import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, beforeEach, after, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { DEFAULT_AUTOPILOT_CONFIG, type AutopilotConfig } from "@creolab/contracts";
import type { AuthContext } from "./lib/types.ts";
import { authForUserInTenant, issueSession } from "./services/authService.ts";
import { getAutopilot, previewAutopilot, saveAutopilot, operateAutopilot } from "./services/autopilotPolicyService.ts";
import { sweepAutopilotTenant, processAutopilotCheck, operateAutopilotCase, failAutopilotCheck } from "./services/autopilotService.ts";
import { recoverInterruptedScheduledActions } from "./services/scheduledActionLease.ts";
import { getActionRun } from "./services/aiActionService.ts";
import { loadSituationEvidence } from "./services/situationEvidence.ts";
import { createProcessClock } from "./services/processCalendar.ts";
import { createApp } from "./app.ts";

let db: Awaited<ReturnType<typeof createPrismaClient>>, auth: AuthContext, tid: string, manager: AuthContext, second: AuthContext;
const base = new Date("2026-11-02T04:00:00Z"), at = (m: number) => new Date(base.getTime() + m * 60000);
const calendar = { mode: "business" as const, days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00", excludedDates: [] as string[] };
async function member(tenantId: string, role = "owner") {
  const u = await db.user.create({ data: { name: role, email: `${randomUUID()}@example.test`, passwordHash: "unused" } });
  await db.membership.create({ data: { tenantId, userId: u.id, role } });
  await db.controlAccess.create({ data: { tenantId, userId: u.id, enabled: true, status: "active", allowedSources: ["CRM_CHAT"], canCreateTasks: true, canReadTeamData: true } });
  return authForUserInTenant(db, u.id, tenantId);
}
async function company() {
  const t = await db.tenant.create({ data: { name: "Autopilot fixture", slug: randomUUID(), timezone: "Asia/Almaty", settingsJson: { control: { enabled: true }, ops: { processCalendar: calendar } } } });
  return member(t.id);
}
const mid = () => manager.activeMembership!.id;
function config(extra: Partial<AutopilotConfig> = {}): AutopilotConfig {
  return { ...DEFAULT_AUTOPILOT_CONFIG, remindMinutes: 5, escalateMinutes: 10, verifyMinutes: 15, members: [mid()], escalationMemberId: auth.activeMembership!.id, ...extra };
}
const opBody = (version: number) => ({ requestId: randomUUID(), version, confirmed: true as const });
const err = (code: string) => (e: any) => e.code === code;
async function enable(c = config({ mode: "auto" }), now = base) {
  const current = await getAutopilot(db, auth, undefined, now);
  const saved = await saveAutopilot(db, auth, { requestId: randomUUID(), version: current.policy?.version || 0, config: c }, now);
  return operateAutopilot(db, auth, "enable", opBody(saved.policy!.version), now);
}
async function inquiry(minutes = 1, extra: Record<string, unknown> = {}) {
  const contact = await db.contact.create({ data: { tenantId: tid, name: "Клиент проверки" } });
  const conversation = await db.conversation.create({ data: { tenantId: tid, contactId: contact.id, mode: "human" } });
  const message = await db.message.create({ data: { tenantId: tid, conversationId: conversation.id, direction: "inbound", senderKind: "client", text: "Нужна консультация", createdAt: at(minutes) } });
  const row = await db.inquiry.create({ data: { tenantId: tid, source: "whatsapp", contactId: contact.id, conversationId: conversation.id, subject: "Консультация", receivedAt: at(minutes), ...extra } });
  return { ...row, messageId: message.id };
}
const rowFor = (id: string) => db.autopilotCase.findUniqueOrThrow({ where: { tenantId_inquiryId: { tenantId: tid, inquiryId: id } } });
async function tick(id: string, minutes: number) {
  const row = await rowFor(id);
  const job = await db.scheduledAction.findFirst({ where: { tenantId: tid, parentId: row.id, type: "autopilot_check", state: "scheduled", dueAt: { lte: at(minutes) } } });
  if (!job) return row;
  const claimed = await db.scheduledAction.updateMany({ where: { id: job.id, version: job.version, state: "scheduled" }, data: { state: "running", version: { increment: 1 } } });
  if (claimed.count) await processAutopilotCheck(db, job, at(minutes));
  return rowFor(id);
}
async function discover(id: string, minutes = 2) { await sweepAutopilotTenant(db, tid, at(minutes)); return rowFor(id); }
async function reply(id: string, minutes: number, extra: Record<string, unknown> = {}) {
  const i = await db.inquiry.findUniqueOrThrow({ where: { id } });
  return db.message.create({ data: { tenantId: tid, conversationId: i.conversationId!, direction: "outbound", senderKind: "staff", text: "Здравствуйте, расскажите о задаче", operationState: "sent", createdAt: at(minutes), ...extra } });
}
before(async () => { db = await createPrismaClient(); });
beforeEach(async () => { auth = await company(); tid = auth.activeMembership!.tenantId; manager = await member(tid, "manager"); second = await member(tid, "manager"); });
after(async () => db.$disconnect());

it("new companies have no active rule; preview and save cannot start old work", async () => {
  const old = await inquiry(-20);
  assert.equal((await getAutopilot(db, auth)).policy, null);
  assert.equal(await sweepAutopilotTenant(db, tid, base), 0);
  const preview = await previewAutopilot(db, auth, config(), base); assert.deepEqual(preview.blockers, []);
  const saved = await saveAutopilot(db, auth, { requestId: randomUUID(), version: 0, config: config() }, base);
  assert.equal(saved.policy!.state, "paused"); assert.equal(saved.policy!.config.mode, "suggest");
  await sweepAutopilotTenant(db, tid, at(20));
  assert.equal(await db.autopilotCase.count({ where: { tenantId: tid } }), 0);
  assert.equal(await db.task.count({ where: { tenantId: tid } }), 0);
  await operateAutopilot(db, auth, "enable", opBody(saved.policy!.version), base);
  await discover((await inquiry()).id);
  assert.equal(await db.autopilotCase.count({ where: { tenantId: tid, inquiryId: old.id } }), 0);
});

it("only the owner enables automatic execution; director can save and pause, manager cannot read company history", async () => {
  const director = await member(tid, "director"), sales = await member(tid, "sales_lead");
  const saved = await saveAutopilot(db, director, { requestId: randomUUID(), version: 0, config: config({ mode: "auto" }) }, base);
  await assert.rejects(operateAutopilot(db, director, "enable", opBody(saved.policy!.version), base), (e: any) => e.status === 403);
  await assert.rejects(getAutopilot(db, manager), (e: any) => e.status === 403);
  assert.equal((await getAutopilot(db, sales)).canEdit, false);
  await assert.rejects(saveAutopilot(db, sales, { requestId: randomUUID(), version: saved.policy!.version, config: config() }), (e: any) => e.status === 403);
  const enabled = await operateAutopilot(db, auth, "enable", opBody(saved.policy!.version), base);
  assert.equal((await operateAutopilot(db, director, "pause", opBody(enabled.policy!.version), at(2))).policy!.state, "paused");
  await assert.rejects(getAutopilot(db, { ...auth, configurationTenant: {} } as AuthContext), (e: any) => e.status === 403);
});

it("save/enable retries are idempotent, stale versions and altered replay payloads are rejected", async () => {
  const body = { requestId: randomUUID(), version: 0, config: config() };
  const [a, b] = await Promise.all([saveAutopilot(db, auth, body, base), saveAutopilot(db, auth, body, base)]);
  assert.equal(a.policy!.version, b.policy!.version);
  await assert.rejects(saveAutopilot(db, auth, { ...body, config: config({ remindMinutes: 20 }) }, base), err("request_conflict"));
  await assert.rejects(saveAutopilot(db, auth, { ...body, requestId: randomUUID() }, base), err("autopilot_changed"));
  const op = opBody(a.policy!.version);
  await assert.rejects(operateAutopilot(db, auth, "enable", { ...op, confirmed: false }, base), err("invalid_autopilot"));
  const enabled = await operateAutopilot(db, auth, "enable", op, base);
  assert.equal((await operateAutopilot(db, auth, "enable", op, at(1))).policy!.version, enabled.policy!.version);
  assert.equal(await db.routingRule.count({ where: { tenantId: tid, kind: "autopilot_first_reply" } }), 1);
});

it("company boundaries protect policy, staff choices, scenario operations and database links", async () => {
  await enable(); const i = await inquiry(); const r = await discover(i.id), other = await company();
  assert.equal((await getAutopilot(db, other)).items.length, 0);
  await assert.rejects(operateAutopilotCase(db, other, r.id, "stop", opBody(r.version)), (e: any) => e.status === 404);
  const invalid = await previewAutopilot(db, auth, config({ members: [other.activeMembership!.id] }), base); assert.ok(invalid.blockers.length);
  await assert.rejects(db.autopilotEvent.create({ data: { tenantId: other.activeMembership!.tenantId, caseId: r.id, type: "fake", policyVersion: 1 } }));
});

it("suggest mode makes no changes until a reviewed scenario is confirmed, and repeated approval creates one task", async () => {
  await enable(config()); const i = await inquiry(), r = await discover(i.id);
  assert.equal((await tick(i.id, 7)).state, "proposed"); assert.equal(await db.task.count({ where: { tenantId: tid } }), 0);
  const body = opBody(r.version); await operateAutopilotCase(db, auth, r.id, "start", body, at(8));
  await operateAutopilotCase(db, auth, r.id, "start", body, at(8));
  const result = await tick(i.id, 9); assert.equal(result.state, "reminded"); assert.ok(result.authorizedAt);
  assert.equal(await db.task.count({ where: { tenantId: tid } }), 1);
});

it("two workers, duplicate events and replayed claimed jobs produce one task, notice and ledger entry", async () => {
  await enable(); const i = await inquiry();
  await Promise.all([sweepAutopilotTenant(db, tid, at(2)), sweepAutopilotTenant(db, tid, at(2))]);
  const r = await rowFor(i.id), job = await db.scheduledAction.findFirstOrThrow({ where: { parentId: r.id, state: "scheduled" } });
  await db.scheduledAction.update({ where: { id: job.id }, data: { state: "running", version: { increment: 1 } } });
  await Promise.all([processAutopilotCheck(db, job, at(7)), processAutopilotCheck(db, job, at(7))]);
  await processAutopilotCheck(db, job, at(7));
  assert.equal(await db.task.count({ where: { tenantId: tid } }), 1);
  assert.equal(await db.notification.count({ where: { tenantId: tid } }), 1);
  const after = await rowFor(i.id), run = await getActionRun(db, auth, after.lastRunId!);
  assert.equal(run.source, "autopilot"); assert.equal(run.status, "succeeded"); assert.equal(run.canConfirm, false);
  assert.equal(await db.activity.count({ where: { tenantId: tid, type: "task.created" } }), 1);
  assert.equal(await db.outboxEvent.count({ where: { tenantId: tid } }), 0);
  assert.equal(await db.notificationDelivery.count({ where: { notification: { tenantId: tid }, channel: { not: "in_app" } } }), 0);
  assert.equal(await db.message.count({ where: { tenantId: tid, direction: "outbound" } }), 0);
});

it("round-robin distributes only among active eligible staff and preserves an already assigned employee", async () => {
  await enable(config({ mode: "auto", routing: "round_robin", members: [mid(), second.activeMembership!.id] }));
  const a = await inquiry(), b = await inquiry(), existing = await inquiry(1, { assigneeMembershipId: second.activeMembership!.id });
  await discover(a.id); await tick(a.id, 7); await tick(b.id, 7); await tick(existing.id, 7);
  assert.equal((await rowFor(a.id)).assignedMembershipId, mid());
  assert.equal((await rowFor(b.id)).assignedMembershipId, second.activeMembership!.id);
  assert.equal((await rowFor(existing.id)).assignedMembershipId, second.activeMembership!.id);
});

it("least-load counts open work; unavailable and inactive employees are skipped", async () => {
  await enable(config({ mode: "auto", routing: "least_load", members: [mid(), second.activeMembership!.id] }));
  await db.task.create({ data: { tenantId: tid, type: "note", title: "Другая работа", ownerMembershipId: mid() } });
  const a = await inquiry(); await discover(a.id); assert.equal((await tick(a.id, 7)).assignedMembershipId, second.activeMembership!.id);
  await db.membership.update({ where: { id: second.activeMembership!.id }, data: { active: false } });
  const b = await inquiry(8); await discover(b.id, 9); assert.equal((await tick(b.id, 14)).assignedMembershipId, mid());
});

it("temporary absence is respected and nobody is assigned when all recipients are unavailable", async () => {
  await enable(config({ mode: "auto", routing: "round_robin", members: [mid(), second.activeMembership!.id], unavailable: [{ membershipId: mid(), until: at(60).toISOString() }] }));
  const a = await inquiry(); await discover(a.id); assert.equal((await tick(a.id, 7)).assignedMembershipId, second.activeMembership!.id);
  await db.user.update({ where: { id: second.user.id }, data: { status: "suspended" } });
  const b = await inquiry(10); await discover(b.id, 11); assert.equal((await tick(b.id, 16)).state, "attention");
  assert.equal((await rowFor(b.id)).taskId, null);
});

it("employees who disabled in-app task notifications are not silently assigned", async () => {
  await enable(); const i = await inquiry(); await discover(i.id);
  await db.notificationPreference.create({ data: { tenantId: tid, membershipId: mid(), channelsJson: { in_app: false } } });
  const row = await tick(i.id, 7); assert.equal(row.state, "attention"); assert.equal(row.taskId, null);
});

it("working calendar handles overnight delays, weekends, exclusions and exact closing time", async () => {
  const clock = createProcessClock(calendar, "Asia/Almaty");
  const friday = new Date("2026-11-06T12:58:00Z");
  assert.equal(clock.afterHours(friday, 5 / 60).toISOString(), "2026-11-09T04:03:00.000Z");
  assert.equal(clock.isWorkingTime(new Date("2026-11-06T13:00:00Z")), false);
  assert.equal(clock.nextWorkingTime(new Date("2026-11-07T08:00:00Z")).toISOString(), "2026-11-09T04:00:00.000Z");
  const excluded = createProcessClock({ ...calendar, excludedDates: ["2026-11-09"] }, "Asia/Almaty");
  assert.equal(excluded.afterHours(friday, 5 / 60).toISOString(), "2026-11-10T04:03:00.000Z");
  const night = createProcessClock({ ...calendar, start: "22:00", end: "06:00" }, "Asia/Almaty");
  assert.equal(night.isWorkingTime(new Date("2026-11-03T00:00:00Z")), true);
});

it("an overdue job does not write at night and resumes inside the next working shift", async () => {
  await enable(); const i = await inquiry(); await discover(i.id);
  const afterNight = await tick(i.id, 600); assert.equal(afterNight.state, "ready");
  assert.equal(await db.task.count({ where: { tenantId: tid } }), 0);
  assert.equal((await tick(i.id, 1440)).state, "reminded");
});

it("calendar mode must be explicit; changing it after approval pauses pending work", async () => {
  await db.tenant.update({ where: { id: tid }, data: { settingsJson: {} } });
  const saved = await saveAutopilot(db, auth, { requestId: randomUUID(), version: 0, config: config() }, base);
  await assert.rejects(operateAutopilot(db, auth, "enable", opBody(saved.policy!.version), base), err("autopilot_blocked"));
  await db.tenant.update({ where: { id: tid }, data: { settingsJson: { ops: { processCalendar: calendar } } } });
  await enable(); const i = await inquiry(); await discover(i.id);
  await db.tenant.update({ where: { id: tid }, data: { settingsJson: { ops: { processCalendar: { ...calendar, end: "17:00" } } } } });
  assert.equal((await tick(i.id, 7)).state, "stopped"); assert.equal((await getAutopilot(db, auth)).policy!.state, "paused");
});

it("an accepted reply a second before escalation resolves the case without reassignment", async () => {
  await enable(); const i = await inquiry(); await discover(i.id); await tick(i.id, 7);
  const message = await reply(i.id, 16.99); const result = await tick(i.id, 17);
  assert.equal(result.state, "resolved"); assert.equal(result.assignedMembershipId, mid());
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: result.taskId! } })).status, "open");
  assert.equal((await db.situationEpisode.findUniqueOrThrow({ where: { id: result.episodeId } })).state, "resolved");
  const evidence = await loadSituationEvidence(db, auth, [`autopilot_reply:${i.id}`], at(18)); assert.equal(evidence.get(`autopilot_reply:${i.id}`)?.active, false);
  assert.ok(JSON.stringify((await getAutopilot(db, auth)).items[0].history).includes("подтверждён"));
  assert.ok(message.id);
});

