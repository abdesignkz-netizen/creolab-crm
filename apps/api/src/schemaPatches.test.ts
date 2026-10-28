import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { applyRequiredSchemaPatches } from "../../../packages/db/src/schemaPatches.ts";
import { applyLivePostgresPatches } from "../../../packages/db/src/client.ts";
import { applyBillingMigration } from "../../../packages/db/src/billingMigration.ts";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { PrismaPGlite } from "pglite-prisma-adapter";
import { PrismaClient } from "@prisma/client";

describe("required startup schema patches", () => {
  let db: Awaited<ReturnType<typeof createPrismaClient>>;
  before(async () => { db = await createPrismaClient(); });
  after(async () => { await db.$disconnect(); });
  const create = 'CREATE TABLE IF NOT EXISTS "SchemaPatchTest" (id INTEGER PRIMARY KEY)';

  it("upgrades the shipped baseline without relying on PGlite-only initialization", async () => {
    const pg = new PGlite();
    const fresh = new PrismaClient({ adapter: new PrismaPGlite(pg) } as never);
    try {
      await pg.exec(await readFile(new URL("../../../packages/db/prisma/init.sql", import.meta.url), "utf8"));
      await applyLivePostgresPatches(fresh);
      await applyBillingMigration(fresh);
      await applyLivePostgresPatches(fresh);
      await applyBillingMigration(fresh);
      assert.equal(await fresh.company.count(), 0);
      assert.equal(await fresh.agreement.count(), 0);
      assert.equal(await fresh.situationEpisode.count(), 0);
      assert.equal(await fresh.billingOrder.count(), 0);
      const tenant = await fresh.tenant.create({ data: { name: "Retained", slug: "retained" } });
      await fresh.company.create({ data: { tenantId: tenant.id, name: "Preserved company" } });
      await applyLivePostgresPatches(fresh);
      assert.equal(await fresh.company.count(), 1);
    } finally { await fresh.$disconnect(); await pg.close(); }
  });

  it("accepts the full live patch manifest on the existing isolated schema, including repeat startup", async () => {
    await applyLivePostgresPatches(db);
    await applyLivePostgresPatches(db);
    await db.tenant.count();
  });

  it("rolls back prior DDL and data and rejects readiness if a later patch fails", async () => {
    await assert.rejects(applyRequiredSchemaPatches(db, [
      { name: "fixture", statements: [create, 'INSERT INTO "SchemaPatchTest" (id) VALUES (1)'] },
      { name: "failure", statements: ['SELECT missing_secret_record_value FROM "SchemaPatchTest"'] },
    ]), error => {
      assert.match(String(error), /Required schema patch failed: failure\[1\].*initialization aborted/);
      assert.doesNotMatch(String(error), /missing_secret_record_value|SELECT|INSERT/);
      return true;
    });
    const rows = await db.$queryRaw<Array<{ table_name: string | null }>>`SELECT to_regclass('public."SchemaPatchTest"')::text AS table_name`;
    assert.equal(rows[0].table_name, null);
  });

  it("can retry successfully after failure and reapply additive patches safely", async () => {
    const groups = [{ name: "fixture", statements: [create, 'ALTER TABLE "SchemaPatchTest" ADD COLUMN IF NOT EXISTS label TEXT'] }];
    await applyRequiredSchemaPatches(db, groups);
    await applyRequiredSchemaPatches(db, groups);
    await db.$executeRaw`INSERT INTO "SchemaPatchTest" (id, label) VALUES (1, 'kept')`;
    await assert.rejects(applyRequiredSchemaPatches(db, [
      { name: "mutate", statements: ['UPDATE "SchemaPatchTest" SET label = \'overwritten\'', 'SELECT invalid_column FROM "SchemaPatchTest"'] },
    ]));
    const rows = await db.$queryRaw<Array<{ label: string }>>`SELECT label FROM "SchemaPatchTest" WHERE id = 1`;
    assert.equal(rows[0].label, "kept");
  });
});
