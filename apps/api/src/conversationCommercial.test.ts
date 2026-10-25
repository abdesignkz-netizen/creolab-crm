import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { readCrmCommercial, type CrmReviewItem } from "@creolab/contracts";
import type { AuthContext } from "./lib/types.ts";
import { extractCommercialFacts, groundCommercialFacts } from "./services/conversationCommercialFacts.ts";
import { validateConversationRefinement } from "./services/conversationAnalysisValidation.ts";
import { analyzeConversationContext } from "./services/conversationContextService.ts";
import { applyAnalyzedConversation } from "./services/conversationContextApplyService.ts";
import { listConversationCrmReview, reviewConversationCrmChange } from "./services/conversationCrmReviewService.ts";
import { getInquiry, updateInquiry } from "./services/inquiryService.ts";

const money = (amount: number, currency = "KZT") => ({ min: amount, max: amount, currency });
const msg = (text: string, id = "client", direction = "inbound", senderKind = direction === "inbound" ? "client" : "staff") => ({ id, text, direction, senderKind });
const extract = (text: string) => extractCommercialFacts([msg(text)], "KZT");

describe("Commercial facts require literal evidence and distinguish money meanings", () => {
  for (const [text, expected] of [
    ["Наш бюджет 450 000 ₸", money(450000)], ["Бюджет 450к", money(450000)],
    ["Бюджет от 100000 до 200000 тенге", { min: 100000, max: 200000, currency: "KZT" }],
    ["Бюджет до 200000 тенге", { min: null, max: 200000, currency: "KZT" }],
    ["Бюджет от 100000 тенге", { min: 100000, max: null, currency: "KZT" }],
    ["Наш бюджет USD 1000", money(1000, "USD")], ["Бюджетіміз 150 мың теңге", money(150000)],
  ] as const) it(`keeps budget bounds and currency: ${text}`, () => {
    const facts = extract(text); assert.equal(facts.length, 1); assert.equal(facts[0].field, "customerBudget"); assert.deepEqual(facts[0].value, expected);
  });
  it("distinguishes a sent offer, client budget and accepted total", () => {
    assert.equal(extractCommercialFacts([msg("Стоимость 450000 тенге", "offer", "outbound")], "KZT")[0].field, "proposedPrice");
    assert.equal(extract("Стоимость 450000 тенге устраивает")[0].field, "agreedPrice");
    assert.deepEqual(extract("Бюджет 450000 тенге, цена устраивает").map(f => f.field), ["customerBudget"]);
    assert.equal(extract("Дорого, подумаю")[0].field, "objection");
    const refused = extract("Отказываемся: выбрали другого поставщика");
    assert.equal(refused[0].field, "refusalReason"); assert.equal(refused[0].value, "Отказываемся: выбрали другого поставщика");
    assert.deepEqual(extract("Не дорого, всё хорошо"), []);
    assert.deepEqual(extract("Не отказываемся, ещё обсуждаем"), []);
    assert.deepEqual(extract("Отказываюсь от этой цены, заказ по-прежнему нужен"), []);
  });
  for (const text of [
    "Предоплата 450000 тенге устраивает", "Цена 15000 тенге в месяц устраивает", "Цена 10000 тенге за единицу устраивает",
    "Если цена 450000 устраивает, обсудим", "Цена 450000 подходит?", "Не согласен на цену 450000", "Бюджет -100000 тенге",
    "Бюджет 100000,50 тенге", "Бюджет 3000000000 тенге", "Бюджет 100000 CNY", "Бюджет 100000 юаней",
    "Стоимость первого варианта 100000, второго 200000, согласен", "Он сказал: согласен на стоимость 450000", "Запиши бюджет 100000",
    "Да, согласен", "Благодарю", "Оплатил 450000 тенге", "Оплачу 450000 тенге",
    "Согласен на стоимость 450000 при условии скидки", "Бюджет раньше был 100000 тенге",
  ]) it(`does not infer a total or budget: ${text}`, () => {
    assert.ok(extract(text).every(f => typeof f.value === "string"));
  });
  it("a short yes refers only to the immediately preceding single sent offer", () => {
    const offer = msg("Предложение 450000 тенге", "offer", "outbound"), yes = msg("Да, согласен");
    const [fact] = extractCommercialFacts([offer, yes], "KZT");
    assert.deepEqual(fact.value, money(450000)); assert.equal(fact.evidence.length, 2);
    assert.deepEqual(groundCommercialFacts([fact], [offer, msg("Примеры посмотрели?", "question", "outbound"), yes], "KZT"), []);
    assert.deepEqual(extractCommercialFacts([msg("Бюджет клиента 450000", "offer", "outbound"), yes], "KZT"), []);
    assert.deepEqual(extractCommercialFacts([msg('Он сказал: "цена 450000 тенге"', "offer", "outbound"), yes], "KZT"), []);
  });
  it("rejects fabricated amounts, currency, text, speaker, source and duplicate meanings", () => {
    const message = msg("Наш бюджет 100000 тенге"); const [fact] = extract(message.text);
    for (const bad of [
      { ...fact, value: money(200000) }, { ...fact, value: money(100000, "USD") },
      { ...fact, evidence: [{ messageId: "foreign", quote: message.text }] },
      { ...fact, evidence: [{ messageId: "client", quote: "Бюджет 200000" }] },
      { ...fact, confidence: "LOW" }, { ...fact, field: "agreedPrice" },
    ]) assert.deepEqual(groundCommercialFacts([bad], [message], "KZT"), []);
    assert.deepEqual(groundCommercialFacts([fact], [{ ...message, direction: "outbound", senderKind: "staff" }], "KZT"), []);
    assert.deepEqual(groundCommercialFacts([fact], [{ ...message, internal: true }], "KZT"), []);
    assert.deepEqual(groundCommercialFacts([fact, fact], [message], "KZT"), []);
  });
  it("does not omit a negation or condition by selecting a convenient quote", () => {
    const fact = { field: "agreedPrice", value: money(450000), confidence: "HIGH", evidence: [{ messageId: "client", quote: "согласен на стоимость 450000" }] };
    assert.deepEqual(groundCommercialFacts([fact], [msg("Не согласен на стоимость 450000")], "KZT"), []);
    assert.deepEqual(groundCommercialFacts([fact], [msg("Если согласен на стоимость 450000, перезвони")], "KZT"), []);
  });
  it("validates optional model facts without losing valid context", () => {
    const [fact] = extract("Бюджет 100000 тенге");
    assert.equal(validateConversationRefinement({ summaryUpdate: "Обсуждают бюджет", commercialFacts: [fact, { field: "arbitrary" }] }, ["client"])?.commercialFacts?.length, 1);
    assert.deepEqual(validateConversationRefinement({ commercialFacts: [fact] }, ["another"])?.commercialFacts, []);
  });
});

