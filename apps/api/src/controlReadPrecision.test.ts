import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createPrismaClient, syncPricingCatalog } from "@creolab/db";
import type { ControlAction } from "@creolab/contracts";
import { authForUserInTenant } from "./services/authService.ts";
import { activateSubscription } from "./services/subscriptionActivationService.ts";
import { upsertControlAccess, executeWebControl, authorizeNativeControl, controlAuthorizationVersion } from "./services/aiControlService.ts";
import { sendControlWebMessage, controlWebHistory } from "./services/controlWebService.ts";
import { mapControlPeriod } from "./services/controlPeriods.ts";

describe("Control exact read queries on isolated data", () => {
  let db: Awaited<ReturnType<typeof createPrismaClient>>;
  const originalFetch = globalThis.fetch;
  before(async () => { db = await createPrismaClient(); await syncPricingCatalog(db); globalThis.fetch = async () => { throw new Error("External services disabled"); }; });
  after(async () => { globalThis.fetch = originalFetch; await db.$disconnect(); });
  async function fixture() {
    const tenant = await db.tenant.create({ data: { name: "Control precision", slug: randomUUID(), timezone: "Asia/Almaty", settingsJson: { control: { enabled: true } } } });
    await activateSubscription(db, { tenantId: tenant.id, planCode: "CRM_START" });
    async function member(name: string, role: string) {
      const user = await db.user.create({ data: { name, email: `${randomUUID()}@example.test`, passwordHash: "unused" } });
      const row = await db.membership.create({ data: { tenantId: tenant.id, userId: user.id, role } });
      const auth = await authForUserInTenant(db, user.id, tenant.id, "control-precision-test");
      const identity = await db.controlIdentity.create({ data: { tenantId: tenant.id, userId: user.id, provider: "CRM_CHAT", externalUserId: user.id, verifiedAt: new Date() } });
      return { ...row, auth, identity };
    }
    const owner = await member("Owner", "owner"), manager = await member("Manager", "manager");
    for (const m of [owner, manager]) await upsertControlAccess(db, owner.auth, m.userId, { enabled: true, allowedSources: ["CRM_CHAT"], canReadFinancialData: true, canReadTeamData: true, canCreateTasks: true });
    const contact = await db.contact.create({ data: { tenantId: tenant.id, name: "Test client" } });
    await db.contactMethod.create({ data: { tenantId: tenant.id, contactId: contact.id, type: "phone", rawValue: "+77011112233", normalizedValue: "+77011112233", source: "manual" } });
    const stage = await db.dealStage.create({ data: { tenantId: tenant.id, name: "New", systemKey: "new", sortOrder: 1 } });
    const task = (title: string, data: Record<string, unknown> = {}) => db.task.create({ data: { tenantId: tenant.id, title, type: "other", contactId: contact.id, ...data } });
    const execute = async (action: ControlAction, params: Record<string, unknown> = {}, actor = owner) => executeWebControl(db, actor.auth, actor.identity.id, action, params, randomUUID()) as Promise<any>;
    const send = async (text: string) => (await sendControlWebMessage(db, owner.auth, { text, requestId: randomUUID() })).items.at(-1)!;
    return { tenant, owner, manager, contact, stage, task, execute, send };
  }
  it("counts all matching tasks before limiting details and searches beyond the previous 100-row window", async () => {
    const f = await fixture(), yesterday = new Date(Date.now() - 86400000);
    await db.task.createMany({ data: Array.from({ length: 121 }, (_, i) => ({ tenantId: f.tenant.id, title: `Task ${i}`, type: "other", contactId: f.contact.id, ownerMembershipId: f.owner.id, dueAt: yesterday, status: i % 2 ? "waiting" : "in_progress" })) });
    await f.task("Done must not count", { status: "done", dueAt: yesterday });
    await f.task("Cancelled must not count", { status: "canceled", dueAt: yesterday });
    const parent = await f.task("Undated parent", { ownerMembershipId: f.manager.id });
    await f.task("Child must not duplicate parent", { parentTaskId: parent.id, dueAt: yesterday });
    const target = await f.task("Unique needle", { ownerMembershipId: f.owner.id });
    const overdue = await f.execute("GET_OVERDUE_TASKS");
    assert.equal(overdue.data.total, 121); assert.equal(overdue.data.items.length, 50); assert.equal(overdue.data.hasMore, true);
    assert.match(overdue.data.items[0].phone, /77011112233/);
    const found = await f.execute("GET_TASKS", { query: "Unique needle" });
    assert.equal(found.data.total, 1); assert.equal(found.data.items[0].id, target.id);
    assert.equal((await f.execute("GET_TASKS")).data.total, 123);
    assert.equal((await f.execute("GET_TASKS", { taskStatus: "completed" })).data.total, 1);
    const reply = await f.send("Покажи просроченные задачи моей команды");
    assert.match(reply.reply, /Найдено: 121. Показано: 8/);
  });
  it("keeps mine, team, named owner and role boundaries separate", async () => {
    const f = await fixture(), other = await fixture();
    const own = await f.task("Owner task", { ownerMembershipId: f.owner.id });
    const managerTask = await f.task("Manager task", { ownerMembershipId: f.manager.id });
    await other.task("Foreign secret", { ownerMembershipId: other.owner.id });
    assert.deepEqual((await f.execute("GET_TASKS", { scope: "mine" })).data.items.map((r: any) => r.id), [own.id]);
    assert.equal((await f.execute("GET_TASKS", { scope: "team" })).data.total, 2);
    assert.deepEqual((await f.execute("GET_TASKS", { ownerMembershipId: f.manager.id })).data.items.map((r: any) => r.id), [managerTask.id]);
    assert.deepEqual((await f.execute("GET_TASKS", {}, f.manager)).data.items.map((r: any) => r.id), [managerTask.id]);
    await assert.rejects(f.execute("GET_TASKS", { scope: "team" }, f.manager), /Нет права/);
    await assert.rejects(f.execute("GET_TASKS", { ownerMembershipId: other.owner.id }), /Сотрудник не найден/);
    await assert.rejects(f.execute("GET_TASKS", { scope: "mine", ownerMembershipId: f.manager.id }), /Уточните/);
    await upsertControlAccess(db, f.owner.auth, f.owner.userId, { canReadTeamData: false });
    await assert.rejects(f.execute("GET_TASKS", { scope: "team" }), /Нет права/);
    await assert.rejects(f.execute("GET_TASKS", { ownerMembershipId: f.manager.id }), /Нет права/);
    assert.equal((await f.execute("GET_TASKS", { scope: "mine" })).data.total, 1);
  });
  it("uses task due dates and excludes other days and undated tasks from today", async () => {
    const f = await fixture(), p = mapControlPeriod({ period: "today" }, "Asia/Almaty");
    const today = await f.task("Today", { ownerMembershipId: f.owner.id, dueAt: new Date(p.from!.getTime() + 1) });
    await f.task("Tomorrow", { ownerMembershipId: f.owner.id, dueAt: p.to });
    await f.task("Yesterday", { ownerMembershipId: f.owner.id, dueAt: new Date(p.from!.getTime() - 1) });
    await f.task("Undated", { ownerMembershipId: f.owner.id });
    await f.task("Done today", { ownerMembershipId: f.owner.id, dueAt: p.from, status: "done" });
    const result = await f.execute("GET_TODAY_TASKS", { scope: "mine" });
    assert.equal(result.data.remaining, 1); assert.equal(result.data.nearest[0].id, today.id);
    assert.equal(result.meta.dateFrom, p.dateFrom); assert.equal(result.meta.timeZone, "Asia/Almaty");
    const yesterday = await f.execute("GET_TASKS", { period: "yesterday" });
    assert.equal(yesterday.data.total, 1); assert.equal(yesterday.data.items[0].title, "Yesterday");
    await assert.rejects(f.execute("GET_TODAY_TASKS", { period: "last_week" }), /другого периода/);
    await assert.rejects(f.execute("GET_TASKS", { period: "nonsense" }), /Уточните период/);
  });
  it("filters completed tasks by completion time rather than their old deadlines", async () => {
    const f = await fixture(), p = mapControlPeriod({ period: "today" }, "Asia/Almaty");
    const completed = await f.task("Finished today, due yesterday", { status: "done", dueAt: new Date(p.from!.getTime() - 1), completedAt: p.from });
    await f.task("Due today but finished yesterday", { status: "done", dueAt: p.from, completedAt: new Date(p.from!.getTime() - 1) });
    await f.task("Completion date unknown", { status: "done", dueAt: p.from });
    const result = await f.execute("GET_TASKS", { taskStatus: "completed", period: "today" });
    assert.equal(result.data.total, 1); assert.equal(result.data.items[0].id, completed.id);
    const reply = await f.send("Завершённые задачи за сегодня");
    assert.match(reply.reply, /Finished today, due yesterday/); assert.doesNotMatch(reply.reply, /Due today but finished yesterday|Completion date unknown/);
    assert.match(reply.reply, /дате завершения/);
  });
  it("finds client tasks through inquiry, deal and conversation links without including another client's work", async () => {
    const f = await fixture(), other = await fixture();
    const inquiry = await db.inquiry.create({ data: { tenantId: f.tenant.id, contactId: f.contact.id, source: "manual" } });
    const deal = await db.deal.create({ data: { tenantId: f.tenant.id, contactId: f.contact.id, stageId: f.stage.id, title: "Related deal" } });
    const conversation = await db.conversation.create({ data: { tenantId: f.tenant.id, contactId: f.contact.id } });
    const foreign = await db.conversation.create({ data: { tenantId: other.tenant.id, contactId: other.contact.id } });
    const expected = [];
    for (const link of [{ contactId: f.contact.id }, { inquiryId: inquiry.id }, { dealId: deal.id }, { conversationId: conversation.id }]) {
      expected.push((await f.task("Linked client task", { contactId: null, ...link })).id);
    }
    await f.task("No client", { contactId: null });
    await f.task("Invalid foreign conversation reference", { contactId: null, conversationId: foreign.id });
    const result = await f.execute("GET_TASKS", { clientId: f.contact.id });
    assert.equal(result.data.total, 4);
    assert.deepEqual(result.data.items.map((row: any) => row.id).sort(), expected.sort());
    assert.ok(result.data.items.every((row: any) => row.contactName === f.contact.name));
  });
  it("finds the intersection of received-today and still-unanswered leads with complete totals", async () => {
    const f = await fixture(), p = mapControlPeriod({ period: "today" }, "Asia/Almaty");
    await db.inquiry.createMany({ data: Array.from({ length: 35 }, (_, i) => ({ tenantId: f.tenant.id, contactId: f.contact.id, source: "manual", subject: `Unanswered ${i}`, receivedAt: p.from!, needsReply: true, assigneeMembershipId: f.owner.id })) });
    for (const data of [{ receivedAt: new Date(p.from!.getTime() - 1) }, { receivedAt: p.to! }, { needsReply: false }, { archived: true }, { status: "lost" }]) {
      await db.inquiry.create({ data: { tenantId: f.tenant.id, contactId: f.contact.id, source: "manual", subject: "Excluded", receivedAt: p.from!, needsReply: true, ...data } });
    }
    const result = await f.execute("GET_RECENT_LEADS", { period: "today", leadFilter: "needs_reply" });
    assert.equal(result.data.total, 35); assert.equal(result.data.items.length, 30); assert.equal(result.data.hasMore, true);
    assert.ok(result.data.items.every((r: any) => r.subject.startsWith("Unanswered")));
    const reply = await f.send("Какие заявки сегодня остались без ответа?");
    assert.deepEqual(reply.actions, ["GET_RECENT_LEADS"]); assert.match(reply.reply, /Найдено: 35. Показано: 8/);
    assert.match(reply.reply, /сейчас ожидают ответа/);
  });
  it("applies creation periods to recent deals and does not reveal financial fields without access", async () => {
    const f = await fixture(), p = mapControlPeriod({ period: "this_week" }, "Asia/Almaty");
    for (const [title, createdAt] of [["In period", p.from!], ["Earlier", new Date(p.from!.getTime() - 1)], ["Next week", p.to!]] as const) {
      await db.deal.create({ data: { tenantId: f.tenant.id, contactId: f.contact.id, stageId: f.stage.id, title, createdAt, offerAmountMinor: 10000 } });
    }
    await upsertControlAccess(db, f.owner.auth, f.owner.userId, { canReadFinancialData: false });
    const result = await f.execute("GET_RECENT_DEALS", { period: "this_week" });
    assert.equal(result.data.total, 1); assert.equal(result.data.items[0].title, "In period");
    assert.equal(result.data.items[0].amountMinor, undefined); assert.equal(result.data.items[0].paymentStatus, undefined);
  });
  it("returns monthly sales by closing dates with exact timezone boundaries and preserves them in follow-ups", async () => {
    const f = await fixture(), p = mapControlPeriod({ period: "this_month" }, "Asia/Almaty");
    for (const [title, closedAt, wonAmountMinor] of [["Won this month", p.from!, 17500], ["Won last month", new Date(p.from!.getTime() - 1), 900], ["Next month boundary", p.to!, 60000]] as const) {
      await db.deal.create({ data: { tenantId: f.tenant.id, contactId: f.contact.id, stageId: f.stage.id, title, outcome: "won", createdAt: new Date(p.from!.getTime() - 86400000), closedAt, offerAmountMinor: 99999, wonAmountMinor } });
    }
    const result = await f.execute("GET_DEALS_STATS", { period: "this_month" });
    assert.equal(result.data.won, 1); assert.equal(result.data.revenue, 17500);
    assert.equal(result.data.created, 0, "A previous-month lead can close this month");
    assert.equal(result.meta.dateFrom, p.dateFrom); assert.equal(result.meta.dateTo, p.dateTo);
    const reply = await f.send("Подготовь отчёт по продажам за текущий месяц");
    assert.deepEqual(reply.actions, ["GET_DEALS_STATS"]); assert.match(reply.reply, /17\s500/);
    assert.match(reply.reply, /Подтверждённые оплаты: 0 ₸/);
    assert.match(reply.reply, /Продажи — по дате закрытия сделки/);
    assert.match(reply.reply, /Оплаты — по дате подтверждения платежа/);
    const previous = await f.send("А за прошлый месяц?");
    assert.match(previous.reply, /900 ₸/); assert.doesNotMatch(previous.reply, /17\s500/);
  });
  it("continues the previous read by period while retaining scope and rechecking revoked access", async () => {
    const f = await fixture(), p = mapControlPeriod({ period: "today" }, "Asia/Almaty");
    await f.task("Owner previous day", { ownerMembershipId: f.owner.id, dueAt: new Date(p.from!.getTime() - 1) });
    await f.task("Manager previous day", { ownerMembershipId: f.manager.id, dueAt: new Date(p.from!.getTime() - 1) });
    assert.match((await f.send("А за вчера?")).reply, /Для какого списка/);
    await f.send("Мои задачи на сегодня");
    const followup = await f.send("А за вчера?");
    assert.match(followup.reply, /Owner previous day/); assert.doesNotMatch(followup.reply, /Manager previous day/);
    assert.deepEqual(followup.actions, ["GET_TASKS"]);
    await f.send("Просроченные задачи моей команды");
    await upsertControlAccess(db, f.owner.auth, f.owner.userId, { canReadTeamData: false });
    const revoked = await f.send("А за эту неделю?");
    assert.doesNotMatch(revoked.reply, /Manager previous day/); assert.match(revoked.reply, /Для какого списка|Нет права/);
    assert.equal(await db.message.count({ where: { tenantId: f.tenant.id } }), 0);
  });
  it("hides historical WhatsApp team results after access changes", async () => {
    const f = await fixture();
    const integration = await db.integration.create({ data: { tenantId: f.tenant.id, type: "whatsapp_qr", name: "Isolated", status: "active" } });
    await upsertControlAccess(db, f.owner.auth, f.owner.userId, { allowedSources: ["CRM_CHAT", "WHATSAPP"] });
    const identity = await db.controlIdentity.create({ data: { tenantId: f.tenant.id, userId: f.owner.userId, provider: "WHATSAPP", externalUserId: randomUUID(), verifiedAt: new Date(), metadata: { chat: { enabled: true, integrationId: integration.id } } } });
    const version = controlAuthorizationVersion(await authorizeNativeControl(db, integration.id, identity.id));
    const entry = await db.controlChatMessage.create({ data: { tenantId: f.tenant.id, identityId: identity.id, integrationId: integration.id, eventKey: randomUUID(), text: "Team tasks", replyText: "Private staff results", state: "sent", actionsJson: ["GET_TASKS"], accessVersion: version } });
    assert.ok((await controlWebHistory(db, f.owner.auth)).items.some(row => row.id === entry.id));
    await upsertControlAccess(db, f.owner.auth, f.owner.userId, { canReadTeamData: false });
    assert.ok(!(await controlWebHistory(db, f.owner.auth)).items.some(row => row.id === entry.id));
  });
});
