import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@creolab/db";
import type { MessageDeliveryPart, MessageRetryBlock } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { enqueueConversationContext } from "./conversationContextQueue.ts";

export type TelegramPart = { id: string; state: MessageDeliveryPart["state"]; attempt: number;
  providerMessageId?: string | null; error?: string | null;
  reconciledBy?: string; reconciledAt?: string; reconciliationNote?: string };
export type TelegramDelivery = { version: 2; messageId: string; actorUserId: string; contactId: string | null;
  connectionId: string; integrationId: string; botId: string; publicKey: string | null; credentialHash: string;
  chatId: string; recipient: string; contentHash: string; messageRevision: number; completed?: boolean;
  claim: string | null; leaseUntil: number; parts: TelegramPart[] };
export type TelegramDb = PrismaClient | Prisma.TransactionClient;
export const telegramDigest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const telegramLease = () => Date.now() + 300_000;
export const telegramBusy = (value: TelegramDelivery) => Boolean(value.claim && value.leaseUntil > Date.now());
export const telegramChanged = () => new ApiError(409, "delivery_changed", "Результат отправки изменился. Обновите проверку.");
export const telegramRevision = (op: { id: string; state: string; controlVersion: number }, value: TelegramDelivery) =>
  telegramDigest(JSON.stringify([op.id, op.state, op.controlVersion, value]));
