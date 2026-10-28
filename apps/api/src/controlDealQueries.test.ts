import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, describe, it } from "node:test";
import { createPrismaClient, syncPricingCatalog } from "@creolab/db";
import type { Prisma } from "@creolab/db";
import type { ControlAction } from "@creolab/contracts";
import { authForUserInTenant } from "./services/authService.ts";
import { initializeTenantUsage } from "./services/billingResourceService.ts";
import { activateSubscription } from "./services/subscriptionActivationService.ts";
import { upsertControlAccess, executeWebControl, createControlIdentity } from "./services/aiControlService.ts";
import { sendControlWebMessage } from "./services/controlWebService.ts";
import { routeControlWhatsApp, processControlChatRequests } from "./services/controlChatService.ts";
import { saveControlChatSettings } from "./services/controlChatSettings.ts";
import { controlUnchangedDeals } from "./services/controlDealQueries.ts";
import { mapControlPeriod } from "./services/controlPeriods.ts";
import { chatCommandSchema, quickControlCommand } from "./services/controlChatLanguage.ts";
import { presentControlReply } from "./services/controlChatPresentation.ts";

const day = 86400000;
describe("Control grounded deal queries", () => {
  let db: Awaited<ReturnType<typeof createPrismaClient>>;
  const originalFetch = globalThis.fetch;
  before(async () => { db = await createPrismaClient(); await syncPricingCatalog(db); globalThis.fetch = async () => { throw new Error("External services disabled"); }; });
  after(async () => { globalThis.fetch = originalFetch; await db.$disconnect(); });
  async function fixture() {
    const now = new Date(), old = new Date(now.getTime() - 30 * day);
    const tenant = await db.tenant.create({ data: { name: "Exact Control deals", slug: randomUUID(), timezone: "Asia/Almaty", settingsJson: { control: { enabled: true } } } });
    await activateSubscription(db, { tenantId: tenant.id, planCode: "CRM_START" });
    async function member(name: string, role: string) {
      const user = await db.user.create({ data: { name, email: `${randomUUID()}@example.test`, passwordHash: "unused" } });
      const row = await db.membership.create({ data: { tenantId: tenant.id, userId: user.id, role } });
      const auth = await authForUserInTenant(db, user.id, tenant.id, "control-deal-test");
      const identity = await db.controlIdentity.create({ data: { tenantId: tenant.id, userId: user.id, provider: "CRM_CHAT", externalUserId: user.id, verifiedAt: now } });
      return { ...row, auth, identity };
    }
    const owner = await member("Owner", "owner"), manager = await member("Manager", "manager");
    for (const m of [owner, manager]) await upsertControlAccess(db, owner.auth, m.userId, { enabled: true, allowedSources: ["CRM_CHAT", "WHATSAPP"], canReadFinancialData: true, canReadTeamData: true });
    const contact = await db.contact.create({ data: { tenantId: tenant.id, name: "Test client" } });
    await db.contactMethod.create({ data: { tenantId: tenant.id, contactId: contact.id, type: "phone", rawValue: "+77011112233", normalizedValue: "+77011112233", source: "manual" } });
    const stage = await db.dealStage.create({ data: { tenantId: tenant.id, name: "КП отправлено", systemKey: "proposal", sortOrder: 1 } });
    const conversation = await db.conversation.create({ data: { tenantId: tenant.id, contactId: contact.id } });
    const deal = (title: string, data: Partial<Prisma.DealUncheckedCreateInput> = {}) => db.deal.create({ data: { tenantId: tenant.id, contactId: contact.id, stageId: stage.id, title, assigneeMembershipId: owner.id, createdAt: old, updatedAt: old, stageEnteredAt: old, ...data } });
    const task = (dealId: string, data: Partial<Prisma.TaskUncheckedCreateInput> = {}) => db.task.create({ data: { tenantId: tenant.id, dealId, title: "Proposal", type: "proposal", ...data } });
    const message = (data: Partial<Prisma.MessageUncheckedCreateInput> = {}) => db.message.create({ data: { tenantId: tenant.id, conversationId: conversation.id, direction: "outbound", senderKind: "human", text: "КП во вложении", operationState: "sent", createdAt: new Date(now.getTime() - 1000), ...data } });
    const proof = async (dealId: string, msg?: { id: string }) => db.activity.create({ data: { tenantId: tenant.id, contactId: contact.id, dealId, type: "sales.proposal_sent", title: "Sent", metadataJson: { sourceMessageId: (msg || await message()).id } } });
    const invoice = (dealId: string, data: Partial<Prisma.InvoiceUncheckedCreateInput> = {}) => db.invoice.create({ data: { tenantId: tenant.id, dealId, number: randomUUID(), dueDate: now, status: "ISSUED", amountWithoutVat: 1000, vatAmount: 0, totalAmount: 1000, ...data } });
    const promise = (dealId: string, data: Partial<Prisma.AgreementUncheckedCreateInput> = {}) => db.agreement.create({ data: { tenantId: tenant.id, dealId, contactId: contact.id, type: "PAYMENT_PROMISE", title: "Оплата завтра", status: "CONFIRMED", scheduledAt: now, ...data } });
    const execute = async (action: ControlAction, params: Record<string, unknown> = {}, actor = owner) => executeWebControl(db, actor.auth, actor.identity.id, action, params, randomUUID()) as Promise<any>;
    const send = async (text: string) => (await sendControlWebMessage(db, owner.auth, { text, requestId: randomUUID() })).items.at(-1)!;
    const ctx = (params: Record<string, unknown> = {}, fallback: "all" | "this_week" = "all") => ({ prisma: db, auth: owner.auth, access: { canReadFinancialData: true, canReadTeamData: true }, params, period: mapControlPeriod(params, tenant.timezone, now, fallback) });
    return { now, old, tenant, owner, manager, contact, stage, conversation, deal, task, message, proof, invoice, promise, execute, send, ctx };
  }
  it("distinguishes stage inactivity from card changes and counts exact boundaries", async () => {
    const f = await fixture(), cutoff = new Date(f.now.getTime() - 14 * day);
    const old = await f.deal("Inactive");
    const edge = await f.deal("At boundary", { stageEnteredAt: cutoff, updatedAt: cutoff });
    await f.deal("Recent card change", { updatedAt: f.now });
    await f.deal("Recent stage", { stageEnteredAt: new Date(cutoff.getTime() + 1) });
    await f.deal("Closed", { outcome: "lost" });
    const read = await controlUnchangedDeals(f.ctx({ inactiveDays: 14 }));
    assert.deepEqual(read.items.map(r => r.id).sort(), [old.id, edge.id].sort());
    assert.equal((await controlUnchangedDeals(f.ctx({ inactiveDays: 14, changeBasis: "stage" }))).total, 3);
    assert.equal(read.cutoff.toISOString(), cutoff.toISOString());
    await assert.rejects(f.execute("GET_UNCHANGED_DEALS", {}), /дней/);
    await assert.rejects(f.execute("GET_UNCHANGED_DEALS", { inactiveDays: 0 }), /дней/);
    await assert.rejects(f.execute("GET_UNCHANGED_DEALS", { inactiveDays: 14, period: "today" }), /фильтр/);
  });
  it("checks linked messages, task completion, documents, agreements, payments and history", async () => {
    const f = await fixture();
    const cases = ["message", "inquiry", "task", "invoice", "agreement", "payment", "activity"];
    for (const kind of cases) {
      const d = await f.deal(kind);
      if (kind === "message" || kind === "inquiry") {
        const c = await db.conversation.create({ data: { tenantId: f.tenant.id, contactId: f.contact.id } });
        if (kind === "message") await db.dealConversation.create({ data: { tenantId: f.tenant.id, dealId: d.id, conversationId: c.id } });
        else await db.inquiry.create({ data: { tenantId: f.tenant.id, contactId: f.contact.id, dealId: d.id, conversationId: c.id, source: "manual" } });
        await f.message({ conversationId: c.id, direction: "inbound", createdAt: f.now });
      } else if (kind === "task") await f.task(d.id, { createdAt: f.old, completedAt: f.now, status: "done" });
      else if (kind === "invoice") await f.invoice(d.id, { updatedAt: f.now });
      else if (kind === "agreement") await f.promise(d.id, { updatedAt: f.now });
      else if (kind === "payment") await db.paymentRecord.create({ data: { tenantId: f.tenant.id, dealId: d.id, amountMinor: 100, currency: "KZT", confirmedAt: f.now } });
      else await db.activity.create({ data: { tenantId: f.tenant.id, contactId: f.contact.id, dealId: d.id, title: "History", type: "note", createdAt: f.now } });
    }
    const untouched = await f.deal("Same client, unrelated conversation");
    await f.message();
    const result = await controlUnchangedDeals(f.ctx({ inactiveDays: 14 }));
    assert.deepEqual(result.items.map(r => r.id), [untouched.id]);
    assert.equal((await controlUnchangedDeals(f.ctx({ inactiveDays: 14, changeBasis: "stage" }))).total, cases.length + 1);
  });
  it("does not mistake failed outbound messages for activity or count only the first fifty rows", async () => {
    const f = await fixture(), d = await f.deal("Unsent message");
    await db.dealConversation.create({ data: { tenantId: f.tenant.id, dealId: d.id, conversationId: f.conversation.id } });
    await f.message({ operationState: "failed" });
    await db.deal.createMany({ data: Array.from({ length: 70 }, (_, i) => ({ tenantId: f.tenant.id, contactId: f.contact.id, stageId: f.stage.id, title: `Old ${i}`, createdAt: f.old, updatedAt: f.old, stageEnteredAt: f.old })) });
    const result = await f.execute("GET_UNCHANGED_DEALS", { inactiveDays: 14 });
    assert.equal(result.data.total, 71); assert.equal(result.data.items.length, 50); assert.equal(result.data.hasMore, true);
  });
  it("requires sent proposal evidence, not a stage, inbound claim or manual completion", async () => {
    const f = await fixture(), sent = await f.deal("Sent proposal"); await f.proof(sent.id);
    await f.deal("Stage label only");
    const manual = await f.deal("Manually completed"); await f.task(manual.id, { status: "done", executionStatus: "sent", sentAt: f.now });
    for (const state of ["queued", "sending", "unknown", "partial", "failed"]) {
      const d = await f.deal(state); await f.proof(d.id, await f.message({ operationState: state }));
    }
    const inbound = await f.deal("Inbound claim"); await f.proof(inbound.id, await f.message({ direction: "inbound" }));
    const failed = await f.deal("Failed receipt"); await f.proof(failed.id, await f.message({ receiptState: "failed" }));
    const result = await f.execute("GET_PROPOSALS_WITHOUT_FOLLOWUP");
    assert.deepEqual(result.data.items.map((r: any) => r.id), [sent.id]);
  });
  it("accepts complete delivery evidence and rejects partial or wrong-client evidence", async () => {
    const f = await fixture();
    let expected = "";
    for (const states of [["accepted", "accepted"], ["accepted", "unknown"], ["accepted", "failed"], []]) {
      const d = await f.deal(states.join("/") || "Empty receipt"), t = await f.task(d.id, { status: "done", executionStatus: "sent", sentAt: f.now });
      await db.idempotencyRecord.create({ data: { scope: "task.delivery", actorKey: f.tenant.id, key: t.id, requestHash: "test", resultJson: { parts: states.map(state => ({ state })) }, expiresAt: new Date(f.now.getTime() + day) } });
      if (states.length && states.every(s => s === "accepted")) expected = d.id;
    }
    const other = await fixture(), wrong = await f.deal("Foreign proof"); await f.proof(wrong.id, await other.message());
    const anotherClient = await db.contact.create({ data: { tenantId: f.tenant.id, name: "Another customer" } });
    const c = await db.conversation.create({ data: { tenantId: f.tenant.id, contactId: anotherClient.id } });
    const wrongClient = await f.deal("Wrong client proof"); await f.proof(wrongClient.id, await f.message({ conversationId: c.id }));
    assert.deepEqual((await f.execute("GET_PROPOSALS_WITHOUT_FOLLOWUP")).data.items.map((r: any) => r.id), [expected]);
  });
  it("excludes future contacts but keeps undated, overdue and unrelated technical work", async () => {
    const f = await fixture(), future = new Date(f.now.getTime() + day), past = new Date(f.now.getTime() - day);
    const expected: string[] = [];
    for (const kind of ["next_action", "call_task", "agreement", "overdue", "undated", "technical", "canceled", "ambiguous"]) {
      const d = await f.deal(kind, kind === "next_action" ? { nextAction: "Позвонить клиенту", nextActionAt: future } : {}); await f.proof(d.id);
      if (kind === "call_task") await f.task(d.id, { type: "call", dueAt: future });
      if (kind === "agreement") await f.promise(d.id, { type: "CALL", scheduledAt: future });
      if (kind === "overdue") await f.task(d.id, { type: "call", dueAt: past });
      if (kind === "undated") await f.task(d.id, { type: "call" });
      if (kind === "technical") await f.task(d.id, { type: "other", title: "Разработать макет", dueAt: future });
      if (kind === "canceled") await f.task(d.id, { type: "call", dueAt: future, status: "canceled" });
      if (kind === "ambiguous") await f.promise(d.id, { type: "CALL", scheduledAt: future, status: "NEEDS_CLARIFICATION" });
      if (!["next_action", "call_task", "agreement"].includes(kind)) expected.push(d.id);
    }
    const result = await f.execute("GET_PROPOSALS_WITHOUT_FOLLOWUP");
    assert.deepEqual(result.data.items.map((r: any) => r.id).sort(), expected.sort());
    assert.equal(result.data.clientCount, 1);
  });
  it("recognizes contacts planned through the inquiry or customer without borrowing another deal's plan", async () => {
    const f = await fixture(), dueAt = new Date(f.now.getTime() + day);
    const first = await f.deal("Needs follow-up"), second = await f.deal("Another project");
    await f.proof(first.id); await f.proof(second.id);
    await f.task(second.id, { type: "call", dueAt });
    assert.deepEqual((await f.execute("GET_PROPOSALS_WITHOUT_FOLLOWUP")).data.items.map((r: any) => r.id), [first.id]);
    const inquiry = await db.inquiry.create({ data: { tenantId: f.tenant.id, dealId: first.id, contactId: f.contact.id, source: "manual" } });
    const call = await f.task(first.id, { dealId: null, inquiryId: inquiry.id, type: "call", dueAt });
    assert.equal((await f.execute("GET_PROPOSALS_WITHOUT_FOLLOWUP")).data.total, 0);
    await db.task.update({ where: { id: call.id }, data: { status: "canceled" } });
    const general = await f.promise(first.id, { dealId: null, type: "CALL", scheduledAt: dueAt });
    assert.equal((await f.execute("GET_PROPOSALS_WITHOUT_FOLLOWUP")).data.total, 0);
    await db.agreement.update({ where: { id: general.id }, data: { clarificationNeeded: "Уточнить время" } });
    assert.equal((await f.execute("GET_PROPOSALS_WITHOUT_FOLLOWUP")).data.total, 1);
    await f.task(first.id, { dealId: null, contactId: f.contact.id, type: "call", dueAt });
    assert.equal((await f.execute("GET_PROPOSALS_WITHOUT_FOLLOWUP")).data.total, 0);
  });
  it("reports ambiguous free-form next steps separately rather than claiming no contact is planned", async () => {
    const f = await fixture(), future = new Date(f.now.getTime() + day);
    for (const nextAction of ["Не звонить, дождаться решения", "ОС по макету", "Подготовить вопросы для звонка"]) {
      const d = await f.deal(nextAction, { nextAction, nextActionAt: future }); await f.proof(d.id);
    }
    const result = await f.execute("GET_PROPOSALS_WITHOUT_FOLLOWUP");
    assert.equal(result.data.total, 0); assert.equal(result.data.uncertainCount, 3); assert.equal(result.data.uncertainItems.length, 2);
    const reply = presentControlReply("GET_PROPOSALS_WITHOUT_FOLLOWUP", result, "ru", f.tenant.timezone);
    assert.match(reply, /требуют проверки: 3/); assert.match(reply, /В итог выше не включены/);
  });
  it("counts proposal candidates across pages, deduplicates facts and applies send-date boundaries", async () => {
    const f = await fixture(), p = mapControlPeriod({ period: "today" }, f.tenant.timezone), sent = await f.message({ createdAt: p.from! });
    const rows = [];
    for (let i = 0; i < 106; i++) rows.push(await f.deal(`Proposal ${i}`));
    await db.activity.createMany({ data: rows.flatMap(d => [1, 2].map(() => ({ tenantId: f.tenant.id, contactId: f.contact.id, dealId: d.id, type: "sales.proposal_sent", title: "Proof", metadataJson: { sourceMessageId: sent.id } }))) });
    const early = await f.deal("Earlier"); await f.proof(early.id, await f.message({ createdAt: new Date(p.from!.getTime() - 1) }));
    const tomorrow = await f.deal("Tomorrow"); await f.proof(tomorrow.id, await f.message({ createdAt: p.to! }));
    const result = await f.execute("GET_PROPOSALS_WITHOUT_FOLLOWUP", { period: "today" });
    assert.equal(result.data.total, 106); assert.equal(result.data.clientCount, 1); assert.equal(result.data.items.length, 50);
    assert.ok(!result.data.items.some((r: any) => [early.id, tomorrow.id].includes(r.id)));
  });
  it("groups real lost reasons and counts missing reasons within closing-date boundaries", async () => {
    const f = await fixture(), p = mapControlPeriod({ period: "this_month" }, f.tenant.timezone);
    for (const lossReason of ["Цена", " цена ", null, "  ", "Выбрали конкурента"]) await f.deal("Lost", { outcome: "lost", lossReason, closedAt: p.from });
    await f.deal("Not lost", { lossReason: "Do not include", closedAt: p.from });
    await f.deal("Earlier", { outcome: "lost", lossReason: "Earlier", closedAt: new Date(p.from!.getTime() - 1) });
    await f.deal("Later", { outcome: "lost", lossReason: "Later", closedAt: p.to });
    const result = await f.execute("GET_LOST_REASONS", { period: "this_month" });
    assert.equal(result.data.total, 5); assert.equal(result.data.reasonCount, 3); assert.equal(result.data.missingReasonCount, 2);
    assert.equal(result.data.items.find((r: any) => r.reason?.toLowerCase() === "цена").share, 40);
    assert.equal(result.data.items.find((r: any) => r.reason === null).count, 2);
  });
  it("uses invoice and promise due dates, never expected closing dates or drafts", async () => {
    const f = await fixture(), p = mapControlPeriod({ period: "this_week" }, f.tenant.timezone), expected: string[] = [];
    for (const status of ["ISSUED", "SENT", "OVERDUE", "DRAFT", "PAID", "CANCELLED"]) {
      const d = await f.deal(status); await f.invoice(d.id, { status, dueDate: p.from });
      if (["ISSUED", "SENT", "OVERDUE"].includes(status)) expected.push(d.id);
    }
    for (const status of ["CONFIRMED", "SCHEDULED", "RESCHEDULED", "DETECTED", "NEEDS_CLARIFICATION", "COMPLETED", "CANCELLED"]) {
      const d = await f.deal(status); await f.promise(d.id, { status, scheduledAt: p.from });
      if (["CONFIRMED", "SCHEDULED", "RESCHEDULED"].includes(status)) expected.push(d.id);
    }
    await f.deal("Expected close is not payment", { expectedCloseAt: p.from });
    const early = await f.deal("Earlier"); await f.invoice(early.id, { dueDate: new Date(p.from!.getTime() - 1) });
    const late = await f.deal("Next week"); await f.invoice(late.id, { dueDate: p.to });
    const unclear = await f.deal("Unclear promise"); await f.promise(unclear.id, { clarificationNeeded: "Дата не подтверждена", scheduledAt: p.from });
    const undated = await f.deal("Undated invoice"); await f.invoice(undated.id, { dueDate: null });
    const result = await f.execute("GET_EXPECTED_PAYMENTS");
    assert.deepEqual(result.data.items.map((r: any) => r.id).sort(), expected.sort());
    assert.equal(result.meta.period, "this_week"); assert.equal(result.meta.dateFrom, p.dateFrom);
  });
  it("deduplicates payment grounds, removes paid deals and flags unallocated partial payments", async () => {
    const f = await fixture(), rows: string[] = [];
    for (const [title, paid, paymentStatus] of [["Unpaid", 0, "INVOICED"], ["Partial", 100, "PARTIALLY_PAID"], ["Full ledger, stale status", 1000, "INVOICED"], ["Already paid", 0, "PAID"], ["Canceled", 0, "CANCELLED"]] as const) {
      const d = await f.deal(title, { offerAmountMinor: 1000, paymentStatus }); await f.invoice(d.id); await f.promise(d.id);
      if (paid) await db.paymentRecord.create({ data: { tenantId: f.tenant.id, dealId: d.id, amountMinor: paid, currency: "KZT", confirmedAt: f.now } });
      if (["Unpaid", "Partial"].includes(title)) rows.push(d.id);
    }
    const result = await f.execute("GET_EXPECTED_PAYMENTS", { period: "all" });
    assert.deepEqual(result.data.items.map((r: any) => r.id).sort(), rows.sort());
    assert.ok(result.data.items.every((r: any) => r.sourceCount === 2)); assert.equal(result.data.reconciliationCount, 1);
    assert.equal(result.data.amountMinor, undefined); assert.equal(result.data.revenue, undefined);
  });
  it("compares payment amounts without rounding and ignores unconfirmed or different-currency receipts", async () => {
    const f = await fixture(), expected: string[] = [];
    for (const [title, amountMinor, currency, status] of [
      ["One minor unit left", "9007199254740992", "KZT", "confirmed"],
      ["Fully paid", "9007199254740993", "KZT", "confirmed"],
      ["Another currency", "9007199254740993", "USD", "confirmed"],
      ["Unconfirmed", "9007199254740993", "KZT", "pending"],
    ]) {
      const d = await f.deal(title, { offerAmountMinor: "9007199254740993" }); await f.invoice(d.id);
      await db.paymentRecord.create({ data: { tenantId: f.tenant.id, dealId: d.id, amountMinor, currency, status, confirmedAt: f.now } });
      if (title !== "Fully paid") expected.push(d.id);
    }
    const result = await f.execute("GET_EXPECTED_PAYMENTS", { period: "all" });
    assert.deepEqual(result.data.items.map((r: any) => r.id).sort(), expected.sort());
  });
  it("counts all expected payments beyond the display limit and keeps the earliest deadlines", async () => {
    const f = await fixture(), ids = [];
    await initializeTenantUsage(db, f.tenant.id, { DOCUMENTS_COUNT: 200 });
    for (let i = 0; i < 104; i++) { const d = await f.deal(`Invoice ${i}`); ids.push(d.id); await f.invoice(d.id, { dueDate: new Date(f.now.getTime() + i * 60000) }); }
    const result = await f.execute("GET_EXPECTED_PAYMENTS", { period: "all" });
    assert.equal(result.data.total, 104); assert.equal(result.data.items.length, 50); assert.equal(result.data.hasMore, true);
    assert.deepEqual(result.data.items.map((r: any) => r.id), ids.slice(0, 50));
  });
  it("preserves tenant, role, person, finance and action permissions for every new query", async () => {
    const f = await fixture(), other = await fixture();
    const owned = await f.deal("Owner"), managed = await f.deal("Manager", { assigneeMembershipId: f.manager.id });
    const secret = await other.deal("Foreign secret");
    for (const [fx, d] of [[f, owned], [f, managed], [other, secret]] as const) { await fx.invoice(d.id); await fx.proof(d.id); }
    const params = { inactiveDays: 14, changeBasis: "stage" };
    for (const [action, p] of [["GET_UNCHANGED_DEALS", params], ["GET_PROPOSALS_WITHOUT_FOLLOWUP", {}], ["GET_EXPECTED_PAYMENTS", {}]] as const) {
      assert.deepEqual((await f.execute(action, { ...p, scope: "mine" })).data.items.map((r: any) => r.id), [owned.id]);
      assert.deepEqual((await f.execute(action, p, f.manager)).data.items.map((r: any) => r.id), [managed.id]);
      assert.equal((await f.execute(action, { ...p, scope: "team" })).data.total, 2);
      await assert.rejects(f.execute(action, { ...p, scope: "team" }, f.manager), /Нет права/);
      await assert.rejects(f.execute(action, { ...p, ownerMembershipId: other.owner.id }), /Сотрудник не найден/);
    }
    await db.deal.updateMany({ where: { id: { in: [owned.id, managed.id, secret.id] } }, data: { outcome: "lost", closedAt: f.now, lossReason: "Lost" } });
    assert.equal((await f.execute("GET_LOST_REASONS", {}, f.manager)).data.total, 1);
    assert.equal((await f.execute("GET_LOST_REASONS", { scope: "mine" })).data.total, 1);
    await upsertControlAccess(db, f.owner.auth, f.owner.userId, { canReadFinancialData: false });
    await assert.rejects(f.execute("GET_EXPECTED_PAYMENTS"), /финансовые/);
    assert.equal((await f.execute("GET_LOST_REASONS")).data.total, 2);
    await upsertControlAccess(db, f.owner.auth, f.owner.userId, { allowedActions: ["GET_TASKS"] });
    await assert.rejects(f.execute("GET_LOST_REASONS"), /не разрешено/);
  });
  it("rejects unsupported filters instead of quietly broadening a read", async () => {
    const f = await fixture();
    for (const action of ["GET_PROPOSALS_WITHOUT_FOLLOWUP", "GET_LOST_REASONS", "GET_EXPECTED_PAYMENTS"] as const) {
      await assert.rejects(f.execute(action, { taskStatus: "completed" }), /фильтр/);
      await assert.rejects(f.execute(action, { inactiveDays: 14 }), /фильтр/);
    }
    await assert.rejects(f.execute("GET_UNCHANGED_DEALS", { inactiveDays: 14, periodPreset: "today" }), /фильтр/);
  });
  it("runs common full phrases without a model and refuses compound or unsupported commands", () => {
    const cases = [
      ["Покажи сделки, которые не менялись две недели", { action: "GET_UNCHANGED_DEALS", inactiveDays: 14, changeBasis: "activity" }],
      ["Мои сделки без смены этапа 7 дней", { action: "GET_UNCHANGED_DEALS", inactiveDays: 7, changeBasis: "stage", scope: "mine" }],
      ["Найди клиентов, которым отправили коммерческое предложение, но не назначили следующий контакт", { action: "GET_PROPOSALS_WITHOUT_FOLLOWUP" }],
      ["КП без следующего контакта за этот месяц", { action: "GET_PROPOSALS_WITHOUT_FOLLOWUP", period: "this_month" }],
      ["Причины проигрыша сделок за прошлый месяц", { action: "GET_LOST_REASONS", period: "last_month" }],
      ["Найди сделки, по которым ожидается оплата на этой неделе", { action: "GET_EXPECTED_PAYMENTS", period: "this_week" }],
      ["14 күн өзгермеген мәмілелерді көрсет", { action: "GET_UNCHANGED_DEALS", inactiveDays: 14, changeBasis: "activity" }],
      ["Осы аптадағы күтілетін төлемдерді көрсет", { action: "GET_EXPECTED_PAYMENTS", period: "this_week" }],
    ] as const;
    for (const [text, expected] of cases) { assert.deepEqual(quickControlCommand(text), expected, text); assert.equal(chatCommandSchema.safeParse(expected).success, true); }
    for (const text of ["Ожидаемые оплаты и удали счета", "КП без следующего контакта за прошлый месяц и позвони", "Сделки без изменений 0 дней", "Сделки без изменений 4000 дней"]) assert.equal(quickControlCommand(text), null, text);
    for (const command of [{ action: "GET_UNCHANGED_DEALS" }, { action: "GET_UNCHANGED_DEALS", inactiveDays: 7, period: "today" }, { action: "GET_LOST_REASONS", inactiveDays: 7 }, { action: "GET_EXPECTED_PAYMENTS", taskStatus: "all" }]) assert.equal(chatCommandSchema.safeParse(command).success, false);
  });
  it("keeps full counts and navigation within a readable message in both languages", () => {
    for (const action of ["GET_UNCHANGED_DEALS", "GET_PROPOSALS_WITHOUT_FOLLOWUP", "GET_LOST_REASONS", "GET_EXPECTED_PAYMENTS"] as const) for (const lang of ["ru", "kk"] as const) {
      const result = { data: { total: 123, reasonCount: 20, clientCount: 90, inactiveDays: 14, changeBasis: "activity", cutoff: new Date(), checkedAt: new Date(), items: Array.from({ length: 50 }, () => ({ id: randomUUID(), title: "Название ".repeat(30), contactName: "Клиент ".repeat(20), phone: "+77011112233", ownerName: "Имя ".repeat(30), reason: "Причина ".repeat(40), share: 20, count: 4, stageEnteredAt: new Date(), sentAt: new Date(), sources: [1, 2].map(() => ({ type: "invoice", title: "Счёт ".repeat(40), dueAt: new Date() })), sourceCount: 3 })) }, meta: { period: "this_week", dateFrom: "2026-10-26", dateTo: "2026-11-01", timeZone: "Asia/Almaty" } };
      const reply = presentControlReply(action, result, lang, "Asia/Almaty");
      assert.ok(reply.length <= 3500, `${action}: ${reply.length}`); assert.match(reply, /123/); assert.match(reply, /\/deals$/);
      assert.match(reply, lang === "ru" ? /Показано: [1-8]/ : /Көрсетілді: [1-8]/);
    }
  });
  it("works in the platform chat, retains the period context and rechecks revoked rights", async () => {
    const f = await fixture(), d = await f.deal("Due this week"); await f.invoice(d.id);
    const p = mapControlPeriod({ period: "last_week" }, f.tenant.timezone), prior = await f.deal("Previous week"); await f.invoice(prior.id, { dueDate: p.from });
    assert.match((await f.send("Ожидаемые оплаты на этой неделе")).reply, /Due this week/);
    const previous = await f.send("А за прошлую неделю?");
    assert.deepEqual(previous.actions, ["GET_EXPECTED_PAYMENTS"]); assert.match(previous.reply, /Previous week/); assert.doesNotMatch(previous.reply, /Due this week/);
    await upsertControlAccess(db, f.owner.auth, f.owner.userId, { canReadFinancialData: false });
    assert.doesNotMatch((await f.send("А за эту неделю?")).reply, /Due this week|Previous week/);
    assert.equal(await db.message.count({ where: { tenantId: f.tenant.id } }), 0);
  });
  it("uses the same precise queries in private WhatsApp without sending real messages", async () => {
    const f = await fixture(), d = await f.deal("Lost in WhatsApp");
    await db.deal.update({ where: { id: d.id }, data: { outcome: "lost", lossReason: "Цена", closedAt: f.now } });
    const integration = await db.integration.create({ data: { tenantId: f.tenant.id, type: "whatsapp_qr", name: "Mock Control", status: "active", connectionStatus: "CONNECTED", testMode: true } });
    const phone = "+77019990001", identity = (await createControlIdentity(db, f.owner.auth, { userId: f.owner.userId, phone, verifyNow: true })).identity;
    await saveControlChatSettings(db, f.owner.auth, identity.id, { enabled: true, integrationId: integration.id, language: "ru", morningEnabled: false, morningTime: "09:00", eveningEnabled: false, eveningTime: "18:00", weekdaysOnly: true });
    const eventId = randomUUID();
    assert.equal(await routeControlWhatsApp(db, integration.id, { phone, text: "Причины проигрыша сделок за этот месяц", at: f.now, eventId }), true);
    await processControlChatRequests(db, integration.id);
    const reply = await db.controlChatMessage.findUniqueOrThrow({ where: { integrationId_eventKey: { integrationId: integration.id, eventKey: eventId } } });
    assert.match(reply.replyText!, /Цена: 1 \(100%\)/); assert.deepEqual(reply.actionsJson, ["GET_LOST_REASONS"]);
    assert.equal(reply.state, "ready"); assert.equal(await db.message.count({ where: { tenantId: f.tenant.id } }), 0);
  });
});
