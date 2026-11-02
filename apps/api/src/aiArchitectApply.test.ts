import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, beforeEach, after, afterEach, it, mock } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { architectAnswersSchema, type ArchitectAnswers } from "@creolab/contracts";
import { previewArchitect, saveArchitectDraft, getArchitectState } from "./services/aiArchitectService.ts";
import { reviewArchitectApplication, applyArchitect } from "./services/aiArchitectApplyService.ts";
import { processActionRun, getActionRun, cancelActionRun, confirmActionRun, previewActionPlan, listActionRuns } from "./services/aiActionService.ts";
import { authForUserInTenant, issueSession } from "./services/authService.ts";
import { parseAIAutomationSettings } from "./services/aiAutomationSettings.ts";
import { updateAIAutomationSettings } from "./services/aiAutomationSettingsService.ts";
import { ApiError } from "./errors.ts";
import type { AuthContext } from "./lib/types.ts";
import { createApp } from "./app.ts";
import { processOutbox } from "./services/backgroundJobs.ts";

let db: Awaited<ReturnType<typeof createPrismaClient>>, auth: AuthContext, other: AuthContext, tid: string;
async function company() {
  const tenant = await db.tenant.create({ data: { name: "Architect application", slug: randomUUID(), timezone: "Asia/Almaty", settingsJson: { unrelated: { retain: true }, aiAutomation: { defaultMode: "MANUAL", integrationModes: { existing: "ASSIST" } } } } });
  const user = await db.user.create({ data: { email: `${randomUUID()}@example.test`, name: "Владелец", passwordHash: "unused" } });
  await db.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: "owner" } });
  return authForUserInTenant(db, user.id, tenant.id);
}
function answers(overrides: Partial<ArchitectAnswers> = {}) {
  return architectAnswersSchema.parse({ businessKind: "services", description: "Разрабатываем презентации для компаний", offerings: "Презентации и дизайн", audience: "Компании Казахстана", goal: "sales", channels: ["whatsapp"],
    replyMode: "assist", replyAudience: "new", hours: { mode: "schedule", days: [1, 3, 5], start: "10:30", end: "19:15" }, firstResponseMinutes: 30, responsibleMembershipId: auth.activeMembership!.id, ...overrides });
}
async function project(a = answers(), revision = 0) {
  const p = await previewArchitect(db, auth, { answers: a });
  return saveArchitectDraft(db, auth, { answers: a, revision, requestId: randomUUID(), baseRevision: p.baseRevision, previewHash: p.previewHash });
}
async function prepared(a = answers()) {
  const draft = await project(a), review = await reviewArchitectApplication(db, auth, draft.id, { revision: draft.revision });
  return { draft, review, body: { revision: draft.revision, confirmed: true as const, applicationHash: review.applicationHash, requestId: randomUUID() } };
}
async function localState() {
  return {
    tenant: await db.tenant.findUniqueOrThrow({ where: { id: tid } }), stages: await db.dealStage.findMany({ where: { tenantId: tid } }),
    ai: await db.aIConfiguration.findMany({ where: { tenantId: tid } }), knowledge: await db.knowledgeDocument.findMany({ where: { tenantId: tid } }),
    members: await db.membership.findMany({ where: { tenantId: tid } }), integrations: await db.integration.findMany({ where: { tenantId: tid } }),
    tasks: await db.task.count({ where: { tenantId: tid } }), messages: await db.message.count({ where: { tenantId: tid } }),
    notices: await db.notification.count({ where: { tenantId: tid } }), usage: await db.aIUsageEvent.count({ where: { tenantId: tid } }),
  };
}
const rejection = (code: string) => (e: any) => e.code === code;
before(async () => { db = await createPrismaClient(); });
beforeEach(async () => { auth = await company(); other = await company(); tid = auth.activeMembership!.tenantId; });
afterEach(() => mock.restoreAll());
after(async () => db.$disconnect());

