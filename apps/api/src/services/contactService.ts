import type { Prisma, PrismaClient } from "@creolab/db";
import { validateClientPhone } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { isManager, requireCompanyAdmin } from "../lib/access.ts";
import {
  INQUIRY_STATUS_LABEL,
  INQUIRY_ACTIVE_STATUSES,
  LIFECYCLE_LABEL,
  SOURCE_LABEL,
  TEMP_LABEL,
  TASK_TYPE_LABEL,
  budgetLabel,
  digitsOnly,
  displayName,
  formatWhen,
  minutesAgo,
  needsReply,
  whoWroteLast,
} from "./contactLabels.ts";

import { countContactsNeedsReply, countContactsNew } from "./attentionCounts.ts";
import { writeAudit } from "../lib/audit.ts";
import { resolvePeriodRange, zonedYmd, type PeriodPreset } from "./periodRange.ts";
import { inquiryInterest, loadConversationInterests } from "./contactInterestService.ts";
import { pagination } from "./pagination.ts";

const ACTIVE_INQUIRY: readonly string[] = INQUIRY_ACTIVE_STATUSES;
const CLOSED_INQUIRY = ["converted", "closed", "lost"];

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership;
}

async function serializeDuplicateContact(prisma: PrismaClient, tenantId: string, contactId: string) {
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, tenantId, archivedAt: null },
    include: {
      methods: true,
      deals: { where: { outcome: "open" }, select: { id: true } },
    },
  });
  if (!contact) return null;
  const phone = primaryPhone(contact.methods);
  return {
    id: contact.id,
    name: displayName(contact),
    phone: phone?.rawValue || null,
    companyName: contact.companyName,
    activeDealsCount: contact.deals.length,
    href: `/contacts/${contact.id}`,
  };
}

