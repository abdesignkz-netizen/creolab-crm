import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import { randomUUID } from "node:crypto";
import { createPrismaClient } from "@creolab/db";
import { WhatsAppSellerBridge } from "@creolab/integrations";
import type { AuthContext } from "./lib/types.ts";
import { encryptSecret } from "./lib/secretBox.ts";
import { extractPriceEvents, parseScheduleHint, analyzeConversationContext } from "./services/conversationContextService.ts";
import { applyAnalyzedConversation, applyConversationAnalysis } from "./services/conversationContextApplyService.ts";
import { enqueueConversationContext, processConversationContextJob } from "./services/conversationContextQueue.ts";
import { ingestSellerBridgeEvent } from "./services/sellerLink.ts";
import { validateConversationRefinement } from "./services/conversationAnalysisValidation.ts";
import { refineConversationContextWithLlm } from "./services/llmClient.ts";
import { normalizeHistoryMediaItem } from "./services/conversationMedia.ts";
import { sellerModeToCrm } from "@creolab/contracts";

const at = new Date("2026-09-24T07:00:00Z");
const sample = "Да, давайте тогда во вторник в 15:00 созвонимся, предложение на 450 000 ₸ устраивает.";
const msg = (text: string, id = "client", direction = "inbound") => ({ id, text, direction, senderKind: direction === "inbound" ? "client" : "staff", createdAt: at });

