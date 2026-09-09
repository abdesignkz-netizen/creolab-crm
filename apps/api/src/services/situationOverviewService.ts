import type { PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { getSituation, type SituationItem, type SituationScope } from "./situationService.ts";
import {
  conversationsAttentionWhere,
  conversationsHumanWhere,
  countContactsNeedsReply,
  countVisibleConversations,
  overdueTasksWhere,
} from "./attentionCounts.ts";
import { ensureDealPipelineStages, flagsForDeal } from "./dealService.ts";
import { openIntakeWhere } from "./inquiryAttention.ts";
import { CONTACT_PHONE_SELECT, displayName, phoneFromContact } from "./contactLabels.ts";
import { PIPELINE_STAGES, parseOpsSettings } from "./dealPipeline.ts";
import {
  addDaysYmd,
  periodLabel,
  resolvePeriodRange,
  type PeriodPreset,
  zonedLocalToUtc,
  zonedYmd,
} from "./periodRange.ts";

export type { PeriodPreset } from "./periodRange.ts";
export { resolvePeriodRange } from "./periodRange.ts";

function mapAgreementSit(a: {
  id: string;
  type: string;
  title: string;
  status: string;
  scheduledAt: Date | null;
  clarificationNeeded: string | null;
  meetingUrl: string | null;
  locationName: string | null;
  address: string | null;
  contact: {
    id: string;
    name: string | null;
    firstName: string | null;
    lastName: string | null;
    methods?: Array<{ type: string; rawValue?: string | null; normalizedValue?: string | null; primary?: boolean }>;
  } | null;
  inquiry: { id: string; subject: string | null; service: string | null } | null;
  deal: { id: string; title: string; stage: { name: string } | null } | null;
  task: { id: string; status: string } | null;
}) {
  const contactName = a.contact ? displayName(a.contact) : null;
  return {
    id: a.id,
    type: a.type,
    title: a.title,
    status: a.status,
    scheduledAt: a.scheduledAt?.toISOString() || null,
    clarificationNeeded: a.clarificationNeeded,
    meetingUrl: a.meetingUrl,
    locationName: a.locationName,
    address: a.address,
    contactName,
    phone: phoneFromContact(a.contact),
    inquiryTitle: a.inquiry?.subject || a.inquiry?.service || null,
    dealTitle: a.deal?.title || null,
    dealStage: a.deal?.stage?.name || null,
    taskId: a.task?.id || null,
    href: a.task?.id ? "/tasks" : a.contact?.id ? `/contacts/${a.contact.id}` : "/today",
    attention:
      a.clarificationNeeded ||
      (a.type === "ONLINE_MEETING" && !a.meetingUrl
        ? "Ссылка на встречу не добавлена"
        : a.type === "OFFLINE_MEETING" && !a.address && !a.locationName
          ? "Не указано место"
          : null),
  };
}

function summarizeAgreementTypes(
  items: Array<{ type: string }>,
): Array<{ type: string; label: string; count: number }> {
  const labels: Record<string, string> = {
    CALL: "Телефонные созвоны",
    ONLINE_MEETING: "Онлайн-встречи",
    OFFLINE_MEETING: "Личные встречи",
    FOLLOW_UP: "Follow-up",
    SEND_PROPOSAL: "Отправить КП",
    SEND_CONTRACT: "Отправить договор",
    PAYMENT_PROMISE: "Проверить оплату",
  };
  const map = new Map<string, number>();
  for (const item of items) {
    map.set(item.type, (map.get(item.type) || 0) + 1);
  }
  return [...map.entries()].map(([type, count]) => ({
    type,
    label: labels[type] || type,
    count,
  }));
}

const BUSINESS_ACTIVITY_TYPES = [
  "inquiry.created",
  "inquiry.converted",
  "inquiry.lost",
  "deal.won",
  "deal.lost",
  "deal.created",
  "payment.confirm",
  "task.completed",
  "task.auto_created",
  "agreement.upserted",
  "agreement.rescheduled",
  "agreement.cancelled",
  "conversation.escalated",
];

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership;
}

function amountNumber(value: { toString(): string } | null | undefined): number | null {
  if (value == null) return null;
  const n = Number(value.toString());
  return Number.isFinite(n) ? n : null;
}

function formatMoneyKzt(amount: number | null, currency: string) {
  if (amount == null) return null;
  return `${Math.round(amount).toLocaleString("ru-RU")} ${currency === "KZT" ? "₸" : currency}`;
}

function delta(current: number, previous: number | null) {
  if (previous == null) return null;
  return current - previous;
}

