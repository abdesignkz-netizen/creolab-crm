import type { Prisma, PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";

type Db = PrismaClient | Prisma.TransactionClient;
export type TaskDeliveryPart = {
  id: string; fileName?: string; state: "pending" | "sending" | "accepted" | "failed" | "unknown";
  attempt: number; error?: string | null; providerMessageId?: string | null;
  reconciledBy?: string; reconciledAt?: string; reconciliationNote?: string;
};
export type TaskDelivery = {
  version: 1; confirmationId: string; contentHash: string; conversationId: string; sellerLeadId: string;
  claim: string | null; leaseUntil: string | null; parts: TaskDeliveryPart[];
};
export const taskDeliveryKey = (tenantId: string, taskId: string) => ({ scope: "task.delivery", actorKey: tenantId, key: taskId });
export const TASK_DELIVERY_CHECK = "Отправка не подтверждена. Проверьте переписку с клиентом. Повторная отправка заблокирована, чтобы не отправить дубликат.";
export const taskDeliveryUnknown = (delivery: TaskDelivery) => delivery.parts.some(p => p.state === "sending" || p.state === "unknown");
export const taskDeliveryBusy = (delivery: TaskDelivery) => Boolean(delivery.claim && delivery.leaseUntil && new Date(delivery.leaseUntil).getTime() > Date.now());

export async function readTaskDelivery(db: Db, tenantId: string, taskId: string): Promise<TaskDelivery | null> {
  const row = await db.idempotencyRecord.findUnique({ where: { scope_actorKey_key: taskDeliveryKey(tenantId, taskId) } });
  return row ? row.resultJson as unknown as TaskDelivery : null;
}

export async function saveTaskDelivery(db: Db, tenantId: string, taskId: string, delivery: TaskDelivery) {
  const key = taskDeliveryKey(tenantId, taskId);
  const data = { requestHash: delivery.contentHash, resultJson: delivery as unknown as Prisma.InputJsonValue,
    // Never expire an ambiguous outcome: deleting it could permit a duplicate send.
    expiresAt: new Date("9999-01-01T00:00:00Z") };
  await db.idempotencyRecord.upsert({ where: { scope_actorKey_key: key }, create: { ...key, ...data }, update: data });
}

/** Call under the Task row lock, before any edit or attachment mutation. */
export async function assertTaskDeliveryEditable(db: Db, tenantId: string, taskId: string, contentChange = true) {
  const batch = await db.idempotencyRecord.findFirst({ where: { scope: "task.batch.delivery", actorKey: tenantId, key: taskId, expiresAt: { gt: new Date() } } });
  if (batch) throw new ApiError(409, "task_sending", "Отправка уже выполняется. Дождитесь результата.");
  const delivery = await readTaskDelivery(db, tenantId, taskId);
  if (!delivery) {
    const task = await db.task.findFirst({ where: { id: taskId, tenantId }, select: { executionStatus: true, targetType: true } });
    if (task && task.targetType !== "group" && ["sending", "partial", "unknown", "failed", "sent"].includes(task.executionStatus)) {
      throw new ApiError(409, "task_delivery_unknown", TASK_DELIVERY_CHECK);
    }
    return;
  }
  if (taskDeliveryBusy(delivery)) throw new ApiError(409, "task_sending", "Отправка уже выполняется. Дождитесь результата.");
  if (taskDeliveryUnknown(delivery)) throw new ApiError(409, "task_delivery_unknown", TASK_DELIVERY_CHECK);
  if (contentChange && delivery.parts.some(p => p.state === "accepted")) {
    throw new ApiError(409, "task_delivery_started", "Часть отправки уже выполнена. Повторите только неотправленные файлы. Для нового сообщения создайте отдельную задачу.");
  }
}

export function taskDeliveryResult(delivery: TaskDelivery) {
  const text = delivery.parts.find(p => p.id === "text")!;
  const visibleState = (part: TaskDeliveryPart) => part.state === "sending" && !taskDeliveryBusy(delivery) ? "unknown" : part.state;
  const files = delivery.parts.filter(p => p.id !== "text").map(p => ({ id: p.id, fileName: p.fileName || "Файл",
    ok: p.state === "accepted", state: visibleState(p), error: p.error || undefined,
    reconciled: Boolean(p.reconciledBy) }));
  const needsCheck = taskDeliveryUnknown(delivery);
  const textOk = text.state === "accepted";
  const allFilesSent = files.every(p => p.ok);
  const success = textOk && allFilesSent;
  const partial = !success && delivery.parts.some(p => p.state === "accepted");
  return { success, partial, textOk, textReconciled: Boolean(text.reconciledBy), textState: visibleState(text),
    textError: text.error || null, files, allFilesSent, needsCheck,
    retryFilesAvailable: !taskDeliveryBusy(delivery) && !needsCheck && textOk && !allFilesSent,
    status: success ? "done" : needsCheck ? "unknown" : partial ? "partial" : "failed",
    note: needsCheck ? TASK_DELIVERY_CHECK : partial
      ? "Текст отправлен. Не все файлы отправлены: повтор коснётся только оставшихся файлов."
      : success ? null : "Отправка не выполнена. Исправьте причину ошибки и повторите попытку." };
}
