import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Prisma, PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { assertConversationReachable, requireTenant } from "../lib/access.ts";
import { resolveUploadPath } from "../lib/storage.ts";
import { writeAudit } from "../lib/audit.ts";
import { assertConversationMime, decodeBase64Payload, storeMessageAttachment, CONVERSATION_MAX_FILE_BYTES } from "./conversationMedia.ts";
import { telegramCall, tokenFor } from "./telegramTransport.ts";
import { telegramBusy, telegramChanged, telegramContentHash, telegramCredentialHash, telegramDigest, telegramDispatchBlock,
  telegramLease, telegramRevision, readTelegramDelivery, saveTelegramDelivery, loadTelegramDelivery, lockTelegramConversation,
  publishTelegramDelivery, type TelegramDelivery } from "./telegramManualState.ts";

type Input = { text?: string; idempotencyKey?: string; attachments?: Array<{ fileName: string; mimeType: string; contentBase64: string }> };
const blocked = (reason: string) => new ApiError(409, "delivery_retry_blocked", "Отправка остановлена: изменились диалог, подключение или права доступа. Обновите результат отправки.", undefined, { reason });

export async function sendCompanyTelegram(prisma: PrismaClient, auth: AuthContext, conversationId: string, input: Input) {
  const { tenantId } = requireTenant(auth);
  await assertConversationReachable(prisma, auth, conversationId);
  const text = String(input.text || "").trim();
  if (text.length > 4096) throw new ApiError(422, "telegram_text_limit", "Telegram принимает до 4096 символов в сообщении");
  if ((input.attachments?.length || 0) > 5) throw new ApiError(422, "too_many_files", "Можно приложить до 5 файлов");
  const files = (input.attachments || []).map(file => {
    const mimeType = assertConversationMime(file.fileName, file.mimeType), buffer = decodeBase64Payload(file.contentBase64);
    if (buffer.length > CONVERSATION_MAX_FILE_BYTES) throw new ApiError(422, "too_large", "Файл больше 16 МБ");
    if (!buffer.length) throw new ApiError(422, "file_empty", "Файл пустой");
    return { fileName: file.fileName, mimeType, buffer };
  });
  if (!text && !files.length) throw new ApiError(422, "invalid", "Введите текст или прикрепите файл");
  const key = `telegram:${conversationId}:${input.idempotencyKey || randomUUID()}`;
  const scoped = `telegram-out-v2:${tenantId}:${telegramDigest(key)}`, oldScoped = `telegram-out:${tenantId}:${telegramDigest(key)}`;
  const claim = randomUUID();
  const prepared = await prisma.$transaction(async tx => {
    await lockTelegramConversation(tx, tenantId, conversationId);
    const conversation = await tx.conversation.findFirstOrThrow({ where: { id: conversationId, tenantId }, include: { connection: { include: { integration: true } }, contact: true } });
    const existing = await tx.message.findFirst({ where: { tenantId, conversationId, connectionScopedId: { in: [scoped, oldScoped] } }, include: { attachments: true } });
    if (existing) {
      const fingerprint = (items: Array<{ fileName: string; mimeType: string; checksum: string | null }>) => JSON.stringify(items.map(f => [f.fileName, f.mimeType, f.checksum]).sort());
      if (existing.senderUserId !== auth.user.id || (existing.text || "") !== text
        || fingerprint(existing.attachments.map(f => ({ ...f, fileName: f.originalFileName || f.fileName }))) !== fingerprint(files.map(f => ({ ...f, checksum: telegramDigest(f.buffer) })))) {
        throw new ApiError(409, "idempotency_conflict", "Повторный ключ использован для другого сообщения");
      }
      return { existing };
    }
    if (conversation.mode !== "human" || conversation.status !== "open") throw new ApiError(409, "mode_locked", "Сначала возьмите открытый диалог, затем отвечайте");
    const connection = conversation.connection;
    if (connection?.channelType !== "telegram" || connection.tenantId !== tenantId || connection.status !== "active" || connection.integration.status !== "active"
      || connection.integration.tenantId !== tenantId || connection.integration.type !== "telegram_bot" || !/^\d+$/.test(conversation.externalThreadId || "") || !/^\d+$/.test(connection.externalRef || "")) {
      throw new ApiError(409, "telegram_disconnected", "Telegram-бот отключён");
    }
    const credential = await tx.credential.findFirst({ where: { id: connection.integration.credentialId || "", tenantId, kind: "telegram_bot" } });
    if (!credential) throw new ApiError(409, "telegram_disconnected", "Подключите Telegram-бота компании");
    const message = await tx.message.create({ data: { tenantId, conversationId, senderKind: "staff", senderUserId: auth.user.id, direction: "outbound", text: text || null, operationState: "sending", connectionScopedId: scoped } });
    const attachments = [];
    for (const file of files) attachments.push(await storeMessageAttachment(tx, { tenantId, messageId: message.id, ...file, uploadedById: auth.user.id, sendState: "pending" }));
    const operation = await tx.outboundOperation.create({ data: { tenantId, conversationId, idempotencyKey: key, controlVersion: conversation.controlVersion, state: "sending", providerRef: message.id } });
    const delivery: TelegramDelivery = { version: 2, messageId: message.id, actorUserId: auth.user.id, contactId: conversation.contactId,
      connectionId: connection.id, integrationId: connection.integrationId, botId: connection.externalRef!, publicKey: connection.integration.publicKey,
      credentialHash: telegramCredentialHash(credential), chatId: conversation.externalThreadId!,
      recipient: [conversation.contact?.name || "Клиент Telegram", `Telegram ID ${conversation.externalThreadId}`].join(" · "),
      contentHash: telegramContentHash(message.text, attachments), messageRevision: conversation.messageRevision, claim, leaseUntil: telegramLease(),
      parts: [...(text ? [{ id: "text", state: "pending" as const, attempt: 0 }] : []), ...attachments.map(f => ({ id: f.id, state: "pending" as const, attempt: 0 }))] };
    const block = await telegramDispatchBlock(tx, tenantId, operation, delivery);
    if (block) throw blocked(block);
    await saveTelegramDelivery(tx, tenantId, operation.id, delivery);
    return { operation };
  }, { timeout: 30_000 });
  if (prepared.existing) return prepared.existing;
  return dispatchTelegramManual(prisma, tenantId, prepared.operation!.id, claim);
}

