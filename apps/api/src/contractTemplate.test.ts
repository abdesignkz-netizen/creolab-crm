import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import JSZip from "jszip";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { scanContractTemplateText } from "./services/contractTemplateScan.ts";
import { extractDocUnicodeText } from "./services/wordDocumentText.ts";

const SAMPLE = `Договор №05082026/01
об оказании возмездных услуг

г. Алматы                                                                                                        «5» августа 2026 г.

ТОО «Creolab», именуемое в дальнейшем «Исполнитель», в лице Директора Иванов Иван, действующего на основании Устава, с одной стороны, и ТОО «АрыстанТехСервис», именуемое в дальнейшем «Заказчик», в лице Директора Шайдуллинов Р. К., действующего на основании Устава, с другой стороны, далее совместно именуемые «Стороны», заключили настоящий Договор о нижеследующем.

ПРЕДМЕТ ДОГОВОРА
2.1. По настоящему договору Исполнитель обязуется оказать Услуги, а Заказчик обязуется принять и оплатить эти услуги.
2.2.1. Разработать презентацию компании.

ПОРЯДОК ОПЛАТЫ
4.5.1. Не позднее 3 рабочих дней Заказчик производит предоплату в размере 50% от Стоимости оказания Услуг, которая составляет 60 000 (Шестьдесят тысяч) тенге.

Приложение №2
Итого: 120 000

11. РЕКВИЗИТЫ СТОРОН

ТОО «АрыстанТехСервис»
РК, город Астана, район Есиль, улица Сыганак, д.4
БИН 222222222220
KZ5396503F0007969139
АО «ForteBank»
БИК: IRTYKZKA

ТОО «Creolab»
РК, г. Алматы, пр. Абая 1
БИН 123456789013
АО «Банк ЦентрКредит»
KZ111111111111111111
БИК: KCJBKZKX`;

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

