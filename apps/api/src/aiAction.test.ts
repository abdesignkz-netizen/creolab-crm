import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, it, mock } from "node:test";
import { createPrismaClient } from "@creolab/db";
import type { ActionInput, ActionRunView } from "@creolab/contracts";
import type { AuthContext } from "./lib/types.ts";
import { authForUserInTenant, issueSession } from "./services/authService.ts";
import { previewActionPlan, confirmActionRun, cancelActionRun, getActionRun, listActionRuns, processActionStep, processActionRun } from "./services/aiActionService.ts";
import { processOutbox } from "./services/backgroundJobs.ts";
import { updateTaskManually } from "./services/taskManualEdit.ts";
import { saveTaskDelivery } from "./services/taskDeliveryState.ts";
import { createApp } from "./app.ts";

let db: Awaited<ReturnType<typeof createPrismaClient>>, auth: AuthContext, other: AuthContext, tid: string;
async function fixture() {
  const tenant = await db.tenant.create({ data: { name: "Action fixture", slug: randomUUID(), settingsJson: { control: { enabled: true } } } });
  const user = await db.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "unused", name: "Инициатор" } });
  await db.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: "owner" } });
  await db.controlAccess.create({ data: { tenantId: tenant.id, userId: user.id, enabled: true, status: "active", allowedSources: ["CRM_CHAT"], canCreateTasks: true, canReadTeamData: true } });
  return authForUserInTenant(db, user.id, tenant.id);
}
async function employee(role = "manager") {
  const user = await db.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "unused", name: "Исполнитель" } });
  return db.membership.create({ data: { tenantId: tid, userId: user.id, role } });
}
async function task() {
  return db.task.create({ data: { tenantId: tid, type: "message", title: "Предложение", ownerMembershipId: auth.activeMembership!.id } });
}
const create = (): ActionInput => ({ key: "create", kind: "task.create", type: "message", title: "Подготовить предложение" });
const draft = (): ActionInput => ({ key: "draft", kind: "task.draft", target: { fromStep: "create" }, text: "Согласованный текст для проверки" });
const preview = (steps: ActionInput[] = [create(), draft()], requestId = randomUUID()) => previewActionPlan(db, auth, { requestId, title: "Предложение клиенту", steps });
const confirm = (run: ActionRunView, requestId = randomUUID()) => confirmActionRun(db, auth, run.id, { requestId, confirmed: true, planHash: run.planHash });
before(async () => { db = await createPrismaClient(); });
beforeEach(async () => { auth = await fixture(); other = await fixture(); tid = auth.activeMembership!.tenantId; });
afterEach(() => mock.restoreAll());
after(async () => { await db.$disconnect(); });

