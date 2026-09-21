-- Additive SaaS billing catalog + request/payment tables.
ALTER TABLE "Plan" ADD COLUMN IF NOT EXISTS "kind" TEXT DEFAULT 'legacy';
ALTER TABLE "Plan" ADD COLUMN IF NOT EXISTS "product" TEXT DEFAULT 'CRM';
ALTER TABLE "Plan" ADD COLUMN IF NOT EXISTS "monthlyPriceMinor" INTEGER DEFAULT 0;
ALTER TABLE "Plan" ADD COLUMN IF NOT EXISTS "yearlyPriceMinor" INTEGER DEFAULT 0;
ALTER TABLE "Plan" ADD COLUMN IF NOT EXISTS "public" BOOLEAN DEFAULT false;
ALTER TABLE "Plan" ADD COLUMN IF NOT EXISTS "active" BOOLEAN DEFAULT true;
ALTER TABLE "Plan" ADD COLUMN IF NOT EXISTS "catalogStatus" TEXT DEFAULT 'HIDDEN';
ALTER TABLE "Plan" ADD COLUMN IF NOT EXISTS "chargeType" TEXT DEFAULT 'RECURRING';
ALTER TABLE "Plan" ADD COLUMN IF NOT EXISTS "recommended" BOOLEAN DEFAULT false;
ALTER TABLE "Plan" ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER DEFAULT 100;
ALTER TABLE "Plan" ADD COLUMN IF NOT EXISTS "description" TEXT DEFAULT '';
ALTER TABLE "Plan" ADD COLUMN IF NOT EXISTS "includedJson" JSONB DEFAULT '[]';
ALTER TABLE "Plan" ADD COLUMN IF NOT EXISTS "version" INTEGER DEFAULT 1;

ALTER TABLE "TenantPlan" ADD COLUMN IF NOT EXISTS "billingPeriod" TEXT DEFAULT 'MONTHLY';
ALTER TABLE "TenantPlan" ADD COLUMN IF NOT EXISTS "amountMinor" INTEGER DEFAULT 0;
ALTER TABLE "TenantPlan" ADD COLUMN IF NOT EXISTS "currency" TEXT DEFAULT 'KZT';
ALTER TABLE "TenantPlan" ADD COLUMN IF NOT EXISTS "itemsJson" JSONB DEFAULT '[]';
ALTER TABLE "TenantPlan" ADD COLUMN IF NOT EXISTS "priceSnapshotJson" JSONB DEFAULT '{}';
ALTER TABLE "TenantPlan" ADD COLUMN IF NOT EXISTS "limitsSnapshotJson" JSONB DEFAULT '{}';
ALTER TABLE "TenantPlan" ADD COLUMN IF NOT EXISTS "featuresSnapshotJson" JSONB DEFAULT '{}';
ALTER TABLE "TenantPlan" ADD COLUMN IF NOT EXISTS "paymentMethod" TEXT DEFAULT 'MANUAL';
ALTER TABLE "TenantPlan" ADD COLUMN IF NOT EXISTS "confirmedByUserId" TEXT;
ALTER TABLE "TenantPlan" ADD COLUMN IF NOT EXISTS "confirmedAt" TIMESTAMP(3);
ALTER TABLE "TenantPlan" ADD COLUMN IF NOT EXISTS "requestId" TEXT;
ALTER TABLE "TenantPlan" ADD COLUMN IF NOT EXISTS "notes" TEXT;

CREATE TABLE IF NOT EXISTS "SubscriptionRequest" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "requestedByUserId" TEXT,
  "requestType" TEXT NOT NULL,
  "requestedPlanCode" TEXT,
  "billingPeriod" TEXT NOT NULL DEFAULT 'MONTHLY',
  "requestedAddOnsJson" JSONB NOT NULL DEFAULT '[]',
  "baseAmountMinor" INTEGER NOT NULL DEFAULT 0,
  "discountAmountMinor" INTEGER NOT NULL DEFAULT 0,
  "finalAmountMinor" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'KZT',
  "status" TEXT NOT NULL DEFAULT 'AWAITING_PAYMENT',
  "snapshotJson" JSONB NOT NULL DEFAULT '{}',
  "reviewedByAdminId" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "paymentId" TEXT,
  "activatedSubscriptionId" TEXT,
  "adminComment" TEXT,
  "rejectionReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SubscriptionRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "SubscriptionRequest_tenantId_status_createdAt_idx"
  ON "SubscriptionRequest"("tenantId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "SubscriptionRequest_status_createdAt_idx"
  ON "SubscriptionRequest"("status", "createdAt");

CREATE TABLE IF NOT EXISTS "BillingPayment" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "subscriptionRequestId" TEXT,
  "amountMinor" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'KZT',
  "method" TEXT NOT NULL DEFAULT 'MANUAL',
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "externalReference" TEXT,
  "confirmedByAdminId" TEXT,
  "confirmedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BillingPayment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "BillingPayment_tenantId_createdAt_idx" ON "BillingPayment"("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "BillingPayment_subscriptionRequestId_idx" ON "BillingPayment"("subscriptionRequestId");

CREATE TABLE IF NOT EXISTS "TenantBillingOverride" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "featuresJson" JSONB NOT NULL DEFAULT '{}',
  "limitsJson" JSONB NOT NULL DEFAULT '{}',
  "customPriceMinor" INTEGER,
  "reason" TEXT,
  "createdByUserId" TEXT,
  "updatedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TenantBillingOverride_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "TenantBillingOverride_tenantId_key" ON "TenantBillingOverride"("tenantId");
