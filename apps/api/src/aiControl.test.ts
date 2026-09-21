import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";

const PASSWORD = process.env.SEED_PASSWORD || "ChangeMeLocal1!";
const WEBHOOK_SECRET = process.env.SEED_WEBHOOK_SECRET || "whsec_dev_local_only";

describe("BasQar Control", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let server: { close: () => void; address: () => { port: number } };
  let base = "";
  let ownerCookie = "";
  let managerCookie = "";
  let ownerUserId = "";
  let managerUserId = "";
  let creolabId = "";
  let demoId = "";
  let webhookId = "";

  async function login(email: string) {
    const response = await fetch(`${base}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD, client: "web" }),
    });
    assert.equal(response.status, 200, await response.text());
    return response.headers.get("set-cookie") || "";
  }

  async function json(path: string, init: RequestInit = {}) {
    const response = await fetch(`${base}${path}`, init);
    const body = await response.json().catch(() => ({}));
    return { status: response.status, body };
  }

  function controlHeaders(requestId: string, integrationId = webhookId) {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WEBHOOK_SECRET}`,
      "x-crm-integration-id": integrationId,
      "x-crm-timestamp": String(Math.floor(Date.now() / 1000)),
      "x-crm-request-id": requestId,
    };
  }

  async function execute(action: string, params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
    const requestId = extra.requestId ? String(extra.requestId) : `req_${randomUUID()}`;
    return json("/api/v1/integrations/ai-control/execute", {
      method: "POST",
      headers: controlHeaders(requestId, String(extra.integrationId || webhookId)),
      body: JSON.stringify({
        externalIdentity: extra.externalIdentity || "+77011111111",
        source: extra.source || "WHATSAPP",
        action,
        params,
        requestId,
        tenantId: extra.tenantId,
      }),
    });
  }

  before(async () => {
    process.env.SEED_PASSWORD ||= PASSWORD;
    prisma = await createPrismaClient();
    const { seedDatabase } = await import("../../../packages/db/src/seed.ts");
    await seedDatabase();
    app = createApp(prisma);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve()) as typeof server;
    });
    base = `http://127.0.0.1:${server.address().port}`;
    ownerCookie = await login("owner@creolab.example");
    managerCookie = await login("manager@creolab.example");

    const me = await json("/api/v1/me", { headers: { cookie: ownerCookie } });
    ownerUserId = me.body.user.id;
    const mgr = await json("/api/v1/me", { headers: { cookie: managerCookie } });
    managerUserId = mgr.body.user.id;

    const creolab = await prisma.tenant.findFirstOrThrow({ where: { slug: "creolab" } });
    const demo = await prisma.tenant.findFirstOrThrow({ where: { slug: "demo-agency" } });
    creolabId = creolab.id;
    demoId = demo.id;
    const webhook = await prisma.integration.findFirstOrThrow({ where: { tenantId: creolabId, type: "webhook" } });
    webhookId = webhook.id;

    const enabled = await json("/api/v1/workspace/control", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.body));

    const access = await json(`/api/v1/workspace/control/access/${ownerUserId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({
        enabled: true,
        canReadFinancialData: true,
        canReadTeamData: true,
        canCreateTasks: true,
        canModifyDeals: true,
        canPerformBulkActions: true,
        requiresConfirmationForWrites: true,
        allowedSources: ["WHATSAPP", "API"],
      }),
    });
    assert.equal(access.status, 200, JSON.stringify(access.body));

    const identity = await json("/api/v1/workspace/control/identities", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({
        userId: ownerUserId,
        provider: "WHATSAPP",
        phone: "+77011111111",
        verifyNow: true,
      }),
    });
    assert.equal(identity.status, 201, JSON.stringify(identity.body));
  });

  after(() => {
    server?.close();
  });

  it("пользователь получает статистику своей компании", async () => {
    const result = await execute("GET_LEADS_STATS", { period: "today" });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.success, true);
    assert.equal(result.body.action, "GET_LEADS_STATS");
    assert.equal(typeof result.body.data.total, "number");
  });

  it("пользователь компании A не видит данные B", async () => {
    const unique = `Demo isolation ${Date.now()}`;
    await prisma.contact.create({
      data: { tenantId: demoId, name: unique, lifecycleStatus: "new", lastSeenAt: new Date() },
    });
    const result = await execute("GET_CLIENTS", { period: "all" });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const names = (result.body.data.items || []).map((item: { name?: string }) => item.name);
    assert.equal(names.includes(unique), false);
  });

  it("непривязанный внешний пользователь получает отказ", async () => {
    const result = await execute("GET_LEADS_STATS", { period: "today" }, { externalIdentity: "+77019999999" });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, "identity_not_linked");
  });

  it("disabled Control → отказ", async () => {
    const off = await json("/api/v1/workspace/control", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(off.status, 200);
    const result = await execute("GET_LEADS_STATS", { period: "today" });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, "control_disabled");
    const on = await json("/api/v1/workspace/control", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(on.status, 200);
  });

  it("нет permission → отказ", async () => {
    await json(`/api/v1/workspace/control/access/${managerUserId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({
        enabled: true,
        canReadFinancialData: false,
        canCreateTasks: false,
        allowedSources: ["WHATSAPP"],
      }),
    });
    await json("/api/v1/workspace/control/identities", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({
        userId: managerUserId,
        provider: "WHATSAPP",
        phone: "+77013333333",
        verifyNow: true,
      }),
    });
    const result = await execute("GET_REVENUE_STATS", { period: "this_month" }, { externalIdentity: "+77013333333" });
    assert.equal(result.status, 403);
    assert.ok(["forbidden", "control_disabled"].includes(result.body.code));
  });

  it("CREATE_TASK выполняется один раз и duplicate requestId не создаёт второй объект", async () => {
    const requestId = `task_${randomUUID()}`;
    const title = `Control task ${Date.now()}`;
    const first = await execute("CREATE_TASK", { title, type: "other" }, { requestId });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.success, true);
    const taskId = first.body.data.id;
    assert.ok(taskId);
    const second = await execute("CREATE_TASK", { title, type: "other" }, { requestId });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.data.id, taskId);
    const count = await prisma.task.count({ where: { tenantId: creolabId, title } });
    assert.equal(count, 1);
  });

  it("HIGH_RISK action требует confirmation", async () => {
    const contact = await prisma.contact.create({
      data: { tenantId: creolabId, name: `To delete ${Date.now()}`, lifecycleStatus: "new" },
    });
    const result = await execute("DELETE_CLIENT", { clientId: contact.id });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.status, "CONFIRMATION_REQUIRED");
    assert.ok(result.body.confirmationId);
    const still = await prisma.contact.findFirst({ where: { id: contact.id } });
    assert.ok(still);
  });

  it("просроченный confirmation не выполняется", async () => {
    const contact = await prisma.contact.create({
      data: { tenantId: creolabId, name: `Expire ${Date.now()}`, lifecycleStatus: "new" },
    });
    const pending = await execute("DELETE_CLIENT", { clientId: contact.id });
    assert.equal(pending.body.status, "CONFIRMATION_REQUIRED");
    await prisma.controlConfirmation.update({
      where: { id: pending.body.confirmationId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const confirmed = await json("/api/v1/integrations/ai-control/confirm", {
      method: "POST",
      headers: controlHeaders(`cnf_${randomUUID()}`),
      body: JSON.stringify({
        confirmationId: pending.body.confirmationId,
        externalIdentity: "+77011111111",
        source: "WHATSAPP",
      }),
    });
    assert.equal(confirmed.status, 410);
    assert.equal(confirmed.body.code, "confirmation_expired");
    const still = await prisma.contact.findFirst({ where: { id: contact.id } });
    assert.ok(still);
  });

  it("spoofed tenantId игнорируется", async () => {
    const result = await execute("GET_LEADS_STATS", { period: "today" }, { tenantId: demoId });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.success, true);
    const demoName = `Should not leak ${Date.now()}`;
    await prisma.contact.create({
      data: { tenantId: demoId, name: demoName, lifecycleStatus: "new" },
    });
    const clients = await execute("FIND_CLIENT", { q: demoName }, { tenantId: demoId });
    assert.equal(clients.status, 200, JSON.stringify(clients.body));
    const items = clients.body.data?.items || [];
    assert.equal(items.some((item: { name?: string }) => item.name === demoName), false);
  });

  it("финансовые данные требуют permission", async () => {
    await json(`/api/v1/workspace/control/access/${ownerUserId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ canReadFinancialData: false }),
    });
    const denied = await execute("GET_REVENUE_STATS", { period: "this_month" });
    assert.equal(denied.status, 403);
    await json(`/api/v1/workspace/control/access/${ownerUserId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ canReadFinancialData: true }),
    });
    const allowed = await execute("GET_REVENUE_STATS", { period: "this_month" });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    assert.equal("revenue" in allowed.body.data, true);
  });

  it("audit log создаётся", async () => {
    const before = await prisma.auditEvent.count({
      where: { tenantId: creolabId, action: { startsWith: "control." } },
    });
    const result = await execute("GET_SITUATION", { period: "today" });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const after = await prisma.auditEvent.count({
      where: { tenantId: creolabId, action: { startsWith: "control." } },
    });
    assert.ok(after > before);
    const history = await json("/api/v1/workspace/control/history", { headers: { cookie: ownerCookie } });
    assert.equal(history.status, 200);
    assert.ok(Array.isArray(history.body.items));
  });

  it("existing CRM endpoints продолжают работать", async () => {
    const contacts = await json("/api/v1/contacts", { headers: { cookie: ownerCookie } });
    assert.equal(contacts.status, 200);
    assert.ok(Array.isArray(contacts.body.items));
    const me = await json("/api/v1/me", { headers: { cookie: ownerCookie } });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, "owner@creolab.example");
  });
});
