import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { encryptSecret, encryptionKeyVersion } from "./lib/secretBox.ts";
import type { AuthContext } from "./lib/types.ts";
import { calendarEffects, calendarRecordKey, calendarSourceHash, CALENDAR_LEASE_SCOPE, hasCalendarConnection } from "./services/calendarSyncState.ts";
import { googleAgreementEventId, syncGoogleCalendar } from "./services/googleCalendarSyncService.ts";
import { completeTaskWithResult } from "./services/taskExecutionService.ts";

describe("Company calendar reconciliation", () => {
  let db: Awaited<ReturnType<typeof createPrismaClient>>;
  const nativeFetch = globalThis.fetch;
  const events = new Map<string, unknown>();
  let requests: Array<{ path: string; method: string; body: unknown }> = [];
  let intercept: ((path: string, init?: RequestInit) => Promise<Response | null>) | undefined;
  const reply = (status = 200) => new Response(status === 204 ? null : "{}", { status });
  before(async () => {
    db = await createPrismaClient();
    globalThis.fetch = async (url, init) => {
      const u = new URL(String(url));
      assert.equal(u.origin, "https://www.googleapis.com", "Real providers are disabled");
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ path: u.pathname, method: init?.method || "GET", body });
      const intercepted = await intercept?.(u.pathname, init);
      if (intercepted) return intercepted;
      if (init?.method === "PATCH") {
        if (!events.has(u.pathname)) return reply(404);
        events.set(u.pathname, body); return reply();
      }
      if (init?.method === "POST") {
        const key = `${u.pathname}/${body.id}`;
        if (events.has(key)) return reply(409);
        events.set(key, body); return reply();
      }
      if (init?.method === "DELETE") { events.delete(u.pathname); return reply(204); }
      throw new Error("Unexpected Google request");
    };
  });
  after(async () => { globalThis.fetch = nativeFetch; await db.$disconnect(); });
  async function fixture() {
    intercept = undefined; requests = [];
    const tenant = await db.tenant.create({ data: { name: "Calendar test", slug: randomUUID(), timezone: "Asia/Almaty" } });
    const credential = await db.credential.create({ data: { tenantId: tenant.id, kind: "google_calendar", scope: "tenant", keyVersion: encryptionKeyVersion(),
      encryptedValue: encryptSecret(JSON.stringify({ access_token: "test-calendar-token", expiresAt: Date.now() + 3_600_000 })) } });
    const integration = await db.integration.create({ data: { tenantId: tenant.id, type: "calendar", publicKey: `google:calendar:${tenant.id}`, name: "Calendar",
      status: "active", credentialId: credential.id, schemaJson: { resourceId: "primary" } } });
    const agreement = await db.agreement.create({ data: { tenantId: tenant.id, type: "ONLINE_MEETING", status: "CONFIRMED", title: "Обсудить проект",
      scheduledAt: new Date(Date.now() + 86_400_000) } });
    const key = calendarRecordKey(tenant.id, integration.id, agreement.id);
    const eventPath = `/calendar/v3/calendars/primary/events/${googleAgreementEventId(tenant.id, agreement.id)}`;
    const sync = () => syncGoogleCalendar(db, integration);
    const effect = async () => (await calendarEffects(db, tenant.id, [agreement.id]))[0];
    const record = async () => (await db.idempotencyRecord.findUniqueOrThrow({ where: { scope_actorKey_key: key } })).resultJson as { state: string; sourceHash: string; checkedAt: string };
    const cursor = async () => (await db.integration.findUniqueOrThrow({ where: { id: integration.id } })).schemaJson as { lastSyncAt?: string };
    return { tenant, credential, integration, agreement, key, eventPath, sync, effect, record, cursor };
  }
  it("recognizes actual company OAuth connections and isolates tenants", async () => {
    const f = await fixture(), other = await db.tenant.create({ data: { name: "Other", slug: randomUUID() } });
    assert.equal(await hasCalendarConnection(db, f.tenant.id), true);
    assert.equal(await hasCalendarConnection(db, other.id), false);
    assert.deepEqual(await calendarEffects(db, other.id, [f.agreement.id]), []);
    assert.equal((await f.effect()).state, "pending");
    await f.sync(); assert.equal((await f.effect()).state, "synced");
    assert.equal((await f.record()).sourceHash, calendarSourceHash(f.agreement));
    assert.ok(!(JSON.stringify(await f.effect())).includes("test-calendar-token"));
  });
  it("keeps one deterministic event through retries and reschedules", async () => {
    const f = await fixture(); await f.sync(); await f.sync();
    assert.equal(requests.filter(r => r.method === "POST").length, 1);
    await db.agreement.update({ where: { id: f.agreement.id }, data: { title: "Перенесённая встреча", scheduledAt: new Date(Date.now() + 172_800_000) } });
    assert.equal((await f.effect()).state, "pending"); await f.sync();
    assert.equal((events.get(f.eventPath) as { summary: string }).summary, "Перенесённая встреча");
    assert.equal(requests.filter(r => r.method === "POST").length, 1);
  });
  it("deletes canceled events while retaining completed and missed meetings", async () => {
    const f = await fixture(); await f.sync();
    for (const status of ["COMPLETED", "MISSED"]) {
      await db.agreement.update({ where: { id: f.agreement.id }, data: { status } });
      await f.sync(); assert.ok(events.has(f.eventPath)); assert.equal((await f.effect()).state, "synced");
    }
    await db.agreement.update({ where: { id: f.agreement.id }, data: { status: "CANCELLED" } });
    assert.equal((await f.effect()).state, "removal_pending"); await f.sync();
    assert.ok(!events.has(f.eventPath)); assert.equal((await f.effect()).state, "removed");
    assert.equal(requests.filter(r => r.method === "DELETE").length, 1);
  });
  for (const status of [404, 410]) it(`accepts an already absent event (${status}) as removed`, async () => {
    const f = await fixture(); await db.agreement.update({ where: { id: f.agreement.id }, data: { status: "CANCELLED" } });
    intercept = async () => reply(status); await f.sync(); assert.equal((await f.effect()).state, "removed");
  });
  it("does not advance the cursor after HTTP failure and retries the same event", async () => {
    const f = await fixture(); intercept = async () => new Response("provider-secret", { status: 503 });
    await assert.rejects(f.sync(), { code: "calendar_sync_failed" });
    assert.equal((await f.effect()).state, "error"); assert.equal((await f.cursor()).lastSyncAt, undefined);
    assert.ok(!JSON.stringify(await f.record()).includes("provider-secret"));
    intercept = undefined; await f.sync(); assert.equal((await f.effect()).state, "synced");
  });
  it("keeps an ambiguous timeout unconfirmed until retry succeeds", async () => {
    const f = await fixture(); intercept = async () => { throw new Error("private timeout detail"); };
    await assert.rejects(f.sync(), { code: "google_unavailable" }); assert.equal((await f.effect()).state, "uncertain");
    assert.equal((await f.cursor()).lastSyncAt, undefined);
    intercept = undefined; await f.sync(); assert.equal((await f.effect()).state, "synced");
  });
  it("updates the same deterministic ID after an insert conflict", async () => {
    const f = await fixture(); let patches = 0;
    intercept = async (path, init) => {
      if (init?.method === "PATCH" && patches++ === 0) return reply(404);
      if (init?.method === "POST") { events.set(f.eventPath, {}); return reply(409); }
      return null;
    };
    await f.sync(); assert.equal(patches, 2); assert.equal((await f.effect()).state, "synced");
  });
  it("does not mark a concurrent edit as synced with an older response", async () => {
    const f = await fixture(); let changed = false;
    intercept = async () => {
      if (!changed) { changed = true; await db.agreement.update({ where: { id: f.agreement.id }, data: { title: "Новые условия" } }); }
      return null;
    };
    await f.sync(); assert.equal((await f.effect()).state, "pending");
    intercept = undefined; await f.sync(); assert.equal((await f.effect()).state, "synced");
    assert.equal((events.get(f.eventPath) as { summary: string }).summary, "Новые условия");
  });
  it("claims calendar sync in the database so a second worker does no duplicate work", async () => {
    const f = await fixture(); let entered!: () => void, resume!: () => void;
    const waiting = new Promise<void>(r => { entered = r; }); const gate = new Promise<void>(r => { resume = r; });
    let first = true; intercept = async () => { if (first) { first = false; entered(); await gate; } return null; };
    const firstSync = f.sync(); await waiting;
    try { assert.deepEqual(await f.sync(), { running: true }); assert.equal((await f.effect()).state, "syncing"); }
    finally { resume(); }
    await firstSync; assert.equal((await f.effect()).state, "synced");
    assert.equal(requests.filter(r => r.method === "POST").length, 1);
  });
  it("a lost lease cannot overwrite the successor's result or cursor", async () => {
    const f = await fixture(); let entered!: () => void, resume!: () => void;
    const waiting = new Promise<void>(r => { entered = r; }); const gate = new Promise<void>(r => { resume = r; });
    let first = true; intercept = async () => { if (first) { first = false; entered(); await gate; return reply(404); } return null; };
    const firstSync = f.sync(); const rejected = assert.rejects(firstSync, { code: "calendar_connection_changed" }); await waiting;
    try {
      await db.idempotencyRecord.updateMany({ where: { scope: CALENDAR_LEASE_SCOPE, actorKey: f.tenant.id }, data: { expiresAt: new Date(0) } });
      await db.agreement.update({ where: { id: f.agreement.id }, data: { title: "Актуальная встреча" } });
      await f.sync();
    } finally { resume(); }
    await rejected; assert.equal((await f.effect()).state, "synced");
    assert.equal((events.get(f.eventPath) as { summary: string }).summary, "Актуальная встреча");
    assert.equal(requests.filter(r => r.method === "POST").length, 1);
  });
  for (const change of ["disconnect", "reauthorize"]) it(`does not publish success when a connection changes in flight: ${change}`, async () => {
    const f = await fixture(); intercept = async () => {
      await db.integration.update({ where: { id: f.integration.id }, data: change === "disconnect" ? { status: "disabled", credentialId: null } : { credentialId: null } });
      return reply();
    };
    await assert.rejects(f.sync(), { code: "calendar_connection_changed" });
    assert.equal((await f.record()).state, "uncertain"); assert.equal((await f.cursor()).lastSyncAt, undefined);
    assert.equal((await f.effect()).state, "disconnected"); assert.equal(requests.length, 1);
  });
  it("shows interrupted and pre-ledger synchronization honestly", async () => {
    const f = await fixture();
    await db.integration.update({ where: { id: f.integration.id }, data: { schemaJson: { resourceId: "primary", lastSyncAt: new Date().toISOString() } } });
    assert.equal((await f.effect()).state, "unverified");
    await f.sync(); assert.equal((await f.effect()).state, "synced", "backfill a pre-ledger connection even with an old cursor");
    await db.idempotencyRecord.delete({ where: { scope_actorKey_key: f.key } });
    await db.idempotencyRecord.create({ data: { ...f.key, requestHash: randomUUID(), expiresAt: new Date("9999-12-31"), resultJson: {
      state: "syncing", sourceHash: calendarSourceHash(f.agreement), checkedAt: new Date(Date.now() - 180_000).toISOString() } } });
    assert.equal((await f.effect()).state, "uncertain");
  });
  it("retains a per-event record when the OAuth connection is removed", async () => {
    const f = await fixture(); await f.sync(); await db.integration.delete({ where: { id: f.integration.id } });
    assert.equal((await f.effect()).state, "disconnected");
    assert.ok(events.has(f.eventPath), "disconnect does not recall an exported event");
  });
  it("completes only the company's agreement, preserves canceled state, and never calls a global calendar", async () => {
    const f = await fixture();
    const user = await db.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "unused", name: "Owner" } });
    const member = await db.membership.create({ data: { tenantId: f.tenant.id, userId: user.id, role: "owner" }, include: { tenant: true } });
    const auth = { user, activeMembership: member, memberships: [member] } as AuthContext;
    const oldToken = process.env.GOOGLE_CALENDAR_ACCESS_TOKEN, oldId = process.env.GOOGLE_CALENDAR_ID;
    process.env.GOOGLE_CALENDAR_ACCESS_TOKEN = "global-token-must-not-be-used"; process.env.GOOGLE_CALENDAR_ID = "another-company";
    try {
      const other = await db.tenant.create({ data: { name: "Foreign", slug: randomUUID() } });
      const foreign = await db.agreement.create({ data: { tenantId: other.id, type: "CALL", title: "Foreign", status: "CONFIRMED" } });
      const canceled = await db.agreement.create({ data: { tenantId: f.tenant.id, type: "CALL", title: "Canceled", status: "CANCELLED" } });
      for (const [agreement, expected] of [[f.agreement, "COMPLETED"], [foreign, "CONFIRMED"], [canceled, "CANCELLED"]] as const) {
        const task = await db.task.create({ data: { tenantId: f.tenant.id, title: "Созвон", type: "meeting", agreementId: agreement.id, ownerMembershipId: member.id } });
        await completeTaskWithResult(db, auth, task.id, { resultCode: "completed", skipNext: true });
        assert.equal((await db.agreement.findUniqueOrThrow({ where: { id: agreement.id } })).status, expected);
      }
      assert.equal(requests.length, 0);
    } finally {
      if (oldToken === undefined) delete process.env.GOOGLE_CALENDAR_ACCESS_TOKEN; else process.env.GOOGLE_CALENDAR_ACCESS_TOKEN = oldToken;
      if (oldId === undefined) delete process.env.GOOGLE_CALENDAR_ID; else process.env.GOOGLE_CALENDAR_ID = oldId;
    }
  });
});
