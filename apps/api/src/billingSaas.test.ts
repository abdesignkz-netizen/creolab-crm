import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { resetRateLimits } from "./lib/rateLimit.ts";
import { quoteSubscription } from "./services/pricingEngine.ts";
import { expireDueSubscriptions } from "./services/subscriptionActivationService.ts";

describe("SaaS billing catalog, requests and manual activation", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let server: { close: (cb?: (err?: Error) => void) => void; address: () => { port: number } | string | null };
  let url = "";
  let platformCookie = "";
  let creolabId = "";

  async function login(email: string, password = process.env.SEED_PASSWORD || "ChangeMeLocal1!") {
    const response = await fetch(`${url}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, client: "web" }),
    });
    assert.equal(response.status, 200, await response.text());
    let cookie = response.headers.getSetCookie?.()?.[0]?.split(";")[0] || "";
    if (!cookie) cookie = (response.headers.get("set-cookie") || "").split(";")[0];
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

  async function signup(name: string, company: string, email: string) {
    resetRateLimits();
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
    platformCookie = await login("platform@creolab.example");
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("keeps existing tenants entitled and prices catalog plans correctly", async () => {
    const ownerCookie = await login("owner@creolab.example");
    const me = await req(ownerCookie, "/api/v1/me", { tenantId: creolabId });
    assert.equal(me.data.billing.previewMode, false);
    assert.equal(me.data.billing.entitlements.WHATSAPP, true);

    const start = await quoteSubscription(prisma, { planCode: "CRM_START" });
    assert.equal(start.finalAmountMinor, 14900);
    assert.equal(start.limits.USERS, 3);
    assert.equal(start.features.CLIENTS, true);
    assert.equal(start.features.WORKFLOWS, false);
    assert.equal(start.features.AI_MANAGER, false);

    const business = await quoteSubscription(prisma, { planCode: "CRM_BUSINESS" });
    assert.equal(business.finalAmountMinor, 29900);
    assert.equal(business.limits.USERS, 10);
    assert.equal(business.features.WORKFLOWS, true);

    const pro = await quoteSubscription(prisma, { planCode: "CRM_PRO" });
    assert.equal(pro.finalAmountMinor, 49900);
    assert.equal(pro.limits.USERS, 25);
    assert.equal(pro.features.API, true);

    const aiAddon = await quoteSubscription(prisma, {
      planCode: "CRM_START",
      addOns: [{ code: "ADDON_AI_START", qty: 1 }],
    });
    assert.equal(aiAddon.features.AI_MANAGER, true);
    assert.equal(aiAddon.limits.WHATSAPP_CONNECTIONS, 1);

    const aiStand = await quoteSubscription(prisma, { planCode: "AI_SALES" });
    assert.equal(aiStand.finalAmountMinor, 29900);
    assert.equal(aiStand.features.CRM_LITE, true);
    assert.equal(aiStand.features.AI_MANAGER, true);

    const controlAddon = await quoteSubscription(prisma, {
      planCode: "CRM_BUSINESS",
      addOns: [{ code: "ADDON_CONTROL", qty: 1 }],
    });
    assert.equal(controlAddon.features.AI_CONTROL, true);
    assert.equal(controlAddon.finalAmountMinor, 39800);

    const controlStand = await quoteSubscription(prisma, { planCode: "CONTROL_STANDALONE" });
    assert.equal(controlStand.finalAmountMinor, 19900);
    assert.equal(controlStand.features.CRM_LITE, true);
    assert.equal(controlStand.features.AI_CONTROL, true);

    const bundle = await quoteSubscription(prisma, { planCode: "BUNDLE_CRM_AI" });
    assert.equal(bundle.finalAmountMinor, 49900);
    assert.ok(bundle.lines.length === 1);

    const bundlePlusIncluded = await quoteSubscription(prisma, {
      planCode: "BUNDLE_CRM_AI",
      addOns: [{ code: "ADDON_AI_BUSINESS", qty: 1 }],
    });
    assert.equal(bundlePlusIncluded.finalAmountMinor, 49900);

    const full = await quoteSubscription(prisma, { planCode: "BUNDLE_FULL" });
    assert.equal(full.finalAmountMinor, 69900);

    const yearly = await quoteSubscription(prisma, { planCode: "CRM_START", billingPeriod: "YEARLY" });
    assert.equal(yearly.finalAmountMinor, 149000);
  });

  it("lets a new company enter preview, request a plan, and wait for admin payment confirmation", async () => {
    const account = await signup("Олжас", "Студия Олжас", `billing-${Date.now()}@example.test`);
    const { cookie, tenantId } = account;

    const billing = await req(cookie, "/api/v1/billing", { tenantId });
    assert.equal(billing.status, 200);
    assert.equal(billing.data.previewMode, true);
    assert.ok(billing.data.preview);

    const plans = await req(cookie, "/api/v1/billing/plans", { tenantId });
    assert.equal(plans.status, 200);
    assert.ok((plans.data.offers || []).some((item: { code: string }) => item.code === "BUNDLE_CRM_AI"));

    const blocked = await req(cookie, "/api/v1/ai/sandbox", { method: "POST", tenantId, body: { message: "hi" } });
    assert.equal(blocked.status, 403);

    const spoofed = await req(cookie, "/api/v1/billing/requests", {
      method: "POST",
      tenantId,
      body: { planCode: "BUNDLE_CRM_AI", finalAmountMinor: 1, amount: 1, addOns: [] },
    });
    assert.equal(spoofed.status, 201, JSON.stringify(spoofed.data));
    assert.equal(spoofed.data.finalAmountMinor, 49900);
    assert.equal(spoofed.data.status, "AWAITING_PAYMENT");

    const afterRequest = await req(cookie, "/api/v1/billing", { tenantId });
    assert.equal(afterRequest.data.previewMode, true);
    assert.equal(afterRequest.data.entitlements.AI_MANAGER, false);
    assert.equal(afterRequest.data.currentRequest.finalAmountMinor, 49900);

    const duplicate = await req(cookie, "/api/v1/billing/requests", {
      method: "POST",
      tenantId,
      body: { planCode: "BUNDLE_CRM_AI" },
    });
    assert.equal(duplicate.status, 201);
    assert.equal(duplicate.data.id, spoofed.data.id);

    const adminList = await req(platformCookie, "/api/v1/admin/billing/requests");
    assert.equal(adminList.status, 200);
    assert.ok((adminList.data.items || []).some((item: { id: string }) => item.id === spoofed.data.id));

    const asUser = await req(cookie, `/api/v1/admin/billing/requests/${spoofed.data.id}/confirm`, {
      method: "POST",
      tenantId,
      body: {},
    });
    assert.equal(asUser.status, 403);

    const other = await signup("Бекзат", "Другая", `billing-b-${Date.now()}@example.test`);
    const leak = await req(other.cookie, "/api/v1/billing", { tenantId });
    assert.equal(leak.status, 403);

    const confirmed = await req(platformCookie, `/api/v1/admin/billing/requests/${spoofed.data.id}/confirm`, {
      method: "POST",
      body: {},
    });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
    assert.equal(confirmed.data.subscriptionStatus, "active");
    assert.equal(confirmed.data.planCode, "BUNDLE_CRM_AI");
    assert.equal(confirmed.data.entitlements.AI_MANAGER, true);
    assert.equal(confirmed.data.previewMode, false);

    const again = await req(platformCookie, `/api/v1/admin/billing/requests/${spoofed.data.id}/confirm`, {
      method: "POST",
      body: {},
    });
    assert.equal(again.status, 200);
    assert.equal(await prisma.tenantPlan.count({ where: { tenantId } }), 1);
    assert.equal(await prisma.billingPayment.count({ where: { tenantId, status: "CONFIRMED" } }), 1);
  });

  it("activates add-ons, upgrades, renews, validates downgrade and keeps data after expiry", async () => {
    const account = await signup("Айжан", "Кабинет Айжан", `billing-c-${Date.now()}@example.test`);
    const { cookie, tenantId } = account;

    const contact = await prisma.contact.create({ data: { tenantId, name: "Клиент тарифа" } });

    const start = await req(platformCookie, `/api/v1/admin/tenants/${tenantId}/subscription/activate`, {
      method: "POST",
      body: { planCode: "CRM_START" },
    });
    assert.equal(start.status, 200, JSON.stringify(start.data));
    assert.equal(start.data.limits.USERS, 3);
    assert.equal(start.data.entitlements.WORKFLOWS, false);

    const addonReq = await req(cookie, "/api/v1/billing/requests", {
      method: "POST",
      tenantId,
      body: { planCode: "CRM_START", addOns: [{ code: "ADDON_USER", qty: 1 }], requestType: "ADD_ADDON" },
    });
    assert.equal(addonReq.status, 201, JSON.stringify(addonReq.data));
    const addonOk = await req(platformCookie, `/api/v1/admin/billing/requests/${addonReq.data.id}/confirm`, {
      method: "POST",
      body: {},
    });
    assert.equal(addonOk.status, 200, JSON.stringify(addonOk.data));
    assert.equal(addonOk.data.limits.USERS, 4);

    const upgrade = await req(cookie, "/api/v1/billing/requests", {
      method: "POST",
      tenantId,
      body: { planCode: "CRM_BUSINESS", requestType: "UPGRADE" },
    });
    assert.equal(upgrade.status, 201);
    const upgraded = await req(platformCookie, `/api/v1/admin/billing/requests/${upgrade.data.id}/confirm`, {
      method: "POST",
      body: {},
    });
    assert.equal(upgraded.data.planCode, "CRM_BUSINESS");
    assert.equal(upgraded.data.entitlements.WORKFLOWS, true);
    assert.ok(await prisma.contact.findFirst({ where: { id: contact.id, tenantId } }));

    const hash = (await prisma.user.findFirstOrThrow({ where: { email: { contains: "billing-c-" } } })).passwordHash;
    for (let i = 0; i < 4; i += 1) {
      const user = await prisma.user.create({
        data: { email: `extra-${tenantId}-${i}@example.test`, passwordHash: hash, name: `Сотрудник ${i}` },
      });
      await prisma.membership.create({ data: { tenantId, userId: user.id, role: "manager", active: true } });
    }
    const blockedDown = await req(cookie, "/api/v1/billing/requests", {
      method: "POST",
      tenantId,
      body: { planCode: "CRM_START", requestType: "DOWNGRADE" },
    });
    assert.equal(blockedDown.status, 422);
    assert.equal(blockedDown.data.code, "LIMIT_EXCEEDED_AFTER_DOWNGRADE");
    assert.ok(await prisma.contact.findFirst({ where: { id: contact.id } }));

    const beforeEnd = await prisma.tenantPlan.findFirstOrThrow({ where: { tenantId } });
    const renew = await req(cookie, "/api/v1/billing/requests", {
      method: "POST",
      tenantId,
      body: { planCode: "CRM_BUSINESS", requestType: "RENEWAL" },
    });
    const renewed = await req(platformCookie, `/api/v1/admin/billing/requests/${renew.data.id}/confirm`, {
      method: "POST",
      body: {},
    });
    assert.ok(new Date(renewed.data.expiresAt).getTime() > new Date(beforeEnd.endsAt || 0).getTime());

    const expiredAt = new Date(Date.now() - 60_000);
    await prisma.tenantPlan.updateMany({
      where: { tenantId },
      data: { endsAt: expiredAt, status: "active" },
    });
    await expireDueSubscriptions(prisma);
    const expiryAudit = await prisma.auditEvent.findFirstOrThrow({
      where: { tenantId, action: "subscription.expired" },
      orderBy: { createdAt: "desc" },
    });
    assert.deepEqual(expiryAudit.changesJson, { endsAt: expiredAt.toISOString() });
    const expired = await req(cookie, "/api/v1/billing", { tenantId });
    assert.equal(expired.data.subscriptionStatus, "expired");
    assert.equal(expired.data.previewMode, true);
    assert.ok(await prisma.contact.findFirst({ where: { id: contact.id, tenantId } }));
  });
});
