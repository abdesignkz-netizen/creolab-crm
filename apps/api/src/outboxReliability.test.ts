import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, it, mock } from "node:test";
import { createPrismaClient, type PrismaClient } from "@creolab/db";
import type { AuthContext } from "./lib/types.ts";
import { ApiError } from "./errors.ts";
import { processOutbox } from "./services/backgroundJobs.ts";
import { claimOutboxEvent } from "./services/outboxLease.ts";
import { listOutboxFailures, retryOutboxFailure } from "./services/outboxDiagnosticsService.ts";
import { OUTBOX_MAX_ATTEMPTS } from "./services/outboxFailurePolicy.ts";

let db: Awaited<ReturnType<typeof createPrismaClient>>, auth: AuthContext, other: AuthContext;
const previousMailKey = process.env.RESEND_API_KEY;
async function owner() {
  const tenant = await db.tenant.create({ data: { name: "Queue fixture", slug: randomUUID() } });
  const user = await db.user.create({ data: { name: "Owner", email: `${randomUUID()}@example.test`, passwordHash: "unused" } });
  const membership = await db.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: "owner" }, include: { tenant: true } });
  return { user, activeMembership: membership, memberships: [membership] } as unknown as AuthContext;
}
before(async () => { db = await createPrismaClient(); auth = await owner(); other = await owner(); });
afterEach(async () => {
  mock.restoreAll();
  if (previousMailKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = previousMailKey;
  await db.outboxEvent.deleteMany();
});
after(async () => { await db.$disconnect(); });
async function event(patch: Record<string, any> = {}) {
  const tenantId = auth.activeMembership!.tenantId, entityId = randomUUID();
  return db.outboxEvent.create({ data: { tenantId, type: "inquiry.automation", entityType: "inquiry", entityId,
    payloadJson: { tenantId, inquiryId: entityId }, availableAt: new Date(0), ...patch } });
}
function failingConsumer(error: Error) {
  mock.method(console, "error", () => {});
  const handler = mock.fn(async () => { throw error; });
  return { handler, consumer: { outboxEvent: db.outboxEvent, inquiry: { findFirst: handler } } as unknown as PrismaClient };
}
const stored = (id: string) => db.outboxEvent.findUniqueOrThrow({ where: { id } });

it("unknown and malformed jobs are quarantined, never acknowledged as successful or polled again", async () => {
  mock.method(console, "error", () => {});
  const unknown = await event({ type: "unsupported.new_handler", payloadJson: { secret: "must-not-leak" } });
  const malformed = await event({ type: "whatsapp.cloud_send", payloadJson: {} });
  assert.equal(await processOutbox(db), 2);
  for (const [row, code] of [[unknown, "unknown_event_type"], [malformed, "invalid_payload"]] as const) {
    const failed = await stored(row.id);
    assert.equal(failed.processedAt, null); assert.ok(failed.failedAt); assert.equal(failed.failureKind, "permanent"); assert.equal(failed.errorCode, code);
    assert.ok(failed.availableAt > new Date("9999-01-01"), "legacy workers must also stop polling terminal jobs");
    assert.equal(await claimOutboxEvent(db, row.id), null);
  }
  assert.equal(await processOutbox(db), 0);
  assert.equal(await db.outboxEvent.count({ where: { processedAt: null, availableAt: { lte: new Date() } } }), 0);
  const diagnostics = await listOutboxFailures(db, auth);
  assert.equal(diagnostics.total, 2); assert.ok(diagnostics.items.every(row => !row.canRetry));
  assert.doesNotMatch(JSON.stringify(diagnostics), /must-not-leak|payloadJson|unsupported.new_handler/);
});

it("temporary failures stop after the retry budget and survive restart as a visible failure", async () => {
  const row = await event(), { consumer, handler } = failingConsumer(new Error("temporary database failure"));
  for (let i = 1; i <= OUTBOX_MAX_ATTEMPTS; i++) {
    await processOutbox(consumer);
    const current = await stored(row.id);
    assert.equal(current.attempts, i); assert.equal(current.retryAttempts, i); assert.equal(current.processedAt, null);
    if (i < OUTBOX_MAX_ATTEMPTS) {
      assert.equal(current.failedAt, null); assert.equal(current.failureKind, "retryable"); assert.ok(current.availableAt > new Date());
      assert.equal(await processOutbox(consumer), 0);
      await db.outboxEvent.update({ where: { id: row.id }, data: { availableAt: new Date(0) } });
    } else { assert.ok(current.failedAt); assert.equal(current.failureKind, "exhausted"); }
  }
  assert.equal(handler.mock.callCount(), OUTBOX_MAX_ATTEMPTS);
  assert.equal(await processOutbox(db), 0);
  assert.equal((await listOutboxFailures(db, auth)).items[0].canRetry, false, "inquiry AUTO may send a welcome; use its delivery review");
});

it("an old job over the retry budget cannot execute another handler", async () => {
  const row = await event({ attempts: 40, retryAttempts: 40 });
  const { consumer, handler } = failingConsumer(new Error("must not run"));
  await processOutbox(consumer);
  assert.equal(handler.mock.callCount(), 0); assert.equal((await stored(row.id)).failureKind, "exhausted");
});

it("validation/permission errors stop immediately without leaking exception contents", async () => {
  const row = await event(), { consumer } = failingConsumer(new ApiError(403, "secret_error", "private provider information"));
  await processOutbox(consumer);
  assert.equal((await stored(row.id)).failureKind, "permanent");
  assert.doesNotMatch(JSON.stringify(await listOutboxFailures(db, auth)), /secret_error|private provider/);
});

it("a timeout after external email submission is uncertain and cannot be replayed", async () => {
  process.env.RESEND_API_KEY = "fixture-only";
  mock.method(console, "error", () => {}); mock.method(console, "info", () => {});
  const fetcher = mock.method(globalThis, "fetch", async () => { throw new Error("timeout after submit"); });
  const row = await event({ type: "billing.email", payloadJson: { to: "nobody@example.test", subject: "Fixture", text: "Not sent" } });
  await processOutbox(db);
  assert.equal(fetcher.mock.callCount(), 1);
  const failed = await stored(row.id); assert.equal(failed.failureKind, "uncertain"); assert.equal(failed.processedAt, null);
  assert.equal(await processOutbox(db), 0);
  await assert.rejects(retryOutboxFailure(db, auth, row.id, { requestId: randomUUID(), confirmed: true, failedAt: failed.failedAt!.toISOString() }), /Повтор недоступен/);
  assert.equal(fetcher.mock.callCount(), 1);
});

it("confirmed internal retry is tenant-scoped, idempotent, preserves attempts and records an audit", async () => {
  const failedAt = new Date(), row = await event({ type: "sales.reconcile", attempts: 8, retryAttempts: 8, failedAt, failureKind: "exhausted", errorCode: "handler_failed" });
  const input = { requestId: randomUUID(), confirmed: true, failedAt: failedAt.toISOString() };
  await assert.rejects(retryOutboxFailure(db, other, row.id, input), (e: any) => e.status === 404);
  assert.equal((await listOutboxFailures(db, other)).total, 0);
  const manager = { ...auth, activeMembership: { ...auth.activeMembership!, role: "manager" } } as AuthContext;
  await assert.rejects(listOutboxFailures(db, manager), (e: any) => e.status === 403);
  await assert.rejects(retryOutboxFailure(db, manager, row.id, input), (e: any) => e.status === 403);
  await assert.rejects(retryOutboxFailure(db, auth, row.id, { ...input, confirmed: false }));
  const results = await Promise.all([retryOutboxFailure(db, auth, row.id, input), retryOutboxFailure(db, auth, row.id, input)]);
  assert.equal(results.filter(r => !r.reused).length, 1);
  const queued = await stored(row.id);
  assert.equal(queued.failedAt, null); assert.equal(queued.retryAttempts, 0); assert.equal(queued.attempts, 8);
  assert.equal(await db.auditEvent.count({ where: { entityId: row.id, action: "outbox.retry", actorUserId: auth.user.id } }), 1);
  await assert.rejects(retryOutboxFailure(db, auth, row.id, { ...input, requestId: randomUUID() }), /Повтор недоступен/);
  await processOutbox(db); assert.ok((await stored(row.id)).processedAt);
  assert.equal((await retryOutboxFailure(db, auth, row.id, input)).reused, true);
  assert.equal((await stored(row.id)).attempts, 9);
});

it("one confirmation key cannot reset two different jobs, including concurrent requests", async () => {
  const failedAt = new Date(), data = { type: "sales.reconcile", attempts: 8, retryAttempts: 8, failedAt, failureKind: "exhausted" };
  const first = await event(data), second = await event(data);
  const input = { requestId: randomUUID(), confirmed: true, failedAt: failedAt.toISOString() };
  const results = await Promise.allSettled([retryOutboxFailure(db, auth, first.id, input), retryOutboxFailure(db, auth, second.id, input)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const rejected = results.find(r => r.status === "rejected") as PromiseRejectedResult;
  assert.equal(rejected.reason.code, "idempotency_conflict"); assert.equal(rejected.reason.status, 409);
  assert.equal(await db.outboxEvent.count({ where: { id: { in: [first.id, second.id] }, failedAt: null } }), 1);
  assert.equal(await db.auditEvent.count({ where: { action: "outbox.retry", entityId: { in: [first.id, second.id] } } }), 1);
});

it("an expired confirmation and a revoked admin cannot reset a new failure", async () => {
  const failedAt = new Date(), row = await event({ type: "sales.reconcile", failedAt, retryAttempts: 8, failureKind: "exhausted" });
  const input = { requestId: randomUUID(), confirmed: true, failedAt: new Date(failedAt.getTime() - 1).toISOString() };
  await assert.rejects(retryOutboxFailure(db, auth, row.id, input), /Повтор недоступен/);
  await db.membership.update({ where: { id: auth.activeMembership!.id }, data: { role: "manager" } });
  try { await assert.rejects(retryOutboxFailure(db, auth, row.id, { ...input, failedAt: failedAt.toISOString() }), (e: any) => e.status === 403); }
  finally { await db.membership.update({ where: { id: auth.activeMembership!.id }, data: { role: "owner" } }); }
});
