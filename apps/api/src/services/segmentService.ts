import type { Prisma, PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import {
  INQUIRY_STATUS_LABEL,
  SOURCE_LABEL,
  digitsOnly,
  displayName,
  formatWhen,
  needsReply,
} from "./contactLabels.ts";

const ACTIVE_INQUIRY = ["new", "accepted", "qualification", "qualified", "in_progress", "waiting_client", "waiting_manager"];

export const SERVICE_CATEGORIES = [
  { id: "WEB", label: "Разработка сайта", keywords: /сайт|website|landing|лендинг|интернет.?магазин|ecommerce|корпоративн|web\b/i },
  { id: "PRESENTATION", label: "Презентация", keywords: /презентац|pitch|deck|тендерн|pitch.?deck/i },
  { id: "ADVERTISING", label: "Реклама", keywords: /реклам|google\s*ads|meta\s*ads|tiktok|facebook\s*ads|яндекс/i },
  { id: "BRANDING", label: "Брендинг", keywords: /бренд|логотип|айдентик|brand/i },
  { id: "AI", label: "AI Manager", keywords: /ai\s*manager|ии.?менеджер|whatsapp\s*ai|чат.?бот/i },
] as const;

export type SegmentInput = {
  q?: string;
  serviceCategories?: string[];
  datePreset?: string;
  dateField?: "lastContact" | "firstContact" | "inquiryCreated" | "lastMessage";
  dateFrom?: string;
  dateTo?: string;
  statuses?: string[];
  lifecycleStatuses?: string[];
  sources?: string[];
  acquisition?: string[];
  ownerMembershipIds?: string[];
  tags?: string[];
  needsReply?: boolean;
  hasOverdueTask?: boolean;
  hasActiveDeal?: boolean;
  missingNextAction?: boolean;
  hot?: boolean;
  excludeWon?: boolean;
  proposalSentDaysAgo?: number;
  limit?: number;
};

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership;
}

function startOfDay(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return new Date(`${y}-${m}-${d}T00:00:00+05:00`);
}

function dateRange(preset: string | undefined, from?: string, to?: string, timeZone = "Asia/Almaty") {
  const now = new Date();
  const todayStart = startOfDay(now, timeZone);
  if (preset === "custom") {
    return {
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    };
  }
  if (preset === "today") return { from: todayStart, to: now };
  if (preset === "yesterday") {
    const y = new Date(todayStart);
    y.setDate(y.getDate() - 1);
    return { from: y, to: todayStart };
  }
  if (preset === "last_3_days") {
    const fromDate = new Date(todayStart);
    fromDate.setDate(fromDate.getDate() - 2);
    return { from: fromDate, to: now };
  }
  if (preset === "last_7_days") {
    const fromDate = new Date(todayStart);
    fromDate.setDate(fromDate.getDate() - 6);
    return { from: fromDate, to: now };
  }
  if (preset === "last_30_days") {
    const fromDate = new Date(todayStart);
    fromDate.setDate(fromDate.getDate() - 29);
    return { from: fromDate, to: now };
  }
  if (preset === "this_month") {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(now);
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    return { from: new Date(`${y}-${m}-01T00:00:00+05:00`), to: now };
  }
  if (preset === "last_month") {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(now);
    const y = Number(parts.find((p) => p.type === "year")?.value);
    const m = Number(parts.find((p) => p.type === "month")?.value);
    const prevM = m === 1 ? 12 : m - 1;
    const prevY = m === 1 ? y - 1 : y;
    const from = new Date(`${prevY}-${String(prevM).padStart(2, "0")}-01T00:00:00+05:00`);
    const to = new Date(`${y}-${String(m).padStart(2, "0")}-01T00:00:00+05:00`);
    return { from, to };
  }
  return { from: undefined, to: undefined };
}

function matchesServiceCategory(
  inquiry: { serviceCategory?: string | null; service?: string | null; subject?: string | null; description?: string | null },
  categories: string[],
) {
  if (!categories.length) return true;
  if (inquiry.serviceCategory && categories.includes(inquiry.serviceCategory)) return true;
  const blob = [inquiry.service, inquiry.subject, inquiry.description].filter(Boolean).join(" ");
  return categories.some((id) => {
    const def = SERVICE_CATEGORIES.find((item) => item.id === id);
    return def ? def.keywords.test(blob) : false;
  });
}

function primaryPhone(methods: Array<{ type: string; rawValue: string; normalizedValue: string; primary: boolean }>) {
  const phones = methods.filter((item) => item.type === "phone");
  return phones.find((item) => item.primary) || phones[0] || null;
}

function inquiryDate(inquiry: { receivedAt: Date } | null | undefined, field: SegmentInput["dateField"], contact: {
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastContactAt: Date | null;
  lastInboundMessageAt: Date | null;
}) {
  if (field === "firstContact") return contact.firstSeenAt;
  if (field === "lastMessage") return contact.lastInboundMessageAt || contact.lastContactAt || contact.lastSeenAt;
  if (field === "inquiryCreated") return inquiry?.receivedAt || contact.firstSeenAt;
  return contact.lastContactAt || contact.lastSeenAt;
}

