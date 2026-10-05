import assert from "node:assert/strict";
import { it } from "node:test";
import { envLlm } from "./services/runtimeSettings.ts";
import { whatsAppAiFailureReason } from "./services/whatsappAiService.ts";
import { attentionReasonLabel } from "./services/attentionReasons.ts";
import { INTEGRATION_IMPLEMENTATIONS } from "./services/platformCatalog.ts";

it("keeps each model provider's key, endpoint and model together when both are configured", () => {
  const keys = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "ANYMODEL_API_KEY", "ANYMODEL_BASE_URL", "ANYMODEL_MODEL"];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, { OPENAI_API_KEY: "openai-test-key", OPENAI_BASE_URL: "https://openai.test/v1", OPENAI_MODEL: "model-a",
      ANYMODEL_API_KEY: "anymodel-test-key", ANYMODEL_BASE_URL: "https://anymodel.test/v1", ANYMODEL_MODEL: "model-b" });
    assert.deepEqual(envLlm("openai"), { provider: "openai", apiKey: "openai-test-key", baseUrl: "https://openai.test/v1", model: "model-a" });
    assert.deepEqual(envLlm("anymodel"), { provider: "anymodel", apiKey: "anymodel-test-key", baseUrl: "https://anymodel.test/v1", model: "model-b" });
    assert.equal(envLlm().provider, "openai");
    delete process.env.OPENAI_API_KEY;
    assert.equal(envLlm("openai").apiKey, "");
    assert.equal(envLlm().provider, "anymodel");
    assert.equal(envLlm("unsupported").apiKey, "");
  } finally {
    for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
});

it("distinguishes safe failure reasons without exposing provider responses", () => {
  const expected = { http_401: "AI_PROVIDER_AUTH", http_429: "AI_PROVIDER_LIMIT", http_400: "AI_PROVIDER_CONFIG",
    ai_model_missing: "AI_MODEL_MISSING", ai_not_configured: "AI_PROMPT_MISSING", ai_credits_exhausted: "AI_CREDITS_EXHAUSTED" };
  for (const [code, reason] of Object.entries(expected)) {
    assert.equal(whatsAppAiFailureReason(code), reason);
    assert.notEqual(attentionReasonLabel(reason), "Ошибка AI");
  }
  assert.equal(whatsAppAiFailureReason("provider-secret-response"), "AI_PROVIDER_UNAVAILABLE");
});

it("offers all WhatsApp transports and reserves Green API credentials for Green API", () => {
  for (const type of ["whatsapp_seller", "whatsapp_qr", "whatsapp_cloud"]) {
    const item = INTEGRATION_IMPLEMENTATIONS.find(item => item.type === type);
    assert(item?.implementationReady);
    assert.equal(item.fields.includes("instanceId"), type === "whatsapp_seller");
  }
});

it("routes a company credential to its selected provider and requires a new key when changing providers", async () => {
  const { createPrismaClient } = await import("@creolab/db");
  const { saveTenantAiSettings } = await import("./services/platformIntegrationService.ts");
  const { getEffectiveLlmConfig, invalidateRuntimeConfig } = await import("./services/runtimeSettings.ts");
  const prisma = await createPrismaClient();
  try {
    const tenant = await prisma.tenant.create({ data: { name: "AI provider routing test", slug: "ai-provider-routing", status: "active" } });
    const admin = await prisma.user.create({ data: { email: "model-admin@example.test", name: "Model admin", passwordHash: "!", platformAdmin: true } });
    await saveTenantAiSettings(prisma, admin.id, tenant.id, { provider: "anymodel", model: "test-model-a", apiKey: "test-company-anymodel-key" });
    let config = await getEffectiveLlmConfig(prisma, tenant.id);
    assert.equal(config.provider, "anymodel"); assert.equal(config.apiKey, "test-company-anymodel-key");
    assert.equal(config.baseUrl, process.env.ANYMODEL_BASE_URL || "https://anymodel.org/v1");
    await assert.rejects(() => saveTenantAiSettings(prisma, admin.id, tenant.id, { provider: "openai" }), (error: any) => error.code === "ai_provider_key_required");
    assert.equal((await getEffectiveLlmConfig(prisma, tenant.id)).provider, "anymodel");
    await saveTenantAiSettings(prisma, admin.id, tenant.id, { provider: "openai", model: "test-model-b", apiKey: "test-company-openai-key" });
    config = await getEffectiveLlmConfig(prisma, tenant.id);
    assert.equal(config.provider, "openai"); assert.equal(config.apiKey, "test-company-openai-key");
    assert.equal(config.baseUrl, process.env.OPENAI_BASE_URL || "https://api.openai.com/v1");
    const other = await prisma.tenant.create({ data: { name: "Other company", slug: "ai-provider-other", status: "active" } });
    assert.notEqual((await getEffectiveLlmConfig(prisma, other.id)).apiKey, config.apiKey);
    const row = await prisma.aIConfiguration.findFirstOrThrow({ where: { tenantId: tenant.id } });
    await prisma.credential.update({ where: { id: row.credentialId! }, data: { encryptedValue: "unreadable-test-key" } });
    assert.equal((await getEffectiveLlmConfig(prisma, tenant.id)).apiKey, "");
  } finally { invalidateRuntimeConfig(); await prisma.$disconnect(); }
});
