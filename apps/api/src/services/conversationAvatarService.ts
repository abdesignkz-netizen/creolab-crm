import { createHash } from "node:crypto";
import type { PrismaClient } from "@creolab/db";
import type { AuthContext } from "../lib/types.ts";
import { assertConversationReachable, requireTenant } from "../lib/access.ts";
import { decryptSecret } from "../lib/secretBox.ts";
import type { WhatsAppSellerSchema } from "./aiManagerConfig.ts";

type Photo = { bytes: Buffer; mime: string };
type Entry = { until: number; photo: Photo | null };
const cache = new Map<string, Entry>();
const pending = new Map<string, Promise<Photo | null>>();
const MAX_BYTES = 256 * 1024;
const MAX_ENTRIES = 128; // At most 32 MB, including negative results; no unbounded tenant cache.
let active = 0;

async function json(url: string, body: object) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000), redirect: "error" });
  if (!response.ok) throw new Error("avatar_provider_unavailable");
  return response.json();
}

async function image(url: string): Promise<Photo | null> {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: "error" });
  if (!response.ok || !response.body) throw new Error("avatar_download_unavailable");
  const reader = response.body.getReader();
  if (Number(response.headers.get("content-length")) > MAX_BYTES) { await reader.cancel(); return null; }
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const chunk = await reader.read(); if (chunk.done) break;
    size += chunk.value.length;
    if (size > MAX_BYTES) { await reader.cancel(); return null; }
    chunks.push(chunk.value);
  }
  const bytes = Buffer.concat(chunks);
  // Never forward HTML/SVG, even if a provider supplies an image Content-Type.
  const mime = bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? "image/jpeg"
    : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
    : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP" ? "image/webp" : null;
  return mime ? { bytes, mime } : null;
}

/** Photos use the existing tenant credentials. No provider URL or token reaches the browser. */
export async function getConversationAvatar(prisma: PrismaClient, auth: AuthContext, id: string): Promise<Photo | null> {
  const { tenantId } = requireTenant(auth);
  await assertConversationReachable(prisma, auth, id);
  const conversation = await prisma.conversation.findFirstOrThrow({ where: { id, tenantId }, include: { connection: { include: { integration: true } }, contact: { include: { methods: true } } } });
  let identity = ""; let load: () => Promise<Photo | null>;
  const connection = conversation.connection;
  if (connection?.channelType === "telegram") {
    if (connection.status !== "active" || connection.integration.status !== "active" || !/^\d+$/.test(conversation.externalThreadId || "")) return null;
    const credential = await prisma.credential.findFirst({ where: { id: connection.integration.credentialId || "", tenantId, kind: "telegram_bot" } });
    if (!credential) return null;
    identity = `${connection.id}:${conversation.externalThreadId}:${credential.encryptedValue}`;
    load = async () => {
      const token = decryptSecret(credential.encryptedValue);
      const base = `https://api.telegram.org/bot${encodeURIComponent(token)}`;
      const photos = await json(`${base}/getUserProfilePhotos`, { user_id: Number(conversation.externalThreadId), limit: 1 });
      if (!photos.ok) throw new Error("avatar_provider_unavailable");
      const sizes = photos.result?.photos?.[0];
      const photo = sizes?.find((size: { width: number }) => size.width >= 160) || sizes?.[0];
      if (!photo?.file_id) return null;
      const file = await json(`${base}/getFile`, { file_id: photo.file_id });
      if (!file.ok) throw new Error("avatar_provider_unavailable");
      const filePath = file.result?.file_path;
      if (typeof filePath !== "string" || !/^[A-Za-z0-9_./-]+$/.test(filePath) || filePath.split("/").includes("..") || file.result.file_size > MAX_BYTES) return null;
      return image(`https://api.telegram.org/file/bot${encodeURIComponent(token)}/${filePath}`);
    };
  } else if (conversation.sellerLeadId && !connection) {
    const integration = await prisma.integration.findFirst({ where: { tenantId, type: "whatsapp_seller", status: "active" } });
    const schema = (integration?.schemaJson || {}) as WhatsAppSellerSchema;
    if (!integration || !/^\d+$/.test(schema.instanceId || "") || !schema.apiTokenEnc) return null;
    const phone = conversation.contact?.methods.find(method => method.type === "phone" && method.primary) || conversation.contact?.methods.find(method => method.type === "phone");
    const digits = (phone?.normalizedValue || "").replace(/\D/g, "");
    if (!/^\d{11,16}$/.test(digits)) return null;
    const host = schema.greenApiHost || process.env.GREEN_API_HOST || `${schema.instanceId}.api.green-api.com`;
    if (!/^(?:[a-z0-9-]+\.)*(?:green-api\.com|greenapi\.com)$/i.test(host)) return null;
    identity = `${integration.id}:${digits}:${schema.apiTokenEnc}:${host}`;
    load = async () => {
      const token = decryptSecret(schema.apiTokenEnc!);
      const result = await json(`https://${host}/waInstance${schema.instanceId}/getAvatar/${encodeURIComponent(token)}`, { chatId: `${digits}@c.us` });
      if (!result.urlAvatar) return null;
      const url = new URL(result.urlAvatar);
      if (url.protocol !== "https:" || url.port || url.username || url.password || !/(^|\.)(whatsapp\.net|fbcdn\.net)$/.test(url.hostname)) return null;
      return image(url.href);
    };
  } else return null;
  const key = `${tenantId}:${createHash("sha256").update(identity).digest("hex")}`;
  const existing = cache.get(key);
  if (existing && existing.until > Date.now()) return existing.photo;
  if (pending.has(key)) return pending.get(key)!;
  // A busy image provider must not consume all API connections. The next view retries.
  if (active >= 4) return null;
  const promise = (async () => {
    active++;
    let photo: Photo | null = null; let ttl = 60 * 60 * 1000;
    try { photo = await load(); if (photo) ttl = 6 * 60 * 60 * 1000; }
    catch { ttl = 5 * 60 * 1000; } // Do not log provider exceptions: URLs contain credentials.
    finally { active--; }
    cache.delete(key);
    while (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
    cache.set(key, { photo, until: Date.now() + ttl });
    return photo;
  })();
  pending.set(key, promise);
  try { return await promise; } finally { pending.delete(key); }
}
