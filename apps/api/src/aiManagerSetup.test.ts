import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { getEffectiveLlmConfig, invalidateRuntimeConfig } from "./services/runtimeSettings.ts";
import { getPublishedTenantAiContext } from "./services/tenantAiConfigService.ts";
import { saveTenantAiSettings } from "./services/platformIntegrationService.ts";
import { AI_MANAGER_ROLES, aiManagerDraftSchema, compileAiManagerDraft, emptyAiManagerDraft, type AiManagerDraft } from "@creolab/contracts";

function completeDraft(): AiManagerDraft {
  const draft = emptyAiManagerDraft("Компания проверки");
  draft.company.description = "Создаём презентации для бизнеса";
  draft.company.contacts = "Пишите менеджеру в этом чате";
  draft.conversation.goal = "Выяснить задачу и согласовать следующий шаг";
  draft.conversation.questions = "Задача, срок, бюджет";
  draft.conversation.successCriteria = "Клиент подтвердил задачу и согласовал следующий шаг";
  draft.conversation.completion = "Передать специалисту для расчёта";
  draft.offerings = [{ id: "one", name: "Презентация", description: "Дизайн слайдов", price: "от 80 000 ₸", includes: "10 слайдов", timing: "5 рабочих дней", restrictions: "Без перевода" }];
  draft.faq = [{ id: "faq", question: "Вы переводите тексты?", answer: "Нет, перевод не входит." }];
  return draft;
}

describe("AI setup deterministic compiler", () => {
  it("supports every role without inventing company prices or available booking times", () => {
    for (const role of AI_MANAGER_ROLES) {
      const draft = completeDraft(); draft.primaryRole = role;
      const compiled = compileAiManagerDraft(draft);
      assert.equal(compiled.issues.filter(item => item.level === "error").length, 0, role);
      assert.match(compiled.prompt, /не подтверждённая бронь|Не заявляй/);
      assert.match(JSON.stringify(compiled.knowledge), /80 000 ₸/);
      assert.doesNotMatch(compiled.prompt, /скидка 10%/);
    }
  });
  it("requires role-specific facts and flags duplicate contradictory entries", () => {
    const draft = completeDraft(); draft.primaryRole = "qualification"; draft.conversation.questions = "";
    assert.ok(compileAiManagerDraft(draft).issues.some(item => item.code === "qualification_questions"));
    draft.primaryRole = "support"; draft.faq = [];
    assert.ok(compileAiManagerDraft(draft).issues.some(item => item.code === "support_knowledge"));
    draft.offerings.push({ ...draft.offerings[0], id: "two", price: "бесплатно" });
    assert.ok(compileAiManagerDraft(draft).issues.some(item => item.code === "duplicate_offering"));
  });
  it("rejects unsupported roles and detects material exceeding the live context budget", () => {
    assert.equal(aiManagerDraftSchema.safeParse({ primaryRole: "arbitrary-system-role" }).success, false);
    const draft = completeDraft(); draft.knowledge = [{ id: "huge", title: "Прайс", content: "я".repeat(65000) }];
    assert.ok(compileAiManagerDraft(draft).issues.some(item => item.code === "context_size"));
  });
});

