import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, beforeEach, after, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { type BusinessInsightView } from "@creolab/contracts";
import type { AuthContext } from "./lib/types.ts";
import { authForUserInTenant, issueSession } from "./services/authService.ts";
import { sweepBusinessInsightTenant, sweepBusinessInsights, listBusinessInsights, getBusinessInsight, decideBusinessInsight, refreshBusinessInsights } from "./services/businessInsightService.ts";
import { loadBusinessEvidence, metricKey, planEvidence, type InsightKey } from "./services/businessMetricRegistry.ts";
import { getCompanySalesForecast, getSalesForecast } from "./services/salesForecastService.ts";
import { businessDealWhere } from "./services/financialMetrics.ts";
import { updateTaskDraft } from "./services/taskExecutionService.ts";
import { createApp } from "./app.ts";

let db: Awaited<ReturnType<typeof createPrismaClient>>, auth: AuthContext, other: AuthContext, tid: string, contactId: string, stageId: string;
const now = new Date("2026-11-15T07:00:00.000Z"), past = new Date("2026-11-01T07:00:00.000Z"), future = new Date("2026-11-20T07:00:00.000Z");
const later = (minutes = 1) => new Date(now.getTime() + minutes * 60_000);
async function company(role = "owner") {
  const tenant = await db.tenant.create({ data: { name: "Insights fixture", slug: randomUUID(), timezone: "Asia/Almaty" } });
  const user = await db.user.create({ data: { email: `${randomUUID()}@example.test`, name: "Owner", passwordHash: "unused" } });
  await db.membership.create({ data: { tenantId: tenant.id, userId: user.id, role } });
  return authForUserInTenant(db, user.id, tenant.id);
}
async function task(extra: Record<string, any> = {}) { return db.task.create({ data: { tenantId: tid, title: "Позвонить клиенту", type: "note", dueAt: past, ...extra } }); }
async function deal(extra: Record<string, any> = {}) { return db.deal.create({ data: { tenantId: tid, contactId, stageId, title: "Презентация", stageEnteredAt: past, ...extra } }); }
async function inquiry(extra: Record<string, any> = {}) { return db.inquiry.create({ data: { tenantId: tid, contactId, subject: "Заказ презентации", source: "manual", ...extra } }); }
const scan = (at = now, pageSize = 20) => sweepBusinessInsightTenant(db, tid, { now: at, pageSize });
const all = (at = now) => listBusinessInsights(db, auth, { state: "all" }, at);
const decisionBody = (item: BusinessInsightView) => ({ version: item.version, fingerprint: item.fingerprint, requestId: randomUUID() });
async function domainCounts() {
  return Promise.all([db.task.count(), db.deal.count(), db.message.count(), db.outboxEvent.count(), db.notification.count(), db.aIUsageEvent.count(), db.actionRun.count()]);
}
before(async () => { db = await createPrismaClient(); });
beforeEach(async () => {
  auth = await company(); other = await company(); tid = auth.activeMembership!.tenantId;
  contactId = (await db.contact.create({ data: { tenantId: tid, name: "Клиент" } })).id;
  stageId = (await db.dealStage.create({ data: { tenantId: tid, name: "Предложение", systemKey: "proposal_sent", sortOrder: 0 } })).id;
});
after(async () => db.$disconnect());

it("distinguishes unscanned, empty sources and insufficient sales history without inventing zero risk", async () => {
  const initial = await all(); assert.equal(initial.coverage.asOf, null); assert.equal(initial.coverage.forecast, null);
  assert.ok(initial.coverage.sources.every(s => s.lastFullPassAt === null));
  assert.equal(await scan(), true);
  const result = await all(); assert.deepEqual(result.items, []); assert.equal(result.coverage.forecast?.status, "insufficient_history");
  assert.ok(result.coverage.sources.every(s => s.lastFullPassAt === now.toISOString()));
  assert.equal(result.coverage.scope, "company");
});

