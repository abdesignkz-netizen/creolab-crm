import type { Prisma, PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import { enqueueConversationContext } from "./conversationContextQueue.ts";
import { readTelegramDelivery, recoverTelegramManual } from "./telegramManualState.ts";

type Delivery = { text: "none" | "pending" | "sending" | "accepted"; leaseUntil: number; messageRevision: number };
const keyFor = (tenantId: string, operationId: string) => ({ scope: "telegram.manual.delivery", actorKey: tenantId, key: operationId });
const leaseUntil = () => Date.now() + 300_000;
async function save(tx: Prisma.TransactionClient, tenantId: string, operationId: string, value: Delivery) {
  const key = keyFor(tenantId, operationId), data = { requestHash: operationId,
    resultJson: value as unknown as Prisma.InputJsonValue, expiresAt: new Date("9999-01-01") };
  await tx.idempotencyRecord.upsert({ where: { scope_actorKey_key: key }, create: { ...key, ...data }, update: data });
}
async function lock(tx: Prisma.TransactionClient, tenantId: string, operationId: string) {
  await tx.$queryRaw`SELECT id FROM "OutboundOperation" WHERE id = ${operationId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  const operation = await tx.outboundOperation.findFirstOrThrow({ where: { id: operationId, tenantId } });
  const record = await tx.idempotencyRecord.findUnique({ where: { scope_actorKey_key: keyFor(tenantId, operationId) } });
  return { operation, delivery: record?.resultJson as unknown as Delivery | undefined };
}
export async function beginTelegramDelivery(tx: Prisma.TransactionClient, tenantId: string, operationId: string, text: boolean, messageRevision: number) {
  await save(tx, tenantId, operationId, { text: text ? "pending" : "none", leaseUntil: leaseUntil(), messageRevision });
}
/** Persist each external intent and its acknowledgement under the same lock as recovery. */
export async function telegramDeliveryPart(tx: Prisma.TransactionClient, tenantId: string, operationId: string, part: string, providerMessageId?: string) {
  const { operation, delivery } = await lock(tx, tenantId, operationId);
  if (operation.state !== "sending" || !delivery) throw new ApiError(409, "telegram_delivery_changed", "Результат отправки требует проверки. Обновите диалог.");
  if (part === "text") {
    delivery.text = providerMessageId ? "accepted" : "sending";
    if (providerMessageId) await tx.message.update({ where: { id: operation.providerRef!, tenantId }, data: { providerMessageId } });
  } else await tx.attachment.updateMany({ where: { id: part, tenantId, messageId: operation.providerRef },
    data: providerMessageId ? { sendState: "sent", providerMessageId } : { sendState: "sending" } });
  delivery.leaseUntil = leaseUntil();
  await save(tx, tenantId, operationId, delivery);
}

/** Finalize from persisted evidence, including after restart; this function cannot send. */
export async function settleTelegramDelivery(tx: Prisma.TransactionClient, tenantId: string, operationId: string, expiredBefore?: number) {
  if (await readTelegramDelivery(tx, tenantId, operationId)) {
    return recoverTelegramManual(tx, tenantId, operationId, expiredBefore ?? Date.now());
  }
  const { operation, delivery } = await lock(tx, tenantId, operationId);
  if (operation.state !== "sending" || (expiredBefore !== undefined && delivery && delivery.leaseUntil > expiredBefore)) return;
  const message = operation.providerRef ? await tx.message.findFirst({ where: { id: operation.providerRef, tenantId }, include: { attachments: true } }) : null;
  // Older manual operations may not link to a message; never guess by "latest".
  if (!message) {
    await tx.outboundOperation.update({ where: { id: operationId }, data: { state: "unknown", error: "Не подтверждён результат отправки Telegram" } });
    return;
  }
  const files = message.attachments;
  const unknown = !delivery || delivery.text === "sending" || files.some(file => ["sending", "unknown"].includes(file.sendState));
  const accepted = Boolean(delivery && ["accepted", "none"].includes(delivery.text) && files.every(file => file.sendState === "sent"));
  const partial = Boolean(message.providerMessageId || files.some(file => file.sendState === "sent"));
  const state = unknown ? "unknown" : accepted ? "accepted" : partial ? "partial" : "failed";
  await tx.outboundOperation.update({ where: { id: operationId }, data: { state, error: unknown ? "Не подтверждён результат отправки Telegram" : accepted ? null : "Не все части сообщения отправлены" } });
  await tx.attachment.updateMany({ where: { tenantId, messageId: message.id, sendState: "sending" }, data: { sendState: "unknown" } });
  await tx.message.update({ where: { id: message.id }, data: { operationState: state,
    providerMessageId: message.providerMessageId || files.find(file => file.providerMessageId)?.providerMessageId || null } });
  if (accepted && !unknown) {
    await tx.conversation.updateMany({ where: { id: operation.conversationId, tenantId, mode: "human", status: "open",
      controlVersion: operation.controlVersion, messageRevision: delivery!.messageRevision }, data: { waitingFor: "CLIENT", needsAttention: false, attentionReason: null } });
    await tx.conversation.update({ where: { id: operation.conversationId, tenantId }, data: { messageRevision: { increment: 1 } } });
    await enqueueConversationContext(tx, tenantId, operation.conversationId, message.id);
  }
}

export async function recoverTelegramDeliveries(prisma: PrismaClient, now = new Date()) {
  const rows = await prisma.outboundOperation.findMany({ where: { idempotencyKey: { startsWith: "telegram:" }, state: "sending",
    createdAt: { lt: new Date(now.getTime() - 300_000) } }, orderBy: { createdAt: "asc" }, take: 50 });
  for (const row of rows) await prisma.$transaction(tx => settleTelegramDelivery(tx, row.tenantId, row.id, now.getTime()));
}
