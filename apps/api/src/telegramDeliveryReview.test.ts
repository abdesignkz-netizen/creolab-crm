import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { after, before, beforeEach, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import type { AuthContext } from "./lib/types.ts";
import { ApiError } from "./errors.ts";
import { encryptSecret, encryptionKeyVersion } from "./lib/secretBox.ts";
import { resolveUploadPath } from "./lib/storage.ts";
import { createApp } from "./app.ts";
import { sendCompanyTelegram } from "./services/telegramCompanyService.ts";
import { getMessageDeliveryReview, reconcileMessageDelivery, retryMessageDelivery } from "./services/messageDeliveryReview.ts";
import { readTelegramDelivery, saveTelegramDelivery } from "./services/telegramManualState.ts";
import { recoverTelegramDeliveries } from "./services/telegramDeliveryState.ts";
import { getConversationWorkspace } from "./services/conversationService.ts";

let db: Awaited<ReturnType<typeof createPrismaClient>>, auth: AuthContext, manager: AuthContext, tid: string;
let server: Server, base = "", cookie = "";
const nativeFetch = globalThis.fetch, token = "123456789:synthetic-only-never-a-real-bot-key";
const calls: Array<{ method: string; chat: string; text?: string; file?: string }> = [];
let provider: (method: string) => Promise<Response>;
const ok = async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1000 + calls.length } }));
const code = (value: string) => (err: unknown) => err instanceof ApiError && err.code === value;
const noAck = async () => { throw new Error("Synthetic lost acknowledgement"); };
before(async () => {
  assert.equal(process.env.CRM_USE_PGLITE, "1"); db = await createPrismaClient();
  await (await import("../../../packages/db/src/seed.ts")).seedDatabase();
  const owner = await db.membership.findFirstOrThrow({ where: { role: "owner", tenant: { slug: "creolab" } }, include: { user: true, tenant: true } });
  auth = { user: owner.user, activeMembership: owner, memberships: [owner] } as AuthContext; tid = owner.tenantId;
  const staff = await db.membership.findFirstOrThrow({ where: { role: "manager", tenantId: tid }, include: { user: true, tenant: true } });
  manager = { user: staff.user, activeMembership: staff, memberships: [staff] } as AuthContext;
  globalThis.fetch = async (url, init) => {
    if (base && String(url).startsWith(`${base}/`)) return nativeFetch(url, init);
    assert.ok(String(url).startsWith(`https://api.telegram.org/bot${token}/`), "External network is forbidden");
    const method = String(url).split("/").at(-1)!;
    assert.ok(["sendMessage", "sendDocument"].includes(method));
    if (init?.body instanceof FormData) calls.push({ method, chat: String(init.body.get("chat_id")), file: (init.body.get("document") as File).name });
    else { const body = JSON.parse(String(init?.body)); calls.push({ method, chat: String(body.chat_id), text: body.text }); }
    return provider(method);
  };
  await new Promise<void>((resolve, reject) => { server = createApp(db).listen(0, "127.0.0.1", error => error ? reject(error) : resolve()); server.once("error", reject); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const response = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: auth.user.email, password: process.env.SEED_PASSWORD, client: "web" }) });
  assert.equal(response.status, 200); cookie = response.headers.get("set-cookie") || "";
});
beforeEach(() => { calls.length = 0; provider = ok; });
after(async () => { globalThis.fetch = nativeFetch; await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); await db?.$disconnect(); });

