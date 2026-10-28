import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fork, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { assertTestDatabase } from "./testSupport/testDatabase.ts";

assertTestDatabase();
assert.equal(process.env.CRM_TEST_POSTGRES, "1", "This suite requires real PostgreSQL");
const db = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
after(() => db.$disconnect());

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
    const event = await db.outboxEvent.create({ data: { tenantId: tenant.id, type: "acceptance.synthetic", entityType: "tenant", entityId: tenant.id } });
    const results = await workers("claim", event.id);
    assert.equal(results.filter(item => item.claimed).length, 1);
    const effects = await db.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*) FROM "AcceptanceEffect" WHERE "eventId" = ${event.id}`;
    assert.equal(Number(effects[0].count), 1);
    const processed = await db.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    assert.ok(processed.processedAt); assert.equal(processed.attempts, 1);
  });

  await t.test("pg_dump restores schema, migration ledger and records into a new database", async () => {
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
      assert.equal(await restored.outboxEvent.count({ where: { processedAt: { not: null } } }), 1);
      const ledger = await restored.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*) FROM "BasqarSchemaMigration"`;
      assert.equal(Number(ledger[0].count), 1);
    } finally {
      await restored.$disconnect();
      if (created) await db.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
