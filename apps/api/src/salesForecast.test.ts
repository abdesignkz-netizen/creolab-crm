import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createPrismaClient, type Prisma } from "@creolab/db";
import type { SalesForecastMonth } from "@creolab/contracts";
import type { AuthContext } from "./lib/types.ts";
import { authForUserInTenant } from "./services/authService.ts";
import { getTenantOps, updateTenantOps } from "./services/dealService.ts";
import { getAnalyticsDashboard } from "./services/analyticsService.ts";
import { getSalesForecast } from "./services/salesForecastService.ts";
import { calculateSalesForecast, forecastContext, forecastMonth } from "./services/salesForecastPolicy.ts";
import { businessDealWhere, moneyValue } from "./services/financialMetrics.ts";
import { zonedYmd } from "./services/periodRange.ts";

const at = new Date("2029-10-16T07:00:00Z"); // 15.5 local days elapsed; 15.5 remain.
const context = () => forecastContext(at, "Asia/Almaty", "KZT");
function month(month: string, days: number, amount: string | number, sales = 5): SalesForecastMonth {
  return { month, days, sales, missingAmounts: 0, total: moneyValue(amount, "KZT") };
}
const history = () => [month("2029-04", 30, 3000), month("2029-05", 31, 6200), month("2029-06", 30, 3000),
  month("2029-07", 31, 3100), month("2029-08", 31, 0, 0), month("2029-09", 30, 3000)];
const inputs = () => ({ history: history(), current: month("2029-10", 31, 700, 2), evidence: {}, monthlyPlan: 3100 });