it("reviews exact local changes without writing, confirms once and atomically applies without live activation or external calls", async () => {
  const before = await localState(), p = await prepared();
  assert.equal(p.review.canApply, true); assert.deepEqual(p.review.changes.map(c => c.key), ["pipeline", "ai_draft", "reply_rules", "onboarding"]);
  assert.ok(p.review.pending.some(item => item.to.includes("integrations"))); assert.ok(p.review.pending.some(item => item.to.includes("ai-manager")));
  assert.deepEqual(await localState(), before);
  const [run, duplicate] = await Promise.all([applyArchitect(db, auth, p.draft.id, p.body), applyArchitect(db, auth, p.draft.id, p.body)]);
  assert.equal(run.status, "queued"); assert.equal(run.source, "architect"); assert.equal(duplicate.id, run.id);
  assert.deepEqual(await localState(), before, "confirmation only queues execution");
  assert.equal((await applyArchitect(db, auth, p.draft.id, { ...p.body, requestId: randomUUID() })).id, run.id);
  const fetcher = mock.method(globalThis, "fetch", async () => { throw new Error("External operations forbidden"); });
  await Promise.all([processActionRun(db, tid, run.id), processActionRun(db, tid, run.id)]);
  const done = await getActionRun(db, auth, run.id); assert.equal(done.status, "succeeded", done.error || ""); assert.equal(done.completed, 4);
  const state = await localState(), config = state.ai[0], automation = parseAIAutomationSettings(state.tenant.settingsJson);
  assert.equal(state.stages.length, 7); assert.equal(config.enabled, false); assert.equal(config.systemPrompt, null); assert.equal(config.draftPrompt, null); assert.equal(config.promptStatus, "draft");
  assert.equal((config.limitsJson as any).aiSetup.draft.company.description, p.draft.answers.description);
  assert.equal((config.limitsJson as any).aiSetup.draft.primaryRole, "sales"); assert.equal((config.limitsJson as any).aiSetup.publishedAt, null);
  assert.equal(automation.defaultMode, "MANUAL"); assert.equal(automation.replyAudience.audience, "new"); assert.ok(automation.replyAudience.since);
  assert.equal(automation.firstContactSlaMinutes, 30); assert.equal(automation.conversationHours.mode, "schedule"); assert.equal(automation.conversationHours.days[2].enabled, false);
  assert.deepEqual(state.tenant.workingHoursJson, { days: [1, 3, 5], start: "10:30", end: "19:15" });
  assert.deepEqual((state.tenant.settingsJson as any).unrelated, { retain: true }); assert.deepEqual((state.tenant.settingsJson as any).aiAutomation.integrationModes, { existing: "ASSIST" });
  for (const field of ["knowledge", "members", "integrations", "tasks", "messages", "notices", "usage"] as const) assert.deepEqual(state[field], before[field], field);
  assert.equal(fetcher.mock.callCount(), 0);
  const review = await reviewArchitectApplication(db, auth, p.draft.id, { revision: 1 }); assert.equal(review.canApply, false); assert.equal(review.run?.status, "succeeded"); assert.ok(review.pending.length);
  assert.equal((await getArchitectState(db, auth)).draft?.appliedRevision, 1);
  assert.equal((await listActionRuns(db, auth)).items[0].source, "architect");
  await processActionRun(db, tid, run.id);
  assert.equal((await applyArchitect(db, auth, p.draft.id, { ...p.body, requestId: randomUUID() })).id, run.id);
  assert.deepEqual(await localState(), state); assert.equal(await db.actionRun.count({ where: { tenantId: tid } }), 1);
  assert.equal(await db.outboxEvent.count({ where: { tenantId: tid } }), 1);
});

it("requires explicit confirmation and exact preview, isolates tenants and rejects executable fields", async () => {
  const p = await prepared();
  for (const body of [{ ...p.body, confirmed: false }, { ...p.body, plan: {} }, { revision: 1 }, { ...p.body, revision: 0 }]) await assert.rejects(applyArchitect(db, auth, p.draft.id, body));
  await assert.rejects(applyArchitect(db, auth, p.draft.id, { ...p.body, applicationHash: "0".repeat(64) }), rejection("architect_preview_changed"));
  await assert.rejects(applyArchitect(db, other, p.draft.id, p.body), rejection("not_found"));
  await assert.rejects(reviewArchitectApplication(db, other, p.draft.id, { revision: 1 }), rejection("not_found"));
  const run = await applyArchitect(db, auth, p.draft.id, p.body);
  await assert.rejects(confirmActionRun(db, auth, run.id, { confirmed: true, planHash: run.planHash, requestId: randomUUID() }), rejection("architect_confirm_separately"));
  await assert.rejects(previewActionPlan(db, auth, { requestId: randomUUID(), title: "Injected", steps: [{ key: "pipeline", kind: "architect.settings", inputJson: {} }] }));
  await assert.rejects(applyArchitect(db, auth, p.draft.id, { ...p.body, applicationHash: "1".repeat(64) }), rejection("idempotency_conflict"));
});

