import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { after, before, beforeEach, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import type { AuthContext } from "./lib/types.ts";
import { ApiError } from "./errors.ts";
import { encryptSecret, encryptionKeyVersion, decryptSecret } from "./lib/secretBox.ts";
import { resolveUploadPath } from "./lib/storage.ts";
import { createApp } from "./app.ts";
import { sendDirectWhatsApp, deliverQrMessage, deliverCloudMessage } from "./services/whatsappSendService.ts";
import { getMessageDeliveryReview, reconcileMessageDelivery, retryMessageDelivery } from "./services/messageDeliveryReview.ts";
import { readDirectWaDelivery, saveDirectWaDelivery, recoverDirectWaDeliveries, restoreUnstartedDirectWaQrJobs } from "./services/directWhatsAppDeliveryState.ts";
import { receiveWhatsAppCloud } from "./services/whatsappCloudService.ts";
import { recordDirectWaReceipt } from "./services/directWhatsAppReceipts.ts";
import { getConversationWorkspace } from "./services/conversationService.ts";
import { getCampaign, retryFailedCampaign } from "./services/campaignService.ts";
import { processOutbox } from "./services/backgroundJobs.ts";

type Channel = "whatsapp_qr" | "whatsapp_cloud";
type Call = { kind: "text" | "file"; to: string; file?: string };
let db: Awaited<ReturnType<typeof createPrismaClient>>, auth: AuthContext, manager: AuthContext, tid: string;
let server: Server, base = "", cookie = "", serial = 0;
const nativeFetch = globalThis.fetch, sender = "77012345678", target = "77015551234";
const secrets = { accessToken: "synthetic-test-token-not-a-real-credential", appSecret: "synthetic-test-app-secret" };
const calls: Call[] = []; let uploads = 0;
let provider: (call: Call) => Promise<string>, upload: () => Promise<void>;
const ok = async () => `wamid.synthetic-${++serial}`;
const noAck = async () => { throw new Error("Synthetic lost acknowledgement"); };
const code = (value: string) => (err: unknown) => err instanceof ApiError && err.code === value;
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
before(async () => {
  assert.equal(process.env.CRM_USE_PGLITE, "1"); db = await createPrismaClient();
  await (await import("../../../packages/db/src/seed.ts")).seedDatabase();
  const owner = await db.membership.findFirstOrThrow({ where: { role: "owner", tenant: { slug: "creolab" } }, include: { user: true, tenant: true } });
  auth = { user: owner.user, activeMembership: owner, memberships: [owner] } as AuthContext; tid = owner.tenantId;
  const staff = await db.membership.findFirstOrThrow({ where: { role: "manager", tenantId: tid }, include: { user: true, tenant: true } });
  manager = { user: staff.user, activeMembership: staff, memberships: [staff] } as AuthContext;
  globalThis.fetch = async (url, init) => {
    if (base && String(url).startsWith(`${base}/`)) return nativeFetch(url, init);
    assert.ok(String(url).startsWith("https://graph.facebook.com/v25.0/"), "External network is forbidden");
    if (String(url).endsWith("/media")) { uploads++; await upload(); return new Response(JSON.stringify({ id: "synthetic-media" })); }
    assert.ok(String(url).endsWith("/messages"));
    const body = JSON.parse(String(init?.body)), call: Call = { kind: body.type === "text" ? "text" : "file", to: body.to, file: body.document?.filename };
    calls.push(call); return new Response(JSON.stringify({ messages: [{ id: await provider(call) }] }));
  };
  await new Promise<void>((resolve, reject) => { server = createApp(db).listen(0, "127.0.0.1", error => error ? reject(error) : resolve()); server.once("error", reject); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const response = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: auth.user.email, password: process.env.SEED_PASSWORD, client: "web" }) });
  assert.equal(response.status, 200); cookie = response.headers.get("set-cookie") || "";
});
beforeEach(() => { calls.length = 0; uploads = 0; provider = ok; upload = async () => {}; });
after(async () => { globalThis.fetch = nativeFetch; await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); await db?.$disconnect(); });

