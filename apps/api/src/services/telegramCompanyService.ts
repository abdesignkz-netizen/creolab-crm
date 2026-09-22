import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { validateClientPhone } from "@creolab/contracts";
import type { Prisma, PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import { config } from "../config.ts";
import { requireIntegrationsAccess, requireTenant, assertConversationReachable } from "../lib/access.ts";
import type { AuthContext } from "../lib/types.ts";
import { encryptSecret, decryptSecret, encryptionKeyVersion } from "../lib/secretBox.ts";
import { writeAudit } from "../lib/audit.ts";
import { assertConversationMime, decodeBase64Payload, storeMessageAttachment, CONVERSATION_MAX_FILE_BYTES } from "./conversationMedia.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const capabilities = ["receive_messages", "send_text", "send_media"];
export const telegramConnectSchema = z.object({ token: z.string().trim().regex(/^\d{5,16}:[A-Za-z0-9_-]{20,100}$/, "Проверьте токен из BotFather") });
const userSchema = z.object({ id: z.number().int().positive().safe(), is_bot: z.boolean().optional(), first_name: z.string().max(1000).optional(), last_name: z.string().max(1000).optional(), username: z.string().max(100).optional() });
const mediaSchema = z.object({ file_id: z.string().max(1000), file_size: z.number().nonnegative().optional(), file_name: z.string().max(500).optional(), mime_type: z.string().max(100).optional() });
const updateSchema = z.object({ update_id: z.number().int().nonnegative().safe(), message: z.object({
  message_id: z.number().int().positive(), date: z.number().int().nonnegative(), from: userSchema.optional(),
  chat: z.object({ id: z.number().int().safe(), type: z.string() }), text: z.string().max(10000).optional(), caption: z.string().max(10000).optional(),
  photo: z.array(mediaSchema).max(20).optional(), document: mediaSchema.optional(), voice: mediaSchema.optional(), audio: mediaSchema.optional(), video: mediaSchema.optional(),
  contact: z.object({ phone_number: z.string().max(100), user_id: z.number().int().optional(), first_name: z.string().optional() }).optional(),
}).optional() });

// Provider errors never include the request URL: Telegram embeds the bot token in it.
async function telegramCall<T>(token: string, method: string, body: Record<string, unknown> | FormData = {}): Promise<T> {
  try {
    const multipart = body instanceof FormData;
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", headers: multipart ? undefined : { "Content-Type": "application/json" },
      body: multipart ? body : JSON.stringify(body), signal: AbortSignal.timeout(20000), redirect: "error",
    });
    const result = await response.json() as { ok: boolean; result: T; error_code?: number };
    if (!response.ok || !result.ok) throw new ApiError(502, "telegram_provider", `Telegram отклонил запрос (${result.error_code || response.status}). Проверьте токен и права бота.`);
    return result.result;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "telegram_unavailable", "Telegram не ответил. Результат отправки может быть неизвестен; проверьте диалог перед повтором.");
  }
}

async function tokenFor(prisma: PrismaClient | Prisma.TransactionClient, tenantId: string, credentialId: string | null) {
  const credential = credentialId ? await prisma.credential.findFirst({ where: { id: credentialId, tenantId, kind: "telegram_bot" } }) : null;
  if (!credential) throw new ApiError(409, "telegram_disconnected", "Подключите Telegram-бота компании");
  return decryptSecret(credential.encryptedValue);
}