it("creates five verifiable operational signals and links without changing CRM, sending notices or using AI", async () => {
  const t = await task(), i = await inquiry(), d = await deal({ paymentStatus: "OVERDUE" }), before = await domainCounts();
  await scan(); const result = await all();
  assert.deepEqual(result.items.map(i => i.rule).sort(), ["inquiry_unhandled", "task_overdue", "deal_next_step", "proposal_delayed", "payment_delayed"].sort());
  for (const item of result.items) {
    assert.equal(item.stale, false); assert.equal(item.schemaVersion, 1); assert.ok(item.formulaVersion);
    assert.ok(item.content?.formula); assert.ok(item.content?.limitation); assert.ok(item.content?.sources.length);
    assert.equal(item.content?.period.timezone, "Asia/Almaty"); assert.ok(item.content?.facts.every(f => typeof f.value === "string"));
  }
  assert.equal(result.items.find(x => x.rule === "task_overdue")!.content!.next.href, `/tasks?open=${t.id}`);
  assert.equal(result.items.find(x => x.rule === "inquiry_unhandled")!.content!.next.href, `/requests/${i.id}`);
  assert.equal(result.items.find(x => x.rule === "deal_next_step")!.content!.next.href, `/deals/${d.id}`);
  assert.deepEqual(await domainCounts(), before);
  assert.doesNotMatch(JSON.stringify(result), /потерян[ао]|вероятность|100%|providerKey|password/i);
});

it("unchanged scans preserve acknowledgement and produce no duplicate insight or history", async () => {
  await task(); await scan(); const item = (await all()).items[0], body = decisionBody(item);
  const saved = await decideBusinessInsight(db, auth, item.id, "acknowledge", body, now);
  assert.equal(saved.state, "acknowledged");
  const replay = await decideBusinessInsight(db, auth, item.id, "acknowledge", body, now); assert.equal(replay.version, saved.version);
  await scan(later());
  assert.equal((await all(later())).items[0].state, "acknowledged");
  assert.equal(await db.businessInsight.count({ where: { tenantId: tid } }), 1);
  const history = (await getBusinessInsight(db, auth, item.id, later())).history;
  assert.deepEqual(history.map(e => e.type).sort(), ["acknowledged", "detected"]);
  assert.equal(await db.auditEvent.count({ where: { tenantId: tid, action: "business_insight.acknowledged" } }), 1);
});

it("hides dismissed conclusions until relevant source changes, then reopens with a new version", async () => {
  const t = await task(); await scan(); const item = (await all()).items[0];
  await decideBusinessInsight(db, auth, item.id, "dismiss", decisionBody(item), now);
  assert.equal((await listBusinessInsights(db, auth, {}, now)).items.length, 0);
  await scan(later()); assert.equal((await all(later())).items[0].state, "dismissed");
  await db.task.update({ where: { id: t.id }, data: { dueAt: new Date("2026-11-14T01:00:00Z") } });
  const stale = await getBusinessInsight(db, auth, item.id, later()); assert.equal(stale.stale, true); assert.equal(stale.content, null);
  await scan(later(2)); const updated = (await all(later(2))).items[0]; assert.equal(updated.state, "open"); assert.ok(updated.version > item.version);
  assert.equal(updated.occurrence, 1);
});

it("resolves closed sources and records recurrence separately; deleting a source is not successful resolution", async () => {
  const t = await task(); await scan(); const first = (await all()).items[0];
  await db.task.update({ where: { id: t.id }, data: { status: "done" } }); await scan(later());
  assert.equal((await all(later())).items[0].state, "resolved");
  await db.task.update({ where: { id: t.id }, data: { status: "open" } }); await scan(later(2));
  const second = (await all(later(2))).items[0]; assert.equal(second.occurrence, 2); assert.notEqual(second.id, first.id);
  assert.equal((await db.businessInsight.findUniqueOrThrow({ where: { id: first.id } })).isCurrent, false);
  await db.task.delete({ where: { id: t.id } }); await scan(later(3));
  const missing = (await all(later(3))).items[0]; assert.equal(missing.state, "unavailable"); assert.equal(missing.stale, true); assert.equal(missing.content, null);
  assert.deepEqual((await db.businessInsight.findUniqueOrThrow({ where: { id: second.id } })).contentJson, {});
});

