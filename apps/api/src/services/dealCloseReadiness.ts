import type { PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { isOfficialInvoiceAccepted } from "./esfStatusSyncService.ts";

export const DEAL_CLOSE_FIELD_LABELS: Record<string, string> = {
  "esf.sent": "ЭСФ, отправленный в ИС ЭСФ",
  "esf.accepted": "ЭСФ доставлен в ИС ЭСФ (DELIVERED)",
};

export function assessDealCloseReadiness(input: {
  dealId: string;
  outcome?: string | null;
  esfExternalId?: string | null;
  esfStatus?: string | null;
  esfExternalStatus?: string | null;
}) {
  const missingFields: string[] = [];
  if (input.outcome === "won") {
    return {
      ready: true,
      alreadyClosed: true,
      missingFields,
      missingFieldLabels: {},
      dealId: input.dealId,
    };
  }
  if (!input.esfExternalId) missingFields.push("esf.sent");
  const accepted = input.esfStatus === "ACCEPTED" || isOfficialInvoiceAccepted(input.esfExternalStatus || "");
  if (input.esfExternalId && !accepted) missingFields.push("esf.accepted");
  return {
    ready: missingFields.length === 0,
    alreadyClosed: false,
    missingFields,
    missingFieldLabels: Object.fromEntries(missingFields.map((code) => [code, DEAL_CLOSE_FIELD_LABELS[code] || code])),
    dealId: input.dealId,
    esfExternalId: input.esfExternalId || null,
    esfExternalStatus: input.esfExternalStatus || null,
  };
}

export async function getDealCloseReadiness(prisma: PrismaClient, auth: AuthContext, dealId: string) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  const tid = auth.activeMembership.tenantId;
  const deal = await prisma.deal.findFirst({
    where: { id: dealId, tenantId: tid },
    include: {
      electronicDocuments: {
        where: { type: "ESF" },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { externalId: true, status: true, externalStatus: true },
      },
    },
  });
  if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");
  const esf = deal.electronicDocuments[0] || null;
  return assessDealCloseReadiness({
    dealId,
    outcome: deal.outcome,
    esfExternalId: esf?.externalId || null,
    esfStatus: esf?.status || null,
    esfExternalStatus: esf?.externalStatus || null,
  });
}
