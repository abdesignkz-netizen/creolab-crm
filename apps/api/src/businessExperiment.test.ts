import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, beforeEach, after, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import type { AuthContext } from "./lib/types.ts";
import type { BusinessExperimentDetail, ExperimentMethod, ExperimentSample } from "@creolab/contracts";
import { authForUserInTenant, issueSession } from "./services/authService.ts";
import { saveExperiment, operateExperiment, getExperiment, listExperiments, experimentOptions, experimentTaskChoices } from "./services/businessExperimentService.ts";
import { measureProposalPreparation, compareExperiment } from "./services/businessExperimentMetrics.ts";
import { createApp } from "./app.ts";
import { prepareTaskExecution } from "./services/taskExecutionService.ts";

let db: Awaited<ReturnType<typeof createPrismaClient>>, auth: AuthContext, other: AuthContext, tid: string, contactId: string, initiativeId: string;
const now = new Date("2026-11-02T07:00:00Z"), base = new Date("2026-10-28T07:00:00Z"), current = new Date("2026-11-05T07:00:00Z"), end = new Date("2026-11-09T19:00:00Z");
const later = (d: Date, minutes: number) => new Date(d.getTime() + minutes * 60000);
const code = (value: string | number) => (e: any) => typeof value === "number" ? e.status === value : e.code === value;
async function company(role = "owner") {
  const tenant = await db.tenant.create({ data: { name: "Experiments", slug: randomUUID(), timezone: "Asia/Almaty" } });
  const user = await db.user.create({ data: { email: `${randomUUID()}@example.test`, name: "Руководитель", passwordHash: "unused" } });
  await db.membership.create({ data: { tenantId: tenant.id, userId: user.id, role } });
  return authForUserInTenant(db, user.id, tenant.id);
}
function method(extra: Partial<ExperimentMethod> = {}): ExperimentMethod { return { metric: "proposal_preparation_minutes", baselineFrom: "2026-10-26", baselineTo: "2026-11-01", from: "2026-11-03", to: "2026-11-09", memberIds: [auth.activeMembership!.id], minimumSample: 10, targetReductionPercent: 20, initiativeTaskId: initiativeId, ...extra }; }
function body(extra: Partial<ExperimentMethod> = {}) { return { requestId: randomUUID(), title: "Подготовка КП", hypothesis: "Единая заготовка сократит подготовку КП", change: "Согласовать структуру предложения и обучить команду", method: method(extra) }; }
const create = (extra: Partial<ExperimentMethod> = {}) => saveExperiment(db, auth, null, body(extra), now);
const approve = (g: BusinessExperimentDetail) => operateExperiment(db, auth, g.id, "approve", { requestId: randomUUID(), version: g.version, reviewHash: g.reviewHash }, now);
const result = (g: BusinessExperimentDetail, at = end) => operateExperiment(db, auth, g.id, "result", { requestId: randomUUID(), version: g.version }, at);
async function task(at = base, minutes: number | null = 100, extra: Record<string, any> = {}) {
  const t = await db.task.create({ data: { tenantId: tid, title: "КП клиенту", type: "proposal", contactId, ownerMembershipId: auth.activeMembership!.id, createdAt: at, ...extra } });
  if (minutes !== null) await prepared(t.id, later(at, minutes));
  return t;
}
async function prepared(taskId: string, at: Date, extra: Record<string, any> = {}) { return db.activity.create({ data: { tenantId: tid, contactId, type: "task.prepared", title: "Подготовка отправки", metadataJson: { taskId }, createdAt: at, ...extra } }); }
async function samples(at = base, minutes = 100, count = 10) {
  const ids = Array.from({ length: count }, () => randomUUID());
  await db.task.createMany({ data: ids.map(id => ({ id, tenantId: tid, title: "КП", type: "proposal", contactId, ownerMembershipId: auth.activeMembership!.id, createdAt: at })) });
  await db.activity.createMany({ data: ids.map(id => ({ tenantId: tid, contactId, type: "task.prepared", title: "Подготовка отправки", metadataJson: { taskId: id }, createdAt: later(at, minutes) })) });
  return ids;
}
const measure = (at = end) => measureProposalPreparation(db, tid, [auth.activeMembership!.id], new Date("2026-10-25T19:00:00Z"), new Date("2026-11-01T19:00:00Z"), at);
before(async () => { db = await createPrismaClient(); });
beforeEach(async () => {
  auth = await company(); other = await company(); tid = auth.activeMembership!.tenantId;
  contactId = (await db.contact.create({ data: { tenantId: tid, name: "Клиент" } })).id;
  initiativeId = (await db.task.create({ data: { tenantId: tid, title: "Внедрить заготовку КП", type: "note", status: "done", completedAt: now, createdAt: now, ownerMembershipId: auth.activeMembership!.id } })).id;
});
after(async () => db.$disconnect());

