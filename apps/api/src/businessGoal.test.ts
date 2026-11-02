import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, beforeEach, after, it, mock } from "node:test";
import { createPrismaClient } from "@creolab/db";
import type { AuthContext } from "./lib/types.ts";
import { authForUserInTenant, issueSession } from "./services/authService.ts";
import { createBusinessGoal, getBusinessGoal, listBusinessGoals, updateBusinessGoal, refreshBusinessGoal, linkGoalTask, sweepBusinessGoals, businessGoalOptions, goalTaskChoices } from "./services/businessGoalService.ts";
import { goalProgress, emptyGoalSample } from "./services/businessGoalMetrics.ts";
import { getTenantOps, updateTenantOps } from "./services/dealService.ts";
import { getCompanySalesForecast } from "./services/salesForecastService.ts";
import { previewActionPlan, confirmActionRun, processActionRun } from "./services/aiActionService.ts";
import { createApp } from "./app.ts";

let db: Awaited<ReturnType<typeof createPrismaClient>>, auth: AuthContext, other: AuthContext, tid: string, contactId: string, stageId: string;
const now = new Date("2026-11-15T07:00:00Z"), past = new Date("2026-11-10T07:00:00Z"), end = new Date("2026-11-30T19:00:00Z");
const later = (minutes = 2) => new Date(now.getTime() + minutes * 60_000);
async function company(role = "owner") {
  const tenant = await db.tenant.create({ data: { name: "Goals", slug: randomUUID(), settingsJson: { control: { enabled: true }, ops: { salesPlans: [{ month: "2026-11", amount: 1000, currency: "KZT" }] } } } });
  const user = await db.user.create({ data: { email: `${randomUUID()}@example.test`, name: "Руководитель", passwordHash: "unused" } });
  await db.membership.create({ data: { tenantId: tenant.id, userId: user.id, role } });
  await db.controlAccess.create({ data: { tenantId: tenant.id, userId: user.id, enabled: true, status: "active", allowedSources: ["CRM_CHAT"], canCreateTasks: true, canReadTeamData: true } });
  return authForUserInTenant(db, user.id, tenant.id);
}
function body(extra: Record<string, unknown> = {}) { return { requestId: randomUUID(), title: "Убрать просрочки", metric: "overdue_tasks", ownerMembershipId: auth.activeMembership!.id, from: "2026-11-01", to: "2026-11-30", target: 0, ...extra }; }
const create = (extra: Record<string, unknown> = {}) => createBusinessGoal(db, auth, body(extra), now);
const sales = () => { const b = body({ metric: "sales_won", title: "План ноября", salesMonth: "2026-11", currency: "KZT" }); delete b.from; delete b.to; delete b.target; return b; };
const task = (extra: Record<string, any> = {}) => db.task.create({ data: { tenantId: tid, contactId, title: "Позвонить", type: "note", dueAt: past, createdAt: past, ...extra } });
const won = (extra: Record<string, any> = {}) => db.deal.create({ data: { tenantId: tid, contactId, stageId, title: "Продажа", outcome: "won", closedAt: past, offerAmountMinor: 400, currency: "KZT", ...extra } });
const refresh = (id: string, at = later(), requestId = randomUUID()) => refreshBusinessGoal(db, auth, id, { requestId }, at);
before(async () => { db = await createPrismaClient(); });
beforeEach(async () => { auth = await company(); other = await company(); tid = auth.activeMembership!.tenantId;
  contactId = (await db.contact.create({ data: { tenantId: tid, name: "Клиент" } })).id;
  stageId = (await db.dealStage.create({ data: { tenantId: tid, name: "Продано", systemKey: "won", sortOrder: 20, isTerminal: true } })).id;
});
after(async () => db.$disconnect());

it("starts from measured overdue baseline and lower-is-better progress without changing tasks", async () => {
  const a = await task(), b = await task(); await task({ status: "done" }); await task({ dueAt: later(20) });
  const goal = await create(); assert.equal(goal.baseline?.value, 2); assert.equal(goal.current?.sample.value, 2); assert.equal(goal.current?.progress, 0);
  await db.task.update({ where: { id: a.id }, data: { status: "done" } });
  const middle = await refresh(goal.id); assert.equal(middle.current?.progress, 50); assert.equal(middle.current?.reached, false);
  await db.task.update({ where: { id: b.id }, data: { status: "done" } });
  const complete = await refresh(goal.id, later(4)); assert.equal(complete.current?.progress, 100); assert.equal(complete.current?.reached, true);
  assert.equal(complete.baseline?.value, 2); assert.equal(complete.measurements.length, 3);
});

