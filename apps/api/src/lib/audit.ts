import type { Prisma, PrismaClient } from "@creolab/db";

const SECRET_KEYS = /secret|password|token|key|encrypted|credential|pem|nca/i;

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (!value || typeof value !== "object") return value;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.test(key)) {
      next[key] = item ? "[redacted]" : null;
      continue;
    }
    next[key] = scrub(item);
  }
  return next;
}

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
      changesJson: (scrub(input.changes || {}) || {}) as Prisma.InputJsonValue,
      correlationId: input.correlationId || null,
    },
  });
}
