import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import type { AuthContext } from "./lib/types.ts";
import { authForUserInTenant } from "./services/authService.ts";
import { analyticsComparison, closedDealConversion, periodSalesPlan } from "./services/analyticsPeriodPolicy.ts";
import { getAnalyticsDashboard, getAnalyticsTrend } from "./services/analyticsService.ts";
import { getSituationOverview } from "./services/situationOverviewService.ts";
import { getTenantOps, updateTenantOps } from "./services/dealService.ts";
import { executeWebControl, updateControlCompany, upsertControlAccess } from "./services/aiControlService.ts";
import { presentControlReply } from "./services/controlChatPresentation.ts";
import { resolvePeriodRange } from "./services/periodRange.ts";

describe("period and monthly target policy", () => {
  const base = { plans: [{ month: "2029-10", amount: 3100, currency: "KZT" }, { month: "2029-11", amount: 3000, currency: "KZT" }],
    legacyAmount: null, currency: "KZT", timeZone: "Asia/Almaty", from: new Date("2029-10-15T19:00:00Z"), to: new Date("2029-11-15T19:00:00Z"),
    filtered: false, actual: "1550", missingAmounts: 0 };
  it("compares local calendar days across DST and clamps leap day", () => {
    assert.equal(resolvePeriodRange("Europe/Berlin", "custom", "2026-03-29", "2026-03-29").previousFrom?.toISOString(), "2026-03-27T23:00:00.000Z");
    assert.deepEqual(analyticsComparison("Europe/Berlin", "previous", new Date("2026-03-28T23:00:00Z"), new Date("2026-03-29T22:00:00Z")),
      { from: new Date("2026-03-27T23:00:00Z"), to: new Date("2026-03-28T23:00:00Z") });
    assert.deepEqual(analyticsComparison("UTC", "last_year", new Date("2028-02-29"), new Date("2028-03-01")),
      { from: new Date("2027-02-28"), to: new Date("2027-03-01") });
    assert.deepEqual(analyticsComparison("UTC", "last_month", new Date("2029-01-20"), new Date("2029-01-21")),
      { from: new Date("2028-12-01"), to: new Date("2029-01-01") });
    assert.deepEqual(analyticsComparison("UTC", "previous", null, null), { from: null, to: null });
  });
  it("uses sales divided by closed deals, not unrelated new inquiries", () => {
    assert.equal(closedDealConversion(3, 1), 75); assert.equal(closedDealConversion(0, 1), 0);
    assert.equal(closedDealConversion(0, 0), null); assert.equal(closedDealConversion(2, 1), 66.7);
  });
  it("prorates each month by calendar days and aggregates before rounding", () => {
    const plan = periodSalesPlan(base);
    assert.equal(plan.amount, 3100); assert.equal(plan.percent, 50); assert.equal(plan.prorated, true);
    assert.deepEqual(plan.months.map(row => row.coveredDays), [16, 15]);
    const fractions = periodSalesPlan({ ...base, plans: base.plans.map(row => ({ ...row, amount: 1 })), actual: "1" });
    assert.equal(fractions.amount, 1); assert.equal(fractions.percent, 100);
  });
  it("does not apply another currency, an undated legacy plan, or a partial company report", () => {
    assert.equal(periodSalesPlan({ ...base, filtered: true }).status, "filtered");
    assert.equal(periodSalesPlan({ ...base, from: null }).status, "unbounded");
    assert.equal(periodSalesPlan({ ...base, plans: [], legacyAmount: 100 }).status, "legacy");
    const missing = periodSalesPlan({ ...base, plans: [base.plans[0], { ...base.plans[1], currency: "USD" }] });
    assert.equal(missing.status, "missing"); assert.equal(missing.percent, null);
    assert.deepEqual(missing.missingMonths, ["2029-11"]); assert.equal(missing.amount, null);
  });
  it("distinguishes zero sales, zero targets and unknown sale amounts", () => {
    assert.equal(periodSalesPlan({ ...base, actual: null }).percent, 0);
    assert.equal(periodSalesPlan({ ...base, missingAmounts: 1 }).percent, null);
    assert.equal(periodSalesPlan({ ...base, actual: null, missingAmounts: 1 }).actual.amount, null);
    assert.equal(periodSalesPlan({ ...base, plans: base.plans.map(row => ({ ...row, amount: 0 })) }).percent, null);
  });
});

