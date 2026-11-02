import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fork, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { PrismaClient } from "@prisma/client";
import { applyLivePostgresPatches } from "../../../packages/db/src/client.ts";
import { assertTestDatabase } from "./testSupport/testDatabase.ts";
import { authForUserInTenant } from "./services/authService.ts";
import { previewActionPlan, confirmActionRun, processActionRun, getActionRun } from "./services/aiActionService.ts";
import { claimOutboxEvent } from "./services/outboxLease.ts";

assertTestDatabase();
assert.equal(process.env.CRM_TEST_POSTGRES, "1", "This suite requires real PostgreSQL");
const db = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
after(() => db.$disconnect());

async function queuedPlan() {
  const tenant = await db.tenant.create({ data: { name: "Runtime acceptance", slug: randomUUID(), settingsJson: { control: { enabled: true } } } });
  const user = await db.user.create({ data: { name: "Test owner", email: `${randomUUID()}@example.test`, passwordHash: "unused" } });
  const membership = await db.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: "owner" } });
  await db.controlAccess.create({ data: { tenantId: tenant.id, userId: user.id, enabled: true, status: "active", allowedSources: ["CRM_CHAT"], canCreateTasks: true, canReadTeamData: true } });
  const auth = await authForUserInTenant(db, user.id, tenant.id);
  const run = await previewActionPlan(db, auth, { requestId: randomUUID(), title: "Runtime plan", steps: [
    { key: "create", kind: "task.create", type: "message", title: "Runtime task" },
    { key: "draft", kind: "task.draft", target: { fromStep: "create" }, text: "Internal acceptance draft. Do not send." },
  ] });
  await confirmActionRun(db, auth, run.id, { requestId: randomUUID(), confirmed: true, planHash: run.planHash });
  return { tenant, user, membership, auth, run, eventId: (await db.actionRun.findUniqueOrThrow({ where: { id: run.id } })).outboxId! };
}

