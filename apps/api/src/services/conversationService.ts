import type { Prisma, PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import {
  INQUIRY_STATUS_LABEL,
  SOURCE_LABEL,
  digitsOnly,
  displayName,
  formatWhen,
  minutesAgo,
  needsReply,
  whoWroteLast,
  budgetLabel,
} from "./contactLabels.ts";
import {
  AGREEMENT_STATUS_LABEL,
  AGREEMENT_TYPE_LABEL,
  WAITING_FOR_LABEL,
  type AgreementStatus,
  type AgreementType,
  type WaitingFor,
} from "./conversationContextTypes.ts";

const ACTIVE_INQUIRY = ["new", "accepted", "qualification", "qualified", "in_progress", "waiting_client", "waiting_manager"];

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership;
}

function primaryPhone(methods: Array<{ type: string; rawValue: string; primary: boolean }>) {
  const phones = methods.filter((item) => item.type === "phone");
  return phones.find((item) => item.primary) || phones[0] || null;
}

function channelLabel(conversation: { sellerLeadId?: string | null; connectionId?: string | null }) {
  if (conversation.sellerLeadId) return "WhatsApp";
  return "Диалог";
}

function actorLabel(senderKind: string | null | undefined, direction?: string) {
  if (senderKind === "client" || direction === "inbound") return "Клиент";
  if (senderKind === "ai") return "AI";
  if (senderKind === "staff" || senderKind === "user") return "Менеджер";
  if (senderKind === "system") return "Система";
  return "Неизвестно";
}

function topicFromInquiry(inquiry: {
  subject?: string | null;
  service?: string | null;
  serviceCategory?: string | null;
} | null) {
  if (!inquiry) return null;
  return inquiry.subject || inquiry.service || inquiry.serviceCategory || null;
}

function acquisitionLabel(inquiry: {
  utmSource?: string | null;
  utmCampaign?: string | null;
  sourceChannel?: string | null;
  sourceType?: string | null;
  source?: string | null;
} | null) {
  if (!inquiry) return null;
  if (inquiry.utmSource) {
    const src = inquiry.utmSource.toLowerCase();
    if (src.includes("google")) return "Google Ads";
    if (src.includes("instagram") || src.includes("meta") || src.includes("fb")) return "Instagram Ads";
    if (src.includes("tiktok")) return "TikTok Ads";
    if (src.includes("organic")) return "Organic";
    if (src.includes("referral")) return "Referral";
    return inquiry.utmSource;
  }
  if (inquiry.utmCampaign) return inquiry.utmCampaign;
  if (inquiry.sourceChannel) return inquiry.sourceChannel;
  return null;
}

function sourceArrow(acquisition: string | null, channel: string) {
  if (acquisition) return `${acquisition} → ${channel}`;
  return channel;
}

function lastMessageAt(conversation: {
  updatedAt: Date;
  messages: Array<{ createdAt: Date }>;
}) {
  return conversation.messages[0]?.createdAt || conversation.updatedAt;
}

