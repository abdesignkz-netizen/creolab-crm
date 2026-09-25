import type { PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import type { AvrSourceSnapshot } from "./avrMapper.ts";
import { importedInvoiceDetails } from "./importedInvoiceDetails.ts";

// Resolve actual CRM links separately from contract requisites printed on an invoice.
// An external contract number is not a CRM contract id.
export async function resolveAvrLinks(
  prisma: PrismaClient, tenantId: string, dealId: string,
  input: { contractId?: string | null; invoiceId?: string | null } = {},
) {
  const invoice = input.invoiceId
    ? await prisma.invoice.findFirst({ where: { id: input.invoiceId, tenantId, dealId } })
    : !input.contractId
      ? await prisma.invoice.findFirst({ where: { tenantId, dealId, status: { notIn: ["CANCELLED", "VOID"] } }, orderBy: { createdAt: "desc" } })
      : null;
  if (input.invoiceId && !invoice) throw new ApiError(404, "not_found", "Счёт не найден");
  const linkedId = input.contractId || (!invoice?.withoutContract ? invoice?.contractId : null);
  let contract = linkedId ? await prisma.contract.findFirst({ where: { id: linkedId, tenantId, dealId } }) : null;
  if (linkedId && !contract) throw new ApiError(404, "not_found", "Договор не найден");
  let basis: AvrSourceSnapshot["contract"] = null;
  if (!input.contractId && invoice && !invoice.withoutContract) {
    const imported = !invoice.contractNumber && invoice.pdfFileId
      ? (await importedInvoiceDetails(prisma, tenantId, [invoice.id])).get(invoice.id) : null;
    const number = invoice.contractNumber?.trim() || imported?.contractNumber?.trim();
    if (number) {
      if (!contract) contract = await prisma.contract.findFirst({ where: { tenantId, dealId, number }, orderBy: { createdAt: "desc" } });
      const sameNumber = contract?.number.trim() === number;
      basis = { id: sameNumber ? contract!.id : "", number,
        date: invoice.contractDate?.toISOString() || (sameNumber ? contract!.date.toISOString() : ""),
        status: sameNumber ? contract!.status : "EXTERNAL" };
      if (!sameNumber) contract = null;
    }
  }
  if (!contract && !basis && !invoice?.withoutContract) {
    contract = await prisma.contract.findFirst({ where: { tenantId, dealId }, orderBy: { createdAt: "desc" } });
  }
  if (!basis && contract) basis = { id: contract.id, number: contract.number, date: contract.date.toISOString(), status: contract.status };
  return { contract, invoice, basis };
}
