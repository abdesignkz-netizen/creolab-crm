import { documentOrganization } from "./documentOrganization.ts";
import type { PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { requireDocumentsAccess } from "../lib/access.ts";
import { AVR_FIELD_LABELS, assessAvrReadiness, type AvrReadiness } from "./avrReadiness.ts";
import { esfOutgoingNum, resolveCatalogTruId } from "./esfInvoiceMapper.ts";

export const ESF_INVOICE_FIELD_LABELS: Record<string, string> = {
  ...AVR_FIELD_LABELS,
  catalogTruId: "Идентификатор ТРУ из справочника ИС ЭСФ (G 18)",
  "esf.outgoingNum": "Исходящий номер ЭСФ только из цифр",
  "avr.sent": "АВР, отправленный в ИС ЭСФ",
};

export type EsfInvoiceReadiness = AvrReadiness & {
  sendReady: boolean;
  avrExternalId: string | null;
};

export function assessEsfInvoiceReadiness(input: Parameters<typeof assessAvrReadiness>[0] & {
  catalogTruId?: string | null;
  outgoingNum?: string | null;
  avrExternalId?: string | null;
}): EsfInvoiceReadiness {
  const base = assessAvrReadiness(input);
  const missingFields = [...base.missingFields];
  if (!String(input.catalogTruId || "").trim()) missingFields.push("catalogTruId");
  if (!esfOutgoingNum(input.outgoingNum || "1")) missingFields.push("esf.outgoingNum");
  const sendMissing = [...missingFields];
  if (!input.avrExternalId) sendMissing.push("avr.sent");
  const missingFieldLabels = Object.fromEntries(
    sendMissing.map((code) => [code, ESF_INVOICE_FIELD_LABELS[code] || code]),
  );
  return {
    ...base,
    ready: missingFields.length === 0,
    sendReady: sendMissing.length === 0,
    missingFields: sendMissing,
    missingFieldLabels,
    avrExternalId: input.avrExternalId || null,
  };
}

export function esfInvoiceMissingFieldsError(readiness: EsfInvoiceReadiness) {
  const labels = readiness.missingFields.map((code) => readiness.missingFieldLabels[code] || code);
  return new ApiError(
    422,
    "missing_fields",
    labels.length ? `Не готов к ЭСФ: ${labels.join(", ")}` : "Не готов к ЭСФ",
    undefined,
    {
      ready: readiness.ready,
      sendReady: readiness.sendReady,
      missingFields: readiness.missingFields,
      missingFieldLabels: readiness.missingFieldLabels,
      warnings: readiness.warnings,
    },
  );
}

export async function getEsfInvoiceReadiness(prisma: PrismaClient, auth: AuthContext, dealId: string) {
  requireDocumentsAccess(auth);
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  const tid = auth.activeMembership.tenantId;
  const deal = await prisma.deal.findFirst({
    where: { id: dealId, tenantId: tid },
    include: {
      company: {
        select: {
          name: true,
          legalName: true,
          bin: true,
          iin: true,
          legalAddress: true,
          address: true,
        },
      },
      items: { select: { id: true, catalogTruId: true } },
      contracts: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true, number: true, date: true, status: true },
      },
      electronicDocuments: {
        where: { type: { in: ["AVR", "ESF"] } },
        orderBy: { createdAt: "desc" },
        select: { id: true, type: true, number: true, contractId: true, invoiceId: true, externalId: true, status: true },
      },
    },
  });
  if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");
  const profile = await documentOrganization(prisma, tid, dealId, deal.electronicDocuments.find(row => row.type === "ESF")?.contractId || deal.contracts[0]?.id);
  const esf = deal.electronicDocuments.find((row) => row.type === "ESF") || null;
  const contract = esf?.contractId ? await prisma.contract.findFirst({where:{id:esf.contractId,tenantId:tid,dealId}}) : deal.contracts[0] || null;
  const avr = deal.electronicDocuments.find((row) => row.type === "AVR" && row.externalId) || null;
  const catalogTruId =
    deal.items.map((item) => resolveCatalogTruId(item, profile?.defaultCatalogTruId)).find(Boolean) ||
    profile?.defaultCatalogTruId ||
    "";
  return assessEsfInvoiceReadiness({
    dealId,
    contractId: contract?.id || null,
    documentId: esf?.id || null,
    signedContractId: contract?.status === "SIGNED" ? contract.id : null,
    invoiceId: esf?.invoiceId || null,
    contractNumber: contract?.number || null,
    contractDate: contract?.date || null,
    itemCount: deal.items.length,
    profile,
    company: deal.company,
    catalogTruId,
    outgoingNum: esf?.number || "1",
    avrExternalId: avr?.externalId || null,
  });
}