function deltaPercent(current: number, previous: number | null) {
  if (previous == null || previous === 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

const SOURCE_LABELS: Record<string, string> = {
  manual: "Ручное добавление",
  website_form: "Форма сайта",
  website_ai: "Website AI",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  instagram: "Instagram",
  phone: "Звонок",
  api: "API",
  other: "Другое",
};

const SOURCE_ALIASES: Record<string, string[]> = {
  manual: ["manual"],
  website_form: ["website_form", "website", "form"],
  website_ai: ["website_ai"],
  whatsapp: ["whatsapp"],
  telegram: ["telegram"],
  instagram: ["instagram"],
  phone: ["phone", "phone_call"],
  api: ["api", "webhook"],
  other: ["other"],
};

function normalizeSourceKey(raw: string | null | undefined) {
  const value = (raw || "").trim().toLowerCase();
  if (!value) return "unspecified";
  const found = Object.entries(SOURCE_ALIASES).find(([, aliases]) => aliases.includes(value));
  return found?.[0] || value;
}

function sourceLabel(key: string) {
  if (key === "unspecified") return "Не указан";
  return SOURCE_LABELS[key] || key;
}

function ruCount(n: number, one: string, few: string, many: string) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}

type PipelineStageRow = { systemKey: string; name: string; count: number; href: string };

function enrichPipelineStages(stages: PipelineStageRow[]) {
  const total = stages.reduce((sum, stage) => sum + stage.count, 0);
  const enriched = stages.map((stage, index) => {
    const next = stages[index + 1];
    return {
      ...stage,
      share: total > 0 ? Math.round((stage.count / total) * 100) : 0,
      toNextRate: next && stage.count > 0 && next.count > 0 ? Math.round((next.count / stage.count) * 100) : null,
      dropOff: next ? stage.count - next.count : null,
    };
  });
  let biggestDrop: {
    fromKey: string;
    fromName: string;
    toKey: string;
    toName: string;
    fromCount: number;
    toCount: number;
    lost: number;
  } | null = null;
  for (let i = 0; i < enriched.length - 1; i += 1) {
    const lost = enriched[i].dropOff;
    if (lost == null || lost <= 0 || enriched[i].count < 2) continue;
    if (!biggestDrop || lost > biggestDrop.lost) {
      biggestDrop = {
        fromKey: enriched[i].systemKey,
        fromName: enriched[i].name,
        toKey: enriched[i + 1].systemKey,
        toName: enriched[i + 1].name,
        fromCount: enriched[i].count,
        toCount: enriched[i + 1].count,
        lost,
      };
    }
  }
  return { stages: enriched, biggestDrop };
}

type SituationInsight = { text: string; href?: string; tone: "critical" | "attention" | "observe" };

function buildInsights(input: {
  needsReply: number;
  overdueTasks: number;
  stalledDeals: number;
  needsHuman: number;
  newInquiries: number;
  inquiries: number;
  prevInquiries: number | null;
  conversionRate: number | null;
  prevConversionRate: number | null;
  biggestDrop: { fromName: string; toName: string; lost: number; fromCount: number; toCount: number } | null;
  topManager: { name: string; attention: number; average: number } | null;
  bestSource: { label: string; rate: number; inquiries: number } | null;
}): SituationInsight[] {
  const insights: SituationInsight[] = [];
  if (input.needsReply > 0) {
    insights.push({
      tone: "critical",
      text: `${ruCount(input.needsReply, "клиент ждёт", "клиента ждут", "клиентов ждут")} ответа.`,
      href: "/contacts?filter=needs_reply",
    });
  }
  if (input.needsHuman > 0) {
    insights.push({
      tone: "critical",
      text: `${ruCount(input.needsHuman, "диалог требует", "диалога требуют", "диалогов требуют")} вмешательства человека.`,
      href: "/conversations?filter=attention",
    });
  }
  if (input.overdueTasks > 0) {
    insights.push({
      tone: "attention",
      text: `${ruCount(input.overdueTasks, "просроченная задача", "просроченные задачи", "просроченных задач")}.`,
      href: "/tasks?filter=overdue",
    });
  }
  if (input.stalledDeals > 0) {
    insights.push({
      tone: "attention",
      text: `${ruCount(input.stalledDeals, "сделка без активности", "сделки без активности", "сделок без активности")}.`,
      href: "/deals?focus=stalled",
    });
  }
  if (input.newInquiries > 0) {
    insights.push({
      tone: "attention",
      text: `${ruCount(input.newInquiries, "заявка ещё не обработана", "заявки ещё не обработаны", "заявок ещё не обработаны")}.`,
      href: "/inquiries?filter=new&test=false",
    });
  }
  if (input.biggestDrop) {
    insights.push({
      tone: "observe",
      text: `Наибольшая потеря сейчас между «${input.biggestDrop.fromName}» и «${input.biggestDrop.toName}» (${input.biggestDrop.fromCount} → ${input.biggestDrop.toCount}).`,
      href: "#funnel",
    });
  }
  if (input.prevInquiries != null && input.prevInquiries >= 3 && input.inquiries < input.prevInquiries * 0.7) {
    const pct = Math.round((1 - input.inquiries / input.prevInquiries) * 100);
    insights.push({
      tone: "observe",
      text: `Заявок на ${pct}% меньше, чем в прошлом периоде.`,
    });
  } else if (input.prevInquiries != null && input.prevInquiries >= 3 && input.inquiries > input.prevInquiries * 1.2) {
    const pct = Math.round((input.inquiries / input.prevInquiries - 1) * 100);
    insights.push({
      tone: "observe",
      text: `Заявок на ${pct}% больше, чем в прошлом периоде.`,
    });
  }
  if (
    input.conversionRate != null &&
    input.prevConversionRate != null &&
    input.prevInquiries != null &&
    input.prevInquiries >= 5 &&
    input.inquiries >= 5 &&
    input.prevConversionRate - input.conversionRate >= 10
  ) {
    insights.push({
      tone: "observe",
      text: `Конверсия снизилась с ${input.prevConversionRate}% до ${input.conversionRate}%.`,
    });
  }
  if (
    input.topManager &&
    input.topManager.attention >= 3 &&
    input.topManager.attention >= input.topManager.average * 2
  ) {
    insights.push({
      tone: "observe",
      text: `У ${input.topManager.name} повышенная нагрузка: ${input.topManager.attention} пунктов внимания.`,
      href: "#team",
    });
  }
  if (input.bestSource && input.bestSource.inquiries >= 3 && input.bestSource.rate > 0) {
    insights.push({
      tone: "observe",
      text: `Лучшая конверсия у источника «${input.bestSource.label}»: ${input.bestSource.rate}%.`,
      href: "#sources",
    });
  }
  return insights.slice(0, 5);
}

function buildBrief(facts: {
  periodLabel: string;
  inquiries: number;
  dealsCreated: number;
  wonDeals: number;
  wonAmountLabel: string | null;
  activeDeals: number;
  needsReply: number;
  overdueTasks: number;
  contractStage: number;
  noNextAction: number;
}) {
  const bits: string[] = [];
  bits.push(
    `${facts.periodLabel}: ${facts.inquiries} обращений, ${facts.dealsCreated} новых сделок, ${facts.wonDeals} продаж` +
      (facts.wonAmountLabel ? ` на ${facts.wonAmountLabel}` : "") +
      ".",
  );
  bits.push(
    `Сейчас в работе ${facts.activeDeals} сделок` +
      (facts.contractStage ? `, из них ${facts.contractStage} на согласовании` : "") +
      ".",
  );
  if (facts.needsReply || facts.overdueTasks || facts.noNextAction) {
    const alerts: string[] = [];
    if (facts.needsReply) alerts.push(`${facts.needsReply} ждут ответа`);
    if (facts.overdueTasks) alerts.push(`${facts.overdueTasks} задач просрочено`);
    if (facts.noNextAction) alerts.push(`${facts.noNextAction} без следующего шага`);
    bits.push(`Требует внимания: ${alerts.join(", ")}.`);
  } else {
    bits.push("Критических действий сейчас нет.");
  }
  return bits.join(" ");
}

function taskTypeBucket(type: string, title: string) {
  const t = `${type} ${title}`.toLowerCase();
  if (/звон|call|phone/.test(t)) return "Позвонить";
  if (/кп|proposal|коммерч|презентац/.test(t)) return "Отправить КП";
  if (/оплат|payment/.test(t)) return "Проверить оплату";
  if (/встреч|meeting/.test(t)) return "Встреча";
  if (/писат|whatsapp|telegram|сообщ|message|reply/.test(t)) return "Написать";
  return "Другое";
}

function attentionGroup(item: Pick<SituationItem, "kind" | "waitingReply">): string {
  if (item.kind === "contact_needs_reply" || (item.kind.startsWith("conversation_") && item.waitingReply)) {
    return "needs_reply";
  }
  if (item.kind === "task_overdue") return "overdue";
  if (item.kind === "missing_next_action") return "no_next_action";
  if (item.kind.startsWith("conversation_")) return "needs_human";
  if (item.kind === "needs_phone") return "no_contact";
  if (item.kind.startsWith("inquiry_")) return "inquiry";
  return "other";
}

export async function getSituationOverview(
  prisma: PrismaClient,
  auth: AuthContext,
  query: Record<string, string | undefined> = {},
) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const timeZone = membership.tenant.timezone || "Asia/Almaty";
  const currency = membership.tenant.currency || "KZT";
  const now = new Date();
  const tenantRow = await prisma.tenant.findUnique({ where: { id: tid } });
  const ops = parseOpsSettings(tenantRow?.settingsJson);
  await ensureDealPipelineStages(prisma, tid);

  const presetRaw = String(query.period || query.periodPreset || "today");
  const allowed: PeriodPreset[] = [
    "today",
    "yesterday",
    "last_7",
    "last_30",
    "this_month",
    "last_month",
    "this_year",
    "all",
    "custom",
  ];
  const preset = (allowed.includes(presetRaw as PeriodPreset) ? presetRaw : "today") as PeriodPreset;
  const scope = (query.scope === "mine" || query.scope === "unassigned" ? query.scope : "all") as SituationScope;
  const onlyImportant = query.onlyImportant === "1" || query.onlyImportant === "true";

  const range = resolvePeriodRange(timeZone, preset, query.dateFrom || query.from, query.dateTo || query.to, now);
  const { from, to, previousFrom, previousTo } = range;

  const assigneeDeal =
    scope === "mine"
      ? { assigneeMembershipId: membership.id }
      : scope === "unassigned"
        ? { assigneeMembershipId: null }
        : {};
  const assigneeInquiry =
    scope === "mine"
      ? { assigneeMembershipId: membership.id }
      : scope === "unassigned"
        ? { assigneeMembershipId: null }
        : {};
  const assigneeTask =
    scope === "mine"
      ? { ownerMembershipId: membership.id }
      : scope === "unassigned"
        ? { ownerMembershipId: null }
        : {};
  const ownerContact =
    scope === "mine"
      ? { ownerMembershipId: membership.id }
      : scope === "unassigned"
        ? { ownerMembershipId: null }
        : {};

  const periodReceived =
    from || to ? { receivedAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {};
  const periodCreated =
    from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {};
  const periodClosed =
    from || to ? { closedAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {};
  const periodFirstSeen =
    from || to ? { firstSeenAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {};
  const periodConfirmed =
    from || to ? { confirmedAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {};
  const periodActivity =
    from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {};

  const todayParts = zonedYmd(now, timeZone);
  const startToday = zonedLocalToUtc(timeZone, todayParts.year, todayParts.month, todayParts.day);
  const tomorrowParts = addDaysYmd(todayParts, 1);
  const startTomorrow = zonedLocalToUtc(timeZone, tomorrowParts.year, tomorrowParts.month, tomorrowParts.day);

  const [
    board,
    stages,
    openDeals,
    periodInquiries,
    prevInquiriesCount,
    newClients,
    prevNewClients,
    dealsCreated,
    prevDealsCreated,
    wonDeals,
    prevWonDeals,
    lostDeals,
    intakesPending,
    openTasks,
    doneTodayTasks,
    recentActivities,
    recentInquiries,
    paymentsPeriod,
    paymentsPrev,
    waitingClientInquiries,
    allTimeCounts,
  ] = await Promise.all([
    getSituation(prisma, auth, { scope, includeSnoozed: false }),
    prisma.dealStage.findMany({ where: { tenantId: tid }, orderBy: { sortOrder: "asc" } }),
    prisma.deal.findMany({
      where: { tenantId: tid, outcome: "open", ...assigneeDeal },
      include: {
        stage: true,
        contact: { include: { methods: true } },
        tasks: { where: { status: { in: ["open", "waiting"] } }, select: { id: true, dueAt: true, status: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
    prisma.inquiry.findMany({
      where: { tenantId: tid, test: false, archived: false, ...assigneeInquiry, ...periodReceived },
      select: {
        id: true,
        status: true,
        receivedAt: true,
        lostReason: true,
        contactId: true,
        subject: true,
        service: true,
        sourceChannel: true,
        source: true,
        needsReply: true,
        phoneRaw: true,
        phoneNormalized: true,
        assigneeMembershipId: true,
        dealId: true,
        contact: { select: CONTACT_PHONE_SELECT },
      },
      orderBy: { receivedAt: "desc" },
      take: 2000,
    }),
    previousFrom && previousTo
      ? prisma.inquiry.count({
          where: {
            tenantId: tid,
            test: false,
            archived: false,
            ...assigneeInquiry,
            receivedAt: { gte: previousFrom, lt: previousTo },
          },
        })
      : Promise.resolve(null as number | null),
    prisma.contact.count({
      where: { tenantId: tid, archivedAt: null, ...ownerContact, ...periodFirstSeen },
    }),
    previousFrom && previousTo
      ? prisma.contact.count({
          where: {
            tenantId: tid,
            archivedAt: null,
            ...ownerContact,
            firstSeenAt: { gte: previousFrom, lt: previousTo },
          },
        })
      : Promise.resolve(null as number | null),
    prisma.deal.count({
      where: { tenantId: tid, ...assigneeDeal, ...periodCreated },
    }),
    previousFrom && previousTo
      ? prisma.deal.count({
          where: { tenantId: tid, ...assigneeDeal, createdAt: { gte: previousFrom, lt: previousTo } },
        })
      : Promise.resolve(null as number | null),
    prisma.deal.findMany({
      where: { tenantId: tid, outcome: "won", ...assigneeDeal, ...periodClosed },
      select: {
        id: true,
        offerAmountMinor: true,
        title: true,
        closedAt: true,
        currency: true,
        contact: { select: CONTACT_PHONE_SELECT },
      },
      orderBy: { closedAt: "desc" },
      take: 500,
    }),
    previousFrom && previousTo
      ? prisma.deal.findMany({
          where: {
            tenantId: tid,
            outcome: "won",
            ...assigneeDeal,
            closedAt: { gte: previousFrom, lt: previousTo },
          },
          select: { offerAmountMinor: true },
        })
      : Promise.resolve([] as { offerAmountMinor: { toString(): string } | null }[]),
    prisma.deal.findMany({
      where: { tenantId: tid, outcome: "lost", ...assigneeDeal, ...periodClosed },
      select: { id: true, lossReason: true },
      take: 500,
    }),
    prisma.incompleteIntake.count({ where: openIntakeWhere(tid) }),
    prisma.task.findMany({
      where: { tenantId: tid, status: { in: ["open", "waiting"] }, ...assigneeTask },
      include: { contact: { select: CONTACT_PHONE_SELECT } },
      orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }],
      take: 300,
    }),
    prisma.task.count({
      where: {
        tenantId: tid,
        status: "done",
        ...assigneeTask,
        completedAt: { gte: startToday },
      },
    }),
    prisma.activity.findMany({
      where: {
        tenantId: tid,
        type: { in: BUSINESS_ACTIVITY_TYPES },
        ...periodActivity,
      },
      include: { contact: { select: { id: true, ...CONTACT_PHONE_SELECT } } },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.inquiry.findMany({
      where: { tenantId: tid, test: false, archived: false, ...assigneeInquiry },
      include: { contact: { select: { id: true, ...CONTACT_PHONE_SELECT } } },
      orderBy: { receivedAt: "desc" },
      take: 8,
    }),
    prisma.paymentRecord.findMany({
      where: { tenantId: tid, status: "confirmed", ...periodConfirmed },
      select: { amountMinor: true, currency: true },
      take: 2000,
    }),
    previousFrom && previousTo
      ? prisma.paymentRecord.findMany({
          where: {
            tenantId: tid,
            status: "confirmed",
            confirmedAt: { gte: previousFrom, lt: previousTo },
          },
          select: { amountMinor: true },
        })
      : Promise.resolve([] as { amountMinor: { toString(): string } }[]),
    prisma.inquiry.count({
      where: {
        tenantId: tid,
        archived: false,
        test: false,
        status: "waiting_client",
        ...assigneeInquiry,
      },
    }),
    Promise.all([
      prisma.inquiry.count({ where: { tenantId: tid, test: false, archived: false } }),
      prisma.contact.count({ where: { tenantId: tid, archivedAt: null } }),
      prisma.deal.count({ where: { tenantId: tid } }),
      prisma.deal.count({ where: { tenantId: tid, outcome: "won" } }),
    ]),
  ]);

  const activeAgreements = await prisma.agreement.findMany({
    where: {
      tenantId: tid,
      status: { in: ["DETECTED", "NEEDS_CLARIFICATION", "CONFIRMED", "SCHEDULED", "RESCHEDULED"] },
    },
    include: {
      contact: { select: { id: true, ...CONTACT_PHONE_SELECT } },
      inquiry: { select: { id: true, subject: true, service: true } },
      deal: { include: { stage: true } },
      task: { select: { id: true, status: true } },
    },
    orderBy: [{ scheduledAt: "asc" }, { updatedAt: "desc" }],
    take: 100,
  });

  const [members, conversationModes, conversationNeedsHuman, currentNewInquiries, currentInWorkInquiries, contactsNeedsReply, tasksOverdueCount, conversationsHumanVisible] =
    await Promise.all([
      prisma.membership.findMany({
        where: { tenantId: tid, active: true },
        include: { user: { select: { name: true } } },
        take: 50,
      }),
      prisma.conversation.groupBy({
        by: ["mode"],
        where: { tenantId: tid, status: "open" },
        _count: { _all: true },
      }),
      countVisibleConversations(prisma, conversationsAttentionWhere(tid)),
      prisma.inquiry.count({
        where: {
          tenantId: tid,
          test: false,
          archived: false,
          status: "new",
          ...assigneeInquiry,
        },
      }),
      prisma.inquiry.count({
        where: {
          tenantId: tid,
          test: false,
          archived: false,
          status: { in: ["in_progress", "accepted", "qualification", "qualified"] },
          ...assigneeInquiry,
        },
      }),
      countContactsNeedsReply(prisma, tid),
      prisma.task.count({ where: overdueTasksWhere(tid, now) }),
      countVisibleConversations(prisma, conversationsHumanWhere(tid)),
    ]);

  const inquiriesCount = periodInquiries.length;

  let wonAmount = 0;
  let wonAmountKnown = 0;
  for (const deal of wonDeals) {
    const amount = amountNumber(deal.offerAmountMinor);
    if (amount != null) {
      wonAmount += amount;
      wonAmountKnown += 1;
    }
  }
  let prevWonAmount = 0;
  for (const deal of prevWonDeals) {
    const amount = amountNumber(deal.offerAmountMinor);
    if (amount != null) prevWonAmount += amount;
  }

  const lostReasonMap = new Map<string, number>();
  for (const deal of lostDeals) {
    const key = (deal.lossReason || "Другое").trim() || "Другое";
    lostReasonMap.set(key, (lostReasonMap.get(key) || 0) + 1);
  }

  const stageByKey = new Map(stages.map((s) => [s.systemKey, s]));
  const pipelineKeys = new Set(PIPELINE_STAGES.map((p) => p.systemKey));
  const pipelineNow = stages
    .filter((stage) => pipelineKeys.has(stage.systemKey))
    .map((stage) => ({
      systemKey: stage.systemKey,
      name: stage.name,
      count: openDeals.filter((d) => d.stageId === stage.id).length,
      href: "/deals",
    }));
  const pipelineView = enrichPipelineStages(pipelineNow);

  const negotiationKey = stageByKey.has("contract")
    ? "contract"
    : stageByKey.has("negotiation")
      ? "negotiation"
      : stages.find((s) => /договор|соглас/i.test(s.name))?.systemKey || "contract";
  const negotiationStageIds = new Set(stages.filter((s) => s.systemKey === "contract").map((s) => s.id));
  const proposalStageIds = new Set(stages.filter((s) => s.systemKey === "proposal_sent").map((s) => s.id));

  let pipelineAmount = 0;
  let pipelineAmountKnown = 0;
  let weightedPipeline = 0;
  const stalledCutoff = new Date(now.getTime() - ops.stalledDealDays * 86400000);
  const proposalCutoff = new Date(now.getTime() - ops.proposalFollowUpThresholdDays * 86400000);

  const waitingClientDeals: typeof openDeals = [];
  const noNextActionDeals: typeof openDeals = [];
  const stalledDealsList: typeof openDeals = [];
  const contractDeals: typeof openDeals = [];
  const importantDeals: Array<{
    id: string;
    title: string;
    amount: number | null;
    amountLabel: string | null;
    stageName: string;
    contactName: string | null;
    phone: string | null;
    reason: string;
    href: string;
  }> = [];

  for (const deal of openDeals) {
    const amount = amountNumber(deal.offerAmountMinor);
    const probability = (deal as { probability?: number }).probability ?? deal.stage?.defaultProbability ?? 10;
    if (amount != null) {
      pipelineAmount += amount;
      pipelineAmountKnown += 1;
      weightedPipeline += Math.round((amount * probability) / 100);
    }
    const onContract = negotiationStageIds.has(deal.stageId);
    if (onContract) contractDeals.push(deal);

    const hasFutureTask = deal.tasks.some((t) => t.dueAt && t.dueAt.getTime() >= now.getTime());
    const hasOpenTask = deal.tasks.length > 0;
    const waiting =
      flagsForDeal(deal, ops, now).waitingClient;
    if (waiting) waitingClientDeals.push(deal);

    if (!deal.nextAction && !hasOpenTask) noNextActionDeals.push(deal);

    const stageEntered = (deal as { stageEnteredAt?: Date }).stageEnteredAt || deal.createdAt;
    const lastTouch = deal.nextActionAt || stageEntered;
    const stalled = flagsForDeal(deal, ops, now).stalled;
    if (stalled) stalledDealsList.push(deal);

    const onProposalTooLong =
      proposalStageIds.has(deal.stageId) && stageEntered < proposalCutoff && !waiting;

    const reasons: string[] = [];
    if (onContract) reasons.push("На договоре");
    if (onProposalTooLong) reasons.push(`КП без ответа >${ops.proposalFollowUpThresholdDays} дн.`);
    if (stalled) reasons.push(`Нет активности ${ops.stalledDealDays}+ дн.`);
    if (!deal.nextAction && !hasOpenTask) reasons.push("Нет следующего действия");
    if (deal.nextActionAt && deal.nextActionAt < now) reasons.push("Просрочен follow-up");
    if (amount != null && amount >= ops.largeDealAmountMinor) reasons.push("Крупная сумма");
    if (waiting) reasons.push("Ждём клиента");
    if (reasons.length) {
      importantDeals.push({
        id: deal.id,
        title: deal.title,
        amount,
        amountLabel: formatMoneyKzt(amount, deal.currency || currency),
        stageName: deal.stage?.name || "Сделка",
        contactName: deal.contact ? displayName(deal.contact) : null,
        phone: phoneFromContact(deal.contact),
        reason: reasons.slice(0, 2).join(" · "),
        href: `/deals/${deal.id}`,
      });
    }
  }

  const proposalWithoutReply = openDeals.filter((deal) => {
    const stageEntered = (deal as { stageEnteredAt?: Date }).stageEnteredAt || deal.createdAt;
    return flagsForDeal(deal, ops, now).proposalWithoutReply;
  }).length;

  importantDeals.sort((a, b) => (b.amount || 0) - (a.amount || 0));

  const overdueTasks = openTasks.filter((t) => t.dueAt && t.dueAt < now);
  const remainingToday = openTasks.filter((t) => {
    if (!t.dueAt) return false;
    const y = zonedYmd(t.dueAt, timeZone);
    return y.year === todayParts.year && y.month === todayParts.month && y.day === todayParts.day;
  });
  const dueTodayFuture = remainingToday.filter((t) => t.dueAt && t.dueAt >= now);

  const typeCounts = new Map<string, number>();
  for (const task of remainingToday) {
    const bucket = taskTypeBucket(task.type, task.title);
    typeCounts.set(bucket, (typeCounts.get(bucket) || 0) + 1);
  }

  const attentionItems = [
    ...board.items.map((item) => ({
      ...item,
        group: attentionGroup(item),
      href:
        item.kind === "needs_phone"
          ? "/inquiries?filter=needs_clarification"
          : item.kind.startsWith("inquiry_") || item.kind === "missing_next_action"
            ? `/requests/${item.entityId}`
            : item.kind === "contact_needs_reply"
              ? `/contacts/${item.entityId}`
              : item.kind.startsWith("conversation_")
                ? `/conversations/${item.entityId}`
                : item.links.taskId ? `/tasks?open=${item.links.taskId}` : "/tasks",
    })),
    ...noNextActionDeals.map(deal => ({
      id: `deal-next:${deal.id}`, kind: "missing_next_action", group: "no_next_action", entityId: deal.id,
      title: deal.title, reason: "В сделке нет следующего действия", nextAction: "create_next_action",
      contactName: deal.contact ? displayName(deal.contact) : null,
      phone: phoneFromContact(deal.contact),
      interest: deal.stage?.name || null,
      severity: "normal", ownerMembershipId: deal.assigneeMembershipId, links: { dealId: deal.id, contactId: deal.contactId },
      href: `/deals/${deal.id}`, ageMinutes: Math.max(0, Math.floor((now.getTime() - deal.stageEnteredAt.getTime()) / 60000)),
    })),
    ...activeAgreements
      .filter((a) => a.status === "NEEDS_CLARIFICATION" || a.clarificationNeeded || (a.type === "ONLINE_MEETING" && !a.meetingUrl))
      .slice(0, 5)
      .map((a) => {
        const mapped = mapAgreementSit(a);
        return {
          id: `agreement:${a.id}`,
          kind: "agreement_attention",
          title: mapped.attention || a.title,
          subtitle: a.title,
          contactName: mapped.contactName,
          phone: mapped.phone,
          interest: mapped.inquiryTitle,
          entityId: a.id,
          entityType: "agreement",
          group: "needs_clarification",
          href: mapped.href,
          urgency: "high",
          ownerMembershipId: null,
        };
      }),
  ];

  const attentionSummary = {
    needsReply: contactsNeedsReply,
    overdueTasks: tasksOverdueCount,
    noNextAction: board.items.filter((i) => i.kind === "missing_next_action").length + noNextActionDeals.length,
    stalledDeals: stalledDealsList.length,
    needsHuman: conversationNeedsHuman,
    noContact: intakesPending,
    unassigned: board.items.filter((i) => !i.ownerMembershipId).length,
    needsClarification:
      board.items.filter((i) => i.kind === "needs_phone" || i.kind === "inquiry_new").length +
      activeAgreements.filter((a) => a.status === "NEEDS_CLARIFICATION" || a.clarificationNeeded).length,
    proposalWithoutReply,
  };

  let paidAmount = 0;
  for (const p of paymentsPeriod) {
    const n = amountNumber(p.amountMinor);
    if (n != null) paidAmount += n;
  }
  let prevPaid = 0;
  for (const p of paymentsPrev) {
    const n = amountNumber(p.amountMinor);
    if (n != null) prevPaid += n;
  }
  const showPayments = paymentsPeriod.length > 0 || paymentsPrev.length > 0;

  const label = periodLabel(preset, from, to, timeZone);
  const wonAmountLabel = formatMoneyKzt(wonAmountKnown ? wonAmount : null, currency);
  const pipelineAmountLabel = formatMoneyKzt(pipelineAmountKnown ? pipelineAmount : null, currency);

  const conversionRate =
    inquiriesCount >= 3 ? Math.round((wonDeals.length / inquiriesCount) * 1000) / 10 : null;
  const prevConversionRate =
    prevInquiriesCount != null && prevInquiriesCount >= 3
      ? Math.round((prevWonDeals.length / prevInquiriesCount) * 1000) / 10
      : null;

  const sourceMap = new Map<string, { inquiries: number; deals: number }>();
  for (const inq of periodInquiries) {
    const key = normalizeSourceKey(inq.sourceChannel || inq.source);
    const row = sourceMap.get(key) || { inquiries: 0, deals: 0 };
    row.inquiries += 1;
    if (inq.dealId || inq.status === "converted") row.deals += 1;
    sourceMap.set(key, row);
  }
  const sources = [...sourceMap.entries()]
    .map(([key, row]) => ({
      key,
      label: sourceLabel(key),
      inquiries: row.inquiries,
      deals: row.deals,
      conversionRate: row.inquiries > 0 ? Math.round((row.deals / row.inquiries) * 1000) / 10 : null,
      href:
        key === "unspecified"
          ? "/inquiries?test=false"
          : `/inquiries?source=${encodeURIComponent(key)}&test=false`,
    }))
    .sort((a, b) => b.inquiries - a.inquiries);

  const newByOwner = new Map<string | null, number>();
  for (const inq of periodInquiries) {
    const key = inq.assigneeMembershipId ?? null;
    newByOwner.set(key, (newByOwner.get(key) || 0) + 1);
  }
  const dealsByOwner = new Map<string | null, number>();
  for (const deal of openDeals) {
    const key = deal.assigneeMembershipId ?? null;
    dealsByOwner.set(key, (dealsByOwner.get(key) || 0) + 1);
  }
  const attentionByOwner = new Map<string | null, number>();
  for (const item of attentionItems) {
    const key = ("ownerMembershipId" in item ? item.ownerMembershipId : null) ?? null;
    attentionByOwner.set(key, (attentionByOwner.get(key) || 0) + 1);
  }
  const overdueByOwner = new Map<string | null, number>();
  for (const task of overdueTasks) {
    const key = task.ownerMembershipId ?? null;
    overdueByOwner.set(key, (overdueByOwner.get(key) || 0) + 1);
  }

  const teamRows = members.map((member) => ({
    membershipId: member.id,
    name: member.user.name || "Менеджер",
    newInquiries: newByOwner.get(member.id) || 0,
    inWork: dealsByOwner.get(member.id) || 0,
    attention: attentionByOwner.get(member.id) || 0,
    overdueTasks: overdueByOwner.get(member.id) || 0,
  }));
  const unassignedTeam = {
    membershipId: null as string | null,
    name: "Без ответственного",
    newInquiries: newByOwner.get(null) || 0,
    inWork: dealsByOwner.get(null) || 0,
    attention: attentionByOwner.get(null) || 0,
    overdueTasks: overdueByOwner.get(null) || 0,
  };
  const teamHasWork = (row: typeof unassignedTeam) =>
    row.newInquiries > 0 || row.inWork > 0 || row.attention > 0 || row.overdueTasks > 0;
  const team =
    scope === "unassigned"
      ? teamHasWork(unassignedTeam)
        ? [unassignedTeam]
        : []
      : [
          ...(scope === "mine" ? teamRows.filter((row) => row.membershipId === membership.id) : teamRows),
          ...(teamHasWork(unassignedTeam) && scope !== "mine" ? [unassignedTeam] : []),
        ].filter((row) => members.length <= 6 || teamHasWork(row));

  const loadedTeam = team.filter((row) => row.membershipId);
  const attentionValues = loadedTeam.map((row) => row.attention).filter((n) => n > 0);
  const topManager =
    loadedTeam.length >= 2 && attentionValues.length >= 2
      ? (() => {
          const leader = [...loadedTeam].sort((a, b) => b.attention - a.attention)[0];
          const average = attentionValues.reduce((sum, n) => sum + n, 0) / attentionValues.length;
          return leader ? { name: leader.name, attention: leader.attention, average } : null;
        })()
      : null;
  const bestSource = sources
    .filter((row) => row.inquiries >= 3 && row.conversionRate != null && row.conversionRate > 0)
    .sort((a, b) => (b.conversionRate || 0) - (a.conversionRate || 0))[0];

  const insights = buildInsights({
    needsReply: attentionSummary.needsReply,
    overdueTasks: attentionSummary.overdueTasks,
    stalledDeals: attentionSummary.stalledDeals,
    needsHuman: attentionSummary.needsHuman,
    newInquiries: currentNewInquiries,
    inquiries: inquiriesCount,
    prevInquiries: prevInquiriesCount,
    conversionRate,
    prevConversionRate,
    biggestDrop: pipelineView.biggestDrop,
    topManager,
    bestSource: bestSource
      ? { label: bestSource.label, rate: bestSource.conversionRate || 0, inquiries: bestSource.inquiries }
      : null,
  });

  const conversationAi = conversationModes.find((row) => row.mode === "ai")?._count._all || 0;
  const whatsappInquiries = periodInquiries.filter(
    (inq) => normalizeSourceKey(inq.sourceChannel || inq.source) === "whatsapp",
  ).length;

  const result = {
    approaches: inquiriesCount,
    inquiries: inquiriesCount,
    newClients,
    requests: inquiriesCount,
    dealsCreated,
    contractsReached: contractDeals.filter((d) => (!from && !to) || (d.createdAt >= (from || d.createdAt) && d.createdAt < (to || new Date(8.64e15)))).length,
    wonDeals: wonDeals.length,
    lostDeals: lostDeals.length,
    wonAmount: wonAmountKnown ? wonAmount : null,
    wonAmountLabel,
    wonAmountKnownCount: wonAmountKnown,
    wonAmountTotalDeals: wonDeals.length,
    conversionRate,
    conversionLabel: conversionRate != null ? `${conversionRate}%` : null,
    lostReasons: [...lostReasonMap.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6),
    deltas: {
      inquiries: delta(inquiriesCount, prevInquiriesCount),
      newClients: delta(newClients, prevNewClients),
      dealsCreated: delta(dealsCreated, prevDealsCreated),
      wonDeals: delta(wonDeals.length, prevWonDeals.length),
      wonAmount: previousFrom ? delta(wonAmount, prevWonAmount) : null,
      inquiriesPct: deltaPercent(inquiriesCount, prevInquiriesCount),
      newClientsPct: deltaPercent(newClients, prevNewClients),
      dealsCreatedPct: deltaPercent(dealsCreated, prevDealsCreated),
      wonDealsPct: deltaPercent(wonDeals.length, prevWonDeals.length),
      wonAmountPct: previousFrom ? deltaPercent(wonAmount, prevWonAmount) : null,
      conversionPct:
        conversionRate != null && prevConversionRate != null
          ? Math.round((conversionRate - prevConversionRate) * 10) / 10
          : null,
    },
    hrefs: {
      inquiries: "/inquiries",
      clients: "/contacts",
      deals: "/deals",
      won: "/deals",
      lost: "/deals",
    },
  };

  const current = {
    activeDeals: openDeals.length,
    activePipelineAmount: pipelineAmountKnown ? pipelineAmount : null,
    activePipelineAmountLabel: pipelineAmountLabel,
    weightedPipeline: pipelineAmountKnown ? weightedPipeline : null,
    weightedPipelineLabel: formatMoneyKzt(pipelineAmountKnown ? weightedPipeline : null, currency),
    amountKnownCount: pipelineAmountKnown,
    amountKnownOf: openDeals.length,
    contractStage: contractDeals.length,
    waitingClient: waitingClientDeals.length + waitingClientInquiries,
    waitingClientDeals: waitingClientDeals.length,
    waitingClientInquiries,
    newInquiries: currentNewInquiries,
    inWorkInquiries: currentInWorkInquiries,
    needsReply: attentionSummary.needsReply,
    noNextAction: attentionSummary.noNextAction,
    overdueTasks: attentionSummary.overdueTasks,
    stalledDeals: stalledDealsList.length,
    proposalWithoutReply,
    intakesPending,
    hrefs: {
      deals: "/deals",
      tasksOverdue: "/tasks",
      conversations: "/conversations",
      inquiriesWaiting: "/inquiries?filter=waiting_client",
      inquiriesNew: "/inquiries?filter=new",
      inquiriesInWork: "/inquiries?filter=in_progress",
      proposalFollowUp: "/deals",
    },
  };

  const brief = buildBrief({
    periodLabel: label,
    inquiries: result.inquiries,
    dealsCreated: result.dealsCreated,
    wonDeals: result.wonDeals,
    wonAmountLabel: result.wonAmountLabel,
    activeDeals: current.activeDeals,
    needsReply: current.needsReply,
    overdueTasks: current.overdueTasks,
    contractStage: current.contractStage,
    noNextAction: current.noNextAction,
  });

  const recentWins = wonDeals.slice(0, 5).map((d) => ({
    id: d.id,
    kind: "won" as const,
    title: d.title,
    contactName: d.contact ? displayName(d.contact) : null,
    phone: phoneFromContact(d.contact),
    amountLabel: formatMoneyKzt(amountNumber(d.offerAmountMinor), d.currency || currency),
    at: d.closedAt?.toISOString() || null,
    href: "/deals",
  }));

  return {
    asOf: now.toISOString(),
    currency,
    period: {
      preset,
      label,
      from: from?.toISOString() || null,
      to: to?.toISOString() || null,
    },
    scope,
    onlyImportant,
    brief,
    insights,
    result,
    current,
    pipeline: {
      stages: pipelineView.stages,
      biggestDrop: pipelineView.biggestDrop,
      note: "Стадии открытых сделок прямо сейчас",
    },
    sources,
    team,
    attention: {
      summary: attentionSummary,
      items: onlyImportant
        ? attentionItems.filter((i) =>
            ["needs_reply", "overdue", "no_next_action", "needs_human", "no_contact"].includes(i.group),
          )
        : attentionItems,
      emptyLabel: "Критических действий сейчас нет.",
    },
    todayTasks: {
      totalDueToday: remainingToday.length,
      doneToday: doneTodayTasks,
      remaining: Math.max(0, remainingToday.length),
      overdue: overdueTasks.length,
      byType: [...typeCounts.entries()].map(([type, count]) => ({ type, count })),
      nearest: [...overdueTasks, ...dueTodayFuture, ...openTasks.filter((t) => !remainingToday.includes(t) && !overdueTasks.includes(t))]
        .slice(0, 10)
        .map((t) => ({
          id: t.id,
          title: t.title,
          type: t.type,
          typeLabel: taskTypeBucket(t.type, t.title),
          dueAt: t.dueAt?.toISOString() || null,
          overdue: Boolean(t.dueAt && t.dueAt < now),
          contactName: t.contact ? displayName(t.contact) : null,
          phone: phoneFromContact(t.contact),
          href: "/tasks",
        })),
    },
    agreements: {
      today: activeAgreements.filter((a) => a.scheduledAt && a.scheduledAt >= startToday && a.scheduledAt < startTomorrow).map(mapAgreementSit),
      upcoming: activeAgreements
        .filter((a) => a.scheduledAt && a.scheduledAt >= startTomorrow)
        .slice(0, 8)
        .map(mapAgreementSit),
      needsClarification: activeAgreements.filter((a) => a.status === "NEEDS_CLARIFICATION" || a.clarificationNeeded).map(mapAgreementSit),
      byType: summarizeAgreementTypes(activeAgreements.filter((a) => a.scheduledAt && a.scheduledAt >= startToday && a.scheduledAt < startTomorrow)),
      overdue: activeAgreements
        .filter((a) => a.scheduledAt && a.scheduledAt < now && ["CONFIRMED", "SCHEDULED", "RESCHEDULED"].includes(a.status))
        .map(mapAgreementSit),
    },
    importantDeals: importantDeals.slice(0, 8),
    recentInquiries: recentInquiries.map((inq) => ({
      id: inq.id,
      title: inq.subject || inq.service || "Заявка",
      contactName: inq.contact ? displayName(inq.contact) : "Клиент",
      phone: phoneFromContact(inq.contact, inq),
      receivedAt: inq.receivedAt.toISOString(),
      source: inq.sourceChannel || inq.source,
      status: inq.status,
      needsReply: inq.needsReply,
      href: `/requests/${inq.id}`,
    })),
    recentResults: recentWins,
    recentEvents: recentActivities.map((a) => ({
      id: a.id,
      type: a.type,
      title: a.title,
      description: a.description,
      contactId: a.contactId,
      contactName: a.contact ? displayName(a.contact) : null,
      phone: phoneFromContact(a.contact),
      createdAt: a.createdAt.toISOString(),
      href: a.contactId ? `/contacts/${a.contactId}` : "/today",
    })),
    payments: showPayments
      ? {
          paidInPeriod: paidAmount,
          paidInPeriodLabel: formatMoneyKzt(paidAmount, currency),
          paidDelta: previousFrom ? delta(paidAmount, prevPaid) : null,
          count: paymentsPeriod.length,
        }
      : null,
    allTime:
      preset === "all"
        ? {
            inquiries: allTimeCounts[0],
            clients: allTimeCounts[1],
            deals: allTimeCounts[2],
            won: allTimeCounts[3],
          }
        : null,
    freshness: board.freshness,
    aiManager: {
      status: board.freshness.seller.configured
        ? board.freshness.seller.reachable
          ? "active"
          : "error"
        : "offline",
      label: board.freshness.seller.configured
        ? board.freshness.seller.reachable
          ? "AI Manager · активен"
          : "AI Manager · ошибка интеграции"
        : "AI Manager · не подключён",
      conversations: {
        ai: conversationAi,
        human: conversationsHumanVisible,
        needsAttention: conversationNeedsHuman,
      },
      whatsappInquiries,
      newRequests: {
        processing: await prisma.task.count({
          where: {
            tenantId: tid,
            type: "process_inquiry",
            status: "open",
            source: "ai_automation",
            executionStatus: { in: ["in_progress", "queued"] },
          },
        }),
        awaitingConfirm: await prisma.task.count({
          where: {
            tenantId: tid,
            type: "process_inquiry",
            status: "open",
            executionStatus: "awaiting_confirm",
          },
        }),
        needsHuman: await prisma.task.count({
          where: {
            tenantId: tid,
            type: "process_inquiry",
            status: "open",
            executionStatus: { in: ["needs_human", "failed"] },
          },
        }),
        analysisFailed: await prisma.inquiry.count({
          where: { tenantId: tid, attentionReason: "AI_ANALYSIS_FAILED", status: { notIn: ["lost", "converted", "cancelled"] } },
        }),
      },
    },
    integrationAlerts: (
      await prisma.integration.findMany({
        where: {
          tenantId: tid,
          OR: [
            { healthStatus: { in: ["ERROR", "TOKEN_EXPIRED"] } },
            { lastError: { not: null } },
          ],
        },
        select: { id: true, name: true, type: true, healthStatus: true, lastError: true, lastErrorCode: true },
        take: 5,
      })
    ).map((i) => ({
      id: i.id,
      title: i.healthStatus === "TOKEN_EXPIRED" ? `${i.name}: требуется повторная авторизация` : `${i.name}: ошибка интеграции`,
      detail: i.lastError || i.lastErrorCode || i.healthStatus,
      href: "/integrations",
    })),
  };
}
