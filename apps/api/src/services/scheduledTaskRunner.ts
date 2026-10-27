import type { PrismaClient } from "@creolab/db";
import type { AuthContext } from "../lib/types.ts";
import { ApiError } from "../errors.ts";
import { logServerError } from "../lib/redact.ts";
import { notifyScheduledTaskFailure } from "./scheduledTaskFailure.ts";
import { executeTaskBatch } from "./aiCommandExecutionService.ts";
import { readTaskDelivery } from "./taskDeliveryState.ts";
import {
  executeTask,
  SCHEDULED_TASK_ACTION_TYPES,
  SENDABLE_TYPES,
} from "./taskExecutionService.ts";

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
): Promise<AuthContext> {
  const membership =
    confirmedById
      ? await prisma.membership.findFirst({
          where: { tenantId, userId: confirmedById, active: true },
          include: { user: true, tenant: true },
        })
      : null;

  if (!membership) {
    throw new ApiError(409, "confirmation_required", "Сотрудник, подтвердивший отправку, больше не имеет доступа. Подтвердите отправку заново.");
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
  const tenant = await prisma.tenant.findUnique({ where: { id: action.tenantId }, select: { status: true } });
  if (!tenant || tenant.status !== "active") {
    await prisma.scheduledAction.update({
      where: { id: action.id },
      data: { state: "canceled", cancelReason: "tenant_suspended" },
    });
    return { skipped: true as const, reason: "tenant_suspended" };
  }

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

  if (action.type !== "task_batch_run" && !SENDABLE_TYPES.has(task.type)) {
    await prisma.scheduledAction.update({
      where: { id: action.id },
      data: { state: "canceled", cancelReason: "not_sendable" },
    });
    if (task.executionStatus === "scheduled" || task.commandStatus === "scheduled") {
      await prisma.task.update({
        where: { id: task.id },
        data: { executionStatus: "none", commandStatus: "none" },
      });
    }
    return { skipped: true as const };
  }

  try {
    const taskIds = action.type === "task_batch_run"
      ? (await prisma.task.findMany({
        where: { tenantId: action.tenantId, parentTaskId: task.id, status: { in: ["open", "waiting"] } },
        select: { id: true },
      })).map(child => child.id) : [task.id];
    const payload = (action.payloadJson || {}) as { confirmedById?: string };
    let confirmedById: string | null | undefined = payload.confirmedById;
    for (const taskId of taskIds) {
      const confirmation = await prisma.executionConfirmation.findFirst({
        where: { tenantId: action.tenantId, taskId, voidedAt: null },
        orderBy: { confirmedAt: "desc" },
      });
      if (!confirmation || (confirmedById && confirmation.confirmedById !== confirmedById)) {
        throw new ApiError(409, "confirmation_required", "Подтверждение отправки отсутствует или изменилось. Проверьте получателей и текст, затем подтвердите заново.");
      }
      confirmedById = confirmation.confirmedById;
    }
    const auth = await authForScheduledTask(prisma, action.tenantId, confirmedById);

    const result =
      action.type === "task_batch_run"
        ? await executeTaskBatch(prisma, auth, task.id, { runScheduled: true })
        : await executeTask(prisma, auth, task.id, { runScheduled: true });
    const succeeded = "failed" in result ? result.failed === 0 : result.success;
    await prisma.scheduledAction.update({
      where: { id: action.id },
      data: { state: succeeded ? "done" : "failed",
        cancelReason: succeeded ? null : "Отправка не завершена. Проверьте результат в задаче перед повтором." },
    });
    if (!succeeded) await notifyScheduledTaskFailure(prisma, action, task)
      .catch(error => logServerError(error, "background:task failure notice"));
    return result;
  } catch (error) {
    await prisma.scheduledAction.update({
      where: { id: action.id },
      data: { state: "failed", cancelReason: error instanceof Error ? error.message : "error" },
    });
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${task.id} AND "tenantId" = ${action.tenantId} FOR UPDATE`;
      const current = await tx.task.findFirst({ where: { id: task.id, tenantId: action.tenantId } });
      const preflightRejected = error instanceof ApiError && ["confirmation_required", "not_confirmed", "stale_confirmation", "feature_required", "limit_exceeded", "forbidden"].includes(error.code);
      const definitelyNotStarted = preflightRejected && current && ["none", "prepared", "confirmed", "scheduled"].includes(current.executionStatus)
        && !(await readTaskDelivery(tx, action.tenantId, task.id));
      await tx.task.updateMany({
        where: { id: task.id, tenantId: action.tenantId, status: { in: ["open", "waiting", "in_progress"] }, executionStatus: { notIn: ["sending", "unknown", "partial", "sent"] } },
        // Rejected before dispatch: ask for a new explicit confirmation. Do not
        // turn a known unsent draft into an unrecoverable legacy unknown send.
        data: definitelyNotStarted ? { executionStatus: "prepared", commandStatus: "needs_confirmation" }
          : { executionStatus: "failed", commandStatus: "failed" },
      });
    });
    await notifyScheduledTaskFailure(prisma, action, task)
      .catch(noticeError => logServerError(noticeError, "background:task failure notice"));
    throw error;
  }
}

export async function recoverDueScheduledTaskSends(prisma: PrismaClient, now = new Date()) {
  // Repair only a missing queue entry. Failed/interrupted sends are never
  // blindly retried: the provider may already have accepted the message.
  const dueTasks = await prisma.task.findMany({
    where: {
      status: { in: ["open", "waiting"] },
      dueAt: { lte: now },
      type: { in: [...SENDABLE_TYPES] },
      parentTaskId: null,
      OR: [{ executionStatus: "scheduled" }, { commandStatus: "scheduled" }],
    },
    orderBy: { dueAt: "asc" },
    take: 30,
  });
  for (const candidate of dueTasks) {
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Task" WHERE "id" = ${candidate.id} AND "tenantId" = ${candidate.tenantId} FOR UPDATE`;
      const task = await tx.task.findFirst({ where: { id: candidate.id, status: { in: ["open", "waiting"] },
        dueAt: { lte: now }, OR: [{ executionStatus: "scheduled" }, { commandStatus: "scheduled" }] } });
      if (!task) return;
      const pending = await tx.scheduledAction.findFirst({
        where: {
          tenantId: task.tenantId,
          parentType: "task",
          parentId: task.id,
          state: { in: ["scheduled", "running"] },
          type: { in: [...SCHEDULED_TASK_ACTION_TYPES] },
        },
      });
      if (pending) return;
      const previous = await tx.scheduledAction.findFirst({
        where: {
          tenantId: task.tenantId,
          parentType: "task",
          parentId: task.id,
          type: { in: [...SCHEDULED_TASK_ACTION_TYPES] },
        },
      });
      if (previous) {
        await tx.task.update({ where: { id: task.id }, data: { executionStatus: "failed", commandStatus: "failed" } });
        return;
      }
      await tx.scheduledAction.create({
        data: {
          tenantId: task.tenantId,
          type: task.targetType === "group" ? "task_batch_run" : "task_run",
          parentType: "task",
          parentId: task.id,
          dueAt: task.dueAt || now,
          state: "scheduled",
          payloadJson: { taskId: task.id, recovered: true },
        },
      });
    });
  }
}
