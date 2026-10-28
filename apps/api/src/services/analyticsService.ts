import { loadTenantServices } from "./tenantServiceCatalog.ts";
import { AnalyticsCoverage } from "./analyticsCoverage.ts";
import { analyticsTotals } from "./analyticsTotals.ts";
import { analyticsComparison, closedDealConversion, periodSalesPlan } from "./analyticsPeriodPolicy.ts";
import { buildAnalyticsFunnel } from "./analyticsFunnel.ts";
import { businessDealWhere, confirmedPaymentsWhere, MoneyDecimal, moneyValue } from "./financialMetrics.ts";
import type { Prisma, PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { requireAnalyticsAccess } from "../lib/access.ts";
import { displayName, formatPhoneDisplay } from "./contactLabels.ts";
import { amountNumber, formatMoney, parseOpsSettings, type TenantOpsSettings } from "./dealPipeline.ts";
import { flagsForDeal, nextStepForDeal, loadProcessDeals, PROCESS_OPEN_TASK_STATUSES } from "./dealProcessPolicy.ts";
import { createProcessClock, type ProcessClock } from "./processCalendar.ts";
import {
  enumerateBucketKeys,
  formatBucketLabel,
  isoWeekKeyFromYmd,
  periodLabel,
  resolvePeriodRange,
  type PeriodPreset,
  type TrendGranularity,
  zonedYmd,
} from "./periodRange.ts";

function inquirySourceLabel(row: {
  utmSource?: string | null;
  sourceChannel?: string | null;
  sourceType?: string | null;
}) {
  return row.utmSource || row.sourceChannel || row.sourceType || "Не указано";
}

export type AnalyticsCompareMode = "previous" | "last_month" | "last_year" | "none";
export type FunnelMode = "cohort" | "events";
export type TrendMetric = "inquiries" | "clients" | "deals" | "won" | "revenue" | "receipts" | "conversion";

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership;
}

function pct(part: number, total: number) {
  if (!total) return null;
  return Math.round((part / total) * 1000) / 10;
}