async function fixture(channel: Channel, options: { text?: boolean; files?: number; actor?: AuthContext; campaign?: boolean } = {}) {
  const actor = options.actor || auth;
  const credential = await db.credential.create({ data: { tenantId: tid, kind: "whatsapp_cloud", scope: "integration", keyVersion: encryptionKeyVersion(), encryptedValue: encryptSecret(JSON.stringify(secrets)) } });
  const settings = { phone: sender, appId: "111", wabaId: "222", phoneNumberId: "333", apiVersion: "v25.0" };
  const integration = await db.integration.create({ data: { tenantId: tid, type: channel, name: "Isolated WhatsApp", status: "active", connectionStatus: "CONNECTED", credentialId: channel === "whatsapp_cloud" ? credential.id : null,
    schemaJson: settings, publicKey: randomUUID() } });
  if (channel === "whatsapp_qr") await db.$executeRaw`INSERT INTO "WhatsAppQrSession" ("integrationId") VALUES (${integration.id})`;
  const connection = await db.channelConnection.create({ data: { tenantId: tid, integrationId: integration.id, channelType: "whatsapp", status: "active", externalRef: sender } });
  const contact = await db.contact.create({ data: { tenantId: tid, name: "Проверяемый клиент", methods: { create: { type: "phone", rawValue: target, normalizedValue: target, source: "test" } } } });
  const conv = await db.conversation.create({ data: { tenantId: tid, contactId: contact.id, connectionId: connection.id, externalThreadId: channel === "whatsapp_qr" ? `${target}@s.whatsapp.net` : target,
    mode: "human", assigneeMembershipId: actor.activeMembership!.id, waitingFor: "MANAGER", needsAttention: true } });
  const inbound = await db.message.create({ data: { tenantId: tid, conversationId: conv.id, direction: "inbound", senderKind: "client", text: "Пришлите материалы" } });
  const payload = { text: options.text === false ? "" : "Материалы по запросу", idempotencyKey: randomUUID(), attachments: Array.from({ length: options.files || 0 }, (_, i) => ({ fileName: `${i}.txt`, mimeType: "text/plain", contentBase64: Buffer.from(`file-${i}`).toString("base64") })) };
  const campaign = options.campaign ? await db.campaign.create({ data: { tenantId: tid, title: "Isolated campaign", status: "running", confirmedAt: new Date(), confirmedById: actor.user.id,
    contentHash: randomUUID(), parsedCommandJson: { whatsappIntegrationId: integration.id }, createdByMembershipId: actor.activeMembership!.id } }) : null;
  const recipient = campaign ? await db.campaignRecipient.create({ data: { tenantId: tid, campaignId: campaign.id, contactId: contact.id, conversationId: conv.id, status: "sending", phoneNormalized: target } }) : null;
  if (recipient) payload.idempotencyKey = `campaign:${campaign!.id}:recipient:${recipient.id}`;
  const socket = { user: { id: `${sender}:1@s.whatsapp.net` }, sendMessage: async (to: string, body: any) => { const call: Call = { kind: body.text ? "text" : "file", to, file: body.fileName }; calls.push(call); return { key: { id: await provider(call) } }; } } as any;
  const read = () => db.message.findFirstOrThrow({ where: { conversationId: conv.id, direction: "outbound", senderKind: "staff" }, include: { attachments: true } });
  const operation = async () => db.outboundOperation.findFirstOrThrow({ where: { conversationId: conv.id, providerRef: (await read()).id } });
  const ledger = async () => (await readDirectWaDelivery(db, tid, (await operation()).id))!;
  const view = async (user = auth) => getMessageDeliveryReview(db, user, conv.id, (await read()).id);
  const send = () => sendDirectWhatsApp(db, actor, conv.id, payload);
  const dispatch = async (token?: string, otherSocket = socket, lease = async () => {}) => channel === "whatsapp_qr"
    ? deliverQrMessage(db, integration.id, otherSocket, (await read()).id, lease, token || (await ledger()).queueToken)
    : deliverCloudMessage(db, tid, integration.id, (await read()).id, token || (await ledger()).queueToken);
  const start = async () => { await send(); if (channel === "whatsapp_qr") await dispatch(); };
  const review = async (partId: string, outcome: "sent" | "not_sent", revision?: string, user = auth) => reconcileMessageDelivery(db, user, conv.id, (await read()).id,
    { revision: revision || (await view()).revision, partId, outcome, note: "Проверено в независимом журнале в тестовом сценарии" });
  const retry = async (revision?: string, user = auth) => retryMessageDelivery(db, user, conv.id, (await read()).id, revision || (await view()).revision);
  const finishRetry = async () => { await retry(); if (channel === "whatsapp_qr") await dispatch(); };
  const unknown = async () => { provider = noAck; await assert.rejects(start(), code("whatsapp_send_unknown")); provider = ok; };
  const receipt = async (providerId: string, status: "sent" | "failed" | "delivered" | "read") => {
    const body = Buffer.from(JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: settings.wabaId, changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: settings.phoneNumberId }, statuses: [{ id: providerId, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: target }] } }] }] }));
    return receiveWhatsAppCloud(db, integration.id, body, `sha256=${createHmac("sha256", secrets.appSecret).update(body).digest("hex")}`);
  };
  return { channel, conv, contact, connection, integration, credential, inbound, settings, socket, payload, campaign, recipient, read, operation, ledger, view, send, dispatch, start, review, retry, finishRetry, unknown, receipt };
}

