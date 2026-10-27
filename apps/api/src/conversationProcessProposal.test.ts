import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import type { AuthContext } from "./lib/types.ts";
import { analyzeConversationContext } from "./services/conversationContextService.ts";
import { applyAnalyzedConversation } from "./services/conversationContextApplyService.ts";
import { listConversationCrmReview, reviewConversationCrmChange } from "./services/conversationCrmReviewService.ts";
import { getContactOverview } from "./services/contactService.ts";
import { setTaskStatus } from "./services/domainService.ts";

describe("ASSIST process proposals and explicit atomic approval", () => {
  let db: Awaited<ReturnType<typeof createPrismaClient>>;
  const originalFetch = globalThis.fetch;
  before(async () => { db = await createPrismaClient(); globalThis.fetch = async () => { throw new Error("External actions disabled in process proposal tests"); }; });
  after(async () => { globalThis.fetch = originalFetch; await db.$disconnect(); });

  async function fixture(options: { mode?: string; crm?: Record<string, boolean> } = {}) {
    const tenant = await db.tenant.create({ data: { name: "ASSIST", slug: randomUUID(), timezone: "Asia/Almaty", settingsJson: {
      aiAutomation: { defaultMode: options.mode || "ASSIST", crm: { enabled: true, updateDealStage: true, ...options.crm }, salesProcess: { mode: "off", notifyResponsible: false } },
    } } });
    const user = await db.user.create({ data: { email: `${randomUUID()}@example.test`, name: "Айбек", passwordHash: "unused" } });
    const membership = await db.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: "owner" }, include: { tenant: true } });
    const auth = { user, activeMembership: membership, memberships: [membership] } as AuthContext;
    const contact = await db.contact.create({ data: { tenantId: tenant.id, name: "Клиент", ownerMembershipId: membership.id } });
    const from = await db.dealStage.create({ data: { tenantId: tenant.id, name: "Выяснение задачи", systemKey: "need_identified", sortOrder: 1, defaultProbability: 10 } });
    const to = await db.dealStage.create({ data: { tenantId: tenant.id, name: "Обсуждение условий", systemKey: "negotiation", sortOrder: 3, defaultProbability: 60 } });
    const deal = await db.deal.create({ data: { tenantId: tenant.id, contactId: contact.id, title: "Проект", stageId: from.id, nextAction: "Уточнить запрос", probability: 10, assigneeMembershipId: membership.id, updatedAt: new Date(Date.now() - 120000) } });
    await db.dealStageHistory.create({ data: { tenantId: tenant.id, dealId: deal.id, toStageId: from.id, toSystemKey: from.systemKey, enteredAt: new Date(Date.now() - 120000), changedByType: "user" } });
    const conversation = await db.conversation.create({ data: { tenantId: tenant.id, contactId: contact.id, mode: "ai", assigneeMembershipId: membership.id, messageRevision: 1 } });
    const inquiry = await db.inquiry.create({ data: { tenantId: tenant.id, contactId: contact.id, conversationId: conversation.id, dealId: deal.id, source: "whatsapp", status: "qualification", assigneeMembershipId: membership.id } });
    let message = await db.message.create({ data: { tenantId: tenant.id, conversationId: conversation.id, direction: "inbound", senderKind: "client", text: "Давайте обсудим условия на созвоне", createdAt: new Date(Date.now() - 1000) } });
    const at = new Date(Date.now() + 3 * 86400000);
    const analyze = async (input: { existingId?: string; action?: "reschedule" | "cancel" | "complete"; scheduledAt?: Date; type?: "CALL" | "SEND_INVOICE" } = {}) => {
      const result = await analyzeConversationContext(db, auth, conversation.id, { useLlm: false });
      Object.assign(result.analysis, { confidence: "HIGH", evidenceMessageIds: [message.id], events: [], suggestedTasks: [], summaryUpdate: "Нужен созвон", suggestedNextAction: "Обсудить условия", suggestedDealStage: "negotiation", commercialFacts: [], intakeRequest: null,
        agreements: [{ action: input.action || "create", existingAgreementId: input.existingId, type: input.type || "CALL", title: "Обсудить условия", summary: "Обсудить сроки проекта", status: input.action === "reschedule" ? "RESCHEDULED" : "SCHEDULED", scheduledAt: (input.scheduledAt || at).toISOString(), createTask: true, confidence: "HIGH", evidenceMessageIds: [message.id] }],
      });
      return result;
    };
    const run = async (input?: Parameters<typeof analyze>[0]) => applyAnalyzedConversation(db, tenant.id, conversation.id, await analyze(input));
    const nextMessage = async () => {
      message = await db.message.create({ data: { tenantId: tenant.id, conversationId: conversation.id, direction: "inbound", senderKind: "client", text: "Перенесём созвон", createdAt: new Date(Date.now() + 1000) } });
      await db.conversation.update({ where: { id: conversation.id }, data: { messageRevision: { increment: 1 } } });
    };
    const list = (as = auth) => listConversationCrmReview(db, as, conversation.id);
    const review = async () => { const item = (await list()).items.find(i => i.entityType === "process"); assert.ok(item, "process proposal visible"); return item; };
    const decide = (id: string, decision: "accept" | "dismiss" | "undo", as = auth) => reviewConversationCrmChange(db, as, conversation.id, id, decision);
    return { tenant, auth, user, membership, contact, deal, from, to, conversation, inquiry, analyze, run, nextMessage, list, review, decide, at };
  }

  it("previews exact actions, owners and sources without mutating CRM or scheduling side effects", async () => {
    const f = await fixture(); const result = await f.run(); assert.equal(result.skipped, "suggestions_only");
    const item = await f.review(); assert.equal(item.status, "pending"); assert.equal(item.canAccept, true); assert.equal(item.canDismiss, true); assert.equal(item.canUndo, false);
    assert.deepEqual(item.process?.entries.map(e => e.entityType).sort(), ["agreement", "deal", "task"]);
    assert.equal(item.evidence.length, 1); assert.equal(item.process?.reminders, 3);
    assert.equal(item.process?.entries.find(e => e.entityType === "task")?.fields.find(f => f.label === "Исполнитель")?.after, "Айбек");
    assert.equal(item.process?.entries.find(e => e.entityType === "deal")?.fields.find(f => f.label === "Стадия сделки")?.before, "Выяснение задачи");
    assert.deepEqual(await db.deal.findUniqueOrThrow({ where: { id: f.deal.id } }), f.deal);
    for (const delegate of [db.task, db.agreement, db.scheduledAction, db.outboxEvent, db.notification]) assert.equal(await delegate.count({ where: { tenantId: f.tenant.id } } as never), 0);
    assert.equal(await db.message.count({ where: { tenantId: f.tenant.id } }), 1);
    assert.ok((await getContactOverview(db, f.auth, f.contact.id)).timeline.some(a => a.id === item.id));
    await f.run(); assert.equal((await f.list()).items.filter(i => i.entityType === "process").length, 1);
  });
  it("accepts once, records the employee and reverses the whole group without deleting history", async () => {
    const f = await fixture(); const result = await f.analyze(); await applyAnalyzedConversation(db, f.tenant.id, f.conversation.id, result); const item = await f.review();
    await Promise.all([f.decide(item.id, "accept"), f.decide(item.id, "accept")]);
    assert.equal(await db.task.count({ where: { tenantId: f.tenant.id } }), 1); assert.equal(await db.agreement.count({ where: { tenantId: f.tenant.id } }), 1);
    const accepted = await f.review(); assert.equal(accepted.status, "accepted"); assert.equal(accepted.canUndo, true, String(accepted.blockedReason));
    assert.equal(await db.auditEvent.count({ where: { tenantId: f.tenant.id, action: "conversation.crm_reviewed", actorUserId: f.user.id } }), 3);
    assert.equal(await db.activity.count({ where: { tenantId: f.tenant.id, type: "conversation.crm_reviewed" } }), 1);
    const current = await db.deal.findUniqueOrThrow({ where: { id: f.deal.id } }); assert.equal(current.stageId, f.to.id); assert.equal(current.offerAmountMinor, f.deal.offerAmountMinor); assert.equal(current.paymentStatus, f.deal.paymentStatus);
    assert.equal(await db.outboxEvent.count({ where: { tenantId: f.tenant.id } }), 0); assert.equal(await db.notification.count({ where: { tenantId: f.tenant.id } }), 0);
    await f.decide(item.id, "undo"); await f.decide(item.id, "undo");
    assert.equal((await f.review()).status, "undone"); assert.equal((await db.task.findFirstOrThrow({ where: { tenantId: f.tenant.id } })).status, "canceled");
    assert.equal((await db.agreement.findFirstOrThrow({ where: { tenantId: f.tenant.id } })).status, "CANCELLED");
    assert.equal((await db.deal.findUniqueOrThrow({ where: { id: f.deal.id } })).stageId, f.from.id);
    assert.equal(await db.scheduledAction.count({ where: { tenantId: f.tenant.id, state: "scheduled" } }), 0);
    assert.equal(await db.dealStageHistory.count({ where: { tenantId: f.tenant.id } }), 3);
    await applyAnalyzedConversation(db, f.tenant.id, f.conversation.id, result);
    assert.equal((await f.list()).items.filter(i => i.entityType === "process").length, 1);
    assert.equal(await db.message.count({ where: { tenantId: f.tenant.id } }), 1);
  });
  it("dismisses idempotently and never revives the dismissed decision on the same source", async () => {
    const f = await fixture(); await f.run(); const item = await f.review();
    await f.decide(item.id, "dismiss"); await f.decide(item.id, "dismiss"); await f.run();
    assert.equal((await f.review()).status, "dismissed"); assert.equal((await f.list()).items.filter(i => i.entityType === "process").length, 1);
    await assert.rejects(f.decide(item.id, "accept"), { code: "crm_review_closed" });
    assert.equal(await db.task.count({ where: { tenantId: f.tenant.id } }), 0);
    assert.equal(await db.activity.count({ where: { tenantId: f.tenant.id, type: "conversation.crm_reviewed" } }), 1);
  });
  it("supersedes an older group on new analysis and rejects the stale approval", async () => {
    const f = await fixture(); await f.run(); const old = await f.review(); await f.nextMessage();
    assert.equal((await f.review()).blockedReason, "conversation_changed"); await assert.rejects(f.decide(old.id, "accept"), { code: "crm_review_changed" });
    await f.run(); const current = await f.review(); assert.notEqual(current.id, old.id); assert.equal(current.canAccept, true);
    assert.equal((await f.list()).items.find(i => i.id === old.id)?.status, "superseded");
  });
  for (const change of ["source", "deal", "owner", "rules", "inquiry", "stage", "member", "new_task"] as const) it(`rechecks ${change} immediately before approval`, async () => {
    const f = await fixture(); await f.run(); const item = await f.review();
    if (change === "source") await db.message.update({ where: { id: item.evidence[0].id }, data: { text: "Другая договорённость" } });
    if (change === "deal") await db.deal.update({ where: { id: f.deal.id }, data: { nextAction: "Правка сотрудника", version: { increment: 1 } } });
    if (change === "owner") await db.conversation.update({ where: { id: f.conversation.id }, data: { assigneeMembershipId: null, controlVersion: { increment: 1 } } });
    if (change === "rules") await db.tenant.update({ where: { id: f.tenant.id }, data: { settingsJson: { aiAutomation: { defaultMode: "ASSIST", crm: { enabled: false } } } } });
    if (change === "inquiry") await db.inquiry.update({ where: { id: f.inquiry.id }, data: { status: "closed" } });
    if (change === "stage") await db.dealStage.update({ where: { id: f.to.id }, data: { isTerminal: true } });
    if (change === "member") await db.membership.update({ where: { id: f.membership.id }, data: { active: false } });
    if (change === "new_task") await db.task.create({ data: { tenantId: f.tenant.id, dealId: f.deal.id, contactId: f.contact.id, type: "custom", title: "Работа сотрудника" } });
    assert.equal((await f.review()).canAccept, false); await assert.rejects(f.decide(item.id, "accept"), { code: "crm_review_changed" });
    assert.equal(await db.agreement.count({ where: { tenantId: f.tenant.id } }), 0);
  });
  it("refreshes a stale pending plan for the same source after settings change", async () => {
    const f = await fixture(); await f.run(); const old = await f.review();
    await db.tenant.update({ where: { id: f.tenant.id }, data: { settingsJson: { aiAutomation: { defaultMode: "ASSIST", crm: { enabled: true, updateDealStage: false }, salesProcess: { mode: "off" } } } } });
    assert.equal((await f.review()).blockedReason, "settings_changed");
    await f.run(); const current = await f.review(); assert.notEqual(current.id, old.id); assert.equal(current.canAccept, true);
    assert.ok(!current.process?.entries.find(e => e.entityType === "deal")?.fields.some(x => x.label === "Стадия сделки"));
    assert.equal((await f.list()).items.find(i => i.id === old.id)?.status, "superseded");
    await f.run(); assert.equal((await f.list()).items.filter(i => i.entityType === "process").length, 2);
  });
  it("blocks expired dates and never confirms money or a terminal stage", async () => {
    const f = await fixture(); const result = await f.analyze({ scheduledAt: new Date(Date.now() - 86400000) });
    result.analysis.suggestedDealStage = "won"; result.analysis.events = [{ type: "PRICE_ACCEPTED", amount: 90000, currency: "KZT", confidence: "HIGH", evidenceMessageIds: result.analysis.evidenceMessageIds }];
    await applyAnalyzedConversation(db, f.tenant.id, f.conversation.id, result);
    const item = await f.review(); assert.equal(item.blockedReason, "expired");
    assert.ok(!item.process?.entries.flatMap(e => e.fields).some(f => ["Сумма сделки", "Стадия сделки"].includes(f.label)));
    await assert.rejects(f.decide(item.id, "accept"), { code: "crm_review_changed" });
  });
  for (const confidence of ["MEDIUM", "LOW"] as const) it(`does not propose agreements or stage updates with ${confidence} evidence`, async () => {
    const f = await fixture(); const result = await f.analyze(); result.analysis.confidence = confidence; result.analysis.agreements[0].confidence = confidence;
    await applyAnalyzedConversation(db, f.tenant.id, f.conversation.id, result);
    assert.ok(!(await f.list()).items.some(i => i.entityType === "process"));
  });
  it("rejects source references from another tenant", async () => {
    const f = await fixture(), other = await fixture(); const result = await f.analyze(); const otherResult = await other.analyze();
    result.analysis.evidenceMessageIds = [otherResult.sourceMessageId!]; result.analysis.agreements[0].evidenceMessageIds = [otherResult.sourceMessageId!];
    await applyAnalyzedConversation(db, f.tenant.id, f.conversation.id, result);
    assert.ok(!(await f.list()).items.some(i => i.entityType === "process"));
  });
  it("keeps sending documents as a separate unexecuted task confirmation", async () => {
    const f = await fixture(); await f.run({ type: "SEND_INVOICE" }); const item = await f.review(); await f.decide(item.id, "accept");
    const task = await db.task.findFirstOrThrow({ where: { tenantId: f.tenant.id } });
    assert.equal(task.commandStatus, "needs_confirmation"); assert.equal(task.executionStatus, "prepared"); assert.equal(task.sentAt, null);
    assert.equal(await db.invoice.count({ where: { tenantId: f.tenant.id } }), 0); assert.equal(await db.message.count({ where: { tenantId: f.tenant.id } }), 1);
  });
  it("rolls all earlier writes back on failure and leaves the proposal actionable", async () => {
    const f = await fixture(); await f.run(); const item = await f.review();
    const failing = new Proxy(db, { get(target, key) {
      if (key === "$transaction") return (callback: any, options: any) => db.$transaction(tx => callback(new Proxy(tx, { get(transaction, field) {
        if (field === "agreement") return new Proxy(transaction.agreement, { get(delegate, method) { if (method === "create") return async () => { throw new Error("synthetic approval failure"); }; return Reflect.get(delegate, method); } });
        return Reflect.get(transaction, field);
      } })), options);
      return Reflect.get(target, key);
    } });
    await assert.rejects(reviewConversationCrmChange(failing, f.auth, f.conversation.id, item.id, "accept"), /synthetic approval failure/);
    assert.deepEqual(await db.deal.findUniqueOrThrow({ where: { id: f.deal.id } }), f.deal); assert.equal(await db.dealStageHistory.count({ where: { tenantId: f.tenant.id } }), 1);
    assert.equal(await db.auditEvent.count({ where: { tenantId: f.tenant.id, action: "conversation.crm_reviewed" } }), 0); assert.equal((await f.review()).canAccept, true);
    await f.decide(item.id, "accept"); assert.equal((await f.review()).status, "accepted");
  });
  it("scopes pending plans and history to all records and forbids manager approval", async () => {
    const f = await fixture(), other = await fixture(); await f.run(); const item = await f.review();
    await assert.rejects(f.decide(item.id, "accept", other.auth), { code: "not_found" });
    const manager = { ...f.auth, activeMembership: { ...f.membership, role: "manager" } } as AuthContext;
    assert.equal((await f.list(manager)).items.find(i => i.id === item.id)?.blockedReason, "permissions");
    await assert.rejects(f.decide(item.id, "accept", manager), { code: "forbidden" });
    await db.deal.update({ where: { id: f.deal.id }, data: { assigneeMembershipId: null } });
    assert.ok(!(await f.list(manager)).items.some(i => i.id === item.id));
    assert.ok(!(await getContactOverview(db, manager, f.contact.id)).timeline.some(i => i.id === item.id));
  });
  for (const action of ["reschedule", "cancel", "complete"] as const) it(`reviews and reverses existing ${action} as one group`, async () => {
    const f = await fixture({ mode: "AUTO" }); await f.run();
    const agreement = await db.agreement.findFirstOrThrow({ where: { tenantId: f.tenant.id } });
    await db.tenant.update({ where: { id: f.tenant.id }, data: { settingsJson: { aiAutomation: { defaultMode: "ASSIST", crm: { enabled: true, updateDealStage: true }, salesProcess: { mode: "off" } } } } });
    await f.nextMessage(); await f.run({ existingId: agreement.id, action, scheduledAt: new Date(f.at.getTime() + 86400000) });
    const item = await f.review(); assert.equal(item.status, "pending"); assert.equal(item.canAccept, true, String(item.blockedReason));
    assert.equal((await db.agreement.findUniqueOrThrow({ where: { id: agreement.id } })).status, agreement.status);
    await f.decide(item.id, "accept"); assert.equal((await f.review()).canUndo, true); await f.decide(item.id, "undo");
    const restored = await db.agreement.findUniqueOrThrow({ where: { id: agreement.id } }); assert.equal(restored.status, agreement.status); assert.equal(restored.scheduledAt?.toISOString(), agreement.scheduledAt?.toISOString());
    assert.equal((await db.task.findFirstOrThrow({ where: { tenantId: f.tenant.id } })).status, "open");
  });
  for (const change of ["task", "reminder", "calendar"] as const) it(`blocks existing agreement approval after ${change} changed`, async () => {
    const f = await fixture({ mode: "AUTO" }); await f.run(); const agreement = await db.agreement.findFirstOrThrow({ where: { tenantId: f.tenant.id } });
    await db.tenant.update({ where: { id: f.tenant.id }, data: { settingsJson: { aiAutomation: { defaultMode: "ASSIST", crm: { enabled: true, updateDealStage: true } } } } });
    if (change === "calendar") await db.integration.create({ data: { tenantId: f.tenant.id, type: "calendar", publicKey: `google:calendar:${f.tenant.id}`, status: "active", name: "Calendar" } });
    await f.nextMessage(); await f.run({ existingId: agreement.id, action: "reschedule", scheduledAt: new Date(f.at.getTime() + 86400000) }); const item = await f.review();
    if (change === "task") { const task = await db.task.findFirstOrThrow({ where: { tenantId: f.tenant.id } }); await setTaskStatus(db, f.auth, task.id, "open"); }
    if (change === "reminder") { const reminder = await db.scheduledAction.findFirstOrThrow({ where: { tenantId: f.tenant.id } }); await db.scheduledAction.update({ where: { id: reminder.id }, data: { state: "running", version: { increment: 1 } } }); }
    assert.equal((await f.review()).canAccept, false); await assert.rejects(f.decide(item.id, "accept"), { code: "crm_review_changed" });
  });
  it("discloses calendar sync for a new agreement and does not promise to recall it", async () => {
    const f = await fixture(); await db.integration.create({ data: { tenantId: f.tenant.id, type: "calendar", publicKey: `google:calendar:${f.tenant.id}`, status: "active", name: "Calendar" } });
    await f.run(); const item = await f.review(); assert.equal(item.process?.calendarSync, true); assert.equal(item.canAccept, true);
    await f.decide(item.id, "accept"); assert.equal((await f.review()).blockedReason, "calendar");
  });
  it("rejects a meeting whose end precedes its start", async () => {
    const f = await fixture(); const result = await f.analyze(); result.analysis.agreements[0].scheduledEndAt = new Date(f.at.getTime() - 60000).toISOString();
    await applyAnalyzedConversation(db, f.tenant.id, f.conversation.id, result); const item = await f.review();
    assert.ok(item.process?.entries.every(e => e.entityType === "deal"));
    assert.ok(!item.process?.entries.flatMap(e => e.fields).some(f => f.label === "Срок следующего шага"));
    await f.decide(item.id, "accept"); assert.equal(await db.agreement.count({ where: { tenantId: f.tenant.id } }), 0);
  });
  it("keeps paused conversations in review mode even with automatic CRM enabled", async () => {
    const f = await fixture({ mode: "AUTO" }); await db.conversation.update({ where: { id: f.conversation.id }, data: { mode: "paused" } });
    await f.run(); assert.equal((await f.review()).status, "pending"); assert.equal(await db.task.count({ where: { tenantId: f.tenant.id } }), 0);
  });
  it("honors per-action toggles when preparing the proposal", async () => {
    const f = await fixture({ crm: { createTasks: false, updateDealStage: false } }); await f.run(); const item = await f.review();
    assert.ok(!item.process?.entries.some(e => e.entityType === "task")); assert.ok(!item.process?.entries.flatMap(e => e.fields).some(f => f.label === "Стадия сделки"));
    await f.decide(item.id, "accept"); assert.equal(await db.task.count({ where: { tenantId: f.tenant.id } }), 0);
    assert.equal((await db.deal.findUniqueOrThrow({ where: { id: f.deal.id } })).stageId, f.from.id);
  });
  it("does not propose changes when CRM automation is disabled", async () => {
    const f = await fixture({ crm: { enabled: false } }); await f.run(); assert.ok(!(await f.list()).items.some(i => i.entityType === "process"));
  });
  it("invalidates an existing proposal when its channel is disconnected", async () => {
    const f = await fixture(); const integration = await db.integration.create({ data: { tenantId: f.tenant.id, type: "whatsapp", name: "WhatsApp", status: "active", connectionStatus: "CONNECTED" } });
    await db.inquiry.update({ where: { id: f.inquiry.id }, data: { integrationId: integration.id } });
    await f.run(); const item = await f.review(); assert.equal(item.canAccept, true);
    await db.integration.update({ where: { id: integration.id }, data: { connectionStatus: "DISCONNECTED" } });
    assert.equal((await f.review()).blockedReason, "settings_changed"); await assert.rejects(f.decide(item.id, "accept"), { code: "crm_review_changed" });
  });
  it("withdraws the old pending plan when a fresh analysis no longer proposes an action", async () => {
    const f = await fixture(); await f.run(); const old = await f.review();
    const result = await f.analyze(); result.analysis.confidence = "LOW"; result.analysis.agreements = [];
    await applyAnalyzedConversation(db, f.tenant.id, f.conversation.id, result);
    assert.equal((await f.review()).status, "superseded"); await assert.rejects(f.decide(old.id, "accept"), { code: "crm_review_closed" });
    assert.equal(await db.agreement.count({ where: { tenantId: f.tenant.id } }), 0);
  });
});
