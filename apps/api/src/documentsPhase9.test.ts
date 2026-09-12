import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { mockSetAwpStatus, mockSetInvoiceStatus, resetEsfMock } from "./integrations/esf/EsfMock.ts";
import { processDueScheduledActions, processOutbox } from "./services/backgroundJobs.ts";

describe("Documents phase 9 статусы ИС ЭСФ → CRM", () => {
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
      body: JSON.stringify({ name: "Phase9 клиент", phone: "+77015550091" }),
    });
    const contactId = created.body.client?.id || created.body.id;
    const deal = await json("/api/v1/deals", {
      method: "POST",
      body: JSON.stringify({
        title: "Phase9 статус ИС ЭСФ",
        contactId,
        items: [{ name: "Разработка сайта", quantity: 1, unitPrice: 850000 }],
      }),
    });
    dealId = deal.body.deal.id;
    const company = await json("/api/v1/companies", {
      method: "POST",
      body: JSON.stringify({
        name: "ТОО Phase9 Buyer",
        legalName: "ТОО Phase9 Buyer",
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
    assert.equal(
      (await json(`/api/v1/electronic-documents/${avrId}/validate`, { method: "POST", body: JSON.stringify({}) }))
        .response.status,
      200,
    );
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
    assert.equal(
      (await json(`/api/v1/electronic-documents/${esfId}/validate`, { method: "POST", body: JSON.stringify({}) }))
        .response.status,
      200,
    );
    const sentEsf = await json(`/api/v1/electronic-documents/${esfId}/esf-send`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(sentEsf.response.status, 200, JSON.stringify(sentEsf.body));
  });

  after(() => {
    server?.close();
  });

  it("outbox avr.sent/esf.sent ставит official статусы и открывает закрытие сделки", async () => {
    const before = await json(`/api/v1/deals/${dealId}/close-readiness`);
    assert.equal(before.response.status, 200);
    assert.equal(before.body.ready, false);
    assert.ok(before.body.missingFields.includes("esf.accepted"));

    const avr = await json(`/api/v1/electronic-documents/${avrId}`);
    const esf = await json(`/api/v1/electronic-documents/${esfId}`);
    mockSetAwpStatus(avr.body.document.externalId, "CONFIRMED");
    mockSetInvoiceStatus(esf.body.document.externalId, "DELIVERED");

    let processed = 0;
    for (let i = 0; i < 10; i++) {
      const n = await processOutbox(prisma);
      processed += n;
      if (n === 0) break;
    }
    assert.ok(processed >= 2);
    const polls = await prisma.scheduledAction.findMany({
      where: { type: "esf_status_poll", parentId: { in: [avrId, esfId] } },
    });
    assert.equal(polls.length, 2);
    await processDueScheduledActions(prisma);

    const avrAfter = await json(`/api/v1/electronic-documents/${avrId}`);
    const esfAfter = await json(`/api/v1/electronic-documents/${esfId}`);
    assert.equal(avrAfter.body.document.externalStatus, "CONFIRMED");
    assert.equal(avrAfter.body.document.status, "ACCEPTED");
    assert.equal(esfAfter.body.document.externalStatus, "DELIVERED");
    assert.equal(esfAfter.body.document.status, "ACCEPTED");
    const acceptedEvents = await prisma.outboxEvent.findMany({
      where: { type: { in: ["avr.accepted", "esf.accepted"] }, entityId: { in: [avrId, esfId] } },
    });
    assert.ok(acceptedEvents.some((event) => event.type === "avr.accepted"));
    assert.ok(acceptedEvents.some((event) => event.type === "esf.accepted"));

    const ready = await json(`/api/v1/deals/${dealId}/close-readiness`);
    assert.equal(ready.body.ready, true);
    const won = await json(`/api/v1/deals/${dealId}/won`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(won.response.status, 200, JSON.stringify(won.body));
    assert.equal(won.body.deal.outcome, "won");
  });

  it("синхронизирует сделку и не отдаёт чужому тенанту", async () => {
    const foreign = await json(`/api/v1/deals/${dealId}/close-readiness`, {}, otherCookie);
    assert.equal(foreign.response.status, 404);
    const foreignSync = await json(
      `/api/v1/deals/${dealId}/esf-sync`,
      { method: "POST", body: JSON.stringify({}) },
      otherCookie,
    );
    assert.equal(foreignSync.response.status, 404);

    mockSetInvoiceStatus((await json(`/api/v1/electronic-documents/${esfId}`)).body.document.externalId, "FAILED");
    const synced = await json(`/api/v1/deals/${dealId}/esf-sync`, { method: "POST", body: JSON.stringify({}) });
    assert.equal(synced.response.status, 200, JSON.stringify(synced.body));
    const esf = synced.body.documents.find((row: { id: string }) => row.id === esfId);
    assert.equal(esf.externalStatus, "FAILED");
    assert.equal(esf.errorCode, "esf_failed");
    assert.notEqual(esf.status, "ACCEPTED");
  });
});
