import type { Prisma, PrismaClient } from "@creolab/db";
import type { MessageDeliveryReconciliation, MessageDeliveryReview, MessageRetryBlock } from "@creolab/contracts";
import type { AuthContext } from "../lib/types.ts";
import { ApiError } from "../errors.ts";
import { assertConversationReachable, isManager, requireNotManager, requireTenant } from "../lib/access.ts";
import { writeAudit } from "../lib/audit.ts";
import { writeActivity } from "./contactService.ts";
import { bridgeTargetKey } from "./messagingProvider.ts";
import { resolveSellerBridge } from "./sellerLink.ts";
import { getEntitlements } from "./entitlementService.ts";
import { consumeResource } from "./billingResourceService.ts";
import { refreshCampaignAfterDeliveryReview } from "./campaignService.ts";
import { phoneFromContact } from "./contactLabels.ts";
import { deliverLegacyMessage, legacyDeliveryBusy, legacyDeliveryRevision, publishLegacyDelivery, readLegacyDelivery } from "./legacyMessageDelivery.ts";
import { getTelegramDeliveryReview, reconcileTelegramDelivery, retryTelegramDelivery } from "./telegramMessageDeliveryReview.ts";
import { getDirectWaDeliveryReview, reconcileDirectWaDelivery, retryDirectWaDelivery } from "./directWhatsAppDeliveryReview.ts";
import { getAiReplyDeliveryReview, reconcileAiReplyDelivery, retryAiReplyDelivery } from "./aiReplyDeliveryReview.ts";

type Db = PrismaClient | Prisma.TransactionClient;
const changed = () => new ApiError(409, "delivery_changed", "Результат отправки изменился. Обновите проверку.");

async function load(db: Db, tenantId: string, conversationId: string, messageId: string) {
  const message = await db.message.findFirst({ where: { id: messageId, tenantId, conversationId, internal: false, direction: "outbound", senderKind: "staff" },
    include: { attachments: true, conversation: { include: { contact: { include: { methods: true } } } } } });
  if (!message) throw new ApiError(404, "not_found", "Сообщение не найдено");
  const operations = await db.outboundOperation.findMany({ where: { tenantId, conversationId, providerRef: messageId }, take: 2 });
  const operation = operations.length === 1 && operations[0].idempotencyKey.startsWith("legacy:") ? operations[0] : null;
  const delivery = operation ? await readLegacyDelivery(db, tenantId, operation.id) : null;
  if (!operation || !delivery || delivery.messageId !== messageId) {
    throw new ApiError(409, "delivery_untracked", "Для этой отправки нет подробной истории частей. Автоматический повтор недоступен; проверьте переписку в канале и обратитесь к администратору.");
  }
  return { message, operation, delivery };
}

async function access(prisma: PrismaClient, auth: AuthContext, conversationId: string, write = false) {
  const { tenantId } = requireTenant(auth);
  if (write) requireNotManager(auth, "Сверить отправку и разрешить повтор может руководитель компании.");
  await assertConversationReachable(prisma, auth, conversationId);
  return tenantId;
}

async function retryBlock(prisma: PrismaClient, auth: AuthContext, value: Awaited<ReturnType<typeof load>>): Promise<MessageRetryBlock> {
  const { message, operation, delivery } = value;
  if (isManager(auth)) return "permissions";
  if (legacyDeliveryBusy(delivery)) return "busy";
  if (delivery.parts.some(p => ["unknown", "sending"].includes(p.state))) return "unknown";
  if (delivery.parts.every(p => p.state === "accepted")) return "complete";
  const conv = message.conversation;
  if (conv.status !== "open" || conv.mode !== "human" || conv.controlVersion !== operation.controlVersion
    || conv.sellerLeadId !== delivery.sellerLeadId || conv.connectionId
    || (delivery.contactId !== undefined && conv.contactId !== delivery.contactId)) return "conversation_changed";
  const member = await prisma.membership.findFirst({ where: { tenantId: message.tenantId, userId: delivery.actorUserId, active: true, tenant: { status: "active" } } });
  if (!member || (member.role === "manager" && (delivery.campaign || conv.assigneeMembershipId !== member.id))) return "access_changed";
  const bridge = await resolveSellerBridge(prisma, message.tenantId);
  if (!bridge.bridge || bridgeTargetKey(bridge) !== delivery.bridge) return "connection_changed";
  const entitlements = await getEntitlements(prisma, message.tenantId);
  if (!entitlements.entitlements.WHATSAPP) return "plan";
  if (delivery.campaign) {
    const row = await prisma.campaignRecipient.findFirst({ where: { id: delivery.campaign.recipientId, tenantId: message.tenantId,
      campaignId: delivery.campaign.id, conversationId: conv.id }, include: { campaign: true } });
    if (!row || !["running", "completed", "partially_completed", "failed"].includes(row.campaign.status)) return "campaign_stopped";
    if (["pending", "queued", "sending"].includes(row.status)) return "busy";
    if (!["failed", "unknown"].includes(row.status)) return "campaign_changed";
    if (row.campaign.confirmedById !== delivery.actorUserId || row.campaign.confirmedAt?.toISOString() !== delivery.campaign.confirmedAt
      || row.campaign.contentHash !== delivery.campaign.contentHash) return "campaign_changed";
    if (!entitlements.snapshot.grandfathered && !entitlements.entitlements.MASS_CAMPAIGNS) return "plan";
  }
  return null;
}

