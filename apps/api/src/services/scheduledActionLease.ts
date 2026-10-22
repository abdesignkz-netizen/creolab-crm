import { Prisma, type PrismaClient } from "@creolab/db";
import { logServerError } from "../lib/redact.ts";
import { notifyScheduledTaskFailure } from "./scheduledTaskFailure.ts";

const LEASE_MS = 90_000;
type Action = { id: string; version: number; payloadJson: unknown };

function payloadObject(value: unknown): Prisma.JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Prisma.JsonObject : {};
}

// The due date is the customer's requested time, not the worker's start time.
// Keep the renewable claim separate so an overdue job is not started twice.
export async function claimScheduledAction(prisma: PrismaClient, action: Action) {
  const version = action.version + 1;
  let payload = { ...payloadObject(action.payloadJson), _leaseUntil: Date.now() + LEASE_MS };
  const claimed = await prisma.scheduledAction.updateMany({
    where: { id: action.id, version: action.version, state: "scheduled", dueAt: { lte: new Date() } },
    data: { state: "running", version, payloadJson: payload },
  });
  if (!claimed.count) return null;
  let renewal: Promise<void> | null = null;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || renewal) return;
    renewal = (async () => {
      const next = { ...payload, _leaseUntil: Date.now() + LEASE_MS };
      const result = await prisma.scheduledAction.updateMany({
        where: { id: action.id, state: "running", version, payloadJson: { equals: payload } },
        data: { payloadJson: next },
      });
      if (result.count) payload = next;
      else { stopped = true; clearInterval(timer); }
    })().catch(error => logServerError(error, "background:scheduled lease")).finally(() => { renewal = null; });
  }, LEASE_MS / 3);
  timer.unref?.();
  return {
    async stop() { stopped = true; clearInterval(timer); await renewal; },
  };
}

export async function recoverInterruptedScheduledActions(prisma: PrismaClient, now = new Date()) {
  const running = await prisma.scheduledAction.findMany({
    where: { state: "running", OR: [
      { payloadJson: { path: ["_leaseUntil"], lte: now.getTime() } },
      // Jobs started before lease support cannot safely be replayed as sends.
      { payloadJson: { path: ["_leaseUntil"], equals: Prisma.AnyNull }, dueAt: { lte: new Date(now.getTime() - LEASE_MS) } },
    ] },
    orderBy: { dueAt: "asc" }, take: 50,
  });
  for (const item of running) {
    // Status reads and deduplicated reminders can be repeated. An interrupted
    // external send needs reconciliation; absence of a result is not a failure to send.
    const repeatable = item.type === "esf_status_poll" || item.type.startsWith("agreement_reminder");
    await prisma.$transaction(async tx => {
      const changed = await tx.scheduledAction.updateMany({
        where: { id: item.id, state: "running", version: item.version, payloadJson: { equals: item.payloadJson! } },
        data: { state: repeatable ? "scheduled" : "failed", version: { increment: 1 },
          cancelReason: repeatable ? null : "Выполнение прервалось. Проверьте результат отправки перед повтором." },
      });
      if (!changed.count || repeatable || !["task_run", "task_batch_run"].includes(item.type)) return;
      const tasks = await tx.task.updateMany({
        where: { id: item.parentId, tenantId: item.tenantId, status: { in: ["open", "waiting"] },
          OR: [{ executionStatus: { in: ["scheduled", "sending"] } }, { commandStatus: { in: ["scheduled", "executing"] } }] },
        data: { executionStatus: "failed", commandStatus: "failed" },
      });
      if (tasks.count) {
        const task = await tx.task.findFirst({ where: { id: item.parentId, tenantId: item.tenantId } });
        if (task) await notifyScheduledTaskFailure(tx, item, task);
      }
    });
  }
}