describe("transparent monthly sales forecast policy", () => {
  it("anchors an exact reproducible range to actual sales and preserves its inputs", () => {
    const base = context(), input = inputs(), before = JSON.stringify({ base, input });
    const f = calculateSalesForecast(base, input);
    assert.equal(f.status, "ready"); assert.equal(f.estimate.exact, "2250");
    assert.equal(f.range.low.exact, "700"); assert.equal(f.range.high.exact, "3800");
    assert.equal(f.elapsedDays, 15.5); assert.equal(f.remainingDays, 15.5);
    assert.equal(f.target.status, "at_risk"); assert.equal(f.target.estimatedGap.exact, "850");
    assert.equal(f.target.estimatedPercent, 72.6); assert.equal(f.deviation.status, "below");
    assert.equal(f.deviation.percent, -54.8); assert.equal(f.deviation.expected.exact, "1550");
    assert.equal(JSON.stringify({ base, input }), before);
  });
  it("uses walk-forward validation without the target month's data or future months", () => {
    const input = inputs(), f = calculateSalesForecast(context(), input);
    assert.deepEqual(f.validation.periods.map(p => [p.month, p.estimate.exact, p.actual.exact, p.absoluteError.exact]),
      [["2029-07", "3100", "3100", "0"], ["2029-08", "3100", "0", "3100"], ["2029-09", "3000", "3000", "0"]]);
    assert.equal(f.validation.meanAbsoluteError.exact, "1033"); assert.equal(f.validation.weightedAbsoluteErrorPercent, 50.8);
    input.history[5] = month("2029-09", 30, 900000);
    const changed = calculateSalesForecast(context(), input);
    assert.deepEqual(changed.validation.periods.map(p => p.estimate.exact), f.validation.periods.map(p => p.estimate.exact));
  });
  it("withholds an estimate for short or sparse history and never substitutes missing amounts with zero", () => {
    for (const input of [{ ...inputs(), history: history().slice(0, 2) }, { ...inputs(), history: history().map(m => ({ ...m, sales: 1 })) }]) {
      const f = calculateSalesForecast(context(), input); assert.equal(f.status, "insufficient_history"); assert.equal(f.estimate.exact, null);
    }
    const missing = inputs(); missing.history[2].missingAmounts = 1;
    assert.equal(calculateSalesForecast(context(), missing).status, "incomplete_data");
    for (const key of ["missingClosedDates", "negativeAmounts", "futureClosedDates"] as const) {
      const f = calculateSalesForecast(context(), { ...inputs(), evidence: { [key]: 1 } });
      assert.equal(f.status, "incomplete_data"); assert.equal(f.range.low.exact, null); assert.equal(f.target.status, "unavailable");
    }
  });
  it("retains genuine zero months, avoids division by zero and does not invent a validation result", () => {
    const f = calculateSalesForecast(context(), { ...inputs(), history: history().map(m => ({ ...m, total: moneyValue(0, "KZT"), sales: 5 })), monthlyPlan: 0 });
    assert.equal(f.status, "ready"); assert.equal(f.estimate.exact, "700"); assert.equal(f.deviation.status, "no_baseline");
    assert.equal(f.deviation.percent, null); assert.equal(f.target.status, "zero_target"); assert.equal(f.target.estimatedPercent, null);
    assert.equal(f.validation.weightedAbsoluteErrorPercent, null);
    const short = calculateSalesForecast(context(), { ...inputs(), history: history().slice(0, 3) });
    assert.equal(short.status, "ready"); assert.equal(short.validation.periods.length, 0); assert.equal(short.validation.meanAbsoluteError.exact, null);
  });
  it("compares plans only for the company and distinguishes a risk, range and achieved fact", () => {
    for (const [plan, status] of [[null, "not_set"], [5000, "below_range"], [3100, "at_risk"], [2000, "within_range"], [600, "achieved"]] as const) {
      assert.equal(calculateSalesForecast(context(), { ...inputs(), monthlyPlan: plan }).target.status, status);
    }
    const positive = inputs(); positive.history = history().filter(m => m.sales);
    assert.equal(calculateSalesForecast(context(), { ...positive, monthlyPlan: 1000 }).target.status, "range_above_plan");
    assert.equal(calculateSalesForecast({ ...context(), filtered: true }, inputs()).target.status, "filtered");
  });
  it("uses local calendar days, including DST, leap years, end-of-month and year rollover", () => {
    const leap = forecastContext(new Date("2028-02-29T23:59:59.999Z"), "UTC", "KZT");
    assert.ok(leap.remainingDays > 0 && leap.remainingDays < .000001);
    assert.equal(leap.from, "2028-02-01T00:00:00.000Z"); assert.equal(leap.to, "2028-03-01T00:00:00.000Z");
    const dst = forecastContext(new Date("2026-03-29T10:30:00Z"), "Europe/Berlin", "EUR");
    assert.equal(dst.elapsedDays, 28.5); assert.equal(dst.remainingDays, 2.5);
    const after = forecastContext(new Date("2026-03-29T22:00:00Z"), "Europe/Berlin", "EUR"); assert.equal(after.elapsedDays, 29);
    const edge = forecastContext(new Date("2028-12-31T19:00:00Z"), "Asia/Almaty", "KZT");
    assert.equal(edge.month, "2029-01"); assert.equal(edge.elapsedDays, 0); assert.equal(edge.remainingDays, 31);
    const f = calculateSalesForecast(edge, { ...inputs(), current: month("2029-01", 31, 0, 0) });
    assert.equal(f.deviation.status, "too_early"); assert.equal(f.estimate.exact, "3100");
    assert.equal(forecastMonth("Asia/Almaty", 2029, 0).month, "2028-12");
  });
  it("keeps monetary precision above safe JavaScript integers and treats fallback zero as known", () => {
    const f = calculateSalesForecast(context(), { ...inputs(), current: month("2029-10", 31, "900719925474099300"), monthlyPlan: null });
    assert.equal(f.estimate.exact, "900719925474100850"); assert.equal(f.estimate.amount, null);
    assert.ok(!JSON.stringify(f).includes("NaN"));
  });
});