async function fixture(options: { text?: boolean; files?: number; actor?: AuthContext } = {}) {
  const actor = options.actor || auth;
  const credential = await db.credential.create({ data: { tenantId: tid, kind: "telegram_bot", scope: "integration", keyVersion: encryptionKeyVersion(), encryptedValue: encryptSecret(token) } });
  const integration = await db.integration.create({ data: { tenantId: tid, type: "telegram_bot", name: "Isolated bot", status: "active", credentialId: credential.id, publicKey: randomUUID() } });
  const connection = await db.channelConnection.create({ data: { tenantId: tid, integrationId: integration.id, channelType: "telegram", status: "active", externalRef: "123456789" } });
  const contact = await db.contact.create({ data: { tenantId: tid, name: "Клиент Telegram" } });
  const conv = await db.conversation.create({ data: { tenantId: tid, contactId: contact.id, connectionId: connection.id, externalThreadId: "555123", mode: "human",
    assigneeMembershipId: actor.activeMembership!.id, waitingFor: "MANAGER", needsAttention: true } });
  const payload = { text: options.text === false ? "" : "Материалы по запросу", idempotencyKey: randomUUID(),
    attachments: Array.from({ length: options.files || 0 }, (_, i) => ({ fileName: `${i}.pdf`, mimeType: "application/pdf", contentBase64: "dGVzdA==" })) };
  const read = () => db.message.findFirstOrThrow({ where: { conversationId: conv.id, direction: "outbound", senderKind: "staff" }, include: { attachments: true } });
  const view = async (user = auth) => getMessageDeliveryReview(db, user, conv.id, (await read()).id);
  const review = async (partId: string, outcome: "sent" | "not_sent", revision?: string, user = auth) => reconcileMessageDelivery(db, user, conv.id, (await read()).id,
    { revision: revision || (await view()).revision, partId, outcome, note: "Проверено с получателем в тестовом сценарии" });
  const retry = async (revision?: string, user = auth, client = db) => retryMessageDelivery(client, user, conv.id, (await read()).id, revision || (await view()).revision);
  const operation = async () => db.outboundOperation.findFirstOrThrow({ where: { conversationId: conv.id, providerRef: (await read()).id } });
  return { conv, contact, connection, integration, credential, payload, read, view, review, retry, operation,
    send: () => sendCompanyTelegram(db, actor, conv.id, payload),
    unknown: async () => { provider = noAck; await assert.rejects(sendCompanyTelegram(db, actor, conv.id, payload), code("telegram_unavailable")); provider = ok; } };
}

