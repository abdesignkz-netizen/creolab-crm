import assert from "node:assert/strict";
import { afterEach, beforeEach, it, mock } from "node:test";
import type { PrismaClient } from "@creolab/db";
import { ApiError } from "./errors.ts";
import { answerWhatsAppWithLlm, getWhatsAppReplyTimeoutMs, refineCommandWithLlm } from "./services/llmClient.ts";
import { invalidateRuntimeConfig } from "./services/runtimeSettings.ts";
import { VOICE_CLARIFICATION } from "./services/aiLanguagePolicy.ts";

const nativeFetch = globalThis.fetch;
const envKeys = ["ANYMODEL_API_KEY", "ANYMODEL_BASE_URL", "WHATSAPP_AI_REPLY_TIMEOUT_MS"];
let savedEnv: Record<string, string | undefined>;
let usage: Array<Record<string, any>>;
let charged: number;
let prisma: PrismaClient;
let timeouts: number[];
let deadlines: AbortController[];
const privateText = "PRIVATE-PROVIDER-KEY-AND-RESPONSE";
const success = (content: unknown = JSON.stringify({ reply: "Здравствуйте! Расскажите о презентации.", handoff: false }), finishReason = "stop") => Response.json({
  id: "request-test", choices: [{ message: { content }, finish_reason: finishReason }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
});

beforeEach(() => {
  savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  process.env.ANYMODEL_API_KEY = "unit-test-key";
  process.env.ANYMODEL_BASE_URL = "https://anymodel.example.test/v1";
  delete process.env.WHATSAPP_AI_REPLY_TIMEOUT_MS;
  usage = []; charged = 0; timeouts = []; deadlines = [];
  // Exercise the public client and usage classification without a database or
  // external provider. This legacy tenant needs no quota reservation.
  const tx = {
    tenant: { findUnique: async () => ({ status: "active", settingsJson: {} }) },
    tenantPlan: { findFirst: async () => null },
    tenantBillingOverride: { findUnique: async () => null },
    tenantUsage: { findUnique: async () => null },
    aIUsageEvent: {
      findFirst: async () => null,
      create: async ({ data }: any) => { usage.push(data); return { id: `usage-${usage.length}`, ...data }; },
    },
    $queryRaw: async (sql: TemplateStringsArray) => sql.join("").includes("basqar_resource_period") ? [{ period: "2026-10" }] : [],
    $executeRaw: async () => { charged += 1; return 1; },
  };
  prisma = {
    ...tx,
    $transaction: async (callback: (db: typeof tx) => unknown) => callback(tx),
    platformSetting: { findUnique: async () => null },
    aIConfiguration: { findFirst: async () => ({ provider: "anymodel", model: "cx/gpt-5.6-sol", enabled: true, promptStatus: "published", systemPrompt: "Помогайте клиентам с презентациями." }) },
    knowledgeDocument: { findMany: async () => [] },
    aIModelPricing: { count: async () => 1, findMany: async () => [] },
  } as unknown as PrismaClient;
  invalidateRuntimeConfig();
  mock.method(AbortSignal, "timeout", (ms: number) => {
    timeouts.push(ms);
    const controller = new AbortController(); deadlines.push(controller);
    return controller.signal;
  });
  globalThis.fetch = async () => success();
});

afterEach(() => {
  globalThis.fetch = nativeFetch;
  mock.restoreAll();
  invalidateRuntimeConfig();
  for (const key of envKeys) if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
});

const answer = (text = "Здравствуйте, хочу обсудить разработку презентации") => answerWhatsAppWithLlm({ prisma, tenantId: "tenant-test", history: [{ role: "user", content: text }] });
async function expectFailure(code: string) {
  await assert.rejects(answer, (error: unknown) => {
    assert(error instanceof ApiError);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /PRIVATE/);
    return true;
  });
  assert.equal(usage.at(-1)?.status, "failed");
  assert.equal(usage.at(-1)?.errorCode, code);
  assert.equal(charged, 0);
  assert.doesNotMatch(JSON.stringify(usage), /PRIVATE/);
}