it("blocks changed configuration both before confirmation and before worker execution without overwriting it", async () => {
  const p = await prepared();
  await updateAIAutomationSettings(db, auth, { firstContactSlaMinutes: 60 });
  await assert.rejects(applyArchitect(db, auth, p.draft.id, p.body), rejection("architect_not_ready"));
  const fresh = await project(answers(), 1), review = await reviewArchitectApplication(db, auth, fresh.id, { revision: 2 });
  const run = await applyArchitect(db, auth, fresh.id, { revision: 2, confirmed: true, applicationHash: review.applicationHash, requestId: randomUUID() });
  await db.tenant.update({ where: { id: tid }, data: { timezone: "UTC" } });
  const manual = await localState(); await processActionRun(db, tid, run.id);
  assert.equal((await getActionRun(db, auth, run.id)).status, "failed"); assert.deepEqual(await localState(), manual);
});

it("preserves custom pipeline, existing deals, published AI, connection flags and manual onboarding", async () => {
  const stage = await db.dealStage.create({ data: { tenantId: tid, name: "Согласование владельцем", systemKey: "custom", sortOrder: 10 } });
  const contact = await db.contact.create({ data: { tenantId: tid, name: "Покупатель" } });
  const deal = await db.deal.create({ data: { tenantId: tid, contactId: contact.id, title: "Текущий договор", stageId: stage.id } });
  const config = await db.aIConfiguration.create({ data: { tenantId: tid, enabled: true, systemPrompt: "Ручной промпт", draftPrompt: "Личный черновик", promptStatus: "published", limitsJson: { privateSetting: true } } });
  await db.tenant.update({ where: { id: tid }, data: { settingsJson: { onboarding: { channel: "telegram", replyMode: "manual", startedAt: new Date().toISOString() }, aiAutomation: { defaultMode: "AUTO", replyAudience: { audience: "existing", since: "2026-01-01T00:00:00.000Z" }, crm: { enabled: true } } } } });
  const p = await prepared(), before = await localState();
  assert.deepEqual(p.review.changes.map(c => c.key), ["reply_rules"]); assert.match(p.review.changes[0].after, /начнут действовать сразу/);
  const run = await applyArchitect(db, auth, p.draft.id, p.body); await processActionRun(db, tid, run.id);
  assert.equal((await getActionRun(db, auth, run.id)).status, "succeeded");
  assert.deepEqual(await db.deal.findUnique({ where: { id: deal.id } }), deal); assert.deepEqual((await localState()).stages, before.stages);
  assert.deepEqual(await db.aIConfiguration.findUnique({ where: { id: config.id } }), config);
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: tid } }), rules = parseAIAutomationSettings(tenant.settingsJson);
  assert.equal(rules.defaultMode, "AUTO"); assert.equal(rules.replyAudience.since, "2026-01-01T00:00:00.000Z"); assert.equal((tenant.settingsJson as any).onboarding.channel, "telegram");
});

it("cancels a queued application and allows a new confirmed attempt, while completed cancellation is a no-op", async () => {
  const p = await prepared(), before = await localState(), run = await applyArchitect(db, auth, p.draft.id, p.body);
  assert.equal((await cancelActionRun(db, auth, run.id, { requestId: randomUUID() })).status, "cancelled");
  await processActionRun(db, tid, run.id); assert.deepEqual(await localState(), before);
  const review = await reviewArchitectApplication(db, auth, p.draft.id, { revision: 1 }); assert.equal(review.canApply, true);
  const next = await applyArchitect(db, auth, p.draft.id, { ...p.body, requestId: randomUUID() }); assert.notEqual(next.id, run.id);
  await processActionRun(db, tid, next.id); assert.equal((await getActionRun(db, auth, next.id)).status, "succeeded");
  assert.equal((await cancelActionRun(db, auth, next.id, { requestId: randomUUID() })).status, "succeeded");
});

it("blocks draft edits while queued, then a new revision only changes applicable settings", async () => {
  const p = await prepared(), run = await applyArchitect(db, auth, p.draft.id, p.body);
  await assert.rejects(project(answers({ firstResponseMinutes: 60 }), 1), rejection("architect_applying"));
  await processActionRun(db, tid, run.id);
  const ai = await db.aIConfiguration.findMany({ where: { tenantId: tid } });
  const next = await project(answers({ firstResponseMinutes: 60 }), 1), review = await reviewArchitectApplication(db, auth, next.id, { revision: 2 });
  assert.deepEqual(review.changes.map(c => c.key), ["reply_rules"]);
  const run2 = await applyArchitect(db, auth, next.id, { revision: 2, confirmed: true, applicationHash: review.applicationHash, requestId: randomUUID() });
  await processActionRun(db, tid, run2.id); assert.equal((await getActionRun(db, auth, run2.id)).status, "succeeded");
  assert.deepEqual(await db.aIConfiguration.findMany({ where: { tenantId: tid } }), ai); assert.equal(await db.dealStage.count({ where: { tenantId: tid } }), 7);
  const saved = (await getArchitectState(db, auth)).draft!; assert.equal(saved.appliedRevision, 2); assert.equal(saved.applicationRunId, run2.id);
});