it("task edits preserve the message draft, invalidate overdue evidence and resolve it after a future or cleared deadline", async () => {
  const t = await task({ messageDraft: "Существующий черновик" }); await scan();
  const item = (await all()).items[0];
  await updateTaskDraft(db, auth, t.id, { dueAt: "2026-11-20T15:00" });
  const edited = await db.task.findUniqueOrThrow({ where: { id: t.id } });
  assert.equal(edited.dueAt!.toISOString(), "2026-11-20T10:00:00.000Z");
  assert.equal(edited.messageDraft, "Существующий черновик");
  assert.equal(edited.status, "open");
  assert.equal((await getBusinessInsight(db, auth, item.id, now)).content, null);
  await refreshBusinessInsights(db, auth, { insightId: item.id }, now);
  assert.equal((await getBusinessInsight(db, auth, item.id, now)).state, "resolved");
  await updateTaskDraft(db, auth, t.id, { dueAt: past.toISOString() }); await scan(later());
  const repeated = (await all(later())).items[0]; assert.equal(repeated.occurrence, 2);
  await updateTaskDraft(db, auth, t.id, { dueAt: null }); await scan(later(2));
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: t.id } })).dueAt, null);
  const cleared = await getBusinessInsight(db, auth, repeated.id, later(2)); assert.equal(cleared.state, "resolved");
  assert.ok(cleared.history.some(e => e.type === "resolved"));
  assert.equal(await db.message.count({ where: { tenantId: tid } }), 0);
});

it("refuses stale, expired or forged decisions and returns no outdated evidence after source or timezone change", async () => {
  const t = await task(); await scan(); const item = (await all()).items[0];
  await assert.rejects(decideBusinessInsight(db, auth, item.id, "dismiss", { ...decisionBody(item), fingerprint: "0".repeat(64) }, now), (e: any) => e.code === "insight_stale");
  await assert.rejects(decideBusinessInsight(db, auth, item.id, "dismiss", decisionBody(item), later(11)), (e: any) => e.code === "insight_stale");
  await db.tenant.update({ where: { id: tid }, data: { timezone: "Europe/London" } });
  assert.equal((await all()).items[0].content, null);
  await assert.rejects(decideBusinessInsight(db, auth, item.id, "dismiss", decisionBody(item), now), (e: any) => e.code === "insight_stale");
  await refreshBusinessInsights(db, auth, { insightId: item.id }, now);
  assert.equal((await all()).items[0].content?.period.timezone, "Europe/London");
  await db.task.update({ where: { id: t.id }, data: { title: "Новое описание" } }); assert.equal((await all()).items[0].content, null);
});

it("uses tenant isolation and fresh roles for lists, details, refresh, decisions and history", async () => {
  await task(); await scan(); const item = (await all()).items[0];
  assert.deepEqual((await listBusinessInsights(db, other, {}, now)).items, []);
  await assert.rejects(getBusinessInsight(db, other, item.id, now), (e: any) => e.status === 404);
  await assert.rejects(decideBusinessInsight(db, other, item.id, "dismiss", decisionBody(item), now), (e: any) => e.status === 404);
  await db.membership.update({ where: { id: auth.activeMembership!.id }, data: { role: "manager" } });
  for (const work of [() => all(), () => getBusinessInsight(db, auth, item.id, now), () => refreshBusinessInsights(db, auth, {}, now), () => decideBusinessInsight(db, auth, item.id, "dismiss", decisionBody(item), now)]) await assert.rejects(work(), (e: any) => e.status === 403);
  await db.membership.update({ where: { id: auth.activeMembership!.id }, data: { role: "sales_lead" } }); assert.equal((await all()).items.length, 1);
  await db.membership.update({ where: { id: auth.activeMembership!.id }, data: { active: false } }); await assert.rejects(all());
});

