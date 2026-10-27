import type { PrismaClient } from "@creolab/db";
import type { MessageDeliveryReconciliation, MessageDeliveryReview, MessageRetryBlock } from "@creolab/contracts";
import type { AuthContext } from "../lib/types.ts";
import { ApiError } from "../errors.ts";
import { assertConversationReachable, isManager, requireNotManager, requireTenant } from "../lib/access.ts";
import { writeAudit } from "../lib/audit.ts";
import { writeActivity } from "./contactService.ts";
import { loadDirectWaDelivery, lockDirectWaConversation, publishDirectWaDelivery, directWaBusy, directWaChanged, directWaDispatchBlock, directWaRevision } from "./directWhatsAppDeliveryState.ts";
import { retryDirectWhatsAppManual } from "./directWhatsAppManualDelivery.ts";

async function access(prisma: PrismaClient, auth: AuthContext, conversationId: string, write = false) {
  const { tenantId } = requireTenant(auth);
  if (write) requireNotManager(auth, "Сверить отправку и разрешить повтор может руководитель компании.");
  await assertConversationReachable(prisma, auth, conversationId);
  return tenantId;
}

export async function getDirectWaDeliveryReview(prisma: PrismaClient, auth: AuthContext, conversationId: string, messageId: string): Promise<MessageDeliveryReview> {
  const tenantId = await access(prisma, auth, conversationId);
  const { message, operation, delivery } = await loadDirectWaDelivery(prisma, tenantId, conversationId, messageId);
  const busy = directWaBusy(delivery, operation.state);
  const users = await prisma.membership.findMany({ where: { tenantId, userId: { in: delivery.parts.flatMap(p => p.reconciledBy ? [p.reconciledBy] : []) } }, select: { userId: true, user: { select: { name: true } } } });
  const names = new Map(users.map(row => [row.userId, row.user.name]));
  const block: MessageRetryBlock = isManager(auth) ? "permissions" : busy ? "busy"
    : delivery.parts.some(p => ["unknown", "sending"].includes(p.state)) ? "unknown"
    : delivery.parts.every(p => p.state === "accepted") ? "complete"
    : await directWaDispatchBlock(prisma, tenantId, operation, { ...delivery, reviewerId: auth.user.id }, "retry");
  return { channel: delivery.channel, messageId, conversationId, revision: directWaRevision(operation, delivery), text: message.text, createdAt: message.createdAt.toISOString(),
    recipient: delivery.recipient, campaignId: delivery.campaign?.id || null, busy, needsCheck: delivery.parts.some(p => p.state === "unknown" || (!busy && p.state === "sending")),
    canReconcile: !isManager(auth) && !busy, canRetry: block === null, retryBlock: block,
    parts: delivery.parts.map(part => ({ id: part.id, label: part.id === "text" ? "Сообщение" : message.attachments.find(f => f.id === part.id)?.originalFileName || message.attachments.find(f => f.id === part.id)?.fileName || "Файл",
      state: part.state === "sending" && !busy ? "unknown" : part.state, providerMessageId: part.providerMessageId || null,
      checkedBy: part.reconciledBy ? names.get(part.reconciledBy) || "Сотрудник компании" : null, checkedAt: part.reconciledAt || null, note: part.reconciliationNote || null })) };
}

export async function reconcileDirectWaDelivery(prisma: PrismaClient, auth: AuthContext, conversationId: string, messageId: string, input: MessageDeliveryReconciliation) {
  const tenantId = await access(prisma, auth, conversationId, true), note = String(input.note || "").trim();
  if (!input.revision || !["sent", "not_sent"].includes(input.outcome) || note.length < 8 || note.length > 1000) throw new ApiError(422, "invalid", "Укажите результат и пояснение проверки от 8 до 1000 символов.");
  const campaignId = await prisma.$transaction(async tx => {
    await lockDirectWaConversation(tx, tenantId, conversationId);
    if (!await tx.membership.count({ where: { tenantId, userId: auth.user.id, active: true, role: { not: "manager" }, tenant: { status: "active" } } })) throw new ApiError(403, "forbidden", "Нет прав на сверку отправки.");
    const { operation, delivery } = await loadDirectWaDelivery(tx, tenantId, conversationId, messageId);
    if (directWaRevision(operation, delivery) !== input.revision) throw directWaChanged();
    if (directWaBusy(delivery, operation.state)) throw new ApiError(409, "delivery_busy", "Отправка выполняется. Дождитесь результата.");
    const part = delivery.parts.find(p => p.id === input.partId);
    if (!part) throw new ApiError(404, "not_found", "Часть сообщения не найдена");
    if (!["unknown", "sending"].includes(part.state)) throw new ApiError(409, "already_reconciled", "Для этой части результат уже известен. Обновите проверку.");
    const before = part.state;
    for (const item of delivery.parts) if (item.state === "sending") item.state = "unknown";
    part.state = input.outcome === "sent" ? "accepted" : "failed"; part.error = input.outcome === "sent" ? null : "По результатам сверки не отправлено";
    part.reconciledBy = auth.user.id; part.reconciledAt = new Date().toISOString(); part.reconciliationNote = note;
    delivery.claim = null; delivery.leaseUntil = 0; delivery.queued = false;
    await publishDirectWaDelivery(tx, tenantId, operation.id, delivery);
    const changes = { conversationId, messageId, channel: delivery.channel, partId: part.id, before, after: part.state, reason: note,
      from: "Отправка не подтверждена", to: input.outcome === "sent" ? "Сверено: отправлено" : "Сверено: не отправлено" };
    await writeAudit(tx, { tenantId, actorUserId: auth.user.id, action: "message.delivery_reconciled", entityType: "message", entityId: messageId, changes });
    if (delivery.contactId && await tx.contact.count({ where: { id: delivery.contactId, tenantId } })) await writeActivity(tx, { tenantId, contactId: delivery.contactId,
      type: "message.delivery_reconciled", title: "Отправка сверена сотрудником", description: note, actorType: "user", actorId: auth.user.id, metadata: changes });
    return delivery.campaign?.id;
  });
  if (campaignId) await (await import("./campaignService.ts")).refreshCampaignAfterDeliveryReview(prisma, tenantId, campaignId);
  return getDirectWaDeliveryReview(prisma, auth, conversationId, messageId);
}

export async function retryDirectWaDelivery(prisma: PrismaClient, auth: AuthContext, conversationId: string, messageId: string, revision: string) {
  const tenantId = await access(prisma, auth, conversationId, true);
  await retryDirectWhatsAppManual(prisma, tenantId, conversationId, messageId, revision, auth.user.id);
  return getDirectWaDeliveryReview(prisma, auth, conversationId, messageId);
}