it("queued, failed, internal and historical messages do not count as real replies", async () => {
  await enable(); const i = await inquiry(); await discover(i.id);
  await reply(i.id, 3, { operationState: "queued" }); await reply(i.id, 4, { receiptState: "failed" });
  await reply(i.id, 4, { internal: true }); await reply(i.id, 4, { historical: true });
  assert.equal((await tick(i.id, 7)).state, "reminded");
  await reply(i.id, 8); assert.equal((await tick(i.id, 9)).state, "resolved");
});

it("only one escalation is possible; assignment alone never means the client was answered", async () => {
  await enable(); const i = await inquiry(); await discover(i.id); const first = await tick(i.id, 7);
  const escalation = await tick(i.id, 17); assert.equal(escalation.state, "escalated"); assert.equal(escalation.taskId, first.taskId);
  assert.equal(escalation.assignedMembershipId, auth.activeMembership!.id);
  const end = await tick(i.id, 32); assert.equal(end.state, "attention");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: end.taskId! } })).ownerMembershipId, auth.activeMembership!.id);
  await tick(i.id, 1500); assert.equal(await db.actionRun.count({ where: { tenantId: tid } }), 2);
});

it("the rule never transfers work back to the same manager", async () => {
  await enable(config({ mode: "auto", members: [auth.activeMembership!.id] })); const i = await inquiry(); await discover(i.id);
  await tick(i.id, 7); assert.equal((await tick(i.id, 17)).state, "attention");
  assert.equal(await db.actionRun.count({ where: { tenantId: tid } }), 1);
});

