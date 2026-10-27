import { applyAiIntake } from "./aiIntakeService.ts";
import { considerSalesOpportunity, ensureSalesNextTask, enqueueSalesReconcile } from "./salesProcessService.ts";
import { deliveredConversationMessage } from "./conversationMessageState.ts";
import type { Prisma, PrismaClient } from "@creolab/db";
import { readCrmCommercial } from "@creolab/contracts";
import { crmReviewFingerprint } from "./crmReviewState.ts";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { writeActivity } from "./contactService.ts";
import { analyzeConversationContext, resolveContextDeal } from "./conversationContextService.ts";
import { parseAIAutomationSettings } from "./aiAutomationSettings.ts";
import { decideAutomationPolicy } from "./aiAutomationPolicyService.ts";
import { getEffectiveTenantSettings } from "./runtimeSettings.ts";
import { writeAudit } from "../lib/audit.ts";
import { listThreadConversationIds } from "./conversationThread.ts";
import { automaticCrmReview, proposeConversationCrmChanges } from "./conversationCrmReviewService.ts";
import { ProcessReviewCapture } from "./conversationProcessReview.ts";
import { applyContextProcess, prepareContextProcess } from "./conversationProcessChanges.ts";
import { proposeProcessChanges } from "./conversationProcessProposal.ts";


const SAFE_INQUIRY_TRANSITIONS: Record<string, string[]> = {
  new: ["qualification", "qualified"],
  qualification: ["qualified", "waiting_client", "waiting_manager"],
  qualified: ["waiting_client", "waiting_manager", "in_progress"],
  accepted: ["qualification", "qualified", "in_progress", "waiting_client"],
  in_progress: ["waiting_client", "waiting_manager", "qualified"],
};


function tenantId(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership.tenantId;
}

type AnalysisResult = Awaited<ReturnType<typeof analyzeConversationContext>>;
const asObject = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;


