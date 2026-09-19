import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";

describe("Documents phase 10 общий список", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let server: { close: () => void };
  let base = "";
  let cookie = "";
  let otherCookie = "";
  let dealId = "";
  let companyId = "";
  let contractId = "";

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

    await json("/api/v1/settings/legal-profile", {
      method: "PATCH",
      body: JSON.stringify({
        legalName: "ТОО CREOLAB",
        bin: "123456789013",
        defaultVatMode: "percent",
        defaultVatRate: 12,
        documentsEnabled: true,
      }),
    });

    const created = await json("/api/v1/contacts", {
      method: "POST",
      body: JSON.stringify({ name: "Phase10 клиент", phone: "+77015550092" }),
    });
    const contactId = created.body.client?.id || created.body.id;
    const deal = await json("/api/v1/deals", {
      method: "POST",
      body: JSON.stringify({
        title: "Phase10 документы",
        contactId,
        items: [{ name: "Сопровождение", quantity: 1, unitPrice: 120000 }],
      }),
    });
    dealId = deal.body.deal.id;
    const company = await json("/api/v1/companies", {
      method: "POST",
      body: JSON.stringify({
        name: "ТОО Phase10 Buyer",
        legalName: "ТОО Phase10 Buyer",
        bin: "222222222220",
        forceCreate: true,
      }),
    });
    companyId = company.body.id;
    await json(`/api/v1/deals/${dealId}`, {
      method: "PATCH",
      body: JSON.stringify({ companyId }),
    });
    const contract = await json(`/api/v1/deals/${dealId}/contracts`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    contractId = contract.body.contract.id;
    await json(`/api/v1/deals/${dealId}/invoices`, { method: "POST", body: JSON.stringify({}) });
  });

  after(() => {
    server?.close();
  });

  it("отдаёт договоры и счета тенанта и прячет чужие", async () => {
    const list = await json("/api/v1/documents");
    assert.equal(list.response.status, 200, JSON.stringify(list.body));
    assert.ok(list.body.items.some((row: { id: string; kind: string }) => row.id === contractId && row.kind === "CONTRACT"));
    assert.ok(list.body.items.some((row: { kind: string; dealId: string }) => row.kind === "INVOICE" && row.dealId === dealId));
    assert.equal(
      list.body.items.every((row: { href: string; kind: string }) => {
        if (row.kind === "INVOICE") return String(row.href).startsWith("/documents/invoices/");
        if (row.kind === "AVR") return String(row.href).startsWith("/documents/avr/");
        return String(row.href).startsWith("/deals/");
      }),
      true,
    );

    const invoices = await json("/api/v1/documents?kind=INVOICE");
    const invoiceRow = invoices.body.items.find((row: { kind: string; dealId: string }) => row.kind === "INVOICE" && row.dealId === dealId);
    assert.ok(invoiceRow);
    assert.equal(invoiceRow.avrStatus, "Требуется");
    assert.equal(invoiceRow.esfStatus, "Требуется");
    assert.ok(Number(invoices.body.counts.invoice) >= 1);

    const createdInvoice = await prisma.invoice.findFirst({ where: { dealId }, orderBy: { createdAt: "desc" } });
    assert.ok(createdInvoice);
    const draftAttention = await json("/api/v1/documents?attention=1&kind=INVOICE");
    assert.ok(
      draftAttention.body.items.some(
        (row: { id: string; kind: string; attention: boolean }) =>
          row.id === createdInvoice.id && row.kind === "INVOICE" && row.attention,
      ),
    );
    await prisma.invoice.update({ where: { id: createdInvoice.id }, data: { status: "ISSUED" } });
    const attentionInvoices = await json("/api/v1/documents?attention=1&kind=INVOICE");
    assert.ok(
      attentionInvoices.body.items.some(
        (row: { id: string; kind: string; attention: boolean }) =>
          row.id === createdInvoice.id && row.kind === "INVOICE" && row.attention,
      ),
    );

    const byDeal = await json(`/api/v1/documents?dealId=${dealId}`);
    assert.ok(byDeal.body.total >= 2);
    const byCompany = await json(`/api/v1/documents?companyId=${companyId}`);
    assert.ok(byCompany.body.items.some((row: { companyId: string }) => row.companyId === companyId));

    const foreign = await json("/api/v1/documents", {}, otherCookie);
    assert.ok(!foreign.body.items?.some((row: { id: string }) => row.id === contractId));

    const foreignDeal = await json(`/api/v1/documents?dealId=${dealId}`, {}, otherCookie);
    assert.equal(foreignDeal.response.status, 200);
    assert.equal(foreignDeal.body.total, 0);
  });

  it("фильтрует документы, требующие внимания, и ставит badge", async () => {
    await prisma.contract.update({
      where: { id: contractId },
      data: { status: "PENDING_SIGNATURE" },
    });
    const attention = await json("/api/v1/documents?attention=1&kind=CONTRACT");
    assert.equal(attention.response.status, 200);
    assert.ok(attention.body.items.some((row: { id: string; attention: boolean }) => row.id === contractId && row.attention));

    const badges = await json("/api/v1/nav-badges");
    assert.ok(Number(badges.body.badges["/documents"]) >= 1);
    assert.equal(badges.body.hrefs["/documents"], "/documents?attention=1");

    const otherBadges = await json("/api/v1/nav-badges", {}, otherCookie);
    assert.equal(Number(otherBadges.body.badges["/documents"] || 0), 0);
  });

  it("показывает статус АВР и ЭСФ сделки в строке счёта", async () => {
    const deal = await prisma.deal.findUniqueOrThrow({ where: { id: dealId } });
    await prisma.electronicDocument.create({
      data: {
        tenantId: deal.tenantId,
        dealId,
        type: "AVR",
        number: "AVR-PHASE10-1",
        amountWithoutVat: 100,
        vatAmount: 12,
        totalAmount: 112,
        status: "VALIDATED",
      },
    });
    await prisma.electronicDocument.create({
      data: {
        tenantId: deal.tenantId,
        dealId,
        type: "ESF",
        number: "ESF-PHASE10-1",
        amountWithoutVat: 100,
        vatAmount: 12,
        totalAmount: 112,
        status: "SENT",
      },
    });
    const invoices = await json("/api/v1/documents?kind=INVOICE");
    const invoiceRow = invoices.body.items.find((row: { dealId: string }) => row.dealId === dealId);
    assert.equal(invoiceRow?.avrStatus, "Готов");
    assert.equal(invoiceRow?.esfStatus, "Отправлен");
    const contracts = await json("/api/v1/documents?kind=CONTRACT");
    const contractRow = contracts.body.items.find((row: { id: string }) => row.id === contractId);
    assert.equal(contractRow?.avrStatus, "Готов");
    assert.equal(contractRow?.esfStatus, "Отправлен");
  });
});