it("denies the platform configuration context and forged mutation fields", async () => {
  await task(); await scan(); const item = (await all()).items[0];
  await assert.rejects(listBusinessInsights(db, { ...auth, configurationTenant: { id: tid } } as any, {}, now), (e: any) => e.status === 403);
  await assert.rejects(listBusinessInsights(db, auth, { state: "hidden", take: 100000 }, now), (e: any) => e.status === 422);
  await assert.rejects(decideBusinessInsight(db, auth, item.id, "dismiss", { ...decisionBody(item), amount: 999, tenantId: other.activeMembership!.tenantId }, now), (e: any) => e.status === 422);
  const body = decisionBody(item); await decideBusinessInsight(db, auth, item.id, "dismiss", body, now);
  await assert.rejects(decideBusinessInsight(db, auth, item.id, "acknowledge", body, now), (e: any) => e.code === "request_conflict");
});

it("excludes test and archived inquiries in both legacy deal link directions and tasks from such inquiries", async () => {
  const direct = await inquiry({ test: true }), reverse = await inquiry({ archived: true });
  await deal({ inquiryId: direct.id }); const d = await deal(); await db.inquiry.update({ where: { id: reverse.id }, data: { dealId: d.id } });
  await task({ inquiryId: direct.id }); await inquiry({ firstContactAt: now }); await inquiry({ status: "accepted" });
  await scan(); assert.equal((await all()).items.length, 0);
});

it("does not infer a missing next step from a truncated task list; future task suppresses proposal reminder", async () => {
  const d = await deal();
  await db.task.createMany({ data: Array.from({ length: 40 }, (_, i) => ({ tenantId: tid, dealId: d.id, title: `Шаг ${i}`, type: "note", dueAt: null })) });
  await task({ dealId: d.id, dueAt: future }); await scan();
  assert.equal((await all()).items.filter(i => i.rule === "deal_next_step" || i.rule === "proposal_delayed").length, 0);
});

it("proposal evidence uses linked conversation timestamps, never another order's contact activity or message text", async () => {
  const d = await deal(), unrelated = await db.conversation.create({ data: { tenantId: tid, contactId } });
  await db.message.create({ data: { tenantId: tid, conversationId: unrelated.id, direction: "inbound", senderKind: "client", text: "SECRET unrelated reply", createdAt: now } });
  await db.contact.update({ where: { id: contactId }, data: { lastInboundMessageAt: now } });
  await scan(); const item = (await all()).items.find(i => i.rule === "proposal_delayed"); assert.ok(item);
  const linked = await db.conversation.create({ data: { tenantId: tid, contactId } });
  await db.dealConversation.create({ data: { tenantId: tid, dealId: d.id, conversationId: linked.id } });
  await db.message.create({ data: { tenantId: tid, conversationId: linked.id, direction: "inbound", senderKind: "client", text: "SECRET linked reply", createdAt: now } });
  assert.equal((await getBusinessInsight(db, auth, item.id, now)).content, null);
  await scan(later()); assert.equal((await getBusinessInsight(db, auth, item.id, later())).state, "resolved");
  assert.doesNotMatch(JSON.stringify(await all(later())), /SECRET/);
});

it("payment signals use only unpaid overdue invoices, do not sum currencies and do not claim bank-confirmed debt", async () => {
  const d = await deal({ nextAction: "Связаться", nextActionAt: future });
  const make = (number: string, status: string, dueDate = past, currency = "KZT") => db.invoice.create({ data: { tenantId: tid, dealId: d.id, number, status, dueDate, currency, amountWithoutVat: 100, vatAmount: 0, totalAmount: 100 } });
  await make("paid", "PAID"); await make("draft", "DRAFT"); await make("future", "SENT", future); await scan();
  assert.equal((await all()).items.length, 0);
  const invoice = await make("USD overdue", "PARTIALLY_PAID", past, "USD"); await scan(later());
  const item = (await all(later())).items[0]; assert.equal(item.rule, "payment_delayed"); assert.equal(item.content?.period.currency, null);
  assert.match(item.content!.limitation, /не подтверждает долг/); assert.doesNotMatch(JSON.stringify(item.content), /100 KZT|100 ₸|200/);
  await db.invoice.update({ where: { id: invoice.id }, data: { status: "PAID" } }); await scan(later(2));
  assert.equal((await all(later(2))).items[0].state, "resolved");
});