export async function listConversationsBoard(
  prisma: PrismaClient,
  auth: AuthContext,
  query: Record<string, string | undefined> = {},
) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const timeZone = membership.tenant.timezone || "Asia/Almaty";
  const now = new Date();
  const filter = String(query.filter || "all");
  const q = String(query.q || "").trim();
  const digits = digitsOnly(q);
  const phoneVariants = new Set<string>();
  if (digits) {
    phoneVariants.add(digits);
    if (digits.startsWith("8") && digits.length === 11) phoneVariants.add(`7${digits.slice(1)}`);
    if (digits.startsWith("7") && digits.length === 11) phoneVariants.add(`8${digits.slice(1)}`);
    if (digits.length === 10) {
      phoneVariants.add(`7${digits}`);
      phoneVariants.add(`8${digits}`);
    }
  }

  const where: Prisma.ConversationWhereInput = {
    tenantId: tid,
    status: filter === "archived" ? "archived" : { not: "archived" },
  };

  if (filter === "ai") where.mode = "ai";
  if (filter === "human") where.mode = "human";
  if (filter === "unread") where.needsAttention = true;

  if (q) {
    where.OR = [
      { sellerLeadId: { contains: q } },
      { attentionReason: { contains: q } },
      {
        contact: {
          OR: [
            { name: { contains: q } },
            { firstName: { contains: q } },
            { lastName: { contains: q } },
            { companyName: { contains: q } },
            {
              methods: {
                some: {
                  OR: [
                    { rawValue: { contains: q } },
                    ...[...phoneVariants].map((value) => ({ normalizedValue: { contains: value } })),
                  ],
                },
              },
            },
            { inquiries: { some: { OR: [{ subject: { contains: q } }, { service: { contains: q } }, { description: { contains: q } }] } } },
          ],
        },
      },
      { messages: { some: { text: { contains: q } } } },
    ];
  }

  const conversations = await prisma.conversation.findMany({
    where,
    include: {
      contact: {
        include: {
          methods: true,
          owner: { include: { user: true } },
          companyContacts: {
            where: { isActive: true },
            include: { company: { select: { id: true, name: true } } },
            take: 3,
            orderBy: { isPrimary: "desc" },
          },
          inquiries: {
            where: { archived: false },
            orderBy: { receivedAt: "desc" },
            take: 8,
          },
          deals: {
            where: { outcome: "open" },
            orderBy: { createdAt: "desc" },
            take: 3,
            include: { stage: true },
          },
          tasks: {
            where: { status: { in: ["open", "waiting"] }, parentTaskId: null },
            orderBy: { dueAt: "asc" },
            take: 5,
          },
        },
      },
      assignee: { include: { user: true } },
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
      inquiries: { where: { archived: false }, orderBy: { receivedAt: "desc" }, take: 3 },
      reads: {
        where: { membershipId: membership.id },
        take: 1,
      },
    },
    orderBy: { updatedAt: "desc" },
    take: 80,
  });

  const items = conversations
    .map((conversation) => {
      const contact = conversation.contact;
      const phone = contact ? primaryPhone(contact.methods) : null;
      const linkedInquiry =
        conversation.inquiries[0] ||
        contact?.inquiries.find((item) => item.conversationId === conversation.id) ||
        contact?.inquiries.find((item) => ACTIVE_INQUIRY.includes(item.status)) ||
        contact?.inquiries[0] ||
        null;
      const deal = contact?.deals[0] || null;
      const last = conversation.messages[0] || null;
      const lastAt = lastMessageAt(conversation);
      const waitingReply = contact
        ? needsReply(contact)
        : last?.direction === "inbound" || last?.senderKind === "client";
      const lastWho =
        (last && (last.senderKind === "client" || last.direction === "inbound"
          ? "client"
          : last.senderKind === "ai"
            ? "ai"
            : last.senderKind === "staff"
              ? "team"
              : whoWroteLast(contact || {}))) ||
        whoWroteLast(contact || {});
      const waitMinutes = waitingReply ? minutesAgo(contact?.lastInboundMessageAt || lastAt, now) : null;
      const channel = channelLabel(conversation);
      const acquisition = acquisitionLabel(linkedInquiry);
      const topic = topicFromInquiry(linkedInquiry) || (conversation.sellerLeadId ? null : null);
      const overdueTask = contact?.tasks.some(
        (task) => task.dueAt && task.dueAt.getTime() < now.getTime() && (task.status === "open" || task.status === "waiting"),
      );
      const nextTask = contact?.tasks[0] || null;
      const title =
        contact ? displayName(contact) : phone?.rawValue || (conversation.sellerLeadId ? "Неизвестный клиент" : "Неизвестный клиент");
      const unread =
        conversation.needsAttention ||
        (waitingReply && conversation.mode !== "ai") ||
        Boolean(conversation.reads[0] === undefined && last?.direction === "inbound");

      const businessStatus = deal?.stage?.name || (linkedInquiry ? INQUIRY_STATUS_LABEL[linkedInquiry.status] || linkedInquiry.status : null);
      const operationalFlags: string[] = [];
      if (waitingReply) operationalFlags.push("needs_reply");
      if (!waitingReply && lastWho === "team") operationalFlags.push("waiting_client");
      if (overdueTask) operationalFlags.push("overdue");
      if (!topic) operationalFlags.push("no_topic");
      if (conversation.mode === "human") operationalFlags.push("human");
      if (conversation.mode === "ai") operationalFlags.push("ai");

      const todayStart = new Date(now);
      todayStart.setHours(0, 0, 0, 0);
      const isToday = lastAt >= todayStart;

      return {
        id: conversation.id,
        title: title === "Без имени" ? phone?.rawValue || "Неизвестный клиент" : title,
        phone: phone?.rawValue || null,
        companyName: contact?.companyContacts?.[0]?.company?.name || contact?.companyName || null,
        companyId: contact?.companyContacts?.[0]?.company?.id || null,
        companyHref: contact?.companyContacts?.[0]?.company
          ? `/companies/${contact.companyContacts[0].company.id}`
          : null,
        topic: topic || "Тема не определена",
        service: linkedInquiry?.service || null,
        channel,
        acquisition,
        sourceLine: sourceArrow(acquisition, channel),
        lastMessagePreview: last?.text?.slice(0, 160) || "Нет сообщений",
        lastMessageAt: lastAt,
        lastMessageLabel: formatWhen(lastAt, timeZone),
        lastRelativeMinutes: minutesAgo(lastAt, now),
        lastWriter: lastWho === "client" ? "client" : lastWho === "ai" ? "ai" : lastWho === "team" ? "team" : "unknown",
        lastWriterLabel:
          lastWho === "client" ? "Клиент" : lastWho === "ai" ? "AI" : lastWho === "team" ? "Менеджер" : "Неизвестно",
        needsReply: Boolean(waitingReply),
        waitMinutes,
        waitLabel: waitingReply && waitMinutes != null ? `Ждёт ${waitMinutes} мин` : null,
        businessStatus,
        inquiryStatus: linkedInquiry?.status || null,
        inquiryStatusLabel: linkedInquiry ? INQUIRY_STATUS_LABEL[linkedInquiry.status] || linkedInquiry.status : null,
        dealTitle: deal?.title || null,
        dealStage: deal?.stage?.name || null,
        mode: conversation.mode,
        modeLabel: conversation.mode === "human" ? "Менеджер" : conversation.mode === "paused" ? "AI на паузе" : "AI",
        assigneeName: conversation.assignee?.user?.name || contact?.owner?.user?.name || null,
        attentionReason: conversation.attentionReason,
        unread: Boolean(unread),
        urgent: Boolean(overdueTask || (waitingReply && (waitMinutes || 0) >= 60) || conversation.mode === "human"),
        startedAt: conversation.createdAt,
        startedLabel: formatWhen(conversation.createdAt, timeZone),
        contactId: contact?.id || null,
        inquiryId: linkedInquiry?.id || null,
        dealId: deal?.id || null,
        nextAction: nextTask ? { title: nextTask.title, dueAt: nextTask.dueAt, dueLabel: formatWhen(nextTask.dueAt, timeZone) } : null,
        operationalFlags,
        isToday,
        sellerLeadId: conversation.sellerLeadId,
      };
    })
    .filter((item) => {
      if (filter === "needs_reply") return item.needsReply;
      if (filter === "waiting_client") return item.operationalFlags.includes("waiting_client");
      if (filter === "today") return item.isToday;
      if (filter === "overdue") return item.operationalFlags.includes("overdue");
      if (filter === "no_topic") return item.operationalFlags.includes("no_topic");
      if (filter === "unread") return item.unread;
      return true;
    });

  if (filter === "needs_reply" || query.sort === "needs_reply") {
    items.sort((a, b) => Number(b.needsReply) - Number(a.needsReply) || b.lastMessageAt.getTime() - a.lastMessageAt.getTime());
  } else if (query.sort === "unread") {
    items.sort((a, b) => Number(b.unread) - Number(a.unread) || b.lastMessageAt.getTime() - a.lastMessageAt.getTime());
  } else {
    items.sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime());
  }

  return {
    asOf: now.toISOString(),
    items,
    counts: {
      all: items.length,
      needsReply: items.filter((item) => item.needsReply).length,
      human: items.filter((item) => item.mode === "human").length,
      unread: items.filter((item) => item.unread).length,
    },
  };
}