describe("stage 7.2 report periods, cohort and plan/fact", () => {
  let db: Awaited<ReturnType<typeof createPrismaClient>>, auth: AuthContext, foreign: AuthContext;
  let tid: string, contactId: string, stageId: string;
  const date = new Date("2029-10-15T10:00:00Z"), later = new Date("2029-11-10T10:00:00Z"), old = new Date("2029-09-01T10:00:00Z");
  const query = { period: "custom", dateFrom: "2029-10-01", dateTo: "2029-10-31", compare: "none" };
  const originalFetch = globalThis.fetch;
  before(async () => {
    db = await createPrismaClient();
    async function company() {
      const tenant = await db.tenant.create({ data: { slug: randomUUID(), name: "Period tests", timezone: "Asia/Almaty", settingsJson: { unrelated: "keep", ops: { salesPlanMinor: 500 } } } });
      const user = await db.user.create({ data: { name: "Owner", email: `${randomUUID()}@example.test`, passwordHash: "unused" } });
      await db.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: "owner" } });
      return authForUserInTenant(db, user.id, tenant.id, "period-test");
    }
    auth = await company(); foreign = await company(); tid = auth.activeMembership!.tenantId;
    globalThis.fetch = async () => { throw new Error("External services disabled for reporting tests"); };
    const ops = await getTenantOps(db, auth); stageId = ops.stages.find(s => s.systemKey === "new")!.id;
    await updateTenantOps(db, auth, { revision: ops.revision, salesPlans: [{ month: "2029-10", amount: 3100, currency: "KZT" }] });
    contactId = (await db.contact.create({ data: { tenantId: tid, name: "Cohort contact", firstSeenAt: date } })).id;
    const inquiry = (data: Record<string, unknown> = {}) => db.inquiry.create({ data: { tenantId: tid, contactId, source: "paid", sourceType: "paid", serviceCategory: "design", receivedAt: new Date("2029-10-10T10:00:00Z"), assigneeMembershipId: auth.activeMembership!.id, ...data } });
    const deal = (data: Record<string, unknown> = {}) => db.deal.create({ data: { tenantId: tid, contactId, stageId, title: "Period deal", currency: "KZT", offerAmountMinor: 100, createdAt: date, outcome: "open", assigneeMembershipId: auth.activeMembership!.id, ...data } });
    const a = await inquiry({ qualifiedAt: date });
    const da = await deal({ inquiryId: a.id, outcome: "won", closedAt: date, wonAmountMinor: 200 });
    const proposalId = ops.stages.find(s => s.systemKey === "proposal_sent")!.id;
    for (const enteredAt of [new Date("2029-10-12T10:00:00Z"), date]) await db.dealStageHistory.create({ data: { tenantId: tid, dealId: da.id, toStageId: proposalId, toSystemKey: "proposal_sent", enteredAt } });
    const b = await inquiry();
    const contractId = ops.stages.find(s => s.systemKey === "contract")!.id;
    const dbb = await deal({ stageId: contractId });
    await db.inquiry.update({ where: { id: b.id }, data: { dealId: dbb.id } });
    await db.dealStageHistory.create({ data: { tenantId: tid, dealId: dbb.id, toStageId: contractId, toSystemKey: "contract", enteredAt: date } });
    const c = await inquiry({ status: "converted" });
    const dc = await deal({ inquiryId: c.id, outcome: "won", closedAt: later, wonAmountMinor: 400 });
    await db.inquiry.update({ where: { id: c.id }, data: { dealId: dc.id } });
    await inquiry({ status: "converted" }); // historic conversion with no traceable deal
    const d = await inquiry({ receivedAt: old });
    const dd = await deal({ createdAt: old, outcome: "won", closedAt: date, wonAmountMinor: 300 });
    await db.inquiry.update({ where: { id: d.id }, data: { dealId: dd.id } });
    const e = await inquiry({ receivedAt: old });
    await deal({ inquiryId: e.id, createdAt: old, outcome: "lost", closedAt: date });
    for (const excluded of [{ test: true }, { archived: true }]) {
      const i = await inquiry(excluded); await deal({ inquiryId: i.id, outcome: "won", closedAt: date, wonAmountMinor: 99999 });
    }
  });
  after(async () => { globalThis.fetch = originalFetch; await db.$disconnect(); });

  it("matches closed-deal shares across statistics, sources, services, managers, home and charts", async () => {
    const report = await getAnalyticsDashboard(db, auth, query);
    assert.equal(report.overview.conversion, 66.7); assert.equal(report.overview.closedDeals, 3);
    assert.equal(report.period.dateFrom, "2029-10-01"); assert.equal(report.period.dateTo, "2029-10-31");
    assert.match(report.period.label, /2029/);
    for (const row of [report.sources.find(r => r.name === "paid"), report.services.find(r => r.name === "design"), report.managers.find(r => r.id === auth.activeMembership!.id)]) {
      assert.ok(row); assert.equal(row.conversion, 66.7);
    }
    const home = await getSituationOverview(db, auth, query);
    assert.equal(home.result.conversionRate, 66.7); assert.equal(home.result.closedDeals, 3);
    assert.equal(home.sources[0].deals, 3); assert.equal(home.sources[0].conversionRate, 75);
    const trend = await getAnalyticsTrend(db, auth, { ...query, metric: "conversion" });
    assert.equal(trend.points.find(p => p.won === 2)?.value, 66.7);
    assert.ok(trend.points.filter(p => p.closed === 0).every(p => p.value === null));
  });
  it("tracks received inquiries once per actual stage, including later sales and both link directions", async () => {
    const report = await getAnalyticsDashboard(db, auth, query), f = report.funnel;
    assert.equal(f.mode, "cohort"); assert.equal(f.complete, true);
    assert.deepEqual(f.cohort, { inquiries: 4, withDeal: 3, won: 2, conversion: 50, unlinkedConverted: 1 });
    assert.equal(f.steps.find(s => s.key === "proposal")?.count, 1);
    assert.equal(f.steps.find(s => s.key === "negotiation")?.count, 0);
    assert.equal(f.steps.find(s => s.key === "contract")?.count, 1);
    assert.ok(f.steps.every(s => (s.fromStartPct ?? 0) <= 100 && s.lost === null));
    assert.deepEqual(f.transitions, []); // skipped or unfinished stages are not lost clients
  });
  it("event mode deduplicates repeated entry and never mixes counts into cohort percentages", async () => {
    const { funnel: f } = await getAnalyticsDashboard(db, auth, { ...query, funnelMode: "events" });
    assert.equal(f.cohort, null); assert.equal(f.steps.find(s => s.key === "proposal")?.count, 1);
    assert.equal(f.steps.find(s => s.key === "won")?.count, 2);
    assert.ok(f.steps.every(s => s.fromStartPct === null && s.fromPrevPct === null));
  });
  it("uses the selected period's plan and sales; a missing month or filter cannot imply completion", async () => {
    const { sales: { plan } } = await getAnalyticsDashboard(db, auth, query);
    assert.equal(plan.status, "ready"); assert.equal(plan.amount, 3100); assert.equal(plan.actual.amount, 500); assert.equal(plan.percent, 16);
    const oneDay = await getAnalyticsDashboard(db, auth, { ...query, dateFrom: "2029-10-15", dateTo: "2029-10-15" });
    assert.equal(oneDay.sales.plan.amount, 100); assert.equal(oneDay.sales.plan.percent, 500); assert.equal(oneDay.sales.plan.prorated, true);
    const missing = await getAnalyticsDashboard(db, auth, { ...query, dateTo: "2029-11-30" });
    assert.equal(missing.sales.plan.status, "missing"); assert.equal(missing.sales.plan.percent, null);
    const filtered = await getAnalyticsDashboard(db, auth, { ...query, assignee: auth.activeMembership!.id, source: "paid" });
    assert.equal(filtered.sales.plan.status, "filtered"); assert.equal(filtered.overview.conversion, 66.7);
    const empty = await getAnalyticsDashboard(db, auth, { ...query, source: "none" });
    assert.equal(empty.funnel.cohort?.inquiries, 0); assert.equal(empty.overview.conversion, null);
  });
  it("compares the same chart intervals, retains all comparison dates, and disables all-time comparison", async () => {
    const short = await getAnalyticsDashboard(db, auth, { ...query, dateFrom: "2029-10-15", dateTo: "2029-10-15", compare: "last_month" });
    assert.equal(short.trend.granularity, short.trendCompare?.granularity);
    assert.equal(short.trend.granularity, "day");
    assert.equal(short.trend.points.length, 1); assert.equal(short.trendCompare?.points.length, 30);
    const year = await getAnalyticsDashboard(db, auth, { ...query, dateFrom: "2029-01-01", dateTo: "2029-12-31", compare: "last_year" });
    assert.equal(year.trend.granularity, "month"); assert.equal(year.trendCompare?.granularity, "month");
    const all = await getAnalyticsDashboard(db, auth, { period: "all", compare: "previous" });
    assert.equal(all.compare.mode, "none"); assert.equal(all.trendCompare, null); assert.equal(all.sales.plan.status, "unbounded");
  });
  it("shares period definitions with Control, including explicit plan proration", async () => {
    await updateControlCompany(db, auth, { enabled: true });
    await upsertControlAccess(db, auth, auth.user.id, { enabled: true, allowedSources: ["CRM_CHAT"], canReadFinancialData: true, canReadTeamData: true, allowedActions: [] });
    const identity = await db.controlIdentity.create({ data: { tenantId: tid, userId: auth.user.id, provider: "CRM_CHAT", externalUserId: auth.user.id, verifiedAt: new Date() } });
    const result = await executeWebControl(db, auth, identity.id, "GET_REVENUE_STATS", { ...query, dateFrom: "2029-10-15", dateTo: "2029-10-15" }, randomUUID()) as any;
    assert.equal(result.data.plan.amount, 100); assert.equal(result.data.plan.actual.amount, 500);
    for (const locale of ["ru", "kk"] as const) {
      const reply = presentControlReply("GET_REVENUE_STATS", result, locale, "Asia/Almaty");
      assert.match(reply, /500%/); assert.match(reply, /календар|күнтізбе/);
    }
    const summary = await executeWebControl(db, auth, identity.id, "GET_DEALS_STATS", query, randomUUID()) as any;
    assert.equal(summary.data.conversion, 66.7); assert.equal(summary.data.closedDeals, 3);
  });
  it("keeps home and statistics on the same previous period for incomplete months and years", async () => {
    for (const period of ["this_month", "last_month", "this_year", "all"]) {
      const report = await getAnalyticsDashboard(db, auth, { period, compare: "previous" });
      const home = await getSituationOverview(db, auth, { period });
      assert.equal(home.compare.from, report.compare.from, period + " comparison start");
      assert.equal(home.compare.to, report.compare.to, period + " comparison end");
      assert.equal(home.compare.label === null, period === "all");
    }
  });
  it("rejects invalid or stale monthly plans, preserves unrelated settings and audits writes", async () => {
    const before = await getTenantOps(db, auth);
    const valid = { month: "2029-11", amount: 900, currency: "KZT" };
    for (const invalid of [{ ...valid, amount: -1 }, { ...valid, amount: 0.5 }, { ...valid, amount: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, month: "2029-13" }, { ...valid, currency: "usd" }]) {
      await assert.rejects(updateTenantOps(db, auth, { revision: before.revision, salesPlans: [invalid] }), (e: any) => e.status === 422);
    }
    await assert.rejects(updateTenantOps(db, auth, { revision: before.revision, salesPlans: [valid, valid] }));
    await assert.rejects(updateTenantOps(db, auth, { salesPlans: [valid] }));
    const saved = await updateTenantOps(db, auth, { revision: before.revision, salesPlans: [valid, ...before.salesPlans] });
    assert.deepEqual(saved.salesPlans.map(p => p.month), ["2029-10", "2029-11"]);
    assert.equal(saved.salesPlanMinor, 500);
    await assert.rejects(updateTenantOps(db, auth, { revision: before.revision, salesPlans: [] }), (e: any) => e.status === 409);
    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: tid } });
    assert.equal((tenant.settingsJson as any).unrelated, "keep");
    assert.ok(await db.auditEvent.count({ where: { tenantId: tid, action: "settings.ops_updated" } }));
  });
  it("isolates company plans, rejects manager writes, and never compares another company's targets", async () => {
    assert.deepEqual((await getTenantOps(db, foreign)).salesPlans, []);
    const manager = { ...auth, activeMembership: { ...auth.activeMembership!, role: "manager" } } as AuthContext;
    await assert.rejects(updateTenantOps(db, manager, { revision: (await getTenantOps(db, auth)).revision, salesPlans: [] }));
    const report = await getAnalyticsDashboard(db, foreign, query);
    assert.equal(report.overview.conversion, null); assert.equal(report.funnel.cohort?.inquiries, 0); assert.equal(report.sales.plan.status, "legacy");
  });
  it("retains old and recent money in all-time and long custom charts", async () => {
    const ancient = await db.deal.create({ data: { tenantId: tid, contactId, stageId, title: "Historic sale", outcome: "won", currency: "KZT", wonAmountMinor: 100,
      createdAt: new Date("2010-01-01T10:00:00Z"), closedAt: new Date("2010-01-01T10:00:00Z") } });
    await db.paymentRecord.create({ data: { tenantId: tid, dealId: ancient.id, currency: "KZT", amountMinor: 75, confirmedAt: new Date("2010-01-01T10:00:00Z") } });
    const latest = await db.deal.findFirstOrThrow({ where: { tenantId: tid, outcome: "won", closedAt: date } });
    await db.paymentRecord.create({ data: { tenantId: tid, dealId: latest.id, currency: "KZT", amountMinor: 125, confirmedAt: date } });
    for (const period of [{ period: "all" }, { period: "custom", dateFrom: "2010-01-01", dateTo: "2029-12-31" }]) {
      const data = await getAnalyticsDashboard(db, auth, { ...period, compare: "none" });
      assert.equal(data.trend.granularity, "year");
      assert.equal(data.trend.points.reduce((sum, p) => sum + (p.revenue ?? 0), 0), data.overview.revenue);
      assert.equal(data.trend.points.reduce((sum, p) => sum + (p.receipts ?? 0), 0), 200);
      assert.equal(data.trend.points.find(p => p.key === "2010")?.receipts, 75);
      assert.equal(data.trend.points.find(p => p.key === "2029")?.receipts, 125);
    }
  });
});
