import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { AVR_SOURCE_KIND, type AvrSourceSnapshot } from "./services/avrMapper.ts";
import {
  AVR_EXCEL_SHEET_NAME,
  avrExcelFileName,
  avrExcelLayout,
  avrLocalNumber,
  directorShortName,
  formatAvrContractBasis,
  paperAvrMeasureUnit,
  renderAvrExcel,
} from "./services/avrExcel.ts";
import { avrPdfFileName, renderAvrPdf } from "./services/avrPdf.ts";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { expandLegalFormName } from "./services/avrMapper.ts";

function cellValue(ws: ExcelJS.Worksheet, addr: string) {
  const value = ws.getCell(addr).value as
    | string
    | number
    | Date
    | { result?: string | number; formula?: string; richText?: Array<{ text: string }> }
    | null;
  if (value instanceof Date) {
    const day = String(value.getDate()).padStart(2, "0");
    const month = String(value.getMonth() + 1).padStart(2, "0");
    return `${day}.${month}.${value.getFullYear()}`;
  }
  if (value && typeof value === "object") {
    if ("result" in value && value.result != null) return value.result;
    if ("formula" in value && value.formula) return value.formula;
    if ("richText" in value && Array.isArray(value.richText)) return value.richText.map((part) => part.text).join("");
  }
  return value ?? "";
}

async function pdfText(buffer: Buffer) {
  const { DOMMatrix, ImageData, Path2D } = await import("@napi-rs/canvas");
  Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
  const page = await pdf.getPage(1);
  const content = await page.getTextContent();
  page.cleanup();
  return content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
}

const gold: AvrSourceSnapshot = {
  kind: AVR_SOURCE_KIND,
  seller: {
    legalName: 'Товарищество с Ограниченной Ответственностью "Creolab"',
    bin: "221140036408",
    iin: "",
    legalAddress: "РК, г. Алматы, улица Монгольская 44",
    directorName: "Булан Асет Болатович",
    directorPosition: "Директор",
  },
  buyer: {
    name: "ГОЛД ПРОДУКТ",
    legalName: "Акционерное общество «ГОЛД ПРОДУКТ»",
    bin: "980740001015",
    iin: "",
    legalAddress: "РК, Алматинская область, Енбекшиказахский район, Тургеньски учетный квартал 126, строение 1",
    directorName: "",
    directorPosition: "",
  },
  deal: { id: "deal-gold", title: "Презентация" },
  contract: {
    id: "contract-gold",
    number: "26022026/01",
    date: "2026-02-26T00:00:00.000Z",
    status: "SIGNED",
  },
  invoice: null,
  items: [
    {
      dealItemId: "1",
      name: "Разработка презентации компании до 5-6 слайдов/страниц",
      description: null,
      quantity: 1,
      unit: "услуга",
      unitPrice: 150000,
      amountWithoutVat: 150000,
      vatRate: 0,
      vatAmount: 0,
      totalAmount: 150000,
      sortOrder: 0,
    },
    {
      dealItemId: "2",
      name: "Профессиональная выездная фотосъемка объекта",
      description: null,
      quantity: 1,
      unit: "796",
      unitPrice: 150000,
      amountWithoutVat: 150000,
      vatRate: 0,
      vatAmount: 0,
      totalAmount: 150000,
      sortOrder: 1,
    },
    {
      dealItemId: "3",
      name: "Доп. объем к презентации компании на 1 слайд/страницу",
      description: null,
      quantity: 1,
      unit: "шт",
      unitPrice: 25000,
      amountWithoutVat: 25000,
      vatRate: 0,
      vatAmount: 0,
      totalAmount: 25000,
      sortOrder: 2,
    },
  ],
  totals: { amountWithoutVat: 325000, vatAmount: 0, totalAmount: 325000, currency: "KZT" },
  documentDate: "2026-09-10T00:00:00.000Z",
};

it("расшифровывает организационно-правовые формы в реквизитах АВР", () => {
  assert.equal(expandLegalFormName("ТОО «Creolab»"), "Товарищество с ограниченной ответственностью «Creolab»");
  assert.equal(expandLegalFormName("АО «ГОЛД ПРОДУКТ»"), "Акционерное общество «ГОЛД ПРОДУКТ»");
  assert.equal(expandLegalFormName("ИП Иванов"), "Индивидуальный предприниматель Иванов");
});

