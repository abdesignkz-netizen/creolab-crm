import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { before, after, beforeEach, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import type { AuthContext } from "./lib/types.ts";
import { encryptSecret } from "./lib/secretBox.ts";
import { ApiError } from "./errors.ts";
import { invalidateRuntimeConfig } from "./services/runtimeSettings.ts";
import { processWhatsAppAiReply, enqueueWhatsAppAi } from "./services/whatsappAiService.ts";
import { deliverChannelMessage } from "./services/channelDeliveryService.ts";
import { deliverQrMessage, deliverCloudMessage } from "./services/whatsappSendService.ts";
import { getMessageDeliveryReview, reconcileMessageDelivery, retryMessageDelivery } from "./services/messageDeliveryReview.ts";
import { aiReplyChannels, aiReplyScope, aiReplyGate, readAiReply, saveAiReply, recoverAiReplyDeliveries, restoreUnstartedAiQrJobs, type AiReplyDelivery } from "./services/aiReplyDeliveryState.ts";
import { getConversationWorkspace, getConversationMessages } from "./services/conversationService.ts";
import { receiveWhatsAppCloud } from "./services/whatsappCloudService.ts";

let db: Awaited<ReturnType<typeof createPrismaClient>>, tenantId: string, owner: AuthContext, manager: AuthContext;
let generated = 0, serial = 0;
const nativeFetch = globalThis.fetch, oldKey = process.env.OPENAI_API_KEY;
const calls: Array<{ to: string; text: string }> = [];
let provider: () => Promise<string | number>;
const good = async () => ++serial;
const fail = async () => { throw new Error("Synthetic lost acknowledgement"); };
const errorCode = (code: string) => (e: unknown) => e instanceof ApiError && e.code === code;
const barrier = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
before(async () => {
  assert.equal(process.env.CRM_USE_PGLITE, "1"); process.env.OPENAI_API_KEY = "synthetic-ai-delivery-test";
  db = await createPrismaClient(); await (await import("../../../packages/db/src/seed.ts")).seedDatabase();
  const member = await db.membership.findFirstOrThrow({ where: { role: "owner", tenant: { slug: "creolab" } }, include: { user: true, tenant: true } }); tenantId = member.tenantId;
  owner = { user: member.user, activeMembership: member, memberships: [member] } as AuthContext;
  const staff = await db.membership.findFirstOrThrow({ where: { role: "manager", tenantId }, include: { user: true, tenant: true } });
  manager = { user: staff.user, activeMembership: staff, memberships: [staff] } as AuthContext;
  globalThis.fetch = async (url, init) => {
    const address = String(url), telegram = address.startsWith("https://api.telegram.org/bot");
    assert.ok(telegram || address.startsWith("https://graph.facebook.com/v25.0/"), "Real external requests forbidden");
    const body = JSON.parse(String(init?.body)); calls.push({ to: body.chat_id || body.to || body.recipient?.id, text: body.text?.body || body.text || body.message?.text });
    const id = await provider(); return new Response(JSON.stringify(telegram ? { ok: true, result: { message_id: id } } : body.messaging_product ? { messages: [{ id: String(id) }] } : { message_id: String(id) }));
  };
});
beforeEach(async () => {
  calls.length = 0; provider = good;
  await db.tenant.update({ where: { id: tenantId }, data: { settingsJson: { aiAutomation: { defaultMode: "AUTO", handoff: { triggers: { CLIENT_REQUESTED_HUMAN: true } } } } } });
  await db.aIConfiguration.updateMany({ where: { tenantId }, data: { enabled: true, promptStatus: "published", systemPrompt: "Отвечай только по услугам компании." } });
  invalidateRuntimeConfig();
});
after(async () => { globalThis.fetch = nativeFetch; if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey; invalidateRuntimeConfig(); await db?.$disconnect(); });

async function fixture(channel: AiReplyDelivery["channel"], handoff = false, whileGenerating?: () => Promise<unknown>) {
  const settings = { phone: "77012345678", appId: "111", wabaId: "222", phoneNumberId: "333", accountId: "444", pageId: "555", apiVersion: "v25.0" };
  const credential = await db.credential.create({ data: { tenantId, scope: "integration", keyVersion: "test", kind: channel === "telegram_bot" ? "telegram_bot" : channel === "instagram_direct" ? "meta" : "whatsapp_cloud",
    encryptedValue: encryptSecret(channel === "telegram_bot" ? "100000:synthetic-bot-token" : JSON.stringify({ accessToken: "synthetic-token", appSecret: "synthetic-app-secret" })) } });
  const integration = await db.integration.create({ data: { tenantId, type: channel, name: "Isolated AI channel", status: "active", connectionStatus: "CONNECTED", schemaJson: settings, credentialId: credential.id } });
  if (channel === "whatsapp_qr") await db.$executeRaw`INSERT INTO "WhatsAppQrSession" ("integrationId") VALUES (${integration.id})`;
  const connection = await db.channelConnection.create({ data: { tenantId, integrationId: integration.id, channelType: channel === "telegram_bot" ? "telegram" : channel === "instagram_direct" ? "instagram" : "whatsapp", status: "active", autoReply: true } });
  const contact = await db.contact.create({ data: { tenantId, name: "Проверка клиента", methods: { create: { type: "phone", rawValue: "77015551234", normalizedValue: "77015551234", source: "test" } } } });
  const conv = await db.conversation.create({ data: { tenantId, contactId: contact.id, connectionId: connection.id, mode: "ai", status: "open", messageRevision: 1, waitingFor: "AI",
    assigneeMembershipId: manager.activeMembership!.id, externalThreadId: channel === "whatsapp_qr" ? "77015551234@s.whatsapp.net" : "77015551234" } });
  const source = await db.message.create({ data: { tenantId, conversationId: conv.id, senderKind: "client", direction: "inbound", text: handoff ? "Хочу поговорить с менеджером" : "Расскажите об услуге" } });
  await db.conversation.update({ where: { id: conv.id }, data: { lastInboundMessageId: source.id } });
  const event = { id: `wa-ai:${conv.id}:${source.id}:${conv.controlVersion}:1`, tenantId, entityId: conv.id, payloadJson: { messageId: source.id, controlVersion: conv.controlVersion, messageRevision: 1 } };
  await processWhatsAppAiReply(db, event, async () => { generated++; await whileGenerating?.(); return { reply: "Сохранённый ответ об услуге", handoff: false }; });
  const message = await db.message.findFirstOrThrow({ where: { tenantId, conversationId: conv.id, senderKind: "ai" } });
  const read = () => db.message.findUniqueOrThrow({ where: { id: message.id } });
  const ledger = async () => (await readAiReply(db, tenantId, message.id))!;
  const view = (auth = owner) => getMessageDeliveryReview(db, auth, conv.id, message.id);
  const socket = { user: { id: "77012345678:1@s.whatsapp.net" }, sendMessage: async (to: string, data: { text: string }) => { calls.push({ to, text: data.text }); return { key: { id: String(await provider()) } }; } } as any;
  const dispatch = async (token?: string) => {
    const queueToken = token || (await ledger()).queueToken;
    if (channel === "whatsapp_qr") return deliverQrMessage(db, integration.id, socket, message.id, async () => {}, queueToken);
    if (channel === "whatsapp_cloud") return deliverCloudMessage(db, tenantId, integration.id, message.id, queueToken);
    return deliverChannelMessage(db, tenantId, message.id, queueToken);
  };
  const unknown = async () => { provider = fail; await assert.rejects(dispatch()); provider = good; assert.equal((await read()).operationState, "unknown"); };
  const review = async (outcome: "sent" | "not_sent", revision?: string, auth = owner) => reconcileMessageDelivery(db, auth, conv.id, message.id,
    { revision: revision || (await view(auth)).revision, partId: "text", outcome, note: "Проверено по независимой переписке клиента" });
  const retry = async (revision?: string, auth = owner) => retryMessageDelivery(db, auth, conv.id, message.id, revision || (await view(auth)).revision);
  const receipt = async (id: string, status: string) => {
    const body = Buffer.from(JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "222", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "333" }, statuses: [{ id, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: "77015551234" }] } }] }] }));
    await receiveWhatsAppCloud(db, integration.id, body, `sha256=${createHmac("sha256", "synthetic-app-secret").update(body).digest("hex")}`);
  };
  return { channel, integration, connection, credential, contact, conv, source, event, message, read, ledger, view, socket, dispatch, unknown, review, retry, receipt };
}
for (const channel of aiReplyChannels) {
  it(`${channel}: saved reply is visible for review and is sent once`, async () => {
    const f = await fixture(channel), before = generated; await f.dispatch(); await f.dispatch();
    assert.equal(calls.length, 1); assert.equal(calls[0].text, f.message.text); assert.equal((await f.read()).operationState, "accepted"); assert.equal(generated, before);
    const view = await f.view(); assert.equal(view.aiReply, true); assert.equal(view.retryBlock, "complete"); assert.ok(view.parts[0].providerMessageId);
    assert.ok(!JSON.stringify(view).includes("synthetic-token"));
    const workspace = await getConversationWorkspace(db, owner, f.conv.id); assert.equal(workspace.messages.find(m => m.id === f.message.id)?.deliveryReviewAvailable, true);
  });
  it(`${channel}: unknown requires evidence and a separate retry with no model call`, async () => {
    const f = await fixture(channel); await f.unknown(); const before = generated, oldToken = (await f.ledger()).queueToken;
    await assert.rejects(f.retry(), errorCode("delivery_retry_blocked"));
    await f.review("not_sent"); assert.equal(calls.length, 1); assert.equal((await f.read()).operationState, "failed");
    const queued = await f.retry(); assert.equal(queued.busy, true); assert.equal(calls.length, 1);
    await f.dispatch(oldToken); assert.equal(calls.length, 1); await f.dispatch(); await f.dispatch();
    assert.equal(calls.length, 2); assert.equal(calls[0].text, calls[1].text); assert.equal(calls[0].to, calls[1].to); assert.equal(generated, before);
    assert.equal((await f.read()).operationState, "accepted");
    assert.equal(await db.auditEvent.count({ where: { tenantId, entityId: f.message.id, action: "message.delivery_reconciled" } }), 1);
    assert.equal(await db.activity.count({ where: { tenantId, contactId: f.contact.id, type: "message.delivery_retry" } }), 1);
  });
  it(`${channel}: manual sent evidence does not fabricate a provider receipt or send`, async () => {
    const f = await fixture(channel); await f.unknown();
    const outbound = { tenantId, type: { in: ["channel.ai_reply", "whatsapp.ai_reply", "channel.send", "whatsapp.cloud_send"] }, entityId: { in: [f.conv.id, f.message.id] } };
    const before = await db.outboxEvent.count({ where: outbound });
    await f.review("sent"); assert.equal(calls.length, 1); assert.equal((await f.read()).receiptState, "reconciled"); assert.equal((await f.read()).providerMessageId, null);
    assert.equal((await f.view()).retryBlock, "complete"); assert.equal(await db.outboxEvent.count({ where: outbound }), before);
  });
  for (const change of ["client", "mode", "prompt", "knowledge", "connection", "disabled", "optout"] as const) it(`${channel}: ${change} change blocks retry of an old answer`, async () => {
    const f = await fixture(channel); await f.unknown(); await f.review("not_sent");
    if (change === "client") await db.conversation.update({ where: { id: f.conv.id }, data: { messageRevision: { increment: 1 } } });
    if (change === "mode") await db.conversation.update({ where: { id: f.conv.id }, data: { mode: "human", controlVersion: { increment: 1 } } });
    if (change === "prompt") await db.aIConfiguration.updateMany({ where: { tenantId }, data: { systemPrompt: "Новая инструкция" } });
    if (change === "knowledge") await db.knowledgeDocument.create({ data: { tenantId, title: "Новый прайс", content: "Изменённые цены", status: "published" } });
    if (change === "connection") await db.integration.update({ where: { id: f.integration.id }, data: { status: "disabled" } });
    if (change === "disabled") await db.channelConnection.update({ where: { id: f.connection.id }, data: { autoReply: false } });
    if (change === "optout") await db.contact.update({ where: { id: f.contact.id }, data: { attributionJson: { doNotContact: true } } });
    assert.equal((await f.view()).canRetry, false); await assert.rejects(f.retry(), errorCode("delivery_retry_blocked")); assert.equal(calls.length, 1);
  });
  it(`${channel}: manager and stale windows cannot reconcile or retry`, async () => {
    const f = await fixture(channel); await f.unknown(); const stale = (await f.view()).revision;
    assert.equal((await f.view(manager)).canReconcile, false); await assert.rejects(f.review("not_sent", undefined, manager), errorCode("forbidden"));
    await f.review("not_sent"); await assert.rejects(f.review("sent", stale), errorCode("delivery_changed")); await assert.rejects(f.retry(stale), errorCode("delivery_changed"));
    assert.equal(calls.length, 1);
  });
  it(`${channel}: expiration and late acknowledgement cannot overwrite reconciliation`, async () => {
    const f = await fixture(channel), entered = barrier(), release = barrier();
    provider = async () => { entered.resolve(); await release.promise; return good(); };
    const pending = f.dispatch().catch(e => e); await Promise.race([entered.promise, pending.then(() => assert.fail("Provider not reached"))]);
    await assert.rejects(f.review("not_sent"), errorCode("delivery_busy"));
    const v = await f.ledger(); v.leaseUntil = Date.now() - 1; await saveAiReply(db, tenantId, v); await recoverAiReplyDeliveries(db);
    await f.review("not_sent"); release.resolve(); assert.ok(await pending instanceof ApiError);
    assert.equal((await f.read()).operationState, "failed"); assert.equal((await f.read()).providerMessageId, null); assert.equal(calls.length, 1);
  });
  it(`${channel}: newer incoming question survives completion of the old send`, async () => {
    const f = await fixture(channel); provider = async () => { await db.conversation.update({ where: { id: f.conv.id }, data: { messageRevision: { increment: 1 }, waitingFor: "MANAGER", needsAttention: true, attentionReason: "new_question" } }); return good(); };
    await f.dispatch(); const conv = await db.conversation.findUniqueOrThrow({ where: { id: f.conv.id } }); assert.equal(conv.waitingFor, "MANAGER"); assert.equal(conv.attentionReason, "new_question");
  });
  it(`${channel}: queued retry rechecks policy immediately before dispatch`, async () => {
    const f = await fixture(channel); await f.unknown(); await f.review("not_sent"); await f.retry();
    await db.aIConfiguration.updateMany({ where: { tenantId }, data: { systemPrompt: "Новые условия продаж" } });
    await f.dispatch(); assert.equal(calls.length, 1); assert.equal((await f.read()).operationState, "canceled");
    assert.equal((await f.view()).retryBlock, "policy_changed");
  });
  it(`${channel}: saved response cannot follow a changed recipient`, async () => {
    const f = await fixture(channel); await f.unknown(); await f.review("not_sent"); await f.retry();
    await db.conversation.update({ where: { id: f.conv.id }, data: { externalThreadId: "77019999999" } });
    await f.dispatch(); assert.equal(calls.length, 1); assert.equal((await f.view()).retryBlock, "conversation_changed");
  });
}
it("uncertain reply blocks re-generation and automatic queueing", async () => {
  const f = await fixture("telegram_bot"); await f.unknown(); const before = generated;
  await processWhatsAppAiReply(db, f.event, async () => { generated++; return { reply: "Не должен генерироваться", handoff: false }; });
  await db.$transaction(tx => enqueueWhatsAppAi(tx, tenantId, f.conv.id)); assert.equal(generated, before);
  assert.equal(await db.outboxEvent.count({ where: { entityId: f.conv.id, type: "channel.ai_reply" } }), 0);
});
it("new incoming question surfaces the unresolved delivery instead of silently stalling", async () => {
  const f = await fixture("telegram_bot"); await f.unknown();
  const incoming = await db.message.create({ data: { tenantId, conversationId: f.conv.id, direction: "inbound", senderKind: "client", text: "Жду ответа" } });
  await db.conversation.update({ where: { id: f.conv.id }, data: { lastInboundMessageId: incoming.id, messageRevision: { increment: 1 }, needsAttention: false, waitingFor: "AI", attentionReason: null } });
  await db.$transaction(tx => enqueueWhatsAppAi(tx, tenantId, f.conv.id, incoming.id));
  const conv = await db.conversation.findUniqueOrThrow({ where: { id: f.conv.id } });
  assert.equal(conv.waitingFor, "MANAGER"); assert.equal(conv.needsAttention, true); assert.equal(conv.attentionReason, "AI_DELIVERY_UNKNOWN");
  assert.equal(await db.outboxEvent.count({ where: { entityId: f.conv.id, type: "channel.ai_reply" } }), 0); assert.equal(calls.length, 1);
});
it("handoff acknowledgement keeps the manager required after a manual check", async () => {
  const f = await fixture("telegram_bot", true); await f.unknown(); await f.review("sent");
  const conv = await db.conversation.findUniqueOrThrow({ where: { id: f.conv.id } }); assert.equal(conv.mode, "human"); assert.equal(conv.waitingFor, "MANAGER"); assert.equal(conv.needsAttention, true);
});
it("QR interrupted queue before intent is restored, but wrong account never sends", async () => {
  const f = await fixture("whatsapp_qr"); await db.$executeRaw`UPDATE "WhatsAppQrJob" SET state = 'sending' WHERE id = ${f.message.id}`;
  await restoreUnstartedAiQrJobs(db, f.integration.id);
  const jobs = await db.$queryRaw<Array<{ state: string }>>`SELECT state FROM "WhatsAppQrJob" WHERE id = ${f.message.id}`; assert.equal(jobs[0].state, "queued");
  f.socket.user.id = "77010000000:1@s.whatsapp.net"; await f.dispatch(); assert.equal(calls.length, 0); assert.equal((await f.read()).operationState, "canceled");
});
it("Cloud signed failure can be retried; receipts for old attempts cannot change a new one", async () => {
  const f = await fixture("whatsapp_cloud"); await f.dispatch(); const old = (await f.read()).providerMessageId!;
  await f.receipt(old, "failed"); assert.equal((await f.read()).operationState, "failed"); assert.equal((await f.view()).canRetry, true);
  await f.retry(); await f.dispatch(); const fresh = (await f.read()).providerMessageId!; assert.notEqual(old, fresh);
  await f.receipt(old, "failed"); assert.equal((await f.read()).operationState, "accepted"); await f.receipt(fresh, "read"); assert.equal((await f.read()).receiptState, "read");
  const conv = await db.conversation.findUniqueOrThrow({ where: { id: f.conv.id } }); assert.equal(conv.needsAttention, false);
});
it("Cloud receipt received before the HTTP acknowledgement is preserved", async () => {
  const f = await fixture("whatsapp_cloud"); provider = async () => { await f.receipt("early", "failed"); return "early"; };
  await f.dispatch(); assert.equal((await f.read()).operationState, "failed"); assert.equal((await f.view()).parts[0].state, "failed");
});
it("Cloud corrected delivery while a retry is queued prevents another send", async () => {
  const f = await fixture("whatsapp_cloud"); await f.dispatch(); const id = (await f.read()).providerMessageId!;
  await f.receipt(id, "failed"); await f.retry(); await f.receipt(id, "delivered"); await f.dispatch();
  assert.equal(calls.length, 1); assert.equal((await f.read()).receiptState, "delivered"); assert.equal((await f.view()).busy, false);
});
it("Cloud and Instagram recheck the reply window before retry", async () => {
  for (const channel of ["whatsapp_cloud", "instagram_direct"] as const) {
    const f = await fixture(channel); await f.unknown(); await f.review("not_sent");
    await db.message.update({ where: { id: f.source.id }, data: { createdAt: new Date(Date.now() - 86_400_001) } });
    assert.equal((await f.view()).retryBlock, "window_closed"); await assert.rejects(f.retry(), errorCode("delivery_retry_blocked"));
  }
});
it("history pagination exposes tracked AI results; older untracked responses do not become retryable", async () => {
  const f = await fixture("telegram_bot"), cursor = await db.message.create({ data: { tenantId, conversationId: f.conv.id, senderKind: "client", direction: "inbound", text: "Позднее", createdAt: new Date(Date.now() + 1000) } });
  const history = await getConversationMessages(db, owner, f.conv.id, cursor.id); assert.equal(history.messages.find(m => m.id === f.message.id)?.deliveryReviewAvailable, true);
  await db.idempotencyRecord.deleteMany({ where: { scope: aiReplyScope, actorKey: tenantId, key: f.message.id } });
  await assert.rejects(f.view(), errorCode("delivery_untracked")); await assert.rejects(f.retry("stale"), errorCode("delivery_untracked"));
});
it("new guard does not permanently lock historical replies without a review snapshot", async () => {
  const f = await fixture("telegram_bot"); await f.unknown();
  await db.idempotencyRecord.deleteMany({ where: { scope: aiReplyScope, actorKey: tenantId, key: f.message.id } });
  assert.equal(await aiReplyGate(db, tenantId, f.conv.id), null);
  await assert.rejects(f.retry("untracked"), errorCode("delivery_untracked")); assert.equal(calls.length, 1);
});
it("a policy update during model generation prevents sending the stale answer", async () => {
  const f = await fixture("telegram_bot", false, () => db.aIConfiguration.updateMany({ where: { tenantId }, data: { systemPrompt: "Новая инструкция после начала генерации" } }));
  await f.dispatch(); assert.equal(calls.length, 0); assert.equal((await f.read()).operationState, "canceled"); assert.equal((await f.view()).retryBlock, "policy_changed");
});
it("review retains the original saved text if the message record changes", async () => {
  const f = await fixture("telegram_bot"); await f.unknown(); await f.review("not_sent");
  await db.message.update({ where: { id: f.message.id }, data: { text: "Изменённый текст" } });
  const view = await f.view(); assert.equal(view.text, f.message.text); assert.equal(view.retryBlock, "conversation_changed");
  await assert.rejects(f.retry(), errorCode("delivery_retry_blocked")); assert.equal(calls.length, 1);
});
it("an operation canceled after claim cannot reach the provider", async () => {
  const f = await fixture("whatsapp_qr"); let guards = 0;
  await deliverQrMessage(db, f.integration.id, f.socket, f.message.id, async () => {
    if (++guards === 2) await db.outboundOperation.updateMany({ where: { tenantId, providerRef: f.message.id }, data: { state: "canceled" } });
  }, (await f.ledger()).queueToken);
  assert.equal(calls.length, 0); assert.equal((await f.read()).operationState, "canceled");
});
it("a queued retry cannot run after the reviewer's access is revoked", async () => {
  const f = await fixture("telegram_bot"); await f.unknown(); await f.review("not_sent"); await f.retry();
  await db.membership.update({ where: { id: owner.activeMembership!.id }, data: { active: false } });
  try { await f.dispatch(); assert.equal(calls.length, 1); assert.equal((await f.read()).operationState, "canceled"); }
  finally { await db.membership.update({ where: { id: owner.activeMembership!.id }, data: { active: true } }); }
});
it("another tenant cannot read, reconcile or retry the AI reply", async () => {
  const f = await fixture("telegram_bot"); await f.unknown();
  const member = await db.membership.findFirstOrThrow({ where: { tenantId: { not: tenantId }, role: "owner" }, include: { user: true, tenant: true } });
  const other = { user: member.user, memberships: [member], activeMembership: member } as AuthContext;
  await assert.rejects(f.view(other), errorCode("not_found"));
  await assert.rejects(f.review("not_sent", "foreign", other), errorCode("not_found"));
  await assert.rejects(f.retry("foreign", other), errorCode("not_found")); assert.equal(calls.length, 1);
});
it("changing the bot credential or Instagram account blocks retry", async () => {
  const tg = await fixture("telegram_bot"); await tg.unknown(); await tg.review("not_sent");
  await db.credential.update({ where: { id: tg.credential.id }, data: { encryptedValue: encryptSecret("100001:another-synthetic-token") } });
  assert.equal((await tg.view()).retryBlock, "connection_changed");
  const ig = await fixture("instagram_direct"); await ig.unknown(); await ig.review("not_sent");
  await db.integration.update({ where: { id: ig.integration.id }, data: { schemaJson: { ...ig.integration.schemaJson as object, accountId: "999" } } });
  assert.equal((await ig.view()).retryBlock, "connection_changed"); assert.equal(calls.length, 2);
});