function deltaPct(current: number | null, previous: number | null) {
  if (current == null) return null;
  if (previous == null || previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function deltaPp(current: number | null, previous: number | null) {
  if (current == null || previous == null) return null;
  return Math.round((current - previous) * 10) / 10;
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function rangeFilter(from: Date | null, to: Date | null) {
  if (!from && !to) return undefined;
  return { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) };
}

export type AnalyticsQuery = {
  period?: string;
  dateFrom?: string;
  dateTo?: string;
  compare?: string;
  funnelMode?: string;
  assignee?: string;
  serviceCategory?: string;
  source?: string;
  channel?: string;
  city?: string;
  campaign?: string;
};

function parsePreset(raw?: string): PeriodPreset {
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
  return allowed.includes(raw as PeriodPreset) ? (raw as PeriodPreset) : "this_month";
}

async function buildFilters(prisma: PrismaClient, query: AnalyticsQuery, tid: string) {
  const inquiryExtra: Record<string, unknown> = { tenantId: tid, test: false, archived: false };
  const dealExtra: Record<string, unknown> = { tenantId: tid };
  if (query.assignee) {
    inquiryExtra.assigneeMembershipId = query.assignee;
    dealExtra.assigneeMembershipId = query.assignee;
  }
  if (query.serviceCategory) inquiryExtra.serviceCategory = query.serviceCategory;
  if (query.source) {
    inquiryExtra.OR = [
      { utmSource: { contains: query.source, mode: "insensitive" } },
      { sourceType: { contains: query.source, mode: "insensitive" } },
      { sourceChannel: { contains: query.source, mode: "insensitive" } },
    ];
  }
  if (query.channel) inquiryExtra.sourceChannel = { contains: query.channel, mode: "insensitive" };
  if (query.city) inquiryExtra.city = { contains: query.city, mode: "insensitive" };
  if (query.campaign) inquiryExtra.utmCampaign = { contains: query.campaign, mode: "insensitive" };
  // A source/service filter must constrain every metric, not just the inquiry count.
  const { assigneeMembershipId, ...attribution } = inquiryExtra;
  const hasAttribution = Object.keys(attribution).some(key => !["tenantId", "test", "archived"].includes(key));
  // Legacy rows may have only Deal.inquiryId or only Inquiry.dealId populated.
  const linked = hasAttribution ? await prisma.inquiry.findMany({
    where: attribution as never, select: { id: true, dealId: true },
  }) : [];
  const linkage = { OR: [{ inquiryId: { in: linked.map(row => row.id) } }, { id: { in: linked.flatMap(row => row.dealId ? [row.dealId] : []) } }] };
  // NOT (nullable inquiryId IN (...)) yields SQL UNKNOWN for unlinked deals.
  // Preserve these legitimate deals when excluding test/archived inquiries.
  dealExtra.AND = hasAttribution ? [linkage] : (await businessDealWhere(prisma, tid)).AND;
  return { inquiryExtra, dealExtra };
}

function contactAnalyticsFilter(tid: string, inquiryExtra: Record<string, unknown>) {
  const { assigneeMembershipId, ...attribution } = inquiryExtra;
  const filtered = Object.keys(attribution).some(key => !["tenantId", "test", "archived"].includes(key));
  return {
    tenantId: tid,
    archivedAt: null,
    ...(assigneeMembershipId ? { ownerMembershipId: assigneeMembershipId as string } : {}),
    ...(filtered ? { inquiries: { some: attribution } } : {}),
  };
}

function inquiryLabelFilter(fields: string[], label: string): Prisma.InquiryWhereInput {
  const empty = (field: string) => ({ OR: [{ [field]: null }, { [field]: "" }] });
  return { OR: [
    ...fields.map((field, index) => ({ AND: [...fields.slice(0, index).map(empty), { [field]: label }] })),
    ...(label === "Не указано" ? [{ AND: fields.map(empty) }] : []),
  ] };
}

async function dealsWithInquiryLabel(prisma: PrismaClient, tid: string, fields: string[], label: string): Promise<Prisma.DealWhereInput> {
  const rows = await prisma.inquiry.findMany({ where: { tenantId: tid, ...inquiryLabelFilter(fields, label) }, select: { id: true, dealId: true } });
  return { OR: [
    { inquiryId: { in: rows.map(row => row.id) } },
    { id: { in: rows.flatMap(row => row.dealId ? [row.dealId] : []) } },
    ...(label === "Не указано" ? [{ inquiryId: null, inquiry: { is: null } }] : []),
  ] };
}

async function metricBundle(
  prisma: PrismaClient,
  tid: string,
  from: Date | null,
  to: Date | null,
  inquiryExtra: Record<string, unknown>,
  dealExtra: Record<string, unknown>,
  coverage: AnalyticsCoverage,
  coveragePrefix: string,
  currency: string,
) {
  const received = rangeFilter(from, to);
  const closed = rangeFilter(from, to);

  const [inquiries, clients, dealsCreated, wonDeals, lostDeals, contractsReached, totals] =
    await Promise.all([
      coverage.read(coveragePrefix + ":inquiries", "Обращения: подробные разрезы", 5000, take => prisma.inquiry.findMany({
        where: { ...inquiryExtra, ...(received ? { receivedAt: received } : {}) } as never,
        select: {
          id: true,
          contactId: true,
          status: true,
          service: true,
          serviceCategory: true,
          serviceSubcategory: true,
          sourceType: true,
          sourceChannel: true,
          utmSource: true,
          utmCampaign: true,
          city: true,
          receivedAt: true,
          firstContactAt: true,
          lostReason: true,
          dealId: true,
          assigneeMembershipId: true,
          contact: { select: { name: true, firstName: true, lastName: true } },
        },
        take,
      })),
      prisma.contact.count({
        where: {
          ...contactAnalyticsFilter(tid, inquiryExtra),
          ...(received ? { firstSeenAt: received } : {}),
          ...(inquiryExtra.assigneeMembershipId ? { ownerMembershipId: inquiryExtra.assigneeMembershipId } : {}),
        },
      }),
      coverage.read(coveragePrefix + ":created", "Созданные сделки: подробные разрезы", 5000, take => prisma.deal.findMany({
        where: { ...dealExtra, ...(received ? { createdAt: received } : {}) } as never,
        select: { id: true, inquiryId: true },
        take,
      })),
      coverage.read(coveragePrefix + ":won", "Продажи: подробные разрезы и медианы", 5000, take => prisma.deal.findMany({
        where: { ...dealExtra, outcome: "won", ...(closed ? { closedAt: closed } : {}) } as never,
        select: {
          id: true,
          title: true,
          offerAmountMinor: true,
          wonAmountMinor: true,
          currency: true,
          closedAt: true,
          createdAt: true,
          lossReason: true,
          stageId: true,
          contactId: true,
          assigneeMembershipId: true,
          contact: { select: { name: true, firstName: true, lastName: true } },
          inquiryId: true,
        },
        take,
      })),
      coverage.read(coveragePrefix + ":lost", "Потери: подробные разрезы", 5000, take => prisma.deal.findMany({
        where: { ...dealExtra, outcome: "lost", ...(closed ? { closedAt: closed } : {}) } as never,
        select: {
          id: true,
          title: true,
          offerAmountMinor: true,
          closedAt: true,
          createdAt: true,
          lossReason: true,
          currency: true,
          stageId: true,
          assigneeMembershipId: true,
          stage: { select: { name: true, systemKey: true } },
          contact: { select: { name: true, firstName: true, lastName: true } },
          inquiryId: true,
        },
        take,
      })),
      prisma.deal.count({
        where: { ...dealExtra, stageHistory: { some: { toSystemKey: "contract", ...(received ? { enteredAt: received } : {}) } } } as never,
      }),
      analyticsTotals(prisma, inquiryExtra, dealExtra, received, tid, currency),
    ]);

  const checks = wonDeals.filter(d => d.currency === currency).map(d => d.wonAmountMinor ?? d.offerAmountMinor)
    .filter((n): n is Prisma.Decimal => n != null).map(n => new MoneyDecimal(n)).sort((a, b) => a.cmp(b));
  const middle = Math.floor(checks.length / 2);
  const medianMoney = moneyValue(checks.length ? checks.length % 2 ? checks[middle] : checks[middle - 1].plus(checks[middle]).div(2) : null, currency);
  const { inquiryCount, won, lost, revenue, revenueKnown, pipeline, weighted, pipelineKnown, lostAmount } = totals;
  const conversion = closedDealConversion(won, lost);

  return {
    inquiries,
    inquiryCount,
    clients,
    dealsCreated: totals.dealsCreated,
    dealsCreatedRows: dealsCreated,
    contractsReached,
    won,
    wonDeals,
    lost,
    lostDeals,
    revenue,
    revenueKnown,
    avgCheck: totals.avgCheck,
    medianCheck: medianMoney.amount,
    medianCheckLabel: medianMoney.label,
    maxCheck: totals.maxCheck,
    conversion,
    pipeline,
    weighted,
    pipelineKnown,
    lostAmount,
    lostAmountLabel: totals.lostAmountLabel,
    financial: totals.financial,
  };
}

function bucketKey(date: Date, granularity: TrendGranularity, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "00";
  const y = get("year");
  const m = get("month");
  const d = get("day");
  const h = get("hour");
  if (granularity === "hour") return `${y}-${m}-${d}T${h}`;
  if (granularity === "day") return `${y}-${m}-${d}`;
  if (granularity === "month") return `${y}-${m}`;
  if (granularity === "year") return y;
  return isoWeekKeyFromYmd({ year: Number(y), month: Number(m), day: Number(d) });
}

function chooseGranularity(preset: PeriodPreset, from: Date | null, to: Date | null): TrendGranularity {
  if (from && to && (to.getTime() - from.getTime()) / 86400000 > 3650) return "year";
  if (preset === "today" || preset === "yesterday") return "hour";
  if (preset === "this_year" || preset === "all") return "month";
  if (from && to) {
    const days = (to.getTime() - from.getTime()) / 86400000;
    if (days <= 2) return "hour";
    if (days <= 45) return "day";
    if (days <= 180) return "week";
    return "month";
  }
  return "day";
}

async function buildTrend(
  prisma: PrismaClient,
  tid: string,
  from: Date | null,
  to: Date | null,
  preset: PeriodPreset,
  timeZone: string,
  inquiryExtra: Record<string, unknown>,
  dealExtra: Record<string, unknown>,
  metric: TrendMetric,
  locale = "ru",
  coverage = new AnalyticsCoverage(),
  coveragePrefix = "trend",
  currency = "KZT",
  forcedGranularity?: TrendGranularity,
) {
  let granularity = forcedGranularity || chooseGranularity(preset, from, to);
  const received = rangeFilter(from, to);
  const [inquiries, deals, newClients] = await Promise.all([
    coverage.read(coveragePrefix + ":inquiries", "График обращений", 8000, take => prisma.inquiry.findMany({
      where: { ...inquiryExtra, ...(received ? { receivedAt: received } : {}) } as never,
      select: { receivedAt: true },
      take,
    })),
    coverage.read(coveragePrefix + ":created", "График сделок", 8000, take => prisma.deal.findMany({
      where: { ...dealExtra, ...(received ? { createdAt: received } : {}) } as never,
      select: { createdAt: true },
      take,
    })),
    coverage.read(coveragePrefix + ":clients", "График клиентов", 8000, take => prisma.contact.findMany({
      where: {
        ...contactAnalyticsFilter(tid, inquiryExtra),
        ...(received ? { firstSeenAt: received } : {}),
        ...(inquiryExtra.assigneeMembershipId ? { ownerMembershipId: inquiryExtra.assigneeMembershipId } : {}),
      },
      select: { firstSeenAt: true },
      take,
    })),
  ]);

  const map = new Map<string, { inquiries: number; clients: number; deals: number; won: number; lost: number; revenue: number | null; receipts: number | null; revenueExact: string; receiptsExact: string }>();
  const touch = (key: string) => {
    if (!map.has(key)) map.set(key, { inquiries: 0, clients: 0, deals: 0, won: 0, lost: 0, revenue: 0, receipts: 0, revenueExact: "0", receiptsExact: "0" });
    return map.get(key)!;
  };

  for (const row of inquiries) touch(bucketKey(row.receivedAt, granularity, timeZone)).inquiries += 1;
  for (const row of newClients) touch(bucketKey(row.firstSeenAt, granularity, timeZone)).clients += 1;
  for (const row of deals) touch(bucketKey(row.createdAt, granularity, timeZone)).deals += 1;
  // Money charts must reconcile with full totals, even beyond the former 8000-row cap.
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.deal.findMany({ where: { AND: [dealExtra as Prisma.DealWhereInput,
      { outcome: { in: ["won", "lost"] }, ...(received ? { closedAt: received } : {}), ...(cursor ? { id: { gt: cursor } } : {}) }] },
      orderBy: { id: "asc" }, take: 500, select: { id: true, outcome: true, closedAt: true, wonAmountMinor: true, offerAmountMinor: true, currency: true } });
    for (const row of rows) {
      if (!row.closedAt) continue;
      const b = touch(bucketKey(row.closedAt, granularity, timeZone));
      if (row.outcome === "lost") { b.lost++; continue; }
      b.won++;
      if (row.currency === currency) {
        const amount = moneyValue(new MoneyDecimal(b.revenueExact).plus(row.wonAmountMinor ?? row.offerAmountMinor ?? 0), currency);
        b.revenue = amount.amount; b.revenueExact = amount.exact!;
      }
    }
    if (rows.length < 500) break; cursor = rows[rows.length - 1].id;
  }
  cursor = undefined;
  for (;;) {
    const rows: Array<{ id: string; confirmedAt: Date; amountMinor: Prisma.Decimal }> = await prisma.paymentRecord.findMany({ where: { ...confirmedPaymentsWhere(tid, dealExtra as Prisma.DealWhereInput, received), currency,
      ...(cursor ? { id: { gt: cursor } } : {}) }, orderBy: { id: "asc" }, take: 500, select: { id: true, confirmedAt: true, amountMinor: true } });
    for (const row of rows) {
      const b = touch(bucketKey(row.confirmedAt, granularity, timeZone));
      const amount = moneyValue(new MoneyDecimal(b.receiptsExact).plus(row.amountMinor), currency);
      b.receipts = amount.amount; b.receiptsExact = amount.exact!;
    }
    if (rows.length < 500) break; cursor = rows[rows.length - 1].id;
  }

  // All-time reports have no explicit bounds. Coarsen a long monthly history
  // instead of dropping sales/payments after the old 120-month bucket limit.
  const monthlyKeys = granularity === "month" ? [...map.keys()].sort() : [];
  if (!from && monthlyKeys.length) {
    const monthIndex = (key: string) => Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7));
    if (monthIndex(monthlyKeys.at(-1)!) - monthIndex(monthlyKeys[0]) >= 120) {
      const rows = [...map.entries()]; map.clear(); granularity = "year";
      for (const [key, row] of rows) {
        const total = touch(key.slice(0, 4));
        for (const field of ["inquiries", "clients", "deals", "won", "lost"] as const) total[field] += row[field];
        for (const field of ["revenue", "receipts"] as const) {
          const exactField = `${field}Exact` as const;
          const amount = moneyValue(new MoneyDecimal(total[exactField]).plus(row[exactField]), currency);
          total[field] = amount.amount; total[exactField] = amount.exact!;
        }
      }
    }
  }
  const keys = enumerateBucketKeys(from, to, granularity, timeZone, [...map.keys()]);
  const points = keys.map((key) => {
    const v = map.get(key) || { inquiries: 0, clients: 0, deals: 0, won: 0, lost: 0, revenue: 0, receipts: 0, revenueExact: "0", receiptsExact: "0" };
    const conversion = closedDealConversion(v.won, v.lost);
    return {
      key,
      label: formatBucketLabel(key, granularity, locale),
      inquiries: v.inquiries,
      clients: v.clients,
      deals: v.deals,
      won: v.won,
      lost: v.lost,
      closed: v.won + v.lost,
      revenue: v.revenue,
      revenueExact: v.revenueExact,
      receipts: v.receipts,
      receiptsExact: v.receiptsExact,
      conversion,
      value:
        metric === "inquiries"
          ? v.inquiries
          : metric === "clients"
            ? v.clients
            : metric === "deals"
              ? v.deals
              : metric === "won"
                ? v.won
                : metric === "revenue"
                  ? v.revenue
                  : metric === "receipts" ? v.receipts : conversion,
    };
  });

  return { granularity, metric, points, coverage: coverage.result() };
}

