import type { PrismaClient } from "@prisma/client";

type PatchGroup = { name: string; statements: readonly string[] };

/** Required patches either all commit or stop startup. API and worker serialize
 * their DDL here; CREATE IF NOT EXISTS alone does not protect concurrent starts. */
export async function applyRequiredSchemaPatches(prisma: PrismaClient, groups: readonly PatchGroup[]) {
  await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(610252026)");
    for (const group of groups) {
      for (const [index, sql] of group.statements.entries()) {
        try {
          await tx.$executeRawUnsafe(sql);
        } catch (error) {
          const code = typeof error === "object" && error && "code" in error ? String(error.code) : "unknown";
          // Identify the patch without putting SQL, connection strings or record
          // values in a startup log. Throwing also rolls back earlier statements.
          throw new Error(`Required schema patch failed: ${group.name}[${index + 1}] (${code}). Database initialization aborted.`);
        }
      }
    }
  }, { timeout: 120_000, maxWait: 30_000 });
}