const keyFor = (tenantId: string, operationId: string) => ({ scope: "telegram.manual.delivery", actorKey: tenantId, key: operationId });
export async function readTelegramDelivery(db: TelegramDb, tenantId: string, operationId: string) {
  const row = await db.idempotencyRecord.findUnique({ where: { scope_actorKey_key: keyFor(tenantId, operationId) } });
  const value = row?.resultJson as unknown as TelegramDelivery | undefined;
  return value?.version === 2 ? value : null;
}
export async function saveTelegramDelivery(db: TelegramDb, tenantId: string, operationId: string, value: TelegramDelivery) {
  const key = keyFor(tenantId, operationId), data = { requestHash: operationId,
    resultJson: value as unknown as Prisma.InputJsonValue, expiresAt: new Date("9999-01-01") };
  await db.idempotencyRecord.upsert({ where: { scope_actorKey_key: key }, create: { ...key, ...data }, update: data });
}
export async function lockTelegramConversation(tx: Prisma.TransactionClient, tenantId: string, id: string) {
  await tx.$queryRaw`SELECT id FROM "Conversation" WHERE id = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
}
export const telegramCredentialHash = (credential: { id: string; encryptedValue: string }) =>
  telegramDigest(JSON.stringify([credential.id, credential.encryptedValue]));
export const telegramContentHash = (text: string | null, files: Array<{ id: string; storageKey: string; originalFileName: string | null; fileName: string; mimeType: string; checksum: string | null; sizeBytes: number }>) =>
  telegramDigest(JSON.stringify([text || "", files.map(f => [f.id, f.storageKey, f.originalFileName || f.fileName, f.mimeType, f.checksum, f.sizeBytes]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]));

export async function loadTelegramDelivery(db: TelegramDb, tenantId: string, conversationId: string, messageId: string) {
  const message = await db.message.findFirst({ where: { id: messageId, tenantId, conversationId, internal: false, direction: "outbound", senderKind: "staff" }, include: { attachments: true } });
  if (!message) throw new ApiError(404, "not_found", "Сообщение не найдено");
  const operations = await db.outboundOperation.findMany({ where: { tenantId, conversationId, providerRef: messageId }, take: 2 });
  const operation = operations.length === 1 && operations[0].idempotencyKey.startsWith("telegram:") ? operations[0] : null;
  const delivery = operation ? await readTelegramDelivery(db, tenantId, operation.id) : null;
  if (!operation || !delivery || delivery.messageId !== messageId) throw new ApiError(409, "delivery_untracked", "Для этой отправки нет полной истории частей. Повтор недоступен; проверьте результат в Telegram.");
  return { message, operation, delivery };
}

/** Check the original identity, content and current access immediately before each external call. */
export async function telegramDispatchBlock(db: TelegramDb, tenantId: string, operation: { conversationId: string; controlVersion: number }, delivery: TelegramDelivery, reviewerId?: string): Promise<MessageRetryBlock> {
  const conv = await db.conversation.findFirst({ where: { id: operation.conversationId, tenantId }, include: { connection: { include: { integration: true } } } });
  if (!conv || conv.status !== "open" || conv.mode !== "human" || conv.controlVersion !== operation.controlVersion
    || conv.contactId !== delivery.contactId || conv.externalThreadId !== delivery.chatId || conv.connectionId !== delivery.connectionId) return "conversation_changed";
  const member = await db.membership.findFirst({ where: { tenantId, userId: delivery.actorUserId, active: true, tenant: { status: "active" } } });
  if (!member || (member.role === "manager" && conv.assigneeMembershipId !== member.id)) return "access_changed";
  if (reviewerId && !await db.membership.count({ where: { tenantId, userId: reviewerId, active: true, role: { not: "manager" }, tenant: { status: "active" } } })) return "permissions";
  const connection = conv.connection, integration = connection?.integration;
  if (!connection || connection.tenantId !== tenantId || connection.channelType !== "telegram" || connection.status !== "active"
    || connection.externalRef !== delivery.botId || integration?.tenantId !== tenantId || integration.id !== delivery.integrationId
    || integration.type !== "telegram_bot" || integration.status !== "active" || integration.publicKey !== delivery.publicKey) return "connection_changed";
  const credential = await db.credential.findFirst({ where: { id: integration.credentialId || "", tenantId, kind: "telegram_bot" } });
  if (!credential || telegramCredentialHash(credential) !== delivery.credentialHash) return "connection_changed";
  const message = await db.message.findFirst({ where: { id: delivery.messageId, tenantId, conversationId: conv.id, senderKind: "staff", senderUserId: delivery.actorUserId, internal: false, direction: "outbound" }, include: { attachments: true } });
  if (!message || telegramContentHash(message.text, message.attachments) !== delivery.contentHash) return "conversation_changed";
  return null;
}

/** Publish durable facts only. Neither recovery nor manual review sends anything. */
export async function publishTelegramDelivery(tx: Prisma.TransactionClient, tenantId: string, operationId: string, delivery: TelegramDelivery) {
  const operation = await tx.outboundOperation.findFirstOrThrow({ where: { id: operationId, tenantId } });
  const complete = delivery.parts.every(p => p.state === "accepted");
  const state = delivery.claim ? "sending" : delivery.parts.some(p => p.state === "unknown" || p.state === "sending") ? "unknown"
    : complete ? "accepted" : delivery.parts.some(p => p.state === "accepted") ? "partial" : "failed";
  await tx.outboundOperation.update({ where: { id: operationId, tenantId }, data: { state, error: state === "unknown" ? "Не подтверждён результат отправки Telegram" : ["failed", "partial"].includes(state) ? "Не все части сообщения отправлены" : null } });
  await tx.message.update({ where: { id: delivery.messageId, tenantId }, data: { operationState: state,
    providerMessageId: delivery.parts.find(p => p.providerMessageId)?.providerMessageId || null,
    ...(state === "accepted" && delivery.parts.some(p => p.reconciledBy) ? { receiptState: "reconciled" } : {}) } });
  for (const part of delivery.parts.filter(p => p.id !== "text")) await tx.attachment.updateMany({ where: { id: part.id, tenantId, messageId: delivery.messageId },
    data: { sendState: part.state === "accepted" ? "sent" : part.state, sendError: part.error || null, providerMessageId: part.providerMessageId || null } });
  if (state === "accepted" && !delivery.completed) {
    // A reply to an older message must not clear a newer incoming message or handoff.
    await tx.conversation.updateMany({ where: { id: operation.conversationId, tenantId, mode: "human", status: "open", controlVersion: operation.controlVersion,
      contactId: delivery.contactId, connectionId: delivery.connectionId, externalThreadId: delivery.chatId, messageRevision: delivery.messageRevision },
      data: { waitingFor: "CLIENT", needsAttention: false, attentionReason: null } });
    await tx.conversation.update({ where: { id: operation.conversationId, tenantId }, data: { messageRevision: { increment: 1 } } });
    await enqueueConversationContext(tx, tenantId, operation.conversationId, delivery.messageId);
    delivery.completed = true;
  }
  await saveTelegramDelivery(tx, tenantId, operationId, delivery);
}

export async function recoverTelegramManual(tx: Prisma.TransactionClient, tenantId: string, operationId: string, now: number) {
  const op = await tx.outboundOperation.findFirstOrThrow({ where: { id: operationId, tenantId } });
  await lockTelegramConversation(tx, tenantId, op.conversationId);
  const value = await readTelegramDelivery(tx, tenantId, operationId);
  if (!value?.claim || value.leaseUntil > now) return;
  for (const part of value.parts) if (part.state === "sending") { part.state = "unknown"; part.error = "Не подтверждён результат отправки Telegram"; }
  value.claim = null; value.leaseUntil = 0;
  await publishTelegramDelivery(tx, tenantId, operationId, value);
}