it("bounded source pages eventually reach the tail and coverage never treats the first page as a full pass", async () => {
  for (let i = 0; i < 7; i++) await task({ title: `Задача ${i}` });
  await scan(now, 2); assert.equal((await all()).coverage.sources.find(s => s.kind === "task")!.lastFullPassAt, null);
  assert.equal((await all()).coverage.sources.find(s => s.kind === "task")!.inProgress, true);
  for (let i = 1; i <= 3; i++) await scan(later(i), 2);
  assert.equal((await all(later(3))).items.length, 7);
  assert.equal((await all(later(3))).coverage.sources.find(s => s.kind === "task")!.lastFullPassAt, later(3).toISOString());
  assert.equal(await scan(later(3), 2), false, "paced, not a new full scan on every click");
  assert.equal(await db.businessInsightEvent.count({ where: { tenantId: tid, type: "detected" } }), 7);
});

it("keyset paging returns every insight exactly once, with no misleading total", async () => {
  await db.task.createMany({ data: Array.from({ length: 26 }, (_, i) => ({ tenantId: tid, title: `Т ${i}`, type: "note", dueAt: past })) });
  await scan(now, 30); const first = await all(); assert.equal(first.items.length, 20); assert.ok(first.nextCursor); assert.ok(!("total" in first));
  const second = await listBusinessInsights(db, auth, { state: "all", cursor: first.nextCursor }, now);
  assert.equal(second.items.length, 6); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items].map(i => i.id)).size, 26);
});

it("uses the shared forecast and exact money, excludes other currencies, and suppresses conclusions from insufficient or incomplete history", async () => {
  await db.tenant.update({ where: { id: tid }, data: { settingsJson: { ops: { salesPlans: [{ month: "2026-11", currency: "KZT", amount: 1000000 }] } } } });
  await deal({ createdAt: new Date("2026-04-01T00:00:00Z"), outcome: "lost" });
  for (const month of ["08", "09", "10"]) for (let i = 0; i < 4; i++) await deal({ outcome: "won", closedAt: new Date(`2026-${month}-15T10:00:00Z`), wonAmountMinor: 1000 });
  await deal({ outcome: "won", currency: "USD", closedAt: new Date("2026-10-15T10:00:00Z"), wonAmountMinor: 9999999 });
  const f = await getCompanySalesForecast(db, auth, now); assert.equal(f.status, "ready");
  assert.equal(f.evidence.otherCurrencySales, 1); assert.equal(f.target.amount.exact, "1000000");
  const comparison = await getSalesForecast(db, { tenantId: tid, dealWhere: await businessDealWhere(db, tid), timeZone: "Asia/Almaty", currency: "KZT", now, period: "this_month", filtered: false, monthlyPlan: 1000000 });
  assert.deepEqual(f, comparison, "aggregate SQL path uses exactly the same financial semantics as the report");
  const fact = planEvidence(f, tid); assert.equal(fact.active, true); assert.equal(fact.content.period.currency, "KZT");
  assert.ok(fact.content.facts.some(x => x.label === "Прогноз" && x.value === f.estimate.label));
  await scan(); const item = (await all()).items.find(i => i.rule === "sales_plan_risk")!; assert.ok(item); assert.equal(item.stale, false);
  await db.tenant.update({ where: { id: tid }, data: { currency: "USD" } }); assert.equal((await getBusinessInsight(db, auth, item.id, now)).content, null);
  const insufficient = { ...f, status: "insufficient_history" as const }; assert.equal(planEvidence(insufficient, tid).active, false); assert.equal(planEvidence(insufficient, tid).available, false);
  const incomplete = { ...f, status: "incomplete_data" as const }; assert.equal(planEvidence(incomplete, tid).active, false);
});

