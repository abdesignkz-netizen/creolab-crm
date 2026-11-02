/** Additive goal snapshots; source records and monetary plans remain authoritative. */
export const BUSINESS_GOAL_SQL = [
  `CREATE TABLE IF NOT EXISTS "BusinessGoal" (
    id TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL REFERENCES "Tenant"(id) ON DELETE CASCADE,
    title TEXT NOT NULL, metric TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active', version INTEGER NOT NULL DEFAULT 1,
    "ownerMembershipId" TEXT NOT NULL, "periodStart" TIMESTAMP(3) NOT NULL, "periodEnd" TIMESTAMP(3) NOT NULL,
    timezone TEXT NOT NULL, currency TEXT, "salesMonth" TEXT, "bindingKey" TEXT,
    target DECIMAL(24,4), "baselineJson" JSONB, "lastMeasuredAt" TIMESTAMP(3), "nextCheckAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
    UNIQUE ("tenantId", id), UNIQUE ("tenantId", "bindingKey"))`,
  `CREATE INDEX IF NOT EXISTS "BusinessGoal_due_idx" ON "BusinessGoal"(state, "nextCheckAt")`,
  `CREATE INDEX IF NOT EXISTS "BusinessGoal_list_idx" ON "BusinessGoal"("tenantId", state, id)`,
  `CREATE TABLE IF NOT EXISTS "GoalMeasurement" (
    id TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "goalId" TEXT NOT NULL, version INTEGER NOT NULL,
    "measuredAt" TIMESTAMP(3) NOT NULL, "asOf" TIMESTAMP(3) NOT NULL, fingerprint TEXT NOT NULL,
    "resultJson" JSONB NOT NULL, FOREIGN KEY ("tenantId", "goalId") REFERENCES "BusinessGoal"("tenantId", id) ON DELETE CASCADE,
    UNIQUE ("tenantId", "goalId", version, fingerprint))`,
  `CREATE INDEX IF NOT EXISTS "GoalMeasurement_history_idx" ON "GoalMeasurement"("tenantId", "goalId", "measuredAt")`,
  `CREATE TABLE IF NOT EXISTS "BusinessGoalEvent" (
    id TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "goalId" TEXT NOT NULL, type TEXT NOT NULL,
    version INTEGER NOT NULL, "userId" TEXT, "requestId" TEXT, "requestHash" TEXT,
    "changesJson" JSONB NOT NULL DEFAULT '{}', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("tenantId", "goalId") REFERENCES "BusinessGoal"("tenantId", id) ON DELETE CASCADE,
    UNIQUE ("tenantId", "userId", "requestId"))`,
  `CREATE INDEX IF NOT EXISTS "BusinessGoalEvent_history_idx" ON "BusinessGoalEvent"("tenantId", "goalId", "createdAt")`,
  `CREATE TABLE IF NOT EXISTS "GoalInitiative" (
    id TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "goalId" TEXT NOT NULL, "taskId" TEXT NOT NULL, "actionRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("tenantId", "goalId") REFERENCES "BusinessGoal"("tenantId", id) ON DELETE CASCADE,
    UNIQUE ("tenantId", "goalId", "taskId"))`,
];