it("preview changes no tasks; duplicate preview and concurrent confirmation execute exactly once", async () => {
  const member = await employee(), requestId = randomUUID();
  const steps: ActionInput[] = [create(), { key: "assign", kind: "task.assign", target: { fromStep: "create" }, membershipId: member.id }, draft(),
    { key: "notify", kind: "staff.notify", target: { fromStep: "create" }, membershipId: member.id, text: "Проверьте черновик" }];
  await db.notificationPreference.create({ data: { tenantId: tid, membershipId: member.id, channelsJson: { in_app: true, telegram: true, web_push: true } } });
  const [run, duplicate] = await Promise.all([preview(steps, requestId), preview(steps, requestId)]);
  assert.equal(run.id, duplicate.id); assert.equal(run.steps.length, 4);
  assert.equal(await db.task.count({ where: { tenantId: tid } }), 0);
  assert.equal(await db.outboxEvent.count({ where: { tenantId: tid } }), 0);
  const confirmationId = randomUUID();
  await Promise.all([confirm(run, confirmationId), confirm(run, confirmationId)]);
  assert.equal(await db.outboxEvent.count({ where: { tenantId: tid, type: "ai.action_run" } }), 1);
  const fetcher = mock.method(globalThis, "fetch", async () => { throw new Error("External send forbidden"); });
  await Promise.all([processActionRun(db, tid, run.id), processActionRun(db, tid, run.id)]);
  const result = await getActionRun(db, auth, run.id), taskId = result.steps[0].taskId!;
  assert.equal(result.status, "succeeded"); assert.equal(result.completed, 4);
  const saved = await db.task.findUniqueOrThrow({ where: { id: taskId } });
  assert.equal(saved.ownerMembershipId, member.id); assert.equal(saved.messageDraft, (draft() as any).text); assert.equal(saved.sentAt, null); assert.equal(saved.confirmedAt, null);
  assert.equal(await db.task.count({ where: { tenantId: tid } }), 1);
  assert.equal(await db.notification.count({ where: { tenantId: tid } }), 1);
  const deliveries = await db.notificationDelivery.findMany({ where: { tenantId: tid } });
  assert.deepEqual(deliveries.map(d => [d.channel, d.state]), [["in_app", "delivered"]]);
  assert.equal(await db.controlNotificationItem.count({ where: { rule: { tenantId: tid } } }), 0);
  assert.equal(fetcher.mock.callCount(), 0);
  assert.equal(await db.auditEvent.count({ where: { tenantId: tid, action: "task.created", entityId: taskId } }), 1);
  assert.equal(await db.auditEvent.count({ where: { tenantId: tid, action: "action.step_completed", correlationId: run.id } }), 4);
  await confirm(run); await processOutbox(db); // replay root event after all steps committed
  assert.equal(await db.task.count({ where: { tenantId: tid } }), 1);
  const stored = await db.actionRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.ok((await db.outboxEvent.findUniqueOrThrow({ where: { id: stored.outboxId! } })).processedAt);
});

it("restart after a committed step resumes only the remaining steps", async () => {
  const run = await preview(); await confirm(run);
  assert.equal(await processActionStep(db, tid, run.id), true);
  const first = await getActionRun(db, auth, run.id); assert.equal(first.completed, 1); assert.equal(first.status, "running");
  // New invocation has no memory of the prior worker, only persisted state.
  await processActionRun(db, tid, run.id); await processActionRun(db, tid, run.id);
  assert.equal((await getActionRun(db, auth, run.id)).status, "succeeded");
  assert.equal(await db.task.count({ where: { tenantId: tid } }), 1);
});

it("second step failure preserves the first step and rolls back all rejected step effects", async () => {
  const member = await employee("director");
  const run = await preview([create(), { key: "notify", kind: "staff.notify", target: { fromStep: "create" }, membershipId: member.id, text: "Уведомление" }, draft()]);
  await confirm(run); await processActionStep(db, tid, run.id);
  await db.notificationPreference.create({ data: { tenantId: tid, membershipId: member.id, channelsJson: { in_app: false, telegram: true } } });
  await processActionRun(db, tid, run.id);
  const result = await getActionRun(db, auth, run.id);
  assert.equal(result.status, "failed"); assert.equal(result.completed, 1);
  assert.deepEqual(result.steps.map(s => s.status), ["succeeded", "failed", "skipped"]);
  assert.equal(await db.notification.count({ where: { tenantId: tid } }), 0, "notification written before preference rejection must roll back");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: result.steps[0].taskId! } })).messageDraft, null);
  await confirm(run); await processActionRun(db, tid, run.id);
  assert.equal(await db.task.count({ where: { tenantId: tid } }), 1);
});

it("cancellation between steps preserves completed work and prevents future writes", async () => {
  const run = await preview(); await confirm(run); await processActionStep(db, tid, run.id);
  const input = { requestId: randomUUID() };
  const canceled = await cancelActionRun(db, auth, run.id, input);
  assert.equal(canceled.completed, 1); assert.equal(canceled.status, "cancelled");
  assert.equal((await cancelActionRun(db, auth, run.id, input)).status, "cancelled");
  await processActionRun(db, tid, run.id);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: canceled.steps[0].taskId! } })).messageDraft, null);
  const fresh = await preview([create()]); await cancelActionRun(db, auth, fresh.id, { requestId: randomUUID() }); await confirm(fresh);
  assert.equal((await getActionRun(db, auth, fresh.id)).status, "cancelled");
});

