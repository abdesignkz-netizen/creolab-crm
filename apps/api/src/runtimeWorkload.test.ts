import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createPrismaClient } from "@creolab/db";
import { assertTestDatabase } from "./testSupport/testDatabase.ts";
import { authForUserInTenant } from "./services/authService.ts";
import { getBusinessHomeFocus } from "./services/businessHomeService.ts";
import { runOutboxLane } from "./services/outboxScheduling.ts";
import { claimOutboxEvent } from "./services/outboxLease.ts";

assertTestDatabase();
let db: Awaited<ReturnType<typeof createPrismaClient>>;
before(async () => { db = await createPrismaClient(); });
after(async () => db.$disconnect());
async function company(name: string) {
  const tenant = await db.tenant.create({ data: { name, slug: randomUUID(), settingsJson: { control: { enabled: true } } } });
  const user = await db.user.create({ data: { name: "Acceptance owner", email: `${randomUUID()}@example.test`, passwordHash: "unused" } });
  await db.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: "owner" } });
  return { tenant, user, auth: await authForUserInTenant(db, user.id, tenant.id) };
}

it("small and large company home reads keep old pending work, bounds and tenant scope", async t => {
  const now = new Date(), observed: object[] = [];
  for (const count of [10, 2000]) {
    const f = await company(`Profile ${count}`);
    const waitingId = randomUUID();
    await db.actionRun.create({ data: { id: waitingId, tenantId: f.tenant.id, userId: f.user.id,
      initiatorMembershipId: f.auth.activeMembership!.id, title: `Waiting ${count}`, requestId: randomUUID(), requestHash: "fixture",
      snapshotJson: {}, createdAt: new Date(now.getTime() - 86400000), expiresAt: new Date(now.getTime() + 3600000) } });
    for (let offset = 0; offset < count; offset += 250) {
      await db.actionRun.createMany({ data: Array.from({ length: Math.min(250, count - offset) }, (_, i) => ({
        tenantId: f.tenant.id, userId: f.user.id, initiatorMembershipId: f.auth.activeMembership!.id,
        title: `History ${count} ${offset + i}`, requestId: randomUUID(), requestHash: "fixture", snapshotJson: {},
        status: "succeeded", finishedAt: now, expiresAt: new Date(now.getTime() + 3600000),
      })) });
    }
    const timings: number[] = [];
    for (let n = 0; n < 10; n++) {
      const start = performance.now(), result = await getBusinessHomeFocus(db, f.auth, now);
      timings.push(performance.now() - start);
      assert.equal(result.actions.status, "ready");
      assert.deepEqual(result.actions.items.map(row => row.id), [waitingId]);
      assert.equal(result.actions.recent.length, 2);
      assert.ok(result.actions.recent.every(row => row.title.startsWith(`History ${count} `)));
      assert.ok(result.goals.items.length <= 3); assert.ok(result.insights.items.length <= 2);
      assert.ok(Buffer.byteLength(JSON.stringify(result)) < 10_000);
    }
    timings.sort((a, b) => a - b);
    observed.push({ records: count + 1, reads: timings.length, p50Ms: Math.round(timings[4]), p95Ms: Math.round(timings[9]) });
  }
  // Measurements are diagnostics, not a production SLA or model latency claim.
  t.diagnostic(`home_workload ${JSON.stringify(observed)}`);
});

it("overlapping polls enforce batch and reply concurrency limits across two tenants", async () => {
  const first = await company("Queue first"), second = await company("Queue second");
  const ids = new Set<string>();
  const events = Array.from({ length: 80 }, (_, n) => {
    const id = randomUUID(); ids.add(id);
    return { id, tenantId: n % 2 ? first.tenant.id : second.tenant.id,
      type: "channel.ai_reply", entityType: "conversation", entityId: randomUUID(), payloadJson: {} };
  });
  await db.outboxEvent.createMany({ data: events });
  let active = 0, peak = 0;
  const seen = new Set<string>();
  const handle = async (candidate: Parameters<Parameters<typeof runOutboxLane>[2]>[0]) => {
    active++; peak = Math.max(peak, active);
    try {
      const lease = await claimOutboxEvent(db, candidate.id);
      assert.ok(lease); assert.ok(ids.has(candidate.id)); assert.equal(seen.has(candidate.id), false);
      seen.add(candidate.id);
      await lease.finish({ processedAt: new Date(), attempts: { increment: 1 } });
      return true;
    } finally { active--; }
  };
  assert.equal(await runOutboxLane(db, "reply", handle), 20);
  for (let n = 0; n < 10 && seen.size < ids.size; n++) {
    await Promise.all(Array.from({ length: 8 }, () => runOutboxLane(db, "reply", handle)));
  }
  assert.ok(peak <= 2); assert.equal(seen.size, ids.size);
  for (const tenantId of [first.tenant.id, second.tenant.id]) {
    assert.equal(await db.outboxEvent.count({ where: { tenantId, processedAt: { not: null }, attempts: 1 } }), 40);
    assert.equal(await db.message.count({ where: { tenantId } }), 0);
  }
});