export async function writeActivity(
  tx: Prisma.TransactionClient | PrismaClient,
  args: {
    tenantId: string;
    contactId: string;
    companyId?: string | null;
    inquiryId?: string | null;
    dealId?: string | null;
    type: string;
    title: string;
    description?: string | null;
    actorType?: string;
    actorId?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  return tx.activity.create({
    data: {
      tenantId: args.tenantId,
      contactId: args.contactId,
      companyId: args.companyId || null,
      inquiryId: args.inquiryId || null,
      dealId: args.dealId || null,
      type: args.type,
      title: args.title,
      description: args.description || null,
      actorType: args.actorType || "system",
      actorId: args.actorId || null,
      metadataJson: (args.metadata || {}) as Prisma.InputJsonValue,
    },
  });
}

function primaryPhone(methods: Array<{ type: string; rawValue: string; normalizedValue: string; primary: boolean }>) {
  const phones = methods.filter((item) => item.type === "phone");
  return phones.find((item) => item.primary) || phones[0] || null;
}

function primaryEmail(methods: Array<{ type: string; rawValue: string }>) {
  return methods.find((item) => item.type === "email")?.rawValue || null;
}

function nextOpenTask(
  tasks: Array<{
    id: string;
    type: string;
    title: string;
    description: string | null;
    status: string;
    dueAt: Date | null;
    ownerMembershipId: string | null;
    contactId: string | null;
  }>,
) {
  const open = tasks.filter((item) => item.status === "open" || item.status === "waiting");
  open.sort((a, b) => {
    const aDue = a.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const bDue = b.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return aDue - bDue;
  });
  return open[0] || null;
}

function buildSummary(args: {
  contact: { summary?: string | null; firstSeenAt: Date; lifecycleStatus: string };
  inquiry: {
    subject?: string | null;
    description?: string | null;
    service?: string | null;
    source?: string | null;
    sourceType?: string | null;
    utmSource?: string | null;
    utmCampaign?: string | null;
    budgetMin?: number | null;
    budgetMax?: number | null;
    currency?: string | null;
    desiredDeadline?: string | null;
    nextStep?: string | null;
  } | null;
  nextTask: { title: string; dueAt: Date | null } | null;
  timeZone: string;
}) {
  if (args.contact.summary?.trim()) return args.contact.summary.trim();
  if (!args.inquiry) return "Пока нет активной заявки. Добавьте задачу или заявку.";
  const parts: string[] = [];
  const when = formatWhen(args.contact.firstSeenAt, args.timeZone);
  const source = SOURCE_LABEL[args.inquiry.sourceType || args.inquiry.source || ""] || args.inquiry.source || "неизвестный источник";
  const channel = args.inquiry.utmSource || args.inquiry.utmCampaign;
  parts.push(`Обратился ${when || "недавно"} через ${source}${channel ? ` (${channel})` : ""}.`);
  if (args.inquiry.subject || args.inquiry.service) {
    parts.push(`Интерес: ${args.inquiry.service || args.inquiry.subject}.`);
  }
  const budget = budgetLabel(args.inquiry);
  parts.push(budget ? `Бюджет: ${budget}.` : "Бюджет пока не определён.");
  if (args.inquiry.desiredDeadline) parts.push(`Срок: ${args.inquiry.desiredDeadline}.`);
  if (args.nextTask) {
    parts.push(
      `Следующее действие — ${args.nextTask.title}${args.nextTask.dueAt ? ` · ${formatWhen(args.nextTask.dueAt, args.timeZone)}` : ""}.`,
    );
  } else if (args.inquiry.nextStep) {
    parts.push(`Следующий шаг: ${args.inquiry.nextStep}.`);
  } else {
    parts.push("Нет следующего действия.");
  }
  return parts.join(" ");
}

function dataGaps(args: {
  name: string;
  phone: string | null;
  inquiry: { subject?: string | null; source?: string | null; nextStep?: string | null } | null;
  ownerId: string | null;
  nextTask: unknown;
}) {
  const gaps: string[] = [];
  if (!args.name || args.name === "Без имени") gaps.push("name");
  if (!args.phone) gaps.push("phone");
  if (!args.inquiry?.subject) gaps.push("task");
  if (!args.inquiry?.source) gaps.push("source");
  if (!args.ownerId) gaps.push("owner");
  if (!args.nextTask && !args.inquiry?.nextStep) gaps.push("next_action");
  return gaps;
}

export async function listContactsBoard(
  prisma: PrismaClient,
  auth: AuthContext,
  query: Record<string, string | undefined> = {},
) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const timeZone = membership.tenant.timezone || "Asia/Almaty";
  const now = new Date();
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
  const filter = String(query.filter || "all");
  const { take, skip } = pagination(query);

  const where: Prisma.ContactWhereInput = {
    tenantId: tid,
    archivedAt: filter === "archived" ? { not: null } : null,
  };

  if (q) {
    where.OR = [
      { name: { contains: q } },
      { firstName: { contains: q } },
      { lastName: { contains: q } },
      { companyName: { contains: q } },
      { summary: { contains: q } },
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
      { tags: { some: { tag: { name: { contains: q } } } } },
      { inquiries: { some: { OR: [{ subject: { contains: q } }, { description: { contains: q } }] } } },
      { tasks: { some: { title: { contains: q } } } },
    ];
  }

  // Same population as the nav badge: do not shrink «Новые» / «Нужен ответ» by period.
  if (filter !== "new" && filter !== "needs_reply" && query.period && query.period !== "all") {
    const range = resolvePeriodRange(timeZone, query.period as PeriodPreset, query.dateFrom, query.dateTo, now);
    where.firstSeenAt = { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lt: range.to } : {}) };
  }
  if (query.status) where.lifecycleStatus = query.status;
  if (query.owner === "me") where.ownerMembershipId = membership.id;
  else if (query.owner === "unassigned") where.ownerMembershipId = null;
  else if (query.owner) where.ownerMembershipId = query.owner;
  if (query.source) {
    where.inquiries = { some: { OR: [{ source: query.source }, { sourceType: query.source }] } };
  }

  // Compute filters on lightweight candidates across the whole selection. Only
  // the requested page loads the expensive card relations and message context.
  const [candidates, attentionNeedsReply, attentionNew] = await Promise.all([
    prisma.contact.findMany({
    where,
    select: {
      id: true, lifecycleStatus: true, lastContactAt: true, lastSeenAt: true,
      lastInboundMessageAt: true, lastOutboundMessageAt: true,
      inquiries: { where: { archived: false, status: { in: [...ACTIVE_INQUIRY] } }, orderBy: [{ receivedAt: "desc" }, { id: "asc" }], take: 1 },
      tasks: { where: { status: { in: ["open", "waiting"] } }, orderBy: { dueAt: { sort: "asc", nulls: "last" } }, take: 1, select: { dueAt: true } },
      _count: { select: {
        inquiries: { where: { archived: false } },
        tasks: { where: { status: { in: ["open", "waiting"] } } },
        deals: { where: { outcome: "open" } },
      } },
    },
    orderBy: [{ lastSeenAt: "desc" }, { firstSeenAt: "desc" }, { id: "asc" }],
  }),
    countContactsNeedsReply(prisma, tid),
    countContactsNew(prisma, tid),
  ]);
  const flags = (contact: typeof candidates[number]) => ({
    needsReply: needsReply(contact),
    overdue: Boolean(contact.tasks[0]?.dueAt && contact.tasks[0].dueAt < now),
    missingNextAction: Boolean(contact.inquiries.length && !contact._count.tasks && !contact.inquiries[0].nextStep),
  });
  const matching = candidates.filter(contact => {
    const state = flags(contact);
    if (filter === "new") return contact.lifecycleStatus === "new";
    if (filter === "in_progress") return ["in_progress", "active"].includes(contact.lifecycleStatus);
    if (filter === "needs_reply") return state.needsReply;
    if (filter === "today") return JSON.stringify(zonedYmd(contact.lastContactAt || contact.lastSeenAt, timeZone)) === JSON.stringify(zonedYmd(now, timeZone));
    if (filter === "overdue") return state.overdue;
    if (filter === "no_next") return state.missingNextAction;
    if (filter === "has_inquiry") return contact.inquiries.length > 0;
    if (filter === "has_deal") return contact._count.deals > 0;
    if (filter === "lost") return contact.lifecycleStatus === "lost";
    return true;
  });
  if (filter === "all") {
    matching.sort((a, b) => {
      const newDelta = Number(b.lifecycleStatus === "new") - Number(a.lifecycleStatus === "new");
      if (newDelta) return newDelta;
      return Number(flags(b).needsReply) - Number(flags(a).needsReply);
    });
  }
  const page = matching.slice(skip, skip + take);
  const byId = new Map(page.map(contact => [contact.id, contact]));
  const contacts = await prisma.contact.findMany({
    where: { tenantId: tid, id: { in: page.map(contact => contact.id) } },
    include: {
      methods: true,
      owner: { include: { user: true } },
      tags: { include: { tag: true } },
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
        where: { status: { in: ["open", "waiting"] } },
        orderBy: { dueAt: "asc" },
        take: 10,
      },
      conversations: {
        where: { status: "open" },
        orderBy: { updatedAt: "desc" },
        take: 1,
        include: { messages: { orderBy: { createdAt: "desc" }, take: 1 } },
      },
    },
    orderBy: [{ lastSeenAt: "desc" }, { firstSeenAt: "desc" }, { id: "asc" }],
  });

  const loaded = new Map(contacts.map((contact) => [contact.id, contact]));
  const conversationInterests = await loadConversationInterests(prisma, tid, contacts.filter((contact) => {
    const inquiry = byId.get(contact.id)?.inquiries[0] || contact.inquiries[0];
    return !inquiryInterest(inquiry);
  }).map((contact) => contact.id));

  const items = page
    .map((candidate) => loaded.get(candidate.id))
    .filter((contact): contact is (typeof contacts)[number] => Boolean(contact))
    .map((contact) => {
      const phone = primaryPhone(contact.methods);
      const currentInquiry =
        byId.get(contact.id)?.inquiries[0] || contact.inquiries[0] || null;
      const interest = inquiryInterest(currentInquiry) || conversationInterests.get(contact.id);
      const nextTask = nextOpenTask(contact.tasks);
      const overdueStrict = contact.tasks.some(
        (item) => item.dueAt && item.dueAt.getTime() < now.getTime() && (item.status === "open" || item.status === "waiting"),
      );
      const waitingReply = needsReply(contact);
      const lastWho = whoWroteLast(contact);
      const waitMinutes = waitingReply ? minutesAgo(contact.lastInboundMessageAt, now) : null;
      const hasActiveInquiry = Boolean(byId.get(contact.id)?.inquiries.length);
      const missingNext = hasActiveInquiry && !nextTask && !currentInquiry?.nextStep;
      const attribution = (contact.attributionJson || {}) as Record<string, string>;
      const source =
        currentInquiry?.sourceType ||
        currentInquiry?.source ||
        attribution.sourceType ||
        attribution.source ||
        null;
      const acquisition = currentInquiry?.utmSource || currentInquiry?.utmCampaign || attribution.utmSource || null;

      return {
        id: contact.id,
        name: displayName(contact),
        companyName: contact.companyName,
        phone: phone?.rawValue || null,
        phoneNormalized: phone?.normalizedValue || null,
        email: primaryEmail(contact.methods),
        lifecycleStatus: contact.lifecycleStatus,
        lifecycleLabel: LIFECYCLE_LABEL[contact.lifecycleStatus] || contact.lifecycleStatus,
        leadTemperature: contact.leadTemperature,
        temperatureLabel: TEMP_LABEL[contact.leadTemperature] || contact.leadTemperature,
        interest: interest?.text || null,
        interestSource: interest?.source || null,
        interestMessageId: interest?.messageId || null,
        inquiryStatus: currentInquiry?.status || null,
        inquiryStatusLabel: currentInquiry ? INQUIRY_STATUS_LABEL[currentInquiry.status] || currentInquiry.status : null,
        source,
        sourceLabel: source ? SOURCE_LABEL[source] || source : null,
        acquisition,
        firstContactAt: contact.firstSeenAt,
        lastContactAt: contact.lastContactAt || contact.lastSeenAt,
        firstContactLabel: formatWhen(contact.firstSeenAt, timeZone),
        lastContactLabel: formatWhen(contact.lastContactAt || contact.lastSeenAt, timeZone),
        inquiryCount: byId.get(contact.id)!._count.inquiries,
        openTaskCount: byId.get(contact.id)!._count.tasks,
        ownerName: contact.owner?.user?.name || null,
        ownerMembershipId: contact.ownerMembershipId,
        nextAction: nextTask
          ? {
              id: nextTask.id,
              title: nextTask.title,
              type: nextTask.type,
              typeLabel: TASK_TYPE_LABEL[nextTask.type] || nextTask.type,
              dueAt: nextTask.dueAt,
              dueLabel: formatWhen(nextTask.dueAt, timeZone),
              overdue: Boolean(nextTask.dueAt && nextTask.dueAt.getTime() < now.getTime()),
            }
          : currentInquiry?.nextStep
            ? { id: null, title: currentInquiry.nextStep, type: "other", typeLabel: "Шаг", dueAt: null, dueLabel: null, overdue: false }
            : null,
        activeDeal: contact.deals[0]
          ? {
              id: contact.deals[0].id,
              title: contact.deals[0].title,
              stage: contact.deals[0].stage?.name || null,
              amountMinor: contact.deals[0].offerAmountMinor,
              currency: contact.deals[0].currency,
            }
          : null,
        needsReply: waitingReply,
        waitMinutes,
        lastWriter: lastWho,
        overdue: overdueStrict,
        missingNextAction: missingNext,
        unreadHint: waitingReply,
        tags: contact.tags.map((item) => item.tag.name),
        conversationId: contact.conversations[0]?.id || null,
        lastMessagePreview: contact.conversations[0]?.messages[0]?.text || null,
      };
    });

  return {
    asOf: now.toISOString(),
    filter,
    q,
    total: matching.length,
    offset: skip,
    limit: take,
    hasMore: skip + items.length < matching.length,
    metrics: {
      total: matching.length,
      new: matching.filter((item) => item.lifecycleStatus === "new").length,
      needsReply: matching.filter((item) => flags(item).needsReply).length,
      overdue: matching.filter((item) => flags(item).overdue).length,
      noNext: matching.filter((item) => flags(item).missingNextAction).length,
    },
    attention: {
      new: attentionNew,
      needsReply: attentionNeedsReply,
    },
    items,
  };
}

