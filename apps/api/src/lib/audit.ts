import type { Prisma, PrismaClient } from "@creolab/db";
import { redactSensitive } from "./redact.ts";

export async function writeAudit(
  prisma: PrismaClient | Prisma.TransactionClient,
  input: {
    tenantId?: string | null;
    actorUserId?: string | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    changes?: unknown;
    correlationId?: string | null;
  },
) {
  await prisma.auditEvent.create({
    data: {
      tenantId: input.tenantId || null,
      actorUserId: input.actorUserId || null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId || null,
      changesJson: (redactSensitive(input.changes || {}) || {}) as Prisma.InputJsonValue,
      correlationId: input.correlationId || null,
    },
  });
}
