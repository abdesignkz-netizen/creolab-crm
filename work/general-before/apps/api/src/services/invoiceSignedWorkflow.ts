import type { PrismaClient } from "@creolab/db";
import { createOrReuseInvoiceDraft } from "./documentDraftService.ts";
import { isDocumentsEnabled } from "./legalProfileService.ts";

export async function ensureInvoiceDraftForSignedContract(
  prisma: PrismaClient,
  input: {
    tenantId: string;
    dealId: string;
    contractId: string;
    actorUserId?: string | null;
  },
) {
  const enabled = await isDocumentsEnabled(prisma, input.tenantId);
  if (!enabled) return null;

  const contract = await prisma.contract.findFirst({
    where: { id: input.contractId, tenantId: input.tenantId, dealId: input.dealId, status: "SIGNED" },
    select: { id: true },
  });
  if (!contract) return null;

  try {
    return await createOrReuseInvoiceDraft(prisma, {
      tenantId: input.tenantId,
      dealId: input.dealId,
      contractId: contract.id,
      actorUserId: input.actorUserId || null,
    });
  } catch (error) {
    console.error("invoice draft after signed contract", error);
    return null;
  }
}

export async function processContractSignedEvent(
  prisma: PrismaClient,
  event: { tenantId: string; payloadJson: unknown },
) {
  const payload = (event.payloadJson || {}) as { contractId?: string; dealId?: string };
  if (!payload.contractId || !payload.dealId) return;
  await ensureInvoiceDraftForSignedContract(prisma, {
    tenantId: event.tenantId,
    dealId: payload.dealId,
    contractId: payload.contractId,
  });
}
