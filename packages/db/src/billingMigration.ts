import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

/** Versioned, checksummed, atomic migration for existing installations and local PGlite. */
export async function applyBillingMigration(prisma: PrismaClient) {
  const version = "20261006_unified_billing";
  const sql = await readFile(
    new URL(`../prisma/migrations/${version}/migration.sql`, import.meta.url),
    "utf8",
  );
  const checksum = createHash("sha256").update(sql).digest("hex");
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(610062026)");
      await tx.$executeRawUnsafe(
        'CREATE TABLE IF NOT EXISTS "BasqarSchemaMigration" ("version" TEXT PRIMARY KEY, "checksum" TEXT NOT NULL, "appliedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW())',
      );
      const applied = await tx.$queryRaw<
        Array<{ checksum: string }>
      >`SELECT checksum FROM "BasqarSchemaMigration" WHERE version = ${version}`;
      if (applied.length) {
        if (applied[0].checksum !== checksum)
          throw new Error("Billing migration checksum mismatch");
        return;
      }
      for (const statement of sql
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean))
        await tx.$executeRawUnsafe(statement);
      await tx.$executeRaw`INSERT INTO "BasqarSchemaMigration" (version, checksum) VALUES (${version}, ${checksum})`;
    },
    { timeout: 60_000 },
  );
}
