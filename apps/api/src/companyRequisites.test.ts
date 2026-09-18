import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import JSZip from "jszip";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { renderInvoicePdf } from "./services/invoicePdf.ts";

const paste = `ТОО "Minerals Supply Services Atyrau"
БИН: 123456789013
Юридический адрес: РК, г. Атырау, ул. Тестовая 1
ИИК: KZ268562203127261373
Банк: АО "Банк ЦентрКредит"
БИК: KCJBKZKX
Директор: Мухсинов Е. Н.
Тел.: +7 701 111 22 33
E-mail: office@minerals.test`;

async function makeDocx(text: string) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  const body = text
    .split("\n")
    .map((line) => `<w:p><w:r><w:t xml:space="preserve">${line.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</w:t></w:r></w:p>`)
    .join("");
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("Company requisites import", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let server: { close: () => void };
  let base = "";
  let cookie = "";

  async function req(path: string, method: string, body?: unknown, status = 200) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    assert.equal(response.status, status, JSON.stringify(data));
    return data;
  }

  before(async () => {
    process.env.SEED_PASSWORD ||= "ChangeMeLocal1!";
    prisma = await createPrismaClient();
    const { seedDatabase } = await import("../../../packages/db/src/seed.ts");
    await seedDatabase();
    const app = createApp(prisma);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const address = (server as { address: () => { port: number } }).address();
    base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "owner@creolab.example", password: process.env.SEED_PASSWORD, client: "web" }),
    });
    cookie = login.headers.get("set-cookie") || "";
    assert.ok(cookie);
  });

  after(() => {
    server?.close();
  });

  it("rejects empty requisites", async () => {
    await req("/api/v1/companies/parse-requisites", "POST", {}, 422);
  });

  it("parses pasted requisites", async () => {
    const body: any = await req("/api/v1/companies/parse-requisites", "POST", { text: paste });
    assert.match(body.draft.name, /Minerals Supply Services Atyrau/);
    assert.equal(body.draft.bin, "123456789013");
    assert.equal(body.draft.iban, "KZ268562203127261373");
    assert.equal(body.draft.bik, "KCJBKZKX");
    assert.equal(body.draft.city, "Атырау");
    assert.match(body.draft.directorName, /Мухсинов/);
  });

  it("parses Word requisites without LibreOffice", async () => {
    const bytes = await makeDocx(paste);
    const body: any = await req("/api/v1/companies/parse-requisites", "POST", {
      fileName: "requisites.docx",
      fileBase64: bytes.toString("base64"),
    });
    assert.match(body.draft.name, /Minerals Supply Services Atyrau/);
    assert.equal(body.draft.bin, "123456789013");
    assert.equal(body.draft.iban, "KZ268562203127261373");
    assert.equal(body.draft.bik, "KCJBKZKX");
  });

  it("parses the buyer from a payment invoice PDF", async () => {
    const pdf = await renderInvoicePdf({
      number: "INV-2026-0121",
      date: new Date("2026-09-03T00:00:00Z"),
      dueDate: new Date("2026-09-10T00:00:00Z"),
      contractNumber: "03092026/01",
      contractDate: new Date("2026-09-03T00:00:00Z"),
      dealName: "Презентация",
      amountWithoutVat: 150000,
      vatRate: 0,
      vatAmount: 0,
      totalAmount: 150000,
      itemsTotalWithoutVat: 300000,
      itemsTotalAmount: 300000,
      paymentPercent: 50,
      sellerName: "ТОО «Creolab»",
      sellerBin: "221140036408",
      sellerAddress: "РК, 050026, г. Алматы, ул. Монгольская 44",
      sellerPhone: "+7 (707) 747 13 01",
      sellerIban: "KZ268562203127261373",
      sellerBankName: 'АО "Банк ЦентрКредит"',
      sellerBik: "KCJBKZKX",
      sellerKbe: "17",
      sellerKnp: "859",
      sellerDirector: "Булан Асет Болатович",
      buyerName: 'ТОО "ARASAKA"',
      buyerBin: "150540023591",
      buyerAddress: "РК, г.Алматы, ул. Абиш Кекилбайулы 131, кв 5.",
      buyerPhone: "+7 776 002 02 09",
      items: [
        {
          name: "Разработка презентации компании до 15 слайдов/страниц",
          quantity: 1,
          unit: "услуга",
          unitPrice: 300000,
          amountWithoutVat: 300000,
          totalAmount: 300000,
        },
      ],
    });
    await prisma.tenantLegalProfile.upsert({
      where: { tenantId: (await prisma.membership.findFirstOrThrow({ where: { user: { email: "owner@creolab.example" } } })).tenantId },
      create: {
        tenantId: (await prisma.membership.findFirstOrThrow({ where: { user: { email: "owner@creolab.example" } } })).tenantId,
        bin: "221140036408",
        legalName: "ТОО «Creolab»",
      },
      update: { bin: "221140036408", legalName: "ТОО «Creolab»" },
    });
    const body: any = await req("/api/v1/companies/parse-requisites", "POST", {
      fileName: "invoice.pdf",
      fileBase64: pdf.toString("base64"),
    });
    assert.match(body.draft.name, /ARASAKA/);
    assert.equal(body.draft.bin, "150540023591");
    assert.notEqual(body.draft.iban, "KZ268562203127261373");
  });
});
