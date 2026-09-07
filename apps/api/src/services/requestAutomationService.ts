import type { Prisma, PrismaClient } from "@creolab/db";
import { parseAIAutomationSettings, isWithinAiSchedule } from "./aiAutomationSettings.ts";
import { decideAutomationPolicy, type AutomationDecision } from "./aiAutomationPolicyService.ts";
import { analyzeRequestWithOptionalLlm, type RequestAnalysis } from "./requestAnalysisService.ts";
import { writeActivity } from "./contactService.ts";

export type AiProcessStatus =
  | "none"
  | "analyzed"
  | "awaiting_confirm"
  | "queued"
  | "in_progress"
  | "waiting_client"
  | "needs_human"
  | "failed"
  | "paused"
  | "completed"
  | "cancelled";

export const AI_PROCESS_LABEL: Record<AiProcessStatus, string> = {
  none: "AI отключён",
  analyzed: "AI-подсказка",
  awaiting_confirm: "Ожидает подтверждения",
  queued: "Ожидает AI",
  in_progress: "AI работает",
  waiting_client: "Ждём клиента",
  needs_human: "Ожидает менеджера",
  failed: "Ошибка",
  paused: "Приостановлено",
  completed: "Выполнено",
  cancelled: "Отменено",
};

export type InquiryAutomationMeta = {
  mode: string;
  reason: string;
  analyze: boolean;
  createTask: boolean;
  autoStart: boolean;
  allowOutbound: boolean;
  status: AiProcessStatus;
  analysis?: RequestAnalysis | null;
  analysisError?: string | null;
  taskId?: string | null;
  handoffReason?: string | null;
  startedAt?: string | null;
  decidedAt: string;
};

function asMeta(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : {};
}

function readAutomation(meta: Record<string, unknown>): InquiryAutomationMeta | null {
  const a = meta.automation;
  if (!a || typeof a !== "object") return null;
  return a as InquiryAutomationMeta;
}

