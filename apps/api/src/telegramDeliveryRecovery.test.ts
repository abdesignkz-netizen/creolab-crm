import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { beginTelegramDelivery, telegramDeliveryPart, settleTelegramDelivery, recoverTelegramDeliveries } from "./services/telegramDeliveryState.ts";
import { storeMessageAttachment } from "./services/conversationMedia.ts";
let db: Awaited<ReturnType<typeof createPrismaClient>>, tenantId: string;
const nativeFetch = globalThis.fetch;
before(async () => {
  assert.equal(process.env.CRM_USE_PGLITE, "1"); db = await createPrismaClient();
  await (await import("../../../packages/db/src/seed.ts")).seedDatabase();
  tenantId = (await db.tenant.findFirstOrThrow({ where: { slug: "creolab" } })).id;
  globalThis.fetch = async () => { throw new Error("Recovery must not call a provider"); };
});
after(async () => { globalThis.fetch = nativeFetch; await db.$disconnect(); });
async function fixture(text = true, fileCount = 1, tracked = true) {
  const conversation = await db.conversation.create({ data: { tenantId, mode: "human", waitingFor: "MANAGER", needsAttention: true } });
  const message = await db.message.create({ data: { tenantId, conversationId: conversation.id, senderKind: "staff", direction: "outbound", text: text ? "Test" : null, operationState: "sending" } });
  const operation = await db.outboundOperation.create({ data: { tenantId, conversationId: conversation.id, controlVersion: conversation.controlVersion,
    idempotencyKey: `telegram:${conversation.id}:${randomUUID()}`, state: "sending", providerRef: message.id, createdAt: new Date(0) } });
  const files = [];
  for (let i=0; i<fileCount; i++) files.push(await storeMessageAttachment(db, { tenantId, messageId: message.id, fileName: `${i}.pdf`, mimeType: "application/pdf", buffer: Buffer.from("test"), sendState: "pending" }));
  if (tracked) await db.$transaction(tx => beginTelegramDelivery(tx, tenantId, operation.id, text, conversation.messageRevision));
  return { conversation, message, operation, files,
    part: (id: string, providerId?: string) => db.$transaction(tx => telegramDeliveryPart(tx, tenantId, operation.id, id, providerId)),
    read: () => db.message.findUniqueOrThrow({ where: { id: message.id }, include: { attachments: true } }) };
}
const later = () => new Date(Date.now() + 360_000);
it("does not touch a live delivery even if its operation was created earlier", async () => {
  const f = await fixture(); await f.part("text"); await recoverTelegramDeliveries(db);
  assert.equal((await f.read()).operationState, "sending");
});
it("recovers an expired text intent as unknown and fences late acknowledgements", async () => {
  const f = await fixture(); await f.part("text"); await recoverTelegramDeliveries(db, later());
  assert.equal((await f.read()).operationState, "unknown");
  await assert.rejects(f.part("text", "123"), /требует проверки/);
  assert.equal((await f.read()).providerMessageId, null);
});
it("preserves confirmed text and marks only the interrupted file as unknown", async () => {
  const f = await fixture(true, 2); await f.part("text"); await f.part("text", "101"); await f.part(f.files[0].id);
  await recoverTelegramDeliveries(db, later()); const message = await f.read();
  assert.equal(message.operationState, "unknown"); assert.equal(message.providerMessageId, "101");
  assert.equal(message.attachments.find(x => x.id === f.files[0].id)?.sendState, "unknown");
  assert.equal(message.attachments.find(x => x.id === f.files[1].id)?.sendState, "pending");
});
it("distinguishes interrupted preparation from a possibly delivered message", async () => {
  const f = await fixture(); await recoverTelegramDeliveries(db, later());
  assert.equal((await f.read()).operationState, "failed");
  assert.equal((await f.read()).attachments[0].sendState, "pending");
});
it("keeps known partial delivery without marking never-started files uncertain", async () => {
  const f = await fixture(); await f.part("text"); await f.part("text", "202"); await recoverTelegramDeliveries(db, later());
  const message = await f.read(); assert.equal(message.operationState, "partial"); assert.equal(message.attachments[0].sendState, "pending");
  assert.equal(await db.outboxEvent.count({ where: { id: `context:${message.id}` } }), 0);
});
it("completes persisted acknowledgements once, without another send or duplicate context event", async () => {
  const f = await fixture(); await f.part("text"); await f.part("text", "303"); await f.part(f.files[0].id); await f.part(f.files[0].id, "304");
  await recoverTelegramDeliveries(db, later()); await recoverTelegramDeliveries(db, later());
  assert.equal((await f.read()).operationState, "accepted");
  const conversation = await db.conversation.findUniqueOrThrow({ where: { id: f.conversation.id } });
  assert.equal(conversation.messageRevision, 1); assert.equal(conversation.waitingFor, "CLIENT");
  assert.equal(await db.outboxEvent.count({ where: { id: `context:${f.message.id}` } }), 1);
});
it("does not erase a newer inbound message or a handoff when completing delivery", async () => {
  const f = await fixture(true, 0); await f.part("text"); await f.part("text", "404");
  await db.conversation.update({ where: { id: f.conversation.id }, data: { mode: "paused", controlVersion: { increment: 1 }, messageRevision: { increment: 1 }, waitingFor: "MANAGER", needsAttention: true } });
  await db.$transaction(tx => settleTelegramDelivery(tx, tenantId, f.operation.id));
  const conversation = await db.conversation.findUniqueOrThrow({ where: { id: f.conversation.id } });
  assert.equal(conversation.mode, "paused"); assert.equal(conversation.waitingFor, "MANAGER"); assert.equal(conversation.needsAttention, true);
});
it("handles file-only success and old untracked sends without guessing", async () => {
  const f = await fixture(false); await f.part(f.files[0].id); await f.part(f.files[0].id, "505");
  await recoverTelegramDeliveries(db, later()); assert.equal((await f.read()).operationState, "accepted"); assert.equal((await f.read()).providerMessageId, "505");
  const old = await fixture(true, 0, false); await recoverTelegramDeliveries(db, later()); assert.equal((await old.read()).operationState, "unknown");
});
it("never reconciles another transport through the Telegram recovery path", async () => {
  const f = await fixture(); await db.outboundOperation.update({ where: { id: f.operation.id }, data: { idempotencyKey: `whatsapp:${randomUUID()}` } });
  await recoverTelegramDeliveries(db, later()); assert.equal((await f.read()).operationState, "sending");
});