async function getLegacyDeliveryReview(prisma: PrismaClient, auth: AuthContext, conversationId: string, messageId: string): Promise<MessageDeliveryReview> {
  const tenantId = await access(prisma, auth, conversationId);
  const value = await load(prisma, tenantId, conversationId, messageId);
  const { message, operation, delivery } = value;
  const busy = legacyDeliveryBusy(delivery);
  const users = await prisma.membership.findMany({ where: { tenantId, userId: { in: delivery.parts.flatMap(p => p.reconciledBy ? [p.reconciledBy] : []) } },
    select: { userId: true, user: { select: { name: true } } } });
  const names = new Map(users.map(row => [row.userId, row.user.name]));
  const block = await retryBlock(prisma, auth, value);
  const phone = phoneFromContact(message.conversation.contact, { externalThreadId: message.conversation.externalThreadId });
  return {
    channel: "whatsapp", messageId, conversationId, revision: legacyDeliveryRevision(operation, delivery), text: message.text, createdAt: message.createdAt.toISOString(),
    recipient: delivery.recipient || [message.conversation.contact?.name, phone].filter(Boolean).join(" · ") || "Клиент этого диалога",
    campaignId: delivery.campaign?.id || null, busy, needsCheck: delivery.parts.some(p => p.state === "unknown" || (!busy && p.state === "sending")),
    canReconcile: !isManager(auth) && !busy, canRetry: block === null, retryBlock: block,
    parts: delivery.parts.map(part => ({ id: part.id, label: part.id === "text" ? "Сообщение" : message.attachments.find(file => file.id === part.id)?.originalFileName
      || message.attachments.find(file => file.id === part.id)?.fileName || "Файл",
      state: part.state === "sending" && !busy ? "unknown" : part.state, providerMessageId: part.providerMessageId || null,
      checkedBy: part.reconciledBy ? names.get(part.reconciledBy) || "Сотрудник компании" : null,
      checkedAt: part.reconciledAt || null, note: part.reconciliationNote || null })),
  };
}

/** Human evidence changes recorded state only. Dispatch is a separate explicit action. */
async function reconcileLegacyDelivery(prisma: PrismaClient, auth: AuthContext, conversationId: string, messageId: string, input: MessageDeliveryReconciliation) {
  const tenantId = await access(prisma, auth, conversationId, true);
  const note = String(input.note || "").trim();
  if (!input.revision || !["sent", "not_sent"].includes(input.outcome) || note.length < 8 || note.length > 1000) {
    throw new ApiError(422, "invalid", "Укажите результат и пояснение проверки от 8 до 1000 символов.");
  }
  const campaignId = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Conversation" WHERE id = ${conversationId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const { message, operation, delivery } = await load(tx, tenantId, conversationId, messageId);
    if (legacyDeliveryRevision(operation, delivery) !== input.revision) throw changed();
    if (legacyDeliveryBusy(delivery)) throw new ApiError(409, "delivery_busy", "Отправка выполняется. Дождитесь результата.");
    const part = delivery.parts.find(item => item.id === input.partId);
    if (!part) throw new ApiError(404, "not_found", "Часть сообщения не найдена");
    if (!["unknown", "sending"].includes(part.state)) throw new ApiError(409, "already_reconciled", "Для этой части результат уже известен. Обновите проверку.");
    const before = part.state;
    part.state = input.outcome === "sent" ? "accepted" : "failed";
    part.error = input.outcome === "not_sent" ? "По результатам сверки не отправлено" : null;
    part.reconciledBy = auth.user.id; part.reconciledAt = new Date().toISOString(); part.reconciliationNote = note;
    delivery.claim = null; delivery.leaseUntil = null; delivery.reviewRequiresRetry = !delivery.parts.every(item => item.state === "accepted");
    await publishLegacyDelivery(tx, tenantId, operation.id, delivery);
    if (input.outcome === "sent") await tx.conversation.update({ where: { id: conversationId, tenantId }, data: { messageRevision: { increment: 1 } } });
    const changes = { conversationId, messageId, partId: part.id, before, after: part.state, reason: note,
      campaignId: delivery.campaign?.id || null, recipientId: delivery.campaign?.recipientId || null,
      from: "Отправка не подтверждена", to: input.outcome === "sent" ? "Сверено: отправлено" : "Сверено: не отправлено" };
    await writeAudit(tx, { tenantId, actorUserId: auth.user.id, action: "message.delivery_reconciled", entityType: "message", entityId: messageId, changes });
    const contactId = delivery.contactId === undefined ? message.conversation.contactId : delivery.contactId;
    if (contactId && await tx.contact.count({ where: { id: contactId, tenantId } })) await writeActivity(tx, { tenantId, contactId,
      type: "message.delivery_reconciled", title: "Отправка сверена сотрудником", description: note, actorType: "user", actorId: auth.user.id, metadata: changes });
    return delivery.campaign?.id;
  });
  if (campaignId) await refreshCampaignAfterDeliveryReview(prisma, tenantId, campaignId);
  return getMessageDeliveryReview(prisma, auth, conversationId, messageId);
}

