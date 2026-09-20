-- Additive self-registration support. Safe to run more than once.
-- Does not change existing Tenant, Membership, User, or TenantPlan rows.

ALTER TABLE "ServiceSignupRequest" ADD COLUMN IF NOT EXISTS "name" TEXT;
ALTER TABLE "ServiceSignupRequest" ADD COLUMN IF NOT EXISTS "userId" TEXT;
ALTER TABLE "ServiceSignupRequest" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "ServiceSignupRequest" ADD COLUMN IF NOT EXISTS "convertedAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "PendingRegistration" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "companyName" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "resendCount" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "lastSentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consumedAt" TIMESTAMP(3),
  "sourceIp" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PendingRegistration_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "PendingRegistration_email_consumedAt_idx" ON "PendingRegistration"("email", "consumedAt");
CREATE INDEX IF NOT EXISTS "PendingRegistration_expiresAt_idx" ON "PendingRegistration"("expiresAt");
