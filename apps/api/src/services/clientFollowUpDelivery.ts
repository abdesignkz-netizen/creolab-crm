import type { Prisma, PrismaClient } from "@creolab/db";

export const followUpOperationKey = (actionId: string) => `followup:${actionId}`;
export const followUpScheduleId = (messageId: string) => `client-followup:${messageId}`;
export const FOLLOWUP_UNKNOWN = "Неизвестный результат автоматического сообщения. Проверьте переписку перед повтором.";

export async function lockFollowUpConversation(tx: Prisma.TransactionClient, tenantId: string, conversationId: string) {
  await tx.$queryRaw`SELECT id FROM "Conversation" WHERE id = ${conversationId} AND "tenantId" = ${tenantId} FOR UPDATE`;
}

/** Called in the scheduler's recovery transaction. Never sends or starts a new cycle. */
export async function recoverInterruptedFollowUp(tx: Prisma.TransactionClient, item: { id: string; tenantId: string; parentId: string }) {
  const operation = await tx.outboundOperation.findUnique({ where: { tenantId_idempotencyKey: {
    tenantId: item.tenantId, idempotencyKey: followUpOperationKey(item.id),
  } } });
  if (!operation || !["generating", "queued", "sending"].includes(operation.state)) return;
  const uncertain = operation.state === "sending";
  const state = uncertain ? "unknown" : "failed";
  const error = uncertain ? FOLLOWUP_UNKNOWN : "Подготовка автоматического сообщения прервана. Сообщение не отправлялось.";
  const changed = await tx.outboundOperation.updateMany({ where: { id: operation.id, state: operation.state }, data: { state, error } });
  if (!changed.count) return;
  if (operation.providerRef) await tx.message.updateMany({ where: { id: operation.providerRef, tenantId: item.tenantId }, data: { operationState: state } });
  await tx.scheduledAction.updateMany({ where: { id: item.id, tenantId: item.tenantId, state: "failed" }, data: { cancelReason: error } });
  if (uncertain) await tx.conversation.updateMany({ where: { id: item.parentId, tenantId: item.tenantId, controlVersion: operation.controlVersion },
    data: { needsAttention: true, attentionReason: "AI_DELIVERY_UNKNOWN" } });
}

/** A permanent operation claim fences generation as well as the remote send. */
export async function claimFollowUp(prisma: PrismaClient, item: { id: string; tenantId: string; parentId: string }, controlVersion: number) {
  return prisma.$transaction(async tx => {
    await lockFollowUpConversation(tx, item.tenantId, item.parentId);
    const action = await tx.scheduledAction.findFirst({ where: { id: item.id, tenantId: item.tenantId, parentId: item.parentId, type: "client_followup", parentType: "conversation",
      state: { in: ["scheduled", "running"] }, dueAt: { lte: new Date() } } });
    if (!action) return null;
    const anchor = (action.payloadJson as Prisma.JsonObject)?.lastOutboundMessageId;
    if (typeof anchor !== "string" || !anchor) return null;
    const anchorKey = { scope: "ai.followup.anchor", actorKey: `${item.tenantId}:${item.parentId}`, key: anchor };
    const prior = await tx.idempotencyRecord.findUnique({ where: { scope_actorKey_key: anchorKey } });
    if (prior && prior.requestHash !== item.id) return null;
    const key = { tenantId: item.tenantId, idempotencyKey: followUpOperationKey(item.id) };
    const existing = await tx.outboundOperation.findUnique({ where: { tenantId_idempotencyKey: key } });
    if (existing && existing.state !== "deferred") return null;
    const changed = await tx.scheduledAction.updateMany({ where: { id: action.id, state: action.state, version: action.version },
      data: action.state === "scheduled" ? { state: "running", version: { increment: 1 },
        payloadJson: { ...(action.payloadJson as Prisma.JsonObject), _leaseUntil: Date.now() + 90_000 } } : { state: "running" } });
    if (!changed.count) return null;
    await tx.idempotencyRecord.upsert({ where: { scope_actorKey_key: anchorKey }, update: {}, create: {
      ...anchorKey, requestHash: item.id, resultJson: { actionId: item.id }, expiresAt: new Date("9999-01-01"),
    } });
    return existing ? tx.outboundOperation.update({ where: { id: existing.id }, data: { state: "generating", controlVersion, error: null } })
      : tx.outboundOperation.create({ data: { ...key, conversationId: item.parentId, controlVersion, state: "generating" } });
  });
}

/** Also reconcile canceled/interrupted jobs whose handler never returned. */
export async function recoverAbandonedFollowUps(prisma: PrismaClient, now = new Date()) {
  const operations = await prisma.outboundOperation.findMany({ where: { idempotencyKey: { startsWith: "followup:" },
    state: { in: ["generating", "sending"] }, createdAt: { lt: new Date(now.getTime() - 300_000) } }, orderBy: { createdAt: "asc" }, take: 50 });
  for (const operation of operations) await prisma.$transaction(async tx => {
    await lockFollowUpConversation(tx, operation.tenantId, operation.conversationId);
    const item = await tx.scheduledAction.findFirst({ where: { id: operation.idempotencyKey.slice("followup:".length),
      tenantId: operation.tenantId, parentId: operation.conversationId, type: "client_followup" } });
    if (!item || (item.state === "running" && Number((item.payloadJson as Prisma.JsonObject)?._leaseUntil) > now.getTime())) return;
    await tx.scheduledAction.updateMany({ where: { id: item.id, state: "running" }, data: { state: "failed", version: { increment: 1 } } });
    await recoverInterruptedFollowUp(tx, item);
  });
}
