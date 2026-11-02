import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, beforeEach, after, afterEach, it, mock } from "node:test";
import { createPrismaClient } from "@creolab/db";
import type { ControlAction, BusinessHomeFocus } from "@creolab/contracts";
import type { AuthContext } from "./lib/types.ts";
import { ApiError } from "./errors.ts";
import { authForUserInTenant, issueSession } from "./services/authService.ts";
import { authorizeWebControl } from "./services/aiControlService.ts";
import { getBusinessHomeFocus } from "./services/businessHomeService.ts";
import { sweepBusinessInsightTenant } from "./services/businessInsightService.ts";
import { createBusinessGoal } from "./services/businessGoalService.ts";
import { prepareControlBriefing, homeBriefingBlocks, fitBriefingBlock, nextBriefingDay } from "./services/controlBriefingService.ts";
import { createApp } from "./app.ts";

let db: Awaited<ReturnType<typeof createPrismaClient>>, auth: AuthContext, other: AuthContext, tid: string;
const now = new Date("2026-11-02T05:00:00Z");
async function company(role = "owner") {
  const t = await db.tenant.create({ data: { name: "Home acceptance", slug: randomUUID(), settingsJson: { control: { enabled: true } } } });
  const u = await db.user.create({ data: { email: `${randomUUID()}@example.test`, name: "Owner", passwordHash: "unused" } });
  await db.membership.create({ data: { tenantId: t.id, userId: u.id, role } });
  await db.controlAccess.create({ data: { tenantId: t.id, userId: u.id, enabled: true, status: "active", allowedSources: ["CRM_CHAT"], canCreateTasks: true, canReadFinancialData: true, canReadTeamData: true } });
  return authForUserInTenant(db, u.id, t.id);
}
async function run(title: string, extra: Record<string, any> = {}, who = auth) {
  return db.actionRun.create({ data: { tenantId: who.activeMembership!.tenantId, userId: who.user.id, initiatorMembershipId: who.activeMembership!.id,
    requestId: randomUUID(), requestHash: "fixture", snapshotJson: {}, title, createdAt: now, expiresAt: new Date(now.getTime() + 3600000), ...extra } });
}
const goal = (title = "Убрать просрочки") => createBusinessGoal(db, auth, { requestId: randomUUID(), title, metric: "overdue_tasks", ownerMembershipId: auth.activeMembership!.id, from: "2026-11-01", to: "2026-11-30", target: 0 }, now);
const task = () => db.task.create({ data: { tenantId: tid, title: "Позвонить клиенту", type: "note", dueAt: new Date("2026-11-01T05:00:00Z") } });
const focus = (at = now) => getBusinessHomeFocus(db, auth, at);
const grant = (data: Record<string, unknown>) => db.controlAccess.update({ where: { tenantId_userId: { tenantId: tid, userId: auth.user.id } }, data });
const allowed: ControlAction[] = ["GET_SITUATION", "GET_TODAY_TASKS", "GET_BUSINESS_SUMMARY", "GET_TASKS"];
function briefing(options: Partial<Parameters<typeof prepareControlBriefing>[1]> = {}) {
  return prepareControlBriefing(db, { kinds: ["evening"], language: "ru", allowed, now,
    executor: { authorize: action => authorizeWebControl(db, auth, action), execute: async () => ({}), confirm: async () => { throw new Error("Cannot write"); } },
    execute: async () => ({ data: { attention: {}, items: [], nearest: [], total: 0 }, meta: { period: "today", timeZone: "Asia/Almaty" } }), ...options });
}
before(async () => { db = await createPrismaClient(); });
beforeEach(async () => { auth = await company(); other = await company(); tid = auth.activeMembership!.tenantId; });
afterEach(() => mock.restoreAll());
after(async () => db.$disconnect());

