// Additive migration shared by PostgreSQL and the isolated PGlite test database.
export const CONTROL_CHAT_SQL = [
  `CREATE TABLE IF NOT EXISTS "ControlChatSession" (
    "id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
    "identityId" TEXT NOT NULL REFERENCES "ControlIdentity"("id") ON DELETE CASCADE,
    "integrationId" TEXT NOT NULL REFERENCES "Integration"("id") ON DELETE CASCADE,
    "contextJson" JSONB NOT NULL DEFAULT '{}', "expiresAt" TIMESTAMP(3) NOT NULL,
    "leaseOwner" TEXT, "leaseUntil" TIMESTAMP(3), "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ControlChatSession_identityId_integrationId_key" ON "ControlChatSession"("identityId", "integrationId")`,
  `CREATE INDEX IF NOT EXISTS "ControlChatSession_tenantId_idx" ON "ControlChatSession"("tenantId")`,
  `CREATE TABLE IF NOT EXISTS "ControlChatMessage" (
    "id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
    "identityId" TEXT NOT NULL REFERENCES "ControlIdentity"("id") ON DELETE CASCADE,
    "integrationId" TEXT NOT NULL REFERENCES "Integration"("id") ON DELETE CASCADE,
    "eventKey" TEXT NOT NULL, "kind" TEXT NOT NULL DEFAULT 'request', "text" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued', "replyText" TEXT, "actionsJson" JSONB NOT NULL DEFAULT '[]',
    "accessVersion" TEXT, "identityVersion" TEXT, "claimedAt" TIMESTAMP(3), "finishedAt" TIMESTAMP(3),
    "providerRef" TEXT, "error" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  // Provider timestamps have second precision; UUIDs cannot break ties in arrival order.
  // Additive for existing installations as well as freshly created test databases.
  `ALTER TABLE "ControlChatMessage" ADD COLUMN IF NOT EXISTS "queueOrder" SERIAL NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ControlChatMessage_integrationId_eventKey_key" ON "ControlChatMessage"("integrationId", "eventKey")`,
  `CREATE INDEX IF NOT EXISTS "ControlChatMessage_state_createdAt_idx" ON "ControlChatMessage"("state", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "ControlChatMessage_identityId_integrationId_createdAt_idx" ON "ControlChatMessage"("identityId", "integrationId", "createdAt")`,
];