export async function previewContactSegment(prisma: PrismaClient, auth: AuthContext, input: SegmentInput) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const timeZone = membership.tenant.timezone || "Asia/Almaty";
  const now = new Date();
  const limit = Math.min(200, input.limit || 80);
  const q = String(input.q || "").trim();
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

  const where: Prisma.ContactWhereInput = {
    tenantId: tid,
    archivedAt: null,
  };

  if (q) {
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { firstName: { contains: q, mode: "insensitive" } },
      { lastName: { contains: q, mode: "insensitive" } },
      { companyName: { contains: q, mode: "insensitive" } },
      { summary: { contains: q, mode: "insensitive" } },
      {
        methods: {
          some: {
            OR: [
              { rawValue: { contains: q, mode: "insensitive" } },
              ...[...phoneVariants].map((value) => ({ normalizedValue: { contains: value } })),
            ],
          },
        },
      },
      { tags: { some: { tag: { name: { contains: q, mode: "insensitive" } } } } },
      {
        inquiries: {
          some: {
            OR: [
              { subject: { contains: q, mode: "insensitive" } },
              { description: { contains: q, mode: "insensitive" } },
              { service: { contains: q, mode: "insensitive" } },
            ],
          },
        },
      },
      { tasks: { some: { title: { contains: q, mode: "insensitive" } } } },
    ];
  }

  if (input.lifecycleStatuses?.length) where.lifecycleStatus = { in: input.lifecycleStatuses };
  if (input.ownerMembershipIds?.length) where.ownerMembershipId = { in: input.ownerMembershipIds };
  if (input.hot) where.leadTemperature = "hot";
  if (input.tags?.length) where.tags = { some: { tag: { name: { in: input.tags } } } };
  if (input.hasActiveDeal) where.deals = { some: { outcome: "open" } };

  const contacts = await prisma.contact.findMany({
    where,
    include: {
      methods: true,
      tags: { include: { tag: true } },
      inquiries: {
        where: { archived: false },
        orderBy: { receivedAt: "desc" },
        take: 10,
      },
      deals: true,
      tasks: {
        where: { status: { in: ["open", "waiting", "done"] }, parentTaskId: null },
        orderBy: { dueAt: "asc" },
        take: 20,
      },
      conversations: { orderBy: { updatedAt: "desc" }, take: 3 },
    },
    orderBy: [{ lastSeenAt: "desc" }],
    take: 300,
  });

  const range = dateRange(input.datePreset, input.dateFrom, input.dateTo, timeZone);
  const dateField = input.dateField || "lastContact";
  const serviceCategories = input.serviceCategories || [];
  const statuses = input.statuses || [];
  const sources = input.sources || [];
  const acquisition = input.acquisition || [];
  const proposalWindow =
    input.proposalSentDaysAgo != null
      ? {
          from: new Date(now.getTime() - (input.proposalSentDaysAgo + 0.5) * 86400000),
          to: new Date(now.getTime() - (input.proposalSentDaysAgo - 0.5) * 86400000),
        }
      : null;

  const filtered = contacts.filter((contact) => {
    const currentInquiry =
      contact.inquiries.find((item) => ACTIVE_INQUIRY.includes(item.status)) || contact.inquiries[0] || null;

    if (serviceCategories.length) {
      const ok = contact.inquiries.some((inq) => matchesServiceCategory(inq, serviceCategories));
      if (!ok) return false;
    }

    if (statuses.length) {
      const statusOk = contact.inquiries.some((inq) => statuses.includes(inq.status));
      if (!statusOk && !statuses.includes(contact.lifecycleStatus)) return false;
    }

    if (sources.length) {
      const sourceOk = contact.inquiries.some(
        (inq) => sources.includes(inq.source) || sources.includes(inq.sourceType || "") || sources.includes(String(inq.sourceChannel || "")),
      );
      if (!sourceOk) return false;
    }

    if (acquisition.length) {
      const acqOk = contact.inquiries.some((inq) => {
        const utm = String(inq.utmSource || "").toLowerCase();
        return acquisition.some((item) => utm.includes(item.toLowerCase()) || String(inq.utmCampaign || "").toLowerCase().includes(item.toLowerCase()));
      });
      if (!acqOk) return false;
    }

    if (range.from || range.to) {
      const at = inquiryDate(currentInquiry, dateField, contact);
      if (range.from && at < range.from) return false;
      if (range.to && at > range.to) return false;
    }

    if (input.needsReply && !needsReply(contact)) return false;

    if (input.hasOverdueTask) {
      const overdue = contact.tasks.some(
        (task) => task.dueAt && task.dueAt.getTime() < now.getTime() && (task.status === "open" || task.status === "waiting"),
      );
      if (!overdue) return false;
    }

    if (input.missingNextAction) {
      const hasNext = contact.tasks.some((task) => task.status === "open" || task.status === "waiting") || Boolean(currentInquiry?.nextStep);
      if (hasNext || !currentInquiry || !ACTIVE_INQUIRY.includes(currentInquiry.status)) return false;
    }

    if (input.excludeWon) {
      const won = contact.deals.some((deal) => deal.outcome === "won");
      if (won) return false;
    }

    if (proposalWindow) {
      const sent = contact.tasks.some(
        (task) =>
          task.type === "proposal" &&
          (task.executionStatus === "sent" || task.resultCode === "sent" || task.status === "done") &&
          task.sentAt &&
          task.sentAt >= proposalWindow.from &&
          task.sentAt <= proposalWindow.to,
      );
      if (!sent) return false;
    }

    return true;
  });

  const clients = filtered.slice(0, limit).map((contact) => {
    const phone = primaryPhone(contact.methods);
    const currentInquiry =
      contact.inquiries.find((item) => ACTIVE_INQUIRY.includes(item.status)) || contact.inquiries[0] || null;
    return {
      id: contact.id,
      name: displayName(contact),
      phone: phone?.rawValue || null,
      companyName: contact.companyName,
      interest: currentInquiry?.subject || currentInquiry?.service || null,
      status: currentInquiry?.status || contact.lifecycleStatus,
      statusLabel: INQUIRY_STATUS_LABEL[currentInquiry?.status || ""] || currentInquiry?.status || contact.lifecycleStatus,
      source: SOURCE_LABEL[currentInquiry?.sourceType || currentInquiry?.source || ""] || currentInquiry?.source || null,
      lastContactAt: contact.lastContactAt || contact.lastSeenAt,
      lastContactLabel: formatWhen(contact.lastContactAt || contact.lastSeenAt, timeZone),
      inquiryId: currentInquiry?.id || null,
      dealId: contact.deals[0]?.id || null,
      conversationId: contact.conversations[0]?.id || null,
    };
  });

  return {
    total: filtered.length,
    clients,
    serviceCategories: SERVICE_CATEGORIES.map((item) => ({ id: item.id, label: item.label })),
  };
}