for (const target of ["inquiry", "conversation", "task"] as const) it(`manual ${target} edits stop the case instead of being overwritten`, async () => {
  await enable(); const i = await inquiry(); await discover(i.id); const first = await tick(i.id, 7);
  if (target === "inquiry") await db.inquiry.update({ where: { id: i.id }, data: { nextStep: "Созвон", version: { increment: 1 } } });
  if (target === "conversation") await db.conversation.update({ where: { id: i.conversationId! }, data: { controlVersion: { increment: 1 } } });
  if (target === "task") await db.task.update({ where: { id: first.taskId! }, data: { status: "done" } });
  assert.equal((await tick(i.id, 17)).state, "stopped"); assert.equal(await db.actionRun.count({ where: { tenantId: tid } }), 1);
});

it("an existing open task is preserved and no duplicate is created", async () => {
  await enable(); const i = await inquiry(); await discover(i.id);
  const task = await db.task.create({ data: { tenantId: tid, type: "note", title: "Уже взял в работу", inquiryId: i.id, ownerMembershipId: mid() } });
  assert.equal((await tick(i.id, 7)).state, "stopped"); assert.equal(await db.task.count({ where: { tenantId: tid } }), 1);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).title, task.title);
});

it("pause and rule version changes cancel pending jobs, resume does not revive old cases", async () => {
  const enabled = await enable(); const i = await inquiry(); const r = await discover(i.id);
  const job = await db.scheduledAction.findFirstOrThrow({ where: { parentId: r.id } });
  await db.scheduledAction.update({ where: { id: job.id }, data: { state: "running", version: { increment: 1 } } });
  const paused = await operateAutopilot(db, auth, "pause", opBody(enabled.policy!.version), at(3));
  await processAutopilotCheck(db, job, at(7)); assert.equal(await db.task.count({ where: { tenantId: tid } }), 0);
  await operateAutopilot(db, auth, "enable", opBody(paused.policy!.version), at(8));
  await sweepAutopilotTenant(db, tid, at(10)); assert.equal((await rowFor(i.id)).state, "stopped");
  const j = await inquiry(11); await discover(j.id, 12);
  const view = await getAutopilot(db, auth); await saveAutopilot(db, auth, { requestId: randomUUID(), version: view.policy!.version, config: config() }, at(13));
  assert.equal((await rowFor(j.id)).state, "stopped");
});

