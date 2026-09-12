import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONTRACT_BODY } from "./services/contractTemplate.ts";
import { renderContractPdf } from "./services/contractPdf.ts";

describe("contract pdf", () => {
  it("собирает PDF с кириллицей и таблицей позиций", async () => {
    const pdf = await renderContractPdf({
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
    });
    assert.equal(pdf.subarray(0, 4).toString("utf8"), "%PDF");
    assert.ok(pdf.length > 2000);

    const again = await renderContractPdf({
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
    });
    assert.equal(createHash("sha256").update(pdf).digest("hex"), createHash("sha256").update(again).digest("hex"));
  });
});