it("a changed task owner before confirmation rejects the stale plan", async () => {
  const t = await task(), member = await employee();
  const run = await preview([{ key: "draft", kind: "task.draft", target: { taskId: t.id }, text: "Old preview" }]);
  await updateTaskManually(db, tid, t.id, { ownerMembershipId: member.id });
  assert.equal((await confirm(run)).status, "failed");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: t.id } })).messageDraft, null);
  assert.equal(await db.outboxEvent.count({ where: { tenantId: tid } }), 0);
});

it("cancellation racing a committing step stops the following step", async () => {
  const run = await preview(); await confirm(run);
  let reached!: () => void, release!: () => void;
  const atWrite = new Promise<void>(r => { reached = r; }), proceed = new Promise<void>(r => { release = r; });
  const delayedDb = new Proxy(db, { get(client, method) {
    if (method !== "$transaction") return client[method as keyof typeof client];
    return (fn: any, options: any) => db.$transaction(tx => fn(new Proxy(tx, { get(transaction: any, field) {
      if (field !== "actionStep") return transaction[field];
      return new Proxy(transaction.actionStep, { get(delegate, action) {
        if (action !== "update") return delegate[action];
        return async (args: any) => { reached(); await proceed; return delegate.update(args); };
      } });
    } })), options);
  } });
  const executing = processActionStep(delayedDb, tid, run.id);
  await atWrite;
  const canceling = cancelActionRun(db, auth, run.id, { requestId: randomUUID() });
  release();
  await Promise.all([executing, canceling]);
  await processActionRun(db, tid, run.id);
  const result = await getActionRun(db, auth, run.id);
  assert.equal(result.status, "cancelled"); assert.equal(result.completed, 1);
  assert.equal(result.steps[1].status, "skipped");
});

it("manual edits after a plan's first step are not overwritten by subsequent steps", async () => {
  const run = await preview(); await confirm(run); await processActionStep(db, tid, run.id);
  const taskId = (await getActionRun(db, auth, run.id)).steps[0].taskId!;
  await updateTaskManually(db, tid, taskId, { messageDraft: "Исправлено сотрудником" });
  await processActionRun(db, tid, run.id);
  assert.equal((await getActionRun(db, auth, run.id)).status, "failed");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: taskId } })).messageDraft, "Исправлено сотрудником");
});

it("fresh permissions and company pause are enforced before each step", async () => {
  for (const change of ["role", "control", "pause", "feature", "inactive"]) {
    const run = await preview(); await confirm(run); await processActionStep(db, tid, run.id);
    if (change === "role") await db.membership.update({ where: { id: auth.activeMembership!.id }, data: { role: "manager" } });
    if (change === "control") await db.controlAccess.updateMany({ where: { tenantId: tid }, data: { canCreateTasks: false } });
    if (change === "pause") await db.tenant.update({ where: { id: tid }, data: { settingsJson: { control: { enabled: true }, runtime: { aiPaused: true } } } });
    if (change === "feature") await db.tenantBillingOverride.create({ data: { tenantId: tid, featuresJson: { TASKS: false } } });
    if (change === "inactive") await db.membership.update({ where: { id: auth.activeMembership!.id }, data: { active: false } });
    await processActionRun(db, tid, run.id);
    const stored = await db.actionRun.findUniqueOrThrow({ where: { id: run.id }, include: { steps: true } });
    assert.equal(stored.status, "failed", change); assert.equal(stored.steps.filter(s => s.status === "succeeded").length, 1);
    await db.membership.update({ where: { id: auth.activeMembership!.id }, data: { role: "owner", active: true } });
    await db.controlAccess.updateMany({ where: { tenantId: tid }, data: { canCreateTasks: true } });
    await db.tenant.update({ where: { id: tid }, data: { settingsJson: { control: { enabled: true } } } });
    await db.tenantBillingOverride.deleteMany({ where: { tenantId: tid } });
  }
});