export async function getContactOverview(prisma: PrismaClient, auth: AuthContext, contactId: string) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const timeZone = membership.tenant.timezone || "Asia/Almaty";
  const now = new Date();

  const contact = await prisma.contact.findFirst({
    where: { id: contactId, tenantId: tid },
    include: {
      methods: { orderBy: { createdAt: "asc" } },
      identities: true,
      owner: { include: { user: true } },
      tags: { include: { tag: true } },
      facts: { orderBy: { createdAt: "desc" }, take: 40 },
      inquiries: {
        where: { archived: false },
        orderBy: { receivedAt: "desc" },
        take: 30,
        include: { assignee: { include: { user: true } } },
      },
      deals: {
        orderBy: { createdAt: "desc" },
        take: 20,
        include: { stage: true, assignee: { include: { user: true } } },
      },
      tasks: {
        orderBy: [{ status: "asc" }, { dueAt: "asc" }],
        take: 40,
        include: { owner: { include: { user: true } } },
      },
      conversations: {
        orderBy: { updatedAt: "desc" },
        take: 20,
        include: {
          messages: { orderBy: { createdAt: "desc" }, take: 40 },
        },
      },
      notes: { orderBy: [{ pinned: "desc" }, { createdAt: "desc" }], take: 30 },
      activities: { orderBy: { createdAt: "desc" }, take: 60 },
    },
  });
  if (!contact) throw new ApiError(404, "not_found", "Клиент не найден");
  if (isManager(auth)) {
    const me = membership.id;
    contact.inquiries = contact.inquiries.filter((item) => !item.assigneeMembershipId || item.assigneeMembershipId === me);
    contact.deals = contact.deals.filter((item) => item.assigneeMembershipId === me);
    contact.tasks = contact.tasks.filter((item) => item.ownerMembershipId === me);
    contact.conversations = contact.conversations.filter(
      (item) => item.assigneeMembershipId === me || contact.inquiries.some((inquiry) => inquiry.conversationId === item.id),
    );
  }

  const companyLinks = await prisma.companyContact.findMany({
    where: { tenantId: tid, contactId, isActive: true },
    include: {
      company: {
        select: {
          id: true,
          name: true,
          city: true,
          industry: true,
          lifecycleStatus: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const phone = primaryPhone(contact.methods);
  const email = primaryEmail(contact.methods);
  const currentInquiry =
    contact.inquiries.find((item) => ACTIVE_INQUIRY.includes(item.status)) || contact.inquiries[0] || null;
  const openTasks = contact.tasks.filter((item) => item.status === "open" || item.status === "waiting");
  const nextTask = nextOpenTask(openTasks);
  const activeDeal = contact.deals.find((item) => item.outcome === "open") || null;
  const waitingReply = needsReply(contact);
  const lastWho = whoWroteLast(contact);
  const attribution = {
    ...((contact.attributionJson || {}) as Record<string, unknown>),
    sourceType: currentInquiry?.sourceType || currentInquiry?.source || (contact.attributionJson as Record<string, string>)?.sourceType || null,
    sourceChannel: currentInquiry?.sourceChannel || null,
    sourceIntegration: currentInquiry?.sourceIntegration || null,
    utmSource: currentInquiry?.utmSource || null,
    utmMedium: currentInquiry?.utmMedium || null,
    utmCampaign: currentInquiry?.utmCampaign || null,
    utmContent: currentInquiry?.utmContent || null,
    utmTerm: currentInquiry?.utmTerm || null,
    landingPage: currentInquiry?.landingPage || null,
    referrer: currentInquiry?.referrer || null,
  };
  const interest = inquiryInterest(currentInquiry) || (await loadConversationInterests(prisma, tid, [contactId])).get(contactId);
  const summary = !contact.summary?.trim() && !currentInquiry && interest
    ? `Интерес из переписки: ${interest.text}`
    : buildSummary({ contact, inquiry: currentInquiry, nextTask, timeZone });
  const conversationMode = contact.conversations[0]?.mode || null;
  const aiMode =
    conversationMode === "human" ? "HUMAN" : conversationMode === "paused" ? "DISABLED" : conversationMode === "ai" ? "AUTO" : "UNKNOWN";

  const HIDDEN_ACTIVITY = new Set([
    "webhook_received",
    "provider_message_synced",
    "cache_invalidated",
  ]);
  const timeline = [
    ...contact.activities
      .filter((item) => !HIDDEN_ACTIVITY.has(item.type) && !item.type.startsWith("system."))
      .map((item) => ({
      id: item.id,
      at: item.createdAt,
      kind: "activity" as const,
      type: item.type,
      title: item.title,
      description: item.description,
      actorType: item.actorType,
    })),
    ...contact.conversations.flatMap((conversation) =>
      conversation.messages
        .filter((message) => !message.internal || Boolean(message.text))
        .map((message) => ({
        id: message.id,
        at: message.createdAt,
        kind: "message" as const,
        type: message.direction === "inbound" ? "message.inbound" : "message.outbound",
        title: message.internal
          ? "Внутренняя заметка"
          : message.senderKind === "client"
            ? "Клиент"
            : message.senderKind === "ai"
              ? "AI"
              : message.senderKind === "staff" || message.senderKind === "user"
                ? "Менеджер"
                : "Система",
        description: message.text,
        actorType: message.senderKind,
      })),
    ),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, 80)
    .map((item) => ({ ...item, atLabel: formatWhen(item.at, timeZone) }));

  const overdueTask = openTasks.find((item) => item.dueAt && item.dueAt.getTime() < now.getTime());
  const control = {
    ownerName: contact.owner?.user?.name || null,
    ownerMembershipId: contact.ownerMembershipId,
    nextAction: nextTask
      ? {
          id: nextTask.id,
          title: nextTask.title,
          type: nextTask.type,
          typeLabel: TASK_TYPE_LABEL[nextTask.type] || nextTask.type,
          dueAt: nextTask.dueAt,
          dueLabel: formatWhen(nextTask.dueAt, timeZone),
          overdue: Boolean(nextTask.dueAt && nextTask.dueAt.getTime() < now.getTime()),
          overdueHours: nextTask.dueAt ? Math.max(0, Math.floor((now.getTime() - nextTask.dueAt.getTime()) / 3600000)) : null,
          description: nextTask.description,
        }
      : null,
    nextStepText: currentInquiry?.nextStep || null,
    lastContactAt: contact.lastContactAt || contact.lastSeenAt,
    lastContactLabel: formatWhen(contact.lastContactAt || contact.lastSeenAt, timeZone),
    lastWriter: lastWho,
    lastWriterLabel: lastWho === "client" ? "Клиент" : lastWho === "team" ? "Команда" : "Неизвестно",
    needsReply: waitingReply,
    waitMinutes: waitingReply ? minutesAgo(contact.lastInboundMessageAt, now) : null,
    aiMode,
    aiModeLabel:
      aiMode === "AUTO" ? "AI активен" : aiMode === "HUMAN" ? "Передано человеку" : aiMode === "DISABLED" ? "AI на паузе" : "Не задан",
    attentionReason: contact.conversations[0]?.attentionReason || currentInquiry?.attentionReason || null,
    overdue: Boolean(overdueTask),
    missingNextAction: Boolean(
      currentInquiry &&
        ACTIVE_INQUIRY.includes(currentInquiry.status) &&
        !nextTask &&
        !currentInquiry.nextStep,
    ),
  };

  return {
    asOf: now.toISOString(),
    client: {
      id: contact.id,
      name: displayName(contact),
      firstName: contact.firstName,
      lastName: contact.lastName,
      middleName: contact.middleName,
      companyName: contact.companyName,
      jobTitle: contact.jobTitle,
      city: contact.city,
      country: contact.country,
      language: contact.language,
      phone: phone?.rawValue || null,
      phoneNormalized: phone?.normalizedValue || null,
      email,
      methods: contact.methods,
      identities: contact.identities,
      lifecycleStatus: contact.lifecycleStatus,
      lifecycleLabel: LIFECYCLE_LABEL[contact.lifecycleStatus] || contact.lifecycleStatus,
      leadTemperature: contact.leadTemperature,
      temperatureLabel: TEMP_LABEL[contact.leadTemperature] || contact.leadTemperature,
      leadScore: contact.leadScore,
      summary,
      interest: interest?.text || null,
      interestSource: interest?.source || null,
      interestMessageId: interest?.messageId || null,
      firstSeenAt: contact.firstSeenAt,
      lastSeenAt: contact.lastSeenAt,
      lastInboundMessageAt: contact.lastInboundMessageAt,
      lastOutboundMessageAt: contact.lastOutboundMessageAt,
      lastContactAt: contact.lastContactAt,
      firstContactLabel: formatWhen(contact.firstSeenAt, timeZone),
      lastInboundLabel: formatWhen(contact.lastInboundMessageAt, timeZone),
      lastOutboundLabel: formatWhen(contact.lastOutboundMessageAt, timeZone),
      lastContactLabel: formatWhen(contact.lastContactAt || contact.lastSeenAt, timeZone),
      archivedAt: contact.archivedAt,
      version: contact.version,
    },
    companies: companyLinks.map((l) => ({
      linkId: l.id,
      position: l.position,
      department: l.department,
      isPrimary: l.isPrimary,
      isDecisionMaker: l.isDecisionMaker,
      isBillingContact: l.isBillingContact,
      company: l.company,
      href: `/companies/${l.company.id}`,
    })),
    attribution,
    currentRequest: currentInquiry
      ? {
          id: currentInquiry.id,
          title: currentInquiry.subject || currentInquiry.service || "Заявка",
          description: currentInquiry.description,
          service: currentInquiry.service,
          status: currentInquiry.status,
          statusLabel: INQUIRY_STATUS_LABEL[currentInquiry.status] || currentInquiry.status,
          budgetLabel: budgetLabel(currentInquiry),
          budgetMin: currentInquiry.budgetMin,
          budgetMax: currentInquiry.budgetMax,
          currency: currentInquiry.currency,
          desiredDeadline: currentInquiry.desiredDeadline,
          priority: currentInquiry.priority,
          nextStep: currentInquiry.nextStep,
          lostReason: currentInquiry.lostReason,
          lostComment: currentInquiry.lostComment,
          fieldMeta: currentInquiry.fieldMetaJson,
          assigneeName: currentInquiry.assignee?.user?.name || null,
          receivedAt: currentInquiry.receivedAt,
          receivedLabel: formatWhen(currentInquiry.receivedAt, timeZone),
        }
      : null,
    control,
    tags: contact.tags.map((item) => ({ id: item.tag.id, name: item.tag.name })),
    notes: contact.notes.map((item) => ({
      id: item.id,
      text: item.text,
      pinned: item.pinned,
      createdAt: item.createdAt,
      createdLabel: formatWhen(item.createdAt, timeZone),
    })),
    requests: contact.inquiries.map((item) => ({
      id: item.id,
      title: item.subject || item.service || "Заявка",
      status: item.status,
      statusLabel: INQUIRY_STATUS_LABEL[item.status] || item.status,
      receivedLabel: formatWhen(item.receivedAt, timeZone),
      closed: CLOSED_INQUIRY.includes(item.status),
    })),
    conversations: (() => {
      const hasLiveWhatsApp = contact.conversations.some((item) => item.sellerLeadId);
      const threadLast = contact.conversations
        .flatMap((item) => item.messages)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      return contact.conversations
        .filter((item) => item.sellerLeadId || item.attentionReason !== "seller_lead_rematched" || !hasLiveWhatsApp)
        .map((item) => ({
          id: item.id,
          mode: item.mode,
          channel: item.sellerLeadId ? "WhatsApp" : "Диалог",
          updatedLabel: formatWhen(item.updatedAt, timeZone),
          lastMessage: item.messages[0]?.text || threadLast?.text || null,
          needsAttention: item.needsAttention,
          sellerLeadId: item.sellerLeadId,
        }));
    })(),
    deals: contact.deals.map((item) => ({
      id: item.id,
      title: item.title,
      stage: item.stage?.name || null,
      outcome: item.outcome,
      amountMinor: item.offerAmountMinor,
      currency: item.currency,
      createdLabel: formatWhen(item.createdAt, timeZone),
      expectedCloseLabel: formatWhen(item.expectedCloseAt, timeZone),
      assigneeName: item.assignee?.user?.name || null,
    })),
    tasks: contact.tasks.map((item) => ({
      id: item.id,
      title: item.title,
      type: item.type,
      typeLabel: TASK_TYPE_LABEL[item.type] || item.type,
      status: item.status,
      dueAt: item.dueAt,
      dueLabel: formatWhen(item.dueAt, timeZone),
      overdue: Boolean(item.dueAt && item.dueAt.getTime() < now.getTime() && (item.status === "open" || item.status === "waiting")),
      ownerName: item.owner?.user?.name || null,
    })),
    timeline,
    statistics: {
      inquiryCount: contact.inquiries.length,
      openTaskCount: openTasks.length,
      dealCount: contact.deals.length,
      conversationCount: contact.conversations.length,
    },
    gaps: dataGaps({
      name: displayName(contact),
      phone: phone?.rawValue || null,
      inquiry: currentInquiry,
      ownerId: contact.ownerMembershipId,
      nextTask,
    }),
    members: await prisma.membership.findMany({
      where: { tenantId: tid, active: true },
      include: { user: true },
      take: 40,
    }).then((rows) => rows.map((row) => ({ id: row.id, name: row.user.name, role: row.role }))),
  };
}

export async function createContact(
  prisma: PrismaClient,
  auth: AuthContext,
  input: { name: string; phone?: string; source?: string; comment?: string; companyName?: string; forceCreate?: boolean },
) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const name = String(input.name || "").trim();
  if (!name) throw new ApiError(422, "invalid", "Укажите имя", { name: "Обязательно" });
  let phoneRaw: string | null = null;
  let phoneNormalized: string | null = null;
  if (input.phone?.trim()) {
    const phone = validateClientPhone(input.phone, membership.tenant.defaultRegion);
    if (!phone.ok) throw new ApiError(422, phone.code, phone.message, { phone: phone.message });
    phoneRaw = phone.raw;
    phoneNormalized = phone.normalized;
    const existing = await prisma.contactMethod.findFirst({
      where: { tenantId: tid, type: "phone", normalizedValue: phoneNormalized },
    });
    if (existing) {
      if (!input.forceCreate) {
        const dup = await serializeDuplicateContact(prisma, tid, existing.contactId);
        throw new ApiError(409, "duplicate_phone", "Клиент с таким телефоном уже есть", { phone: existing.contactId }, {
          duplicates: dup ? [dup] : [],
        });
      }
    }
  }
  const source = String(input.source || "manual");
  const contact = await prisma.$transaction(async (tx) => {
    const created = await tx.contact.create({
      data: {
        tenantId: tid,
        name,
        companyName: input.companyName || null,
        language: "ru",
        lifecycleStatus: "new",
        ownerMembershipId: membership.id,
        lastContactAt: new Date(),
        attributionJson: { sourceType: source, source },
        methods: phoneRaw
          ? {
              create: {
                type: "phone",
                rawValue: phoneRaw,
                normalizedValue: phoneNormalized!,
                source,
                primary: true,
                confirmed: false,
              },
            }
          : undefined,
      },
    });
    await writeActivity(tx, {
      tenantId: tid,
      contactId: created.id,
      type: "contact.created",
      title: "Создан клиент",
      description: input.comment || null,
      actorType: "user",
      actorId: auth.user.id,
      metadata: { source },
    });
    if (input.comment?.trim()) {
      await tx.note.create({
        data: {
          tenantId: tid,
          parentType: "contact",
          parentId: created.id,
          contactId: created.id,
          authorUserId: auth.user.id,
          text: input.comment.trim(),
          internal: true,
        },
      });
    }
    return created;
  });
  return getContactOverview(prisma, auth, contact.id);
}

export async function updateContact(
  prisma: PrismaClient,
  auth: AuthContext,
  contactId: string,
  input: Record<string, unknown>,
) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const current = await prisma.contact.findFirst({ where: { id: contactId, tenantId: tid } });
  if (!current) throw new ApiError(404, "not_found", "Клиент не найден");
  if (isManager(auth)) throw new ApiError(403, "forbidden", "Недостаточно прав для изменения карточки");

  const data: Prisma.ContactUncheckedUpdateInput = {};
  for (const key of [
    "name",
    "firstName",
    "lastName",
    "middleName",
    "companyName",
    "jobTitle",
    "city",
    "country",
    "language",
    "summary",
    "lifecycleStatus",
    "leadTemperature",
  ] as const) {
    if (key in input) {
      const value = input[key];
      if (value != null && typeof value !== "string") throw new ApiError(422, "invalid", `Поле ${key} должно быть строкой`);
      if (key === "language" || key === "leadTemperature") data[key] = value || "unknown";
      else if (key === "lifecycleStatus") data[key] = value || "new";
      else data[key] = value || null;
    }
  }
  if ("ownerMembershipId" in input) {
    const ownerId = input.ownerMembershipId ? String(input.ownerMembershipId) : null;
    if (ownerId) {
      const owner = await prisma.membership.findFirst({ where: { id: ownerId, tenantId: tid, active: true } });
      if (!owner) throw new ApiError(422, "invalid", "Сотрудник не найден");
    }
    data.ownerMembershipId = ownerId;
  }
  if ("leadScore" in input) {
    data.leadScore = input.leadScore == null || input.leadScore === "" ? null : Number(input.leadScore);
  }
  if ("archived" in input) {
    data.archivedAt = input.archived ? new Date() : null;
    if (input.archived) data.lifecycleStatus = "archived";
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.contact.update({ where: { id: contactId }, data });
    if ("ownerMembershipId" in input && String(input.ownerMembershipId || "") !== String(current.ownerMembershipId || "")) {
      await writeActivity(tx, {
        tenantId: tid,
        contactId,
        type: "contact.owner_changed",
        title: "Сменён ответственный",
        actorType: "user",
        actorId: auth.user.id,
        metadata: { from: current.ownerMembershipId, to: input.ownerMembershipId },
      });
    }
    if ("lifecycleStatus" in input && input.lifecycleStatus !== current.lifecycleStatus) {
      await writeActivity(tx, {
        tenantId: tid,
        contactId,
        type: "contact.status_changed",
        title: `Статус: ${LIFECYCLE_LABEL[String(input.lifecycleStatus)] || input.lifecycleStatus}`,
        actorType: "user",
        actorId: auth.user.id,
        metadata: { from: current.lifecycleStatus, to: input.lifecycleStatus },
      });
    }
    await tx.auditEvent.create({
      data: {
        tenantId: tid,
        actorUserId: auth.user.id,
        action: "contact.update",
        entityType: "contact",
        entityId: contactId,
        changesJson: input as Prisma.InputJsonValue,
      },
    });
    return row;
  });
  void updated;
  return getContactOverview(prisma, auth, contactId);
}

const BLOCKING_INVOICE_STATUSES = ["ISSUED", "PARTIALLY_PAID", "PAID", "OVERDUE"] as const;
const SIGNED_CONTRACT_STATUSES = ["SIGNED", "PARTIALLY_SIGNED"] as const;

export async function deleteContact(prisma: PrismaClient, auth: AuthContext, contactId: string) {
  requireCompanyAdmin(auth, "Удалить клиента может только владелец или директор компании");
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, tenantId: tid },
    select: { id: true, name: true },
  });
  if (!contact) throw new ApiError(404, "not_found", "Клиент не найден");

  const deals = await prisma.deal.findMany({ where: { tenantId: tid, contactId }, select: { id: true } });
  const dealIds = deals.map((row) => row.id);
  if (dealIds.length) {
    const [issuedInvoices, signedContracts, electronicDocuments] = await Promise.all([
      prisma.invoice.count({
        where: { tenantId: tid, dealId: { in: dealIds }, status: { in: [...BLOCKING_INVOICE_STATUSES] } },
      }),
      prisma.contract.count({
        where: {
          tenantId: tid,
          dealId: { in: dealIds },
          OR: [{ signedAt: { not: null } }, { status: { in: [...SIGNED_CONTRACT_STATUSES] } }],
        },
      }),
      prisma.electronicDocument.count({ where: { tenantId: tid, dealId: { in: dealIds } } }),
    ]);
    if (issuedInvoices || signedContracts || electronicDocuments) {
      throw new ApiError(
        409,
        "contact_has_documents",
        "Нельзя удалить клиента: есть выставленные счета, подписанные договоры или ЭСФ. Архивируйте карточку.",
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    const inquiries = await tx.inquiry.findMany({ where: { tenantId: tid, contactId }, select: { id: true } });
    const inquiryIds = inquiries.map((row) => row.id);
    const conversations = await tx.conversation.findMany({
      where: { tenantId: tid, contactId },
      select: { id: true },
    });
    const conversationIds = conversations.map((row) => row.id);

    await tx.campaignRecipient.updateMany({
      where: { tenantId: tid, contactId },
      data: { contactId: null, conversationId: null },
    });
    await tx.note.deleteMany({ where: { tenantId: tid, contactId } });
    await tx.task.updateMany({
      where: { tenantId: tid, contactId },
      data: { contactId: null },
    });
    if (inquiryIds.length) {
      await tx.task.updateMany({ where: { tenantId: tid, inquiryId: { in: inquiryIds } }, data: { inquiryId: null } });
      await tx.agreement.updateMany({
        where: { tenantId: tid, inquiryId: { in: inquiryIds } },
        data: { inquiryId: null },
      });
      await tx.incompleteIntake.updateMany({
        where: { tenantId: tid, inquiryId: { in: inquiryIds } },
        data: { inquiryId: null },
      });
    }
    if (dealIds.length) {
      await tx.task.updateMany({ where: { tenantId: tid, dealId: { in: dealIds } }, data: { dealId: null } });
      await tx.agreement.updateMany({ where: { tenantId: tid, dealId: { in: dealIds } }, data: { dealId: null } });
    }
    await tx.agreement.updateMany({
      where: { tenantId: tid, contactId },
      data: { contactId: null, conversationId: null },
    });
    await tx.incompleteIntake.updateMany({
      where: { tenantId: tid, contactId },
      data: { contactId: null, conversationId: null },
    });

    if (conversationIds.length) {
      const messages = await tx.message.findMany({
        where: { tenantId: tid, conversationId: { in: conversationIds } },
        select: { id: true },
      });
      const messageIds = messages.map((row) => row.id);
      if (messageIds.length) {
        await tx.messageStatusEvent.updateMany({
          where: { tenantId: tid, messageId: { in: messageIds } },
          data: { messageId: null },
        });
        await tx.attachment.updateMany({
          where: { tenantId: tid, messageId: { in: messageIds } },
          data: { messageId: null },
        });
      }
      await tx.outboundOperation.deleteMany({ where: { tenantId: tid, conversationId: { in: conversationIds } } });
      await tx.inquiry.updateMany({
        where: { tenantId: tid, conversationId: { in: conversationIds } },
        data: { conversationId: null },
      });
      await tx.incompleteIntake.updateMany({
        where: { tenantId: tid, conversationId: { in: conversationIds } },
        data: { conversationId: null },
      });
      await tx.agreement.updateMany({
        where: { tenantId: tid, conversationId: { in: conversationIds } },
        data: { conversationId: null },
      });
      await tx.dealConversation.deleteMany({
        where: { tenantId: tid, conversationId: { in: conversationIds } },
      });
      await tx.conversation.deleteMany({ where: { tenantId: tid, id: { in: conversationIds } } });
    }

    await tx.inquiry.updateMany({
      where: { tenantId: tid, contactId },
      data: { dealId: null, conversationId: null },
    });
    if (dealIds.length) {
      await tx.deal.updateMany({ where: { tenantId: tid, id: { in: dealIds } }, data: { inquiryId: null } });
    }
    await tx.inquiry.deleteMany({ where: { tenantId: tid, contactId } });

    if (dealIds.length) {
      await tx.invoice.deleteMany({ where: { tenantId: tid, dealId: { in: dealIds } } });
      await tx.contract.deleteMany({ where: { tenantId: tid, dealId: { in: dealIds } } });
      await tx.deal.deleteMany({ where: { tenantId: tid, id: { in: dealIds } } });
    }

    await tx.auditEvent.create({
      data: {
        tenantId: tid,
        actorUserId: auth.user.id,
        action: "contact.delete",
        entityType: "contact",
        entityId: contactId,
        changesJson: { name: contact.name } as Prisma.InputJsonValue,
      },
    });
    await tx.contact.delete({ where: { id: contactId } });
  });

  return { ok: true, id: contactId };
}

