import { createHash, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { writeActivity } from "./contactService.ts";
import { analyzeConversationContext } from "./conversationContextService.ts";
import {
  AGREEMENT_STATUS_LABEL,
  AGREEMENT_TYPE_LABEL,
  type ConversationAnalysis,
  type SuggestedAgreement,
  agreementTypeToTaskType,
} from "./conversationContextTypes.ts";
import { ensureDealPipelineStages } from "./dealService.ts";
import { syncAgreementToCalendar } from "./calendarAdapter.ts";
import { createStaffNotification } from "./notificationService.ts";

const SAFE_INQUIRY_TRANSITIONS: Record<string, string[]> = {
  new: ["qualification", "qualified"],
  qualification: ["qualified", "waiting_client", "waiting_manager"],
  qualified: ["waiting_client", "waiting_manager", "in_progress"],
  accepted: ["qualification", "qualified", "in_progress", "waiting_client"],
  in_progress: ["waiting_client", "waiting_manager", "qualified"],
};

const SAFE_DEAL_STAGES = new Set(["need_identified", "proposal_sent", "negotiation", "contract"]);
const BLOCKED_DEAL = new Set(["won", "lost", "WON", "LOST"]);

const ACTIVE_AGREEMENT = ["DETECTED", "NEEDS_CLARIFICATION", "CONFIRMED", "SCHEDULED", "RESCHEDULED"];

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

function dedupeKeyFor(suggestion: SuggestedAgreement, conversationId: string, contactId: string | null) {
  const day = suggestion.scheduledAt ? suggestion.scheduledAt.slice(0, 10) : "nodate";
  return `agr:${conversationId || contactId || "x"}:${suggestion.type}:${day}`;
}

async function scheduleReminders(
  prisma: PrismaClient,
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

async function upsertAgreementAndTask(
  prisma: PrismaClient,
  auth: AuthContext,
  ctx: {
    tid: string;
    conversationId: string;
    contactId: string | null;
    inquiryId: string | null;
    dealId: string | null;
    analysis: ConversationAnalysis;
    recentMessages: Array<{ id: string; text?: string | null; senderKind: string; direction: string; createdAt: Date }>;
  },
  suggestion: SuggestedAgreement,
) {
  const tid = ctx.tid;
  const confidence = suggestion.confidence || "MEDIUM";
  if (confidence === "LOW" && suggestion.action === "create") {
    return { skipped: true, reason: "low_confidence" as const };
  }

  if (suggestion.action === "cancel" && suggestion.existingAgreementId) {
    const agr = await prisma.agreement.update({
      where: { id: suggestion.existingAgreementId },
      data: { status: "CANCELLED", cancelledAt: new Date(), clarificationNeeded: null },
    });
    const task = await prisma.task.findFirst({ where: { tenantId: tid, agreementId: agr.id } });
    if (task && (task.status === "open" || task.status === "waiting")) {
      await prisma.task.update({ where: { id: task.id }, data: { status: "canceled", completedAt: new Date() } });
    }
    if (ctx.contactId) {
      await writeActivity(prisma, {
        tenantId: tid,
        contactId: ctx.contactId,
        inquiryId: ctx.inquiryId,
        dealId: ctx.dealId,
        type: "agreement.cancelled",
        title: "Договорённость отменена",
        description: agr.title,
        metadata: { agreementId: agr.id, type: agr.type },
      });
    }
    return { agreement: agr, task: null, cancelled: true };
  }

  const key = dedupeKeyFor(suggestion, ctx.conversationId, ctx.contactId);
  let agreement =
    (suggestion.existingAgreementId
      ? await prisma.agreement.findFirst({ where: { id: suggestion.existingAgreementId, tenantId: tid } })
      : null) ||
    (await prisma.agreement.findFirst({
      where: {
        tenantId: tid,
        OR: [{ dedupeKey: key }, { conversationId: ctx.conversationId, type: suggestion.type, status: { in: ACTIVE_AGREEMENT } }],
      },
      orderBy: { updatedAt: "desc" },
    }));

  const scheduledAt = suggestion.scheduledAt ? new Date(suggestion.scheduledAt) : null;
  const sourceIds = suggestion.evidenceMessageIds?.length
    ? suggestion.evidenceMessageIds
    : ctx.analysis.evidenceMessageIds;
  const snapshot = {
    summary: ctx.analysis.summaryUpdate,
    facts: ctx.analysis.facts,
    waitingFor: ctx.analysis.waitingFor,
    recentMessages: ctx.recentMessages
      .filter((m) => sourceIds.includes(m.id))
      .slice(-12)
      .map((m) => ({
        id: m.id,
        text: m.text,
        senderKind: m.senderKind,
        direction: m.direction,
        createdAt: m.createdAt.toISOString(),
      })),
  };

  const data = {
    contactId: ctx.contactId,
    inquiryId: ctx.inquiryId,
    dealId: ctx.dealId,
    conversationId: ctx.conversationId,
    type: suggestion.type,
    title: suggestion.title,
    summary: suggestion.summary || null,
    purpose: suggestion.purpose || null,
    status: suggestion.status,
    scheduledAt,
    previousScheduledAt:
      suggestion.action === "reschedule" && agreement?.scheduledAt ? agreement.scheduledAt : agreement?.previousScheduledAt || null,
    locationName: suggestion.locationName || null,
    address: suggestion.address || null,
    meetingProvider: suggestion.meetingProvider || null,
    meetingUrl: suggestion.meetingUrl || null,
    meetingId: suggestion.meetingId || null,
    meetingPassword: suggestion.meetingPassword || null,
    phone: suggestion.phone || null,
    sourceMessageIdsJson: sourceIds as unknown as Prisma.InputJsonValue,
    contextSnapshotJson: snapshot as unknown as Prisma.InputJsonValue,
    remindersJson: defaultReminders(suggestion.type) as unknown as Prisma.InputJsonValue,
    confidence,
    clarificationNeeded: suggestion.clarificationNeeded || null,
    dedupeKey: key,
    cancelledAt: null,
  };

  if (agreement) {
    agreement = await prisma.agreement.update({ where: { id: agreement.id }, data });
  } else {
    agreement = await prisma.agreement.create({
      data: { id: randomUUID(), tenantId: tid, ...data },
    });
  }

  await scheduleReminders(prisma, tid, "agreement", agreement.id, scheduledAt, suggestion.type);
  await syncAgreementToCalendar(agreement).catch(() => null);

  const hitlTypes = new Set(["SEND_CONTRACT", "SEND_INVOICE", "SEND_PROPOSAL", "SEND_DOCUMENTS"]);
  const requiresHitl = hitlTypes.has(suggestion.type);

  if (ctx.contactId) {
    const title =
      suggestion.action === "reschedule"
        ? "Встреча перенесена"
        : suggestion.status === "NEEDS_CLARIFICATION"
          ? "Договорённость требует уточнения"
          : "Зафиксирована договорённость";
    await writeActivity(prisma, {
      tenantId: tid,
      contactId: ctx.contactId,
      inquiryId: ctx.inquiryId,
      dealId: ctx.dealId,
      type: suggestion.action === "reschedule" ? "agreement.rescheduled" : "agreement.upserted",
      title,
      description: agreement.title,
      metadata: {
        agreementId: agreement.id,
        type: agreement.type,
        status: agreement.status,
        scheduledAt: agreement.scheduledAt?.toISOString() || null,
        previousScheduledAt: agreement.previousScheduledAt?.toISOString() || null,
        requiresHitl,
      },
    });
  }

  if (requiresHitl && auth.activeMembership?.id) {
    await createStaffNotification(prisma, {
      tenantId: tid,
      membershipId: auth.activeMembership.id,
      type: "agreement.needs_confirmation",
      entityType: "agreement",
      entityId: agreement.id,
      title: "Нужно подтверждение перед отправкой",
      body: `${agreement.title}. AI понял договорённость — проверьте и подтвердите отправку.`,
      priority: "high",
      channels: ["in_app", "web_push"],
    });
  }

  let task = await prisma.task.findFirst({ where: { tenantId: tid, agreementId: agreement.id } });
  const shouldTask =
    suggestion.createTask &&
    (suggestion.status === "CONFIRMED" ||
      suggestion.status === "SCHEDULED" ||
      suggestion.status === "RESCHEDULED" ||
      (suggestion.status === "NEEDS_CLARIFICATION" && confidence === "HIGH"));

  if (!shouldTask) {
    return { agreement, task, cancelled: false, requiresHitl };
  }

  const taskType = suggestion.taskType || agreementTypeToTaskType(suggestion.type as never);
  const briefing =
    ctx.analysis.summaryUpdate ||
    `Основание: договорённость в диалоге (${AGREEMENT_TYPE_LABEL[suggestion.type as keyof typeof AGREEMENT_TYPE_LABEL] || suggestion.type}).`;
  const hints = (ctx.analysis.suggestedTasks.find((t) => t.linkedAgreementIndex === 0)?.preparationHints || []).map(
    (h) => (h.startsWith("AI рекомендует") ? h : `AI рекомендует: ${h}`),
  );
  if (requiresHitl) {
    hints.unshift("Требуется подтверждение менеджера перед внешней отправкой");
  }

  const taskData = {
    type: taskType,
    title: suggestion.title,
    description: suggestion.summary || suggestion.clarificationNeeded || null,
    contactId: ctx.contactId,
    inquiryId: ctx.inquiryId,
    conversationId: ctx.conversationId,
    dealId: ctx.dealId,
    agreementId: agreement.id,
    dueAt: scheduledAt,
    priority: suggestion.status === "NEEDS_CLARIFICATION" || requiresHitl ? "high" : "normal",
    source: "context_engine",
    status: "open" as const,
    targetType: ctx.contactId ? "client" : "none",
    ownerMembershipId: auth.activeMembership?.id || null,
    dedupeKey: `task-agr:${agreement.id}`,
    contextSnapshotJson: snapshot as unknown as Prisma.InputJsonValue,
    sourceMessageIdsJson: sourceIds as unknown as Prisma.InputJsonValue,
    purpose: suggestion.purpose || null,
    briefingText: briefing,
    preparationHintsJson: hints as unknown as Prisma.InputJsonValue,
    executionStatus: requiresHitl ? "prepared" : "none",
    commandStatus: requiresHitl ? "needs_confirmation" : "none",
  };

  if (task) {
    if (task.status === "done" || task.status === "canceled") {
      // recreate open task for reschedule after cancel? only if reschedule
      if (suggestion.action === "reschedule" || suggestion.action === "update") {
        task = await prisma.task.create({
          data: { id: randomUUID(), tenantId: tid, ...taskData, dedupeKey: `task-agr:${agreement.id}:${Date.now()}` },
        });
      }
    } else {
      task = await prisma.task.update({
        where: { id: task.id },
        data: {
          title: taskData.title,
          description: taskData.description,
          dueAt: taskData.dueAt,
          purpose: taskData.purpose,
          briefingText: taskData.briefingText,
          preparationHintsJson: taskData.preparationHintsJson,
          contextSnapshotJson: taskData.contextSnapshotJson,
          sourceMessageIdsJson: taskData.sourceMessageIdsJson,
          status: "open",
        },
      });
    }
  } else {
    // dedupe by contact+type+due day
    const existingOpen = await prisma.task.findFirst({
      where: {
        tenantId: tid,
        status: { in: ["open", "waiting"] },
        type: taskType,
        contactId: ctx.contactId || undefined,
        dueAt: scheduledAt || undefined,
        parentTaskId: null,
      },
    });
    if (existingOpen && !existingOpen.agreementId) {
      task = await prisma.task.update({
        where: { id: existingOpen.id },
        data: taskData,
      });
    } else if (existingOpen?.agreementId === agreement.id) {
      task = existingOpen;
    } else {
      try {
        task = await prisma.task.create({ data: { id: randomUUID(), tenantId: tid, ...taskData } });
      } catch {
        task = await prisma.task.findFirst({ where: { tenantId: tid, dedupeKey: taskData.dedupeKey } });
      }
    }
  }

  if (ctx.contactId && task) {
    await writeActivity(prisma, {
      tenantId: tid,
      contactId: ctx.contactId,
      inquiryId: ctx.inquiryId,
      dealId: ctx.dealId,
      type: "task.auto_created",
      title: "Автоматически создана задача",
      description: task.title,
      metadata: { taskId: task.id, agreementId: agreement.id, source: "context_engine" },
    });
  }

  if (ctx.dealId && scheduledAt) {
    await prisma.deal.update({
      where: { id: ctx.dealId },
      data: {
        nextAction: suggestion.title,
        nextActionAt: scheduledAt,
      },
    });
  }

  return { agreement, task, cancelled: false };
}

export async function applyConversationAnalysis(
  prisma: PrismaClient,
  auth: AuthContext,
  conversationId: string,
  options: { useLlm?: boolean; dryRun?: boolean } = {},
) {
  const tid = tenantId(auth);
  const { analysis } = await analyzeConversationContext(prisma, auth, conversationId, { useLlm: options.useLlm });

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId: tid },
    include: {
      messages: { orderBy: { createdAt: "desc" }, take: 20 },
      inquiries: { where: { archived: false }, orderBy: { receivedAt: "desc" }, take: 1 },
    },
  });
  if (!conversation) throw new ApiError(404, "not_found", "Диалог не найден");

  const contactId = conversation.contactId;
  const inquiry =
    conversation.inquiries[0] ||
    (contactId
      ? await prisma.inquiry.findFirst({
          where: { tenantId: tid, contactId, archived: false },
          orderBy: { receivedAt: "desc" },
        })
      : null);
  const deal = contactId
    ? await prisma.deal.findFirst({
        where: { tenantId: tid, contactId, outcome: "open" },
        include: { stage: true },
        orderBy: { updatedAt: "desc" },
      })
    : null;

  if (options.dryRun) {
    return { dryRun: true, analysis, applied: null };
  }

  const lastMsg = conversation.messages[0];
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      waitingFor: analysis.waitingFor,
      contextSummary: analysis.summaryUpdate,
      lastContextAnalyzedAt: new Date(),
      lastAnalyzedMessageId: lastMsg?.id || null,
      needsAttention: analysis.humanRequired || analysis.needsReply || analysis.waitingFor === "MANAGER",
      attentionReason: analysis.humanRequired
        ? analysis.humanReason || "human_required"
        : analysis.needsReply
          ? "needs_reply"
          : conversation.attentionReason,
    },
  });

  if (contactId && analysis.summaryUpdate) {
    await prisma.contact.update({
      where: { id: contactId },
      data: {
        summary: analysis.summaryUpdate,

      },
    });
  }

  // Safe inquiry status
  const applied: Record<string, unknown> = { agreements: [], inquiryStatus: null, dealStage: null, suggestions: [] };
  if (inquiry && analysis.suggestedRequestStatus) {
    const allowed = SAFE_INQUIRY_TRANSITIONS[inquiry.status] || [];
    if (allowed.includes(analysis.suggestedRequestStatus) && (analysis.confidence === "HIGH" || analysis.confidence === "MEDIUM")) {
      await prisma.inquiry.update({
        where: { id: inquiry.id },
        data: {
          status: analysis.suggestedRequestStatus,
          ...(analysis.suggestedRequestStatus === "qualified" ? { qualifiedAt: new Date() } : {}),
          aiSummary: analysis.summaryUpdate || inquiry.aiSummary,
          needsReply: analysis.needsReply,
        },
      });
      await prisma.inquiryStatusHistory.create({
        data: {
          id: randomUUID(),
          tenantId: tid,
          inquiryId: inquiry.id,
          fromStatus: inquiry.status,
          toStatus: analysis.suggestedRequestStatus,
          changedByType: "context_engine",
          note: analysis.summaryUpdate || undefined,
        },
      });
      applied.inquiryStatus = analysis.suggestedRequestStatus;
    }
  }

  // Safe deal stage — never WON/LOST
  if (deal && analysis.suggestedDealStage && !BLOCKED_DEAL.has(analysis.suggestedDealStage)) {
    const targetKey = analysis.suggestedDealStage;
    if (SAFE_DEAL_STAGES.has(targetKey) && deal.stage?.systemKey !== targetKey && analysis.confidence === "HIGH") {
      const stages = await ensureDealPipelineStages(prisma, tid);
      const target = stages.find((s) => s.systemKey === targetKey);
      if (target) {
        await prisma.deal.update({
          where: { id: deal.id },
          data: { stageId: target.id, stageEnteredAt: new Date(), probability: target.defaultProbability },
        });
        await prisma.dealStageHistory.create({
          data: {
            id: randomUUID(),
            tenantId: tid,
            dealId: deal.id,
            fromStageId: deal.stageId,
            fromSystemKey: deal.stage?.systemKey || null,
            toStageId: target.id,
            toSystemKey: target.systemKey,
            changedByType: "context_engine",
            note: analysis.summaryUpdate || undefined,
          },
        });
        applied.dealStage = targetKey;
      }
    } else if (SAFE_DEAL_STAGES.has(targetKey) && analysis.confidence !== "HIGH") {
      applied.suggestions.push({ kind: "deal_stage", stage: targetKey, requiresConfirm: true });
    }
  }

  const recent = [...conversation.messages].reverse();
  for (const suggestion of analysis.agreements) {
    const result = await upsertAgreementAndTask(
      prisma,
      auth,
      {
        tid,
        conversationId,
        contactId,
        inquiryId: inquiry?.id || null,
        dealId: deal?.id || null,
        analysis,
        recentMessages: recent,
      },
      suggestion,
    );
    (applied.agreements as unknown[]).push({
      type: suggestion.type,
      status: suggestion.status,
      statusLabel: AGREEMENT_STATUS_LABEL[suggestion.status],
      agreementId: (result as { agreement?: { id: string } }).agreement?.id,
      taskId: (result as { task?: { id: string } | null }).task?.id || null,
      skipped: (result as { skipped?: boolean }).skipped || false,
    });
  }

  return { dryRun: false, analysis, applied };
}

export async function analyzeAndApplyConversation(
  prisma: PrismaClient,
  auth: AuthContext,
  conversationId: string,
  options: { useLlm?: boolean; dryRun?: boolean } = {},
) {
  return applyConversationAnalysis(prisma, auth, conversationId, options);
}
