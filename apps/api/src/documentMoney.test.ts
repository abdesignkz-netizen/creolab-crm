import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapDealItemsToInvoiceItems } from "./services/documentDraftService.ts";
import { lineAmounts, moneyRound, sumLines } from "./services/documentMoney.ts";

describe("document money", () => {
  it("считает НДС 12% с округлением", () => {
    const line = lineAmounts(1, 850000, 12);
    assert.equal(line.amountWithoutVat, 850000);
    assert.equal(line.vatAmount, 102000);
    assert.equal(line.totalAmount, 952000);
  });

  it("суммирует смешанные ставки", () => {
    const totals = sumLines([
      { amountWithoutVat: 100000, vatAmount: 0, totalAmount: 100000, vatRate: 0 },
      { amountWithoutVat: 200000, vatAmount: 24000, totalAmount: 224000, vatRate: 12 },
    ]);
    assert.equal(totals.amountWithoutVat, 300000);
    assert.equal(totals.vatAmount, 24000);
    assert.equal(totals.totalAmount, 324000);
    assert.equal(totals.vatRate, null);
  });

  it("копирует позиции сделки в строки счёта", () => {
    const mapped = mapDealItemsToInvoiceItems(
      [
        {
          id: "item-1",
          name: "Сайт",
          description: null,
          quantity: 1,
          unit: "услуга",
          unitPrice: 100,
          amountWithoutVat: 100,
          vatRate: 0,
          vatAmount: 0,
          totalAmount: 100,
          sortOrder: 0,
          catalogItemId: null,
        },
      ],
      "tenant-1",
      "invoice-1",
    );
    assert.equal(mapped[0].dealItemId, "item-1");
    assert.equal(mapped[0].invoiceId, "invoice-1");
    assert.equal(mapped[0].name, "Сайт");
  });

  it("округляет деньги до тиына", () => {
    assert.equal(moneyRound(12.345), 12.35);
  });
});
