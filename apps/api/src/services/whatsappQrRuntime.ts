import { randomUUID, createHash, createHmac, createDecipheriv, timingSafeEqual } from "node:crypto";
import type { PrismaClient, Prisma } from "@creolab/db";
import makeWASocket, { BufferJSON, DisconnectReason, initAuthCreds, proto, jidNormalizedUser, normalizeMessageContent, getMediaKeys, type AuthenticationState, type WASocket, type WAMessage } from "@whiskeysockets/baileys";
import pino from "pino";
import { encryptSecret, decryptSecret } from "../lib/secretBox.ts";
import { recordExternalMessage } from "./externalMessageService.ts";
import { CONVERSATION_MAX_FILE_BYTES } from "./conversationMedia.ts";
import { qrEnabled, waDigest } from "./whatsappConnectionService.ts";
import { deliverQrMessage } from "./whatsappSendService.ts";

const logger = pino({ level: "silent" }); // Never log pairing QR, Signal keys or message bodies.
const encode = (value: unknown) => encryptSecret(JSON.stringify(value, BufferJSON.replacer));
const decode = (value: string) => JSON.parse(decryptSecret(value), BufferJSON.reviver);
type Db = PrismaClient | Prisma.TransactionClient;

// Download ourselves: the pinned upstream stream helper does not forward fetch
// timeout/redirect options. Never fetch a sender-supplied arbitrary media host.
export async function downloadQrMedia(media: { url?: string | null; directPath?: string | null; mediaKey?: Uint8Array | null; fileSha256?: Uint8Array | null; fileEncSha256?: Uint8Array | null }, type: "image" | "video" | "audio" | "document" | "sticker") {
  const source = media.url ? new URL(media.url) : new URL("https://mmg.whatsapp.net");
  if (source.protocol !== "https:" || source.port || source.username || source.password || !(source.hostname === "mmg.whatsapp.net" || source.hostname.endsWith(".whatsapp.net"))) throw new Error("Invalid media host");
  if (media.directPath && (!media.directPath.startsWith("/") || media.directPath.startsWith("//") || media.directPath.includes("\\"))) throw new Error("Invalid media path");
  const url = media.directPath ? new URL(media.directPath, source.origin) : source;
  if (!media.mediaKey) throw new Error("Missing media key");
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20000) });
  if (!response.ok || !response.body) throw new Error("Media unavailable");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > CONVERSATION_MAX_FILE_BYTES + 64) throw new Error("Media too large"); chunks.push(Buffer.from(chunk)); }
  const encrypted = Buffer.concat(chunks);
  if (encrypted.length <= 10) throw new Error("Invalid encrypted media");
  if (media.fileEncSha256 && !createHash("sha256").update(encrypted).digest().equals(Buffer.from(media.fileEncSha256))) throw new Error("Invalid encrypted media hash");
  const keys = await getMediaKeys(media.mediaKey, type), ciphertext = encrypted.subarray(0, -10);
  if (!keys.macKey) throw new Error("Missing media MAC key");
  const mac = createHmac("sha256", keys.macKey).update(Buffer.concat([keys.iv, ciphertext])).digest().subarray(0, 10);
  if (!timingSafeEqual(mac, encrypted.subarray(-10))) throw new Error("Invalid media MAC");
  const decipher = createDecipheriv("aes-256-cbc", keys.cipherKey, keys.iv);
  const buffer = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (buffer.length > CONVERSATION_MAX_FILE_BYTES || media.fileSha256 && !createHash("sha256").update(buffer).digest().equals(Buffer.from(media.fileSha256))) throw new Error("Invalid media hash");
  return buffer;
}

