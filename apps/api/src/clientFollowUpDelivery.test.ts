import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, it, mock } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { WhatsAppSellerBridge } from "@creolab/integrations";
import { encryptSecret } from "./lib/secretBox.ts";
import { invalidateRuntimeConfig } from "./services/runtimeSettings.ts";
import { processClientFollowUp, refreshConversationFollowUp, cancelConversationFollowUps } from "./services/aiConversationPolicyService.ts";
import { claimFollowUp, followUpOperationKey, recoverAbandonedFollowUps } from "./services/clientFollowUpDelivery.ts";
import { recoverInterruptedScheduledActions } from "./services/scheduledActionLease.ts";

let db: Awaited<ReturnType<typeof createPrismaClient>>, tid: string, integrationId: string;
let sends = 0, generations = 0, generationHook: (() => Promise<void>) | undefined, sendHook: (() => Promise<unknown>) | undefined;
const nativeFetch = globalThis.fetch, oldKey = process.env.OPENAI_API_KEY, oldBase = process.env.OPENAI_BASE_URL;
const settings = { aiAutomation: { analyzeNewRequests: true, defaultMode: "AUTO", followUp: { enabled: true, maxAttempts: 2, delaysMinutes: [5, 10] } } };
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
before(async () => {
  assert.equal(process.env.CRM_USE_PGLITE, "1");
  db = await createPrismaClient(); await (await import("../../../packages/db/src/seed.ts")).seedDatabase();
  tid = (await db.tenant.findFirstOrThrow({ where: { slug: "creolab" } })).id;
  const integration = await db.integration.findFirstOrThrow({ where: { tenantId: tid, type: "whatsapp_seller" } }); integrationId = integration.id;
  await db.aIConfiguration.updateMany({ where: { tenantId: tid }, data: { enabled: true, provider: "openai", model: "isolated-model", promptStatus: "published", systemPrompt: "Создаём сайты. Не придумывай цены." } });
  await db.knowledgeDocument.create({ data: { tenantId: tid, title: "Test company", content: "Создаём сайты за 10 дней.", status: "published", sourceType: "manual" } });
  process.env.OPENAI_API_KEY = "synthetic-test-key"; process.env.OPENAI_BASE_URL = "https://followup-model.example.test/v1"; invalidateRuntimeConfig();
  globalThis.fetch = async url => {
    assert.equal(String(url), "https://followup-model.example.test/v1/chat/completions"); generations++; await generationHook?.();
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: "Подскажите, удалось ли согласовать макет сайта?" } }], usage: { prompt_tokens: 50, completion_tokens: 15, total_tokens: 65 } });
  };
});
beforeEach(async () => {
  sends = 0; generations = 0; generationHook = undefined; sendHook = undefined;
  await db.tenant.update({ where: { id: tid }, data: { status: "active", settingsJson: settings } });
  await db.integration.update({ where: { id: integrationId }, data: { status: "active", automationMode: "AUTO", schemaJson: { sellerUrl: "https://seller.invalid", secretEnc: encryptSecret("synthetic-only") } } });
  mock.method(WhatsAppSellerBridge.prototype, "sendText", async () => { sends++; return sendHook ? sendHook() : { ok: true, idMessage: `provider-${sends}` }; });
});
afterEach(async () => { mock.restoreAll(); await db.scheduledAction.deleteMany({ where: { tenantId: tid } }); });
after(async () => {
  globalThis.fetch = nativeFetch;
  if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
  if (oldBase === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = oldBase;
  invalidateRuntimeConfig(); await db.$disconnect();
});
async function fixture(connectionId?: string) {
  const contact = await db.contact.create({ data: { tenantId: tid, name: "Synthetic client" } });
  const conversation = await db.conversation.create({ data: { tenantId: tid, contactId: contact.id, sellerLeadId: randomUUID(), connectionId, mode: "ai", waitingFor: "CLIENT" } });
  const anchor = await db.message.create({ data: { tenantId: tid, conversationId: conversation.id, senderKind: "ai", direction: "outbound", text: "Высылаю макет сайта.", operationState: "accepted", createdAt: new Date(Date.now() - 3600_000) } });
  await refreshConversationFollowUp(db, tid, conversation.id);
  const action = await db.scheduledAction.findFirstOrThrow({ where: { tenantId: tid, parentId: conversation.id } });
  await db.scheduledAction.update({ where: { id: action.id }, data: { dueAt: new Date(0) } });
  return { conversation, anchor, action, run: () => processClientFollowUp(db, action),
    operation: () => db.outboundOperation.findUniqueOrThrow({ where: { tenantId_idempotencyKey: { tenantId: tid, idempotencyKey: followUpOperationKey(action.id) } } }) };
}

it("schedules only once for the same anchor, even when refreshed in parallel", async () => {
  const f = await fixture();
  await Promise.all(Array.from({ length: 6 }, () => refreshConversationFollowUp(db, tid, f.conversation.id)));
  assert.equal(await db.scheduledAction.count({ where: { parentId: f.conversation.id } }), 1);
});
it("records provider evidence and atomically creates one next attempt; replay is harmless", async () => {
  const f = await fixture(); assert.equal((await f.run()).sent, true);
  const op = await f.operation(); assert.equal(op.state, "accepted");
  const message = await db.message.findUniqueOrThrow({ where: { id: op.providerRef! } });
  assert.equal(message.providerMessageId, "provider-1"); assert.equal(message.operationState, "accepted");
  assert.equal(await db.outboxEvent.count({ where: { id: `context:${message.id}` } }), 1);
  await f.run(); await refreshConversationFollowUp(db, tid, f.conversation.id);
  const pending = await db.scheduledAction.findMany({ where: { parentId: f.conversation.id, state: "scheduled" } });
  assert.equal(pending.length, 1); assert.equal((pending[0].payloadJson as any).attempt, 2); assert.equal(sends, 1); assert.equal(generations, 1);
});
it("does not reset the maximum attempts when context is refreshed after the last reminder", async () => {
  const f = await fixture(); await f.run();
  const second = await db.scheduledAction.findFirstOrThrow({ where: { parentId: f.conversation.id, state: "scheduled" } });
  await db.scheduledAction.update({ where: { id: second.id }, data: { dueAt: new Date(0) } });
  assert.equal((await processClientFollowUp(db, second)).sent, true);
  await refreshConversationFollowUp(db, tid, f.conversation.id);
  assert.equal(await db.scheduledAction.count({ where: { parentId: f.conversation.id } }), 2); assert.equal(sends, 2);
});
it("concurrent handlers generate and send only one message", async () => {
  const f = await fixture(), entered = gate(), release = gate(); generationHook = async () => { entered.resolve(); await release.promise; };
  const first = f.run(); await entered.promise;
  try { await f.run(); assert.equal(generations, 1); } finally { release.resolve(); await first; }
  assert.equal(sends, 1);
});
it("a timeout keeps an unknown result, blocks blind repeats and does not create a new first attempt", async () => {
  const f = await fixture(); sendHook = async () => { throw new Error("timeout after acceptance"); };
  assert.equal((await f.run()).skipped, "unknown"); const op = await f.operation(); assert.equal(op.state, "unknown");
  assert.equal((await db.message.findUniqueOrThrow({ where: { id: op.providerRef! } })).operationState, "unknown");
  await f.run(); await refreshConversationFollowUp(db, tid, f.conversation.id); assert.equal(sends, 1);
  assert.equal(await db.scheduledAction.count({ where: { parentId: f.conversation.id } }), 1);
  assert.equal((await db.conversation.findUniqueOrThrow({ where: { id: f.conversation.id } })).attentionReason, "AI_DELIVERY_UNKNOWN");
});
it("two old jobs for the same anchor cannot generate parallel reminders", async () => {
  const f = await fixture(), entered = gate(), release = gate();
  const duplicate = await db.scheduledAction.create({ data: { tenantId: tid, type: "client_followup", parentType: "conversation",
    parentId: f.conversation.id, dueAt: new Date(0), payloadJson: { attempt: 1, lastOutboundMessageId: f.anchor.id } } });
  generationHook = async () => { entered.resolve(); await release.promise; };
  const first = f.run(); await entered.promise;
  try { await processClientFollowUp(db, duplicate); assert.equal(generations, 1); }
  finally { release.resolve(); await first; }
  assert.equal(sends, 1);
});
it("rejects stale anchors, excessive attempts and cross-tenant jobs before generation", async () => {
  const f = await fixture();
  assert.equal((await processClientFollowUp(db, { ...f.action, tenantId: "another-tenant" })).skipped, "not_pending");
  assert.equal((await db.scheduledAction.findUniqueOrThrow({ where: { id: f.action.id } })).state, "scheduled");
  await db.scheduledAction.update({ where: { id: f.action.id }, data: { payloadJson: { attempt: 3, lastOutboundMessageId: f.anchor.id } } });
  assert.equal((await f.run()).skipped, "attempt_limit");
  const g = await fixture(); await db.message.create({ data: { tenantId: tid, conversationId: g.conversation.id, senderKind: "ai", direction: "outbound", text: "Новые условия", operationState: "accepted" } });
  assert.equal((await g.run()).skipped, "conversation_changed"); assert.equal(generations, 0); assert.equal(sends, 0);
});
it("human takeover and explicit cancellation during generation prevent sending", async () => {
  for (const cancel of [false, true]) {
    const f = await fixture(); generationHook = async () => {
      if (cancel) await cancelConversationFollowUps(db, tid, f.conversation.id, "user_canceled");
      else await db.conversation.update({ where: { id: f.conversation.id }, data: { mode: "human", controlVersion: { increment: 1 } } });
    };
    await f.run(); assert.equal(sends, 0); assert.equal((await f.operation()).state, "canceled");
  }
});
it("client reply, company pause and recipient changes during generation stop the draft", async () => {
  for (const change of ["reply", "pause", "recipient"]) {
    await db.tenant.update({ where: { id: tid }, data: { settingsJson: settings } });
    const f = await fixture(); generationHook = async () => {
      if (change === "reply") await db.message.create({ data: { tenantId: tid, conversationId: f.conversation.id, senderKind: "client", direction: "inbound", text: "Уже согласовано" } });
      else if (change === "pause") await db.tenant.update({ where: { id: tid }, data: { settingsJson: { ...settings, runtime: { aiPaused: true } } } });
      else await db.conversation.update({ where: { id: f.conversation.id }, data: { sellerLeadId: randomUUID() } });
    };
    await f.run(); assert.equal(sends, 0); assert.equal((await f.operation()).state, "canceled");
  }
});
it("a changed bridge is a known unsent failure, never a silent redirect to another connection", async () => {
  const f = await fixture(); generationHook = async () => { await db.integration.update({ where: { id: integrationId }, data: { schemaJson: { sellerUrl: "https://different.invalid", secretEnc: encryptSecret("synthetic-only") } } }); };
  assert.equal((await f.run()).skipped, "failed"); assert.equal((await f.operation()).state, "failed"); assert.equal(sends, 0);
});
it("supports a conversation bound to the existing seller connection and stops if its binding changes", async () => {
  const connection = await db.channelConnection.create({ data: { tenantId: tid, integrationId, channelType: "whatsapp", status: "active" } });
  const f = await fixture(connection.id);
  assert.equal((await f.run()).sent, true); assert.equal(sends, 1);
  const g = await fixture(connection.id);
  generationHook = async () => { await db.conversation.update({ where: { id: g.conversation.id }, data: { connectionId: null } }); };
  await g.run(); assert.equal((await g.operation()).state, "canceled"); assert.equal(sends, 1);
});
it("never redirects a bound conversation to a different seller integration or another channel", async () => {
  for (const type of ["whatsapp_seller", "whatsapp_qr"]) {
    const integration = await db.integration.create({ data: { tenantId: tid, type, name: "Other test channel", status: "active", automationMode: "AUTO" } });
    const connection = await db.channelConnection.create({ data: { tenantId: tid, integrationId: integration.id, channelType: "whatsapp", status: "active" } });
    const f = await fixture(connection.id);
    assert.equal((await f.run()).skipped, type === "whatsapp_seller" ? "bridge_changed" : "no_channel");
    assert.equal(sends, 0); assert.equal(generations, 0);
  }
});
it("honors a legacy connector's manual mode even before a conversation has a connection record", async () => {
  const f = await fixture(); await db.integration.update({ where: { id: integrationId }, data: { automationMode: "MANUAL" } });
  assert.equal((await f.run()).skipped, "ai_policy_restricted"); assert.equal(sends, 0); assert.equal(generations, 0);
});
it("checks cancellation and a new reply after connection lookup, immediately before the provider call", async () => {
  for (const change of ["cancel", "reply", "suspend"]) {
    await db.tenant.update({ where: { id: tid }, data: { status: "active" } });
    const f = await fixture();
    const original = db.integration.findFirst.bind(db.integration);
    let changed = false;
    const findFirst = async (args: any) => {
      const result = await original(args);
      if (!changed && args?.where?.type === "whatsapp_seller" && await db.outboundOperation.count({ where: { conversationId: f.conversation.id, state: "sending" } })) {
        changed = true;
        if (change === "cancel") await cancelConversationFollowUps(db, tid, f.conversation.id, "user_canceled");
        else if (change === "reply") await db.message.create({ data: { tenantId: tid, conversationId: f.conversation.id, senderKind: "client", direction: "inbound", text: "Спасибо, уже решили" } });
        else await db.tenant.update({ where: { id: tid }, data: { status: "suspended" } });
      }
      return result;
    };
    const intercepted = new Proxy(db, { get(target, key) {
      if (key === "integration") return { ...target.integration, findFirst };
      return Reflect.get(target, key);
    } });
    assert.equal((await processClientFollowUp(intercepted, f.action)).skipped, "canceled");
    assert.equal(changed, true); assert.equal(sends, 0); assert.equal((await f.operation()).state, "canceled");
  }
});
it("an expired generation is fenced so a late model answer cannot send", async () => {
  const f = await fixture(), entered = gate(), release = gate(); generationHook = async () => { entered.resolve(); await release.promise; };
  const run = f.run(); await entered.promise;
  try { await recoverInterruptedScheduledActions(db, new Date(Date.now() + 100_000)); } finally { release.resolve(); await run; }
  assert.equal((await f.operation()).state, "failed"); assert.equal(sends, 0);
});
it("interrupted remote sends become unknown and recovery does not dispatch", async () => {
  const f = await fixture(); const operation = await claimFollowUp(db, f.action, f.conversation.controlVersion); assert.ok(operation);
  const message = await db.message.create({ data: { tenantId: tid, conversationId: f.conversation.id, senderKind: "ai", direction: "outbound", text: "Interrupted", operationState: "sending" } });
  await db.outboundOperation.update({ where: { id: operation.id }, data: { state: "sending", providerRef: message.id } });
  await recoverInterruptedScheduledActions(db, new Date(Date.now() + 100_000));
  assert.equal((await f.operation()).state, "unknown"); assert.equal((await db.message.findUniqueOrThrow({ where: { id: message.id } })).operationState, "unknown");
  await refreshConversationFollowUp(db, tid, f.conversation.id); assert.equal(await db.scheduledAction.count({ where: { parentId: f.conversation.id } }), 1); assert.equal(sends, 0);
});
it("recovers a canceled send after process loss without resurrecting the action", async () => {
  const f = await fixture(); const operation = await claimFollowUp(db, f.action, f.conversation.controlVersion); assert.ok(operation);
  const message = await db.message.create({ data: { tenantId: tid, conversationId: f.conversation.id, senderKind: "ai", direction: "outbound", text: "Canceled in flight", operationState: "sending" } });
  await db.outboundOperation.update({ where: { id: operation.id }, data: { state: "sending", providerRef: message.id, createdAt: new Date(0) } });
  await cancelConversationFollowUps(db, tid, f.conversation.id, "user_canceled"); await recoverAbandonedFollowUps(db);
  assert.equal((await f.operation()).state, "unknown"); assert.equal((await db.scheduledAction.findUniqueOrThrow({ where: { id: f.action.id } })).state, "canceled"); assert.equal(sends, 0);
});
it("a reply arriving during provider delivery prevents the next reminder", async () => {
  const f = await fixture(); sendHook = async () => {
    await db.message.create({ data: { tenantId: tid, conversationId: f.conversation.id, senderKind: "client", direction: "inbound", text: "Уже посмотрел" } });
    return { ok: true, idMessage: "accepted-before-reply" };
  };
  assert.equal((await f.run()).sent, true); assert.equal(await db.scheduledAction.count({ where: { parentId: f.conversation.id, state: "scheduled" } }), 0);
});
it("old failed actions for an anchor cannot be bypassed by a fresh schedule", async () => {
  const f = await fixture(); await db.scheduledAction.delete({ where: { id: f.action.id } });
  await db.scheduledAction.create({ data: { tenantId: tid, type: "client_followup", parentType: "conversation", parentId: f.conversation.id, state: "failed", dueAt: new Date(0), payloadJson: { attempt: 1, lastOutboundMessageId: f.anchor.id } } });
  await refreshConversationFollowUp(db, tid, f.conversation.id);
  assert.equal(await db.scheduledAction.count({ where: { parentId: f.conversation.id } }), 1); assert.equal(sends, 0);
});
