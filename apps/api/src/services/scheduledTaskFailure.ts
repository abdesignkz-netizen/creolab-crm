import type { Prisma, PrismaClient } from "@creolab/db";
import { createStaffNotification } from "./notificationService.ts";

export function notifyScheduledTaskFailure(
  prisma: PrismaClient | Prisma.TransactionClient,
  action: { id: string; tenantId: string },
  task: { id: string; title: string; ownerMembershipId: string | null },
) {
  return createStaffNotification(prisma, {
    tenantId: action.tenantId, membershipId: task.ownerMembershipId,
    type: "task.send_failed", entityType: "task", entityId: task.id,
    title: "Запланированная отправка требует проверки",
    body: `${task.title}. Откройте задачу и проверьте результат в диалоге перед повторной отправкой.`,
    priority: "high", episodeKey: `task.send_failed:${action.id}`, channels: ["in_app"],
  });
}
