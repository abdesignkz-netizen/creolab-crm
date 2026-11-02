import assert from "node:assert/strict";
import { after, before, it, mock } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { recordAiUsage } from "./services/aiUsageService.ts";
import { refineCommandWithLlm } from "./services/llmClient.ts";

let db: Awaited<ReturnType<typeof createPrismaClient>>;
before(async () => {
  db = await createPrismaClient();
  await db.aIModelPricing.createMany({ data: [
    { provider: "openai", model: "a0-priced-fixture", pricingVersion: "fixture", inputPerMillion: 2, outputPerMillion: 8, cachedInputPerMillion: 0.5, effectiveFrom: new Date(0) },
    { provider: "openai", model: "a0-no-cache-price", pricingVersion: "fixture", inputPerMillion: 2, outputPerMillion: 8, effectiveFrom: new Date(0) },
  ] });
});
after(async () => { mock.restoreAll(); await db.$disconnect(); });
const input = { provider: "openai", model: "a0-priced-fixture", feature: "AI_CRM_COMMAND", status: "ok" as const };

it("the chat adapter treats cached tokens as part of prompt tokens, including fallback totals", async () => {
  const priorKey = process.env.OPENAI_API_KEY, priorModel = process.env.OPENAI_MODEL;
  process.env.OPENAI_API_KEY = "fixture-not-a-real-key"; process.env.OPENAI_MODEL = input.model;
  const fetcher = mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    id: "a0-cache-response", choices: [{ message: { content: JSON.stringify({ intent: "query" }) } }],
    usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 600 } },
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  try {
    assert.deepEqual(await refineCommandWithLlm("Задачи", {}, { prisma: db }), { intent: "query" });
    const event = await db.aIUsageEvent.findFirstOrThrow({ where: { providerRequestId: "a0-cache-response" } });
    assert.equal(event.inputTokens, 1000); assert.equal(event.cachedInputTokens, 600); assert.equal(event.totalTokens, 1100);
    assert.equal(Number(event.inputCost), 0.0008); assert.equal(Number(event.cachedInputCost), 0.0003);
    assert.equal(Number(event.outputCost), 0.0008); assert.equal(Number(event.totalCost), 0.0019);
    assert.equal(fetcher.mock.callCount(), 1);
  } finally {
    fetcher.mock.restore();
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = priorKey;
    if (priorModel === undefined) delete process.env.OPENAI_MODEL; else process.env.OPENAI_MODEL = priorModel;
  }
});

it("without a cached rate the input is billed once at the normal rate", async () => {
  const event = await recordAiUsage(db, { ...input, model: "a0-no-cache-price", inputTokens: 1000, cachedInputTokens: 600, outputTokens: 100, totalTokens: 1100 });
  assert.ok(event); assert.equal(event.totalTokens, 1100); assert.equal(Number(event.totalCost), 0.0028);
  assert.equal(Number(event.cachedInputUnitPrice), 2, "the recorded price matches the fallback actually used");
  const noCache = await recordAiUsage(db, { ...input, inputTokens: 1000, outputTokens: 100 });
  assert.ok(noCache); assert.equal(Number(noCache.totalCost), 0.0028);
});

it("invalid cache counters cannot overbill, create negative cost, or prevent usage recording", async () => {
  const clamped = await recordAiUsage(db, { ...input, inputTokens: 100, outputTokens: 10, cachedInputTokens: 500 });
  assert.ok(clamped); assert.equal(clamped.cachedInputTokens, 100); assert.equal(clamped.totalTokens, 110); assert.equal(Number(clamped.inputCost), 0);
  const invalid = await recordAiUsage(db, { ...input, inputTokens: -1, outputTokens: 10, cachedInputTokens: NaN, totalTokens: Infinity });
  assert.ok(invalid); assert.equal(invalid.inputTokens, null); assert.equal(invalid.cachedInputTokens, null); assert.equal(invalid.totalTokens, 10);
});
