import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import type { AuthContext } from "./lib/types.ts";
import { seedDatabase } from "../../../packages/db/src/seed.ts";
import { authForUserInTenant } from "./services/authService.ts";
import { getAnalyticsDashboard, getAnalyticsDrilldown, getAnalyticsTrend } from "./services/analyticsService.ts";
import { getSituationOverview } from "./services/situationOverviewService.ts";
import { getDeal, getDealBoard, ensureDealPipelineStages } from "./services/dealService.ts";
import { addPayment } from "./services/domainService.ts";
import { businessDealWhere, confirmedPaymentTotals, moneyValue, outstandingPaymentTotals, openPipelineTotals, wonSalesTotals } from "./services/financialMetrics.ts";
import { executeWebControl, updateControlCompany, upsertControlAccess } from "./services/aiControlService.ts";
import { presentControlReply } from "./services/controlChatPresentation.ts";

describe("stage 7.1 consistent sales and confirmed receipts", () => {
  let db: Awaited<ReturnType<typeof createPrismaClient>>, auth: AuthContext;
  let tid: string, contactId: string, stageId: string, wonId: string, openId: string;
  const date = new Date("2029-10-24T10:00:00Z"), from = new Date("2029-10-23T19:00:00Z"), to = new Date("2029-10-24T19:00:00Z");
  const query = { period: "custom", dateFrom: "2029-10-24", dateTo: "2029-10-24", compare: "none" };
  const originalFetch = globalThis.fetch;
  const deal = (title: string, input: Record<string, unknown> = {}) => db.deal.create({ data: {
    tenantId: tid, contactId, stageId, title, outcome: "won", createdAt: new Date("2029-10-01T00:00:00Z"),
    closedAt: date, stageEnteredAt: date, currency: "KZT", assigneeMembershipId: auth.activeMembership!.id,
    ...input,
  } });
  const pay = (dealId: string, amountMinor: number | string, input: Record<string, unknown> = {}) => db.paymentRecord.create({ data: {
    tenantId: tid, dealId, amountMinor, currency: "KZT", status: "confirmed", confirmedAt: date, ...input,
  } });
  before(async () => {
    db = await createPrismaClient();
    await seedDatabase();
    const member = await db.membership.findFirstOrThrow({ where: { user: { email: "owner@creolab.example" } } });
    auth = await authForUserInTenant(db, member.userId, member.tenantId, "finance-test"); tid = member.tenantId;
    await ensureDealPipelineStages(db, tid);
    stageId = (await db.dealStage.findFirstOrThrow({ where: { tenantId: tid, systemKey: "new" } })).id;
    contactId = (await db.contact.create({ data: { tenantId: tid, name: "Finance test" } })).id;
    globalThis.fetch = async () => { throw new Error("External services are disabled in financial tests"); };
    wonId = (await deal("Actual agreed price", { offerAmountMinor: 1000, wonAmountMinor: 800 })).id;
    await pay(wonId, 300); await pay(wonId, -10); await pay(wonId, 600, { status: "pending" });
    await pay(wonId, 400, { status: "reversed" }); await pay(wonId, 7, { currency: "USD" });
    await deal("Fallback price", { offerAmountMinor: 200 });
    await deal("Agreed zero", { offerAmountMinor: 700, wonAmountMinor: 0 });
    await deal("Unknown amount");
    const usd = await deal("USD sale", { currency: "USD", wonAmountMinor: 30 }); await pay(usd.id, 3, { currency: "USD" });
    const old = await deal("Old sale, new payment", { wonAmountMinor: 999, closedAt: new Date("2029-10-23T18:00:00Z") }); await pay(old.id, 100);
    openId = (await deal("Open advance", { outcome: "open", closedAt: null, offerAmountMinor: 400, paymentStatus: "PARTIALLY_PAID" })).id;
    await pay(openId, 80); await pay(openId, 999, { status: "pending" }); await pay(openId, 90, { currency: "USD", status: "pending" });
    const lost = await deal("Lost with receipt", { outcome: "lost", offerAmountMinor: 300 }); await pay(lost.id, 50);
    const boundary = await deal("Start inclusive", { wonAmountMinor: 100, closedAt: from }); await pay(boundary.id, 5, { confirmedAt: from });
    await pay(boundary.id, 9, { confirmedAt: new Date(from.getTime() - 1) });
    const next = await deal("End exclusive", { wonAmountMinor: 500, closedAt: to }); await pay(next.id, 11, { confirmedAt: to });
    const otherAssignee = await deal("Unassigned", { wonAmountMinor: 60, assigneeMembershipId: null }); await pay(otherAssignee.id, 20);
    for (const excluded of [{ test: true }, { archived: true }]) {
      const inquiry = await db.inquiry.create({ data: { tenantId: tid, contactId, source: "manual", receivedAt: date, ...excluded } });
      const excludedDeal = await deal("Excluded", { offerAmountMinor: 500000, ...("test" in excluded ? { inquiryId: inquiry.id } : {}) });
      if ("archived" in excluded) await db.inquiry.update({ where: { id: inquiry.id }, data: { dealId: excludedDeal.id } });
      await pay(excludedDeal.id, 100000);
    }
  });
  after(async () => { globalThis.fetch = originalFetch; await db.$disconnect(); });

  it("separates agreement value from receipts and respects confirmation dates, status, currency, zero and missing values", async () => {
    const data = await getAnalyticsDashboard(db, auth, query);
    assert.equal(data.overview.won, 7);
    assert.equal(data.overview.revenue, 1160);
    assert.equal(data.overview.receipts, 545);
    assert.equal(data.overview.avgCheck, 232);
    assert.equal(data.financial.sales.total.known, 5);
    assert.equal(data.financial.sales.total.missing, 1);
    assert.equal(data.financial.sales.byCurrency.find(r => r.currency === "USD")?.amount, 30);
    assert.equal(data.financial.receipts.byCurrency.find(r => r.currency === "USD")?.amount, 10);
    assert.equal(data.financial.amountsConverted, false);
    assert.equal(data.sources.find(r => r.name === "Не указано")?.avgCheck, 232);
    assert.equal(data.services.find(r => r.name === "Не указано")?.avgCheck, 232);
    assert.equal(data.managers.find(r => r.id === auth.activeMembership!.id)?.avgCheck, 275);
    assert.equal(data.trend.points.reduce((sum, p) => sum + (p.revenue || 0), 0), 1160);
    assert.equal(data.trend.points.reduce((sum, p) => sum + (p.receipts || 0), 0), 545);
    const payments = await getAnalyticsDrilldown(db, auth, { ...query, entity: "payments" });
    assert.equal(payments.total, 7);
    assert.equal(payments.items.reduce((sum, p) => sum + ("amount" in p ? p.amount || 0 : 0), 0), 545);
    assert.ok(payments.items.every(p => p.status === "confirmed" && p.href.startsWith("/deals/")));
  });

  it("reconciles home, deal board and statistics even when the board uses creation dates", async () => {
    const home = await getSituationOverview(db, auth, query);
    assert.equal(home.result.wonAmount, 1160); assert.equal(home.result.wonDeals, 7);
    assert.equal(home.payments?.paidInPeriod, 545);
    const board = await getDealBoard(db, auth, { ...query, timeMode: "period", basis: "created" });
    assert.equal(board.items.length, 0);
    assert.equal(board.summary.mode, "period");
    if (board.summary.mode === "period") {
      assert.equal(board.summary.soldAmount, 1160); assert.equal(board.summary.receipts, 545); assert.equal(board.summary.wonDeals, 7);
    }
    const mine = await getSituationOverview(db, auth, { ...query, scope: "mine" });
    assert.equal(mine.result.wonAmount, 1100); assert.equal(mine.payments?.paidInPeriod, 525);
    const filtered = await getAnalyticsDashboard(db, auth, { ...query, assignee: auth.activeMembership!.id });
    assert.equal(filtered.overview.receipts, 525);
    const empty = await getAnalyticsDashboard(db, auth, { ...query, source: "No such source" });
    assert.equal(empty.overview.revenue, null); assert.equal(empty.overview.receipts, 0);
  });

  it("uses actual won value and only same-currency confirmed money for the card balance", async () => {
    const card = await getDeal(db, auth, wonId);
    assert.equal(card.deal.amount, 800);
    assert.equal(card.paymentSummary.amount, 290);
    assert.equal(card.paymentSummary.remaining.amount, 510);
    assert.equal(card.paymentSummary.byCurrency.find(r => r.currency === "USD")?.amount, 7);
    const expected = await outstandingPaymentTotals(db, { tenantId: tid, id: openId }, "KZT");
    assert.equal(expected.total.amount, 320);
    assert.ok(card.payments.every(p => p.amountLabel && p.confirmedAt));
  });

  it("returns both monetary measures in Control and protects financial access", async () => {
    await updateControlCompany(db, auth, { enabled: true });
    await upsertControlAccess(db, auth, auth.user.id, { enabled: true, allowedSources: ["CRM_CHAT"], canReadFinancialData: true, canReadTeamData: true, allowedActions: [] });
    const identity = await db.controlIdentity.create({ data: { tenantId: tid, userId: auth.user.id, provider: "CRM_CHAT", externalUserId: auth.user.id, verifiedAt: new Date() } });
    for (const action of ["GET_REVENUE_STATS", "GET_DEALS_STATS", "GET_BUSINESS_SUMMARY"] as const) {
      const result = await executeWebControl(db, auth, identity.id, action, query, randomUUID()) as any;
      assert.equal(result.data.revenue, 1160); assert.equal(result.data.receipts, 545);
      for (const lang of ["ru", "kk"] as const) {
        const reply = presentControlReply(action, result, lang, "Asia/Almaty");
        assert.match(reply, /545/); assert.match(reply, /30 USD/); assert.match(reply, /10 USD/);
        assert.match(reply, /закрытия|жабылған/); assert.match(reply, /подтверждения|расталған/);
      }
    }
    await upsertControlAccess(db, auth, auth.user.id, { canReadFinancialData: false });
    await assert.rejects(executeWebControl(db, auth, identity.id, "GET_REVENUE_STATS", query, randomUUID()), /финансовые/);
    const safe = await executeWebControl(db, auth, identity.id, "GET_SITUATION", query, randomUUID()) as any;
    assert.equal(safe.data.payments, undefined); assert.equal(safe.data.result.salesByCurrency, undefined);
  });

  it("records exact payment status against the agreed value, rejects rounded input and isolates other tenants", async () => {
    for (const amountMinor of [1.5, Number.MAX_SAFE_INTEGER + 1, 0, -1]) {
      await assert.rejects(addPayment(db, auth, wonId, { amountMinor }), /целым/);
    }
    const row = await deal("Confirm agreed price", { offerAmountMinor: 1000, wonAmountMinor: 800, closedAt: to });
    await addPayment(db, auth, row.id, { amountMinor: 799 });
    assert.equal((await getDeal(db, auth, row.id)).deal.paymentStatus, "PARTIALLY_PAID");
    await addPayment(db, auth, row.id, { amountMinor: 5000, currency: "USD" });
    assert.equal((await getDeal(db, auth, row.id)).deal.paymentStatus, "PARTIALLY_PAID");
    await addPayment(db, auth, row.id, { amountMinor: 1 });
    assert.equal((await getDeal(db, auth, row.id)).deal.paymentStatus, "PAID");
    const foreignMember = await db.membership.findFirstOrThrow({ where: { user: { email: "owner@demo-agency.example" } } });
    const foreign = await authForUserInTenant(db, foreignMember.userId, foreignMember.tenantId, "foreign-finance");
    await assert.rejects(getDeal(db, foreign, wonId), /найдена/);
    const report = await getAnalyticsDashboard(db, foreign, query);
    assert.equal(report.overview.receipts, 0); assert.equal(report.overview.revenue, null);
  });

  it("preserves exact large totals and rounds weighted amounts only after summing", async () => {
    const a = await deal("Large exact A", { wonAmountMinor: "9007199254740993", closedAt: to });
    const b = await deal("Large exact B", { wonAmountMinor: "9007199254740994", closedAt: to });
    const where = { tenantId: tid, id: { in: [a.id, b.id] } };
    const total = await wonSalesTotals(db, where, undefined, "KZT");
    assert.equal(total.total.amount, null); assert.equal(total.total.exact, "18014398509481987");
    assert.equal(total.total.label, moneyValue("18014398509481987", "KZT").label);
    assert.equal(total.total.avg.exact, "9007199254740994");
    await pay(a.id, "9007199254740993"); await pay(b.id, "9007199254740994");
    const payments = await confirmedPaymentTotals(db, tid, where, undefined, "KZT");
    assert.equal(payments.total.amount, null); assert.equal(payments.total.exact, total.total.exact);
    const card = await getDeal(db, auth, a.id);
    assert.equal(card.deal.amountExact, "9007199254740993"); assert.equal(card.paymentSummary.remaining.exact, "0");
    const open = await Promise.all([deal("Weighted A", { outcome: "open", closedAt: null, offerAmountMinor: 1, probability: 25 }), deal("Weighted B", { outcome: "open", closedAt: null, offerAmountMinor: 1, probability: 25 })]);
    const pipeline = await openPipelineTotals(db, { tenantId: tid, id: { in: open.map(d => d.id) } }, "KZT");
    assert.equal(pipeline.total.weighted.amount, 1);
  });
});

