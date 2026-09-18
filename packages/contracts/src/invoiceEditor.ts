import { z } from "zod";
import { avrEditorAmounts, avrEditorSchema, type AvrEditorInput } from "./avrEditor.ts";

const paymentPercent = z.coerce
  .number()
  .finite()
  .min(1, "Укажите процент оплаты")
  .max(100)
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 0.00001, "Не более 2 знаков после запятой");

export const invoiceEditorSchema = avrEditorSchema.and(
  z.object({
    paymentPercent: paymentPercent.default(100),
    contractNumber: z.string().trim().max(100).optional().default(""),
    contractDate: z
      .string()
      .regex(/^$|^20\d{2}-\d{2}-\d{2}$/, "Укажите дату договора")
      .optional()
      .default(""),
  }),
);

export const updateInvoiceDraftSchema = invoiceEditorSchema.and(
  z.object({
    updatedAt: z.string().datetime().optional(),
  }),
);

export type InvoiceEditorInput = AvrEditorInput & { paymentPercent: number; contractNumber?: string; contractDate?: string };

function scaledCents(amount: number) {
  return BigInt(amount.toFixed(2).replace(".", ""));
}

export function scaleInvoiceMoney(amount: number, paymentPercent: number) {
  const payable = (scaledCents(amount) * scaledCents(paymentPercent) + 5000n) / 10000n;
  return Number(payable) / 100;
}

export function invoicePayableTotals(items: AvrEditorInput["items"], paymentPercent: number) {
  const amounts = avrEditorAmounts(items);
  return {
    items: amounts,
    paymentPercent,
    payable: {
      amountWithoutVat: scaleInvoiceMoney(amounts.totals.amountWithoutVat, paymentPercent),
      vatAmount: scaleInvoiceMoney(amounts.totals.vatAmount, paymentPercent),
      totalAmount: scaleInvoiceMoney(amounts.totals.totalAmount, paymentPercent),
    },
  };
}

export function inferInvoicePaymentPercent(payableTotal: number, itemsTotal: number) {
  if (!(itemsTotal > 0)) return 100;
  const ratio = (Number(payableTotal) / Number(itemsTotal)) * 100;
  if (Math.abs(ratio - 100) < 0.051) return 100;
  return Math.round(ratio * 100) / 100;
}