for (const channel of ["whatsapp_qr", "whatsapp_cloud"] as const) {
  it(`${channel}: exact recipient and separate text/file acknowledgement without secrets`, async () => {
    const f = await fixture(channel, { files: 2 }); await f.start(); const view = await f.view();
    assert.equal(view.channel, channel); assert.equal(view.parts.length, 3); assert.equal(view.retryBlock, "complete");
    assert.ok(view.parts.every(p => p.state === "accepted" && p.providerMessageId)); assert.match(view.recipient, /Проверяемый клиент/);
    assert.ok(!JSON.stringify(view).includes(secrets.accessToken)); assert.ok(!JSON.stringify(view).includes(f.credential.id));
    assert.equal((await getConversationWorkspace(db, auth, f.conv.id)).messages.find(m => m.id === view.messageId)?.deliveryReviewAvailable, true);
    assert.equal(calls.length, 3); assert.ok(calls.every(c => c.to === f.conv.externalThreadId));
  });
  it(`${channel}: repeated POST and worker replay cannot send twice`, async () => {
    const f = await fixture(channel); await f.start(); const message = await f.read(); await f.send(); await f.dispatch();
    assert.equal(calls.length, 1); assert.equal((await f.read()).id, message.id);
    await assert.rejects(sendDirectWhatsApp(db, auth, f.conv.id, { ...f.payload, text: "Changed" }), code("idempotency_conflict"));
  });
  it(`${channel}: unknown delivery requires evidence then a separate explicit retry`, async () => {
    const f = await fixture(channel); await f.unknown(); const token = (await f.ledger()).queueToken;
    assert.equal((await f.view()).retryBlock, "unknown"); await assert.rejects(f.retry(), code("delivery_retry_blocked"));
    await f.send(); await f.dispatch(); assert.equal(calls.length, 1);
    assert.equal((await f.review("text", "not_sent")).canRetry, true); assert.equal(calls.length, 1);
    await f.finishRetry(); await f.dispatch(token); assert.equal(calls.length, 2); assert.equal((await f.view()).retryBlock, "complete");
    assert.equal(await db.auditEvent.count({ where: { tenantId: tid, entityId: (await f.read()).id, action: "message.delivery_retry" } }), 1);
    assert.equal(await db.activity.count({ where: { tenantId: tid, contactId: f.contact.id, type: "message.delivery_retry" } }), 1);
  });
  it(`${channel}: partial retry skips confirmed text and only resends absent files`, async () => {
    const f = await fixture(channel, { files: 2 }); provider = async c => c.kind === "file" ? noAck() : ok();
    await assert.rejects(f.start(), code("whatsapp_send_unknown")); provider = ok;
    const view = await f.view(); assert.equal(view.parts[0].state, "accepted"); assert.equal(view.parts[2].state, "pending");
    await f.review(view.parts[1].id, "not_sent"); await f.finishRetry();
    assert.deepEqual(calls.map(c => c.kind), ["text", "file", "file", "file"]); assert.equal((await f.view()).retryBlock, "complete");
  });
  it(`${channel}: manual sent evidence is not a provider receipt and never sends`, async () => {
    const f = await fixture(channel); await f.unknown(); const view = await f.review("text", "sent");
    assert.equal(view.parts[0].providerMessageId, null); assert.ok(view.parts[0].checkedBy); assert.equal((await f.read()).receiptState, "reconciled");
    await assert.rejects(f.retry(), code("delivery_retry_blocked")); assert.equal(calls.length, 1);
    assert.equal(await db.activity.count({ where: { tenantId: tid, contactId: f.contact.id, type: "message.delivery_reconciled" } }), 1);
  });
  it(`${channel}: stale screens and managers cannot change reconciliation`, async () => {
    const f = await fixture(channel, { actor: manager }); await f.unknown(); const old = (await f.view()).revision;
    assert.equal((await f.view(manager)).canReconcile, false); await assert.rejects(f.review("text", "not_sent", old, manager), code("forbidden"));
    await f.review("text", "not_sent"); await assert.rejects(f.review("text", "sent", old), code("delivery_changed"));
    await assert.rejects(f.retry(old), code("delivery_changed")); assert.equal(calls.length, 1);
  });
  for (const change of ["recipient", "mode", "connection", "actor"] as const) it(`${channel}: rechecks ${change} before retry`, async () => {
    const f = await fixture(channel, { actor: change === "actor" ? manager : auth }); await f.unknown(); await f.review("text", "not_sent");
    if (change === "recipient") await db.conversation.update({ where: { id: f.conv.id }, data: { externalThreadId: "77019999999" } });
    if (change === "mode") await db.conversation.update({ where: { id: f.conv.id }, data: { mode: "ai", controlVersion: { increment: 1 } } });
    if (change === "connection") await db.integration.update({ where: { id: f.integration.id }, data: { publicKey: randomUUID() } });
    if (change === "actor") await db.membership.update({ where: { id: manager.activeMembership!.id }, data: { active: false } });
    try { assert.equal((await f.view()).canRetry, false); await assert.rejects(f.retry(), code("delivery_retry_blocked")); assert.equal(calls.length, 1); }
    finally { if (change === "actor") await db.membership.update({ where: { id: manager.activeMembership!.id }, data: { active: true } }); }
  });
  it(`${channel}: tampered file cannot reach provider`, async () => {
    const f = await fixture(channel, { text: false, files: 1 }); await f.unknown(); const file = (await f.read()).attachments[0];
    await f.review(file.id, "not_sent"); await writeFile(resolveUploadPath(file.storageKey), "changed contents");
    await assert.rejects(f.finishRetry(), code("attachment_changed")); assert.equal(calls.length, 1);
    assert.ok(!(await f.view()).busy); assert.equal((await f.view()).parts[0].state, "failed");
  });
  it(`${channel}: recovery fences an old acknowledgement while a new retry is running`, async () => {
    const f = await fixture(channel), firstStarted = gate(), firstRelease = gate(), nextStarted = gate(), nextRelease = gate();
    let n = 0; provider = async () => { if (++n === 1) { firstStarted.resolve(); await firstRelease.promise; return "old-ack"; } nextStarted.resolve(); await nextRelease.promise; return "new-ack"; };
    const first = f.start().catch(error => error);
    await Promise.race([firstStarted.promise, first.then(error => { throw error || new Error("Expected dispatch to start"); })]);
    const op = await f.operation(), value = await f.ledger(); value.leaseUntil = Date.now() - 1; await saveDirectWaDelivery(db, tid, op.id, value);
    await recoverDirectWaDeliveries(db); assert.equal((await f.view()).parts[0].state, "unknown");
    await f.review("text", "not_sent"); const retry = f.finishRetry(); await nextStarted.promise;
    firstRelease.resolve(); assert.ok(await first instanceof ApiError); assert.equal((await f.read()).operationState, "sending");
    assert.equal((await f.view()).parts[0].providerMessageId, null); nextRelease.resolve(); await retry;
    assert.equal((await f.view()).parts[0].providerMessageId, "new-ack"); assert.equal(calls.length, 2);
  });
  it(`${channel}: a newer incoming message remains waiting for an employee`, async () => {
    const f = await fixture(channel); provider = async () => { await db.message.create({ data: { tenantId: tid, conversationId: f.conv.id, direction: "inbound", senderKind: "client", text: "Новый вопрос" } });
      await db.conversation.update({ where: { id: f.conv.id }, data: { messageRevision: { increment: 1 }, waitingFor: "MANAGER", needsAttention: true } }); return ok(); };
    await f.start(); const conv = await db.conversation.findUniqueOrThrow({ where: { id: f.conv.id } }); assert.equal(conv.waitingFor, "MANAGER"); assert.equal(conv.needsAttention, true);
  });
}