describe("conversation extraction safety", () => {
  for (const amount of ["450 000", "450к", "450 тыс", "450 000 ₸", "450 тысяч тенге"]) it(`normalizes accepted ${amount}`, () => {
    const [event] = extractPriceEvents([msg(`Стоимость ${amount} устраивает`)], "KZT");
    assert.equal(event.type, "PRICE_ACCEPTED"); assert.equal(event.amount, 450000); assert.equal(event.currency, "KZT");
  });
  for (const text of ["450 000 дороговато, подумаю", "Нет, за 450 000 неинтересно", "Не согласен на 450 000"]) it(`does not accept: ${text}`, () => {
    assert.equal(extractPriceEvents([msg(text)], "KZT")[0]?.type, "PRICE_REJECTED");
  });
  it("does not interpret hypothetical consent as acceptance", () => {
    for (const text of ["А 450000 устраивает?", "Если 450000 устраивает, обсудим", "Я согласился бы на 450000"])
      assert.notEqual(extractPriceEvents([msg(text)], "KZT")[0]?.type, "PRICE_ACCEPTED");
  });
  it("does not pick the last price or use a payment/budget as deal total", () => {
    assert.deepEqual(extractPriceEvents([msg("Первый вариант 450 000, второй 600 000, согласен")], "KZT"), []);
    assert.notEqual(extractPriceEvents([msg("Предоплата 450 000 устраивает")], "KZT")[0]?.type, "PRICE_ACCEPTED");
  });
  it("uses an explicit previous offer for a short acceptance", () => {
    const events = extractPriceEvents([msg("Наше предложение на 450 000 ₸", "offer", "outbound"), msg("Да, согласен")], "KZT");
    assert.equal(events[0].amount, 450000); assert.deepEqual(events[0].evidenceMessageIds, ["offer", "client"]);
    assert.deepEqual(extractPriceEvents([msg("Варианты за 450 000 и 600 000", "offer", "outbound"), msg("Да, согласен")], "KZT"), []);
  });
  it("resolves natural dates in the company timezone", () => {
    for (const [text, expected] of [
      [sample, "2026-09-29T10:00:00.000Z"],
      ["Послезавтра в 11", "2026-09-26T06:00:00.000Z"],
      ["Через два дня в 11", "2026-09-26T06:00:00.000Z"],
      ["25 сентября в 15:00", "2026-09-25T10:00:00.000Z"],
      ["25.09.2026 в 15:00", "2026-09-25T10:00:00.000Z"],
    ]) assert.equal(parseScheduleHint(text, at, "Asia/Almaty").at?.toISOString(), expected, text);
    assert.equal(parseScheduleHint("Завтра в 11", new Date("2026-09-24T22:00:00Z"), "Asia/Almaty").at?.toISOString(), "2026-09-26T06:00:00.000Z");
    assert.equal(parseScheduleHint("Завтра в 11", new Date("2026-09-24T22:00:00Z"), "America/New_York").at?.toISOString(), "2026-09-25T15:00:00.000Z");
  });
  it("does not fabricate a time or accept invalid dates", () => {
    for (const text of ["Давайте созвонимся как-нибудь во вторник", "Встречаемся завтра после обеда", "Завтра примерно в 3", "31 февраля в 15:00", "Во вторник в 15:99"])
      assert.equal(parseScheduleHint(text, at, "Asia/Almaty").at, null, text);
    assert.equal(parseScheduleHint("В 15:00", at, "Asia/Almaty").at, null);
  });
  it("normalizes raw WhatsApp text, timestamp and provider identity", () => {
    const value = normalizeHistoryMediaItem({ idMessage: "wa-1", timestamp: at.getTime() / 1000,
      messageData: { typeMessage: "textMessage", textMessageData: { textMessage: sample } } });
    assert.equal(value?.content, sample); assert.equal(value?.at, at.toISOString()); assert.equal(value?.providerMessageId, "wa-1");
  });
  it("sends conversation, timezone and reference time to the existing semantic analyst", async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "synthetic-test-only";
    const semantic = { events: [{ type: "PRICE_ACCEPTED", amount: 450000, currency: "KZT", confidence: "HIGH", evidenceMessageIds: ["offer", "client"] }], agreements: [] };
    const fetchMock = mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const input = JSON.parse(body.messages[1].content);
      assert.equal(input.timeZone, "Asia/Almaty"); assert.equal(input.referenceAt, at.toISOString()); assert.equal(input.messages.length, 2);
      assert.match(body.messages[0].content, /PRICE_ACCEPTED/);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(semantic) } }] }), { status: 200 });
    });
    try {
      const result = await refineConversationContextWithLlm({ messages: [
        { role: "staff", text: "Полный пакет — 450000 KZT", at: at.toISOString(), id: "offer" },
        { role: "client", text: "Останавливаемся на этом варианте", at: at.toISOString(), id: "client" },
      ], draft: {}, timeZone: "Asia/Almaty", referenceAt: at.toISOString(), currency: "KZT", inquiryStatus: null, dealStage: null, openTaskTitles: [], existingAgreements: [] });
      assert.equal(validateConversationRefinement(result, ["offer", "client"])?.events?.[0].amount, 450000);
      assert.equal(fetchMock.mock.callCount(), 1);
    } finally { fetchMock.mock.restore(); if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; }
  });
  it("validates LLM enum, datetime, amounts and evidence", () => {
    assert.equal(validateConversationRefinement({ agreements: [{ type: "DELETE_ALL" }] }, ["client"]), null);
    assert.equal(validateConversationRefinement({ events: [{ type: "PRICE_ACCEPTED", amount: -1, confidence: "HIGH", evidenceMessageIds: ["client"] }] }, ["client"]), null);
    assert.deepEqual(validateConversationRefinement({ events: [{ type: "PRICE_ACCEPTED", amount: 450000, confidence: "HIGH", evidenceMessageIds: ["foreign"] }] }, ["client"])?.events, []);
    assert.deepEqual(validateConversationRefinement({ agreements: [] }, ["client"])?.agreements, []);
    assert.equal(sellerModeToCrm("ASSIST"), "paused");
  });
});