describe("Contract Word templates", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let server: { close: () => void };
  let base = "";
  let cookie = "";
  let otherCookie = "";

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

  it("заменяет стороны примера презентации на поля шаблона", () => {
    const scanned = scanContractTemplateText(SAMPLE, {
      legalName: "ТОО CREOLAB",
      bin: "123456789013",
      legalAddress: "г. Алматы, пр. Абая 1",
      directorName: "Иванов Иван",
    }, "Договор на возмездные услуги.doc");
    assert.match(scanned.body, /\{\{seller_name\}\}/);
    assert.match(scanned.body, /\{\{buyer_name\}\}/);
    assert.match(scanned.body, /\{\{seller_bin\}\}/);
    assert.match(scanned.body, /\{\{buyer_bin\}\}/);
    assert.match(scanned.body, /\{\{contract_number\}\}/);
    assert.match(scanned.body, /Разработать презентацию компании/);
    assert.doesNotMatch(scanned.body, /АрыстанТехСервис/);
    assert.equal(scanned.buyer.bin, "222222222220");
    assert.equal(scanned.seller.bin, "123456789013");
    assert.match(scanned.name, /презентац/i);
  });

  it("читает unicode-текст из OLE .doc без LibreOffice", () => {
    const payload = Buffer.from(SAMPLE, "utf16le");
    const bytes = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(32),
      payload,
    ]);
    const text = extractDocUnicodeText(bytes);
    assert.match(text, /Разработать презентацию компании/);
    assert.match(text, /АрыстанТехСервис/);
  });

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
        bin: "123456789013",
        legalAddress: "г. Алматы, пр. Абая 1",
        directorName: "Иванов Иван",
        directorPosition: "Директор",
        iban: "KZ111111111111111111",
        bankName: "АО «Банк ЦентрКредит»",
        bik: "KCJBKZKX",
        defaultVatMode: "none",
      }),
    });
  });

  after(() => {
    server?.close();
  });

  it("загружает Word, сохраняет шаблон и формирует договор по компании", async () => {
    const bytes = await makeDocx(SAMPLE);
    const preview = await json("/api/v1/documents/contract-templates/preview", {
      method: "POST",
      body: JSON.stringify({
        fileName: "Договор на возмездные услуги.docx",
        fileBase64: bytes.toString("base64"),
      }),
    });
    assert.equal(preview.response.status, 200, JSON.stringify(preview.body));
    assert.match(preview.body.body, /\{\{buyer_name\}\}/);
    assert.match(preview.body.body, /Разработать презентацию компании/);

    const created = await json("/api/v1/documents/contract-templates", {
      method: "POST",
      body: JSON.stringify({
        name: "Договор на разработку презентации",
        body: preview.body.body,
        isDefault: true,
      }),
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const templateId = created.body.template.id;
    const hidden = await json(`/api/v1/documents/contract-templates/${templateId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Чужой шаблон" }),
    }, otherCookie);
    assert.equal(hidden.response.status, 404);

    const company = await json("/api/v1/companies", {
      method: "POST",
      body: JSON.stringify({
        name: "ТОО АрыстанТехСервис",
        legalName: "ТОО АрыстанТехСервис",
        bin: "222222222220",
        legalAddress: "г. Астана, ул. Сыганак 4",
        directorName: "Шайдуллинов Р. К.",
        iban: "KZ5396503F0007969139",
        bankName: "АО ForteBank",
        bik: "IRTYKZKA",
        forceCreate: true,
      }),
    });
    assert.equal(company.response.status, 201, JSON.stringify(company.body));

    const formed = await json(`/api/v1/companies/${company.body.id}/contract-from-template`, {
      method: "POST",
      body: JSON.stringify({ templateId }),
    });
    assert.equal(formed.response.status, 201, JSON.stringify(formed.body));
    assert.equal(formed.body.contract.templateId, templateId);
    assert.ok(formed.body.dealId);
    assert.equal(formed.body.generated, true, JSON.stringify(formed.body));

    const pdf = await fetch(`${base}/api/v1/contracts/${formed.body.contract.id}/pdf`, { headers: { cookie } });
    assert.equal(pdf.status, 200);
    const pdfBytes = Buffer.from(await pdf.arrayBuffer());
    assert.ok(pdfBytes.subarray(0, 5).equals(Buffer.from("%PDF-")));
    assert.equal(formed.body.contract.status, "READY_TO_SIGN");

    const list = await json("/api/v1/documents/contract-templates");
    assert.ok((list.body.items || []).some((row: { id: string }) => row.id === templateId));
  });

  it("формирует договор с услугами и выбранным НДС даже без НДС в настройках", async () => {
    await json("/api/v1/settings/legal-profile", {
      method: "PATCH",
      body: JSON.stringify({ defaultVatMode: null, defaultVatRate: null }),
    });
    const list = await json("/api/v1/documents/contract-templates");
    const templateId = (list.body.items || []).find((row: { isDefault?: boolean }) => row.isDefault)?.id
      || (list.body.items || [])[0]?.id;
    assert.ok(templateId);
    const companies = await json("/api/v1/companies");
    const companyId = (companies.body.items || companies.body.companies || [])[0]?.id;
    assert.ok(companyId, JSON.stringify(companies.body));
    const formed = await json(`/api/v1/companies/${companyId}/contract-from-template`, {
      method: "POST",
      body: JSON.stringify({
        templateId,
        items: [
          { name: "Разработка презентации", quantity: 1, unitPrice: 120000, vatRate: 12 },
          { name: "Доп. слайды", quantity: 3, unitPrice: 20000, vatRate: 0 },
        ],
      }),
    });
    assert.equal(formed.response.status, 201, JSON.stringify(formed.body));
    const deal = await json(`/api/v1/deals/${formed.body.dealId}`);
    assert.equal(deal.response.status, 200, JSON.stringify(deal.body));
    const items = deal.body.deal?.items || [];
    assert.equal(items.length, 2);
    assert.equal(items[0].name, "Разработка презентации");
    assert.equal(items[0].vatRate, 12);
    assert.equal(items[1].vatRate, 0);
  });

  it("не отдаёт шаблон другой компании", async () => {
    const list = await json("/api/v1/documents/contract-templates", {}, otherCookie);
    assert.equal(list.response.status, 200);
    assert.equal(
      (list.body.items || []).some((row: { name: string }) => /презентац/i.test(row.name)),
      false,
    );
  });
});
