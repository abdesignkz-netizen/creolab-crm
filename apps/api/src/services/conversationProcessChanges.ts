import { randomUUID } from "node:crypto";
import type { Prisma } from "@creolab/db";
import { taskCreatorSnapshot } from "@creolab/contracts";
import type { analyzeConversationContext, resolveContextDeal } from "./conversationContextService.ts";
import { agreementTypeToTaskType } from "./conversationContextTypes.ts";
import { publishedIntakePolicy } from "./aiIntakeService.ts";
import type { AIAutomationSettings } from "./aiAutomationSettings.ts";
import { recordDealStageTransition } from "./dealStageHistory.ts";
import { createStaffNotification } from "./notificationService.ts";
import { ProcessReviewCapture } from "./conversationProcessReview.ts";

type Tx = Prisma.TransactionClient;
type AnalysisResult = Awaited<ReturnType<typeof analyzeConversationContext>>;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const asObject = object;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const taskState = (task: { title: string; dueAt: Date | null; status: string; ownerMembershipId: string | null; description: string | null }) =>
  ({ title: task.title, dueAt: task.dueAt?.toISOString() || null, status: task.status, ownerMembershipId: task.ownerMembershipId, description: task.description });
const SAFE_DEAL_STAGES = new Set(["need_identified", "proposal_sent", "negotiation"]);
export type ProcessOperation = { kind: "deal" | "agreement" | "task"; id: string; before: Record<string, unknown> | null; data: Record<string, unknown>; eventType: string; confidence: "HIGH" | "MEDIUM" | "LOW" };
export type ProcessInput = {
  result: AnalysisResult; settings: AIAutomationSettings;
  conversation: Prisma.ConversationGetPayload<{ include: { contact: true } }>;
  inquiry: Prisma.InquiryGetPayload<{}> | undefined;
  deal: Awaited<ReturnType<typeof resolveContextDeal>>;
  evidenceMessages: Array<{ id: string; direction: string; senderKind: string }>;
  createdSalesDeal?: { id: string } | null;
  allowAmount?: boolean;
};
export function defaultReminders(type: string) {
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


/** Read-only preparation shared by automatic application and staff proposals. */
export async function prepareContextProcess(tx: Tx, tid: string, input: ProcessInput) {
  const { result, settings, conversation, inquiry, deal, evidenceMessages, createdSalesDeal } = input;
  const { analysis } = result, sourceMessageId = result.sourceMessageId!, sourceMessageAt = result.sourceMessageAt!;
  const conversationId = conversation.id, contactId = conversation.contactId;
  const evidenceIds = new Set(evidenceMessages.map(m => m.id));
  const grounded = (ids: string[]) => ids.includes(sourceMessageId) && ids.every(id => evidenceIds.has(id));
  const reliable = analysis.confidence === "HIGH" && grounded(analysis.evidenceMessageIds);
  const records: ProcessOperation[] = [], plannedAgreements = new Set<string>();
  const notifications: Array<{ agreementId: string; title: string; ownerMembershipId: string | null }> = [];
  const applied: { agreements: unknown[]; dealStage: string | null; dealAmount: number | null } = { agreements: [], dealStage: null, dealAmount: null };
  const manuallyChanged = async (entityType: string, entityId: string) => Boolean(await tx.auditEvent.findFirst({ where: {
    tenantId: tid, entityType, entityId, actorUserId: { not: null }, createdAt: { gte: sourceMessageAt },
  }, select: { id: true } }));
    // An older message may never overwrite a newer edit, including edits made during AI inference.
    const lastAiDealChange = deal ? await tx.auditEvent.findFirst({ where: { tenantId: tid, entityType: "deal", entityId: deal.id,
      action: "conversation.crm_updated", actorUserId: null }, orderBy: { createdAt: "desc" } }) : null;
    const lastAiData = asObject(lastAiDealChange?.changesJson);
    const onlyPriorAiChanged = deal && asObject(lastAiData.after).version === deal.version &&
      typeof lastAiData.sourceMessageAt === "string" && new Date(lastAiData.sourceMessageAt) <= sourceMessageAt;
    const dealWritable = deal && (createdSalesDeal?.id === deal.id || (result.snapshot.deal?.id === deal.id && result.snapshot.deal.version === deal.version &&
      result.snapshot.deal.updatedAt.getTime() === deal.updatedAt.getTime() &&
      (deal.updatedAt <= sourceMessageAt || onlyPriorAiChanged) && !await manuallyChanged("deal", deal.id)));
    const dealData: Prisma.DealUncheckedUpdateInput = {};
    const accepted = (analysis.events || []).filter(e => e.type === "PRICE_ACCEPTED" && e.confidence === "HIGH" && grounded(e.evidenceMessageIds));
    if (dealWritable && evidenceMessages.some(m => m.id === sourceMessageId && (m.direction === "inbound" || m.senderKind === "client")) && input.allowAmount !== false && settings.crm.updateDealAmount && accepted.length === 1 && !(analysis.events || []).some(e => e.type === "PRICE_REJECTED")) {
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
      const target = await tx.dealStage.findFirst({ where: { tenantId: tid, systemKey: analysis.suggestedDealStage, isTerminal: false, isArchived: false } });
      if (target && target.sortOrder > deal.stage.sortOrder) {
        dealData.stageId = target.id; dealData.stageEnteredAt = new Date(); dealData.probability = target.defaultProbability;
        applied.dealStage = target.systemKey;
      }
    }
    const ownerCandidate = conversation.assigneeMembershipId || deal?.assigneeMembershipId || inquiry?.assigneeMembershipId || conversation.contact?.ownerMembershipId;
    const owner = ownerCandidate ? await tx.membership.findFirst({ where: { id: ownerCandidate, tenantId: tid, active: true } }) : null;
    const intakePolicy = await publishedIntakePolicy(tx, tid);
    const staffSource = evidenceMessages.some(m => m.id === sourceMessageId && m.direction === "outbound" && m.senderKind === "staff");
    const scheduled = analysis.agreements.filter(a => a.confidence === "HIGH" && grounded(a.evidenceMessageIds)
      && (!a.scheduledAt || Number.isFinite(Date.parse(a.scheduledAt)))
      && (!a.scheduledEndAt || Boolean(a.scheduledAt && Date.parse(a.scheduledEndAt) > Date.parse(a.scheduledAt)))
      // Neither customer preferences nor the AI's own words confirm a reservation.
      && !(!staffSource && intakePolicy?.roles.includes("booking") && ["CALL", "OFFLINE_MEETING", "ONLINE_MEETING"].includes(a.type)));
    if (dealWritable && settings.crm.updateNextAction && reliable && analysis.suggestedNextAction) {
      dealData.nextAction = analysis.suggestedNextAction;
      const dated = scheduled.find(a => a.scheduledAt && ["CONFIRMED", "SCHEDULED", "RESCHEDULED"].includes(a.status));
      if (dated?.scheduledAt && Number.isFinite(Date.parse(dated.scheduledAt))) dealData.nextActionAt = new Date(dated.scheduledAt);
    }
    if (dealWritable && Object.keys(dealData).length) {
      records.push({ kind: "deal", id: deal.id, before: object(json(deal)), data: object(json(dealData)), eventType: applied.dealAmount != null ? "PRICE_ACCEPTED" : "DEAL_UPDATED", confidence: "HIGH" });
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
      const agreement = { ...existing, ...data, id: existing?.id || randomUUID(), tenantId: tid, dedupeKey: existing?.dedupeKey || agreementKey };
      const key = existing?.id || agreementKey;
      if (plannedAgreements.has(key)) continue;
      plannedAgreements.add(key);
      records.push({ kind: "agreement", id: agreement.id, before: existing ? object(json(existing)) : null,
        data: object(json({ ...data, ...(!existing ? { dedupeKey: agreementKey } : {}) })), eventType: suggestion.type, confidence: suggestion.confidence });
      let task = await tx.task.findFirst({ where: { tenantId: tid, agreementId: agreement.id } });
      if (settings.crm.createTasks) {
        const oldSnapshot = asObject(task?.contextSnapshotJson);
        const untouched = !task || (task.source === "context_engine" && !oldSnapshot.manualEditId && Object.entries(taskState(task)).every(([key, value]) => asObject(oldSnapshot.aiTaskState)[key] === value) && oldSnapshot.executorType !== "AI");
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
          const taskId = task?.id || randomUUID();
          records.push({ kind: "task", id: taskId, before: task ? object(json(task)) : null,
            data: object(json({ ...taskData, contextSnapshotJson: snapshot, ...(!task ? { dedupeKey: `task-agr:${agreement.id}` } : {}) })), eventType: suggestion.type, confidence: suggestion.confidence });
          task = { ...task, ...taskData, id: taskId } as typeof task;
          if (hitl && taskData.status === "open") notifications.push({ agreementId: agreement.id, title: agreement.title, ownerMembershipId: taskData.ownerMembershipId });
        }
      }
      applied.agreements.push({ agreementId: agreement.id, taskId: task?.id || null, type: agreement.type, status: agreement.status });
    }
    return { records, notifications, applied, owner, intakePolicy, scheduled, dealWritable: Boolean(dealWritable), dealData };
}

