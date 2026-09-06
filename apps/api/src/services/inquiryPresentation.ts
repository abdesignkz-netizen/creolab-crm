import {
  INQUIRY_STATUS_LABEL,
  INTAKE_REASON_LABEL,
  SERVICE_CATEGORY_LABEL,
  SOURCE_ATTR_LABEL,
  SOURCE_CHANNEL_LABEL,
  SOURCE_LABEL,
  budgetLabel,
  displayName,
  formatWhen,
  minutesAgo,
  needsReply as contactNeedsReply,
} from "./contactLabels.ts";

export function statusLabel(status: string) {
  return INQUIRY_STATUS_LABEL[status] || status;
}

export function channelLabel(channel?: string | null, source?: string | null) {
  const key = channel || source || "";
  return SOURCE_CHANNEL_LABEL[key] || SOURCE_LABEL[key] || key || "Не указан";
}

export function attributionLabel(sourceType?: string | null, utmSource?: string | null) {
  const key = (utmSource || sourceType || "").toLowerCase().replace(/\s+/g, "_");
  if (!key) return null;
  if (SOURCE_ATTR_LABEL[key]) return SOURCE_ATTR_LABEL[key];
  if (key.includes("google")) return "Google Ads";
  if (key.includes("instagram") || key === "ig") return "Instagram";
  if (key.includes("organic")) return "Organic";
  if (key.includes("referral")) return "Referral";
  return utmSource || sourceType;
}

export function serviceLabel(category?: string | null, service?: string | null) {
  if (category && SERVICE_CATEGORY_LABEL[category]) return SERVICE_CATEGORY_LABEL[category];
  return service || category || null;
}

export function intakeReasonLabel(reason: string) {
  return INTAKE_REASON_LABEL[reason] || "Требует уточнения";
}

export function relativeDayLabel(value: Date | string, timeZone = "Asia/Almaty") {
  const date = typeof value === "string" ? new Date(value) : value;
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const day = fmt.format(date);
  const today = fmt.format(now);
  const yesterdayDate = new Date(now.getTime() - 86400000);
  const yesterday = fmt.format(yesterdayDate);
  const time = new Intl.DateTimeFormat("ru-RU", { timeZone, hour: "2-digit", minute: "2-digit" }).format(date);
  if (day === today) return `Сегодня · ${time}`;
  if (day === yesterday) return `Вчера · ${time}`;
  return formatWhen(date, timeZone) || "";
}

type InquiryLike = {
  id: string;
  status: string;
  subject?: string | null;
  description?: string | null;
  service?: string | null;
  serviceCategory?: string | null;
  serviceSubcategory?: string | null;
  companyName?: string | null;
  city?: string | null;
  phoneRaw?: string | null;
  phoneNormalized?: string | null;
  source?: string | null;
  sourceType?: string | null;
  sourceChannel?: string | null;
  utmSource?: string | null;
  utmCampaign?: string | null;
  landingPage?: string | null;
  nextStep?: string | null;
  needsReply?: boolean | null;
  attentionReason?: string | null;
  receivedAt: Date;
  desiredDeadline?: string | null;
  budgetMin?: number | null;
  budgetMax?: number | null;
  currency?: string | null;
  aiSummary?: string | null;
  dealId?: string | null;
  assigneeMembershipId?: string | null;
  contact?: {
    id: string;
    name?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    companyName?: string | null;
    lastInboundMessageAt?: Date | null;
    lastOutboundMessageAt?: Date | null;
    createdAt?: Date;
    _count?: { inquiries?: number };
    methods?: Array<{ type: string; normalizedValue?: string | null; rawValue?: string | null }>;
  } | null;
  assignee?: { id: string; user?: { name?: string | null } | null } | null;
  deal?: {
    id: string;
    title: string;
    amountMinor?: unknown;
    currency?: string | null;
    outcome?: string | null;
    stage?: { name?: string | null } | null;
  } | null;
  tasks?: Array<{ id: string; title: string; status: string; dueAt?: Date | null }>;
  conversation?: {
    id: string;
    updatedAt?: Date;
    connection?: { channelType?: string | null } | null;
    _count?: { messages?: number };
  } | null;
};

