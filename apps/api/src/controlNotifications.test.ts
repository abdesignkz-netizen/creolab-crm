import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createPrismaClient } from "@creolab/db";
import { CONTROL_NOTICE_DEFAULTS } from "@creolab/contracts";
import { createApp } from "./app.ts";
import { resetRateLimits } from "./lib/rateLimit.ts";
import { encryptSecret } from "./lib/secretBox.ts";
import { createStaffNotification } from "./services/notificationService.ts";
import { buildControlNotificationBatches, controlLocalTime, controlQuiet, deliverControlNotifications, processControlNotifications, queueControlNotification } from "./services/controlNotificationService.ts";
import { processWhatsAppAiReply } from "./services/whatsappAiService.ts";
import { startWhatsAppQrRuntime } from "./services/whatsappQrRuntime.ts";

describe("BasQar Control WhatsApp notices", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>, server: any, url: string, owner: any, manager: any, foreign: any, integration: any;
  let cookie = "", managerCookie = "", sendMode = 200;
  const originalFetch = globalThis.fetch, sent: Array<{ to: string; text: string }> = [];
  const endpoint = "/api/v1/workspace/control/notifications";
  const day = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10), nextDay = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const at = (hhmm = "12:00") => new Date(`${day}T${hhmm}:00Z`);
  const qr = () => ({ integrationId: integration.id, checkLease: async () => {}, socket: { sendMessage: async (to: string, payload: any) => { sent.push({ to, text: payload.text }); if (!sendMode) throw Error("Uncertain provider result"); return { key: { id: randomUUID() } }; } } as any });
  async function request(path = endpoint, method = "GET", body?: any, auth = cookie) {
    const response = await fetch(`${url}${path}`, { method, headers: { cookie: auth, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }
  const prefs = (patch: any = {}) => ({ ...structuredClone(CONTROL_NOTICE_DEFAULTS), membershipId: owner.id, integrationId: integration.id, phone: "+77020000002", recipientConfirmed: true, enabled: true, quietHours: { enabled: false, start: "22:00", end: "08:00" }, ...patch });
  async function save(patch: any = {}) {
    const result = await request(endpoint, "PUT", prefs(patch)); assert.equal(result.status, 200, JSON.stringify(result.data));
    return prisma.controlNotificationRule.findUniqueOrThrow({ where: { id: result.data.id } });
  }
  async function newInquiry() {
    const contact = await prisma.contact.create({ data: { tenantId: owner.tenantId, name: "Notice test client" } });
    return prisma.inquiry.create({ data: { tenantId: owner.tenantId, contactId: contact.id, source: "manual", subject: "Notice test inquiry", status: "new" } });
  }
  async function event(patch: any = {}) {
    const entityId = patch.entityId || (!patch.type || patch.type === "inquiry.created" ? (await newInquiry()).id : randomUUID());
    await queueControlNotification(prisma, { tenantId: owner.tenantId, type: "inquiry.created", ...patch, entityId });
  }
  const batches = () => prisma.controlNotificationBatch.findMany({ orderBy: { createdAt: "asc" } });
  before(async () => {
    prisma = await createPrismaClient(); await (await import("../../../packages/db/src/seed.ts")).seedDatabase();
    owner = await prisma.membership.findFirstOrThrow({ where: { user: { email: "owner@creolab.example" }, tenant: { slug: "creolab" } } });
    manager = await prisma.membership.findFirstOrThrow({ where: { user: { email: "manager@creolab.example" }, tenantId: owner.tenantId } });
    foreign = await prisma.membership.findFirstOrThrow({ where: { tenantId: { not: owner.tenantId } } });
    integration = await prisma.integration.create({ data: { tenantId: owner.tenantId, type: "whatsapp_qr", name: "Control test sender", status: "active", connectionStatus: "CONNECTED", testMode: false, schemaJson: { phone: "77010000001" } } });
    server = await new Promise<any>(resolve => { const s = createApp(prisma).listen(0, "127.0.0.1", () => resolve(s)); }); url = `http://127.0.0.1:${server.address().port}`;
    for (const email of ["owner@creolab.example", "manager@creolab.example"]) {
      const response = await fetch(`${url}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: process.env.SEED_PASSWORD }) }); assert.equal(response.status, 200);
      const value = response.headers.get("set-cookie")!.split(";")[0]; if (email.startsWith("owner")) cookie = value; else managerCookie = value;
    }
    globalThis.fetch = async (input, init) => {
      const target = String(input); if (target.startsWith(url)) return originalFetch(input, init);
      assert.ok(target.startsWith("https://123456.api.green-api.com/waInstance123456/sendMessage/"));
      assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
      const body = JSON.parse(String(init?.body)); sent.push({ to: body.chatId, text: body.message });
      if (!sendMode) throw Error("private token in provider error");
      return Response.json(sendMode === 200 ? { idMessage: "accepted-green" } : { error: "secret-provider-detail" }, { status: sendMode, headers: { "retry-after": "120" } });
    };
  });
  beforeEach(async () => {
    resetRateLimits(); sent.length = 0; sendMode = 200;
    await prisma.controlNotificationRule.deleteMany(); await prisma.notificationPreference.deleteMany();
    await prisma.membership.update({ where: { id: owner.id }, data: { active: true, role: "owner" } });
    await prisma.tenant.update({ where: { id: owner.tenantId }, data: { status: "active" } });
    await prisma.integration.update({ where: { id: integration.id }, data: { type: "whatsapp_qr", status: "active", connectionStatus: "CONNECTED", testMode: false, schemaJson: { phone: "77010000001" } } });
  });
  after(async () => { globalThis.fetch = originalFetch; await new Promise<void>(resolve => server.close(() => resolve())); await prisma.$disconnect(); });

  it("restricts settings and actions to company admins and never exposes sender secrets", async () => {
    assert.equal((await request(endpoint, "GET", undefined, "")).status, 401);
    assert.equal((await request(endpoint, "GET", undefined, managerCookie)).status, 403);
    assert.equal((await request(endpoint, "PUT", prefs(), managerCookie)).status, 403);
    assert.equal((await request(endpoint, "PUT", prefs({ membershipId: foreign.id }))).status, 422);
    assert.equal((await request(endpoint, "PUT", prefs({ membershipId: manager.id }))).status, 422);
    assert.equal((await request(endpoint, "PUT", prefs({ integrationId: randomUUID() }))).status, 422);
    const row = await save();
    assert.equal((await request(`${endpoint}/${row.id}/test`, "POST", undefined, managerCookie)).status, 403);
    assert.equal((await request(`${endpoint}/${row.id}/pause`, "POST", undefined, managerCookie)).status, 403);
    const other = await prisma.controlNotificationRule.create({ data: { tenantId: foreign.tenantId, membershipId: foreign.id, integrationId: (await prisma.integration.create({ data: { tenantId: foreign.tenantId, name: "Foreign", type: "whatsapp_qr", status: "disabled" } })).id, phone: "+77039999999", settingsJson: prefs({ membershipId: foreign.id }) } });
    assert.equal((await request(`${endpoint}/${other.id}/test`, "POST")).status, 404);
    assert.equal((await request(`${endpoint}/${other.id}/pause`, "POST")).status, 404);
    const config = await request(); assert.equal(config.data.rules.length, 1); assert.doesNotMatch(JSON.stringify(config), /apiToken|encryptedToken|secretHash|settingsJson/);
  });
  it("validates consent, source, phone, schedule and selected events before enabling", async () => {
    for (const patch of [{ recipientConfirmed: false }, { timezone: "invalid/zone" }, { digestTime: "25:00" }, { quietHours: { enabled: true, start: "22:00", end: "22:00" } }, { phone: "abc" }, { phone: "+77010000001" }, { events: Object.fromEntries(Object.keys(CONTROL_NOTICE_DEFAULTS.events).map(k => [k, "off"])) }]) {
      const result = await request(endpoint, "PUT", prefs(patch)); assert.ok(result.status >= 400 && result.status < 500, JSON.stringify(result));
    }
    await prisma.integration.update({ where: { id: integration.id }, data: { type: "whatsapp_cloud" } });
    assert.equal((await request(endpoint, "PUT", prefs())).status, 422);
    await prisma.integration.update({ where: { id: integration.id }, data: { type: "whatsapp_qr", connectionStatus: "DISCONNECTED" } });
    assert.equal((await request(endpoint, "PUT", prefs())).status, 409);
    assert.equal(await prisma.controlNotificationRule.count(), 0);
    await save({ enabled: false }); // Offline drafts are allowed, automatic sending is not.
  });
  it("allows only one concurrent version update and isolates recipients' phone numbers", async () => {
    const results = await Promise.all([request(endpoint, "PUT", prefs()), request(endpoint, "PUT", prefs())]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    await prisma.membership.update({ where: { id: manager.id }, data: { role: "director" } });
    try {
      const result = await request(endpoint, "PUT", prefs({ membershipId: manager.id })); assert.equal(result.status, 409);
    } finally { await prisma.membership.update({ where: { id: manager.id }, data: { role: "manager" } }); }
    assert.equal(await prisma.controlNotificationRule.count(), 1);
  });
  it("uses versions, invalidates queued work when changing a recipient and pauses offline", async () => {
    const row = await save(); await event(); await buildControlNotificationBatches(prisma, at());
    assert.equal((await request(endpoint, "PUT", prefs({ phone: "+77025555555" }))).status, 409);
    await save({ version: row.version, phone: "+77025555555" });
    assert.equal((await batches())[0].state, "skipped"); await buildControlNotificationBatches(prisma, at()); await deliverControlNotifications(prisma, qr(), at()); assert.equal(sent.length, 0);
    await prisma.integration.update({ where: { id: integration.id }, data: { status: "disabled" } });
    assert.equal((await request(`${endpoint}/${row.id}/pause`, "POST")).status, 200);
    assert.equal((await prisma.controlNotificationRule.findUniqueOrThrow({ where: { id: row.id } })).enabled, false);
  });
  it("queues company events once even for several staff recipients with disabled personal preferences", async () => {
    await save();
    await prisma.notificationPreference.create({ data: { tenantId: owner.tenantId, membershipId: owner.id, eventsJson: { new_inquiries: false }, channelsJson: { in_app: false } } });
    const input = { tenantId: owner.tenantId, type: "inquiry.created", entityType: "inquiry", entityId: (await newInquiry()).id, title: "PRIVATE CLIENT", body: "PRIVATE PHONE" };
    assert.equal(await createStaffNotification(prisma, { ...input, membershipId: owner.id }), null);
    await createStaffNotification(prisma, { ...input, membershipId: manager.id });
    await createStaffNotification(prisma, { ...input, entityId: (await newInquiry()).id, membershipId: null }); // Unassigned is particularly important for a director.
    await event({ type: "inquiry.assigned" }); // off
    assert.equal(await prisma.controlNotificationItem.count(), 2);
    await buildControlNotificationBatches(prisma, at()); assert.deepEqual((await batches())[0].countsJson, { new_inquiries: 2 });
    await deliverControlNotifications(prisma, qr(), at()); assert.equal(sent.length, 1); assert.doesNotMatch(sent[0].text, /PRIVATE/);
  });
  it("captures actual task assignment and AI handoff, even without a manager on the conversation", async () => {
    await save();
    const task = await prisma.task.create({ data: { tenantId: owner.tenantId, type: "call", title: "Test assignment", ownerMembershipId: owner.id } });
    const assigned = await request(`/api/v1/tasks/${task.id}/assign`, "POST", { membershipId: manager.id }); assert.equal(assigned.status, 200, JSON.stringify(assigned.data));
    assert.equal((await prisma.controlNotificationItem.findMany({ where: { category: "tasks" } })).length, 1);
    await request(`/api/v1/tasks/${task.id}/assign`, "POST", { membershipId: manager.id }); assert.equal(await prisma.controlNotificationItem.count({ where: { category: "tasks" } }), 1);
    const conversation = await prisma.conversation.create({ data: { tenantId: owner.tenantId, mode: "ai" } });
    const job = { id: randomUUID(), tenantId: owner.tenantId, entityId: conversation.id, payloadJson: { controlVersion: conversation.controlVersion, messageRevision: conversation.messageRevision, messageId: randomUUID() } };
    await processWhatsAppAiReply(prisma, job); // No configured model => genuine handoff path, no model call.
    await processWhatsAppAiReply(prisma, job);
    assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).mode, "human");
    assert.equal(await prisma.controlNotificationItem.count({ where: { category: "ai_events", urgent: true } }), 1);
  });
  it("handles local midnight and overnight quiet hours, allowing only opted-in urgent instant events", async () => {
    const p = prefs({ quietHours: { enabled: true, start: "22:00", end: "08:00" }, urgentDuringQuiet: true });
    assert.deepEqual(controlLocalTime(at("20:00"), "Asia/Almaty"), { day: nextDay, time: "01:00" });
    assert.equal(controlQuiet(p, at("20:00")), true); assert.equal(controlQuiet(p, at("03:00")), false);
    await save(p); await event(); await event({ priority: "urgent" });
    await buildControlNotificationBatches(prisma, at("20:00")); assert.deepEqual((await batches())[0].countsJson, { new_inquiries: 1 });
    await deliverControlNotifications(prisma, qr(), at("20:00")); assert.equal(sent.length, 1);
    await buildControlNotificationBatches(prisma, new Date(`${nextDay}T03:00:00Z`)); await deliverControlNotifications(prisma, qr(), new Date(`${nextDay}T03:00:00Z`)); assert.equal(sent.length, 2);
  });
  it("creates one daily digest concurrently and holds a late digest until quiet hours end", async () => {
    await save({ digestTime: "23:00", quietHours: { enabled: true, start: "22:00", end: "08:00" } }); await event({ type: "task.assigned" });
    await Promise.all([buildControlNotificationBatches(prisma, at("18:00")), buildControlNotificationBatches(prisma, at("18:00"))]);
    assert.equal((await batches()).length, 1); assert.equal((await batches())[0].kind, "digest");
    await deliverControlNotifications(prisma, qr(), at("18:00")); assert.equal(sent.length, 0);
    await deliverControlNotifications(prisma, qr(), new Date(`${nextDay}T03:00:00Z`)); assert.equal(sent.length, 1);
    await buildControlNotificationBatches(prisma, new Date(`${nextDay}T18:00:00Z`)); assert.equal((await batches()).length, 1); // no empty digest
  });
  it("groups an offline backlog and fresh pending events into ONE summary on reconnect", async () => {
    await save(); await event(); await buildControlNotificationBatches(prisma, at());
    await event(); await event(); await buildControlNotificationBatches(prisma, at("12:01")); assert.equal((await batches()).length, 1);
    await buildControlNotificationBatches(prisma, at("12:06")); assert.equal((await batches()).length, 2);
    await event(); // Not yet batched: it should be part of the same summary.
    await deliverControlNotifications(prisma, qr(), at("12:10")); assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Сводка накопившихся событий/); assert.match(sent[0].text, /Новые заявки: 4/);
    assert.equal((await batches()).filter(b => b.state === "merged").length, 1);
    await deliverControlNotifications(prisma, qr(), at("12:15")); assert.equal(sent.length, 1);
    assert.equal((await request()).data.rules[0].history.length, 1);
  });
  it("combines due digest and instant notices but keeps tests and uncertain sends separate", async () => {
    const row = await save({ digestTime: "17:00" });
    await event(); await event({ type: "task.assigned" });
    await buildControlNotificationBatches(prisma, at());
    await prisma.controlNotificationBatch.create({ data: { ruleId: row.id, version: row.version, kind: "instant", key: "unknown", state: "uncertain", countsJson: { new_inquiries: 99 } } });
    await prisma.controlNotificationBatch.create({ data: { ruleId: row.id, version: row.version, kind: "test", key: "test", availableAt: at(), createdAt: at() } });
    await Promise.all([deliverControlNotifications(prisma, qr(), at()), deliverControlNotifications(prisma, qr(), at())]);
    assert.equal(sent.length, 2);
    assert.equal(sent.filter(message => message.text.includes("Проверочное сообщение")).length, 1);
    const summary = sent.find(message => message.text.includes("Сводка накопившихся событий"))!;
    assert.match(summary.text, /Новые заявки: 1/); assert.match(summary.text, /Задачи и напоминания: 1/); assert.doesNotMatch(summary.text, /99/);
    await buildControlNotificationBatches(prisma, at("13:00")); await deliverControlNotifications(prisma, qr(), at("13:00")); assert.equal(sent.length, 2);
  });
  it("claims each QR batch once and creates no customer conversation or message", async () => {
    await save(); await event(); await buildControlNotificationBatches(prisma, at());
    const counts = [await prisma.contact.count(), await prisma.conversation.count(), await prisma.message.count()];
    await Promise.all([deliverControlNotifications(prisma, qr(), at()), deliverControlNotifications(prisma, qr(), at())]);
    assert.equal(sent.length, 1); assert.equal(sent[0].to, "77020000002@s.whatsapp.net"); assert.equal((await batches())[0].state, "accepted");
    assert.deepEqual([await prisma.contact.count(), await prisma.conversation.count(), await prisma.message.count()], counts);
  });
  it("holds a due digest until the send interval ends before merging newer fast events", async () => {
    await save({ minIntervalMinutes: 15, digestTime: "17:05" });
    await event(); await buildControlNotificationBatches(prisma, at()); await deliverControlNotifications(prisma, qr(), at());
    assert.equal(sent.length, 1);
    await event(); await event({ type: "task.assigned" });
    await buildControlNotificationBatches(prisma, at("12:05")); await deliverControlNotifications(prisma, qr(), at("12:05"));
    assert.equal(sent.length, 1, "a digest must not bypass the 15-minute interval");
    const delayed = (await batches()).find(batch => batch.kind === "digest")!;
    assert.equal(delayed.error, "send_interval"); assert.equal(delayed.availableAt.toISOString(), at("12:15").toISOString());
    await buildControlNotificationBatches(prisma, at("12:15")); await deliverControlNotifications(prisma, qr(), at("12:15"));
    assert.equal(sent.length, 2); assert.match(sent[1].text, /Новые заявки: 1/); assert.match(sent[1].text, /Задачи и напоминания: 1/);
    await deliverControlNotifications(prisma, qr(), at("12:30")); assert.equal(sent.length, 2);
  });
  it("applies the interval after a standalone digest before sending new fast events", async () => {
    await save({ minIntervalMinutes: 15, digestTime: "17:00" });
    await event({ type: "task.assigned" }); await buildControlNotificationBatches(prisma, at()); await deliverControlNotifications(prisma, qr(), at());
    assert.equal(sent.length, 1); assert.match(sent[0].text, /Ежедневная сводка/);
    await event(); await buildControlNotificationBatches(prisma, at("12:01")); await deliverControlNotifications(prisma, qr(), at("12:01"));
    assert.equal(sent.length, 1);
    await deliverControlNotifications(prisma, qr(), at("12:15")); assert.equal(sent.length, 2);
  });
  it("does not send after a lost QR lease or guess whether a timed-out request was delivered", async () => {
    await save(); await event(); await buildControlNotificationBatches(prisma, at());
    await assert.rejects(() => deliverControlNotifications(prisma, { ...qr(), checkLease: async () => { throw Error("lost lease"); } }, at())); assert.equal(sent.length, 0);
    sendMode = 0; await deliverControlNotifications(prisma, qr(), at()); assert.equal((await batches())[0].state, "uncertain");
    await deliverControlNotifications(prisma, qr(), at("13:00")); assert.equal(sent.length, 1);
  });
  it("drops notices if admin access or the company is suspended before sending", async () => {
    await save(); await event(); await buildControlNotificationBatches(prisma, at());
    await prisma.membership.update({ where: { id: owner.id }, data: { active: false } }); await deliverControlNotifications(prisma, qr(), at());
    assert.equal((await batches())[0].state, "skipped"); assert.equal(sent.length, 0);
    await prisma.membership.update({ where: { id: owner.id }, data: { active: true } }); await event(); await buildControlNotificationBatches(prisma, at("13:00"));
    await prisma.tenant.update({ where: { id: owner.tenantId }, data: { status: "suspended" } }); await deliverControlNotifications(prisma, qr(), at("13:00")); assert.equal(sent.length, 0);
  });
  it("permits explicit tests while paused, deduplicates double clicks, respects quiet hours", async () => {
    const row = await save({ enabled: false, quietHours: { enabled: true, start: "22:00", end: "08:00" } });
    const a = await request(`${endpoint}/${row.id}/test`, "POST"), b = await request(`${endpoint}/${row.id}/test`, "POST"); assert.equal(a.status, 200); assert.equal(a.data.id, b.data.id);
    await prisma.controlNotificationBatch.updateMany({ data: { createdAt: at("18:00"), availableAt: at("18:00") } });
    await deliverControlNotifications(prisma, qr(), at("18:00")); assert.equal(sent.length, 0);
    await deliverControlNotifications(prisma, qr(), new Date(`${nextDay}T03:00:00Z`)); assert.equal(sent.length, 1);
    assert.equal((await prisma.controlNotificationRule.findUniqueOrThrow({ where: { id: row.id } })).enabled, false);
  });
  async function green() {
    await prisma.integration.update({ where: { id: integration.id }, data: { type: "whatsapp_seller", schemaJson: { instanceId: "123456", apiTokenEnc: encryptSecret("private-test-token") } } });
    await save(); await event(); await buildControlNotificationBatches(prisma, at());
  }
  it("sends via Green API and retries only a confirmed rate limit", async () => {
    await green(); sendMode = 429; await deliverControlNotifications(prisma, undefined, at()); assert.equal((await batches())[0].state, "queued");
    await deliverControlNotifications(prisma, undefined, at("12:01")); assert.equal(sent.length, 1);
    sendMode = 200; await deliverControlNotifications(prisma, undefined, at("12:02")); assert.equal((await batches())[0].state, "accepted"); assert.equal(sent[1].to, "77020000002@c.us");
    assert.doesNotMatch(JSON.stringify((await request()).data), /private-test-token|accepted-green/);
  });
  it("does not retry ambiguous Green failures or expose raw provider errors", async () => {
    await green(); sendMode = 500; await deliverControlNotifications(prisma, undefined, at()); assert.equal((await batches())[0].state, "uncertain");
    await deliverControlNotifications(prisma, undefined, at("13:00")); assert.equal(sent.length, 1);
    assert.doesNotMatch(JSON.stringify((await request()).data), /secret-provider-detail|private-test-token/);
  });
  it("fails closed on rejected Green credentials or unsupported hosts", async () => {
    await green(); sendMode = 401; await deliverControlNotifications(prisma, undefined, at()); assert.equal((await batches())[0].state, "failed");
    await prisma.integration.update({ where: { id: integration.id }, data: { schemaJson: { instanceId: "123456", apiTokenEnc: encryptSecret("x"), greenApiHost: "green-api.com.evil.invalid" } } });
    assert.equal((await request(endpoint, "PUT", prefs({ version: 1 }))).status, 422);
  });
  it("expires queued tests even when the QR sender stays disconnected", async () => {
    const row = await save();
    await prisma.integration.update({ where: { id: integration.id }, data: { connectionStatus: "DISCONNECTED" } });
    await prisma.controlNotificationBatch.create({ data: { ruleId: row.id, version: row.version, kind: "test", key: "expired-test", createdAt: new Date(Date.now() - 2 * 86400000) } });
    await processControlNotifications(prisma); assert.equal((await batches())[0].error, "expired"); assert.equal(sent.length, 0);
  });
  it("marks an interrupted in-flight send uncertain without resending", async () => {
    const row = await save(); await prisma.controlNotificationBatch.create({ data: { ruleId: row.id, version: row.version, kind: "instant", key: "crash", state: "sending", claimedAt: new Date(Date.now() - 300000) } });
    await processControlNotifications(prisma); assert.equal((await batches())[0].state, "uncertain"); assert.equal(sent.length, 0);
  });
  it("dispatches a notice through the actual QR runtime owner without an open browser", async () => {
    const row = await save();
    await prisma.whatsAppQrSession.create({ data: { integrationId: integration.id } });
    let socket: any;
    const runtime = startWhatsAppQrRuntime(prisma, (() => { const q = qr(); socket = { ...q.socket, ev: new EventEmitter(), user: { id: "77010000001:1@s.whatsapp.net" }, end() {}, logout: async () => {} }; return socket; }) as any);
    try {
      for (let i = 0; i < 100 && !socket; i++) { await runtime.tick(); await new Promise(r => setTimeout(r, 20)); }
      assert.ok(socket); socket.ev.emit("connection.update", { connection: "open" });
      for (let i = 0; i < 100 && (await prisma.integration.findUniqueOrThrow({ where: { id: integration.id } })).connectionStatus !== "CONNECTED"; i++) await new Promise(r => setTimeout(r, 20));
      assert.equal((await request(`${endpoint}/${row.id}/test`, "POST")).status, 200);
      for (let i = 0; i < 100 && !sent.length; i++) { await runtime.tick(); await new Promise(r => setTimeout(r, 20)); }
      assert.equal(sent.length, 1); assert.equal((await batches())[0].state, "accepted");
    } finally { await runtime.stop(); }
  });
});
