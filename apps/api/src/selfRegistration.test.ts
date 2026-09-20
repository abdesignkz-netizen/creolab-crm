import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { resetRateLimits } from "./lib/rateLimit.ts";

describe("self-service registration and preview entitlements", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let server: { close: (cb?: (err?: Error) => void) => void; address: () => { port: number } | string | null };
  let url = "";
  let platformCookie = "";
  let creolabId = "";
  let demoId = "";

  async function login(email: string, password = process.env.SEED_PASSWORD || "ChangeMeLocal1!") {
    const response = await fetch(`${url}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, client: "web" }),
    });
    assert.equal(response.status, 200, await response.text());
    let cookie = response.headers.getSetCookie?.()?.[0]?.split(";")[0] || "";
    if (!cookie) cookie = (response.headers.get("set-cookie") || "").split(";")[0];
    assert.ok(cookie);
    return cookie;
  }

  async function req(cookie: string, path: string, init: { method?: string; body?: unknown; tenantId?: string } = {}) {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.tenantId) headers["x-tenant-id"] = init.tenantId;
    const response = await fetch(`${url}${path}`, {
      method: init.method || "GET",
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, data, cookie: response.headers.get("set-cookie") || "" };
  }

  before(async () => {
    process.env.SEED_PASSWORD ||= "ChangeMeLocal1!";
    process.env.INTERNAL_SERVICE_SECRET ||= "test-internal-secret";
    prisma = await createPrismaClient();
    const { seedDatabase } = await import("../../../packages/db/src/seed.ts");
    await seedDatabase();
    const app = createApp(prisma);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve()) as typeof server;
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    url = `http://127.0.0.1:${addr.port}`;
    creolabId = (await prisma.tenant.findFirstOrThrow({ where: { slug: "creolab" } })).id;
    demoId = (await prisma.tenant.findFirstOrThrow({ where: { slug: "demo-agency" } })).id;
    platformCookie = await login("platform@creolab.example");
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("registers a company after email verification and opens preview CRM", async () => {
    resetRateLimits();
    const email = `owner-a-${Date.now()}@example.test`;
    const started = await req("", "/api/v1/auth/register", {
      method: "POST",
      body: {
        name: "Алия Владелец",
        companyName: "Студия Алия",
        email,
        password: "SignupPass1!",
        passwordConfirm: "SignupPass1!",
      },
    });
    assert.equal(started.status, 200, JSON.stringify(started.data));
    assert.equal(started.data.ok, true);
    assert.ok(started.data.verificationCode);

    const beforeUsers = await prisma.user.count({ where: { email } });
    assert.equal(beforeUsers, 0);

    const verified = await req("", "/api/v1/auth/register/verify", {
      method: "POST",
      body: { email, code: started.data.verificationCode },
    });
    assert.equal(verified.status, 200, JSON.stringify(verified.data));
    assert.ok(verified.cookie.includes("crm_session"));
    const cookie = verified.cookie.split(";")[0];
    const tenantId = verified.data.user?.activeTenant?.tenant?.id;
    assert.ok(tenantId);
    assert.equal(verified.data.user.activeTenant.role, "owner");
    assert.equal(verified.data.user.billing.previewMode, true);
    assert.equal(verified.data.user.billing.subscriptionStatus, "none");
    assert.equal(verified.data.user.billing.organizationStatus, "active");
    assert.equal(verified.data.user.billing.entitlements.WHATSAPP, false);

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    assert.ok(user.passwordHash);
    assert.equal(user.passwordHash.includes("SignupPass1!"), false);
    assert.ok(user.emailVerifiedAt);

    const membership = await prisma.membership.findFirstOrThrow({
      where: { userId: user.id, tenantId },
    });
    assert.equal(membership.role, "owner");

    const me = await req(cookie, "/api/v1/me", { tenantId });
    assert.equal(me.status, 200);
    assert.equal(me.data.billing.previewMode, true);

    const situation = await req(cookie, "/api/v1/situation/overview", { tenantId });
    assert.equal(situation.status, 200);

    const blocked = await req(cookie, "/api/v1/integrations/whatsapp-seller/connect", {
      method: "POST",
      tenantId,
      body: { instanceId: "1111111111", apiToken: "token-preview" },
    });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.data.code, "feature_required");

    const ai = await req(cookie, "/api/v1/ai/sandbox", {
      method: "POST",
      tenantId,
      body: { message: "тест" },
    });
    assert.equal(ai.status, 403);
    assert.equal(ai.data.code, "feature_required");

    const support = await req(cookie, "/api/v1/support/articles", { tenantId });
    assert.equal(support.status, 200);

    const billing = await req(cookie, "/api/v1/billing", { tenantId });
    assert.equal(billing.status, 200);
    assert.equal(billing.data.previewMode, true);
    assert.ok(billing.data.preview);

    const activated = await req(platformCookie, `/api/v1/admin/tenants/${tenantId}/subscription/activate`, {
      method: "POST",
      body: {},
    });
    assert.equal(activated.status, 200, JSON.stringify(activated.data));
    assert.equal(activated.data.subscriptionStatus, "active");
    assert.equal(activated.data.previewMode, false);

    const after = await req(cookie, "/api/v1/integrations/whatsapp-seller/connect", {
      method: "POST",
      tenantId,
      body: { instanceId: "1111111111", apiToken: "token-preview" },
    });
    assert.notEqual(after.data.code, "feature_required");
    assert.ok(after.status === 200 || after.status === 422, JSON.stringify(after.data));

    const lead = await prisma.serviceSignupRequest.findFirst({ where: { email } });
    assert.ok(lead);
    assert.equal(lead.status, "REGISTERED");
    assert.equal(lead.tenantId, tenantId);
  });

  it("does not create a duplicate user and keeps existing tenants entitled", async () => {
    resetRateLimits();
    const exists = await req("", "/api/v1/auth/register", {
      method: "POST",
      body: {
        name: "Владелец",
        companyName: "Ещё одна",
        email: "owner@creolab.example",
        password: "SignupPass1!",
        passwordConfirm: "SignupPass1!",
      },
    });
    assert.equal(exists.status, 409);
    assert.equal(exists.data.code, "account_exists");

    const ownerCookie = await login("owner@creolab.example");
    const me = await req(ownerCookie, "/api/v1/me", { tenantId: creolabId });
    assert.equal(me.status, 200);
    assert.equal(me.data.billing.previewMode, false);
    assert.equal(me.data.billing.entitlements.WHATSAPP, true);

    const connect = await req(ownerCookie, "/api/v1/integrations/whatsapp-seller/connect", {
      method: "POST",
      tenantId: creolabId,
      body: {},
    });
    assert.notEqual(connect.data.code, "feature_required");
  });

  it("isolates two self-registered companies and their subscription statuses", async () => {
    resetRateLimits();
    async function signup(name: string, company: string, email: string) {
      const started = await req("", "/api/v1/auth/register", {
        method: "POST",
        body: { name, companyName: company, email, password: "SignupPass1!", passwordConfirm: "SignupPass1!" },
      });
      assert.equal(started.status, 200, JSON.stringify(started.data));
      const verified = await req("", "/api/v1/auth/register/verify", {
        method: "POST",
        body: { email, code: started.data.verificationCode },
      });
      assert.equal(verified.status, 200, JSON.stringify(verified.data));
      return {
        cookie: verified.cookie.split(";")[0],
        tenantId: verified.data.user.activeTenant.tenant.id as string,
      };
    }
    const a = await signup("Owner A", "Компания А", `iso-a-${Date.now()}@example.test`);
    const b = await signup("Owner B", "Компания Б", `iso-b-${Date.now()}@example.test`);
    assert.notEqual(a.tenantId, b.tenantId);

    await req(platformCookie, `/api/v1/admin/tenants/${b.tenantId}/subscription/activate`, {
      method: "POST",
      body: {},
    });

    const aBilling = await req(a.cookie, "/api/v1/billing", { tenantId: a.tenantId });
    const bBilling = await req(b.cookie, "/api/v1/billing", { tenantId: b.tenantId });
    assert.equal(aBilling.data.subscriptionStatus, "none");
    assert.equal(bBilling.data.subscriptionStatus, "active");

    const cross = await req(a.cookie, "/api/v1/contacts", { tenantId: b.tenantId });
    assert.ok(cross.status === 403 || cross.status === 401 || (cross.status === 200 && (cross.data.items || []).length === 0));
    if (cross.status === 200) {
      assert.equal(cross.data.total || cross.data.items.length, 0);
    }

    const aMeOnB = await req(a.cookie, "/api/v1/me", { tenantId: b.tenantId });
    assert.equal(aMeOnB.status, 403);

    const demoOwner = await login("owner@demo-agency.example");
    const leak = await req(demoOwner, "/api/v1/contacts", { tenantId: creolabId });
    assert.equal(leak.status, 403);
    void demoId;
  });
});
