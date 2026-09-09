import type { PrismaClient } from "@creolab/db";
import { crmModeToSeller } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { CALLS_ENABLED } from "../lib/featureFlags.ts";
import type { AuthContext } from "../lib/types.ts";
import { can } from "../lib/types.ts";
import { campaignTaskDedupeKey } from "./campaignPersonalize.ts";
import { INQUIRY_STATUS_LABEL, displayName, phoneFromContact } from "./contactLabels.ts";
import { resolveSellerBridge } from "./sellerLink.ts";
import { resolveContactLinks } from "./segmentService.ts";
import { getSituation } from "./situationService.ts";
import { getConversationWorkspace, listConversationsBoard } from "./conversationService.ts";
import { parseDateTimeInput } from "./periodRange.ts";

function tenantId(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership.tenantId;
}

export async function todayQueue(
  prisma: PrismaClient,
  auth: AuthContext,
  query: { scope?: string; includeSnoozed?: string | boolean } = {},
) {
  return getSituation(prisma, auth, query);
}

export async function listDeals(prisma: PrismaClient, auth: AuthContext) {
  return prisma.deal.findMany({
    where: { tenantId: tenantId(auth) },
    include: { contact: { include: { methods: true } }, stage: true, payments: true },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

export async function addPayment(
  prisma: PrismaClient,
  auth: AuthContext,
  dealId: string,
  input: { amountMinor: number; currency?: string; comment?: string },
) {
  if (!can(auth, "confirm_payments")) {
    throw new ApiError(403, "forbidden", "Нет права подтверждать оплату");
  }
  const tid = tenantId(auth);
  const deal = await prisma.deal.findFirst({ where: { id: dealId, tenantId: tid } });
  if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");
  if (!Number.isFinite(input.amountMinor) || input.amountMinor <= 0) {
    throw new ApiError(422, "invalid", "Сумма оплаты должна быть больше 0");
  }
  return prisma.$transaction(async (tx) => {
    const payment = await tx.paymentRecord.create({
      data: {
        tenantId: tid,
        dealId,
        amountMinor: input.amountMinor,
        currency: input.currency || deal.currency,
        confirmedByUserId: auth.user.id,
        comment: input.comment,
      },
    });
    const payments = await tx.paymentRecord.findMany({
      where: { tenantId: tid, dealId },
      select: { amountMinor: true },
    });
    const paid = payments.reduce((sum, row) => sum + Number(row.amountMinor || 0), 0);
    const dealAmount = deal.offerAmountMinor != null ? Number(deal.offerAmountMinor) : null;
    let paymentStatus = deal.paymentStatus;
    if (deal.paymentStatus !== "NOT_REQUIRED" && deal.paymentStatus !== "CANCELLED") {
      if (dealAmount != null && dealAmount > 0) {
        paymentStatus = paid >= dealAmount ? "PAID" : "PARTIALLY_PAID";
      } else if (paid > 0) {
        paymentStatus = "PAID";
      }
    }
    if (paymentStatus !== deal.paymentStatus) {
      await tx.deal.update({ where: { id: dealId }, data: { paymentStatus } });
    }
    await tx.auditEvent.create({
      data: {
        tenantId: tid,
        actorUserId: auth.user.id,
        action: "payment.confirm",
        entityType: "payment",
        entityId: payment.id,
        changesJson: { amountMinor: input.amountMinor, paymentStatus },
      },
    });
    return { ...payment, paymentStatus };
  });
}

function taskContextLabel(item: {
  targetType: string;
  contact?: { name?: string | null; firstName?: string | null; lastName?: string | null } | null;
  inquiry?: { subject?: string | null; phoneRaw?: string | null } | null;
  deal?: { title?: string | null } | null;
  conversation?: { contact?: { name?: string | null } | null } | null;
  childTasks?: Array<{ status: string }>;
  segmentSnapshotJson?: unknown;
}) {
  if (item.targetType === "group") {
    const snap = (item.segmentSnapshotJson || {}) as Record<string, unknown>;
    const label = typeof snap.label === "string" ? snap.label : "Группа клиентов";
    const total = item.childTasks?.length || 0;
    const done = item.childTasks?.filter((child) => child.status === "done").length || 0;
    return `${label} · ${done} / ${total}`;
  }
  if (item.contact) {
    const name = [item.contact.firstName, item.contact.lastName].filter(Boolean).join(" ").trim() || item.contact.name;
    return name || "Клиент";
  }
  if (item.inquiry) return item.inquiry.subject || item.inquiry.phoneRaw || "Заявка";
  if (item.deal) return item.deal.title || "Сделка";
  if (item.conversation?.contact?.name) return item.conversation.contact.name;
  return "Без привязки";
}

const TASK_STATUS_LABEL: Record<string, string> = {
  open: "Открыта",
  waiting: "В ожидании",
  done: "Сделано",
  canceled: "Отменена",
};

const TASK_RESULT_LABEL: Record<string, string> = {
  sent: "Отправлено",
  reached: "Дозвонились",
  no_answer: "Не ответил",
  callback_later: "Перезвонить",
  refused: "Отказ",
  agreed: "Договорились",
  waiting_reply: "Ждём ответа",
  needs_changes: "Нужны правки",
  needs_estimate: "Нужен расчёт",
  send_proposal: "Отправить КП",
  send_contract: "Отправить договор",
  client_thinking: "Клиент думает",
  reschedule: "Перенести",
  other: "Другое",
};

function taskDoneAt(item: { status: string; completedAt?: Date | null; sentAt?: Date | null; updatedAt: Date }) {
  if (item.status !== "done" && item.status !== "canceled") return null;
  return item.completedAt || item.sentAt || item.updatedAt;
}

function taskDoneSummary(item: {
  status: string;
  resultCode?: string | null;
  resultText?: string | null;
  executionStatus?: string | null;
  sentAt?: Date | null;
}) {
  if (item.status === "canceled") return "Отменена";
  const result = item.resultCode ? TASK_RESULT_LABEL[item.resultCode] || null : null;
  const sent = item.executionStatus === "sent" || Boolean(item.sentAt) || item.resultCode === "sent";
  if (sent && result && result !== "Отправлено") return `Отправлено · ${result}`;
  if (sent) return "Отправлено";
  if (result) return result;
  return "Сделано";
}

const TASK_TYPE_LABEL: Record<string, string> = {
  call: "Позвонить",
  message: "Написать",
  follow_up: "Напомнить",
  meeting: "Встреча",
  proposal: "Отправить КП",
  send_documents: "Отправить документы",
  prepare_estimate: "Подготовить расчёт",
  wait_client: "Ждать клиента",
  payment: "Проверить оплату",
  process_inquiry: "Обработать обращение",
  other: "Другое",
};

function contactDisplayName(contact?: {
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
} | null) {
  if (!contact) return null;
  return [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim() || contact.name || null;
}

function primaryPhoneFromMethods(
  methods?: Array<{ type: string; rawValue: string; normalizedValue: string; primary: boolean }> | null,
) {
  if (!methods?.length) return null;
  const phones = methods.filter((m) => m.type === "phone");
  const primary = phones.find((m) => m.primary) || phones[0];
  return primary?.rawValue || primary?.normalizedValue || null;
}

async function scheduledSendByTaskIds(prisma: PrismaClient, tenantId: string, taskIds: string[]) {
  if (!taskIds.length) return new Map<string, Date>();
  const rows = await prisma.scheduledAction.findMany({
    where: {
      tenantId,
      parentType: "task",
      parentId: { in: taskIds },
      state: { in: ["scheduled", "running"] },
      type: { in: ["task_run", "task_batch_run"] },
    },
    orderBy: { dueAt: "desc" },
  });
  const map = new Map<string, Date>();
  for (const row of rows) {
    if (!map.has(row.parentId)) map.set(row.parentId, row.dueAt);
  }
  return map;
}

export async function listTasks(prisma: PrismaClient, auth: AuthContext) {
  const tid = tenantId(auth);
  const now = new Date();
  const items = await prisma.task.findMany({
    where: { tenantId: tid, parentTaskId: null },
    include: {
      inquiry: { include: { contact: { include: { methods: true } } } },
      deal: { include: { stage: true, contact: { include: { methods: true } } } },
      contact: { include: { methods: true } },
      owner: { include: { user: true } },
      childTasks: {
        include: { contact: { include: { methods: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: [{ status: "asc" }, { dueAt: "asc" }],
    take: 100,
  });
  const conversationIds = [...new Set(items.map((item) => item.conversationId).filter(Boolean))] as string[];
  const conversations = conversationIds.length
    ? await prisma.conversation.findMany({
        where: { tenantId: tid, id: { in: conversationIds } },
        include: { contact: { include: { methods: true } } },
      })
    : [];
  const byId = new Map(conversations.map((item) => [item.id, item]));
  const taskIds = items.map((item) => item.id);
  const failedAttachments = taskIds.length
    ? await prisma.attachment.findMany({
        where: {
          tenantId: tid,
          parentType: "task",
          parentId: { in: taskIds },
          sendState: "failed",
        },
        select: { parentId: true, fileName: true, sendError: true },
      })
    : [];
  const failedByTask = new Map<string, Array<{ fileName: string; sendError: string | null }>>();
  for (const row of failedAttachments) {
    const list = failedByTask.get(row.parentId) || [];
    list.push({ fileName: row.fileName, sendError: row.sendError });
    failedByTask.set(row.parentId, list);
  }
  const scheduledSendAtByTask = await scheduledSendByTaskIds(prisma, tid, taskIds);

  const rows = items.map((item) => {
    const conversation = item.conversationId ? byId.get(item.conversationId) || null : null;
    const childTotal = item.childTasks.length;
    const childDone = item.childTasks.filter((child) => child.status === "done").length;
    const resolvedContact = item.contact || item.inquiry?.contact || item.deal?.contact || conversation?.contact || null;
    const contactName = contactDisplayName(resolvedContact);
    const phone =
      primaryPhoneFromMethods(resolvedContact?.methods) ||
      item.inquiry?.phoneRaw ||
      item.inquiry?.phoneNormalized ||
      null;
    const dueLater = Boolean(item.dueAt && item.dueAt.getTime() > now.getTime());
    const sendScheduled =
      dueLater &&
      (item.executionStatus === "scheduled" ||
        item.commandStatus === "scheduled" ||
        scheduledSendAtByTask.has(item.id));
    const overdue =
      Boolean(item.dueAt && item.dueAt < now && item.status !== "done" && item.status !== "canceled" && !sendScheduled);
    const failedFiles = failedByTask.get(item.id) || [];
    const needsFileRetry =
      failedFiles.length > 0 || item.executionStatus === "partial";
    const aboutParts: string[] = [];
    if (item.inquiry) {
      aboutParts.push(
        `Заявка: ${item.inquiry.subject || item.inquiry.service || item.inquiry.companyName || "без темы"}` +
          (item.inquiry.status ? ` (${INQUIRY_STATUS_LABEL[item.inquiry.status] || item.inquiry.status})` : ""),
      );
      if (item.inquiry.city) aboutParts.push(`Город: ${item.inquiry.city}`);
    }
    if (item.deal) {
      aboutParts.push(
        `Сделка: ${item.deal.title}` + (item.deal.stage?.name ? ` · ${item.deal.stage.name}` : ""),
      );
    }
    if (conversation && !item.inquiry && !item.deal) {
      aboutParts.push("Диалог WhatsApp");
    }
    if (item.targetType === "group") {
      aboutParts.push(`Группа · ${childDone} из ${childTotal}`);
    }
    if (!aboutParts.length && !contactName) aboutParts.push("Без привязки к клиенту");

    return {
      ...item,
      contact: resolvedContact || item.contact,
      conversation,
      contextLabel: taskContextLabel({ ...item, conversation }),
      statusLabel: TASK_STATUS_LABEL[item.status] || item.status,
      typeLabel: TASK_TYPE_LABEL[item.type] || item.type,
      assigneeName: item.owner?.user?.name || item.owner?.user?.email || null,
      whoName: contactName,
      whoPhone: phone,
      aboutLines: aboutParts,
      descriptionPreview: item.description ? String(item.description).slice(0, 180) : null,
      messagePreview: item.messageDraft ? String(item.messageDraft).slice(0, 180) : null,
      purpose: item.purpose || null,
      briefingText: item.briefingText || null,
      overdue,
      doneAt: taskDoneAt(item),
      resultLabel: item.resultCode ? TASK_RESULT_LABEL[item.resultCode] || null : null,
      doneSummary: item.status === "done" || item.status === "canceled" ? taskDoneSummary(item) : null,
      progress:
        item.targetType === "group"
          ? { done: childDone, total: childTotal, label: `${childDone} из ${childTotal}` }
          : null,
      children: item.childTasks.map((child) => ({
        id: child.id,
        title: child.title,
        status: child.status,
        statusLabel: TASK_STATUS_LABEL[child.status] || child.status,
        contactId: child.contactId,
        contactName: child.contact ? displayName(child.contact) : null,
        phone: phoneFromContact(child.contact),
        dueAt: child.dueAt,
        executionStatus: child.executionStatus,
      })),
      isSendable: ["proposal", "message", "send_documents", "prepare_estimate", "follow_up", "process_inquiry"].includes(item.type),
      needsFileRetry,
      failedFiles,
      executionStatus: item.executionStatus,
      scheduledSendAt: scheduledSendAtByTask.get(item.id) || null,
      sendScheduled,
      campaignId:
        (typeof item.parsedCommandJson === "object" && item.parsedCommandJson
          ? (item.parsedCommandJson as { campaignId?: string }).campaignId
          : null) ||
        (typeof item.segmentSnapshotJson === "object" && item.segmentSnapshotJson
          ? (item.segmentSnapshotJson as { campaignId?: string }).campaignId
          : null) ||
        null,
    };
  });

  const knownCampaignIds = new Set(rows.map((row) => row.campaignId).filter(Boolean));
  const queuedCampaignIds = (
    await prisma.scheduledAction.findMany({
      where: { tenantId: tid, parentType: "campaign", type: "campaign_run", state: { in: ["scheduled", "running"] } },
      select: { parentId: true },
      take: 40,
    })
  ).map((row) => row.parentId);
  const scheduledCampaigns = await prisma.campaign.findMany({
    where: {
      tenantId: tid,
      OR: [
        { status: "scheduled" },
        ...(queuedCampaignIds.length ? [{ id: { in: queuedCampaignIds } }] : []),
      ],
    },
    include: { recipients: { where: { status: { in: ["pending", "queued"] } }, take: 50, orderBy: { createdAt: "asc" } } },
    take: 40,
  });
  for (const campaign of scheduledCampaigns) {
    if (knownCampaignIds.has(campaign.id)) continue;
    if (items.some((item) => item.dedupeKey === campaignTaskDedupeKey(campaign.id))) continue;
    const pending = campaign.recipients;
    const campaignDueLater = Boolean(campaign.scheduledAt && campaign.scheduledAt.getTime() > Date.now());
    rows.push({
      id: campaignTaskDedupeKey(campaign.id),
      tenantId: campaign.tenantId,
      type: "message",
      title: campaign.title,
      description: `Массовая рассылка WhatsApp · ${pending.length} получателям`,
      contactId: null,
      inquiryId: null,
      conversationId: null,
      dealId: null,
      companyId: null,
      incompleteIntakeId: null,
      agreementId: null,
      ownerMembershipId: campaign.createdByMembershipId,
      dueAt: campaign.scheduledAt,
      priority: "normal",
      source: campaign.source,
      status: "open",
      dedupeKey: campaignTaskDedupeKey(campaign.id),
      targetType: "group",
      parentTaskId: null,
      segmentSnapshotJson: { label: "Массовая рассылка", campaignId: campaign.id },
      contextSnapshotJson: {},
      sourceMessageIdsJson: [],
      purpose: null,
      briefingText: null,
      preparationHintsJson: [],
      executionStatus: "scheduled",
      messageDraft: campaign.messageDraft,
      resultCode: null,
      resultText: null,
      completionSource: null,
      confirmedAt: campaign.confirmedAt,
      sentAt: null,
      rawCommandText: campaign.rawCommandText,
      parsedCommandJson: { campaignId: campaign.id, sendViaCampaign: true },
      commandStatus: "scheduled",
      recurrenceRule: null,
      completionResult: null,
      createdAt: campaign.createdAt,
      completedAt: null,
      inquiry: null,
      deal: null,
      contact: null,
      owner: null,
      conversation: null,
      contextLabel: "Массовая рассылка",
      statusLabel: "Открыта",
      typeLabel: "Массовая отправка",
      assigneeName: null,
      whoName: null,
      whoPhone: null,
      aboutLines: [`Рассылка · ${pending.length} получателям`],
      descriptionPreview: campaign.messageDraft ? String(campaign.messageDraft).slice(0, 180) : null,
      messagePreview: campaign.messageDraft ? String(campaign.messageDraft).slice(0, 180) : null,
      overdue: Boolean(campaign.scheduledAt && !campaignDueLater),
      doneAt: null,
      resultLabel: null,
      doneSummary: null,
      progress: { done: 0, total: pending.length, label: `0 из ${pending.length}` },
      children: pending.map((row) => ({
        id: row.id,
        title: row.displayName || row.phoneRaw || "Контакт",
        status: "open",
        statusLabel: "Открыта",
        contactId: row.contactId,
        contactName: row.displayName,
        phone: row.phoneRaw,
        dueAt: campaign.scheduledAt,
        executionStatus: "scheduled",
      })),
      isSendable: false,
      needsFileRetry: false,
      failedFiles: [],
      scheduledSendAt: campaign.scheduledAt,
      sendScheduled: campaignDueLater,
      campaignId: campaign.id,
    } as (typeof rows)[number]);
  }

  return rows;
}

export async function getTask(prisma: PrismaClient, auth: AuthContext, id: string) {
  const tid = tenantId(auth);
  const item = await prisma.task.findFirst({
    where: { id, tenantId: tid },
    include: {
      inquiry: true,
      deal: { include: { stage: true } },
      contact: { include: { methods: true } },
      owner: { include: { user: true } },
      agreement: true,
      childTasks: { include: { contact: true }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!item) throw new ApiError(404, "not_found", "Задача не найдена");
  const attachments = await prisma.attachment.findMany({
    where: { tenantId: tid, parentType: "task", parentId: id },
    orderBy: { createdAt: "asc" },
  });

  const sourceIds = Array.isArray(item.sourceMessageIdsJson)
    ? (item.sourceMessageIdsJson as string[])
    : [];
  let sourceMessages: Array<{
    id: string;
    text: string | null;
    senderKind: string;
    direction: string;
    createdAt: Date;
  }> = [];
  if (sourceIds.length) {
    sourceMessages = await prisma.message.findMany({
      where: { tenantId: tid, id: { in: sourceIds } },
      orderBy: { createdAt: "asc" },
    });
  } else if (item.conversationId) {
    sourceMessages = await prisma.message.findMany({
      where: { tenantId: tid, conversationId: item.conversationId },
      orderBy: { createdAt: "desc" },
      take: 8,
    });
    sourceMessages.reverse();
  }

  const phone =
    item.contact?.methods?.find((m) => m.type === "phone" && m.primary) ||
    item.contact?.methods?.find((m) => m.type === "phone") ||
    null;
  const scheduledSendAt = (await scheduledSendByTaskIds(prisma, tid, [id])).get(id) || null;

  return {
    ...item,
    scheduledSendAt,
    sendScheduled:
      Boolean(item.dueAt && item.dueAt.getTime() > new Date().getTime()) &&
      (item.executionStatus === "scheduled" || item.commandStatus === "scheduled" || Boolean(scheduledSendAt)),
    attachments,
    isSendable: ["proposal", "message", "send_documents", "prepare_estimate", "follow_up", "process_inquiry"].includes(item.type),
    briefing: {
      purpose: item.purpose,
      briefingText: item.briefingText,
      preparationHints: Array.isArray(item.preparationHintsJson) ? item.preparationHintsJson : [],
      facts: (item.contextSnapshotJson as { facts?: Record<string, unknown> } | null)?.facts || {},
      client: item.contact
        ? {
            id: item.contact.id,
            name:
              [item.contact.firstName, item.contact.lastName].filter(Boolean).join(" ").trim() ||
              item.contact.name ||
              "Клиент",
            phone: phone?.rawValue || null,
            companyName: item.contact.companyName,
          }
        : null,
      inquiry: item.inquiry
        ? {
            id: item.inquiry.id,
            title: item.inquiry.subject || item.inquiry.service || "Заявка",
            status: item.inquiry.status,
          }
        : null,
      deal: item.deal
        ? {
            id: item.deal.id,
            title: item.deal.title,
            stage: item.deal.stage?.name || null,
            amountMinor: item.deal.offerAmountMinor,
            currency: item.deal.currency,
          }
        : null,
      agreement: item.agreement
        ? {
            id: item.agreement.id,
            type: item.agreement.type,
            status: item.agreement.status,
            scheduledAt: item.agreement.scheduledAt,
            meetingUrl: item.agreement.meetingUrl,
            meetingProvider: item.agreement.meetingProvider,
            locationName: item.agreement.locationName,
            address: item.agreement.address,
            clarificationNeeded: item.agreement.clarificationNeeded,
          }
        : null,
      sourceMessages: sourceMessages.map((m) => ({
        id: m.id,
        text: m.text,
        actorLabel:
          m.senderKind === "client" || m.direction === "inbound"
            ? "Клиент"
            : m.senderKind === "ai"
              ? "AI Manager"
              : "Менеджер",
        createdAt: m.createdAt,
      })),
      conversationId: item.conversationId,
      basisLabel:
        item.source === "context_engine"
          ? "Создано автоматически из договорённости в WhatsApp"
          : item.source === "ai_command"
            ? "Создано из команды"
            : null,
    },
  };
}

export async function createTask(
  prisma: PrismaClient,
  auth: AuthContext,
  input: {
    type: string;
    title: string;
    description?: string;
    inquiryId?: string;
    conversationId?: string;
    contactId?: string;
    dealId?: string;
    dueAt?: string;
    priority?: string;
    ownerMembershipId?: string;
    targetType?: "client" | "group" | "none";
    clientIds?: string[];
    segmentSnapshot?: Record<string, unknown>;
  },
) {
  if (!CALLS_ENABLED && input.type === "call") {
    throw new ApiError(422, "calls_disabled", "Звонки временно отключены. Создайте задачу «Написать».");
  }
  const tid = tenantId(auth);
  const targetType = input.targetType || (input.contactId || input.clientIds?.length ? "client" : "none");
  const ownerMembershipId = input.ownerMembershipId || auth.activeMembership?.id;
  if (ownerMembershipId) {
    const owner = await prisma.membership.findFirst({ where: { id: ownerMembershipId, tenantId: tid, active: true } });
    if (!owner) throw new ApiError(422, "invalid", "Ответственный не найден");
  }
  let dueAt: Date | null = null;
  if (input.dueAt) {
    dueAt = parseDateTimeInput(input.dueAt, auth.activeMembership?.tenant?.timezone || "Asia/Almaty");
    if (Number.isNaN(dueAt.getTime())) {
      throw new ApiError(422, "invalid", "Некорректная дата срока");
    }
  }

  if (targetType === "group") {
    const clientIds = [...new Set(input.clientIds || [])];
    if (!clientIds.length) throw new ApiError(422, "invalid", "Выберите хотя бы одного клиента");
    if (clientIds.length > 200) throw new ApiError(422, "invalid", "Слишком много клиентов для одной задачи");

    return prisma.$transaction(async (tx) => {
      const parent = await tx.task.create({
        data: {
          tenantId: tid,
          type: input.type,
          title: input.title,
          description: input.description,
          dueAt,
          priority: input.priority || "normal",
          ownerMembershipId,
          source: "manual",
          targetType: "group",
          segmentSnapshotJson: (input.segmentSnapshot || {}) as object,
        },
      });

      for (const contactId of clientIds) {
        const links = await resolveContactLinks(tx, tid, contactId);
        await tx.task.create({
          data: {
            tenantId: tid,
            type: input.type,
            title: input.title,
            description: input.description,
            contactId,
            inquiryId: links.inquiryId,
            conversationId: links.conversationId,
            dealId: links.dealId,
            dueAt,
            priority: input.priority || "normal",
            ownerMembershipId,
            source: "manual",
            targetType: "client",
            parentTaskId: parent.id,
          },
        });
      }

      return tx.task.findFirstOrThrow({
        where: { id: parent.id },
        include: { childTasks: { include: { contact: true } } },
      });
    });
  }

  let contactId = input.contactId;
  let inquiryId = input.inquiryId;
  let conversationId = input.conversationId;
  let dealId = input.dealId;

  if (targetType === "client") {
    if (!contactId && input.clientIds?.[0]) contactId = input.clientIds[0];
    if (!contactId) throw new ApiError(422, "invalid", "Выберите клиента");
    const links = await resolveContactLinks(prisma, tid, contactId, { inquiryId, dealId, conversationId });
    contactId = links.contact.id;
    inquiryId = inquiryId || links.inquiryId;
    conversationId = conversationId || links.conversationId;
    dealId = dealId || links.dealId;
  } else {
    if (conversationId) {
      const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId: tid } });
      if (!conversation) throw new ApiError(422, "invalid", "Диалог не найден");
      contactId = contactId || conversation.contactId;
    }
    if (inquiryId) {
      const inquiry = await prisma.inquiry.findFirst({ where: { id: inquiryId, tenantId: tid } });
      if (!inquiry) throw new ApiError(422, "invalid", "Заявка не найдена");
      contactId = contactId || inquiry.contactId;
    }
  }

  return prisma.task.create({
    data: {
      tenantId: tid,
      type: input.type,
      title: input.title,
      description: input.description,
      inquiryId,
      conversationId,
      contactId,
      dealId,
      dueAt,
      priority: input.priority || "normal",
      ownerMembershipId,
      source: "manual",
      targetType: targetType === "client" ? "client" : "none",
      segmentSnapshotJson: (input.segmentSnapshot || {}) as object,
      dedupeKey: input.type === "process_inquiry" && inquiryId ? `inquiry-process:${inquiryId}` : null,
    },
    include: { contact: true, inquiry: true, deal: true },
  });
}

async function taskInTenant(prisma: PrismaClient, auth: AuthContext, id: string) {
  const tid = tenantId(auth);
  const task = await prisma.task.findFirst({ where: { id, tenantId: tid } });
  if (!task) throw new ApiError(404, "not_found", "Задача не найдена");
  return { tid, task };
}

export async function completeTask(prisma: PrismaClient, auth: AuthContext, id: string) {
  const { tid, task } = await taskInTenant(prisma, auth, id);
  if (task.type === "process_inquiry" && task.inquiryId) {
    const inquiry = await prisma.inquiry.findFirst({ where: { id: task.inquiryId, tenantId: tid } });
    if (inquiry?.status === "new") {
      throw new ApiError(422, "inquiry_open", "Сначала примите или отклоните заявку, затем закройте задачу");
    }
  }
  if (task.status === "canceled") throw new ApiError(409, "invalid_state", "Отменённую задачу нельзя закрыть");
  await prisma.scheduledAction.updateMany({
    where: { tenantId: tid, parentType: "task", parentId: id, state: "scheduled" },
    data: { state: "canceled", cancelReason: "task_done" },
  });
  const completedAt = new Date();
  if (task.targetType === "group" && !task.parentTaskId) {
    await prisma.task.updateMany({
      where: { tenantId: tid, parentTaskId: id, status: { in: ["open", "waiting"] } },
      data: { status: "done", completedAt },
    });
  }
  const updated = await prisma.task.update({
    where: { id },
    data: { status: "done", completedAt },
  });
  if (task.parentTaskId) {
    const openChildren = await prisma.task.count({
      where: { tenantId: tid, parentTaskId: task.parentTaskId, status: { in: ["open", "waiting"] } },
    });
    if (openChildren === 0) {
      await prisma.task.updateMany({
        where: { id: task.parentTaskId, tenantId: tid, status: { in: ["open", "waiting"] } },
        data: { status: "done", completedAt },
      });
    }
  }
  return updated;
}

export async function waitTask(prisma: PrismaClient, auth: AuthContext, id: string) {
  const { task } = await taskInTenant(prisma, auth, id);
  if (task.status !== "open") throw new ApiError(409, "invalid_state", "В ожидание можно перевести только открытую задачу");
  return prisma.task.update({ where: { id }, data: { status: "waiting" } });
}

export async function reopenTask(prisma: PrismaClient, auth: AuthContext, id: string) {
  const { task } = await taskInTenant(prisma, auth, id);
  if (task.status !== "waiting") throw new ApiError(409, "invalid_state", "Вернуть можно только задачу в ожидании");
  return prisma.task.update({ where: { id }, data: { status: "open", completedAt: null } });
}

export async function cancelTask(prisma: PrismaClient, auth: AuthContext, id: string) {
  const { tid, task } = await taskInTenant(prisma, auth, id);
  if (task.status === "done") throw new ApiError(409, "invalid_state", "Сделанную задачу нельзя отменить");
  await prisma.scheduledAction.updateMany({
    where: { tenantId: tid, parentType: "task", parentId: id, state: "scheduled" },
    data: { state: "canceled", cancelReason: "task_canceled" },
  });
  return prisma.task.update({ where: { id }, data: { status: "canceled", completedAt: new Date() } });
}

export async function assignTask(prisma: PrismaClient, auth: AuthContext, id: string, membershipId?: string) {
  const { tid } = await taskInTenant(prisma, auth, id);
  const ownerId = membershipId || auth.activeMembership?.id;
  if (!ownerId) throw new ApiError(422, "invalid", "Нет сотрудника для назначения");
  const owner = await prisma.membership.findFirst({ where: { id: ownerId, tenantId: tid, active: true } });
  if (!owner) throw new ApiError(422, "invalid", "Сотрудник не найден");
  return prisma.task.update({ where: { id }, data: { ownerMembershipId: owner.id } });
}

export async function listConversations(prisma: PrismaClient, auth: AuthContext) {
  const board = await listConversationsBoard(prisma, auth, {});
  return board.items;
}

export async function getConversation(prisma: PrismaClient, auth: AuthContext, id: string) {
  return getConversationWorkspace(prisma, auth, id);
}

export async function setConversationMode(
  prisma: PrismaClient,
  auth: AuthContext,
  id: string,
  mode: "ai" | "human" | "paused",
) {
  const tid = tenantId(auth);
  return prisma.$transaction(async (tx) => {
    const current = await tx.conversation.findFirst({
      where: { id, tenantId: tid },
      include: { assignee: { include: { user: true } } },
    });
    if (!current) throw new ApiError(404, "not_found", "Диалог не найден");

    if (
      mode === "human" &&
      current.mode === "human" &&
      current.assigneeMembershipId &&
      current.assigneeMembershipId !== auth.activeMembership?.id
    ) {
      const holder = current.assignee?.user?.name || "другой сотрудник";
      throw new ApiError(409, "already_taken", `Уже забрал ${holder}`);
    }

    const sameOwnerTake =
      mode === "human" && current.mode === "human" && current.assigneeMembershipId === auth.activeMembership?.id;
    const alreadySameMode = current.mode === mode && (mode !== "human" || sameOwnerTake);
    if (alreadySameMode || sameOwnerTake) {
      return { ...current, appliedOnSeller: true as const, sellerError: null as string | null };
    }

    const modeChanged = current.mode !== mode;
    const updated = await tx.conversation.update({
      where: { id },
      data: {
        mode,
        controlVersion: modeChanged ? { increment: 1 } : undefined,
        assigneeMembershipId: mode === "human" ? auth.activeMembership?.id : current.assigneeMembershipId,
        needsAttention: mode !== "ai",
        attentionReason: mode === "human" ? "taken_by_human" : mode === "paused" ? "paused" : null,
      },
    });
    if (mode === "human" && auth.activeMembership) {
      await tx.notification.upsert({
        where: {
          tenantId_episodeKey_recipientMembershipId: {
            tenantId: tid,
            episodeKey: `conversation.needs_human:${id}`,
            recipientMembershipId: auth.activeMembership.id,
          },
        },
        update: { title: "Диалог у менеджера", body: "Нужен ответ человеку" },
        create: {
          tenantId: tid,
          episodeKey: `conversation.needs_human:${id}`,
          recipientMembershipId: auth.activeMembership.id,
          type: "conversation.needs_human",
          priority: "high",
          entityType: "conversation",
          entityId: id,
          title: "Диалог у менеджера",
          body: "Нужен ответ человеку",
        },
      });
    }
    await tx.outboundOperation.updateMany({
      where: { tenantId: tid, conversationId: id, state: { in: ["queued", "generating"] } },
      data: { state: "canceled", error: "taken_by_human" },
    });
    let appliedOnSeller = false;
    let sellerError: string | null = null;
    if (current.sellerLeadId) {
      const resolved = await resolveSellerBridge(tx as unknown as PrismaClient, tid);
      try {
        if (resolved.bridge) {
          await resolved.bridge.setMode(current.sellerLeadId, crmModeToSeller(mode));
          appliedOnSeller = true;
        } else {
          sellerError = "На боте не применилось: WhatsApp не подключён";
        }
      } catch (error) {
        sellerError = `На боте не применилось: ${error instanceof Error ? error.message : "мост недоступен"}`;
        await tx.auditEvent.create({
          data: {
            tenantId: tid,
            actorUserId: auth.user.id,
            action: "seller.mode_sync_failed",
            entityType: "conversation",
            entityId: id,
            changesJson: { error: error instanceof Error ? error.message : "sync_failed" },
          },
        });
      }
    }
    await tx.auditEvent.create({
      data: {
        tenantId: tid,
        actorUserId: auth.user.id,
        action: `conversation.${mode === "human" ? "take" : mode === "paused" ? "pause" : "return_to_ai"}`,
        entityType: "conversation",
        entityId: id,
        changesJson: { mode, controlVersion: updated.controlVersion, appliedOnSeller },
      },
    });
    return { ...updated, appliedOnSeller, sellerError };
  });
}

export async function addConversationMessage(
  prisma: PrismaClient,
  auth: AuthContext,
  id: string,
  input: { text: string; internal?: boolean; idempotencyKey?: string },
) {
  const tid = tenantId(auth);
  const conversation = await prisma.conversation.findFirst({ where: { id, tenantId: tid } });
  if (!conversation) throw new ApiError(404, "not_found", "Диалог не найден");
  if (input.internal) {
    return prisma.message.create({
      data: {
        tenantId: tid,
        conversationId: id,
        senderKind: "staff",
        senderUserId: auth.user.id,
        direction: "internal",
        text: input.text,
        internal: true,
      },
    });
  }
  if (conversation.mode !== "human") {
    throw new ApiError(409, "mode_locked", "Сначала возьмите диалог, затем отвечайте");
  }
  const key = input.idempotencyKey || `msg:${id}:${input.text}:${auth.user.id}`;
  const existing = await prisma.outboundOperation.findFirst({
    where: { tenantId: tid, idempotencyKey: key },
  });
  if (existing) {
    return prisma.message.findFirst({
      where: { tenantId: tid, conversationId: id, text: input.text },
      orderBy: { createdAt: "desc" },
    });
  }
  const message = await prisma.message.create({
    data: {
      tenantId: tid,
      conversationId: id,
      senderKind: "staff",
      senderUserId: auth.user.id,
      direction: "outbound",
      text: input.text,
      operationState: conversation.sellerLeadId ? "queued" : "stored",
    },
  });
  await prisma.outboundOperation.create({
    data: {
      tenantId: tid,
      conversationId: id,
      idempotencyKey: key,
      controlVersion: conversation.controlVersion,
      state: conversation.sellerLeadId ? "queued" : "stored",
    },
  });
  const resolved = conversation.sellerLeadId ? await resolveSellerBridge(prisma, tid) : { bridge: null };
  if (conversation.sellerLeadId && resolved.bridge) {
    const bridge = resolved.bridge;
    try {
      await bridge.sendText(conversation.sellerLeadId, input.text, key);
      await prisma.message.update({
        where: { id: message.id },
        data: { operationState: "accepted" },
      });
    } catch (error) {
      await prisma.message.update({
        where: { id: message.id },
        data: { operationState: "unknown", receiptState: "unknown" },
      });
      throw new ApiError(503, "sender_unknown", error instanceof Error ? error.message : "Неизвестный результат отправки");
    }
  }
  return message;
}

export async function listNotifications(prisma: PrismaClient, auth: AuthContext) {
  if (!auth.activeMembership) return [];
  const items = await prisma.notification.findMany({
    where: { tenantId: tenantId(auth), recipientMembershipId: auth.activeMembership.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return items.map((item) => ({
    ...item,
    href: notificationHref(item.type, item.entityType, item.entityId),
  }));
}

function notificationHref(type: string, entityType: string, entityId: string) {
  if (type === "inquiry.created" || entityType === "inquiry") return "/inquiries";
  if (type === "needs_phone" || entityType === "incomplete_intake") return "/today";
  if (type.startsWith("conversation.") || entityType === "conversation") return `/conversations/${entityId}`;
  if (entityType === "task") return "/tasks";
  if (entityType === "contact") return `/contacts/${entityId}`;
  return "/today";
}

export async function markNotificationRead(prisma: PrismaClient, auth: AuthContext, id: string) {
  const row = await prisma.notification.findFirst({
    where: { id, tenantId: tenantId(auth), recipientMembershipId: auth.activeMembership?.id },
  });
  if (!row) throw new ApiError(404, "not_found", "Уведомление не найдено");
  return prisma.notification.update({ where: { id }, data: { readAt: new Date() } });
}

export async function statsSummary(prisma: PrismaClient, auth: AuthContext) {
  const tid = tenantId(auth);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const [inquiries, won, lost, intakes, payments] = await Promise.all([
    prisma.inquiry.count({ where: { tenantId: tid, receivedAt: { gte: start }, test: false } }),
    prisma.deal.count({ where: { tenantId: tid, outcome: "won", closedAt: { gte: start } } }),
    prisma.deal.count({ where: { tenantId: tid, outcome: "lost", closedAt: { gte: start } } }),
    prisma.incompleteIntake.count({ where: { tenantId: tid, status: "pending" } }),
    prisma.paymentRecord.findMany({ where: { tenantId: tid, confirmedAt: { gte: start }, status: "confirmed" } }),
  ]);
  const closed = won + lost;
  return {
    inquiriesToday: inquiries,
    needsPhone: intakes,
    won,
    lost,
    conversionClosed: closed === 0 ? null : won / closed,
    conversionLabel: closed === 0 ? "Нет закрытых сделок" : "Конверсия закрытых сделок",
    paymentsByCurrency: payments.reduce<Record<string, string>>((acc, item) => {
      acc[item.currency] = String(BigInt(acc[item.currency] || "0") + BigInt(item.amountMinor.toString()));
      return acc;
    }, {}),
  };
}

export async function listIntegrations(prisma: PrismaClient, auth: AuthContext) {
  if (!can(auth, "manage_integrations") && auth.activeMembership?.role !== "owner") {
    return prisma.integration.findMany({
      where: { tenantId: tenantId(auth) },
      select: { id: true, name: true, type: true, status: true, lastEventAt: true, lastError: true },
    });
  }
  return prisma.integration.findMany({
    where: { tenantId: tenantId(auth) },
    include: { forms: true, channelConnections: true },
  });
}

export async function knowledgeCurrent(prisma: PrismaClient, auth: AuthContext) {
  return prisma.knowledgeVersion.findFirst({
    where: { tenantId: tenantId(auth) },
    orderBy: { version: "desc" },
  });
}

export async function aiSandbox(prisma: PrismaClient, auth: AuthContext, message: string) {
  const tid = tenantId(auth);
  const execution = await prisma.aIExecution.create({
    data: {
      tenantId: tid,
      sourceType: "sandbox",
      sourceId: auth.user.id,
      status: "completed",
      sandbox: true,
      model: process.env.ANYMODEL_MODEL || process.env.OPENAI_MODEL || "not-configured",
    },
  });
  return {
    sandbox: true,
    executionId: execution.id,
    reply_text: `Песочница CRM. Сообщение не отправлено в WhatsApp. Вход: ${message.slice(0, 180)}`,
    note: "Текущий продавец остаётся в процессе бота. Провайдер не менялся.",
  };
}

export async function platformTenants(prisma: PrismaClient, auth: AuthContext) {
  if (!auth.user.platformAdmin) throw new ApiError(403, "forbidden", "Только администратор платформы");
  return prisma.tenant.findMany({
    include: {
      _count: { select: { memberships: true, integrations: true, inquiries: true } },
      plans: { include: { plan: true } },
    },
  });
}
