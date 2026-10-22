import assert from "node:assert/strict";
import { before, after, describe, it, mock } from "node:test";
import { randomUUID } from "node:crypto";
import { createPrismaClient } from "@creolab/db";
import { aiManagerDraftSchema, compileAiManagerDraft, emptyAiManagerDraft, defaultAiIntakeSettings, missingIntakeFields, readAiIntakeRecords, aiIntakeExtractionSchema, getAiSetupScenarios, type AiIntakeExtraction, type IntakeKind } from "@creolab/contracts";
import { validateConversationRefinement } from "./services/conversationAnalysisValidation.ts";
import { analyzeConversationContext } from "./services/conversationContextService.ts";
import { applyAnalyzedConversation } from "./services/conversationContextApplyService.ts";
import { publishedIntakePolicy } from "./services/aiIntakeService.ts";
import { getInquiry } from "./services/inquiryService.ts";
import { invalidateRuntimeConfig } from "./services/runtimeSettings.ts";
import type { AuthContext } from "./lib/types.ts";

it("migrates old questionnaires and gates automatic execution in the compiler", () => {
  const old = emptyAiManagerDraft(); delete (old as any).intake;
  assert.equal(aiManagerDraftSchema.parse(old).intake.confirmation, "staff");
  const draft = emptyAiManagerDraft(); draft.primaryRole = "food_order";
  draft.intake.confirmation = "automatic";
  assert.ok(compileAiManagerDraft(draft).issues.some(i => i.code === "intake_automatic_unavailable" && i.level === "error"));
  draft.intake.confirmation = "staff";
  assert.match(compileAiManagerDraft(draft).prompt, /Аллергию/);
  assert.match(compileAiManagerDraft(draft).prompt, /не гарантируй отсутствие аллергена/);
  draft.additionalRoles = ["booking", "product_order", "sales"];
  assert.equal(getAiSetupScenarios(draft).filter(s => s.required && s.id.startsWith("intake_")).length, 3);
});
it("requires core details, keeps pickup address optional, and rejects forged confirmation fields", () => {
  const request = aiIntakeExtractionSchema.parse({ kind: "product_order", confidence: "HIGH", evidenceMessageIds: ["m"], fields: { fulfillment: "pickup", contact: "77000000000" }, items: [{ name: "Item", quantity: 2 }] });
  assert.deepEqual(missingIntakeFields(request, defaultAiIntakeSettings()), []);
  request.fields.fulfillment = "delivery";
  assert.deepEqual(missingIntakeFields(request, defaultAiIntakeSettings()), ["address"]);
  request.items![0].quantity = null;
  assert.deepEqual(missingIntakeFields(request, defaultAiIntakeSettings()), ["items", "address"]);
  assert.equal(aiIntakeExtractionSchema.safeParse({ ...request, confirmed: true }).success, false);
  assert.equal(aiIntakeExtractionSchema.safeParse({ ...request, items: [{ name: "Item", quantity: -1 }] }).success, false);
  assert.equal(aiManagerDraftSchema.safeParse({ intake: { booking: { requiredFields: [] } } }).success, false);
});
it("drops malformed or ungrounded extraction without losing other valid analysis", () => {
  const request = { kind: "booking", confidence: "HIGH", evidenceMessageIds: ["other"], fields: {} };
  assert.equal(validateConversationRefinement({ summaryUpdate: "Summary", intakeRequest: request }, ["m"])?.intakeRequest, null);
  assert.equal(validateConversationRefinement({ summaryUpdate: "Summary", intakeRequest: { ...request, fields: { money: 1 } } }, ["other"])?.summaryUpdate, "Summary");
});

