import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, beforeEach, after, it, mock } from "node:test";
import { createPrismaClient } from "@creolab/db";
import type { BusinessInsightView, ActionRunView } from "@creolab/contracts";
import type { AuthContext } from "./lib/types.ts";
import { authForUserInTenant, issueSession } from "./services/authService.ts";
import { listBusinessInsights, sweepBusinessInsightTenant, refreshBusinessInsights, getBusinessInsight, decideBusinessInsight } from "./services/businessInsightService.ts";
import { previewActionPlan, confirmActionRun, processActionRun, getActionRun, cancelActionRun } from "./services/aiActionService.ts";
import { createApp } from "./app.ts";

let db: Awaited<ReturnType<typeof createPrismaClient>>, auth: AuthContext, other: AuthContext, tid: string, contactId: string, stageId: string;
async function company() {
  const tenant = await db.tenant.create({ data: { name: "Opportunities", slug: randomUUID(), settingsJson: { control: { enabled: true } } } });
  const user = await db.user.create({ data: { email: `${randomUUID()}@example.test`, name: "Руководитель", passwordHash: "unused" } });
  await db.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: "owner" } });
  await db.controlAccess.create({ data: { tenantId: tenant.id, userId: user.id, enabled: true, status: "active", allowedSources: ["CRM_CHAT"], canCreateTasks: true, canReadTeamData: true } });
  return authForUserInTenant(db, user.id, tenant.id);
}
const deal = (extra: Record<string, any> = {}) => db.deal.create({ data: { tenantId: tid, contactId, stageId, title: "Презентация", ...extra } });
const inquiry = (extra: Record<string, any> = {}) => db.inquiry.create({ data: { tenantId: tid, contactId, source: "manual", subject: "Новый проект", ...extra } });
const list = (state = "all") => listBusinessInsights(db, auth, { kind: "opportunity", state });
const scan = () => sweepBusinessInsightTenant(db, tid);
async function itemFor(id: string) { await scan(); return (await list()).items.find(i => i.content?.sources.some(s => s.href.endsWith(id)))!; }
const date = () => new Date(Date.now() + 86400000).toISOString();
function body(item: BusinessInsightView, extra: Record<string, any> = {}, requestId = randomUUID()) {
  return { requestId, title: "Следующий шаг", steps: [{ key: "create", kind: "opportunity.task", insightId: item.id, version: item.version, fingerprint: item.fingerprint,
    ownerMembershipId: auth.activeMembership!.id, dueAt: date(), ...extra }] };
}
const preview = (item: BusinessInsightView, extra: Record<string, any> = {}) => previewActionPlan(db, auth, body(item, extra));
const confirm = (run: ActionRunView) => confirmActionRun(db, auth, run.id, { requestId: randomUUID(), planHash: run.planHash, confirmed: true });
async function requestProposal(dealId: string, extra: Record<string, any> = {}) {
  const conversation = await db.conversation.create({ data: { tenantId: tid, contactId } });
  await db.dealConversation.create({ data: { tenantId: tid, dealId, conversationId: conversation.id } });
  const message = await db.message.create({ data: { tenantId: tid, conversationId: conversation.id, direction: "inbound", senderKind: "client", text: "Пришлите КП, пожалуйста", createdAt: new Date(Date.now() - 60000) } });
  const agreement = await db.agreement.create({ data: { tenantId: tid, dealId, contactId, conversationId: conversation.id, type: "SEND_PROPOSAL", title: "Запрошено предложение", status: "CONFIRMED", confidence: "HIGH", sourceMessageIdsJson: [message.id], ...extra } });
  return { conversation, message, agreement };
}
before(async () => { db = await createPrismaClient(); });
beforeEach(async () => {
  auth = await company(); other = await company(); tid = auth.activeMembership!.tenantId;
  contactId = (await db.contact.create({ data: { tenantId: tid, name: "Алия" } })).id;
  await db.contactMethod.create({ data: { tenantId: tid, contactId, type: "phone", rawValue: "+77010000001", normalizedValue: "+77010000001", primary: true, source: "manual" } });
  stageId = (await db.dealStage.create({ data: { tenantId: tid, name: "Переговоры", systemKey: "negotiation", sortOrder: 5 } })).id;
});
after(async () => db.$disconnect());