function buildInstruction(args: {
  contactName: string;
  companyName: string | null;
  analysis: RequestAnalysis;
  sourceLine: string;
}): string {
  const known = args.analysis.knownFields
    .filter((f) => f.key !== "phone")
    .map((f) => `✓ ${f.label}${f.value ? `: ${f.value}` : ""}`)
    .join("\n");
  const missing = args.analysis.missingFields.map((f) => `□ ${f.label}`).join("\n");
  return [
    `Задача AI Manager: ${args.analysis.taskTitle}`,
    `Клиент: ${args.contactName}`,
    args.companyName ? `Компания: ${args.companyName}` : null,
    `Источник: ${args.sourceLine}`,
    args.analysis.detectedNeed ? `Запрос: ${args.analysis.detectedNeed}` : null,
    known ? `Уже известно:\n${known}` : null,
    missing ? `Нужно выяснить:\n${missing}` : null,
    `Цель: ${args.analysis.expectedOutcome}`,
    "Не спрашивай телефон — он уже известен.",
    "Не начинай с общего «Чем могу помочь?» — сразу продолжи заявку.",
    "Не придумывай факты, которых нет в контексте.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function findWhatsAppConversation(prisma: PrismaClient, tenantId: string, contactId: string) {
  return prisma.conversation.findFirst({
    where: {
      tenantId,
      contactId,
      sellerLeadId: { not: null },
    },
    orderBy: { updatedAt: "desc" },
    include: {
      connection: true,
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
}

export async function processNewRequestAutomation(
  prisma: PrismaClient,
  tenantId: string,
  inquiryId: string,
  options: { forceMode?: "MANUAL" | "ASSIST" | "CONFIRM" | "AUTO"; forceStart?: boolean } = {},
) {
  const inquiry = await prisma.inquiry.findFirst({
    where: { id: inquiryId, tenantId },
    include: {
      contact: true,
      tasks: { where: { type: "process_inquiry", status: "open" }, take: 1 },
    },
  });
  if (!inquiry) return null;

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  const settings = parseAIAutomationSettings(tenant?.settingsJson);
  const integrationRow = inquiry.integrationId
    ? await prisma.integration.findFirst({
        where: { id: inquiry.integrationId, tenantId },
        select: { automationMode: true },
      })
    : null;
  const contactAttr =
    inquiry.contact?.attributionJson && typeof inquiry.contact.attributionJson === "object"
      ? (inquiry.contact.attributionJson as Record<string, unknown>)
      : {};
  const fieldMeta = asMeta(inquiry.fieldMetaJson);

  const priorCount = await prisma.inquiry.count({
    where: { tenantId, contactId: inquiry.contactId, id: { not: inquiry.id } },
  });

  const decision: AutomationDecision = options.forceMode
    ? {
        mode: options.forceMode,
        analyze: options.forceMode !== "MANUAL",
        createTask: options.forceMode === "CONFIRM" || options.forceMode === "AUTO" || Boolean(options.forceStart),
        autoStart: options.forceMode === "AUTO" || Boolean(options.forceStart),
        allowOutbound: options.forceMode === "AUTO" || Boolean(options.forceStart),
        reason: "Ручная передача AI Manager",
      }
    : decideAutomationPolicy({
        settingsJson: tenant?.settingsJson,
        sourceChannel: inquiry.sourceChannel,
        sourceType: inquiry.sourceType,
        source: inquiry.source,
        serviceCategory: inquiry.serviceCategory,
        integrationId: inquiry.integrationId,
        integrationAutomationMode: integrationRow?.automationMode || null,
        clientAiMode: typeof contactAttr.aiAutomation === "string" ? contactAttr.aiAutomation : null,
        requestOverrideMode:
          typeof fieldMeta.automationOverride === "string" ? fieldMeta.automationOverride : null,
        isRepeatRequest: priorCount > 0,
      });

  const withinSchedule =
    options.forceStart ||
    isWithinAiSchedule(new Date(), tenant?.timezone || "Asia/Almaty", settings);
  if (!withinSchedule && (decision.autoStart || decision.allowOutbound)) {
    decision.autoStart = false;
    decision.allowOutbound = false;
    decision.reason = `${decision.reason}; вне окна автообработки`;
  }

  const decidedAt = new Date().toISOString();
  let analysis: RequestAnalysis | null = null;
  let analysisError: string | null = null;
  let status: AiProcessStatus = decision.analyze ? "analyzed" : "none";

  if (decision.analyze) {
    try {
      analysis = await analyzeRequestWithOptionalLlm({
        name: inquiry.contact?.name,
        companyName: inquiry.companyName || inquiry.contact?.companyName,
        subject: inquiry.subject,
        description: inquiry.description,
        service: inquiry.service,
        serviceCategory: inquiry.serviceCategory,
        serviceSubcategory: inquiry.serviceSubcategory,
        city: inquiry.city,
        desiredDeadline: inquiry.desiredDeadline,
        budgetMin: inquiry.budgetMin,
        budgetMax: inquiry.budgetMax,
        landingPage: inquiry.landingPage,
        utmCampaign: inquiry.utmCampaign,
        sourceChannel: inquiry.sourceChannel,
        phoneNormalized: inquiry.phoneNormalized,
      });
    } catch (err) {
      analysisError = err instanceof Error ? err.message : "AI analysis failed";
      status = "failed";
    }
  }

  const processTask = inquiry.tasks[0] || null;
  const dueAt = new Date(Date.now() + settings.firstContactSlaMinutes * 60_000);

  await prisma.$transaction(async (tx) => {
    const updates: Prisma.InquiryUncheckedUpdateInput = {
      fieldMetaJson: {
        ...fieldMeta,
        automation: {
          mode: decision.mode,
          reason: decision.reason,
          analyze: decision.analyze,
          createTask: decision.createTask,
          autoStart: decision.autoStart,
          allowOutbound: decision.allowOutbound,
          status,
          analysis,
          analysisError,
          taskId: processTask?.id || null,
          decidedAt,
          sourceRule: decision.sourceRule,
          serviceRule: decision.serviceRule,
          integrationRule: decision.integrationRule,
          clientOverride: decision.clientOverride,
        } satisfies InquiryAutomationMeta & Record<string, unknown>,
      } as Prisma.InputJsonValue,
    };

    if (analysis && !analysisError) {
      if (analysis.serviceCategory && !inquiry.serviceCategory) {
        updates.serviceCategory = analysis.serviceCategory;
      }
      if (analysis.serviceSubcategory && !inquiry.serviceSubcategory) {
        updates.serviceSubcategory = analysis.serviceSubcategory;
      }
      if (analysis.city && !inquiry.city) updates.city = analysis.city;
      if (analysis.company && !inquiry.companyName) updates.companyName = analysis.company;
      if (analysis.deadline && !inquiry.desiredDeadline) updates.desiredDeadline = analysis.deadline;
      if (analysis.budgetMin != null && inquiry.budgetMin == null) updates.budgetMin = analysis.budgetMin;
      if (analysis.budgetMax != null && inquiry.budgetMax == null) updates.budgetMax = analysis.budgetMax;
      if (analysis.detectedNeed) updates.aiSummary = analysis.detectedNeed.slice(0, 2000);
      if (inquiry.status === "new" && decision.analyze) {
        updates.status = "qualification";
        updates.nextStep = analysis.taskTitle;
      }
      if (analysis.urgency === "urgent") updates.priority = "urgent";
      else if (analysis.urgency === "high") updates.priority = "high";
    }

    if (analysisError) {
      updates.attentionReason = "AI_ANALYSIS_FAILED";
      updates.nextStep = "Повторить AI-анализ или обработать вручную";
    }

    await tx.inquiry.update({ where: { id: inquiry.id }, data: updates });

    if (inquiry.status === "new" && analysis && !analysisError && decision.analyze) {
      await tx.inquiryStatusHistory.create({
        data: {
          tenantId,
          inquiryId: inquiry.id,
          fromStatus: "new",
          toStatus: "qualification",
          changedByType: "system",
          note: "AI-анализ новой заявки",
        },
      });
    }

    if (processTask && analysis && !analysisError) {
      const executorAi = decision.createTask;
      const nextExec: AiProcessStatus = !decision.createTask
        ? "analyzed"
        : decision.autoStart || options.forceStart
          ? "queued"
          : "awaiting_confirm";

      status = nextExec;

      await tx.task.update({
        where: { id: processTask.id },
        data: {
          title: analysis.taskTitle,
          description: analysis.taskObjective,
          messageDraft: analysis.clientMessageDraft,
          purpose: analysis.expectedOutcome,
          briefingText: analysis.detectedNeed,
          preparationHintsJson: [
            ...analysis.knownFields.map((f) => `Известно: ${f.label}${f.value ? ` — ${f.value}` : ""}`),
            ...analysis.missingFields.map((f) => `Уточнить: ${f.label}`),
          ] as Prisma.InputJsonValue,
          dueAt,
          priority: analysis.urgency === "urgent" ? "urgent" : analysis.urgency === "high" ? "high" : "normal",
          source: executorAi ? "ai_automation" : processTask.source,
          executionStatus: executorAi
            ? nextExec === "awaiting_confirm"
              ? "awaiting_confirm"
              : "queued"
            : "none",
          contextSnapshotJson: {
            executorType: executorAi ? "AI" : "USER",
            executorId: executorAi ? "AI_MANAGER" : null,
            knownFields: analysis.knownFields,
            missingFields: analysis.missingFields,
            expectedOutcome: analysis.expectedOutcome,
            automationMode: decision.mode,
            aiStatus: nextExec,
            qualificationQuestions: analysis.qualificationQuestions,
            clientMessageDraft: analysis.clientMessageDraft,
          } as Prisma.InputJsonValue,
        },
      });

      // Refresh automation status after task update
      const metaNow = asMeta(
        (
          await tx.inquiry.findUnique({
            where: { id: inquiry.id },
            select: { fieldMetaJson: true },
          })
        )?.fieldMetaJson,
      );
      const auto = readAutomation(metaNow) || ({} as InquiryAutomationMeta);
      await tx.inquiry.update({
        where: { id: inquiry.id },
        data: {
          fieldMetaJson: {
            ...metaNow,
            automation: { ...auto, status: nextExec, taskId: processTask.id },
          } as Prisma.InputJsonValue,
        },
      });
    }

    await writeActivity(tx, {
      tenantId,
      contactId: inquiry.contactId,
      inquiryId: inquiry.id,
      type: "inquiry.automation_decided",
      title: `Автоматизация: ${decision.mode}`,
      description: decision.reason,
      actorType: "system",
      metadata: { mode: decision.mode, reason: decision.reason },
    });

    if (analysis && !analysisError) {
      await writeActivity(tx, {
        tenantId,
        contactId: inquiry.contactId,
        inquiryId: inquiry.id,
        type: "inquiry.ai_analyzed",
        title: `AI определил: ${analysis.serviceCategory || "потребность"}`,
        description: analysis.taskObjective,
        actorType: "system",
        metadata: {
          known: analysis.knownFields.map((f) => f.key),
          missing: analysis.missingFields.map((f) => f.key),
        },
      });
    }

    if (analysisError) {
      await writeActivity(tx, {
        tenantId,
        contactId: inquiry.contactId,
        inquiryId: inquiry.id,
        type: "inquiry.ai_analysis_failed",
        title: "Заявка создана, но AI-анализ не выполнен",
        description: analysisError,
        actorType: "system",
      });
    }

    if (decision.createTask && analysis && !analysisError) {
      await writeActivity(tx, {
        tenantId,
        contactId: inquiry.contactId,
        inquiryId: inquiry.id,
        type: "inquiry.ai_task_ready",
        title:
          decision.autoStart || options.forceStart
            ? "Создана задача AI Manager"
            : "AI готов обработать заявку",
        description: analysis.taskTitle,
        actorType: "system",
      });
    }
  });

  const shouldStart = Boolean(
    analysis &&
      !analysisError &&
      (options.forceStart || decision.autoStart) &&
      decision.allowOutbound !== false &&
      (decision.createTask || options.forceStart),
  );

  if (shouldStart) {
    return startAiManagerForInquiry(prisma, tenantId, inquiryId);
  }

  return { inquiryId, decision, analysis, status };
}

export async function startAiManagerForInquiry(prisma: PrismaClient, tenantId: string, inquiryId: string) {
  const inquiry = await prisma.inquiry.findFirst({
    where: { id: inquiryId, tenantId },
    include: {
      contact: true,
      tasks: { where: { type: "process_inquiry", status: "open" }, take: 1 },
    },
  });
  if (!inquiry) return null;

  const fieldMeta = asMeta(inquiry.fieldMetaJson);
  const auto = readAutomation(fieldMeta);
  const analysis = (auto?.analysis || null) as RequestAnalysis | null;
  const task = inquiry.tasks[0];

  if (!analysis) {
    return processNewRequestAutomation(prisma, tenantId, inquiryId, {
      forceMode: "AUTO",
      forceStart: true,
    });
  }

  const conversation = await findWhatsAppConversation(prisma, tenantId, inquiry.contactId);
  if (!conversation?.sellerLeadId) {
    await prisma.$transaction(async (tx) => {
      if (task) {
        await tx.task.update({
          where: { id: task.id },
          data: {
            executionStatus: "needs_human",
            contextSnapshotJson: {
              ...(typeof task.contextSnapshotJson === "object" && task.contextSnapshotJson
                ? (task.contextSnapshotJson as object)
                : {}),
              executorType: "AI",
              executorId: "AI_MANAGER",
              aiStatus: "needs_human",
              handoffReason: "NO_AUTOMATED_CHANNEL",
            } as Prisma.InputJsonValue,
          },
        });
      }
      await tx.inquiry.update({
        where: { id: inquiry.id },
        data: {
          attentionReason: "NO_AUTOMATED_CHANNEL",
          nextStep: "Нет доступного канала связи для AI",
          fieldMetaJson: {
            ...fieldMeta,
            automation: {
              ...auto,
              status: "needs_human",
              handoffReason: "NO_AUTOMATED_CHANNEL",
            },
          } as Prisma.InputJsonValue,
        },
      });
      await writeActivity(tx, {
        tenantId,
        contactId: inquiry.contactId,
        inquiryId: inquiry.id,
        type: "inquiry.ai_needs_human",
        title: "AI требуется менеджер",
        description: "Нет доступного канала связи (WhatsApp lead не найден).",
        actorType: "system",
      });
    });
    return { inquiryId, status: "needs_human" as const, reason: "NO_AUTOMATED_CHANNEL" };
  }

  // If client already wrote last — do not send a second greeting; only set AI mode + instruction
  const lastMsg = conversation.messages[0];
  const skipGreetingNote = lastMsg && lastMsg.direction === "inbound";

  const contactName =
    inquiry.contact?.name ||
    [inquiry.contact?.firstName, inquiry.contact?.lastName].filter(Boolean).join(" ") ||
    "Клиент";
  const sourceLine = [inquiry.utmSource || inquiry.sourceType, inquiry.sourceChannel || inquiry.source]
    .filter(Boolean)
    .join(" → ");
  const instruction = buildInstruction({
    contactName,
    companyName: inquiry.companyName || inquiry.contact?.companyName || null,
    analysis,
    sourceLine: sourceLine || "заявка",
  });

  let appliedOnSeller = false;
  let sellerError: string | null = null;
  try {
    const { resolveSellerBridge } = await import("./sellerLink.ts");
    const resolved = await resolveSellerBridge(prisma, tenantId);
    if (!resolved.bridge) {
      sellerError = "WhatsApp не подключён";
    } else {
      await resolved.bridge.setMode(conversation.sellerLeadId, "AUTO");
      await resolved.bridge.addInstruction(conversation.sellerLeadId, instruction);
      appliedOnSeller = true;
    }
  } catch (err) {
    sellerError = err instanceof Error ? err.message : "Ошибка WhatsApp provider";
  }

  if (!appliedOnSeller) {
    await prisma.$transaction(async (tx) => {
      if (task) {
        await tx.task.update({
          where: { id: task.id },
          data: { executionStatus: "failed", resultText: sellerError },
        });
      }
      await tx.inquiry.update({
        where: { id: inquiry.id },
        data: {
          attentionReason: "AI_OUTBOUND_FAILED",
          fieldMetaJson: {
            ...fieldMeta,
            automation: {
              ...auto,
              status: "failed",
              handoffReason: sellerError,
            },
          } as Prisma.InputJsonValue,
        },
      });
      await writeActivity(tx, {
        tenantId,
        contactId: inquiry.contactId,
        inquiryId: inquiry.id,
        type: "inquiry.ai_outbound_failed",
        title: "Ошибка отправки первого сообщения AI",
        description: sellerError,
        actorType: "system",
      });
    });
    return { inquiryId, status: "failed" as const, reason: sellerError };
  }

  await prisma.$transaction(async (tx) => {
    await tx.conversation.update({
      where: { id: conversation.id },
      data: { mode: "ai" },
    });
    if (task) {
      await tx.task.update({
        where: { id: task.id },
        data: {
          executionStatus: "in_progress",
          conversationId: conversation.id,
          contextSnapshotJson: {
            executorType: "AI",
            executorId: "AI_MANAGER",
            knownFields: analysis.knownFields,
            missingFields: analysis.missingFields,
            expectedOutcome: analysis.expectedOutcome,
            aiStatus: "in_progress",
            skipGreeting: Boolean(skipGreetingNote),
          } as Prisma.InputJsonValue,
        },
      });
    }
    await tx.inquiry.update({
      where: { id: inquiry.id },
      data: {
        conversationId: conversation.id,
        status: inquiry.status === "new" || inquiry.status === "qualification" ? "qualification" : inquiry.status,
        nextStep: analysis.taskTitle,
        attentionReason: null,
        fieldMetaJson: {
          ...fieldMeta,
          automation: {
            ...auto,
            status: "in_progress",
            startedAt: new Date().toISOString(),
            taskId: task?.id || null,
          },
        } as Prisma.InputJsonValue,
      },
    });
    await writeActivity(tx, {
      tenantId,
      contactId: inquiry.contactId,
      inquiryId: inquiry.id,
      type: "inquiry.ai_started",
      title: "AI начал обработку",
      description: analysis.taskTitle,
      actorType: "system",
    });
  });

  return { inquiryId, status: "in_progress" as const, conversationId: conversation.id };
}

export async function handoffInquiryToHuman(
  prisma: PrismaClient,
  tenantId: string,
  inquiryId: string,
  opts: { userId?: string; membershipId?: string; reason?: string } = {},
) {
  const inquiry = await prisma.inquiry.findFirst({
    where: { id: inquiryId, tenantId },
    include: { tasks: { where: { type: "process_inquiry", status: "open" }, take: 1 } },
  });
  if (!inquiry) return null;
  const fieldMeta = asMeta(inquiry.fieldMetaJson);
  const auto = readAutomation(fieldMeta);

  if (inquiry.conversationId) {
    try {
      const { resolveSellerBridge } = await import("./sellerLink.ts");
      const conversation = await prisma.conversation.findFirst({
        where: { id: inquiry.conversationId, tenantId },
      });
      if (conversation?.sellerLeadId) {
        const resolved = await resolveSellerBridge(prisma, tenantId);
        if (resolved.bridge) await resolved.bridge.setMode(conversation.sellerLeadId, "HUMAN");
      }
      await prisma.conversation.update({
        where: { id: inquiry.conversationId },
        data: { mode: "human" },
      });
    } catch {
      /* keep local pause even if bridge fails */
    }
  }

  await prisma.$transaction(async (tx) => {
    if (inquiry.tasks[0]) {
      await tx.task.update({
        where: { id: inquiry.tasks[0].id },
        data: {
          executionStatus: "paused",
          ownerMembershipId: opts.membershipId || inquiry.assigneeMembershipId,
          contextSnapshotJson: {
            executorType: "USER",
            aiStatus: "paused",
            handoffReason: opts.reason || "HUMAN_TAKEOVER",
          } as Prisma.InputJsonValue,
        },
      });
    }
    await tx.inquiry.update({
      where: { id: inquiry.id },
      data: {
        assigneeMembershipId: opts.membershipId || inquiry.assigneeMembershipId,
        fieldMetaJson: {
          ...fieldMeta,
          automation: {
            ...auto,
            status: "paused",
            handoffReason: opts.reason || "HUMAN_TAKEOVER",
          },
        } as Prisma.InputJsonValue,
      },
    });
    await writeActivity(tx, {
      tenantId,
      contactId: inquiry.contactId,
      inquiryId: inquiry.id,
      type: "inquiry.ai_paused",
      title: "AI остановлен — заявку забрал менеджер",
      description: opts.reason || null,
      actorType: "user",
      actorId: opts.userId,
    });
  });

  return { ok: true };
}

export async function returnInquiryToAi(prisma: PrismaClient, tenantId: string, inquiryId: string) {
  return startAiManagerForInquiry(prisma, tenantId, inquiryId);
}

export async function getInquiryAutomationPreview(prisma: PrismaClient, tenantId: string, inquiryId: string) {
  const inquiry = await prisma.inquiry.findFirst({
    where: { id: inquiryId, tenantId },
    include: { contact: true },
  });
  if (!inquiry) return null;
  const fieldMeta = asMeta(inquiry.fieldMetaJson);
  let auto = readAutomation(fieldMeta);
  if (!auto?.analysis) {
    await processNewRequestAutomation(prisma, tenantId, inquiryId, { forceMode: "ASSIST" });
    const refreshed = await prisma.inquiry.findFirst({ where: { id: inquiryId, tenantId } });
    auto = readAutomation(asMeta(refreshed?.fieldMetaJson));
  }
  const analysis = auto?.analysis;
  const conversation = await findWhatsAppConversation(prisma, tenantId, inquiry.contactId);
  return {
    contactName:
      inquiry.contact?.name ||
      [inquiry.contact?.firstName, inquiry.contact?.lastName].filter(Boolean).join(" ") ||
      "Клиент",
    companyName: inquiry.companyName || inquiry.contact?.companyName || null,
    request: inquiry.subject || analysis?.detectedNeed || "Заявка",
    knownFields: analysis?.knownFields || [],
    missingFields: analysis?.missingFields || [],
    objective: analysis?.expectedOutcome || analysis?.taskObjective || null,
    channel: conversation?.sellerLeadId ? "WhatsApp" : "Нет автоматического канала",
    canStart: Boolean(conversation?.sellerLeadId),
    mode: auto?.mode || null,
    status: auto?.status || "none",
    statusLabel: AI_PROCESS_LABEL[(auto?.status as AiProcessStatus) || "none"],
  };
}