it("measures first valid preparation only, calendar minutes and exact company period boundaries", async () => {
  const t = await task(base, 30); await prepared(t.id, later(base, 40)); await prepared(t.id, later(base, -1));
  const wrongContact = (await db.contact.create({ data: { tenantId: tid, name: "Другой" } })).id;
  await prepared(t.id, later(base, 1), { contactId: wrongContact });
  const foreignContact = (await db.contact.create({ data: { tenantId: other.activeMembership!.tenantId, name: "Другой" } })).id;
  await prepared(t.id, later(base, 2), { tenantId: other.activeMembership!.tenantId, contactId: foreignContact });
  await task(base, 90); await task(new Date("2026-10-25T18:59:59Z"), 1); await task(new Date("2026-11-01T19:00:00Z"), 0);
  const m = await measure(); assert.equal(m.total, 2); assert.equal(m.prepared, 2); assert.equal(m.medianMinutes, 60); assert.equal(m.meanMinutes, 60);
  assert.equal(m.from, "2026-10-25T19:00:00.000Z");
});
it("excludes unrelated, group, child, archived and legacy test-linked work while retaining cancelled unfinished proposals", async () => {
  const legacy = await db.inquiry.create({ data: { tenantId: tid, contactId, source: "manual", test: true } });
  const stage = await db.dealStage.create({ data: { tenantId: tid, name: "Работа", systemKey: "work", sortOrder: 1 } });
  const deal = await db.deal.create({ data: { tenantId: tid, contactId, inquiryId: legacy.id, stageId: stage.id, title: "Тест" } });
  const archived = await db.contact.create({ data: { tenantId: tid, name: "Архив", archivedAt: now } });
  for (const extra of [{ type: "note" }, { inquiryId: legacy.id }, { dealId: deal.id }, { contactId: archived.id }, { targetType: "group" }, { parentTaskId: initiativeId }]) await task(base, null, extra);
  await task(base, null, { status: "canceled" }); await task();
  const m = await measure(); assert.equal(m.total, 2); assert.equal(m.pending, 1); assert.equal(m.prepared, 1);
  const choices = await experimentTaskChoices(db, auth, "Внедрить"); assert.deepEqual(choices.items.map(t => t.id), [initiativeId]);
  assert.equal((await experimentTaskChoices(db, auth, "100%_")).items.length, 0);
});
it("has no fabricated value before start, without activity, or for preparation after the cutoff", async () => {
  const t = await task(base, null); await prepared(t.id, new Date("2026-11-01T19:00:00Z"));
  const m = await measure(); assert.equal(m.medianMinutes, null); assert.equal(m.pending, 1);
  const future = await measureProposalPreparation(db, tid, [auth.activeMembership!.id], current, end, now);
  assert.equal(future.total, 0); assert.equal(future.medianMinutes, null);
  await task(base, 200); const early = await measure(later(base, 10)); assert.equal(early.prepared, 0);
});
it("reads preparation evidence produced by the real task workflow without sending to a customer", async () => {
  const at = new Date(), createdAt = later(at, -20);
  const conversation = await db.conversation.create({ data: { tenantId: tid, contactId, sellerLeadId: randomUUID() } });
  const t = await task(createdAt, null, { conversationId: conversation.id, messageDraft: "Здравствуйте! Вот предложение для обсуждения." });
  await prepareTaskExecution(db, auth, t.id);
  const m = await measureProposalPreparation(db, tid, [auth.activeMembership!.id], later(createdAt, -1), later(at, 60), new Date());
  assert.equal(m.prepared, 1); assert.ok(m.medianMinutes! >= 20 && m.medianMinutes! < 21);
  assert.equal(await db.message.count({ where: { tenantId: tid, direction: "outbound" } }), 0);
});
it("caps large source sets and refuses a partial statistic instead of silently using the first page", async () => {
  await db.task.createMany({ data: Array.from({ length: 2002 }, () => ({ tenantId: tid, title: "КП", type: "proposal", contactId, ownerMembershipId: auth.activeMembership!.id, createdAt: base })) });
  const m = await measure(); assert.equal(m.total, 2001); assert.equal(m.capped, true); assert.equal(m.medianMinutes, null);
});
it("locks approved method, measures a complete prospective sample, retains history and does not change business settings", async () => {
  await samples(); const settings = (await db.tenant.findUniqueOrThrow({ where: { id: tid } })).settingsJson;
  const draft = await create(); assert.equal(draft.state, "draft"); assert.equal(draft.result, null); assert.equal(draft.baseline?.medianMinutes, 100); assert.equal(draft.members[0].name, "Руководитель");
  const running = await approve(draft); assert.equal(running.state, "running");
  await assert.rejects(saveExperiment(db, auth, running.id, { ...body(), version: running.version }, now), code("experiment_locked"));
  await samples(current, 60);
  const interim = await result(running, later(current, 120)); assert.equal(interim.result?.status, "in_progress"); assert.equal(interim.state, "running");
  const final = await result(interim); assert.equal(final.state, "completed"); assert.equal(final.result?.status, "improvement_observed"); assert.equal(final.result?.reductionPercent, 40); assert.equal(final.result?.causal, false);
  assert.equal(final.measurements.length, 2); assert.equal(final.history[0].type, "result");
  assert.deepEqual((await db.tenant.findUniqueOrThrow({ where: { id: tid } })).settingsJson, settings);
  assert.equal(await db.outboxEvent.count({ where: { tenantId: tid } }), 0);
  assert.equal(await db.auditEvent.count({ where: { tenantId: tid, entityType: "business_experiment" } }), 4);
  await assert.rejects(result(final), code("experiment_finished"));
});
it("missing baseline, incomplete cohort and zero baseline cannot yield improvement", async () => {
  let g = await approve(await create()); await samples(current, 20); assert.equal((await result(g)).result?.status, "insufficient_data");
  await samples(base, 0); g = await approve(await create()); const zero = await result(g); assert.equal(zero.result?.status, "insufficient_data"); assert.equal(zero.result?.reductionPercent, null);
  await db.activity.deleteMany({ where: { tenantId: tid } }); await samples(base, 100); await task(current, null, { status: "canceled" });
  g = await approve(await create()); assert.equal((await result(g)).result?.status, "insufficient_data");
});
it("does not round a near miss into success and distinguishes no improvement and altered composition", () => {
  const sample = (value: number, byMember = { a: 10 }): ExperimentSample => ({ total: 10, prepared: 10, pending: 0, medianMinutes: value, meanMinutes: value, capped: false, fingerprint: "x", byMember, from: base.toISOString(), to: now.toISOString(), asOf: now.toISOString() });
  const b = sample(100), c = { ...sample(80.00001), from: current.toISOString() };
  assert.equal(compareExperiment(method({ memberIds: ["a"] }), b, c, end, end, []).status, "no_improvement");
  assert.equal(compareExperiment(method({ memberIds: ["a"] }), b, { ...c, medianMinutes: 80 }, end, end, []).status, "improvement_observed");
  assert.equal(compareExperiment(method({ memberIds: ["a"] }), b, { ...c, byMember: { a: 1 }, medianMinutes: 20 }, end, end, []).status, "conditions_changed");
  assert.equal(compareExperiment(method({ memberIds: ["a"] }), b, { ...c, from: "2026-12-01T00:00:00Z" }, end, end, []).status, "conditions_changed");
});
it("prospective dates, equal periods, tenant-owned members and references are validated", async () => {
  for (const extra of [{ minimumSample: 9 }, { minimumSample: 10.5 }, { targetReductionPercent: 91 }, { baselineTo: "2026-02-31" }, { from: "2026-11-02", to: "2026-11-08" }, { to: "2026-11-10" }, { from: "2027-01-01", to: "2027-01-07" }, { memberIds: [other.activeMembership!.id] }, { memberIds: [auth.activeMembership!.id, auth.activeMembership!.id] }, { initiativeTaskId: randomUUID() }, { metric: "revenue" }]) {
    await assert.rejects(create(extra as Partial<ExperimentMethod>), code(422));
  }
  await assert.rejects(create({ goal: { id: randomUUID(), version: 1 } }), code(409));
  await assert.rejects(create({ decision: { id: randomUUID(), version: 1 } }), code(422));
  assert.equal(await db.businessExperiment.count({ where: { tenantId: tid } }), 0);
});
it("stale baseline review, edited conditions, company timezone and method version require a fresh review", async () => {
  const draft = await create(); await task(); await assert.rejects(approve(draft), code("stale_review"));
  const fresh = await getExperiment(db, auth, draft.id, now); assert.notEqual(fresh.reviewHash, draft.reviewHash);
  const edited = await saveExperiment(db, auth, draft.id, { ...body({ targetReductionPercent: 30 }), version: draft.version }, now);
  await assert.rejects(approve(fresh), code("experiment_changed"));
  await db.tenant.update({ where: { id: tid }, data: { timezone: "UTC" } }); await assert.rejects(approve(edited), code("experiment_method_changed"));
  await db.tenant.update({ where: { id: tid }, data: { timezone: "Asia/Almaty" } });
  await db.businessExperiment.update({ where: { id: draft.id }, data: { methodVersion: "future" } }); await assert.rejects(approve(edited), code("experiment_method_changed"));
});
it("approval and save retries are idempotent, competing drafts cannot overlap the same group", async () => {
  const b = body(), [a, copy] = await Promise.all([saveExperiment(db, auth, null, b, now), saveExperiment(db, auth, null, b, now)]);
  assert.equal(a.id, copy.id); assert.equal(a.history.length, 1);
  await assert.rejects(saveExperiment(db, auth, null, { ...b, title: "Другой текст" }, now), code("request_conflict"));
  const operation = { requestId: randomUUID(), version: a.version, reviewHash: a.reviewHash }, [r1, r2] = await Promise.all([
    operateExperiment(db, auth, a.id, "approve", operation, now), operateExperiment(db, auth, a.id, "approve", operation, now)]);
  assert.equal(r1.version, r2.version); assert.equal(r1.history.length, 2);
  await assert.rejects(approve(await create()), code("experiment_overlap"));
});
it("result retries are idempotent and measurements with identical timestamps retain revision order", async () => {
  await samples(); let g = await approve(await create()); await samples(current, 60);
  const input = { requestId: randomUUID(), version: g.version }; g = await operateExperiment(db, auth, g.id, "result", input, current);
  const repeated = await operateExperiment(db, auth, g.id, "result", input, end); assert.equal(repeated.measurements.length, 1); assert.equal(repeated.state, "running");
  g = await result(g, current); assert.equal(g.measurements.length, 2);
  const ids = await db.experimentMeasurement.findMany({ where: { experimentId: g.id }, orderBy: { revision: "desc" } });
  assert.equal(g.measurements[0].id, ids[0].id); assert.equal(g.history[0].version, g.version);
});
it("records confounding changes and does not turn complete faster data into a causal success", async () => {
  await samples(); let g = await approve(await create()); await samples(current, 60);
  g = await operateExperiment(db, auth, g.id, "note", { requestId: randomUUID(), version: g.version, note: "В периоде изменились цены" }, current);
  assert.equal(g.history[0].note, "В периоде изменились цены");
  await db.tenant.update({ where: { id: tid }, data: { settingsJson: { changed: true } } });
  const final = await result(g); assert.equal(final.result?.status, "conditions_changed"); assert.match(final.result!.reasons.join(" "), /настройки компании.*изменения условий/s);
});
it("retains baseline when old records are archived or corrected after approval", async () => {
  const ids = await samples(); const g = await approve(await create()); await samples(current, 60);
  await db.task.update({ where: { id: ids[0] }, data: { type: "note" } });
  const final = await result(g); assert.equal(final.baseline?.total, 10); assert.equal(final.result?.baseline.total, 10); assert.equal(final.result?.status, "conditions_changed"); assert.match(final.result!.reasons.join(" "), /исходного периода изменились/);
});
it("requires implementation completed in the gap, not a retrospective or unfinished initiative", async () => {
  await samples(); await samples(current, 60);
  for (const completedAt of [null, base, later(current, 60)]) {
    await db.task.update({ where: { id: initiativeId }, data: { completedAt, status: completedAt ? "done" : "open" } });
    const g = await approve(await create()); assert.equal((await result(g)).result?.status, "conditions_changed");
  }
});
it("stopping requires a reason, retains measurements and blocks further results or edits", async () => {
  let g = await approve(await create()); g = await result(g, current);
  await assert.rejects(operateExperiment(db, auth, g.id, "stop", { requestId: randomUUID(), version: g.version }, current), code("experiment_note"));
  g = await operateExperiment(db, auth, g.id, "stop", { requestId: randomUUID(), version: g.version, note: "Отложили внедрение" }, current);
  assert.equal(g.state, "stopped"); assert.equal(g.measurements.length, 1); assert.equal(g.stopReason, "Отложили внедрение");
  await assert.rejects(result(g), code("experiment_finished"));
  assert.equal((await listExperiments(db, auth, { state: "active" })).items.length, 0); assert.equal((await listExperiments(db, auth, { state: "finished" })).items.length, 1);
});
it("rechecks role and active membership, isolates tenants and denies platform configuration sessions", async () => {
  const g = await create(); await assert.rejects(getExperiment(db, other, g.id), code(404));
  await assert.rejects(getExperiment(db, { ...auth, configurationTenant: { id: tid } } as any, g.id), code(403));
  await db.membership.update({ where: { id: auth.activeMembership!.id }, data: { role: "sales_lead" } });
  assert.equal((await getExperiment(db, auth, g.id)).canEdit, false); await assert.rejects(approve(g), code(403));
  await db.membership.update({ where: { id: auth.activeMembership!.id }, data: { role: "manager" } });
  await assert.rejects(experimentOptions(db, auth), code(403)); await assert.rejects(experimentTaskChoices(db, auth, ""), code(403));
  await db.membership.update({ where: { id: auth.activeMembership!.id }, data: { active: false } }); await assert.rejects(listExperiments(db, auth), code(403));
});
it("invalidates results when a linked goal version changes", async () => {
  await samples(); await samples(current, 60);
  const goal = await db.businessGoal.create({ data: { tenantId: tid, title: "Общая цель", metric: "overdue_tasks", ownerMembershipId: auth.activeMembership!.id, periodStart: now, periodEnd: end, timezone: "Asia/Almaty", target: 0 } });
  const g = await approve(await create({ goal: { id: goal.id, version: goal.version } }));
  await db.businessGoal.update({ where: { id: goal.id }, data: { version: { increment: 1 } } });
  assert.equal((await result(g)).result?.status, "conditions_changed");
});
it("never links a private decision into a shared experiment and validates approved public versions", async () => {
  const decision = await db.businessDecision.create({ data: { tenantId: tid, kind: "decision", state: "approved", topic: "КП", topicKey: "кп", title: "Общий шаблон", body: "Использовать согласованную структуру", rationale: "Ускорить подготовку", sourceKind: "manual", sourceFingerprint: "manual-v1", authorUserId: auth.user.id, approvedAt: now, approvedByUserId: auth.user.id, validFrom: base, validUntil: later(end, 60), retentionUntil: later(end, 1440), privateUserId: auth.user.id } });
  await assert.rejects(create({ decision: { id: decision.id, version: decision.version } }), code("experiment_decision"));
  assert.equal((await experimentOptions(db, auth, now)).decisions.length, 0);
  await db.businessDecision.update({ where: { id: decision.id }, data: { privateUserId: null } });
  await samples(); await samples(current, 60);
  const g = await approve(await create({ decision: { id: decision.id, version: decision.version } }));
  await db.businessDecision.update({ where: { id: decision.id }, data: { state: "revoked", version: { increment: 1 } } });
  assert.equal((await result(g)).result?.status, "conditions_changed");
});
it("bounds active work, paginates and returns the initiating user's ActionRun link only", async () => {
  const run = await db.actionRun.create({ data: { tenantId: tid, userId: auth.user.id, initiatorMembershipId: auth.activeMembership!.id, requestId: randomUUID(), requestHash: "test", title: "Внедрение", snapshotJson: {}, expiresAt: end,
    steps: { create: { position: 0, key: "task", kind: "task.create", label: "Внедрение", detail: "Внедрение", inputJson: {}, snapshotJson: {}, status: "succeeded", taskId: initiativeId, finishedAt: now } } } });
  const g = await create(); assert.equal(g.initiative?.runHref, `/control?view=plans&run=${run.id}`);
  const u = await db.user.create({ data: { email: `${randomUUID()}@example.test`, name: "Директор", passwordHash: "unused" } });
  await db.membership.create({ data: { tenantId: tid, userId: u.id, role: "director" } });
  const director = await authForUserInTenant(db, u.id, tid); assert.equal((await getExperiment(db, director, g.id, now)).initiative?.runHref, null);
  for (let i = 0; i < 24; i++) await create();
  await assert.rejects(create(), code("experiment_limit"));
  const first = await listExperiments(db, auth), second = await listExperiments(db, auth, { cursor: first.nextCursor });
  assert.equal(first.items.length, 20); assert.equal(second.items.length, 5); assert.equal(new Set([...first.items, ...second.items].map(g => g.id)).size, 25);
});
it("history failure rolls back state, version and measurement together", async () => {
  const g = await approve(await create());
  await db.$executeRawUnsafe(`CREATE FUNCTION fail_experiment_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type = 'result' THEN RAISE EXCEPTION 'simulated'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe('CREATE TRIGGER fail_experiment_event BEFORE INSERT ON "BusinessExperimentEvent" FOR EACH ROW EXECUTE FUNCTION fail_experiment_event()');
  try { await assert.rejects(result(g)); } finally { await db.$executeRawUnsafe('DROP TRIGGER fail_experiment_event ON "BusinessExperimentEvent"'); await db.$executeRawUnsafe('DROP FUNCTION fail_experiment_event()'); }
  const retained = await getExperiment(db, auth, g.id); assert.equal(retained.state, "running"); assert.equal(retained.version, g.version); assert.equal(retained.measurements.length, 0);
});
it("HTTP requires auth, protects request scope, exposes no-store and supports a stopped lifecycle", async () => {
  const token = await issueSession(db, auth.user.id, "web"), server = createApp(db).listen(0, "127.0.0.1");
  await new Promise<void>(r => server.once("listening", r)); const url = `http://127.0.0.1:${(server.address() as any).port}/api/v1/workspace/experiments`;
  try {
    assert.equal((await fetch(url)).status, 401);
    const headers = { cookie: `crm_session=${token.sessionToken}`, "x-tenant-id": tid, "Content-Type": "application/json" };
    assert.equal((await fetch(`${url}?tenantId=${tid}`, { headers })).status, 422);
    const opts = await fetch(`${url}/options`, { headers }); assert.equal(opts.status, 200); const o = await opts.json() as any;
    const day = (n: number) => { const d = new Date(`${o.today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body({ baselineFrom: day(-7), baselineTo: day(-1), from: day(1), to: day(7) })) });
    assert.equal(r.status, 201); assert.equal(r.headers.get("cache-control"), "no-store"); const g = await r.json() as any;
    assert.equal((await fetch(`${url}/${g.id}`, { headers })).status, 200); assert.equal((await fetch(`${url}/tasks?q=Внедрить`, { headers })).status, 200);
    const stopped = await fetch(`${url}/${g.id}/stop`, { method: "POST", headers, body: JSON.stringify({ requestId: randomUUID(), version: g.version, note: "Проверка HTTP завершена" }) });
    assert.equal(stopped.status, 200); assert.equal((await stopped.json() as any).state, "stopped");
  } finally { await new Promise<void>((r, reject) => server.close(e => e ? reject(e) : r())); }
});