it("separates opportunities from risks, deduplicates both inquiry links and keeps separate purchases by one contact", async () => {
  const first = await inquiry(), second = await inquiry(), standalone = await inquiry();
  const a = await deal({ inquiryId: first.id, offerAmountMinor: 999999, currency: "USD" }), b = await deal();
  await db.inquiry.update({ where: { id: second.id }, data: { dealId: b.id } });
  await requestProposal(a.id); await scan();
  const rows = (await list()).items; assert.equal(rows.length, 3);
  const combined = rows.find(r => r.content?.sources[0].href.endsWith(a.id))!;
  assert.deepEqual(combined.content?.opportunity?.reasons, ["proposal_requested", "late_no_step", "unhandled_inquiry"]);
  assert.ok(rows.some(r => r.content?.sources[0].href.endsWith(standalone.id)));
  assert.ok(rows.some(r => r.content?.sources[0].href.endsWith(b.id)));
  assert.ok((await listBusinessInsights(db, auth, { state: "all" })).items.every(r => !r.rule.startsWith("opportunity")));
  assert.ok(combined.content?.facts.some(f => f.value.includes("77010000001")));
  assert.doesNotMatch(JSON.stringify(rows), /999999|"USD"|выручка|потенциал.*999/);
});

it("requests require an active confirmed agreement and a genuine inbound message linked to that deal", async () => {
  await db.dealStage.update({ where: { id: stageId }, data: { systemKey: "need_identified" } });
  const d = await deal(), proof = await requestProposal(d.id, { confidence: "MEDIUM" });
  await scan(); assert.equal((await list()).items.length, 0);
  await db.agreement.update({ where: { id: proof.agreement.id }, data: { confidence: "HIGH", sourceMessageIdsJson: [randomUUID()] } });
  await db.businessInsightScan.update({ where: { tenantId: tid }, data: { nextRunAt: new Date(0) } }); await scan(); assert.equal((await list()).items.length, 0);
  await db.agreement.update({ where: { id: proof.agreement.id }, data: { sourceMessageIdsJson: [proof.message.id] } });
  await db.businessInsightScan.update({ where: { tenantId: tid }, data: { nextRunAt: new Date(0) } }); await scan(); const item = (await list()).items[0]; assert.ok(item);
  await db.message.update({ where: { id: proof.message.id }, data: { internal: true } });
  assert.equal((await getBusinessInsight(db, auth, item.id)).stale, true);
  await refreshBusinessInsights(db, auth, { insightId: item.id }); assert.equal((await getBusinessInsight(db, auth, item.id)).state, "resolved");
});

it("another deal's sent proposal and a failed outbound message cannot fulfil this request", async () => {
  await db.dealStage.update({ where: { id: stageId }, data: { systemKey: "need_identified" } });
  const d = await deal(), otherDeal = await deal(), proof = await requestProposal(d.id);
  const msg = await db.message.create({ data: { tenantId: tid, conversationId: proof.conversation.id, direction: "outbound", senderKind: "manager", text: "КП", operationState: "failed" } });
  const activity = await db.activity.create({ data: { tenantId: tid, contactId, dealId: otherDeal.id, type: "sales.proposal_sent", title: "КП", metadataJson: { sourceMessageId: msg.id } } });
  const item = await itemFor(d.id); assert.ok(item.content?.opportunity?.reasons.includes("proposal_requested"));
  await db.activity.update({ where: { id: activity.id }, data: { dealId: d.id } });
  await refreshBusinessInsights(db, auth, { insightId: item.id }); assert.equal((await getBusinessInsight(db, auth, item.id)).state, "open");
  await db.message.update({ where: { id: msg.id }, data: { operationState: "sent", receiptState: "sent" } });
  await refreshBusinessInsights(db, auth, { insightId: item.id }); assert.equal((await getBusinessInsight(db, auth, item.id)).state, "resolved");
});

it("proposal delivery ledger must accept every part before suppressing a request", async () => {
  await db.dealStage.update({ where: { id: stageId }, data: { systemKey: "need_identified" } });
  const d = await deal(); await requestProposal(d.id); const item = await itemFor(d.id);
  const t = await db.task.create({ data: { tenantId: tid, contactId, dealId: d.id, title: "КП", type: "proposal", status: "done", executionStatus: "sent", sentAt: new Date() } });
  const ledger = await db.idempotencyRecord.create({ data: { scope: "task.delivery", actorKey: tid, key: t.id, requestHash: "x", expiresAt: new Date("9999-01-01"), resultJson: { parts: [{ state: "accepted" }, { state: "failed" }] } } });
  await refreshBusinessInsights(db, auth, { insightId: item.id }); assert.equal((await getBusinessInsight(db, auth, item.id)).state, "open");
  await db.idempotencyRecord.update({ where: { id: ledger.id }, data: { resultJson: { parts: [{ state: "accepted" }, { state: "accepted" }] } } });
  await refreshBusinessInsights(db, auth, { insightId: item.id }); assert.equal((await getBusinessInsight(db, auth, item.id)).state, "resolved");
});