export async function getConversationWorkspace(prisma: PrismaClient, auth: AuthContext, id: string) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const timeZone = membership.tenant.timezone || "Asia/Almaty";
  const now = new Date();

  const conversation = await prisma.conversation.findFirst({
    where: { id, tenantId: tid },
    include: {
      contact: {
        include: {
          methods: true,
          owner: { include: { user: true } },
          companyContacts: {
            where: { isActive: true },
            include: { company: { select: { id: true, name: true } } },
            take: 3,
            orderBy: { isPrimary: "desc" },
          },
          inquiries: { where: { archived: false }, orderBy: { receivedAt: "desc" }, take: 20 },
          deals: { orderBy: { createdAt: "desc" }, take: 10, include: { stage: true, assignee: { include: { user: true } } } },
          tasks: {
            where: { status: { in: ["open", "waiting"] }, parentTaskId: null },
            orderBy: { dueAt: "asc" },
            take: 10,
            include: { owner: { include: { user: true } } },
          },
          notes: { where: { pinned: true }, orderBy: { createdAt: "desc" }, take: 5 },
        },
      },
      assignee: { include: { user: true } },
      messages: { orderBy: { createdAt: "asc" }, take: 120 },
      inquiries: { where: { archived: false }, orderBy: { receivedAt: "desc" }, take: 10 },
    },
  });
  if (!conversation) throw new ApiError(404, "not_found", "Диалог не найден");

  const contact = conversation.contact;
  const phone = contact ? primaryPhone(contact.methods) : null;
  const linkedInquiry =
    conversation.inquiries.find((item) => ACTIVE_INQUIRY.includes(item.status)) ||
    conversation.inquiries[0] ||
    contact?.inquiries.find((item) => item.conversationId === conversation.id) ||
    contact?.inquiries.find((item) => ACTIVE_INQUIRY.includes(item.status)) ||
    contact?.inquiries[0] ||
    null;
  const deal = contact?.deals.find((item) => item.outcome === "open") || contact?.deals[0] || null;
  const last = conversation.messages[conversation.messages.length - 1] || null;
  const waitingReply = contact ? needsReply(contact) : last?.direction === "inbound";
  const lastWho = last
    ? last.senderKind === "client" || last.direction === "inbound"
      ? "client"
      : last.senderKind === "ai"
        ? "ai"
        : "team"
    : whoWroteLast(contact || {});
  const waitMinutes = waitingReply ? minutesAgo(contact?.lastInboundMessageAt || last?.createdAt, now) : null;
  const nextTask = contact?.tasks[0] || null;
  const overdueTask = contact?.tasks.find(
    (task) => task.dueAt && task.dueAt.getTime() < now.getTime() && (task.status === "open" || task.status === "waiting"),
  );
  const channel = channelLabel(conversation);
  const acquisition = acquisitionLabel(linkedInquiry);
  const topic = topicFromInquiry(linkedInquiry);

  const agreements = await prisma.agreement.findMany({
    where: {
      tenantId: tid,
      OR: [{ conversationId: conversation.id }, ...(contact?.id ? [{ contactId: contact.id }] : [])],
      status: { in: ["DETECTED", "NEEDS_CLARIFICATION", "CONFIRMED", "SCHEDULED", "RESCHEDULED"] },
    },
    include: { task: true },
    orderBy: [{ scheduledAt: "asc" }, { updatedAt: "desc" }],
    take: 10,
  });

  const title = contact
    ? displayName(contact) === "Без имени"
      ? phone?.rawValue || "Неизвестный клиент"
      : displayName(contact)
    : "Неизвестный клиент";

  const summary =
    conversation.contextSummary ||
    contact?.summary ||
    [
      topic ? `Интерес: ${topic}.` : null,
      linkedInquiry ? budgetLabel(linkedInquiry) ? `Бюджет: ${budgetLabel(linkedInquiry)}.` : "Бюджет пока не определён." : null,
      nextTask ? `Следующее действие — ${nextTask.title}.` : "Нет следующего действия.",
    ]
      .filter(Boolean)
      .join(" ") || "Краткое резюме пока не сформировано.";

  const extracted = {
    service: linkedInquiry?.service || null,
    budget: linkedInquiry ? budgetLabel(linkedInquiry) : null,
    deadline: linkedInquiry?.desiredDeadline || null,
    company: contact?.companyContacts?.[0]?.company?.name || contact?.companyName || null,
    city: contact?.city || null,
  };

  const waitingFor = (conversation.waitingFor || "NONE") as WaitingFor;

  return {
    asOf: now.toISOString(),
    conversation: {
      id: conversation.id,
      mode: conversation.mode,
      modeLabel: conversation.mode === "human" ? "Менеджер отвечает" : conversation.mode === "paused" ? "AI отключён" : "AI отвечает",
      status: conversation.status,
      channel,
      acquisition,
      sourceLine: sourceArrow(acquisition, channel),
      sellerLeadId: conversation.sellerLeadId,
      startedAt: conversation.createdAt,
      startedLabel: formatWhen(conversation.createdAt, timeZone),
      lastMessageAt: last?.createdAt || conversation.updatedAt,
      lastMessageLabel: formatWhen(last?.createdAt || conversation.updatedAt, timeZone),
      lastWriter: lastWho,
      lastWriterLabel: lastWho === "client" ? "Клиент" : lastWho === "ai" ? "AI" : "Менеджер",
      needsReply: Boolean(waitingReply) || waitingFor === "MANAGER",
      waitMinutes,
      waitLabel:
        waitingFor !== "NONE"
          ? WAITING_FOR_LABEL[waitingFor]
          : waitingReply && waitMinutes != null
            ? `Ждёт ответа: ${waitMinutes} мин`
            : null,
      waitingFor,
      waitingForLabel: WAITING_FOR_LABEL[waitingFor],
      attentionReason: conversation.attentionReason,
      assigneeName: conversation.assignee?.user?.name || contact?.owner?.user?.name || null,
      topic: topic || "Тема не определена",
      contextSummary: conversation.contextSummary,
    },
    client: contact
      ? {
          id: contact.id,
          name: title,
          phone: phone?.rawValue || null,
          companyName: contact.companyContacts?.[0]?.company?.name || contact.companyName,
          companyId: contact.companyContacts?.[0]?.company?.id || null,
          companyHref: contact.companyContacts?.[0]?.company
            ? `/companies/${contact.companyContacts[0].company.id}`
            : null,
          city: contact.city,
          firstContactAt: contact.firstSeenAt,
          firstContactLabel: formatWhen(contact.firstSeenAt, timeZone),
          lastContactAt: contact.lastContactAt || contact.lastSeenAt,
          lastContactLabel: formatWhen(contact.lastContactAt || contact.lastSeenAt, timeZone),
          summary,
        }
      : null,
    currentRequest: linkedInquiry
      ? {
          id: linkedInquiry.id,
          title: topicFromInquiry(linkedInquiry) || "Заявка",
          status: linkedInquiry.status,
          statusLabel: INQUIRY_STATUS_LABEL[linkedInquiry.status] || linkedInquiry.status,
          service: linkedInquiry.service,
          budgetLabel: budgetLabel(linkedInquiry),
          desiredDeadline: linkedInquiry.desiredDeadline,
          description: linkedInquiry.description,
          source: SOURCE_LABEL[linkedInquiry.sourceType || linkedInquiry.source || ""] || linkedInquiry.source,
        }
      : null,
    requests: (contact?.inquiries || conversation.inquiries).map((item) => ({
      id: item.id,
      title: topicFromInquiry(item) || "Заявка",
      status: item.status,
      statusLabel: INQUIRY_STATUS_LABEL[item.status] || item.status,
      active: ACTIVE_INQUIRY.includes(item.status),
    })),
    deal: deal
      ? {
          id: deal.id,
          title: deal.title,
          stage: deal.stage?.name || null,
          outcome: deal.outcome,
          amountMinor: deal.offerAmountMinor,
          currency: deal.currency,
          assigneeName: deal.assignee?.user?.name || null,
          nextAction: deal.nextAction || null,
          nextActionAt: deal.nextActionAt || null,
        }
      : null,
    agreements: agreements.map((a) => ({
      id: a.id,
      type: a.type,
      typeLabel: AGREEMENT_TYPE_LABEL[a.type as AgreementType] || a.type,
      status: a.status,
      statusLabel: AGREEMENT_STATUS_LABEL[a.status as AgreementStatus] || a.status,
      title: a.title,
      scheduledAt: a.scheduledAt,
      scheduledLabel: formatWhen(a.scheduledAt, timeZone),
      meetingProvider: a.meetingProvider,
      meetingUrl: a.meetingUrl,
      locationName: a.locationName,
      address: a.address,
      clarificationNeeded: a.clarificationNeeded,
      taskId: a.task?.id || null,
      confidenceUserLabel:
        a.status === "NEEDS_CLARIFICATION" ? "Нужно уточнить" : a.status === "CONFIRMED" || a.status === "SCHEDULED" ? "Подтверждено" : "Обнаружено",
    })),
    control: {
      nextAction: nextTask
        ? {
            id: nextTask.id,
            title: nextTask.title,
            dueLabel: formatWhen(nextTask.dueAt, timeZone),
            overdue: Boolean(nextTask.dueAt && nextTask.dueAt.getTime() < now.getTime()),
            ownerName: nextTask.owner?.user?.name || null,
          }
        : null,
      overdue: Boolean(overdueTask),
      overdueTitle: overdueTask?.title || null,
      needsReply: Boolean(waitingReply) || waitingFor === "MANAGER",
      waitLabel:
        waitingFor !== "NONE"
          ? WAITING_FOR_LABEL[waitingFor]
          : waitingReply && waitMinutes != null
            ? `Ждёт ответа: ${waitMinutes} мин`
            : waitingReply
              ? "Нужен ответ"
              : "Ждём клиента",
      situationLabel: waitingReply
        ? "Клиент написал последним"
        : conversation.mode === "human"
          ? "Менеджер ведёт диалог"
          : "Ждём ответ клиента",
    },
    extracted,
    attribution: {
      sourceType: linkedInquiry?.sourceType || linkedInquiry?.source || null,
      utmSource: linkedInquiry?.utmSource || null,
      utmCampaign: linkedInquiry?.utmCampaign || null,
      landingPage: linkedInquiry?.landingPage || null,
      sourceLine: sourceArrow(acquisition, channel),
    },
    pinnedNotes: contact?.notes?.map((item) => ({ id: item.id, text: item.text })) || [],
    messages: conversation.messages.map((message) => ({
      id: message.id,
      text: message.text,
      direction: message.direction,
      senderKind: message.senderKind,
      actorLabel: message.internal ? "Заметка" : actorLabel(message.senderKind, message.direction),
      internal: message.internal,
      createdAt: message.createdAt,
      createdLabel: formatWhen(message.createdAt, timeZone),
      operationState: message.operationState,
      receiptState: message.receiptState,
      deliveryLabel:
        message.direction === "outbound"
          ? message.receiptState === "read"
            ? "Прочитано"
            : message.receiptState === "delivered"
              ? "Доставлено"
              : message.operationState === "accepted"
                ? "Отправлено"
                : message.operationState === "failed"
                  ? "Ошибка"
                  : message.operationState
          : null,
    })),
  };
}