export async function addContactNote(
  prisma: PrismaClient,
  auth: AuthContext,
  contactId: string,
  input: { text: string; pinned?: boolean },
) {
  const membership = requireTenant(auth);
  const contact = await prisma.contact.findFirst({ where: { id: contactId, tenantId: membership.tenantId } });
  if (!contact) throw new ApiError(404, "not_found", "Клиент не найден");
  const text = String(input.text || "").trim();
  if (!text) throw new ApiError(422, "invalid", "Текст заметки пуст");
  await prisma.$transaction(async (tx) => {
    await tx.note.create({
      data: {
        tenantId: membership.tenantId,
        parentType: "contact",
        parentId: contactId,
        contactId,
        authorUserId: auth.user.id,
        text,
        internal: true,
        pinned: Boolean(input.pinned),
      },
    });
    await writeActivity(tx, {
      tenantId: membership.tenantId,
      contactId,
      type: "note.created",
      title: input.pinned ? "Закреплённая заметка" : "Заметка менеджера",
      description: text,
      actorType: "user",
      actorId: auth.user.id,
    });
  });
  return getContactOverview(prisma, auth, contactId);
}

export async function addContactTag(prisma: PrismaClient, auth: AuthContext, contactId: string, name: string) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const contact = await prisma.contact.findFirst({ where: { id: contactId, tenantId: tid } });
  if (!contact) throw new ApiError(404, "not_found", "Клиент не найден");
  const tagName = String(name || "").trim();
  if (!tagName) throw new ApiError(422, "invalid", "Укажите тег");
  await prisma.$transaction(async (tx) => {
    const tag = await tx.tag.upsert({
      where: { tenantId_name: { tenantId: tid, name: tagName } },
      update: {},
      create: { tenantId: tid, name: tagName },
    });
    await tx.contactTag.upsert({
      where: { tenantId_contactId_tagId: { tenantId: tid, contactId, tagId: tag.id } },
      update: {},
      create: { tenantId: tid, contactId, tagId: tag.id },
    });
  });
  return getContactOverview(prisma, auth, contactId);
}

