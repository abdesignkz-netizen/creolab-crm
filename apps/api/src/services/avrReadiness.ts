import { resolveAvrLinks } from "./avrContractBasis.ts";
import { documentOrganization } from "./documentOrganization.ts";
import type { PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { requireDocumentsAccess } from "../lib/access.ts";
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
  warnings: string[];
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
  const contractId = input.contractId || input.signedContractId;
  const warnings = input.signedContractId ? [] : [contractId
    ? "Договор не подписан. Это не препятствует формированию, проверке и отправке АВР и ЭСФ."
    : "Договор не загружен. АВР и ЭСФ можно сформировать из данных сделки."];
  if (contractId && !filled(input.contractNumber)) missingFields.push("contract.number");
  if (contractId && !input.contractDate) missingFields.push("contract.date");

  const missingFieldLabels = Object.fromEntries(
    missingFields.map((code) => [code, AVR_FIELD_LABELS[code] || code]),
  );
  return {
    ready: missingFields.length === 0,
    warnings,
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
      warnings: readiness.warnings,
    },
  );
}

export async function getAvrReadiness(prisma: PrismaClient, auth: AuthContext, dealId: string) {
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
      items: { select: { id: true } },
      contracts: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true, number: true, date: true, status: true },
      },
      electronicDocuments: {
        where: { type: "AVR", status: { in: ["DRAFT", "VALIDATED"] } },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true, contractId: true, invoiceId: true, sourceDataJson: true },
      },
    },
  });
  if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");
  const { contract, invoice, basis } = await resolveAvrLinks(prisma, tid, dealId, deal.electronicDocuments[0] || {});
  const profile = await documentOrganization(prisma, tid, dealId, contract?.id);
  const source=deal.electronicDocuments[0]?.sourceDataJson as {editorVersion?:number;items?:unknown[]}|undefined;
  return assessAvrReadiness({
    dealId,
    contractId: contract?.id || null,
    documentId: deal.electronicDocuments[0]?.id || null,
    signedContractId: contract?.status === "SIGNED" ? contract.id : null,
    invoiceId: invoice?.id || null,
    contractNumber: basis?.number || null,
    contractDate: basis?.date || null,
    itemCount: source?.editorVersion===1 ? source.items?.length||0 : deal.items.length,
    profile,
    company: deal.company,
  });
}
