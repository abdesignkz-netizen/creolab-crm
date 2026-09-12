import type { PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import {
  assessContractReadiness,
  CONTRACT_FIELD_LABELS,
  type ContractReadiness,
} from "./contractReadiness.ts";

export const INVOICE_FIELD_LABELS: Record<string, string> = {
  ...CONTRACT_FIELD_LABELS,
  "contract.signed": "Подписанный договор",
  "organization.iban": "Реквизиты: ИИК / IBAN",
  "organization.bik": "Реквизиты: БИК",
};

export type InvoiceReadiness = ContractReadiness & {
  invoiceId: string | null;
  signedContractId: string | null;
};

function filled(value: string | null | undefined) {
  return Boolean(value && String(value).trim());
}

export function assessInvoiceReadiness(input: {
  dealId: string;
  contractId?: string | null;
  invoiceId?: string | null;
  signedContractId?: string | null;
  itemCount: number;
  profile: {
    legalName: string | null;
    bin: string | null;
    iin?: string | null;
    legalAddress: string | null;
    directorName: string | null;
    iban?: string | null;
    bik?: string | null;
  } | null;
  company: {
    name: string;
    legalName: string | null;
    bin: string | null;
    iin: string | null;
    legalAddress: string | null;
    address: string | null;
  } | null;
}): InvoiceReadiness {
  const base = assessContractReadiness({
    dealId: input.dealId,
    contractId: input.signedContractId || input.contractId,
    itemCount: input.itemCount,
    profile: input.profile,
    company: input.company,
  });
  const missingFields = [...base.missingFields];
  if (!input.signedContractId) missingFields.push("contract.signed");
  if (!filled(input.profile?.iban)) missingFields.push("organization.iban");
  if (!filled(input.profile?.bik)) missingFields.push("organization.bik");

  const missingFieldLabels = Object.fromEntries(
    missingFields.map((code) => [code, INVOICE_FIELD_LABELS[code] || code]),
  );
  return {
    ready: missingFields.length === 0,
    missingFields,
    missingFieldLabels,
    dealId: input.dealId,
    contractId: input.signedContractId || input.contractId || null,
    invoiceId: input.invoiceId || null,
    signedContractId: input.signedContractId || null,
  };
}

export function invoiceMissingFieldsError(readiness: InvoiceReadiness) {
  const labels = readiness.missingFields.map((code) => readiness.missingFieldLabels[code] || code);
  return new ApiError(
    422,
    "missing_fields",
    labels.length ? `Не хватает данных для счёта: ${labels.join(", ")}` : "Не хватает данных для счёта",
    undefined,
    {
      ready: false,
      missingFields: readiness.missingFields,
      missingFieldLabels: readiness.missingFieldLabels,
    },
  );
}

export async function getInvoiceReadiness(prisma: PrismaClient, auth: AuthContext, dealId: string) {
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
        select: { id: true },
      },
      invoices: {
        where: { status: { in: ["DRAFT", "ISSUED", "PARTIALLY_PAID"] } },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true, contractId: true },
      },
    },
  });
  if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");
  const profile = await prisma.tenantLegalProfile.findUnique({
    where: { tenantId: tid },
    select: {
      legalName: true,
      bin: true,
      iin: true,
      legalAddress: true,
      directorName: true,
      iban: true,
      bik: true,
    },
  });
  return assessInvoiceReadiness({
    dealId,
    contractId: deal.invoices[0]?.contractId || deal.contracts[0]?.id || null,
    invoiceId: deal.invoices[0]?.id || null,
    signedContractId: deal.contracts[0]?.id || null,
    itemCount: deal.items.length,
    profile,
    company: deal.company,
  });
}
