import assert from "node:assert/strict";
import { test } from "node:test";
import { inferInvoicePaymentPercent, invoicePayableTotals, scaleInvoiceMoney } from "./invoiceEditor.ts";

test("invoice prepayment scales cents without floating drift", () => {
  const half = invoicePayableTotals(
    [{ name: "Услуга", quantity: 1, unit: "услуга", unitPrice: 300000, vatRate: 0 }],
    50,
  );
  assert.equal(half.payable.totalAmount, 150000);
  assert.equal(half.items.totals.totalAmount, 300000);
  assert.equal(scaleInvoiceMoney(274000, 50), 137000);
  assert.equal(inferInvoicePaymentPercent(150000, 300000), 50);
  assert.equal(inferInvoicePaymentPercent(300000, 300000), 100);
});