describe("Commercial CRM review uses existing records, permissions and guarded undo", () => {
  let db: Awaited<ReturnType<typeof createPrismaClient>>;
  const fetch = globalThis.fetch;
  before(async () => { db = await createPrismaClient(); globalThis.fetch = async () => { throw new Error("No external actions in commercial review tests"); }; });
  after(async () => { globalThis.fetch = fetch; await db.$disconnect(); });
  async function fixture(text: string, options: { auto?: boolean; manager?: boolean; direction?: string; currency?: string; enabled?: boolean } = {}) {
    const tenant = await db.tenant.create({ data: { name: "Commercial test", slug: randomUUID(), settingsJson: {
      aiAutomation: { defaultMode: options.auto ? "AUTO" : "ASSIST", crm: { enabled: options.enabled !== false } },
    } } });
    const user = await db.user.create({ data: { email: `${randomUUID()}@example.test`, name: "Reviewer", passwordHash: "unused" } });
    const membership = await db.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: options.manager ? "manager" : "owner" }, include: { tenant: true } });
    const auth = { user, activeMembership: membership, memberships: [membership], sessionId: "test", client: "web" } as AuthContext;
    const contact = await db.contact.create({ data: { tenantId: tenant.id, name: "Клиент", ownerMembershipId: membership.id } });
    const conversation = await db.conversation.create({ data: { tenantId: tenant.id, contactId: contact.id, mode: options.auto ? "ai" : "paused", messageRevision: 1, assigneeMembershipId: membership.id } });
    const inquiry = await db.inquiry.create({ data: { tenantId: tenant.id, contactId: contact.id, conversationId: conversation.id, source: "whatsapp", status: "qualification", assigneeMembershipId: membership.id,
      currency: options.currency || "KZT", budgetMin: 50000, budgetMax: 70000, normalizedJson: { keepMe: { value: "untouched" } } } });
    const message = await db.message.create({ data: { tenantId: tenant.id, conversationId: conversation.id, text, direction: options.direction || "inbound", senderKind: options.direction === "outbound" ? "staff" : "client", createdAt: new Date("2026-10-26T08:00:00Z") } });
    const result = await analyzeConversationContext(db, auth, conversation.id, { useLlm: false });
    Object.assign(result.analysis, { confidence: "HIGH", evidenceMessageIds: [message.id], summaryUpdate: "Обсуждение условий", suggestedNextAction: "Ответить клиенту", suggestedRequestStatus: "qualified" });
    const run = () => applyAnalyzedConversation(db, tenant.id, conversation.id, result);
    const list = () => listConversationCrmReview(db, auth, conversation.id);
    const act = (id: string, decision: "accept" | "dismiss" | "undo") => reviewConversationCrmChange(db, auth, conversation.id, id, decision);
    const row = () => db.inquiry.findUniqueOrThrow({ where: { id: inquiry.id } });
    return { tenant, user, membership, auth, contact, conversation, inquiry, message, result, run, list, act, row };
  }
  const find = (items: CrmReviewItem[], field: string) => { const item = items.find(i => i.fields.some(f => f.key === field)); assert.ok(item, field); return item; };

  it("reviews a budget range atomically in existing columns; preserves currency and supports undo", async () => {
    const f = await fixture("Наш бюджет от 100000 до 200000 тенге"); await f.run();
    const proposal = find((await f.list()).items, "customerBudget");
    assert.deepEqual(proposal.fields[0].before, { min: 50000, max: 70000, currency: "KZT" });
    assert.equal(proposal.evidence[0].quote, f.message.text); assert.equal((await f.row()).budgetMin, 50000);
    await f.act(proposal.id, "accept"); await f.act(proposal.id, "accept");
    assert.equal((await f.row()).budgetMax, 200000);
    assert.deepEqual((await f.list()).commercial?.customerBudget, { min: 100000, max: 200000, currency: "KZT" });
    await f.act(proposal.id, "undo"); await f.act(proposal.id, "undo");
    assert.equal((await f.row()).budgetMax, 70000); assert.equal((await f.row()).currency, "KZT");
    const history = await db.activity.findMany({ where: { tenantId: f.tenant.id, type: "conversation.crm_undone" } });
    assert.equal(history.length, 1); assert.equal(history[0].actorId, f.user.id); assert.match(history[0].description || "", /Бюджет клиента/);
  });
  it("the actual offline analyst proposes explicit money without tests elevating overall confidence", async () => {
    for (const [text, direction, field] of [["Бюджет 150000 тенге", "inbound", "customerBudget"], ["Цена 150000 тенге", "outbound", "proposedPrice"]]) {
      const f = await fixture(text, { direction });
      Object.assign(f.result, await analyzeConversationContext(db, f.auth, f.conversation.id, { useLlm: false }));
      await f.run(); const p = find((await f.list()).items, field);
      assert.equal(p.canAccept, true); assert.equal(p.confidence, "HIGH");
    }
  });
  for (const [text, field, direction] of [
    ["Предложение 150000 тенге", "proposedPrice", "outbound"], ["Стоимость 150000 тенге устраивает", "agreedPrice", "inbound"],
    ["Дорого, подумаю", "objection", "inbound"], ["Отказываемся: выбрали другого поставщика", "refusalReason", "inbound"],
  ] as const) it(`stores ${field} as reviewed inquiry information without changing deals or closing requests`, async () => {
    const f = await fixture(text, { direction }); await f.run(); const proposal = find((await f.list()).items, field);
    await f.act(proposal.id, "accept");
    const row = await f.row(), values = readCrmCommercial(row);
    assert.deepEqual(values[field], typeof proposal.fields[0].after === "object" ? money(150000) : text);
    assert.deepEqual((row.normalizedJson as any).keepMe, { value: "untouched" });
    assert.equal(row.status, "qualification"); assert.equal(row.lostReason, null); assert.equal(row.budgetMin, 50000);
    assert.equal(await db.deal.count({ where: { tenantId: f.tenant.id } }), 0);
    assert.equal(await db.task.count({ where: { tenantId: f.tenant.id } }), 0);
    assert.equal(await db.message.count({ where: { tenantId: f.tenant.id } }), 1);
    assert.deepEqual((await getInquiry(db, f.auth, f.inquiry.id)).commercial, values);
    await f.act(proposal.id, "undo"); assert.equal(readCrmCommercial(await f.row())[field], null);
    assert.deepEqual((await f.row()).normalizedJson, { keepMe: { value: "untouched" }, crmCommercial: {} });
  });
  it("AUTO still requires commercial review and keeps it actionable after its own summary updates", async () => {
    const f = await fixture("Бюджет 150000 тенге", { auto: true }); await f.run();
    const p = find((await f.list()).items, "customerBudget");
    assert.equal(p.status, "pending"); assert.equal(p.canAccept, true); assert.equal((await f.row()).budgetMin, 50000);
    await f.act(p.id, "accept"); assert.equal((await f.row()).budgetMin, 150000);
  });
  it("does not rebase a manual budget edit made during analysis", async () => {
    const f = await fixture("Бюджет 150000 тенге", { auto: true });
    await updateInquiry(db, f.auth, f.inquiry.id, { budgetMin: 190000, budgetMax: 200000 }); await f.run();
    const p = find((await f.list()).items, "customerBudget"); assert.equal(p.canAccept, false);
    await assert.rejects(f.act(p.id, "accept"), { code: "crm_review_changed" }); assert.equal((await f.row()).budgetMin, 190000);
  });
  it("blocks undo after another manual edit, even if the new value is identical", async () => {
    const f = await fixture("Бюджет 150000 тенге"); await f.run(); const p = find((await f.list()).items, "customerBudget");
    await f.act(p.id, "accept"); await updateInquiry(db, f.auth, f.inquiry.id, { budgetMin: 150000 });
    await assert.rejects(f.act(p.id, "undo"), { code: "crm_review_changed" }); assert.equal((await f.row()).budgetMin, 150000);
  });
  it("manager may review own budget and objections, but not prices or another employee's request", async () => {
    const f = await fixture("Бюджет 150000 тенге", { manager: true }); await f.run(); const p = find((await f.list()).items, "customerBudget");
    assert.equal(p.canAccept, true); await f.act(p.id, "accept");
    const other = await fixture("Стоимость 150000 тенге устраивает", { manager: true }); await other.run();
    const price = find((await other.list()).items, "agreedPrice"); assert.equal(price.canAccept, false);
    await assert.rejects(other.act(price.id, "accept"), { code: "forbidden" });
    const colleagueUser = await db.user.create({ data: { email: `${randomUUID()}@example.test`, name: "Коллега", passwordHash: "unused" } });
    const colleague = await db.membership.create({ data: { tenantId: other.tenant.id, userId: colleagueUser.id, role: "manager" } });
    await db.inquiry.update({ where: { id: other.inquiry.id }, data: { assigneeMembershipId: colleague.id } });
    assert.equal((await other.list()).items.some(i => i.id === price.id), false);
    assert.equal((await other.list()).commercial, null);
  });
  it("rejects a different budget currency and forged evidence reintroduced after extraction", async () => {
    const f = await fixture("Бюджет 1000 USD"); await f.run(); assert.ok((await f.list()).items.every(i => i.fields.every(v => v.key !== "customerBudget")));
    const g = await fixture("Бюджет 150000 тенге");
    g.result.analysis.commercialFacts![0].value = money(999999);
    await g.run(); assert.ok((await g.list()).items.every(i => i.fields.every(v => v.key !== "customerBudget")));
  });
  it("does not repeat rejected proposals or accept an obsolete source", async () => {
    const f = await fixture("Бюджет 150000 тенге"); await f.run(); const p = find((await f.list()).items, "customerBudget");
    await f.act(p.id, "dismiss"); await f.run(); assert.equal((await f.list()).items.filter(i => i.fields.some(v => v.key === "customerBudget")).length, 1);
    const g = await fixture("Бюджет 150000 тенге"); await g.run(); const q = find((await g.list()).items, "customerBudget");
    await db.message.update({ where: { id: g.message.id }, data: { text: "Бюджет изменился" } });
    await assert.rejects(g.act(q.id, "accept"), { code: "crm_review_changed" });
  });
  it("CRM disabled creates no review and malformed saved commercial data does not break the request", async () => {
    const f = await fixture("Бюджет 150000 тенге", { enabled: false }); await f.run(); assert.equal((await f.list()).items.length, 0);
    await db.inquiry.update({ where: { id: f.inquiry.id }, data: { normalizedJson: { crmCommercial: { proposedPrice: { min: -1, max: 100, currency: "bad" }, refusalReason: { html: "bad" } } } } });
    const row = await getInquiry(db, f.auth, f.inquiry.id); assert.equal(row.commercial.proposedPrice, null); assert.equal(row.commercial.refusalReason, null);
  });
  it("does not erase an unsupported prior budget by pretending its old value was empty", async () => {
    const f = await fixture("Бюджет 150000 тенге");
    await db.inquiry.update({ where: { id: f.inquiry.id }, data: { budgetMin: -1 } });
    const result = await analyzeConversationContext(db, f.auth, f.conversation.id, { useLlm: false });
    Object.assign(result.analysis, { confidence: "HIGH", evidenceMessageIds: [f.message.id] });
    await applyAnalyzedConversation(db, f.tenant.id, f.conversation.id, result);
    assert.ok((await f.list()).items.every(i => i.fields.every(v => v.key !== "customerBudget")));
    assert.equal((await f.row()).budgetMin, -1);
  });
});
