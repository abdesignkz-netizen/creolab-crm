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
  let contactId = "";

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
    contactId = created.body.client?.id || created.body.id;
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
      number: "СЧ-125/А",
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
    assert.equal(created.body.invoice.number, "СЧ-125/А");
    assert.equal((await json(`/api/v1/deals/${dealId}/invoice-context`)).body.editor.number, "СЧ-125/А");
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
    assert.ok(text.includes("СЧ-125/А"));
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
    const generated = await json(`/api/v1/invoices/${invoiceId}/generate`, {method:"POST", body:JSON.stringify({})});
    assert.equal(generated.response.status,200,JSON.stringify(generated.body));
    assert.ok(generated.body.invoice.pdfFileId);
    const patched = await json(`/api/v1/invoices/${invoiceId}`, {
      method: "PATCH",
      body: JSON.stringify({
        number: "СЧ-126/Б",
        documentDate: "2026-09-03",
        paymentPercent: 50,
        items: [
          { name: "Разработка презентации компании до 15 слайдов/страниц", quantity: 1, unit: "услуга", unitPrice: 300000, vatRate: 0 },
          { name: "Дополнительный слайд", quantity: 1, unit: "услуга", unitPrice: 20000, vatRate: 0 },
        ],
      }),
    });
    assert.equal(patched.response.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.invoice.number, "СЧ-126/Б");
    assert.equal(patched.body.invoice.pdfFileId, null);
    assert.equal(patched.body.invoice.status, "DRAFT");
    assert.equal(patched.body.invoice.items.length, 2);
    assert.equal(patched.body.invoice.totalAmount, 160000);

    const again = await json(`/api/v1/deals/${dealId}/invoices`, { method: "POST", body: JSON.stringify({}) });
    assert.equal(again.body.invoice.id, invoiceId);
    assert.equal(again.body.reused, true);
    const current = await json(`/api/v1/invoices/${invoiceId}`);
    assert.equal(current.body.invoice.id, invoiceId);
    assert.equal(current.body.invoice.number, "СЧ-126/Б");
    assert.equal(current.body.invoice.items.length, 2);
    assert.equal(current.body.invoice.totalAmount, 160000);
  });

  it("сохраняет номер договора в счёте и печатает его в PDF", async () => {
    const current = await json(`/api/v1/invoices/${invoiceId}`);
    const patched = await json(`/api/v1/invoices/${invoiceId}`, {
      method: "PATCH",
      body: JSON.stringify({
        documentDate: "2026-09-03",
        paymentPercent: 50,
        contractNumber: "19122025/01",
        contractDate: "2025-12-19",
        items: current.body.invoice.items.map((item: { name: string; quantity: number; unit: string; unitPrice: number; vatRate: number }) => ({
          name: item.name,
          quantity: item.quantity,
          unit: item.unit,
          unitPrice: item.unitPrice,
          vatRate: item.vatRate,
        })),
        updatedAt: current.body.invoice.updatedAt,
      }),
    });
    assert.equal(patched.response.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.invoice.contractNumber, "19122025/01");
    assert.equal(patched.body.invoice.contractDate, "2025-12-19");
    const pdf = await fetch(`${base}/api/v1/invoices/${invoiceId}/pdf`, { headers: { cookie } });
    assert.equal(pdf.status, 200);
    const { DOMMatrix, ImageData, Path2D } = await import("@napi-rs/canvas");
    Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const parsed = await getDocument({ data: new Uint8Array(await pdf.arrayBuffer()), useSystemFonts: true }).promise;
    const page = await parsed.getPage(1);
    const content = await page.getTextContent();
    page.cleanup();
    const text = content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
    assert.match(text, /19122025\/01/);
  });

  it("печатает счёт без договора и без даты договора", async () => {
    const current = await json(`/api/v1/invoices/${invoiceId}`);
    const patched = await json(`/api/v1/invoices/${invoiceId}`, {
      method: "PATCH",
      body: JSON.stringify({
        documentDate: "2026-09-03",
        paymentPercent: 50,
        withoutContract: true,
        contractNumber: "19122025/01",
        contractDate: "2025-12-19",
        items: current.body.invoice.items.map((item: { name: string; quantity: number; unit: string; unitPrice: number; vatRate: number }) => ({
          name: item.name,
          quantity: item.quantity,
          unit: item.unit,
          unitPrice: item.unitPrice,
          vatRate: item.vatRate,
        })),
        updatedAt: current.body.invoice.updatedAt,
      }),
    });
    assert.equal(patched.response.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.invoice.withoutContract, true);
    assert.equal(patched.body.invoice.contractNumber, "");
    assert.equal(patched.body.invoice.contractDate, "");
    const pdf = await fetch(`${base}/api/v1/invoices/${invoiceId}/pdf`, { headers: { cookie } });
    assert.equal(pdf.status, 200);
    const { DOMMatrix, ImageData, Path2D } = await import("@napi-rs/canvas");
    Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const parsed = await getDocument({ data: new Uint8Array(await pdf.arrayBuffer()), useSystemFonts: true }).promise;
    const page = await parsed.getPage(1);
    const content = await page.getTextContent();
    page.cleanup();
    const text = content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
    assert.match(text, /без договора/);
    assert.equal(/без договора от/.test(text), false);
    assert.equal(/19122025\/01/.test(text), false);
  });

  it("создаёт счёт по компании без сделки", async () => {
    const company = await json("/api/v1/companies", {
      method: "POST",
      body: JSON.stringify({
        name: "ENOVO Technologies",
        legalName: 'ТОО "ENOVO Technologies"',
        bin: "020240004419",
        legalAddress: "РК, г. Алматы, ул. Сатпаева 30/8",
        forceCreate: true,
      }),
    });
    assert.equal(company.response.status, 201, JSON.stringify(company.body));
    const listed = await json("/api/v1/documents/invoices/eligible-companies?q=ENOVO");
    assert.equal(listed.response.status, 200, JSON.stringify(listed.body));
    const row = listed.body.items.find((item: { id: string }) => item.id === company.body.id);
    assert.ok(row);
    assert.equal(row.openDealsCount, 0);
    assert.equal((await json("/api/v1/documents/invoices/eligible-companies", {}, otherCookie)).response.status, 200);
    assert.equal((await json(`/api/v1/companies/${company.body.id}/invoice-deal`, { method: "POST", body: JSON.stringify({}) }, otherCookie)).response.status, 404);

    const prepared = await json(`/api/v1/companies/${company.body.id}/invoice-deal`, { method: "POST", body: JSON.stringify({}) });
    assert.equal(prepared.response.status, 201, JSON.stringify(prepared.body));
    assert.equal(prepared.body.createdDeal, true);
    const ctx = await json(`/api/v1/deals/${prepared.body.dealId}/invoice-context`);
    assert.equal(ctx.response.status, 200, JSON.stringify(ctx.body));
    assert.equal(ctx.body.deal.companyId, company.body.id);
    const created = await json(`/api/v1/deals/${prepared.body.dealId}/invoices`, {
      method: "POST",
      body: JSON.stringify({
        editor: {
          documentDate: "2026-09-18",
          paymentPercent: 100,
          items: [{ name: "Разработка презентации компании", quantity: 1, unit: "услуга", unitPrice: 500000, vatRate: 0 }],
        },
      }),
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.invoice.totalAmount, 500000);
    const again = await json("/api/v1/documents/invoices/eligible-companies?q=ENOVO");
    assert.equal(again.body.items.find((item: { id: string }) => item.id === company.body.id).openDealsCount, 1);
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
  const post = (body: unknown) => ({method: "POST", body: JSON.stringify(body)});
  const patch = (body: unknown) => ({method: "PATCH", body: JSON.stringify(body)});
  const numberedEditor = {documentDate:"2026-09-26", paymentPercent:100, items:[{name:"Услуга",quantity:1,unit:"услуга",unitPrice:1000,vatRate:0}]};
  async function newDeal() {
    const result = await json("/api/v1/deals", post({title:"Проверка номера счёта",contactId,items:numberedEditor.items}));
    assert.equal(result.response.status,201,JSON.stringify(result.body));
    return result.body.deal.id as string;
  }
  it("защищает ручные номера и печатные варианты от дублей", async () => {
    const id = await newDeal();
    const clash = await json(`/api/v1/deals/${id}/invoices`,post({editor:{...numberedEditor,number:"СЧ-126/Б"}}));
    assert.equal(clash.response.status,409,JSON.stringify(clash.body));
    const automatic = await json(`/api/v1/deals/${id}/invoices`,post({editor:numberedEditor}));
    assert.equal(automatic.response.status,201,JSON.stringify(automatic.body));
    const [_,year,seq] = automatic.body.invoice.number.split("-");
    const alias = `${year.slice(-2)}-${seq}`;
    const another = await newDeal();
    assert.equal((await json(`/api/v1/deals/${another}/invoices`,post({editor:{...numberedEditor,number:alias}}))).response.status,409);
    assert.equal((await json(`/api/v1/invoices/${invoiceId}`,patch({...numberedEditor,number:alias}))).response.status,409);
    const preserved = (await json(`/api/v1/invoices/${invoiceId}`)).body.invoice;
    assert.equal(preserved.number,"СЧ-126/Б");
    assert.equal(preserved.totalAmount,160000);
    const tooLong = await json(`/api/v1/invoices/${invoiceId}`,patch({...numberedEditor,number:"X".repeat(41)}));
    assert.equal(tooLong.response.status,422);
  });
  it("продолжает отсчёт после ручного номера и не стирает номер пустым полем", async () => {
    const id = await newDeal();
    const number = `${String(new Date().getFullYear()).slice(-2)}-0500`;
    const created = await json(`/api/v1/deals/${id}/invoices`,post({editor:{...numberedEditor,number}}));
    assert.equal(created.response.status,201,JSON.stringify(created.body));
    const saved = await json(`/api/v1/invoices/${created.body.invoice.id}`,patch({...numberedEditor,number:""}));
    assert.equal(saved.body.invoice.number,number);
    assert.equal((await json("/api/v1/settings/document-numbering")).body.INV.next,501);
    const nextDeal = await newDeal();
    const next = await json(`/api/v1/deals/${nextDeal}/invoices`,post({editor:numberedEditor}));
    assert.match(next.body.invoice.number,/-0501$/);
  });
  it("одновременное создание переиспользует один счёт, одинаковый ручной номер выдаётся один раз", async () => {
    const id = await newDeal();
    const results = await Promise.all([1,2].map(()=>json(`/api/v1/deals/${id}/invoices`,post({editor:numberedEditor}))));
    for(const r of results) assert.equal(r.response.status,201,JSON.stringify(r.body));
    assert.equal(results[0].body.invoice.id,results[1].body.invoice.id);
    assert.equal(await prisma.invoice.count({where:{dealId:id}}),1);
    const ids = [await newDeal(),await newDeal()];
    const sameNumber = await Promise.all(ids.map(id=>json(`/api/v1/deals/${id}/invoices`,post({editor:{...numberedEditor,number:"СЧ-конкурентный"}}))));
    assert.deepEqual(sameNumber.map(r=>r.response.status).sort(),[201,409]);
  });
  it("отклоняет устаревшие параллельные правки и не меняет оплаченный счёт", async () => {
    const id = await newDeal();
    const created = await json(`/api/v1/deals/${id}/invoices`,post({editor:numberedEditor}));
    const invoice = created.body.invoice;
    const edits = await Promise.all(["СЧ-версия-А","СЧ-версия-Б"].map(number=>json(`/api/v1/invoices/${invoice.id}`,patch({...numberedEditor,number,updatedAt:invoice.updatedAt}))));
    assert.deepEqual(edits.map(r=>r.response.status).sort(),[200,409]);
    await prisma.invoice.update({where:{id:invoice.id},data:{status:"PAID"}});
    assert.equal((await json(`/api/v1/invoices/${invoice.id}`,patch({...numberedEditor,number:"СЧ-запрещено"}))).response.status,422);
    assert.equal((await json(`/api/v1/invoices/${invoice.id}`,patch({...numberedEditor,number:"СЧ-чужой"}),otherCookie)).response.status,404);
  });

  it("показывает импортированный счёт без редактирования и защищает его на сервере", async () => {
    const id = await newDeal();
    const created = await json(`/api/v1/deals/${id}/invoices`,post({editor:numberedEditor}));
    const row = await prisma.invoice.findUniqueOrThrow({where:{id:created.body.invoice.id}});
    const file = await prisma.attachment.create({data:{tenantId:row.tenantId,parentType:"invoice",parentId:row.id,storageKey:"test-imported.pdf",fileName:"original.pdf",mimeType:"application/pdf",sizeBytes:1,status:"imported"}});
    await prisma.invoice.update({where:{id:row.id},data:{pdfFileId:file.id}});
    assert.equal((await json(`/api/v1/invoices/${row.id}`)).body.invoice.importedPdf,true);
    assert.equal((await json(`/api/v1/deals/${id}/invoice-context`)).body.invoice.importedPdf,true);
    const patchResult = await json(`/api/v1/invoices/${row.id}`,patch({...numberedEditor,number:"Новый номер"}));
    assert.equal(patchResult.response.status,422);
    assert.equal(patchResult.body.code,"imported_pdf_immutable");
    const createResult = await json(`/api/v1/deals/${id}/invoices`,post({editor:{...numberedEditor,number:"Новый номер"}}));
    assert.equal(createResult.response.status,422);
    assert.equal(createResult.body.code,"imported_pdf_immutable");
    assert.equal((await prisma.invoice.findUniqueOrThrow({where:{id:row.id}})).number,row.number);
  });

});