/** Only a new explicit request can claim unsent parts; repeated POSTs cannot resend. */
export async function retryTelegramManual(prisma: PrismaClient, tenantId: string, conversationId: string, messageId: string, revision: string, reviewerId: string) {
  const claim = randomUUID();
  const operationId = await prisma.$transaction(async tx => {
    await lockTelegramConversation(tx, tenantId, conversationId);
    const { operation, delivery } = await loadTelegramDelivery(tx, tenantId, conversationId, messageId);
    if (telegramRevision(operation, delivery) !== revision) throw telegramChanged();
    if (telegramBusy(delivery)) throw blocked("busy");
    if (delivery.parts.some(p => ["unknown", "sending"].includes(p.state))) throw blocked("unknown");
    if (delivery.parts.every(p => p.state === "accepted")) throw blocked("complete");
    const block = await telegramDispatchBlock(tx, tenantId, operation, delivery, reviewerId);
    if (block) throw blocked(block);
    delivery.claim = claim; delivery.leaseUntil = telegramLease();
    await publishTelegramDelivery(tx, tenantId, operation.id, delivery);
    await writeAudit(tx, { tenantId, actorUserId: reviewerId, action: "message.delivery_retry", entityType: "message", entityId: messageId,
      changes: { conversationId, channel: "telegram", partIds: delivery.parts.filter(p => p.state !== "accepted").map(p => p.id) } });
    return operation.id;
  });
  return dispatchTelegramManual(prisma, tenantId, operationId, claim, reviewerId);
}