export async function applyContextProcess(tx: Tx, tid: string, plan: Pick<Awaited<ReturnType<typeof prepareContextProcess>>, "records" | "notifications">, options: {
  capture: ProcessReviewCapture;
  sourceMessageId: string;
  summary?: string | null;
  actorUserId?: string;
  notify?: boolean;
  onChange: (operation: ProcessOperation, after: object) => void;
}) {
  for (const record of plan.records) {
    const before = record.before;
    options.capture.remember(record.kind, record.id, before);
    if (record.kind === "agreement" && before) await options.capture.beforeAgreement(tx, tid, record.id);
    // Stored proposals contain JSON dates. Prisma accepts ISO dates as well as Date objects.
    let after: object;
    if (record.kind === "deal") {
      const data = { ...record.data, ...(record.data.stageId ? { stageEnteredAt: new Date() } : {}), version: { increment: 1 } };
      after = await tx.deal.update({ where: { id: record.id, tenantId: tid, version: Number(before!.version), updatedAt: new Date(String(before!.updatedAt)) }, data: data as Prisma.DealUncheckedUpdateInput });
      if (record.data.stageId && record.data.stageId !== before!.stageId) {
        const from = await tx.dealStage.findUniqueOrThrow({ where: { id: String(before!.stageId) } }), to = await tx.dealStage.findUniqueOrThrow({ where: { id: String(record.data.stageId) } });
        await recordDealStageTransition(tx, { tenantId: tid, dealId: record.id, fromStageId: from.id, fromSystemKey: from.systemKey, toStageId: to.id, toSystemKey: to.systemKey,
          enteredAt: object(after).stageEnteredAt as Date, changedByType: options.actorUserId ? "user" : "context_engine", changedById: options.actorUserId, note: options.actorUserId ? "Подтверждено предложение ИИ" : options.summary || null });
      }
    } else if (record.kind === "agreement") {
      const data = { ...record.data, ...(record.data.status === "CANCELLED" ? { cancelledAt: new Date() } : {}), ...(record.data.status === "COMPLETED" ? { completedAt: new Date() } : {}) };
      after = before ? await tx.agreement.update({ where: { id: record.id, tenantId: tid, updatedAt: new Date(String(before.updatedAt)) }, data: data as Prisma.AgreementUncheckedUpdateInput })
        : await tx.agreement.create({ data: { ...data, id: record.id, tenantId: tid } as Prisma.AgreementUncheckedCreateInput });
      await tx.scheduledAction.updateMany({ where: { tenantId: tid, parentType: "agreement", parentId: record.id, state: "scheduled" }, data: { state: "canceled", cancelReason: "agreement_updated" } });
      if (!["CANCELLED", "COMPLETED"].includes(String(record.data.status))) await scheduleReminders(tx, tid, "agreement", record.id, record.data.scheduledAt ? new Date(String(record.data.scheduledAt)) : null, String(record.data.type));
    } else {
      const data = { ...record.data, ...(record.data.completedAt ? { completedAt: new Date() } : {}) };
      after = before ? await tx.task.update({ where: { id: record.id, tenantId: tid, status: String(before.status), title: String(before.title), description: before.description as string | null,
        ownerMembershipId: before.ownerMembershipId as string | null, dueAt: before.dueAt ? new Date(String(before.dueAt)) : null, contextSnapshotJson: { equals: json(before.contextSnapshotJson || {}) } }, data: data as Prisma.TaskUncheckedUpdateInput })
        : await tx.task.create({ data: { ...data, id: record.id, tenantId: tid } as Prisma.TaskUncheckedCreateInput });
    }
    options.onChange(record, after);
  }
  if (options.notify !== false) for (const item of plan.notifications) await createStaffNotification(tx, {
    tenantId: tid, membershipId: item.ownerMembershipId, type: "agreement.needs_confirmation", entityType: "agreement", entityId: item.agreementId,
    title: "Нужно подтверждение перед отправкой", body: `${item.title}. Проверьте и подтвердите отправку.`, priority: "high",
    episodeKey: `agreement-confirmation:${item.agreementId}:${options.sourceMessageId}`, channels: ["in_app", "web_push"],
  });
}