export async function connectCompanyTelegram(prisma: PrismaClient, auth: AuthContext, input: z.infer<typeof telegramConnectSchema>) {
  requireIntegrationsAccess(auth);
  const { tenantId } = requireTenant(auth);
  const base = new URL(config.apiBaseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new ApiError(422, "public_https_required", "Для подключения Telegram у сервера CRM должен быть публичный HTTPS-адрес (API_BASE_URL).");
  }
  const me = await telegramCall<{ id: number; is_bot: boolean; username?: string }>(input.token, "getMe");
  if (!me.is_bot || !me.username || !Number.isSafeInteger(me.id)) throw new ApiError(422, "invalid_bot", "Токен не принадлежит боту");
  const publicKey = `telegram-bot:${me.id}`;
  const occupied = await prisma.integration.findUnique({ where: { publicKey } });
  if (occupied && occupied.tenantId !== tenantId) throw new ApiError(409, "bot_in_use", "Этот бот уже подключён к другой компании");
  const id = occupied?.id || randomUUID();
  const webhookUrl = `${config.apiBaseUrl.replace(/\/$/, "")}/public/integrations/telegram/${id}`;
  const webhook = await telegramCall<{ url: string }>(input.token, "getWebhookInfo");
  if (webhook.url && webhook.url !== webhookUrl) throw new ApiError(409, "bot_in_use", "Бот принимает сообщения в другой системе. Отключите его там или создайте отдельного бота в BotFather.");
  if (occupied?.status === "active" && webhook.url === webhookUrl) {
    const credential = await prisma.credential.findFirst({ where: { id: occupied.credentialId || "", tenantId, kind: "telegram_bot" } });
    if (!credential) throw new ApiError(409, "telegram_disconnected", "Сначала отключите прежнее подключение бота");
    await prisma.$transaction(async tx => {
      await tx.credential.update({ where: { id: credential.id }, data: { encryptedValue: encryptSecret(input.token), keyVersion: encryptionKeyVersion(), rotatedAt: new Date() } });
      await writeAudit(tx, { tenantId, actorUserId: auth.user.id, action: "integration.telegram_access_updated", entityType: "integration", entityId: occupied.id });
    });
    return { id: occupied.id, username: me.username, connected: true };
  }
  const secret = randomBytes(32).toString("hex");
  await prisma.$transaction(async (tx) => {
    // A unique public key also prevents two companies claiming the same bot concurrently.
    const credential = occupied?.credentialId ? await tx.credential.findFirst({ where: { id: occupied.credentialId, tenantId, kind: "telegram_bot" } }) : null;
    const data = { encryptedValue: encryptSecret(input.token), keyVersion: encryptionKeyVersion(), rotatedAt: new Date() };
    const saved = credential ? await tx.credential.update({ where: { id: credential.id }, data }) : await tx.credential.create({ data: { ...data, tenantId, kind: "telegram_bot", scope: "integration" } });
    const integrationData = { name: `Telegram @${me.username}`, status: occupied?.status === "active" ? "active" : "pending", connectionStatus: occupied?.status === "active" ? "CONNECTED" : "PENDING", credentialId: saved.id, publicKey,
      previousSecretHash: occupied?.secretHash || null, previousSecretExpiresAt: occupied?.secretHash ? new Date(Date.now() + 300000) : null,
      secretHash: hash(secret), schemaJson: { botId: String(me.id), username: me.username, webhookUrl }, testMode: false };
    if (occupied) await tx.integration.update({ where: { id }, data: integrationData });
    else await tx.integration.create({ data: { id, tenantId, type: "telegram_bot", ...integrationData } });
  });
  try {
    await telegramCall(input.token, "setWebhook", { url: webhookUrl, secret_token: secret, allowed_updates: ["message"], drop_pending_updates: false });
    await prisma.$transaction(async (tx) => {
      const connection = await tx.channelConnection.findFirst({ where: { tenantId, integrationId: id, channelType: "telegram" } });
      const data = { status: "active", externalRef: String(me.id), capabilitiesJson: capabilities, autoReply: false };
      if (connection) await tx.channelConnection.update({ where: { id: connection.id }, data });
      else await tx.channelConnection.create({ data: { tenantId, integrationId: id, channelType: "telegram", ...data } });
      await tx.integration.update({ where: { id }, data: { status: "active", connectionStatus: "CONNECTED", healthStatus: "NO_EVENTS_YET", lastError: null, lastErrorCode: null, lastSuccessAt: new Date() } });
      await writeAudit(tx, { tenantId, actorUserId: auth.user.id, action: "integration.telegram_connected", entityType: "integration", entityId: id, changes: { username: me.username } });
    });
  } catch (error) {
    await prisma.integration.update({ where: { id }, data: { healthStatus: "ERROR", lastError: "Не удалось завершить регистрацию Telegram webhook", lastErrorAt: new Date() } });
    throw error;
  }
  return { id, username: me.username, connected: true };
}

