import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";

describe("Invoice editor workflow", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let server: { close: () => void };
  let base = "";
  let cookie = "";
  let otherCookie = "";
  let dealId = "";
  let invoiceId = "";

  async function json(path: string, init: RequestInit = {}, useCookie = cookie) {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", cookie: useCookie, ...(init.headers || {}) },
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
      body: JSON.stringify({ email: "owner@creolab.example", password: process.env.SEED_PASSWORD, client: "web" }),
    }, "");
    cookie = login.response.headers.get("set-cookie") || "";
    const demo = await json("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "owner@demo-agency.example", password: process.env.SEED_PASSWORD, client: "web" }),
    }, "");
    otherCookie = demo.response.headers.get("set-cookie") || "";

    await json("/api/v1/settings/legal-profile", {
      method: "PATCH",
      body: JSON.stringify({
        legalName: "ТОО CREOLAB",
        bin: "221140036408",
        legalAddress: "г. Алматы, ул. Монгольская 44",
        directorName: "Булан Асет Болатович",
        phone: "+7 (707) 747 13 01",
        email: "info@creolab.kz",
        iban: "KZ268562203127261373",
        bankName: 'АО "Банк ЦентрКредит"',
        bik: "KCJBKZKX",
        defaultVatMode: "none",
        defaultVatRate: 0,
      }),
    });

    const created = await json("/api/v1/contacts", {
      method: "POST",
      body: JSON.stringify({ name: "Invoice клиент", phone: "+77017770001" }),
    });
    const contactId = created.body.client?.id || created.body.id;
    const deal = await json("/api/v1/deals", {
      method: "POST",
      body: JSON.stringify({
        title: "Презентация компании",
        contactId,
        items: [{ name: "Разработка презентации компании до 15 слайдов/страниц", quantity: 1, unit: "услуга", unitPrice: 300000, vatRate: 0 }],
      }),
    });
    assert.equal(deal.response.status, 201, JSON.stringify(deal.body));
    dealId = deal.body.deal.id;
    const company = await json("/api/v1/companies", {
      method: "POST",
      body: JSON.stringify({
        name: "ARASAKA",
        legalName: 'ТОО "ARASAKA"',
        bin: "150540023591",
        legalAddress: "РК, г.Алматы, ул. Абиш Кекилбайулы 131, кв 5.",
        phone: "+7 776 002 02 09",
        email: "office@arasaka.test",
        forceCreate: true,
      }),
    });
    await json(`/api/v1/deals/${dealId}`, { method: "PATCH", body: JSON.stringify({ companyId: company.body.id }) });
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await prisma.$disconnect();
  });

  it("создаёт черновик из редактора, хранит предоплату и не отдаёт чужому тенанту", async () => {
    const eligible = await json("/api/v1/documents/invoices/eligible-deals?filter=all");
    assert.equal(eligible.response.status, 200, JSON.stringify(eligible.body));
    assert.ok(eligible.body.items.some((row: { id: string }) => row.id === dealId));
    assert.equal((await json("/api/v1/documents/invoices/eligible-deals", {}, otherCookie)).response.status, 200);

    const ctx = await json(`/api/v1/deals/${dealId}/invoice-context`);
    assert.equal(ctx.response.status, 200, JSON.stringify(ctx.body));
    assert.equal(ctx.body.organization.phone, "+7 (707) 747 13 01");
    assert.equal(ctx.body.organization.email, "info@creolab.kz");
    assert.equal((await json(`/api/v1/deals/${dealId}/invoice-context`, {}, otherCookie)).response.status, 404);

    const editor = {
      documentDate: "2026-09-03",
      paymentPercent: 50,
      items: [{ name: "Разработка презентации компании до 15 слайдов/страниц", quantity: 1, unit: "услуга", unitPrice: 300000, vatRate: 0 }],
    };
    const created = await json(`/api/v1/deals/${dealId}/invoices`, {
      method: "POST",
      body: JSON.stringify({ editor }),
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    invoiceId = created.body.invoice.id;
    assert.equal(created.body.invoice.paymentPercent, 50);
    assert.equal(created.body.invoice.totalAmount, 150000);
    assert.equal(created.body.invoice.items[0].totalAmount, 300000);

    const pdf = await fetch(`${base}/api/v1/invoices/${invoiceId}/pdf`, { headers: { cookie } });
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers.get("content-disposition") || "", /inline/);
    const bytes = Buffer.from(await pdf.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString("utf8"), "%PDF");
    const { DOMMatrix, ImageData, Path2D } = await import("@napi-rs/canvas");
    Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const parsed = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
    const page = await parsed.getPage(1);
    const content = await page.getTextContent();
    page.cleanup();
    const items = content.items
      .filter((item): item is { str: string; transform: number[] } => "str" in item && Boolean(item.str.trim()))
      .map((item) => ({ str: item.str, y: item.transform[5] }));
    const text = items.map((item) => item.str).join(" ");
    assert.match(text, /Счет на оплату/);
    assert.match(text, /Предоплата 50%/);
    assert.match(text, /ARASAKA/);
    assert.match(text, /Образец платежного поручения/);
    assert.match(text, /Тел\.: \+7 \(707\) 747 13 01/);
    assert.match(text, /Тел: \+7 776 002 02 09/);
    const bin = items.find((item) => item.str.startsWith("БИН:"));
    const bank = items.find((item) => item.str === "Банк бенефициара");
    assert.ok(bin && bank);
    assert.ok(bin.y - bank.y >= 18, `BIN y=${bin.y} bank y=${bank.y}`);

    const attachment = await fetch(`${base}/api/v1/invoices/${invoiceId}/pdf?download=1`, { headers: { cookie } });
    assert.match(attachment.headers.get("content-disposition") || "", /attachment/);

    assert.equal((await fetch(`${base}/api/v1/invoices/${invoiceId}/pdf`, { headers: { cookie: otherCookie } })).status, 404);
    assert.equal((await json(`/api/v1/invoices/${invoiceId}`, {}, otherCookie)).response.status, 404);
    assert.equal((await json(`/api/v1/invoices/${invoiceId}`, { method: "PATCH", body: JSON.stringify(editor) }, otherCookie)).response.status, 404);
  });

  it("PATCH сохраняет правки и не зацикливает повторное создание", async () => {
    const patched = await json(`/api/v1/invoices/${invoiceId}`, {
      method: "PATCH",
      body: JSON.stringify({
        documentDate: "2026-09-03",
        paymentPercent: 50,
        items: [
          { name: "Разработка презентации компании до 15 слайдов/страниц", quantity: 1, unit: "услуга", unitPrice: 300000, vatRate: 0 },
          { name: "Дополнительный слайд", quantity: 1, unit: "услуга", unitPrice: 20000, vatRate: 0 },
        ],
      }),
    });
    assert.equal(patched.response.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.invoice.items.length, 2);
    assert.equal(patched.body.invoice.totalAmount, 160000);

    const again = await json(`/api/v1/deals/${dealId}/invoices`, { method: "POST", body: JSON.stringify({}) });
    assert.equal(again.body.invoice.id, invoiceId);
    assert.equal(again.body.reused, true);
    const current = await json(`/api/v1/invoices/${invoiceId}`);
    assert.equal(current.body.invoice.id, invoiceId);
  });

  it("принимает печать и отдаёт stamped PDF", async () => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const uploaded = await json("/api/v1/settings/legal-profile/marks/stamp", {
      method: "POST",
      body: JSON.stringify({ contentBase64: `data:image/png;base64,${png}`, mimeType: "image/png" }),
    });
    assert.equal(uploaded.response.status, 200, JSON.stringify(uploaded.body));
    assert.equal(uploaded.body.hasStamp, true);
    const plain = await fetch(`${base}/api/v1/invoices/${invoiceId}/pdf`, { headers: { cookie } });
    const stamped = await fetch(`${base}/api/v1/invoices/${invoiceId}/pdf?stamped=1`, { headers: { cookie } });
    assert.equal(stamped.status, 200);
    const plainBytes = Buffer.from(await plain.arrayBuffer());
    const stampedBytes = Buffer.from(await stamped.arrayBuffer());
    assert.ok(stampedBytes.length > plainBytes.length);
  });
});