it("revoked owner permission and the global pause stop future effects", async () => {
  await enable(); const i = await inquiry(); await discover(i.id);
  await db.membership.update({ where: { id: auth.activeMembership!.id }, data: { role: "director" } });
  assert.equal((await tick(i.id, 7)).state, "stopped"); assert.equal(await db.task.count({ where: { tenantId: tid } }), 0);
  await db.membership.update({ where: { id: auth.activeMembership!.id }, data: { role: "owner" } });
  await enable(config({ mode: "auto" }), at(10)); const j = await inquiry(11); await discover(j.id, 12);
  await db.tenant.update({ where: { id: tid }, data: { settingsJson: { ops: { processCalendar: calendar }, runtime: { aiPaused: true } } } });
  assert.equal((await tick(j.id, 17)).state, "stopped");
});

it("the hourly limit is shared across concurrent cases and survives worker restart", async () => {
  await enable(config({ mode: "auto", hourlyLimit: 1 })); const a = await inquiry(), b = await inquiry(); await discover(a.id);
  await Promise.all([tick(a.id, 7), tick(b.id, 7)]);
  assert.equal(await db.task.count({ where: { tenantId: tid } }), 1);
  const waiting = (await rowFor(a.id)).state === "ready" ? a.id : b.id;
  await tick(waiting, 20); assert.equal((await rowFor(waiting)).state, "ready");
  assert.equal((await tick(waiting, 68)).state, "reminded");
});

