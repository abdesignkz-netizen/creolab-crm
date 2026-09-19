-- Additive: public requests to connect a company. Safe to run more than once.

CREATE TABLE IF NOT EXISTS "ServiceSignupRequest" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "companyName" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'NEW',
  "sourceIp" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  "processedByUserId" TEXT,
  CONSTRAINT "ServiceSignupRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ServiceSignupRequest_status_createdAt_idx" ON "ServiceSignupRequest"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "ServiceSignupRequest_email_createdAt_idx" ON "ServiceSignupRequest"("email", "createdAt");
