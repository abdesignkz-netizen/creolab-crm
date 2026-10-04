// Additive schema shared by PostgreSQL deployments and the local PGlite database.
export const WHATSAPP_SQL = [
  `ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "lastInboundMessageId" TEXT`,
  `ALTER TABLE "OutboundOperation" ADD COLUMN IF NOT EXISTS "requestHash" TEXT`,
  `CREATE TABLE IF NOT EXISTS "WhatsAppQrSession" (
    "integrationId" TEXT PRIMARY KEY REFERENCES "Integration"("id") ON DELETE CASCADE,
    "owner" TEXT, "leaseUntil" TIMESTAMPTZ, "encryptedQr" TEXT, "qrExpiresAt" TIMESTAMPTZ,
    "reconnectAt" TIMESTAMPTZ, "attempts" INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS "WhatsAppQrKey" (
    "integrationId" TEXT NOT NULL REFERENCES "WhatsAppQrSession"("integrationId") ON DELETE CASCADE,
    "key" TEXT NOT NULL, "encryptedValue" TEXT NOT NULL,
    PRIMARY KEY ("integrationId", "key")
  )`,
  `CREATE TABLE IF NOT EXISTS "WhatsAppQrJob" (
    "id" TEXT PRIMARY KEY, "integrationId" TEXT NOT NULL REFERENCES "WhatsAppQrSession"("integrationId") ON DELETE CASCADE,
    "kind" TEXT NOT NULL, "encryptedPayload" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued', "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS "WhatsAppQrJob_pending" ON "WhatsAppQrJob" ("integrationId", "state", "createdAt")`,
];