describe("structured booking and order intake", () => {
  let db: Awaited<ReturnType<typeof createPrismaClient>>;
  before(async () => { db = await createPrismaClient(); });
  after(async () => { await db.$disconnect(); });
  async function fixture(kind: IntakeKind = "booking", options: { crm?: boolean; createTasks?: boolean; aiMode?: string; conversationMode?: string } = {}) {
    const tenant = await db.tenant.create({ data: { name: "Intake test", slug: randomUUID(), timezone: "Asia/Almaty", settingsJson: { aiAutomation: { defaultMode: options.aiMode || "AUTO", crm: { enabled: options.crm !== false, createTasks: options.createTasks !== false } } } } });
    const user = await db.user.create({ data: { name: "Owner", email: `${randomUUID()}@example.test`, passwordHash: "unused" } });
    const member = await db.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: "owner" }, include: { tenant: true } });
    const auth = { user, activeMembership: member, memberships: [member] } as unknown as AuthContext;
    const contact = await db.contact.create({ data: { tenantId: tenant.id, name: "Client", ownerMembershipId: member.id } });
    await db.contactMethod.create({ data: { tenantId: tenant.id, contactId: contact.id, type: "phone", rawValue: "+77001234567", normalizedValue: "77001234567", source: "test" } });
    const conversation = await db.conversation.create({ data: { tenantId: tenant.id, contactId: contact.id, mode: options.conversationMode || "ai", assigneeMembershipId: member.id, messageRevision: 1 } });
    const inquiry = await db.inquiry.create({ data: { tenantId: tenant.id, contactId: contact.id, conversationId: conversation.id, source: "whatsapp", status: "qualification", normalizedJson: { preserved: "fact" } } });
    const message = await db.message.create({ data: { tenantId: tenant.id, conversationId: conversation.id, direction: "inbound", senderKind: "client", text: "Запишите на стрижку завтра в 15:00. Или хочу 2 товара самовывозом.", operationState: "sent" } });
    const draft = emptyAiManagerDraft(); draft.primaryRole = kind;
    const config = await db.aIConfiguration.create({ data: { tenantId: tenant.id, enabled: true, promptStatus: "published", systemPrompt: "Published intake", limitsJson: { aiSetup: { currentVersionId: "published", draft: { ...draft, primaryRole: "support" }, versions: [{ id: "published", prompt: "Published intake", draft }] } } } });
    const result = await analyzeConversationContext(db, auth, conversation.id, { useLlm: false });
    const extraction: AiIntakeExtraction = { kind, action: "collect", confidence: "HIGH", evidenceMessageIds: [message.id], fields: kind === "booking" ? { service: "Стрижка", preferredDate: "завтра", preferredTime: "15:00" } : { fulfillment: "pickup" }, items: kind === "booking" ? [] : [{ name: "Товар", quantity: 2 }] };
    Object.assign(result.analysis, { confidence: "HIGH", evidenceMessageIds: [message.id], intakeRequest: extraction, events: [], agreements: [], suggestedTasks: [] });
    const run = () => applyAnalyzedConversation(db, tenant.id, conversation.id, result);
    const records = async () => readAiIntakeRecords((await db.inquiry.findUniqueOrThrow({ where: { id: inquiry.id } })).normalizedJson);
    const tasks = () => db.task.findMany({ where: { tenantId: tenant.id, source: "ai_intake" } });
    const next = async (fields: AiIntakeExtraction["fields"], action: AiIntakeExtraction["action"] = "collect", items?: AiIntakeExtraction["items"]) => {
      const msg = await db.message.create({ data: { tenantId: tenant.id, conversationId: conversation.id, direction: "inbound", senderKind: "client", text: "Уточнение заявки", operationState: "sent", createdAt: new Date(result.sourceMessageAt!.getTime() + 1000) } });
      await db.conversation.update({ where: { id: conversation.id }, data: { messageRevision: { increment: 1 } } });
      Object.assign(result, await analyzeConversationContext(db, auth, conversation.id, { useLlm: false }));
      Object.assign(result.analysis, { confidence: "HIGH", evidenceMessageIds: [msg.id], intakeRequest: { ...extraction, fields, action, items, evidenceMessageIds: [msg.id] }, events: [], agreements: [] });
      return msg;
    };
    return { tenant, member, auth, contact, conversation, inquiry, message, config, draft, result, extraction, run, records, tasks, next };
  }
  for (const kind of ["booking", "product_order", "food_order"] as const) it(`stores ${kind} in the request and history and creates one staff review task`, async () => {
    const f = await fixture(kind); await f.run(); await f.run();
    const [record] = await f.records(); assert.equal(record.state, "needs_review"); assert.equal(record.fields.contact, "+77001234567");
    assert.equal((await f.tasks()).length, 1); assert.equal((await f.tasks())[0].ownerMembershipId, f.member.id);
    assert.equal(await db.activity.count({ where: { tenantId: f.tenant.id, type: "ai.intake_updated" } }), 1);
    assert.equal(await db.agreement.count({ where: { tenantId: f.tenant.id } }), 0);
    assert.equal(await db.dealItem.count({ where: { tenantId: f.tenant.id } }), 0);
    assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: f.inquiry.id } })).normalizedJson.preserved, "fact");
    assert.equal((await getInquiry(db, f.auth, f.inquiry.id)).intakeRequests[0].taskId, record.taskId);
  });
  it("collects missing details across messages and keeps delivery incomplete without an address", async () => {
    const f = await fixture("food_order"); f.extraction.fields.fulfillment = "delivery";
    await f.run(); assert.equal((await f.records())[0].state, "collecting"); assert.equal((await f.tasks()).length, 0);
    await f.next({ address: "Алматы, тестовый адрес", notes: "Без орехов, аллергия" }); await f.run();
    const [record] = await f.records(); assert.equal(record.fields.fulfillment, "delivery"); assert.equal(record.items.length, 1); assert.equal(record.state, "needs_review");
    assert.match((await f.tasks())[0].description!, /аллергия/);
  });
  it("replaces the whole basket, including explicit removal, and refreshes untouched task details", async () => {
    const f = await fixture("product_order"); await f.run();
    await f.next({}, "change", [{ name: "Другой товар", quantity: 3, variant: "Большой" }]); await f.run();
    assert.equal((await f.records())[0].items[0].name, "Другой товар");
    assert.match((await f.tasks())[0].description!, /Другой товар/);
    await f.next({}, "collect", []); await f.run();
    assert.equal((await f.records())[0].items.length, 0);
    assert.ok((await f.records())[0].missingFields.includes("items"));
    assert.match((await f.tasks())[0].description!, /Не хватает/);
  });
  it("rejects delivery when the published setup only permits pickup", async () => {
    const f = await fixture("product_order"); f.draft.intake.fulfillment = ["pickup"];
    await db.aIConfiguration.update({ where: { id: f.config.id }, data: { limitsJson: { aiSetup: { currentVersionId: "published", versions: [{ id: "published", prompt: "Published intake", draft: f.draft }] } } } });
    f.extraction.fields = { fulfillment: "delivery", address: "Адрес" }; await f.run();
    assert.ok((await f.records())[0].missingFields.includes("fulfillment")); assert.equal((await f.tasks()).length, 0);
  });
  it("deduplicates concurrent processing of the same message", async () => {
    const f = await fixture("product_order"); await Promise.all([f.run(), f.run()]);
    assert.equal((await f.tasks()).length, 1);
    assert.equal(await db.activity.count({ where: { tenantId: f.tenant.id, type: "ai.intake_updated" } }), 1);
  });
  it("does not expose another tenant's intake or turn a WhatsApp ID into a phone", async () => {
    const f = await fixture(); const other = await fixture();
    await db.contactMethod.deleteMany({ where: { tenantId: f.tenant.id, contactId: f.contact.id } });
    await db.conversation.update({ where: { id: f.conversation.id }, data: { externalThreadId: "36322639085811@lid" } });
    await f.run(); assert.ok((await f.records())[0].missingFields.includes("contact"));
    assert.equal((await f.tasks()).length, 0);
    await assert.rejects(() => getInquiry(db, other.auth, f.inquiry.id));
  });
  it("uses published settings, not a changed draft, and rejects stale/unpublished configuration", async () => {
    const f = await fixture(); assert.ok(await db.$transaction(tx => publishedIntakePolicy(tx, f.tenant.id)));
    await db.aIConfiguration.update({ where: { id: f.config.id }, data: { systemPrompt: "Edited outside wizard" } });
    await f.run(); assert.equal((await f.records()).length, 0);
    assert.equal(await db.$transaction(tx => publishedIntakePolicy(tx, f.tenant.id)), null);
  });
  for (const option of [{ crm: false }, { aiMode: "MANUAL" }, { aiMode: "ASSIST" }, { conversationMode: "paused" }]) it(`respects CRM policy ${JSON.stringify(option)}`, async () => {
    const f = await fixture("booking", option); await f.run(); assert.equal((await f.records()).length, 0); assert.equal((await f.tasks()).length, 0);
  });
  it("can save without creating tasks when task automation is disabled", async () => {
    const f = await fixture("booking", { createTasks: false }); await f.run(); assert.equal((await f.records()).length, 1); assert.equal((await f.tasks()).length, 0);
  });
  it("does not infer an available appointment or create a scheduled meeting from a customer preference", async () => {
    const f = await fixture();
    f.result.analysis.agreements = [{ action: "create", type: "OFFLINE_MEETING", title: "Стрижка", status: "CONFIRMED", scheduledAt: "2026-10-23T15:00:00+05:00", confidence: "HIGH", createTask: true, evidenceMessageIds: [f.message.id] }];
    await f.run(); assert.equal(await db.agreement.count({ where: { tenantId: f.tenant.id } }), 0); assert.equal((await f.records())[0].state, "needs_review");
  });
  for (const senderKind of ["ai", "staff"] as const) it(`accepts booking confirmation only from staff, source=${senderKind}`, async () => {
    const f = await fixture();
    await db.message.update({ where: { id: f.message.id }, data: { direction: "outbound", senderKind, text: "Запись на стрижку подтверждена на 23 октября в 15:00" } });
    f.result.analysis.agreements = [{ action: "create", type: "OFFLINE_MEETING", title: "Стрижка", status: "CONFIRMED", scheduledAt: "2026-10-23T15:00:00+05:00", confidence: "HIGH", createTask: true, evidenceMessageIds: [f.message.id] }];
    await f.run();
    assert.equal(await db.agreement.count({ where: { tenantId: f.tenant.id } }), senderKind === "staff" ? 1 : 0);
    assert.equal(await db.task.count({ where: { tenantId: f.tenant.id, source: "context_engine" } }), senderKind === "staff" ? 1 : 0);
    assert.equal((await f.records()).length, 0);
  });
  for (const kind of ["food_order", "product_order"] as const) it(`passes a multi-message grocery order through the selected mode, model adapter and CRM: ${kind}`, async () => {
    const f = await fixture(kind);
    const previous = { key: process.env.OPENAI_API_KEY, base: process.env.OPENAI_BASE_URL };
    process.env.OPENAI_API_KEY = "synthetic-test-only";
    process.env.OPENAI_BASE_URL = "https://intake-model.example.test/v1";
    await db.aIConfiguration.update({ where: { id: f.config.id }, data: { provider: "openai", model: "test-model" } });
    await db.message.update({ where: { id: f.message.id }, data: { text: "Хочу две пиццы Маргарита с доставкой. Аллергия на орехи." } });
    invalidateRuntimeConfig();
    const inputs: any[] = [];
    const fetchMock = mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); const input = JSON.parse(body.messages[1].content); inputs.push(input);
      const lastId = input.messages.at(-1).id;
      const intakeRequest = { kind: input.intakeKinds?.[0], action: "collect", confidence: "HIGH", evidenceMessageIds: [lastId],
        fields: inputs.length === 1 ? { fulfillment: "delivery", notes: "Аллергия на орехи" } : { address: "Алматы, тестовый адрес 10" },
        ...(inputs.length === 1 ? { items: [{ name: "Маргарита", quantity: 2 }] } : {}),
      };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summaryUpdate: "Предварительная заявка на доставку двух пицц", confidence: "HIGH", evidenceMessageIds: [lastId], agreements: [], events: [], suggestedTasks: [], intakeRequest }) } }] }), { status: 200 });
    });
    try {
      const first = await analyzeConversationContext(db, f.auth, f.conversation.id);
      assert.equal(first.llmUsed, true); assert.equal(first.analysis.intakeRequest?.kind, kind);
      assert.deepEqual(inputs[0].intakeKinds, [kind]);
      await applyAnalyzedConversation(db, f.tenant.id, f.conversation.id, first);
      assert.equal((await f.records())[0].state, "collecting"); assert.equal((await f.tasks()).length, 0);
      await f.next({ address: "Алматы, тестовый адрес 10" });
      const second = await analyzeConversationContext(db, f.auth, f.conversation.id);
      assert.equal(second.llmUsed, true);
      await applyAnalyzedConversation(db, f.tenant.id, f.conversation.id, second);
      assert.equal(fetchMock.mock.callCount(), 2);
      assert.equal(inputs[1].existingIntake[0].items[0].name, "Маргарита");
      assert.equal(inputs[1].timeZone, "Asia/Almaty");
      const [record] = await f.records();
      assert.equal(record.state, "needs_review"); assert.equal(record.items[0].quantity, 2);
      assert.match(record.fields.notes!, /Аллергия/); assert.equal((await f.tasks()).length, 1);
      assert.equal(await db.activity.count({ where: { tenantId: f.tenant.id, type: "ai.intake_updated" } }), 2);
    } finally {
      fetchMock.mock.restore();
      if (previous.key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous.key;
      if (previous.base === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = previous.base;
      invalidateRuntimeConfig();
    }
  });
  for (const alteration of ["confidence", "foreign_evidence", "wrong_role", "outbound", "closed"] as const) it(`rejects unsafe intake: ${alteration}`, async () => {
    const f = await fixture();
    if (alteration === "confidence") f.extraction.confidence = "LOW";
    if (alteration === "foreign_evidence") f.extraction.evidenceMessageIds.push(randomUUID());
    if (alteration === "wrong_role") f.extraction.kind = "food_order";
    if (alteration === "outbound") await db.message.update({ where: { id: f.message.id }, data: { direction: "outbound", senderKind: "ai" } });
    if (alteration === "closed") await db.inquiry.update({ where: { id: f.inquiry.id }, data: { status: "closed" } });
    await f.run(); assert.equal((await f.records()).length, 0);
  });
  it("preserves staff task edits and records a cancellation request without performing cancellation", async () => {
    const f = await fixture(); await f.run(); const [task] = await f.tasks();
    await db.task.update({ where: { id: task.id }, data: { title: "Моя задача", description: "Ручные детали" } });
    await f.next({ notes: "Клиент просит отменить" }, "cancel"); await f.run();
    assert.equal((await f.records())[0].action, "cancel"); const [current] = await f.tasks();
    assert.equal(current.id, task.id); assert.equal(current.description, "Ручные детали"); assert.equal(current.status, "open");
    assert.equal(await db.activity.count({ where: { tenantId: f.tenant.id, type: "ai.intake_updated" } }), 2);
  });
  it("keeps a manually renamed review task across multiple later updates", async () => {
    const f = await fixture(); await f.run(); const [task] = await f.tasks();
    await db.task.update({ where: { id: task.id }, data: { title: "Проверить запись у Айгерим" } });
    for (const preferredTime of ["16:00", "17:00"]) {
      await f.next({ preferredTime }, "change"); await f.run();
      const current = await db.task.findUniqueOrThrow({ where: { id: task.id } });
      assert.equal(current.title, "Проверить запись у Айгерим");
      assert.match(current.description!, new RegExp(preferredTime));
    }
  });
  it("does not restore a CRM phone after the customer explicitly withdraws that contact", async () => {
    const f = await fixture(); await f.run();
    await f.next({ contact: null }); await f.run();
    assert.equal((await f.records())[0].fields.contact, null);
    assert.ok((await f.records())[0].missingFields.includes("contact"));
    await f.next({ notes: "Новый номер пришлю позже" }); await f.run();
    assert.equal((await f.records())[0].fields.contact, null);
    assert.ok((await f.records())[0].missingFields.includes("contact"));
  });
  it("reopens review for changed details after completion but does not duplicate identical intake", async () => {
    const f = await fixture(); await f.run(); const [task] = await f.tasks();
    await db.task.update({ where: { id: task.id }, data: { status: "done" } });
    await f.next({}); await f.run(); assert.equal((await f.tasks()).length, 1);
    await f.next({ preferredTime: "17:00" }, "change"); await f.run(); assert.equal((await f.tasks()).length, 2);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status, "done");
  });
});