it("returns channel, exact recipient and separate text/file evidence, without secrets", async () => {
  const f = await fixture({ files: 2 }); await f.send(); const view = await f.view();
  assert.equal(view.channel, "telegram"); assert.equal(view.parts.length, 3); assert.equal(view.retryBlock, "complete");
  assert.ok(view.parts.every(p => p.state === "accepted" && p.providerMessageId)); assert.match(view.recipient, /Клиент Telegram.*555123/);
  assert.ok(!JSON.stringify(view).includes(token)); assert.ok(!JSON.stringify(view).includes(f.credential.id));
  const workspace = await getConversationWorkspace(db, auth, f.conv.id);
  assert.equal(workspace.messages.find(m => m.id === view.messageId)?.deliveryReviewAvailable, true);
});
it("repeated send requests preserve the same message without another provider call", async () => {
  const f = await fixture(); const first = await f.send(), second = await f.send();
  assert.equal(first.id, second.id); assert.equal(calls.length, 1);
  await assert.rejects(sendCompanyTelegram(db, auth, f.conv.id, { ...f.payload, text: "Changed" }), code("idempotency_conflict"));
});
it("unknown delivery is held until an explicit check, and review does not send", async () => {
  const f = await fixture(); await f.unknown(); const before = calls.length;
  assert.equal((await f.view()).retryBlock, "unknown"); await assert.rejects(f.retry(), code("delivery_retry_blocked"));
  await f.send(); assert.equal(calls.length, before);
  const checked = await f.review("text", "not_sent"); assert.equal(checked.canRetry, true); assert.equal(calls.length, before);
  const sent = await f.retry(); assert.equal(sent.retryBlock, "complete"); assert.equal(calls.length, before + 1);
  assert.equal(await db.message.count({ where: { conversationId: f.conv.id, direction: "outbound" } }), 1);
});
it("manual confirmation of an accepted text never invents a provider receipt or resends it", async () => {
  const f = await fixture(); await f.unknown(); const checked = await f.review("text", "sent");
  assert.equal(checked.parts[0].providerMessageId, null); assert.ok(checked.parts[0].checkedBy); assert.equal(checked.retryBlock, "complete");
  assert.equal((await f.read()).receiptState, "reconciled"); await assert.rejects(f.retry(), code("delivery_retry_blocked")); assert.equal(calls.length, 1);
  assert.equal(await db.auditEvent.count({ where: { tenantId: tid, entityId: checked.messageId, action: "message.delivery_reconciled" } }), 1);
  assert.equal(await db.activity.count({ where: { tenantId: tid, contactId: f.contact.id, type: "message.delivery_reconciled" } }), 1);
});
it("retries only an absent file and remaining pending files, preserving accepted text", async () => {
  const f = await fixture({ files: 2 }); provider = async method => method === "sendDocument" ? noAck() : ok();
  await assert.rejects(f.send()); provider = ok;
  const view = await f.view(), file = view.parts.find(p => p.state === "unknown")!;
  assert.equal(view.parts.find(p => p.id === "text")?.state, "accepted");
  assert.equal(view.parts.filter(p => p.state === "pending").length, 1);
  await f.review(file.id, "not_sent"); await f.retry();
  assert.deepEqual(calls.map(c => c.method), ["sendMessage", "sendDocument", "sendDocument", "sendDocument"]);
  assert.equal((await f.view()).retryBlock, "complete");
});
it("a confirmed file is skipped and only the never-started file is sent", async () => {
  const f = await fixture({ text: false, files: 2 }); await f.unknown(); const unknown = (await f.view()).parts.find(p => p.state === "unknown")!;
  await f.review(unknown.id, "sent"); await f.retry();
  assert.deepEqual(calls.map(c => c.file), ["0.pdf", "1.pdf"]); assert.equal((await f.read()).receiptState, "reconciled");
});
it("a definite Telegram rejection is retryable but never retried automatically", async () => {
  const f = await fixture(); provider = async () => new Response(JSON.stringify({ ok: false, error_code: 403 }), { status: 403 });
  await assert.rejects(f.send(), code("telegram_provider")); provider = ok;
  const view = await f.view(); assert.equal(view.parts[0].state, "failed"); assert.equal(view.canRetry, true);
  await f.send(); assert.equal(calls.length, 1); await f.retry(); assert.equal(calls.length, 2);
});
for (const [name, response] of [
  ["server failure", () => new Response(JSON.stringify({ ok: false, error_code: 500 }), { status: 500 })],
  ["missing message id", () => new Response(JSON.stringify({ ok: true, result: {} }))],
  ["invalid response", () => new Response("not JSON")],
  ["non-boolean acknowledgement", () => new Response(JSON.stringify({ ok: "true", result: { message_id: 1001 } }))],
] as const) it(`keeps ${name} unknown and blocks blind retries`, async () => {
  const f = await fixture(); provider = async () => response(); await assert.rejects(f.send());
  assert.equal((await f.view()).retryBlock, "unknown"); await assert.rejects(f.retry(), code("delivery_retry_blocked")); assert.equal(calls.length, 1);
});
it("rejects stale, invalid and already reconciled review requests", async () => {
  const f = await fixture(); await f.unknown(); const view = await f.view();
  await assert.rejects(reconcileMessageDelivery(db, auth, f.conv.id, view.messageId, { revision: view.revision, partId: "text", outcome: "not_sent", note: "short" }), code("invalid"));
  await assert.rejects(f.review("missing", "sent"), code("not_found"));
  await f.review("text", "not_sent", view.revision);
  await assert.rejects(f.review("text", "sent", view.revision), code("delivery_changed"));
  await assert.rejects(f.review("text", "sent"), code("already_reconciled"));
});
it("serializes competing reviewers and retries so only one can succeed", async () => {
  const f = await fixture(); await f.unknown(); const view = await f.view();
  const reviews = await Promise.allSettled([f.review("text", "not_sent", view.revision), f.review("text", "sent", view.revision)]);
  assert.equal(reviews.filter(r => r.status === "fulfilled").length, 1);
  // The first call acquires the row lock first; if a future DB scheduler differs, use a fresh absent fixture.
  const target = (await f.view()).canRetry ? f : await fixture(); if (target !== f) { await target.unknown(); await target.review("text", "not_sent"); }
  const ready = await target.view(), before = calls.length;
  const retries = await Promise.allSettled([target.retry(ready.revision), target.retry(ready.revision)]);
  assert.equal(retries.filter(r => r.status === "fulfilled").length, 1); assert.equal(calls.length, before + 1);
});
it("manager can inspect own dialogue but cannot reconcile or retry", async () => {
  const f = await fixture({ actor: manager }); await f.unknown();
  assert.equal((await f.view(manager)).canReconcile, false); assert.equal((await f.view(manager)).retryBlock, "permissions");
  await assert.rejects(f.review("text", "sent", undefined, manager), code("forbidden"));
  await assert.rejects(f.retry(undefined, manager), code("forbidden"));
});
it("rejects cross-tenant, wrong-conversation, untracked AI and internal messages", async () => {
  const f = await fixture(); await f.unknown(); const message = await f.read();
  const other = await db.membership.findFirstOrThrow({ where: { tenantId: { not: tid }, role: "owner" }, include: { tenant: true, user: true } });
  const otherAuth = { user: other.user, activeMembership: other, memberships: [other] } as AuthContext;
  await assert.rejects(getMessageDeliveryReview(db, otherAuth, f.conv.id, message.id));
  const another = await fixture(); await assert.rejects(getMessageDeliveryReview(db, auth, another.conv.id, message.id), code("not_found"));
  await db.message.update({ where: { id: message.id }, data: { senderKind: "ai" } }); await assert.rejects(getMessageDeliveryReview(db, auth, f.conv.id, message.id), code("delivery_untracked"));
  await db.message.update({ where: { id: message.id }, data: { senderKind: "staff", internal: true } }); await assert.rejects(getMessageDeliveryReview(db, auth, f.conv.id, message.id), code("not_found"));
});

