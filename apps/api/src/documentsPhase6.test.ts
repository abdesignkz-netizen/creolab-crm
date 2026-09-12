import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";

describe("Documents phase 6 ESF POC", () => {
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
    delete process.env.ESF_ALLOW_LIVE_SEND;
    delete process.env.ESF_SIGN_CERT_PATH;
    delete process.env.ESF_SIGN_CERT_PIN;
    process.env.ESF_ENV = "off";
    process.env.ESF_PROVIDER = "live";
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
      body: JSON.stringify({ name: "Phase6 клиент", phone: "+77015550061" }),
    });
    const contactId = created.body.client?.id || created.body.id;
    const deal = await json("/api/v1/deals", {
      method: "POST",
      body: JSON.stringify({
        title: "Phase6 АВР XML",
        contactId,
        items: [{ name: "Разработка сайта", quantity: 1, unitPrice: 850000 }],
      }),
    });
    dealId = deal.body.deal.id;
    const company = await json("/api/v1/companies", {
      method: "POST",
      body: JSON.stringify({
        name: "ТОО Phase6 Buyer",
        legalName: "ТОО Phase6 Buyer",
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

  it("собирает official AwpV1 XML и не ходит в ИС ЭСФ", async () => {
    const preview = await json(`/api/v1/electronic-documents/${documentId}/esf-preview`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(preview.response.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.validation.valid, true, JSON.stringify(preview.body.validation));
    assert.equal(preview.body.version, "AwpV1");
    assert.match(preview.body.xml, /<v1:awp xmlns:v1="v1.awp"/);
    assert.match(preview.body.xml, /<tin>123456789013<\/tin>/);
    assert.match(preview.body.xml, /<tin>222222222220<\/tin>/);
    assert.match(preview.body.xml, /<ndsRate>12<\/ndsRate>/);
    assert.match(preview.body.xml, /<iik>KZ123456789012345678<\/iik>/);
    assert.deepEqual(preview.body.operations, ["createSession", "uploadAwp", "queryAwpStatusById"]);
    assert.match(preview.body.envelopes.createSession, /createSessionRequest/);
    assert.match(preview.body.envelopes.uploadAwp, /awpUploadRequest/);
    assert.equal(preview.body.document.xmlPrepared, true);
    assert.equal(preview.body.signing.code, "legacy_server_p12_forbidden");
    assert.equal(preview.body.liveSendAllowed, false);
  });

  it("не отдаёт XML другому тенанту", async () => {
    const foreign = await json(
      `/api/v1/electronic-documents/${documentId}/esf-preview`,
      { method: "POST", body: JSON.stringify({}) },
      otherCookie,
    );
    assert.equal(foreign.response.status, 404);
  });

  it("не шлёт в ИС ЭСФ, пока флаг выключен, и честно отказывается без Kalkan", async () => {
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
    const unsigned = await json(`/api/v1/electronic-documents/${documentId}/esf-send`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(unsigned.response.status, 422);
    assert.equal(unsigned.body.code, "legacy_server_p12_forbidden");
    assert.match(String(unsigned.body.details?.envelopes?.uploadAwp || ""), /awpUploadRequest/);
    const still = await json(`/api/v1/electronic-documents/${documentId}`);
    assert.equal(still.body.document.status, "VALIDATED");
    assert.notEqual(still.body.document.status, "SENT");
  });
});