it("zero baseline means maintaining the limit, never division by zero or invented improvement", async () => {
  const g = await create(); assert.equal(g.current?.sample.value, 0); assert.equal(g.current?.progress, 100);
  await task(); const bad = await refresh(g.id); assert.equal(bad.current?.progress, 0); assert.equal(bad.current?.reached, false);
  assert.equal(bad.baseline?.value, 0); assert.doesNotMatch(JSON.stringify(bad), /NaN|Infinity/);
});

it("same-timestamp goal edits select the latest revision instead of random measurement ID order", async () => {
  const g = await create();
  await db.goalMeasurement.update({ where: { id: g.current!.id }, data: { id: "ffffffff-ffff-4fff-8fff-ffffffffffff" } });
  const changed = await updateBusinessGoal(db, auth, g.id, { requestId: randomUUID(), version: g.version, target: 2 }, now);
  assert.equal(changed.current?.version, changed.version); assert.equal(changed.current?.target, 2);
  assert.equal(changed.targetChanged, false); assert.equal(changed.stale, false);
  assert.equal(changed.measurements[0].version, changed.version);
});

it("progress rounding never claims 100 percent until the exact target is reached", () => {
  const sample = { ...emptyGoalSample("sales_won", "ready"), value: 999999 };
  assert.deepEqual(goalProgress("sales_won", sample, 1000000, 0), { progress: 99.9, reached: false });
  assert.deepEqual(goalProgress("first_response_minutes", { ...sample, value: 15.0001 }, 15, 60), { progress: 99.9, reached: false });
  assert.deepEqual(goalProgress("overdue_tasks", { ...sample, value: 0 }, 0, 5000), { progress: 100, reached: true });
});

it("counts all overdue tasks beyond one UI page and excludes legacy test/archive links from measurements and initiatives", async () => {
  await db.task.createMany({ data: Array.from({ length: 205 }, (_, i) => ({ tenantId: tid, contactId, title: `Работа ${i}`, type: "note", dueAt: past, createdAt: past, status: ["open", "in_progress", "waiting"][i % 3] })) });
  const legacyInquiry = await db.inquiry.create({ data: { tenantId: tid, contactId, source: "manual", test: true } });
  const legacyDeal = await won({ inquiryId: legacyInquiry.id });
  const excluded = await task({ title: "Скрытая тестовая работа", dealId: legacyDeal.id });
  const otherDeal = await won(); await db.inquiry.create({ data: { tenantId: tid, contactId, source: "manual", archived: true, dealId: otherDeal.id } });
  await task({ dealId: otherDeal.id }); await task({ inquiryId: legacyInquiry.id }); await task({ status: "done" });
  const g = await create(); assert.equal(g.current?.sample.value, 205);
  assert.equal((await goalTaskChoices(db, auth, "Скрытая тестовая")).items.length, 0);
  await assert.rejects(linkGoalTask(db, auth, g.id, { requestId: randomUUID(), version: g.version, taskId: excluded.id }, later()), (e: any) => e.status === 404);
  const real = await task({ title: "100% точная_задача" });
  assert.deepEqual((await goalTaskChoices(db, auth, "% точная_")).items.map(t => t.id), [real.id]);
  const linked = await linkGoalTask(db, auth, g.id, { requestId: randomUUID(), version: g.version, taskId: real.id }, later());
  await db.task.update({ where: { id: real.id }, data: { dealId: legacyDeal.id } });
  assert.equal((await getBusinessGoal(db, auth, linked.id, later(3))).initiatives.length, 0);
});

