/** Additive on both PostgreSQL and PGlite; no replay of historical actions. */
export const AI_ACTION_SQL = [
  `CREATE TABLE IF NOT EXISTS "ActionRun" (
    "id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
    "userId" TEXT NOT NULL, "initiatorMembershipId" TEXT NOT NULL, "requestId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL, "title" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'draft',
    "snapshotJson" JSONB NOT NULL, "confirmationId" TEXT, "outboxId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL, "confirmedAt" TIMESTAMP(3), "finishedAt" TIMESTAMP(3),
    "errorCode" TEXT, "errorText" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ActionRun_tenantId_id_key" UNIQUE ("tenantId", "id"),
    CONSTRAINT "ActionRun_tenantId_userId_requestId_key" UNIQUE ("tenantId", "userId", "requestId"),
    CONSTRAINT "ActionRun_confirmationId_key" UNIQUE ("confirmationId"),
    CONSTRAINT "ActionRun_outboxId_key" UNIQUE ("outboxId")
  )`,
  `CREATE INDEX IF NOT EXISTS "ActionRun_tenantId_userId_createdAt_idx" ON "ActionRun" ("tenantId", "userId", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "ActionRun_status_expiresAt_idx" ON "ActionRun" ("status", "expiresAt")`,
  `CREATE TABLE IF NOT EXISTS "ActionStep" (
    "id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "runId" TEXT NOT NULL, "position" INTEGER NOT NULL,
    "key" TEXT NOT NULL, "kind" TEXT NOT NULL, "label" TEXT NOT NULL, "detail" TEXT NOT NULL,
    "inputJson" JSONB NOT NULL, "snapshotJson" JSONB NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending',
    "taskId" TEXT, "resultJson" JSONB, "errorCode" TEXT, "errorText" TEXT, "finishedAt" TIMESTAMP(3),
    CONSTRAINT "ActionStep_run_fkey" FOREIGN KEY ("tenantId", "runId") REFERENCES "ActionRun"("tenantId", "id") ON DELETE CASCADE,
    CONSTRAINT "ActionStep_tenantId_runId_key_key" UNIQUE ("tenantId", "runId", "key"),
    CONSTRAINT "ActionStep_runId_position_key" UNIQUE ("runId", "position")
  )`,
];
