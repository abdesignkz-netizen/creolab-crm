import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { resetRateLimits } from "./lib/rateLimit.ts";

describe("BasQar billing HTTP contract", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let server: any;
  let url = "";
  let platformCookie = "";
  async function req(cookie: string, path: string, init: { method?: string; body?: unknown; tenantId?: string } = {}) {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    if (init.tenantId) headers["x-tenant-id"] = init.tenantId;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${url}${path}`, { method: init.method || "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    return { status: response.status, data: await response.json().catch(() => ({})), cookie: response.headers.get("set-cookie") || "" };
  }
  async function login(email: string) {
    const response = await req("", "/api/v1/auth/login", { method: "POST", body: { email, password: process.env.SEED_PASSWORD || "ChangeMeLocal1!", client: "web" } });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return response.cookie.split(";")[0];
  }
  async function signup(email: string) {
    resetRateLimits();
    const started = await req("", "/api/v1/auth/register", { method: "POST", body: { name: "HTTP user", companyName: "HTTP company", email, password: "SignupPass1!", passwordConfirm: "SignupPass1!" } });
    assert.equal(started.status, 200, JSON.stringify(started.data));
    const verified = await req("", "/api/v1/auth/register/verify", { method: "POST", body: { email, code: started.data.verificationCode } });
    assert.equal(verified.status, 200, JSON.stringify(verified.data));
    return { cookie: verified.cookie.split(";")[0], tenantId: verified.data.user.activeTenant.tenant.id as string };
  }
  before(async () => {
    process.env.SEED_PASSWORD ||= "ChangeMeLocal1!";
    process.env.INTERNAL_SERVICE_SECRET ||= "test-internal-secret";
    prisma = await createPrismaClient();
    const { seedDatabase } = await import("../../../packages/db/src/seed.ts");
    await seedDatabase();
    server = createApp(prisma).listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    url = `http://127.0.0.1:${server.address().port}`;
    platformCookie = await login("platform@creolab.example");
  });
  after(async () => { await new Promise(resolve => server.close(resolve)); });

  it("publishes only the four public BasQar plans", async () => {
    const account = await signup(`catalog-${Date.now()}@example.test`);
    const response = await req(account.cookie, "/api/v1/billing/plans", { tenantId: account.tenantId });
    assert.equal(response.status, 200);
    assert.deepEqual(response.data.plans.map((item: { code: string }) => item.code), ["BASQAR_FREE", "CRM_START", "CONTROL", "SALES"]);
  });
  it("creates a Free account and a server-priced Start request", async () => {
    const account = await signup(`request-${Date.now()}@example.test`);
    const billing = await req(account.cookie, "/api/v1/billing", { tenantId: account.tenantId });
    assert.equal(billing.data.planCode, "BASQAR_FREE");
    assert.equal(billing.data.entitlements.DOCUMENTS, true);
    const request = await req(account.cookie, "/api/v1/billing/requests", { method: "POST", tenantId: account.tenantId, body: { planCode: "CRM_START", finalAmountMinor: 1 } });
    assert.equal(request.status, 201, JSON.stringify(request.data));
    assert.equal(request.data.finalAmountMinor, 9990);
    const confirmed = await req(platformCookie, `/api/v1/admin/billing/requests/${request.data.id}/confirm`, { method: "POST", body: {} });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
    assert.equal(confirmed.data.planCode, "CRM_START");
    assert.equal(confirmed.data.limits.AI_CREDITS, 1000);
  });
  it("keeps individual work available while Free rejects a campaign", async () => {
    const account = await signup(`free-${Date.now()}@example.test`);
    const campaign = await req(account.cookie, "/api/v1/campaigns", { method: "POST", tenantId: account.tenantId, body: { title: "Free campaign", messageDraft: "Hi", recipientDrafts: [{ phone: "+77010000000" }] } });
    assert.equal(campaign.status, 403);
    const task = await req(account.cookie, "/api/v1/tasks", { method: "POST", tenantId: account.tenantId, body: { type: "note", title: "Manual task", targetType: "none" } });
    assert.equal(task.status, 201, JSON.stringify(task.data));
  });
});