it("sales goal links the sole ops plan and counts exact month, currency and non-test sales instead of payments", async () => {
  await won(); await won({ currency: "USD", wonAmountMinor: 2000 });
  await won({ closedAt: new Date("2026-10-31T18:59:59Z") });
  await won({ closedAt: new Date("2026-10-31T19:00:00Z"), wonAmountMinor: 100 });
  const test = await db.inquiry.create({ data: { tenantId: tid, contactId, source: "manual", test: true } });
  await won({ inquiryId: test.id, wonAmountMinor: 9999 });
  const input = sales(), g = await createBusinessGoal(db, auth, input, now);
  assert.equal(g.target, 1000); assert.equal(g.current?.sample.value, 500); assert.equal(g.current?.sample.excluded, 1);
  assert.equal(g.current?.progress, 50); assert.equal((await db.businessGoal.findUniqueOrThrow({ where: { id: g.id } })).target, null);
  assert.equal((await getCompanySalesForecast(db, auth, now)).actual.exact, "500");
  await assert.rejects(createBusinessGoal(db, auth, { ...input, requestId: randomUUID() }, now), (e: any) => e.code === "goal_exists");
  await assert.rejects(updateBusinessGoal(db, auth, g.id, { requestId: randomUUID(), version: g.version, target: 2 }, now), (e: any) => e.code === "goal_target");
});

it("ops plan edits and removal invalidate progress, preserve prior measurement target and create goal history", async () => {
  await won(); const g = await createBusinessGoal(db, auth, sales(), now), ops = await getTenantOps(db, auth);
  await updateTenantOps(db, auth, { revision: ops.revision, salesPlans: [{ month: "2026-11", currency: "KZT", amount: 2000 }] });
  const changed = await getBusinessGoal(db, auth, g.id, later()); assert.equal(changed.target, 2000); assert.equal(changed.targetChanged, true);
  assert.equal(changed.current?.progress, null); assert.equal(changed.current?.target, 1000); assert.ok(changed.history.some(e => e.type === "sales_plan_changed"));
  const measured = await refresh(g.id); assert.equal(measured.current?.progress, 20); assert.equal(measured.measurements[1].target, 1000);
  const fresh = await getTenantOps(db, auth); await updateTenantOps(db, auth, { revision: fresh.revision, salesPlans: [] });
  const missing = await refresh(g.id, later(4)); assert.equal(missing.target, null); assert.equal(missing.current?.sample.status, "plan_missing"); assert.equal(missing.current?.progress, null);
});

it("missing amount or undated sale yields incomplete coverage, never a false zero or complete goal", async () => {
  const d = await won({ offerAmountMinor: null }); const g = await createBusinessGoal(db, auth, sales(), now);
  assert.equal(g.current?.sample.status, "incomplete"); assert.equal(g.current?.sample.value, null); assert.equal(g.current?.progress, null);
  await db.deal.update({ where: { id: d.id }, data: { offerAmountMinor: 400, closedAt: null } });
  assert.equal((await refresh(g.id)).current?.sample.status, "incomplete");
});

async function conversation(minutes: number | null, extra: Record<string, any> = {}) {
  const c = await db.conversation.create({ data: { tenantId: tid, contactId } });
  await db.message.create({ data: { tenantId: tid, conversationId: c.id, direction: "inbound", senderKind: "client", text: "Вопрос", createdAt: past } });
  if (minutes !== null) await db.message.create({ data: { tenantId: tid, conversationId: c.id, direction: "outbound", senderKind: "ai", text: "Ответ", operationState: "accepted", createdAt: new Date(past.getTime() + minutes * 60_000), ...extra } });
  return c;
}
it("first-response metric has no-data state and pending conversations prevent a misleading 100 percent", async () => {
  const g = await create({ metric: "first_response_minutes", target: 15 }); assert.equal(g.current?.sample.status, "no_data"); assert.equal(g.current?.progress, null);
  await conversation(5); const pending = await conversation(null);
  const measured = await refresh(g.id); assert.equal(measured.current?.sample.value, 5); assert.equal(measured.current?.sample.unanswered, 1);
  assert.equal(measured.current?.progress, null); assert.equal(measured.current?.reached, null); assert.equal(measured.baseline, null);
  await db.message.create({ data: { tenantId: tid, conversationId: pending.id, direction: "outbound", senderKind: "staff", operationState: "accepted", createdAt: new Date(past.getTime() + 35 * 60_000) } });
  const answered = await refresh(g.id, later(4)); assert.equal(answered.current?.sample.value, 20); assert.equal(answered.baseline?.value, 20); assert.equal(answered.current?.reached, false);
});

