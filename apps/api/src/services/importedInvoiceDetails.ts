import type { PrismaClient } from "@creolab/db";
import { z } from "zod";
import { invoicePayment } from "./invoicePayment.ts";

// The reviewed import is stored atomically with the invoice in the import audit.
// Read it for existing imports too, without re-running OCR or changing the PDF.
const detailsSchema = z.object({
  subject: z.string(), paymentTerms: z.string(),
  paymentKind: z.enum(["PREPAYMENT", "BALANCE", "ADDITIONAL", "FULL", "UNSPECIFIED"]).optional(),
  contractNumber: z.string().optional(),
});
export async function importedInvoiceDetails(prisma: PrismaClient, tenantId: string, ids: string[]) {
  const result = new Map<string, z.infer<typeof detailsSchema>>();
  if (!ids.length) return result;
  const events = await prisma.auditEvent.findMany({where:{tenantId,entityType:"invoice",entityId:{in:ids},action:"document.import_pdf"},orderBy:{createdAt:"asc"}});
  for (const event of events) {
    const json = event.changesJson as {reviewedImport?: unknown} | null;
    const parsed = detailsSchema.safeParse(json?.reviewedImport);
    if (parsed.success && event.entityId) result.set(event.entityId, {...parsed.data, paymentKind:parsed.data.paymentKind ?? invoicePayment(`${parsed.data.subject}\n${parsed.data.paymentTerms}`).paymentKind});
  }
  return result;
}
