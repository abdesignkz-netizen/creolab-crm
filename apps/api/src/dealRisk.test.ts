import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { DEFAULT_PROCESS_CALENDAR } from "@creolab/contracts";
import type { AuthContext } from "./lib/types.ts";
import { getSalesControl } from "./services/salesControlService.ts";
import { acceptDealRiskTask } from "./services/dealRiskService.ts";
import { quickControlCommand } from "./services/controlChatLanguage.ts";
import { presentSalesControl } from "./services/controlSalesRiskPresentation.ts";

describe("evidence-based deal risks and confirmed next steps", () => {
  let db: Awaited<ReturnType<typeof createPrismaClient>>;
  before(async () => { db = await createPrismaClient(); });
  after(async () => { await db.$disconnect(); });
  async function fixture() {
    const tenant = await db.tenant.create({ data: { name: "Risk test", slug: randomUUID(), timezone: "Asia/Almaty" } });
    const user = await db.user.create({ data: { name: "Owner", email: `${randomUUID()}@example.test`, passwordHash: "unused" } });
    const member = await db.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: "owner" }, include: { tenant: true } });
    const auth = { user, activeMembership: member, memberships: [member] } as unknown as AuthContext;
    const contact = await db.contact.create({ data: { tenantId: tenant.id, name: "Айбек", ownerMembershipId: member.id } });
    const stage = await db.dealStage.create({ data: { tenantId: tenant.id, systemKey: "new", name: "Новая", sortOrder: 1 } });
    const deal = await db.deal.create({ data: { tenantId: tenant.id, contactId: contact.id, stageId: stage.id, title: "Презентация", assigneeMembershipId: member.id } });
    const report = () => getSalesControl(db, auth);
    const risk = async () => (await report()).items.find(d => d.id === deal.id)!.risk;
    const taskInput = async () => { const r = await risk(), rec = r.recommendation!; return { confirmed: true as const, fingerprint: r.fingerprint, title: rec.title, dueAt: rec.dueAt!, ownerMembershipId: rec.ownerMembershipId! }; };
    return { tenant, user, member, auth, contact, stage, deal, report, risk, taskInput };
  }
  const future = () => new Date(Date.now() + 86400000), past = () => new Date(Date.now() - 86400000);
  it("covers risk after the 200th deal, filters globally and pages without gaps or changing totals", async () => {
    const f = await fixture();
    await db.deal.update({ where: { id: f.deal.id }, data: { nextAction: "Позвонить", nextActionAt: future() } });
    await db.deal.createMany({ data: Array.from({ length: 200 }, (_, i) => ({
      id: `a0-${String(i).padStart(4, "0")}-${f.tenant.id}`, tenantId: f.tenant.id, contactId: f.contact.id, stageId: f.stage.id,
      assigneeMembershipId: f.member.id, title: `Planned ${i}`, nextAction: "Позвонить", nextActionAt: future(),
    })) });
    const late = await db.deal.create({ data: { id: `zz-${f.tenant.id}`, tenantId: f.tenant.id, contactId: f.contact.id, stageId: f.stage.id,
      assigneeMembershipId: f.member.id, title: "Risk outside the first batch", nextAction: "Перезвонить", nextActionAt: past() } });
    const first = await getSalesControl(db, f.auth, { limit: 100 });
    assert.equal(first.items[0].id, late.id); assert.equal(first.summary.active, 202);
    assert.equal(first.summary.urgent, 1); assert.equal(first.summary.needsAttention, 1);
    assert.deepEqual(first.coverage, { total: 202, checked: 202, complete: true, checkedAt: first.checkedAt });
    assert.equal(first.pagination.total, 202); assert.equal(first.pagination.hasMore, true);
    const second = await getSalesControl(db, f.auth, { offset: 100, limit: 100 });
    const third = await getSalesControl(db, f.auth, { offset: 200, limit: 100 });
    assert.equal(new Set([...first.items, ...second.items, ...third.items].map(i => i.id)).size, 202);
    assert.equal(third.items.length, 2); assert.equal(third.pagination.hasMore, false);
    assert.deepEqual(third.summary, first.summary);
    const urgent = await getSalesControl(db, f.auth, { filter: "urgent", limit: 1 });
    assert.equal(urgent.pagination.total, 1); assert.equal(urgent.items[0].id, late.id); assert.deepEqual(urgent.summary, first.summary);
    const noMatches = await getSalesControl(db, f.auth, { filter: "ready" });
    assert.equal(noMatches.pagination.total, 0); assert.equal(noMatches.items.length, 0); assert.equal(noMatches.coverage.checked, 202);
    await assert.rejects(getSalesControl(db, f.auth, { offset: -1 }));
    await assert.rejects(getSalesControl(db, f.auth, { filter: "invalid" }));
  });
  it("proposes a dated step without changing any CRM state on read", async () => {
    const f = await fixture(), before = await db.deal.findUniqueOrThrow({ where: { id: f.deal.id } });
    const report = await f.report(), r = report.items[0].risk;
    assert.equal(r.priority, "attention"); assert.equal(r.signals[0].code, "step_missing");
    assert.equal(r.recommendation?.kind, "create_task"); assert.equal(r.recommendation?.ownerMembershipId, f.member.id);
    assert.equal(r.recommendation?.deadlineBasis, "suggested"); assert.ok(new Date(r.recommendation!.dueAt!) > new Date());
    assert.equal((await f.risk()).fingerprint, r.fingerprint, "checkedAt must not invalidate a confirmation");
    assert.equal(await db.task.count({ where: { dealId: f.deal.id } }), 0);
    assert.equal(await db.activity.count({ where: { dealId: f.deal.id } }), 0);
    assert.equal(await db.outboxEvent.count({ where: { tenantId: f.tenant.id } }), 0);
    assert.deepEqual(await db.deal.findUniqueOrThrow({ where: { id: f.deal.id } }), before);
  });
  it("honors a real scheduled step and never flags a paid invoice by its old date", async () => {
    const f = await fixture();
    await db.deal.update({ where: { id: f.deal.id }, data: { nextAction: "Обсудить проект", nextActionAt: future() } });
    await db.invoice.create({ data: { tenantId: f.tenant.id, dealId: f.deal.id, number: randomUUID(), status: "PAID", dueDate: past(), amountWithoutVat: 100, vatAmount: 0, totalAmount: 100 } });
    const r = await f.risk(); assert.equal(r.priority, "clear"); assert.deepEqual(r.signals, []); assert.equal(r.recommendation, null);
  });
  it("distinguishes overdue unpaid invoices from paid and cancelled invoices", async () => {
    const f = await fixture();
    await db.deal.update({ where: { id: f.deal.id }, data: { nextAction: "Проверить результат", nextActionAt: future() } });
    const invoice = await db.invoice.create({ data: { tenantId: f.tenant.id, dealId: f.deal.id, number: randomUUID(), status: "PARTIALLY_PAID", dueDate: past(), amountWithoutVat: 100, vatAmount: 0, totalAmount: 100 } });
    assert.equal((await f.risk()).signals[0].code, "payment_check");
    await db.invoice.update({ where: { id: invoice.id }, data: { status: "CANCELLED" } });
    assert.equal((await f.risk()).signals.some(s => s.code === "payment_check"), false);
  });
  it("uses delivered replies in the linked thread, not stale waiting flags or drafts", async () => {
    const f = await fixture();
    await db.deal.update({ where: { id: f.deal.id }, data: { nextAction: "Обсудить проект", nextActionAt: future() } });
    const conversation = await db.conversation.create({ data: { tenantId: f.tenant.id, contactId: f.contact.id, mode: "human", waitingFor: "MANAGER" } });
    await db.dealConversation.create({ data: { tenantId: f.tenant.id, dealId: f.deal.id, conversationId: conversation.id } });
    await db.message.create({ data: { tenantId: f.tenant.id, conversationId: conversation.id, direction: "inbound", senderKind: "client", text: "Когда обсудим?", createdAt: new Date(Date.now() - 3600000) } });
    let r = await f.risk(); assert.equal(r.priority, "urgent"); assert.equal(r.recommendation?.kind, "conversation");
    const outbound = await db.message.create({ data: { tenantId: f.tenant.id, conversationId: conversation.id, direction: "outbound", senderKind: "agent", text: "Ответ", operationState: "failed", createdAt: new Date(Date.now() - 60000) } });
    assert.equal((await f.risk()).signals[0].code, "reply_waiting");
    await db.message.update({ where: { id: outbound.id }, data: { operationState: "sent", internal: true } });
    assert.equal((await f.risk()).signals[0].code, "reply_waiting");
    await db.message.update({ where: { id: outbound.id }, data: { internal: false } });
    assert.equal((await f.risk()).priority, "clear", "accepted response wins over stale waitingFor");
  });
  it("opens an existing uncertain task and preserves manual execution and deadlines", async () => {
    const f = await fixture();
    const task = await db.task.create({ data: { tenantId: f.tenant.id, dealId: f.deal.id, ownerMembershipId: f.member.id, type: "follow_up", title: "Не повторять отправку", status: "in_progress", executionStatus: "unknown", dueAt: past() } });
    const r = await f.risk(); assert.equal(r.signals[0].code, "execution_uncertain");
    assert.equal(r.recommendation?.href, `/tasks?open=${task.id}`); assert.equal(r.recommendation?.title, task.title);
    assert.equal(r.recommendation?.canCreate, false); assert.equal(r.recommendation?.deadlineBasis, "existing");
    assert.deepEqual(await db.task.findUniqueOrThrow({ where: { id: task.id } }), task);
  });
  it("creates once after explicit confirmation with client/deal links, author and audit", async () => {
    const f = await fixture(), input = await f.taskInput();
    await assert.rejects(acceptDealRiskTask(db, f.auth, f.deal.id, { ...input, confirmed: false }));
    const results = await Promise.all([acceptDealRiskTask(db, f.auth, f.deal.id, input), acceptDealRiskTask(db, f.auth, f.deal.id, input)]);
    assert.equal(results[0].id, results[1].id); assert.equal(results.filter(r => !r.reused).length, 1);
    const task = await db.task.findUniqueOrThrow({ where: { id: results[0].id } });
    assert.equal(task.contactId, f.contact.id); assert.equal(task.dealId, f.deal.id); assert.equal(task.ownerMembershipId, f.member.id); assert.equal(task.source, "control");
    assert.equal(await db.task.count({ where: { dealId: f.deal.id } }), 1);
    const events = await db.activity.findMany({ where: { dealId: f.deal.id, type: "task.created" } });
    assert.equal(events.length, 1); assert.equal(events[0].actorId, f.user.id); assert.equal((events[0].metadataJson as any).taskId, task.id);
    assert.equal(await db.auditEvent.count({ where: { tenantId: f.tenant.id, entityId: task.id, action: "task.created" } }), 1);
    assert.equal(await db.outboxEvent.count({ where: { tenantId: f.tenant.id } }), 0, "confirmation creates staff work, no external send");
    const history = (await f.report()).items[0].history;
    assert.equal(history.length, 1); assert.equal(history[0].description, task.title);
    assert.equal(history[0].reason, "Нет следующего действия");
    await assert.rejects(acceptDealRiskTask(db, f.auth, f.deal.id, { ...input, title: "Другая задача" }), /другими параметрами/);
    await db.task.update({ where: { id: task.id }, data: { status: "done" } });
    assert.equal((await acceptDealRiskTask(db, f.auth, f.deal.id, input)).reused, true);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status, "done");
    assert.equal((await f.report()).items[0].history.length, 1, "completing a task does not hide its creation history");
    const nextInput = await f.taskInput();
    assert.notEqual(nextInput.fingerprint, input.fingerprint, "a new planning cycle must not replay the completed step");
    assert.equal((await f.report()).items[0].nextAction, null, "a finished task is not a pending next action");
    const next = await acceptDealRiskTask(db, f.auth, f.deal.id, { ...nextInput, title: "Уточнить следующий этап" });
    assert.notEqual(next.id, task.id);
    assert.equal(await db.task.count({ where: { dealId: f.deal.id, status: "open" } }), 1);
    assert.equal((await acceptDealRiskTask(db, f.auth, f.deal.id, input)).id, task.id, "a retry cannot reopen the previous cycle");
  });
  for (const change of ["task", "manual_step", "closed", "inactive_owner", "calendar", "timezone"] as const) it(`rejects a stale recommendation after ${change}`, async () => {
    const f = await fixture(), input = await f.taskInput();
    if (change === "task") await db.task.create({ data: { tenantId: f.tenant.id, dealId: f.deal.id, type: "follow_up", title: "Уже запланировано", dueAt: future() } });
    if (change === "manual_step") await db.deal.update({ where: { id: f.deal.id }, data: { nextAction: "Ручной шаг", nextActionAt: future() } });
    if (change === "closed") await db.deal.update({ where: { id: f.deal.id }, data: { outcome: "won" } });
    if (change === "inactive_owner") await db.membership.update({ where: { id: f.member.id }, data: { active: false } });
    if (change === "calendar") await db.tenant.update({ where: { id: f.tenant.id }, data: { settingsJson: { ops: { processCalendar: { ...DEFAULT_PROCESS_CALENDAR, mode: "business" } } } } });
    if (change === "timezone") await db.tenant.update({ where: { id: f.tenant.id }, data: { timezone: "Europe/Berlin" } });
    await assert.rejects(acceptDealRiskTask(db, f.auth, f.deal.id, input), /Ситуация изменилась/);
    assert.equal(await db.task.count({ where: { dealId: f.deal.id, source: "control" } }), 0);
  });
  it("protects tenant scope, staff permissions and private task evidence", async () => {
    const f = await fixture(), foreign = await fixture(), input = await f.taskInput();
    await assert.rejects(acceptDealRiskTask(db, foreign.auth, f.deal.id, input), /Сделка не найдена/);
    await assert.rejects(acceptDealRiskTask(db, f.auth, f.deal.id, { ...input, ownerMembershipId: foreign.member.id }), /сотрудника компании/);
    const user = await db.user.create({ data: { name: "Manager", email: `${randomUUID()}@example.test`, passwordHash: "unused" } });
    const member = await db.membership.create({ data: { tenantId: f.tenant.id, userId: user.id, role: "manager" }, include: { tenant: true } });
    const manager = { user, activeMembership: member, memberships: [member] } as unknown as AuthContext;
    await db.deal.update({ where: { id: f.deal.id }, data: { assigneeMembershipId: member.id } });
    const secret = await db.task.create({ data: { tenantId: f.tenant.id, dealId: f.deal.id, type: "other", ownerMembershipId: f.member.id, title: "Private task title", dueAt: past() } });
    await db.activity.create({ data: { tenantId: f.tenant.id, dealId: f.deal.id, contactId: f.contact.id, type: "task.created", title: "Private task title", actorType: "user", metadataJson: { taskId: secret.id, fingerprint: input.fingerprint } } });
    const report = await getSalesControl(db, manager), item = report.items[0];
    assert.equal(item.id, f.deal.id); assert.equal(item.risk.recommendation?.kind, "deal");
    assert.doesNotMatch(JSON.stringify(item.risk), new RegExp(`${secret.id}|Private task title`));
    assert.equal(item.nextAction, null); assert.equal(item.risk.recommendation?.canCreate, false); assert.equal(report.riskAssignees.length, 0);
    assert.equal(item.history.length, 0);
    assert.equal(report.items.some(d => d.id === foreign.deal.id), false);
    await assert.rejects(acceptDealRiskTask(db, manager, f.deal.id, input), /Недостаточно прав/);
  });
  it("requires a future valid date and an active responsible person", async t => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-29T12:00:00+05:00") });
    const f = await fixture(), input = await f.taskInput();
    for (const dueAt of [past().toISOString(), new Date(Date.now() + 400 * 86400000).toISOString(), "2027-02-30T12:00", "not-a-date"]) {
      await assert.rejects(acceptDealRiskTask(db, f.auth, f.deal.id, { ...input, dueAt }));
    }
    await db.deal.update({ where: { id: f.deal.id }, data: { assigneeMembershipId: null } });
    const r = await f.risk(); assert.equal(r.signals[0].code, "owner_missing");
    assert.equal(r.recommendation?.kind, "deal"); assert.equal(r.recommendation?.canCreate, false);
    assert.equal(r.recommendation?.ownerMembershipId, null);
    assert.equal(await db.task.count({ where: { dealId: f.deal.id } }), 0);
  });
  it("calculates suggested deadlines and stage thresholds using the company calendar", async t => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-23T16:00:00+05:00") });
    const f = await fixture();
    await db.tenant.update({ where: { id: f.tenant.id }, data: { settingsJson: {
      aiAutomation: { salesProcess: { nextStepHours: 2 } }, ops: { processCalendar: { ...DEFAULT_PROCESS_CALENDAR, mode: "business", end: "17:00", excludedDates: ["2026-10-26"] } },
    } } });
    const input = await f.taskInput(); assert.equal(input.dueAt, new Date("2026-10-27T10:00:00+05:00").toISOString());
    const saved = await acceptDealRiskTask(db, f.auth, f.deal.id, { ...input, dueAt: "2026-10-27T12:00" });
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: saved.id } })).dueAt!.toISOString(), "2026-10-27T07:00:00.000Z");
    const p = await fixture();
    await db.deal.update({ where: { id: p.deal.id }, data: { nextAction: "Уточнить", nextActionAt: future(), stageEnteredAt: new Date("2026-10-23T09:00:00+05:00") } });
    await db.tenant.update({ where: { id: p.tenant.id }, data: { settingsJson: { ops: { stageSlaDays: { new: 1 }, processCalendar: { ...DEFAULT_PROCESS_CALENDAR, mode: "business", end: "17:00" } } } } });
    t.mock.timers.tick(2 * 86400000);
    assert.equal((await p.risk()).signals.some(s => s.code === "stage_overdue"), false, "weekend is not two working days");
  });
  it("does not apply contact activity from another order to an unanswered proposal", async () => {
    const f = await fixture();
    await db.dealStage.update({ where: { id: f.stage.id }, data: { systemKey: "proposal_sent" } });
    await db.deal.update({ where: { id: f.deal.id }, data: { stageEnteredAt: new Date(Date.now() - 5 * 86400000) } });
    await db.contact.update({ where: { id: f.contact.id }, data: { lastInboundMessageAt: new Date(), lastOutboundMessageAt: new Date() } });
    assert.ok((await f.risk()).signals.some(s => s.code === "proposal_unanswered"));
    assert.equal((await f.risk()).recommendation?.reason, "proposal_unanswered", "recommend a concrete follow-up before a generic next step");
    await db.task.create({ data: { tenantId: f.tenant.id, dealId: f.deal.id, type: "follow_up", title: "Согласованный контакт", dueAt: future() } });
    assert.equal((await f.risk()).signals.some(s => s.code === "proposal_unanswered"), false);
  });
  it("keeps paused deals out of overdue automation and excludes test inquiries", async () => {
    const f = await fixture();
    await db.deal.update({ where: { id: f.deal.id }, data: { outcome: "on_hold", nextAction: "Пауза", nextActionAt: past() } });
    let r = await f.risk(); assert.equal(r.priority, "on_hold"); assert.deepEqual(r.signals.map(s => s.code), ["on_hold"]); assert.equal(r.recommendation?.kind, "deal");
    await db.inquiry.create({ data: { tenantId: f.tenant.id, contactId: f.contact.id, source: "form", status: "converted", test: true, dealId: f.deal.id } });
    assert.equal((await f.report()).total, 0);
  });
  it("recognizes direct risk commands and keeps bounded RU/KK evidence, owner and deadline", async () => {
    for (const text of ["Риски сделок", "Покажи сделки под риском", "Какие сделки под риском?", "Что делать по сделкам", "Мәміле тәуекелдері", "Тәуекелдегі мәмілелер"]) {
      assert.deepEqual(quickControlCommand(text), { action: "GET_SALES_CONTROL", salesFilter: "attention" });
    }
    assert.equal(quickControlCommand("Риски сделок и удали все задачи"), null);
    const f = await fixture(), data = await f.report();
    for (const lang of ["ru", "kk"] as const) {
      const reply = presentSalesControl({ ...data, filter: "attention", items: Array(20).fill(data.items[0]) }, lang, "Asia/Almaty", path => `https://example.test${path}`);
      assert.ok(reply.length < 3500); assert.match(reply, /Owner/); assert.match(reply, /Asia\/Almaty/);
      assert.match(reply, lang === "ru" ? /Предлагаемый срок/ : /Ұсынылатын мерзім/);
      assert.ok(reply.endsWith("https://example.test/control?view=sales&filter=attention"));
    }
  });
});
