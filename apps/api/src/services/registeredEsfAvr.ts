import type { PrismaClient } from "@creolab/db";

/** A local signature or rejected portal act is not an act sent to IS ESF. */
export function findRegisteredEsfAvr(prisma: PrismaClient, tenantId: string, dealId: string) {
  return prisma.electronicDocument.findFirst({
    where: {
      tenantId, dealId, type: "AVR", externalSystem: "ESF_AWP",
      externalId: { not: null }, status: { in: ["SENT", "ACCEPTED"] },
    },
    orderBy: { createdAt: "desc" },
  });
}