it("company forecast excludes legacy test links without fetching an unbounded exclusion list", async () => {
  const excluded = await inquiry({ test: true }), archived = await inquiry({ archived: true });
  await deal({ inquiryId: excluded.id, outcome: "won", wonAmountMinor: 999999, closedAt: now });
  const reversed = await deal({ outcome: "won", wonAmountMinor: 888888, closedAt: now });
  await db.inquiry.update({ where: { id: archived.id }, data: { dealId: reversed.id } });
  await deal({ outcome: "won", offerAmountMinor: 123, closedAt: now });
  const f = await getCompanySalesForecast(db, auth, now); assert.equal(f.actual.exact, "123");
});

it("scan and decision failures roll back both state and history, then can retry without duplicates", async () => {
  await task();
  const fail = new Proxy(db, { get(client: any, key) {
    if (key !== "$transaction") return client[key];
    return (work: any, options: any) => db.$transaction(tx => work(new Proxy(tx, { get(inner: any, field) {
      if (field !== "businessInsightEvent") return inner[field];
      return new Proxy(inner.businessInsightEvent, { get(model: any, method) { return method === "create" ? async () => { throw new Error("simulated insight persistence failure"); } : model[method]; } });
    } })), options);
  } });
  await assert.rejects(sweepBusinessInsightTenant(fail, tid, { now }), /simulated/);
  assert.equal(await db.businessInsight.count({ where: { tenantId: tid } }), 0);
  assert.equal(await db.businessInsightScan.count({ where: { tenantId: tid } }), 0);
  await scan(); const item = (await all()).items[0], body = decisionBody(item);
  await assert.rejects(decideBusinessInsight(fail, auth, item.id, "dismiss", body, now), /simulated/);
  assert.equal((await all()).items[0].state, "open");
  await decideBusinessInsight(db, auth, item.id, "dismiss", body, now);
  assert.equal((await getBusinessInsight(db, auth, item.id, now)).history.length, 2);
});

it("background scheduling advances in bounded company batches and paces tenants without an active owner", async () => {
  const orphan = await company(); await db.membership.update({ where: { id: orphan.activeMembership!.id }, data: { active: false } });
  await db.businessInsightScan.create({ data: { tenantId: orphan.activeMembership!.tenantId, nextRunAt: past } });
  await sweepBusinessInsights(db, now);
  const state = await db.businessInsightScan.findUniqueOrThrow({ where: { tenantId: orphan.activeMembership!.tenantId } });
  assert.ok(state.nextRunAt > now); assert.equal(state.lastRunAt, null);
});

it("can refresh exactly one changed insight and cannot read another company's source", async () => {
  const t = await task(); await scan(); const item = (await all()).items[0];
  await db.task.update({ where: { id: t.id }, data: { title: "Новая задача" } });
  assert.equal((await refreshBusinessInsights(db, auth, { insightId: item.id }, now)).advanced, true);
  assert.equal((await all()).items[0].content?.subject, "Новая задача");
  const foreign = await db.task.create({ data: { tenantId: other.activeMembership!.tenantId, type: "note", title: "PRIVATE", dueAt: past } });
  const key: InsightKey = { rule: "task_overdue", entityKind: "task", entityId: foreign.id };
  assert.equal((await loadBusinessEvidence(db, auth, [key], now)).evidence.get(metricKey(key)), undefined);
});

it("HTTP endpoints require authentication, private responses and valid explicit decisions", async () => {
  await task(); await scan(); const item = (await all()).items[0];
  const session = await issueSession(db, auth.user.id, "web"), app = createApp(db), server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve)); const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/v1/workspace/intelligence`, headers = { "Content-Type": "application/json", cookie: `crm_session=${session.sessionToken}`, "x-tenant-id": tid };
  try {
    assert.equal((await fetch(base)).status, 401);
    const response = await fetch(base, { headers }); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await fetch(`${base}?state=invalid`, { headers })).status, 422);
    assert.equal((await fetch(`${base}/${item.id}/dismiss`, { headers, method: "POST", body: "{}" })).status, 422);
    assert.equal((await fetch(`${base}/refresh`, { headers, method: "POST", body: JSON.stringify({ command: "send_all" }) })).status, 422);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
