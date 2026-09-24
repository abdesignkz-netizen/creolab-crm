import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { WhatsAppSellerBridge } from "@creolab/integrations";
import { createApp } from "./app.ts";
import { decryptSecret } from "./lib/secretBox.ts";
import type { AuthContext } from "./lib/types.ts";
import { sharedAiManagerUrl } from "./services/aiManagerConfig.ts";
import { setGreenApiFetchForTests } from "./services/greenApiWebhook.ts";
import { recordAiUsage, listPlatformAiUsage } from "./services/aiUsageService.ts";
import {
  getPublishedTenantAiContext,
  buildTenantAiSystemPreamble,
  getTenantAiManagerAdmin,
  saveTenantAiPrompt,
  syncTenantAiToWhatsApp,
  searchTenantKnowledge,
  upsertTenantKnowledgeDocument,
} from "./services/tenantAiConfigService.ts";
import {
  connectWhatsAppSeller,
  ingestSellerBridgeEvent,
  resolveSellerBridge,
  sellerHealthFor,
} from "./services/sellerLink.ts";

describe("shared AI Manager SaaS", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let platformAuth: AuthContext;
  let ownerAuth: AuthContext;
  let tenantA: string;
  let tenantB: string;
  let server: { close: (cb?: (err?: Error) => void) => void; address: () => { port: number } | string | null };
  let url = "";
  let platformCookie = "";
  let ownerCookie = "";
  const registerCalls: Array<{ input: Record<string, unknown>; serviceSecret?: string; bearerSecret?: string }> = [];
  const healthSecrets: string[] = [];

  async function login(email: string) {
    const response = await fetch(`${url}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: process.env.SEED_PASSWORD, client: "web" }),
    });
    assert.equal(response.status, 200, await response.text());
    let cookie = response.headers.getSetCookie?.()?.[0]?.split(";")[0] || "";
    if (!cookie) cookie = (response.headers.get("set-cookie") || "").split(";")[0];
    return cookie;
  }

  before(async () => {
    process.env.SEED_PASSWORD ||= "ChangeMeLocal1!";
    process.env.AI_MANAGER_URL = "https://ai.basqar.test";
    process.env.INTERNAL_SERVICE_SECRET = "internal-service-secret";
    process.env.CRM_BRIDGE_SECRET = "global-bridge-secret";
    prisma = await createPrismaClient();
    const { seedDatabase } = await import("../../../packages/db/src/seed.ts");
    await seedDatabase();
    const platformUser = await prisma.user.findFirstOrThrow({ where: { email: "platform@creolab.example" } });
    const ownerMembership = await prisma.membership.findFirstOrThrow({
      where: { role: "owner", tenant: { slug: "creolab" } },
      include: { user: true, tenant: true },
    });
    platformAuth = { user: platformUser, activeMembership: null } as AuthContext;
    ownerAuth = { user: ownerMembership.user, activeMembership: ownerMembership } as unknown as AuthContext;
    tenantA = ownerMembership.tenantId;
    const other = await prisma.tenant.create({ data: { name: "Tenant B", slug: `tenant-b-${Date.now()}` } });
    tenantB = other.id;
    setGreenApiFetchForTests(async () => new Response(JSON.stringify({ saveSettings: true }), { status: 200 }));
    mock.method(WhatsAppSellerBridge.prototype, "health", async function health(this: { secret?: string }) {
      if (this?.secret) healthSecrets.push(this.secret);
      return { ok: true, sender: "+7701" };
    });
    mock.method(
      WhatsAppSellerBridge.prototype,
      "registerIntegration",
      async function registerIntegration(
        this: { secret?: string },
        input: { integrationId: string; integrationSecret?: string; prompt?: string; knowledge?: string; crmEventsUrl?: string },
        options?: { serviceSecret?: string },
      ) {
        registerCalls.push({
          input: input as unknown as Record<string, unknown>,
          serviceSecret: options?.serviceSecret,
          bearerSecret: this?.secret,
        });
        return { ok: true, integration: { webhookToken: `hook-${input.integrationId}`, integrationId: input.integrationId } };
      },
    );
    mock.method(WhatsAppSellerBridge.prototype, "listLeads", async () => ({ leads: [] }));
    const app = createApp(prisma);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve()) as typeof server;
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    url = `http://127.0.0.1:${addr.port}`;
    platformCookie = await login("platform@creolab.example");
    ownerCookie = await login("owner@creolab.example");
  });

  after(async () => {
    delete process.env.AI_MANAGER_URL;
    delete process.env.INTERNAL_SERVICE_SECRET;
    delete process.env.CRM_BRIDGE_SECRET;
    setGreenApiFetchForTests(null);
    mock.restoreAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("uses one shared AI_MANAGER_URL for several tenants and hides it from tenant health", async () => {
    const first = await connectWhatsAppSeller(prisma, ownerAuth, { instanceId: "111", apiToken: "token-a" });
    assert.equal(first.ok, true);
    assert.ok(first.bridgeSecret);
    const tenantBOwner = await prisma.user.create({
      data: {
        email: `owner-b-${Date.now()}@example.test`,
        passwordHash: (ownerAuth.user as { passwordHash?: string }).passwordHash || "x",
        name: "B",
        memberships: { create: { tenantId: tenantB, role: "owner", permissions: ["manage_integrations"] } },
      },
      include: { memberships: { include: { tenant: true } } },
    });
    const authB = {
      user: tenantBOwner,
      activeMembership: { ...tenantBOwner.memberships[0], user: tenantBOwner },
    } as unknown as AuthContext;
    const second = await connectWhatsAppSeller(prisma, authB, { instanceId: "222", apiToken: "token-b" });
    const rowA = await prisma.integration.findFirstOrThrow({ where: { id: first.integrationId } });
    const rowB = await prisma.integration.findFirstOrThrow({ where: { id: second.integrationId } });
    const schemaA = rowA.schemaJson as { sellerUrl?: string; secretEnc?: string; instanceId?: string };
    const schemaB = rowB.schemaJson as { sellerUrl?: string; secretEnc?: string; instanceId?: string };
    assert.equal(schemaA.sellerUrl, sharedAiManagerUrl());
    assert.equal(schemaB.sellerUrl, sharedAiManagerUrl());
    assert.equal(schemaA.instanceId, "111");
    assert.equal(schemaB.instanceId, "222");
    assert.notEqual(decryptSecret(schemaA.secretEnc || ""), decryptSecret(schemaB.secretEnc || ""));
    assert.notEqual(decryptSecret(schemaA.secretEnc || ""), "global-bridge-secret");
    assert.equal(schemaA.webhookToken, `hook-${first.integrationId}`);
    assert.equal(schemaA.webhookUrl, `https://ai.basqar.test/webhook/hook-${first.integrationId}`);
    assert.equal(schemaB.webhookUrl, `https://ai.basqar.test/webhook/hook-${second.integrationId}`);
    assert.equal(registerCalls.length >= 2, true);
    assert.equal(registerCalls[0].serviceSecret, "internal-service-secret");
    assert.equal(registerCalls[0].bearerSecret, "internal-service-secret");
    assert.equal(registerCalls[0].input.integrationSecret, decryptSecret(schemaA.secretEnc || ""));
    assert.ok(String(registerCalls[0].input.prompt || "").includes("Базовые правила BasQar"));
    assert.ok(String(registerCalls[0].input.knowledge || "").length > 0);
    assert.ok(healthSecrets.includes(decryptSecret(schemaA.secretEnc || "")));
    assert.ok(!healthSecrets.includes("global-bridge-secret"));
    const health = await sellerHealthFor(prisma, ownerAuth);
    assert.equal((health as { sellerUrl?: string }).sellerUrl, undefined);
    const resolvedA = await resolveSellerBridge(prisma, tenantA);
    const resolvedB = await resolveSellerBridge(prisma, tenantB);
    assert.equal(resolvedA.url, "https://ai.basqar.test");
    assert.equal(resolvedB.url, "https://ai.basqar.test");
  });

  it("resolves webhook tenant by integration secret and rejects cross-tenant attempts", async () => {
    const rowA = await prisma.integration.findFirstOrThrow({ where: { tenantId: tenantA, type: "whatsapp_seller" } });
    const rowB = await prisma.integration.findFirstOrThrow({ where: { tenantId: tenantB, type: "whatsapp_seller" } });
    const secretA = decryptSecret(String((rowA.schemaJson as { secretEnc?: string }).secretEnc));
    const secretB = decryptSecret(String((rowB.schemaJson as { secretEnc?: string }).secretEnc));
    const accepted = await ingestSellerBridgeEvent(
      prisma,
      { type: "message.received", leadId: "LEAD-A-1", clientPhone: "+77011111111", clientName: "A" },
      { secret: secretA, integrationId: rowA.id },
    );
    assert.equal(accepted.tenantId, tenantA);
    const convA = await prisma.conversation.findFirst({ where: { tenantId: tenantA, sellerLeadId: "LEAD-A-1" } });
    assert.ok(convA);
    await assert.rejects(
      () =>
        ingestSellerBridgeEvent(
          prisma,
          { type: "message.received", leadId: "LEAD-B-1", clientPhone: "+77012222222" },
          { secret: secretA, integrationId: rowB.id },
        ),
      (error: { status?: number }) => error.status === 401,
    );
    await assert.rejects(
      () => ingestSellerBridgeEvent(prisma, { leadId: "LEAD-X" }, { secret: "wrong-secret", integrationId: rowA.id }),
      (error: { status?: number }) => error.status === 401,
    );
    await ingestSellerBridgeEvent(
      prisma,
      { type: "message.received", leadId: "LEAD-B-1", clientPhone: "+77012222222", clientName: "B" },
      { secret: secretB, integrationId: rowB.id },
    );
    await ingestSellerBridgeEvent(
      prisma,
      {
        type: "ai.usage",
        provider: "openai",
        model: "gpt-4o-mini",
        providerRequestId: "usage-a-1",
        inputTokens: 11,
        outputTokens: 4,
      },
      { secret: secretA, integrationId: rowA.id },
    );
    const usageA = await prisma.aIUsageEvent.findFirst({ where: { providerRequestId: "usage-a-1" } });
    assert.equal(usageA?.tenantId, tenantA);
    assert.equal(usageA?.integrationId, rowA.id);
    assert.ok(Number(usageA?.totalCost || 0) > 0);
    const again = await ingestSellerBridgeEvent(
      prisma,
      { type: "ai.usage", provider: "openai", model: "gpt-4o-mini", providerRequestId: "usage-a-1", inputTokens: 11, outputTokens: 4 },
      { secret: secretA, integrationId: rowA.id },
    );
    assert.equal(again.usage, true);
    assert.equal(await prisma.aIUsageEvent.count({ where: { providerRequestId: "usage-a-1" } }), 1);
    await assert.rejects(
      () =>
        ingestSellerBridgeEvent(
          prisma,
          { type: "ai.usage", provider: "openai", model: "gpt-4o-mini", providerRequestId: "usage-x", inputTokens: 1, outputTokens: 1 },
          { secret: secretA, integrationId: rowB.id },
        ),
      (error: { status?: number }) => error.status === 401,
    );
    await assert.rejects(
      () =>
        ingestSellerBridgeEvent(
          prisma,
          { type: "message.received", leadId: "LEAD-B-1", clientPhone: "+77012222222" },
          { secret: secretA, integrationId: rowA.id },
        ),
      (error: { status?: number }) => error.status === 403,
    );
  });

  it("records AI Manager and CRM usage with tokens, cost, and no double-count", async () => {
    const first = await recordAiUsage(prisma, {
      tenantId: tenantA,
      integrationId: "int-a",
      conversationId: "conv-a",
      provider: "openai",
      model: "gpt-4o-mini",
      feature: "AI_MANAGER_REPLY",
      providerRequestId: "req-1",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      status: "ok",
    });
    const duplicate = await recordAiUsage(prisma, {
      tenantId: tenantA,
      provider: "openai",
      model: "gpt-4o-mini",
      feature: "AI_MANAGER_REPLY",
      providerRequestId: "req-1",
      inputTokens: 100,
      outputTokens: 50,
      status: "ok",
    });
    assert.equal(first?.id, duplicate?.id);
    assert.equal(first?.pricingMissing, false);
    assert.ok(Number(first?.totalCost || 0) > 0);
    const command = await recordAiUsage(prisma, {
      tenantId: tenantA,
      provider: "openai",
      model: "gpt-4o-mini",
      feature: "AI_CRM_COMMAND",
      providerRequestId: "req-cmd-1",
      inputTokens: 20,
      outputTokens: 10,
      status: "ok",
    });
    assert.equal(command?.feature, "AI_CRM_COMMAND");
    const missing = await recordAiUsage(prisma, {
      tenantId: tenantA,
      provider: "openai",
      model: "unknown-model-xyz",
      feature: "AI_SUMMARY",
      providerRequestId: "req-miss",
      inputTokens: 10,
      outputTokens: 4,
      status: "ok",
    });
    assert.equal(missing?.pricingMissing, true);
    assert.equal(missing?.totalCost, null);
    const failed = await recordAiUsage(prisma, {
      tenantId: tenantA,
      provider: "openai",
      model: "gpt-4o-mini",
      feature: "AI_MANAGER_REPLY",
      status: "failed",
      errorCode: "http_500",
    });
    assert.equal(failed?.inputTokens, null);
    assert.equal(failed?.totalCost, null);
    const orig = prisma.aIUsageEvent.create.bind(prisma.aIUsageEvent);
    prisma.aIUsageEvent.create = (async () => {
      throw new Error("telemetry down");
    }) as typeof prisma.aIUsageEvent.create;
    try {
      const ignored = await recordAiUsage(prisma, {
        tenantId: tenantA,
        provider: "openai",
        model: "gpt-4o-mini",
        feature: "AI_OTHER",
        status: "ok",
        inputTokens: 1,
        outputTokens: 1,
      });
      assert.equal(ignored, null);
    } finally {
      prisma.aIUsageEvent.create = orig;
    }
  });

  it("keeps prompt and knowledge tenant-scoped; draft is unused until publish", async () => {
    await saveTenantAiPrompt(prisma, platformAuth, tenantA, { draftPrompt: "Prompt A draft", publish: false });
    await saveTenantAiPrompt(prisma, platformAuth, tenantB, { draftPrompt: "Prompt B published", publish: true });
    const draftA = await getPublishedTenantAiContext(prisma, tenantA);
    assert.equal(draftA.tenantPrompt.includes("Prompt A draft"), false);
    assert.match(draftA.tenantPrompt, /CreoLab/i);
    await saveTenantAiPrompt(prisma, platformAuth, tenantA, { draftPrompt: "Prompt A published", publish: true });
    const publishedA = await getPublishedTenantAiContext(prisma, tenantA);
    const publishedB = await getPublishedTenantAiContext(prisma, tenantB);
    assert.equal(publishedA.tenantPrompt, "Prompt A published");
    assert.equal(publishedB.tenantPrompt, "Prompt B published");
    assert.ok(!publishedA.tenantPrompt.includes("Prompt B"));
    await upsertTenantKnowledgeDocument(prisma, platformAuth, tenantA, {
      title: "Прайс A",
      content: "Массаж стоит 10000",
      publish: true,
    });
    await upsertTenantKnowledgeDocument(prisma, platformAuth, tenantB, {
      title: "Прайс B",
      content: "Секретная цена 999",
      publish: true,
    });
    const hitsA = await searchTenantKnowledge(prisma, platformAuth, tenantA, "массаж");
    assert.ok(hitsA.items.some((item) => item.title === "Прайс A"));
    assert.ok(!hitsA.items.some((item) => item.title === "Прайс B"));
    await assert.rejects(() => getTenantAiManagerAdmin(prisma, ownerAuth, tenantA), (error: { status?: number }) => error.status === 403);
  });

  it("loads Creolab acting WhatsApp prompt and knowledge into the creolab tenant", async () => {
    const { readCreolabAiManagerDefaults } = await import("../../../packages/db/src/creolabAiManagerDefaults.ts");
    const defaults = readCreolabAiManagerDefaults();
    assert.match(defaults.prompt, /AI-менеджер по продажам компании CreoLab/);
    assert.match(defaults.knowledge, /50 000/);
    const docs = await prisma.knowledgeDocument.findMany({ where: { tenantId: tenantA } });
    const kb = docs.find((item) => item.title === "База знаний CreoLab");
    assert.ok(kb);
    assert.match(kb.content, /экспресс-сайт/i);
    assert.equal(kb.status, "published");
  });

  it("sends the complete published knowledge beyond 20000 characters and 40 documents", async () => {
    const tail = "FINAL_KNOWLEDGE_FACT_53";
    const content = "Полная база знаний. ".repeat(1600) + tail;
    const published = await upsertTenantKnowledgeDocument(prisma, platformAuth, tenantA, {
      title: "Полная база", content, publish: true,
    });
    assert.ok(content.length > 20000);
    const registration = registerCalls.at(-1)!;
    assert.ok(String(registration.input.knowledge).includes(content));
    assert.ok(String(registration.input.knowledge).includes(tail));
    assert.ok(published.activation.knowledge.live);
    assert.equal(published.activation.delivery?.knowledgeCharacters, String(registration.input.knowledge).length);
    await prisma.knowledgeDocument.createMany({ data: Array.from({ length: 41 }, (_, index) => ({
      tenantId: tenantA, title: `Fact ${index}`, content: `UNIQUE_FACT_${index}`, status: "published",
    })) });
    const context = await getPublishedTenantAiContext(prisma, tenantA);
    assert.ok(context.knowledge.length > 40);
    const { tenantAiManagerRegisterPayload } = await import("./services/aiManagerRegistration.ts");
    const payload = await tenantAiManagerRegisterPayload(prisma, tenantA);
    assert.ok(payload.knowledge.includes(content));
    for (let index = 0; index < 41; index++) assert.ok(payload.knowledge.includes(`UNIQUE_FACT_${index}`));
    assert.ok(buildTenantAiSystemPreamble(context).includes(content));
    assert.ok(!payload.knowledge.includes("Секретная цена 999"));
  });

  it("records the sent version when the prompt changes during registration", async () => {
    const before = await getPublishedTenantAiContext(prisma, tenantA);
    const registration = mock.method(WhatsAppSellerBridge.prototype, "registerIntegration", async (input: { integrationId: string; prompt?: string }) => {
      assert.ok(input.prompt?.includes(before.tenantPrompt));
      await prisma.aIConfiguration.updateMany({ where: { tenantId: tenantA }, data: { systemPrompt: "Changed during registration", promptStatus: "published" } });
      return { ok: true, integration: { webhookToken: `hook-${input.integrationId}`, integrationId: input.integrationId } };
    });
    try {
      const result = await syncTenantAiToWhatsApp(prisma, platformAuth, tenantA);
      assert.equal(result.activation.prompt.live, false);
      assert.match(result.activation.prompt.reason, /более новая версия/);
    } finally { registration.mock.restore(); }
  });

  it("does not mark a rejected registration as applied", async () => {
    const registration = mock.method(WhatsAppSellerBridge.prototype, "registerIntegration", async () => ({ ok: false }));
    try {
      const result = await saveTenantAiPrompt(prisma, platformAuth, tenantA, { draftPrompt: "Rejected registration version", publish: true });
      assert.equal(result.activation.prompt.live, false);
    } finally { registration.mock.restore(); }
  });

  it("stores each client WhatsApp prompt and knowledge in service admin", async () => {
    const listed = await fetch(`${url}/api/v1/admin/ai-managers`, { headers: { cookie: platformCookie } });
    assert.equal(listed.status, 200);
    const listedBody = await listed.json();
    assert.ok(Array.isArray(listedBody.items));
    assert.ok(listedBody.items.some((row: { tenantId: string }) => row.tenantId === tenantA || row.tenantId === tenantB));
    const ownerListed = await fetch(`${url}/api/v1/admin/ai-managers`, { headers: { cookie: ownerCookie } });
    assert.equal(ownerListed.status, 403);
    const saved = await fetch(`${url}/api/v1/admin/tenants/${tenantB}/ai-manager/prompt`, {
      method: "PATCH",
      headers: { cookie: platformCookie, "content-type": "application/json" },
      body: JSON.stringify({ draftPrompt: "Ты менеджер компании Tenant B. Цены только из базы знаний.", publish: true }),
    });
    assert.equal(saved.status, 200);
    const knowledge = await fetch(`${url}/api/v1/admin/tenants/${tenantB}/ai-manager/knowledge`, {
      method: "POST",
      headers: { cookie: platformCookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Услуги B", content: "Консультация 15 000 тенге", sourceType: "faq", publish: true }),
    });
    assert.equal(knowledge.status, 201);
    const detail = await fetch(`${url}/api/v1/admin/tenants/${tenantB}/ai-manager`, { headers: { cookie: platformCookie } });
    assert.equal(detail.status, 200);
    const detailBody = await detail.json();
    assert.match(String(detailBody.prompt?.published || ""), /Цены только из базы знаний/);
    assert.ok((detailBody.knowledge || []).some((item: { title: string }) => item.title === "Услуги B"));
    const listedAgain = await fetch(`${url}/api/v1/admin/ai-managers`, { headers: { cookie: platformCookie } });
    const againBody = await listedAgain.json();
    const row = (againBody.items || []).find((item: { tenantId: string }) => item.tenantId === tenantB);
    assert.equal(row?.promptReady, true);
    assert.ok(row?.knowledgeCount >= 1);
    assert.equal(detailBody.activation?.prompt?.live, true);
    assert.equal(detailBody.activation?.knowledge?.live, true);
    assert.match(String(detailBody.activation?.prompt?.label || ""), /Активен в WhatsApp/);
    assert.match(String(detailBody.activation?.knowledge?.label || ""), /Активна в WhatsApp/);
    assert.equal(row?.promptLive, true);
    assert.equal(row?.knowledgeLive, true);
    assert.match(String(row?.promptActivation?.label || ""), /Активен в WhatsApp/);

    const orphan = await prisma.tenant.create({ data: { name: "No WhatsApp", slug: `no-wa-${Date.now()}` } });
    const orphanSaved = await fetch(`${url}/api/v1/admin/tenants/${orphan.id}/ai-manager/prompt`, {
      method: "PATCH",
      headers: { cookie: platformCookie, "content-type": "application/json" },
      body: JSON.stringify({ draftPrompt: "Промт без WhatsApp", publish: true }),
    });
    assert.equal(orphanSaved.status, 200);
    const orphanBody = await orphanSaved.json();
    assert.equal(orphanBody.activation?.prompt?.live, false);
    assert.match(String(orphanBody.activation?.prompt?.label || ""), /Не активен в WhatsApp/);
    assert.match(String(orphanBody.activation?.prompt?.reason || ""), /не подключ/i);
    const orphanListed = await fetch(`${url}/api/v1/admin/ai-managers`, { headers: { cookie: platformCookie } });
    const orphanList = await orphanListed.json();
    const orphanRow = (orphanList.items || []).find((item: { tenantId: string }) => item.tenantId === orphan.id);
    assert.equal(orphanRow?.promptLive, false);
    assert.match(String(orphanRow?.promptActivation?.label || ""), /Не активен в WhatsApp/);
    const ownerSync = await fetch(`${url}/api/v1/admin/tenants/${tenantB}/ai-manager/sync`, {
      method: "POST",
      headers: { cookie: ownerCookie },
    });
    assert.equal(ownerSync.status, 403);
    const platformSync = await fetch(`${url}/api/v1/admin/tenants/${tenantB}/ai-manager/sync`, {
      method: "POST",
      headers: { cookie: platformCookie },
    });
    assert.equal(platformSync.status, 200);
    const syncBody = await platformSync.json();
    assert.equal(syncBody.activation?.prompt?.live, true);
  });

  it("forbids tenant admin from AI usage and allows platform admin", async () => {
    const forbidden = await fetch(`${url}/api/v1/admin/ai-usage`, { headers: { cookie: ownerCookie, "x-tenant-id": tenantA } });
    assert.equal(forbidden.status, 403);
    const promptForbidden = await fetch(`${url}/api/v1/admin/tenants/${tenantA}/ai-manager`, {
      headers: { cookie: ownerCookie },
    });
    assert.equal(promptForbidden.status, 403);
    const allowed = await fetch(`${url}/api/v1/admin/ai-usage?period=last_7`, { headers: { cookie: platformCookie } });
    assert.equal(allowed.status, 200);
    const body = await allowed.json();
    assert.ok(body.totals);
    const listed = await listPlatformAiUsage(prisma, platformAuth, { period: "last_30" });
    assert.ok(listed.tenants.some((row) => row.tenantId === tenantA));
    const health = await fetch(`${url}/api/v1/integrations/whatsapp-seller/health`, {
      headers: { cookie: ownerCookie, "x-tenant-id": tenantA },
    });
    const healthBody = await health.json();
    assert.equal(health.status, 200);
    assert.equal(healthBody.sellerUrl, undefined);
    assert.ok(!JSON.stringify(healthBody).includes("inputTokens"));
    assert.ok(!JSON.stringify(healthBody).includes("totalCost"));
  });
});
