import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { WhatsAppSellerBridge } from "@creolab/integrations";
import type { AuthContext } from "./lib/types.ts";
import { ApiError } from "./errors.ts";
import { encryptSecret } from "./lib/secretBox.ts";
import { createApp } from "./app.ts";
import { getMessageDeliveryReview, reconcileMessageDelivery, retryMessageDelivery } from "./services/messageDeliveryReview.ts";
import { prepareLegacyMessage, deliverLegacyMessage, legacyCampaignKey, legacyManualKey, readLegacyDelivery, recoverLegacyMessage } from "./services/legacyMessageDelivery.ts";
import { getCampaign, processCampaignQueue, cancelCampaignRemainder } from "./services/campaignService.ts";
import { getConversationWorkspace } from "./services/conversationService.ts";
import { adoptSameContactThreadMessages } from "./services/conversationThread.ts";

describe("Explicit delivery review and retry", () => {
  let db: Awaited<ReturnType<typeof createPrismaClient>>, auth: AuthContext, manager: AuthContext, tid: string, integrationId: string;
  let server: Server | undefined, base: string, cookie: string;
  let textCalls = 0, fileCalls = 0;
  let textSend: () => Promise<unknown>, fileSend: () => Promise<unknown>;
  const nativeFetch = globalThis.fetch;
  const code = (value: string) => (err: unknown) => err instanceof ApiError && err.code === value;
  before(async () => {
    db = await createPrismaClient();
    await (await import("../../../packages/db/src/seed.ts")).seedDatabase();
    const owner = await db.membership.findFirstOrThrow({ where: { role: "owner", tenant: { slug: "creolab" } }, include: { user: true, tenant: true } });
    auth = { user: owner.user, activeMembership: owner, memberships: [owner] } as AuthContext; tid = owner.tenantId;
    const staff = await db.membership.findFirstOrThrow({ where: { tenantId: tid, role: "manager" }, include: { user: true, tenant: true } });
    manager = { user: staff.user, activeMembership: staff, memberships: [staff] } as AuthContext;
    const existing = await db.integration.findFirst({ where: { tenantId: tid, type: "whatsapp_seller" } });
    const data = { status: "active", connectionStatus: "CONNECTED", schemaJson: { sellerUrl: "https://seller.invalid", secretEnc: encryptSecret("synthetic-only") } };
    integrationId = (existing ? await db.integration.update({ where: { id: existing.id }, data })
      : await db.integration.create({ data: { tenantId: tid, type: "whatsapp_seller", name: "Review fixture", ...data } })).id;
    globalThis.fetch = async (...args) => {
      if (String(args[0]).startsWith(`${base}/`)) return nativeFetch(...args);
      throw new Error("External network forbidden in review test");
    };
    await new Promise<void>((resolve, reject) => { server = createApp(db).listen(0, "127.0.0.1", error => error ? reject(error) : resolve()); server.once("error", reject); });
    base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
    const response = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: owner.user.email, password: process.env.SEED_PASSWORD, client: "web" }) });
    assert.equal(response.status, 200); cookie = response.headers.get("set-cookie") || "";
  });
  after(async () => { globalThis.fetch = nativeFetch; await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); await db?.$disconnect(); });
  beforeEach(() => {
    textCalls = 0; fileCalls = 0;
    textSend = async () => ({ ok: true, idMessage: `text-${textCalls}` });
    fileSend = async () => ({ ok: true, idMessage: `file-${fileCalls}` });
    mock.method(WhatsAppSellerBridge.prototype, "setMode", async () => ({ ok: true }));
    mock.method(WhatsAppSellerBridge.prototype, "sendText", async () => { textCalls++; return textSend(); });
    mock.method(WhatsAppSellerBridge.prototype, "sendFile", async () => { fileCalls++; return fileSend(); });
  });
  afterEach(() => mock.restoreAll());
  async function fixture(options: { campaign?: boolean; files?: number; actor?: AuthContext } = {}) {
    const actor = options.actor || auth;
    const contact = await db.contact.create({ data: { tenantId: tid, name: "Клиент проверки", methods: { create: {
      type: "phone", rawValue: "+7 708 111 22 33", normalizedValue: "77081112233", primary: true, source: "test",
    } } } });
    const conv = await db.conversation.create({ data: { tenantId: tid, contactId: contact.id, sellerLeadId: randomUUID(), mode: "human", assigneeMembershipId: actor.activeMembership!.id } });
    const campaign = options.campaign ? await db.campaign.create({ data: { tenantId: tid, title: "Isolated review", status: "running",
      confirmedAt: new Date(), confirmedById: auth.user.id, createdByMembershipId: auth.activeMembership!.id, messageSnapshot: "Материалы", contentHash: randomUUID(), createMissingClients: false } }) : null;
    const recipient = campaign ? await db.campaignRecipient.create({ data: { tenantId: tid, campaignId: campaign.id, contactId: contact.id,
      conversationId: conv.id, status: "sending", displayName: contact.name, phoneRaw: "+7 708 111 22 33" } }) : null;
    const operation = await prepareLegacyMessage(db, { tenantId: tid, conversationId: conv.id, actorUserId: actor.user.id,
      key: campaign ? legacyCampaignKey(campaign.id, recipient!.id) : legacyManualKey(conv.id, randomUUID()), text: "Материалы для клиента",
      files: Array.from({ length: options.files ?? 1 }, (_, i) => ({ fileName: `Файл-${i + 1}.pdf`, mimeType: "application/pdf", buffer: Buffer.from(`fixture-${i}`) })),
      ...(campaign ? { campaign: { id: campaign.id, recipientId: recipient!.id } } : {}) });
    const messageId = operation.providerRef!;
    return { conv, contact, campaign, recipient, operation, messageId,
      send: () => deliverLegacyMessage(db, tid, operation.id), view: (a = auth) => getMessageDeliveryReview(db, a, conv.id, messageId),
      review: async (outcome: "sent" | "not_sent", partId = "text") => {
        const view = await getMessageDeliveryReview(db, auth, conv.id, messageId);
        return reconcileMessageDelivery(db, auth, conv.id, messageId, { revision: view.revision, partId, outcome, note: "Проверено в WhatsApp компании" });
      },
      retry: async () => retryMessageDelivery(db, auth, conv.id, messageId, (await getMessageDeliveryReview(db, auth, conv.id, messageId)).revision),
    };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function unknownText(f: Fixture) {
    textSend = async () => { throw new Error("Lost response after remote send"); };
    await f.send(); textSend = async () => ({ ok: true, idMessage: "retry-text" });
  }
  async function expire(f: Fixture) {
    const delivery = (await readLegacyDelivery(db, tid, f.operation.id))!;
    delivery.leaseUntil = new Date(0).toISOString();
    await db.idempotencyRecord.update({ where: { scope_actorKey_key: { scope: "legacy.message.delivery", actorKey: tid, key: f.operation.id } }, data: { resultJson: delivery as any } });
  }
  const route = (f: Fixture) => `${base}/api/v1/conversations/${f.conv.id}/messages/${f.messageId}/delivery`;
  const post = (url: string, value: unknown) => fetch(url, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify(value) });

  it("returns exact part results, recipient identity and a revision without changing anything", async () => {
    const f = await fixture(); await unknownText(f);
    const before = await readLegacyDelivery(db, tid, f.operation.id), view = await f.view();
    assert.match(view.recipient, /708 111 22 33/); assert.equal(view.messageId, f.messageId);
    assert.deepEqual(view.parts.map(p => p.state), ["unknown", "pending"]); assert.match(view.revision, /^[a-f0-9]{64}$/);
    assert.equal(view.canRetry, false); assert.equal(view.canReconcile, true);
    assert.deepEqual(await readLegacyDelivery(db, tid, f.operation.id), before); assert.equal(textCalls, 1); assert.equal(fileCalls, 0);
  });
  it("records manual acceptance separately from provider delivery and retains the actor and note in history", async () => {
    const f = await fixture({ files: 0 }); await unknownText(f);
    const view = await f.review("sent");
    assert.equal(view.parts[0].state, "accepted"); assert.equal(view.parts[0].providerMessageId, null);
    assert.equal(view.parts[0].checkedBy, auth.user.name); assert.ok(view.parts[0].checkedAt); assert.match(view.parts[0].note!, /WhatsApp/);
    assert.equal(view.retryBlock, "complete"); assert.equal(textCalls, 1);
    const message = await db.message.findUniqueOrThrow({ where: { id: f.messageId } }); assert.equal(message.receiptState, "reconciled");
    assert.equal(await db.auditEvent.count({ where: { entityId: f.messageId, action: "message.delivery_reconciled", actorUserId: auth.user.id } }), 1);
    assert.equal(await db.activity.count({ where: { contactId: f.contact.id, type: "message.delivery_reconciled", actorId: auth.user.id } }), 1);
    const workspace = await getConversationWorkspace(db, auth, f.conv.id);
    const row = workspace.messages.find(m => m.id === f.messageId)!; assert.equal(row.deliveryLabel, "Сверено сотрудником");
    assert.equal(row.deliveryReviewAvailable, true); assert.equal(row.deliveryConversationId, f.conv.id);
  });
  it("does not enqueue pending campaign files when a person confirms the text", async () => {
    const f = await fixture({ campaign: true }); await unknownText(f); const view = await f.review("sent");
    assert.equal(view.canRetry, true); assert.deepEqual(view.parts.map(p => p.state), ["accepted", "pending"]);
    await processCampaignQueue(db, f.campaign!.id);
    assert.equal(textCalls, 1); assert.equal(fileCalls, 0);
    const c = await getCampaign(db, auth, f.campaign!.id); assert.equal(c.recipients[0].status, "failed");
    assert.equal(c.status, "failed"); assert.equal(c.recipients[0].deliveryMessageId, f.messageId); assert.equal(c.recipients[0].deliveryChecked, true);
    const result = await f.retry(); assert.equal(result.retryBlock, "complete"); assert.equal(textCalls, 1); assert.equal(fileCalls, 1);
    assert.equal((await getCampaign(db, auth, f.campaign!.id)).status, "completed");
  });
  it("retries only the checked absent file and preserves the accepted text and message ID", async () => {
    const f = await fixture(); fileSend = async () => { throw new Error("timeout"); }; await f.send();
    const view = await f.view(), textId = view.parts[0].providerMessageId;
    await f.review("not_sent", view.parts[1].id); assert.equal(fileCalls, 1);
    fileSend = async () => ({ ok: true, idMessage: "replayed-file" });
    const result = await f.retry(); assert.equal(textCalls, 1); assert.equal(fileCalls, 2);
    assert.equal(result.messageId, f.messageId); assert.equal(result.parts[0].providerMessageId, textId);
    assert.equal(result.parts[1].providerMessageId, "replayed-file"); assert.equal(result.parts[1].checkedBy, null);
    assert.equal(await db.message.count({ where: { conversationId: f.conv.id } }), 1);
    assert.equal(await db.auditEvent.count({ where: { entityId: f.messageId, action: "message.delivery_retry" } }), 1);
    assert.equal(await db.activity.count({ where: { contactId: f.contact.id, type: "message.delivery_reconciled" } }), 1);
  });
  it("rejects a stale or concurrent reconciliation instead of overwriting another employee", async () => {
    const f = await fixture(); await unknownText(f); const view = await f.view();
    const input = { revision: view.revision, partId: "text", outcome: "not_sent" as const, note: "Проверено: сообщения нет" };
    const results = await Promise.allSettled([reconcileMessageDelivery(db, auth, f.conv.id, f.messageId, input), reconcileMessageDelivery(db, auth, f.conv.id, f.messageId, input)]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    const rejected = results.find(r => r.status === "rejected") as PromiseRejectedResult; assert.ok(code("delivery_changed")(rejected.reason));
    await assert.rejects(reconcileMessageDelivery(db, auth, f.conv.id, f.messageId, input), code("delivery_changed"));
    assert.equal(await db.auditEvent.count({ where: { entityId: f.messageId, action: "message.delivery_reconciled" } }), 1); assert.equal(textCalls, 1);
  });
  it("does not allow replacing known acceptance or approving a part from a different message", async () => {
    const a = await fixture(), b = await fixture(); await a.send(); await unknownText(b);
    await assert.rejects(a.review("not_sent"), code("already_reconciled"));
    await assert.rejects(b.review("sent", (await a.view()).parts[1].id), code("not_found"));
    assert.equal((await a.view()).parts[0].state, "accepted");
  });
  it("serializes parallel retries and rejects replay of a stale retry request", async () => {
    const f = await fixture(); await unknownText(f); const view = await f.review("not_sent");
    const results = await Promise.allSettled([retryMessageDelivery(db, auth, f.conv.id, f.messageId, view.revision), retryMessageDelivery(db, auth, f.conv.id, f.messageId, view.revision)]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.ok(code("delivery_changed")((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason));
    assert.equal(textCalls, 2); assert.equal(fileCalls, 1);
    await assert.rejects(retryMessageDelivery(db, auth, f.conv.id, f.messageId, view.revision), code("delivery_changed"));
  });
  it("blocks retries while any result remains unknown", async () => {
    const f = await fixture(); await unknownText(f);
    await assert.rejects(f.retry(), code("delivery_retry_blocked")); assert.equal(textCalls, 1); assert.equal(fileCalls, 0);
  });
  it("blocks a live claim, then fences a late provider response after an expired claim is reviewed", async () => {
    const f = await fixture(); let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
    textSend = async () => { entered(); await gate; return { ok: true, idMessage: "late-provider-id" }; };
    const pending = f.send(); await Promise.race([started, pending.then(() => { throw new Error("No provider call"); })]);
    try {
      const active = await f.view(); assert.equal(active.busy, true); assert.equal(active.canReconcile, false);
      await assert.rejects(f.review("sent"), code("delivery_busy"));
      await expire(f); assert.equal((await f.view()).parts[0].state, "unknown");
      await f.review("sent");
    } finally { release(); }
    await assert.rejects(pending, code("delivery_changed"));
    const result = await f.view(); assert.equal(result.parts[0].state, "accepted"); assert.equal(result.parts[0].providerMessageId, null); assert.equal(fileCalls, 0);
  });
  it("lets an assigned employee read evidence but restricts reconciliation and retry to company leaders", async () => {
    const f = await fixture({ actor: manager }); await unknownText(f); const view = await f.view(manager);
    assert.equal(view.canReconcile, false); assert.equal(view.canRetry, false);
    await assert.rejects(reconcileMessageDelivery(db, manager, f.conv.id, f.messageId, { revision: view.revision, partId: "text", outcome: "sent", note: "Проверено в WhatsApp" }), code("forbidden"));
    await assert.rejects(retryMessageDelivery(db, manager, f.conv.id, f.messageId, view.revision), code("forbidden"));
  });
  it("does not expose foreign company messages or an inaccessible employee conversation", async () => {
    const f = await fixture(); await unknownText(f);
    await db.conversation.update({ where: { id: f.conv.id }, data: { assigneeMembershipId: auth.activeMembership!.id } });
    await assert.rejects(f.view(manager), err => err instanceof ApiError && [403, 404].includes(err.status));
    const foreign = await db.tenant.create({ data: { name: "Other", slug: randomUUID() } });
    const conv = await db.conversation.create({ data: { tenantId: foreign.id } });
    const msg = await db.message.create({ data: { tenantId: foreign.id, conversationId: conv.id, direction: "outbound", senderKind: "staff", text: "private" } });
    await assert.rejects(getMessageDeliveryReview(db, auth, conv.id, msg.id), code("not_found"));
    await assert.rejects(getMessageDeliveryReview(db, auth, f.conv.id, msg.id), code("not_found"));
  });
  it("does not manufacture evidence for old untracked sends or AI messages", async () => {
    const f = await fixture();
    const old = await db.message.create({ data: { tenantId: tid, conversationId: f.conv.id, direction: "outbound", senderKind: "staff", text: "old", operationState: "unknown" } });
    await assert.rejects(getMessageDeliveryReview(db, auth, f.conv.id, old.id), code("delivery_untracked"));
    await db.message.update({ where: { id: old.id }, data: { senderKind: "ai" } });
    await assert.rejects(getMessageDeliveryReview(db, auth, f.conv.id, old.id), code("delivery_untracked")); assert.equal(textCalls, 0);
  });
  it("blocks replay if the conversation mode, control version or recipient changed", async () => {
    for (const change of [{ mode: "ai" }, { controlVersion: { increment: 1 } }, { sellerLeadId: randomUUID() }, { status: "closed" }]) {
      const f = await fixture(); await unknownText(f); await f.review("not_sent");
      await db.conversation.update({ where: { id: f.conv.id }, data: change });
      assert.equal((await f.view()).retryBlock, "conversation_changed"); await assert.rejects(f.retry(), code("delivery_retry_blocked"));
    }
    assert.equal(textCalls, 4); assert.equal(fileCalls, 0);
  });
  it("does not borrow leader authority when the original employee loses access", async () => {
    const f = await fixture({ actor: manager }); await unknownText(f); await f.review("not_sent");
    await db.membership.update({ where: { id: manager.activeMembership!.id }, data: { active: false } });
    try { assert.equal((await f.view()).retryBlock, "access_changed"); await assert.rejects(f.retry(), code("delivery_retry_blocked")); }
    finally { await db.membership.update({ where: { id: manager.activeMembership!.id }, data: { active: true } }); }
    assert.equal(textCalls, 1); assert.equal(fileCalls, 0);
  });
  it("keeps the original recipient visible and blocks retry after relinking the conversation to another client", async () => {
    const f = await fixture(); await unknownText(f); await f.review("not_sent");
    const another = await db.contact.create({ data: { tenantId: tid, name: "Другой клиент" } });
    await db.conversation.update({ where: { id: f.conv.id }, data: { contactId: another.id } });
    const view = await f.view(); assert.match(view.recipient, /Клиент проверки/); assert.match(view.recipient, /708 111 22 33/);
    assert.equal(view.retryBlock, "conversation_changed"); await assert.rejects(f.retry(), code("delivery_retry_blocked"));
    assert.equal(textCalls, 1); assert.equal(fileCalls, 0);
  });
  it("does not offer to retry a recipient that is already queued by the campaign worker", async () => {
    const f = await fixture({ campaign: true });
    assert.equal((await f.view()).retryBlock, "busy"); await assert.rejects(f.retry(), code("delivery_retry_blocked"));
    assert.equal(textCalls, 0); assert.equal(fileCalls, 0);
  });
  it("records reconciliation in the original client's history even if the conversation was relinked", async () => {
    const f = await fixture({ files: 0 }); await unknownText(f);
    const another = await db.contact.create({ data: { tenantId: tid, name: "Другой клиент" } });
    await db.conversation.update({ where: { id: f.conv.id }, data: { contactId: another.id } });
    await f.review("sent");
    assert.equal(await db.activity.count({ where: { contactId: f.contact.id, type: "message.delivery_reconciled" } }), 1);
    assert.equal(await db.activity.count({ where: { contactId: another.id, type: "message.delivery_reconciled" } }), 0);
    assert.equal(textCalls, 1);
  });
  it("does not send through a replacement WhatsApp connection", async () => {
    const f = await fixture(); await unknownText(f); await f.review("not_sent");
    const integration = await db.integration.findUniqueOrThrow({ where: { id: integrationId } });
    await db.integration.update({ where: { id: integrationId }, data: { schemaJson: { ...(integration.schemaJson as object), instanceId: "changed" } } });
    try { assert.equal((await f.view()).retryBlock, "connection_changed"); await assert.rejects(f.retry(), code("delivery_retry_blocked")); }
    finally { await db.integration.update({ where: { id: integrationId }, data: { schemaJson: integration.schemaJson as any } }); }
    assert.equal(textCalls, 1); assert.equal(fileCalls, 0);
  });
  it("allows checking a cancelled campaign without reactivating it", async () => {
    const f = await fixture({ campaign: true }); await unknownText(f); await cancelCampaignRemainder(db, auth, f.campaign!.id);
    const checked = await f.review("sent"); assert.equal(checked.retryBlock, "campaign_stopped");
    await assert.rejects(f.retry(), code("delivery_retry_blocked"));
    assert.equal((await getCampaign(db, auth, f.campaign!.id)).status, "cancelled"); assert.equal(fileCalls, 0);
  });
  it("blocks retries for paused campaigns and changed confirmations or content", async () => {
    for (const change of [{ status: "paused" }, { confirmedAt: new Date(Date.now() + 10_000) }, { contentHash: randomUUID() }]) {
      const f = await fixture({ campaign: true }); await unknownText(f); await f.review("not_sent");
      await db.campaign.update({ where: { id: f.campaign!.id }, data: change });
      assert.equal((await f.view()).canRetry, false); await assert.rejects(f.retry(), code("delivery_retry_blocked"));
    }
    assert.equal(textCalls, 3); assert.equal(fileCalls, 0);
  });
  it("retries just the selected campaign recipient without restarting other failures", async () => {
    const f = await fixture({ campaign: true }); await unknownText(f); await f.review("not_sent");
    const neighbor = await db.campaignRecipient.create({ data: { tenantId: tid, campaignId: f.campaign!.id, status: "failed", textSendState: "not_sent" } });
    await db.campaign.update({ where: { id: f.campaign!.id }, data: { status: "failed" } });
    await f.retry();
    const campaign = await getCampaign(db, auth, f.campaign!.id); assert.equal(campaign.status, "partially_completed");
    assert.equal(campaign.summary.sent, 1); assert.equal(campaign.summary.failed, 1);
    assert.equal(campaign.recipients.find(r => r.id === neighbor.id)!.status, "failed"); assert.equal(textCalls, 2); assert.equal(fileCalls, 1);
  });
  it("rechecks campaign cancellation between retried parts", async () => {
    const f = await fixture({ campaign: true }); await unknownText(f); await f.review("not_sent");
    textSend = async () => { await cancelCampaignRemainder(db, auth, f.campaign!.id); return { ok: true, idMessage: "text-only" }; };
    const result = await f.retry(); assert.deepEqual(result.parts.map(p => p.state), ["accepted", "failed"]);
    assert.equal(fileCalls, 0); assert.equal((await getCampaign(db, auth, f.campaign!.id)).status, "cancelled");
  });
  it("keeps a renewed timeout unknown rather than repeatedly resending after a human review", async () => {
    const f = await fixture(); await unknownText(f); await f.review("not_sent");
    textSend = async () => { throw new Error("Another lost response"); };
    const result = await f.retry(); assert.equal(result.parts[0].state, "unknown"); assert.equal(result.parts[0].checkedBy, null);
    await assert.rejects(f.retry(), code("delivery_retry_blocked")); assert.equal(textCalls, 2); assert.equal(fileCalls, 0);
  });
  it("checks cancellation, human mode and revoked access immediately before the provider call", async () => {
    for (const change of ["cancel", "mode", "access"]) {
      const f = await fixture({ campaign: true }); await unknownText(f); const view = await f.review("not_sent");
      const original = db.integration.findFirst.bind(db.integration); let changed = false;
      const intercepted = new Proxy(db, { get(target, key) {
        if (key === "integration") return { ...target.integration, findFirst: async (args: any) => {
          const result = await original(args);
          if (!changed && args?.where?.type === "whatsapp_seller" && await db.outboundOperation.count({ where: { id: f.operation.id, state: "sending" } })) {
            changed = true;
            if (change === "cancel") await cancelCampaignRemainder(db, auth, f.campaign!.id);
            if (change === "mode") await db.conversation.update({ where: { id: f.conv.id }, data: { mode: "ai" } });
            if (change === "access") await db.membership.update({ where: { id: auth.activeMembership!.id }, data: { active: false } });
          }
          return result;
        } };
        return Reflect.get(target, key);
      } });
      try {
        const result = await retryMessageDelivery(intercepted, auth, f.conv.id, f.messageId, view.revision);
        assert.equal(changed, true); assert.equal(result.parts[0].state, "failed");
      } finally { await db.membership.update({ where: { id: auth.activeMembership!.id }, data: { active: true } }); }
    }
    assert.equal(textCalls, 3); assert.equal(fileCalls, 0);
  });
  it("keeps tracked outbound messages attached to the original operation when history is combined", async () => {
    const f = await fixture(); await unknownText(f);
    await db.conversation.update({ where: { id: f.conv.id }, data: { attentionReason: "seller_lead_rematched" } });
    const target = await db.conversation.create({ data: { tenantId: tid, contactId: f.contact.id, sellerLeadId: randomUUID(), mode: "human" } });
    const oldInbound = await db.message.create({ data: { tenantId: tid, conversationId: f.conv.id, direction: "inbound", senderKind: "client", text: "Old inbound" } });
    await adoptSameContactThreadMessages(db, tid, target);
    assert.equal((await db.message.findUniqueOrThrow({ where: { id: f.messageId } })).conversationId, f.conv.id);
    assert.equal((await db.message.findUniqueOrThrow({ where: { id: oldInbound.id } })).conversationId, target.id);
    const workspace = await getConversationWorkspace(db, auth, target.id), visible = workspace.messages.find(m => m.id === f.messageId)!;
    assert.ok(visible); assert.equal(visible.deliveryConversationId, f.conv.id); assert.equal((await f.view()).messageId, f.messageId);
  });
  it("validates HTTP review input and requires authentication", async () => {
    const f = await fixture(); await unknownText(f); const view = await f.view();
    const unauthorized = await fetch(route(f)); assert.equal(unauthorized.status, 401);
    const get = await fetch(route(f), { headers: { cookie } }); assert.equal(get.status, 200); assert.match(get.headers.get("cache-control")!, /no-store/);
    for (const input of [
      { revision: view.revision, partId: "text", outcome: "sent", note: "short" },
      { revision: view.revision, partId: "text", outcome: "maybe", note: "Checked in WhatsApp" },
      { revision: "invalid", partId: "text", outcome: "sent", note: "Checked in WhatsApp" },
      { revision: view.revision, partId: "text", outcome: "sent", note: "Checked in WhatsApp", tenantId: randomUUID() },
    ]) { const response = await post(`${route(f)}/reconcile`, input); assert.equal(response.status, 422); }
    const accepted = await post(`${route(f)}/reconcile`, { revision: view.revision, partId: "text", outcome: "not_sent", note: "Checked in WhatsApp" });
    assert.equal(accepted.status, 200); const updated = await accepted.json();
    const invalidRetry = await post(`${route(f)}/retry`, { revision: updated.revision, recipient: "other" }); assert.equal(invalidRetry.status, 422);
    const retried = await post(`${route(f)}/retry`, { revision: updated.revision }); assert.equal(retried.status, 200);
    assert.equal((await retried.json()).retryBlock, "complete"); assert.equal(textCalls, 2); assert.equal(fileCalls, 1);
  });
});