export async function disconnectCompanyTelegram(prisma: PrismaClient, auth: AuthContext, id: string) {
  requireIntegrationsAccess(auth);
  const { tenantId } = requireTenant(auth);
  const integration = await prisma.integration.findFirst({ where: { id, tenantId, type: "telegram_bot" } });
  if (!integration) throw new ApiError(404, "not_found", "Подключение не найдено");
  if (integration.status === "disabled") return { disconnected: true };
  await telegramCall(await tokenFor(prisma, tenantId, integration.credentialId), "deleteWebhook", { drop_pending_updates: false });
  await prisma.$transaction(async (tx) => {
    await tx.integration.update({ where: { id }, data: { status: "disabled", connectionStatus: "DISCONNECTED", secretHash: null, previousSecretHash: null, previousSecretExpiresAt: null } });
    await tx.channelConnection.updateMany({ where: { tenantId, integrationId: id }, data: { status: "disabled" } });
    await writeAudit(tx, { tenantId, actorUserId: auth.user.id, action: "integration.telegram_disconnected", entityType: "integration", entityId: id });
  });
  return { disconnected: true };
}

export async function checkCompanyTelegram(prisma: PrismaClient, auth: AuthContext, id: string) {
  requireIntegrationsAccess(auth);
  const { tenantId } = requireTenant(auth);
  const integration = await prisma.integration.findFirst({ where: { id, tenantId, type: "telegram_bot" } });
  if (!integration) throw new ApiError(404, "not_found", "Подключение не найдено");
  if (integration.status !== "active") return { connected: false, healthLabel: "Не подключено" };
  const webhook = await telegramCall<{ url: string; pending_update_count?: number; last_error_date?: number }>(await tokenFor(prisma, tenantId, integration.credentialId), "getWebhookInfo");
  const expected = (integration.schemaJson as { webhookUrl?: string }).webhookUrl;
  const connected = Boolean(expected && webhook.url === expected);
  const healthStatus = connected ? (integration.lastEventAt ? "HEALTHY" : "NO_EVENTS_YET") : "ERROR";
  await prisma.integration.update({ where: { id }, data: { healthStatus, lastError: connected ? null : "Telegram webhook изменён вне CRM" } });
  return { connected, healthLabel: connected ? "Подключено" : "Адрес приёма сообщений изменён", pendingUpdates: webhook.pending_update_count || 0, lastDeliveryErrorAt: webhook.last_error_date || null };
}

async function downloadTelegramMedia(token: string, media: z.infer<typeof mediaSchema>, fallbackName: string, fallbackMime: string) {
  if (media.file_size && media.file_size > CONVERSATION_MAX_FILE_BYTES) return null;
  const fileName = media.file_name || fallbackName;
  let mimeType: string;
  try { mimeType = assertConversationMime(fileName, media.mime_type || fallbackMime); }
  catch { return null; }
  const file = await telegramCall<{ file_path?: string; file_size?: number }>(token, "getFile", { file_id: media.file_id });
  if (!file.file_path || file.file_size && file.file_size > CONVERSATION_MAX_FILE_BYTES) return null;
  if (!/^[A-Za-z0-9_./-]+$/.test(file.file_path) || file.file_path.split("/").includes("..")) throw new ApiError(502, "telegram_file_path", "Telegram вернул некорректный путь файла");
  try {
    const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(20000), redirect: "error" });
    if (!response.ok || !response.body) throw new Error("download");
    const chunks: Uint8Array[] = []; let size = 0;
    const reader = response.body.getReader();
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.length;
      if (size > CONVERSATION_MAX_FILE_BYTES) { await reader.cancel(); return null; }
      chunks.push(chunk.value);
    }
    return { fileName, mimeType, buffer: Buffer.concat(chunks) };
  } catch { throw new ApiError(502, "telegram_media_unavailable", "Не удалось получить вложение Telegram. Доставка будет повторена."); }
}