it("response calculation excludes failed, internal, historical and test messages without dropping long waits", async () => {
  await conversation(5, { operationState: "failed" }); await conversation(3, { internal: true }); await conversation(2, { historical: true });
  const test = await conversation(1); await db.inquiry.create({ data: { tenantId: tid, contactId, conversationId: test.id, source: "manual", test: true } });
  await conversation(60 * 24 * 4);
  const g = await create({ metric: "first_response_minutes", target: 60 });
  assert.equal(g.current?.sample.samples, 1); assert.equal(g.current?.sample.value, 5760); assert.equal(g.current?.sample.unanswered, 3);
});

it("future period has no baseline until its start and timezone changes require explicit new scope", async () => {
  await task(); const g = await create({ from: "2026-11-20" }); assert.equal(g.current?.sample.status, "not_started"); assert.equal(g.baseline, null);
  const started = await refresh(g.id, new Date("2026-11-20T07:00:00Z")); assert.equal(started.baseline?.value, 1);
  await db.tenant.update({ where: { id: tid }, data: { timezone: "Europe/Berlin" } });
  const changed = await getBusinessGoal(db, auth, g.id, new Date("2026-11-21T07:00:00Z")); assert.equal(changed.stale, true); assert.equal(changed.current?.progress, null);
  const updated = await refresh(g.id, new Date("2026-11-21T07:00:00Z")); assert.equal(updated.current?.sample.status, "config_changed"); assert.equal(updated.timezone, "Asia/Almaty");
});

it("ended overdue goal preserves its last pre-deadline snapshot instead of rewriting history with current task state", async () => {
  const t = await task(), g = await create();
  await db.task.update({ where: { id: t.id }, data: { status: "done" } });
  const ended = await refresh(g.id, end); assert.equal(ended.current?.sample.status, "ended_snapshot"); assert.equal(ended.current?.sample.value, 1);
  assert.equal(ended.current?.asOf, now.toISOString()); assert.equal(ended.current?.reached, null); assert.equal(ended.nextCheckAt, null);
  await assert.rejects(updateBusinessGoal(db, auth, g.id, { requestId: randomUUID(), version: ended.version, target: 1 }, end), (e: any) => e.code === "goal_ended");
});

it("negative targets, bad dates, changed metrics, mixed currencies, foreign owners and invalid count fractions are rejected", async () => {
  for (const extra of [{ target: -1 }, { target: 0.5 }, { to: "2026-02-31" }, { from: "2026-12-01" }, { currency: "USD" }, { ownerMembershipId: other.activeMembership!.id }, { metric: "cash_collected" }, { metric: "first_response_minutes", target: 0 }, { metric: "first_response_minutes", target: 1.000001 }]) {
    await assert.rejects(create(extra), (e: any) => e.status === 422);
  }
  const g = await create(); await assert.rejects(updateBusinessGoal(db, auth, g.id, { requestId: randomUUID(), version: g.version, metric: "sales_won" }, now), (e: any) => e.status === 422);
  assert.equal(await db.businessGoal.count({ where: { tenantId: tid } }), 1);
});

it("create and refresh retries are idempotent; a return to an earlier value is a new observable measurement", async () => {
  const input = body(); const [a, b] = await Promise.all([createBusinessGoal(db, auth, input, now), createBusinessGoal(db, auth, input, now)]);
  assert.equal(a.id, b.id); assert.equal(await db.businessGoalEvent.count({ where: { tenantId: tid, type: "created" } }), 1);
  const req = randomUUID(); const c = await refresh(a.id, later(), req), d = await refresh(a.id, later(4), req); assert.equal(c.measurements.length, 1); assert.equal(d.measurements.length, 1);
  const t = await task(); assert.equal((await refresh(a.id, later(6))).current?.sample.value, 1);
  await db.task.update({ where: { id: t.id }, data: { status: "done" } }); const again = await refresh(a.id, later(8));
  assert.equal(again.current?.sample.value, 0); assert.equal(again.measurements.length, 3);
  await assert.rejects(createBusinessGoal(db, auth, { ...input, title: "Подмена" }, now), (e: any) => e.code === "request_conflict");
});