it("test, archived, terminal, early-stage and already planned sources produce no sales opportunity", async () => {
  await inquiry({ test: true }); await inquiry({ archived: true }); await inquiry({ status: "accepted" });
  await deal({ outcome: "won" }); await deal({ outcome: "lost" }); await deal({ nextAction: "Встреча", nextActionAt: new Date(date()) });
  const bad = await inquiry({ test: true }); await deal({ inquiryId: bad.id });
  const earlyStage = await db.dealStage.create({ data: { tenantId: tid, name: "Новая", systemKey: "new", sortOrder: 0 } });
  await deal({ stageId: earlyStage.id }); await scan(); assert.equal((await list()).items.length, 0);
});

it("preview and confirmation create nothing; worker records exactly one task, outcome and action history with exact source links", async () => {
  const i = await inquiry(), d = await deal({ inquiryId: i.id }); await deal({ title: "Другой заказ того же клиента" });
  const item = await itemFor(d.id), input = body(item);
  const [run, replay] = await Promise.all([previewActionPlan(db, auth, input), previewActionPlan(db, auth, input)]); assert.equal(run.id, replay.id);
  assert.equal(run.source, "opportunity"); assert.equal(await db.task.count({ where: { tenantId: tid } }), 0);
  await Promise.all([confirm(run), confirm(run)]); assert.equal(await db.task.count({ where: { tenantId: tid } }), 0);
  const fetcher = mock.method(globalThis, "fetch", async () => { throw new Error("No external sends"); });
  try { await Promise.all([processActionRun(db, tid, run.id), processActionRun(db, tid, run.id)]); assert.equal(fetcher.mock.callCount(), 0); } finally { fetcher.mock.restore(); }
  const done = await getActionRun(db, auth, run.id); assert.equal(done.status, "succeeded");
  const task = await db.task.findUniqueOrThrow({ where: { id: done.steps[0].taskId! } });
  assert.equal(task.contactId, contactId); assert.equal(task.dealId, d.id); assert.equal(task.inquiryId, i.id); assert.equal(task.type, "note");
  assert.equal(task.conversationId, null); assert.equal(task.sentAt, null); assert.equal(task.status, "open");
  const activity = await db.activity.findMany({ where: { tenantId: tid, type: "task.created" } }); assert.equal(activity.length, 1); assert.equal(activity[0].dealId, d.id);
  await refreshBusinessInsights(db, auth, { insightId: item.id }); const detail = await getBusinessInsight(db, auth, item.id);
  assert.equal(detail.action?.taskId, task.id); assert.equal(detail.action?.runId, run.id); assert.equal(detail.action?.outcomeEventId, activity[0].id);
  assert.ok(detail.history.some(h => h.type === "action_task_created"));
  assert.equal(await db.task.count({ where: { tenantId: tid } }), 1);
  assert.equal(await db.message.count({ where: { tenantId: tid } }), 0); assert.equal(await db.paymentRecord.count({ where: { tenantId: tid } }), 0);
  assert.equal(await db.notification.count({ where: { tenantId: tid } }), 0);
});

it("two different plans for overlapping reasons cannot create duplicate tasks", async () => {
  const d = await deal(); await requestProposal(d.id); const item = await itemFor(d.id);
  const [a, b] = await Promise.all([preview(item), preview(item)]); await confirm(a); await confirm(b);
  await Promise.all([processActionRun(db, tid, a.id), processActionRun(db, tid, b.id)]);
  assert.deepEqual([(await getActionRun(db, auth, a.id)).status, (await getActionRun(db, auth, b.id)).status].sort(), ["failed", "succeeded"]);
  assert.equal(await db.task.count({ where: { tenantId: tid } }), 1);
});

it("an employee's new task between preview and confirmation rejects the stale action", async () => {
  const i = await inquiry(), item = await itemFor(i.id), run = await preview(item);
  await db.task.create({ data: { tenantId: tid, contactId, inquiryId: i.id, title: "Уже работаем", type: "note" } });
  assert.equal((await confirm(run)).status, "failed"); assert.equal(await db.task.count({ where: { tenantId: tid } }), 1);
});