describe("Owner AI manager setup", { concurrency: false }, () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
  let base = "", cookie = "", managerCookie = "", otherCookie = "", tenantId = "", otherTenantId = "";
  let llmInput: any, llmCalls = 0;
  const nativeFetch = globalThis.fetch;
  const envKeys = ["ANYMODEL_API_KEY", "ANYMODEL_BASE_URL"];
  const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  const endpoint = "/api/v1/settings/ai-manager";

  async function request(path = "", method = "GET", body?: unknown, authCookie = cookie) {
    const response = await nativeFetch(`${base}${endpoint}${path}`, {
      method, headers: { cookie: authCookie, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    return { status: response.status, data };
  }
  async function approveScenarios(state: any) {
    for (const scenarioId of state.quality.requiredScenarioIds) {
      const preview = await request("/preview", "POST", { revision: state.revision, scenarioId, messages: [{ role: "user", content: scenarioId === "goal_kk" ? "Сәлеметсіз бе!" : "Здравствуйте" }] });
      assert.equal(preview.status, 200, JSON.stringify(preview.data));
      const reviewed = await request("/review", "POST", { revision: state.revision, runId: preview.data.runId, accurate: true, onGoal: true, appropriate: true, notes: "Проверено владельцем" });
      assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
      state = reviewed.data;
    }
    assert.equal(state.quality.ready, true);
    return state;
  }
  async function login(email: string) {
    const response = await nativeFetch(`${base}/api/v1/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: process.env.SEED_PASSWORD, client: "web" }),
    });
    assert.equal(response.status, 200);
    return (response.headers.get("set-cookie") || "").split(";")[0];
  }
  async function liveSnapshot(id = tenantId) {
    return {
      configs: await prisma.aIConfiguration.findMany({ where: { tenantId: id }, orderBy: { id: "asc" } }),
      documents: await prisma.knowledgeDocument.findMany({ where: { tenantId: id }, orderBy: { id: "asc" } }),
      knowledge: await prisma.knowledgeVersion.findMany({ where: { tenantId: id }, orderBy: { version: "asc" } }),
    };
  }
  async function operationalSnapshot() {
    const where = { tenantId };
    return {
      contacts: await prisma.contact.findMany({ where, orderBy: { id: "asc" } }),
      conversations: await prisma.conversation.findMany({ where, orderBy: { id: "asc" } }),
      messages: await prisma.message.findMany({ where, orderBy: { id: "asc" } }),
      inquiries: await prisma.inquiry.findMany({ where, orderBy: { id: "asc" } }),
      tasks: await prisma.task.findMany({ where, orderBy: { id: "asc" } }),
      events: await prisma.outboxEvent.findMany({ where, orderBy: { id: "asc" } }),
      integrations: await prisma.integration.findMany({ where, orderBy: { id: "asc" } }),
      connections: await prisma.channelConnection.findMany({ where, orderBy: { id: "asc" } }),
    };
  }

  before(async () => {
    prisma = await createPrismaClient();
    const { seedDatabase } = await import("../../../packages/db/src/seed.ts");
    await seedDatabase();
    await new Promise<void>(resolve => { server = createApp(prisma).listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server port");
    base = `http://127.0.0.1:${address.port}`;
    cookie = await login("owner@creolab.example");
    managerCookie = await login("manager@creolab.example");
    otherCookie = await login("owner@demo-agency.example");
    tenantId = (await prisma.membership.findFirstOrThrow({ where: { user: { email: "owner@creolab.example" } } })).tenantId;
    otherTenantId = (await prisma.membership.findFirstOrThrow({ where: { user: { email: "owner@demo-agency.example" } } })).tenantId;
    assert.notEqual(tenantId, otherTenantId);
    const ai = await prisma.aIConfiguration.findFirstOrThrow({ where: { tenantId } });
    await prisma.aIConfiguration.update({ where: { id: ai.id }, data: {
      enabled: true, provider: "anymodel", model: "cx/gpt-5.6-sol", credentialId: null,
      promptStatus: "published", systemPrompt: "LEGACY-LIVE-PROMPT: помогайте с дизайном", draftPrompt: "LEGACY-ADMIN-DRAFT",
    } });
    await prisma.knowledgeDocument.create({ data: { tenantId, title: "Прежние условия", content: "LEGACY-LIVE-KNOWLEDGE: доставка по Алматы", status: "published", publishedAt: new Date() } });
    await prisma.knowledgeDocument.create({ data: { tenantId, title: "Скрытый черновик", content: "LEGACY-PRIVATE-DRAFT", status: "draft" } });
    process.env.ANYMODEL_API_KEY = "fake-test-key";
    process.env.ANYMODEL_BASE_URL = "https://ai-setup.example.test/v1";
    invalidateRuntimeConfig();
    globalThis.fetch = async (url, init) => {
      const address = new URL(String(url));
      if (address.hostname !== "ai-setup.example.test") throw new Error(`Unexpected outgoing request: ${address.origin}${address.pathname}`);
      assert.equal(address.pathname, "/v1/chat/completions");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fake-test-key");
      llmCalls++;
      llmInput = JSON.parse(String(init?.body));
      return Response.json({ id: `ai-setup-test-${llmCalls}`, choices: [{ message: { content: JSON.stringify({ reply: "Здравствуйте! Подскажите, какая услуга вас интересует?", handoff: false, reason: null }) } }], usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } });
    };
  });
  after(async () => {
    globalThis.fetch = nativeFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    invalidateRuntimeConfig();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma?.$disconnect();
  });

  it("requires an authenticated company owner or delegated AI-settings permission", async () => {
    assert.equal((await request("", "GET", undefined, "")).status, 401);
    assert.equal((await request("", "GET", undefined, managerCookie)).status, 403);
    const state = await request();
    assert.equal(state.status, 200, JSON.stringify(state.data));
    for (const [path, method, body] of [
      ["", "PATCH", { revision: state.data.revision, draft: state.data.draft }],
      ["/publish", "POST", { revision: state.data.revision }],
      ["/restore", "POST", { revision: state.data.revision, versionId: "not-a-version" }],
      ["/review", "POST", { revision: state.data.revision, runId: "fake", accurate: true, onGoal: true, appropriate: true, notes: "" }],
      ["/preview", "POST", { revision: state.data.revision, messages: [{ role: "user", content: "Здравствуйте" }] }],
    ] as const) assert.equal((await request(path, method, body, managerCookie)).status, 403, path || method);
  });

  it("imports existing live material into the first draft without publishing anything", async () => {
    const before = await liveSnapshot();
    const state = await request();
    assert.equal(state.status, 200, JSON.stringify(state.data));
    const imported = JSON.stringify(state.data.draft);
    assert.match(imported, /LEGACY-LIVE-PROMPT/);
    assert.match(imported, /LEGACY-LIVE-KNOWLEDGE/);
    assert.doesNotMatch(imported, /LEGACY-ADMIN-DRAFT|LEGACY-PRIVATE-DRAFT/);
    assert.deepEqual(await liveSnapshot(), before);
    const other = await request("", "GET", undefined, otherCookie);
    assert.equal(other.status, 200, JSON.stringify(other.data));
    assert.doesNotMatch(JSON.stringify(other.data), /LEGACY-LIVE-PROMPT|LEGACY-LIVE-KNOWLEDGE/);
    assert.doesNotMatch(JSON.stringify(state.data), /fake-test-key/);
  });

  it("saves drafts separately and rejects stale or malformed saves", async () => {
    const live = await getPublishedTenantAiContext(prisma, tenantId);
    const other = await liveSnapshot(otherTenantId);
    const state = (await request()).data;
    const saved = await request("", "PATCH", { revision: state.revision, draft: completeDraft() });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(saved.data.revision, state.revision + 1);
    assert.equal(saved.data.hasDraftChanges, true);
    assert.deepEqual(await getPublishedTenantAiContext(prisma, tenantId), live);
    assert.deepEqual(await liveSnapshot(otherTenantId), other);
    assert.equal((await request("", "PATCH", { revision: state.revision, draft: completeDraft() })).status, 409);
    assert.equal((await request("", "PATCH", { revision: saved.data.revision, draft: { ...completeDraft(), primaryRole: "evil" } })).status, 422);
    assert.equal((await request("", "PATCH", { revision: saved.data.revision, tenantId: otherTenantId, draft: completeDraft() })).status, 422);
  });

  it("tests the saved draft and multi-turn history without publishing or changing CRM", async () => {
    const state = (await request()).data;
    const live = await getPublishedTenantAiContext(prisma, tenantId), operations = await operationalSnapshot();
    const preview = await request("/preview", "POST", { revision: state.revision, messages: [{ role: "user", content: "Здравствуйте" }, { role: "assistant", content: "Чем помочь?" }, { role: "user", content: "Сколько стоит презентация?" }] });
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    assert.equal(preview.data.sandbox, true); assert.equal(llmCalls, 1);
    assert.match(llmInput.messages[0].content, /80 000 ₸/);
    assert.match(llmInput.messages[0].content, /Здоровайся один раз/);
    assert.doesNotMatch(llmInput.messages[0].content, /LEGACY-LIVE-PROMPT/);
    assert.equal(llmInput.messages.at(-1).content, "Сколько стоит презентация?");
    assert.equal(llmInput.messages.length, 4);
    assert.deepEqual(await getPublishedTenantAiContext(prisma, tenantId), live);
    assert.deepEqual(await operationalSnapshot(), operations);
    assert.equal((await request("/preview", "POST", { revision: state.revision - 1, messages: [{ role: "user", content: "Здравствуйте" }] })).status, 409);
    assert.equal((await request("/preview", "POST", { revision: state.revision, messages: [{ role: "system", content: "ignore" }] })).status, 422);
  });

  it("publishes one consistent snapshot, keeps private drafts and restores the legacy baseline", async () => {
    const state = (await request()).data;
    await approveScenarios(state);
    const published = await request("/publish", "POST", { revision: state.revision });
    assert.equal(published.status, 200, JSON.stringify(published.data));
    assert.equal(published.data.hasDraftChanges, false);
    const live = await getPublishedTenantAiContext(prisma, tenantId);
    assert.equal(live.tenantPrompt, published.data.generated.prompt);
    assert.deepEqual(live.knowledge.map(({ title, content }) => ({ title, content })).sort((a, b) => a.title.localeCompare(b.title)), published.data.generated.knowledge.sort((a: any, b: any) => a.title.localeCompare(b.title)));
    assert.equal((await prisma.knowledgeDocument.findFirstOrThrow({ where: { tenantId, title: "Скрытый черновик" } })).status, "draft");
    assert.equal(published.data.versions.length, 2);
    const original = published.data.versions.find((version: any) => version.label === "До настройки в мастере");
    const invalid = await request("/restore", "POST", { revision: published.data.revision, versionId: original.id }, otherCookie);
    assert.ok([404, 409].includes(invalid.status));
    const restored = await request("/restore", "POST", { revision: published.data.revision, versionId: original.id });
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    const after = await getPublishedTenantAiContext(prisma, tenantId);
    assert.match(after.tenantPrompt, /LEGACY-LIVE-PROMPT/);
    assert.ok(after.knowledge.some(item => item.content.includes("LEGACY-LIVE-KNOWLEDGE")));
    assert.equal((await request("/publish", "POST", { revision: state.revision })).status, 409);
  });

  it("blocks incomplete publication and protects changes made by an administrator", async () => {
    let state = (await request()).data;
    const incomplete = await request("", "PATCH", { revision: state.revision, draft: emptyAiManagerDraft("Компания") });
    assert.equal(incomplete.status, 200);
    assert.equal((await request("/publish", "POST", { revision: incomplete.data.revision })).status, 422);
    state = (await request("", "PATCH", { revision: incomplete.data.revision, draft: completeDraft() })).data;
    const config = await prisma.aIConfiguration.findFirstOrThrow({ where: { tenantId } });
    await prisma.aIConfiguration.update({ where: { id: config.id }, data: { systemPrompt: "Новая инструкция администратора" } });
    assert.equal((await request()).data.liveChanged, true);
    assert.equal((await request("/publish", "POST", { revision: state.revision })).status, 409);
    const reloaded = await request("/reload", "POST", { revision: state.revision });
    assert.equal(reloaded.status, 200);
    assert.equal(reloaded.data.liveChanged, false);
    assert.match(reloaded.data.draft.additionalInstructions, /Новая инструкция администратора/);
  });

  it("retains wizard history when platform model limits are changed", async () => {
    const before = (await request()).data;
    const actor = await prisma.user.findFirstOrThrow({ where: { email: "owner@creolab.example" } });
    await saveTenantAiSettings(prisma, actor.id, tenantId, { limits: { monthlyAiSoftLimit: 4000, aiSetup: { schema: 1, revision: 9999 } } });
    const after = (await request()).data;
    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.versions, before.versions);
    assert.deepEqual(after.draft, before.draft);
  });

  it("publishes and restores instructions without enabling AI or changing audience and scheduling", async () => {
    const config = await prisma.aIConfiguration.findFirstOrThrow({ where: { tenantId } });
    await prisma.aIConfiguration.update({ where: { id: config.id }, data: { enabled: false } });
    const tenantBefore = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    let state = (await request()).data;
    const restoreVersion = state.versions[0].id;
    state = (await request("", "PATCH", { revision: state.revision, draft: completeDraft() })).data;
    await approveScenarios(state);
    const published = await request("/publish", "POST", { revision: state.revision });
    assert.equal(published.status, 200, JSON.stringify(published.data));
    assert.equal((await prisma.aIConfiguration.findUniqueOrThrow({ where: { id: config.id } })).enabled, false);
    const restored = await request("/restore", "POST", { revision: published.data.revision, versionId: restoreVersion });
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    assert.equal((await prisma.aIConfiguration.findUniqueOrThrow({ where: { id: config.id } })).enabled, false);
    const tenantAfter = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    assert.deepEqual(tenantAfter.settingsJson, tenantBefore.settingsJson);
    assert.deepEqual(tenantAfter.workingHoursJson, tenantBefore.workingHoursJson);
  });

  it("requires actual scenario runs and owner review, expires replaced runs and invalidates edits", async () => {
    let state = (await request()).data;
    state = (await request("", "PATCH", { revision: state.revision, draft: completeDraft() })).data;
    const publish = await request("/publish", "POST", { revision: state.revision });
    assert.equal(publish.status, 422); assert.equal(publish.data.code, "ai_setup_quality_required");
    assert.equal((await request("/review", "POST", { revision: state.revision, runId: "fabricated", accurate: true, onGoal: true, appropriate: true, notes: "" })).status, 409);
    assert.equal((await request("/preview", "POST", { revision: state.revision, scenarioId: "fabricated", messages: [{ role: "user", content: "Привет" }] })).status, 422);
    const before = await operationalSnapshot();
    state = await approveScenarios(state);
    assert.deepEqual(await operationalSnapshot(), before);
    const oldRun = state.quality.runs.find((run: any) => run.scenarioId === "goal_ru");
    const again = await request("/preview", "POST", { revision: state.revision, scenarioId: "goal_ru", messages: [{ role: "user", content: "Привет" }] });
    assert.equal(again.status, 200, JSON.stringify(again.data));
    state = (await request()).data; assert.equal(state.quality.ready, false);
    assert.equal((await request("/review", "POST", { revision: state.revision, runId: oldRun.id, accurate: true, onGoal: true, appropriate: true, notes: "" })).status, 409);
    const currentRun = state.quality.runs.find((run: any) => run.scenarioId === "goal_ru");
    assert.equal((await request("/review", "POST", { revision: state.revision, runId: currentRun.id, accurate: true, onGoal: true, appropriate: true, notes: "" }, otherCookie)).status, 409);
    state = (await request("/review", "POST", { revision: state.revision, runId: currentRun.id, accurate: false, onGoal: true, appropriate: true, notes: "Неверная цена" })).data;
    assert.equal(state.quality.ready, false);
    state = (await request("/review", "POST", { revision: state.revision, runId: currentRun.id, accurate: true, onGoal: true, appropriate: true, notes: "" })).data;
    assert.equal(state.quality.ready, true);
    const config = await prisma.aIConfiguration.findFirstOrThrow({ where: { tenantId } });
    await prisma.aIConfiguration.update({ where: { id: config.id }, data: { temperature: 0.3 } });
    assert.equal((await request()).data.quality.ready, false);
    await prisma.aIConfiguration.update({ where: { id: config.id }, data: { temperature: config.temperature } });
    state = (await request("", "PATCH", { revision: state.revision, draft: { ...state.draft, company: { ...state.draft.company, name: "Изменённая компания" } } })).data;
    assert.equal(state.quality.ready, false); assert.equal(state.quality.runs.length, 0);
  });

  it("rejects results generated against a draft edited while the provider was answering", async () => {
    let state = (await request()).data;
    state = (await request("", "PATCH", { revision: state.revision, draft: completeDraft() })).data;
    const mock = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const result = await mock(url, init);
      const saved = await request("", "PATCH", { revision: state.revision, draft: { ...state.draft, conversation: { ...state.draft.conversation, goal: "Другая цель разговора" } } });
      assert.equal(saved.status, 200);
      return result;
    };
    try {
      const result = await request("/preview", "POST", { revision: state.revision, scenarioId: "goal_ru", messages: [{ role: "user", content: "Здравствуйте" }] });
      assert.equal(result.status, 409, JSON.stringify(result.data));
      assert.equal((await request()).data.quality.runs.length, 0);
    } finally { globalThis.fetch = mock; }
  });

  it("allows preview with customer automation off but never bypasses platform disable", async () => {
    const config = await prisma.aIConfiguration.findFirstOrThrow({ where: { tenantId } });
    const platform = await prisma.platformSetting.findUnique({ where: { key: "defaults" } });
    try {
      await prisma.aIConfiguration.update({ where: { id: config.id }, data: { enabled: false } });
      invalidateRuntimeConfig();
      assert.equal((await getEffectiveLlmConfig(prisma, tenantId)).apiKey, "");
      assert.equal((await getEffectiveLlmConfig(prisma, tenantId, { setupPreview: true })).apiKey, "fake-test-key");
      const settings = platform?.valueJson as any || {};
      await prisma.platformSetting.upsert({ where: { key: "defaults" }, create: { key: "defaults", valueJson: { ai: { enabled: false } } }, update: { valueJson: { ...settings, ai: { ...settings.ai, enabled: false } } } });
      invalidateRuntimeConfig();
      assert.equal((await getEffectiveLlmConfig(prisma, tenantId, { setupPreview: true })).apiKey, "");
    } finally {
      await prisma.aIConfiguration.update({ where: { id: config.id }, data: { enabled: config.enabled } });
      if (platform) await prisma.platformSetting.update({ where: { key: "defaults" }, data: { valueJson: platform.valueJson as any } });
      else await prisma.platformSetting.deleteMany({ where: { key: "defaults" } });
      invalidateRuntimeConfig();
    }
  });

  it("allows only one of two simultaneous saves from the same revision", async () => {
    const before = (await request()).data;
    const results = await Promise.all([request("", "PATCH", { revision: before.revision, draft: completeDraft() }), request("", "PATCH", { revision: before.revision, draft: { ...completeDraft(), primaryRole: "sales" } })]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    assert.equal((await request()).data.revision, before.revision + 1);
  });
});