export async function claimQrLease(prisma: PrismaClient, id: string, owner: string) {
  const rows = await prisma.$queryRaw<Array<{ integrationId: string }>>`UPDATE "WhatsAppQrSession" s SET owner = ${owner}, "leaseUntil" = CURRENT_TIMESTAMP + INTERVAL '60 seconds'
    FROM "Integration" i JOIN "Tenant" t ON t.id = i."tenantId"
    WHERE s."integrationId" = ${id} AND i.id = s."integrationId" AND i.status <> 'disabled' AND t.status = 'active'
      AND (s.owner = ${owner} OR s."leaseUntil" IS NULL OR s."leaseUntil" < CURRENT_TIMESTAMP)
    RETURNING s."integrationId"`;
  return rows.length > 0;
}
async function guardLease(tx: Db, id: string, owner: string) {
  const rows = await tx.$queryRaw<Array<{ integrationId: string }>>`SELECT s."integrationId" FROM "WhatsAppQrSession" s
    JOIN "Integration" i ON i.id = s."integrationId" JOIN "Tenant" t ON t.id = i."tenantId"
    WHERE s."integrationId" = ${id} AND s.owner = ${owner} AND s."leaseUntil" > CURRENT_TIMESTAMP AND i.status <> 'disabled' AND t.status = 'active' FOR UPDATE OF s`;
  if (!rows.length) throw new Error("WhatsApp session lease lost");
}
export async function databaseQrAuth(prisma: PrismaClient, id: string, owner: string) {
  async function read(key: string) {
    const rows = await prisma.$queryRaw<Array<{ encryptedValue: string }>>`SELECT "encryptedValue" FROM "WhatsAppQrKey" WHERE "integrationId" = ${id} AND key = ${key}`;
    return rows[0] ? decode(rows[0].encryptedValue) : undefined;
  }
  async function write(entries: Array<[string, unknown]>) {
    await prisma.$transaction(async tx => {
      await guardLease(tx, id, owner);
      for (const [key, value] of entries) {
        if (value == null) await tx.$executeRaw`DELETE FROM "WhatsAppQrKey" WHERE "integrationId" = ${id} AND key = ${key}`;
        else await tx.$executeRaw`INSERT INTO "WhatsAppQrKey" ("integrationId", key, "encryptedValue") VALUES (${id}, ${key}, ${encode(value)}) ON CONFLICT ("integrationId", key) DO UPDATE SET "encryptedValue" = EXCLUDED."encryptedValue"`;
      }
    });
  }
  const creds = await read("creds") || initAuthCreds();
  const state: AuthenticationState = { creds, keys: {
    get: async (type, ids) => {
      const values: Record<string, any> = {};
      for (const key of ids) { let value = await read(`${type}:${key}`); if (type === "app-state-sync-key" && value) value = proto.Message.AppStateSyncKeyData.fromObject(value); if (value != null) values[key] = value; }
      return values;
    },
    set: async data => { const entries: Array<[string, unknown]> = []; for (const [type, values] of Object.entries(data)) for (const [key, value] of Object.entries(values || {})) entries.push([`${type}:${key}`, value]); await write(entries); },
  } };
  return { state, saveCreds: () => write([["creds", creds]]) };
}

async function receiveQrMessage(prisma: PrismaClient, id: string, socket: WASocket, message: WAMessage) {
  const jid = jidNormalizedUser(message.key.remoteJid || "");
  if (!message.key.id || message.key.fromMe || !/^\d+@(s\.whatsapp\.net|lid)$/.test(jid)) return;
  const content = normalizeMessageContent(message.message);
  if (!content || content.protocolMessage || content.reactionMessage || content.senderKeyDistributionMessage) return;
  let text = content.conversation || content.extendedTextMessage?.text || "";
  const media = content.imageMessage || content.videoMessage || content.audioMessage || content.documentMessage || content.stickerMessage;
  const attachments: Array<{ fileName: string; mimeType: string; buffer: Buffer }> = [];
  if (media) {
    text = (media as { caption?: string }).caption || text;
    try {
      if (Number(media.fileLength || 0) > CONVERSATION_MAX_FILE_BYTES) throw new Error("Media too large");
      const type = content.imageMessage ? "image" : content.videoMessage ? "video" : content.audioMessage ? "audio" : content.documentMessage ? "document" : "sticker";
      const buffer = await downloadQrMedia(media, type);
      attachments.push({ fileName: content.documentMessage?.fileName || `whatsapp-${message.key.id}`, mimeType: media.mimetype || "application/octet-stream", buffer });
    } catch { text += "\n[Вложение WhatsApp недоступно. Откройте оригинал в WhatsApp.]"; }
  }
  const at = new Date(Number(message.messageTimestamp || Math.floor(Date.now() / 1000)) * 1000);
  const phoneJid = jid.endsWith("@s.whatsapp.net") ? jid : message.key.remoteJidAlt?.endsWith("@s.whatsapp.net") ? message.key.remoteJidAlt : null;
  await recordExternalMessage(prisma, id, { eventId: `wa:${waDigest(`${jid}:${message.key.id}`)}`, channel: "whatsapp", externalUserId: jid, threadId: jid, messageId: message.key.id,
    name: message.pushName || (phoneJid ? `+${phoneJid.split("@")[0]}` : "WhatsApp"), phone: phoneJid?.split("@")[0], aliases: message.key.remoteJidAlt && /^\d+@(s\.whatsapp\.net|lid)$/.test(jidNormalizedUser(message.key.remoteJidAlt)) ? [jidNormalizedUser(message.key.remoteJidAlt)] : [], text: text || (attachments.length ? "" : "[Сообщение WhatsApp]"),
    at: Number.isFinite(at.getTime()) && at.getTime() <= Date.now() + 60000 ? at : new Date(), attachments, raw: { id: message.key.id } });
}