function groupCount<T>(rows: T[], keyFn: (row: T) => string) {
  const map = new Map<string, number>();
  for (const row of rows) {
    const k = keyFn(row) || "Не указано";
    map.set(k, (map.get(k) || 0) + 1);
  }
  return map;
}

export async function getAnalyticsDashboard(prisma: PrismaClient, auth: AuthContext, query: AnalyticsQuery = {}) {
  requireAnalyticsAccess(auth);
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const timeZone = membership.tenant.timezone || "Asia/Almaty";
  const currency = membership.tenant.currency || "KZT";
  const now = new Date();
  const preset = parsePreset(query.period);
  let compareMode = (["previous", "last_month", "last_year", "none"].includes(String(query.compare))
    ? query.compare
    : "previous") as AnalyticsCompareMode;
  const funnelMode: FunnelMode = query.funnelMode === "events" ? "events" : "cohort";

  const range = resolvePeriodRange(timeZone, preset, query.dateFrom, query.dateTo, now);
  if (!range.from || !range.to) compareMode = "none";
  const cmp = analyticsComparison(timeZone, compareMode, range.from, range.to);
  // Use the coarser interval for both periods. A single day's hourly chart
  // compared to a whole month must not silently stop after the first 72 hours.
  const intervals = ["hour", "day", "week", "month", "year"] as const;
  const granularity = intervals[Math.max(intervals.indexOf(chooseGranularity(preset, range.from, range.to)),
    compareMode === "none" ? 0 : intervals.indexOf(chooseGranularity("custom", cmp.from, cmp.to)))];
  const { inquiryExtra, dealExtra } = await buildFilters(prisma, query, tid);
  const coverage = new AnalyticsCoverage();
  const tenantRow = await prisma.tenant.findUnique({ where: { id: tid }, select: { settingsJson: true, timezone: true } });
  const ops = parseOpsSettings(tenantRow?.settingsJson);
  const processClock = createProcessClock(ops.processCalendar, tenantRow?.timezone || timeZone, now);

  const [current, previous, funnel, trendInquiries, stageDurations, stage2] = await Promise.all([
    metricBundle(prisma, tid, range.from, range.to, inquiryExtra, dealExtra, coverage, "current", currency),
    compareMode === "none"
      ? null
      : metricBundle(prisma, tid, cmp.from, cmp.to, inquiryExtra, dealExtra, coverage, "previous", currency),
    buildAnalyticsFunnel(prisma, tid, range.from, range.to, funnelMode, inquiryExtra as Prisma.InquiryWhereInput, dealExtra as Prisma.DealWhereInput),
    buildTrend(prisma, tid, range.from, range.to, preset, timeZone, inquiryExtra, dealExtra, "inquiries", auth.user.locale, coverage, "trend", currency, granularity),
    buildStageDurations(prisma, tid, range.from, range.to, coverage, dealExtra, ops, processClock, now).catch((err) => {
      coverage.unavailable("durations", "Длительность этапов");
      console.error("analytics stageDurations", err);
      return [];
    }),
    buildStage2Analytics(prisma, tid, range.from, range.to, inquiryExtra, dealExtra, currency, coverage, query.assignee).catch(
      (err) => {
        coverage.unavailable("details", "Подробная статистика");
        console.error("analytics stage2", err);
        return emptyStage2();
      },
    ),
  ]);

  const trendCompare =
    compareMode === "none"
      ? null
      : await buildTrend(
          prisma,
          tid,
          cmp.from,
          cmp.to,
          "custom",
          timeZone,
          inquiryExtra,
          dealExtra,
          "inquiries",
          auth.user.locale,
          coverage,
          "trend-previous",
          currency,
          trendInquiries.granularity,
        );

  const relatedInquiryIds = [
    ...current.dealsCreatedRows.map((d) => d.inquiryId).filter(Boolean),
    ...current.wonDeals.map((d) => d.inquiryId).filter(Boolean),
    ...current.lostDeals.map((d) => d.inquiryId).filter(Boolean),
  ] as string[];
  const missingIds = [...new Set(relatedInquiryIds)].filter(
    (id) => !current.inquiries.some((i) => i.id === id),
  );
  const relatedDealIds = [...current.wonDeals, ...current.lostDeals, ...current.dealsCreatedRows].map(row => row.id);
  const extraInquiries = missingIds.length || relatedDealIds.length
    ? await prisma.inquiry.findMany({
        where: { tenantId: tid, OR: [{ id: { in: missingIds } }, { dealId: { in: relatedDealIds } }] },
        select: {
          id: true,
          dealId: true,
          service: true,
          serviceCategory: true,
          serviceSubcategory: true,
          sourceType: true,
          sourceChannel: true,
          utmSource: true,
          utmCampaign: true,
        },
      })
    : [];
  const inquiryById = new Map(
    [...current.inquiries, ...extraInquiries].map((i) => [i.id, i] as const),
  );
  const inquiryByDealId = new Map(
    [...current.inquiries, ...extraInquiries]
      .filter((i) => i.dealId)
      .map((i) => [i.dealId!, i] as const),
  );
  const resolveInquiry = (dealId: string, inquiryId?: string | null) =>
    (inquiryId ? inquiryById.get(inquiryId) : undefined) || inquiryByDealId.get(dealId);

  const sourceMap = new Map<
    string,
    { inquiries: number; deals: number; won: number; lost: number; revenue: Prisma.Decimal; revenueKnown: number }
  >();
  for (const inq of current.inquiries) {
    const src = inquirySourceLabel(inq);
    if (!sourceMap.has(src)) sourceMap.set(src, { inquiries: 0, deals: 0, won: 0, lost: 0, revenue: new MoneyDecimal(0), revenueKnown: 0 });
    sourceMap.get(src)!.inquiries += 1;
  }
  for (const d of current.dealsCreatedRows) {
    const inq = resolveInquiry(d.id, d.inquiryId);
    const src = inq ? inquirySourceLabel(inq) : "Не указано";
    if (!sourceMap.has(src)) sourceMap.set(src, { inquiries: 0, deals: 0, won: 0, lost: 0, revenue: new MoneyDecimal(0), revenueKnown: 0 });
    sourceMap.get(src)!.deals += 1;
  }
  for (const d of current.wonDeals) {
    const inq = resolveInquiry(d.id, d.inquiryId);
    const src = inq ? inquirySourceLabel(inq) : "Не указано";
    if (!sourceMap.has(src)) sourceMap.set(src, { inquiries: 0, deals: 0, won: 0, lost: 0, revenue: new MoneyDecimal(0), revenueKnown: 0 });
    const bucket = sourceMap.get(src)!;
    bucket.won += 1;
    const n = d.wonAmountMinor ?? d.offerAmountMinor;
    if (n != null && d.currency === currency) { bucket.revenue = bucket.revenue.plus(n); bucket.revenueKnown++; }
  }

  for (const d of current.lostDeals) {
    const inq = resolveInquiry(d.id, d.inquiryId), src = inq ? inquirySourceLabel(inq) : "Не указано";
    if (!sourceMap.has(src)) sourceMap.set(src, { inquiries: 0, deals: 0, won: 0, lost: 0, revenue: new MoneyDecimal(0), revenueKnown: 0 });
    sourceMap.get(src)!.lost++;
  }
  const sources = [...sourceMap.entries()]
    .map(([name, v]) => ({
      name,
      inquiries: v.inquiries,
      deals: v.deals,
      won: v.won,
      conversion: closedDealConversion(v.won, v.lost),
      closed: v.won + v.lost,
      revenue: moneyValue(v.revenueKnown ? v.revenue : null, currency).amount,
      revenueExact: moneyValue(v.revenueKnown ? v.revenue : null, currency).exact,
      revenueLabel: moneyValue(v.revenueKnown ? v.revenue : null, currency).label,
      revenueKnown: v.revenueKnown,
      avgCheck: moneyValue(v.revenueKnown ? v.revenue.div(v.revenueKnown) : null, currency).amount,
      avgCheckLabel: moneyValue(v.revenueKnown ? v.revenue.div(v.revenueKnown) : null, currency).label,
    }))
    .sort((a, b) => b.inquiries - a.inquiries);

  const serviceNames = new Map((await loadTenantServices(prisma, tid)).map((row) => [row.code, row.name]));
  const serviceMap = new Map<string, { inquiries: number; won: number; lost: number; revenue: Prisma.Decimal; revenueKnown: number; sub: Map<string, number> }>();
  for (const inq of current.inquiries) {
    const cat = inq.serviceCategory || inq.service || "Не указано";
    if (!serviceMap.has(cat)) serviceMap.set(cat, { inquiries: 0, won: 0, lost: 0, revenue: new MoneyDecimal(0), revenueKnown: 0, sub: new Map() });
    const row = serviceMap.get(cat)!;
    row.inquiries += 1;
    if (inq.serviceSubcategory) row.sub.set(inq.serviceSubcategory, (row.sub.get(inq.serviceSubcategory) || 0) + 1);
  }
  for (const d of current.wonDeals) {
    const inq = resolveInquiry(d.id, d.inquiryId);
    const cat = inq?.serviceCategory || inq?.service || "Не указано";
    if (!serviceMap.has(cat)) serviceMap.set(cat, { inquiries: 0, won: 0, lost: 0, revenue: new MoneyDecimal(0), revenueKnown: 0, sub: new Map() });
    const row = serviceMap.get(cat)!;
    row.won += 1;
    const n = d.wonAmountMinor ?? d.offerAmountMinor;
    if (n != null && d.currency === currency) { row.revenue = row.revenue.plus(n); row.revenueKnown++; }
  }
  for (const d of current.lostDeals) {
    const inq = resolveInquiry(d.id, d.inquiryId), cat = inq?.serviceCategory || inq?.service || "Не указано";
    if (!serviceMap.has(cat)) serviceMap.set(cat, { inquiries: 0, won: 0, lost: 0, revenue: new MoneyDecimal(0), revenueKnown: 0, sub: new Map() });
    serviceMap.get(cat)!.lost++;
  }
  const services = [...serviceMap.entries()]
    .map(([name, v]) => ({
      name,
      label: serviceNames.get(name) || name,
      inquiries: v.inquiries,
      won: v.won,
      conversion: closedDealConversion(v.won, v.lost),
      closed: v.won + v.lost,
      revenue: moneyValue(v.revenueKnown ? v.revenue : null, currency).amount,
      revenueExact: moneyValue(v.revenueKnown ? v.revenue : null, currency).exact,
      revenueLabel: moneyValue(v.revenueKnown ? v.revenue : null, currency).label,
      revenueKnown: v.revenueKnown,
      avgCheck: moneyValue(v.revenueKnown ? v.revenue.div(v.revenueKnown) : null, currency).amount,
      avgCheckLabel: moneyValue(v.revenueKnown ? v.revenue.div(v.revenueKnown) : null, currency).label,
      subcategories: [...v.sub.entries()].map(([sub, count]) => ({ name: sub, count })),
    }))
    .sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0) || b.inquiries - a.inquiries);

  const lossReasons = [...groupCount(current.lostDeals, (d) => d.lossReason || "Другое").entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  const lossByStage = [...groupCount(current.lostDeals, (d) => d.stage?.name || "Не указано").entries()]
    .map(([stage, count]) => {
      const priced = current.lostDeals.filter(d => (d.stage?.name || "Не указано") === stage && d.currency === currency && d.offerAmountMinor != null);
      const money = moneyValue(priced.length ? priced.reduce((sum, d) => sum.plus(d.offerAmountMinor!), new MoneyDecimal(0)) : null, currency);
      return { stage, count, amount: money.amount, amountExact: money.exact, amountLabel: money.label };
    })
    .sort((a, b) => b.count - a.count);

  const cycleDays = current.wonDeals
    .filter((d) => d.closedAt && d.createdAt)
    .map((d) => (d.closedAt!.getTime() - d.createdAt.getTime()) / 86400000);

  const overview = {
    inquiries: current.inquiryCount,
    clients: current.clients,
    requests: current.inquiryCount,
    dealsCreated: current.dealsCreated,
    contracts: current.contractsReached,
    won: current.won,
    lost: current.lost,
    revenue: current.revenueKnown ? current.revenue : null,
    revenueLabel: current.financial.sales.total.label,
    receipts: current.financial.receipts.total.amount,
    receiptsLabel: current.financial.receipts.total.label,
    receiptCount: current.financial.receipts.total.count,
    conversion: current.conversion,
    conversionBasis: "won_over_closed",
    closedDeals: current.won + current.lost,
    avgCheck: current.avgCheck,
    avgCheckLabel: current.financial.sales.total.avg.label,
    deltas: previous
      ? {
          inquiries: deltaPct(current.inquiryCount, previous.inquiryCount),
          won: deltaPct(current.won, previous.won),
          revenue: deltaPct(current.revenue, previous.revenue),
          receipts: deltaPct(current.financial.receipts.total.amount, previous.financial.receipts.total.amount),
          conversionPp: deltaPp(current.conversion, previous.conversion),
        }
      : null,
  };

  const biggestLoss = funnel.transitions.slice().sort((a, b) => b.lost - a.lost)[0] || null;
  const plan = periodSalesPlan({ plans: ops.salesPlans, legacyAmount: ops.salesPlanMinor, currency, timeZone,
    from: range.from, to: range.to, filtered: [query.assignee, query.serviceCategory, query.source, query.channel, query.city, query.campaign].some(Boolean),
    actual: current.financial.sales.total.exact, missingAmounts: current.financial.sales.total.missing });

  const filterLabels = [
    query.serviceCategory,
    query.source,
    query.channel,
    query.city,
    query.campaign,
    query.assignee ? "Менеджер выбран" : null,
  ].filter(Boolean);
  const localDate = (date: Date) => {
    const d = zonedYmd(date, timeZone);
    return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
  };

  return {
    asOf: now.toISOString(),
    coverage: { ...coverage.result(), totalsComplete: true },
    currency,
    period: {
      preset,
      label: periodLabel(preset, range.from, range.to, timeZone, auth.user.locale),
      from: range.from?.toISOString() || null,
      to: range.to?.toISOString() || null,
      dateFrom: range.from ? localDate(range.from) : null,
      dateTo: range.to ? localDate(new Date(range.to.getTime() - 1)) : null,
    },
    compare: {
      mode: compareMode,
      from: cmp.from?.toISOString() || null,
      to: cmp.to?.toISOString() || null,
      label:
        compareMode === "none"
          ? null
          : [cmp.from!, new Date(cmp.to!.getTime() - 1)].map(date => date.toLocaleDateString(auth.user.locale === "kk" ? "kk-KZ" : "ru-RU", { day: "numeric", month: "short", year: "numeric", timeZone })).join(" — "),
    },
    filters: {
      assignee: query.assignee || null,
      serviceCategory: query.serviceCategory || null,
      source: query.source || null,
      channel: query.channel || null,
      city: query.city || null,
      campaign: query.campaign || null,
      label: filterLabels.length ? filterLabels.join(" · ") : null,
    },
    overview,
    financial: current.financial,
    sales: {
      won: current.won,
      revenue: current.revenueKnown ? current.revenue : null,
      revenueLabel: current.financial.sales.total.label,
      receipts: current.financial.receipts.total.amount,
      receiptsLabel: current.financial.receipts.total.label,
      receiptCount: current.financial.receipts.total.count,
      avgCheck: current.avgCheck,
      avgCheckLabel: current.financial.sales.total.avg.label,
      medianCheck: current.medianCheck,
      medianCheckLabel: current.medianCheckLabel,
      maxCheck: current.maxCheck,
      maxCheckLabel: current.financial.sales.total.max.label,
      pipeline: current.pipelineKnown ? current.pipeline : null,
      pipelineLabel: current.financial.pipeline.total.label,
      weightedPipeline: current.pipelineKnown ? current.weighted : null,
      weightedPipelineLabel: current.financial.pipeline.total.weighted.label,
      plan,
      planMinor: plan.amount,
      planLabel: plan.label,
      planPercent: plan.percent,
      cycle: {
        avgDays: cycleDays.length ? Math.round((cycleDays.reduce((a, b) => a + b, 0) / cycleDays.length) * 10) / 10 : null,
        medianDays: median(cycleDays) != null ? Math.round(median(cycleDays)! * 10) / 10 : null,
        minDays: cycleDays.length ? Math.round(Math.min(...cycleDays) * 10) / 10 : null,
        maxDays: cycleDays.length ? Math.round(Math.max(...cycleDays) * 10) / 10 : null,
      },
    },
    funnel,
    biggestLoss,
    stageDurations,
    trend: trendInquiries,
    trendCompare,
    sources,
    services,
    losses: {
      lost: current.lost,
      lostAmount: current.lostAmount,
      lostAmountLabel: current.lostAmountLabel,
      reasons: lossReasons,
      byStage: lossByStage,
    },
    managers: stage2.managers,
    tasks: stage2.tasks,
    communications: stage2.communications,
    aiManager: stage2.aiManager,
    campaigns: stage2.campaigns,
    dataQuality: stage2.dataQuality,
    empty: current.inquiryCount === 0 && current.clients === 0 && current.dealsCreated === 0 && current.won === 0 && current.financial.receipts.count === 0,
  };
}