it("employee or tenant substitution and unpermitted individual capabilities fail closed", async () => {
  const foreignMember = other.activeMembership!.id;
  await assert.rejects(preview([{ ...create(), ownerMembershipId: foreignMember } as ActionInput]));
  const member = await employee(), t = await task();
  await assert.rejects(preview([{ key: "notify", kind: "staff.notify", target: { taskId: t.id }, membershipId: member.id, text: "Not your task" }]));
  const run = await preview();
  await assert.rejects(getActionRun(db, other, run.id), (e: any) => e.status === 404);
  await assert.rejects(confirmActionRun(db, other, run.id, { requestId: randomUUID(), confirmed: true, planHash: run.planHash }), (e: any) => e.status === 404);
  await assert.rejects(cancelActionRun(db, other, run.id, { requestId: randomUUID() }), (e: any) => e.status === 404);
  assert.equal((await listActionRuns(db, other)).total, 0);
  await db.controlAccess.updateMany({ where: { tenantId: tid }, data: { allowedActions: ["CREATE_TASK"] } });
  await assert.rejects(preview([create(), draft()]), (e: any) => e.status === 403);
});

it("assignee changes after review and confirmation expiry prevent execution", async () => {
  const member = await employee();
  const run = await preview([{ ...create(), ownerMembershipId: member.id } as ActionInput]);
  await db.membership.update({ where: { id: member.id }, data: { active: false } });
  assert.equal((await confirm(run)).status, "failed");
  const expired = await preview();
  await db.actionRun.update({ where: { id: expired.id }, data: { expiresAt: new Date(0) } });
  assert.equal((await confirm(expired)).status, "expired");
  const queued = await preview(); await confirm(queued);
  await db.actionRun.update({ where: { id: queued.id }, data: { confirmedAt: new Date(0) } });
  await processActionRun(db, tid, queued.id);
  assert.equal((await getActionRun(db, auth, queued.id)).status, "expired");
  assert.equal(await db.task.count({ where: { tenantId: tid } }), 0);
});

it("idempotency key conflicts, wrong plan hash, cycles and unsupported/external actions are rejected", async () => {
  const key = randomUUID(), run = await preview([create()], key);
  await assert.rejects(preview([create(), draft()], key), (e: any) => e.code === "idempotency_conflict");
  await assert.rejects(confirmActionRun(db, auth, run.id, { requestId: randomUUID(), confirmed: true, planHash: "0".repeat(64) }));
  await assert.rejects(confirmActionRun(db, auth, run.id, { requestId: randomUUID(), confirmed: false, planHash: run.planHash }));
  for (const kind of ["channel.send", "payment.create", "role.change", "task.delete"]) await assert.rejects(previewActionPlan(db, auth, { requestId: randomUUID(), title: "Denied", steps: [{ key: "x", kind }] }));
  await assert.rejects(preview([draft(), create()]));
  await assert.rejects(preview([create(), { ...create(), key: "second" }]));
  const firstTask = await task(), secondTask = await task();
  await assert.rejects(preview([
    { key: "draft", kind: "task.draft", target: { taskId: firstTask.id }, text: "First" },
    { key: "another", kind: "task.draft", target: { taskId: secondTask.id }, text: "Second" },
  ]), /одной задачей/);
  await assert.rejects(preview([create(), { key: "another", kind: "task.draft", target: { taskId: firstTask.id }, text: "Second" }]), /одной задачей/);
  await assert.rejects(previewActionPlan(db, auth, { requestId: randomUUID(), title: "Denied", steps: [{ ...create(), executorKind: "ai" }] }));
  const confirmId = randomUUID(), second = await preview([create()]);
  const results = await Promise.allSettled([confirm(run, confirmId), confirm(second, confirmId)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(await db.outboxEvent.count({ where: { tenantId: tid } }), 1);
});

it("draft-only plans cannot resume a scheduled or ambiguous external send", async () => {
  const t = await task();
  const step: ActionInput = { key: "draft", kind: "task.draft", target: { taskId: t.id }, text: "Do not send" };
  await db.scheduledAction.create({ data: { tenantId: tid, type: "task_run", parentType: "task", parentId: t.id, dueAt: new Date(Date.now() + 60_000), payloadJson: {} } });
  await assert.rejects(preview([step]), /запланировано/);
  await db.scheduledAction.deleteMany({ where: { tenantId: tid } });
  await saveTaskDelivery(db, tid, t.id, { version: 1, confirmationId: randomUUID(), contentHash: "old", conversationId: randomUUID(), sellerLeadId: "old",
    claim: null, leaseUntil: null, parts: [{ id: "text", state: "unknown", attempt: 1 }] });
  await assert.rejects(preview([step]), /Отправка не подтверждена/);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: t.id } })).messageDraft, null);
});

