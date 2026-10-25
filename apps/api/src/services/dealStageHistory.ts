import type { Prisma } from "@creolab/db";

/** Call after updating/locking the deal, in the same transaction. */
export async function recordDealStageTransition(tx: Prisma.TransactionClient, data: {
  tenantId: string;
  dealId: string;
  fromStageId: string;
  fromSystemKey: string;
  toStageId: string;
  toSystemKey: string;
  enteredAt: Date;
  changedByType: string;
  changedById?: string | null;
  note?: string | null;
}) {
  await closeDealStageInterval(tx, data.tenantId, data.dealId, data.enteredAt);
  return tx.dealStageHistory.create({ data });
}

export async function closeDealStageInterval(tx: Prisma.TransactionClient, tenantId: string, dealId: string, at: Date) {
  await tx.dealStageHistory.updateMany({
    where: { tenantId, dealId, leftAt: null },
    data: { leftAt: at },
  });
}