it("target changes preserve baseline and old target snapshots; stale concurrent edits do not overwrite", async () => {
  await task(); await task(); const g = await create();
  const changed = await updateBusinessGoal(db, auth, g.id, { requestId: randomUUID(), version: g.version, target: 1 }, later());
  assert.equal(changed.baseline?.value, 2); assert.equal(changed.measurements[1].target, 0); assert.equal(changed.current?.target, 1);
  await assert.rejects(updateBusinessGoal(db, auth, g.id, { requestId: randomUUID(), version: g.version, target: 2 }, later()), (e: any) => e.code === "goal_changed");
});

it("tenant and role restrictions cover values, history, changes, and revoked membership", async () => {
  const g = await create(); await assert.rejects(getBusinessGoal(db, other, g.id, now), (e: any) => e.status === 404);
  await db.membership.update({ where: { id: auth.activeMembership!.id }, data: { role: "sales_lead" } });
  assert.equal((await getBusinessGoal(db, auth, g.id, now)).canEdit, false);
  await assert.rejects(create(), (e: any) => e.status === 403);
  await db.membership.update({ where: { id: auth.activeMembership!.id }, data: { role: "manager" } });
  await assert.rejects(listBusinessGoals(db, auth), (e: any) => e.status === 403);
  await assert.rejects(getBusinessGoal(db, auth, g.id), (e: any) => e.status === 403);
  await assert.rejects(refresh(g.id), (e: any) => e.status === 403);
});

it("links a real task and its own confirmed action run without mutating task or claiming causal revenue", async () => {
  const g = await create();
  const run = await previewActionPlan(db, auth, { requestId: randomUUID(), title: "Разобрать просрочки", steps: [{ key: "task", kind: "task.create", type: "note", title: "Разобрать просрочки", ownerMembershipId: auth.activeMembership!.id }] });
  await confirmActionRun(db, auth, run.id, { requestId: randomUUID(), planHash: run.planHash, confirmed: true }); await processActionRun(db, tid, run.id);
  const step = await db.actionStep.findFirstOrThrow({ where: { runId: run.id } });
  const before = await db.task.findUnique({ where: { id: step.taskId! } });
  const linked = await linkGoalTask(db, auth, g.id, { requestId: randomUUID(), version: g.version, taskId: step.taskId!, remove: false }, later());
  assert.equal(linked.initiatives[0].taskId, step.taskId); assert.equal(linked.initiatives[0].runId, run.id);
  assert.deepEqual(await db.task.findUnique({ where: { id: step.taskId! } }), before);
  const foreign = await db.task.create({ data: { tenantId: other.activeMembership!.tenantId, title: "Чужая", type: "note" } });
  await assert.rejects(linkGoalTask(db, auth, g.id, { requestId: randomUUID(), version: linked.version, taskId: foreign.id }, later(4)), (e: any) => e.status === 404);
  const removed = await linkGoalTask(db, auth, g.id, { requestId: randomUUID(), version: linked.version, taskId: step.taskId!, remove: true }, later(4));
  assert.equal(removed.initiatives.length, 0); assert.ok(await db.task.findUnique({ where: { id: step.taskId! } }));
});

it("archive pauses checkpoints and preserves history; explicit restoration does not create a second goal", async () => {
  const g = await create(); const archived = await updateBusinessGoal(db, auth, g.id, { requestId: randomUUID(), version: g.version, state: "archived" }, later());
  assert.equal(archived.nextCheckAt, null); assert.equal(archived.measurements.length, 1);
  assert.equal(archived.current?.progress, 100); assert.equal(archived.current?.reached, true); assert.equal(archived.stale, false);
  await sweepBusinessGoals(db, later(60)); assert.equal((await getBusinessGoal(db, auth, g.id, later(60))).measurements.length, 1);
  assert.equal((await listBusinessGoals(db, auth, { state: "archived" })).items.length, 1);
  const restored = await updateBusinessGoal(db, auth, g.id, { requestId: randomUUID(), version: archived.version, state: "active" }, later(60));
  assert.equal(restored.id, g.id); assert.equal(restored.state, "active"); assert.ok(restored.nextCheckAt);
});

