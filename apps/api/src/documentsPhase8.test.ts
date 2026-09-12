import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { mockSetInvoiceStatus, resetEsfMock } from "./integrations/esf/EsfMock.ts";

describe("Documents phase 8 ЭСФ → syncInvoice", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let server: { close: () => void };
  let base = "";
  let cookie = "";
  let otherCookie = "";
  let dealId = "";
  let avrId = "";
  let esfId = "";

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
    process.env.ESF_ENV = "off";
    process.env.ESF_PROVIDER = "mock";
    delete process.env.ESF_ALLOW_LIVE_SEND;
    resetEsfMock();
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

    await json("/api/v1/settings/legal-profile", {
      method: "PATCH",
      body: JSON.stringify({
        legalName: "ТОО CREOLAB",
        bin: "123456789013",
        legalAddress: "г. Алматы, пр. Абая 1",
        directorName: "Иванов Иван",
        bankName: "Kaspi",
        iban: "KZ123456789012345678",
        bik: "CASPKZKA",
        defaultVatMode: "percent",
        defaultVatRate: 12,
        defaultCatalogTruId: "1",
        esfIntegrationEnabled: true,
      }),
    });

    const created = await json("/api/v1/contacts", {
      method: "POST",
      body: JSON.stringify({ name: "Phase8 клиент", phone: "+77015550081" }),
    });
    const contactId = created.body.client?.id || created.body.id;
    const deal = await json("/api/v1/deals", {
      method: "POST",
      body: JSON.stringify({
        title: "Phase8 ЭСФ syncInvoice",
        contactId,
        items: [{ name: "Разработка сайта", quantity: 1, unitPrice: 850000 }],
      }),
    });
    dealId = deal.body.deal.id;
    const company = await json("/api/v1/companies", {
      method: "POST",
      body: JSON.stringify({
        name: "ТОО Phase8 Buyer",
        legalName: "ТОО Phase8 Buyer",
        bin: "222222222220",
        legalAddress: "г. Астана, ул. Кабанбай 10",
        forceCreate: true,
      }),
    });
    await json(`/api/v1/deals/${dealId}`, {
      method: "PATCH",
      body: JSON.stringify({ companyId: company.body.id }),
    });
    const contract = await json(`/api/v1/deals/${dealId}/contracts`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    await prisma.contract.update({
      where: { id: contract.body.contract.id },
      data: { status: "SIGNED", signedAt: new Date() },
    });
    const avr = await json(`/api/v1/deals/${dealId}/electronic-documents`, {
      method: "POST",
      body: JSON.stringify({ type: "AVR" }),
    });
    avrId = avr.body.document.id;
    const validated = await json(`/api/v1/electronic-documents/${avrId}/validate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(validated.response.status, 200, JSON.stringify(validated.body));
    const sentAvr = await json(`/api/v1/electronic-documents/${avrId}/esf-send`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(sentAvr.response.status, 200, JSON.stringify(sentAvr.body));
    const esf = await json(`/api/v1/deals/${dealId}/electronic-documents`, {
      method: "POST",
      body: JSON.stringify({ type: "ESF" }),
    });
    esfId = esf.body.document.id;
    const validatedEsf = await json(`/api/v1/electronic-documents/${esfId}/validate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(validatedEsf.response.status, 200, JSON.stringify(validatedEsf.body));
  });

  after(() => {
    server?.close();
  });

  it("собирает official InvoiceV2 и шлёт syncInvoice через mock", async () => {
    const preview = await json(`/api/v1/electronic-documents/${esfId}/esf-preview`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(preview.response.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.version, "InvoiceV2");
    assert.equal(preview.body.validation.valid, true, JSON.stringify(preview.body.validation));
    assert.match(preview.body.xml, /<v2:invoice /);
    assert.match(preview.body.xml, /<catalogTruId>1<\/catalogTruId>/);
    assert.match(preview.body.xml, /<truOriginCode>6<\/truOriginCode>/);
    assert.match(preview.body.xml, /<num>\d+<\/num>/);
    assert.deepEqual(preview.body.operations, ["createSession", "syncInvoice", "queryInvoiceById"]);
    assert.match(preview.body.envelopes.syncInvoice, /syncInvoiceRequest/);

    const sent = await json(`/api/v1/electronic-documents/${esfId}/esf-send`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(sent.response.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.provider, "mock");
    assert.equal(sent.body.document.status, "SENT");
    assert.ok(sent.body.externalId);
    assert.equal(sent.body.externalStatus, "CREATED");
    assert.equal(sent.body.document.externalSystem, "ESF_INVOICE");

    const again = await json(`/api/v1/electronic-documents/${esfId}/esf-send`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(again.response.status, 200);
    assert.equal(again.body.reused, true);
    assert.equal(again.body.externalId, sent.body.externalId);
  });

  it("обновляет official статус queryInvoiceById и ставит ACCEPTED на DELIVERED", async () => {
    const current = await json(`/api/v1/electronic-documents/${esfId}`);
    const invoiceId = current.body.document.externalId;
    mockSetInvoiceStatus(invoiceId, "DELIVERED");
    const refreshed = await json(`/api/v1/electronic-documents/${esfId}/esf-refresh`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(refreshed.response.status, 200, JSON.stringify(refreshed.body));
    assert.equal(refreshed.body.operation, "queryInvoiceById");
    assert.equal(refreshed.body.externalStatus, "DELIVERED");
    assert.equal(refreshed.body.document.status, "ACCEPTED");
    assert.ok(refreshed.body.document.acceptedAt);
  });

  it("не отдаёт ЭСФ другого тенанта и не шлёт без АВР", async () => {
    const foreign = await json(`/api/v1/electronic-documents/${esfId}`, {}, otherCookie);
    assert.equal(foreign.response.status, 404);

    const extraContact = await json("/api/v1/contacts", {
      method: "POST",
      body: JSON.stringify({ name: "Phase8 extra", phone: "+77015550082" }),
    });
    const otherDeal = await json("/api/v1/deals", {
      method: "POST",
      body: JSON.stringify({
        title: "Phase8 без АВР",
        contactId: extraContact.body.client?.id || extraContact.body.id,
        items: [{ name: "Услуга", quantity: 1, unitPrice: 10000 }],
      }),
    });
    const extraDealId = otherDeal.body.deal.id;
    const extraCompany = await json("/api/v1/companies", {
      method: "POST",
      body: JSON.stringify({
        name: "ТОО Phase8 Extra",
        legalName: "ТОО Phase8 Extra",
        bin: "222222222220",
        legalAddress: "г. Астана, ул. Кабанбай 11",
        forceCreate: true,
      }),
    });
    await json(`/api/v1/deals/${extraDealId}`, {
      method: "PATCH",
      body: JSON.stringify({ companyId: extraCompany.body.id }),
    });
    await json(`/api/v1/deals/${extraDealId}/contracts`, { method: "POST", body: JSON.stringify({}) });
    const contract = await json(`/api/v1/deals/${extraDealId}/documents`);
    const contractId = contract.body.contracts[0].id;
    await prisma.contract.update({
      where: { id: contractId },
      data: { status: "SIGNED", signedAt: new Date() },
    });
    const esf = await json(`/api/v1/deals/${extraDealId}/electronic-documents`, {
      method: "POST",
      body: JSON.stringify({ type: "ESF" }),
    });
    const validated = await json(`/api/v1/electronic-documents/${esf.body.document.id}/validate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(validated.response.status, 200, JSON.stringify(validated.body));
    const blocked = await json(`/api/v1/electronic-documents/${esf.body.document.id}/esf-send`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(blocked.response.status, 422);
    assert.equal(blocked.body.code, "avr_not_sent");
  });
});