it("QR: queued retry owns a distinct durable job and old jobs cannot dispatch it", async () => {
  const f = await fixture("whatsapp_qr"); await f.unknown(); const token = (await f.ledger()).queueToken; await f.review("text", "not_sent");
  const result = await f.retry(); assert.equal(result.busy, true); assert.equal(result.canRetry, false);
  const jobs = await db.$queryRaw<Array<{ id: string; encryptedPayload: string }>>`SELECT id, "encryptedPayload" FROM "WhatsAppQrJob" WHERE "integrationId" = ${f.integration.id}`;
  assert.equal(jobs.length, 2); assert.notEqual(jobs[0].id, jobs[1].id); assert.ok(jobs.every(j => JSON.parse(decryptSecret(j.encryptedPayload)).deliveryToken));
  await f.dispatch(token); assert.equal(calls.length, 1); await f.dispatch(); assert.equal(calls.length, 2);
});
it("QR: account mismatch and lost session lease prevent sends", async () => {
  const f = await fixture("whatsapp_qr"); await f.send(); await f.dispatch(undefined, { ...f.socket, user: { id: "77010000000@s.whatsapp.net" } });
  assert.equal(calls.length, 0); assert.equal((await f.read()).operationState, "canceled");
  await f.retry(); await assert.rejects(f.dispatch(undefined, f.socket, async () => { throw new Error("Lost QR lease"); }));
  assert.equal(calls.length, 0); assert.equal((await f.view()).busy, false);
});
it("Cloud: text receipt cannot mark a file delivered; failed file alone is retryable", async () => {
  const f = await fixture("whatsapp_cloud", { files: 1 }); await f.start(); const parts = (await f.view()).parts;
  await f.receipt(parts[0].providerMessageId!, "read"); assert.equal((await f.read()).receiptState, "sent");
  await f.receipt(parts[1].providerMessageId!, "failed"); const failed = await f.view();
  assert.equal(failed.parts[0].state, "accepted"); assert.equal(failed.parts[1].state, "failed"); assert.equal(failed.canRetry, true);
  assert.equal((await f.read()).operationState, "partial"); assert.equal((await db.conversation.findUniqueOrThrow({ where: { id: f.conv.id } })).controlVersion, f.conv.controlVersion);
  assert.equal((await db.conversation.findUniqueOrThrow({ where: { id: f.conv.id } })).attentionReason, "outbound_delivery_failed");
  await f.finishRetry(); assert.deepEqual(calls.map(c => c.kind), ["text", "file", "file"]);
  const resumed = await db.conversation.findUniqueOrThrow({ where: { id: f.conv.id } }); assert.equal(resumed.needsAttention, false); assert.equal(resumed.waitingFor, "CLIENT");
  const fresh = (await f.view()).parts[1].providerMessageId!;
  await f.receipt(parts[1].providerMessageId!, "failed"); assert.equal((await f.view()).parts[1].providerMessageId, fresh); assert.equal((await f.read()).operationState, "accepted");
  await f.receipt(fresh, "read"); assert.equal((await f.read()).receiptState, "read");
  await f.receipt(fresh, "failed"); await f.receipt(fresh, "sent"); assert.equal((await f.read()).receiptState, "read");
});
it("Cloud: a signed receipt arriving before HTTP acknowledgement is not lost", async () => {
  const f = await fixture("whatsapp_cloud"); provider = async () => { await f.receipt("early-ack", "failed"); return "early-ack"; };
  await f.start(); assert.equal((await f.view()).parts[0].state, "failed"); assert.equal((await f.view()).canRetry, true);
});
it("Cloud: receipts are isolated by tenant and integration", async () => {
  const f = await fixture("whatsapp_cloud"); await f.start(); const id = (await f.view()).parts[0].providerMessageId!;
  await recordDirectWaReceipt(db, tid, randomUUID(), id, "failed"); assert.equal((await f.read()).operationState, "accepted");
  await assert.rejects(receiveWhatsAppCloud(db, f.integration.id, Buffer.from("{}"), "sha256=" + "0".repeat(64)), code("invalid_signature"));
});
it("Cloud: reply window is checked again on retry and after media upload", async () => {
  const f = await fixture("whatsapp_cloud"); await f.unknown(); await f.review("text", "not_sent");
  await db.message.update({ where: { id: f.inbound.id }, data: { createdAt: new Date(Date.now() - 86_400_001) } });
  assert.equal((await f.view()).retryBlock, "window_closed"); await assert.rejects(f.retry(), code("whatsapp_window_closed")); assert.equal(calls.length, 1);
  const second = await fixture("whatsapp_cloud", { text: false, files: 1 }); upload = async () => { await db.message.update({ where: { id: second.inbound.id }, data: { createdAt: new Date(Date.now() - 86_400_001) } }); };
  await second.start(); assert.equal(calls.length, 1); assert.equal((await second.view()).parts[0].state, "pending"); assert.equal((await second.read()).operationState, "canceled");
});
it("Cloud: failed media upload is known unsent and retry does not require invented evidence", async () => {
  const f = await fixture("whatsapp_cloud", { text: false, files: 1 }); upload = async () => { throw new Error("Synthetic upload failure"); };
  await assert.rejects(f.start()); assert.equal(calls.length, 0); assert.equal((await f.view()).parts[0].state, "pending"); assert.equal((await f.view()).canRetry, true);
  upload = async () => {}; await f.finishRetry(); assert.equal(calls.length, 1);
});
it("Cloud: credential replacement between upload and send prevents dispatch", async () => {
  const f = await fixture("whatsapp_cloud", { text: false, files: 1 }); upload = async () => { await db.credential.update({ where: { id: f.credential.id }, data: { encryptedValue: encryptSecret(JSON.stringify({ ...secrets, accessToken: "changed" })) } }); };
  await f.start(); assert.equal(calls.length, 0); assert.equal((await f.view()).retryBlock, "connection_changed");
});
it("HTTP: review has private caching, strict validation and authentication", async () => {
  const f = await fixture("whatsapp_qr"); await f.unknown(); const url = `${base}/api/v1/conversations/${f.conv.id}/messages/${(await f.read()).id}/delivery`;
  const response = await fetch(url, { headers: { cookie } }); assert.equal(response.status, 200); assert.match(response.headers.get("cache-control") || "", /no-store/);
  assert.equal((await fetch(url)).status, 401);
  const malformed = await fetch(`${url}/reconcile`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ revision: (await f.view()).revision, partId: "text", outcome: "not_sent", note: "short" }) });
  assert.equal(malformed.status, 422); assert.equal(calls.length, 1);
});

