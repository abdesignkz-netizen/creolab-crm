import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { PrismaClient, Prisma } from "@creolab/db";
import { verifyHmacSha256 } from "@creolab/integrations";
import { config } from "../config.ts";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { requireIntegrationsAccess, requireTenant } from "../lib/access.ts";
import { safeEqual } from "../lib/hash.ts";
import { encryptSecret, decryptSecret, encryptionKeyVersion } from "../lib/secretBox.ts";
import { writeAudit } from "../lib/audit.ts";
import { ownedWhatsApp, requireWhatsAppSlot, waDigest } from "./whatsappConnectionService.ts";
import { recordExternalMessage } from "./externalMessageService.ts";
import { CONVERSATION_MAX_FILE_BYTES } from "./conversationMedia.ts";

const metaId = z.string().regex(/^\d{1,30}$/);
export const whatsappCloudSchema = z.object({ appId: metaId, wabaId: metaId, phoneNumberId: metaId,
  accessToken: z.string().trim().min(20).max(4096), appSecret: z.string().trim().min(16).max(256), apiVersion: z.string().regex(/^v\d{2}\.0$/).default("v25.0") });
type Secrets = { accessToken: string; appSecret: string };
export type CloudSettings = { appId: string; wabaId: string; phoneNumberId: string; phone: string; apiVersion: string; callbackUrl: string; webhookVerifiedAt?: string };
type Integration = Awaited<ReturnType<PrismaClient["integration"]["findUniqueOrThrow"]>>;
export async function cloudSecrets(prisma: PrismaClient, row: Integration): Promise<Secrets> {
  const credential = row.credentialId ? await prisma.credential.findFirst({ where: { id: row.credentialId, tenantId: row.tenantId, kind: "whatsapp_cloud" } }) : null;
  if (!credential) throw new ApiError(409, "whatsapp_disconnected", "Подключите WhatsApp заново");
  return JSON.parse(decryptSecret(credential.encryptedValue));
}
export async function cloudRequest<T>(secrets: Secrets, version: string, path: string, init: RequestInit = {}): Promise<T> {
  if (!/^v\d{2}\.0$/.test(version) || !path.startsWith("/")) throw new Error("Invalid Graph path");
  try {
    const response = await fetch(`https://graph.facebook.com/${version}${path}`, { ...init, headers: { ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }), Authorization: `Bearer ${secrets.accessToken}` }, signal: AbortSignal.timeout(20000), redirect: "error" });
    const data = await response.json() as T & { error?: { code?: number } };
    if (!response.ok || data.error) throw new ApiError(502, "whatsapp_cloud_rejected", "Meta отклонила запрос. Проверьте доступ, номер и разрешения приложения.");
    return data;
  } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(502, "whatsapp_cloud_unavailable", "Meta не ответила. Проверьте результат операции перед повтором."); }
}
export async function connectWhatsAppCloud(prisma: PrismaClient, auth: AuthContext, input: z.infer<typeof whatsappCloudSchema>) {
  requireIntegrationsAccess(auth); const { tenantId } = requireTenant(auth);
  if (new URL(config.apiBaseUrl).protocol !== "https:") throw new ApiError(422, "https_required", "Для Meta нужен публичный HTTPS-адрес CRM");
  const secrets = { accessToken: input.accessToken, appSecret: input.appSecret };
  const debug = await cloudRequest<{ data: { is_valid?: boolean; app_id?: string } }>({ ...secrets, accessToken: `${input.appId}|${input.appSecret}` }, input.apiVersion, `/debug_token?input_token=${encodeURIComponent(input.accessToken)}`);
  if (!debug.data?.is_valid || debug.data.app_id !== input.appId) throw new ApiError(422, "meta_app_mismatch", "Токен должен принадлежать указанному приложению Meta");
  const phones = await cloudRequest<{ data: Array<{ id: string; display_phone_number?: string; platform_type?: string }> }>(secrets, input.apiVersion, `/${input.wabaId}/phone_numbers?fields=id,display_phone_number,platform_type&limit=100`);
  const phone = phones.data.find(p => p.id === input.phoneNumberId);
  if (!phone || phone.platform_type !== "CLOUD_API") throw new ApiError(422, "whatsapp_phone_mismatch", "Выберите зарегистрированный номер WhatsApp Cloud API указанного бизнес-аккаунта");
  const publicKey = `whatsapp_cloud:${input.phoneNumberId}`;
  const previous = await prisma.integration.findUnique({ where: { publicKey } });
  if (previous && previous.tenantId !== tenantId) throw new ApiError(409, "account_in_use", "Аккаунт уже подключён к другой компании");
  const peers = await prisma.integration.findMany({ where: { type: "whatsapp_cloud", status: { not: "disabled" }, ...(previous ? { id: { not: previous.id } } : {}) } });
  // Manual Meta apps have one callback per object. Do not silently replace another tenant's callback.
  if (peers.some(p => (p.schemaJson as CloudSettings).appId === input.appId)) throw new ApiError(409, "meta_callback_in_use", "Это приложение уже принимает WhatsApp для другого подключения. Используйте отдельное приложение Meta.");
  if (!previous || previous.status === "disabled") await requireWhatsAppSlot(prisma, auth);
  const id = previous?.id || randomUUID(), verifyToken = randomBytes(32).toString("hex");
  const callbackUrl = `${config.apiBaseUrl}/public/integrations/whatsapp-cloud/${id}`;
  const active = previous?.status === "active";
  if (active && (previous.schemaJson as CloudSettings).appId !== input.appId) throw new ApiError(409, "meta_app_changed", "Для смены приложения сначала отключите текущее подключение");
  await prisma.$transaction(async tx => {
    const credential = await tx.credential.create({ data: { tenantId, scope: "integration", kind: "whatsapp_cloud", encryptedValue: encryptSecret(JSON.stringify(secrets)), keyVersion: encryptionKeyVersion() } });
    const settings: CloudSettings = { appId: input.appId, wabaId: input.wabaId, phoneNumberId: input.phoneNumberId, phone: phone.display_phone_number || "", apiVersion: input.apiVersion, callbackUrl, ...(active ? { webhookVerifiedAt: (previous.schemaJson as CloudSettings).webhookVerifiedAt } : {}) };
    const data = { name: "WhatsApp · Cloud API", credentialId: credential.id, publicKey, status: active ? "active" : "pending", connectionStatus: active ? "CONNECTED" : "PENDING", secretHash: active ? previous.secretHash : waDigest(verifyToken), schemaJson: settings as Prisma.InputJsonValue, testMode: false, lastError: null };
    if (previous) await tx.integration.update({ where: { id }, data });
    else await tx.integration.create({ data: { id, tenantId, type: "whatsapp_cloud", ...data } });
    if (previous?.credentialId) await tx.credential.deleteMany({ where: { id: previous.credentialId, tenantId } });
    if (!await tx.channelConnection.findFirst({ where: { tenantId, integrationId: id } })) await tx.channelConnection.create({ data: { tenantId, integrationId: id, channelType: "whatsapp", status: "pending", externalRef: input.phoneNumberId, capabilitiesJson: ["receive_messages", "send_text", "send_media", "requires_template_outside_window"] } });
    await writeAudit(tx, { tenantId, actorUserId: auth.user.id, action: "integration.whatsapp_cloud_configured", entityType: "integration", entityId: id });
  });
  return { id, callbackUrl, verifyToken: active ? null : verifyToken, connected: Boolean(active) };
}
export async function verifyWhatsAppCloud(prisma: PrismaClient, id: string, mode: string, token: string, challenge: string) {
  const row = await prisma.integration.findUnique({ where: { id }, include: { tenant: true } });
  if (!row || row.type !== "whatsapp_cloud" || row.status === "disabled" || row.tenant.status !== "active" || mode !== "subscribe" || !row.secretHash || !safeEqual(waDigest(token), row.secretHash)) throw new ApiError(403, "invalid_verification", "Проверка отклонена");
  await prisma.integration.update({ where: { id }, data: { schemaJson: { ...(row.schemaJson as object), webhookVerifiedAt: new Date().toISOString() } } });
  return challenge;
}
export async function activateWhatsAppCloud(prisma: PrismaClient, auth: AuthContext, id: string) {
  const row = await ownedWhatsApp(prisma, auth, id), settings = row.schemaJson as CloudSettings;
  if (row.type !== "whatsapp_cloud" || row.status === "disabled") throw new ApiError(409, "whatsapp_disconnected", "Подключите WhatsApp заново");
  if (!settings.webhookVerifiedAt) throw new ApiError(409, "webhook_unverified", "Сначала подтвердите Callback URL в приложении Meta");
  const result = await cloudRequest<{ success: boolean }>(await cloudSecrets(prisma, row), settings.apiVersion, `/${settings.wabaId}/subscribed_apps`, { method: "POST" });
  if (!result.success) throw new ApiError(502, "whatsapp_subscription_failed", "Meta не подтвердила подключение");
  await prisma.$transaction(async tx => {
    await tx.integration.update({ where: { id }, data: { status: "active", connectionStatus: "CONNECTED", healthStatus: "NO_EVENTS_YET", lastError: null } });
    await tx.channelConnection.updateMany({ where: { integrationId: id }, data: { status: "active" } });
  });
  return { connected: true };
}

