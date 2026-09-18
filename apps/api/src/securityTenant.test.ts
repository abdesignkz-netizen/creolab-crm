import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";

describe("tenant isolation", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let server: { close: (cb?: (err?: Error) => void) => void; address: () => { port: number } | string | null };
  let url = "";
  let ownerA = "";
  let ownerB = "";

  async function login(email: string) {
    const response = await fetch(`${url}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: process.env.SEED_PASSWORD, client: "web" }),
    });
    assert.equal(response.status, 200, await response.text());
    return (response.headers.getSetCookie?.()?.[0] || response.headers.get("set-cookie") || "").split(";")[0];
  }

  async function req(cookie: string, path: string, init: { method?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = { cookie };
    if (init.body !== undefined) headers["content-type"] = "application/json";
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
    ownerA = await login("owner@creolab.example");
    ownerB = await login("owner@demo-agency.example");
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await prisma.$disconnect();
  });

  it("User A cannot read or mutate User B campaign by id", async () => {
    const created = await req(ownerB, "/api/v1/campaigns", {
      method: "POST",
      body: { title: "Чужая рассылка", messageDraft: "Привет", phones: ["+77015550001"] },
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const id = created.data.campaign?.id as string;
    assert.ok(id);

    const read = await req(ownerA, `/api/v1/campaigns/${id}`);
    assert.equal(read.status, 404);

    const confirm = await req(ownerA, `/api/v1/campaigns/${id}/confirm`, {
      method: "POST",
      body: { scheduledAt: "2099-01-01T12:00" },
    });
    assert.equal(confirm.status, 404);
    const original = await prisma.campaign.findUniqueOrThrow({ where: { id } });
    assert.equal(original.scheduledAt, null);

    const cancel = await req(ownerA, `/api/v1/campaigns/${id}/cancel-remainder`, { method: "POST", body: {} });
    assert.equal(cancel.status, 404);
    const after = await prisma.campaign.findUniqueOrThrow({ where: { id } });
    assert.notEqual(after.status, "cancelled");

    const retry = await req(ownerA, `/api/v1/campaigns/${id}/retry-failed`, { method: "POST", body: {} });
    assert.equal(retry.status, 404);
  });

  it("User A cannot read User B contact or inquiry by id", async () => {
    const contact = await req(ownerB, "/api/v1/contacts", {
      method: "POST",
      body: { name: "Клиент B", phone: "+7 701 555 00 02" },
    });
    assert.equal(contact.status, 201, JSON.stringify(contact.data));
    const contactId = contact.data.client?.id;
    assert.ok(contactId);
    const stolenContact = await req(ownerA, `/api/v1/contacts/${contactId}`);
    assert.equal(stolenContact.status, 404);

    const inquiry = await req(ownerB, "/api/v1/inquiries", {
      method: "POST",
      body: {
        name: "Заявка B",
        phone: "+7 701 555 00 03",
        subject: "Секрет",
        message: "Только для B",
        sourceChannel: "manual",
      },
    });
    assert.equal(inquiry.status, 201);
    const stolenInquiry = await req(ownerA, `/api/v1/inquiries/${inquiry.data.id}`);
    assert.equal(stolenInquiry.status, 404);
  });

  it("resolves x-tenant-id only for a membership of the authenticated user", async () => {
    const randomUUID = (await import("node:crypto")).randomUUID;
    const tenantA = await prisma.tenant.findFirstOrThrow({ where: { slug: "creolab" } });
    const tenantC = await prisma.tenant.findFirstOrThrow({ where: { slug: "demo-agency" } });
    const tenantB = await prisma.tenant.create({
      data: { name: "Tenant B resolution", slug: `tenant-b-${Date.now()}` },
    });
    const suspended = await prisma.tenant.create({
      data: { name: "Suspended tenant", slug: `tenant-susp-${Date.now()}`, status: "suspended" },
    });
    const ownerHash = (await prisma.user.findUniqueOrThrow({ where: { email: "owner@creolab.example" } })).passwordHash;
    const userA = await prisma.user.create({
      data: {
        email: `dual-${Date.now()}@creolab.example`,
        passwordHash: ownerHash,
        name: "Dual tenant",
        memberships: {
          create: [
            { tenantId: tenantA.id, role: "manager", active: true },
            { tenantId: tenantB.id, role: "manager", active: true },
            { tenantId: suspended.id, role: "manager", active: true },
          ],
        },
      },
    });
    const inactiveTenant = await prisma.tenant.create({
      data: { name: "Inactive membership", slug: `tenant-inact-${Date.now()}` },
    });
    await prisma.membership.create({
      data: { tenantId: inactiveTenant.id, userId: userA.id, role: "manager", active: false },
    });
    const cookie = await login(userA.email);

    async function me(headers: Record<string, string> = {}) {
      const response = await fetch(`${url}/api/v1/me`, { headers: { cookie, ...headers } });
      const data = await response.json().catch(() => ({}));
      return { status: response.status, data };
    }

    const withA = await me({ "x-tenant-id": tenantA.id });
    assert.equal(withA.status, 200, JSON.stringify(withA.data));
    assert.equal(withA.data.activeTenant.tenant.id, tenantA.id);

    const withB = await me({ "x-tenant-id": tenantB.id });
    assert.equal(withB.status, 200, JSON.stringify(withB.data));
    assert.equal(withB.data.activeTenant.tenant.id, tenantB.id);

    const withC = await me({ "x-tenant-id": tenantC.id });
    assert.equal(withC.status, 403);
    assert.equal(withC.data.code, "unknown_tenant");
    assert.notEqual(withC.data.activeTenant?.tenant?.id, tenantA.id);
    assert.notEqual(withC.data.activeTenant?.tenant?.id, tenantB.id);

    const random = await me({ "x-tenant-id": randomUUID() });
    assert.equal(random.status, 403);
    assert.equal(random.data.code, "unknown_tenant");
    assert.equal(random.data.activeTenant, undefined);

    const missing = await me();
    assert.equal(missing.status, 200);
    assert.ok([tenantA.id, tenantB.id].includes(missing.data.activeTenant.tenant.id));

    const inactive = await me({ "x-tenant-id": inactiveTenant.id });
    assert.equal(inactive.status, 403);
    assert.equal(inactive.data.code, "membership_suspended");
    assert.ok(Array.isArray(inactive.data.details?.memberships));
    assert.ok(inactive.data.details.memberships.every((item: { tenantId: string }) => item.tenantId !== inactiveTenant.id));
    assert.ok(inactive.data.details.memberships.some((item: { tenantId: string }) => item.tenantId === tenantA.id));

    const frozen = await me({ "x-tenant-id": suspended.id });
    assert.equal(frozen.status, 403);
    assert.equal(frozen.data.code, "tenant_suspended");
    assert.ok(frozen.data.details.memberships.every((item: { tenantId: string }) => item.tenantId !== suspended.id));

    const afterDenied = await me();
    assert.equal(afterDenied.status, 200);
    assert.equal(afterDenied.data.activeTenant.tenant.id, missing.data.activeTenant.tenant.id);
  });

  it("blocks GET/POST/PATCH/DELETE/export/confirm/retry across tenants", async () => {
    const contact = await req(ownerB, "/api/v1/contacts", {
      method: "POST",
      body: { name: "Клиент export B", phone: "+7 701 555 00 12" },
    });
    assert.equal(contact.status, 201, JSON.stringify(contact.data));
    const contactId = contact.data.client?.id as string;
    const inquiry = await req(ownerB, "/api/v1/inquiries", {
      method: "POST",
      body: {
        name: "Заявка export B",
        phone: "+7 701 555 00 13",
        subject: "Секрет export",
        message: "Только для B",
        sourceChannel: "manual",
      },
    });
    assert.equal(inquiry.status, 201);
    const inquiryId = inquiry.data.id as string;
    const campaign = await req(ownerB, "/api/v1/campaigns", {
      method: "POST",
      body: { title: "Рассылка export B", messageDraft: "Привет", phones: ["+77015550014"] },
    });
    assert.equal(campaign.status, 201, JSON.stringify(campaign.data));
    const campaignId = campaign.data.campaign?.id as string;

    assert.equal((await req(ownerA, `/api/v1/contacts/${contactId}`)).status, 404);
    assert.equal(
      (await req(ownerA, `/api/v1/contacts/${contactId}`, { method: "PATCH", body: { name: "Украдено" } })).status,
      404,
    );
    assert.equal((await req(ownerA, `/api/v1/inquiries/${inquiryId}`)).status, 404);
    assert.equal(
      (await req(ownerA, `/api/v1/inquiries/${inquiryId}`, { method: "PATCH", body: { subject: "Украдено" } })).status,
      404,
    );
    assert.equal((await req(ownerA, `/api/v1/campaigns/${campaignId}`)).status, 404);
    assert.equal(
      (await req(ownerA, `/api/v1/campaigns/${campaignId}`, { method: "PATCH", body: { title: "Украдено" } })).status,
      404,
    );
    assert.equal(
      (await req(ownerA, `/api/v1/campaigns/${campaignId}/confirm`, { method: "POST", body: { scheduledAt: "2099-01-01T12:00" } })).status,
      404,
    );
    assert.equal(
      (await req(ownerA, `/api/v1/campaigns/${campaignId}/retry-failed`, { method: "POST", body: {} })).status,
      404,
    );
    const excel = await fetch(`${url}/api/v1/electronic-documents/${campaignId}/excel`, { headers: { cookie: ownerA } });
    assert.ok(excel.status === 404 || excel.status === 403);
    const pdf = await fetch(`${url}/api/v1/electronic-documents/${campaignId}/pdf`, { headers: { cookie: ownerA } });
    assert.ok(pdf.status === 404 || pdf.status === 403);
    const invoicePdf = await fetch(`${url}/api/v1/invoices/${contactId}/pdf`, { headers: { cookie: ownerA } });
    assert.ok(invoicePdf.status === 404 || invoicePdf.status === 403);
    const contractPdf = await fetch(`${url}/api/v1/contracts/${inquiryId}/pdf`, { headers: { cookie: ownerA } });
    assert.ok(contractPdf.status === 404 || contractPdf.status === 403);

    const stillContact = await prisma.contact.findUniqueOrThrow({ where: { id: contactId } });
    assert.equal(stillContact.name, "Клиент export B");
    const stillCampaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    assert.equal(stillCampaign.title, "Рассылка export B");

    const tagged = await req(ownerB, `/api/v1/contacts/${contactId}/tags`, {
      method: "POST",
      body: { name: "secret-b" },
    });
    assert.ok(tagged.status === 200 || tagged.status === 201, JSON.stringify(tagged.data));
    const tagId = (tagged.data.tags || []).find((item: { name: string }) => item.name === "secret-b")?.id;
    assert.ok(tagId);
    const stolenDelete = await req(ownerA, `/api/v1/contacts/${contactId}/tags/${tagId}`, { method: "DELETE" });
    assert.ok(stolenDelete.status === 404 || stolenDelete.status === 403);
    const stillTagged = await req(ownerB, `/api/v1/contacts/${contactId}`);
    assert.ok((stillTagged.data.tags || []).some((item: { name: string }) => item.name === "secret-b"));
  });
});