export async function searchContactsForPicker(prisma: PrismaClient, auth: AuthContext, q: string) {
  const query = String(q || "").trim();
  // Empty query → recent CRM clients for picker browse
  return previewContactSegment(prisma, auth, { q: query || undefined, limit: query ? 20 : 40 });
}

export async function listWorkspaceMembers(prisma: PrismaClient, auth: AuthContext) {
  const membership = requireTenant(auth);
  const items = await prisma.membership.findMany({
    where: { tenantId: membership.tenantId, active: true },
    include: { user: true },
    orderBy: { createdAt: "asc" },
  });
  return {
    items: items.map((item) => ({
      id: item.id,
      name: item.user.name,
      email: item.user.email,
      role: item.role,
      isMe: item.id === membership.id,
    })),
  };
}

export async function resolveContactLinks(
  prisma: PrismaClient | Prisma.TransactionClient,
  tenantId: string,
  contactId: string,
  preferred?: { inquiryId?: string; dealId?: string; conversationId?: string },
) {
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, tenantId },
    include: {
      inquiries: { where: { archived: false }, orderBy: { receivedAt: "desc" }, take: 20 },
      deals: { where: { outcome: "open" }, orderBy: { createdAt: "desc" }, take: 10 },
      conversations: { orderBy: { updatedAt: "desc" }, take: 10 },
    },
  });
  if (!contact) throw new ApiError(422, "invalid", "Клиент не найден");

  let inquiryId = preferred?.inquiryId;
  if (inquiryId) {
    const ok = contact.inquiries.some((item) => item.id === inquiryId);
    if (!ok) throw new ApiError(422, "invalid", "Заявка не принадлежит клиенту");
  } else {
    inquiryId =
      contact.inquiries.find((item) => ACTIVE_INQUIRY.includes(item.status))?.id || contact.inquiries[0]?.id || undefined;
  }

  let dealId = preferred?.dealId;
  if (dealId) {
    const ok = contact.deals.some((item) => item.id === dealId);
    if (!ok) throw new ApiError(422, "invalid", "Сделка не принадлежит клиенту");
  } else if (inquiryId) {
    const inquiry = contact.inquiries.find((item) => item.id === inquiryId);
    dealId = inquiry?.dealId || contact.deals[0]?.id || undefined;
  } else {
    dealId = contact.deals[0]?.id || undefined;
  }

  let conversationId = preferred?.conversationId;
  if (conversationId) {
    const ok = contact.conversations.some((item) => item.id === conversationId);
    if (!ok) throw new ApiError(422, "invalid", "Диалог не принадлежит клиенту");
  } else {
    conversationId = contact.conversations[0]?.id || undefined;
  }

  return { contact, inquiryId, dealId, conversationId };
}