describe("sales forecast integration and isolation", () => {
  let db: Awaited<ReturnType<typeof createPrismaClient>>;
  let auth: AuthContext, foreign: AuthContext, manager: AuthContext;
  let tid: string, stageId: string, contactId: string, historicalId: string;
  const now = new Date(), timeZone = "Asia/Almaty", currency = "KZT";
  const today = zonedYmd(now, timeZone);
  const current = forecastMonth(timeZone, today.year, today.month);
  const months = Array.from({ length: 6 }, (_, i) => forecastMonth(timeZone, today.year, today.month - 6 + i));
  const start = new Date(months[0].from.getTime() - 15 * 86400000);
  const originalFetch = globalThis.fetch;
  async function company() {
    const tenant = await db.tenant.create({ data: { slug: randomUUID(), name: "Forecast tests", timezone: timeZone } });
    const user = await db.user.create({ data: { name: "Owner", email: `${randomUUID()}@example.test`, passwordHash: "unused" } });
    await db.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: "owner" } });
    return authForUserInTenant(db, user.id, tenant.id, "forecast-test");
  }
  async function deal(data: Record<string, unknown> = {}) {
    return db.deal.create({ data: { tenantId: tid, stageId, contactId, title: "Forecast deal", outcome: "won", currency,
      createdAt: start, closedAt: current.from, wonAmountMinor: 350, assigneeMembershipId: auth.activeMembership!.id, ...data } });
  }
  async function run(extra: Partial<Parameters<typeof getSalesForecast>[1]> = {}) {
    return getSalesForecast(db, { tenantId: tid, dealWhere: await businessDealWhere(db, tid), timeZone, currency, now, period: "this_month", filtered: false, monthlyPlan: 3100, ...extra });
  }
  before(async () => {
    db = await createPrismaClient(); auth = await company(); foreign = await company(); tid = auth.activeMembership!.tenantId;
    const user = await db.user.create({ data: { name: "Manager", email: `${randomUUID()}@example.test`, passwordHash: "unused" } });
    await db.membership.create({ data: { tenantId: tid, userId: user.id, role: "manager" } });
    manager = await authForUserInTenant(db, user.id, tid, "forecast-manager");
    globalThis.fetch = async () => { throw new Error("External services disabled for forecast tests"); };
    const ops = await getTenantOps(db, auth); stageId = ops.stages.find(s => s.systemKey === "new")!.id;
    await updateTenantOps(db, auth, { revision: ops.revision, salesPlans: [{ month: current.month, amount: 3100, currency }] });
    contactId = (await db.contact.create({ data: { tenantId: tid, name: "Forecast contact", firstSeenAt: start } })).id;
    await deal({ outcome: "open", closedAt: null, wonAmountMinor: null, offerAmountMinor: 999999999, probability: 100 });
    for (const [i, m] of months.entries()) {
      const rate = [100, 200, 100, 100, 0, 100][i]; if (!rate) continue;
      for (let k = 0; k < 5; k++) {
        const row = await deal({ closedAt: new Date(m.from.getTime() + 86400000), wonAmountMinor: k === 0 ? null : m.days * rate / 5, offerAmountMinor: m.days * rate / 5 });
        if (i === 0 && k === 1) historicalId = row.id;
      }
    }
    await deal(); await deal(); await deal({ currency: "USD", wonAmountMinor: 90000000 });
    const foreignOps = await getTenantOps(db, foreign);
    const fc = await db.contact.create({ data: { tenantId: foreign.activeMembership!.tenantId, name: "Other", firstSeenAt: start } });
    await db.deal.create({ data: { tenantId: foreign.activeMembership!.tenantId, contactId: fc.id, stageId: foreignOps.stages[0].id, title: "Other tenant", currency, outcome: "won", wonAmountMinor: 777777777, closedAt: current.from, createdAt: start } });
    // Exclusion works for both legacy link directions and for archived inquiries.
    for (const [test, reverse] of [[true, false], [true, true], [false, true]]) {
      const inquiry = await db.inquiry.create({ data: { tenantId: tid, contactId, source: "excluded", test, archived: !test, receivedAt: start } });
      const excluded = await deal({ inquiryId: reverse ? null : inquiry.id, wonAmountMinor: null, offerAmountMinor: null, closedAt: null });
      if (reverse) await db.inquiry.update({ where: { id: inquiry.id }, data: { dealId: excluded.id } });
    }
  });
  after(async () => { globalThis.fetch = originalFetch; await db?.$disconnect(); });
  it("reads complete, same-currency sales and ignores pipeline, other tenants and test/archive links", async () => {
    const f = await run(); assert.equal(f.status, "ready"); assert.equal(f.actual.exact, "700");
    assert.equal(f.evidence.months, 6); assert.equal(f.evidence.sales, 25); assert.equal(f.evidence.otherCurrencySales, 1);
    assert.equal(f.history[4].total.exact, "0"); assert.equal(f.evidence.missingClosedDates, 0);
    assert.equal(f.history[0].total.exact, String(months[0].days * 100));
    assert.equal(f.validation.periods.length, 3);
  });
  it("returns a forecast through the authorized dashboard and applies its filters to the history", async () => {
    const dashboard = await getAnalyticsDashboard(db, auth, { period: "this_month", compare: "none" });
    assert.equal(dashboard.sales.forecast.status, "ready"); assert.equal(dashboard.sales.forecast.actual.exact, "700");
    assert.equal(dashboard.sales.forecast.target.amount.exact, "3100");
    const filtered = await getAnalyticsDashboard(db, auth, { period: "this_month", compare: "none", assignee: auth.activeMembership!.id });
    assert.equal(filtered.sales.forecast.evidence.sales, 25); assert.equal(filtered.sales.forecast.target.status, "filtered");
    const empty = await getAnalyticsDashboard(db, auth, { period: "this_month", compare: "none", source: "does-not-exist" });
    assert.equal(empty.sales.forecast.status, "insufficient_history"); assert.equal(empty.sales.forecast.evidence.months, 0);
    assert.equal(empty.sales.forecast.actual.exact, "0");
    const other = await getAnalyticsDashboard(db, foreign, { period: "this_month", compare: "none" });
    assert.equal(other.sales.forecast.actual.exact, "777777777"); assert.equal(other.sales.forecast.evidence.sales, 0);
    await assert.rejects(getAnalyticsDashboard(db, manager, {}), (e: any) => e.status === 403);
  });
  it("does not turn a selected past or arbitrary period into a current forecast", async () => {
    const neverDb = { $transaction: () => { throw new Error("must not query"); } } as unknown as typeof db;
    const f = await getSalesForecast(neverDb, { tenantId: tid, dealWhere: {}, timeZone, currency, now, period: "last_month", filtered: false, monthlyPlan: null });
    assert.equal(f.status, "unsupported_period"); assert.equal(f.estimate.exact, null);
    const data = await getAnalyticsDashboard(db, auth, { period: "last_month", compare: "none" });
    assert.equal(data.sales.forecast.status, "unsupported_period");
  });
  it("withholds the forecast for missing, negative and future-dated sales and recovers after correction", async () => {
    const invalid = [
      [{ closedAt: null }, "missingClosedDates"], [{ wonAmountMinor: null, offerAmountMinor: null }, "missingAmounts"],
      [{ wonAmountMinor: -1 }, "negativeAmounts"], [{ wonAmountMinor: null, offerAmountMinor: -1 }, "negativeAmounts"],
      [{ closedAt: new Date(now.getTime() + 86400000 * 40) }, "futureClosedDates"],
    ] as const;
    for (const [data, key] of invalid) {
      const bad = await deal(data);
      const f = await run(); assert.equal(f.status, "incomplete_data", key); assert.equal(f.evidence[key], 1); assert.equal(f.estimate.exact, null);
      await db.deal.delete({ where: { id: bad.id } });
    }
    const saved = await db.deal.findUniqueOrThrow({ where: { id: historicalId } });
    await db.deal.update({ where: { id: historicalId }, data: { wonAmountMinor: null, offerAmountMinor: null } });
    assert.equal((await run()).status, "incomplete_data");
    await db.deal.update({ where: { id: historicalId }, data: { wonAmountMinor: saved.wonAmountMinor, offerAmountMinor: saved.offerAmountMinor } });
    assert.equal((await run()).status, "ready");
  });
  it("does not fabricate completed months before the first CRM record", async () => {
    const fresh = await deal({ createdAt: new Date(months[5].from.getTime() + 1000), wonAmountMinor: 0 });
    const f = await run({ dealWhere: { id: fresh.id } });
    assert.equal(f.status, "insufficient_history"); assert.equal(f.evidence.months, 0); assert.equal(f.actual.exact, "0");
    await db.deal.delete({ where: { id: fresh.id } });
  });
  it("aggregates beyond the report's 5,000-row detail limit", async () => {
    const data: Prisma.DealCreateManyInput[] = Array.from({ length: 5007 }, () => ({ tenantId: tid, stageId, contactId,
      title: "Large forecast", outcome: "won", currency, wonAmountMinor: 1, createdAt: start, closedAt: months[0].from }));
    for (let i = 0; i < data.length; i += 1000) await db.deal.createMany({ data: data.slice(i, i + 1000) });
    const f = await run({ dealWhere: { title: "Large forecast" } });
    assert.equal(f.evidence.sales, 5007); assert.equal(f.history[0].total.exact, "5007"); assert.equal(f.status, "ready");
    await db.deal.deleteMany({ where: { tenantId: tid, title: "Large forecast" } });
  });
  it("fails visibly instead of returning a plausible zero when its data query fails", async () => {
    const broken = { $transaction: async () => { throw new Error("database unavailable"); } } as unknown as typeof db;
    const f = await getSalesForecast(broken, { tenantId: tid, dealWhere: {}, timeZone, currency, now, period: "this_month", filtered: false, monthlyPlan: null });
    assert.equal(f.status, "unavailable"); assert.equal(f.actual.exact, null); assert.equal(f.estimate.exact, null);
  });
});