it("allows a 90-second WhatsApp deadline and retains tenant provider settings", async () => {
  let request: RequestInit | undefined;
  globalThis.fetch = async (url, init) => { assert.equal(url, "https://anymodel.example.test/v1/chat/completions"); request = init; return success(); };
  assert.equal((await answer())?.reply, "Здравствуйте! Расскажите о презентации.");
  assert.deepEqual(timeouts, [90_000]);
  assert.equal(JSON.parse(String(request?.body)).model, "cx/gpt-5.6-sol");
  assert.equal(usage[0].status, "ok");
  assert.equal(charged, 1);
});

it("bounds the configurable timeout and defaults invalid values", async () => {
  for (const [value, expected] of [["", 90_000], ["bad", 90_000], ["Infinity", 90_000], ["0", 90_000], ["-10", 90_000], ["1", 10_000], ["60000.9", 60_000], ["999999", 120_000]] as const) {
    process.env.WHATSAPP_AI_REPLY_TIMEOUT_MS = value;
    assert.equal(getWhatsAppReplyTimeoutMs(), expected);
  }
  process.env.WHATSAPP_AI_REPLY_TIMEOUT_MS = "60000";
  await answer();
  assert.deepEqual(timeouts, [60_000]);
});

it("classifies a timeout before response headers without exposing the error", async () => {
  globalThis.fetch = async () => {
    const deadline = deadlines.at(-1)!;
    deadline.abort(new DOMException(privateText, "TimeoutError"));
    throw deadline.signal.reason;
  };
  await expectFailure("llm_timeout");
});

it("does not swallow a timeout while reading a successful response body", async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => {
    deadlines.at(-1)!.abort(new DOMException(privateText, "TimeoutError"));
    throw new DOMException(privateText, "AbortError");
  } }) as Response;
  await expectFailure("llm_timeout");
});

it("distinguishes network failures during fetch and body reading", async () => {
  globalThis.fetch = async () => { throw new TypeError(privateText); };
  await expectFailure("llm_network_error");
  globalThis.fetch = async () => ({ ok: true, json: async () => { throw new TypeError(privateText); } }) as Response;
  await expectFailure("llm_network_error");
});

it("preserves HTTP error codes even when the error body is not JSON", async () => {
  for (const status of [400, 401, 429, 500, 502, 503, 504]) {
    globalThis.fetch = async () => new Response(privateText, { status });
    await expectFailure(`http_${status}`);
  }
});

it("rejects malformed response envelopes and invalid WhatsApp JSON before charging", async () => {
  for (const response of [
    () => new Response(privateText),
    () => Response.json(null),
    () => Response.json([]),
    () => success({ reply: privateText }),
    () => success(privateText),
    () => success(JSON.stringify({ reply: "", handoff: false })),
    () => success(JSON.stringify({ reply: "   ", handoff: false })),
    () => success(JSON.stringify({ reply: "Здравствуйте", handoff: "false" })),
    () => success(JSON.stringify({ reply: "а".repeat(4001), handoff: false })),
  ]) {
    globalThis.fetch = async () => response();
    await expectFailure("ai_invalid_response");
  }
});

it("distinguishes empty completions from output-budget exhaustion", async () => {
  globalThis.fetch = async () => success("");
  await expectFailure("empty_completion");
  globalThis.fetch = async () => success(null, "length");
  await expectFailure("llm_output_limit");
  globalThis.fetch = async () => success('{"reply":"частичный', "length");
  await expectFailure("llm_output_limit");
});

it("keeps valid handoff and unclear-voice replies valid", async () => {
  globalThis.fetch = async () => success(JSON.stringify({ reply: "", handoff: true, reason: "staff_action" }));
  assert.deepEqual(await answer(), { reply: "", handoff: true });
  globalThis.fetch = async () => success(JSON.stringify({ reply: "", handoff: false, reason: "unclear_message" }));
  assert.deepEqual(await answer("[Расшифровка голосового сообщения]: неясно"), { reply: VOICE_CLARIFICATION, handoff: false });
  assert.equal(usage.every(row => row.status === "ok"), true);
});

it("preserves other callers' deadlines and JSON results", async () => {
  globalThis.fetch = async () => success('{"intent":"presentation"}');
  assert.deepEqual(await refineCommandWithLlm("Презентация", {}, { prisma, tenantId: "tenant-test" }), { intent: "presentation" });
  assert.deepEqual(timeouts, [12_000]);
});
