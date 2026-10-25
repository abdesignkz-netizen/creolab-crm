import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import type { CrmReviewItem } from "@creolab/contracts";
import type { AuthContext } from "./lib/types.ts";
import { analyzeConversationContext } from "./services/conversationContextService.ts";
import { applyAnalyzedConversation } from "./services/conversationContextApplyService.ts";
import { listConversationCrmReview, reviewConversationCrmChange } from "./services/conversationCrmReviewService.ts";
import { getContactOverview, updateContact } from "./services/contactService.ts";
import { updateInquiry } from "./services/inquiryService.ts";
import { createApp } from "./app.ts";
import { issueSession } from "./services/authService.ts";
import type { Server } from "node:http";

describe("Review CRM evidence and undo without losing later edits", () => {
  let db: Awaited<ReturnType<typeof createPrismaClient>>;
  const originalFetch = globalThis.fetch;
  before(async () => {
    db = await createPrismaClient();
    globalThis.fetch = async () => { throw new Error("No external actions in CRM review tests"); };
  });
  after(async () => { globalThis.fetch = originalFetch; await db.$disconnect(); });
  async function fixture(options: { auto?: boolean; manager?: boolean; summary?: string | null; nextStep?: string | null; enabled?: boolean } = {}) {
    const tenant = await db.tenant.create({ data: { name: "CRM review test", slug: randomUUID(), settingsJson: {
      aiAutomation: { defaultMode: options.auto ? "AUTO" : "ASSIST", crm: { enabled: options.enabled !== false } },
    } } });
    const user = await db.user.create({ data: { email: `${randomUUID()}@example.test`, name: "Owner", passwordHash: "unused" } });
    const membership = await db.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: options.manager ? "manager" : "owner" }, include: { tenant: true } });
    const auth = { user, activeMembership: membership, memberships: [membership], sessionId: "test", client: "web" } as AuthContext;
    const contact = await db.contact.create({ data: { tenantId: tenant.id, name: "Покупатель", summary: "Прежняя сводка", ownerMembershipId: membership.id } });
    const conversation = await db.conversation.create({ data: { tenantId: tenant.id, contactId: contact.id, mode: options.auto ? "ai" : "paused", messageRevision: 1, assigneeMembershipId: membership.id } });
    const inquiry = await db.inquiry.create({ data: { tenantId: tenant.id, contactId: contact.id, conversationId: conversation.id, source: "whatsapp", status: "qualification", assigneeMembershipId: membership.id,
      aiSummary: "Прежняя заявка", nextStep: "Прежний шаг" } });
    const message = await db.message.create({ data: { tenantId: tenant.id, conversationId: conversation.id, direction: "inbound", senderKind: "client",
      text: "Нужна презентация. Пришлите примеры работ", createdAt: new Date("2026-10-26T08:00:00Z") } });
    const analysis = await analyzeConversationContext(db, auth, conversation.id, { useLlm: false });
    Object.assign(analysis.analysis, { confidence: "HIGH", evidenceMessageIds: [message.id],
      summaryUpdate: options.summary === undefined ? "Нужна презентация" : options.summary,
      suggestedNextAction: options.nextStep === undefined ? "Отправить примеры работ" : options.nextStep,
      suggestedRequestStatus: "qualified", needsReply: true });
    const run = () => applyAnalyzedConversation(db, tenant.id, conversation.id, analysis);
    const list = (as = auth) => listConversationCrmReview(db, as, conversation.id);
    const act = (id: string, decision: "accept" | "dismiss" | "undo", as = auth) => reviewConversationCrmChange(db, as, conversation.id, id, decision);
    return { tenant, user, membership, auth, contact, conversation, inquiry, message, analysis, run, list, act };
  }
  const find = (items: CrmReviewItem[], entity: string, field: string) => {
    const item = items.find(i => i.entityType === entity && i.fields.some(f => f.key === field));
    assert.ok(item, `${entity}.${field} proposal is visible`); return item;
  };

  it("ASSIST persists grounded per-field proposals without mutating cards, tasks or messages", async () => {
    const f = await fixture(); await f.run();
    const { items } = await f.list();
    assert.equal(items.length, 3); assert.ok(items.every(i => i.status === "pending" && i.canAccept && i.canDismiss && !i.canUndo));
    assert.deepEqual(find(items, "inquiry", "nextStep").fields, [{ key: "nextStep", before: "Прежний шаг", after: "Отправить примеры работ" }]);
    assert.equal(items[0].evidence[0].id, f.message.id); assert.equal(items[0].evidence[0].text, f.message.text);
    assert.equal((await db.contact.findUniqueOrThrow({ where: { id: f.contact.id } })).summary, "Прежняя сводка");
    assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: f.inquiry.id } })).nextStep, "Прежний шаг");
    assert.equal(await db.task.count({ where: { tenantId: f.tenant.id } }), 0);
    assert.equal(await db.message.count({ where: { tenantId: f.tenant.id } }), 1);
  });
  it("replaying analysis and a dismissed proposal never duplicates or resurrects it", async () => {
    const f = await fixture(); await f.run();
    const first = await f.list(), item = find(first.items, "contact", "summary");
    await f.act(item.id, "dismiss"); await f.run(); await f.run(); await f.act(item.id, "dismiss");
    const listed = await f.list(); assert.equal(listed.items.length, 3);
    assert.equal(listed.items.find(i => i.id === item.id)?.status, "dismissed");
    assert.equal(await db.auditEvent.count({ where: { tenantId: f.tenant.id, action: "conversation.crm_reviewed" } }), 1);
    await assert.rejects(f.act(item.id, "accept"), { code: "crm_review_closed" });
  });
  it("accepts and undoes exactly once, preserving original activity and appending audit/history", async () => {
    const f = await fixture(); await f.run(); const item = find((await f.list()).items, "contact", "summary");
    await f.act(item.id, "accept"); await f.act(item.id, "accept");
    assert.equal((await db.contact.findUniqueOrThrow({ where: { id: f.contact.id } })).summary, "Нужна презентация");
    assert.equal((await f.list()).items.find(i => i.id === item.id)?.canUndo, true);
    await f.act(item.id, "undo"); await f.act(item.id, "undo");
    const row = await db.contact.findUniqueOrThrow({ where: { id: f.contact.id } });
    assert.equal(row.summary, "Прежняя сводка"); assert.equal(row.version, f.contact.version + 2);
    const history = await db.activity.findMany({ where: { tenantId: f.tenant.id, type: { in: ["conversation.crm_reviewed", "conversation.crm_undone"] } } });
    assert.equal(history.length, 2); assert.ok(history.every(a => a.actorId === f.user.id && a.actorType === "user"));
    assert.ok(history.every(a => a.description?.includes("Прежняя сводка") && a.description?.includes("Нужна презентация")));
    assert.equal(await db.auditEvent.count({ where: { tenantId: f.tenant.id } }), 2);
    const original = await db.activity.findUniqueOrThrow({ where: { id: item.id } });
    assert.equal(original.actorType, "ai"); assert.equal((original.metadataJson as any).review.status, "undone");
    assert.deepEqual((original.metadataJson as any).review.fields, item.fields);
  });
  it("other fields of the same proposal can be confirmed sequentially without rebasing unrelated edits", async () => {
    const f = await fixture(); await f.run(); const items = (await f.list()).items;
    const summary = find(items, "inquiry", "aiSummary"), step = find(items, "inquiry", "nextStep");
    await f.act(summary.id, "accept");
    assert.equal((await f.list()).items.find(i => i.id === step.id)?.canAccept, true);
    await f.act(step.id, "accept");
    const row = await db.inquiry.findUniqueOrThrow({ where: { id: f.inquiry.id } });
    assert.equal(row.nextStep, "Отправить примеры работ"); assert.equal(row.aiSummary, "Нужна презентация");
    await assert.rejects(f.act(summary.id, "undo"), { code: "crm_review_changed" });
  });
  it("a subsequent manual edit blocks acceptance and is preserved", async () => {
    const f = await fixture(); await f.run(); const step = find((await f.list()).items, "inquiry", "nextStep");
    await updateInquiry(db, f.auth, f.inquiry.id, { nextStep: "Сотрудник уже назначил встречу" });
    assert.equal((await f.list()).items.find(i => i.id === step.id)?.blockedReason, "changed");
    await assert.rejects(f.act(step.id, "accept"), { code: "crm_review_changed" });
    assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: f.inquiry.id } })).nextStep, "Сотрудник уже назначил встречу");
    await f.act(step.id, "dismiss");
  });
  it("undo protects manual edits even when the same summary is saved again", async () => {
    const f = await fixture(); await f.run(); const item = find((await f.list()).items, "contact", "summary");
    await f.act(item.id, "accept"); await updateContact(db, f.auth, f.contact.id, { summary: "Нужна презентация" });
    await assert.rejects(f.act(item.id, "undo"), { code: "crm_review_changed" });
    assert.equal((await db.contact.findUniqueOrThrow({ where: { id: f.contact.id } })).summary, "Нужна презентация");
  });
  it("a manual write during inference creates a blocked proposal, not a silently rebased one", async () => {
    const f = await fixture();
    await db.contact.update({ where: { id: f.contact.id }, data: { summary: "Новый ручной факт" } });
    await f.run(); const item = find((await f.list()).items, "contact", "summary");
    assert.equal(item.canAccept, false); assert.equal(item.blockedReason, "changed");
    await assert.rejects(f.act(item.id, "accept"), { code: "crm_review_changed" });
  });
  it("a new message blocks stale review, and reanalysis supersedes only the same field", async () => {
    const f = await fixture(); await f.run(); const old = find((await f.list()).items, "inquiry", "nextStep");
    const message = await db.message.create({ data: { tenantId: f.tenant.id, conversationId: f.conversation.id, direction: "inbound", senderKind: "client", text: "Лучше созвонимся", createdAt: new Date("2026-10-26T08:01:00Z") } });
    await db.conversation.update({ where: { id: f.conversation.id }, data: { messageRevision: { increment: 1 } } });
    await assert.rejects(f.act(old.id, "accept"), { code: "crm_review_changed" });
    const next = await analyzeConversationContext(db, f.auth, f.conversation.id, { useLlm: false });
    Object.assign(next.analysis, { confidence: "HIGH", evidenceMessageIds: [message.id], summaryUpdate: "Нужна презентация и звонок", suggestedNextAction: "Уточнить время звонка" });
    await applyAnalyzedConversation(db, f.tenant.id, f.conversation.id, next);
    const items = (await f.list()).items;
    assert.equal(items.find(i => i.id === old.id)?.status, "superseded");
    assert.equal(items.filter(i => i.status === "pending").length, 3);
    assert.equal(items.find(i => i.entityType === "inquiry" && i.status === "pending" && i.fields[0].key === "nextStep")?.canAccept, true);
  });
  it("editing evidence text invalidates review even if the message revision was not updated", async () => {
    const f = await fixture(); await f.run(); const item = find((await f.list()).items, "contact", "summary");
    await db.message.update({ where: { id: f.message.id }, data: { text: "Презентация больше не нужна" } });
    assert.equal((await f.list()).items.find(i => i.id === item.id)?.blockedReason, "conversation_changed");
    await assert.rejects(f.act(item.id, "accept"), { code: "crm_review_changed" });
  });
  it("a new message in an alias thread blocks confirmation even without a canonical revision change", async () => {
    const f = await fixture(); await f.run(); const item = find((await f.list()).items, "contact", "summary");
    const alias = await db.conversation.create({ data: { tenantId: f.tenant.id, contactId: f.contact.id, attentionReason: "seller_lead_rematched", assigneeMembershipId: f.membership.id } });
    await db.message.create({ data: { tenantId: f.tenant.id, conversationId: alias.id, direction: "inbound", senderKind: "client", text: "Отменяю заказ", createdAt: new Date("2026-10-26T08:02:00Z") } });
    assert.equal((await f.list()).items.find(i => i.id === item.id)?.blockedReason, "conversation_changed");
    await assert.rejects(f.act(item.id, "accept"), { code: "crm_review_changed" });
  });
  it("undo of automatic inquiry changes appends the reverse status transition and preserves checkpoint", async () => {
    const f = await fixture({ auto: true }); await f.run();
    const items = (await f.list()).items;
    assert.ok(items.some(i => i.status === "automatic")); assert.ok(items.every(i => i.status !== "pending"));
    const item = find(items, "inquiry", "status"); assert.equal(item.canUndo, true);
    await f.act(item.id, "undo");
    const row = await db.inquiry.findUniqueOrThrow({ where: { id: f.inquiry.id } });
    assert.equal(row.status, "qualification"); assert.equal(row.aiSummary, "Прежняя заявка"); assert.equal(row.nextStep, "Прежний шаг");
    const history = await db.inquiryStatusHistory.findMany({ where: { inquiryId: row.id }, orderBy: { changedAt: "asc" } });
    assert.equal(history.length, 2); assert.equal(history[0].toStatus, "qualified"); assert.equal(history[1].toStatus, "qualification");
    assert.equal(history[1].changedById, f.user.id);
    await f.run(); assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: row.id } })).status, "qualification");
    assert.equal(await db.inquiryStatusHistory.count({ where: { inquiryId: row.id } }), 2);
  });
  it("a manager can confirm their next step but cannot edit the client or AI summary", async () => {
    const f = await fixture({ manager: true }); await f.run(); const items = (await f.list()).items;
    const step = find(items, "inquiry", "nextStep"), client = find(items, "contact", "summary"), summary = find(items, "inquiry", "aiSummary");
    assert.equal(step.canAccept, true); assert.equal(client.blockedReason, "permissions"); assert.equal(summary.canAccept, false);
    await assert.rejects(f.act(client.id, "accept"), { code: "forbidden" });
    await assert.rejects(f.act(summary.id, "dismiss"), { code: "forbidden" });
    await f.act(step.id, "accept"); await f.act(step.id, "undo");
  });
  it("record reassignment removes access even while the conversation remains reachable", async () => {
    const f = await fixture({ manager: true }); await f.run(); const item = find((await f.list()).items, "inquiry", "nextStep");
    const user = await db.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "unused", name: "Другой" } });
    const other = await db.membership.create({ data: { tenantId: f.tenant.id, userId: user.id, role: "manager" } });
    await db.inquiry.update({ where: { id: f.inquiry.id }, data: { assigneeMembershipId: other.id } });
    assert.ok(!(await f.list()).items.some(i => i.id === item.id));
    assert.ok(!(await getContactOverview(db, f.auth, f.contact.id)).timeline.some(i => i.id === item.id));
    await assert.rejects(f.act(item.id, "accept"), { code: "not_found" });
  });
  it("rejects cross-tenant conversation and proposal IDs, suspended memberships and configuration-only access", async () => {
    const f = await fixture(), other = await fixture(); await f.run(); const item = (await f.list()).items[0];
    await assert.rejects(f.list(other.auth), { code: "not_found" });
    await assert.rejects(other.act(item.id, "accept"), { code: "not_found" });
    const suspended = { ...f.auth, activeMembership: { ...f.membership, active: false } } as AuthContext;
    await assert.rejects(f.list(suspended), { code: "membership_suspended" });
    const config = { ...f.auth, activeMembership: null, configurationTenant: { tenantId: f.tenant.id, tenant: f.tenant } } as AuthContext;
    await assert.rejects(f.act(item.id, "accept", config), { code: "no_tenant" });
  });
  it("does not attach another tenant's messages or pending outbound messages as evidence", async () => {
    const f = await fixture(), other = await fixture();
    f.analysis.analysis.evidenceMessageIds = [f.message.id, other.message.id]; await f.run(); assert.equal((await f.list()).items.length, 0);
    f.analysis.analysis.evidenceMessageIds = [f.message.id];
    await db.message.update({ where: { id: f.message.id }, data: { operationState: "queued" } });
    await assert.rejects(f.run(), { code: "stale_analysis" });
  });
  it("refuses disabled automation and low-confidence guesses instead of inventing proposed values", async () => {
    const disabled = await fixture({ enabled: false }); await disabled.run(); assert.equal((await disabled.list()).items.length, 0);
    const low = await fixture(); low.analysis.analysis.confidence = "LOW"; await low.run(); assert.equal((await low.list()).items.length, 0);
    const medium = await fixture(); medium.analysis.analysis.confidence = "MEDIUM"; await medium.run();
    assert.ok((await medium.list()).items.every(i => i.confidence === "MEDIUM" && i.status === "pending"));
  });
  it("never erases fields because the model returned empty/null values", async () => {
    const f = await fixture({ summary: null, nextStep: null }); await f.run(); assert.equal((await f.list()).items.length, 0);
    assert.equal((await db.contact.findUniqueOrThrow({ where: { id: f.contact.id } })).summary, "Прежняя сводка");
  });
  it("rolls back the card, proposal and activity if the audit write fails", async () => {
    const f = await fixture(); await f.run(); const item = find((await f.list()).items, "contact", "summary");
    const broken = new Proxy(db, { get(target, property) {
      if (property === "$transaction") return (callback: any, options: any) => db.$transaction(async tx => callback(new Proxy(tx, {
        get(transaction, name) { if (name === "auditEvent") return new Proxy(transaction.auditEvent, { get(delegate, method) {
          if (method === "create") return () => { throw new Error("Injected audit failure"); };
          return Reflect.get(delegate, method);
        } }); return Reflect.get(transaction, name); },
      })), options);
      return Reflect.get(target, property);
    } });
    await assert.rejects(reviewConversationCrmChange(broken, f.auth, f.conversation.id, item.id, "accept"), /Injected audit failure/);
    assert.equal((await db.contact.findUniqueOrThrow({ where: { id: f.contact.id } })).summary, "Прежняя сводка");
    assert.equal((await f.list()).items.find(i => i.id === item.id)?.status, "pending");
    assert.equal(await db.activity.count({ where: { tenantId: f.tenant.id, type: "conversation.crm_reviewed" } }), 0);
  });
  it("legacy or malformed history remains readable elsewhere but does not offer unsafe undo", async () => {
    const f = await fixture();
    await db.activity.create({ data: { tenantId: f.tenant.id, contactId: f.contact.id, type: "conversation.crm_updated", title: "Legacy", metadataJson: { conversationId: f.conversation.id, before: {}, after: {} } } });
    await f.run(); const item = (await f.list()).items[0];
    const activity = await db.activity.findUniqueOrThrow({ where: { id: item.id } });
    await db.activity.update({ where: { id: item.id }, data: { metadataJson: { ...activity.metadataJson as object, review: { ...(activity.metadataJson as any).review, fields: [{ key: "offerAmountMinor", before: 0, after: 999999 }] } } } });
    assert.ok(!(await f.list()).items.some(i => i.id === item.id));
    await assert.rejects(f.act(item.id, "accept"), { code: "not_found" });
  });
  it("two simultaneous confirmations commit one mutation and one audit", async () => {
    const f = await fixture(); await f.run(); const item = find((await f.list()).items, "contact", "summary");
    const results = await Promise.all([f.act(item.id, "accept"), f.act(item.id, "accept")]);
    assert.ok(results.every(r => r.status === "accepted"));
    assert.equal((await db.contact.findUniqueOrThrow({ where: { id: f.contact.id } })).version, f.contact.version + 1);
    assert.equal(await db.auditEvent.count({ where: { tenantId: f.tenant.id, action: "conversation.crm_reviewed" } }), 1);
  });
  it("HTTP endpoints require authentication and reject client-supplied replacement fields", async () => {
    const f = await fixture(); await f.run(); const item = find((await f.list()).items, "contact", "summary");
    let server: Server | undefined;
    try {
      await new Promise<void>((resolve, reject) => { server = createApp(db).listen(0, "127.0.0.1", error => error ? reject(error) : resolve()).once("error", reject); });
      const address = server!.address(); assert.ok(address && typeof address !== "string");
      const path = `http://127.0.0.1:${address.port}/api/v1/conversations/${f.conversation.id}/crm-review`;
      assert.equal((await originalFetch(path)).status, 401);
      const session = await issueSession(db, f.user.id);
      const headers = { "Content-Type": "application/json", cookie: `${session.cookieName}=${session.sessionToken}` };
      const listing = await originalFetch(path, { headers }); assert.equal(listing.status, 200);
      assert.equal((await listing.json()).items.length, 3);
      for (const body of [{ decision: "erase" }, { decision: "accept", after: { summary: "forged" } }, {}]) {
        const response = await originalFetch(`${path}/${item.id}`, { method: "POST", headers, body: JSON.stringify(body) });
        assert.equal(response.status, 422, JSON.stringify(await response.json()));
      }
      assert.equal((await db.contact.findUniqueOrThrow({ where: { id: f.contact.id } })).summary, "Прежняя сводка");
      const applied = await originalFetch(`${path}/${item.id}`, { method: "POST", headers, body: JSON.stringify({ decision: "accept" }) });
      assert.equal(applied.status, 200); assert.equal((await applied.json()).status, "accepted");
    } finally { if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve())); }
  });
});
