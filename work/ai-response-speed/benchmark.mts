import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

// No real accounts, messages, model requests, payments or external integrations.
const scratch = mkdtempSync(join(tmpdir(), "basqar-latency-benchmark-"));
Object.assign(process.env, {
  NODE_ENV: "test", CRM_USE_PGLITE: "1", CRM_PGLITE_DIR: join(scratch, "db"), STORAGE_DIR: join(scratch, "uploads"),
  OPENAI_API_KEY: "mock-only", OPENAI_BASE_URL: "https://latency-model.example.test/v1", ANYMODEL_API_KEY: "",
  BILLING_PROVIDER: "none", FREEDOM_PAY_SECRET_KEY: "", TELEGRAM_BOT_TOKEN: "", TELEGRAM_BOT_USERNAME: "",
  WHATSAPP_SELLER_URL: "", WHATSAPP_SELLER_SECRET: "", AI_MANAGER_URL: "", ESF_PROVIDER: "mock", ESF_ENV: "off", ESF_ALLOW_LIVE_SEND: "0",
  PLATFORM_ADMIN_EMAIL: "", PLATFORM_ADMIN_PASSWORD: "", SEED_PASSWORD: "IsolatedBenchmarkOnly1!",
});
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const reply = "Здравствуйте! Стоимость сайта — 50 000 ₸. Расскажите о вашей задаче.";
const requests: Array<{ hash: string; startedAt: number; completedAt: number }> = [];
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), "https://latency-model.example.test/v1/chat/completions", "Unexpected network access");
  const request = { hash: createHash("sha256").update(String(init?.body)).digest("hex"), startedAt: performance.now(), completedAt: 0 };
  requests.push(request);
  await sleep(2000); // Exactly the same simulated model latency in both runs.
  request.completedAt = performance.now();
  return Response.json({ id: "mock-model", choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ reply, handoff: false, reason: null, handoffSummary: null }) } }], usage: { prompt_tokens: 400, completion_tokens: 45, total_tokens: 445 } });
};
const { createPrismaClient } = await import("../../packages/db/src/index.ts");
const { enqueueWhatsAppAi } = await import("../../apps/api/src/services/whatsappAiService.ts");
const { processOutbox } = await import("../../apps/api/src/services/backgroundJobs.ts");
const { processOutbox: oldProcessOutbox } = await import("./legacyOutbox.mts");
const { invalidateRuntimeConfig } = await import("../../apps/api/src/services/runtimeSettings.ts");
const prisma = await createPrismaClient();
try {
  await (await import("../../packages/db/src/seed.ts")).seedDatabase();
  const tenantId = (await prisma.tenant.findFirstOrThrow({ where: { slug: "creolab" } })).id;
  await prisma.outboxEvent.deleteMany({ where: { tenantId } });
  await prisma.tenant.update({ where: { id: tenantId }, data: { settingsJson: { aiAutomation: { defaultMode: "AUTO" } } } });
  await prisma.aIConfiguration.updateMany({ where: { tenantId }, data: { enabled: true, provider: "openai", model: "unchanged-quality-model", promptStatus: "published", systemPrompt: "Компания создаёт сайты. Отвечай по базе знаний.", maxOutputTokens: 1400, temperature: 0.2 } });
  await prisma.knowledgeDocument.create({ data: { tenantId, title: "Актуальный прайс", content: "Стоимость сайта — 50 000 ₸. Срок — 10 дней.", status: "published", sourceType: "manual" } });
  const integration = await prisma.integration.create({ data: { tenantId, name: "Benchmark widget", type: "website_chat", status: "active" } });
  const connectionId = (await prisma.channelConnection.create({ data: { tenantId, integrationId: integration.id, channelType: "website", status: "active", autoReply: true } })).id;
  invalidateRuntimeConfig();
  async function run(mode: "before" | "after") {
    await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    const contact = await prisma.contact.create({ data: { tenantId, name: "Synthetic customer" } });
    const conversation = await prisma.conversation.create({ data: { tenantId, contactId: contact.id, connectionId, mode: "ai", waitingFor: "MANAGER" } });
    const message = await prisma.message.create({ data: { tenantId, conversationId: conversation.id, direction: "inbound", senderKind: "client", text: "Здравствуйте! Сколько стоит сайт?" } });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { messageRevision: 1, lastInboundMessageId: message.id } });
    const start = performance.now(), initialRequestCount = requests.length;
    await enqueueWhatsAppAi(prisma, tenantId, conversation.id, message.id); // Keeps the normal 1.5 s aggregation delay.
    const failures: unknown[] = [], pending = new Set<Promise<unknown>>();
    function track(job: Promise<unknown>) { const promise = job.catch(error => { failures.push(error); }); pending.add(promise); void promise.finally(() => pending.delete(promise)); }
    function tick() {
      if (mode === "before") track(oldProcessOutbox(prisma));
      else for (const lane of ["reply", "delivery"] as const) track(processOutbox(prisma, { lane }));
    }
    const timer = setInterval(tick, mode === "before" ? 5000 : 1000);
    tick();
    let acceptedAt = 0;
    try {
      while (performance.now() - start < 25000) {
        if (failures.length) throw failures[0];
        const result = await prisma.message.findFirst({ where: { conversationId: conversation.id, senderKind: "ai", operationState: "accepted" } });
        if (result) { assert.equal(result.text, reply); acceptedAt = performance.now(); break; }
        await sleep(40);
      }
      assert(acceptedAt, "Reply did not reach the synthetic website conversation");
    } finally { clearInterval(timer); await Promise.allSettled([...pending]); }
    assert.equal(requests.length, initialRequestCount + 1, "Only one model call is allowed");
    const model = requests.at(-1)!;
    return { mode, totalMs: Math.round(acceptedAt - start), beforeModelMs: Math.round(model.startedAt - start), modelMs: Math.round(model.completedAt - model.startedAt), afterModelMs: Math.round(acceptedAt - model.completedAt), requestHash: model.hash };
  }
  const before = await run("before"), after = await run("after");
  assert.equal(before.requestHash, after.requestHash, "The model must receive identical input and parameters");
  assert(after.totalMs < before.totalMs, "Fast queues should reduce non-model waiting");
  const result = {
    recordedAt: new Date().toISOString(), baselineCommit: readFileSync(new URL("baseline-commit.txt", import.meta.url), "utf8").trim(),
    environment: "Local macOS ARM, isolated PGlite, synthetic website conversation, fixed 2-second model mock; not a production/provider benchmark",
    sampling: "One run per queue implementation; poll phase begins at inbound enqueue; observation resolution about 40 ms",
    before, after, savedMs: before.totalMs - after.totalMs, sameModelRequest: true, sameReply: true,
  };
  writeFileSync(new URL("results.json", import.meta.url), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally { await prisma.$disconnect(); rmSync(scratch, { recursive: true, force: true }); }
