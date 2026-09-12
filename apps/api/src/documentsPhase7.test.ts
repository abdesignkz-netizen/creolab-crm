import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { mockSetAwpStatus, resetEsfMock } from "./integrations/esf/EsfMock.ts";

describe("Documents phase 7 AVR → ИС ЭСФ", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let server: { close: () => void };
  let base = "";
  let cookie = "";
  let otherCookie = "";
  let dealId = "";
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
      }),
    });

    const created = await json("/api/v1/contacts", {
      method: "POST",
      body: JSON.stringify({ name: "Phase7 клиент", phone: "+77015550071" }),
    });
    const contactId = created.body.client?.id || created.body.id;
    const deal = await json("/api/v1/deals", {
      method: "POST",
      body: JSON.stringify({
        title: "Phase7 АВР ИС ЭСФ",
        contactId,
        items: [{ name: "Разработка сайта", quantity: 1, unitPrice: 850000 }],
      }),
    });
    dealId = deal.body.deal.id;
    const company = await json("/api/v1/companies", {
      method: "POST",
      body: JSON.stringify({
        name: "ТОО Phase7 Buyer",
        legalName: "ТОО Phase7 Buyer",
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
    documentId = avr.body.document.id;
    const validated = await json(`/api/v1/electronic-documents/${documentId}/validate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(validated.response.status, 200, JSON.stringify(validated.body));
  });

  after(() => {
    server?.close();
  });

  it("не шлёт без флага и отдаёт official externalId/status через mock", async () => {
    const blocked = await json(`/api/v1/electronic-documents/${documentId}/esf-send`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(blocked.response.status, 403);
    assert.equal(blocked.body.code, "esf_disabled");

    await json("/api/v1/settings/legal-profile", {
      method: "PATCH",
      body: JSON.stringify({ esfIntegrationEnabled: true }),
    });
    const sent = await json(`/api/v1/electronic-documents/${documentId}/esf-send`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(sent.response.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.provider, "mock");
    assert.equal(sent.body.document.status, "SENT");
    assert.ok(sent.body.externalId);
    assert.equal(sent.body.externalStatus, "NOT_VIEWED");
    assert.equal(sent.body.document.xmlPrepared, true);
    assert.equal(sent.body.document.signedXmlPrepared, true);
    assert.ok(sent.body.document.sentAt);

    const again = await json(`/api/v1/electronic-documents/${documentId}/esf-send`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(again.response.status, 200);
    assert.equal(again.body.reused, true);
    assert.equal(again.body.externalId, sent.body.externalId);
  });

  it("обновляет official статус queryAwpStatusById и ставит ACCEPTED на CONFIRMED", async () => {
    const current = await json(`/api/v1/electronic-documents/${documentId}`);
    const awpId = current.body.document.externalId;
    mockSetAwpStatus(awpId, "CONFIRMED");
    const refreshed = await json(`/api/v1/electronic-documents/${documentId}/esf-refresh`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(refreshed.response.status, 200, JSON.stringify(refreshed.body));
    assert.equal(refreshed.body.operation, "queryAwpStatusById");
    assert.equal(refreshed.body.externalStatus, "CONFIRMED");
    assert.equal(refreshed.body.document.status, "ACCEPTED");
    assert.ok(refreshed.body.document.acceptedAt);
  });

  it("не отдаёт АВР другого тенанта", async () => {
    const foreign = await json(`/api/v1/electronic-documents/${documentId}`, {}, otherCookie);
    assert.equal(foreign.response.status, 404);
    const foreignRefresh = await json(
      `/api/v1/electronic-documents/${documentId}/esf-refresh`,
      { method: "POST", body: JSON.stringify({}) },
      otherCookie,
    );
    assert.equal(foreignRefresh.response.status, 404);
  });
});
