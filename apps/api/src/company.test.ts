import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";

describe("Companies B2B", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let server: { close: () => void };
  let base = "";
  let cookie = "";
  let contactId = "";

  before(async () => {
    process.env.SEED_PASSWORD ||= "ChangeMeLocal1!";
    prisma = await createPrismaClient();
    const { seedDatabase } = await import("../../../packages/db/src/seed.ts");
    await seedDatabase();
    app = createApp(prisma);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const address = (server as { address: () => { port: number } }).address();
    base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "owner@creolab.example",
        password: process.env.SEED_PASSWORD,
        client: "web",
      }),
    });
    cookie = login.headers.get("set-cookie") || "";
    assert.ok(cookie);
  });

  after(() => {
    server?.close();
  });

  it("B2C contact works without company", async () => {
    const created = await fetch(`${base}/api/v1/contacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ name: "Алина Solo", phone: "+77012220002" }),
    });
    assert.equal(created.status, 201);
    const body: any = await created.json();
    const id = body.client?.id || body.id;
    const overview = await fetch(`${base}/api/v1/contacts/${id}/overview`, { headers: { cookie } });
    assert.equal(overview.status, 200);
    const data: any = await overview.json();
    assert.equal((data.companies || []).length, 0);
  });

  it("creates company, links contacts, switches primary, overview ok", async () => {
    const a = await fetch(`${base}/api/v1/contacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ name: "Алия Маркетолог", phone: "+77013330003", companyName: "ABC Construction" }),
    });
    const aBody: any = await a.json();
    const aliaId = aBody.client?.id || aBody.id;

    const b = await fetch(`${base}/api/v1/contacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ name: "Александр Директор", phone: "+77014440004" }),
    });
    const bBody: any = await b.json();
    const alexId = bBody.client?.id || bBody.id;

    const companyRes = await fetch(`${base}/api/v1/companies`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        name: "ABC Construction",
        bin: "123456789012",
        city: "Алматы",
        industry: "Строительство",
        forceCreate: true,
      }),
    });
    assert.equal(companyRes.status, 201);
    const company: any = await companyRes.json();
    assert.ok(company.id);

    const link1 = await fetch(`${base}/api/v1/companies/${company.id}/contacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        contactId: aliaId,
        position: "Маркетолог",
        isPrimary: true,
      }),
    });
    assert.equal(link1.status, 201);

    const link2 = await fetch(`${base}/api/v1/companies/${company.id}/contacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        contactId: alexId,
        position: "Директор",
        isPrimary: true,
        isDecisionMaker: true,
      }),
    });
    assert.equal(link2.status, 201);

    const contacts = await fetch(`${base}/api/v1/companies/${company.id}/contacts`, { headers: { cookie } });
    const contactsBody: any = await contacts.json();
    const primary = (contactsBody.contacts || []).filter((c: any) => c.isPrimary);
    assert.equal(primary.length, 1);
    assert.equal(primary[0].contactId, alexId);
    assert.ok((contactsBody.contacts || []).some((c: any) => c.isDecisionMaker));

    const overview = await fetch(`${base}/api/v1/companies/${company.id}/overview`, { headers: { cookie } });
    assert.equal(overview.status, 200);
    const ov: any = await overview.json();
    assert.equal(ov.company.name, "ABC Construction");
    assert.ok(ov.contacts.length >= 2);
    assert.ok(ov.lifetime);
    assert.ok(ov.current);

    const dup = await fetch(
      `${base}/api/v1/companies/duplicates?name=ABC%20Construction&bin=123456789012`,
      { headers: { cookie } },
    );
    assert.equal(dup.status, 200);
    const dupBody: any = await dup.json();
    assert.ok((dupBody.duplicates || []).length >= 1);

    const migrate = await fetch(`${base}/api/v1/companies/migrate-preview`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(migrate.status, 200);
    const mig: any = await migrate.json();
    assert.ok(Array.isArray(mig.candidates));

    contactId = aliaId;
  });

  it("lists companies and contact overview includes company", async () => {
    const list = await fetch(`${base}/api/v1/companies`, { headers: { cookie } });
    assert.equal(list.status, 200);
    const body: any = await list.json();
    assert.ok((body.items || []).length >= 1);

    if (contactId) {
      const overview = await fetch(`${base}/api/v1/contacts/${contactId}/overview`, { headers: { cookie } });
      assert.equal(overview.status, 200);
      const data: any = await overview.json();
      assert.ok((data.companies || []).length >= 1);
    }
  });
});
