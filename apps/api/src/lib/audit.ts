import { presentAudit, AUDIT_ACTION_LABELS, AUDIT_ENTITY_LABELS } from "./auditPresentation.ts";
import type { Prisma, PrismaClient } from "@creolab/db";
import { redactSensitive } from "./redact.ts";
import { requireCompanyAdmin, requireTenant } from "./access.ts";
import type { AuthContext } from "./types.ts";

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
  const redacted = redactSensitive(input.changes || {}) ?? {};
  const changesJson = JSON.parse(JSON.stringify(redacted)) as Prisma.InputJsonValue;
  await prisma.auditEvent.create({
    data: {
      tenantId: input.tenantId || null,
      actorUserId: input.actorUserId || null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId || null,
      changesJson,
      correlationId: input.correlationId || null,
    },
  });
}

export async function listTenantAudit(
  prisma: PrismaClient,
  auth: AuthContext,
  query: Record<string, string | undefined> = {},
) {
  requireCompanyAdmin(auth, "Журнал действий доступен администратору и директору");
  const membership = requireTenant(auth);
  const page = Math.max(1, Number(query.page || 1));
  const take = Math.min(100, Math.max(10, Number(query.limit || 50)));
  const where: Prisma.AuditEventWhereInput = { tenantId: membership.tenantId };
  if (query.q) {
    where.OR = [
      { action: { contains: String(query.q), mode: "insensitive" } },
      { entityType: { contains: String(query.q), mode: "insensitive" } },
      { action: { in: Object.entries(AUDIT_ACTION_LABELS).filter(([, label]) => label.toLocaleLowerCase("ru").includes(String(query.q).toLocaleLowerCase("ru"))).map(([code]) => code) } },
      { entityType: { in: Object.entries(AUDIT_ENTITY_LABELS).filter(([, label]) => label.toLocaleLowerCase("ru").includes(String(query.q).toLocaleLowerCase("ru"))).map(([code]) => code) } },
    ];
  }
  const [total, items] = await Promise.all([
    prisma.auditEvent.count({ where }),
    prisma.auditEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * take,
      take,
    }),
  ]);
  const actorIds = [...new Set(items.map((item) => item.actorUserId).filter(Boolean))] as string[];
  const actors = actorIds.length
    ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, email: true } })
    : [];
  const actorMap = new Map(actors.map((item) => [item.id, item]));
  return {
    page,
    pageSize: take,
    total,
    items: items.map((item) => ({
      id: item.id,
      action: item.action,
      ...presentAudit(item, membership.tenant.timezone || "Asia/Almaty"),
      entityType: item.entityType,
      entityId: item.entityId,
      createdAt: item.createdAt,
      actor: item.actorUserId ? actorMap.get(item.actorUserId) || null : null,
      actorLabel: item.actorUserId
        ? actorMap.get(item.actorUserId)?.name || actorMap.get(item.actorUserId)?.email || "сотрудник"
        : "система",
      changes: item.changesJson,
    })),
  };
}