async function retryLegacyDelivery(prisma: PrismaClient, auth: AuthContext, conversationId: string, messageId: string, revision: string) {
  const tenantId = await access(prisma, auth, conversationId, true);
  const value = await load(prisma, tenantId, conversationId, messageId);
  if (legacyDeliveryRevision(value.operation, value.delivery) !== revision) throw changed();
  const block = await retryBlock(prisma, auth, value);
  if (block) throw new ApiError(409, "delivery_retry_blocked", "Повтор сейчас недоступен. Обновите результат отправки.", undefined, { reason: block });
  if (value.delivery.campaign) await consumeResource(prisma, tenantId, "CAMPAIGN_RECIPIENTS", 1, `campaign-recipient:${value.delivery.campaign.recipientId}`);
  await deliverLegacyMessage(prisma, tenantId, value.operation.id, { revision, actorUserId: auth.user.id });
  if (value.delivery.campaign) await refreshCampaignAfterDeliveryReview(prisma, tenantId, value.delivery.campaign.id);
  return getMessageDeliveryReview(prisma, auth, conversationId, messageId);
}

async function deliveryChannel(prisma: PrismaClient, auth: AuthContext, conversationId: string, messageId: string) {
  const tenantId = await access(prisma, auth, conversationId);
  const message = await prisma.message.findFirst({ where: { id: messageId, tenantId, conversationId, internal: false, senderKind: { in: ["staff", "ai"] }, direction: "outbound" }, select: { connectionScopedId: true, senderKind: true } });
  if (!message) throw new ApiError(404, "not_found", "Сообщение не найдено");
  if (message.senderKind === "ai") return "ai";
  return /^telegram-out(?:-v2)?:/.test(message.connectionScopedId || "") ? "telegram" : message.connectionScopedId?.startsWith("wa-out-v2:") ? "direct" : "legacy";
}
export async function getMessageDeliveryReview(prisma: PrismaClient, auth: AuthContext, conversationId: string, messageId: string) {
  const channel = await deliveryChannel(prisma, auth, conversationId, messageId);
  return ({ ai: getAiReplyDeliveryReview, telegram: getTelegramDeliveryReview, direct: getDirectWaDeliveryReview, legacy: getLegacyDeliveryReview })[channel](prisma, auth, conversationId, messageId);
}
export async function reconcileMessageDelivery(prisma: PrismaClient, auth: AuthContext, conversationId: string, messageId: string, input: MessageDeliveryReconciliation) {
  const channel = await deliveryChannel(prisma, auth, conversationId, messageId);
  return ({ ai: reconcileAiReplyDelivery, telegram: reconcileTelegramDelivery, direct: reconcileDirectWaDelivery, legacy: reconcileLegacyDelivery })[channel](prisma, auth, conversationId, messageId, input);
}
export async function retryMessageDelivery(prisma: PrismaClient, auth: AuthContext, conversationId: string, messageId: string, revision: string) {
  const channel = await deliveryChannel(prisma, auth, conversationId, messageId);
  return ({ ai: retryAiReplyDelivery, telegram: retryTelegramDelivery, direct: retryDirectWaDelivery, legacy: retryLegacyDelivery })[channel](prisma, auth, conversationId, messageId, revision);
}
