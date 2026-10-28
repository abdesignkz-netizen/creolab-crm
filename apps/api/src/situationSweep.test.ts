import assert from "node:assert/strict";
import { before, beforeEach, after, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { createPrismaClient } from "@creolab/db";
import { CONTROL_NOTICE_DEFAULTS } from "@creolab/contracts";
import { sweepSituationTenant, sweepSituations } from "./services/situationSweepService.ts";
import { situationWorkerAuth } from "./services/situationWorkerAuth.ts";
import { buildControlNotificationBatches, deliverControlNotifications, queueControlNotification } from "./services/controlNotificationService.ts";
import { snoozeSituation } from "./services/situationService.ts";
import { situationEpisodeDetails } from "./services/situationEpisodeService.ts";
import { visibleSituationSnoozes } from "./services/situationSnooze.ts";

describe("Background situations and relevant Control summaries", () => {
  let db: Awaited<ReturnType<typeof createPrismaClient>>, tenantId: string, memberId: string, ruleId: string, integrationId: string;
  let userId: string, secondUserId: string, planId: string, now: Date;
  const sent: string[] = [];
  const originalFetch = globalThis.fetch;
  const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
  const task = (title = "Позвонить клиенту", extra: Record<string, unknown> = {}) => db.task.create({ data: {
    tenantId, ownerMembershipId: memberId, title, type: "manual", status: "open", dueAt: new Date(now.getTime() - 3_600_000), ...extra,
  } });
  const items = () => db.controlNotificationItem.findMany({ where: { ruleId }, orderBy: { createdAt: "asc" } });
  const batches = () => db.controlNotificationBatch.findMany({ where: { ruleId }, orderBy: { createdAt: "asc" } });
  const qr = (checkLease = async () => {}) => ({ integrationId, checkLease, socket: { sendMessage: async (_to: string, payload: any) => {
    sent.push(payload.text); return { key: { id: randomUUID() } };
  } } as any });
  const episode = (itemId: string) => db.situationEpisode.findUniqueOrThrow({ where: { tenantId_itemId: { tenantId, itemId } } });
  const scan = (at = now, pageSize?: number) => sweepSituationTenant(db, tenantId, { now: at, pageSize });
  async function makeRule(membershipId: string, phone = "+77020000002") {
    return db.controlNotificationRule.create({ data: { tenantId, membershipId, integrationId, phone, enabled: true,
      settingsJson: { ...structuredClone(CONTROL_NOTICE_DEFAULTS), membershipId, integrationId, phone,
        enabled: true, recipientConfirmed: true, minIntervalMinutes: 0,
        quietHours: { enabled: false, start: "22:00", end: "08:00" },
        events: Object.fromEntries(Object.keys(CONTROL_NOTICE_DEFAULTS.events).map(key => [key, "instant"])) } } });
  }
  before(async () => {
    db = await createPrismaClient(); await (await import("../../../packages/db/src/seed.ts")).seedDatabase();
    userId = (await db.user.findUniqueOrThrow({ where: { email: "owner@creolab.example" } })).id;
    secondUserId = (await db.user.findUniqueOrThrow({ where: { email: "owner@demo-agency.example" } })).id;
    planId = (await db.tenantPlan.findFirstOrThrow({ where: { tenant: { slug: "creolab" } } })).planId;
    globalThis.fetch = async () => { throw new Error("External access disabled in situation tests"); };
  });
  beforeEach(async () => {
    sent.length = 0; now = new Date(Date.now() + 2000);
    const tenant = await db.tenant.create({ data: { name: "Situation sweep test", slug: randomUUID() } }); tenantId = tenant.id;
    memberId = (await db.membership.create({ data: { tenantId, userId, role: "owner" } })).id;
    await db.tenantPlan.create({ data: { tenantId, planId, status: "active", endsAt: new Date(Date.now() + 365 * 86400000), featuresSnapshotJson: { AI_CONTROL: true } } });
    integrationId = (await db.integration.create({ data: { tenantId, type: "whatsapp_qr", name: "Fake QR", testMode: false, status: "active", connectionStatus: "CONNECTED", schemaJson: { phone: "77010000001" } } })).id;
    ruleId = (await makeRule(memberId)).id;
  });
  after(async () => { globalThis.fetch = originalFetch; await db.$disconnect(); });

  it("detects and resolves from source facts without visiting the UI", async () => {
    const t = await task(); assert.equal(await scan(), true);
    const e = await episode(`task_overdue:${t.id}`);
    assert.equal(e.state, "open"); assert.equal((await items()).length, 1);
    await db.task.update({ where: { id: t.id }, data: { status: "done" } });
    await scan(later(2)); assert.equal((await episode(e.itemId)).state, "resolved");
    const events = await db.situationEpisodeEvent.findMany({ where: { episodeId: e.id }, orderBy: { version: "asc" } });
    assert.deepEqual(events.map(row => row.kind), ["detected", "resolved"]);
    assert.ok(events.every(row => row.actorUserId === null));
  });
  it("serializes concurrent workers and keeps once-only delivery after restarts", async () => {
    await task(); const results = await Promise.all([scan(), scan(), scan()]);
    assert.equal(results.filter(Boolean).length, 1);
    await scan(later(2)); await scan(later(4));
    assert.equal((await items()).length, 1);
    await buildControlNotificationBatches(db, later(4)); await deliverControlNotifications(db, qr(), later(4));
    await scan(later(6)); await buildControlNotificationBatches(db, later(6)); await deliverControlNotifications(db, qr(), later(6));
    assert.equal(sent.length, 1);
  });
  it("persists source cursors and reaches records beyond the first page", async () => {
    for (let i = 0; i < 5; i++) await task(`Task ${i}`, { id: `${tenantId}-${i}` });
    await scan(now, 2); assert.equal(await db.situationEpisode.count({ where: { tenantId } }), 2);
    const saved = (await db.situationSweepState.findUniqueOrThrow({ where: { tenantId } })).cursorsJson as any;
    assert.equal(saved.task, `${tenantId}-1`);
    await scan(later(2), 2); await scan(later(4), 2);
    assert.equal(await db.situationEpisode.count({ where: { tenantId } }), 5);
    assert.equal((await items()).length, 5);
  });
  it("closes known episodes even after sources leave discovery queries", async () => {
    const t = await task(); await scan();
    await db.task.update({ where: { id: t.id }, data: { status: "done" } });
    await scan(later(2), 1); assert.equal((await episode(`task_overdue:${t.id}`)).state, "resolved");
  });
  it("never fabricates resolution for a deleted source and suppresses its queued notice", async () => {
    const t = await task(); await scan(); await buildControlNotificationBatches(db, now);
    await db.task.delete({ where: { id: t.id } }); await scan(later(2));
    await deliverControlNotifications(db, qr(), later(2));
    assert.equal(sent.length, 0); assert.equal((await episode(`task_overdue:${t.id}`)).state, "open");
    assert.equal((await items())[0].suppressionReason, "source_unavailable");
  });
  it("rechecks resolutions both before batching and immediately before dispatch", async () => {
    const first = await task(); await scan(); await db.task.update({ where: { id: first.id }, data: { status: "done" } });
    await buildControlNotificationBatches(db, now); assert.equal((await batches()).length, 0);
    const second = await task(); await scan(later(2)); await buildControlNotificationBatches(db, later(2));
    let checks = 0;
    await deliverControlNotifications(db, qr(async () => { if (++checks === 2) await db.task.update({ where: { id: second.id }, data: { status: "done" } }); }), later(2));
    assert.equal(sent.length, 0); assert.equal((await batches())[0].error, "no_active_events");
  });
  it("merges an offline backlog and fresh items, excluding resolved ones", async () => {
    const first = await task(); await scan(); await buildControlNotificationBatches(db, now);
    await db.integration.update({ where: { id: integrationId }, data: { connectionStatus: "DISCONNECTED" } });
    await deliverControlNotifications(db, qr(), now);
    await task(); await scan(later(2)); await buildControlNotificationBatches(db, later(2));
    await task(); await scan(later(4)); // fresh unbatched item
    await db.task.update({ where: { id: first.id }, data: { status: "done" } });
    await db.integration.update({ where: { id: integrationId }, data: { connectionStatus: "CONNECTED" } });
    await deliverControlNotifications(db, qr(), later(4));
    assert.equal(sent.length, 1); assert.match(sent[0], /Задачи и напоминания: 2/);
    assert.equal((await items()).filter(row => row.suppressionReason === "situation_resolved").length, 1);
  });
  it("issues a new notice only for a verified recurrence, not every source edit", async () => {
    const t = await task(); await scan(); await buildControlNotificationBatches(db, now); await deliverControlNotifications(db, qr(), now);
    await db.task.update({ where: { id: t.id }, data: { title: "Уточнённая задача", priority: "high" } }); await scan(later(2));
    assert.equal((await items()).length, 1);
    await db.task.update({ where: { id: t.id }, data: { status: "done" } }); await scan(later(4));
    await db.task.update({ where: { id: t.id }, data: { status: "open" } }); await scan(later(6));
    assert.equal((await items()).length, 2); assert.equal((await items())[1].episodeOccurrence, 2);
    await buildControlNotificationBatches(db, later(6)); await deliverControlNotifications(db, qr(), later(6)); assert.equal(sent.length, 2);
  });
  it("shares identity between domain notifications and the background sweep", async () => {
    const client = await db.contact.create({ data: { tenantId, name: "Client" } });
    const inquiry = await db.inquiry.create({ data: { tenantId, contactId: client.id, source: "manual", subject: "Новая заявка", status: "new" } });
    const input = { tenantId, type: "inquiry.created", entityId: inquiry.id };
    await queueControlNotification(db, input); await scan(); await queueControlNotification(db, input);
    assert.equal((await items()).length, 1); assert.ok((await items())[0].episodeId);
    await queueControlNotification(db, { ...input, entityId: randomUUID() }); assert.equal((await items()).length, 1);
  });
  it("respects personal/company snoozes and sends exactly one reminder when due", async () => {
    const other = await db.membership.create({ data: { tenantId, userId: secondUserId, role: "director" } });
    const otherRule = await makeRule(other.id, "+77030000003");
    const t = await task(); await scan();
    const auth = (await situationWorkerAuth(db, tenantId, memberId))!;
    await snoozeSituation(db, auth, { itemId: `task_overdue:${t.id}`, scope: "personal", until: later(5).toISOString() });
    await buildControlNotificationBatches(db, now); await deliverControlNotifications(db, qr(), now);
    assert.equal((await batches()).length, 0);
    assert.equal(await db.controlNotificationBatch.count({ where: { ruleId: otherRule.id, state: "accepted" } }), 1);
    await scan(later(6)); await buildControlNotificationBatches(db, later(6)); await deliverControlNotifications(db, qr(), later(6));
    assert.equal((await batches()).filter(row => row.state === "accepted").length, 1);
    await scan(later(8)); assert.equal((await items()).length, 2);
    await snoozeSituation(db, auth, { itemId: `task_overdue:${t.id}`, scope: "company", until: later(20).toISOString() });
    await scan(later(10)); assert.equal((await items()).length, 2);
  });
  it("new evidence invalidates a snooze without repeatedly notifying on each poll", async () => {
    const c = await db.contact.create({ data: { tenantId, name: "Waiting", lastInboundMessageAt: new Date(now.getTime() - 3_600_000) } });
    await scan(); const auth = (await situationWorkerAuth(db, tenantId, memberId))!;
    await snoozeSituation(db, auth, { itemId: `contact_needs_reply:${c.id}`, scope: "company", until: later(10).toISOString() });
    await buildControlNotificationBatches(db, now);
    assert.equal((await items())[0].suppressionReason, "situation_snoozed");
    await db.contact.update({ where: { id: c.id }, data: { lastInboundMessageAt: later(1) } }); await scan(later(2));
    await buildControlNotificationBatches(db, later(2)); await deliverControlNotifications(db, qr(), later(2));
    await scan(later(4)); assert.equal(sent.length, 1); assert.equal((await items()).length, 2);
  });
  it("does not notify disabled recipients, suspended tenants or unconsented rules", async () => {
    await task(); await db.controlNotificationRule.update({ where: { id: ruleId }, data: { enabled: false } }); await scan(); assert.equal((await items()).length, 0);
    await db.controlNotificationRule.update({ where: { id: ruleId }, data: { enabled: true } });
    await db.membership.update({ where: { id: memberId }, data: { active: false } }); assert.equal(await scan(later(2)), false);
    await db.membership.update({ where: { id: memberId }, data: { active: true } }); await scan(later(4));
    await buildControlNotificationBatches(db, later(4));
    await db.tenant.update({ where: { id: tenantId }, data: { status: "suspended" } }); await deliverControlNotifications(db, qr(), later(4));
    assert.equal(sent.length, 0); assert.equal(await situationWorkerAuth(db, tenantId, memberId), null);
  });
  it("keeps unresolved delivery results out of future batches", async () => {
    await task(); await scan(); await buildControlNotificationBatches(db, now);
    await deliverControlNotifications(db, { ...qr(), socket: { sendMessage: async () => { throw new Error("Unknown result"); } } as any }, now);
    assert.equal((await batches())[0].state, "uncertain");
    await scan(later(5)); await buildControlNotificationBatches(db, later(5)); await deliverControlNotifications(db, qr(), later(5));
    assert.equal(sent.length, 0); assert.equal((await batches()).length, 1);
  });
  it("exposes only this administrator's notification history, without phone numbers", async () => {
    const t = await task(); await scan(); const auth = (await situationWorkerAuth(db, tenantId, memberId))!;
    const detail = await situationEpisodeDetails(db, auth, `task_overdue:${t.id}`);
    assert.equal(detail.notices.length, 1); assert.doesNotMatch(JSON.stringify(detail.notices), /77020000002|phone|eventKey|settingsJson/);
    const foreignMember = await db.membership.findFirstOrThrow({ where: { tenantId: { not: tenantId }, userId } });
    assert.equal(await situationWorkerAuth(db, tenantId, foreignMember.id), null);
  });
  it("initializes the scheduler for active tenants and preserves cursors across runs", async () => {
    await task();
    // Isolate this scheduler turn from fixtures created by earlier cases.
    await db.situationSweepState.updateMany({ data: { nextRunAt: later(100) } });
    const otherTenants = await db.tenant.findMany({ where: { id: { not: tenantId }, situationSweep: null }, select: { id: true } });
    await db.situationSweepState.createMany({ data: otherTenants.map(row => ({ tenantId: row.id, nextRunAt: later(100) })) });
    await sweepSituations(db, now);
    assert.ok((await db.situationSweepState.findUniqueOrThrow({ where: { tenantId } })).lastCompletedAt);
    assert.equal((await items()).length, 1);
  });
  it("discovers inquiries, dialogs, intakes, deals and agreements without a dashboard", async () => {
    const c = await db.contact.create({ data: { tenantId, name: "Client", lastInboundMessageAt: new Date(now.getTime() - 3600000) } });
    const inquiry = await db.inquiry.create({ data: { tenantId, contactId: c.id, source: "manual", status: "accepted", subject: "Без следующего шага" } });
    const dialog = await db.conversation.create({ data: { tenantId, contactId: c.id, mode: "human" } });
    const intake = await db.incompleteIntake.create({ data: { tenantId, inboundEventId: randomUUID(), reason: "missing_phone" } });
    const stage = await db.dealStage.create({ data: { tenantId, name: "Новая", systemKey: "new", sortOrder: 1 } });
    const deal = await db.deal.create({ data: { tenantId, contactId: c.id, title: "Нужен шаг", stageId: stage.id } });
    const agreement = await db.agreement.create({ data: { tenantId, type: "ONLINE_MEETING", title: "Встреча без ссылки", status: "CONFIRMED", scheduledAt: later(60) } });
    await scan();
    for (const id of [`inquiry_accepted:${inquiry.id}`, `conversation_human:${dialog.id}`, `needs_phone:${intake.id}`, `deal-next:${deal.id}`, `agreement:${agreement.id}`]) {
      assert.equal((await episode(id)).state, "open");
    }
    const notices = await db.controlNotificationItem.findMany({ where: { ruleId }, include: { episode: true } });
    assert.equal(notices.some(row => row.episode?.itemId === `contact_needs_reply:${c.id}`), false, "Contact fallback must not duplicate the dialog");
    assert.equal(notices.some(row => row.episode?.itemId === `missing_next_action:${inquiry.id}`), false, "Accepted inquiry already represents its missing step");
    assert.equal(notices.find(row => row.episode?.itemId === `conversation_human:${dialog.id}`)?.category, "dialogs");
    await db.agreement.update({ where: { id: agreement.id }, data: { meetingUrl: "https://example.test/meeting" } });
    await db.incompleteIntake.update({ where: { id: intake.id }, data: { status: "completed" } });
    await db.deal.update({ where: { id: deal.id }, data: { nextAction: "Позвонить", nextActionAt: later(60) } });
    await scan(later(2));
    for (const id of [`needs_phone:${intake.id}`, `deal-next:${deal.id}`, `agreement:${agreement.id}`]) assert.equal((await episode(id)).state, "resolved");
  });
  it("suppresses a queued contact fallback when a current dialog covers the same waiting client", async () => {
    const c = await db.contact.create({ data: { tenantId, name: "Client", lastInboundMessageAt: new Date(now.getTime() - 3600000) } });
    await scan(); await buildControlNotificationBatches(db, now);
    await db.conversation.create({ data: { tenantId, contactId: c.id, mode: "human" } }); await scan(later(2));
    await buildControlNotificationBatches(db, later(2)); await deliverControlNotifications(db, qr(), later(2));
    assert.equal(sent.length, 1); assert.equal((await items()).find(row => row.suppressionReason === "covered_by_dialogue")?.suppressionReason, "covered_by_dialogue");
  });
  it("company snooze suppresses already queued notifications for every recipient", async () => {
    const other = await db.membership.create({ data: { tenantId, userId: secondUserId, role: "director" } });
    await makeRule(other.id, "+77030000003");
    const t = await task(); await scan(); await buildControlNotificationBatches(db, now);
    await snoozeSituation(db, (await situationWorkerAuth(db, tenantId, memberId))!, { itemId: `task_overdue:${t.id}`, scope: "company", until: later(10).toISOString() });
    await deliverControlNotifications(db, qr(), now); assert.equal(sent.length, 0);
    assert.equal(await db.controlNotificationItem.count({ where: { rule: { tenantId }, suppressionReason: "situation_snoozed" } }), 2);
  });
  it("requires stored recipient confirmation before queueing or delivering", async () => {
    await task(); await scan(); await buildControlNotificationBatches(db, now);
    const rule = await db.controlNotificationRule.findUniqueOrThrow({ where: { id: ruleId } });
    await db.controlNotificationRule.update({ where: { id: ruleId }, data: { settingsJson: { ...rule.settingsJson as any, recipientConfirmed: false } } });
    await task(); await scan(later(2)); await deliverControlNotifications(db, qr(), later(2));
    assert.equal((await items()).length, 1); assert.equal(sent.length, 0);
  });
  it("does not let a stale company snooze mask a current personal reminder", async () => {
    const c = await db.contact.create({ data: { tenantId, name: "Client", lastInboundMessageAt: new Date(now.getTime() - 3600000) } });
    await scan(); const auth = (await situationWorkerAuth(db, tenantId, memberId))!, itemId = `contact_needs_reply:${c.id}`;
    await snoozeSituation(db, auth, { itemId, scope: "company", until: later(20).toISOString() });
    await db.contact.update({ where: { id: c.id }, data: { lastInboundMessageAt: later(1) } });
    await snoozeSituation(db, auth, { itemId, scope: "personal", until: later(10).toISOString() });
    await scan(later(2)); await buildControlNotificationBatches(db, later(2)); await deliverControlNotifications(db, qr(), later(2));
    assert.equal(sent.length, 0);
    const e = await episode(itemId);
    const reminder = (await visibleSituationSnoozes(db, auth, { now: later(2), evidenceKeys: new Map([[itemId, e.evidenceKey]]) })).get(itemId);
    assert.match(reminder!.itemId, /^personal:/);
  });
});
