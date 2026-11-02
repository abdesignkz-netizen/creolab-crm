/** Additive, shared by PostgreSQL startup and the isolated test database. */
export const BUSINESS_INSIGHT_SQL = [
  `CREATE TABLE IF NOT EXISTS "BusinessInsight" (
    "id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
    "rule" TEXT NOT NULL, "entityKind" TEXT NOT NULL, "entityId" TEXT NOT NULL,
    "occurrence" INTEGER NOT NULL DEFAULT 1, "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "state" TEXT NOT NULL DEFAULT 'open', "version" INTEGER NOT NULL DEFAULT 1,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1, "formulaVersion" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL, "contentJson" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL, "checkedAt" TIMESTAMP(3) NOT NULL, "validUntil" TIMESTAMP(3) NOT NULL,
    UNIQUE ("tenantId", "id"), UNIQUE ("tenantId", "rule", "entityId", "occurrence"))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "BusinessInsight_current_key" ON "BusinessInsight"("tenantId", "rule", "entityId") WHERE "isCurrent"`,
  `CREATE INDEX IF NOT EXISTS "BusinessInsight_list_idx" ON "BusinessInsight"("tenantId", "isCurrent", "state", "id")`,
  `CREATE INDEX IF NOT EXISTS "BusinessInsight_recheck_idx" ON "BusinessInsight"("tenantId", "isCurrent", "checkedAt", "id")`,
  `CREATE TABLE IF NOT EXISTS "BusinessInsightEvent" (
    "id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "insightId" TEXT NOT NULL,
    "type" TEXT NOT NULL, "version" INTEGER NOT NULL, "userId" TEXT,
    "requestId" TEXT, "requestHash" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("tenantId", "insightId") REFERENCES "BusinessInsight"("tenantId", "id") ON DELETE CASCADE,
    UNIQUE ("tenantId", "userId", "requestId"))`,
  `CREATE INDEX IF NOT EXISTS "BusinessInsightEvent_history_idx" ON "BusinessInsightEvent"("tenantId", "insightId", "createdAt")`,
  `CREATE TABLE IF NOT EXISTS "BusinessInsightScan" (
    "tenantId" TEXT PRIMARY KEY REFERENCES "Tenant"("id") ON DELETE CASCADE,
    "cursorsJson" JSONB NOT NULL DEFAULT '{}', "coverageJson" JSONB NOT NULL DEFAULT '{}',
    "lastRunAt" TIMESTAMP(3), "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS "BusinessInsightScan_due_idx" ON "BusinessInsightScan"("nextRunAt")`,
  // IDs are resolved with tenant + entity checks; deleting CRM history must not
  // block contact erasure. No copied activity text is retained here.
  `ALTER TABLE "BusinessInsight" ADD COLUMN IF NOT EXISTS "actionRunId" TEXT`,
  `ALTER TABLE "BusinessInsight" ADD COLUMN IF NOT EXISTS "outcomeEventId" TEXT`,
  `CREATE INDEX IF NOT EXISTS "Agreement_deal_opportunity_idx" ON "Agreement"("tenantId", "dealId", "type", "status")`,
  `CREATE INDEX IF NOT EXISTS "Task_deal_opportunity_idx" ON "Task"("tenantId", "dealId", "status", "dueAt", "id")`,
  `CREATE INDEX IF NOT EXISTS "Task_inquiry_opportunity_idx" ON "Task"("tenantId", "inquiryId", "status", "dueAt", "id")`,
];