async function dispatchTelegramManual(prisma: PrismaClient, tenantId: string, operationId: string, claim: string, reviewerId?: string) {
  const operation = await prisma.outboundOperation.findFirstOrThrow({ where: { id: operationId, tenantId } });
  const delivery = await readTelegramDelivery(prisma, tenantId, operationId);
  if (!delivery || delivery.claim !== claim) throw telegramChanged();
  const withClaim = <T>(fn: (tx: Prisma.TransactionClient, value: TelegramDelivery) => Promise<T>) => prisma.$transaction(async tx => {
    await lockTelegramConversation(tx, tenantId, operation.conversationId);
    const current = await readTelegramDelivery(tx, tenantId, operationId);
    if (!current || current.claim !== claim || !telegramBusy(current)) throw telegramChanged();
    return fn(tx, current);
  });
  try {
    for (const part of delivery.parts) {
      if (part.state === "accepted") continue;
      const { message } = await loadTelegramDelivery(prisma, tenantId, operation.conversationId, delivery.messageId);
      let body: Record<string, unknown> | FormData = { chat_id: delivery.chatId, text: message.text };
      if (part.id !== "text") {
        const file = message.attachments.find(f => f.id === part.id);
        let bytes: Buffer;
        try {
          if (!file) throw new Error("missing");
          bytes = await readFile(resolveUploadPath(file.storageKey));
          if (bytes.length > CONVERSATION_MAX_FILE_BYTES || bytes.length !== file.sizeBytes || telegramDigest(bytes) !== file.checksum) throw new Error("changed");
        } catch { throw new ApiError(409, "attachment_changed", "Файл отсутствует или изменился. Повтор этой отправки недоступен; прикрепите исходный файл новым сообщением."); }
        const form = new FormData(); form.set("chat_id", delivery.chatId);
        form.set("document", new Blob([new Uint8Array(bytes)], { type: file!.mimeType }), file!.originalFileName || file!.fileName); body = form;
      }
      const integration = await prisma.integration.findFirstOrThrow({ where: { id: delivery.integrationId, tenantId } });
      const token = await tokenFor(prisma, tenantId, integration.credentialId);
      if (token.split(":")[0] !== delivery.botId) throw blocked("connection_changed");
      // No async preparation after this guard: persist intent, then call the exact original bot/chat.
      await withClaim(async (tx, current) => {
        const block = await telegramDispatchBlock(tx, tenantId, operation, current, reviewerId);
        if (block) throw blocked(block);
        const item = current.parts.find(p => p.id === part.id)!;
        if (!["pending", "failed"].includes(item.state)) throw telegramChanged();
        item.state = "sending"; item.attempt++; item.error = null; item.providerMessageId = null;
        delete item.reconciledBy; delete item.reconciledAt; delete item.reconciliationNote;
        current.leaseUntil = telegramLease();
        await publishTelegramDelivery(tx, tenantId, operationId, current);
      });
      let providerId: string;
      try {
        const reply = await telegramCall<{ message_id?: number }>(token, part.id === "text" ? "sendMessage" : "sendDocument", body);
        if (!Number.isSafeInteger(reply?.message_id) || Number(reply.message_id) <= 0) throw new ApiError(502, "telegram_send_unknown", "Telegram не подтвердил отправку");
        providerId = String(reply.message_id);
      } catch (error) {
        const rejected = error instanceof ApiError && error.code === "telegram_provider" && (error.details as { definitelyNotSent?: boolean })?.definitelyNotSent;
        await withClaim(async (tx, current) => {
          const item = current.parts.find(p => p.id === part.id)!;
          item.state = rejected ? "failed" : "unknown"; item.error = rejected ? "Telegram отклонил отправку" : "Не подтверждён результат отправки Telegram";
          await publishTelegramDelivery(tx, tenantId, operationId, current);
        });
        throw error;
      }
      await withClaim(async (tx, current) => {
        Object.assign(current.parts.find(p => p.id === part.id)!, { state: "accepted", providerMessageId: providerId, error: null });
        await publishTelegramDelivery(tx, tenantId, operationId, current);
      });
    }
  } finally {
    await prisma.$transaction(async tx => {
      await lockTelegramConversation(tx, tenantId, operation.conversationId);
      const current = await readTelegramDelivery(tx, tenantId, operationId);
      // A late completion must never overwrite a staff review or a newer retry claim.
      if (!current || current.claim !== claim) return;
      for (const part of current.parts) if (part.state === "sending") { part.state = "unknown"; part.error = "Не подтверждён результат отправки Telegram"; }
      current.claim = null; current.leaseUntil = 0;
      await publishTelegramDelivery(tx, tenantId, operationId, current);
    });
  }
  return prisma.message.findFirstOrThrow({ where: { id: delivery.messageId, tenantId }, include: { attachments: true } });
}