export async function removeContactTag(prisma: PrismaClient, auth: AuthContext, contactId: string, tagId: string) {
  const membership = requireTenant(auth);
  await prisma.contactTag.deleteMany({
    where: { tenantId: membership.tenantId, contactId, tagId },
  });
  return getContactOverview(prisma, auth, contactId);
}

export async function listContactActivities(
  prisma: PrismaClient,
  auth: AuthContext,
  contactId: string,
  query: Record<string, string | undefined> = {},
) {
  const membership = requireTenant(auth);
  const take = Math.min(100, Number(query.limit || 40) || 40);
  const items = await prisma.activity.findMany({
    where: { tenantId: membership.tenantId, contactId },
    orderBy: { createdAt: "desc" },
    take,
  });
  return { items };
}

/** Keep old export name for app.ts compatibility during transition. */
export async function listContacts(prisma: PrismaClient, auth: AuthContext) {
  const board = await listContactsBoard(prisma, auth, {});
  return board.items;
}

export async function findContactDuplicates(
  prisma: PrismaClient,
  auth: AuthContext,
  input: { phone?: string; name?: string; excludeId?: string },
) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const or: Prisma.ContactWhereInput[] = [];
  if (input.phone?.trim()) {
    const phone = validateClientPhone(input.phone, membership.tenant.defaultRegion);
    if (phone.ok) {
      const existing = await prisma.contactMethod.findMany({
        where: { tenantId: tid, type: "phone", normalizedValue: phone.normalized },
        select: { contactId: true },
        take: 10,
      });
      if (existing.length) or.push({ id: { in: existing.map((item) => item.contactId) } });
    }
  }
  const name = String(input.name || "").trim();
  if (name.length >= 4) {
    or.push({ name: { contains: name, mode: "insensitive" } });
  }
  if (!or.length) return { duplicates: [] as Awaited<ReturnType<typeof serializeDuplicateContact>>[] };
  const rows = await prisma.contact.findMany({
    where: {
      tenantId: tid,
      archivedAt: null,
      ...(input.excludeId ? { id: { not: input.excludeId } } : {}),
      OR: or,
    },
    include: { methods: true, deals: { where: { outcome: "open" }, select: { id: true } } },
    take: 10,
  });
  return {
    duplicates: rows.map((contact) => ({
      id: contact.id,
      name: displayName(contact),
      phone: primaryPhone(contact.methods)?.rawValue || null,
      companyName: contact.companyName,
      activeDealsCount: contact.deals.length,
      href: `/contacts/${contact.id}`,
    })),
  };
}