it("different employees share the source dedupe lock and can see task outcome without another employee's private plan", async () => {
  const item = await itemFor((await inquiry()).id);
  const user = await db.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "unused", name: "Директор" } });
  const member = await db.membership.create({ data: { tenantId: tid, userId: user.id, role: "director" } });
  await db.controlAccess.create({ data: { tenantId: tid, userId: user.id, enabled: true, status: "active", allowedSources: ["CRM_CHAT"], canCreateTasks: true, canReadTeamData: true } });
  const colleague = await authForUserInTenant(db, user.id, tid);
  const a = await preview(item), b = await previewActionPlan(db, colleague, body(item, { ownerMembershipId: member.id }));
  await confirm(a); await confirmActionRun(db, colleague, b.id, { requestId: randomUUID(), planHash: b.planHash, confirmed: true });
  await processActionRun(db, tid, a.id); await processActionRun(db, tid, b.id);
  assert.equal(await db.task.count({ where: { tenantId: tid } }), 1);
  assert.equal((await getActionRun(db, colleague, b.id)).status, "failed");
  await refreshBusinessInsights(db, auth, { insightId: item.id });
  const shared = await getBusinessInsight(db, colleague, item.id); assert.ok(shared.action?.taskId); assert.equal(shared.action?.runId, null);
  await assert.rejects(getActionRun(db, colleague, a.id), (e: any) => e.status === 404);
});

it("an inquiry task inherited by its deal is offered instead of a duplicate, but another purchase's task is not", async () => {
  const i = await inquiry(), d = await deal({ inquiryId: i.id }), second = await deal();
  const t = await db.task.create({ data: { tenantId: tid, inquiryId: i.id, contactId, title: "Первичная обработка", type: "note" } });
  await scan(); const rows = (await list()).items, first = rows.find(r => r.content?.sources[0].href.endsWith(d.id))!, next = rows.find(r => r.content?.sources[0].href.endsWith(second.id))!;
  assert.equal(first.content?.opportunity?.existingTask?.id, t.id); assert.equal(next.content?.opportunity?.existingTask, null);
  await assert.rejects(preview(first), (e: any) => e.code === "opportunity_task_exists"); assert.ok(await preview(next));
});

it("source closure after confirmation and access revocation stop the worker before writing", async () => {
  const d = await deal(), item = await itemFor(d.id), run = await preview(item); await confirm(run);
  await db.deal.update({ where: { id: d.id }, data: { outcome: "won" } }); await processActionRun(db, tid, run.id);
  assert.equal((await getActionRun(db, auth, run.id)).status, "failed"); assert.equal(await db.task.count({ where: { tenantId: tid } }), 0);
  const i = await inquiry(); await db.businessInsightScan.update({ where: { tenantId: tid }, data: { nextRunAt: new Date(0) } });
  const second = await preview(await itemFor(i.id)); await confirm(second);
  await db.controlAccess.updateMany({ where: { tenantId: tid, userId: auth.user.id }, data: { canCreateTasks: false } }); await processActionRun(db, tid, second.id);
  assert.equal((await getActionRun(db, auth, second.id)).status, "failed"); assert.equal(await db.task.count({ where: { tenantId: tid } }), 0);
});

it("roles, tenant, hidden state, stale fingerprints, missing deadlines and cancellation are enforced", async () => {
  const item = await itemFor((await inquiry()).id);
  await assert.rejects(previewActionPlan(db, other, body(item)), (e: any) => e.status === 404);
  await assert.rejects(preview(item, { ownerMembershipId: other.activeMembership!.id }), (e: any) => e.status === 409);
  await assert.rejects(preview(item, { fingerprint: "a".repeat(64) }), (e: any) => e.code === "insight_stale");
  await assert.rejects(preview(item, { dueAt: new Date(0).toISOString() }), (e: any) => e.status === 422);
  const run = await preview(item); await cancelActionRun(db, auth, run.id, { requestId: randomUUID() }); await confirm(run); await processActionRun(db, tid, run.id);
  assert.equal(await db.task.count({ where: { tenantId: tid } }), 0);
  const dismissed = await decideBusinessInsight(db, auth, item.id, "dismiss", { version: item.version, fingerprint: item.fingerprint, requestId: randomUUID() });
  await assert.rejects(preview(dismissed), (e: any) => e.code === "insight_stale");
  await db.membership.update({ where: { id: auth.activeMembership!.id }, data: { role: "manager" } });
  await assert.rejects(list(), (e: any) => e.status === 403); await assert.rejects(preview(item), (e: any) => e.status === 403);
});

