import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";

describe("Documents phase 5", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let server: { close: () => void };
  let base = "";
  let cookie = "";
  let otherCookie = "";
  let contactId = "";
  let dealId = "";
  let contractId = "";
  let documentId = "";

  async function json(path: string, init: RequestInit = {}, useCookie = cookie) {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        cookie: useCookie,
        ...(init.headers || {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    return { response, body };
  }

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

    const login = await json(
      "/api/v1/auth/login",
      {
        method: "POST",
        body: JSON.stringify({
          email: "owner@creolab.example",
          password: process.env.SEED_PASSWORD,
          client: "web",
        }),
      },
      "",
    );
    cookie = login.response.headers.get("set-cookie") || "";
    const demo = await json(
      "/api/v1/auth/login",
      {
        method: "POST",
        body: JSON.stringify({
          email: "owner@demo-agency.example",
          password: process.env.SEED_PASSWORD,
          client: "web",
        }),
      },
      "",
    );
    otherCookie = demo.response.headers.get("set-cookie") || "";

    const profile = await json("/api/v1/settings/legal-profile", {
      method: "PATCH",
      body: JSON.stringify({
        legalName: "ТОО CREOLAB",
        bin: "123456789013",
        legalAddress: "г. Алматы, пр. Абая 1",
        directorName: "Иванов Иван",
        defaultVatMode: "percent",
        defaultVatRate: 12,
      }),
    });
    assert.equal(profile.response.status, 200);

    const created = await json("/api/v1/contacts", {
      method: "POST",
      body: JSON.stringify({ name: "Phase5 клиент", phone: "+77015550051" }),
    });
    contactId = created.body.client?.id || created.body.id;

    const deal = await json("/api/v1/deals", {
      method: "POST",
      body: JSON.stringify({
        title: "Phase5 сайт",
        contactId,
        items: [{ name: "Разработка сайта", quantity: 1, unitPrice: 850000 }],
      }),
    });
    assert.equal(deal.response.status, 201);
    dealId = deal.body.deal.id;

    const company = await json("/api/v1/companies", {
      method: "POST",
      body: JSON.stringify({
        name: "ТОО Phase5 Buyer",
        legalName: "ТОО Phase5 Buyer",
        bin: "222222222220",
        legalAddress: "г. Астана, ул. Кабанбай 10",
        forceCreate: true,
      }),
    });
    assert.equal(company.response.status, 201, JSON.stringify(company.body));
    await json(`/api/v1/deals/${dealId}`, {
      method: "PATCH",
      body: JSON.stringify({ companyId: company.body.id }),
    });

    const draft = await json(`/api/v1/deals/${dealId}/contracts`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    contractId = draft.body.contract.id;
    const generated = await json(`/api/v1/contracts/${contractId}/generate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(generated.response.status, 200, JSON.stringify(generated.body));
  });

  after(() => {
    server?.close();
  });

  it("создаёт внутренний черновик АВР из позиций сделки и не пускает проверку без SIGNED", async () => {
    const ready = await json(`/api/v1/deals/${dealId}/avr-readiness`);
    assert.equal(ready.response.status, 200);
    assert.equal(ready.body.ready, false);
    assert.ok(ready.body.missingFields.includes("contract.signed"));

    const draft = await json(`/api/v1/deals/${dealId}/electronic-documents`, {
      method: "POST",
      body: JSON.stringify({ type: "AVR" }),
    });
    assert.equal(draft.response.status, 201, JSON.stringify(draft.body));
    documentId = draft.body.document.id;
    assert.equal(draft.body.document.status, "DRAFT");
    assert.equal(draft.body.document.source.kind, "avr_internal_v1");
    assert.equal(draft.body.document.source.items[0].name, "Разработка сайта");
    assert.equal(draft.body.document.source.contract, null);
    assert.equal(draft.body.document.source.xml, undefined);

    const again = await json(`/api/v1/deals/${dealId}/electronic-documents`, {
      method: "POST",
      body: JSON.stringify({ type: "AVR" }),
    });
    assert.equal(again.body.document.id, documentId);
    assert.equal(again.body.reused, true);

    const validated = await json(`/api/v1/electronic-documents/${documentId}/validate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(validated.response.status, 422);
    assert.equal(validated.body.code, "missing_fields");
    assert.ok(validated.body.details.missingFields.includes("contract.signed"));
  });

  it("после SIGNED заполняет договор в snapshot и ставит VALIDATED", async () => {
    await prisma.contract.update({
      where: { id: contractId },
      data: { status: "SIGNED", signedAt: new Date() },
    });

    const ready = await json(`/api/v1/deals/${dealId}/avr-readiness`);
    assert.equal(ready.body.ready, true);

    const refreshed = await json(`/api/v1/deals/${dealId}/electronic-documents`, {
      method: "POST",
      body: JSON.stringify({ type: "AVR" }),
    });
    assert.equal(refreshed.body.document.contractId, contractId);
    assert.equal(refreshed.body.document.source.contract.number, refreshed.body.document.source.contract.number);

    const validated = await json(`/api/v1/electronic-documents/${documentId}/validate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(validated.response.status, 200, JSON.stringify(validated.body));
    assert.equal(validated.body.document.status, "VALIDATED");
    assert.ok(validated.body.document.validatedAt);
    assert.equal(validated.body.document.source.seller.bin, "123456789013");
    assert.equal(validated.body.document.source.buyer.bin, "222222222220");
    assert.equal(validated.body.document.source.contract.id, contractId);
    assert.ok(validated.body.document.source.contract.date);
    assert.equal(validated.body.document.source.items[0].name, "Разработка сайта");
  });

  it("не отдаёт АВР другому тенанту и не даёт проверить после отправки", async () => {
    const foreign = await json(`/api/v1/electronic-documents/${documentId}`, {}, otherCookie);
    assert.equal(foreign.response.status, 404);

    const foreignValidate = await json(
      `/api/v1/electronic-documents/${documentId}/validate`,
      { method: "POST", body: JSON.stringify({}) },
      otherCookie,
    );
    assert.equal(foreignValidate.response.status, 404);

    await prisma.electronicDocument.update({
      where: { id: documentId },
      data: { status: "SENT" },
    });
    const locked = await json(`/api/v1/electronic-documents/${documentId}/validate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(locked.response.status, 422);
    assert.equal(locked.body.code, "avr_immutable");
  });
});
