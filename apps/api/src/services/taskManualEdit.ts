import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@creolab/db";
import { assertTaskDeliveryEditable } from "./taskDeliveryState.ts";
import { ApiError } from "../errors.ts";

const object = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Prisma.JsonObject : {};

/** Tasks have no version column. Keep a change token in their existing metadata,
 * including same-value saves; merge under the row lock to preserve other keys. */
export async function updateTaskManually(db: PrismaClient | Prisma.TransactionClient, tenantId: string, id: string, data: Prisma.TaskUncheckedUpdateInput) {
  const update = async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const current = await tx.task.findUniqueOrThrow({ where: { id, tenantId } });
    if ((current.status === "done" && data.status === "canceled") || (current.status === "canceled" && data.status === "done")) {
      throw new ApiError(409, "invalid_state", "Состояние задачи уже изменилось. Обновите список задач.");
    }
    const contentChange = ["messageDraft", "description", "contactId", "inquiryId", "conversationId", "dealId"].some(key => key in data);
    await assertTaskDeliveryEditable(tx, tenantId, id, contentChange);
    return tx.task.update({ where: { id, tenantId }, data: { ...data,
      contextSnapshotJson: { ...object(current.contextSnapshotJson), ...object(data.contextSnapshotJson), manualEditId: randomUUID() },
    } });
  };
  return "$transaction" in db ? db.$transaction(update) : update(db);
}
