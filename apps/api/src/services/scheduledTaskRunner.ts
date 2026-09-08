import type { PrismaClient } from "@creolab/db";
import type { AuthContext } from "../lib/types.ts";
import { executeTaskBatch } from "./aiCommandExecutionService.ts";
import { executeTask } from "./taskExecutionService.ts";

type ScheduledTaskAction = {
  id: string;
  tenantId: string;
  parentId: string;
  type: string;
  payloadJson?: unknown;
};

export async function authForScheduledTask(
  prisma: PrismaClient,
  tenantId: string,
  confirmedById?: string | null,
  ownerMembershipId?: string | null,
): Promise<AuthContext> {
  let membership =
    (confirmedById
      ? await prisma.membership.findFirst({
          where: { tenantId, userId: confirmedById, active: true },
          include: { user: true, tenant: true },
        })
      : null) ||
    (ownerMembershipId
      ? await prisma.membership.findFirst({
          where: { id: ownerMembershipId, tenantId, active: true },
          include: { user: true, tenant: true },
        })
      : null) ||
    (await prisma.membership.findFirst({
      where: { tenantId, active: true },
      include: { user: true, tenant: true },
      orderBy: { createdAt: "asc" },
    }));

  if (!membership) {
    throw new Error("Нет сотрудника для запланированной отправки");
  }

  const permissions = Array.isArray(membership.permissions) ? (membership.permissions as string[]) : [];
  const activeMembership = {
    id: membership.id,
    tenantId: membership.tenantId,
    role: membership.role as AuthContext["memberships"][number]["role"],
    permissions,
    active: membership.active,
    tenant: {
      id: membership.tenant.id,
      name: membership.tenant.name,
      slug: membership.tenant.slug,
      status: membership.tenant.status,
      timezone: membership.tenant.timezone,
      currency: membership.tenant.currency,
      defaultRegion: membership.tenant.defaultRegion,
    },
  };

  return {
    user: {
      id: membership.user.id,
      email: membership.user.email,
      name: membership.user.name,
      platformAdmin: membership.user.platformAdmin,
    },
    memberships: [activeMembership],
    activeMembership,
    sessionId: `scheduled-task:${membership.id}`,
    client: "web",
  };
}

export async function processScheduledTask(prisma: PrismaClient, action: ScheduledTaskAction) {
  const task = await prisma.task.findFirst({
    where: { id: action.parentId, tenantId: action.tenantId },
  });
  if (!task || task.status === "canceled" || task.status === "done") {
    await prisma.scheduledAction.update({
      where: { id: action.id },
      data: { state: "canceled", cancelReason: "task_inactive" },
    });
    return { skipped: true as const };
  }

  const payload = (action.payloadJson || {}) as { confirmedById?: string; batch?: boolean };
  const auth = await authForScheduledTask(
    prisma,
    action.tenantId,
    payload.confirmedById,
    task.ownerMembershipId,
  );

  try {
    const result =
      action.type === "task_batch_run"
        ? await executeTaskBatch(prisma, auth, task.id, { runScheduled: true })
        : await executeTask(prisma, auth, task.id, { runScheduled: true });
    await prisma.scheduledAction.update({
      where: { id: action.id },
      data: { state: "done" },
    });
    return result;
  } catch (error) {
    await prisma.scheduledAction.update({
      where: { id: action.id },
      data: { state: "failed", cancelReason: error instanceof Error ? error.message : "error" },
    });
    throw error;
  }
}