it("expires queued confirmation and refuses incomplete or expired projects", async () => {
  const p = await prepared(), before = await localState(), run = await applyArchitect(db, auth, p.draft.id, p.body);
  await db.actionRun.update({ where: { id: run.id }, data: { expiresAt: new Date(0) } });
  await processActionRun(db, tid, run.id); assert.equal((await getActionRun(db, auth, run.id)).status, "expired"); assert.deepEqual(await localState(), before);
  await db.architectDraft.update({ where: { id: p.draft.id }, data: { expiresAt: new Date(0) } });
  const old = await reviewArchitectApplication(db, auth, p.draft.id, { revision: 1 }); assert.equal(old.canApply, false); assert.ok(old.blockers.some(x => x.includes("7 дней")));
  const blank = await project(architectAnswersSchema.parse({}), 1), empty = await reviewArchitectApplication(db, auth, blank.id, { revision: 2 });
  assert.equal(empty.canApply, false); assert.ok(empty.blockers.length >= 6);
});

it("rechecks revoked access, company pause and feature availability before writing", async () => {
  for (const mutation of ["membership", "user", "pause", "feature"]) {
    auth = await company(); tid = auth.activeMembership!.tenantId; const p = await prepared(), run = await applyArchitect(db, auth, p.draft.id, p.body);
    if (mutation === "membership") await db.membership.update({ where: { id: auth.activeMembership!.id }, data: { role: "manager" } });
    if (mutation === "user") await db.user.update({ where: { id: auth.user.id }, data: { status: "disabled" } });
    if (mutation === "pause") await db.tenant.update({ where: { id: tid }, data: { settingsJson: { runtime: { aiPaused: true } } } });
    if (mutation === "feature") await db.tenant.update({ where: { id: tid }, data: { settingsJson: { features: { ai: false } } } });
    const before = await localState(); await processActionRun(db, tid, run.id);
    assert.equal((await db.actionRun.findUniqueOrThrow({ where: { id: run.id } })).status, "failed", mutation); assert.deepEqual(await localState(), before, mutation);
  }
});

it("disabled features stay pending without configuring AI or connecting channels", async () => {
  await db.tenant.update({ where: { id: tid }, data: { settingsJson: { features: { ai: false, whatsapp: false } } } });
  const p = await prepared(); assert.ok(!p.review.changes.some(c => ["reply_rules", "ai_draft", "onboarding"].includes(c.key)));
  const run = await applyArchitect(db, auth, p.draft.id, p.body); await processActionRun(db, tid, run.id);
  assert.equal((await getActionRun(db, auth, run.id)).status, "succeeded"); assert.equal(await db.aIConfiguration.count({ where: { tenantId: tid } }), 0);
  assert.ok((await reviewArchitectApplication(db, auth, p.draft.id, { revision: 1 })).pending.some(x => x.to.includes("ai-manager")));
});

it("manual projects preserve active AI and explicitly request reviewing the reply mode", async () => {
  const config = await db.aIConfiguration.create({ data: { tenantId: tid, enabled: true, systemPrompt: "Existing", promptStatus: "published" } });
  const p = await prepared(answers({ replyMode: "manual" }));
  assert.ok(p.review.pending.some(x => x.text.includes("не отключает"))); assert.ok(!p.review.changes.some(c => ["reply_rules", "ai_draft"].includes(c.key)));
  const run = await applyArchitect(db, auth, p.draft.id, p.body); await processActionRun(db, tid, run.id);
  assert.equal((await getActionRun(db, auth, run.id)).status, "succeeded"); assert.deepEqual(await db.aIConfiguration.findUnique({ where: { id: config.id } }), config);
});

