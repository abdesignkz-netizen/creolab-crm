import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONTRACT_BODY } from "./services/contractTemplate.ts";
import { paymentHalves, renderContractPdf } from "./services/contractPdf.ts";
import { buildPlainDocx } from "./services/contractDocx.ts";
import { wordFileToContractPdf } from "./services/contractPdfCopy.ts";

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
});
