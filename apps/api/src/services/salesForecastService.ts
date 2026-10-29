import type { Prisma, PrismaClient } from "@creolab/db";
import type { SalesForecast, SalesForecastMonth } from "@creolab/contracts";
import { businessDealWhere, moneyValue, wonSalesTotals } from "./financialMetrics.ts";
import type { AuthContext } from "../lib/types.ts";
import { requireAnalyticsAccess, requireTenant } from "../lib/access.ts";
import { parseOpsSettings } from "./dealPipeline.ts";
import { calculateSalesForecast, forecastContext, forecastMonth, FORECAST_MAX_MONTHS } from "./salesForecastPolicy.ts";
import { zonedYmd } from "./periodRange.ts";

/** A focused read for Control: no charts, contacts or unrelated reports loaded. */
export async function getCompanySalesForecast(prisma: PrismaClient, auth: AuthContext, now = new Date()) {
  requireAnalyticsAccess(auth);
  const membership = requireTenant(auth), tenantId = membership.tenantId;
  const timeZone = membership.tenant.timezone || "Asia/Almaty", currency = membership.tenant.currency || "KZT";
  const [dealWhere, tenant] = await Promise.all([
    businessDealWhere(prisma, tenantId),
    prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settingsJson: true } }),
  ]);
  const today = zonedYmd(now, timeZone), month = `${today.year}-${String(today.month).padStart(2, "0")}`;
  const monthlyPlan = parseOpsSettings(tenant.settingsJson).salesPlans.find(row => row.month === month && row.currency === currency)?.amount ?? null;
  return getSalesForecast(prisma, { tenantId, dealWhere, timeZone, currency, now, period: "this_month", filtered: false, monthlyPlan });
}

export async function getSalesForecast(prisma: PrismaClient, input: {
  tenantId: string;
  dealWhere: Prisma.DealWhereInput;
  timeZone: string;
  currency: string;
  now: Date;
  period: string;
  filtered: boolean;
  monthlyPlan: number | null;
}): Promise<SalesForecast> {
  const base = forecastContext(input.now, input.timeZone, input.currency, input.filtered);
  // A forecast horizon must never silently differ from the selected report.
  if (input.period !== "this_month") return { ...base, status: "unsupported_period" };
  const today = zonedYmd(input.now, input.timeZone);
  const where: Prisma.DealWhereInput = { AND: [input.dealWhere, { tenantId: input.tenantId }] };
  const sameCurrency: Prisma.DealWhereInput = { AND: [where, { currency: input.currency }] };
  try {
    // All inputs share a database snapshot; an edited amount cannot enter only
    // the numerator or only the history. Aggregates have no detail-row limit.
    return await prisma.$transaction(async tx => {
      const first = await tx.deal.findFirst({ where: sameCurrency, orderBy: { createdAt: "asc" }, select: { createdAt: true } });
      const months = Array.from({ length: FORECAST_MAX_MONTHS }, (_, i) => forecastMonth(input.timeZone, today.year, today.month - FORECAST_MAX_MONTHS + i))
        .filter(month => first && month.from >= first.createdAt);
      const from = months[0]?.from || new Date(base.from);
      const window = { gte: from, lte: input.now };
      const won: Prisma.DealWhereInput = { AND: [sameCurrency, { outcome: "won" }] };
      async function total(month: ReturnType<typeof forecastMonth>, period: Prisma.DateTimeFilter): Promise<SalesForecastMonth> {
        const value = await wonSalesTotals(tx, sameCurrency, period, input.currency);
        return { month: month.month, days: month.days, sales: value.total.count, missingAmounts: value.total.missing,
          total: value.total.count ? moneyValue(value.total.exact, input.currency) : moneyValue(0, input.currency) };
      }
      const [history, current, missingClosedDates, futureClosedDates, negativeAmounts, otherCurrencySales] = await Promise.all([
        Promise.all(months.map(month => total(month, { gte: month.from, lt: month.to }))),
        total(forecastMonth(input.timeZone, today.year, today.month), { gte: new Date(base.from), lte: input.now }),
        tx.deal.count({ where: { AND: [won, { closedAt: null }] } }),
        tx.deal.count({ where: { AND: [won, { closedAt: { gt: input.now } }] } }),
        tx.deal.count({ where: { AND: [won, { closedAt: window, OR: [
          { wonAmountMinor: { lt: 0 } }, { wonAmountMinor: null, offerAmountMinor: { lt: 0 } },
        ] }] } }),
        tx.deal.count({ where: { AND: [where, { outcome: "won", currency: { not: input.currency }, closedAt: window }] } }),
      ]);
      return calculateSalesForecast(base, { history, current, monthlyPlan: input.monthlyPlan,
        evidence: { firstRecordAt: first?.createdAt.toISOString() || null, missingClosedDates, futureClosedDates, negativeAmounts, otherCurrencySales } });
    }, { isolationLevel: "RepeatableRead", maxWait: 3000, timeout: 10000 });
  } catch {
    // Forecast failure must not invent zero sales or break the main report.
    console.error("analytics sales forecast unavailable", { tenantId: input.tenantId });
    return { ...base, status: "unavailable" };
  }
}
