import assert from "node:assert/strict";
import { before, after, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { createPrismaClient } from "@creolab/db";
import { parseSalesProcess, salesProcessPrompt, AI_MANAGER_GOALS, DEFAULT_PROCESS_CALENDAR } from "@creolab/contracts";
import type { AuthContext } from "./lib/types.ts";
import { analyzeConversationContext } from "./services/conversationContextService.ts";
import { applyAnalyzedConversation } from "./services/conversationContextApplyService.ts";
import { ensureSalesNextTask, reviewSalesProposal } from "./services/salesProcessService.ts";
import { getSalesControl, reconcileSalesDeal, sweepSalesProcesses } from "./services/salesControlService.ts";
import { addPayment } from "./services/domainService.ts";
import { convertInquiryToDeal } from "./services/inquiryService.ts";
import { getPublishedTenantAiContext } from "./services/tenantAiConfigService.ts";
import { quickControlCommand } from "./services/controlChatLanguage.ts";
import { getAIAutomationSettings, updateAIAutomationSettings } from "./services/aiAutomationSettingsService.ts";
import { changeDealStage, markDealWon, markDealLost } from "./services/dealService.ts";

describe("configurable sales process", () => {
  let db: Awaited<ReturnType<typeof createPrismaClient>>;
  before(async () => { db = await createPrismaClient(); });
  after(async () => { await db.$disconnect(); });
  async function fixture(options: { mode?: string; aiMode?: string; crm?: boolean; conversationMode?: string; human?: boolean } = {}) {
    const settings = { aiAutomation: { defaultMode: options.aiMode || "AUTO", crm: { enabled: options.crm !== false }, salesProcess: { mode: options.mode || "auto", notifyResponsible: false } } };
    const tenant = await db.tenant.create({ data: { name: "Sales test", slug: randomUUID(), settingsJson: settings, timezone: "Asia/Almaty" } });
    const user = await db.user.create({ data: { name: "Owner", email: `${randomUUID()}@example.test`, passwordHash: "unused" } });
    const member = await db.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: "owner" }, include: { tenant: true } });
    const auth = { user, activeMembership: member, memberships: [member] } as unknown as AuthContext;
    const contact = await db.contact.create({ data: { tenantId: tenant.id, name: "Айбек", ownerMembershipId: member.id } });
    await db.contactMethod.create({ data: { tenantId: tenant.id, contactId: contact.id, type: "phone", rawValue: "+77001234567", normalizedValue: "77001234567", source: "test" } });
    const conversation = await db.conversation.create({ data: { tenantId: tenant.id, contactId: contact.id, mode: options.conversationMode || "ai", assigneeMembershipId: member.id, messageRevision: 1 } });
    const inquiry = await db.inquiry.create({ data: { tenantId: tenant.id, contactId: contact.id, conversationId: conversation.id, source: "whatsapp", status: "qualification", phoneNormalized: "77001234567" } });
    const message = await db.message.create({ data: { tenantId: tenant.id, conversationId: conversation.id, direction: "inbound", senderKind: "client", text: "Нужна презентация компании, хочу заказать 15 слайдов", operationState: "sent" } });
    const result = await analyzeConversationContext(db, auth, conversation.id, { useLlm: false });
    Object.assign(result.analysis, { confidence: "HIGH", detectedNeed: "Презентация компании — 15 слайдов", suggestedNextAction: "Уточнить содержание слайдов", humanRequired: !!options.human, humanReason: options.human ? "Нужен индивидуальный расчёт" : null,
      evidenceMessageIds: [message.id], events: [{ type: "CLIENT_INTEREST_CONFIRMED", confidence: "HIGH", evidenceMessageIds: [message.id] }], agreements: [], suggestedRequestStatus: "qualified" });
    const run = () => applyAnalyzedConversation(db, tenant.id, conversation.id, result);
    const deal = () => db.deal.findFirstOrThrow({ where: { tenantId: tenant.id } });
    const report = () => getSalesControl(db, auth);
    return { tenant, auth, user, member, contact, conversation, inquiry, message, result, run, deal, report };
  }
  async function goal(f: Awaited<ReturnType<typeof fixture>>, value: string) {
    await db.tenant.update({ where: { id: f.tenant.id }, data: { settingsJson: { aiAutomation: { defaultMode: "AUTO", crm: { enabled: true }, salesProcess: { mode: "auto", goal: value, notifyResponsible: false } } } } });
  }
  it("defaults off and has a grounded sales goal", () => {
    assert.equal(parseSalesProcess({}).mode, "off"); assert.equal(parseSalesProcess({ mode: "typo" }).mode, "off");
    assert.equal(salesProcessPrompt({}), ""); assert.match(salesProcessPrompt({ mode: "auto", goal: "payment" }), /не являются оплатой/);
    assert.ok(AI_MANAGER_GOALS.some(g => g.id === "close_sale"));
  });
  it("creates exactly one linked deal and next task, with evidence and inquiry history", async () => {
    const f = await fixture(); await f.run(); await f.run();
    const d = await f.deal(); assert.equal(await db.deal.count({ where: { tenantId: f.tenant.id } }), 1);
    const inquiry = await db.inquiry.findUniqueOrThrow({ where: { id: f.inquiry.id } });
    assert.equal(inquiry.dealId, d.id); assert.equal(inquiry.status, "converted");
    assert.equal(await db.dealConversation.count({ where: { dealId: d.id, conversationId: f.conversation.id } }), 1);
    const tasks = await db.task.findMany({ where: { dealId: d.id } }); assert.equal(tasks.length, 1); assert.equal(tasks[0].ownerMembershipId, f.member.id); assert.ok(tasks[0].dueAt);
    assert.equal(await db.auditEvent.count({ where: { tenantId: f.tenant.id, action: "sales.deal_created", correlationId: f.message.id } }), 1);
    assert.equal((await f.report()).items[0].phone, "+77001234567");
  });
  it("uses company working hours for automatic deal and task deadlines, keeping existing dates", async t => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-23T16:00:00+05:00") });
    const f = await fixture();
    await db.dealStage.create({ data: { tenantId: f.tenant.id, systemKey: "new", name: "Новый заказ", sortOrder: 1, defaultProbability: 25 } });
    await db.tenant.update({ where: { id: f.tenant.id }, data: { settingsJson: {
      ...f.tenant.settingsJson as object,
      aiAutomation: { defaultMode: "AUTO", crm: { enabled: true }, salesProcess: { mode: "auto", notifyResponsible: false, nextStepHours: 2 } },
      ops: { processCalendar: { ...DEFAULT_PROCESS_CALENDAR, mode: "business", end: "17:00", excludedDates: ["2026-10-26"] } },
    } } });
    await f.run(); const deal = await f.deal(), due = new Date("2026-10-27T10:00:00+05:00");
    assert.equal(deal.probability, 25);
    assert.equal(deal.nextActionAt!.getTime(), due.getTime());
    const task = await db.task.findFirstOrThrow({ where: { dealId: deal.id } });
    assert.equal(task.dueAt!.getTime(), due.getTime());
    await db.tenant.update({ where: { id: f.tenant.id }, data: { settingsJson: { aiAutomation: { salesProcess: { mode: "auto", nextStepHours: 4 } } } } });
    await db.$transaction(tx => ensureSalesNextTask(tx, f.tenant.id, deal.id));
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).dueAt!.getTime(), due.getTime());
    const manual = new Date("2026-10-25T12:00:00+05:00");
    await db.deal.update({ where: { id: deal.id }, data: { nextActionAt: manual } });
    await db.$transaction(tx => ensureSalesNextTask(tx, f.tenant.id, deal.id));
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).dueAt!.getTime(), manual.getTime());
  });
  for (const invoiceDue of [null, new Date("2026-10-25T12:00:00+05:00")]) it(`honors the calendar and explicit invoice date during document automation: ${invoiceDue}`, async t => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-23T16:00:00+05:00") });
    const f = await fixture(); await f.run(); const deal = await f.deal();
    await db.tenant.update({ where: { id: f.tenant.id }, data: { settingsJson: {
      aiAutomation: { defaultMode: "AUTO", crm: { enabled: true }, salesProcess: { mode: "auto", notifyResponsible: false, nextStepHours: 2 } },
      ops: { processCalendar: { ...DEFAULT_PROCESS_CALENDAR, mode: "business", end: "17:00", excludedDates: ["2026-10-26"] } },
    } } });
    await db.dealStage.create({ data: { tenantId: f.tenant.id, systemKey: "invoiced", name: "Ждём оплату", sortOrder: 7 } });
    await db.invoice.create({ data: { tenantId: f.tenant.id, dealId: deal.id, number: randomUUID(), status: "ISSUED", dueDate: invoiceDue, amountWithoutVat: 1000, vatAmount: 0, totalAmount: 1000 } });
    await reconcileSalesDeal(db, f.tenant.id, deal.id);
    const expected = invoiceDue || new Date("2026-10-27T10:00:00+05:00");
    assert.equal((await f.deal()).nextActionAt!.getTime(), expected.getTime());
    assert.equal((await db.task.findFirstOrThrow({ where: { dealId: deal.id, status: "open" } })).dueAt!.getTime(), expected.getTime());
  });
  for (const options of [{ mode: "off" }, { aiMode: "MANUAL" }, { aiMode: "ASSIST" }, { crm: false }, { conversationMode: "paused" }]) it(`respects existing policy ${JSON.stringify(options)}`, async () => {
    const f = await fixture(options); await f.run(); assert.equal(await db.deal.count({ where: { tenantId: f.tenant.id } }), 0);
  });
  for (const kind of ["greeting", "weak", "unrelated-evidence", "refused"] as const) it(`does not turn ${kind} into a deal`, async () => {
    const f = await fixture();
    if (kind === "greeting") { f.result.analysis.detectedNeed = null; f.result.analysis.events = []; }
    if (kind === "weak") f.result.analysis.confidence = "LOW";
    if (kind === "unrelated-evidence") f.result.analysis.events![0].evidenceMessageIds = [randomUUID()];
    if (kind === "refused") f.result.analysis.events!.push({ type: "PRICE_REJECTED", confidence: "HIGH", evidenceMessageIds: [f.message.id] });
    await f.run(); assert.equal(await db.deal.count({ where: { tenantId: f.tenant.id } }), 0);
  });
  it("suggests, then confirms idempotently, without an automatic deal", async () => {
    const f = await fixture({ mode: "suggest" }); await f.run();
    assert.equal(await db.deal.count({ where: { tenantId: f.tenant.id } }), 0);
    const p = (await f.report()).proposals[0]; assert.ok(p);
    const a = await reviewSalesProposal(db, f.auth, p.id, { decision: "create", revision: p.revision });
    const b = await reviewSalesProposal(db, f.auth, p.id, { decision: "create", revision: p.revision }); assert.deepEqual(a, b);
    assert.equal(await db.task.count({ where: { dealId: a.dealId! } }), 1);
    assert.equal((await f.report()).proposals.length, 0);
    await goal(f, "qualified");
    assert.equal((await f.report()).items[0].goalReached, true);
    await reconcileSalesDeal(db, f.tenant.id, a.dealId!);
    assert.equal(await db.activity.count({ where: { dealId: a.dealId!, type: "sales.goal_reached" } }), 1);
  });
  it("requires review for human-required cases; can dismiss stale proposals", async () => {
    const f = await fixture({ human: true }); await f.run(); const p = (await f.report()).proposals[0];
    await db.conversation.update({ where: { id: f.conversation.id }, data: { messageRevision: 2 } });
    await assert.rejects(reviewSalesProposal(db, f.auth, p.id, { decision: "create", revision: p.revision }), /Переписка изменилась/);
    await reviewSalesProposal(db, f.auth, p.id, { decision: "dismiss", revision: p.revision });
    assert.equal((await f.report()).proposals.length, 0);
  });
  it("does not guess among a customer's existing orders, and links the chosen deal", async () => {
    const f = await fixture(); const stage = await db.dealStage.create({ data: { tenantId: f.tenant.id, systemKey: "new", name: "Новая", sortOrder: 1 } });
    const existing = await db.deal.create({ data: { tenantId: f.tenant.id, contactId: f.contact.id, title: "Другой заказ", stageId: stage.id } });
    await f.run(); const p = (await f.report()).proposals[0]; assert.equal(p.alternatives[0].id, existing.id);
    await reviewSalesProposal(db, f.auth, p.id, { decision: "link", dealId: existing.id, revision: p.revision });
    assert.equal(await db.deal.count({ where: { tenantId: f.tenant.id } }), 1);
    assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: f.inquiry.id } })).dealId, existing.id);
    await goal(f, "qualified");
    assert.equal((await f.report()).items[0].goalReached, true);
  });
  it("uses the current conversation owner when a manager approves an older proposal", async () => {
    const f = await fixture({ mode: "suggest" }); await f.run(); const p = (await f.report()).proposals[0];
    const other = await fixture();
    const member = await db.membership.create({ data: { userId: other.user.id, tenantId: f.tenant.id, role: "manager" }, include: { tenant: true } });
    await db.conversation.update({ where: { id: f.conversation.id }, data: { assigneeMembershipId: member.id } });
    const manager = { user: other.user, activeMembership: member, memberships: [member] } as unknown as AuthContext;
    const result = await reviewSalesProposal(db, manager, p.id, { decision: "create", revision: p.revision });
    const report = await getSalesControl(db, manager);
    assert.equal(report.items[0].id, result.dealId);
    assert.equal((await f.deal()).assigneeMembershipId, member.id);
    assert.equal((await db.task.findFirstOrThrow({ where: { dealId: result.dealId! } })).ownerMembershipId, member.id);
  });
  it("preserves manual task edits and does not duplicate in-progress tasks", async () => {
    const f = await fixture(); await f.run(); const d = await f.deal(); const task = await db.task.findFirstOrThrow({ where: { dealId: d.id } });
    await db.task.update({ where: { id: task.id }, data: { title: "Мой ручной шаг" } });
    await db.deal.update({ where: { id: d.id }, data: { nextAction: "Новая рекомендация" } });
    await reconcileSalesDeal(db, f.tenant.id, d.id);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).title, "Мой ручной шаг");
    const g = await fixture(); const stage = await db.dealStage.create({ data: { tenantId: g.tenant.id, systemKey: "new", name: "Новая", sortOrder: 1 } });
    const gd = await db.deal.create({ data: { tenantId: g.tenant.id, contactId: g.contact.id, title: "В работе", stageId: stage.id } });
    await db.task.create({ data: { tenantId: g.tenant.id, dealId: gd.id, title: "Уже работаем", type: "call", status: "in_progress" } });
    await db.$transaction(tx => ensureSalesNextTask(tx, g.tenant.id, gd.id)); assert.equal(await db.task.count({ where: { dealId: gd.id } }), 1);
  });
  it("does not reopen completed tasks; a changed next step gets a new task", async () => {
    const f = await fixture(); await f.run(); const d = await f.deal(); const task = await db.task.findFirstOrThrow({ where: { dealId: d.id } });
    await db.task.update({ where: { id: task.id }, data: { status: "done" } });
    await reconcileSalesDeal(db, f.tenant.id, d.id); assert.equal(await db.task.count({ where: { dealId: d.id } }), 1);
    await db.deal.update({ where: { id: d.id }, data: { nextAction: "Согласовать договор" } });
    await reconcileSalesDeal(db, f.tenant.id, d.id); assert.equal(await db.task.count({ where: { dealId: d.id } }), 2);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status, "done");
  });
  it("assigns a fresh working deadline to a new undated step after the previous task is completed", async t => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-23T16:00:00+05:00") });
    const f = await fixture(); await f.run(); const d = await f.deal(), task = await db.task.findFirstOrThrow({ where: { dealId: d.id } });
    await db.tenant.update({ where: { id: f.tenant.id }, data: { settingsJson: {
      aiAutomation: { salesProcess: { mode: "auto", notifyResponsible: false, nextStepHours: 2 } },
      ops: { processCalendar: { ...DEFAULT_PROCESS_CALENDAR, mode: "business", end: "17:00", excludedDates: ["2026-10-26"] } },
    } } });
    await db.task.update({ where: { id: task.id }, data: { status: "done", completedAt: new Date() } });
    await db.deal.update({ where: { id: d.id }, data: { nextAction: "Согласовать договор", nextActionAt: null } });
    await db.$transaction(tx => ensureSalesNextTask(tx, f.tenant.id, d.id));
    const next = await db.task.findFirstOrThrow({ where: { dealId: d.id, status: "open" } });
    assert.equal(next.dueAt!.getTime(), new Date("2026-10-27T10:00:00+05:00").getTime());
    assert.notEqual(next.dueAt!.getTime(), task.dueAt!.getTime());
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status, "done");
    assert.equal(await db.activity.count({ where: { tenantId: f.tenant.id, dealId: d.id, type: "task.created" } }), 2);
  });
  it("does not replace an explicitly scheduled date when document automation fills an empty action", async () => {
    const f = await fixture(); await f.run(); const d = await f.deal(), dueAt = new Date("2026-12-16T15:00:00+05:00");
    await db.deal.update({ where: { id: d.id }, data: { nextAction: "  ", nextActionAt: dueAt } });
    await db.dealStage.create({ data: { tenantId: f.tenant.id, systemKey: "contract", name: "Договор", sortOrder: 6 } });
    await db.contract.create({ data: { tenantId: f.tenant.id, dealId: d.id, number: randomUUID(), status: "SIGNED", amountWithoutVat: 1000, vatAmount: 0, totalAmount: 1000 } });
    await reconcileSalesDeal(db, f.tenant.id, d.id);
    assert.equal((await f.deal()).nextActionAt!.getTime(), dueAt.getTime());
    assert.equal((await db.task.findFirstOrThrow({ where: { dealId: d.id, status: "open" } })).dueAt!.getTime(), dueAt.getTime());
  });
  it("issued documents move the stage; drafts and payment promises do not", async () => {
    const f = await fixture(); await f.run(); const d = await f.deal(); await goal(f, "payment");
    const target = await db.dealStage.create({ data: { tenantId: f.tenant.id, systemKey: "invoiced", name: "Счёт выставлен", sortOrder: 7 } });
    const invoice = await db.invoice.create({ data: { tenantId: f.tenant.id, dealId: d.id, number: randomUUID(), amountWithoutVat: 1000, vatAmount: 0, totalAmount: 1000 } });
    await reconcileSalesDeal(db, f.tenant.id, d.id); assert.equal((await f.deal()).stageId, d.stageId); assert.equal((await f.report()).items[0].goalReached, false);
    await db.invoice.update({ where: { id: invoice.id }, data: { status: "ISSUED" } });
    await reconcileSalesDeal(db, f.tenant.id, d.id); assert.equal((await f.deal()).stageId, target.id); assert.equal((await f.report()).items[0].goalReached, false);
    await reconcileSalesDeal(db, f.tenant.id, d.id);
    const history = await db.dealStageHistory.findMany({ where: { dealId: d.id } });
    assert.equal(history.length, 2);
    assert.equal(history.filter(h => !h.leftAt).length, 1);
    const current = history.find(h => !h.leftAt)!;
    assert.equal(current.toStageId, target.id);
    assert.equal(history.find(h => h.id !== current.id)?.leftAt?.toISOString(), current.enteredAt.toISOString());
    assert.equal((await f.deal()).stageEnteredAt.toISOString(), current.enteredAt.toISOString());
    await db.deal.update({ where: { id: d.id }, data: { offerAmountMinor: 1000, paymentStatus: "PAID" } });
    assert.equal((await f.report()).items[0].goalReached, false);
    await db.paymentRecord.create({ data: { tenantId: f.tenant.id, dealId: d.id, amountMinor: 1000, currency: "USD" } });
    await db.paymentRecord.create({ data: { tenantId: f.tenant.id, dealId: d.id, amountMinor: 1000, currency: "KZT", status: "pending" } });
    assert.equal((await f.report()).items[0].goalReached, false);
    await db.paymentRecord.create({ data: { tenantId: f.tenant.id, dealId: d.id, amountMinor: 1000, currency: "KZT" } });
    await reconcileSalesDeal(db, f.tenant.id, d.id); await reconcileSalesDeal(db, f.tenant.id, d.id);
    assert.equal((await f.report()).items[0].goalReached, true); assert.equal((await f.deal()).outcome, "open");
    assert.equal(await db.activity.count({ where: { dealId: d.id, type: "sales.goal_reached" } }), 1);
  });
  for (const outcome of ["won", "lost"] as const) it(`manual transitions and ${outcome} close the preceding stage interval`, async () => {
    const f = await fixture(); await f.run(); const d = await f.deal();
    await changeDealStage(db, f.auth, d.id, { systemKey: "negotiation" });
    await changeDealStage(db, f.auth, d.id, { systemKey: "negotiation" });
    const history = await db.dealStageHistory.findMany({ where: { dealId: d.id } });
    assert.equal(history.length, 2); assert.equal(history.filter(h => !h.leftAt).length, 1);
    const current = history.find(h => !h.leftAt)!;
    assert.equal(history.find(h => h.id !== current.id)?.leftAt?.toISOString(), current.enteredAt.toISOString());
    if (outcome === "won") await markDealWon(db, f.auth, d.id);
    else await markDealLost(db, f.auth, d.id, { lossReason: "Клиент выбрал другой вариант" });
    const closed = await f.deal();
    assert.equal(await db.dealStageHistory.count({ where: { dealId: d.id, leftAt: null } }), 0);
    assert.equal((await db.dealStageHistory.findUniqueOrThrow({ where: { id: current.id } })).leftAt?.toISOString(), closed.closedAt?.toISOString());
  });
  for (const outcome of ["won", "lost"] as const) it(`a stale ${outcome} request cannot close a newer stage interval`, async () => {
    const f = await fixture(); await f.run(); const d = await f.deal();
    let interrupted = false;
    // Deterministically interleave a real, committed stage change after the
    // close request reads its snapshot and before its write transaction begins.
    const racing = new Proxy(db, { get(target, property) {
      if (property !== "$transaction") return Reflect.get(target, property);
      return async (run: Parameters<typeof db.$transaction>[0]) => {
        assert.equal(interrupted, false); interrupted = true;
        await changeDealStage(db, f.auth, d.id, { systemKey: "negotiation" });
        return db.$transaction(run);
      };
    } });
    const close = outcome === "won" ? markDealWon(racing, f.auth, d.id)
      : markDealLost(racing, f.auth, d.id, { lossReason: "Другой вариант" });
    await assert.rejects(close, { code: "conflict" });
    const current = await f.deal();
    assert.equal(current.outcome, "open"); assert.equal(current.closedAt, null);
    const history = await db.dealStageHistory.findMany({ where: { dealId: d.id } });
    assert.equal(history.length, 2);
    assert.equal(history.filter(row => !row.leftAt).length, 1);
    assert.equal(history.find(row => !row.leftAt)?.toStageId, current.stageId);
    assert.equal(await db.activity.count({ where: { dealId: d.id, type: `deal.${outcome}` } }), 0);
  });
  it("isolates proposal review and reports by tenant and manager visibility", async () => {
    const f = await fixture({ mode: "suggest" }); await f.run(); const p = (await f.report()).proposals[0]; const other = await fixture();
    await assert.rejects(reviewSalesProposal(db, other.auth, p.id, { decision: "create", revision: p.revision }), /не найдено/);
    await reviewSalesProposal(db, f.auth, p.id, { decision: "create", revision: p.revision });
    const member = await db.membership.create({ data: { userId: other.user.id, tenantId: f.tenant.id, role: "manager" }, include: { tenant: true } });
    const manager = { user: other.user, activeMembership: member, memberships: [member] } as unknown as AuthContext;
    assert.equal((await getSalesControl(db, manager)).items.length, 0);
    assert.equal((await other.report()).items.length, 0);
  });
  it("accepts sales questions directly without opening a menu", () => {
    for (const text of ["Продажи под контролем", "Покажи продажи под контролем", "Какие клиенты близки к покупке?", "Что мешает завершить сделки?"]) assert.equal(quickControlCommand(text)?.action, "GET_SALES_CONTROL", text);
    assert.equal(quickControlCommand("Какие клиенты близки к покупке?")?.salesFilter, "ready");
    assert.equal(quickControlCommand("Покажи клиентов близких к покупке")?.salesFilter, "ready");
    assert.equal(quickControlCommand("Что мешает завершить сделки?")?.salesFilter, "attention");
    assert.equal(quickControlCommand("По каким сделкам цель достигнута?")?.salesFilter, "goal");
  });
  it("does not duplicate the next task when the first analysis agrees on a meeting", async () => {
    const f = await fixture();
    f.result.analysis.agreements = [{ action: "create", type: "ONLINE_MEETING", title: "Обсудить презентацию", status: "CONFIRMED", scheduledAt: new Date(Date.now() + 48 * 3600000).toISOString(), confidence: "HIGH", createTask: true, evidenceMessageIds: [f.message.id] }];
    await f.run(); const d = await f.deal();
    const tasks = await db.task.findMany({ where: { dealId: d.id } }); assert.equal(tasks.length, 1); assert.equal(tasks[0].type, "meeting");
  });
  it("continues the same contact across a second conversation without another automatic deal", async () => {
    const f = await fixture(); await f.run(); const d = await f.deal();
    const c = await db.conversation.create({ data: { tenantId: f.tenant.id, contactId: f.contact.id, mode: "ai", messageRevision: 1 } });
    const m = await db.message.create({ data: { tenantId: f.tenant.id, conversationId: c.id, senderKind: "client", direction: "inbound", text: "Хочу заказать презентацию" } });
    const result = await analyzeConversationContext(db, f.auth, c.id, { useLlm: false });
    result.analysis = { ...f.result.analysis, evidenceMessageIds: [m.id], events: [{ type: "CLIENT_INTEREST_CONFIRMED", confidence: "HIGH", evidenceMessageIds: [m.id] }] };
    await applyAnalyzedConversation(db, f.tenant.id, c.id, result);
    assert.equal(await db.deal.count({ where: { tenantId: f.tenant.id } }), 1); assert.equal((await f.report()).proposals[0].alternatives[0].id, d.id);
  });
  it("allows approval after an AI reply, and requires checking a new client message", async () => {
    const f = await fixture({ mode: "suggest" }); await f.run();
    await db.message.create({ data: { tenantId: f.tenant.id, conversationId: f.conversation.id, direction: "outbound", senderKind: "ai", text: "Уточните сроки", createdAt: new Date(Date.now() + 1000) } });
    await db.conversation.update({ where: { id: f.conversation.id }, data: { messageRevision: 2 } });
    const p = (await f.report()).proposals[0]; assert.equal(p.changed, false); assert.equal(p.revision, 2);
    await reviewSalesProposal(db, f.auth, p.id, { decision: "create", revision: p.revision });
    const g = await fixture({ mode: "suggest" }); await g.run();
    await db.message.create({ data: { tenantId: g.tenant.id, conversationId: g.conversation.id, direction: "inbound", senderKind: "client", text: "Сначала уточним объём", createdAt: new Date(Date.now() + 1000) } });
    await db.conversation.update({ where: { id: g.conversation.id }, data: { messageRevision: 2 } });
    const q = (await g.report()).proposals[0]; assert.equal(q.changed, true);
    await assert.rejects(reviewSalesProposal(db, g.auth, q.id, { decision: "create", revision: q.revision }), /Проверьте переписку/);
    await reviewSalesProposal(db, g.auth, q.id, { decision: "create", revision: q.revision, confirmedLatest: true });
  });
  it("serializes manual conversion against automatic processing of the same inquiry", async () => {
    const f = await fixture(); await db.dealStage.create({ data: { tenantId: f.tenant.id, systemKey: "new", name: "Новая", sortOrder: 1 } });
    const [, manual] = await Promise.all([f.run(), convertInquiryToDeal(db, f.auth, f.inquiry.id)]);
    assert.equal(await db.deal.count({ where: { tenantId: f.tenant.id } }), 1);
    assert.equal(manual.id, (await f.deal()).id);
  });
  it("the company pause prevents automatic deal creation", async () => {
    const f = await fixture(); await db.tenant.update({ where: { id: f.tenant.id }, data: { settingsJson: { ...f.tenant.settingsJson as object, runtime: { aiPaused: true } } } });
    await f.run(); assert.equal(await db.deal.count({ where: { tenantId: f.tenant.id } }), 0);
  });
  it("manual conversion links the conversation and carries existing tasks into the deal", async () => {
    const f = await fixture(); await db.dealStage.create({ data: { tenantId: f.tenant.id, systemKey: "new", name: "Новая", sortOrder: 1 } });
    const task = await db.task.create({ data: { tenantId: f.tenant.id, contactId: f.contact.id, inquiryId: f.inquiry.id, title: "Позвонить", type: "call" } });
    const d = await convertInquiryToDeal(db, f.auth, f.inquiry.id);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).dealId, d.id);
    assert.equal(await db.task.count({ where: { dealId: d.id } }), 1);
    assert.equal(await db.dealConversation.count({ where: { dealId: d.id, conversationId: f.conversation.id } }), 1);
  });
  it("confirmed payment uses the deal currency and completes only the managed payment check", async () => {
    const f = await fixture(); await f.run(); const d = await f.deal();
    await db.deal.update({ where: { id: d.id }, data: { offerAmountMinor: 1000 } });
    await db.dealStage.create({ data: { tenantId: f.tenant.id, systemKey: "invoiced", name: "Счёт выставлен", sortOrder: 7 } });
    await db.invoice.create({ data: { tenantId: f.tenant.id, dealId: d.id, number: randomUUID(), status: "ISSUED", amountWithoutVat: 1000, vatAmount: 0, totalAmount: 1000 } });
    await reconcileSalesDeal(db, f.tenant.id, d.id);
    assert.equal((await f.deal()).nextAction, "Проверить поступление оплаты по счёту");
    const foreign = await addPayment(db, f.auth, d.id, { amountMinor: 1000, currency: "USD" }); assert.equal(foreign.paymentStatus, "NOT_INVOICED");
    await addPayment(db, f.auth, d.id, { amountMinor: 1000, currency: "KZT" });
    await reconcileSalesDeal(db, f.tenant.id, d.id);
    assert.equal((await db.task.findFirstOrThrow({ where: { dealId: d.id } })).status, "done");
    assert.equal((await f.deal()).outcome, "open");
  });
  it("signed contracts, not model words, move the document stage and preserve a human plan", async () => {
    const f = await fixture(); await f.run(); const d = await f.deal();
    const target = await db.dealStage.create({ data: { tenantId: f.tenant.id, systemKey: "contract", name: "Договор", sortOrder: 6 } });
    await db.deal.update({ where: { id: d.id }, data: { nextAction: "Обсудить с директором" } });
    const c = await db.contract.create({ data: { tenantId: f.tenant.id, dealId: d.id, number: randomUUID(), amountWithoutVat: 1000, vatAmount: 0, totalAmount: 1000 } });
    await reconcileSalesDeal(db, f.tenant.id, d.id); assert.notEqual((await f.deal()).stageId, target.id);
    await db.contract.update({ where: { id: c.id }, data: { status: "SIGNED" } });
    await reconcileSalesDeal(db, f.tenant.id, d.id); assert.equal((await f.deal()).stageId, target.id); assert.equal((await f.deal()).nextAction, "Обсудить с директором");
  });
  it("adds the goal to the published prompt without making an unpublished prompt live", async () => {
    const f = await fixture(); assert.equal((await getPublishedTenantAiContext(db, f.tenant.id)).tenantPrompt, "");
    await db.aIConfiguration.create({ data: { tenantId: f.tenant.id, systemPrompt: "Консультируй по презентациям.", promptStatus: "published" } });
    const context = await getPublishedTenantAiContext(db, f.tenant.id); assert.match(context.tenantPrompt, /Сопровождение продажи/); assert.match(context.tenantPrompt, /Консультируй по презентациям/);
  });
  it("identifies the customer in alerts and does not repeat an unchanged blocker", async () => {
    const f = await fixture();
    await db.tenant.update({ where: { id: f.tenant.id }, data: { settingsJson: { aiAutomation: { defaultMode: "AUTO", crm: { enabled: true }, salesProcess: { mode: "auto", notifyResponsible: true } } } } });
    await f.run(); const d = await f.deal();
    const created = await db.notification.findFirstOrThrow({ where: { tenantId: f.tenant.id, type: "deal.updated" } });
    assert.match(created.body, /Айбек/); assert.match(created.body, /77001234567/);
    await db.deal.update({ where: { id: d.id }, data: { nextActionAt: new Date(Date.now() - 3600000) } });
    await reconcileSalesDeal(db, f.tenant.id, d.id); await reconcileSalesDeal(db, f.tenant.id, d.id);
    assert.equal(await db.notification.count({ where: { tenantId: f.tenant.id, type: "sales.attention" } }), 1);
  });
  it("saves sales settings with validation and performs a bounded sweep", async () => {
    const f = await fixture();
    await assert.rejects(updateAIAutomationSettings(db, f.auth, { salesProcess: { mode: "auto", assigneeMembershipId: randomUUID() } } as any), /сотрудника/);
    await updateAIAutomationSettings(db, f.auth, { salesProcess: { mode: "suggest", goal: "meeting", nextStepHours: 12 } } as any);
    const settings = await getAIAutomationSettings(db, f.auth); assert.equal(settings.salesProcess.goal, "meeting"); assert.equal(settings.salesProcess.nextStepHours, 12);
    await sweepSalesProcesses(db);
  });
});
