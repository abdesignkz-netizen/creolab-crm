import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@creolab/db";
import type { AuthContext } from "../../lib/types.ts";
import { requirePlatformAdmin } from "../../lib/access.ts";
import { writeAudit } from "../../lib/audit.ts";
import { billingError } from "./config.ts";
import { sellerProfile, sellerSchema } from "./documents.ts";
import { lockTenant } from "./ledger.ts";

const fields = ["signerName", "signerPosition", "signatureDataUrl", "stampDataUrl"] as const;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Explicit, audited completion of missing signing details on an unpaid invoice. */
export async function completeInvoiceSigning(db: PrismaClient, auth: AuthContext, invoiceId: string) {
  requirePlatformAdmin(auth);
  const found = await db.billingInvoice.findUnique({ where: { id: invoiceId }, select: { tenantId: true } });
  if (!found) billingError("not_found", "Счёт не найден", 404);
  return db.$transaction(async tx => {
    await lockTenant(tx, found.tenantId);
    const invoice = await tx.billingInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
    const order = await tx.billingOrder.findUnique({ where: { id: invoice.orderId } });
    const paid = await tx.billingPayment.findFirst({ where: {
      orderId: invoice.orderId,
      OR: [{ status: { in: ["PAID", "CONFIRMED", "REFUNDED", "PARTIALLY_REFUNDED"] } }, { paidAt: { not: null } }],
    } });
    if (invoice.status !== "ISSUED" || invoice.paidAt || !order || order.status !== "PENDING_PAYMENT" || order.paidAt || paid)
      billingError("invoice_closed", "Дополнить подпись можно только в неоплаченном открытом счёте", 409);
    const current = await sellerProfile(tx);
    if (!current?.signerName || !current.signerPosition || !current.signatureDataUrl)
      billingError("invoice_signing_missing", "Сначала сохраните ФИО, должность и подпись в реквизитах продавца", 409);
    const old = sellerSchema.parse(invoice.sellerJson);
    if (old.bin !== current.bin)
      billingError("invoice_seller_mismatch", "БИН продавца в счёте отличается от текущих реквизитов", 409);
    // Never attribute a previously saved signature to a new person or office.
    if ((old.signerName && old.signerName !== current.signerName) ||
        (old.signerPosition && old.signerPosition !== current.signerPosition) ||
        (old.signatureDataUrl && old.signatureDataUrl !== current.signatureDataUrl))
      billingError("invoice_signer_mismatch", "Подписант счёта отличается от текущего. Автоматическое дополнение недоступно", 409);
    const snapshot = { ...(invoice.sellerJson as Record<string, Prisma.JsonValue>) };
    const addedFields: string[] = [];
    for (const field of fields) {
      if (!old[field] && current[field]) {
        snapshot[field] = current[field];
        addedFields.push(field);
      }
    }
    if (addedFields.length) {
      await tx.billingInvoice.update({ where: { id: invoice.id }, data: { sellerJson: snapshot as Prisma.InputJsonValue } });
      await writeAudit(tx, {
        tenantId: invoice.tenantId, actorUserId: auth.user.id,
        action: "billing.invoice.signing_completed", entityType: "billing_invoice", entityId: invoice.id,
        changes: { invoiceNumber: invoice.invoiceNumber, addedFields,
          values: Object.fromEntries(addedFields.map(field => [field,
            field.endsWith("DataUrl") ? { sha256: hash(String(snapshot[field])) } : snapshot[field],
          ])),
        },
      });
    }
    return { id: invoice.id, invoiceNumber: invoice.invoiceNumber, addedFields, changed: addedFields.length > 0 };
  });
}
