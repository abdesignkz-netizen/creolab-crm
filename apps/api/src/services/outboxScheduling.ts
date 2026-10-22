import type { Prisma, PrismaClient } from "@creolab/db";

type OutboxEvent = Prisma.OutboxEventGetPayload<Record<string, never>>;

export type OutboxLane = "reply" | "delivery" | "background";
export const OUTBOX_FAST_POLL_MS = 1000;
const replyTypes = ["whatsapp.ai_reply", "channel.ai_reply"];
const deliveryTypes = ["whatsapp.cloud_send", "channel.send"];
const fastTypes = [...replyTypes, ...deliveryTypes];
const capacity: Record<OutboxLane, number> = { reply: 2, delivery: 2, background: 1 };
type LaneState = { workers: number; keys: Set<string> };
const active = new WeakMap<PrismaClient, Record<OutboxLane, LaneState>>();

function stateFor(prisma: PrismaClient, lane: OutboxLane) {
  let state = active.get(prisma);
  if (!state) {
    state = { reply: { workers: 0, keys: new Set() }, delivery: { workers: 0, keys: new Set() }, background: { workers: 0, keys: new Set() } };
    active.set(prisma, state);
  }
  return state[lane];
}

function eventLane(type: string): OutboxLane {
  return replyTypes.includes(type) ? "reply" : deliveryTypes.includes(type) ? "delivery" : "background";
}
function serialKey(event: OutboxEvent, lane: OutboxLane) {
  const integrationId = (event.payloadJson as { integrationId?: unknown } | null)?.integrationId;
  // Keep replies for one conversation and sends through one connection ordered.
  // Durable DB claims still protect each event across separate API/worker processes.
  return `${event.tenantId}:${lane === "delivery" ? typeof integrationId === "string" ? integrationId : "delivery" : event.entityId}`;
}

/** Separate bounded pools prevent slow analytics or model calls from holding up delivery. */
export async function runOutboxLane(prisma: PrismaClient, lane: OutboxLane, handle: (event: OutboxEvent) => Promise<boolean>) {
  const state = stateFor(prisma, lane);
  if (state.workers >= capacity[lane]) return 0;
  const due = await prisma.outboxEvent.findMany({
    where: { processedAt: null, availableAt: { lte: new Date() }, type: lane === "background" ? { notIn: fastTypes } : { in: lane === "reply" ? replyTypes : deliveryTypes } },
    orderBy: [{ availableAt: "asc" }, { id: "asc" }], take: 20,
  });
  let cursor = 0, processed = 0;
  const consume = async () => {
    state.workers++;
    try {
      while (cursor < due.length) {
        const event = due[cursor++];
        if (eventLane(event.type) !== lane) continue;
        const key = serialKey(event, lane);
        if (state.keys.has(key)) continue; // Remains durable and is picked up on a later poll.
        state.keys.add(key);
        try { if (await handle(event)) processed++; }
        finally { state.keys.delete(key); }
      }
    } finally { state.workers--; }
  };
  // Recheck after the query: another poll may have occupied slots in the meantime.
  const jobs: Promise<void>[] = [];
  const slots = Math.min(due.length, capacity[lane] - state.workers);
  for (let i = 0; i < slots; i++) jobs.push(consume());
  // Do not reject this poll while sibling workers are still handling their events.
  const settled = await Promise.allSettled(jobs);
  const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
  return processed;
}