it("list pagination keeps all company goals visible and checkpoint batches are limited to five", async () => {
  await db.businessGoal.updateMany({ data: { nextCheckAt: null } });
  await db.businessGoal.createMany({ data: Array.from({ length: 21 }, (_, i) => ({ tenantId: tid, title: `Цель ${i}`, metric: "overdue_tasks", ownerMembershipId: auth.activeMembership!.id,
    periodStart: past, periodEnd: end, timezone: "Asia/Almaty", target: 0, nextCheckAt: now })) });
  const first = await listBusinessGoals(db, auth, {}, now), second = await listBusinessGoals(db, auth, { cursor: first.nextCursor }, now);
  assert.equal(first.items.length, 20); assert.equal(second.items.length, 1); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items].map(g => g.id)).size, 21);
  assert.equal((await listBusinessGoals(db, other, {}, now)).items.length, 0);
  await sweepBusinessGoals(db, now);
  assert.equal(await db.goalMeasurement.count({ where: { tenantId: tid } }), 5);
  assert.equal(await db.businessGoal.count({ where: { tenantId: tid, nextCheckAt: { lte: now } } }), 16);
});

it("worker records daily checkpoints once, is bounded, and performs no outside effects", async () => {
  const g = await create();
  // Earlier cases intentionally leave overdue batches behind. Isolate this
  // scheduling assertion from those fixtures rather than assuming queue order.
  await db.businessGoal.updateMany({ where: { id: { not: g.id } }, data: { nextCheckAt: null } });
  const f = mock.method(globalThis, "fetch", async () => { throw new Error("No outbound calls"); });
  try { await Promise.all([sweepBusinessGoals(db, later(1441)), sweepBusinessGoals(db, later(1441))]); assert.equal(f.mock.callCount(), 0); } finally { f.mock.restore(); }
  const measured = await getBusinessGoal(db, auth, g.id, later(1441)); assert.equal(measured.measurements.length, 2);
  assert.equal(await db.task.count({ where: { tenantId: tid } }), 0); assert.equal(await db.message.count({ where: { tenantId: tid } }), 0);
  assert.equal(await db.notification.count({ where: { tenantId: tid } }), 0);
});

it("history write failure rolls back a goal mutation and its measurement", async () => {
  const g = await create();
  await db.$executeRawUnsafe(`CREATE FUNCTION fail_goal_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type = 'changed' THEN RAISE EXCEPTION 'simulated failure'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe(`CREATE TRIGGER fail_goal_event BEFORE INSERT ON "BusinessGoalEvent" FOR EACH ROW EXECUTE FUNCTION fail_goal_event()`);
  try { await assert.rejects(updateBusinessGoal(db, auth, g.id, { requestId: randomUUID(), version: g.version, target: 4 }, later())); }
  finally { await db.$executeRawUnsafe('DROP TRIGGER fail_goal_event ON "BusinessGoalEvent"'); await db.$executeRawUnsafe('DROP FUNCTION fail_goal_event()'); }
  const unchanged = await getBusinessGoal(db, auth, g.id, later()); assert.equal(unchanged.version, g.version); assert.equal(unchanged.target, 0); assert.equal(unchanged.measurements.length, 1);
});

it("HTTP endpoints require authentication, return no-store and keep company scope server-owned", async () => {
  const token = await issueSession(db, auth.user.id, "web"), server = createApp(db).listen(0, "127.0.0.1");
  await new Promise<void>(r => server.once("listening", r)); const url = `http://127.0.0.1:${(server.address() as any).port}/api/v1/workspace/goals`;
  try {
    assert.equal((await fetch(url)).status, 401);
    const headers = { cookie: `crm_session=${token.sessionToken}`, "x-tenant-id": tid, "Content-Type": "application/json" };
    assert.equal((await fetch(`${url}?tenantId=${tid}`, { headers })).status, 422);
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body()) }); assert.equal(r.status, 201); assert.equal(r.headers.get("cache-control"), "no-store");
    const g = await r.json() as any;
    const get = await fetch(`${url}/${g.id}`, { headers }); assert.equal(get.status, 200); assert.equal((await get.json() as any).id, g.id);
    const opts = await fetch(`${url}/options`, { headers }); assert.equal(opts.status, 200); assert.equal((await opts.json() as any).canEdit, true);
    const updated = await fetch(`${url}/${g.id}`, { method: "PATCH", headers, body: JSON.stringify({ requestId: randomUUID(), version: g.version, title: "Проверенная цель" }) }); assert.equal(updated.status, 200);
  } finally { await new Promise<void>((r, reject) => server.close(e => e ? reject(e) : r())); }
});