it("retains existing published knowledge in the prepared wizard and never truncates oversized materials", async () => {
  const doc = await db.knowledgeDocument.create({ data: { tenantId: tid, title: "Проверенный прайс", content: "Стоимость: 120 000 тенге", status: "published" } });
  const p = await prepared(), run = await applyArchitect(db, auth, p.draft.id, p.body); await processActionRun(db, tid, run.id);
  assert.equal((await getActionRun(db, auth, run.id)).status, "succeeded");
  const config = await db.aIConfiguration.findFirstOrThrow({ where: { tenantId: tid } });
  assert.deepEqual((config.limitsJson as any).aiSetup.draft.knowledge, [{ id: doc.id, title: doc.title, content: doc.content }]);
  assert.deepEqual(await db.knowledgeDocument.findUnique({ where: { id: doc.id } }), doc);
  auth = await company(); tid = auth.activeMembership!.tenantId;
  const long = await db.knowledgeDocument.create({ data: { tenantId: tid, title: "Полный каталог", content: "А".repeat(65001), status: "published" } });
  const next = await prepared(); assert.ok(!next.review.changes.some(c => c.key === "ai_draft")); assert.ok(next.review.pending.some(c => c.text.includes("Материалы сохранены полностью")));
  const run2 = await applyArchitect(db, auth, next.draft.id, next.body); await processActionRun(db, tid, run2.id);
  assert.equal((await getActionRun(db, auth, run2.id)).status, "succeeded"); assert.deepEqual(await db.knowledgeDocument.findUnique({ where: { id: long.id } }), long);
});

function failDuringRules(error: Error) {
  return new Proxy(db, { get(client: any, key) {
    if (key !== "$transaction") return client[key];
    return (work: any, options: any) => db.$transaction(tx => work(new Proxy(tx, { get(inner: any, field) {
      if (field !== "tenant") return inner[field];
      return new Proxy(inner.tenant, { get(model: any, method) { return method === "update" ? async () => { throw error; } : model[method]; } });
    } })), options);
  } });
}
it("a database failure rolls back earlier configuration changes; retry after restart finishes once", async () => {
  const p = await prepared(), run = await applyArchitect(db, auth, p.draft.id, p.body), before = await localState();
  await assert.rejects(processActionRun(failDuringRules(new Error("simulated database interruption")), tid, run.id), /simulated/);
  assert.deepEqual(await localState(), before); assert.equal((await getActionRun(db, auth, run.id)).status, "queued");
  assert.equal(await db.auditEvent.count({ where: { tenantId: tid, action: "AI_SETUP_DRAFT_SAVED" } }), 0);
  await processActionRun(db, tid, run.id); assert.equal((await getActionRun(db, auth, run.id)).status, "succeeded");
  assert.equal(await db.auditEvent.count({ where: { tenantId: tid, action: "architect.applied" } }), 1);
});

it("a domain failure after intermediate writes rolls back the whole project and records a truthful failure", async () => {
  const p = await prepared(), run = await applyArchitect(db, auth, p.draft.id, p.body), before = await localState();
  await processActionRun(failDuringRules(new ApiError(409, "simulated_postcondition", "Сохранение не подтверждено")), tid, run.id);
  const result = await getActionRun(db, auth, run.id); assert.equal(result.status, "failed"); assert.equal(result.completed, 0); assert.match(result.error!, /не применены/);
  assert.deepEqual(await localState(), before); assert.equal((await getArchitectState(db, auth)).draft?.appliedRevision, null);
});

it("another company admin can inspect execution but cannot cancel someone else's confirmation", async () => {
  const p = await prepared(), run = await applyArchitect(db, auth, p.draft.id, p.body);
  const user = await db.user.create({ data: { email: `${randomUUID()}@example.test`, name: "Директор", passwordHash: "unused" } });
  await db.membership.create({ data: { tenantId: tid, userId: user.id, role: "director" } });
  const director = await authForUserInTenant(db, user.id, tid);
  const review = await reviewArchitectApplication(db, director, p.draft.id, { revision: 1 }); assert.equal(review.run?.id, run.id); assert.equal(review.run?.canCancel, false);
  await assert.rejects(cancelActionRun(db, director, run.id, { requestId: randomUUID() }));
  // Membership changes also invalidate the queued project before it can write.
  const before = await localState(); await processActionRun(db, tid, run.id); assert.deepEqual(await localState(), before);
});

