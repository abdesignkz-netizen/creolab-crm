import type { PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import {
  assessContractReadiness,
  CONTRACT_FIELD_LABELS,
  type ContractReadiness,
} from "./contractReadiness.ts";

export const AVR_FIELD_LABELS: Record<string, string> = {
  ...CONTRACT_FIELD_LABELS,
  "contract.signed": "Подписанный договор",
  "contract.date": "Договор: дата",
  "contract.number": "Договор: номер",
};

export type AvrReadiness = ContractReadiness & {
  documentId: string | null;
  signedContractId: string | null;
  invoiceId: string | null;
};

function filled(value: string | null | undefined) {
  return Boolean(value && String(value).trim());
}

export function assessAvrReadiness(input: {
  dealId: string;
  contractId?: string | null;
  documentId?: string | null;
  signedContractId?: string | null;
  invoiceId?: string | null;
  contractNumber?: string | null;
  contractDate?: Date | string | null;
  itemCount: number;
  profile: {
    legalName: string | null;
    bin: string | null;
    iin?: string | null;
    legalAddress: string | null;
    directorName: string | null;
  } | null;
  company: {
    name: string;
    legalName: string | null;
    bin: string | null;
    iin: string | null;
    legalAddress: string | null;
    address: string | null;
  } | null;
}): AvrReadiness {
  const base = assessContractReadiness({
    dealId: input.dealId,
    contractId: input.signedContractId || input.contractId,
    itemCount: input.itemCount,
    profile: input.profile,
    company: input.company,
  });
  const missingFields = [...base.missingFields];
  if (!input.signedContractId) missingFields.push("contract.signed");
  if (input.signedContractId && !filled(input.contractNumber)) missingFields.push("contract.number");
  if (input.signedContractId && !input.contractDate) missingFields.push("contract.date");

  const missingFieldLabels = Object.fromEntries(
    missingFields.map((code) => [code, AVR_FIELD_LABELS[code] || code]),
  );
  return {
    ready: missingFields.length === 0,
    missingFields,
    missingFieldLabels,
    dealId: input.dealId,
    contractId: input.signedContractId || input.contractId || null,
    documentId: input.documentId || null,
    signedContractId: input.signedContractId || null,
    invoiceId: input.invoiceId || null,
  };
}

export function avrMissingFieldsError(readiness: AvrReadiness) {
  const labels = readiness.missingFields.map((code) => readiness.missingFieldLabels[code] || code);
  return new ApiError(
    422,
    "missing_fields",
    labels.length ? `Не готов к отправке: ${labels.join(", ")}` : "Не готов к отправке",
    undefined,
    {
      ready: false,
      missingFields: readiness.missingFields,
      missingFieldLabels: readiness.missingFieldLabels,
    },
  );
}

export async function getAvrReadiness(prisma: PrismaClient, auth: AuthContext, dealId: string) {
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
      items: { select: { id: true } },
      contracts: {
        where: { status: "SIGNED" },
        orderBy: { signedAt: "desc" },
        take: 1,
        select: { id: true, number: true, date: true },
      },
      invoices: {
        where: { status: { in: ["ISSUED", "PARTIALLY_PAID", "PAID"] } },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true },
      },
      electronicDocuments: {
        where: { type: "AVR", status: { in: ["DRAFT", "VALIDATED"] } },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true, contractId: true, invoiceId: true },
      },
    },
  });
  if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");
  const profile = await prisma.tenantLegalProfile.findUnique({
    where: { tenantId: tid },
    select: { legalName: true, bin: true, iin: true, legalAddress: true, directorName: true },
  });
  const signed = deal.contracts[0] || null;
  return assessAvrReadiness({
    dealId,
    contractId: deal.electronicDocuments[0]?.contractId || signed?.id || null,
    documentId: deal.electronicDocuments[0]?.id || null,
    signedContractId: signed?.id || null,
    invoiceId: deal.electronicDocuments[0]?.invoiceId || deal.invoices[0]?.id || null,
    contractNumber: signed?.number || null,
    contractDate: signed?.date || null,
    itemCount: deal.items.length,
    profile,
    company: deal.company,
  });
}
