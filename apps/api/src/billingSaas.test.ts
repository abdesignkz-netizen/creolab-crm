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

    for (const [code, price, users, ai, control] of [
      ["CONTROL", 29900, 5, false, true], ["SALES", 49900, 10, true, true], ["FULL", 69900, 20, true, true],
    ] as const) {
      const quote = await quoteSubscription(prisma, { planCode: code });
      assert.equal(quote.finalAmountMinor, price);
      assert.equal(quote.limits.USERS, users);
      assert.equal(quote.features.AI_MANAGER, ai);
      assert.equal(quote.features.AI_CONTROL, control);
    }
    for (const code of ["CRM_BUSINESS", "CRM_PRO", "AI_SALES", "CONTROL_STANDALONE", "BUNDLE_CRM_AI", "BUNDLE_FULL"]) {
      await assert.rejects(quoteSubscription(prisma, { planCode: code }), /недоступен/);
    }
    for (const code of ["ADDON_AI_START", "ADDON_AI_BUSINESS", "ADDON_AI_PRO", "ADDON_CONTROL"]) {
      await assert.rejects(quoteSubscription(prisma, { planCode: "SALES", addOns: [{ code }] }), /недоступно/);
    }

    const yearly = await quoteSubscription(prisma, { planCode: "CRM_START", billingPeriod: "YEARLY" });
    assert.equal(yearly.finalAmountMinor, 149000);
  });

  it("lets a new company enter Free, request a plan, and wait for admin payment confirmation", async () => {
    const account = await signup("Олжас", "Студия Олжас", `billing-${Date.now()}@example.test`);
    const { cookie, tenantId } = account;

    const billing = await req(cookie, "/api/v1/billing", { tenantId });
    assert.equal(billing.status, 200);
    assert.equal(billing.data.previewMode, false);
    assert.equal(billing.data.planCode, "BASQAR_FREE");
    assert.equal(billing.data.preview, null);

    const plans = await req(cookie, "/api/v1/billing/plans", { tenantId });
    assert.equal(plans.status, 200);
    assert.ok((plans.data.offers || []).some((item: { code: string }) => item.code === "SALES"));

    const blocked = await req(cookie, "/api/v1/ai/sandbox", { method: "POST", tenantId, body: { message: "hi" } });
    assert.equal(blocked.status, 403);

    const spoofed = await req(cookie, "/api/v1/billing/requests", {
      method: "POST",
      tenantId,
      body: { planCode: "SALES", finalAmountMinor: 1, amount: 1, addOns: [] },
    });
    assert.equal(spoofed.status, 201, JSON.stringify(spoofed.data));
    assert.equal(spoofed.data.finalAmountMinor, 49900);
    assert.equal(spoofed.data.status, "AWAITING_PAYMENT");

    const afterRequest = await req(cookie, "/api/v1/billing", { tenantId });
    assert.equal(afterRequest.data.previewMode, false);
    assert.equal(afterRequest.data.entitlements.AI_MANAGER, false);
    assert.equal(afterRequest.data.currentRequest.finalAmountMinor, 49900);

    const duplicate = await req(cookie, "/api/v1/billing/requests", {
      method: "POST",
      tenantId,
      body: { planCode: "SALES" },
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
    assert.equal(confirmed.data.planCode, "SALES");
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
      body: { planCode: "CONTROL", requestType: "UPGRADE" },
    });
    assert.equal(upgrade.status, 201);
    const upgraded = await req(platformCookie, `/api/v1/admin/billing/requests/${upgrade.data.id}/confirm`, {
      method: "POST",
      body: {},
    });
    assert.equal(upgraded.data.planCode, "CONTROL");
    assert.equal(upgraded.data.entitlements.DOCUMENTS, true);
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
      body: { planCode: "CONTROL", requestType: "RENEWAL" },
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
  it("enforces Free on HTTP routes while manual tasks and company isolation keep working", async () => {
    const { cookie, tenantId } = await signup("Free Owner", "Free HTTP", `free-http-${Date.now()}@example.test`);
    for (const [path, method] of [["/contacts/import", "POST"], ["/contacts/export", "GET"], ["/documents/import-pdf/preview", "POST"], ["/tasks/parse-command", "POST"], ["/analytics/trend", "GET"]]) {
      const result = await req(cookie, `/api/v1${path}`, { tenantId, method, ...(method === "POST" ? { body: {} } : {}) });
      assert.equal(result.status, 403, `${path}: ${JSON.stringify(result.data)}`);
    }
    const created = await req(cookie, "/api/v1/tasks", { tenantId, method: "POST", body: { type: "note", title: "Ручная задача", targetType: "none", priority: "high" } });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const taskId = created.data.id || created.data.task?.id;
    assert.ok(taskId);
    for (const action of ["complete", "reopen"]) {
      const response = await req(cookie, `/api/v1/tasks/${taskId}/${action}`, { tenantId, method: "POST", body: {} });
      assert.equal(response.status, 200, JSON.stringify(response.data));
    }
    const admin = await req(cookie, "/api/v1/admin/billing/free", { tenantId });
    assert.equal(admin.status, 403);
  });

  it("rolls back payment on activation failure, retains the quote and serializes duplicate approval", async () => {
    const { cookie, tenantId } = await signup("Safe", "Atomic billing", `atomic-${Date.now()}@example.test`);
    const requested = await req(cookie, "/api/v1/billing/requests", { tenantId, method: "POST", body: { planCode: "CRM_START", baseAmountMinor: 1, limits: { USERS: 999 } } });
    assert.equal(requested.status, 201);
    const id = requested.data.id;
    const failed = await req(platformCookie, `/api/v1/admin/billing/requests/${id}/confirm`, { method: "POST", body: { endDate: "2000-01-01" } });
    assert.equal(failed.status, 422, JSON.stringify(failed.data));
    assert.equal(await prisma.billingPayment.count({ where: { tenantId } }), 0);
    assert.equal((await prisma.subscriptionRequest.findUniqueOrThrow({ where: { id } })).status, "AWAITING_PAYMENT");
    const plan = await prisma.plan.findUniqueOrThrow({ where: { code: "CRM_START" } });
    await prisma.plan.update({ where: { id: plan.id }, data: { monthlyPriceMinor: 44444, limitsJson: { USERS: 1 } } });
    try {
      const approved = await Promise.all([1,2].map(() => req(platformCookie, `/api/v1/admin/billing/requests/${id}/confirm`, { method: "POST", body: {} })));
      for (const result of approved) { assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.amountMinor, 14900); assert.equal(result.data.limits.USERS, 3); }
      assert.equal(await prisma.billingPayment.count({ where: { tenantId, status: "CONFIRMED" } }), 1);
      assert.equal(await prisma.auditEvent.count({ where: { tenantId, action: "payment.confirmed" } }), 1);
      assert.ok(await prisma.notification.findFirst({ where: { tenantId, type: "billing.subscription" } }));
    } finally {
      await prisma.plan.update({ where: { id: plan.id }, data: { monthlyPriceMinor: plan.monthlyPriceMinor, limitsJson: plan.limitsJson as never } });
    }
  });

  it("edits Free capacity without deployment, rejects new signup atomically and preserves existing companies", async () => {
    const existing = await signup("Existing", "Existing Free", `existing-free-${Date.now()}@example.test`);
    const policy = await req(platformCookie, "/api/v1/admin/billing/free", { method: "PATCH", body: { maxActiveFreeTenants: 0 } });
    assert.equal(policy.status, 200);
    assert.ok(policy.data.active > 0);
    try {
      const email = `capacity-${Date.now()}@example.test`;
      const begin = await req("", "/api/v1/auth/register", { method: "POST", body: { name: "Capacity", companyName: "Capacity test", email, password: "SignupPass1!", passwordConfirm: "SignupPass1!" } });
      assert.equal(begin.status, 200);
      const done = await req("", "/api/v1/auth/register/verify", { method: "POST", body: { email, code: begin.data.verificationCode } });
      assert.equal(done.status, 503, JSON.stringify(done.data));
      assert.equal(await prisma.user.findUnique({ where: { email } }), null);
      assert.equal((await req(existing.cookie, "/api/v1/billing", { tenantId: existing.tenantId })).data.subscriptionStatus, "active");
    } finally { await req(platformCookie, "/api/v1/admin/billing/free", { method: "PATCH", body: { maxActiveFreeTenants: 5000 } }); }
  });

  it("records administrator renewals as requests and payments with agreed prices", async () => {
    const tenant = await signup("Renewal", "Renewal company", `renewal-admin-${Date.now()}@example.test`);
    const request = await req(tenant.cookie, "/api/v1/billing/requests", { method: "POST", body: { planCode: "CRM_START" } });
    await req(platformCookie, `/api/v1/admin/billing/requests/${request.data.id}/confirm`, { method: "POST", body: {} });
    const current = await prisma.tenantPlan.findFirstOrThrow({ where: { tenantId: tenant.tenantId } });
    const snapshot = current.priceSnapshotJson as { finalAmountMinor: number };
    const response = await req(platformCookie, `/api/v1/admin/tenants/${tenant.tenantId}/subscription/extend`, { method: "POST", body: {} });
    assert.equal(response.status,200,JSON.stringify(response.data));
    assert.equal(response.data.amountMinor,snapshot.finalAmountMinor);
    assert.ok(new Date(response.data.expiresAt).getTime() > current.endsAt!.getTime());
    assert.equal(await prisma.billingPayment.count({where:{tenantId:tenant.tenantId}}),2);
    assert.equal(await prisma.subscriptionRequest.count({where:{tenantId:tenant.tenantId,requestType:"RENEWAL",status:"ACTIVATED"}}),1);
  });

  it("activates Free without a payment and rejects excessive downgrade usage", async () => {
    const account = await signup("Free switch", "Free switch company", `free-switch-${Date.now()}@example.test`);
    const paid = await req(platformCookie, `/api/v1/admin/tenants/${account.tenantId}/subscription/activate`, {method:"POST",body:{planCode:"CRM_START"}});
    assert.equal(paid.status,200,JSON.stringify(paid.data));
    const payments=await prisma.billingPayment.count({where:{tenantId:account.tenantId}});
    const free=await req(account.cookie,"/api/v1/billing/requests",{method:"POST",body:{planCode:"BASQAR_FREE"}});
    assert.equal(free.status,201,JSON.stringify(free.data));assert.equal(free.data.status,"ACTIVATED");
    const state=await req(account.cookie,"/api/v1/billing");
    assert.equal(state.data.planCode,"BASQAR_FREE");assert.equal(state.data.expiresAt,null);assert.equal(state.data.paymentMethod,"FREE");
    assert.equal(await prisma.billingPayment.count({where:{tenantId:account.tenantId}}),payments);
  });

  it("enforces the five-tier HTTP matrix, including reads and advanced settings", async () => {
    const account = await signup("Matrix", "Matrix company", `matrix-${Date.now()}@example.test`);
    for (const [index, planCode] of ["BASQAR_FREE", "CRM_START", "CONTROL", "SALES", "FULL"].entries()) {
      if (index > 0) {
        const activated = await req(platformCookie, `/api/v1/admin/tenants/${account.tenantId}/subscription/activate`, {method:"POST",body:{planCode}});
        assert.equal(activated.status,200,JSON.stringify(activated.data));
      }
      for (const [path,minimum] of [["support/articles",1],["documents",2],["workspace/control",2],["settings/ai-automation",3],["campaigns/missing",3]] as const) {
        const response = await req(account.cookie, `/api/v1/${path}`, {tenantId:account.tenantId});
        assert.equal(response.status,index >= minimum ? (path === "campaigns/missing" ? 404 : 200) : 403,`${planCode} ${path}: ${JSON.stringify(response.data)}`);
      }
      if(index >= 3) {
        const advanced = await req(account.cookie,"/api/v1/settings/ai-automation",{method:"PATCH",body:{serviceModes:{WEB:"AUTO"}}});
        assert.equal(advanced.status,index === 4 ? 200 : 403,JSON.stringify(advanced.data));
        const mode = await req(account.cookie,"/api/v1/settings/ai-automation",{method:"PATCH",body:{defaultMode:"ASSIST"}});
        assert.equal(mode.status,200,JSON.stringify(mode.data));
      }
    }
  });

  it("requires administrator Enterprise terms and preserves the agreed SLA", async () => {
    const tenant = await signup("Enterprise", "Custom company", `enterprise-${Date.now()}@example.test`);
    const request = await req(tenant.cookie, "/api/v1/billing/requests", { method:"POST", body:{planCode:"CRM_ENTERPRISE", enterpriseTerms:{customPriceMinor:1,limits:{USERS:999}}} });
    assert.equal(request.status,201);
    const path = `/api/v1/admin/billing/requests/${request.data.id}/confirm`;
    assert.equal((await req(tenant.cookie,path,{method:"POST",body:{}})).status,403);
    assert.equal((await req(platformCookie,path,{method:"POST",body:{}})).status,422);
    assert.equal(await prisma.billingPayment.count({where:{tenantId:tenant.tenantId}}),0);
    const activated = await req(platformCookie,path,{method:"POST",body:{enterpriseTerms:{customPriceMinor:123000,limits:{USERS:15,DATABASE_MB:100,FILE_STORAGE_MB:2048},features:{DOCUMENTS:true},sla:"Ответ в рабочее время",integrations:"Существующий API"}}});
    assert.equal(activated.status,200,JSON.stringify(activated.data));
    assert.equal(activated.data.amountMinor,123000); assert.equal(activated.data.limits.USERS,15);
    assert.equal(activated.data.limits.STORAGE_GB,2);
    assert.equal(activated.data.enterpriseTerms.sla,"Ответ в рабочее время");
  });

});