export function clarificationIssues(inquiry: InquiryLike) {
  const issues: Array<{ code: string; label: string; detail: string }> = [];
  const phone = inquiry.phoneNormalized || inquiry.phoneRaw;
  const methods = inquiry.contact?.methods || [];
  const hasPhone = Boolean(phone);
  const hasOtherContact = methods.some((m) => m.type !== "phone" && m.normalizedValue);
  if (!hasPhone && !hasOtherContact) {
    issues.push({
      code: "no_contact",
      label: "Нет доступного способа связи",
      detail: "Нельзя связаться с клиентом: нет телефона и других каналов.",
    });
  } else if (!hasPhone) {
    issues.push({
      code: "missing_phone",
      label: "Нет телефона",
      detail: hasOtherContact
        ? "Телефон не указан, но контакт доступен через другой канал."
        : "Клиент оставил обращение без номера телефона.",
    });
  }
  if (!inquiry.serviceCategory && !inquiry.service && !inquiry.subject) {
    issues.push({
      code: "missing_service",
      label: "Не определена услуга",
      detail: "Непонятно, с какой задачей обратился клиент.",
    });
  } else if (!inquiry.subject) {
    issues.push({
      code: "missing_subject",
      label: "Неизвестна тема",
      detail: "Краткая тема заявки не заполнена.",
    });
  }
  if (!inquiry.contact?.id) {
    issues.push({
      code: "unlinked_client",
      label: "Клиент не связан",
      detail: "Заявку нужно связать с карточкой клиента.",
    });
  }
  return issues;
}

export function qualificationChecklist(inquiry: InquiryLike) {
  const phone = Boolean(inquiry.phoneNormalized || inquiry.phoneRaw);
  const name = Boolean(inquiry.contact && displayName(inquiry.contact) !== "Без имени");
  const need = Boolean(inquiry.serviceCategory || inquiry.service || inquiry.subject || inquiry.description);
  const budget = inquiry.budgetMin != null || inquiry.budgetMax != null;
  const deadline = Boolean(inquiry.desiredDeadline);
  const company = Boolean(inquiry.companyName || inquiry.contact?.companyName);
  return [
    { key: "name", label: "Имя", ok: name },
    { key: "phone", label: "Телефон", ok: phone },
    { key: "need", label: "Потребность", ok: need },
    { key: "budget", label: "Бюджет", ok: budget },
    { key: "deadline", label: "Срок", ok: deadline },
    { key: "company", label: "Компания", ok: company },
  ];
}

export function mapInquiryListItem(inquiry: InquiryLike, timeZone = "Asia/Almaty") {
  const contactName = inquiry.contact ? displayName(inquiry.contact) : "Клиент не идентифицирован";
  const phone =
    inquiry.phoneRaw ||
    inquiry.contact?.methods?.find((m) => m.type === "phone")?.rawValue ||
    null;
  const channel = channelLabel(inquiry.sourceChannel, inquiry.source);
  const attribution = attributionLabel(inquiry.sourceType, inquiry.utmSource);
  const replyNeeded =
    inquiry.needsReply ??
    (inquiry.contact ? contactNeedsReply(inquiry.contact) : inquiry.status === "new");
  const waitMinutes =
    replyNeeded && inquiry.contact?.lastInboundMessageAt
      ? minutesAgo(inquiry.contact.lastInboundMessageAt)
      : replyNeeded
        ? minutesAgo(inquiry.receivedAt)
        : null;
  const openTask = (inquiry.tasks || []).find((t) => t.status === "open" || t.status === "planned");
  const issues = clarificationIssues(inquiry);

  return {
    id: inquiry.id,
    contactId: inquiry.contact?.id || null,
    contactName,
    companyName: inquiry.companyName || inquiry.contact?.companyName || null,
    phone,
    hasPhone: Boolean(inquiry.phoneNormalized || phone),
    subject: inquiry.subject || "Без темы",
    description: inquiry.description || null,
    service: inquiry.service || null,
    serviceCategory: inquiry.serviceCategory || null,
    serviceLabel: serviceLabel(inquiry.serviceCategory, inquiry.service),
    source: inquiry.source,
    sourceChannel: inquiry.sourceChannel,
    sourceType: inquiry.sourceType,
    channelLabel: channel,
    attributionLabel: attribution,
    sourceLine: attribution ? `${attribution} → ${channel}` : channel,
    status: inquiry.status === "accepted" ? "in_progress" : inquiry.status,
    statusLabel: statusLabel(inquiry.status === "accepted" ? "in_progress" : inquiry.status),
    receivedAt: inquiry.receivedAt,
    receivedLabel: relativeDayLabel(inquiry.receivedAt, timeZone),
    needsReply: Boolean(replyNeeded),
    waitingMinutes: waitMinutes,
    assigneeMembershipId: inquiry.assigneeMembershipId,
    assigneeName: inquiry.assignee?.user?.name || null,
    nextStep: inquiry.nextStep || openTask?.title || null,
    dealId: inquiry.dealId || inquiry.deal?.id || null,
    dealTitle: inquiry.deal?.title || null,
    dealStage: inquiry.deal?.stage?.name || null,
    hasDeal: Boolean(inquiry.dealId || inquiry.deal?.id),
    conversationId: inquiry.conversation?.id || null,
    issues,
    needsClarification: issues.some((i) => i.code === "no_contact" || i.code === "missing_service" || i.code === "unlinked_client"),
    attentionReason: inquiry.attentionReason || null,
  };
}