it("interrupted internal claims can be recovered without repeating committed effects", async () => {
  await enable(); const i = await inquiry(), r = await discover(i.id);
  const job = await db.scheduledAction.findFirstOrThrow({ where: { parentId: r.id } });
  await db.scheduledAction.update({ where: { id: job.id }, data: { state: "running", version: { increment: 1 }, payloadJson: { _leaseUntil: at(3).getTime() } } });
  await recoverInterruptedScheduledActions(db, at(4));
  assert.equal((await tick(i.id, 7)).state, "reminded");
  await processAutopilotCheck(db, job, at(8)); assert.equal(await db.task.count({ where: { tenantId: tid } }), 1);
});

it("failed transactions have no partial assignment, notice or run and retries stop after three failures", async () => {
  await enable(); const i = await inquiry(), r = await discover(i.id);
  await db.task.create({ data: { tenantId: tid, type: "note", title: "Historical duplicate guard", status: "done", dedupeKey: `autopilot:${r.id}` } });
  for (const min of [7, 9, 11]) {
    const job = await db.scheduledAction.findFirstOrThrow({ where: { parentId: r.id, state: "scheduled" } });
    await db.scheduledAction.update({ where: { id: job.id }, data: { state: "running", version: { increment: 1 } } });
    await assert.rejects(processAutopilotCheck(db, job, at(min)));
    await failAutopilotCheck(db, job, at(min));
  }
  assert.equal((await rowFor(i.id)).state, "attention");
  assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: i.id } })).assigneeMembershipId, null);
  assert.equal(await db.notification.count({ where: { tenantId: tid } }), 0);
  assert.equal(await db.actionRun.count({ where: { tenantId: tid } }), 0);
});