it("a deleted or archived contact hides evidence and cannot be used for a prepared action", async () => {
  const item = await itemFor((await inquiry()).id), run = await preview(item);
  await db.contact.update({ where: { id: contactId }, data: { archivedAt: new Date() } });
  const detail = await getBusinessInsight(db, auth, item.id); assert.equal(detail.content, null); assert.equal(detail.stale, true);
  assert.equal((await confirm(run)).status, "failed"); assert.equal(await db.task.count({ where: { tenantId: tid } }), 0);
});

it("transaction failure rolls back task, activity and insight link together and retries safely", async () => {
  const item = await itemFor((await inquiry()).id), run = await preview(item); await confirm(run);
  const wrapped = new Proxy(db, { get(client: any, key) {
    if (key !== "$transaction") return client[key];
    return (fn: any, options: any) => db.$transaction(tx => fn(new Proxy(tx, { get(t: any, field) {
      if (field !== "businessInsightEvent") return t[field];
      return new Proxy(t[field], { get(delegate, method) { return method === "create" ? async (input: any) => { if (input.data.type === "action_task_created") throw new Error("Transient DB error"); return delegate.create(input); } : delegate[method]; } });
    } })), options);
  } });
  await assert.rejects(processActionRun(wrapped, tid, run.id), /Transient DB error/);
  assert.equal(await db.task.count({ where: { tenantId: tid } }), 0); assert.equal(await db.activity.count({ where: { tenantId: tid, type: "task.created" } }), 0);
  assert.equal((await db.businessInsight.findUniqueOrThrow({ where: { id: item.id } })).actionRunId, null);
  await processActionRun(db, tid, run.id); assert.equal((await getActionRun(db, auth, run.id)).status, "succeeded");
  assert.equal(await db.task.count({ where: { tenantId: tid } }), 1);
});

it("created tasks are tracked by their actual status; cancellation does not silently create a replacement", async () => {
  const item = await itemFor((await inquiry()).id), run = await preview(item); await confirm(run); await processActionRun(db, tid, run.id);
  const taskId = (await getActionRun(db, auth, run.id)).steps[0].taskId!;
  await db.task.update({ where: { id: taskId }, data: { status: "canceled" } });
  await refreshBusinessInsights(db, auth, { insightId: item.id }); const refreshed = await getBusinessInsight(db, auth, item.id);
  assert.equal(refreshed.action?.taskStatus, "canceled"); await assert.rejects(preview(refreshed), (e: any) => e.code === "opportunity_action_exists");
});

it("HTTP exposes the opportunity filter with no-store and refuses injected scopes or unknown kinds", async () => {
  const item = await itemFor((await inquiry()).id);
  const token = await issueSession(db, auth.user.id, "web"), server = createApp(db).listen(0, "127.0.0.1");
  await new Promise<void>(r => server.once("listening", r)); const url = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const headers = { cookie: `crm_session=${token.sessionToken}`, "x-tenant-id": tid, "Content-Type": "application/json" };
    const response = await fetch(`${url}/api/v1/workspace/intelligence?kind=opportunity`, { headers }); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json() as any).items.length, 1);
    assert.equal((await fetch(`${url}/api/v1/workspace/intelligence?kind=opportunity&tenantId=${tid}`, { headers })).status, 422);
    assert.equal((await fetch(`${url}/api/v1/workspace/intelligence?kind=guaranteed_profit`, { headers })).status, 422);
    const prepared = await fetch(`${url}/api/v1/workspace/ai-actions`, { method: "POST", headers, body: JSON.stringify(body(item)) });
    assert.equal(prepared.status, 201); const run = await prepared.json() as ActionRunView;
    assert.equal(await db.task.count({ where: { tenantId: tid } }), 0);
    const confirmation = await fetch(`${url}/api/v1/workspace/ai-actions/${run.id}/confirm`, { method: "POST", headers, body: JSON.stringify({ requestId: randomUUID(), confirmed: true, planHash: run.planHash }) });
    assert.equal(confirmation.status, 200); assert.equal((await confirmation.json() as ActionRunView).status, "queued");
    await processActionRun(db, tid, run.id);
    const result = await fetch(`${url}/api/v1/workspace/ai-actions/${run.id}`, { headers }); const done = await result.json() as ActionRunView;
    assert.equal(done.status, "succeeded"); assert.ok(done.steps[0].taskId);
    const refreshed = await fetch(`${url}/api/v1/workspace/intelligence/refresh`, { method: "POST", headers, body: JSON.stringify({ insightId: item.id }) }); assert.equal(refreshed.status, 200);
    const detail = await fetch(`${url}/api/v1/workspace/intelligence/${item.id}`, { headers }); assert.equal((await detail.json() as any).action.taskId, done.steps[0].taskId);
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});