export function mapInquiryDetail(inquiry: InquiryLike & {
  statusHistory?: Array<{
    id: string;
    fromStatus?: string | null;
    toStatus: string;
    changedAt: Date;
    changedByType: string;
    note?: string | null;
  }>;
  activities?: Array<{
    id: string;
    type: string;
    title: string;
    description?: string | null;
    createdAt: Date;
    actorType: string;
  }>;
}, timeZone = "Asia/Almaty") {
  const list = mapInquiryListItem(inquiry, timeZone);
  const checklist = qualificationChecklist(inquiry);
  return {
    ...list,
    serviceSubcategory: inquiry.serviceSubcategory || null,
    city: inquiry.city || null,
    desiredDeadline: inquiry.desiredDeadline || null,
    budgetLabel: budgetLabel(inquiry),
    budgetMin: inquiry.budgetMin ?? null,
    budgetMax: inquiry.budgetMax ?? null,
    currency: inquiry.currency || "KZT",
    aiSummary: inquiry.aiSummary || inquiry.description || null,
    landingPage: inquiry.landingPage || null,
    utmCampaign: inquiry.utmCampaign || null,
    utmSource: inquiry.utmSource || null,
    qualification: checklist,
    control: {
      status: list.statusLabel,
      assigneeName: list.assigneeName,
      needsReply: list.needsReply,
      waitingMinutes: list.waitingMinutes,
      nextStep: list.nextStep,
      deal: list.hasDeal ? list.dealTitle : null,
    },
    contact: inquiry.contact
      ? {
          id: inquiry.contact.id,
          name: displayName(inquiry.contact),
          phone: list.phone,
          companyName: inquiry.contact.companyName || inquiry.companyName || null,
          inquiryCount: inquiry.contact._count?.inquiries ?? null,
          clientSince: inquiry.contact.createdAt || null,
        }
      : null,
    conversation: inquiry.conversation
      ? {
          id: inquiry.conversation.id,
          channel: inquiry.conversation.connection?.channelType || "chat",
          updatedAt: inquiry.conversation.updatedAt || null,
          messageCount: inquiry.conversation._count?.messages ?? null,
        }
      : null,
    deal: inquiry.deal
      ? {
          id: inquiry.deal.id,
          title: inquiry.deal.title,
          stage: inquiry.deal.stage?.name || null,
          outcome: inquiry.deal.outcome || null,
          amountMinor: inquiry.deal.amountMinor ?? null,
          currency: inquiry.deal.currency || "KZT",
        }
      : null,
    tasks: (inquiry.tasks || []).map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      dueAt: t.dueAt || null,
    })),
    timeline: [
      ...(inquiry.statusHistory || []).map((h) => ({
        id: h.id,
        at: h.changedAt,
        title: `Статус: ${statusLabel(h.toStatus)}`,
        description: h.note || (h.fromStatus ? `Было: ${statusLabel(h.fromStatus)}` : null),
        kind: "status" as const,
      })),
      ...(inquiry.activities || []).map((a) => ({
        id: a.id,
        at: a.createdAt,
        title: a.title,
        description: a.description || null,
        kind: "activity" as const,
      })),
    ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()),
  };
}
