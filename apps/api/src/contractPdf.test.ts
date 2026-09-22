import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONTRACT_BODY } from "./services/contractTemplate.ts";
import { contractItemTableRows, paymentHalves, renderContractPdf } from "./services/contractPdf.ts";
import { buildPlainDocx, contractDocxContentHash } from "./services/contractDocx.ts";
import JSZip from "jszip";
import { wordFileToContractPdf } from "./services/contractPdfCopy.ts";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractPdfPages } from "./services/pdfTextExtraction.ts";
import { renderSimpleWordPdf } from "./services/contractWordPdfFallback.ts";

const SAMPLE_INPUT = {
  number: "DOG-2026-0001",
  date: new Date("2026-09-12T00:00:00Z"),
  subject: "Разработка сайта",
  dealName: "Сайт для клиента",
  paymentTerms: "50% аванс",
  completionTerms: "30 дней",
  amountWithoutVat: 850000,
  vatRate: 12,
  vatAmount: 102000,
  totalAmount: 952000,
  sellerName: "ТОО CREOLAB",
  sellerBin: "123456789013",
  sellerAddress: "Алматы",
  sellerDirector: "Иванов И.И.",
  sellerDirectorPosition: "Директор",
  buyerName: "ТОО Покупатель",
  buyerBin: "222222222220",
  buyerAddress: "Астана",
  buyerDirector: "Петров П.П.",
  items: [{ name: "Разработка сайта", quantity: 1, unit: "услуга", unitPrice: 850000, totalAmount: 952000 }],
  templateBody: DEFAULT_CONTRACT_BODY,
};

describe("contract pdf", () => {
  it("prints readable unit symbols from the stored codes", () => {
    const rows = contractItemTableRows({ ...SAMPLE_INPUT, items: [
      { ...SAMPLE_INPUT.items[0], unit: "796" },
      { ...SAMPLE_INPUT.items[0], unit: "362" },
    ] });
    assert.equal(rows[1][3], "шт");
    assert.equal(rows[2][3], "мес");
  });
  it("compares Word content without ZIP timestamps but detects formatting and image changes", async () => {
    const original = await buildPlainDocx("Неизменённый договор", []);
    const zip = await JSZip.loadAsync(original);
    for (const entry of Object.values(zip.files)) entry.date = new Date("2030-01-01T00:00:00Z");
    const repacked = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
    assert.notDeepEqual(repacked, original);
    assert.equal(await contractDocxContentHash(repacked), await contractDocxContentHash(original));
    zip.file("word/styles.xml", "<styles>changed</styles>");
    const restyled = await zip.generateAsync({ type: "nodebuffer" });
    assert.notEqual(await contractDocxContentHash(restyled), await contractDocxContentHash(original));
    zip.file("word/media/logo.png", Buffer.from("changed logo"));
    assert.notEqual(await contractDocxContentHash(await zip.generateAsync({ type: "nodebuffer" })), await contractDocxContentHash(restyled));
  });
  it("делит сумму сделки пополам для предоплаты и остатка", () => {
    assert.deepEqual(paymentHalves(300000), { prepayment: 150000, remainder: 150000 });
    assert.deepEqual(paymentHalves(200001), { prepayment: 100000.5, remainder: 100000.5 });
  });
  it("собирает PDF с кириллицей и таблицей позиций", async () => {
    const pdf = await renderContractPdf(SAMPLE_INPUT);
    assert.equal(pdf.subarray(0, 4).toString("utf8"), "%PDF");
    assert.ok(pdf.length > 2000);

    const again = await renderContractPdf(SAMPLE_INPUT);
    assert.equal(createHash("sha256").update(pdf).digest("hex"), createHash("sha256").update(again).digest("hex"));
  });
  it("если LibreOffice недоступен, всё равно отдаёт PDF для просмотра и подписи", async () => {
    const original = process.env.CRM_SOFFICE_PATH;
    process.env.CRM_SOFFICE_PATH = "/missing-soffice-binary";
    try {
      const docx = await buildPlainDocx("Договор на разработку сайта", []);
      const pdf = await wordFileToContractPdf(docx, "DOG-2026-0001.docx", SAMPLE_INPUT);
      assert.equal(pdf.subarray(0, 4).toString("utf8"), "%PDF");
      assert.ok(pdf.length > 2000);
    } finally {
      if (original === undefined) delete process.env.CRM_SOFFICE_PATH;
      else process.env.CRM_SOFFICE_PATH = original;
    }
  });
  it("recovers a converter failure from the saved Word text, never from changed deal or template data", async () => {
    const original = process.env.CRM_SOFFICE_PATH;
    const scratch = await mkdtemp(path.join(tmpdir(), "contract-pdf-fallback-"));
    const converter = path.join(scratch, "soffice");
    await writeFile(converter, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    process.env.CRM_SOFFICE_PATH = converter;
    try {
      const docx = await buildPlainDocx("Договор DOG-2026-0009\nУникальное условие: оплата после приёмки.\n{{items_table}}\nПодписи сторон", [["Заказ", "Сумма"], ["Презентация", "200 000 тенге"]]);
      const pdf = await wordFileToContractPdf(docx, "DOG-2026-0009.docx", SAMPLE_INPUT);
      const text = (await extractPdfPages(pdf)).map((page) => page.text).join(" ");
      assert.match(text, /DOG-2026-0009/);
      assert.match(text, /оплата после приёмки/);
      assert.match(text, /200 000/);
      assert.doesNotMatch(text, /952.?000|Разработка сайта|50% аванс/);
      await assert.rejects(wordFileToContractPdf(Buffer.from("PK\u0003\u0004broken"), "broken.docx", SAMPLE_INPUT));
      const imageDoc = await JSZip.loadAsync(docx);
      imageDoc.file("word/media/logo.png", Buffer.from("logo"));
      assert.equal(await renderSimpleWordPdf(await imageDoc.generateAsync({ type: "nodebuffer" })), null);
    } finally {
      if (original === undefined) delete process.env.CRM_SOFFICE_PATH; else process.env.CRM_SOFFICE_PATH = original;
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
