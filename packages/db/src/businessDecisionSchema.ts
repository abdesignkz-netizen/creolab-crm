/** Contents may be erased; the event log keeps operation metadata only. */
export const BUSINESS_DECISION_SQL = [
  `CREATE TABLE IF NOT EXISTS "BusinessDecision" (
    id TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL REFERENCES "Tenant"(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 1, kind TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'draft',
    topic TEXT NOT NULL, "topicKey" TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, rationale TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL, "sourceId" TEXT, "sourceFingerprint" TEXT, "privateUserId" TEXT,
    "authorUserId" TEXT NOT NULL, "approvedByUserId" TEXT, "approvedAt" TIMESTAMP(3),
    "validFrom" TIMESTAMP(3) NOT NULL, "validUntil" TIMESTAMP(3) NOT NULL, "retentionUntil" TIMESTAMP(3) NOT NULL,
    "supersededById" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
    UNIQUE ("tenantId", id))`,
  `CREATE INDEX IF NOT EXISTS "BusinessDecision_list_idx" ON "BusinessDecision"("tenantId", state, id)`,
  `CREATE INDEX IF NOT EXISTS "BusinessDecision_topic_idx" ON "BusinessDecision"("tenantId", "topicKey", state)`,
  `CREATE INDEX IF NOT EXISTS "BusinessDecision_retention_idx" ON "BusinessDecision"("retentionUntil", state)`,
  `CREATE TABLE IF NOT EXISTS "BusinessDecisionEvent" (
    id TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "decisionId" TEXT NOT NULL, type TEXT NOT NULL, version INTEGER NOT NULL,
    "userId" TEXT, "requestId" TEXT, "requestHash" TEXT, "fieldsJson" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("tenantId", "decisionId") REFERENCES "BusinessDecision"("tenantId", id) ON DELETE CASCADE,
    UNIQUE ("tenantId", "userId", "requestId"))`,
  `CREATE INDEX IF NOT EXISTS "BusinessDecisionEvent_history_idx" ON "BusinessDecisionEvent"("tenantId", "decisionId", "createdAt")`,
];
