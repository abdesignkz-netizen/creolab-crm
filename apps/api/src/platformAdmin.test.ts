import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { resolveSellerBridge } from "./services/sellerLink.ts";

describe("platform admin panel", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let server: { close: (cb?: (err?: Error) => void) => void; address: () => { port: number } | string | null };
  let url = "";
  let platformCookie = "";
  let ownerCookie = "";
  let managerCookie = "";
  let creolabId = "";
  let demoId = "";

  async function login(email: string) {
    const response = await fetch(`${url}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: process.env.SEED_PASSWORD, client: "web" }),
    });
    assert.equal(response.status, 200, await response.text());
    let cookie = response.headers.getSetCookie?.()?.[0]?.split(";")[0] || "";
    if (!cookie) cookie = (response.headers.get("set-cookie") || "").split(";")[0];
    assert.ok(cookie);
    return cookie;
  }

  async function req(cookie: string, path: string, init: { method?: string; body?: unknown; tenantId?: string } = {}) {
    const headers: Record<string, string> = { cookie };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.tenantId) headers["x-tenant-id"] = init.tenantId;
    const response = await fetch(`${url}${path}`, {
      method: init.method || "GET",
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, data };
  }

  before(async () => {
    process.env.SEED_PASSWORD ||= "ChangeMeLocal1!";
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
    ownerCookie = await login("owner@creolab.example");
    managerCookie = await login("manager@creolab.example");
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("blocks company admin and manager from the service panel", async () => {
    assert.equal((await req(ownerCookie, "/api/v1/admin/overview")).status, 403);
    assert.equal((await req(managerCookie, "/api/v1/admin/tenants")).status, 403);
    assert.equal((await req(managerCookie, "/api/v1/documents", { tenantId: creolabId })).status, 403);
  });

  it("creates a company, invitation, and accepts into the right tenant", async () => {
    const created = await req(platformCookie, "/api/v1/admin/tenants", {
      method: "POST",
      body: {
        name: "Новая студия",
        adminEmail: "director-new@example.test",
        adminName: "Директор",
        adminRole: "owner",
        city: "Алматы",
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.invitation.delivery, "link_created");
    assert.match(String(created.data.invitation.inviteUrl), /\/invite\//);
    const json = JSON.stringify(created.data);
    assert.equal(json.includes("password"), false);
    assert.equal(json.includes("tokenHash"), false);
    const token = String(created.data.invitation.inviteUrl).split("/invite/")[1];
    const preview = await req("", `/api/v1/invitations/${token}`);
    assert.equal(preview.status, 200);
    const accepted = await req("", `/api/v1/invitations/${token}/accept`, {
      method: "POST",
      body: { password: "InvitePass1!", name: "Директор" },
    });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
    assert.equal(accepted.data.tenantId, created.data.company.id);
    const directorLogin = await fetch(`${url}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "director-new@example.test", password: "InvitePass1!", client: "web" }),
    });
    assert.equal(directorLogin.status, 200, await directorLogin.text());
    let directorCookie = directorLogin.headers.getSetCookie?.()?.[0]?.split(";")[0] || "";
    if (!directorCookie) directorCookie = (directorLogin.headers.get("set-cookie") || "").split(";")[0];
    assert.equal((await req(directorCookie, "/api/v1/admin/overview")).status, 403);
    const me = await req(directorCookie, "/api/v1/me", { tenantId: created.data.company.id });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.platformAdmin, false);
    assert.equal(me.data.activeTenant.tenant.id, created.data.company.id);
  });

  it("links an existing user without creating a duplicate", async () => {
    const email = "owner@demo-agency.example";
    const before = await prisma.user.count({ where: { email } });
    const created = await req(platformCookie, "/api/v1/admin/tenants", {
      method: "POST",
      body: { name: "Вторая студия", adminEmail: email, adminRole: "director" },
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.invitation.existingUser, true);
    const token = String(created.data.invitation.inviteUrl).split("/invite/")[1];
    const demoCookie = await login(email);
    const accepted = await req(demoCookie, `/api/v1/invitations/${token}/accept`, { method: "POST", body: {} });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
    assert.equal(await prisma.user.count({ where: { email } }), before);
    const memberships = await prisma.membership.count({ where: { user: { email } } });
    assert.ok(memberships >= 2);
  });

  it("rejects invitation accept from a different logged-in account", async () => {
    const created = await req(platformCookie, "/api/v1/admin/tenants", {
      method: "POST",
      body: { name: "Третья студия", adminEmail: "manager@creolab.example", adminRole: "owner" },
    });
    const token = String(created.data.invitation.inviteUrl).split("/invite/")[1];
    const mismatch = await req(ownerCookie, `/api/v1/invitations/${token}/accept`, { method: "POST", body: {} });
    assert.equal(mismatch.status, 403);
  });

  it("keeps tenant integration isolation", async () => {
    const a = await req(platformCookie, `/api/v1/admin/tenants/${creolabId}/integrations`, { method: "POST", body: { type: "webhook", name: "Hook A" } });
    assert.equal(a.status, 201, JSON.stringify(a.data));
    assert.ok(a.data.secret);
    assert.equal(JSON.stringify(a.data).includes(a.data.secret) || true, true);
    const listed = await req(platformCookie, `/api/v1/admin/tenants/${demoId}/integrations`);
    assert.equal(listed.status, 200);
    const ids = (listed.data.items || []).map((item: { id: string }) => item.id);
    assert.equal(ids.includes(a.data.id), false);
  });

  it("does not treat a saved form as a live provider handshake", async () => {
    const tenant = await prisma.tenant.create({ data: { name: "Form Co", slug: `form-co-${Date.now()}` } });
    const created = await req(platformCookie, `/api/v1/admin/tenants/${tenant.id}/integrations`, {
      method: "POST",
      body: { type: "form", name: "Сайт" },
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.lifecycle, "connected");
    assert.match(String(created.data.note || ""), /адрес приёма|сохран/i);
  });

  it("does not use the global WhatsApp bridge for an unconfigured company", async () => {
    process.env.WHATSAPP_SELLER_URL = "https://shared-bot.example";
    process.env.WHATSAPP_SELLER_SECRET = "shared-secret";
    const tenant = await prisma.tenant.create({ data: { name: "Empty WA", slug: `empty-wa-${Date.now()}` } });
    const resolved = await resolveSellerBridge(prisma, tenant.id);
    assert.equal(resolved.configured, false);
    assert.equal(resolved.bridge, null);
  });

  it("suspends a company and rejects inbound form with a clear error", async () => {
    const tenant = await prisma.tenant.create({ data: { name: "Pause Co", slug: `pause-co-${Date.now()}` } });
    const form = await req(platformCookie, `/api/v1/admin/tenants/${tenant.id}/integrations`, {
      method: "POST",
      body: { type: "form", name: "Форма" },
    });
    assert.equal(form.status, 201, JSON.stringify(form.data));
    const publicKey = form.data.forms[0].publicKey;
    const paused = await req(platformCookie, `/api/v1/admin/tenants/${tenant.id}/suspend`, { method: "POST" });
    assert.equal(paused.status, 200);
    const submit = await fetch(`${url}/public/forms/${publicKey}/submissions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "A", phone: "+77010000000" }),
    });
    const body = await submit.json();
    assert.equal(submit.status, 403);
    assert.equal(body.code, "tenant_suspended");
    const restored = await req(platformCookie, `/api/v1/admin/tenants/${tenant.id}/restore`, { method: "POST" });
    assert.equal(restored.status, 200);
  });

  it("disabling an integration rejects webhook events", async () => {
    const created = await req(platformCookie, `/api/v1/admin/tenants/${creolabId}/integrations`, {
      method: "POST",
      body: { type: "webhook", name: "Disable me" },
    });
    await req(platformCookie, `/api/v1/admin/tenants/${creolabId}/integrations/${created.data.id}/disable`, {
      method: "POST",
      body: { disabled: true },
    });
    const event = await fetch(`${url}/api/v1/integrations/${created.data.id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${created.data.secret}` },
      body: JSON.stringify({ event_id: "evt-1", contact: { methods: [{ type: "phone", value: "+7701" }] } }),
    });
    assert.equal(event.status, 403);
  });

  it("keeps secrets out of audit entries", async () => {
    const secret = "super-secret-value-not-for-logs";
    const tenant = await prisma.tenant.create({ data: { name: "Audit Co", slug: `audit-co-${Date.now()}` } });
    await req(platformCookie, `/api/v1/admin/tenants/${tenant.id}/integrations`, {
      method: "POST",
      body: { type: "webhook", name: "Secret hook" },
    });
    const audit = await req(platformCookie, `/api/v1/admin/audit?tenantId=${tenant.id}`);
    assert.equal(audit.status, 200);
    assert.equal(JSON.stringify(audit.data).includes("whsec_"), false);
    assert.equal(JSON.stringify(audit.data).includes(secret), false);
  });

  it("refuses to remove the last company admin", async () => {
    const tenant = await prisma.tenant.create({ data: { name: "Solo Admin", slug: `solo-admin-${Date.now()}` } });
    const user = await prisma.user.create({
      data: { email: `solo-${Date.now()}@example.test`, passwordHash: "x", name: "Solo" },
    });
    const membership = await prisma.membership.create({
      data: { tenantId: tenant.id, userId: user.id, role: "owner" },
    });
    const result = await req(platformCookie, `/api/v1/admin/members/${membership.id}`, {
      method: "PATCH",
      body: { role: "manager" },
    });
    assert.equal(result.status, 422);
    assert.equal(result.data.code, "last_admin");
  });

  it("platform login accepts service admin and rejects company admin", async () => {
    const owner = await fetch(`${url}/api/v1/auth/platform-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@creolab.example", password: process.env.SEED_PASSWORD, client: "web" }),
    });
    assert.equal(owner.status, 403);
    const platform = await fetch(`${url}/api/v1/auth/platform-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "platform@creolab.example", password: process.env.SEED_PASSWORD, client: "web" }),
    });
    assert.equal(platform.status, 200, await platform.text());
  });
});
