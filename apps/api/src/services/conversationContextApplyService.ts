import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@creolab/db";
import { taskCreatorSnapshot } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { writeActivity } from "./contactService.ts";
import { analyzeConversationContext, resolveContextDeal } from "./conversationContextService.ts";
import {
  agreementTypeToTaskType,
} from "./conversationContextTypes.ts";
import { parseAIAutomationSettings } from "./aiAutomationSettings.ts";
import { decideAutomationPolicy } from "./aiAutomationPolicyService.ts";
import { getEffectiveTenantSettings } from "./runtimeSettings.ts";
import { createStaffNotification } from "./notificationService.ts";
import { writeAudit } from "../lib/audit.ts";
import { listThreadConversationIds } from "./conversationThread.ts";


const SAFE_INQUIRY_TRANSITIONS: Record<string, string[]> = {
  new: ["qualification", "qualified"],
  qualification: ["qualified", "waiting_client", "waiting_manager"],
  qualified: ["waiting_client", "waiting_manager", "in_progress"],
  accepted: ["qualification", "qualified", "in_progress", "waiting_client"],
  in_progress: ["waiting_client", "waiting_manager", "qualified"],
};

const SAFE_DEAL_STAGES = new Set(["need_identified", "proposal_sent", "negotiation", "contract"]);

function tenantId(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership.tenantId;
}

function defaultReminders(type: string) {
  if (type === "OFFLINE_MEETING") {
    return [
      { offsetMinutes: 24 * 60, channel: "in_app" },
      { offsetMinutes: 60, channel: "in_app" },
      { offsetMinutes: 30, channel: "in_app" },
    ];
  }
  if (type === "ONLINE_MEETING" || type === "CALL") {
    return [
      { offsetMinutes: 24 * 60, channel: "in_app" },
      { offsetMinutes: 60, channel: "in_app" },
      { offsetMinutes: 30, channel: "in_app" },
    ];
  }
  return [
    { offsetMinutes: 24 * 60, channel: "in_app" },
    { offsetMinutes: 60, channel: "in_app" },
  ];
}

async function scheduleReminders(
  prisma: Prisma.TransactionClient,
  tid: string,
  parentType: string,
  parentId: string,
  scheduledAt: Date | null,
  type: string,
) {
  if (!scheduledAt) return;
  const now = Date.now();
  for (const rem of defaultReminders(type)) {
    const dueAt = new Date(scheduledAt.getTime() - rem.offsetMinutes * 60_000);
    if (dueAt.getTime() <= now) continue;
    const actionType = `agreement_reminder_${rem.offsetMinutes}`;
    const existing = await prisma.scheduledAction.findFirst({
      where: { tenantId: tid, type: actionType, parentType, parentId, state: "scheduled" },
    });
    if (existing) {
      await prisma.scheduledAction.update({
        where: { id: existing.id },
        data: {
          dueAt,
          payloadJson: {
            offsetMinutes: rem.offsetMinutes,
            channel: rem.channel,
            agreementId: parentId,
          } as object,
        },
      });
      continue;
    }
    await prisma.scheduledAction.create({
      data: {
        id: randomUUID(),
        tenantId: tid,
        type: actionType,
        parentType,
        parentId,
        dueAt,
        state: "scheduled",
        payloadJson: {
          offsetMinutes: rem.offsetMinutes,
          channel: rem.channel,
          agreementId: parentId,
        } as object,
      },
    });
  }
}

