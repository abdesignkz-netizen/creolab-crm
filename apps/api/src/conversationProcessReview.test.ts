import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import type { AuthContext } from "./lib/types.ts";
import { analyzeConversationContext } from "./services/conversationContextService.ts";
import { applyAnalyzedConversation } from "./services/conversationContextApplyService.ts";
import { listConversationCrmReview, reviewConversationCrmChange } from "./services/conversationCrmReviewService.ts";
import { getContactOverview } from "./services/contactService.ts";
import { reopenTask, setTaskStatus, waitTask } from "./services/domainService.ts";
import { calendarRecordKey } from "./services/calendarSyncState.ts";

describe("Coupled CRM process review and guarded local undo", () => {
  let db: Awaited<ReturnType<typeof createPrismaClient>>;
  const originalFetch = globalThis.fetch;
  before(async () => { db = await createPrismaClient(); globalThis.fetch = async () => { throw new Error("External actions disabled in process review tests"); }; });
  after(async () => { globalThis.fetch = originalFetch; await db.$disconnect(); });
  async function fixture(options: { sales?: boolean; agreement?: boolean; crm?: Record<string, boolean> } = {}) {
    const tenant = await db.tenant.create({ data: { name: "Process review", slug: randomUUID(), timezone: "Asia/Almaty", settingsJson: {
      aiAutomation: { defaultMode: "AUTO", crm: { enabled: true, updateDealStage: true, ...options.crm }, salesProcess: { mode: options.sales ? "auto" : "off", notifyResponsible: false } },
    } } });
    const user = await db.user.create({ data: { email: `${randomUUID()}@example.test`, name: "Руководитель", passwordHash: "unused" } });
    const membership = await db.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: "owner" }, include: { tenant: true } });
    const auth = { user, activeMembership: membership, memberships: [membership] } as AuthContext;
    const contact = await db.contact.create({ data: { tenantId: tenant.id, name: "Клиент", ownerMembershipId: membership.id } });
    const from = await db.dealStage.create({ data: { tenantId: tenant.id, name: "Выяснение задачи", systemKey: "need_identified", sortOrder: 1, defaultProbability: 10 } });
    const to = await db.dealStage.create({ data: { tenantId: tenant.id, name: "Обсуждение условий", systemKey: "negotiation", sortOrder: 3, defaultProbability: 60 } });
    const deal = await db.deal.create({ data: { tenantId: tenant.id, contactId: contact.id, title: "Проект", stageId: from.id,
      nextAction: "Уточнить запрос", probability: 10, assigneeMembershipId: membership.id, updatedAt: new Date(Date.now() - 120000) } });
    await db.dealStageHistory.create({ data: { tenantId: tenant.id, dealId: deal.id, toStageId: from.id, toSystemKey: from.systemKey, enteredAt: new Date(Date.now() - 120000), changedByType: "user" } });
    const conversation = await db.conversation.create({ data: { tenantId: tenant.id, contactId: contact.id, mode: "ai", assigneeMembershipId: membership.id, messageRevision: 1 } });
    const inquiry = await db.inquiry.create({ data: { tenantId: tenant.id, contactId: contact.id, conversationId: conversation.id, dealId: deal.id, source: "whatsapp", status: "qualification", assigneeMembershipId: membership.id } });
    let message = await db.message.create({ data: { tenantId: tenant.id, conversationId: conversation.id, direction: "inbound", senderKind: "client", text: "Давайте обсудим условия на созвоне", createdAt: new Date(Date.now() - 1000) } });
    const at = new Date(Date.now() + 3 * 86400000);
    const analyze = async (input: { existingId?: string; action?: "reschedule" | "cancel" | "complete"; scheduledAt?: Date } = {}) => {
      const result = await analyzeConversationContext(db, auth, conversation.id, { useLlm: false });
      Object.assign(result.analysis, { confidence: "HIGH", evidenceMessageIds: [message.id], events: [], summaryUpdate: "Нужен созвон", suggestedNextAction: "Обсудить условия", suggestedDealStage: "negotiation", commercialFacts: [], intakeRequest: null,
        agreements: options.agreement === false ? [] : [{ action: input.action || "create", existingAgreementId: input.existingId, type: "CALL", title: "Обсудить условия", summary: "Обсудить сроки проекта", status: input.action === "reschedule" ? "RESCHEDULED" : "SCHEDULED", scheduledAt: (input.scheduledAt || at).toISOString(), createTask: true, confidence: "HIGH", evidenceMessageIds: [message.id] }],
      });
      return result;
    };
    const run = async (input?: Parameters<typeof analyze>[0]) => applyAnalyzedConversation(db, tenant.id, conversation.id, await analyze(input));
    const nextMessage = async () => {
      message = await db.message.create({ data: { tenantId: tenant.id, conversationId: conversation.id, direction: "inbound", senderKind: "client", text: "Перенесём созвон", createdAt: new Date(Date.now() + 1000) } });
      await db.conversation.update({ where: { id: conversation.id }, data: { messageRevision: { increment: 1 } } });
    };
    const list = (as = auth) => listConversationCrmReview(db, as, conversation.id);
    const review = async () => { const item = (await list()).items.find(i => i.entityType === "process"); assert.ok(item, "process review is visible"); return item; };
    const undo = (id: string, as = auth) => reviewConversationCrmChange(db, as, conversation.id, id, "undo");
    return { tenant, auth, user, membership, contact, deal, from, to, conversation, inquiry, analyze, run, nextMessage, list, review, undo, at };
  }

  it("shows the actual changes and undoes stage, new agreement, task and reminders together exactly once", async () => {
    const f = await fixture(); const result = await f.analyze(); await applyAnalyzedConversation(db, f.tenant.id, f.conversation.id, result);
    const item = await f.review(); assert.equal(item.canUndo, true);
    assert.deepEqual(item.process?.entries.map(e => e.entityType).sort(), ["agreement", "deal", "task"]);
    const stage = item.process!.entries.find(e => e.entityType === "deal")!.fields.find(x => x.label === "Стадия сделки");
    assert.equal(stage?.before, "Выяснение задачи"); assert.equal(stage?.after, "Обсуждение условий"); assert.equal(item.process?.reminders, 3);
    await f.undo(item.id); await f.undo(item.id);
    const deal = await db.deal.findUniqueOrThrow({ where: { id: f.deal.id } });
    assert.equal(deal.stageId, f.from.id); assert.equal(deal.probability, 10); assert.equal(deal.nextAction, "Уточнить запрос"); assert.equal(deal.nextActionAt, null); assert.equal(deal.version, f.deal.version + 2);
    assert.equal((await db.agreement.findFirstOrThrow({ where: { tenantId: f.tenant.id } })).status, "CANCELLED");
    assert.equal((await db.task.findFirstOrThrow({ where: { tenantId: f.tenant.id } })).status, "canceled");
    assert.equal(await db.scheduledAction.count({ where: { tenantId: f.tenant.id, state: "scheduled" } }), 0);
    const history = await db.dealStageHistory.findMany({ where: { dealId: f.deal.id }, orderBy: { enteredAt: "asc" } });
    assert.equal(history.length, 3); assert.equal(history.filter(h => h.leftAt === null).length, 1); assert.equal(history.at(-1)?.toStageId, f.from.id); assert.equal(history.at(-1)?.changedById, f.user.id);
    assert.ok(history.slice(0, -1).every(h => h.leftAt && h.leftAt >= h.enteredAt));
    assert.equal(await db.auditEvent.count({ where: { tenantId: f.tenant.id, action: "conversation.crm_undone" } }), 3);
    assert.equal(await db.activity.count({ where: { tenantId: f.tenant.id, type: "conversation.crm_undone" } }), 1);
    assert.equal((await f.review()).status, "undone");
    assert.equal((await f.review()).process?.reminders, 0);
    assert.equal((await f.review()).process?.queues?.find(q => q.kind === "reminders")?.canceled, 3);
    await applyAnalyzedConversation(db, f.tenant.id, f.conversation.id, result);
    assert.equal(await db.task.count({ where: { tenantId: f.tenant.id } }), 1); assert.equal(await db.message.count({ where: { tenantId: f.tenant.id } }), 1);
    assert.equal((await db.task.findFirstOrThrow({ where: { tenantId: f.tenant.id } })).status, "canceled");
  });
  it("restores an existing rescheduled agreement and task plus only future pending reminders", async () => {
    const f = await fixture(); await f.run();
    const old = await db.agreement.findFirstOrThrow({ where: { tenantId: f.tenant.id } });
    const task = await db.task.findFirstOrThrow({ where: { tenantId: f.tenant.id } });
    const reminders = await db.scheduledAction.findMany({ where: { tenantId: f.tenant.id, state: "scheduled" }, orderBy: { dueAt: "asc" } });
    await db.scheduledAction.update({ where: { id: reminders[0].id }, data: { dueAt: new Date(Date.now() - 1000) } });
    await f.nextMessage(); await f.run({ existingId: old.id, action: "reschedule", scheduledAt: new Date(f.at.getTime() + 86400000) });
    const item = await f.review(); assert.equal(item.canUndo, true); await f.undo(item.id);
    const restored = await db.agreement.findUniqueOrThrow({ where: { id: old.id } });
    assert.equal(restored.status, old.status); assert.equal(restored.scheduledAt?.toISOString(), old.scheduledAt?.toISOString());
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).dueAt?.toISOString(), task.dueAt?.toISOString());
    assert.equal(await db.agreement.count({ where: { tenantId: f.tenant.id } }), 1); assert.equal(await db.task.count({ where: { tenantId: f.tenant.id } }), 1);
    const pending = await db.scheduledAction.findMany({ where: { tenantId: f.tenant.id, state: "scheduled" } });
    assert.deepEqual(pending.map(x => x.id).sort(), reminders.slice(1).map(x => x.id).sort());
    assert.equal((await db.scheduledAction.findUniqueOrThrow({ where: { id: reminders[0].id } })).state, "canceled");
  });
  for (const action of ["cancel", "complete"] as const) it(`can reverse the AI's ${action} while preserving manual completion protection`, async () => {
    const f = await fixture(); await f.run(); const agreement = await db.agreement.findFirstOrThrow({ where: { tenantId: f.tenant.id } });
    await f.nextMessage(); await f.run({ action, existingId: agreement.id });
    const item = await f.review(); assert.equal(item.canUndo, true); await f.undo(item.id);
    assert.equal((await db.agreement.findUniqueOrThrow({ where: { id: agreement.id } })).status, "SCHEDULED");
    assert.equal((await db.task.findFirstOrThrow({ where: { tenantId: f.tenant.id } })).status, "open");
  });
  for (const field of ["description", "status", "priority", "messageDraft", "ownerMembershipId"] as const) it(`preserves a later employee task edit: ${field}`, async () => {
    const f = await fixture(); await f.run(); const item = await f.review();
    const task = await db.task.findFirstOrThrow({ where: { tenantId: f.tenant.id } });
    const value = field === "status" ? "done" : field === "priority" ? "high" : field === "ownerMembershipId" ? null : "Ручная правка";
    await db.task.update({ where: { id: task.id }, data: { [field]: value } });
    assert.equal((await f.review()).blockedReason, "changed"); await assert.rejects(f.undo(item.id), { code: "crm_review_changed" });
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } }))[field], value);
    assert.equal((await db.deal.findUniqueOrThrow({ where: { id: f.deal.id } })).stageId, f.to.id);
  });
  it("blocks a same-value save through the actual task editor", async () => {
    const f = await fixture(); await f.run(); const item = await f.review(); const task = await db.task.findFirstOrThrow({ where: { tenantId: f.tenant.id } });
    await setTaskStatus(db, f.auth, task.id, "open");
    assert.equal((await f.review()).blockedReason, "changed"); await assert.rejects(f.undo(item.id), { code: "crm_review_changed" });
  });
  it("preserves a manual change even after the employee returns the original status", async () => {
    const f = await fixture(); await f.run(); const item = await f.review(); const task = await db.task.findFirstOrThrow({ where: { tenantId: f.tenant.id } });
    await waitTask(db, f.auth, task.id); await reopenTask(db, f.auth, task.id);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status, task.status);
    assert.equal((await f.review()).blockedReason, "changed"); await assert.rejects(f.undo(item.id), { code: "crm_review_changed" });
    const agreement = await db.agreement.findFirstOrThrow({ where: { tenantId: f.tenant.id } });
    await f.nextMessage(); await f.run({ existingId: agreement.id, action: "reschedule", scheduledAt: new Date(f.at.getTime() + 86400000) });
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).dueAt?.toISOString(), task.dueAt?.toISOString());
    assert.equal((await f.review()).blockedReason, "related_activity");
  });
  it("blocks newly linked manual work instead of changing its deal context", async () => {
    const f = await fixture(); await f.run(); const item = await f.review();
    await db.task.create({ data: { tenantId: f.tenant.id, dealId: f.deal.id, contactId: f.contact.id, type: "custom", title: "План сотрудника" } });
    assert.equal((await f.review()).blockedReason, "related_activity"); await assert.rejects(f.undo(item.id), { code: "crm_review_changed" });
  });
  for (const state of ["running", "done", "failed"]) it(`blocks undo when reminder is ${state}`, async () => {
    const f = await fixture(); await f.run(); const item = await f.review(); const reminder = await db.scheduledAction.findFirstOrThrow({ where: { tenantId: f.tenant.id } });
    await db.scheduledAction.update({ where: { id: reminder.id }, data: { state, version: { increment: 1 } } });
    const queue = (await f.review()).process?.queues?.find(q => q.kind === "reminders");
    assert.equal(queue?.queued, 2);
    assert.equal(queue?.[state === "running" ? "running" : state === "done" ? "processed" : "needsCheck"], 1);
    assert.equal((await f.review()).blockedReason, "effects_started"); await assert.rejects(f.undo(item.id), { code: "crm_review_changed" });
  });
  it("blocks a newer scheduled action instead of dropping it", async () => {
    const f = await fixture(); await f.run(); const item = await f.review(); const agreement = await db.agreement.findFirstOrThrow({ where: { tenantId: f.tenant.id } });
    await db.scheduledAction.create({ data: { tenantId: f.tenant.id, type: "agreement_reminder_10", parentType: "agreement", parentId: agreement.id, dueAt: f.at } });
    assert.equal((await f.review()).blockedReason, "effects_started"); await assert.rejects(f.undo(item.id), { code: "crm_review_changed" });
  });
  it("does not claim to recall notices or events in a connected calendar", async () => {
    const f = await fixture(); await f.run(); const item = await f.review();
    const integration = await db.integration.create({ data: { tenantId: f.tenant.id, type: "calendar", publicKey: `google:calendar:${f.tenant.id}`, status: "active", name: "Calendar" } });
    assert.equal((await f.review()).blockedReason, "calendar"); await assert.rejects(f.undo(item.id), { code: "crm_review_changed" });
    await db.integration.update({ where: { id: integration.id }, data: { status: "disabled" } });
    assert.equal((await f.review()).blockedReason, "calendar");
    const other = await fixture(); await other.run();
    const agreement = await db.agreement.findFirstOrThrow({ where: { tenantId: other.tenant.id } });
    await db.notification.create({ data: { tenantId: other.tenant.id, recipientMembershipId: other.membership.id, episodeKey: randomUUID(), type: "agreement.reminder", entityType: "agreement", entityId: agreement.id, title: "Напоминание", body: "Созвон", priority: "normal" } });
    assert.equal((await other.review()).blockedReason, "effects_started");
  });
  it("blocks linked child work and documents/payment data on the deal", async () => {
    const f = await fixture(); await f.run(); const item = await f.review(); const task = await db.task.findFirstOrThrow({ where: { tenantId: f.tenant.id } });
    await db.task.create({ data: { tenantId: f.tenant.id, type: "custom", title: "Дополнительная работа", parentTaskId: task.id } });
    assert.equal((await f.review()).blockedReason, "related_activity"); await assert.rejects(f.undo(item.id), { code: "crm_review_changed" });
    const other = await fixture(); await other.run();
    await db.dealItem.create({ data: { tenantId: other.tenant.id, dealId: other.deal.id, name: "Услуга", quantity: 1, unitPrice: 100, amountWithoutVat: 100, vatRate: 0, vatAmount: 0, totalAmount: 100 } });
    assert.equal((await other.review()).blockedReason, "related_activity");
  });
  it("keeps calendar reconciliation required after the captured integration is removed", async () => {
    const f = await fixture();
    const integration = await db.integration.create({ data: { tenantId: f.tenant.id, type: "calendar", publicKey: `google:calendar:${f.tenant.id}`, status: "active", name: "Calendar" } });
    await f.run(); const item = await f.review();
    await db.integration.delete({ where: { id: integration.id } });
    assert.equal((await f.review()).blockedReason, "calendar");
    await assert.rejects(f.undo(item.id), { code: "crm_review_changed" });
    assert.equal((await db.agreement.findFirstOrThrow({ where: { tenantId: f.tenant.id } })).status, "SCHEDULED");
  });
  it("retains external history if a calendar was connected and removed after the local change", async () => {
    const f = await fixture(); await f.run(); const item = await f.review(); assert.equal(item.canUndo, true);
    const agreement = await db.agreement.findFirstOrThrow({ where: { tenantId: f.tenant.id } });
    const key = calendarRecordKey(f.tenant.id, randomUUID(), agreement.id);
    await db.idempotencyRecord.create({ data: { ...key, requestHash: randomUUID(), expiresAt: new Date("9999-12-31"),
      resultJson: { sourceHash: "prior-export", state: "synced", checkedAt: new Date().toISOString() } } });
    assert.equal((await f.review()).blockedReason, "calendar");
    assert.equal((await f.review()).process?.calendarEffects?.[0]?.state, "disconnected");
    await assert.rejects(f.undo(item.id), { code: "crm_review_changed" });
  });
  it("blocks changed stage rules and later deal edits", async () => {
    const f = await fixture(); await f.run(); const item = await f.review();
    await db.dealStage.update({ where: { id: f.from.id }, data: { isTerminal: true } });
    assert.equal((await f.review()).blockedReason, "related_activity"); await assert.rejects(f.undo(item.id), { code: "crm_review_changed" });
    await db.dealStage.update({ where: { id: f.from.id }, data: { isTerminal: false } });
    await db.deal.update({ where: { id: f.deal.id }, data: { nextAction: "Новый план сотрудника", version: { increment: 1 } } });
    assert.equal((await f.review()).blockedReason, "changed");
  });
  it("scopes the action, history and evidence to tenant and all affected owners", async () => {
    const f = await fixture(), other = await fixture(); await f.run(); const item = await f.review();
    await assert.rejects(f.undo(item.id, other.auth), { code: "not_found" });
    const manager = { ...f.auth, activeMembership: { ...f.membership, role: "manager" } } as AuthContext;
    assert.equal((await f.list(manager)).items.find(i => i.id === item.id)?.blockedReason, "permissions");
    await assert.rejects(f.undo(item.id, manager), { code: "forbidden" });
    await db.task.updateMany({ where: { tenantId: f.tenant.id }, data: { ownerMembershipId: null } });
    assert.ok(!(await f.list(manager)).items.some(i => i.id === item.id));
    assert.ok(!(await getContactOverview(db, manager, f.contact.id)).timeline.some(i => i.id === item.id));
    await assert.rejects(f.undo(item.id, manager), { code: "not_found" });
  });
  it("rejects stale messages and never accepts client-supplied replacement data", async () => {
    const f = await fixture(); await f.run(); const item = await f.review();
    await assert.rejects(reviewConversationCrmChange(db, f.auth, f.conversation.id, item.id, "accept"), { code: "crm_review_closed" });
    await f.nextMessage(); assert.equal((await f.review()).blockedReason, "conversation_changed"); await assert.rejects(f.undo(item.id), { code: "crm_review_changed" });
  });
  it("detects a source timestamp edit even without a message revision increment", async () => {
    const f = await fixture(); await f.run(); const item = await f.review();
    await db.message.update({ where: { id: item.evidence[0].id }, data: { createdAt: new Date(Date.now() + 1000) } });
    assert.equal((await f.review()).blockedReason, "conversation_changed"); await assert.rejects(f.undo(item.id), { code: "crm_review_changed" });
  });
  it("rolls earlier task, deal and history writes back if agreement restore fails", async () => {
    const f = await fixture(); await f.run(); const item = await f.review();
    const historyBefore = await db.dealStageHistory.findMany({ where: { tenantId: f.tenant.id }, orderBy: { enteredAt: "asc" } });
    const failing = new Proxy(db, { get(target, key) {
      if (key === "$transaction") return (callback: any, options: any) => db.$transaction(tx => callback(new Proxy(tx, { get(transaction, field) {
        if (field === "agreement") return new Proxy(transaction.agreement, { get(delegate, method) { if (method === "update") return async () => { throw new Error("synthetic undo failure"); }; return Reflect.get(delegate, method); } });
        return Reflect.get(transaction, field);
      } })), options);
      return Reflect.get(target, key);
    } });
    await assert.rejects(reviewConversationCrmChange(failing, f.auth, f.conversation.id, item.id, "undo"), /synthetic undo failure/);
    assert.equal((await f.review()).canUndo, true); assert.equal((await db.deal.findUniqueOrThrow({ where: { id: f.deal.id } })).stageId, f.to.id);
    assert.equal((await db.task.findFirstOrThrow({ where: { tenantId: f.tenant.id, agreementId: { not: null } } })).status, "open");
    assert.deepEqual(await db.dealStageHistory.findMany({ where: { tenantId: f.tenant.id }, orderBy: { enteredAt: "asc" } }), historyBefore);
    assert.equal(await db.auditEvent.count({ where: { tenantId: f.tenant.id, action: "conversation.crm_undone" } }), 0);
    assert.equal(await db.activity.count({ where: { tenantId: f.tenant.id, type: "conversation.crm_undone" } }), 0);
    await f.undo(item.id); assert.equal((await f.review()).status, "undone");
  });
  it("includes managed next-step tasks and cancels only the analysis's untouched queue entry", async () => {
    const f = await fixture({ sales: true, agreement: false }); await f.run(); const item = await f.review();
    assert.ok(item.process?.entries.some(e => e.entityType === "task")); assert.equal(item.canUndo, true);
    assert.equal(item.process?.queues?.find(q => q.kind === "actions")?.queued, 1);
    await f.undo(item.id);
    assert.equal((await db.task.findFirstOrThrow({ where: { tenantId: f.tenant.id, source: "sales_automation" } })).status, "canceled");
    assert.equal(await db.outboxEvent.count({ where: { tenantId: f.tenant.id, type: "sales.reconcile", processedAt: null } }), 0);
    const queue = (await f.review()).process?.queues?.find(q => q.kind === "actions");
    assert.equal(queue?.canceled, 1); assert.equal(queue?.processed, 0);
    const other = await fixture({ sales: true, agreement: false }); await other.run(); const blocked = await other.review();
    const event = await db.outboxEvent.findFirstOrThrow({ where: { tenantId: other.tenant.id, type: "sales.reconcile" } });
    await db.outboxEvent.update({ where: { id: event.id }, data: { availableAt: new Date(Date.now() + 90000) } });
    assert.equal((await other.review()).blockedReason, "effects_started"); await assert.rejects(other.undo(blocked.id), { code: "crm_review_changed" });
    await db.outboxEvent.update({ where: { id: event.id }, data: { attempts: 1 } });
    assert.equal((await other.review()).process?.queues?.find(q => q.kind === "actions")?.needsCheck, 1);
    await db.outboxEvent.update({ where: { id: event.id }, data: { processedAt: new Date() } });
    assert.equal((await other.review()).process?.queues?.find(q => q.kind === "actions")?.processed, 1);
  });
  it("loads a full process history with a bounded query count and fresh permission checks", async () => {
    const f = await fixture(); await f.run(); const item = await f.review();
    const activity = await db.activity.findUniqueOrThrow({ where: { id: item.id } });
    const metadata = activity.metadataJson as any;
    await db.activity.createMany({ data: Array.from({ length: 51 }, (_, index) => ({
      tenantId: f.tenant.id, contactId: f.contact.id, type: "conversation.crm_updated", title: "Предыдущее изменение ИИ", actorType: "ai",
      createdAt: new Date(activity.createdAt.getTime() + index + 1),
      metadataJson: { ...metadata, review: { ...metadata.review, messageRevision: 0 } },
    })) });
    let queries = 0;
    const counted = new Proxy(db, { get(target, key) {
      if (key === "$transaction") return (callback: any, options: any) => db.$transaction(tx => callback(new Proxy(tx, { get(transaction, field) {
        const delegate = Reflect.get(transaction, field);
        if (delegate && typeof delegate === "object") return new Proxy(delegate, { get(model, method) {
          const fn = Reflect.get(model, method);
          if (["findFirst", "findFirstOrThrow", "findUnique", "findUniqueOrThrow", "findMany", "count"].includes(String(method)) && typeof fn === "function") return (...args: any[]) => { queries++; return fn.apply(model, args); };
          return fn;
        } });
        return delegate;
      } })), options);
      return Reflect.get(target, key);
    } });
    const result = await listConversationCrmReview(counted, f.auth, f.conversation.id);
    assert.equal(result.items.length, 50); assert.equal(result.hasMore, true);
    assert.ok(result.items.every(i => i.entityType === "process" && i.blockedReason === "conversation_changed" && !i.canUndo));
    assert.ok(queries <= 25, `History needed ${queries} database reads`);
    const manager = { ...f.auth, activeMembership: { ...f.membership, role: "manager" } } as AuthContext;
    assert.equal((await f.list(manager)).items.length, 50);
    await db.task.updateMany({ where: { tenantId: f.tenant.id }, data: { ownerMembershipId: null } });
    assert.equal((await f.list(manager)).items.length, 0);
  });
});
