/** Observational initiatives only: no prompt, pipeline or delivery settings are changed. */
export const BUSINESS_EXPERIMENT_SQL = [
  `CREATE TABLE IF NOT EXISTS "BusinessExperiment" (
    id TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL REFERENCES "Tenant"(id) ON DELETE CASCADE,
    title TEXT NOT NULL, hypothesis TEXT NOT NULL, change TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'draft',
    version INTEGER NOT NULL DEFAULT 1, "methodVersion" TEXT NOT NULL, "methodJson" JSONB NOT NULL, timezone TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL, "periodEnd" TIMESTAMP(3) NOT NULL, "authorUserId" TEXT NOT NULL,
    "baselineJson" JSONB, "environmentHash" TEXT, "approvedAt" TIMESTAMP(3), "approvedByUserId" TEXT,
    "stopReason" TEXT, "finishedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL, UNIQUE ("tenantId", id))`,
  `CREATE INDEX IF NOT EXISTS "BusinessExperiment_list_idx" ON "BusinessExperiment"("tenantId", state, id)`,
  `CREATE TABLE IF NOT EXISTS "ExperimentMeasurement" (
    id TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "experimentId" TEXT NOT NULL, revision INTEGER NOT NULL, "measuredAt" TIMESTAMP(3) NOT NULL,
    fingerprint TEXT NOT NULL, "resultJson" JSONB NOT NULL,
    FOREIGN KEY ("tenantId", "experimentId") REFERENCES "BusinessExperiment"("tenantId", id) ON DELETE CASCADE,
    UNIQUE ("tenantId", "experimentId", fingerprint))`,
  `CREATE INDEX IF NOT EXISTS "ExperimentMeasurement_history_idx" ON "ExperimentMeasurement"("tenantId", "experimentId", "measuredAt")`,
  `CREATE TABLE IF NOT EXISTS "BusinessExperimentEvent" (
    id TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "experimentId" TEXT NOT NULL, type TEXT NOT NULL, version INTEGER NOT NULL,
    "userId" TEXT NOT NULL, "requestId" TEXT NOT NULL, "requestHash" TEXT NOT NULL, note TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("tenantId", "experimentId") REFERENCES "BusinessExperiment"("tenantId", id) ON DELETE CASCADE,
    UNIQUE ("tenantId", "userId", "requestId"))`,
  `CREATE INDEX IF NOT EXISTS "BusinessExperimentEvent_history_idx" ON "BusinessExperimentEvent"("tenantId", "experimentId", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "Task_proposal_experiment_idx" ON "Task"("tenantId", type, "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "Activity_proposal_prepared_idx" ON "Activity"("tenantId", ("metadataJson"->>'taskId'), "createdAt") WHERE type = 'task.prepared'`,
];