it("empty companies distinguish an uncompleted scan from a verified empty sample", async () => {
  let result = await focus(); assert.equal(result.scope, "company"); assert.equal(result.insights.status, "ready"); assert.equal(result.insights.scannedAt, null);
  assert.deepEqual(result.goals.items, []); assert.deepEqual(result.actions.items, []);
  await sweepBusinessInsightTenant(db, tid, { now }); result = await focus();
  assert.equal(result.insights.scannedAt, now.toISOString()); assert.equal(result.insights.sampled, true); assert.deepEqual(result.insights.items, []);
});
it("shows verified signals with their source and never resurrects resolved or stale evidence", async () => {
  const t = await task(); await sweepBusinessInsightTenant(db, tid, { now });
  let result = await focus(); assert.ok(result.insights.items.length); assert.ok(result.insights.items[0].limitation); assert.match(result.insights.items[0].href, /view=insights&insight=/);
  await db.task.update({ where: { id: t.id }, data: { status: "done" } }); result = await focus(); assert.deepEqual(result.insights.items, []);
  await db.task.update({ where: { id: t.id }, data: { status: "open" } }); result = await focus(new Date(now.getTime() + 3600000)); assert.deepEqual(result.insights.items, []);
});
it("old pending work stays visible behind many finished runs; expired drafts and other users stay out", async () => {
  const waiting = await run("Waiting oldest", { createdAt: new Date(now.getTime() - 100000) });
  await run("Expired", { expiresAt: new Date(now.getTime() - 1) });
  for (let i = 0; i < 24; i++) await run(`Done ${i}`, { status: "succeeded", finishedAt: new Date(now.getTime() - i * 1000) });
  const colleague = await db.user.create({ data: { name: "Director", email: `${randomUUID()}@example.test`, passwordHash: "unused" } });
  await run("Other employee secret", { userId: colleague.id }); await run("Other tenant secret", {}, other);
  const result = await focus(); assert.equal(result.actions.items[0].id, waiting.id); assert.equal(result.actions.items.length, 1); assert.equal(result.actions.recent.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /secret|Expired/); assert.match(result.actions.items[0].href, /view=plans&run=/);
});
it("reports actual completed steps and a failed plan, not an achieved business goal", async () => {
  const r = await run("Partially executed", { status: "failed", finishedAt: now });
  for (const [i, status] of ["succeeded", "failed"].entries()) await db.actionStep.create({ data: { tenantId: tid, runId: r.id, position: i, key: `step${i}`, kind: "task.create", label: "Step", detail: "", inputJson: {}, snapshotJson: {}, status } });
  const result = await focus(); assert.equal(result.actions.recent[0].completed, 1); assert.equal(result.actions.recent[0].steps, 2); assert.equal(result.actions.recent[0].status, "failed");
  const text = homeBriefingBlocks(result, "ru").join("\n"); assert.match(text, /Нужна проверка результата/); assert.match(text, /не подтверждение достижения/);
});
it("reuses goal measurements but does not call stale or ended measurements current progress", async () => {
  await goal(); let result = await focus(); assert.equal(result.goals.items[0].progress, 100);
  result = await focus(new Date("2026-12-10T05:00:00Z")); assert.equal(result.goals.items[0].progress, null); assert.equal(result.goals.items[0].reached, null); assert.equal(result.goals.items[0].ended, true);
});
it("bounds large home modules rather than dumping the whole company", async () => {
  for (let i = 0; i < 5; i++) { await goal(`Goal ${i}`); await run(`Plan ${i}`); await task(); }
  await sweepBusinessInsightTenant(db, tid, { now }); const r = await focus(); assert.equal(r.goals.items.length, 3); assert.equal(r.actions.items.length, 2); assert.ok(r.insights.items.length <= 2);
});
it("partial storage failure is unavailable, never an empty successful section", async () => {
  await goal(); const broken = new Proxy(db, { get: (target, key) => key === "actionRun" ? { findMany: async () => { throw new Error("Simulated storage outage"); } } : Reflect.get(target, key) });
  const r = await getBusinessHomeFocus(broken, auth, now); assert.equal(r.actions.status, "unavailable"); assert.equal(r.goals.status, "ready"); assert.equal(r.goals.items.length, 1); assert.equal(r.insights.status, "ready");
});
it("employee and demoted-owner context runs no company-wide readers", async () => {
  await run("Private plan"); await db.membership.update({ where: { id: auth.activeMembership!.id }, data: { role: "manager" } });
  const guarded = new Proxy(db, { get: (target, key) => key === "$transaction" ? async () => { throw new Error("A company reader must not run"); } : Reflect.get(target, key) });
  const r = await getBusinessHomeFocus(guarded, auth, now); assert.equal(r.scope, "personal"); assert.equal(r.actions.status, "hidden"); assert.equal(r.insights.status, "hidden"); assert.equal(r.goals.status, "hidden"); assert.doesNotMatch(JSON.stringify(r), /Private/);
});
it("rechecks membership after collecting data and rejects mid-request revocation", async () => {
  const original = db.actionRun.findMany.bind(db.actionRun); let changed = false;
  const changing = new Proxy(db, { get: (target, key) => key === "actionRun" ? { findMany: async (...args: any[]) => {
    const result = await original(...args as [any]);
    if (!changed) { changed = true; await db.membership.update({ where: { id: auth.activeMembership!.id }, data: { role: "manager" } }); }
    return result;
  } } : Reflect.get(target, key) });
  await assert.rejects(getBusinessHomeFocus(changing, auth, now), (e: ApiError) => e.status === 403);
});
it("inactive membership and platform configuration mode cannot read the company home", async () => {
  await assert.rejects(getBusinessHomeFocus(db, { ...auth, configurationTenant: { tenantId: tid, tenant: auth.activeMembership!.tenant } }), (e: ApiError) => e.status === 403);
  await db.membership.update({ where: { id: auth.activeMembership!.id }, data: { active: false } });
  await assert.rejects(focus(), (e: ApiError) => [401, 403].includes(e.status));
});
it("evening briefing reads tomorrow's unfinished tasks in the company's calendar, without writes", async () => {
  const calls: Array<{ action: ControlAction; params: any }> = [], before = await db.task.count({ where: { tenantId: tid } });
  const text = await briefing({ now: new Date("2026-11-30T20:00:00Z"), execute: async (action, params) => { calls.push({ action, params }); return { data: { items: [], attention: {} } }; } });
  assert.match(text, /Вечерняя сводка/); assert.match(text, /План на завтра · 2026-12-02/);
  assert.deepEqual(calls.find(c => c.action === "GET_TASKS")!.params, { period: "custom", dateFrom: "2026-12-02", dateTo: "2026-12-02", taskStatus: "active" });
  assert.equal(await db.task.count({ where: { tenantId: tid } }), before);
});
it("morning and evening together use one bounded text and deduplicate situation reads", async () => {
  const calls: string[] = []; await run("Plan " + "x".repeat(150));
  const text = await briefing({ kinds: ["morning", "evening"], execute: async action => { calls.push(action); return { data: { items: Array.from({ length: 30 }, (_, i) => ({ title: `Task ${i} ` + "x".repeat(300), contactName: "Long client ".repeat(100), phone: "+77015556677" })), nearest: [], total: 30, attention: {} } }; } });
  assert.equal(calls.filter(c => c === "GET_SITUATION").length, 1); assert.ok(text.length <= 4000); assert.match(text, /Утренняя и вечерняя/); assert.match(text, /Ждёт вашего подтверждения/); assert.ok(text.endsWith("/today"));
});
it("restricted financial/team permissions and action allowlist cannot leak company context through briefing titles", async () => {
  await run("Private forecast 123456"); await goal("Private finance 123456");
  for (const data of [{ canReadFinancialData: false }, { canReadFinancialData: true, canReadTeamData: false }, { canReadTeamData: true, allowedActions: ["GET_SITUATION"] }]) {
    await grant(data); const text = await briefing({ allowed: ["GET_SITUATION"] }); assert.doesNotMatch(text, /Private|123456/);
  }
});
it("briefing discards collected data if Control permissions change during the read", async () => {
  let called = false;
  await assert.rejects(briefing({ allowed: ["GET_SITUATION"], execute: async () => { if (!called) { called = true; await grant({ canReadTeamData: false }); } return { data: { attention: {} } }; } }), (e: ApiError) => e.status === 403);
});
it("a failed section says it failed, instead of reporting zero tasks", async () => {
  const text = await briefing({ kinds: ["morning"], allowed: ["GET_TODAY_TASKS"], execute: async () => { throw new Error("Unavailable"); } });
  assert.match(text, /не загрузилась/); assert.doesNotMatch(text, /На сегодня осталось: 0|Задач нет/);
});
it("short summaries retain fractional progress and full source links, including Kazakh", () => {
  assert.equal(nextBriefingDay(new Date("2026-12-31T20:00:00Z"), "Asia/Almaty"), "2027-01-02");
  const link = "https://bsqr.kz/control?view=goals&goal=" + randomUUID();
  const limited = fitBriefingBlock("Задачи\n" + "Подробности\n".repeat(500) + link, 500); assert.ok(limited.length <= 500); assert.ok(limited.endsWith(link));
  const r: BusinessHomeFocus = { asOf: now.toISOString(), scope: "company", insights: { status: "ready", items: [], sampled: true, scannedAt: null }, actions: { status: "ready", items: [], recent: [] },
    goals: { status: "ready", items: [{ id: "g", title: "План", progress: 99.9, reached: false, stale: false, ended: false, asOf: now.toISOString(), href: "/control?view=goals" }] } };
  assert.match(homeBriefingBlocks(r, "kk").join("\n"), /Мақсат: План\n99.9%/);
});
it("HTTP home is authenticated and non-cacheable; a stale owner session sees only personal modules after demotion", async () => {
  const session = await issueSession(db, auth.user.id, "web"), server = createApp(db).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/workspace/home`, headers = { cookie: `crm_session=${session.sessionToken}`, "x-tenant-id": tid };
  try {
    assert.equal((await fetch(base)).status, 401);
    const response = await fetch(base, { headers }); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store"); assert.equal((await response.json()).scope, "company");
    assert.equal((await fetch(base, { headers: { ...headers, "x-tenant-id": other.activeMembership!.tenantId } })).status, 403);
    await db.membership.update({ where: { id: auth.activeMembership!.id }, data: { role: "manager" } });
    const r = await fetch(base, { headers }); assert.equal(r.status, 200); assert.equal((await r.json()).scope, "personal");
  } finally { server.close(); }
});