describe("CRM conversation integration (real isolated database)", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  before(async () => { prisma = await createPrismaClient(); });
  after(async () => { mock.restoreAll(); await prisma.$disconnect(); });
  async function fixture(options: { text?: string; mode?: string; defaultMode?: string; crm?: Record<string, boolean>; timezone?: string } = {}) {
    const tenant = await prisma.tenant.create({ data: { name: "CRM test", slug: randomUUID(), timezone: options.timezone || "Asia/Almaty",
      settingsJson: { aiAutomation: { defaultMode: options.defaultMode || "AUTO", crm: { enabled: true, ...options.crm } } } } });
    const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "unused", name: "Менеджер" } });
    const membership = await prisma.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: "owner" }, include: { tenant: true } });
    const auth = { user, activeMembership: membership, memberships: [membership] } as unknown as AuthContext;
    const contact = await prisma.contact.create({ data: { tenantId: tenant.id, name: "ТОО ABC" } });
    const stage = await prisma.dealStage.create({ data: { tenantId: tenant.id, systemKey: "new", name: "Наш входящий этап", sortOrder: 1 } });
    const target = await prisma.dealStage.create({ data: { tenantId: tenant.id, systemKey: "negotiation", name: "Согласуем условия", sortOrder: 3, defaultProbability: 60 } });
    const deal = await prisma.deal.create({ data: { tenantId: tenant.id, contactId: contact.id, stageId: stage.id, title: "Предложение", offerAmountMinor: 100,
      updatedAt: new Date("2026-09-23T00:00:00Z"), assigneeMembershipId: membership.id } });
    const conversation = await prisma.conversation.create({ data: { tenantId: tenant.id, contactId: contact.id, mode: options.mode || "ai", messageRevision: 1 } });
    const inquiry = await prisma.inquiry.create({ data: { tenantId: tenant.id, contactId: contact.id, conversationId: conversation.id, source: "whatsapp", dealId: deal.id, status: "qualification" } });
    const message = await prisma.message.create({ data: { tenantId: tenant.id, conversationId: conversation.id, senderKind: "client", direction: "inbound", text: options.text || sample, createdAt: at } });
    const analyze = () => analyzeConversationContext(prisma, auth, conversation.id, { useLlm: false });
    const run = () => applyConversationAnalysis(prisma, auth, conversation.id, { useLlm: false, automatic: true });
    return { tenant, user, membership, auth, contact, stage, target, deal, conversation, inquiry, message, analyze, run };
  }
  it("acceptance: one call task, agreed price, actual links, AI audit, replay", async () => {
    const f = await fixture();
    const output = await f.run();
    assert.equal(output.applied?.dealAmount, 450000);
    const deal = await prisma.deal.findUniqueOrThrow({ where: { id: f.deal.id } });
    assert.equal(Number(deal.offerAmountMinor), 450000); assert.equal(deal.stageId, f.stage.id);
    assert.equal(deal.paymentStatus, "NOT_INVOICED"); assert.equal(deal.outcome, "open");
    const tasks = await prisma.task.findMany({ where: { tenantId: f.tenant.id, conversationId: f.conversation.id } });
    assert.equal(tasks.length, 1); assert.equal(tasks[0].dueAt?.toISOString(), "2026-09-29T10:00:00.000Z");
    assert.equal(tasks[0].contactId, f.contact.id); assert.equal(tasks[0].dealId, f.deal.id); assert.equal(tasks[0].inquiryId, f.inquiry.id);
    assert.equal(tasks[0].ownerMembershipId, f.membership.id);
    const audits = await prisma.auditEvent.findMany({ where: { tenantId: f.tenant.id, correlationId: f.message.id } });
    assert.ok(audits.some(a => a.entityType === "deal")); assert.ok(audits.some(a => a.entityType === "task"));
    assert.ok(audits.every(a => (a.changesJson as { actor: string }).actor === "ai"));
    await f.run(); assert.equal(await prisma.task.count({ where: { tenantId: f.tenant.id } }), 1);
    assert.equal(await prisma.auditEvent.count({ where: { tenantId: f.tenant.id } }), audits.length);
  });
  for (const mode of ["ai", "human"]) it(`keeps CRM current in ${mode} without sending a reply`, async () => {
    const f = await fixture({ mode }); await f.run();
    assert.equal(await prisma.task.count({ where: { tenantId: f.tenant.id } }), 1);
    assert.equal(await prisma.message.count({ where: { tenantId: f.tenant.id, direction: "outbound" } }), 0);
    assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: f.conversation.id } })).mode, mode);
  });
  for (const options of [{ crm: { enabled: false } }, { defaultMode: "MANUAL" }, { defaultMode: "ASSIST" }, { mode: "paused" }, { mode: "human", crm: { inHumanMode: false } }]) it(`respects disabled/assisted modes ${JSON.stringify(options)}`, async () => {
    const f = await fixture(options); await f.run();
    assert.equal(Number((await prisma.deal.findUniqueOrThrow({ where: { id: f.deal.id } })).offerAmountMinor), 100);
    assert.equal(await prisma.task.count({ where: { tenantId: f.tenant.id } }), 0);
    assert.equal(await prisma.auditEvent.count({ where: { tenantId: f.tenant.id } }), 0);
  });
  it("respects individual flags", async () => {
    const f = await fixture({ crm: { updateContact: false, updateInquiry: false, updateDealAmount: false, createTasks: false, updateNextAction: false } });
    await f.run();
    assert.equal(Number((await prisma.deal.findUniqueOrThrow({ where: { id: f.deal.id } })).offerAmountMinor), 100);
    assert.equal(await prisma.task.count({ where: { tenantId: f.tenant.id } }), 0);
    assert.equal(await prisma.agreement.count({ where: { tenantId: f.tenant.id } }), 1);
    assert.equal((await prisma.contact.findUniqueOrThrow({ where: { id: f.contact.id } })).summary, null);
  });
  it("moves only to an existing forward nonterminal stage when enabled", async () => {
    const f = await fixture({ crm: { updateDealStage: true } }); const analysis = await f.analyze();
    analysis.analysis.suggestedDealStage = "negotiation";
    await applyAnalyzedConversation(prisma, f.tenant.id, f.conversation.id, analysis);
    assert.equal((await prisma.deal.findUniqueOrThrow({ where: { id: f.deal.id } })).stageId, f.target.id);
    assert.equal(await prisma.dealStageHistory.count({ where: { tenantId: f.tenant.id } }), 1);
  });
  for (const target of ["won", "lost", "invented", "invoiced"]) it(`blocks critical/arbitrary stage ${target}`, async () => {
    const f = await fixture({ crm: { updateDealStage: true } }); const analysis = await f.analyze(); analysis.analysis.suggestedDealStage = target;
    await applyAnalyzedConversation(prisma, f.tenant.id, f.conversation.id, analysis);
    assert.equal((await prisma.deal.findUniqueOrThrow({ where: { id: f.deal.id } })).stageId, f.stage.id);
  });
  it("rejects low confidence amounts and agreements", async () => {
    const f = await fixture(); const analysis = await f.analyze();
    analysis.analysis.confidence = "LOW";
    analysis.analysis.events!.forEach(e => e.confidence = "LOW"); analysis.analysis.agreements.forEach(a => a.confidence = "LOW");
    await applyAnalyzedConversation(prisma, f.tenant.id, f.conversation.id, analysis);
    assert.equal(await prisma.task.count({ where: { tenantId: f.tenant.id } }), 0);
    assert.equal(Number((await prisma.deal.findUniqueOrThrow({ where: { id: f.deal.id } })).offerAmountMinor), 100);
  });
  it("does not overwrite a newer manual edit or choose between multiple deals", async () => {
    const f = await fixture(); const analysis = await f.analyze();
    await prisma.deal.update({ where: { id: f.deal.id }, data: { offerAmountMinor: 777000, version: { increment: 1 } } });
    await applyAnalyzedConversation(prisma, f.tenant.id, f.conversation.id, analysis);
    assert.equal(Number((await prisma.deal.findUniqueOrThrow({ where: { id: f.deal.id } })).offerAmountMinor), 777000);
    const second = await fixture(); await prisma.inquiry.update({ where: { id: second.inquiry.id }, data: { dealId: null } });
    await prisma.deal.create({ data: { tenantId: second.tenant.id, contactId: second.contact.id, stageId: second.stage.id, title: "Другая сделка" } });
    await second.run(); assert.equal(Number((await prisma.deal.findUniqueOrThrow({ where: { id: second.deal.id } })).offerAmountMinor), 100);
  });
  it("scopes existing agreement IDs and conversations to tenant", async () => {
    const f = await fixture(); const other = await fixture(); await other.run();
    const foreign = await prisma.agreement.findFirstOrThrow({ where: { tenantId: other.tenant.id } });
    const analysis = await f.analyze(); analysis.analysis.agreements[0].action = "cancel"; analysis.analysis.agreements[0].existingAgreementId = foreign.id;
    await applyAnalyzedConversation(prisma, f.tenant.id, f.conversation.id, analysis);
    assert.equal((await prisma.agreement.findUniqueOrThrow({ where: { id: foreign.id } })).status, foreign.status);
    await assert.rejects(() => applyAnalyzedConversation(prisma, f.tenant.id, other.conversation.id, analysis), /Диалог не найден/);
  });
  for (const text of ["450 000 дороговато, подумаю", "Нет, за 450 000 неинтересно", "Я оплачу завтра", "Оплатил"]) it(`keeps finance safe: ${text}`, async () => {
    const f = await fixture({ text }); await f.run();
    const deal = await prisma.deal.findUniqueOrThrow({ where: { id: f.deal.id } });
    assert.equal(Number(deal.offerAmountMinor), 100); assert.equal(deal.paymentStatus, "NOT_INVOICED"); assert.equal(deal.outcome, "open");
  });
  it("creates a meeting, and requests clarification when time is absent", async () => {
    const f = await fixture({ text: "Да, завтра в 11 встретимся в офисе" }); await f.run();
    assert.equal((await prisma.task.findFirstOrThrow({ where: { tenantId: f.tenant.id } })).type, "meeting");
    const ambiguous = await fixture({ text: "Давайте созвонимся как-нибудь во вторник" }); await ambiguous.run();
    assert.equal(await prisma.task.count({ where: { tenantId: ambiguous.tenant.id } }), 0);
  });
  it("uses previous call context for a short date reply", async () => {
    const f = await fixture({ text: "Давайте во вторник в 15:00" });
    await prisma.message.create({ data: { tenantId: f.tenant.id, conversationId: f.conversation.id, senderKind: "staff", direction: "outbound",
      text: "Когда удобно созвониться?", createdAt: new Date(at.getTime() - 1000) } });
    await f.run();
    assert.equal((await prisma.task.findFirstOrThrow({ where: { tenantId: f.tenant.id } })).dueAt?.toISOString(), "2026-09-29T10:00:00.000Z");
    const unknown = await fixture({ text: "Давайте во вторник в 15:00" }); await unknown.run();
    assert.equal(await prisma.task.count({ where: { tenantId: unknown.tenant.id } }), 0);
  });
  it("rejects a result when another message arrives during inference", async () => {
    const f = await fixture(); const analysis = await f.analyze();
    await prisma.conversation.update({ where: { id: f.conversation.id }, data: { messageRevision: { increment: 1 } } });
    await assert.rejects(() => applyAnalyzedConversation(prisma, f.tenant.id, f.conversation.id, analysis), /повторный анализ/);
    assert.equal(await prisma.task.count({ where: { tenantId: f.tenant.id } }), 0);
  });
  it("keeps CRM automation separate from reply confirmation", async () => {
    const f = await fixture({ defaultMode: "CONFIRM", mode: "human" }); await f.run();
    assert.equal(await prisma.task.count({ where: { tenantId: f.tenant.id } }), 1);
    assert.equal(await prisma.message.count({ where: { tenantId: f.tenant.id, direction: "outbound" } }), 0);
  });
  it("processes the customer event even when an AI reply arrives first", async () => {
    const f = await fixture();
    await prisma.message.create({ data: { tenantId: f.tenant.id, conversationId: f.conversation.id, senderKind: "ai", direction: "outbound",
      text: "Отлично, договорились", createdAt: new Date(at.getTime() + 1000) } });
    await prisma.conversation.update({ where: { id: f.conversation.id }, data: { messageRevision: { increment: 1 } } });
    await processConversationContextJob(prisma, f.tenant.id, f.conversation.id, { useLlm: false, sourceMessageId: f.message.id });
    assert.equal(Number((await prisma.deal.findUniqueOrThrow({ where: { id: f.deal.id } })).offerAmountMinor), 450000);
    assert.equal(await prisma.task.count({ where: { tenantId: f.tenant.id } }), 1);
  });
  it("reads the newest history window and ignores failed outbound messages", async () => {
    const f = await fixture();
    await prisma.message.createMany({ data: Array.from({ length: 85 }, (_, index) => ({ tenantId: f.tenant.id, conversationId: f.conversation.id,
      senderKind: "client", direction: "inbound", text: "Здравствуйте", createdAt: new Date(at.getTime() - (index + 1) * 1000) })) });
    await prisma.message.create({ data: { tenantId: f.tenant.id, conversationId: f.conversation.id, senderKind: "staff", direction: "outbound",
      text: "Это не отправлено", operationState: "failed", createdAt: new Date(at.getTime() + 1000) } });
    const result = await f.analyze(); assert.equal(result.sourceMessageId, f.message.id); assert.equal(result.messageCount, 80);
    await f.run(); assert.equal(await prisma.task.count({ where: { tenantId: f.tenant.id } }), 1);
  });
  it("does not apply an older message after a newer context has committed", async () => {
    const f = await fixture();
    const later = await prisma.message.create({ data: { tenantId: f.tenant.id, conversationId: f.conversation.id,
      senderKind: "client", direction: "inbound", text: "Нет, созвон отменяется", createdAt: new Date(at.getTime() + 1000) } });
    await prisma.conversation.update({ where: { id: f.conversation.id }, data: { messageRevision: { increment: 1 } } });
    await processConversationContextJob(prisma, f.tenant.id, f.conversation.id, { useLlm: false, sourceMessageId: later.id });
    const result = await processConversationContextJob(prisma, f.tenant.id, f.conversation.id, { useLlm: false, sourceMessageId: f.message.id });
    assert.equal(result.skipped, "superseded");
    assert.equal(await prisma.task.count({ where: { tenantId: f.tenant.id } }), 0);
    assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: f.conversation.id } })).lastAnalyzedMessageId, later.id);
  });
  it("waits for a failed earlier queued event before advancing to the next reply", async () => {
    const f = await fixture();
    const later = await prisma.message.create({ data: { tenantId: f.tenant.id, conversationId: f.conversation.id,
      senderKind: "ai", direction: "outbound", text: "Хорошо, договорились", createdAt: new Date(at.getTime() + 1000) } });
    await prisma.$transaction(async tx => {
      await enqueueConversationContext(tx, f.tenant.id, f.conversation.id, f.message.id);
      await enqueueConversationContext(tx, f.tenant.id, f.conversation.id, later.id);
    });
    await assert.rejects(() => processConversationContextJob(prisma, f.tenant.id, f.conversation.id, { useLlm: false, sourceMessageId: later.id }), /предыдущего сообщения/);
    await processConversationContextJob(prisma, f.tenant.id, f.conversation.id, { useLlm: false, sourceMessageId: f.message.id });
    await processConversationContextJob(prisma, f.tenant.id, f.conversation.id, { useLlm: false, sourceMessageId: later.id });
    assert.equal(Number((await prisma.deal.findUniqueOrThrow({ where: { id: f.deal.id } })).offerAmountMinor), 450000);
    assert.equal(await prisma.task.count({ where: { tenantId: f.tenant.id } }), 1);
  });
  it("waits for seller ingestion to link the inquiry before applying CRM facts", async () => {
    const f = await fixture();
    await prisma.conversation.update({ where: { id: f.conversation.id }, data: { sellerLeadId: "pending-ingestion" } });
    await prisma.inquiry.update({ where: { id: f.inquiry.id }, data: { conversationId: null } });
    await assert.rejects(() => processConversationContextJob(prisma, f.tenant.id, f.conversation.id, { useLlm: false, sourceMessageId: f.message.id }), /привязка WhatsApp/);
    assert.equal(await prisma.task.count({ where: { tenantId: f.tenant.id } }), 0);
    await prisma.inquiry.update({ where: { id: f.inquiry.id }, data: { conversationId: f.conversation.id } });
    await processConversationContextJob(prisma, f.tenant.id, f.conversation.id, { useLlm: false, sourceMessageId: f.message.id });
    assert.equal(await prisma.task.count({ where: { tenantId: f.tenant.id } }), 1);
  });
  it("concurrent application commits one task and one event checkpoint", async () => {
    const f = await fixture(); const analysis = await f.analyze();
    const results = await Promise.allSettled([applyAnalyzedConversation(prisma, f.tenant.id, f.conversation.id, analysis), applyAnalyzedConversation(prisma, f.tenant.id, f.conversation.id, analysis)]);
    assert.ok(results.some(r => r.status === "fulfilled"));
    for (const result of results) if (result.status === "rejected") assert.match(String(result.reason), /изменился|transaction|unique|write conflict/i);
    assert.equal(await prisma.task.count({ where: { tenantId: f.tenant.id } }), 1);
    assert.equal(await prisma.idempotencyRecord.count({ where: { actorKey: `${f.tenant.id}:${f.conversation.id}` } }), 1);
  });
  it("rolls back all CRM writes when a task write fails, then retries cleanly", async () => {
    const f = await fixture();
    const failingPrisma = new Proxy(prisma, { get(target, property) {
      if (property === "$transaction") return (callback: any, options: any) => prisma.$transaction(async tx => callback(new Proxy(tx, {
        get(transaction, name) { if (name === "task") return new Proxy(transaction.task, { get(delegate, method) {
          if (method === "create") return async () => { throw new Error("synthetic task failure"); };
          return Reflect.get(delegate, method);
        } }); return Reflect.get(transaction, name); },
      })), options);
      return Reflect.get(target, property);
    } });
    await assert.rejects(() => applyConversationAnalysis(failingPrisma, f.auth, f.conversation.id, { useLlm: false, automatic: true }), /synthetic task failure/);
    assert.equal(Number((await prisma.deal.findUniqueOrThrow({ where: { id: f.deal.id } })).offerAmountMinor), 100);
    assert.equal(await prisma.agreement.count({ where: { tenantId: f.tenant.id } }), 0);
    assert.equal(await prisma.idempotencyRecord.count({ where: { actorKey: `${f.tenant.id}:${f.conversation.id}` } }), 0);
    await f.run(); assert.equal(await prisma.task.count({ where: { tenantId: f.tenant.id } }), 1);
  });
  it("keeps the manager's edited task date on a later reschedule suggestion", async () => {
    const f = await fixture(); await f.run();
    const task = await prisma.task.findFirstOrThrow({ where: { tenantId: f.tenant.id } });
    const manualDueAt = new Date("2026-10-15T05:00:00Z");
    await prisma.task.update({ where: { id: task.id }, data: { dueAt: manualDueAt } });
    await prisma.message.create({ data: { tenantId: f.tenant.id, conversationId: f.conversation.id, senderKind: "client", direction: "inbound",
      text: "Да, перенесем созвон на завтра в 16:00", createdAt: new Date(Math.max(Date.now(), at.getTime()) + 1000) } });
    await prisma.conversation.update({ where: { id: f.conversation.id }, data: { messageRevision: { increment: 1 } } });
    await f.run();
    assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).dueAt?.toISOString(), manualDueAt.toISOString());
    assert.equal(await prisma.task.count({ where: { tenantId: f.tenant.id } }), 1);
  });
  it("reschedules the existing unedited task instead of duplicating it", async () => {
    const f = await fixture(); await f.run();
    const task = await prisma.task.findFirstOrThrow({ where: { tenantId: f.tenant.id } });
    const nextAt = new Date(Math.max(Date.now(), at.getTime()) + 2000);
    await prisma.message.create({ data: { tenantId: f.tenant.id, conversationId: f.conversation.id, senderKind: "client", direction: "inbound",
      text: "Да, перенесем созвон на завтра в 16:00", createdAt: nextAt } });
    await prisma.conversation.update({ where: { id: f.conversation.id }, data: { messageRevision: { increment: 1 } } });
    await f.run();
    assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).dueAt?.toISOString(), parseScheduleHint("Завтра в 16:00", nextAt, "Asia/Almaty").at?.toISOString());
    assert.equal(await prisma.task.count({ where: { tenantId: f.tenant.id } }), 1);
    assert.equal(await prisma.agreement.count({ where: { tenantId: f.tenant.id } }), 1);
  });
  it("accepts a newer explicit price after an earlier AI update", async () => {
    const f = await fixture(); await f.run();
    const message = await prisma.message.create({ data: { tenantId: f.tenant.id, conversationId: f.conversation.id, senderKind: "client", direction: "inbound",
      text: "Фиксируем стоимость 600 тысяч тенге", createdAt: new Date(at.getTime() + 1000) } });
    await prisma.conversation.update({ where: { id: f.conversation.id }, data: { messageRevision: { increment: 1 } } });
    await processConversationContextJob(prisma, f.tenant.id, f.conversation.id, { useLlm: false, sourceMessageId: message.id });
    assert.equal(Number((await prisma.deal.findUniqueOrThrow({ where: { id: f.deal.id } })).offerAmountMinor), 600000);
  });
  it("leaves a manual inquiry status and next step newer than the message", async () => {
    const f = await fixture();
    await prisma.inquiry.update({ where: { id: f.inquiry.id }, data: { nextStep: "Проверить у директора" } });
    await prisma.activity.create({ data: { tenantId: f.tenant.id, contactId: f.contact.id, inquiryId: f.inquiry.id, actorType: "user",
      actorId: f.user.id, type: "inquiry.updated", title: "Ручная правка", createdAt: new Date(at.getTime() + 1000) } });
    await f.run(); assert.equal((await prisma.inquiry.findUniqueOrThrow({ where: { id: f.inquiry.id } })).nextStep, "Проверить у директора");
  });
  it("seller webhook -> persisted message/outbox -> CRM, repeated webhook is idempotent", async () => {
    const f = await fixture(); await prisma.message.deleteMany({ where: { tenantId: f.tenant.id } });
    await prisma.contactMethod.create({ data: { tenantId: f.tenant.id, contactId: f.contact.id, type: "phone", rawValue: "77012345678", normalizedValue: "77012345678", source: "test" } });
    const secret = "synthetic-context-secret";
    const integration = await prisma.integration.create({ data: { tenantId: f.tenant.id, type: "whatsapp_seller", name: "WhatsApp", status: "active", connectionStatus: "CONNECTED",
      schemaJson: { secretEnc: encryptSecret(secret), sellerUrl: "https://seller.invalid" } } });
    const channel = await prisma.channelConnection.create({ data: { tenantId: f.tenant.id, integrationId: integration.id, channelType: "whatsapp" } });
    await prisma.conversation.update({ where: { id: f.conversation.id }, data: { sellerLeadId: `lead-${f.tenant.id}`, connectionId: channel.id, externalThreadId: "77012345678" } });
    const payload = { type: "message.received", leadId: `lead-${f.tenant.id}`, clientPhone: "77012345678", aiMode: "HUMAN", conversationHistory: [{ role: "user", content: sample, at: at.toISOString() }] };
    const bridge = mock.method(WhatsAppSellerBridge.prototype, "listLeads", async () => ({ leads: [] }));
    try {
      await ingestSellerBridgeEvent(prisma, payload, { secret, integrationId: integration.id });
      assert.equal(await prisma.message.count({ where: { tenantId: f.tenant.id } }), 1);
      assert.equal(await prisma.outboxEvent.count({ where: { tenantId: f.tenant.id, type: "conversation.context" } }), 1);
      await processConversationContextJob(prisma, f.tenant.id, f.conversation.id, { useLlm: false });
      await ingestSellerBridgeEvent(prisma, payload, { secret, integrationId: integration.id });
      await processConversationContextJob(prisma, f.tenant.id, f.conversation.id, { useLlm: false });
      assert.equal(await prisma.task.count({ where: { tenantId: f.tenant.id } }), 1);
      assert.equal(await prisma.message.count({ where: { tenantId: f.tenant.id } }), 1);
      assert.equal(Number((await prisma.deal.findUniqueOrThrow({ where: { id: f.deal.id } })).offerAmountMinor), 450000);
    } finally { bridge.mock.restore(); }
  });
});
