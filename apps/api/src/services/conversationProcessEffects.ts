import type { Prisma } from "@creolab/db";
import type { CrmProcessQueue } from "@creolab/contracts";
import { calendarEffects } from "./calendarSyncState.ts";

/** One bounded set of reads for the whole review history. Undo never trusts this snapshot. */
export async function loadProcessEffects(db: Prisma.TransactionClient, tenantId: string, agreementIds: string[], outboxIds: string[]) {
  const [reminders, events, calendar] = await Promise.all([
    agreementIds.length ? db.scheduledAction.groupBy({ by: ["parentId", "state"], where: { tenantId, parentType: "agreement", parentId: { in: agreementIds } }, _count: true }) : [],
    outboxIds.length ? db.outboxEvent.findMany({ where: { tenantId, id: { in: outboxIds } }, select: { id: true, processedAt: true, attempts: true, payloadJson: true } }) : [],
    calendarEffects(db, tenantId, agreementIds),
  ]);
  return { reminders, events, calendar };
}
export type ProcessEffects = Awaited<ReturnType<typeof loadProcessEffects>>;

/** Queue processing is not proof of delivery to an external channel. */
export function processQueues(effects: ProcessEffects, agreementIds: string[], outboxIds: string[]) {
  const reminders = effects.reminders.filter(r => r.parentId && agreementIds.includes(r.parentId));
  const events = effects.events.filter(e => outboxIds.includes(e.id));
  const empty = (kind: CrmProcessQueue["kind"]): CrmProcessQueue => ({ kind, queued: 0, running: 0, processed: 0, canceled: 0, needsCheck: 0 });
  const reminderQueue = empty("reminders"), actions = empty("actions");
  for (const row of reminders) {
    const key = row.state === "scheduled" ? "queued" : row.state === "running" ? "running" : row.state === "done" ? "processed" : row.state === "canceled" ? "canceled" : "needsCheck";
    reminderQueue[key] += row._count;
  }
  for (const row of events) {
    const canceled = row.payloadJson && typeof row.payloadJson === "object" && !Array.isArray(row.payloadJson) && row.payloadJson.canceledByCrmReview;
    actions[canceled ? "canceled" : row.processedAt ? "processed" : row.attempts ? "needsCheck" : "queued"]++;
  }
  actions.needsCheck += outboxIds.length - events.length;
  return [...(reminders.length ? [reminderQueue] : []), ...(outboxIds.length ? [actions] : [])];
}