async function cloudMedia(secrets: Secrets, settings: CloudSettings, media: { id: string; mime_type?: string; filename?: string }) {
  if (!/^\d+$/.test(media.id)) throw new Error("Invalid media ID");
  const info = await cloudRequest<{ url: string; mime_type: string; file_size: number }>(secrets, settings.apiVersion, `/${media.id}`);
  const url = new URL(info.url);
  if (url.protocol !== "https:" || url.username || url.password || !(url.hostname === "lookaside.fbsbx.com" || url.hostname.endsWith(".fbcdn.net")) || !Number.isFinite(info.file_size) || info.file_size > CONVERSATION_MAX_FILE_BYTES) throw new Error("Unsupported media");
  const response = await fetch(url, { headers: { Authorization: `Bearer ${secrets.accessToken}` }, redirect: "error", signal: AbortSignal.timeout(20000) });
  if (!response.ok || !response.body) throw new Error("Media unavailable");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > CONVERSATION_MAX_FILE_BYTES) throw new Error("Media too large"); chunks.push(Buffer.from(chunk)); }
  return { buffer: Buffer.concat(chunks), mimeType: info.mime_type, fileName: media.filename || `whatsapp-${media.id}` };
}
const webhookSchema = z.object({ object: z.literal("whatsapp_business_account"), entry: z.array(z.object({ id: z.string(), changes: z.array(z.object({ field: z.string(), value: z.object({ metadata: z.object({ phone_number_id: z.string() }).optional(), contacts: z.array(z.object({ wa_id: z.string(), profile: z.object({ name: z.string() }).optional() })).optional(), messages: z.array(z.object({ id: z.string(), from: z.string().regex(/^\d+$/), timestamp: z.string(), type: z.string(), text: z.object({ body: z.string() }).optional(), image: z.any().optional(), audio: z.any().optional(), video: z.any().optional(), document: z.any().optional(), sticker: z.any().optional() })).max(100).optional(), statuses: z.array(z.object({ id: z.string(), status: z.enum(["sent", "delivered", "read", "failed"]), timestamp: z.string() })).optional() }) })).max(100) })).max(100) });
export async function receiveWhatsAppCloud(prisma: PrismaClient, id: string, raw: Buffer, signature: string) {
  const row = await prisma.integration.findUnique({ where: { id }, include: { tenant: true } });
  if (!row || row.type !== "whatsapp_cloud") throw new ApiError(404, "not_found", "Подключение не найдено");
  if (row.status !== "active" || row.tenant.status !== "active") throw new ApiError(403, "integration_disabled", "Подключение недоступно");
  const secrets = await cloudSecrets(prisma, row);
  if (!/^sha256=[a-fA-F0-9]{64}$/.test(signature) || !verifyHmacSha256(raw, secrets.appSecret, signature)) throw new ApiError(401, "invalid_signature", "Подпись Meta отклонена");
  const body = webhookSchema.parse(JSON.parse(raw.toString("utf8"))), settings = row.schemaJson as CloudSettings;
  for (const entry of body.entry) for (const change of entry.changes) {
    if (entry.id !== settings.wabaId || change.field !== "messages" || change.value.metadata?.phone_number_id !== settings.phoneNumberId) continue;
    for (const message of change.value.messages || []) {
      if (await prisma.inboundEvent.findUnique({ where: { integrationId_externalEventKey: { integrationId: id, externalEventKey: `wa:${waDigest(message.id)}` } }, select: { id: true } })) continue;
      let text = message.text?.body || "", attachments = [];
      const media = message.image || message.audio || message.video || message.document || message.sticker;
      if (media) {
        text = media.caption || text;
        try { attachments.push(await cloudMedia(secrets, settings, media)); }
        catch { text += "\n[Вложение WhatsApp недоступно. Откройте оригинал в WhatsApp.]"; }
      }
      const at = new Date(Number(message.timestamp) * 1000);
      if (!Number.isFinite(at.getTime()) || at.getTime() > Date.now() + 60000) throw new ApiError(422, "invalid_timestamp", "Некорректная дата сообщения");
      await recordExternalMessage(prisma, id, { eventId: `wa:${waDigest(message.id)}`, channel: "whatsapp", externalUserId: message.from, threadId: message.from, messageId: message.id, phone: message.from,
        name: change.value.contacts?.find(c => c.wa_id === message.from)?.profile?.name || `+${message.from}`, text: text || (attachments.length ? "" : `[WhatsApp: ${message.type}]`), at, attachments, raw: { id: message.id, type: message.type } });
    }
    for (const status of change.value.statuses || []) {
      if (status.status === "failed") {
        const messages = await prisma.message.findMany({ where: { tenantId: row.tenantId, providerMessageId: status.id,
          direction: "outbound", conversation: { connection: { integrationId: id } }, receiptState: { in: ["unknown", "sent"] } }, select: { id: true, conversationId: true } });
        for (const message of messages) await prisma.$transaction(async tx => {
          await tx.$queryRaw`SELECT id FROM "Conversation" WHERE id = ${message.conversationId} AND "tenantId" = ${row.tenantId} FOR UPDATE`;
          const latest = await tx.message.findFirst({ where: { tenantId: row.tenantId, conversationId: message.conversationId,
            direction: "outbound", operationState: "accepted" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } });
          const changed = await tx.message.updateMany({ where: { id: message.id, receiptState: { in: ["unknown", "sent"] } }, data: { receiptState: "failed", operationState: "failed" } });
          if (!changed.count) return;
          await tx.outboundOperation.updateMany({ where: { tenantId: row.tenantId, providerRef: message.id }, data: { state: "failed", error: "whatsapp_delivery_failed" } });
          // Do not roll back a later successful reply when an old failure arrives late.
          if (latest?.id !== message.id) return;
          const conversation = await tx.conversation.findUniqueOrThrow({ where: { id: message.conversationId } });
          if (conversation.status !== "open") return;
          await tx.conversation.update({ where: { id: conversation.id }, data: {
            ...(conversation.mode === "ai" ? { mode: "human" } : {}), controlVersion: { increment: 1 }, messageRevision: { increment: 1 },
            needsAttention: true, waitingFor: "MANAGER", attentionReason: "AI_OUTBOUND_FAILED",
          } });
          await tx.outboundOperation.updateMany({ where: { tenantId: row.tenantId, conversationId: conversation.id, state: { in: ["queued", "generating"] } }, data: { state: "canceled", error: "whatsapp_delivery_failed" } });
        });
        continue;
      }
      const previousStates = status.status === "read" ? ["sent", "delivered", "unknown"] : status.status === "delivered" ? ["sent", "unknown"] : ["unknown"];
      await prisma.message.updateMany({ where: { tenantId: row.tenantId, providerMessageId: status.id, conversation: { connection: { integrationId: id } }, receiptState: { in: previousStates } }, data: { receiptState: status.status } });
    }
  }
  return { ok: true };
}