describe("AVR Excel Form R-1", () => {
  it("переводит номер CRM в архивный YY-NNNN", () => {
    assert.equal(avrLocalNumber("AVR-2026-0035", "2026-09-10"), "26-0035");
    assert.equal(avrLocalNumber("AVR-2026-1", "2026-01-01"), "26-0001");
    assert.equal(avrLocalNumber("26-35", "2026-09-10"), "26-0035");
    assert.equal(avrLocalNumber("Акт-125/А", "2026-09-10"), "Акт-125/А");
    assert.equal(avrLocalNumber("123456", "2026-09-10"), "123456");
  });

  it("сохраняет ручной номер в Excel и PDF", async () => {
    const number = "Акт-126/Б";
    const excel = await renderAvrExcel({ number, source: gold });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(excel.buffer as any);
    assert.equal(cellValue(workbook.worksheets[0], "AP15"), number);
    const pdf = await renderAvrPdf({ number, source: gold });
    assert.ok((await pdfText(pdf.buffer)).includes(number));
  });

  it("собирает договор, ФИО и единицу как в бумажном архиве", () => {
    assert.equal(formatAvrContractBasis(gold.contract), "No 26022026/01 от «26» февраля 2026 года");
    assert.equal(directorShortName("Булан Асет Болатович"), "Булан А. Б.");
    assert.equal(paperAvrMeasureUnit("796"), "услуга");
    assert.equal(paperAvrMeasureUnit("услуга"), "услуга");
    assert.equal(paperAvrMeasureUnit("час"), "ч");
    assert.match(avrExcelFileName({ number: "AVR-2026-0035", source: gold }), /^26-0035 ГОЛД ПРОДУКТ от 10 сентября 2026\.xlsx$/);
  });

  it("кладёт реквизиты, позиции и итоги в те же ячейки, что форма Р-1", async () => {
    const { buffer, layout } = await renderAvrExcel({ number: "AVR-2026-0035", source: gold });
    assert.equal(buffer.subarray(0, 2).toString("utf8"), "PK");
    assert.equal(layout.totalsRow, 23);
    assert.equal(layout.wordsRow, 25);
    assert.equal(layout.signRow, 30);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.getWorksheet(AVR_EXCEL_SHEET_NAME);
    assert.ok(ws);
    assert.equal((ws.model.merges || []).length, 82);
    assert.equal(ws.getColumn(1).width, 4.5);
    assert.equal(ws.getColumn(11).width, 1.75);
    assert.equal(ws.getRow(17).height, 66);
    assert.equal(ws.getRow(20).height, 40.5);
    assert.equal(cellValue(ws, "A17"), "Номер по порядку");
    assert.equal(cellValue(ws, "AN1"), "Приложение 50");
    assert.equal(cellValue(ws, "AW6"), "Форма Р-1");
    assert.match(String(cellValue(ws, "E9")), /ГОЛД ПРОДУКТ/);
    assert.equal(String(cellValue(ws, "AQ9")).trim(), "980740001015");
    assert.match(String(cellValue(ws, "E11")), /Creolab/);
    assert.equal(String(cellValue(ws, "AQ11")), "221140036408");
    assert.equal(cellValue(ws, "F13"), "No 26022026/01 от «26» февраля 2026 года");
    assert.equal(cellValue(ws, "AP15"), "26-0035");
    assert.equal(cellValue(ws, "AT15"), "10.09.2026");
    assert.equal(cellValue(ws, "C20"), gold.items[0].name);
    assert.equal(cellValue(ws, "N20"), "");
    assert.equal(cellValue(ws, "AC20"), "услуга");
    assert.equal(cellValue(ws, "AF20"), 1);
    assert.equal(cellValue(ws, "AI20"), 150000);
    assert.equal(cellValue(ws, "AN20"), 150000);
    assert.equal(cellValue(ws, "AS20"), 0);
    assert.equal(cellValue(ws, "C22"), gold.items[2].name);
    assert.equal(cellValue(ws, "AE23"), "Итого");
    assert.equal(cellValue(ws, "AI23"), "x");
    assert.equal(cellValue(ws, "AN23"), 325000);
    assert.equal(cellValue(ws, "T25"), "Триста двадцать пять тысяч тенге");
    assert.equal(cellValue(ws, "A30"), "Сдал (Исполнитель)");
    assert.equal(cellValue(ws, "F30"), "Директор");
    assert.equal(cellValue(ws, "R30"), "Булан А. Б.");
    assert.equal(cellValue(ws, "AA30"), "Принял (Заказчик)");
    assert.equal(cellValue(ws, "A33"), "М.П.");
    assert.equal(ws.getCell("AN20").value && typeof ws.getCell("AN20").value === "object" ? (ws.getCell("AN20").value as { formula?: string }).formula : "", "AF20*AI20");
    assert.equal(ws.getCell("AT15").numFmt, "dd.mm.yyyy");
    assert.equal(ws.getCell("A20").border?.left?.style, "thin");
    assert.equal(ws.getCell("B20").border?.right?.style, "thin");
    assert.equal(ws.getCell("C20").border?.left?.style, "thin");
    assert.equal(ws.getCell("M20").border?.right?.style, "thin");
    assert.equal(ws.getCell("AH23").border?.right?.style, "thin");

    const zip = await JSZip.loadAsync(buffer);
    const types = await zip.file("[Content_Types].xml")?.async("string");
    const sheet = await zip.file("xl/worksheets/sheet1.xml")?.async("string");
    assert.ok(types && sheet);
    assert.equal(types.includes("vml"), false);
    const stylesXml = await zip.file("xl/styles.xml")?.async("string");
    assert.ok(stylesXml);
    assert.equal(stylesXml.includes("slicerStyles"), false);
    assert.equal(stylesXml.includes("timelineStyles"), false);
    assert.equal(sheet.includes('max="257"'), false);
    assert.equal(sheet.includes("4294967295"), false);
    assert.match(sheet, /<c r="AT15"[^>]*><v>46275<\/v><\/c>/);
    assert.match(sheet, /<c r="A7"/);
    assert.match(sheet, /<c r="AU32"/);
    assert.ok(sheet.indexOf('r="AG32"') < sheet.indexOf('r="AU32"'));
    assert.match(sheet, /<c r="B20"/);
    assert.match(sheet, /<c r="M20"/);
    assert.match(sheet, /<c r="AO1"/);
    assert.equal(/<c r="AO1"[^>/]*><v>/.test(sheet), false);
    const merges = [...sheet.matchAll(/<mergeCell ref="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(merges.length, 82);
    for (const ref of merges) {
      const master = ref.split(":")[0];
      assert.match(sheet, new RegExp(`<c r="${master}"`), `нет ячейки объединения ${master}`);
    }
  });

  it("сдвигает итоги и подписи, если позиций больше трёх", async () => {
    const source: AvrSourceSnapshot = {
      ...gold,
      items: [
        ...gold.items,
        {
          dealItemId: "4",
          name: "Часы сопровождения",
          description: null,
          quantity: 2,
          unit: "час",
          unitPrice: 10000,
          amountWithoutVat: 20000,
          vatRate: 12,
          vatAmount: 2400,
          totalAmount: 22400,
          sortOrder: 3,
        },
      ],
      totals: { amountWithoutVat: 345000, vatAmount: 2400, totalAmount: 347400, currency: "KZT" },
    };
    const { buffer, layout } = await renderAvrExcel({ number: "AVR-2026-0035", source });
    assert.equal(layout.totalsRow, 24);
    assert.equal(layout.wordsRow, 26);
    assert.equal(layout.signRow, 31);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.getWorksheet(AVR_EXCEL_SHEET_NAME);
    assert.ok(ws);
    assert.equal(cellValue(ws, "C23"), "Часы сопровождения");
    assert.equal(cellValue(ws, "AC23"), "ч");
    assert.equal(cellValue(ws, "AE24"), "Итого");
    assert.equal(cellValue(ws, "AS23"), 2400);
    assert.equal(cellValue(ws, "T26"), "Триста сорок пять тысяч тенге");
    assert.equal(cellValue(ws, "R31"), "Булан А. Б.");
    assert.equal(avrExcelLayout(4).stampRow, 34);
    assert.ok((ws.model.merges || []).includes("A23:B23"));
    assert.ok((ws.model.merges || []).includes("AF24:AH24"));
  });

  it("убирает пустые строки формы, если позиция одна", async () => {
    const source: AvrSourceSnapshot = {
      ...gold,
      items: [gold.items[0]],
      totals: { amountWithoutVat: 150000, vatAmount: 0, totalAmount: 150000, currency: "KZT" },
    };
    const { buffer, layout } = await renderAvrExcel({ number: "AVR-2026-0002", source });
    assert.equal(layout.unused, 2);
    assert.equal(layout.totalsRow, 21);
    assert.equal(layout.wordsRow, 23);
    assert.equal(layout.signRow, 28);
    assert.equal(layout.stampRow, 31);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.getWorksheet(AVR_EXCEL_SHEET_NAME);
    assert.ok(ws);
    assert.equal((ws.model.merges || []).length, 64);
    assert.equal(ws.getRow(20).height, 40.5);
    assert.equal(ws.getRow(21).height, 11);
    assert.equal(cellValue(ws, "C20"), gold.items[0].name);
    assert.equal(cellValue(ws, "AE21"), "Итого");
    assert.equal(cellValue(ws, "AN21"), 150000);
    assert.equal(cellValue(ws, "C21"), "");
    assert.equal(cellValue(ws, "C22"), "");
    assert.equal(cellValue(ws, "T23"), "Сто пятьдесят тысяч тенге");
    assert.equal(cellValue(ws, "A28"), "Сдал (Исполнитель)");
    assert.equal(cellValue(ws, "AA28"), "Принял (Заказчик)");
    assert.equal(cellValue(ws, "A31"), "М.П.");
    assert.equal(ws.getCell("AT15").numFmt, "dd.mm.yyyy");
    assert.ok((ws.model.merges || []).includes("C20:M20"));
    assert.ok((ws.model.merges || []).includes("AF21:AH21"));
    assert.equal((ws.model.merges || []).includes("C21:M21"), false);
    assert.equal((ws.model.merges || []).includes("C22:M22"), false);
    assert.equal(ws.getCell("A20").border?.left?.style, "thin");
    assert.equal(ws.getCell("B20").border?.right?.style, "thin");
    assert.equal(ws.getCell("C20").border?.left?.style, "thin");
    assert.equal(ws.getCell("M20").border?.right?.style, "thin");
    assert.equal(ws.getCell("AH21").border?.right?.style, "thin");
    assert.equal(ws.getCell("AW21").border?.right?.style, "thin");
  });

  it("fills the existing Form R-1 PDF without leftover template text", async () => {
    const { buffer, filename } = await renderAvrPdf({ number: "AVR-2026-0035", source: gold });
    assert.equal(buffer.subarray(0, 5).toString("utf8"), "%PDF-");
    assert.equal(filename, "26-0035 ГОЛД ПРОДУКТ от 10 сентября 2026.pdf");
    assert.equal(avrPdfFileName({ number: "AVR-2026-0035", source: gold }), filename);
    const text = await pdfText(buffer);
    assert.match(text, /26-0035/);
    assert.match(text, /10\.09\.2026/);
    assert.match(text, /ГОЛД ПРОДУКТ/);
    assert.match(text, /фотосъемка/);
    assert.match(text, /Булан А\. Б\./);
    assert.match(text, /Триста двадцать пять тысяч тенге/);

    const one: AvrSourceSnapshot = {
      ...gold,
      buyer: {
        ...gold.buyer,
        name: "АрыстанТехСервис",
        legalName: "ТОО «АрыстанТехСервис»",
        legalAddress: "РК, город Астана, район Есиль",
        bin: "111111111111",
      },
      items: [gold.items[0]],
      totals: { amountWithoutVat: 150000, vatAmount: 0, totalAmount: 150000, currency: "KZT" },
    };
    const other = await renderAvrPdf({ number: "AVR-2026-0002", source: one });
    const otherText = await pdfText(other.buffer);
    assert.match(otherText, /АрыстанТехСервис/);
    assert.match(otherText, /26-0002/);
    assert.match(otherText, /Итого/);
    assert.equal(/ГОЛД ПРОДУКТ/.test(otherText), false);
    assert.equal(/фотосъемка/.test(otherText), false);
    assert.equal(/26-0035/.test(otherText), false);

    const four: AvrSourceSnapshot = {
      ...gold,
      items: [
        ...gold.items,
        {
          dealItemId: "4",
          name: "Часы сопровождения",
          description: null,
          quantity: 2,
          unit: "час",
          unitPrice: 10000,
          amountWithoutVat: 20000,
          vatRate: 12,
          vatAmount: 2400,
          totalAmount: 22400,
          sortOrder: 3,
        },
      ],
      totals: { amountWithoutVat: 345000, vatAmount: 2400, totalAmount: 347400, currency: "KZT" },
    };
    const extra = await renderAvrPdf({ number: "AVR-2026-0035", source: four });
    const extraText = await pdfText(extra.buffer);
    assert.match(extraText, /Часы сопровождения/);
    assert.match(extraText, /фотосъемка/);
    assert.match(extraText, /345 000,00/);
    assert.match(extraText, /Триста сорок пять тысяч тенге/);
  });
});

describe("GET AVR Excel", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let server: { close: () => void };
  let base = "";
  let cookie = "";
  let otherCookie = "";
  let documentId = "";
  let esfId = "";

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

    const login = await json(
      "/api/v1/auth/login",
      { method: "POST", body: JSON.stringify({ email: "owner@creolab.example", password: process.env.SEED_PASSWORD, client: "web" }) },
      "",
    );
    cookie = login.response.headers.get("set-cookie") || "";
    const demo = await json(
      "/api/v1/auth/login",
      { method: "POST", body: JSON.stringify({ email: "owner@demo-agency.example", password: process.env.SEED_PASSWORD, client: "web" }) },
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
        directorPosition: "Директор",
        defaultVatMode: "percent",
        defaultVatRate: 12,
      }),
    });
    const created = await json("/api/v1/contacts", {
      method: "POST",
      body: JSON.stringify({ name: "Excel клиент", phone: "+77015550071" }),
    });
    const contactId = created.body.client?.id || created.body.id;
    const company = await json("/api/v1/companies", {
      method: "POST",
      body: JSON.stringify({
        name: "ТОО Excel Buyer",
        legalName: "ТОО Excel Buyer",
        bin: "222222222220",
        legalAddress: "г. Астана, ул. Кабанбай 10",
        forceCreate: true,
      }),
    });
    const deal = await json("/api/v1/deals", {
      method: "POST",
      body: JSON.stringify({
        title: "Excel сайт",
        contactId,
        companyId: company.body.id,
        items: [{ name: "Разработка сайта", quantity: 1, unit: "услуга", unitPrice: 850000 }],
      }),
    });
    const avr = await json(`/api/v1/deals/${deal.body.deal.id}/electronic-documents`, {
      method: "POST",
      body: JSON.stringify({
        type: "AVR",
        editor: {
          documentDate: "2026-09-10",
          items: [{ name: "Разработка сайта", quantity: 1, unit: "услуга", unitPrice: 850000, vatRate: 12 }],
        },
      }),
    });
    assert.equal(avr.response.status, 201, JSON.stringify(avr.body));
    documentId = avr.body.document.id;
    const esf = await json(`/api/v1/deals/${deal.body.deal.id}/electronic-documents`, {
      method: "POST",
      body: JSON.stringify({ type: "ESF" }),
    });
    esfId = esf.body.document?.id || "";
  });

  after(() => {
    server?.close();
  });

  it("отдаёт xlsx без ИС ЭСФ", async () => {
    const response = await fetch(`${base}/api/v1/electronic-documents/${documentId}/excel`, { headers: { cookie } });
    const buffer = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200, buffer.toString("utf8").slice(0, 400));
    assert.match(response.headers.get("content-type") || "", /spreadsheetml/);
    assert.match(response.headers.get("content-disposition") || "", /filename\*=UTF-8''/);
    assert.equal(buffer.subarray(0, 2).toString("utf8"), "PK");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.getWorksheet(AVR_EXCEL_SHEET_NAME);
    assert.ok(ws);
    assert.match(String(cellValue(ws, "AP15")), /^\d{2}-\d{4}$/);
    assert.equal(cellValue(ws, "C20"), "Разработка сайта");
    assert.equal(cellValue(ws, "AC20"), "услуга");
    assert.equal(cellValue(ws, "AI20"), 850000);
  });

  it("отдаёт PDF формы Р-1 без ИС ЭСФ", async () => {
    const response = await fetch(`${base}/api/v1/electronic-documents/${documentId}/pdf`, { headers: { cookie } });
    const buffer = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200, buffer.toString("utf8").slice(0, 400));
    assert.match(response.headers.get("content-type") || "", /pdf/);
    assert.match(response.headers.get("content-disposition") || "", /\.pdf/);
    assert.equal(buffer.subarray(0, 5).toString("utf8"), "%PDF-");
    const text = await pdfText(buffer);
    assert.match(text, /Разработка сайта/);
    assert.match(text, /Excel Buyer/);
    assert.equal(/ГОЛД ПРОДУКТ/.test(text), false);
  });

  it("не отдаёт Excel чужому тенанту и не считает ЭСФ актом", async () => {
    assert.equal((await fetch(`${base}/api/v1/electronic-documents/${documentId}/excel`)).status, 401);
    assert.equal(
      (await fetch(`${base}/api/v1/electronic-documents/${documentId}/excel`, { headers: { cookie: otherCookie } })).status,
      404,
    );
    if (esfId) {
      const denied = await json(`/api/v1/electronic-documents/${esfId}/excel`);
      assert.equal(denied.response.status, 422);
      assert.equal(denied.body.code, "not_avr");
      const deniedPdf = await json(`/api/v1/electronic-documents/${esfId}/pdf`);
      assert.equal(deniedPdf.response.status, 422);
      assert.equal(deniedPdf.body.code, "not_avr");
    }
    assert.equal((await fetch(`${base}/api/v1/electronic-documents/${documentId}/pdf`)).status, 401);
    assert.equal(
      (await fetch(`${base}/api/v1/electronic-documents/${documentId}/pdf`, { headers: { cookie: otherCookie } })).status,
      404,
    );
  });
});
