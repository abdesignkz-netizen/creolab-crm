import assert from "node:assert/strict";
import { after, afterEach, before, it } from "node:test";
import { createPrismaClient, type PrismaClient } from "@creolab/db";
import { enqueueWhatsAppAi } from "./services/whatsappAiService.ts";
import { processOutbox } from "./services/backgroundJobs.ts";
import { invalidateRuntimeConfig } from "./services/runtimeSettings.ts";

let prisma: Awaited<ReturnType<typeof createPrismaClient>>, tenantId: string, connectionId: string;
const envKeys = ["OPENAI_API_KEY", "OPENAI_BASE_URL"];
const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const nativeFetch = globalThis.fetch;
let providerBarrier: Promise<void> | undefined, providerStarted: (() => void) | undefined;
let requests: Array<Record<string, any>> = [];
const reply = "Здравствуйте! Стоимость сайта — 50 000 ₸. Расскажите о вашей задаче.";
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

before(async () => {
  assert.equal(process.env.CRM_USE_PGLITE, "1", "Use the isolated test runner");
  process.env.OPENAI_API_KEY = "isolated-test-only";
  process.env.OPENAI_BASE_URL = "https://latency-model.example.test/v1";
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://latency-model.example.test/v1/chat/completions");
    requests.push(JSON.parse(String(init?.body))); providerStarted?.(); await providerBarrier;
    return Response.json({ id: `model-request-${requests.length}`, choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ reply, handoff: false, reason: null, handoffSummary: null }) } }], usage: { prompt_tokens: 400, completion_tokens: 45, total_tokens: 445 } });
  };
  prisma = await createPrismaClient();
  await (await import("../../../packages/db/src/seed.ts")).seedDatabase();
  tenantId = (await prisma.tenant.findFirstOrThrow({ where: { slug: "creolab" } })).id;
  await prisma.tenant.update({ where: { id: tenantId }, data: { settingsJson: { aiAutomation: { defaultMode: "AUTO" } } } });
  await prisma.aIConfiguration.updateMany({ where: { tenantId }, data: { enabled: true, provider: "openai", model: "unchanged-quality-model", promptStatus: "published", systemPrompt: "Компания создаёт сайты. Отвечай по базе знаний.", maxOutputTokens: 1400, temperature: 0.2 } });
  await prisma.knowledgeDocument.create({ data: { tenantId, title: "Актуальный прайс", content: "Стоимость сайта — 50 000 ₸. Срок — 10 дней.", status: "published", sourceType: "manual" } });
  const integration = await prisma.integration.create({ data: { tenantId, name: "Local test widget", type: "website_chat", status: "active" } });
  connectionId = (await prisma.channelConnection.create({ data: { tenantId, integrationId: integration.id, channelType: "website", status: "active", autoReply: true } })).id;
  invalidateRuntimeConfig();
});
afterEach(async () => { providerBarrier = undefined; providerStarted = undefined; await prisma.outboxEvent.deleteMany({ where: { tenantId } }); });
after(async () => {
  globalThis.fetch = nativeFetch;
  for (const key of envKeys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  invalidateRuntimeConfig(); await prisma?.$disconnect();
});
async function inbound() {
  const contact = await prisma.contact.create({ data: { tenantId, name: "Synthetic customer" } });
  const conversation = await prisma.conversation.create({ data: { tenantId, contactId: contact.id, connectionId, mode: "ai", waitingFor: "MANAGER" } });
  const message = await prisma.message.create({ data: { tenantId, conversationId: conversation.id, direction: "inbound", senderKind: "client", text: "Здравствуйте! Сколько стоит сайт?" } });
  await prisma.conversation.update({ where: { id: conversation.id }, data: { messageRevision: 1, lastInboundMessageId: message.id } });
  await enqueueWhatsAppAi(prisma, tenantId, conversation.id, message.id);
  await prisma.outboxEvent.updateMany({ where: { entityId: conversation.id }, data: { availableAt: new Date(0) } });
  return conversation;
}

it("a complete AI answer reaches the website while unrelated background work is still blocked", { timeout: 15000 }, async () => {
  const conversation = await inbound(), blocked = gate(), entered = gate();
  const event = await prisma.outboxEvent.create({ data: { tenantId, type: "inquiry.automation", entityType: "inquiry", entityId: "slow-analysis", payloadJson: { tenantId, inquiryId: "slow-analysis" } } });
  const consumer = new Proxy(prisma, { get(target, key) {
    if (key === "inquiry") return { ...target.inquiry, findFirst: async () => { entered.resolve(); await blocked.promise; return null; } };
    return Reflect.get(target, key);
  } }) as PrismaClient;
  const background = processOutbox(consumer, { lane: "background" });
  const before = requests.length;
  try {
    await entered.promise;
    assert.equal(await processOutbox(consumer, { lane: "reply" }), 1);
    assert.equal(await processOutbox(consumer, { lane: "delivery" }), 1);
    assert.equal((await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).processedAt, null);
    const delivered = await prisma.message.findFirstOrThrow({ where: { conversationId: conversation.id, senderKind: "ai" } });
    assert.equal(delivered.text, reply); assert.equal(delivered.operationState, "accepted");
    assert.equal(requests.length, before + 1);
    const request = requests.at(-1)!;
    assert.equal(request.model, "unchanged-quality-model"); assert.equal(request.max_completion_tokens, 1400); assert.equal(request.temperature, 0.2);
    assert.equal(request.response_format.type, "json_schema");
    assert.match(request.messages[0].content, /Стоимость сайта — 50 000 ₸/);
    assert.equal(request.messages.at(-1).content, "Здравствуйте! Сколько стоит сайт?");
    const usage = await prisma.aIUsageEvent.findMany({ where: { tenantId, conversationId: conversation.id, feature: "AI_MANAGER_REPLY" } });
    assert.equal(usage.length, 1); assert.equal(usage[0].status, "ok");
  } finally { blocked.resolve(); await background; }
});

it("faster overlapping polls do not duplicate generation and takeover still cancels delivery", { timeout: 15000 }, async () => {
  const conversation = await inbound(), blocked = gate(), entered = gate();
  providerBarrier = blocked.promise; providerStarted = entered.resolve;
  const count = requests.length;
  const generation = processOutbox(prisma, { lane: "reply" });
  try {
    await entered.promise;
    assert.deepEqual(await Promise.all(Array.from({ length: 5 }, () => processOutbox(prisma, { lane: "reply" }))), Array(5).fill(0));
    assert.equal(requests.length, count + 1);
  } finally { blocked.resolve(); await generation; }
  await prisma.conversation.update({ where: { id: conversation.id }, data: { mode: "human", controlVersion: { increment: 1 } } });
  await processOutbox(prisma, { lane: "delivery" });
  const stopped = await prisma.message.findFirstOrThrow({ where: { conversationId: conversation.id, senderKind: "ai" } });
  assert.equal(stopped.operationState, "canceled");
  assert.equal(requests.length, count + 1);
});

it("a newer inbound message cancels the old answer and remains queued for the complete updated context", { timeout: 15000 }, async () => {
  const conversation = await inbound(), blocked = gate(), entered = gate();
  providerBarrier = blocked.promise; providerStarted = entered.resolve;
  const count = requests.length;
  const generation = processOutbox(prisma, { lane: "reply" });
  try {
    await entered.promise;
    const newer = await prisma.message.create({ data: { tenantId, conversationId: conversation.id, direction: "inbound", senderKind: "client", text: "А за сколько дней сделаете?" } });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { messageRevision: { increment: 1 }, lastInboundMessageId: newer.id } });
    await enqueueWhatsAppAi(prisma, tenantId, conversation.id, newer.id);
    // Make only the unclaimed new event due, without overwriting the old event's lease.
    await prisma.outboxEvent.updateMany({ where: { entityId: conversation.id, payloadJson: { path: ["messageId"], equals: newer.id } }, data: { availableAt: new Date(0) } });
    assert.equal(await processOutbox(prisma, { lane: "reply" }), 0);
    assert.equal(requests.length, count + 1);
  } finally { blocked.resolve(); await generation; }
  assert.equal(await prisma.message.count({ where: { conversationId: conversation.id, senderKind: "ai" } }), 0);
  providerBarrier = undefined; providerStarted = undefined;
  assert.equal(await processOutbox(prisma, { lane: "reply" }), 1);
  await processOutbox(prisma, { lane: "delivery" });
  assert.equal(requests.length, count + 2);
  const history = requests.at(-1)!.messages.filter((message: { role: string }) => message.role === "user").map((message: { content: string }) => message.content);
  assert.deepEqual(history, ["Здравствуйте! Сколько стоит сайт?", "А за сколько дней сделаете?"]);
  assert.equal(await prisma.message.count({ where: { conversationId: conversation.id, senderKind: "ai", operationState: "accepted" } }), 1);
});
