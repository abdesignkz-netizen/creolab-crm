import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { createPrismaClient } from "@creolab/db";
import { authForUserInTenant } from "./services/authService.ts";
import { getSituation, snoozeSituation } from "./services/situationService.ts";
import { actOnSituationEpisode, situationEpisodeDetails, situationEpisodeHistory, syncSituationEpisodes } from "./services/situationEpisodeService.ts";
import { loadSituationEvidence } from "./services/situationEvidence.ts";
import { getSituationOverview } from "./services/situationOverviewService.ts";
import { situationEpisodeActionSchema } from "@creolab/contracts";

describe("Managed situation lifecycle", () => {
  let db: Awaited<ReturnType<typeof createPrismaClient>>;
  let owner: Awaited<ReturnType<typeof authForUserInTenant>>, manager: typeof owner, other: typeof owner;
  let tenantId: string;
  const originalFetch = globalThis.fetch;
  const past = () => new Date(Date.now() - 3_600_000);
  const future = () => new Date(Date.now() + 86_400_000).toISOString();
  const task = (auth = owner) => db.task.create({ data: { tenantId: auth.activeMembership!.tenantId,
    type: "manual", title: `Situation task ${randomUUID()}`, ownerMembershipId: auth.activeMembership!.id, status: "open", dueAt: past() } });
  const contact = () => db.contact.create({ data: { tenantId, name: `Client ${randomUUID()}`, lastInboundMessageAt: past(), ownerMembershipId: owner.activeMembership!.id } });
  const see = (itemId: string, auth = owner) => situationEpisodeDetails(db, auth, itemId);
  const countEvents = (episodeId: string, kind?: string) => db.situationEpisodeEvent.count({ where: { episodeId, ...(kind ? { kind } : {}) } });
  before(async () => {
    db = await createPrismaClient();
    await (await import("../../../packages/db/src/seed.ts")).seedDatabase();
    const auth = async (email: string) => { const m = await db.membership.findFirstOrThrow({ where: { user: { email } } }); return authForUserInTenant(db, m.userId, m.tenantId, "episode-test"); };
    owner = await auth("owner@creolab.example"); manager = await auth("manager@creolab.example"); other = await auth("owner@demo-agency.example");
    tenantId = owner.activeMembership!.tenantId;
    globalThis.fetch = async () => { throw new Error("External services disabled"); };
  });
  after(async () => { globalThis.fetch = originalFetch; await db.$disconnect(); });

  it("persists detection once even on repeated/concurrent refreshes", async () => {
    const row = await task(), itemId = `task_overdue:${row.id}`;
    const results = await Promise.all([see(itemId), see(itemId), see(itemId)]);
    assert.equal(new Set(results.map(r => r.id)).size, 1);
    assert.equal(await countEvents(results[0].id), 1);
    const board = await getSituation(db, owner);
    assert.equal(board.items.find(item => item.id === itemId)?.episode?.id, results[0].id);
  });
  it("does not treat checking an active problem as resolution or write to the source", async () => {
    const row = await task(), episode = await see(`task_overdue:${row.id}`);
    const result = await actOnSituationEpisode(db, owner, { itemId: episode.itemId, version: episode.version, action: "check" });
    assert.equal(result.stillActive, true); assert.equal(result.state, "open");
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: row.id } })).status, "open");
    assert.equal(await countEvents(episode.id, "resolved"), 0);
  });
  it("records verified resolution and recurrence without repeated events", async () => {
    const row = await task(), itemId = `task_overdue:${row.id}`, episode = await see(itemId);
    await db.task.update({ where: { id: row.id }, data: { status: "done", completedAt: new Date() } });
    assert.equal((await see(itemId)).state, "resolved"); await see(itemId);
    assert.equal(await countEvents(episode.id, "resolved"), 1);
    await db.task.update({ where: { id: row.id }, data: { status: "open", completedAt: null, dueAt: past() } });
    const reopened = await see(itemId);
    assert.equal(reopened.occurrence, 2); assert.equal(reopened.state, "open");
    await see(itemId); assert.equal(await countEvents(episode.id, "reopened"), 1);
  });
  it("reconciles from source facts even when filters omit an active item", async () => {
    const row = await task(), itemId = `task_overdue:${row.id}`, episode = await see(itemId);
    await syncSituationEpisodes(db, owner, []);
    assert.equal((await db.situationEpisode.findUniqueOrThrow({ where: { id: episode.id } })).state, "open");
    await db.task.update({ where: { id: row.id }, data: { status: "done" } });
    await syncSituationEpisodes(db, owner, []);
    assert.equal((await db.situationEpisode.findUniqueOrThrow({ where: { id: episode.id } })).state, "resolved");
  });
  it("assignment is recorded, rejects stale writes and cannot grant source access", async () => {
    const row = await task(), episode = await see(`task_overdue:${row.id}`);
    await assert.rejects(actOnSituationEpisode(db, owner, { itemId: episode.itemId, version: episode.version, action: "assign", membershipId: manager.activeMembership!.id }), { code: "source_access" });
    const assigned = await actOnSituationEpisode(db, owner, { itemId: episode.itemId, version: episode.version, action: "assign", membershipId: owner.activeMembership!.id });
    assert.equal(assigned.state, "in_progress"); assert.equal(assigned.assignedMembershipId, owner.activeMembership!.id);
    assert.equal(await countEvents(episode.id, "assigned"), 1);
    await assert.rejects(actOnSituationEpisode(db, owner, { itemId: episode.itemId, version: episode.version, action: "assign", membershipId: owner.activeMembership!.id }), { code: "situation_changed" });
  });
  it("snooze is separate from resolution and new inbound evidence makes it visible", async () => {
    const client = await contact(), itemId = `contact_needs_reply:${client.id}`;
    const initial = await see(itemId);
    await snoozeSituation(db, owner, { itemId, until: future(), scope: "company", reason: "Ожидаем сведения" });
    assert.equal((await see(itemId)).state, "open");
    assert.equal((await getSituation(db, owner)).items.some(item => item.id === itemId), false);
    await db.contact.update({ where: { id: client.id }, data: { lastInboundMessageAt: new Date() } });
    assert.equal((await getSituation(db, owner)).items.some(item => item.id === itemId), true);
    assert.equal(await countEvents(initial.id, "snoozed"), 1);
    assert.equal(await countEvents(initial.id, "resolved"), 0);
  });
  it("creates exactly one linked task under concurrent submissions and records client history", async () => {
    const client = await contact(), episode = await see(`contact_needs_reply:${client.id}`);
    const input = { itemId: episode.itemId, version: episode.version, action: "create_task" as const, title: "Ответить клиенту по предложению", dueAt: future(), membershipId: owner.activeMembership!.id };
    const results = await Promise.allSettled([actOnSituationEpisode(db, owner, input), actOnSituationEpisode(db, owner, input)]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    const result = await see(episode.itemId);
    assert.ok(result.task); assert.equal(result.state, "in_progress");
    const saved = await db.task.findUniqueOrThrow({ where: { id: result.task!.id } });
    assert.equal(saved.contactId, client.id); assert.equal(saved.source, "situation"); assert.ok(saved.dueAt);
    assert.equal(await countEvents(episode.id, "task_created"), 1);
    assert.equal(await db.activity.count({ where: { contactId: client.id, type: "task.created" } }), 1);
    assert.equal(await db.auditEvent.count({ where: { tenantId, entityId: saved.id, action: "task.created" } }), 1);
    assert.equal(await countEvents(episode.id, "resolved"), 0);
    await assert.rejects(actOnSituationEpisode(db, owner, { ...input, version: result.version }), { code: "task_exists" });
  });
  it("accepts only related accessible existing tasks", async () => {
    const client = await contact(), episode = await see(`contact_needs_reply:${client.id}`), unrelated = await task();
    await assert.rejects(actOnSituationEpisode(db, owner, { action: "link_task", itemId: episode.itemId, version: episode.version, taskId: unrelated.id }), { code: "unrelated_task" });
    await db.task.update({ where: { id: unrelated.id }, data: { contactId: client.id } });
    const linked = await actOnSituationEpisode(db, owner, { action: "link_task", itemId: episode.itemId, version: episode.version, taskId: unrelated.id });
    assert.equal(linked.task!.id, unrelated.id);
  });
  it("rejects other tenants, forged kinds and inaccessible sources without creating history", async () => {
    const foreign = await task(other), privateTask = await task();
    for (const itemId of [`task_overdue:${foreign.id}`, `anything:${privateTask.id}`]) await assert.rejects(see(itemId), { code: "not_found" });
    const initial = await see(`task_overdue:${privateTask.id}`);
    await assert.rejects(see(initial.itemId, manager), { code: "not_found" });
    assert.equal((await situationEpisodeHistory(db, manager)).items.some(row => row.id === initial.id), false);
    assert.equal(await db.situationEpisode.count({ where: { tenantId, itemId: `task_overdue:${foreign.id}` } }), 0);
  });
  it("keeps inaccessible or deleted sources unresolved rather than inventing success", async () => {
    const row = await task(manager), episode = await see(`task_overdue:${row.id}`, manager);
    await db.task.update({ where: { id: row.id }, data: { ownerMembershipId: owner.activeMembership!.id } });
    await syncSituationEpisodes(db, manager, []);
    assert.equal((await db.situationEpisode.findUniqueOrThrow({ where: { id: episode.id } })).state, "open");
    await db.task.delete({ where: { id: row.id } }); await syncSituationEpisodes(db, owner, []);
    assert.equal((await db.situationEpisode.findUniqueOrThrow({ where: { id: episode.id } })).state, "open");
    await assert.rejects(see(episode.itemId), { code: "not_found" });
  });
  it("managers may take their own situation but cannot create tasks or assign others", async () => {
    const row = await task(manager), episode = await see(`task_overdue:${row.id}`, manager);
    await assert.rejects(actOnSituationEpisode(db, manager, { itemId: episode.itemId, version: episode.version, action: "assign", membershipId: owner.activeMembership!.id }), { code: "forbidden" });
    const current = await actOnSituationEpisode(db, manager, { itemId: episode.itemId, version: episode.version, action: "assign", membershipId: manager.activeMembership!.id });
    await assert.rejects(actOnSituationEpisode(db, manager, { itemId: episode.itemId, version: current.version, action: "create_task", membershipId: manager.activeMembership!.id, title: "Новая задача", dueAt: future() }), { code: "forbidden" });
  });
  it("keeps in-progress overdue tasks in the queue", async () => {
    const row = await task(); await db.task.update({ where: { id: row.id }, data: { status: "in_progress" } });
    assert.ok((await getSituation(db, owner)).items.find(item => item.id === `task_overdue:${row.id}`));
  });
  it("does not label accepted inquiries without a next step when a task exists", async () => {
    const client = await contact();
    const inquiry = await db.inquiry.create({ data: { tenantId, contactId: client.id, subject: "Принятая заявка", status: "accepted", source: "manual", assigneeMembershipId: owner.activeMembership!.id } });
    await db.task.create({ data: { tenantId, type: "manual", title: "Следующий шаг", status: "in_progress", inquiryId: inquiry.id, contactId: client.id, ownerMembershipId: owner.activeMembership!.id } });
    const board = await getSituation(db, owner);
    assert.equal(board.items.some(item => item.id === `inquiry_accepted:${inquiry.id}` || item.id === `missing_next_action:${inquiry.id}`), false);
  });
  it("checks deal conditions through the shared process policy, not age text", async () => {
    const stage = await db.dealStage.findFirstOrThrow({ where: { tenantId, isTerminal: false } });
    const deal = await db.deal.create({ data: { tenantId, contactId: (await contact()).id, title: "Нет шага", stageId: stage.id, assigneeMembershipId: owner.activeMembership!.id } });
    const episode = await see(`deal-next:${deal.id}`);
    assert.equal(episode.active, true);
    await db.task.create({ data: { tenantId, type: "manual", title: "План", dealId: deal.id, dueAt: new Date(future()), status: "in_progress", ownerMembershipId: owner.activeMembership!.id } });
    assert.equal((await see(episode.itemId)).state, "resolved");
  });
  it("unrelated update timestamps do not change a dialogue's evidence identity", async () => {
    const client = await contact();
    const conversation = await db.conversation.create({ data: { tenantId, contactId: client.id, mode: "paused", updatedAt: new Date(Date.now() - 5 * 3_600_000), assigneeMembershipId: owner.activeMembership!.id } });
    const itemId = `conversation_paused:${conversation.id}`;
    const before = (await loadSituationEvidence(db, owner, [itemId])).get(itemId)!;
    await db.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date(Date.now() - 4 * 3_600_000) } });
    assert.equal((await loadSituationEvidence(db, owner, [itemId])).get(itemId)!.evidenceKey, before.evidenceKey);
  });
  it("validates action payloads and refuses suspended memberships", async () => {
    assert.equal(situationEpisodeActionSchema.safeParse({ action: "resolve", itemId: "task_overdue:some", version: 1 }).success, false);
    assert.equal(situationEpisodeActionSchema.safeParse({ action: "create_task", itemId: "task_overdue:some", version: 1, title: " ", dueAt: "bad", membershipId: randomUUID() }).success, false);
    const row = await task();
    await assert.rejects(see(`task_overdue:${row.id}`, { ...owner, activeMembership: { ...owner.activeMembership!, active: false } }), { code: "membership_suspended" });
  });
  it("rejects a stale snooze after new client information", async () => {
    const client = await contact(), itemId = `contact_needs_reply:${client.id}`, episode = await see(itemId);
    await db.contact.update({ where: { id: client.id }, data: { lastInboundMessageAt: new Date() } });
    await assert.rejects(snoozeSituation(db, owner, { itemId, version: episode.version, until: future() }), { code: "situation_changed" });
    assert.equal(await db.situationSnooze.count({ where: { tenantId, itemId: { endsWith: itemId } } }), 0);
  });
  it("does not lose waiting clients after the first 200 contacts", async () => {
    await db.contact.createMany({ data: Array.from({ length: 205 }, (_, i) => ({ tenantId, name: `Earlier contact ${i}` })) });
    const client = await contact();
    assert.ok((await getSituation(db, owner)).items.some(item => item.id === `contact_needs_reply:${client.id}`));
  });
  it("stores episode events only within their tenant", async () => {
    const row = await task(), episode = await see(`task_overdue:${row.id}`);
    await assert.rejects(db.situationEpisodeEvent.create({ data: { tenantId: other.activeMembership!.tenantId, episodeId: episode.id,
      version: 900, kind: "forged" } }));
    assert.equal(await countEvents(episode.id, "forged"), 0);
  });
  it("opens the exact agreement task and resolves only after the missing details are supplied", async () => {
    const client = await contact();
    const agreement = await db.agreement.create({ data: { tenantId, contactId: client.id, title: "Встреча без ссылки", type: "ONLINE_MEETING", status: "CONFIRMED", scheduledAt: new Date(future()) } });
    const linked = await db.task.create({ data: { tenantId, contactId: client.id, agreementId: agreement.id, type: "manual", title: "Встреча", ownerMembershipId: owner.activeMembership!.id } });
    const itemId = `agreement:${agreement.id}`, episode = await see(itemId);
    const overview = await getSituationOverview(db, owner);
    const card = overview.attention.items.find(item => item.id === itemId);
    assert.ok(card); assert.equal(card.nextAction, "open_agreement"); assert.equal(card.href, `/tasks?open=${linked.id}`);
    await db.task.update({ where: { id: linked.id }, data: { status: "done" } });
    assert.equal((await see(itemId)).state, "open");
    await db.agreement.update({ where: { id: agreement.id }, data: { meetingUrl: "https://example.invalid/meeting" } });
    assert.equal((await see(itemId)).state, "resolved");
    assert.equal(await countEvents(episode.id, "resolved"), 1);
  });
  it("does not offer company-wide controls to a sales lead", async () => {
    const salesLead = { ...owner, activeMembership: { ...owner.activeMembership!, role: "sales_lead" as const } };
    const row = await task(), episode = await see(`task_overdue:${row.id}`, salesLead);
    assert.equal(episode.canManage, true); assert.equal(episode.canSnoozeCompany, false);
    assert.deepEqual(episode.members.map(m => m.id), [salesLead.activeMembership.id]);
    await assert.rejects(snoozeSituation(db, salesLead, { itemId: episode.itemId, until: future(), scope: "company" }), { code: "forbidden" });
  });
});