for (const change of ["recipient", "contact", "connection", "mode", "closed", "control", "content", "file"] as const) it(`blocks retry after ${change} changes`, async () => {
  const f = await fixture({ files: 1 }); await f.unknown(); await f.review("text", "not_sent"); const before = calls.length;
  if (change === "recipient") await db.conversation.update({ where: { id: f.conv.id }, data: { externalThreadId: "999999" } });
  if (change === "contact") await db.conversation.update({ where: { id: f.conv.id }, data: { contactId: null } });
  if (change === "connection") await db.conversation.update({ where: { id: f.conv.id }, data: { connectionId: null } });
  if (change === "mode") await db.conversation.update({ where: { id: f.conv.id }, data: { mode: "ai" } });
  if (change === "closed") await db.conversation.update({ where: { id: f.conv.id }, data: { status: "closed" } });
  if (change === "control") await db.conversation.update({ where: { id: f.conv.id }, data: { controlVersion: { increment: 1 } } });
  if (change === "content") await db.message.update({ where: { id: (await f.read()).id }, data: { text: "Changed" } });
  if (change === "file") await db.attachment.update({ where: { id: (await f.read()).attachments[0].id }, data: { originalFileName: "changed.pdf" } });
  assert.equal((await f.view()).retryBlock, "conversation_changed"); await assert.rejects(f.retry(), code("delivery_retry_blocked")); assert.equal(calls.length, before);
});
for (const change of ["bot", "integration", "credential", "disconnected"] as const) it(`blocks retry after ${change} changes without exposing secrets`, async () => {
  const f = await fixture(); await f.unknown(); await f.review("text", "not_sent"); const before = calls.length;
  if (change === "bot") await db.channelConnection.update({ where: { id: f.connection.id }, data: { externalRef: "987654321" } });
  if (change === "integration") await db.integration.update({ where: { id: f.integration.id }, data: { publicKey: "changed" } });
  if (change === "credential") await db.credential.update({ where: { id: f.credential.id }, data: { encryptedValue: encryptSecret("another-secret") } });
  if (change === "disconnected") await db.integration.update({ where: { id: f.integration.id }, data: { status: "disabled" } });
  assert.equal((await f.view()).retryBlock, "connection_changed"); await assert.rejects(f.retry(), code("delivery_retry_blocked")); assert.equal(calls.length, before);
});
it("honors original sender access changes and preserves immutable recipient/history", async () => {
  const f = await fixture({ actor: manager }); await f.unknown();
  const newContact = await db.contact.create({ data: { tenantId: tid, name: "Another person" } });
  await db.conversation.update({ where: { id: f.conv.id }, data: { contactId: newContact.id, externalThreadId: "111111" } });
  const view = await f.review("text", "not_sent"); assert.match(view.recipient, /Клиент Telegram.*555123/); assert.equal(view.retryBlock, "conversation_changed");
  assert.equal(await db.activity.count({ where: { contactId: f.contact.id, type: "message.delivery_reconciled" } }), 1);
  assert.equal(await db.activity.count({ where: { contactId: newContact.id, type: "message.delivery_reconciled" } }), 0);
  await db.conversation.update({ where: { id: f.conv.id }, data: { contactId: f.contact.id, externalThreadId: "555123", assigneeMembershipId: auth.activeMembership!.id } });
  assert.equal((await f.view()).retryBlock, "access_changed"); await assert.rejects(f.retry(), code("delivery_retry_blocked"));
});
it("rechecks reviewer membership inside the mutation despite a stale authenticated context", async () => {
  const f = await fixture({ actor: manager }); await f.unknown(); const view = await f.view();
  await db.membership.update({ where: { id: auth.activeMembership!.id }, data: { active: false } });
  try { await assert.rejects(f.review("text", "sent", view.revision), code("forbidden")); }
  finally { await db.membership.update({ where: { id: auth.activeMembership!.id }, data: { active: true } }); }
  await f.review("text", "not_sent");
  await db.membership.update({ where: { id: auth.activeMembership!.id }, data: { role: "manager" } });
  try { await assert.rejects(f.retry(), code("delivery_retry_blocked")); assert.equal(calls.length, 1); }
  finally { await db.membership.update({ where: { id: auth.activeMembership!.id }, data: { role: "owner" } }); }
});
it("checks access again after token preparation immediately before dispatch", async () => {
  const f = await fixture({ actor: manager }); await f.unknown(); await f.review("text", "not_sent"); const before = calls.length;
  const original = db.credential.findFirst.bind(db.credential); let changed = false;
  const intercepted = new Proxy(db, { get(target, key) {
    if (key === "credential") return { ...target.credential, findFirst: async (...args: Parameters<typeof original>) => {
      const value = await original(...args);
      if (!changed && await db.outboundOperation.count({ where: { conversationId: f.conv.id, state: "sending" } })) {
        changed = true; await db.conversation.update({ where: { id: f.conv.id }, data: { assigneeMembershipId: auth.activeMembership!.id } });
      }
      return value;
    } };
    return Reflect.get(target, key);
  } });
  await assert.rejects(f.retry(undefined, auth, intercepted), code("delivery_retry_blocked")); assert.equal(changed, true); assert.equal(calls.length, before);
  assert.equal((await f.view()).parts[0].state, "failed");
});
it("stops remaining files when the conversation changes during an accepted text", async () => {
  const f = await fixture({ files: 1 });
  provider = async () => { await db.conversation.update({ where: { id: f.conv.id }, data: { mode: "ai", controlVersion: { increment: 1 } } }); return ok(); };
  await assert.rejects(f.send(), code("delivery_retry_blocked")); assert.equal(calls.length, 1);
  const view = await f.view(); assert.equal(view.parts[0].state, "accepted"); assert.equal(view.parts[1].state, "pending");
});
it("verifies saved file bytes and refuses a changed file before an external call", async () => {
  const f = await fixture({ text: false, files: 1 }); await f.unknown(); await f.review((await f.view()).parts[0].id, "not_sent");
  const file = (await f.read()).attachments[0]; await writeFile(resolveUploadPath(file.storageKey), "tampered");
  await assert.rejects(f.retry(), code("attachment_changed")); assert.equal(calls.length, 1); assert.equal((await f.view()).parts[0].state, "failed");
});
it("does not clear a newer inbound message when completing or manually confirming an old send", async () => {
  const f = await fixture(); await f.unknown();
  await db.conversation.update({ where: { id: f.conv.id }, data: { messageRevision: { increment: 1 }, waitingFor: "MANAGER", needsAttention: true } });
  await f.review("text", "sent");
  const conv = await db.conversation.findUniqueOrThrow({ where: { id: f.conv.id } });
  assert.equal(conv.waitingFor, "MANAGER"); assert.equal(conv.needsAttention, true); assert.equal(conv.messageRevision, 2);
  await recoverTelegramDeliveries(db, new Date(Date.now() + 360_000));
  assert.equal((await db.conversation.findUniqueOrThrow({ where: { id: conv.id } })).messageRevision, 2);
  assert.equal(await db.outboxEvent.count({ where: { id: `context:${(await f.read()).id}` } }), 1);
});
it("keeps live sends busy and fences late acknowledgements while a newer retry is still sending", async () => {
  const f = await fixture(); let release!: () => void, started!: () => void, releaseRetry!: () => void, startedRetry!: () => void;
  const arrived = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const retryArrived = new Promise<void>(resolve => { startedRetry = resolve; }), retryGate = new Promise<void>(resolve => { releaseRetry = resolve; });
  let first = true;
  provider = async () => { if (first) { first = false; started(); await gate; return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } })); } startedRetry(); await retryGate; return ok(); };
  const sending = f.send().then(result => ({ result, error: null }), error => ({ result: null, error }));
  let retrying: ReturnType<typeof f.retry> | undefined;
  try {
    await arrived;
    assert.equal((await f.view()).busy, true); await assert.rejects(f.review("text", "sent"), code("delivery_busy"));
    await assert.rejects(f.retry(), code("delivery_retry_blocked"));
    await recoverTelegramDeliveries(db); assert.equal((await f.view()).busy, true);
    await recoverTelegramDeliveries(db, new Date(Date.now() + 360_000)); assert.equal((await f.view()).needsCheck, true);
    await f.review("text", "not_sent"); retrying = f.retry(); await retryArrived; const current = await f.view();
    release(); const old = await sending; assert.ok(code("delivery_changed")(old.error));
    assert.equal((await f.view()).revision, current.revision); assert.equal((await f.view()).busy, true);
    releaseRetry(); await retrying;
    assert.notEqual((await f.read()).providerMessageId, "99"); assert.equal(calls.length, 2); assert.equal((await f.view()).retryBlock, "complete");
  } finally { release(); releaseRetry(); await sending; await retrying; }
});
it("manual review of an expired intent fences its still-running process without background recovery", async () => {
  const f = await fixture(); let release!: () => void, started!: () => void;
  const arrived = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  provider = async () => { started(); await gate; return ok(); };
  const sending = f.send().catch(error => error);
  try {
    await arrived; const op = await f.operation(), delivery = (await readTelegramDelivery(db, tid, op.id))!;
    delivery.leaseUntil = 0; await saveTelegramDelivery(db, tid, op.id, delivery);
    assert.equal((await f.view()).parts[0].state, "unknown"); await f.review("text", "sent");
    release(); assert.ok(code("delivery_changed")(await sending)); assert.equal((await f.read()).receiptState, "reconciled"); assert.equal(calls.length, 1);
  } finally { release(); await sending; }
});
it("older deliveries without an immutable target stay untracked; same key never resends", async () => {
  const f = await fixture(); await f.send(); const message = await f.read(), op = await f.operation();
  await db.message.update({ where: { id: message.id }, data: { connectionScopedId: message.connectionScopedId!.replace("telegram-out-v2:", "telegram-out:") } });
  await db.idempotencyRecord.update({ where: { scope_actorKey_key: { scope: "telegram.manual.delivery", actorKey: tid, key: op.id } }, data: { resultJson: { text: "sending", leaseUntil: 0, messageRevision: 0 } } });
  await assert.rejects(f.view(), code("delivery_untracked")); await f.send(); assert.equal(calls.length, 1);
  const workspace = await getConversationWorkspace(db, auth, f.conv.id);
  assert.equal(workspace.messages.find(m => m.id === message.id)?.deliveryReviewAvailable, false);
});
it("reconciles the selected message rather than the newest message in a conversation", async () => {
  const f = await fixture(); await f.unknown(); const first = await f.read(), before = await f.view();
  const latest = await sendCompanyTelegram(db, auth, f.conv.id, { text: "Another reply", idempotencyKey: randomUUID() });
  await reconcileMessageDelivery(db, auth, f.conv.id, first.id, { revision: before.revision, partId: "text", outcome: "not_sent", note: "Verified first reply missing" });
  assert.equal((await db.message.findUniqueOrThrow({ where: { id: first.id } })).operationState, "failed");
  assert.equal((await db.message.findUniqueOrThrow({ where: { id: latest.id } })).operationState, "accepted");
  assert.equal(calls.length, 2);
});
it("HTTP review validates the payload, tenant scope and no-cache response", async () => {
  const f = await fixture(); await f.unknown(); const message = await f.read(), url = `${base}/api/v1/conversations/${f.conv.id}/messages/${message.id}/delivery`;
  assert.equal((await fetch(url)).status, 401);
  const response = await fetch(url, { headers: { cookie } }); assert.equal(response.status, 200); assert.match(response.headers.get("cache-control") || "", /no-store/);
  const view = await response.json(); assert.equal(view.channel, "telegram");
  const post = (path: string, body: unknown) => fetch(url + path, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post("/reconcile", { revision: view.revision, partId: "text", outcome: "not_sent", note: "Verified absent", extra: true })).status, 422);
  assert.equal((await post("/retry", { revision: "bad" })).status, 422);
  const checked = await post("/reconcile", { revision: view.revision, partId: "text", outcome: "not_sent", note: "Verified with recipient" }); assert.equal(checked.status, 200);
  assert.equal(calls.length, 1); const ready = await checked.json();
  assert.equal((await post("/retry", { revision: ready.revision })).status, 200); assert.equal(calls.length, 2);
  assert.equal((await post("/retry", { revision: ready.revision })).status, 409); assert.equal(calls.length, 2);
});