it("HTTP guards apply and review, uses no-store and leaves execution queued", async () => {
  const p = await prepared(), session = await issueSession(db, auth.user.id, "web"), app = createApp(db);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/v1/workspace/onboarding/architect/${p.draft.id}`;
  const headers = { "Content-Type": "application/json", cookie: `crm_session=${session.sessionToken}`, "x-tenant-id": tid };
  try {
    assert.equal((await fetch(`${url}/apply`, { method: "POST" })).status, 401);
    const review = await fetch(`${url}/apply-preview`, { method: "POST", headers, body: JSON.stringify({ revision: 1 }) });
    assert.equal(review.status, 200, await review.clone().text()); assert.equal(review.headers.get("cache-control"), "no-store");
    assert.equal((await fetch(`${url}/apply`, { method: "POST", headers, body: JSON.stringify({ ...p.body, confirmed: false }) })).status, 422);
    const apply = await fetch(`${url}/apply`, { method: "POST", headers, body: JSON.stringify(p.body) });
    assert.equal(apply.status, 200, await apply.clone().text()); assert.equal(apply.headers.get("cache-control"), "no-store"); assert.equal(((await apply.json()) as any).status, "queued");
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});

it("the real outbox dispatcher executes the architect application without external effects", async () => {
  const p = await prepared(), run = await applyArchitect(db, auth, p.draft.id, p.body);
  const fetcher = mock.method(globalThis, "fetch", async () => { throw new Error("External sends forbidden"); });
  // The dispatcher deliberately takes small batches; earlier scenarios leave
  // durable receipts to consume before this newest application.
  for (let i = 0; i < 5; i++) {
    await processOutbox(db, { lane: "background" });
    if ((await getActionRun(db, auth, run.id)).status !== "queued") break;
  }
  assert.equal((await getActionRun(db, auth, run.id)).status, "succeeded");
  assert.ok((await db.outboxEvent.findFirstOrThrow({ where: { tenantId: tid, entityId: run.id } })).processedAt);
  assert.equal(fetcher.mock.callCount(), 0);
});

it("cancellation racing a committing project cannot leave a partial configuration", async () => {
  const p = await prepared(), run = await applyArchitect(db, auth, p.draft.id, p.body);
  let reached!: () => void, release!: () => void;
  const atWrite = new Promise<void>(resolve => { reached = resolve; }), proceed = new Promise<void>(resolve => { release = resolve; });
  const delayed = new Proxy(db, { get(client: any, field) {
    if (field !== "$transaction") return client[field];
    return (work: any, options: any) => db.$transaction(tx => work(new Proxy(tx, { get(inner: any, name) {
      if (name !== "actionStep") return inner[name];
      return new Proxy(inner.actionStep, { get(model: any, method) {
        if (method !== "update") return model[method];
        return async (args: any) => { reached(); await proceed; return model.update(args); };
      } });
    } })), options);
  } });
  const applying = processActionRun(delayed, tid, run.id); await atWrite;
  const canceling = cancelActionRun(db, auth, run.id, { requestId: randomUUID() }); release();
  await Promise.all([applying, canceling]);
  const result = await getActionRun(db, auth, run.id); assert.equal(result.status, "succeeded"); assert.equal(result.completed, 4);
  assert.equal(await db.dealStage.count({ where: { tenantId: tid } }), 7); assert.equal((await getArchitectState(db, auth)).draft?.appliedRevision, 1);
});

it("applies supported goal drafts in Russian and Kazakh without enabling replies or treating bookings as confirmed", async () => {
  for (const goal of ["booking", "product_order", "food_order", "support", "qualification", "consultation", "sales"] as const) {
    auth = await company(); tid = auth.activeMembership!.tenantId;
    const businessKind = goal === "food_order" ? "food" : goal === "product_order" ? "retail" : goal === "booking" ? "booking" : "services";
    const locale = goal === "food_order" ? "kk" : "ru", p = await prepared(answers({ businessKind, goal, locale }));
    const run = await applyArchitect(db, auth, p.draft.id, p.body); await processActionRun(db, tid, run.id);
    const done = await getActionRun(db, auth, run.id); assert.equal(done.status, "succeeded", goal + ": " + done.error);
    const config = await db.aIConfiguration.findFirstOrThrow({ where: { tenantId: tid } });
    assert.equal((config.limitsJson as any).aiSetup.draft.primaryRole, goal); assert.equal(config.enabled, false);
    if (locale === "kk") { assert.match(run.title, /Компанияны/); assert.match((config.limitsJson as any).aiSetup.draft.conversation.goal, /тапсырыс|Мәзір/); }
    assert.equal(await db.task.count({ where: { tenantId: tid } }), 0); assert.equal(await db.message.count({ where: { tenantId: tid } }), 0);
  }
});
