import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { processOutbox } from "./services/backgroundJobs.ts";

describe("Documents phase 4", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let server: { close: () => void };
  let base = "";
  let cookie = "";
  let otherCookie = "";
  let contactId = "";
  let dealId = "";
  let contractId = "";
  let invoiceId = "";

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
        directorPosition: "Директор",
        iban: "KZ86125KZT5004100100",
        bankName: "Kaspi Bank",
        bik: "KCJBKZKX",
        defaultVatMode: "percent",
        defaultVatRate: 12,
      }),
    });
    assert.equal(profile.response.status, 200);

    const created = await json("/api/v1/contacts", {
      method: "POST",
      body: JSON.stringify({ name: "Phase4 клиент", phone: "+77015550041" }),
    });
    contactId = created.body.client?.id || created.body.id;
    assert.ok(contactId);

    const deal = await json("/api/v1/deals", {
      method: "POST",
      body: JSON.stringify({
        title: "Phase4 сайт",
        contactId,
        items: [{ name: "Разработка сайта", quantity: 1, unitPrice: 850000 }],
      }),
    });
    assert.equal(deal.response.status, 201);
    dealId = deal.body.deal.id;

    const company = await json("/api/v1/companies", {
      method: "POST",
      body: JSON.stringify({
        name: "ТОО Phase4 Buyer",
        legalName: "ТОО Phase4 Buyer",
        bin: "222222222220",
        legalAddress: "г. Астана, ул. Кабанбай 10",
        forceCreate: true,
      }),
    });
    assert.equal(company.response.status, 201, JSON.stringify(company.body));
    const linked = await json(`/api/v1/deals/${dealId}`, {
      method: "PATCH",
      body: JSON.stringify({ companyId: company.body.id }),
    });
    assert.equal(linked.response.status, 200);

    const draft = await json(`/api/v1/deals/${dealId}/contracts`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(draft.response.status, 201);
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

  it("не выпускает PDF счёта до подписанного договора", async () => {
    const ready = await json(`/api/v1/deals/${dealId}/invoice-readiness`);
    assert.equal(ready.response.status, 200);
    assert.equal(ready.body.ready, false);
    assert.ok(ready.body.missingFields.includes("contract.signed"));

    const draft = await json(`/api/v1/deals/${dealId}/invoices`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(draft.response.status, 201);
    invoiceId = draft.body.invoice.id;
    assert.equal(draft.body.invoice.status, "DRAFT");
    assert.equal(draft.body.invoice.items[0].name, "Разработка сайта");

    const generated = await json(`/api/v1/invoices/${invoiceId}/generate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(generated.response.status, 422);
    assert.equal(generated.body.code, "missing_fields");
    assert.ok(generated.body.details.missingFields.includes("contract.signed"));
  });

  it("после SIGNED пишет PDF, ISSUED и paymentStatus INVOICED", async () => {
    await prisma.contract.update({
      where: { id: contractId },
      data: { status: "SIGNED", signedAt: new Date() },
    });

    const ready = await json(`/api/v1/deals/${dealId}/invoice-readiness`);
    assert.equal(ready.body.ready, true);
    assert.equal(ready.body.signedContractId, contractId);

    const first = await json(`/api/v1/invoices/${invoiceId}/generate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(first.response.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.invoice.status, "ISSUED");
    assert.equal(first.body.invoice.contractId, contractId);
    assert.ok(first.body.invoice.pdfFileId);
    assert.ok(first.body.sha256);
    assert.equal(first.body.reused, false);

    const deal = await json(`/api/v1/deals/${dealId}`);
    assert.equal(deal.body.deal.paymentStatus, "INVOICED");

    const attachment = await prisma.attachment.findFirst({
      where: { id: first.body.invoice.pdfFileId },
    });
    assert.ok(attachment);
    assert.equal(attachment?.mimeType, "application/pdf");
    assert.equal(attachment?.checksum, first.body.sha256);
    assert.equal(attachment?.parentType, "invoice");

    const second = await json(`/api/v1/invoices/${invoiceId}/generate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(second.body.reused, true);
    assert.equal(second.body.invoice.pdfFileId, first.body.invoice.pdfFileId);

    const pdf = await fetch(`${base}/api/v1/invoices/${invoiceId}/pdf`, { headers: { cookie } });
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers.get("content-type") || "", /pdf/);
    const bytes = Buffer.from(await pdf.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString("utf8"), "%PDF");
  });

  it("не отдаёт PDF другому тенанту и блокирует пересборку после оплаты", async () => {
    const foreign = await fetch(`${base}/api/v1/invoices/${invoiceId}/pdf`, {
      headers: { cookie: otherCookie },
    });
    assert.equal(foreign.status, 404);

    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: "PAID" },
    });
    const locked = await json(`/api/v1/invoices/${invoiceId}/generate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(locked.response.status, 422);
    assert.equal(locked.body.code, "invoice_immutable");
  });

  it("contract.signed в outbox создаёт черновик счёта", async () => {
    const extra = await json("/api/v1/deals", {
      method: "POST",
      body: JSON.stringify({
        title: "Phase4 outbox",
        contactId,
        items: [{ name: "Аудит", quantity: 1, unitPrice: 100000, vatRate: 0 }],
      }),
    });
    assert.equal(extra.response.status, 201);
    const extraDealId = extra.body.deal.id;
    const firstDeal = await json(`/api/v1/deals/${dealId}`);
    await json(`/api/v1/deals/${extraDealId}`, {
      method: "PATCH",
      body: JSON.stringify({ companyId: firstDeal.body.deal.company.id }),
    });
    const draft = await json(`/api/v1/deals/${extraDealId}/contracts`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    const extraContractId = draft.body.contract.id;
    await json(`/api/v1/contracts/${extraContractId}/generate`, { method: "POST", body: JSON.stringify({}) });
    await prisma.contract.update({
      where: { id: extraContractId },
      data: { status: "SIGNED", signedAt: new Date() },
    });
    const tenant = await prisma.contract.findUnique({
      where: { id: extraContractId },
      select: { tenantId: true },
    });
    await prisma.outboxEvent.create({
      data: {
        tenantId: tenant!.tenantId,
        type: "contract.signed",
        entityType: "contract",
        entityId: extraContractId,
        payloadJson: { contractId: extraContractId, dealId: extraDealId },
      },
    });
    const processed = await processOutbox(prisma);
    assert.ok(processed >= 1);
    const invoice = await prisma.invoice.findFirst({
      where: { dealId: extraDealId },
      include: { items: true },
    });
    assert.ok(invoice);
    assert.equal(invoice?.status, "DRAFT");
    assert.equal(invoice?.contractId, extraContractId);
    assert.equal(invoice?.items[0].name, "Аудит");
  });
});