describe("money totals beyond display limits", () => {
  let db: Awaited<ReturnType<typeof createPrismaClient>>, auth: AuthContext, tid: string;
  const date = new Date("2029-10-24T10:00:00Z");
  const query = { period: "custom", dateFrom: "2029-10-24", dateTo: "2029-10-24", compare: "none" };
  before(async () => {
    db = await createPrismaClient();
    const tenant = await db.tenant.create({ data: { slug: randomUUID(), name: "Unclipped finance", timezone: "Asia/Almaty" } }); tid = tenant.id;
    const user = await db.user.create({ data: { name: "Finance owner", email: `${randomUUID()}@example.test`, passwordHash: "unused" } });
    const membership = await db.membership.create({ data: { tenantId: tid, userId: user.id, role: "owner" }, include: { tenant: true } });
    auth = { user, activeMembership: membership, memberships: [membership] } as unknown as AuthContext;
    const contact = await db.contact.create({ data: { tenantId: tid, name: "Bulk" } });
    await ensureDealPipelineStages(db, tid);
    const stage = await db.dealStage.findFirstOrThrow({ where: { tenantId: tid, systemKey: "new" } });
    for (let i = 0; i < 8001; i += 500) {
      const ids = Array.from({ length: Math.min(500, 8001 - i) }, () => randomUUID());
      await db.deal.createMany({ data: ids.map(id => ({ id, tenantId: tid, contactId: contact.id, stageId: stage.id,
        title: "Bulk sale", outcome: "won", offerAmountMinor: 999, wonAmountMinor: 2, currency: "KZT", createdAt: date, closedAt: date })) });
      await db.paymentRecord.createMany({ data: ids.map(dealId => ({ tenantId: tid, dealId, amountMinor: 1, currency: "KZT", confirmedAt: date })) });
    }
  });
  after(async () => { await db.$disconnect(); });
  it("retains all 8001 payments and sales in aggregates and charts, with bounded drilldown", async t => {
    t.diagnostic("Loading full dashboard");
    const report = await getAnalyticsDashboard(db, auth, query);
    assert.equal(report.overview.revenue, 16002); assert.equal(report.overview.receipts, 8001);
    assert.equal(report.trend.points.reduce((sum, p) => sum + (p.revenue || 0), 0), 16002);
    t.diagnostic("Loading full receipts chart");
    const trend = await getAnalyticsTrend(db, auth, { ...query, metric: "receipts" });
    assert.equal(trend.points.reduce((sum, p) => sum + (p.value || 0), 0), 8001);
    t.diagnostic("Loading payment drilldown");
    const rows = await getAnalyticsDrilldown(db, auth, { ...query, entity: "payments" });
    assert.equal(rows.total, 8001); assert.equal(rows.items.length, 500); assert.equal(rows.hasMore, true);
    t.diagnostic("Loading board");
    const board = await getDealBoard(db, auth, { ...query, timeMode: "period" });
    if (board.summary.mode !== "period") assert.fail("Expected period totals");
    assert.equal(board.summary.soldAmount, 16002); assert.equal(board.summary.receipts, 8001);
    t.diagnostic("Loading home");
    const home = await getSituationOverview(db, auth, query);
    assert.equal(home.result.wonAmount, 16002); assert.equal(home.payments?.paidInPeriod, 8001);
    assert.equal(home.result.wonDeals, 8001);
  });
});
