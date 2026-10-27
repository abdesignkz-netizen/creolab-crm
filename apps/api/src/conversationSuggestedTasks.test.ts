import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { emptyAiManagerDraft } from "@creolab/contracts";
import type { AuthContext } from "./lib/types.ts";
import type { SuggestedTask } from "./services/conversationContextTypes.ts";
import { analyzeConversationContext } from "./services/conversationContextService.ts";
import { applyAnalyzedConversation } from "./services/conversationContextApplyService.ts";
import { listConversationCrmReview, reviewConversationCrmChange } from "./services/conversationCrmReviewService.ts";
import { validateConversationRefinement } from "./services/conversationAnalysisValidation.ts";
import { getContactOverview } from "./services/contactService.ts";
import { setTaskStatus } from "./services/domainService.ts";

describe("Independent contextual task suggestions", () => {
  let db: Awaited<ReturnType<typeof createPrismaClient>>;
  const originalFetch = globalThis.fetch;
  before(async () => { db = await createPrismaClient(); globalThis.fetch = async () => { throw new Error("External actions disabled in task suggestion tests"); }; });
  after(async () => { globalThis.fetch = originalFetch; await db.$disconnect(); });

  async function fixture(mode = "ASSIST") {
    const tenant = await db.tenant.create({ data: { name: "Task suggestions", slug: randomUUID(), timezone: "Asia/Almaty", settingsJson: {
      aiAutomation: { defaultMode: mode, crm: { enabled: true, updateContact: false, updateInquiry: false, updateNextAction: false, updateDealStage: false }, salesProcess: { mode: "off", notifyResponsible: false } },
    } } });
    const user = await db.user.create({ data: { email: `${randomUUID()}@example.test`, name: "Айбек", passwordHash: "unused" } });
    const membership = await db.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: "owner" }, include: { tenant: true } });
    const auth = { user, activeMembership: membership, memberships: [membership] } as AuthContext;
    const contact = await db.contact.create({ data: { tenantId: tenant.id, name: "Дана", ownerMembershipId: membership.id } });
    const conversation = await db.conversation.create({ data: { tenantId: tenant.id, contactId: contact.id, mode: "ai", assigneeMembershipId: membership.id, messageRevision: 1 } });
    const inquiry = await db.inquiry.create({ data: { tenantId: tenant.id, contactId: contact.id, conversationId: conversation.id, source: "whatsapp", status: "qualification", assigneeMembershipId: membership.id } });
    let message = await db.message.create({ data: { tenantId: tenant.id, conversationId: conversation.id, direction: "inbound", senderKind: "client", text: "Рассчитайте стоимость презентации на двадцать слайдов", createdAt: new Date(Date.now() - 1000) } });
    const future = new Date(Date.now() + 3 * 86400000).toISOString();
    const suggestion = (changes: Partial<SuggestedTask> = {}): SuggestedTask => ({ type: "prepare_estimate", title: "Рассчитать стоимость презентации", purpose: "Назвать клиенту стоимость", briefingText: "Презентация на 20 слайдов", preparationHints: ["Уточнить объём иллюстраций"], dueAt: null, linkedAgreementIndex: null, confidence: "HIGH", evidenceMessageIds: [message.id], ...changes });
    const analyze = async (tasks = [suggestion()]) => {
      const result = await analyzeConversationContext(db, auth, conversation.id, { useLlm: false });
      Object.assign(result.analysis, { confidence: "HIGH", evidenceMessageIds: [message.id], events: [], suggestedTasks: tasks,
        summaryUpdate: "Клиенту нужен расчёт для презентации на 20 слайдов", suggestedNextAction: null, suggestedDealStage: null, agreements: [], commercialFacts: [], intakeRequest: null });
      return result;
    };
    const run = async (tasks?: SuggestedTask[]) => applyAnalyzedConversation(db, tenant.id, conversation.id, await analyze(tasks));
    const list = async () => (await listConversationCrmReview(db, auth, conversation.id)).items.filter(i => i.entityType === "process");
    const review = async () => { const item = (await list()).find(i => i.status === "pending") || (await list())[0]; assert.ok(item, "process proposal visible"); return item; };
    const decide = (id: string, decision: "accept" | "dismiss" | "undo", as = auth) => reviewConversationCrmChange(db, as, conversation.id, id, decision);
    const next = async () => {
      message = await db.message.create({ data: { tenantId: tenant.id, conversationId: conversation.id, direction: "inbound", senderKind: "client", text: "Рассчитайте ещё один проект на двадцать слайдов", createdAt: new Date(Date.now() + 2000) } });
      await db.conversation.update({ where: { id: conversation.id }, data: { messageRevision: { increment: 1 } } });
    };
    const manual = (title = "Ручная задача") => db.task.create({ data: { tenantId: tenant.id, type: "prepare_estimate", title, contactId: contact.id, ownerMembershipId: membership.id, source: "manual" } });
    return { tenant, auth, user, membership, contact, conversation, inquiry, suggestion, analyze, run, list, review, decide, next, manual, future };
  }

  it("previews a task with no agreement, known context, owner, sources and no invented deadline", async () => {
    const f = await fixture(); assert.equal((await f.run()).skipped, "suggestions_only");
    const p = await f.review(); assert.equal(p.canAccept, true); assert.equal(p.process?.entries.length, 1); assert.equal(p.process?.entries[0].entityType, "task");
    const fields = p.process!.entries[0].fields;
    assert.equal(fields.find(v => v.label === "Срок")?.after, "Без срока");
    assert.equal(fields.find(v => v.label === "Исполнитель")?.after, "Айбек");
    assert.equal(fields.find(v => v.label === "Цель")?.after, "Назвать клиенту стоимость");
    assert.equal(fields.find(v => v.label === "Подготовка")?.after, "Уточнить объём иллюстраций");
    assert.equal(p.evidence.length, 1); assert.equal(p.process?.reminders, 0);
    for (const delegate of [db.task, db.agreement, db.scheduledAction, db.outboxEvent, db.notification]) assert.equal(await delegate.count({ where: { tenantId: f.tenant.id } } as never), 0);
    await f.run(); assert.equal((await f.list()).length, 1);
  });
  it("approves exactly once, links client and inquiry, records history and cancels on undo", async () => {
    const f = await fixture(); await f.run(); const p = await f.review();
    await Promise.all([f.decide(p.id, "accept"), f.decide(p.id, "accept")]);
    const task = await db.task.findFirstOrThrow({ where: { tenantId: f.tenant.id } });
    assert.equal(await db.task.count({ where: { tenantId: f.tenant.id } }), 1);
    assert.equal(task.contactId, f.contact.id); assert.equal(task.conversationId, f.conversation.id); assert.equal(task.inquiryId, f.inquiry.id); assert.equal(task.agreementId, null);
    assert.equal(task.ownerMembershipId, f.membership.id); assert.equal((task.contextSnapshotJson as Record<string, unknown>).executorType, "USER");
    assert.deepEqual(task.sourceMessageIdsJson, p.evidence.map(m => m.id)); assert.equal(task.dueAt, null); assert.equal(task.purpose, "Назвать клиенту стоимость");
    assert.equal((await f.review()).status, "accepted"); assert.equal((await f.review()).canUndo, true);
    assert.ok((await getContactOverview(db, f.auth, f.contact.id)).timeline.some(item => item.id === p.id));
    assert.equal(await db.auditEvent.count({ where: { tenantId: f.tenant.id, entityType: "task", entityId: task.id, actorUserId: f.user.id } }), 1);
    await f.decide(p.id, "undo"); await f.decide(p.id, "undo"); await f.run();
    assert.equal((await f.review()).status, "undone"); assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status, "canceled");
    assert.equal(await db.task.count({ where: { tenantId: f.tenant.id } }), 1); assert.equal((await f.list()).length, 1);
  });
  it("AUTO also waits for task approval and never starts a send or schedules reminders", async () => {
    const f = await fixture("AUTO"); const suggestions = [f.suggestion({ type: "send_documents", title: "Подготовить документы для клиента", dueAt: f.future })]; await f.run(suggestions);
    const p = await f.review(); assert.equal(p.status, "pending"); assert.equal(p.canAccept, true); assert.equal(await db.task.count({ where: { tenantId: f.tenant.id } }), 0);
    assert.equal((await f.run(suggestions)).skipped, "already_applied"); assert.equal((await f.review()).id, p.id); await f.decide(p.id, "accept");
    const task = await db.task.findFirstOrThrow({ where: { tenantId: f.tenant.id } });
    assert.equal(task.executionStatus, "prepared"); assert.equal(task.commandStatus, "needs_confirmation"); assert.equal(task.messageDraft, null); assert.equal(task.sentAt, null);
    assert.equal((task.contextSnapshotJson as Record<string, unknown>).executorType, "USER");
    for (const delegate of [db.outboxEvent, db.scheduledAction, db.notification]) assert.equal(await delegate.count({ where: { tenantId: f.tenant.id } } as never), 0);
    assert.equal(await db.message.count({ where: { tenantId: f.tenant.id } }), 1);
  });
  it("does not revive dismissal on the same source", async () => {
    const f = await fixture(); await f.run(); const p = await f.review(); await f.decide(p.id, "dismiss"); await f.run([f.suggestion({ title: "Другое название расчёта" })]);
    assert.equal((await f.review()).status, "dismissed"); assert.equal((await f.list()).length, 1); assert.equal(await db.task.count({ where: { tenantId: f.tenant.id } }), 0);
  });
  for (const invalid of ["low", "linked", "foreign", "empty", "type", "date", "past", "meeting_without_time", "long"] as const) it(`ignores ${invalid} task recommendations`, async () => {
    const f = await fixture(); const task = f.suggestion();
    if (invalid === "low") task.confidence = "MEDIUM";
    if (invalid === "linked") task.linkedAgreementIndex = 99;
    if (invalid === "foreign") task.evidenceMessageIds.push(randomUUID());
    if (invalid === "empty") task.title = "  ";
    if (invalid === "type") task.type = "delete_all";
    if (invalid === "date") task.dueAt = "завтра";
    if (invalid === "past") task.dueAt = new Date(Date.now() - 10000).toISOString();
    if (invalid === "meeting_without_time") task.type = "meeting";
    if (invalid === "long") task.title = "А".repeat(201);
    await f.run([task]); assert.equal((await f.list()).length, 0); assert.equal(await db.task.count({ where: { tenantId: f.tenant.id } }), 0);
  });
  it("does not let AI words or internal messages become task instructions", async () => {
    const f = await fixture(); const result = await f.analyze();
    await db.message.update({ where: { id: result.sourceMessageId! }, data: { direction: "outbound", senderKind: "ai" } });
    await f.run(); assert.equal((await f.list()).length, 0);
    const f2 = await fixture(); const result2 = await f2.analyze();
    await db.message.update({ where: { id: result2.sourceMessageId! }, data: { direction: "outbound", senderKind: "staff", internal: true } });
    await assert.rejects(applyAnalyzedConversation(db, f2.tenant.id, f2.conversation.id, result2), { code: "stale_analysis" });
  });
  it("requires the latest source and confident overall context", async () => {
    const f = await fixture(); const old = f.suggestion(); await f.next(); await f.run([old]); assert.equal((await f.list()).length, 0);
    const result = await f.analyze(); result.analysis.confidence = "LOW";
    await applyAnalyzedConversation(db, f.tenant.id, f.conversation.id, result); assert.equal((await f.list()).length, 0);
  });
  it("strips model-supplied owners, tenants, execution and status fields", async () => {
    const f = await fixture(); const task = { ...f.suggestion(), tenantId: randomUUID(), ownerMembershipId: randomUUID(), status: "done", source: "manual", contextSnapshotJson: { executorType: "AI" }, messageDraft: "Send now", sentAt: f.future };
    await f.run([task]); await f.decide((await f.review()).id, "accept"); const stored = await db.task.findFirstOrThrow({ where: { tenantId: f.tenant.id } });
    assert.equal(stored.ownerMembershipId, f.membership.id); assert.equal(stored.status, "open"); assert.equal(stored.source, "context_engine"); assert.equal(stored.messageDraft, null); assert.equal(stored.sentAt, null);
  });
  it("deduplicates normalized titles, existing manual work and repeated calls", async () => {
    const f = await fixture(); await f.manual("  РАССЧИТАТЬ стоимость презентации! "); await f.run(); assert.equal((await f.list()).length, 0);
    const f2 = await fixture(); await f2.run([f2.suggestion(), f2.suggestion({ title: "РАССЧИТАТЬ стоимость презентации!", dueAt: f2.future }), f2.suggestion({ type: "call", title: "Позвонить клиенту", dueAt: f2.future }), f2.suggestion({ type: "call", title: "Обсудить проект", dueAt: f2.future })]);
    assert.equal((await f2.review()).process?.entries.length, 2);
  });
  it("caps the proposal at five new tasks", async () => {
    const f = await fixture(); await f.run(Array.from({ length: 20 }, (_, i) => f.suggestion({ title: `Уточнить часть проекта ${i}` })));
    assert.equal((await f.review()).process?.entries.length, 5);
  });
  it("recognizes identical manual work regardless of its category", async () => {
    const f = await fixture(); const manual = await f.manual(f.suggestion().title);
    await db.task.update({ where: { id: manual.id }, data: { type: "other" } }); await f.run(); assert.equal((await f.list()).length, 0);
  });
  it("does not bypass duplicate checks when the client workset exceeds the review limit", async () => {
    const f = await fixture(); await db.task.createMany({ data: Array.from({ length: 201 }, (_, i) => ({ tenantId: f.tenant.id, contactId: f.contact.id, title: `Работа ${i}`, type: "other" })) });
    await f.run(); assert.equal((await f.list()).length, 0);
  });
  for (const change of ["new_task", "edited_task", "completed_task", "source", "owner", "settings", "message"] as const) it(`invalidates approval after ${change}`, async () => {
    const f = await fixture(); const existing = await f.manual(); await f.run(); const p = await f.review();
    if (change === "new_task") await f.manual("Появилась ещё одна задача");
    if (change === "edited_task") await setTaskStatus(db, f.auth, existing.id, existing.status);
    if (change === "completed_task") await db.task.update({ where: { id: existing.id }, data: { status: "done" } });
    if (change === "source") await db.message.update({ where: { id: p.evidence[0].id }, data: { text: "Расчёт уже не нужен" } });
    if (change === "owner") await db.conversation.update({ where: { id: f.conversation.id }, data: { assigneeMembershipId: null } });
    if (change === "settings") await db.tenant.update({ where: { id: f.tenant.id }, data: { settingsJson: { aiAutomation: { defaultMode: "ASSIST", crm: { enabled: true, createTasks: false } } } } });
    if (change === "message") await f.next();
    assert.equal((await f.review()).canAccept, false); await assert.rejects(f.decide(p.id, "accept"), { code: "crm_review_changed" });
    assert.equal(await db.task.count({ where: { tenantId: f.tenant.id, source: "context_engine" } }), 0);
  });
  it("honors createTasks=false and leaves inactive owners unassigned", async () => {
    const f = await fixture(); await db.tenant.update({ where: { id: f.tenant.id }, data: { settingsJson: { aiAutomation: { defaultMode: "ASSIST", crm: { enabled: true, createTasks: false } } } } });
    await f.run(); assert.equal((await f.list()).length, 0);
    const f2 = await fixture(); const inactive = await db.membership.create({ data: { tenantId: f2.tenant.id, userId: (await db.user.create({ data: { name: "Бывший сотрудник", email: `${randomUUID()}@example.test`, passwordHash: "unused" } })).id, role: "manager", active: false } });
    await db.conversation.update({ where: { id: f2.conversation.id }, data: { assigneeMembershipId: inactive.id } });
    await f2.run(); assert.equal((await f2.review()).process?.entries[0].fields.find(v => v.label === "Исполнитель")?.after, null);
  });
  it("never resurrects completed work from its original source, but allows later requests", async () => {
    const f = await fixture(); const task = await f.manual(f.suggestion().title);
    await db.task.update({ where: { id: task.id }, data: { status: "done", sourceMessageIdsJson: f.suggestion().evidenceMessageIds } });
    await f.run([f.suggestion({ title: "Подготовить новый расчёт" })]); assert.equal((await f.list()).length, 0);
    await f.next(); await f.run(); assert.equal((await f.review()).canAccept, true);
  });
  it("does not let suggestions bypass agreement task ownership and booking guards", async () => {
    const f = await fixture(); const result = await f.analyze([f.suggestion({ type: "call", title: "Позвонить по проекту", dueAt: f.future })]);
    result.analysis.agreements = [{ action: "create", type: "CALL", title: "Уточнить время звонка", status: "NEEDS_CLARIFICATION", scheduledAt: null, confidence: "MEDIUM", createTask: false, evidenceMessageIds: result.analysis.evidenceMessageIds }];
    await applyAnalyzedConversation(db, f.tenant.id, f.conversation.id, result); assert.equal((await f.list()).length, 0);
  });
  it("combines unrelated task and agreement actions in one reversible review", async () => {
    const f = await fixture(); const result = await f.analyze();
    result.analysis.agreements = [{ action: "create", type: "CALL", title: "Обсудить проект", status: "CONFIRMED", scheduledAt: f.future, confidence: "HIGH", createTask: true, evidenceMessageIds: result.analysis.evidenceMessageIds }];
    await applyAnalyzedConversation(db, f.tenant.id, f.conversation.id, result); const p = await f.review(); assert.equal(p.process?.entries.length, 3);
    await f.decide(p.id, "accept"); assert.equal(await db.task.count({ where: { tenantId: f.tenant.id } }), 2); await f.decide(p.id, "undo");
    assert.equal(await db.task.count({ where: { tenantId: f.tenant.id, status: "open" } }), 0);
  });
  it("does not turn a booking preference into an independent appointment", async () => {
    const f = await fixture(); const draft = emptyAiManagerDraft(); draft.primaryRole = "booking";
    await db.aIConfiguration.create({ data: { tenantId: f.tenant.id, enabled: true, promptStatus: "published", systemPrompt: "Booking", limitsJson: { aiSetup: { currentVersionId: "published", versions: [{ id: "published", prompt: "Booking", draft }] } } } });
    await f.run([f.suggestion({ type: "meeting", title: "Записать клиента на приём", dueAt: f.future })]); assert.equal((await f.list()).length, 0);
    await f.run([f.suggestion({ type: "message", title: "Уточнить удобное время" })]); assert.equal((await f.review()).canAccept, true);
  });
  it("allows a fresh standalone review in AUTO after manual work, without replaying automatic changes", async () => {
    const f = await fixture("AUTO"); await f.run(); const old = await f.review(); await f.manual();
    assert.equal((await f.review()).canAccept, false); assert.equal((await f.run()).skipped, "already_applied");
    const fresh = await f.review(); assert.notEqual(fresh.id, old.id); assert.equal(fresh.canAccept, true);
    assert.equal((await f.list()).find(p => p.id === old.id)?.status, "superseded");
    assert.equal(await db.task.count({ where: { tenantId: f.tenant.id, source: "context_engine" } }), 0);
  });
  it("withdraws an old proposal when the employee has created the same task", async () => {
    const f = await fixture(); await f.run(); const old = await f.review(); await f.manual(f.suggestion().title); await f.run();
    assert.equal((await f.list()).find(p => p.id === old.id)?.status, "superseded"); assert.equal((await f.list()).filter(p => p.status === "pending").length, 0);
  });
  it("rolls back the group if writing any task fails", async () => {
    const f = await fixture(); await f.run([f.suggestion(), f.suggestion({ type: "message", title: "Уточнить иллюстрации" })]); const p = await f.review();
    // Simulate a write failure after the first task was inserted, inside the real transaction.
    const failingDb = db.$extends({ query: { task: { async create({ args, query }) {
      if (args.data.title === "Уточнить иллюстрации") throw new Error("Simulated task write failure");
      return query(args);
    } } } });
    await assert.rejects(reviewConversationCrmChange(failingDb as typeof db, f.auth, f.conversation.id, p.id, "accept"), /Simulated task write failure/);
    assert.equal(await db.task.count({ where: { tenantId: f.tenant.id } }), 0); assert.equal((await f.review()).status, "pending");
    assert.equal(await db.auditEvent.count({ where: { tenantId: f.tenant.id, action: "conversation.crm_reviewed" } }), 0);
  });
  it("blocks a due date that expires while awaiting review", async () => {
    const f = await fixture(); await f.run([f.suggestion({ dueAt: f.future })]); const p = await f.review(); const now = Date.now;
    try { Date.now = () => Date.parse(f.future) + 1; assert.equal((await f.review()).blockedReason, "expired"); await assert.rejects(f.decide(p.id, "accept"), { code: "crm_review_changed" }); }
    finally { Date.now = now; }
  });
  it("protects manual work after acceptance and isolates companies", async () => {
    const f = await fixture(); const other = await fixture(); await f.run(); const p = await f.review();
    await assert.rejects(f.decide(p.id, "accept", other.auth), { status: 404 });
    await f.decide(p.id, "accept"); const task = await db.task.findFirstOrThrow({ where: { tenantId: f.tenant.id } });
    await setTaskStatus(db, f.auth, task.id, "open"); assert.equal((await f.review()).canUndo, false);
    await assert.rejects(f.decide(p.id, "undo"), { code: "crm_review_changed" });
  });
  it("drops only malformed optional tasks while keeping valid context and stripping unknown fields", () => {
    const valid = { type: "message", title: "Уточнить требования", evidenceMessageIds: ["m"], confidence: "HIGH", ownerMembershipId: "foreign" };
    const result = validateConversationRefinement({ summaryUpdate: "Клиент просит расчёт", suggestedTasks: [{ ...valid, dueAt: "maybe" }, { ...valid, title: " " }, { ...valid, preparationHints: ["x".repeat(501)] }, valid] }, ["m"]);
    assert.equal(result?.summaryUpdate, "Клиент просит расчёт"); assert.equal(result?.suggestedTasks?.length, 1);
    assert.equal((result?.suggestedTasks?.[0] as unknown as Record<string, unknown>).ownerMembershipId, undefined);
  });
});