export function startWhatsAppQrRuntime(prisma: PrismaClient, socketFactory = makeWASocket) {
  const owner = randomUUID();
  const sessions = new Map<string, { socket: WASocket; open: boolean; tasks: Promise<void>; stop: boolean }>();
  let stopped = false, ticking = false;
  async function release(id: string) {
    const local = sessions.get(id); if (local) { local.stop = true; local.socket.end(undefined); sessions.delete(id); }
    await prisma.$executeRaw`UPDATE "WhatsAppQrSession" SET owner = NULL, "leaseUntil" = NULL, "encryptedQr" = NULL, "qrExpiresAt" = NULL WHERE "integrationId" = ${id} AND owner = ${owner}`;
  }
  async function connect(id: string) {
    if (!await claimQrLease(prisma, id, owner)) return;
    await prisma.$executeRaw`UPDATE "WhatsAppQrSession" SET "encryptedQr" = NULL, "qrExpiresAt" = NULL WHERE "integrationId" = ${id} AND owner = ${owner}`;
    await prisma.integration.update({ where: { id }, data: { connectionStatus: "CONNECTING" } });
    await prisma.channelConnection.updateMany({ where: { integrationId: id }, data: { status: "pending" } });
    // A process crash during an outgoing network call has an uncertain result. Never resend automatically.
    await prisma.message.updateMany({ where: { conversation: { connection: { integrationId: id } }, operationState: "sending" }, data: { operationState: "unknown" } });
    await prisma.outboundOperation.updateMany({ where: { conversation: { connection: { integrationId: id } }, state: "sending" }, data: { state: "unknown" } });
    await prisma.$executeRaw`DELETE FROM "WhatsAppQrJob" WHERE "integrationId" = ${id} AND kind = 'outbound' AND state = 'sending'`;
    const auth = await databaseQrAuth(prisma, id, owner);
    await auth.saveCreds();
    const socket = socketFactory({ auth: auth.state, logger, browser: ["BasQar", "Chrome", "1.0.0"], markOnlineOnConnect: false, syncFullHistory: false, shouldSyncHistoryMessage: () => false, connectTimeoutMs: 20000, defaultQueryTimeoutMs: 20000 });
    const local = { socket, open: false, tasks: Promise.resolve(), stop: false }; sessions.set(id, local);
    const enqueue = (work: () => Promise<void>) => {
      local.tasks = local.tasks.then(async () => { if (!local.stop) await work(); }).catch(async () => {
        // No raw provider errors: those may contain keys, JIDs or message content.
        await prisma.integration.updateMany({ where: { id, status: { not: "disabled" } }, data: { healthStatus: "ERROR", lastError: "Не удалось обработать событие WhatsApp. Проверьте подключение.", lastErrorAt: new Date() } }).catch(() => undefined);
      });
    };
    socket.ev.on("creds.update", () => enqueue(auth.saveCreds));
    socket.ev.on("connection.update", update => enqueue(async () => {
      await guardLease(prisma, id, owner);
      if (update.qr) {
        await prisma.$executeRaw`UPDATE "WhatsAppQrSession" SET "encryptedQr" = ${encryptSecret(update.qr)}, "qrExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '30 seconds' WHERE "integrationId" = ${id} AND owner = ${owner}`;
        await prisma.integration.updateMany({ where: { id, status: { not: "disabled" } }, data: { connectionStatus: "QR_READY" } });
      }
      if (update.connection === "open") {
        const phone = jidNormalizedUser(socket.user?.id || "").split("@")[0];
        if (!/^\d+$/.test(phone)) { await release(id); return; }
        try {
          await prisma.$transaction(async tx => {
            await guardLease(tx, id, owner);
            await tx.integration.update({ where: { id }, data: { status: "active", connectionStatus: "CONNECTED", publicKey: `whatsapp_qr:${phone}`, schemaJson: { phone }, healthStatus: "NO_EVENTS_YET", lastError: null, lastSuccessAt: new Date() } });
            await tx.channelConnection.updateMany({ where: { integrationId: id }, data: { status: "active", externalRef: phone } });
            await tx.$executeRaw`UPDATE "WhatsAppQrSession" SET "encryptedQr" = NULL, "qrExpiresAt" = NULL, attempts = 0 WHERE "integrationId" = ${id}`;
          });
          local.open = true;
        } catch {
          await prisma.integration.updateMany({ where: { id, status: { not: "disabled" } }, data: { connectionStatus: "RECONNECT_REQUIRED", lastError: "Номер уже подключён или подключение недоступно. Отключите его и повторите попытку." } });
          await release(id);
        }
      }
      if (update.connection === "close") {
        local.open = false;
        const reason = (update.lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
        const terminal = [DisconnectReason.loggedOut, DisconnectReason.badSession, DisconnectReason.connectionReplaced, DisconnectReason.multideviceMismatch, DisconnectReason.forbidden].includes(reason as number);
        await prisma.$transaction(async tx => {
          await guardLease(tx, id, owner);
          await tx.integration.update({ where: { id }, data: { connectionStatus: terminal ? "RECONNECT_REQUIRED" : "CONNECTING", healthStatus: "ERROR" } });
          await tx.channelConnection.updateMany({ where: { integrationId: id }, data: { status: "pending" } });
          await tx.$executeRaw`UPDATE "WhatsAppQrSession" SET "reconnectAt" = CURRENT_TIMESTAMP + (LEAST(300, 5 * POWER(2, LEAST(attempts,6))) * INTERVAL '1 second'), attempts = attempts + 1 WHERE "integrationId" = ${id}`;
        });
        await release(id);
      }
    }));
    socket.ev.on("messages.upsert", event => enqueue(async () => {
      // Offline deliveries may be append events. Skip only history sync and outgoing echoes.
      for (const message of event.messages) {
        if (!message.key.id || message.key.fromMe || !/^\d+@(s\.whatsapp\.net|lid)$/.test(jidNormalizedUser(message.key.remoteJid || ""))) continue;
        const jobId = `in:${id}:${waDigest(`${message.key.remoteJid}:${message.key.id}`)}`;
        await prisma.$transaction(async tx => {
          await guardLease(tx, id, owner);
          await tx.$executeRaw`INSERT INTO "WhatsAppQrJob" (id, "integrationId", kind, "encryptedPayload") VALUES (${jobId}, ${id}, 'inbound', ${encode(message)}) ON CONFLICT (id) DO NOTHING`;
        });
      }
    }));
  }
  async function tick() {
    if (stopped || ticking || !qrEnabled()) return;
    ticking = true;
    try {
      for (const [id, local] of sessions) {
        if (!await claimQrLease(prisma, id, owner)) {
          const row = await prisma.integration.findUnique({ where: { id } });
          if (row?.status === "disabled") await local.socket.logout().catch(() => undefined);
          await release(id); continue;
        }
        if (!local.open) continue;
        await local.tasks;
        const jobs = await prisma.$queryRaw<Array<{ id: string; kind: string; encryptedPayload: string }>>`SELECT id, kind, "encryptedPayload" FROM "WhatsAppQrJob" WHERE "integrationId" = ${id} AND state = 'queued' ORDER BY "createdAt" LIMIT 10`;
        for (const job of jobs) {
          if (!await claimQrLease(prisma, id, owner)) break;
          try {
            // Protobuf's toJSON runs before BufferJSON.replacer and turns media
            // keys/hashes into bare base64 strings. Restore the protobuf types,
            // including for jobs saved before this fix, before verifying media.
            if (job.kind === "inbound") {
              const message = proto.WebMessageInfo.fromObject(decode(job.encryptedPayload));
              if (message.key) await receiveQrMessage(prisma, id, local.socket, { ...message, key: message.key });
            }
            else {
              await prisma.$executeRaw`UPDATE "WhatsAppQrJob" SET state = 'sending' WHERE id = ${job.id}`;
              await deliverQrMessage(prisma, id, local.socket, decode(job.encryptedPayload).messageId, () => guardLease(prisma, id, owner));
            }
            await prisma.$executeRaw`DELETE FROM "WhatsAppQrJob" WHERE id = ${job.id}`;
          } catch {
            if (job.kind === "outbound") {
              const messageId = decode(job.encryptedPayload).messageId;
              const message = await prisma.message.findUnique({ where: { id: messageId }, select: { operationState: true } });
              if (message?.operationState === "queued") {
                // A failure before network dispatch is safe to retry.
                await prisma.$executeRaw`UPDATE "WhatsAppQrJob" SET state = 'queued' WHERE id = ${job.id}`;
                break;
              }
              if (message?.operationState === "sending") await prisma.message.update({ where: { id: messageId }, data: { operationState: "unknown" } });
              await prisma.$executeRaw`DELETE FROM "WhatsAppQrJob" WHERE id = ${job.id}`;
            }
            else break; // Keep encrypted inbound event durable for retry, including quota failures.
          }
        }
      }
      const rows = await prisma.$queryRaw<Array<{ integrationId: string }>>`SELECT s."integrationId" FROM "WhatsAppQrSession" s JOIN "Integration" i ON i.id = s."integrationId" JOIN "Tenant" t ON t.id = i."tenantId"
        WHERE i.status <> 'disabled' AND i."connectionStatus" <> 'RECONNECT_REQUIRED' AND t.status = 'active'
          AND (s."reconnectAt" IS NULL OR s."reconnectAt" <= CURRENT_TIMESTAMP) AND (s."leaseUntil" IS NULL OR s."leaseUntil" < CURRENT_TIMESTAMP) LIMIT 100`;
      for (const row of rows) if (!sessions.has(row.integrationId)) {
        try { await connect(row.integrationId); }
        catch { await release(row.integrationId); }
      }
    } catch { console.warn("[whatsapp-qr] Session processing unavailable; retrying"); }
    finally { ticking = false; }
  }
  // Renew independently of media downloads/job processing. Losing the lease closes
  // this process's socket before a second worker can send with the same session.
  let renewing = false;
  const heartbeat = setInterval(() => {
    if (stopped || renewing) return;
    renewing = true;
    void (async () => {
      for (const [id, local] of sessions) {
        try { if (await claimQrLease(prisma, id, owner)) continue; }
        catch { /* Fail closed on database outages. */ }
        const row = await prisma.integration.findUnique({ where: { id }, select: { status: true } }).catch(() => null);
        if (row?.status === "disabled") await local.socket.logout().catch(() => undefined);
        local.stop = true; local.socket.end(undefined); sessions.delete(id);
      }
    })().finally(() => { renewing = false; });
  }, 10000); heartbeat.unref();
  const timer = setInterval(() => void tick(), 3000); timer.unref(); void tick();
  return { tick, async stop() { stopped = true; clearInterval(timer); clearInterval(heartbeat); for (const [id, local] of sessions) { local.stop = true; local.socket.end(undefined); await local.tasks; await release(id); } } };
}
