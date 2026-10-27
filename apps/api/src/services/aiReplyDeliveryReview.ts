import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@creolab/db";
import type { MessageDeliveryReview, MessageDeliveryReconciliation } from "@creolab/contracts";
import type { AuthContext } from "../lib/types.ts";
import { ApiError } from "../errors.ts";
import { assertConversationReachable, isManager, requireNotManager, requireTenant } from "../lib/access.ts";
import { writeAudit } from "../lib/audit.ts";
import { writeActivity } from "./contactService.ts";
import { aiReplyBlock, aiReplyBusy, aiReplyChanged, aiReplyRevision, enqueueAiReply, lockAiReply, publishAiReply, readAiReply } from "./aiReplyDeliveryState.ts";

async function access(prisma: PrismaClient, auth: AuthContext, conversationId: string, write = false) {
  const { tenantId } = requireTenant(auth);
  if (write) requireNotManager(auth, "Сверить результат и повторить ответ ИИ может руководитель компании.");
  await assertConversationReachable(prisma, auth, conversationId); return tenantId;
}
async function load(db: Parameters<typeof readAiReply>[0], tenantId: string, conversationId: string, messageId: string) {
  const message = await db.message.findFirst({ where: { id: messageId, tenantId, conversationId, senderKind: "ai", direction: "outbound", internal: false } });
  if (!message) throw new ApiError(404, "not_found", "Ответ ИИ не найден");
  const value = await readAiReply(db, tenantId, messageId);
  if (!value || value.conversationId !== conversationId) throw new ApiError(409, "delivery_untracked", "Нет сохранённых данных о получателе и попытке отправки этого ответа ИИ. Автоматический повтор недоступен.");
  return { message, value };
}
export async function getAiReplyDeliveryReview(prisma: PrismaClient, auth: AuthContext, conversationId: string, messageId: string): Promise<MessageDeliveryReview> {
  const tenantId = await access(prisma, auth, conversationId), { message, value: v } = await load(prisma, tenantId, conversationId, messageId);
  const busy = aiReplyBusy(v), unknown = v.state === "unknown" || (!busy && v.state === "sending");
  const block = isManager(auth) ? "permissions" : busy ? "busy" : unknown ? "unknown" : v.state === "accepted" ? "complete" : await aiReplyBlock(prisma, tenantId, { ...v, reviewerId: auth.user.id });
  const checker = v.checkedBy ? await prisma.membership.findFirst({ where: { tenantId, userId: v.checkedBy }, select: { user: { select: { name: true } } } }) : null;
  return { channel: v.channel === "telegram_bot" ? "telegram" : v.channel === "instagram_direct" ? "instagram" : v.channel,
    aiReply: true, messageId, conversationId, revision: aiReplyRevision(v), text: v.text, createdAt: message.createdAt.toISOString(), recipient: v.recipient, campaignId: null,
    busy, needsCheck: unknown, canReconcile: !isManager(auth) && !busy, canRetry: !block, retryBlock: block,
    parts: [{ id: "text", label: "Ответ ИИ", state: unknown ? "unknown" : v.state, providerMessageId: v.providerMessageId,
      checkedBy: v.checkedBy ? checker?.user.name || "Сотрудник компании" : null, checkedAt: v.checkedAt || null, note: v.note || null }] };
}
export async function reconcileAiReplyDelivery(prisma: PrismaClient, auth: AuthContext, conversationId: string, messageId: string, input: MessageDeliveryReconciliation) {
  const tenantId = await access(prisma, auth, conversationId, true), note = input.note?.trim() || "";
  if (!input.revision || input.partId !== "text" || !["sent", "not_sent"].includes(input.outcome) || note.length < 8 || note.length > 1000) throw new ApiError(422, "invalid", "Укажите результат и пояснение проверки от 8 до 1000 символов.");
  await prisma.$transaction(async tx => {
    await lockAiReply(tx, tenantId, conversationId);
    if (!await tx.membership.count({ where: { tenantId, userId: auth.user.id, active: true, role: { not: "manager" }, tenant: { status: "active" } } })) throw new ApiError(403, "forbidden", "Нет прав на сверку");
    const { value: v } = await load(tx, tenantId, conversationId, messageId);
    if (aiReplyRevision(v) !== input.revision) throw aiReplyChanged();
    if (aiReplyBusy(v)) throw new ApiError(409, "delivery_busy", "Ответ ещё отправляется");
    if (!["unknown", "sending"].includes(v.state)) throw new ApiError(409, "already_reconciled", "Результат уже известен");
    v.state = input.outcome === "sent" ? "accepted" : "failed"; v.claim = null; v.leaseUntil = 0; v.queued = false;
    v.checkedBy = auth.user.id; v.checkedAt = new Date().toISOString(); v.note = note;
    await publishAiReply(tx, tenantId, v);
    const changes = { conversationId, messageId, channel: v.channel, partId: "text", after: v.state, reason: note, aiReply: true };
    await writeAudit(tx, { tenantId, actorUserId: auth.user.id, action: "message.delivery_reconciled", entityType: "message", entityId: messageId, changes });
    if (v.contactId && await tx.contact.count({ where: { id: v.contactId, tenantId } })) await writeActivity(tx, { tenantId, contactId: v.contactId,
      type: "message.delivery_reconciled", title: "Отправка ответа ИИ сверена", description: note, actorType: "user", actorId: auth.user.id, metadata: changes });
  });
  return getAiReplyDeliveryReview(prisma, auth, conversationId, messageId);
}
export async function retryAiReplyDelivery(prisma: PrismaClient, auth: AuthContext, conversationId: string, messageId: string, revision: string) {
  const tenantId = await access(prisma, auth, conversationId, true);
  await prisma.$transaction(async tx => {
    await lockAiReply(tx, tenantId, conversationId); const { value: v } = await load(tx, tenantId, conversationId, messageId);
    if (aiReplyRevision(v) !== revision) throw aiReplyChanged();
    if (aiReplyBusy(v) || ["unknown", "sending", "accepted"].includes(v.state)) throw new ApiError(409, "delivery_retry_blocked", "Сначала обновите и проверьте результат отправки");
    v.reviewerId = auth.user.id; const block = await aiReplyBlock(tx, tenantId, v);
    if (block) throw new ApiError(409, "delivery_retry_blocked", "Ответ уже не соответствует текущему диалогу или настройкам ИИ. Подготовьте актуальный ответ в диалоге.", undefined, { reason: block });
    v.queued = true; v.claim = null; v.leaseUntil = 0; v.intent = false; v.canceled = false; v.queueToken = randomUUID(); v.generation++;
    await publishAiReply(tx, tenantId, v); await enqueueAiReply(tx, tenantId, v);
    const changes = { conversationId, messageId, channel: v.channel, aiReply: true, generation: v.generation };
    await writeAudit(tx, { tenantId, actorUserId: auth.user.id, action: "message.delivery_retry", entityType: "message", entityId: messageId, changes });
    if (v.contactId && await tx.contact.count({ where: { id: v.contactId, tenantId } })) await writeActivity(tx, { tenantId, contactId: v.contactId,
      type: "message.delivery_retry", title: "Повтор сохранённого ответа ИИ", actorType: "user", actorId: auth.user.id, metadata: changes });
  });
  return getAiReplyDeliveryReview(prisma, auth, conversationId, messageId);
}