for (const channel of ["whatsapp_qr", "whatsapp_cloud"] as const) {
  it(`${channel}: selective campaign retry keeps accepted parts, recipient links and campaign history`, async () => {
    const f = await fixture(channel, { files: 1, campaign: true }); provider = async c => c.kind === "file" ? noAck() : ok();
    await assert.rejects(f.start(), code("whatsapp_send_unknown")); provider = ok;
    await db.campaign.update({ where: { id: f.campaign!.id }, data: { status: "failed" } });
    const other = await db.campaignRecipient.create({ data: { tenantId: tid, campaignId: f.campaign!.id, status: "sent", providerMessageId: "already-sent-to-another-client" } });
    const history = await getCampaign(db, auth, f.campaign!.id), row = history.recipients.find(r => r.id === f.recipient!.id)!;
    assert.equal(row.deliveryMessageId, (await f.read()).id); assert.equal(row.deliveryConversationId, f.conv.id);
    const file = (await f.view()).parts[1]; await f.review(file.id, "not_sent");
    await assert.rejects(retryFailedCampaign(db, auth, f.campaign!.id), code("nothing_to_retry")); assert.equal(calls.length, 2);
    await f.finishRetry(); assert.deepEqual(calls.map(c => c.kind), ["text", "file", "file"]);
    const finished = await getCampaign(db, auth, f.campaign!.id);
    assert.equal(finished.status, "completed"); assert.equal(finished.recipients.find(r => r.id === f.recipient!.id)?.status, "sent");
    assert.equal(finished.recipients.find(r => r.id === other.id)?.providerMessageId, "already-sent-to-another-client");
  });
  for (const stopped of ["paused", "cancelled", "changed", "recipient"] as const) it(`${channel}: ${stopped} campaign cannot be restarted by retry`, async () => {
    const f = await fixture(channel, { campaign: true }); await f.unknown(); await f.review("text", "not_sent");
    if (stopped === "recipient") await db.campaignRecipient.update({ where: { id: f.recipient!.id }, data: { phoneNormalized: "77010000000" } });
    else await db.campaign.update({ where: { id: f.campaign!.id }, data: stopped === "changed" ? { contentHash: randomUUID() } : { status: stopped } });
    assert.equal((await f.view()).retryBlock, ["changed", "recipient"].includes(stopped) ? "campaign_changed" : "campaign_stopped");
    await assert.rejects(f.retry(), code("delivery_retry_blocked")); assert.equal(calls.length, 1);
  });
  it(`${channel}: wrong conversation and tenant cannot read or reconcile a message`, async () => {
    const f = await fixture(channel); await f.unknown(); const second = await fixture(channel);
    await assert.rejects(getMessageDeliveryReview(db, auth, second.conv.id, (await f.read()).id), code("not_found"));
    const foreign = await db.membership.findFirstOrThrow({ where: { role: "owner", tenantId: { not: tid } }, include: { user: true, tenant: true } });
    const otherAuth = { user: foreign.user, activeMembership: foreign, memberships: [foreign] } as AuthContext;
    await assert.rejects(f.view(otherAuth), err => err instanceof ApiError && [403, 404].includes(err.status));
    await assert.rejects(f.review("text", "not_sent", undefined, otherAuth), err => err instanceof ApiError && [403, 404].includes(err.status));
    assert.equal(calls.length, 1);
  });
  it(`${channel}: a queued message is cancelled when its conversation changes connection`, async () => {
    const f = await fixture(channel);
    const changedDb = new Proxy(db, { get(target, prop) {
      if (prop === "$transaction") return async (fn: any, options: any) => {
        const result = await target.$transaction(fn, options);
        if (result?.delivery?.messageId) await target.conversation.update({ where: { id: f.conv.id }, data: { connectionId: null } });
        return result;
      };
      const member = Reflect.get(target, prop); return typeof member === "function" ? member.bind(target) : member;
    } });
    await sendDirectWhatsApp(changedDb, auth, f.conv.id, f.payload);
    if (channel === "whatsapp_qr") {
      const message = await f.read();
      await db.$executeRaw`UPDATE "WhatsAppQrJob" SET state = 'sending' WHERE id = ${message.id}`;
      await restoreUnstartedDirectWaQrJobs(db, f.integration.id); await f.dispatch();
    }
    assert.equal(calls.length, 0); assert.equal((await f.read()).operationState, "canceled");
    assert.equal((await f.view()).busy, false); assert.equal((await f.view()).retryBlock, "conversation_changed");
  });
}
it("QR: rights and control are rechecked after retry is queued", async () => {
  const f = await fixture("whatsapp_qr", { actor: manager }); await f.unknown(); await f.review("text", "not_sent"); await f.retry();
  await db.conversation.update({ where: { id: f.conv.id }, data: { assigneeMembershipId: auth.activeMembership!.id } });
  await f.dispatch(); assert.equal(calls.length, 1); assert.equal((await f.view()).retryBlock, "access_changed"); assert.equal((await f.view()).busy, false);
});
it("QR: concurrent workers claim only one attempt", async () => {
  const f = await fixture("whatsapp_qr"); await f.send(); await Promise.all([f.dispatch(), f.dispatch(), f.dispatch()]); assert.equal(calls.length, 1);
});
it("Cloud: original outbox replay cannot dispatch an explicit new retry", async () => {
  const f = await fixture("whatsapp_cloud"); await f.unknown(); const old = (await f.ledger()).queueToken; await f.review("text", "not_sent");
  const entered = gate(), release = gate(); provider = async () => { entered.resolve(); await release.promise; return ok(); };
  const pending = f.retry(); await entered.promise; await f.dispatch(old); assert.equal(calls.length, 2); release.resolve(); await pending;
  assert.equal(await db.outboxEvent.count({ where: { tenantId: tid, entityId: (await f.read()).id, type: "whatsapp.cloud_send" } }), 2);
});
it("Cloud: old failure cannot undo a later successful response", async () => {
  const f = await fixture("whatsapp_cloud"); await f.start(); const old = (await f.view()).parts[0].providerMessageId!;
  await sendDirectWhatsApp(db, auth, f.conv.id, { text: "Более поздний ответ", idempotencyKey: randomUUID() });
  await f.receipt(old, "failed"); const conv = await db.conversation.findUniqueOrThrow({ where: { id: f.conv.id } });
  assert.equal(conv.waitingFor, "CLIENT"); assert.equal(conv.needsAttention, false);
});
it("Cloud: recovery of delivery does not clear a newer client's request", async () => {
  const f = await fixture("whatsapp_cloud"); await f.start(); const id = (await f.view()).parts[0].providerMessageId!;
  await f.receipt(id, "failed");
  await db.message.create({ data: { tenantId: tid, conversationId: f.conv.id, direction: "inbound", senderKind: "client", text: "Ещё один вопрос" } });
  await db.conversation.update({ where: { id: f.conv.id }, data: { messageRevision: { increment: 1 }, needsAttention: true, waitingFor: "MANAGER", attentionReason: "new_client_request" } });
  await f.finishRetry();
  const conv = await db.conversation.findUniqueOrThrow({ where: { id: f.conv.id } });
  assert.equal(conv.needsAttention, true); assert.equal(conv.waitingFor, "MANAGER"); assert.equal(conv.attentionReason, "new_client_request");
});
it("Cloud: a corrected receipt clears only its own delivery warning", async () => {
  const f = await fixture("whatsapp_cloud"); await f.start(); const id = (await f.view()).parts[0].providerMessageId!;
  await f.receipt(id, "failed"); assert.equal((await db.conversation.findUniqueOrThrow({ where: { id: f.conv.id } })).needsAttention, true);
  await f.receipt(id, "delivered");
  const conv = await db.conversation.findUniqueOrThrow({ where: { id: f.conv.id } });
  assert.equal(conv.needsAttention, false); assert.equal(conv.waitingFor, "CLIENT"); assert.equal((await f.read()).receiptState, "delivered");
  assert.equal(calls.length, 1);
});
it("Cloud: a provider receipt still updates the original message after connection changes", async () => {
  const f = await fixture("whatsapp_cloud"); await f.start(); const id = (await f.view()).parts[0].providerMessageId!;
  await db.conversation.update({ where: { id: f.conv.id }, data: { connectionId: null, controlVersion: { increment: 1 } } });
  await f.receipt(id, "failed"); assert.equal((await f.view()).parts[0].state, "failed"); assert.equal((await f.view()).retryBlock, "conversation_changed");
  const conv = await db.conversation.findUniqueOrThrow({ where: { id: f.conv.id } }); assert.equal(conv.needsAttention, false);
});
it("QR: interrupted queue claim is restored only if no provider intent has started", async () => {
  const f = await fixture("whatsapp_qr"); await f.send(); const message = await f.read();
  await db.$executeRaw`UPDATE "WhatsAppQrJob" SET state = 'sending' WHERE id = ${message.id}`;
  await restoreUnstartedDirectWaQrJobs(db, f.integration.id);
  const jobs = await db.$queryRaw<Array<{ state: string }>>`SELECT state FROM "WhatsAppQrJob" WHERE id = ${message.id}`;
  assert.equal(jobs[0].state, "queued"); assert.equal(calls.length, 0); await f.dispatch(); assert.equal(calls.length, 1);
});
it("recovery also fences a lease whose operation was cancelled during a provider call", async () => {
  const f = await fixture("whatsapp_cloud"), entered = gate(), release = gate();
  provider = async () => { entered.resolve(); await release.promise; return "late-after-handoff"; };
  const pending = f.start().catch(error => error); await entered.promise;
  const op = await f.operation(), value = await f.ledger(); value.leaseUntil = Date.now() - 1;
  await saveDirectWaDelivery(db, tid, op.id, value); await db.outboundOperation.update({ where: { id: op.id }, data: { state: "canceled" } });
  await db.conversation.update({ where: { id: f.conv.id }, data: { mode: "ai", controlVersion: { increment: 1 } } });
  await recoverDirectWaDeliveries(db); assert.equal((await f.read()).operationState, "unknown"); assert.equal((await f.view()).busy, false);
  release.resolve(); assert.ok(await pending instanceof ApiError); assert.equal((await f.view()).parts[0].providerMessageId, null);
});
it("Cloud: paused outbox work remains durable and resumes the same explicit retry", async () => {
  const f = await fixture("whatsapp_cloud", { campaign: true }); await f.unknown(); await f.review("text", "not_sent");
  // Pause after committing the retry queue but before its immediate dispatch.
  const pausedDb = new Proxy(db, { get(target, prop) {
    if (prop === "$transaction") return async (fn: any, options: any) => {
      const result = await target.$transaction(fn, options);
      if (result && typeof result === "object" && "generation" in result && result.generation === 1 && "queued" in result && result.queued) {
        await target.campaign.update({ where: { id: f.campaign!.id }, data: { status: "paused" } });
      }
      return result;
    };
    const member = Reflect.get(target, prop); return typeof member === "function" ? member.bind(target) : member;
  } });
  await retryMessageDelivery(pausedDb, auth, f.conv.id, (await f.read()).id, (await f.view()).revision);
  const value = await f.ledger(); assert.equal(value.queued, true); assert.equal(calls.length, 1);
  // Only this synthetic queued event is due; no other test's outbox participates.
  await db.outboxEvent.updateMany({ where: { type: "whatsapp.cloud_send" }, data: { availableAt: new Date(Date.now() + 86_400_000) } });
  const event = await db.outboxEvent.findFirstOrThrow({ where: { type: "whatsapp.cloud_send", entityId: value.messageId, payloadJson: { path: ["deliveryToken"], equals: value.queueToken } } });
  await db.outboxEvent.update({ where: { id: event.id }, data: { availableAt: new Date(0), processedAt: null } });
  const before = calls.length; await processOutbox(db, { lane: "delivery" });
  const deferred = await db.outboxEvent.findUniqueOrThrow({ where: { id: event.id } }); assert.equal(deferred.processedAt, null); assert.ok(deferred.availableAt.getTime() > Date.now());
  assert.equal(calls.length, before); await db.campaign.update({ where: { id: f.campaign!.id }, data: { status: "running" } });
  await db.outboxEvent.update({ where: { id: event.id }, data: { availableAt: new Date(0) } }); provider = ok; await processOutbox(db, { lane: "delivery" });
  assert.equal(calls.length, before + 1); assert.equal((await f.read()).operationState, "accepted");
});