export async function mergeContacts(
  prisma: PrismaClient,
  auth: AuthContext,
  input: { keepId: string; mergeId: string },
) {
  requireCompanyAdmin(auth, "Объединять клиентов может администратор или директор");
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  if (input.keepId === input.mergeId) throw new ApiError(422, "invalid", "Нужны два разных клиента");
  const [keep, source] = await Promise.all([
    prisma.contact.findFirst({ where: { id: input.keepId, tenantId: tid } }),
    prisma.contact.findFirst({
      where: { id: input.mergeId, tenantId: tid },
      include: { methods: true },
    }),
  ]);
  if (!keep || !source) throw new ApiError(404, "not_found", "Клиент не найден");

  await prisma.$transaction(async (tx) => {
    const keepMethods = await tx.contactMethod.findMany({ where: { tenantId: tid, contactId: keep.id } });
    const keepKeys = new Set(keepMethods.map((item) => `${item.type}:${item.normalizedValue}`));
    for (const method of source.methods) {
      const key = `${method.type}:${method.normalizedValue}`;
      if (keepKeys.has(key)) {
        await tx.contactMethod.delete({ where: { id: method.id } });
        continue;
      }
      await tx.contactMethod.update({ where: { id: method.id }, data: { contactId: keep.id } });
      keepKeys.add(key);
    }

    await tx.inquiry.updateMany({ where: { tenantId: tid, contactId: source.id }, data: { contactId: keep.id } });
    await tx.deal.updateMany({ where: { tenantId: tid, contactId: source.id }, data: { contactId: keep.id } });
    await tx.conversation.updateMany({ where: { tenantId: tid, contactId: source.id }, data: { contactId: keep.id } });
    await tx.task.updateMany({ where: { tenantId: tid, contactId: source.id }, data: { contactId: keep.id } });
    await tx.note.updateMany({ where: { tenantId: tid, contactId: source.id }, data: { contactId: keep.id } });
    await tx.activity.updateMany({ where: { tenantId: tid, contactId: source.id }, data: { contactId: keep.id } });
    await tx.externalIdentity.updateMany({ where: { tenantId: tid, contactId: source.id }, data: { contactId: keep.id } });
    await tx.contactFact.updateMany({ where: { tenantId: tid, contactId: source.id }, data: { contactId: keep.id } });
    await tx.contactPermission.updateMany({ where: { tenantId: tid, contactId: source.id }, data: { contactId: keep.id } });
    await tx.agreement.updateMany({ where: { tenantId: tid, contactId: source.id }, data: { contactId: keep.id } });
    await tx.campaignRecipient.updateMany({ where: { tenantId: tid, contactId: source.id }, data: { contactId: keep.id } });
    await tx.incompleteIntake.updateMany({ where: { tenantId: tid, contactId: source.id }, data: { contactId: keep.id } });

    const sourceCompanies = await tx.companyContact.findMany({ where: { tenantId: tid, contactId: source.id } });
    for (const link of sourceCompanies) {
      const exists = await tx.companyContact.findFirst({
        where: { tenantId: tid, companyId: link.companyId, contactId: keep.id },
      });
      if (exists) await tx.companyContact.delete({ where: { id: link.id } });
      else await tx.companyContact.update({ where: { id: link.id }, data: { contactId: keep.id } });
    }
    const sourceDealContacts = await tx.dealContact.findMany({ where: { tenantId: tid, contactId: source.id } });
    for (const link of sourceDealContacts) {
      const exists = await tx.dealContact.findFirst({
        where: { tenantId: tid, dealId: link.dealId, contactId: keep.id },
      });
      if (exists) await tx.dealContact.delete({ where: { id: link.id } });
      else await tx.dealContact.update({ where: { id: link.id }, data: { contactId: keep.id } });
    }
    const sourceTags = await tx.contactTag.findMany({ where: { tenantId: tid, contactId: source.id } });
    for (const tag of sourceTags) {
      const exists = await tx.contactTag.findFirst({
        where: { tenantId: tid, contactId: keep.id, tagId: tag.tagId },
      });
      if (exists) await tx.contactTag.delete({ where: { id: tag.id } });
      else await tx.contactTag.update({ where: { id: tag.id }, data: { contactId: keep.id } });
    }

    await tx.contact.update({
      where: { id: source.id },
      data: { archivedAt: new Date(), name: `${source.name} (объединён)` },
    });
    await writeActivity(tx, {
      tenantId: tid,
      contactId: keep.id,
      type: "contact.merged",
      title: "Клиенты объединены",
      description: source.name,
      actorType: "user",
      actorId: auth.user.id,
      metadata: { mergedId: source.id },
    });
    await writeAudit(tx, {
      tenantId: tid,
      actorUserId: auth.user.id,
      action: "contact.merge",
      entityType: "contact",
      entityId: keep.id,
      changes: { keepId: keep.id, mergeId: source.id, mergeName: source.name },
    });
  });

  return getContactOverview(prisma, auth, keep.id);
}