/** Analysis never performs external actions. All CRM changes and the message checkpoint commit together. */
export async function applyConversationAnalysis(
  prisma: PrismaClient,
  auth: AuthContext,
  conversationId: string,
  options: { useLlm?: boolean; dryRun?: boolean; sourceMessageId?: string; automatic?: boolean } = {},
) {
  const result = await analyzeConversationContext(prisma, auth, conversationId, options);
  if (options.dryRun) return { dryRun: true, ...result, applied: null };
  const outcome = await applyAnalyzedConversation(prisma, tenantId(auth), conversationId, result);
  if (!options.automatic && !outcome.applied && outcome.skipped !== "superseded") {
    // Explicit «Понять контекст» remains available without granting automatic CRM mutation rights.
    await prisma.$transaction(async tx => {
      const saved = await tx.conversation.updateMany({ where: { id: conversationId, tenantId: tenantId(auth), messageRevision: result.messageRevision },
        data: { contextSummary: result.analysis.summaryUpdate, waitingFor: result.analysis.waitingFor, lastContextAnalyzedAt: new Date() } });
      if (saved.count) await writeAudit(tx, { tenantId: tenantId(auth), actorUserId: auth.user.id, action: "conversation.context_analyzed",
        entityType: "conversation", entityId: conversationId, changes: { summary: result.analysis.summaryUpdate, sourceMessageId: result.sourceMessageId } });
    });
  }
  if (outcome.applied) {
    const latest = await prisma.message.findFirst({ where: { tenantId: tenantId(auth), conversationId, ...deliveredConversationMessage }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    if (latest?.id === result.sourceMessageId) {
      const { applyConfiguredHandoff, refreshConversationFollowUp } = await import("./aiConversationPolicyService.ts");
      await applyConfiguredHandoff(prisma, tenantId(auth), conversationId, {
        text: latest.direction === "inbound" ? latest.text || "" : "", analysis: result.analysis,
      }).catch(error => console.warn("[context] handoff", error instanceof Error ? error.message : error));
      await refreshConversationFollowUp(prisma, tenantId(auth), conversationId)
        .catch(error => console.warn("[context] follow-up", error instanceof Error ? error.message : error));
    }
  }
  return outcome;
}

/** Separate from extraction so queued work and tests use exactly the same guarded application path. */
export async function applyAnalyzedConversation(prisma: PrismaClient, tid: string, conversationId: string, result: AnalysisResult) {
  const { analysis, sourceMessageId, sourceMessageAt } = result;
  if (!sourceMessageId || !sourceMessageAt) return { ...result, applied: null, skipped: "no_messages" };
  if (!(await getEffectiveTenantSettings(prisma, tid)).ai.enabled) return { ...result, applied: null, skipped: "ai_disabled" };
  const outcome = await prisma.$transaction(async tx => {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tid } });
    const settings = parseAIAutomationSettings(tenant.settingsJson);
    const conversation = await tx.conversation.findFirst({ where: { id: conversationId, tenantId: tid },
      include: { contact: true, connection: { include: { integration: true } },
        inquiries: { where: { tenantId: tid, archived: false }, orderBy: { receivedAt: "desc" }, take: 1 },
        messages: { where: { tenantId: tid, ...deliveredConversationMessage }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 80 } } });
    if (!conversation) throw new ApiError(404, "not_found", "Диалог не найден");
    const inquiry = conversation.inquiries[0];
    const integration = conversation.connection?.integration || (inquiry?.integrationId
      ? await tx.integration.findFirst({ where: { id: inquiry.integrationId, tenantId: tid } }) : null);
    if (integration && (integration.status === "disabled" || integration.connectionStatus === "DISCONNECTED")) return { applied: null, skipped: "integration_disabled" };
    const threadIds = await listThreadConversationIds(tx, tid, conversation);
    const evidenceMessages = await tx.message.findMany({ where: { tenantId: tid, conversationId: { in: threadIds },
      OR: [{ createdAt: { lt: sourceMessageAt } }, { createdAt: sourceMessageAt, id: { lte: sourceMessageId } }],
      ...deliveredConversationMessage }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 80 });
    const attr = asObject(conversation.contact?.attributionJson);
    const fieldMeta = asObject(inquiry?.fieldMetaJson);
    const policy = decideAutomationPolicy({ settingsJson: tenant.settingsJson, interaction: "crm",
      sourceChannel: conversation.connection?.channelType || inquiry?.sourceChannel,
      source: inquiry?.source, serviceCategory: inquiry?.serviceCategory,
      integrationId: integration?.id, integrationAutomationMode: integration?.automationMode,
      clientAiMode: typeof attr.aiAutomation === "string" ? attr.aiAutomation : null,
      requestOverrideMode: typeof fieldMeta.automationOverride === "string" ? fieldMeta.automationOverride : null,
    });
    // Global off cannot be bypassed by a source/integration override. HUMAN only controls who replies.
    if (tenant.status !== "active" || !settings.analyzeNewRequests || !settings.crm.enabled || !policy.analyze) {
      return { applied: null, skipped: "automation_disabled" };
    }
    if (conversation.mode === "paused" || policy.mode === "ASSIST" || (conversation.mode === "human" && !settings.crm.inHumanMode)) {
      await tx.$queryRaw`SELECT id FROM "Conversation" WHERE id = ${conversationId} AND "tenantId" = ${tid} FOR UPDATE`;
      const fresh = await tx.conversation.findUniqueOrThrow({ where: { id: conversationId } });
      if (fresh.messageRevision !== result.messageRevision || fresh.controlVersion !== conversation.controlVersion || !evidenceMessages.some(m => m.id === sourceMessageId)) {
        throw new ApiError(409, "stale_analysis", "Диалог изменился во время анализа; требуется повторный анализ");
      }
      await proposeConversationCrmChanges(tx, tid, conversationId, { analysis, sourceMessageId, messageRevision: result.messageRevision,
        snapshot: result.snapshot.review, updateContact: settings.crm.updateContact, updateInquiry: settings.crm.updateInquiry });
      await proposeProcessChanges(tx, tid, { result, evidenceMessages }, conversationId);
      return { applied: null, skipped: "suggestions_only" };
    }
    if (conversation.messageRevision !== result.messageRevision || !evidenceMessages.some(m => m.id === sourceMessageId)) {
      throw new ApiError(409, "stale_analysis", "Диалог изменился во время анализа; требуется повторный анализ");
    }
    const key = { scope: "conversation.crm", actorKey: `${tid}:${conversationId}`, key: sourceMessageId };
    if (await tx.idempotencyRecord.findUnique({ where: { scope_actorKey_key: key } })) {
      await tx.$queryRaw`SELECT id FROM "Conversation" WHERE id = ${conversationId} AND "tenantId" = ${tid} FOR UPDATE`;
      await proposeProcessChanges(tx, tid, { result, evidenceMessages }, conversationId, { tasksOnly: true });
      return { applied: null, skipped: "already_applied" };
    }
    const previousSource = conversation.lastAnalyzedMessageId ? await tx.message.findFirst({
      where: { id: conversation.lastAnalyzedMessageId, tenantId: tid }, select: { id: true, createdAt: true },
    }) : null;
    if (previousSource && (previousSource.createdAt > sourceMessageAt ||
      (previousSource.createdAt.getTime() === sourceMessageAt.getTime() && previousSource.id > sourceMessageId))) {
      return { applied: null, skipped: "superseded" };
    }
    // Row lock plus compare-and-set protects concurrent workers and mode changes during the LLM request.
    const claimed = await tx.conversation.updateMany({ where: { id: conversationId, tenantId: tid,
      messageRevision: result.messageRevision, controlVersion: conversation.controlVersion,
      lastAnalyzedMessageId: conversation.lastAnalyzedMessageId },
      data: { lastAnalyzedMessageId: sourceMessageId, lastContextAnalyzedAt: new Date() } });
    if (!claimed.count) throw new ApiError(409, "stale_analysis", "Диалог изменился во время анализа");
    // Check again after acquiring the lock (a second worker may have completed while we waited).
    if (await tx.idempotencyRecord.findUnique({ where: { scope_actorKey_key: key } })) return { applied: null, skipped: "already_applied" };

    const contactId = conversation.contactId;
    let commercialUnchanged = false;
    if (inquiry && result.snapshot.review?.inquiry?.id === inquiry.id && analysis.commercialFacts?.length) {
      await tx.$queryRaw`SELECT id FROM "Inquiry" WHERE id = ${inquiry.id} AND "tenantId" = ${tid} FOR UPDATE`;
      const locked = await tx.inquiry.findUniqueOrThrow({ where: { id: inquiry.id } });
      commercialUnchanged = crmReviewFingerprint("inquiry", locked) === result.snapshot.review.inquiry.fingerprint;
    }
    const createdSalesDeal = await considerSalesOpportunity(tx, tid, { conversationId, sourceMessageId, messageRevision: result.messageRevision, analysis });
    const deal = await resolveContextDeal(tx, tid, conversationId, contactId, inquiry?.dealId);
    const processReview = new ProcessReviewCapture();
    const evidenceIds = new Set(evidenceMessages.map(m => m.id));
    const grounded = (ids: string[]) => ids.includes(sourceMessageId) && ids.every(id => evidenceIds.has(id));
    const reliable = analysis.confidence === "HIGH" && grounded(analysis.evidenceMessageIds);
    const changes: Array<{ entityType: string; entityId: string; before: unknown; after: unknown; eventType: string; confidence: string }> = [];
    const applied: { agreements: unknown[]; inquiryStatus: string | null; dealStage: string | null; dealAmount: number | null; suggestions: unknown[] } =
      { agreements: [], inquiryStatus: null, dealStage: null, dealAmount: null, suggestions: [] };
    const addChange = (entityType: string, entityId: string, before: unknown, after: unknown, eventType: string, confidence = analysis.confidence) => {
      changes.push({ entityType, entityId, before, after, eventType, confidence });
    };
    const manuallyChanged = async (entityType: string, entityId: string) => Boolean((entityType === "inquiry" && await tx.activity.findFirst({
      where: { tenantId: tid, inquiryId: entityId, actorType: "user", createdAt: { gte: sourceMessageAt } }, select: { id: true },
    })) || await tx.auditEvent.findFirst({
      where: { tenantId: tid, entityType, entityId, actorUserId: { not: null }, createdAt: { gte: sourceMessageAt } }, select: { id: true },
    }));
    // A handoff acknowledgment is not an answer to the customer's question.
    // Keep the staff obligation until a real staff reply or explicit mode change.
    const handoff = asObject(conversation.aiHandoffSummaryJson);
    const pendingHandoff = conversation.mode !== "ai" && conversation.waitingFor === "MANAGER"
      && handoff.controlVersion === conversation.controlVersion && typeof handoff.sourceMessageId === "string";
    const waitingFor = pendingHandoff ? "MANAGER" : analysis.waitingFor;
    await tx.conversation.update({ where: { id: conversationId, tenantId: tid }, data: {
      contextSummary: analysis.summaryUpdate, waitingFor,
      ...(!pendingHandoff && analysis.needsReply ? { needsAttention: true, attentionReason: "needs_reply" } : {}),
    } });
    addChange("conversation", conversationId, { contextSummary: conversation.contextSummary, waitingFor: conversation.waitingFor },
      { contextSummary: analysis.summaryUpdate, waitingFor }, "CONTEXT_UPDATED");

    if (settings.crm.updateContact && reliable && contactId && analysis.summaryUpdate && conversation.contact?.summary === result.snapshot.contactSummary && !await manuallyChanged("contact", contactId)) {
      await tx.contact.update({ where: { id: contactId, tenantId: tid, summary: conversation.contact?.summary }, data: { summary: analysis.summaryUpdate, version: { increment: 1 } } });
      addChange("contact", contactId, { summary: conversation.contact?.summary }, { summary: analysis.summaryUpdate }, "NEED_IDENTIFIED");
    }
    if (!createdSalesDeal && settings.crm.updateInquiry && reliable && inquiry && inquiry.id === result.snapshot.inquiry?.id && inquiry.status === result.snapshot.inquiry.status && inquiry.nextStep === result.snapshot.inquiry.nextStep && inquiry.aiSummary === result.snapshot.inquiry.aiSummary && inquiry.needsReply === result.snapshot.inquiry.needsReply && !await manuallyChanged("inquiry", inquiry.id)) {
      const status = analysis.suggestedRequestStatus && (SAFE_INQUIRY_TRANSITIONS[inquiry.status] || []).includes(analysis.suggestedRequestStatus)
        ? analysis.suggestedRequestStatus : inquiry.status;
      const data = { status, aiSummary: analysis.summaryUpdate, nextStep: analysis.suggestedNextAction, needsReply: analysis.needsReply };
      await tx.inquiry.update({ where: { id: inquiry.id, tenantId: tid, version: inquiry.version, status: inquiry.status, nextStep: inquiry.nextStep, aiSummary: inquiry.aiSummary }, data: { ...data, version: { increment: 1 } } });
      if (status !== inquiry.status) {
        await tx.inquiryStatusHistory.create({ data: { tenantId: tid, inquiryId: inquiry.id, fromStatus: inquiry.status, toStatus: status,
          changedByType: "context_engine", note: analysis.summaryUpdate } });
        applied.inquiryStatus = status;
      }
      addChange("inquiry", inquiry.id, { status: inquiry.status, aiSummary: inquiry.aiSummary, nextStep: inquiry.nextStep, needsReply: inquiry.needsReply }, data, "INQUIRY_UPDATED");
    }

    const processPlan = await prepareContextProcess(tx, tid, { result, settings, conversation, inquiry, deal, evidenceMessages, createdSalesDeal });
    const { owner, intakePolicy, scheduled, dealWritable, dealData } = processPlan;
    Object.assign(applied, processPlan.applied);
    await applyContextProcess(tx, tid, processPlan, { capture: processReview, sourceMessageId, summary: analysis.summaryUpdate,
      onChange: (record, after) => addChange(record.kind, record.id, record.before, after, record.eventType, record.confidence) });
    if (deal && reliable) {
      const outbound = evidenceMessages.find(m => m.id === sourceMessageId)?.direction === "outbound";
      const evidenceType = applied.dealAmount != null ? "sales.order_agreed" : outbound && (analysis.events || []).some(e => e.type === "COMMERCIAL_OFFER_SENT" && e.confidence === "HIGH" && grounded(e.evidenceMessageIds)) ? "sales.proposal_sent" : null;
      if (evidenceType) await writeActivity(tx, { tenantId: tid, contactId: deal.contactId, dealId: deal.id, type: evidenceType,
        title: evidenceType === "sales.order_agreed" ? "Клиент согласовал стоимость" : "Предложение отправлено", actorType: "ai",
        metadata: { sourceMessageId, reason: analysis.summaryUpdate, evidenceMessageIds: analysis.evidenceMessageIds } });
    }
    for (const change of changes) {
      const review = contactId ? await automaticCrmReview(tx, tid, { conversationId, contactId, sourceMessageId, messageRevision: result.messageRevision,
        ...change, evidenceMessageIds: analysis.evidenceMessageIds }) : null;
      const metadata = { actor: "ai", conversationId, contactId, dealId: deal?.id || null, sourceMessageId, sourceMessageAt: sourceMessageAt.toISOString(), ...change, ...(review ? { review } : {}) };
      await writeAudit(tx, { tenantId: tid, action: "conversation.crm_updated", entityType: change.entityType,
        entityId: change.entityId, correlationId: sourceMessageId, changes: metadata });
      if (contactId) await writeActivity(tx, { tenantId: tid, contactId, inquiryId: inquiry?.id, dealId: deal?.id,
        type: "conversation.crm_updated", title: "AI обновил CRM по переписке", description: analysis.summaryUpdate,
        actorType: "ai", metadata: json(metadata) as Record<string, unknown> });
    }
    if (settings.crm.updateInquiry && reliable) await applyAiIntake(tx, tid, { policy: intakePolicy,
      extraction: analysis.intakeRequest, inquiryId: inquiry?.id, conversationId, sourceMessageId, evidence: evidenceMessages,
      createTasks: settings.crm.createTasks, ownerMembershipId: owner?.id });
    const reviewedInquiry = commercialUnchanged && inquiry ? await tx.inquiry.findUniqueOrThrow({ where: { id: inquiry.id } }) : null;
    const commercialFingerprint = reviewedInquiry && JSON.stringify(readCrmCommercial(reviewedInquiry)) === JSON.stringify(result.snapshot.review?.inquiry?.commercial)
      ? crmReviewFingerprint("inquiry", reviewedInquiry) : undefined;
    await proposeConversationCrmChanges(tx, tid, conversationId, { analysis, sourceMessageId, messageRevision: result.messageRevision,
      snapshot: result.snapshot.review, commercialFingerprint, updateContact: settings.crm.updateContact, updateInquiry: settings.crm.updateInquiry });
    await tx.idempotencyRecord.create({ data: { ...key, requestHash: sourceMessageId,
      resultJson: json({ events: analysis.events || [], applied }), expiresAt: new Date("9999-12-31T00:00:00Z") } });
    if (deal) {
      const taskChanges = await ensureSalesNextTask(tx, tid, deal.id, conversationId, Boolean(dealWritable && (dealData.nextAction || dealData.nextActionAt)));
      for (const change of taskChanges || []) processReview.remember("task", change.id, change.before);
      processReview.rememberOutbox(await enqueueSalesReconcile(tx, tid, deal.id));
    }
    await processReview.save(tx, tid, { conversationId, contactId, sourceMessageId, messageRevision: result.messageRevision,
      evidenceMessageIds: [...new Set([...analysis.evidenceMessageIds, ...scheduled.flatMap(a => a.evidenceMessageIds)])] });
    // Free-standing recommendations remain reviewable suggestions in AUTO too.
    // Prepare against final CRM state so tasks already created above are not proposed twice.
    await proposeProcessChanges(tx, tid, { result, evidenceMessages }, conversationId, { tasksOnly: true });
    return { applied, skipped: null };
  }, { timeout: 15000 });
  // Tenant OAuth calendar polling synchronizes persisted agreements independently.
  return { dryRun: false, ...result, ...outcome };
}

export const analyzeAndApplyConversation = applyConversationAnalysis;