type AnalysisResult = Awaited<ReturnType<typeof analyzeConversationContext>>;
const asObject = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const taskState = (task: { title: string; dueAt: Date | null; status: string; ownerMembershipId: string | null; description: string | null }) =>
  ({ title: task.title, dueAt: task.dueAt?.toISOString() || null, status: task.status, ownerMembershipId: task.ownerMembershipId, description: task.description });

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
    const latest = await prisma.message.findFirst({ where: { tenantId: tenantId(auth), conversationId, internal: false }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
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
        messages: { where: { tenantId: tid, internal: false, operationState: { notIn: ["queued", "failed", "unknown"] } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 80 } } });
    if (!conversation) throw new ApiError(404, "not_found", "Диалог не найден");
    const inquiry = conversation.inquiries[0];
    const integration = conversation.connection?.integration || (inquiry?.integrationId
      ? await tx.integration.findFirst({ where: { id: inquiry.integrationId, tenantId: tid } }) : null);
    if (integration && (integration.status === "disabled" || integration.connectionStatus === "DISCONNECTED")) return { applied: null, skipped: "integration_disabled" };
    const threadIds = await listThreadConversationIds(tx, tid, conversation);
    const evidenceMessages = await tx.message.findMany({ where: { tenantId: tid, conversationId: { in: threadIds }, internal: false,
      OR: [{ createdAt: { lt: sourceMessageAt } }, { createdAt: sourceMessageAt, id: { lte: sourceMessageId } }],
      operationState: { notIn: ["queued", "failed", "unknown"] } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 80 });
    const attr = asObject(conversation.contact?.attributionJson);
    const fieldMeta = asObject(inquiry?.fieldMetaJson);
    const policy = decideAutomationPolicy({ settingsJson: tenant.settingsJson,
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
      return { applied: null, skipped: "suggestions_only" };
    }
    if (conversation.messageRevision !== result.messageRevision || !evidenceMessages.some(m => m.id === sourceMessageId)) {
      throw new ApiError(409, "stale_analysis", "Диалог изменился во время анализа; требуется повторный анализ");
    }
    const key = { scope: "conversation.crm", actorKey: `${tid}:${conversationId}`, key: sourceMessageId };
    if (await tx.idempotencyRecord.findUnique({ where: { scope_actorKey_key: key } })) return { applied: null, skipped: "already_applied" };
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
    const deal = await resolveContextDeal(tx, tid, conversationId, contactId, inquiry?.dealId);
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
    await tx.conversation.update({ where: { id: conversationId, tenantId: tid }, data: {
      contextSummary: analysis.summaryUpdate, waitingFor: analysis.waitingFor,
      ...(analysis.needsReply ? { needsAttention: true, attentionReason: "needs_reply" } : {}),
    } });
    addChange("conversation", conversationId, { contextSummary: conversation.contextSummary, waitingFor: conversation.waitingFor },
      { contextSummary: analysis.summaryUpdate, waitingFor: analysis.waitingFor }, "CONTEXT_UPDATED");

    if (settings.crm.updateContact && reliable && contactId && analysis.summaryUpdate && conversation.contact?.summary === result.snapshot.contactSummary && !await manuallyChanged("contact", contactId)) {
      await tx.contact.update({ where: { id: contactId, tenantId: tid, summary: conversation.contact?.summary }, data: { summary: analysis.summaryUpdate, version: { increment: 1 } } });
      addChange("contact", contactId, { summary: conversation.contact?.summary }, { summary: analysis.summaryUpdate }, "NEED_IDENTIFIED");
    }
    if (settings.crm.updateInquiry && reliable && inquiry && inquiry.id === result.snapshot.inquiry?.id && inquiry.status === result.snapshot.inquiry.status && inquiry.nextStep === result.snapshot.inquiry.nextStep && inquiry.aiSummary === result.snapshot.inquiry.aiSummary && inquiry.needsReply === result.snapshot.inquiry.needsReply && !await manuallyChanged("inquiry", inquiry.id)) {
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

    // An older message may never overwrite a newer edit, including edits made during AI inference.
    const lastAiDealChange = deal ? await tx.auditEvent.findFirst({ where: { tenantId: tid, entityType: "deal", entityId: deal.id,
      action: "conversation.crm_updated", actorUserId: null }, orderBy: { createdAt: "desc" } }) : null;
    const lastAiData = asObject(lastAiDealChange?.changesJson);
    const onlyPriorAiChanged = deal && asObject(lastAiData.after).version === deal.version &&
      typeof lastAiData.sourceMessageAt === "string" && new Date(lastAiData.sourceMessageAt) <= sourceMessageAt;
    const dealWritable = deal && result.snapshot.deal?.id === deal.id && result.snapshot.deal.version === deal.version &&
      result.snapshot.deal.updatedAt.getTime() === deal.updatedAt.getTime() &&
      (deal.updatedAt <= sourceMessageAt || onlyPriorAiChanged) && !await manuallyChanged("deal", deal.id);
    const dealData: Prisma.DealUncheckedUpdateInput = {};
    const accepted = (analysis.events || []).filter(e => e.type === "PRICE_ACCEPTED" && e.confidence === "HIGH" && grounded(e.evidenceMessageIds));
    if (dealWritable && evidenceMessages.some(m => m.id === sourceMessageId && (m.direction === "inbound" || m.senderKind === "client")) && settings.crm.updateDealAmount && accepted.length === 1 && !(analysis.events || []).some(e => e.type === "PRICE_REJECTED")) {
      const price = accepted[0];
      const amount = price.amount;
      if (typeof amount === "number" && Number.isSafeInteger(amount) && amount > 0 && price.currency === deal.currency &&
          !await tx.dealItem.count({ where: { tenantId: tid, dealId: deal.id } })) {
        dealData.offerAmountMinor = amount;
        applied.dealAmount = amount;
      }
    }
    if (dealWritable && settings.crm.updateDealStage && reliable && analysis.suggestedDealStage && SAFE_DEAL_STAGES.has(analysis.suggestedDealStage)) {
      // Use existing semantic keys only. Never seed stages or move backwards/into terminal or financial stages.
      const target = await tx.dealStage.findFirst({ where: { tenantId: tid, systemKey: analysis.suggestedDealStage, isTerminal: false } });
      if (target && target.sortOrder > deal.stage.sortOrder) {
        dealData.stageId = target.id; dealData.stageEnteredAt = new Date(); dealData.probability = target.defaultProbability;
        await tx.dealStageHistory.create({ data: { tenantId: tid, dealId: deal.id, fromStageId: deal.stageId,
          fromSystemKey: deal.stage.systemKey, toStageId: target.id, toSystemKey: target.systemKey, changedByType: "context_engine", note: analysis.summaryUpdate } });
        applied.dealStage = target.systemKey;
      }
    }
    const ownerCandidate = conversation.assigneeMembershipId || deal?.assigneeMembershipId || inquiry?.assigneeMembershipId || conversation.contact?.ownerMembershipId;
    const owner = ownerCandidate ? await tx.membership.findFirst({ where: { id: ownerCandidate, tenantId: tid, active: true } }) : null;
    const scheduled = analysis.agreements.filter(a => a.confidence === "HIGH" && grounded(a.evidenceMessageIds));
    if (dealWritable && settings.crm.updateNextAction && reliable && analysis.suggestedNextAction) {
      dealData.nextAction = analysis.suggestedNextAction;
      const dated = scheduled.find(a => a.scheduledAt && ["CONFIRMED", "SCHEDULED", "RESCHEDULED"].includes(a.status));
      if (dated?.scheduledAt && Number.isFinite(Date.parse(dated.scheduledAt))) dealData.nextActionAt = new Date(dated.scheduledAt);
    }
    if (dealWritable && Object.keys(dealData).length) {
      await tx.deal.update({ where: { id: deal.id, tenantId: tid, version: deal.version, updatedAt: deal.updatedAt }, data: { ...dealData, version: { increment: 1 } } });
      addChange("deal", deal.id, { offerAmountMinor: deal.offerAmountMinor, stageId: deal.stageId, probability: deal.probability,
        nextAction: deal.nextAction, nextActionAt: deal.nextActionAt, version: deal.version }, { ...dealData, version: deal.version + 1 }, applied.dealAmount != null ? "PRICE_ACCEPTED" : "DEAL_UPDATED", "HIGH");
    }
    if (settings.crm.detectAgreements) for (const suggestion of scheduled) {
      let at = suggestion.scheduledAt ? new Date(suggestion.scheduledAt) : null;
      if (at && !Number.isFinite(at.getTime())) continue;
      const agreementKey = `agr:${conversationId}:${suggestion.type}:${at?.toISOString() || sourceMessageId}`;
      const existing = suggestion.existingAgreementId
        ? await tx.agreement.findFirst({ where: { id: suggestion.existingAgreementId, tenantId: tid, conversationId } })
        : await tx.agreement.findFirst({ where: { tenantId: tid, dedupeKey: agreementKey } });
      if (suggestion.existingAgreementId && !existing) continue;
      const priorAiAgreement = existing ? await tx.auditEvent.findFirst({ where: { tenantId: tid, entityType: "agreement", entityId: existing.id,
        action: "conversation.crm_updated", actorUserId: null }, orderBy: { createdAt: "desc" } }) : null;
      const priorAgreementSource = asObject(priorAiAgreement?.changesJson).sourceMessageAt;
      const onlyPriorAiAgreement = asObject(asObject(priorAiAgreement?.changesJson).after).updatedAt === existing?.updatedAt.toISOString() && typeof priorAgreementSource === "string" && new Date(priorAgreementSource) <= sourceMessageAt;
      if (existing && (result.snapshot.agreements.find(a => a.id === existing.id)?.updatedAt.getTime() !== existing.updatedAt.getTime() ||
        (existing.updatedAt > sourceMessageAt && !onlyPriorAiAgreement) || ["COMPLETED", "CANCELLED"].includes(existing.status))) continue;
      if (suggestion.action !== "create" && !existing) continue;
      if (!at && existing && ["cancel", "complete"].includes(suggestion.action)) at = existing.scheduledAt;
      const status = suggestion.action === "cancel" ? "CANCELLED" : suggestion.action === "complete" ? "COMPLETED" : suggestion.status;
      const data = { contactId, inquiryId: inquiry?.id || null, dealId: deal?.id || null, conversationId,
        type: suggestion.type, title: suggestion.title, summary: suggestion.summary || null, purpose: suggestion.purpose || null,
        status, scheduledAt: at, scheduledEndAt: suggestion.scheduledEndAt ? new Date(suggestion.scheduledEndAt) : null,
        previousScheduledAt: suggestion.action === "reschedule" ? existing?.scheduledAt : existing?.previousScheduledAt,
        responsibleMembershipId: existing?.responsibleMembershipId || owner?.id || null,
        locationName: suggestion.locationName === undefined ? existing?.locationName || null : suggestion.locationName, address: suggestion.address === undefined ? existing?.address || null : suggestion.address,
        phone: suggestion.phone === undefined ? existing?.phone || null : suggestion.phone,
        meetingId: suggestion.meetingId === undefined ? existing?.meetingId || null : suggestion.meetingId,
        meetingPassword: suggestion.meetingPassword === undefined ? existing?.meetingPassword || null : suggestion.meetingPassword,
        meetingProvider: suggestion.meetingProvider === undefined ? existing?.meetingProvider || null : suggestion.meetingProvider, meetingUrl: suggestion.meetingUrl === undefined ? existing?.meetingUrl || null : suggestion.meetingUrl,
        clarificationNeeded: suggestion.clarificationNeeded || null, confidence: suggestion.confidence,
        sourceMessageIdsJson: json(suggestion.evidenceMessageIds),
        contextSnapshotJson: json({ summary: analysis.summaryUpdate, sourceMessageId, events: analysis.events || [] }),
        remindersJson: json(defaultReminders(suggestion.type)),
        ...(status === "CANCELLED" ? { cancelledAt: new Date() } : {}),
        ...(status === "COMPLETED" ? { completedAt: new Date() } : {}),
      };
      const agreement = existing
        ? await tx.agreement.update({ where: { id: existing.id, tenantId: tid, updatedAt: existing.updatedAt }, data })
        : await tx.agreement.create({ data: { ...data, tenantId: tid, dedupeKey: agreementKey } });
      addChange("agreement", agreement.id, existing, { ...data, updatedAt: agreement.updatedAt.toISOString() }, suggestion.type, suggestion.confidence);
      await tx.scheduledAction.updateMany({ where: { tenantId: tid, parentType: "agreement", parentId: agreement.id, state: "scheduled" }, data: { state: "canceled", cancelReason: "agreement_updated" } });
      if (!["CANCELLED", "COMPLETED"].includes(status)) await scheduleReminders(tx, tid, "agreement", agreement.id, at, suggestion.type);
      let task = await tx.task.findFirst({ where: { tenantId: tid, agreementId: agreement.id } });
      if (settings.crm.createTasks) {
        const oldSnapshot = asObject(task?.contextSnapshotJson);
        const untouched = !task || (task.source === "context_engine" && Object.entries(taskState(task)).every(([key, value]) => asObject(oldSnapshot.aiTaskState)[key] === value) && oldSnapshot.executorType !== "AI");
        const meeting = ["CALL", "ONLINE_MEETING", "OFFLINE_MEETING"].includes(suggestion.type);
        const shouldTask = suggestion.createTask && ["CONFIRMED", "SCHEDULED", "RESCHEDULED"].includes(status) && (!meeting || at != null);
        if (untouched && (!task || !["done", "canceled"].includes(task.status)) && (shouldTask || (task && ["CANCELLED", "COMPLETED"].includes(status)))) {
          const hitl = ["SEND_CONTRACT", "SEND_INVOICE", "SEND_PROPOSAL", "SEND_DOCUMENTS"].includes(suggestion.type);
          const taskData = { type: agreementTypeToTaskType(suggestion.type), title: suggestion.title,
            description: suggestion.summary || analysis.summaryUpdate, contactId, inquiryId: inquiry?.id || null,
            dealId: deal?.id || null, conversationId, agreementId: agreement.id, dueAt: at,
            ownerMembershipId: task?.ownerMembershipId || owner?.id || null,
            status: status === "CANCELLED" ? "canceled" : status === "COMPLETED" ? "done" : "open",
            completedAt: ["CANCELLED", "COMPLETED"].includes(status) ? new Date() : null,
            source: "context_engine", targetType: contactId ? "client" : "none",
            briefingText: analysis.summaryUpdate, purpose: suggestion.purpose || null,
            sourceMessageIdsJson: json(suggestion.evidenceMessageIds),
            executionStatus: hitl ? "prepared" : "none", commandStatus: hitl ? "needs_confirmation" : "none",
          };
          const snapshot = json(taskCreatorSnapshot({ existing: { summary: analysis.summaryUpdate, aiTaskState: taskState(taskData), sourceMessageId },
            createdByKind: "ai", createdByMembershipId: null, executorType: "USER" }));
          const previous = task;
          task = task ? await tx.task.update({ where: { id: task.id, tenantId: tid, status: task.status, dueAt: task.dueAt, ownerMembershipId: task.ownerMembershipId, title: task.title, description: task.description, contextSnapshotJson: { equals: json(task.contextSnapshotJson || {}) } }, data: { ...taskData, contextSnapshotJson: snapshot } })
            : await tx.task.create({ data: { ...taskData, tenantId: tid, dedupeKey: `task-agr:${agreement.id}`, contextSnapshotJson: snapshot } });
          addChange("task", task.id, previous ? taskState(previous) : null, taskState(task), suggestion.type, suggestion.confidence);
          if (hitl && task.status === "open") await createStaffNotification(tx, {
            tenantId: tid, membershipId: task.ownerMembershipId, type: "agreement.needs_confirmation",
            entityType: "agreement", entityId: agreement.id, title: "Нужно подтверждение перед отправкой",
            body: `${agreement.title}. Проверьте и подтвердите отправку.`, priority: "high",
            episodeKey: `agreement-confirmation:${agreement.id}:${sourceMessageId}`, channels: ["in_app", "web_push"],
          });
        }
      }
      applied.agreements.push({ agreementId: agreement.id, taskId: task?.id || null, type: agreement.type, status: agreement.status });
    }
    for (const change of changes) {
      const metadata = { actor: "ai", conversationId, contactId, dealId: deal?.id || null, sourceMessageId, sourceMessageAt: sourceMessageAt.toISOString(), ...change };
      await writeAudit(tx, { tenantId: tid, action: "conversation.crm_updated", entityType: change.entityType,
        entityId: change.entityId, correlationId: sourceMessageId, changes: metadata });
      if (contactId) await writeActivity(tx, { tenantId: tid, contactId, inquiryId: inquiry?.id, dealId: deal?.id,
        type: "conversation.crm_updated", title: "AI обновил CRM по переписке", description: analysis.summaryUpdate,
        actorType: "ai", metadata: json(metadata) as Record<string, unknown> });
    }
    await tx.idempotencyRecord.create({ data: { ...key, requestHash: sourceMessageId,
      resultJson: json({ events: analysis.events || [], applied }), expiresAt: new Date("9999-12-31T00:00:00Z") } });
    return { applied, skipped: null };
  }, { timeout: 15000 });
  // Tenant OAuth calendar polling synchronizes persisted agreements independently.
  return { dryRun: false, ...result, ...outcome };
}

export const analyzeAndApplyConversation = applyConversationAnalysis;
