import type { Prisma, PrismaClient } from "@creolab/db";
import type { AuthContext } from "../lib/types.ts";
import { ApiError } from "../errors.ts";
import { parseAIAutomationSettings } from "./aiAutomationSettings.ts";
import { applyConversationAnalysis } from "./conversationContextApplyService.ts";

/** Reuse the durable outbox, written in the same transaction as the message. */
export async function enqueueConversationContext(tx: Prisma.TransactionClient, tenantId: string, conversationId: string, messageId: string) {
  await tx.outboxEvent.upsert({ where: { id: `context:${messageId}` }, update: {}, create: {
    id: `context:${messageId}`, tenantId, type: "conversation.context", entityType: "conversation", entityId: conversationId,
    payloadJson: { conversationId, messageId },
  } });
}

export async function processConversationContextJob(prisma: PrismaClient, tenantId: string, conversationId: string, options: { useLlm?: boolean; sourceMessageId?: string } = {}) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant || tenant.status !== "active") return { skipped: "tenant_inactive" };
  const settings = parseAIAutomationSettings(tenant.settingsJson);
  if (!settings.analyzeNewRequests || !settings.crm.enabled) return { skipped: "automation_disabled" };
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId },
    include: { messages: { where: { internal: false, operationState: { notIn: ["queued", "failed", "unknown"] } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 } } });
  if (!conversation) return { skipped: "missing" };
  if (conversation.sellerLeadId && !await prisma.inquiry.findFirst({ where: { tenantId, conversationId, archived: false }, select: { id: true } })) {
    // Seller ingestion derives the inquiry from persisted history; let that finish first.
    throw new ApiError(409, "context_pending", "Ожидается привязка WhatsApp-заявки к диалогу");
  }
  const last = options.sourceMessageId ? await prisma.message.findFirst({ where: { id: options.sourceMessageId, tenantId, conversationId } }) : conversation.messages[0];
  if (!last) return { skipped: "no_messages" };
  if (await prisma.idempotencyRecord.findUnique({ where: { scope_actorKey_key: {
    scope: "conversation.crm", actorKey: `${tenantId}:${conversationId}`, key: last.id,
  } } })) return { skipped: "already_applied" };
  // A failed older event must retry before a newer reply advances the context checkpoint.
  const pending = await prisma.outboxEvent.findMany({ where: { tenantId, type: "conversation.context", entityId: conversationId, processedAt: null },
    select: { payloadJson: true } });
  const pendingIds = pending.map(event => (event.payloadJson as { messageId?: unknown })?.messageId).filter((id): id is string => typeof id === "string");
  const earlier = pendingIds.length ? await prisma.message.findMany({ where: { tenantId, conversationId, id: { in: pendingIds },
    OR: [{ createdAt: { lt: last.createdAt } }, { createdAt: last.createdAt, id: { lt: last.id } }],
  }, select: { id: true } }) : [];
  if (earlier.length) {
    const applied = await prisma.idempotencyRecord.findMany({ where: { scope: "conversation.crm", actorKey: `${tenantId}:${conversationId}`, key: { in: earlier.map(message => message.id) } }, select: { key: true } });
    const completed = new Set(applied.map(record => record.key));
    if (earlier.some(message => !completed.has(message.id))) throw new ApiError(409, "context_pending", "Ожидается обработка предыдущего сообщения диалога");
  }
  // Existing analyst needs tenant context; no staff identity is impersonated for writes or assignment.
  const auth: AuthContext = { user: { id: "system", email: "", name: "AI", platformAdmin: false },
    memberships: [], activeMembership: { id: "", tenantId, role: "owner", permissions: [], active: true, tenant },
    sessionId: "", client: "web" };
  return applyConversationAnalysis(prisma, auth, conversationId, { ...options, automatic: true });
}
