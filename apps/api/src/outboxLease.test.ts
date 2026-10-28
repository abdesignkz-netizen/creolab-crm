import assert from "node:assert/strict";
import { after, afterEach, before, it, mock } from "node:test";
import { createPrismaClient, type PrismaClient } from "@creolab/db";
import { claimOutboxEvent } from "./services/outboxLease.ts";
import { processOutbox } from "./services/backgroundJobs.ts";
import { enqueueInquiryAutomation } from "./services/inquiryAutomationQueue.ts";
import { assertTestDatabase } from "./testSupport/testDatabase.ts";

let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
let tenantId: string;
before(async () => {
  assertTestDatabase();
  prisma = await createPrismaClient();
  await (await import("../../../packages/db/src/seed.ts")).seedDatabase();
  tenantId = (await prisma.tenant.findFirstOrThrow({ where: { slug: "creolab" } })).id;
});
afterEach(async () => {
  mock.restoreAll();
  await prisma.outboxEvent.deleteMany({ where: { tenantId } });
});
after(async () => { await prisma?.$disconnect(); });
async function event(payloadJson = {}) {
  return prisma.outboxEvent.create({ data: {
    tenantId, type: "inquiry.automation", entityType: "inquiry", entityId: "synthetic-inquiry",
    payloadJson, availableAt: new Date(Date.now() - 1000),
  } });
}

it("only one consumer acquires a due event and a completed event cannot be acquired", async () => {
  const row = await event();
  const claims = await Promise.all(Array.from({ length: 8 }, () => claimOutboxEvent(prisma, row.id)));
  const leases = claims.filter(lease => lease !== null);
  try {
    assert.equal(leases.length, 1);
    assert.equal(await claimOutboxEvent(prisma, row.id), null);
    assert.equal((await leases[0].finish({ processedAt: new Date(), attempts: { increment: 1 } })).count, 1);
    assert.equal(await claimOutboxEvent(prisma, row.id), null);
    assert.equal((await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } })).attempts, 1);
  } finally { for (const lease of leases) await lease.finish({}); }
});

it("recovers an expired claim and prevents its previous owner from acknowledging the event", async () => {
  const row = await event();
  const old = await claimOutboxEvent(prisma, row.id);
  assert.ok(old);
  let current: Awaited<ReturnType<typeof claimOutboxEvent>> = null;
  try {
    // Simulate a worker that stopped longer than the lease interval.
    await prisma.outboxEvent.update({ where: { id: row.id }, data: { availableAt: new Date(Date.now() - 1000) } });
    current = await claimOutboxEvent(prisma, row.id);
    assert.ok(current);
    assert.equal((await old.finish({ processedAt: new Date() })).count, 0);
    assert.equal((await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } })).processedAt, null);
    assert.equal((await current.finish({ processedAt: new Date() })).count, 1);
  } finally { await old.finish({}); await current?.finish({}); }
});

it("renews a slow job's claim while it is running", async () => {
  const row = await event();
  let heartbeat: (() => void) | undefined;
  const interval = mock.method(globalThis, "setInterval", (callback: () => void) => {
    heartbeat = callback;
    return { unref() {} } as any;
  });
  const lease = await claimOutboxEvent(prisma, row.id);
  interval.mock.restore();
  assert.ok(lease);
  try {
    const initial = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } });
    const clock = mock.method(Date, "now", () => initial.availableAt.getTime() - 30_000);
    heartbeat!();
    // finish waits for any in-flight renewal, including its database write.
    await lease.finish({ attempts: { increment: 1 } });
    clock.mock.restore();
    const renewed = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(renewed.availableAt.getTime(), initial.availableAt.getTime() + 30_000);
    assert.equal(renewed.attempts, 1);
    assert.equal(await claimOutboxEvent(prisma, row.id), null);
  } finally { await lease.finish({}); }
});

it("overlapping API and worker polls invoke an event handler only once", async () => {
  await prisma.outboxEvent.deleteMany({ where: { tenantId } });
  const row = await event({ tenantId, inquiryId: "synthetic-inquiry" });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const handler = mock.fn(async () => { entered(); await blocked; return null; });
  const consumer = { outboxEvent: prisma.outboxEvent, inquiry: { findFirst: handler } } as unknown as PrismaClient;
  const first = processOutbox(consumer);
  try {
    await started;
    assert.equal(handler.mock.callCount(), 1);
    assert.equal(await processOutbox(consumer), 0);
    release();
    assert.equal(await first, 1);
    const done = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } });
    assert.ok(done.processedAt);
    assert.equal(done.attempts, 1);
    assert.equal(handler.mock.callCount(), 1);
  } finally { release(); await first; }
});

it("an immediate inquiry handler and the background poll share the same claim", async () => {
  await prisma.outboxEvent.deleteMany({ where: { tenantId } });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const handler = mock.fn(async () => { entered(); await blocked; return null; });
  const consumer = { outboxEvent: prisma.outboxEvent, inquiry: { findFirst: handler } } as unknown as PrismaClient;
  const immediate = enqueueInquiryAutomation(consumer, tenantId, "synthetic-inquiry", { inline: true });
  try {
    await started;
    assert.equal(await processOutbox(consumer), 0);
    release();
    await immediate;
    const done = await prisma.outboxEvent.findFirstOrThrow({ where: { tenantId } });
    assert.ok(done.processedAt);
    assert.equal(done.attempts, 1);
    assert.equal(handler.mock.callCount(), 1);
  } finally { release(); await immediate; }
});

it("a failed immediate inquiry remains queued for retry", async () => {
  const handler = mock.fn(async () => { throw new Error("synthetic transient failure"); });
  const consumer = { outboxEvent: prisma.outboxEvent, inquiry: { findFirst: handler } } as unknown as PrismaClient;
  mock.method(console, "error", () => {});
  await enqueueInquiryAutomation(consumer, tenantId, "synthetic-inquiry", { inline: true });
  const pending = await prisma.outboxEvent.findFirstOrThrow({ where: { tenantId } });
  assert.equal(pending.processedAt, null);
  assert.equal(pending.attempts, 1);
  assert.ok(pending.availableAt.getTime() > Date.now());
  assert.equal(await processOutbox(consumer), 0);
});