function phoneFromMethods(
  methods?: Array<{ type: string; rawValue?: string | null; normalizedValue?: string | null; primary?: boolean }> | null,
) {
  if (!methods?.length) return null;
  const phones = methods.filter((item) => item.type === "phone" || item.type === "whatsapp");
  const primary = phones.find((item) => item.primary) || phones[0];
  if (!primary) return null;
  return primary.rawValue || formatPhoneDisplay(primary.normalizedValue) || null;
}

function contactPhone(
  contact?: { methods?: Array<{ type: string; rawValue?: string | null; normalizedValue?: string | null; primary?: boolean }> | null } | null,
  inquiry?: { phoneRaw?: string | null; phoneNormalized?: string | null } | null,
) {
  return phoneFromMethods(contact?.methods) || inquiry?.phoneRaw || formatPhoneDisplay(inquiry?.phoneNormalized) || null;
}

function contactName(contact?: { name?: string | null; firstName?: string | null; lastName?: string | null } | null) {
  if (!contact) return "Без имени";
  return [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim() || contact.name || "Без имени";
}

function emptyStage2() {
  return {
    managers: [] as Array<Record<string, unknown>>,
    tasks: {
      created: 0,
      done: 0,
      doneOnTime: 0,
      doneLate: 0,
      open: 0,
      overdue: 0,
      canceled: 0,
      onTimePct: null as number | null,
      byType: [] as Array<{ type: string; created: number; done: number; overdue: number }>,
      meetings: { calls: 0, online: 0, offline: 0, done: 0, rescheduled: 0, cancelled: 0, missed: 0 },
    },
    communications: {
      inbound: 0,
      outbound: 0,
      dialogs: 0,
      avgResponseMin: null as number | null,
      waitedOver15: 0,
      aiHandled: 0,
      staffHandled: 0,
      handedToHuman: 0,
      responseBuckets: [] as Array<{ key: string; count: number }>,
    },
    aiManager: {
      dialogs: 0,
      clients: 0,
      qualified: 0,
      needIdentified: 0,
      tasksCreated: 0,
      handedToHuman: 0,
      dealsReached: 0,
      won: 0,
      funnel: { clients: 0, qualified: 0, deals: 0, won: 0 },
      handoffReasons: [] as Array<{ reason: string; count: number }>,
    },
    campaigns: [] as Array<Record<string, unknown>>,
    dataQuality: {
      noPhone: 0,
      noSource: 0,
      noService: 0,
      noOwner: 0,
      lostNoReason: 0,
      openNoNextAction: 0,
      dealsNoAmount: 0,
      sampleContacts: 0,
    },
  };
}

async function buildStage2Analytics(
  prisma: PrismaClient,
  tid: string,
  from: Date | null,
  to: Date | null,
  inquiryExtra: Record<string, unknown>,
  dealExtra: Record<string, unknown>,
  currency: string,
  coverage: AnalyticsCoverage,
  filterAssignee?: string,
) {
  const received = rangeFilter(from, to);
  const created = rangeFilter(from, to);
  const now = new Date();

  const members = await prisma.membership.findMany({
    where: { tenantId: tid, active: true, ...(filterAssignee ? { id: filterAssignee } : {}) },
    include: { user: { select: { name: true } } },
  });
  const memberName = new Map(members.map((m) => [m.id, m.user.name || "Менеджер"]));

  const [inquiries, wonDeals, lostDeals, openDeals, tasks, messages, conversations, campaigns, agreements, contactsSample] =
    await Promise.all([
      coverage.read("buildStage2Analytics:inquiries", "Менеджеры: обращения", 5000, take => prisma.inquiry.findMany({
        where: { ...inquiryExtra, ...(received ? { receivedAt: received } : {}) } as never,
        select: {
          id: true,
          assigneeMembershipId: true,
          receivedAt: true,
          firstContactAt: true,
          status: true,
          dealId: true,
        },
        take,
      })),
      coverage.read("buildStage2Analytics:won", "Менеджеры: продажи", 5000, take => prisma.deal.findMany({
        where: { ...dealExtra, outcome: "won", ...(created ? { closedAt: created } : {}) } as never,
        select: {
          id: true,
          assigneeMembershipId: true,
          offerAmountMinor: true,
          wonAmountMinor: true,
          currency: true,
          createdAt: true,
          closedAt: true,
          nextAction: true,
        },
        take,
      })),
      coverage.read("buildStage2Analytics:lost", "Менеджеры: потери", 5000, take => prisma.deal.findMany({
        where: { ...dealExtra, outcome: "lost", ...(created ? { closedAt: created } : {}) } as never,
        select: { id: true, assigneeMembershipId: true },
        take,
      })),
      coverage.read("buildStage2Analytics:open", "Менеджеры: открытые сделки", 3000,
        take => loadProcessDeals(prisma, tid, { ...dealExtra, outcome: "open" }, take)),
      coverage.read("buildStage2Analytics:tasks", "Задачи", 8000, take => prisma.task.findMany({
        where: {
          tenantId: tid,
          ...(created ? { createdAt: created } : {}),
          ...(filterAssignee ? { ownerMembershipId: filterAssignee } : {}),
        },
        select: {
          id: true,
          type: true,
          status: true,
          dueAt: true,
          completedAt: true,
          createdAt: true,
          ownerMembershipId: true,
          source: true,
        },
        take,
      })),
      coverage.read("buildStage2Analytics:messages", "Сообщения", 12000, take => prisma.message.findMany({
        where: {
          tenantId: tid,
          historical: false,
          ...(created ? { createdAt: created } : {}),
        },
        select: {
          id: true,
          conversationId: true,
          direction: true,
          senderKind: true,
          createdAt: true,
          conversation: { select: { assigneeMembershipId: true, mode: true, contactId: true } },
        },
        take,
      })),
      coverage.read("buildStage2Analytics:conversations", "Диалоги", 5000, take => prisma.conversation.findMany({
        where: {
          tenantId: tid,
          ...(created ? { updatedAt: created } : {}),
        },
        select: {
          id: true,
          mode: true,
          assigneeMembershipId: true,
          attentionReason: true,
          contactId: true,
          createdAt: true,
        },
        take,
      })),
      coverage.read("buildStage2Analytics:campaigns", "Рассылки", 100, take => prisma.campaign
        .findMany({
          where: {
            tenantId: tid,
            ...(created ? { createdAt: created } : {}),
          },
          select: {
            id: true,
            title: true,
            createdAt: true,
            startedAt: true,
            recipients: {
              select: {
                status: true,
                deliveredAt: true,
                readAt: true,
                repliedAt: true,
                contactId: true,
                conversationId: true,
              },
            },
          },
          orderBy: { createdAt: "desc" },
          take,
        }))
        .catch((err) => {
          coverage.unavailable("campaigns", "Рассылки");
          console.error("analytics campaigns", err);
          return [];
        }),
      coverage.read("buildStage2Analytics:agreements", "Договорённости", 3000, take => prisma.agreement.findMany({
        where: {
          tenantId: tid,
          ...(created ? { createdAt: created } : {}),
        },
        select: { id: true, clarificationNeeded: true, detectedBy: true, status: true, type: true },
        take,
      })),
      coverage.read("buildStage2Analytics:contacts", "Качество карточек клиентов", 3000, take => prisma.contact.findMany({
        where: { tenantId: tid, archivedAt: null },
        select: {
          id: true,
          ownerMembershipId: true,
          methods: { select: { type: true }, take: 5 },
          inquiries: {
            where: { archived: false },
            select: { sourceType: true, sourceChannel: true, utmSource: true, service: true, serviceCategory: true },
            take: 1,
            orderBy: { receivedAt: "desc" },
          },
        },
        take,
      })),
    ]);

  type Mgr = {
    id: string;
    name: string;
    leads: number;
    won: number;
    lost: number;
    revenue: Prisma.Decimal;
    revenueKnown: number;
    responseMinutes: number[];
    overdueTasks: number;
    noNextAction: number;
    cycles: number[];
  };
  const mgrMap = new Map<string, Mgr>();
  const touchMgr = (id: string | null | undefined) => {
    const key = id || "unassigned";
    if (!mgrMap.has(key)) {
      mgrMap.set(key, {
        id: key,
        name: id ? memberName.get(id) || "Менеджер" : "Без ответственного",
        leads: 0,
        won: 0,
        lost: 0,
        revenue: new MoneyDecimal(0),
        revenueKnown: 0,
        responseMinutes: [],
        overdueTasks: 0,
        noNextAction: 0,
        cycles: [],
      });
    }
    return mgrMap.get(key)!;
  };

  for (const inq of inquiries) {
    const m = touchMgr(inq.assigneeMembershipId);
    m.leads += 1;
    if (inq.firstContactAt && inq.receivedAt) {
      const mins = (inq.firstContactAt.getTime() - inq.receivedAt.getTime()) / 60000;
      if (mins >= 0 && mins < 60 * 24 * 14) m.responseMinutes.push(mins);
    }
  }
  for (const d of wonDeals) {
    const m = touchMgr(d.assigneeMembershipId);
    m.won += 1;
    const n = d.wonAmountMinor ?? d.offerAmountMinor;
    if (n != null && d.currency === currency) { m.revenue = m.revenue.plus(n); m.revenueKnown++; }
    if (d.closedAt && d.createdAt) m.cycles.push((d.closedAt.getTime() - d.createdAt.getTime()) / 86400000);
  }
  for (const d of lostDeals) touchMgr(d.assigneeMembershipId).lost += 1;
  for (const d of openDeals) {
    if (nextStepForDeal(d).issue) touchMgr(d.assigneeMembershipId).noNextAction += 1;
  }
  for (const t of tasks) {
    if (PROCESS_OPEN_TASK_STATUSES.includes(t.status) && t.dueAt && t.dueAt < now) touchMgr(t.ownerMembershipId).overdueTasks += 1;
  }

  const managers = [...mgrMap.values()]
    .map((m) => ({
      id: m.id,
      name: m.name,
      attribution: "Текущий ответственный / ответственный на сделке",
      leads: m.leads,
      won: m.won,
      lost: m.lost,
      conversion: closedDealConversion(m.won, m.lost),
      closed: m.won + m.lost,
      revenue: moneyValue(m.revenueKnown ? m.revenue : null, currency).amount,
      revenueExact: moneyValue(m.revenueKnown ? m.revenue : null, currency).exact,
      revenueLabel: moneyValue(m.revenueKnown ? m.revenue : null, currency).label,
      revenueKnown: m.revenueKnown,
      avgCheck: moneyValue(m.revenueKnown ? m.revenue.div(m.revenueKnown) : null, currency).amount,
      avgCheckLabel: moneyValue(m.revenueKnown ? m.revenue.div(m.revenueKnown) : null, currency).label,
      avgFirstResponseMin:
        m.responseMinutes.length
          ? Math.round(m.responseMinutes.reduce((a, b) => a + b, 0) / m.responseMinutes.length)
          : null,
      overdueTasks: m.overdueTasks,
      noNextAction: m.noNextAction,
      avgCycleDays:
        m.cycles.length ? Math.round((m.cycles.reduce((a, b) => a + b, 0) / m.cycles.length) * 10) / 10 : null,
    }))
    .sort((a, b) => b.won - a.won || b.leads - a.leads);

  const taskCreated = tasks.length;
  const taskDone = tasks.filter((t) => t.status === "done" || t.completedAt).length;
  const taskOpen = tasks.filter((t) => t.status === "open").length;
  const taskCanceled = tasks.filter((t) => t.status === "canceled" || t.status === "cancelled").length;
  const taskOverdue = tasks.filter((t) => t.status === "open" && t.dueAt && t.dueAt < now).length;
  const taskDoneOnTime = tasks.filter(
    (t) => t.completedAt && t.dueAt && t.completedAt <= t.dueAt,
  ).length;
  const taskDoneLate = tasks.filter(
    (t) => t.completedAt && t.dueAt && t.completedAt > t.dueAt,
  ).length;
  const byType = new Map<string, { created: number; done: number; overdue: number }>();
  for (const t of tasks) {
    if (!byType.has(t.type)) byType.set(t.type, { created: 0, done: 0, overdue: 0 });
    const row = byType.get(t.type)!;
    row.created += 1;
    if (t.status === "done" || t.completedAt) row.done += 1;
    if (t.status === "open" && t.dueAt && t.dueAt < now) row.overdue += 1;
  }

  const meetings = {
    calls: tasks.filter((t) => t.type === "call").length,
    online: agreements.filter((a) => a.type === "ONLINE_MEETING").length,
    offline: agreements.filter((a) => a.type === "OFFLINE_MEETING" || a.type === "MEETING").length,
    done: agreements.filter((a) => a.status === "COMPLETED" || a.status === "CONFIRMED").length,
    rescheduled: agreements.filter((a) => a.status === "RESCHEDULED").length,
    cancelled: agreements.filter((a) => a.status === "CANCELLED").length,
    missed: agreements.filter((a) => a.status === "MISSED" || a.status === "NO_SHOW").length,
  };

  const inbound = messages.filter((m) => m.direction === "inbound" || m.senderKind === "client").length;
  const outbound = messages.filter((m) => m.direction === "outbound").length;
  const dialogIds = new Set(messages.map((m) => m.conversationId));
  const aiHandled = messages.filter((m) => m.senderKind === "ai").length;
  const staffHandled = messages.filter((m) => m.senderKind === "staff" || m.senderKind === "user").length;
  const handedToHuman = conversations.filter(
    (c) => c.mode === "human" || c.attentionReason === "taken_by_human" || c.attentionReason === "escalate",
  ).length;

  // Response buckets: first staff/ai reply after inbound per conversation in sample
  const byConv = new Map<string, typeof messages>();
  for (const m of messages) {
    if (!byConv.has(m.conversationId)) byConv.set(m.conversationId, []);
    byConv.get(m.conversationId)!.push(m);
  }
  const responseBuckets = [
    { key: "<5м", count: 0 },
    { key: "5–15м", count: 0 },
    { key: "15–30м", count: 0 },
    { key: "30–60м", count: 0 },
    { key: "1ч+", count: 0 },
  ];
  let responseSum = 0;
  let responseN = 0;
  let waitedOver15 = 0;
  for (const list of byConv.values()) {
    const sorted = [...list].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const firstIn = sorted.find((m) => m.direction === "inbound" || m.senderKind === "client");
    if (!firstIn) continue;
    const firstOut = sorted.find(
      (m) =>
        m.createdAt > firstIn.createdAt &&
        m.direction === "outbound" &&
        (m.senderKind === "staff" || m.senderKind === "user" || m.senderKind === "ai"),
    );
    if (!firstOut) continue;
    const mins = (firstOut.createdAt.getTime() - firstIn.createdAt.getTime()) / 60000;
    if (mins < 0 || mins > 60 * 24 * 7) continue;
    responseSum += mins;
    responseN += 1;
    if (mins > 15) waitedOver15 += 1;
    if (mins < 5) responseBuckets[0].count += 1;
    else if (mins < 15) responseBuckets[1].count += 1;
    else if (mins < 30) responseBuckets[2].count += 1;
    else if (mins < 60) responseBuckets[3].count += 1;
    else responseBuckets[4].count += 1;
  }

  const aiConversationIds = new Set(
    messages.filter((m) => m.senderKind === "ai").map((m) => m.conversationId),
  );
  const aiContactIds = new Set(
    messages
      .filter((m) => m.senderKind === "ai" && m.conversation?.contactId)
      .map((m) => m.conversation!.contactId!),
  );
  const wonWithAiContact = await prisma.deal.count({
    where: {
      tenantId: tid,
      outcome: "won",
      ...(created ? { closedAt: created } : {}),
      contactId: aiContactIds.size ? { in: [...aiContactIds] } : { in: [] },
    },
  });
  const dealsWithAi = await prisma.deal.count({
    where: {
      tenantId: tid,
      ...(created ? { createdAt: created } : {}),
      contactId: aiContactIds.size ? { in: [...aiContactIds] } : { in: [] },
    },
  });
  const qualifiedAi = inquiries.filter((i) =>
    ["qualified", "accepted", "in_progress", "waiting_client", "waiting_manager", "proposal", "converted"].includes(
      i.status,
    ),
  ).length;
  const aiTasks = tasks.filter((t) => t.source === "ai" || t.source === "context_engine" || t.source === "agreement").length;
  const handoffReasons = [...groupCount(
    agreements.filter((a) => a.clarificationNeeded),
    (a) => a.clarificationNeeded || "Другое",
  ).entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);

  // Campaign attribution: recipients replied → later inquiries/deals on same contact
  const campaignRows = [];
  for (const c of campaigns) {
    const recipients = c.recipients.length;
    const delivered = c.recipients.filter((r) => r.deliveredAt || r.status === "delivered" || r.status === "sent").length;
    const read = c.recipients.filter((r) => r.readAt).length;
    const replied = c.recipients.filter((r) => r.repliedAt).length;
    const contactIds = c.recipients.map((r) => r.contactId).filter(Boolean) as string[];
    let deals = 0;
    let won = 0;
    let inquiriesCount = 0;
    if (contactIds.length) {
      const after = c.startedAt || c.createdAt;
      inquiriesCount = await prisma.inquiry.count({
        where: { tenantId: tid, contactId: { in: contactIds }, receivedAt: { gte: after }, test: false },
      });
      deals = await prisma.deal.count({
        where: { tenantId: tid, contactId: { in: contactIds }, createdAt: { gte: after } },
      });
      won = await prisma.deal.count({
        where: { tenantId: tid, contactId: { in: contactIds }, outcome: "won", closedAt: { gte: after } },
      });
    }
    campaignRows.push({
      id: c.id,
      title: c.title,
      recipients,
      delivered,
      read,
      replied,
      inquiries: inquiriesCount,
      deals,
      won,
      funnel: { recipients, delivered, read, replied, inquiries: inquiriesCount, deals, won },
    });
  }

  let noPhone = 0;
  let noSource = 0;
  let noService = 0;
  let noOwner = 0;
  for (const c of contactsSample) {
    if (!c.methods.some((m) => m.type === "phone" || m.type === "whatsapp")) noPhone += 1;
    if (!c.ownerMembershipId) noOwner += 1;
    const inq = c.inquiries[0];
    if (!inq || (!inq.utmSource && !inq.sourceChannel && !inq.sourceType)) noSource += 1;
    if (!inq || (!inq.service && !inq.serviceCategory)) noService += 1;
  }
  const lostNoReason = lostDeals.length
    ? await prisma.deal.count({
        where: {
          tenantId: tid,
          outcome: "lost",
          OR: [{ lossReason: null }, { lossReason: "" }],
          ...(created ? { closedAt: created } : {}),
        },
      })
    : 0;
  const openNoNext = openDeals.filter((d) => nextStepForDeal(d).issue).length;
  const dealsNoAmount = await prisma.deal.count({
    where: { tenantId: tid, offerAmountMinor: null, ...(created ? { createdAt: created } : {}) },
  });

  return {
    managers,
    tasks: {
      created: taskCreated,
      done: taskDone,
      doneOnTime: taskDoneOnTime,
      doneLate: taskDoneLate,
      open: taskOpen,
      overdue: taskOverdue,
      canceled: taskCanceled,
      onTimePct: pct(taskDoneOnTime, taskDoneOnTime + taskDoneLate),
      byType: [...byType.entries()]
        .map(([type, v]) => ({ type, ...v }))
        .sort((a, b) => b.created - a.created),
      meetings,
    },
    communications: {
      inbound,
      outbound,
      dialogs: dialogIds.size,
      avgResponseMin: responseN ? Math.round(responseSum / responseN) : null,
      waitedOver15,
      aiHandled,
      staffHandled,
      handedToHuman,
      responseBuckets,
    },
    aiManager: {
      dialogs: aiConversationIds.size,
      clients: aiContactIds.size,
      qualified: qualifiedAi,
      needIdentified: qualifiedAi,
      tasksCreated: aiTasks,
      handedToHuman,
      dealsReached: dealsWithAi,
      won: wonWithAiContact,
      funnel: {
        clients: aiContactIds.size,
        qualified: qualifiedAi,
        deals: dealsWithAi,
        won: wonWithAiContact,
      },
      handoffReasons: handoffReasons.length
        ? handoffReasons
        : [
            { reason: "Клиент попросил человека", count: handedToHuman },
          ].filter((r) => r.count > 0),
    },
    campaigns: campaignRows,
    dataQuality: {
      noPhone,
      noSource,
      noService,
      noOwner,
      lostNoReason,
      openNoNextAction: openNoNext,
      dealsNoAmount,
      sampleContacts: contactsSample.length,
    },
  };
}

async function buildStageDurations(prisma: PrismaClient, tid: string, from: Date | null, to: Date | null, coverage: AnalyticsCoverage,
  dealExtra: Record<string, unknown>, ops: TenantOpsSettings, clock: ProcessClock, now: Date) {
  const entered = rangeFilter(from, to);
  const history = await coverage.read("buildStageDurations:history", "Длительность этапов", 8000, take => prisma.dealStageHistory.findMany({
    where: { tenantId: tid, deal: { is: dealExtra }, ...(entered ? { enteredAt: entered } : {}) },
    orderBy: { enteredAt: "asc" },
    take,
  }));
  const byStage = new Map<string, number[]>();
  for (const row of history) {
    if (!row.leftAt) continue;
    const hours = (row.leftAt.getTime() - row.enteredAt.getTime()) / 3600000;
    if (hours < 0) continue;
    const key = row.toSystemKey;
    if (!byStage.has(key)) byStage.set(key, []);
    byStage.get(key)!.push(hours);
  }
  const openStuck = await coverage.read("buildStageDurations:stalled", "Задержки на этапах", 2000,
    take => loadProcessDeals(prisma, tid, { ...dealExtra, outcome: "open" }, take));
  const stuckMap = new Map<string, number>();
  for (const d of openStuck) {
    if (flagsForDeal(d, ops, now, clock).stalled) stuckMap.set(d.stage.systemKey, (stuckMap.get(d.stage.systemKey) || 0) + 1);
  }

  const stages = await prisma.dealStage.findMany({ where: { tenantId: tid }, orderBy: { sortOrder: "asc" } });
  return stages.filter(s => !s.isTerminal && !s.isArchived || byStage.has(s.systemKey) || openStuck.some(deal => deal.stage.systemKey === s.systemKey)).map((s) => {
    const hours = byStage.get(s.systemKey) || [];
    const avg = hours.length ? hours.reduce((a, b) => a + b, 0) / hours.length : null;
    const med = median(hours);
    return {
      systemKey: s.systemKey,
      name: s.name,
      avgHours: avg != null ? Math.round(avg * 10) / 10 : null,
      medianHours: med != null ? Math.round(med * 10) / 10 : null,
      stalled: stuckMap.get(s.systemKey) || 0,
      samples: hours.length,
    };
  });
}

export async function getAnalyticsTrend(
  prisma: PrismaClient,
  auth: AuthContext,
  query: AnalyticsQuery & { metric?: string },
) {
  requireAnalyticsAccess(auth);
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const timeZone = membership.tenant.timezone || "Asia/Almaty";
  const preset = parsePreset(query.period);
  const range = resolvePeriodRange(timeZone, preset, query.dateFrom, query.dateTo);
  const { inquiryExtra, dealExtra } = await buildFilters(prisma, query, tid);
  const metric = (["inquiries", "clients", "deals", "won", "revenue", "receipts", "conversion"].includes(String(query.metric))
    ? query.metric
    : "inquiries") as TrendMetric;
  return buildTrend(prisma, tid, range.from, range.to, preset, timeZone, inquiryExtra, dealExtra, metric, auth.user.locale, new AnalyticsCoverage(), "trend", membership.tenant.currency || "KZT");
}

export type DrillEntity =
  | "inquiries"
  | "payments"
  | "clients"
  | "deals"
  | "won"
  | "lost"
  | "source_won"
  | "source_inquiries"
  | "service_won"
  | "loss_reason"
  | "loss_stage"
  | "manager_won"
  | "manager_lost"
  | "manager_leads";

function dealRow(
  d: {
    id: string;
    title: string;
    closedAt?: Date | null;
    createdAt: Date;
    outcome?: string;
    currency?: string;
    offerAmountMinor?: { toString(): string } | null;
    wonAmountMinor?: { toString(): string } | null;
    lossReason?: string | null;
    assigneeMembershipId?: string | null;
    contact?: {
      name?: string | null;
      firstName?: string | null;
      lastName?: string | null;
      methods?: Array<{ type: string; rawValue?: string | null; normalizedValue?: string | null; primary?: boolean }>;
    } | null;
    inquiry?: { phoneRaw?: string | null; phoneNormalized?: string | null } | null;
    stage?: { name?: string | null } | null;
  },
  currency: string,
  managerNames: Map<string, string>,
) {
  const money = moneyValue((d.outcome === "won" ? d.wonAmountMinor ?? d.offerAmountMinor : d.offerAmountMinor)?.toString(), d.currency || currency);
  return {
    kind: "deal" as const,
    id: d.id,
    date: (d.closedAt || d.createdAt).toISOString(),
    client: contactName(d.contact),
    phone: contactPhone(d.contact, d.inquiry),
    title: d.title,
    amount: money.amount,
    amountExact: money.exact,
    amountLabel: money.label,
    status: d.outcome || d.stage?.name || "—",
    lossReason: d.lossReason || null,
    manager: d.assigneeMembershipId ? managerNames.get(d.assigneeMembershipId) || "—" : "—",
    href: `/deals/${d.id}`,
  };
}

export async function getAnalyticsDrilldown(
  prisma: PrismaClient,
  auth: AuthContext,
  query: AnalyticsQuery & { entity?: string; key?: string },
) {
  requireAnalyticsAccess(auth);
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const timeZone = membership.tenant.timezone || "Asia/Almaty";
  const currency = membership.tenant.currency || "KZT";
  const preset = parsePreset(query.period);
  const range = resolvePeriodRange(timeZone, preset, query.dateFrom, query.dateTo);
  const { inquiryExtra, dealExtra } = await buildFilters(prisma, query, tid);
  const received = rangeFilter(range.from, range.to);
  const entity = String(query.entity || "won") as DrillEntity;
  const key = query.key || "";

  const members = await prisma.membership.findMany({
    where: { tenantId: tid },
    include: { user: { select: { name: true } } },
  });
  const managerNames = new Map(members.map((m) => [m.id, m.user.name || "Менеджер"]));

  const titleMap: Record<string, string> = {
    payments: "Подтверждённые оплаты",
    inquiries: "Обращения",
    clients: "Уникальные клиенты",
    deals: "Созданные сделки",
    won: "Продажи",
    lost: "Потери",
    source_won: `Источник → продажи: ${key}`,
    source_inquiries: `Источник → обращения: ${key}`,
    service_won: `Услуга → продажи: ${key}`,
    loss_reason: `Причина потери: ${key}`,
    loss_stage: `Потери на стадии: ${key}`,
    manager_won: `Менеджер → продажи`,
    manager_lost: `Менеджер → потери`,
    manager_leads: `Менеджер → обращения`,
  };

  if (entity === "payments") {
    const where = { ...confirmedPaymentsWhere(tid, dealExtra as Prisma.DealWhereInput, received), currency };
    const [total, rows] = await Promise.all([
      prisma.paymentRecord.count({ where }),
      prisma.paymentRecord.findMany({ where, orderBy: [{ confirmedAt: "desc" }, { id: "desc" }], take: 500,
        include: { deal: { include: { contact: { include: { methods: true } }, inquiry: true } } } }),
    ]);
    return { entity, key, title: titleMap.payments, total, hasMore: total > rows.length,
      items: rows.map(row => {
        const money = moneyValue(row.amountMinor, row.currency);
        return { kind: "payment" as const, id: row.id, date: row.confirmedAt.toISOString(),
          client: contactName(row.deal.contact), phone: contactPhone(row.deal.contact, row.deal.inquiry),
          title: row.deal.title, amount: money.amount, amountExact: money.exact, amountLabel: money.label,
          status: "confirmed", manager: managerNames.get(row.deal.assigneeMembershipId || "") || "—", href: `/deals/${row.dealId}` };
      }) };
  }

  if (entity === "clients") {
    const where = {
      ...contactAnalyticsFilter(tid, inquiryExtra),
      ...(received ? { firstSeenAt: received } : {}),
    };
    const total = await prisma.contact.count({ where });
    const rows = await prisma.contact.findMany({
      where,
      include: {
        methods: true,
        owner: { include: { user: { select: { name: true } } } },
      },
      orderBy: { firstSeenAt: "desc" },
      take: 500,
    });
    return {
      entity,
      key,
      title: titleMap.clients,
      total,
      hasMore: total > rows.length,
      items: rows.map((c) => ({
        kind: "contact" as const,
        id: c.id,
        date: c.firstSeenAt.toISOString(),
        client: displayName(c),
        phone: phoneFromMethods(c.methods),
        title: c.companyName || "Клиент",
        status: c.lifecycleStatus || "—",
        source: null,
        manager: c.owner?.user?.name || "—",
        href: `/contacts/${c.id}`,
        amountLabel: null,
      })),
    };
  }

  if (entity === "inquiries" || entity === "source_inquiries" || entity === "manager_leads") {
    const where: Prisma.InquiryWhereInput = { AND: [
      inquiryExtra,
      ...(received ? [{ receivedAt: received }] : []),
      ...(entity === "manager_leads" ? [{ assigneeMembershipId: key === "unassigned" ? null : key }] : []),
      ...(entity === "source_inquiries" ? [inquiryLabelFilter(["utmSource", "sourceChannel", "sourceType"], key)] : []),
    ] };
    const total = await prisma.inquiry.count({ where });
    const rows = await prisma.inquiry.findMany({
      where,
      include: {
        contact: { select: { name: true, firstName: true, lastName: true, methods: true } },
        assignee: { include: { user: { select: { name: true } } } },
      },
      orderBy: { receivedAt: "desc" },
      take: 500,
    });
    return {
      entity,
      key,
      title: titleMap[entity] || entity,
      total,
      hasMore: total > rows.length,
      items: rows.map((r) => ({
        kind: "inquiry" as const,
        id: r.id,
        date: r.receivedAt.toISOString(),
        client: contactName(r.contact),
        phone: contactPhone(r.contact, r),
        title: r.service || r.serviceCategory || "Обращение",
        status: r.status,
        source: inquirySourceLabel(r),
        manager: r.assignee?.user?.name || "—",
        href: `/requests/${r.id}`,
        amountLabel: null,
      })),
    };
  }

  const dealWhereBase: Record<string, unknown> = { ...dealExtra };
  if (entity === "won" || entity === "source_won" || entity === "service_won" || entity === "manager_won") {
    dealWhereBase.outcome = "won";
    if (received) dealWhereBase.closedAt = received;
  } else if (entity === "lost" || entity === "loss_reason" || entity === "loss_stage" || entity === "manager_lost") {
    dealWhereBase.outcome = "lost";
    if (received) dealWhereBase.closedAt = received;
  } else if (entity === "deals") {
    if (received) dealWhereBase.createdAt = received;
  }

  if (entity === "manager_won" || entity === "manager_lost") {
    if (key === "unassigned") dealWhereBase.assigneeMembershipId = null;
    else if (key) dealWhereBase.assigneeMembershipId = key;
  }
  if (entity === "loss_reason" && key && key !== "Другое") {
    dealWhereBase.lossReason = key;
  }

  const extra: Prisma.DealWhereInput[] = [];
  if (entity === "source_won") extra.push(await dealsWithInquiryLabel(prisma, tid, ["utmSource", "sourceChannel", "sourceType"], key));
  if (entity === "service_won") extra.push(await dealsWithInquiryLabel(prisma, tid, ["serviceCategory", "service"], key));
  if (entity === "loss_stage") extra.push({ stage: { name: key } });
  if (entity === "loss_reason" && key === "Другое") extra.push({ OR: [{ lossReason: null }, { lossReason: "" }, { lossReason: "Другое" }] });
  const where: Prisma.DealWhereInput = { AND: [dealWhereBase, ...extra] };
  const total = await prisma.deal.count({ where });

  const deals = await prisma.deal.findMany({
    where,
    include: {
      contact: { select: { name: true, firstName: true, lastName: true, methods: true } },
      stage: { select: { name: true } },
      inquiry: {
        select: {
          utmSource: true,
          sourceChannel: true,
          sourceType: true,
          service: true,
          serviceCategory: true,
          phoneRaw: true,
          phoneNormalized: true,
        },
      },
    },
    orderBy: { updatedAt: "desc" },
    take: 500,
  });

  return {
    entity,
    key,
    title: titleMap[entity] || entity,
    total,
    hasMore: total > deals.length,
    items: deals.map((d) => dealRow(d, currency, managerNames)),
  };
}

export async function getAnalyticsExportPayload(prisma: PrismaClient, auth: AuthContext, query: AnalyticsQuery) {
  return getAnalyticsDashboard(prisma, auth, query);
}