export async function importContacts(
  prisma: PrismaClient,
  auth: AuthContext,
  input: { fileName: string; contentBase64: string; mapping?: Record<string, "name" | "phone" | "company" | "email" | "service" | "comment" | "skip"> },
) {
  requireTenant(auth);
  const { parseContactImportFile } = await import("./contactImportParse.ts");
  const parsed = parseContactImportFile(input.fileName, input.contentBase64, input.mapping);
  const created: string[] = [];
  const skipped: Array<{ row: number; reason: string; existingId?: string }> = [];
  const errors: Array<{ row: number; message: string }> = [];
  for (const row of parsed.rows) {
    const name = row.mapped.name || row.mapped.phone || "Клиент";
    if (!row.mapped.phone && !row.mapped.name) {
      errors.push({ row: row.rowIndex, message: "Нет имени и телефона" });
      continue;
    }
    try {
      const createdContact = await createContact(prisma, auth, {
        name,
        phone: row.mapped.phone,
        companyName: row.mapped.company,
        comment: row.mapped.comment,
        source: "import",
      });
      created.push(createdContact.client.id);
    } catch (err) {
      if (err instanceof ApiError && err.code === "duplicate_phone") {
        const existingId = (err.details as { duplicates?: Array<{ id: string }> } | undefined)?.duplicates?.[0]?.id
          || err.fieldErrors?.phone;
        skipped.push({ row: row.rowIndex, reason: "уже есть в CRM", existingId });
        continue;
      }
      errors.push({ row: row.rowIndex, message: err instanceof Error ? err.message : "Не импортировано" });
    }
  }
  return {
    created: created.length,
    skipped: skipped.length,
    errors: errors.length,
    createdIds: created.slice(0, 50),
    skippedRows: skipped.slice(0, 50),
    errorRows: errors.slice(0, 50),
  };
}

function csvCell(value: string | null | undefined) {
  const text = String(value || "");
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export async function exportContacts(prisma: PrismaClient, auth: AuthContext) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const ownerFilter = isManager(auth) ? { ownerMembershipId: membership.id } : {};
  const rows = await prisma.contact.findMany({
    where: { tenantId: tid, archivedAt: null, ...ownerFilter },
    include: { methods: true },
    orderBy: { lastSeenAt: "desc" },
    take: 3000,
  });
  const lines = ["name,phone,email,company,status,source"];
  for (const contact of rows) {
    const phone = contact.methods.find((item) => item.type === "phone");
    const email = contact.methods.find((item) => item.type === "email");
    const source =
      contact.attributionJson && typeof contact.attributionJson === "object"
        ? String((contact.attributionJson as { source?: string }).source || "")
        : "";
    lines.push(
      [
        csvCell(contact.name),
        csvCell(phone?.rawValue || phone?.normalizedValue),
        csvCell(email?.rawValue || email?.normalizedValue),
        csvCell(contact.companyName),
        csvCell(contact.lifecycleStatus),
        csvCell(source),
      ].join(","),
    );
  }
  return { filename: "clients.csv", count: rows.length, csv: `${lines.join("\n")}\n` };
}
