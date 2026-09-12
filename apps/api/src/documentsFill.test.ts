import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { buildContractPlaceholders } from "./services/contractPdf.ts";
import { amountToKztWords } from "@creolab/contracts";

describe("Document field fill", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let server: { close: () => void };
  let base = "";
  let cookie = "";
  let contactId = "";
  let dealId = "";
  let companyId = "";
  let contractId = "";
  let invoiceId = "";

  async function json(path: string, init: RequestInit = {}) {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        cookie,
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

    const login = await json("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: "owner@creolab.example",
        password: process.env.SEED_PASSWORD,
        client: "web",
      }),
    });
    cookie = login.response.headers.get("set-cookie") || "";

    const profile = await json("/api/v1/settings/legal-profile", {
      method: "PATCH",
      body: JSON.stringify({
        legalName: "ТОО Fill Seller",
        shortName: "FillSeller",
        bin: "123456789013",
        legalAddress: "Алматы, Абая 1",
        directorName: "Селлер Семенович",
        directorPosition: "Генеральный директор",
        iban: "KZ86125KZT5004100100",
        bankName: "Fill Bank",
        bik: "KCJBKZKX",
        defaultVatMode: "percent",
        defaultVatRate: 12,
      }),
    });
    assert.equal(profile.response.status, 200);

    const contact = await json("/api/v1/contacts", {
      method: "POST",
      body: JSON.stringify({ name: "Fill клиент", phone: "+77015550061" }),
    });
    contactId = contact.body.client?.id || contact.body.id;
    const company = await json("/api/v1/companies", {
      method: "POST",
      body: JSON.stringify({
        name: "ТОО Fill Buyer",
        legalName: "ТОО Fill Buyer Legal",
        bin: "222222222220",
        legalAddress: "Астана, Кабанбай 10",
        directorName: "Баеров Баер",
        directorPosition: "Директор",
        forceCreate: true,
      }),
    });
    assert.equal(company.response.status, 201, JSON.stringify(company.body));
    companyId = company.body.id;

    const deal = await json("/api/v1/deals", {
      method: "POST",
      body: JSON.stringify({
        title: "Fill сделка",
        contactId,
        companyId,
        items: [
          { name: "Сайт", quantity: 2, unit: "шт", unitPrice: 100000 },
          { name: "Поддержка", quantity: 1, unit: "мес", unitPrice: 50000, vatRate: 0 },
        ],
      }),
    });
    assert.equal(deal.response.status, 201, JSON.stringify(deal.body));
    dealId = deal.body.deal.id;
    if (!deal.body.deal.company) {
      const linked = await json(`/api/v1/deals/${dealId}`, {
        method: "PATCH",
        body: JSON.stringify({ companyId }),
      });
      assert.equal(linked.body.deal.company.id, companyId);
    }
  });

  after(() => {
    server?.close();
  });

  it("позиции сделки считают НДС построчно и не смешивают ставки", async () => {
    const deal = await json(`/api/v1/deals/${dealId}`);
    const items = deal.body.deal.items;
    assert.equal(items.length, 2);
    assert.equal(items[0].name, "Сайт");
    assert.equal(items[0].quantity, 2);
    assert.equal(items[0].unit, "шт");
    assert.equal(items[0].unitPrice, 100000);
    assert.equal(items[0].amountWithoutVat, 200000);
    assert.equal(items[0].vatRate, 12);
    assert.equal(items[0].vatAmount, 24000);
    assert.equal(items[0].totalAmount, 224000);
    assert.equal(items[1].name, "Поддержка");
    assert.equal(items[1].vatRate, 0);
    assert.equal(items[1].amountWithoutVat, 50000);
    assert.equal(items[1].vatAmount, 0);
    assert.equal(items[1].totalAmount, 50000);
    assert.equal(deal.body.deal.itemTotals.amountWithoutVat, 250000);
    assert.equal(deal.body.deal.itemTotals.vatAmount, 24000);
    assert.equal(deal.body.deal.itemTotals.totalAmount, 274000);
    assert.equal(deal.body.deal.itemTotals.vatRate, null);
  });

  it("договор берёт реквизиты продавца, покупателя и суммы из сделки", async () => {
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
    const contract = generated.body.contract;
    assert.equal(contract.companyId, companyId);
    assert.equal(contract.subject, "Fill сделка");
    assert.equal(contract.amountWithoutVat, 250000);
    assert.equal(contract.vatAmount, 24000);
    assert.equal(contract.totalAmount, 274000);
    assert.equal(contract.vatRate, null);

    const placeholders = buildContractPlaceholders({
      number: contract.number,
      date: new Date(contract.date),
      subject: contract.subject,
      dealName: "Fill сделка",
      paymentTerms: "По согласованию сторон.",
      completionTerms: "По согласованию сторон.",
      amountWithoutVat: 250000,
      vatRate: null,
      vatAmount: 24000,
      totalAmount: 274000,
      sellerName: "ТОО Fill Seller",
      sellerBin: "123456789013",
      sellerAddress: "Алматы, Абая 1",
      sellerDirector: "Селлер Семенович",
      sellerDirectorPosition: "Генеральный директор",
      buyerName: "ТОО Fill Buyer Legal",
      buyerBin: "222222222220",
      buyerAddress: "Астана, Кабанбай 10",
      buyerDirector: "Баеров Баер",
      items: [],
      templateBody: "",
    });
    assert.equal(placeholders.seller_name, "ТОО Fill Seller");
    assert.equal(placeholders.seller_bin, "123456789013");
    assert.equal(placeholders.buyer_name, "ТОО Fill Buyer Legal");
    assert.equal(placeholders.buyer_bin, "222222222220");
    assert.match(placeholders.amount, /274/);
    assert.equal(placeholders.amount_words, amountToKztWords(274000));
    assert.match(placeholders.vat, /НДС/);
    assert.match(placeholders.vat, /24/);
  });

  it("счёт копирует позиции 1:1 и банковские реквизиты продавца", async () => {
    await prisma.contract.update({
      where: { id: contractId },
      data: { status: "SIGNED", signedAt: new Date() },
    });
    const draft = await json(`/api/v1/deals/${dealId}/invoices`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    invoiceId = draft.body.invoice.id;
    assert.equal(draft.body.invoice.contractId, contractId);
    assert.equal(draft.body.invoice.items.length, 2);
    assert.equal(draft.body.invoice.items[0].name, "Сайт");
    assert.equal(draft.body.invoice.items[0].quantity, 2);
    assert.equal(draft.body.invoice.items[0].unit, "шт");
    assert.equal(draft.body.invoice.items[0].unitPrice, 100000);
    assert.equal(draft.body.invoice.items[0].amountWithoutVat, 200000);
    assert.equal(draft.body.invoice.items[0].vatRate, 12);
    assert.equal(draft.body.invoice.items[1].vatRate, 0);

    const deal = await json(`/api/v1/deals/${dealId}`);
    assert.equal(draft.body.invoice.items[0].dealItemId, deal.body.deal.items[0].id);

    const generated = await json(`/api/v1/invoices/${invoiceId}/generate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(generated.response.status, 200, JSON.stringify(generated.body));
    assert.equal(generated.body.invoice.status, "ISSUED");
    assert.equal(generated.body.invoice.amountWithoutVat, 250000);
    assert.equal(generated.body.invoice.vatAmount, 24000);
    assert.equal(generated.body.invoice.totalAmount, 274000);
    assert.equal(generated.body.invoice.contractId, contractId);
  });

  it("АВР заполняет продавца, покупателя, договор, счёт и позиции без смешения БИН/ИИН", async () => {
    const draft = await json(`/api/v1/deals/${dealId}/electronic-documents`, {
      method: "POST",
      body: JSON.stringify({ type: "AVR" }),
    });
    assert.equal(draft.response.status, 201, JSON.stringify(draft.body));
    const source = draft.body.document.source;
    assert.equal(source.seller.legalName, "ТОО Fill Seller");
    assert.equal(source.seller.bin, "123456789013");
    assert.equal(source.seller.iin, "");
    assert.equal(source.seller.legalAddress, "Алматы, Абая 1");
    assert.equal(source.seller.directorName, "Селлер Семенович");
    assert.equal(source.seller.directorPosition, "Генеральный директор");
    assert.equal(source.buyer.legalName, "ТОО Fill Buyer Legal");
    assert.equal(source.buyer.bin, "222222222220");
    assert.equal(source.buyer.iin, "");
    assert.equal(source.buyer.legalAddress, "Астана, Кабанбай 10");
    assert.equal(source.buyer.directorName, "Баеров Баер");
    assert.equal(source.buyer.directorPosition, "Директор");
    assert.equal(source.contract.id, contractId);
    assert.equal(source.invoice.id, invoiceId);
    assert.equal(source.items[0].name, "Сайт");
    assert.equal(source.items[0].quantity, 2);
    assert.equal(source.items[0].unit, "шт");
    assert.equal(source.items[0].amountWithoutVat, 200000);
    assert.equal(source.items[1].vatRate, 0);
    assert.equal(source.totals.amountWithoutVat, 250000);
    assert.equal(source.totals.vatAmount, 24000);
    assert.equal(source.totals.totalAmount, 274000);

    const validated = await json(`/api/v1/electronic-documents/${draft.body.document.id}/validate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(validated.response.status, 200, JSON.stringify(validated.body));
    assert.equal(validated.body.document.source.contract.number, validated.body.document.source.contract.number);
    assert.ok(validated.body.document.source.contract.date);
    assert.equal(validated.body.document.source.invoice.id, invoiceId);
  });

  it("черновики договора и счёта обновляют суммы после новой позиции", async () => {
    const freshDeal = await json("/api/v1/deals", {
      method: "POST",
      body: JSON.stringify({
        title: "Fill refresh",
        contactId,
        companyId,
        items: [{ name: "Аудит", quantity: 1, unitPrice: 100000, vatRate: 0 }],
      }),
    });
    const freshId = freshDeal.body.deal.id;
    const contractFirst = await json(`/api/v1/deals/${freshId}/contracts`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(contractFirst.body.contract.totalAmount, 100000);
    const first = await json(`/api/v1/deals/${freshId}/invoices`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(first.body.invoice.items.length, 1);
    await json(`/api/v1/deals/${freshId}/items`, {
      method: "POST",
      body: JSON.stringify({ name: "Вторая", quantity: 1, unitPrice: 20000, vatRate: 0 }),
    });
    const contractSecond = await json(`/api/v1/deals/${freshId}/contracts`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(contractSecond.body.reused, true);
    assert.equal(contractSecond.body.contract.totalAmount, 120000);
    const second = await json(`/api/v1/deals/${freshId}/invoices`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(second.body.reused, true);
    assert.equal(second.body.invoice.items.length, 2);
    assert.equal(second.body.invoice.items[1].name, "Вторая");
    assert.equal(second.body.invoice.totalAmount, 120000);
  });

  it("покупатель только с ИИН попадает в договор и АВР, БИН не подменяется", async () => {
    const company = await json("/api/v1/companies", {
      method: "POST",
      body: JSON.stringify({
        name: "ИП Fill IIN",
        iin: "222222222220",
        legalAddress: "Шымкент",
        directorName: "ИП Директор",
        forceCreate: true,
      }),
    });
    assert.equal(company.response.status, 201, JSON.stringify(company.body));
    assert.equal(company.body.bin, null);
    assert.equal(company.body.iin, "222222222220");

    const deal = await json("/api/v1/deals", {
      method: "POST",
      body: JSON.stringify({
        title: "Fill IIN deal",
        contactId,
        companyId: company.body.id,
        items: [{ name: "Консультация", quantity: 1, unitPrice: 10000, vatRate: 0 }],
      }),
    });
    const id = deal.body.deal.id;
    const ready = await json(`/api/v1/deals/${id}/contract-readiness`);
    assert.equal(ready.body.ready, true);

    const draft = await json(`/api/v1/deals/${id}/contracts`, { method: "POST", body: JSON.stringify({}) });
    const generated = await json(`/api/v1/contracts/${draft.body.contract.id}/generate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(generated.response.status, 200, JSON.stringify(generated.body));

    await prisma.contract.update({
      where: { id: draft.body.contract.id },
      data: { status: "SIGNED", signedAt: new Date() },
    });
    const avr = await json(`/api/v1/deals/${id}/electronic-documents`, {
      method: "POST",
      body: JSON.stringify({ type: "AVR" }),
    });
    assert.equal(avr.body.document.source.buyer.bin, "");
    assert.equal(avr.body.document.source.buyer.iin, "222222222220");
    assert.equal(avr.body.document.source.buyer.legalName, "ИП Fill IIN");
    assert.equal(avr.body.document.source.buyer.legalAddress, "Шымкент");
  });
});