export async function receiveCompanyTelegram(prisma: PrismaClient, id: string, secret: string, body: unknown) {
  const integration = await prisma.integration.findUnique({ where: { id }, include: { tenant: true } });
  if (!integration || integration.type !== "telegram_bot") throw new ApiError(404, "not_found", "Подключение не найдено");
  const digest = hash(secret);
  const matches = (expected: string | null) => Boolean(secret && expected && expected.length === digest.length && timingSafeEqual(Buffer.from(digest), Buffer.from(expected)));
  if (!matches(integration.secretHash) && !(integration.previousSecretExpiresAt && integration.previousSecretExpiresAt > new Date() && matches(integration.previousSecretHash))) throw new ApiError(401, "invalid_signature", "Подпись отклонена");
  if (integration.status !== "active" || integration.tenant.status !== "active") throw new ApiError(403, "integration_disabled", "Подключение недоступно");
  const update = updateSchema.parse(body);
  const incoming = update.message;
  // Only private customer conversations are imported; groups and service updates are acknowledged.
  if (!incoming || incoming.chat.type !== "private" || !incoming.from || incoming.from.is_bot) return { ok: true, ignored: true };
  const { tenantId } = integration;
  const previous = await prisma.inboundEvent.findUnique({ where: { integrationId_externalEventKey: { integrationId: id, externalEventKey: String(update.update_id) } } });
  if (previous) return { ok: true, duplicate: true };
  const media = incoming.document || incoming.voice || incoming.audio || incoming.video || incoming.photo?.at(-1);
  const downloaded = media ? await downloadTelegramMedia(await tokenFor(prisma, tenantId, integration.credentialId), media,
    incoming.photo ? "photo.jpg" : incoming.voice ? "voice.ogg" : incoming.video ? "video.mp4" : "attachment.bin",
    incoming.photo ? "image/jpeg" : incoming.voice ? "audio/ogg" : incoming.video ? "video/mp4" : "application/octet-stream") : null;
  return prisma.$transaction(async (tx) => {
    // Serialize deliveries for this bot; there is no unique conversation/thread constraint in the existing schema.
    const locked = await tx.integration.update({ where: { id }, data: { lastEventAt: new Date() } });
    if (locked.status !== "active") throw new ApiError(403, "integration_disabled", "Подключение отключено");
    const externalEventKey = String(update.update_id);
    const existing = await tx.inboundEvent.findUnique({ where: { integrationId_externalEventKey: { integrationId: id, externalEventKey } } });
    if (existing) return { ok: true, duplicate: true };
    const connection = await tx.channelConnection.findFirst({ where: { integrationId: id, tenantId, status: "active", channelType: "telegram" } });
    if (!connection) throw new ApiError(409, "connection_pending", "Регистрация подключения ещё не завершена");
    const externalThreadId = String(incoming.chat.id);
    const identity = await tx.externalIdentity.findFirst({ where: { tenantId, connectionId: connection.id, type: "telegram", externalId: String(incoming.from!.id) } });
    const contact = identity ? await tx.contact.findFirstOrThrow({ where: { id: identity.contactId, tenantId } }) : await tx.contact.create({ data: { tenantId, name: [incoming.from!.first_name, incoming.from!.last_name].filter(Boolean).join(" ") || incoming.from!.username || "Клиент Telegram" } });
    if (!identity) await tx.externalIdentity.create({ data: { tenantId, contactId: contact.id, integrationId: id, connectionId: connection.id, type: "telegram", externalId: String(incoming.from!.id), confirmed: true } });
    let conversation = await tx.conversation.findFirst({ where: { tenantId, connectionId: connection.id, externalThreadId } });
    if (!conversation) conversation = await tx.conversation.create({ data: { tenantId, connectionId: connection.id, externalThreadId, contactId: contact.id, mode: "human" } });
    const sharedContact = incoming.contact;
    let text = incoming.text || incoming.caption || "";
    if (sharedContact) text = [text, `Контакт: ${sharedContact.first_name || ""} ${sharedContact.phone_number}`].filter(Boolean).join("\n");
    if (media && !downloaded) text = [text, `[Вложение Telegram: ${media.file_name || (incoming.photo ? "фото" : incoming.voice ? "голосовое сообщение" : "файл")}]`].filter(Boolean).join("\n");
    if (!text && !downloaded) text = "[Сообщение Telegram неподдерживаемого типа]";
    const providerMessageId = String(incoming.message_id);
    const scoped = `telegram:${connection.id}:${externalThreadId}:${providerMessageId}`;
    const duplicateMessage = await tx.message.findUnique({ where: { connectionScopedId: scoped } });
    if (!duplicateMessage) {
      const message = await tx.message.create({ data: { tenantId, conversationId: conversation.id, senderKind: "client", direction: "inbound", type: downloaded ? "document" : "text", text: text || null, providerMessageId, connectionScopedId: scoped, createdAt: new Date(incoming.date * 1000) } });
      if (downloaded) await storeMessageAttachment(tx, { tenantId, messageId: message.id, ...downloaded, providerMessageId });
    }
    if (sharedContact && sharedContact.user_id === incoming.from!.id) {
      const phone = validateClientPhone(sharedContact.phone_number, integration.tenant.defaultRegion);
      if (phone.ok) {
        const existingPhone = await tx.contactMethod.findFirst({ where: { tenantId, contactId: contact.id, type: "phone", normalizedValue: phone.normalized } });
        if (!existingPhone) await tx.contactMethod.create({ data: { tenantId, contactId: contact.id, type: "phone", rawValue: sharedContact.phone_number, normalizedValue: phone.normalized, source: "telegram", confirmed: true } });
      }
    }
    await tx.contact.update({ where: { id: contact.id }, data: { lastSeenAt: new Date(), lastInboundMessageAt: new Date() } });
    await tx.conversation.update({ where: { id: conversation.id }, data: { needsAttention: true, attentionReason: "client_waiting", waitingFor: "MANAGER", messageRevision: { increment: duplicateMessage ? 0 : 1 } } });
    await tx.inboundEvent.create({ data: { tenantId, integrationId: id, externalEventKey, payloadHash: hash(JSON.stringify(update)), rawJson: update as Prisma.InputJsonValue, provider: "telegram", eventType: "MESSAGE_RECEIVED", status: "PROCESSED", processedAt: new Date(), test: integration.testMode } });
    await tx.integration.update({ where: { id }, data: { healthStatus: "HEALTHY", lastSuccessAt: new Date(), lastError: null } });
    return { ok: true, conversationId: conversation.id };
  });
}

