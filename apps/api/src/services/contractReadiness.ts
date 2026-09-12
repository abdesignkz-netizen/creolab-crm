import type { PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";

export const CONTRACT_FIELD_LABELS: Record<string, string> = {
  "organization.legalName": "Реквизиты: юридическое название",
  "organization.bin": "Реквизиты: БИН или ИИН",
  "organization.legalAddress": "Реквизиты: юридический адрес",
  "organization.directorName": "Реквизиты: директор",
  "customer.company": "Сделка: компания покупателя",
  "customer.legalName": "Компания: название",
  "customer.bin": "Компания: БИН или ИИН",
  "customer.legalAddress": "Компания: юридический адрес",
  "deal.items": "Сделка: хотя бы одна позиция",
};

export type ContractReadiness = {
  ready: boolean;
  missingFields: string[];
  missingFieldLabels: Record<string, string>;
  dealId: string;
  contractId: string | null;
};

function filled(value: string | null | undefined) {
  return Boolean(value && String(value).trim());
}

export function assessContractReadiness(input: {
  dealId: string;
  contractId?: string | null;
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
}): ContractReadiness {
  const missingFields: string[] = [];
  if (!filled(input.profile?.legalName)) missingFields.push("organization.legalName");
  if (!filled(input.profile?.bin) && !filled(input.profile?.iin)) missingFields.push("organization.bin");
  if (!filled(input.profile?.legalAddress)) missingFields.push("organization.legalAddress");
  if (!filled(input.profile?.directorName)) missingFields.push("organization.directorName");
  if (!input.company) {
    missingFields.push("customer.company");
  } else {
    if (!filled(input.company.legalName) && !filled(input.company.name)) {
      missingFields.push("customer.legalName");
    }
    if (!filled(input.company.bin) && !filled(input.company.iin)) {
      missingFields.push("customer.bin");
    }
    if (!filled(input.company.legalAddress) && !filled(input.company.address)) {
      missingFields.push("customer.legalAddress");
    }
  }
  if (input.itemCount < 1) missingFields.push("deal.items");

  const missingFieldLabels = Object.fromEntries(
    missingFields.map((code) => [code, CONTRACT_FIELD_LABELS[code] || code]),
  );
  return {
    ready: missingFields.length === 0,
    missingFields,
    missingFieldLabels,
    dealId: input.dealId,
    contractId: input.contractId || null,
  };
}

export function missingFieldsError(readiness: ContractReadiness) {
  const labels = readiness.missingFields.map((code) => readiness.missingFieldLabels[code] || code);
  return new ApiError(
    422,
    "missing_fields",
    labels.length ? `Не хватает данных для договора: ${labels.join(", ")}` : "Не хватает данных для договора",
    undefined,
    {
      ready: false,
      missingFields: readiness.missingFields,
      missingFieldLabels: readiness.missingFieldLabels,
    },
  );
}

export async function getContractReadiness(prisma: PrismaClient, auth: AuthContext, dealId: string) {
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
        where: { status: { in: ["DRAFT", "READY_TO_SIGN", "PENDING_SIGNATURE", "PARTIALLY_SIGNED"] } },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true },
      },
    },
  });
  if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");
  const profile = await prisma.tenantLegalProfile.findUnique({
    where: { tenantId: tid },
    select: { legalName: true, bin: true, iin: true, legalAddress: true, directorName: true },
  });
  return assessContractReadiness({
    dealId,
    contractId: deal.contracts[0]?.id || null,
    itemCount: deal.items.length,
    profile,
    company: deal.company,
  });
}