it("a delayed incoming message can be discovered on the bounded overlap pass", async () => {
  await enable(); const i = await inquiry(); await db.message.delete({ where: { id: i.messageId } });
  await sweepAutopilotTenant(db, tid, at(2)); assert.equal(await db.autopilotCase.count({ where: { tenantId: tid } }), 0);
  await db.message.create({ data: { tenantId: tid, conversationId: i.conversationId!, direction: "inbound", senderKind: "client", text: "Поздняя обработка", createdAt: at(1) } });
  await sweepAutopilotTenant(db, tid, at(3)); await sweepAutopilotTenant(db, tid, at(4));
  assert.equal((await rowFor(i.id)).state, "ready");
});

it("HTTP routes require the company actor, use no-store, and reject malformed confirmation", async () => {
  const app = createApp(db); const server = app.listen(0, "127.0.0.1"); await new Promise<void>(r => server.on("listening", r));
  const address = server.address() as { port: number }, root = `http://127.0.0.1:${address.port}/api/v1/settings/autopilot`;
  try {
    assert.equal((await fetch(root)).status, 401);
    const session = await issueSession(db, auth.user.id, "web");
    const headers = { cookie: `crm_session=${session.sessionToken}`, "x-tenant-id": tid, "Content-Type": "application/json" };
    const r = await fetch(root, { headers }); assert.equal(r.status, 200); assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal((await fetch(`${root}/enable`, { method: "POST", headers, body: JSON.stringify({ version: 1 }) })).status, 422);
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});

it("expired suggestions stop without effects and a reply before approval rejects stale confirmation", async () => {
  await enable(config()); const a = await inquiry(), b = await inquiry(); const row = await discover(a.id);
  await reply(a.id, 3);
  await assert.rejects(operateAutopilotCase(db, auth, row.id, "start", opBody(row.version), at(4)), err("autopilot_changed"));
  assert.equal((await tick(a.id, 4)).state, "resolved");
  assert.equal((await getAutopilot(db, auth, undefined, at(7 * 1440 + 2))).items.find(row => row.inquiryId === b.id)!.canStart, false);
  assert.equal((await tick(b.id, 7 * 1440 + 2)).state, "stopped");
  assert.equal(await db.task.count({ where: { tenantId: tid } }), 0);
});

it("a manual episode assignment stops automation, even if the inquiry itself was unchanged", async () => {
  await enable(); const i = await inquiry(), row = await discover(i.id);
  const episode = await db.situationEpisode.update({ where: { id: row.episodeId }, data: { assignedMembershipId: mid(), version: { increment: 1 } } });
  await db.situationEpisodeEvent.create({ data: { tenantId: tid, episodeId: episode.id, version: episode.version, kind: "assigned", actorUserId: auth.user.id } });
  assert.equal((await tick(i.id, 7)).state, "stopped"); assert.equal(await db.task.count({ where: { tenantId: tid } }), 0);
});

it("a scenario approved by another director stops when that director loses permission", async () => {
  const director = await member(tid, "director"); await enable(config()); const i = await inquiry(), row = await discover(i.id);
  await operateAutopilotCase(db, director, row.id, "start", opBody(row.version), at(3));
  await db.membership.update({ where: { id: director.activeMembership!.id }, data: { role: "manager" } });
  assert.equal((await tick(i.id, 7)).state, "stopped");
  assert.equal((await getAutopilot(db, auth)).policy!.state, "enabled");
});

it("a selected director's action ledger stays private to that director in shared scenario history", async () => {
  const director = await member(tid, "director"); await enable(config()); const i = await inquiry(), row = await discover(i.id);
  await operateAutopilotCase(db, director, row.id, "start", opBody(row.version), at(3));
  const next = await tick(i.id, 7);
  assert.equal((await getAutopilot(db, auth)).items[0].history.some(h => h.runId), false);
  assert.equal((await getAutopilot(db, director)).items[0].history.some(h => h.runId === next.lastRunId), true);
  await assert.rejects(getActionRun(db, auth, next.lastRunId!), (e: any) => e.status === 404);
});

it("closed, test and already answered inquiries do not enter automation", async () => {
  await enable(); const closed = await inquiry(1, { status: "closed" }), test = await inquiry(1, { test: true }), answered = await inquiry();
  await reply(answered.id, 1.5); await sweepAutopilotTenant(db, tid, at(2));
  assert.equal(await db.autopilotCase.count({ where: { tenantId: tid, inquiryId: { in: [closed.id, test.id, answered.id] } } }), 0);
});

it("100 active scenarios cap discovery; stopping one permits the next new inquiry without losing the cursor", async () => {
  await enable(config());
  const contact = await db.contact.create({ data: { tenantId: tid, name: "Capacity" } });
  const conversation = await db.conversation.create({ data: { tenantId: tid, contactId: contact.id } });
  await db.message.create({ data: { tenantId: tid, conversationId: conversation.id, direction: "inbound", senderKind: "client", createdAt: at(1) } });
  await db.inquiry.createMany({ data: Array.from({ length: 101 }, () => ({ id: randomUUID(), tenantId: tid, contactId: contact.id, conversationId: conversation.id, source: "web", receivedAt: at(1) })) });
  for (let m = 2; m <= 8; m++) await sweepAutopilotTenant(db, tid, at(m));
  assert.equal(await db.autopilotCase.count({ where: { tenantId: tid } }), 100);
  const row = await db.autopilotCase.findFirstOrThrow({ where: { tenantId: tid } });
  await operateAutopilotCase(db, auth, row.id, "stop", opBody(row.version), at(9));
  await sweepAutopilotTenant(db, tid, at(10));
  assert.equal(await db.autopilotCase.count({ where: { tenantId: tid } }), 101);
  assert.equal(await db.autopilotCase.count({ where: { tenantId: tid, state: "proposed" } }), 100);
  const first = await getAutopilot(db, auth); assert.equal(first.items.length, 20); assert.ok(first.nextCursor);
  const secondPage = await getAutopilot(db, auth, first.nextCursor); assert.equal(secondPage.items.length, 20);
  assert.ok(secondPage.items.every(row => !first.items.some(first => first.id === row.id)));
});

it("existing customer-only tasks are not duplicated by automatic reminders", async () => {
  await enable(); const i = await inquiry(); await discover(i.id);
  await db.task.create({ data: { tenantId: tid, type: "message", title: "Связаться с клиентом", contactId: i.contactId, ownerMembershipId: mid() } });
  assert.equal((await tick(i.id, 7)).state, "stopped"); assert.equal(await db.task.count({ where: { tenantId: tid } }), 1);
});

it("manual action on the existing new-inquiry card is respected by the linked automation", async () => {
  await enable(); const i = await inquiry(); await discover(i.id);
  const episode = await db.situationEpisode.create({ data: { tenantId: tid, itemId: `inquiry_new:${i.id}`, title: "Новая заявка", evidenceKey: "manual", version: 2 } });
  await db.situationEpisodeEvent.create({ data: { tenantId: tid, episodeId: episode.id, version: 2, kind: "snoozed", actorUserId: auth.user.id, createdAt: at(3) } });
  assert.equal((await tick(i.id, 7)).state, "stopped"); assert.equal(await db.task.count({ where: { tenantId: tid } }), 0);
});
