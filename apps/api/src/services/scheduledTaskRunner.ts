import type { PrismaClient } from "@creolab/db";
import type { AuthContext } from "../lib/types.ts";
import { executeTaskBatch } from "./aiCommandExecutionService.ts";
import {
  confirmTaskExecution,
  executeTask,
  prepareTaskExecution,
  SCHEDULED_TASK_ACTION_TYPES,
  SENDABLE_TYPES,
} from "./taskExecutionService.ts";

const STUCK_RUNNING_MS = 90_000;
const MAX_FAILED_RETRIES = 8;

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

  const payload = (action.payloadJson || {}) as { confirmedById?: string; batch?: boolean };
  const auth = await authForScheduledTask(
    prisma,
    action.tenantId,
    payload.confirmedById,
    task.ownerMembershipId,
  );

  try {
    if (action.type === "task_batch_run") {
      const children = await prisma.task.findMany({
        where: { tenantId: action.tenantId, parentTaskId: task.id, status: { in: ["open", "waiting"] } },
        select: { id: true },
      });
      for (const child of children) {
        const childConfirm = await prisma.executionConfirmation.findFirst({
          where: { tenantId: action.tenantId, taskId: child.id, voidedAt: null },
        });
        if (!childConfirm) {
          await prepareTaskExecution(prisma, auth, child.id);
          await confirmTaskExecution(prisma, auth, child.id);
        }
      }
    } else {
      const confirmation = await prisma.executionConfirmation.findFirst({
        where: { tenantId: action.tenantId, taskId: task.id, voidedAt: null },
      });
      if (!confirmation) {
        await prepareTaskExecution(prisma, auth, task.id);
        await confirmTaskExecution(prisma, auth, task.id);
      }
    }

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
    await prisma.task.updateMany({
      where: { id: task.id, tenantId: action.tenantId, status: { in: ["open", "waiting"] } },
      data: { executionStatus: "failed", commandStatus: "failed" },
    });
    throw error;
  }
}

export async function recoverDueScheduledTaskSends(prisma: PrismaClient, now = new Date()) {
  const stuckBefore = new Date(now.getTime() - STUCK_RUNNING_MS);
  await prisma.scheduledAction.updateMany({
    where: {
      state: "running",
      type: { in: [...SCHEDULED_TASK_ACTION_TYPES] },
      dueAt: { lte: stuckBefore },
    },
    data: { state: "scheduled", cancelReason: null },
  });

  const failed = await prisma.scheduledAction.findMany({
    where: {
      state: "failed",
      type: { in: [...SCHEDULED_TASK_ACTION_TYPES] },
      dueAt: { lte: now },
    },
    take: 20,
  });
  for (const item of failed) {
    const payload = (item.payloadJson || {}) as { attempts?: number };
    const attempts = Number(payload.attempts || 0);
    const task = await prisma.task.findFirst({
      where: { id: item.parentId, tenantId: item.tenantId, status: { in: ["open", "waiting"] } },
    });
    if (!task || task.sentAt || task.executionStatus === "sent") continue;
    if (attempts >= MAX_FAILED_RETRIES) {
      if (task.executionStatus === "scheduled" || task.commandStatus === "scheduled") {
        await prisma.task.update({
          where: { id: task.id },
          data: { executionStatus: "failed", commandStatus: "failed" },
        });
      }
      continue;
    }
    await prisma.scheduledAction.update({
      where: { id: item.id },
      data: {
        state: "scheduled",
        cancelReason: null,
        payloadJson: { ...payload, attempts: attempts + 1 },
      },
    });
  }

  const dueTasks = await prisma.task.findMany({
    where: {
      status: { in: ["open", "waiting"] },
      dueAt: { lte: now },
      type: { in: [...SENDABLE_TYPES] },
      OR: [{ executionStatus: "scheduled" }, { commandStatus: "scheduled" }],
    },
    take: 30,
  });
  for (const task of dueTasks) {
    const pending = await prisma.scheduledAction.findFirst({
      where: {
        tenantId: task.tenantId,
        parentType: "task",
        parentId: task.id,
        state: { in: ["scheduled", "running"] },
        type: { in: [...SCHEDULED_TASK_ACTION_TYPES] },
      },
    });
    if (pending) continue;
    const lastFailed = await prisma.scheduledAction.findFirst({
      where: {
        tenantId: task.tenantId,
        parentType: "task",
        parentId: task.id,
        type: { in: [...SCHEDULED_TASK_ACTION_TYPES] },
        state: "failed",
      },
      orderBy: { id: "desc" },
    });
    const attempts = Number((lastFailed?.payloadJson as { attempts?: number } | undefined)?.attempts || 0);
    if (lastFailed && attempts >= MAX_FAILED_RETRIES) {
      if (task.executionStatus === "scheduled" || task.commandStatus === "scheduled") {
        await prisma.task.update({
          where: { id: task.id },
          data: { executionStatus: "failed", commandStatus: "failed" },
        });
      }
      continue;
    }
    await prisma.scheduledAction.create({
      data: {
        tenantId: task.tenantId,
        type: task.targetType === "group" ? "task_batch_run" : "task_run",
        parentType: "task",
        parentId: task.id,
        dueAt: task.dueAt || now,
        state: "scheduled",
        payloadJson: { taskId: task.id, recovered: true, attempts },
      },
    });
  }
}
