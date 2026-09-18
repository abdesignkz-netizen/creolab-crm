import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  invoiceDirectorShortName,
  invoiceLocalNumber,
  invoicePayableWords,
  invoicePdfFileName,
  renderInvoicePdf,
} from "./services/invoicePdf.ts";

const sample = {
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
};

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

describe("invoice pdf", () => {
  it("собирает детерминированный PDF счёта по форме 1С", async () => {
    assert.equal(invoiceLocalNumber("INV-2026-0121"), "26-0121");
    assert.equal(invoiceDirectorShortName("Булан Асет Болатович"), "Булан А.Б.");
    assert.equal(invoicePayableWords(150000), "Сто пятьдесят тысяч тенге 00 тиын");
    assert.match(invoicePdfFileName(sample), /26-0121/);

    const pdf = await renderInvoicePdf(sample);
    assert.equal(pdf.subarray(0, 4).toString("utf8"), "%PDF");
    const text = await pdfText(pdf);
    assert.match(text, /Образец платежного поручения/);
    assert.match(text, /Счет на оплату № 26-0121 от 03\.09\.2026 г\./);
    assert.match(text, /Бенефициар/);
    assert.match(text, /KZ268562203127261373/);
    assert.match(text, /КБе/);
    assert.match(text, /КНП/);
    assert.match(text, /Поставщик/);
    assert.match(text, /Покупатель/);
    assert.match(text, /ARASAKA/);
    assert.match(text, /03092026\/01/);
    assert.match(text, /Разработка презентации компании/);
    assert.match(text, /Предоплата 50%/);
    assert.match(text, /150 000,00/);
    assert.match(text, /Без НДС/);
    assert.match(text, /Всего к оплате: Сто пятьдесят тысяч тенге 00 тиын/);
    assert.match(text, /Булан А\.Б\./);
    assert.equal(/СЧЁТ НА ОПЛАТУ/.test(text), false);

    const again = await renderInvoicePdf(sample);
    assert.equal(createHash("sha256").update(pdf).digest("hex"), createHash("sha256").update(again).digest("hex"));
  });

  it("не ставит строку предоплаты при полной оплате", async () => {
    const pdf = await renderInvoicePdf({
      ...sample,
      paymentPercent: 100,
      amountWithoutVat: 300000,
      totalAmount: 300000,
    });
    const text = await pdfText(pdf);
    assert.equal(/Предоплата/.test(text), false);
    assert.match(text, /300 000,00/);
  });
});