it("transient failure rolls the whole step back; worker retry persists one task", async () => {
  const run = await preview(); await confirm(run);
  const original = db.$transaction.bind(db);
  let injected = true;
  const faultDb = new Proxy(db, { get(client, method) {
    if (method !== "$transaction") return client[method as keyof typeof client];
    return async (fn: any, options: any) => original(async (tx: any) => fn(new Proxy(tx, {
    get(target, key) {
      if (key === "actionStep" && injected) return new Proxy(target.actionStep, { get(delegate, method) {
        if (method === "update") return async () => { injected = false; throw new Error("simulated crash after domain write"); };
        return delegate[method];
      } });
      return target[key];
    },
  })), options);
  } });
  await assert.rejects(processActionStep(faultDb, tid, run.id), /simulated crash/);
  assert.equal(await db.task.count({ where: { tenantId: tid } }), 0);
  assert.equal((await getActionRun(db, auth, run.id)).completed, 0);
  mock.restoreAll(); await processOutbox(db);
  assert.equal((await getActionRun(db, auth, run.id)).status, "succeeded");
  assert.equal(await db.task.count({ where: { tenantId: tid } }), 1);
});

it("worker retry exhaustion leaves a visible partial result, never a false queued success", async () => {
  mock.method(console, "error", () => {});
  const run = await preview(); await confirm(run); await processActionStep(db, tid, run.id);
  const stored = await db.actionRun.findUniqueOrThrow({ where: { id: run.id } });
  await db.outboxEvent.update({ where: { id: stored.outboxId! }, data: { retryAttempts: 8 } });
  await processOutbox(db);
  const result = await getActionRun(db, auth, run.id);
  assert.equal(result.status, "failed"); assert.equal(result.completed, 1);
  assert.ok((await db.outboxEvent.findUniqueOrThrow({ where: { id: stored.outboxId! } })).failedAt);
});

it("HTTP routes expose plans/options, enforce authentication and retain task history", async () => {
  const session = await issueSession(db, auth.user.id);
  const server = createApp(db).listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/v1/workspace/ai-actions`;
  try {
    assert.equal((await fetch(base)).status, 401);
    const headers = { "Content-Type": "application/json", cookie: `crm_session=${session.sessionToken}`, "x-tenant-id": tid };
    const response = await fetch(base, { method: "POST", headers, body: JSON.stringify({ requestId: randomUUID(), title: "План через API", steps: [create(), draft()] }) });
    assert.equal(response.status, 201, await response.clone().text());
    const run = await response.json() as ActionRunView;
    assert.equal((await fetch(`${base}/options`, { headers })).status, 200);
    assert.equal((await fetch(`${base}/options?kind=contact&q=123`, { headers })).status, 200);
    assert.equal((await fetch(`${base}/options?kind=task`, { headers })).status, 200);
    const confirmed = await fetch(`${base}/${run.id}/confirm`, { method: "POST", headers, body: JSON.stringify({ requestId: randomUUID(), confirmed: true, planHash: run.planHash }) });
    assert.equal(confirmed.status, 200); await processOutbox(db);
    const get = await fetch(`${base}/${run.id}`, { headers }); assert.equal(get.headers.get("cache-control"), "no-store");
    assert.equal((await get.json() as ActionRunView).status, "succeeded");
    assert.equal((await fetch(base, { headers })).status, 200);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
