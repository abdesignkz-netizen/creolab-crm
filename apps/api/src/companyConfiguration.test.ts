import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { emptyAiManagerDraft } from "@creolab/contracts";
import { createApp } from "./app.ts";
import { config } from "./config.ts";
import { CONFIGURATION_HEADER } from "./services/companyConfigurationAccess.ts";
import { invalidateRuntimeConfig } from "./services/runtimeSettings.ts";

describe("service admin company configuration without impersonation", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>, server: ReturnType<ReturnType<typeof createApp>["listen"]>;
  let base = "", admin = "", owner = "", tenantId = "", otherId = "", actorId = "", widgetId = "";
  const nativeFetch = globalThis.fetch, oldApiBase = config.apiBaseUrl, oldAppBase = config.appBaseUrl;
  const envKeys = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET", "INSTAGRAM_VERIFY_TOKEN", "ANYMODEL_API_KEY", "ANYMODEL_BASE_URL"];
  const oldEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  let tokenExchanges = 0;
  async function call(path: string, method = "GET", body?: unknown, cookie = admin, scope: string | null = tenantId) {
    const response = await nativeFetch(`${base}${path}`, { method, redirect: "manual", headers: {
      cookie, "content-type": "application/json", ...(scope ? { [CONFIGURATION_HEADER]: scope } : {}),
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json().catch(() => ({})), location: response.headers.get("location") };
  }
  async function login(email: string) {
    const response = await nativeFetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: process.env.SEED_PASSWORD }) });
    assert.equal(response.status, 200); return (response.headers.get("set-cookie") || "").split(";")[0];
  }
  before(async () => {
    config.apiBaseUrl = config.appBaseUrl = "https://bsqr.kz";
    Object.assign(process.env, { GOOGLE_CLIENT_ID: "test-client", GOOGLE_CLIENT_SECRET: "test-secret", INSTAGRAM_APP_ID: "test-instagram", INSTAGRAM_APP_SECRET: "test-instagram-secret", INSTAGRAM_VERIFY_TOKEN: "test-verify", ANYMODEL_API_KEY: "test-ai-key", ANYMODEL_BASE_URL: "https://test-ai.example.test/v1" });
    globalThis.fetch = async (url, init) => {
      const u = new URL(String(url));
      if (u.hostname === "test-ai.example.test") return Response.json({ id: "scoped-preview", choices: [{ message: { content: JSON.stringify({ reply: "Здравствуйте! Уточните задачу, пожалуйста.", handoff: false, reason: null }) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
      if (u.hostname === "oauth2.googleapis.com") { tokenExchanges++; return Response.json({ access_token: "secret-google", refresh_token: "secret-refresh", expires_in: 3600 }); }
      if (u.hostname === "www.googleapis.com" && u.pathname.includes("calendarList")) return Response.json({ id: "scoped-calendar", summary: "Компания", accessRole: "owner" });
      if (u.hostname === "api.instagram.com") { tokenExchanges++; return Response.json({ access_token: "secret-instagram", user_id: "178410002", permissions: ["instagram_business_basic", "instagram_business_manage_messages"] }); }
      if (u.hostname === "graph.instagram.com") {
        if (u.pathname === "/access_token") return Response.json({ access_token: "secret-instagram-long", expires_in: 5184000 });
        if (u.pathname.endsWith("/me")) return Response.json({ user_id: "178410002", username: "scoped_company" });
        if (u.pathname.endsWith("/subscribed_apps")) return Response.json({ success: true });
      }
      if (u.hostname === "api.telegram.org") {
        if (u.pathname.endsWith("/getMe")) return Response.json({ ok: true, result: { id: 123456789, is_bot: true, username: "company_test_bot" } });
        if (u.pathname.endsWith("/getWebhookInfo")) return Response.json({ ok: true, result: { url: "" } });
        return Response.json({ ok: true, result: true });
      }
      throw new Error(`Unexpected external request: ${u.hostname}${u.pathname}`);
    };
    prisma = await createPrismaClient(); await (await import("../../../packages/db/src/seed.ts")).seedDatabase();
    tenantId = (await prisma.tenant.findFirstOrThrow({ where: { slug: "creolab" } })).id;
    otherId = (await prisma.tenant.findFirstOrThrow({ where: { slug: "demo-agency" } })).id;
    actorId = (await prisma.user.findFirstOrThrow({ where: { email: "platform@creolab.example" } })).id;
    await prisma.aIConfiguration.updateMany({ where: { tenantId }, data: { enabled: true, provider: "anymodel", model: "test", credentialId: null } });
    invalidateRuntimeConfig();
    await new Promise<void>(resolve => { server = createApp(prisma).listen(0, "127.0.0.1", resolve); });
    const addr = server.address(); if (!addr || typeof addr === "string") throw new Error("no port"); base = `http://127.0.0.1:${addr.port}`;
    admin = await login("platform@creolab.example"); owner = await login("owner@creolab.example");
  });
  after(async () => {
    globalThis.fetch = nativeFetch; config.apiBaseUrl = oldApiBase; config.appBaseUrl = oldAppBase;
    for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    invalidateRuntimeConfig(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); await prisma?.$disconnect();
  });

  it("requires a service admin, explicit scope and active target company", async () => {
    assert.equal((await call("/api/v1/settings/ai-manager", "GET", undefined, "")).status, 401);
    assert.equal((await call("/api/v1/settings/ai-manager", "GET", undefined, owner)).status, 403);
    assert.equal((await call("/api/v1/settings/ai-manager", "GET", undefined, admin, null)).status, 403);
    assert.equal((await call("/api/v1/settings/ai-manager", "GET", undefined, admin, "missing")).status, 404);
    const suspended = await prisma.tenant.create({ data: { name: "Paused", slug: "paused-scoped", status: "suspended" } });
    assert.equal((await call("/api/v1/settings/ai-manager", "GET", undefined, admin, suspended.id)).status, 403);
    assert.equal((await call("/api/v1/settings/ai-manager", "GET", undefined, owner, null)).status, 200);
  });
  it("does not grant CRM, payment, document-signing or personal account access", async () => {
    for (const [method, path] of [["GET", "/api/v1/conversations"], ["GET", "/api/v1/me"], ["GET", "/api/v1/telegram/status"], ["POST", "/api/v1/electronic-documents/foreign/esf-send"], ["POST", "/api/v1/billing/payments"], ["POST", "/api/v1/conversations/foreign/messages"], ["POST", "/api/v1/integrations/esf/ncalayer-poc/avr-send"]]) {
      const result = await call(path, method, method === "POST" ? {} : undefined);
      assert.equal(result.status, 403, `${method} ${path}: ${JSON.stringify(result.data)}`);
      assert.equal(result.data.code, "configuration_scope");
    }
  });
  it("loads every configuration panel without creating a company membership", async () => {
    const count = await prisma.membership.count({ where: { userId: actorId } });
    const context = await call(`/api/v1/admin/tenants/${tenantId}/configuration-context`, "GET", undefined, admin, null);
    assert.equal(context.status, 200); assert.equal(context.data.company.id, tenantId); assert.equal(context.data.billing.tenantId, tenantId);
    for (const path of ["/api/v1/settings/ai-manager", "/api/v1/settings/ai-automation", ...["catalog", "setup", "events", "whatsapp", "website-chat", "channels/ai", "meta", "google", "tiktok", "whatsapp-seller/health"].map(x => `/api/v1/integrations/${x}`)]) {
      const result = await call(path); assert.equal(result.status, 200, `${path}: ${JSON.stringify(result.data)}`);
    }
    assert.equal(await prisma.membership.count({ where: { userId: actorId } }), count);
  });
  it("respects the service-wide ESF switch in company configuration", async () => {
    assert.equal((await call("/api/v1/integrations/esf")).status, 404);
    assert.equal((await call("/api/v1/integrations/esf/connect", "POST", {})).status, 404);
    const enabled = await call("/api/v1/admin/settings", "PATCH", { features: { esf: true } }, admin, null);
    assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
    assert.equal((await call("/api/v1/integrations/esf")).status, 200);
    await call("/api/v1/admin/settings", "PATCH", { features: { esf: false } }, admin, null);
  });
  it("edits audience, schedule and handoff only for the selected company with the admin actor", async () => {
    const other = await prisma.tenant.findUniqueOrThrow({ where: { id: otherId } });
    const result = await call("/api/v1/settings/ai-automation", "PATCH", { defaultMode: "AUTO", replyAudience: { audience: "new" }, proactiveFirstContact: false, timezone: "Asia/Almaty", conversationHours: { mode: "schedule", days: { 1: { enabled: true, start: "10:00", end: "18:00" } }, offHoursBehavior: "no_reply" } });
    assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.replyAudience.audience, "new");
    assert.deepEqual((await prisma.tenant.findUniqueOrThrow({ where: { id: otherId } })).settingsJson, other.settingsJson);
    const event = await prisma.auditEvent.findFirst({ where: { tenantId, action: "platform.configuration_requested" }, orderBy: { createdAt: "desc" } });
    assert.equal(event?.actorUserId, actorId);
    const saved = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId, action: "ai.automation_updated" } });
    assert.equal(saved.actorUserId, actorId);
  });
  it("supports draft, test, review, publish and restore with conflict protection", async () => {
    const endpoint = "/api/v1/settings/ai-manager";
    const otherBefore = await prisma.aIConfiguration.findMany({ where: { tenantId: otherId } });
    let state = (await call(endpoint)).data;
    const draft = emptyAiManagerDraft("Компания администратора");
    draft.company.description = "Разработка презентаций"; draft.company.contacts = "Менеджер в этом чате";
    draft.conversation.goal = "Выяснить задачу"; draft.conversation.questions = "Срок и число слайдов";
    draft.conversation.completion = "Передать запрос менеджеру"; draft.conversation.successCriteria = "Клиент согласовал следующий шаг";
    draft.offerings = [{ id: "one", name: "Презентация", description: "Дизайн", price: "от 80000 тенге", includes: "10 слайдов", timing: "5 дней", restrictions: "Без перевода" }];
    const saved = await call(endpoint, "PATCH", { revision: state.revision, draft }); assert.equal(saved.status, 200); state = saved.data;
    assert.equal((await call(endpoint, "PATCH", { revision: state.revision - 1, draft })).status, 409);
    const messages = await prisma.message.count({ where: { tenantId } });
    for (const scenarioId of state.quality.requiredScenarioIds) {
      const preview = await call(`${endpoint}/preview`, "POST", { revision: state.revision, scenarioId, messages: [{ role: "user", content: "Здравствуйте" }] });
      assert.equal(preview.status, 200, JSON.stringify(preview.data));
      const reviewed = await call(`${endpoint}/review`, "POST", { revision: state.revision, runId: preview.data.runId, accurate: true, onGoal: true, appropriate: true });
      assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data)); state = reviewed.data;
    }
    assert.equal(await prisma.message.count({ where: { tenantId } }), messages);
    const published = await call(`${endpoint}/publish`, "POST", { revision: state.revision }); assert.equal(published.status, 200, JSON.stringify(published.data)); state = published.data;
    assert.equal((await prisma.aIConfiguration.findFirstOrThrow({ where: { tenantId } })).promptUpdatedById, actorId);
    const restored = await call(`${endpoint}/restore`, "POST", { revision: state.revision, versionId: state.versions[0].id });
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    assert.deepEqual(await prisma.aIConfiguration.findMany({ where: { tenantId: otherId } }), otherBefore);
  });
  it("configures a website widget and blocks mutations using another company's integration ID", async () => {
    const widget = await call("/api/v1/integrations/website-chat", "PUT", { enabled: true, title: "Помощник", greeting: "Здравствуйте!", color: "#0066cc", origins: ["https://customer.example.test"] });
    assert.equal(widget.status, 200, JSON.stringify(widget.data)); widgetId = widget.data.item.id;
    assert.equal((await prisma.integration.findUniqueOrThrow({ where: { id: widgetId } })).tenantId, tenantId);
    assert.equal((await call(`/api/v1/integrations/channels/${widgetId}/ai`, "POST", { enabled: false }, admin, otherId)).status, 404);
    assert.equal((await call(`/api/v1/integrations/channels/${widgetId}/ai`, "POST", { enabled: false })).status, 200);
    const bot = await call("/api/v1/integrations/telegram/connect", "POST", { token: `123456789:${"a".repeat(35)}` });
    assert.equal(bot.status, 200, JSON.stringify(bot.data));
    assert.equal((await call(`/api/v1/integrations/telegram/${bot.data.id}/disconnect`, "POST", undefined, admin, otherId)).status, 404);
    assert.equal((await call(`/api/v1/integrations/telegram/${bot.data.id}/disconnect`, "POST")).status, 200);
    const audit = await prisma.auditEvent.findMany({ where: { tenantId, actorUserId: actorId } });
    assert.doesNotMatch(JSON.stringify(audit), /secret-google|secret-instagram|a{35}/);
  });
  it("binds Google and Instagram OAuth to the selected company and returns to its admin card", async () => {
    for (const provider of ["google", "instagram"]) {
      const begun = await call(`/api/v1/integrations/${provider}/connect`, "POST", provider === "google" ? { kind: "calendar" } : undefined);
      assert.equal(begun.status, 200, JSON.stringify(begun.data));
      const state = new URL(begun.data.url).searchParams.get("state");
      const url = `/api/v1/integrations/${provider}/callback?state=${state}&code=test`;
      const before = tokenExchanges;
      assert.match((await call(url, "GET", undefined, owner, null)).location || "", /failed|expired/);
      assert.equal(tokenExchanges, before);
      const finished = await call(url, "GET", undefined, admin, null);
      assert.equal(finished.status, 302); assert.match(finished.location || "", new RegExp(`/admin/companies/${tenantId}\\?tab=integrations&${provider}=connected`));
      assert.equal(tokenExchanges, before + 1);
      const row = await prisma.integration.findFirstOrThrow({ where: { publicKey: provider === "google" ? { startsWith: `google:calendar:${tenantId}:` } : "instagram_direct:178410002" } });
      assert.equal(row.tenantId, tenantId);
      await call(url, "GET", undefined, admin, null); assert.equal(tokenExchanges, before + 1);
    }
  });
  it("creates and disconnects QR setup for the selected company without membership", async () => {
    const created = await call("/api/v1/integrations/whatsapp/qr", "POST");
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const id = created.data.id;
    assert.equal((await prisma.integration.findUniqueOrThrow({ where: { id } })).tenantId, tenantId);
    assert.equal((await call(`/api/v1/integrations/whatsapp/${id}/qr`, "GET", undefined, admin, otherId)).status, 404);
    const qr = await call(`/api/v1/integrations/whatsapp/${id}/qr`);
    assert.equal(qr.status, 200); assert.equal(qr.data.qr, null); // No worker or real WhatsApp login in tests.
    assert.equal((await call(`/api/v1/integrations/whatsapp/${id}/disconnect`, "POST")).status, 200);
    assert.equal((await prisma.integration.findUniqueOrThrow({ where: { id } })).status, "disabled");
  });
  it("rejects foreign connection IDs in every provider action before external requests", async () => {
    for (const [type, routes] of [
      ["whatsapp_cloud", ["whatsapp/ID/activate", "whatsapp/ID/disconnect", "whatsapp/ID/ai"]],
      ["instagram_direct", ["meta/ID/activate", "meta/ID/disconnect"]],
      ["tiktok_leads", ["tiktok/ID/check", "tiktok/ID/disconnect"]],
      ["calendar", ["google/ID/sync", "google/ID/disconnect"]],
    ] as Array<[string, string[]]>) {
      const row = await prisma.integration.create({ data: { tenantId: otherId, type, name: "Foreign connection", status: "active" } });
      for (const route of routes) {
        const response = await call(`/api/v1/integrations/${route.replace("ID", row.id)}`, "POST", { enabled: false });
        assert.equal(response.status, 404, `${route}: ${JSON.stringify(response.data)}`);
      }
      assert.equal((await prisma.integration.findUniqueOrThrow({ where: { id: row.id } })).status, "active");
    }
  });
  it("returns expired OAuth to the selected company without exchanging credentials", async () => {
    for (const provider of ["google", "instagram"]) {
      const begun = await call(`/api/v1/integrations/${provider}/connect`, "POST", provider === "google" ? { kind: "email" } : undefined);
      assert.equal(begun.status, 200);
      const state = new URL(begun.data.url).searchParams.get("state");
      await prisma.idempotencyRecord.updateMany({ where: { scope: `${provider}.oauth` }, data: { expiresAt: new Date(0) } });
      const before = tokenExchanges;
      const result = await call(`/api/v1/integrations/${provider}/callback?state=${state}&code=expired`, "GET", undefined, admin, null);
      assert.equal(result.status, 302);
      assert.match(result.location || "", new RegExp(`/admin/companies/${tenantId}\\?tab=integrations&${provider}=(expired|failed)`));
      assert.equal(tokenExchanges, before);
    }
  });
});
