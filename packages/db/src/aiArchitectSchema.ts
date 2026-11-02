/** Same additive migration for live PostgreSQL and isolated PGlite. */
export const AI_ARCHITECT_SQL = [
  `CREATE TABLE IF NOT EXISTS "ArchitectDraft" (
    "id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL UNIQUE REFERENCES "Tenant"("id") ON DELETE CASCADE,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1, "revision" INTEGER NOT NULL DEFAULT 1,
    "savedByUserId" TEXT NOT NULL, "requestId" TEXT NOT NULL, "requestHash" TEXT NOT NULL,
    "baseRevision" TEXT NOT NULL, "answersJson" JSONB NOT NULL, "previewJson" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
  )`,
  `ALTER TABLE "ArchitectDraft" ADD COLUMN IF NOT EXISTS "applicationRunId" TEXT`,
  `ALTER TABLE "ArchitectDraft" ADD COLUMN IF NOT EXISTS "appliedRevision" INTEGER`,
  `ALTER TABLE "ArchitectDraft" ADD COLUMN IF NOT EXISTS "appliedAt" TIMESTAMP(3)`,
];