async function workers(mode: string, id = "", count = 4) {
  const children = Array.from({ length: count }, () => {
    const child = fork("scripts/check-postgres-worker.ts", [mode, id], { execArgv: ["--experimental-strip-types"], stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let output = "", result: { claimed?: boolean } = {}, isReady = false;
    child.stdout?.on("data", chunk => { output = (output + chunk).slice(-4000); });
    child.stderr?.on("data", chunk => { output = (output + chunk).slice(-4000); });
    let resolveReady!: () => void, rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    child.on("message", (value: { ready?: boolean; claimed?: boolean }) => {
      if (value.ready) { isReady = true; resolveReady(); }
      if (typeof value.claimed === "boolean") result = value;
    });
    const timer = setTimeout(() => { child.kill(); }, 90_000);
    const done = new Promise<{ claimed?: boolean }>((resolve, reject) => {
      child.on("error", error => { rejectReady(error); reject(error); });
      child.on("exit", code => {
        clearTimeout(timer);
        if (!isReady) rejectReady(new Error(`Worker failed before readiness (${code}): ${output}`));
        if (code !== 0) reject(new Error(`Worker failed (${code}): ${output}`)); else resolve(result);
      });
    });
    // Both promises are observed even when another worker fails first.
    void ready.catch(() => {}); void done.catch(() => {});
    return { child, ready, done };
  });
  try {
    await Promise.all(children.map(item => item.ready));
    for (const item of children) item.child.send("run");
    return await Promise.all(children.map(item => item.done));
  } finally {
    for (const item of children) if (item.child.exitCode === null) item.child.kill();
    await Promise.allSettled(children.map(item => item.done));
  }
}

test("real PostgreSQL migration, process contention and backup restoration", async t => {
  await t.test("four cold processes migrate the shipped baseline; repeated startup preserves data", async () => {
    await workers("startup");
    const ledger = await db.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*) FROM "BasqarSchemaMigration"`;
    assert.equal(Number(ledger[0].count), 1);
    await db.tenant.create({ data: { name: "Acceptance retained", slug: "pg-acceptance-retained" } });
    await workers("startup");
    assert.equal(await db.tenant.count({ where: { slug: "pg-acceptance-retained" } }), 1);
    assert.equal(await db.situationEpisode.count(), 0);
  });

  await t.test("four independent workers produce one effect for the same queued event", async () => {
    const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: "pg-acceptance-retained" } });
    await db.$executeRawUnsafe('CREATE TABLE "AcceptanceEffect" ("eventId" TEXT NOT NULL)');
    const event = await db.outboxEvent.create({ data: { tenantId: tenant.id, type: "acceptance.synthetic", entityType: "tenant", entityId: tenant.id, payloadJson: {} } });
    const results = await workers("claim", event.id);
    assert.equal(results.filter(item => item.claimed).length, 1);
    const effects = await db.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*) FROM "AcceptanceEffect" WHERE "eventId" = ${event.id}`;
    assert.equal(Number(effects[0].count), 1);
    const processed = await db.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    assert.ok(processed.processedAt); assert.equal(processed.attempts, 1);
  });

  await t.test("SIGKILL after a committed step is recovered once by competing workers", { timeout: 120000 }, async () => {
    const fixture = await queuedPlan();
    const child = fork("scripts/check-postgres-worker.ts", ["action-crash", fixture.eventId], {
      execArgv: ["--experimental-strip-types"], stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const exited = once(child, "exit");
    let committed = false, output = "";
    child.stdout?.on("data", chunk => { output = (output + chunk).slice(-4000); });
    child.stderr?.on("data", chunk => { output = (output + chunk).slice(-4000); });
    child.on("message", (m: { ready?: boolean; firstStepCommitted?: boolean }) => {
      if (m.ready) child.send("run");
      if (m.firstStepCommitted) committed = true;
    });
    try {
      for (let n = 0; n < 400 && !committed && child.exitCode === null; n++) await delay(100);
      assert.ok(committed, output);
      child.kill("SIGKILL"); await exited;
      const before = await db.outboxEvent.findUniqueOrThrow({ where: { id: fixture.eventId } });
      assert.equal(before.processedAt, null); assert.ok(before.availableAt > new Date());
      assert.equal(await db.task.count({ where: { tenantId: fixture.tenant.id } }), 1);
      assert.equal((await getActionRun(db, fixture.auth, fixture.run.id)).completed, 1);
      assert.equal(await claimOutboxEvent(db, fixture.eventId), null, "unexpired claim blocks takeover");
      // Expire only this synthetic lease, without sleeping for the full 60s TTL.
      await db.outboxEvent.update({ where: { id: fixture.eventId }, data: { availableAt: new Date(Date.now() - 1000) } });
      assert.equal((await workers("action", fixture.eventId)).filter(r => r.claimed).length, 1);
      const after = await getActionRun(db, fixture.auth, fixture.run.id);
      assert.equal(after.status, "succeeded"); assert.equal(after.completed, 2);
      assert.equal(await db.task.count({ where: { tenantId: fixture.tenant.id } }), 1);
      assert.equal(await db.auditEvent.count({ where: { tenantId: fixture.tenant.id, action: "task.created" } }), 1);
      assert.equal(await db.message.count({ where: { tenantId: fixture.tenant.id } }), 0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  });

  await t.test("pg_dump restores schema, migration ledger and records into a new database", async () => {
    const paused = await queuedPlan(), revoked = await queuedPlan();
    await db.tenant.update({ where: { id: paused.tenant.id }, data: { settingsJson: { control: { enabled: true }, runtime: { aiPaused: true } } } });
    await db.membership.update({ where: { id: revoked.membership.id }, data: { active: false } });
    const processedBefore = await db.outboxEvent.count({ where: { processedAt: { not: null } } });
    const url = new URL(process.env.DATABASE_URL!);
    const name = `${url.pathname.slice(1)}_restore`;
    const folder = mkdtempSync(join(tmpdir(), "basqar-pg-backup-"));
    const file = join(folder, "backup.sql");
    const env = { ...process.env, PGHOST: url.hostname, PGPORT: url.port || "5432", PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: url.pathname.slice(1) };
    let created = false;
    const target = new URL(url); target.pathname = `/${name}`;
    const restored = new PrismaClient({ datasourceUrl: target.href });
    try {
      const dump = spawnSync("pg_dump", ["--no-owner", "--no-acl", "--file", file], { env, encoding: "utf8" });
      assert.equal(dump.status, 0, dump.stderr || String(dump.error));
      await db.$executeRawUnsafe(`CREATE DATABASE "${name}"`); created = true;
      const restore = spawnSync("psql", ["--set", "ON_ERROR_STOP=1", "--file", file], { env: { ...env, PGDATABASE: name }, encoding: "utf8" });
      assert.equal(restore.status, 0, restore.stderr || String(restore.error));
      assert.equal(await restored.tenant.count(), await db.tenant.count());
      await applyLivePostgresPatches(restored); // repeat startup after restoration
      assert.equal(await restored.outboxEvent.count({ where: { processedAt: { not: null } } }), processedBefore);
      assert.equal(await restored.actionRun.count(), await db.actionRun.count());
      assert.equal(await restored.actionStep.count(), await db.actionStep.count());
      assert.equal(await restored.controlConfirmation.count(), await db.controlConfirmation.count());
      await processActionRun(restored, paused.tenant.id, paused.run.id);
      await processActionRun(restored, revoked.tenant.id, revoked.run.id);
      for (const fixture of [paused, revoked]) {
        assert.equal(await restored.task.count({ where: { tenantId: fixture.tenant.id } }), 0);
        assert.equal((await restored.actionRun.findUniqueOrThrow({ where: { id: fixture.run.id } })).status, "failed");
      }
      await assert.rejects(getActionRun(restored, revoked.auth, revoked.run.id), (e: any) => [401, 403].includes(e.status));
      await assert.rejects(getActionRun(restored, paused.auth, revoked.run.id), (e: any) => e.status === 404);
      const ledger = await restored.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*) FROM "BasqarSchemaMigration"`;
      assert.equal(Number(ledger[0].count), 1);
    } finally {
      await restored.$disconnect();
      if (created) await db.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
