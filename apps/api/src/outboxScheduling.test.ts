import assert from "node:assert/strict";
import { it } from "node:test";
import type { PrismaClient } from "@creolab/db";
import { runOutboxLane } from "./services/outboxScheduling.ts";

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(types: Array<{ id: string; type: string; entityId?: string; integrationId?: string }>) {
  const events = types.map(item => ({ ...item, tenantId: "test-company", entityType: "conversation", entityId: item.entityId || item.id,
    payloadJson: { integrationId: item.integrationId }, attempts: 0, availableAt: new Date(0), processedAt: null as Date | null }));
  let reads = 0;
  const prisma = { outboxEvent: { findMany: async ({ where, take }: any) => {
    reads++;
    return events.filter(event => !event.processedAt && (where.type.in ? where.type.in.includes(event.type) : !where.type.notIn.includes(event.type))).slice(0, take);
  } } } as unknown as PrismaClient;
  return { prisma, events, reads: () => reads };
}

it("a blocked background job does not delay replies or delivery", async () => {
  const { prisma, events } = fixture([{ id: "slow", type: "inquiry.automation" }, { id: "reply", type: "channel.ai_reply" }, { id: "delivery", type: "channel.send" }]);
  const blocked = gate(), entered = gate();
  const work = runOutboxLane(prisma, "background", async () => { entered.resolve(); await blocked.promise; return true; });
  try {
    await entered.promise;
    const handled: string[] = [];
    const fast = async (event: typeof events[number]) => { handled.push(event.id); return true; };
    assert.equal(await runOutboxLane(prisma, "reply", fast), 1);
    assert.equal(await runOutboxLane(prisma, "delivery", fast), 1);
    assert.deepEqual(handled, ["reply", "delivery"]);
  } finally { blocked.resolve(); await work; }
});

it("overlapping polls share the reply concurrency limit and continue after it clears", async () => {
  const f = fixture(Array.from({ length: 6 }, (_, index) => ({ id: `reply-${index}`, type: "whatsapp.ai_reply" })));
  const blocked = gate(), twoStarted = gate(); let active = 0, peak = 0, calls = 0;
  const handle = async (event: typeof f.events[number]) => {
    calls++; active++; peak = Math.max(peak, active); if (calls === 2) twoStarted.resolve();
    await blocked.promise; active--; event.processedAt = new Date(); return true;
  };
  const first = runOutboxLane(f.prisma, "reply", handle);
  try {
    await twoStarted.promise;
    const reads = f.reads();
    assert.deepEqual(await Promise.all(Array.from({ length: 8 }, () => runOutboxLane(f.prisma, "reply", handle))), Array(8).fill(0));
    assert.equal(f.reads(), reads, "A saturated pool should not poll the database again");
    assert.equal(calls, 2);
  } finally { blocked.resolve(); await first; }
  assert.equal(calls, 6); assert.equal(peak, 2);
  assert.equal(await runOutboxLane(f.prisma, "reply", handle), 0);
});

it("keeps one conversation serialized while another customer proceeds", async () => {
  const f = fixture([{ id: "first", type: "channel.ai_reply", entityId: "customer-a" }, { id: "newer", type: "channel.ai_reply", entityId: "customer-a" }, { id: "other", type: "channel.ai_reply", entityId: "customer-b" }]);
  const blocked = gate(), otherDone = gate(); const calls: string[] = [];
  const work = runOutboxLane(f.prisma, "reply", async event => {
    calls.push(event.id);
    if (event.id === "first") await blocked.promise;
    event.processedAt = new Date(); if (event.id === "other") otherDone.resolve(); return true;
  });
  try { await otherDone.promise; assert.deepEqual(calls, ["first", "other"]); }
  finally { blocked.resolve(); await work; }
  assert.equal(f.events[1].processedAt, null);
  assert.equal(await runOutboxLane(f.prisma, "reply", async event => { calls.push(event.id); return true; }), 1);
  assert.deepEqual(calls, ["first", "other", "newer"]);
});

it("sends through one connection in order without blocking another connection", async () => {
  const f = fixture([{ id: "first", type: "channel.send", integrationId: "channel-a" }, { id: "second", type: "channel.send", integrationId: "channel-a" }, { id: "other", type: "whatsapp.cloud_send", integrationId: "channel-b" }]);
  const blocked = gate(), otherDone = gate(); const calls: string[] = [];
  const work = runOutboxLane(f.prisma, "delivery", async event => {
    calls.push(event.id); if (event.id === "first") await blocked.promise;
    event.processedAt = new Date(); if (event.id === "other") otherDone.resolve(); return true;
  });
  try { await otherDone.promise; assert.deepEqual(calls, ["first", "other"]); }
  finally { blocked.resolve(); await work; }
  await runOutboxLane(f.prisma, "delivery", async event => { calls.push(event.id); return true; });
  assert.deepEqual(calls, ["first", "other", "second"]);
});

it("releases pool slots after database/handler failure", async () => {
  const f = fixture([{ id: "retry", type: "channel.ai_reply" }]);
  await assert.rejects(() => runOutboxLane(f.prisma, "reply", async () => { throw new Error("Database is unavailable"); }), /Database is unavailable/);
  assert.equal(await runOutboxLane(f.prisma, "reply", async () => true), 1);
});
