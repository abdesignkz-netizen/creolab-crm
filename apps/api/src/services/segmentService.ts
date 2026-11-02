import type { Prisma, PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { isManager } from "../lib/access.ts";
import { addDaysYmd, zonedLocalToUtc, zonedYmd } from "./periodRange.ts";
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
  { id: "AI", label: "AI-менеджер", keywords: /ai\s*manager|ии.?менеджер|whatsapp\s*ai|чат.?бот/i },
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

export function segmentDateRange(preset: string | undefined, from?: string, to?: string, timeZone = "Asia/Almaty", now = new Date()) {
  if (preset === "custom") return { from: from ? new Date(from) : undefined, to: to ? new Date(to) : undefined };
  const today = zonedYmd(now, timeZone);
  const midnight = (date: typeof today) => zonedLocalToUtc(timeZone, date.year, date.month, date.day);
  if (preset === "today") return { from: midnight(today), to: now };
  // Segment filters use an inclusive upper bound. Do not include the next day's
  // midnight in yesterday/last month, and never use the server's local calendar.
  if (preset === "yesterday") return { from: midnight(addDaysYmd(today, -1)), to: new Date(midnight(today).getTime() - 1) };
  const lookback = preset === "last_3_days" ? 2 : preset === "last_7_days" ? 6 : preset === "last_30_days" ? 29 : undefined;
  if (lookback !== undefined) return { from: midnight(addDaysYmd(today, -lookback)), to: now };
  const monthStart = { ...today, day: 1 };
  if (preset === "this_month") return { from: midnight(monthStart), to: now };
  if (preset === "last_month") {
    const previous = addDaysYmd(monthStart, -1);
    return { from: midnight({ ...previous, day: 1 }), to: new Date(midnight(monthStart).getTime() - 1) };
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

  const range = segmentDateRange(input.datePreset, input.dateFrom, input.dateTo, timeZone, now);
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
      email: isManager(auth) ? undefined : item.user.email,
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
    const preferredConv = contact.conversations.find((item) => item.id === conversationId);
    if (!preferredConv) throw new ApiError(422, "invalid", "Диалог не принадлежит клиенту");
    if (!preferredConv.sellerLeadId) {
      conversationId =
        contact.conversations.find((item) => item.sellerLeadId)?.id || conversationId;
    }
  } else {
    conversationId =
      contact.conversations.find((item) => item.sellerLeadId)?.id || contact.conversations[0]?.id || undefined;
  }

  return { contact, inquiryId, dealId, conversationId };
}

export async function searchWorkspace(prisma: PrismaClient, auth: AuthContext, q: string) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const query = String(q || "").trim();
  if (query.length < 2) return { q: query, items: [] as Array<Record<string, string>> };
  const digits = digitsOnly(query);
  const assignee = isManager(auth) ? membership.id : undefined;

  const [contacts, companies, deals, inquiries, tasks, conversations] = await Promise.all([
    prisma.contact.findMany({
      where: {
        tenantId: tid,
        archivedAt: null,
        ...(assignee ? { ownerMembershipId: assignee } : {}),
        OR: [
          { name: { contains: query, mode: "insensitive" } },
          { companyName: { contains: query, mode: "insensitive" } },
          ...(digits.length >= 4
            ? [{ methods: { some: { normalizedValue: { contains: digits } } } }]
            : []),
          { methods: { some: { type: "email", rawValue: { contains: query, mode: "insensitive" } } } },
        ],
      },
      select: { id: true, name: true, companyName: true, methods: { where: { type: "phone" }, take: 1 } },
      take: 6,
    }),
    prisma.company.findMany({
      where: {
        tenantId: tid,
        archivedAt: null,
        OR: [
          { name: { contains: query, mode: "insensitive" } },
          { bin: { contains: query } },
        ],
      },
      select: { id: true, name: true, bin: true },
      take: 5,
    }),
    prisma.deal.findMany({
      where: {
        tenantId: tid,
        ...(assignee ? { assigneeMembershipId: assignee } : {}),
        title: { contains: query, mode: "insensitive" },
      },
      select: { id: true, title: true, outcome: true },
      take: 5,
    }),
    prisma.inquiry.findMany({
      where: {
        tenantId: tid,
        ...(assignee ? { assigneeMembershipId: assignee } : {}),
        OR: [
          { subject: { contains: query, mode: "insensitive" } },
          ...(digits.length >= 4 ? [{ phoneNormalized: { contains: digits } }] : []),
        ],
      },
      select: { id: true, subject: true, status: true },
      take: 5,
    }),
    prisma.task.findMany({
      where: {
        tenantId: tid,
        parentTaskId: null,
        ...(assignee ? { ownerMembershipId: assignee } : {}),
        title: { contains: query, mode: "insensitive" },
      },
      select: { id: true, title: true, status: true },
      take: 5,
    }),
    prisma.conversation.findMany({
      where: {
        tenantId: tid,
        status: "open",
        ...(assignee ? { assigneeMembershipId: assignee } : {}),
        contact: {
          OR: [
            { name: { contains: query, mode: "insensitive" } },
            { companyName: { contains: query, mode: "insensitive" } },
            ...(digits.length >= 4
              ? [{ methods: { some: { normalizedValue: { contains: digits } } } }]
              : []),
          ],
        },
      },
      select: { id: true, mode: true, contact: { select: { name: true, companyName: true } } },
      take: 5,
    }),
  ]);

  return {
    q: query,
    items: [
      ...contacts.map((item) => ({
        type: "contact",
        id: item.id,
        title: displayName(item),
        subtitle: item.companyName || item.methods[0]?.rawValue || "Клиент",
        href: `/contacts/${item.id}`,
      })),
      ...companies.map((item) => ({
        type: "company",
        id: item.id,
        title: item.name,
        subtitle: item.bin || "Компания",
        href: `/companies/${item.id}`,
      })),
      ...deals.map((item) => ({
        type: "deal",
        id: item.id,
        title: item.title,
        subtitle: item.outcome === "open" ? "Сделка" : item.outcome,
        href: `/deals/${item.id}`,
      })),
      ...inquiries.map((item) => ({
        type: "inquiry",
        id: item.id,
        title: item.subject || "Заявка",
        subtitle: INQUIRY_STATUS_LABEL[item.status] || item.status,
        href: `/requests/${item.id}`,
      })),
      ...tasks.map((item) => ({
        type: "task",
        id: item.id,
        title: item.title,
        subtitle: item.status,
        href: `/tasks?open=${item.id}`,
      })),
      ...conversations.map((item) => ({
        type: "conversation",
        id: item.id,
        title: item.contact ? displayName(item.contact) : "Диалог",
        subtitle: item.mode === "ai" ? "AI" : "Человек",
        href: `/conversations/${item.id}`,
      })),
    ],
  };
}