export async function sendCompanyTelegram(prisma: PrismaClient, auth: AuthContext, conversationId: string, input: { text?: string; idempotencyKey?: string; attachments?: Array<{ fileName: string; mimeType: string; contentBase64: string }> }) {
  const { tenantId } = requireTenant(auth);
  await assertConversationReachable(prisma, auth, conversationId);
  const text = String(input.text || "").trim();
  if (text.length > 4096) throw new ApiError(422, "telegram_text_limit", "Telegram принимает до 4096 символов в сообщении");
  if ((input.attachments?.length || 0) > 5) throw new ApiError(422, "too_many_files", "Можно приложить до 5 файлов");
  const files = (input.attachments || []).map(file => {
    const mimeType = assertConversationMime(file.fileName, file.mimeType);
    const buffer = decodeBase64Payload(file.contentBase64);
    if (buffer.length > CONVERSATION_MAX_FILE_BYTES) throw new ApiError(422, "too_large", "Файл больше 16 МБ");
    return { ...file, mimeType, buffer };
  });
  if (!text && !files.length) throw new ApiError(422, "invalid", "Введите текст или прикрепите файл");
  const key = `telegram:${conversationId}:${input.idempotencyKey || randomUUID()}`;
  const scoped = `telegram-out:${tenantId}:${hash(key)}`;
  const claimed = await prisma.$transaction(async tx => {
    const conversation = await tx.conversation.update({ where: { tenantId_id: { tenantId, id: conversationId } }, data: { updatedAt: new Date() }, include: { connection: { include: { integration: true } } } });
    if (conversation.mode !== "human") throw new ApiError(409, "mode_locked", "Сначала возьмите диалог, затем отвечайте");
    const connection = conversation.connection;
    if (connection?.channelType !== "telegram" || connection.status !== "active" || connection.integration.status !== "active" || !conversation.externalThreadId) throw new ApiError(409, "telegram_disconnected", "Telegram-бот отключён");
    const existing = await tx.message.findUnique({ where: { connectionScopedId: scoped }, include: { attachments: true } });
    if (existing) {
      const fingerprint = (items: Array<{ fileName: string; mimeType: string; checksum: string | null }>) => JSON.stringify(items.map(item => `${item.fileName}:${item.mimeType}:${item.checksum}`).sort());
      const incomingFiles = files.map(file => ({ fileName: file.fileName, mimeType: file.mimeType, checksum: hash(file.contentBase64) }));
      // Compare decoded bytes, since equivalent base64 encodings may differ.
      for (const [index, file] of files.entries()) incomingFiles[index].checksum = createHash("sha256").update(file.buffer).digest("hex");
      if (existing.senderUserId !== auth.user.id || (existing.text || "") !== text || fingerprint(existing.attachments.map(file => ({ ...file, fileName: file.originalFileName || file.fileName }))) !== fingerprint(incomingFiles)) throw new ApiError(409, "idempotency_conflict", "Повторный ключ использован для другого сообщения");
      return { existing };
    }
    const message = await tx.message.create({ data: { tenantId, conversationId, senderKind: "staff", senderUserId: auth.user.id, direction: "outbound", text: text || null, operationState: "queued", connectionScopedId: scoped } });
    const attachmentIds: string[] = [];
    for (const file of files) {
      const stored = await storeMessageAttachment(tx, { tenantId, messageId: message.id, fileName: file.fileName, mimeType: file.mimeType, buffer: file.buffer, uploadedById: auth.user.id, sendState: "pending" });
      attachmentIds.push(stored.id);
    }
    const operation = await tx.outboundOperation.create({ data: { tenantId, conversationId, idempotencyKey: key, controlVersion: conversation.controlVersion, state: "sending" } });
    return { message, operation, messageRevision: conversation.messageRevision, attachmentIds, chatId: conversation.externalThreadId, credentialId: connection.integration.credentialId };
  });
  if (claimed.existing) return claimed.existing;
  const { message, operation } = claimed;
  try {
    const token = await tokenFor(prisma, tenantId, claimed.credentialId!);
    let providerMessageId: string | null = null;
    if (text) providerMessageId = String((await telegramCall<{ message_id: number }>(token, "sendMessage", { chat_id: claimed.chatId, text })).message_id);
    for (const [index, file] of files.entries()) {
      const form = new FormData(); form.set("chat_id", claimed.chatId!); form.set("document", new Blob([new Uint8Array(file.buffer)], { type: file.mimeType }), file.fileName);
      const sent = await telegramCall<{ message_id: number }>(token, "sendDocument", form);
      providerMessageId ||= String(sent.message_id);
      await prisma.attachment.update({ where: { id: claimed.attachmentIds![index] }, data: { sendState: "sent", providerMessageId: String(sent.message_id) } });
    }
    await prisma.$transaction(async tx => {
      await tx.message.update({ where: { id: message!.id }, data: { operationState: "accepted", providerMessageId } });
      await tx.outboundOperation.update({ where: { id: operation!.id }, data: { state: "accepted", providerRef: providerMessageId } });
      await tx.conversation.updateMany({ where: { id: conversationId, messageRevision: claimed.messageRevision }, data: { waitingFor: "CLIENT", needsAttention: false, attentionReason: null } });
      await tx.conversation.update({ where: { id: conversationId }, data: { messageRevision: { increment: 1 } } });
    });
  } catch (error) {
    await prisma.$transaction(async tx => {
      await tx.message.update({ where: { id: message!.id }, data: { operationState: "unknown" } });
      await tx.outboundOperation.update({ where: { id: operation!.id }, data: { state: "unknown", error: "Не подтверждён результат отправки Telegram" } });
    });
    throw error;
  }
  return prisma.message.findUnique({ where: { id: message!.id }, include: { attachments: true } });
}
