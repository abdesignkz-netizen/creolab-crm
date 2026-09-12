import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderInvoicePdf } from "./services/invoicePdf.ts";

const sample = {
  number: "INV-2026-0001",
  date: new Date("2026-09-12T00:00:00Z"),
  dueDate: new Date("2026-09-19T00:00:00Z"),
  contractNumber: "DOG-2026-0001",
  contractDate: new Date("2026-09-10T00:00:00Z"),
  dealName: "Сайт для клиента",
  amountWithoutVat: 850000,
  vatRate: 12,
  vatAmount: 102000,
  totalAmount: 952000,
  sellerName: "ТОО CREOLAB",
  sellerBin: "123456789013",
  sellerAddress: "Алматы",
  sellerIban: "KZ86125KZT5004100100",
  sellerBankName: "Kaspi Bank",
  sellerBik: "KCJBKZKX",
  buyerName: "ТОО Покупатель",
  buyerBin: "222222222220",
  buyerAddress: "Астана",
  items: [{ name: "Разработка сайта", quantity: 1, unit: "услуга", unitPrice: 850000, totalAmount: 952000 }],
};

describe("invoice pdf", () => {
  it("собирает детерминированный PDF счёта", async () => {
    const pdf = await renderInvoicePdf(sample);
    assert.equal(pdf.subarray(0, 4).toString("utf8"), "%PDF");
    assert.ok(pdf.length > 1500);

    const again = await renderInvoicePdf(sample);
    assert.equal(createHash("sha256").update(pdf).digest("hex"), createHash("sha256").update(again).digest("hex"));
  });
});
