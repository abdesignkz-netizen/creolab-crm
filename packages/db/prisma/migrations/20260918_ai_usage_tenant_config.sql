-- Additive: tenant AI prompt/knowledge + internal AI usage telemetry.

ALTER TABLE "AIConfiguration" ADD COLUMN IF NOT EXISTS "systemPrompt" TEXT;
ALTER TABLE "AIConfiguration" ADD COLUMN IF NOT EXISTS "draftPrompt" TEXT;
ALTER TABLE "AIConfiguration" ADD COLUMN IF NOT EXISTS "promptStatus" TEXT DEFAULT 'draft';
ALTER TABLE "AIConfiguration" ADD COLUMN IF NOT EXISTS "promptUpdatedAt" TIMESTAMP(3);
ALTER TABLE "AIConfiguration" ADD COLUMN IF NOT EXISTS "promptUpdatedById" TEXT;
ALTER TABLE "AIConfiguration" ADD COLUMN IF NOT EXISTS "temperature" DOUBLE PRECISION;
ALTER TABLE "AIConfiguration" ADD COLUMN IF NOT EXISTS "maxOutputTokens" INTEGER;

CREATE TABLE IF NOT EXISTS "KnowledgeDocument" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "content" TEXT NOT NULL DEFAULT '',
  "sourceType" TEXT NOT NULL DEFAULT 'text',
  "status" TEXT NOT NULL DEFAULT 'draft',
  "publishedAt" TIMESTAMP(3),
  "updatedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "KnowledgeDocument_tenantId_status_idx" ON "KnowledgeDocument"("tenantId", "status");

CREATE TABLE IF NOT EXISTS "AIUsageEvent" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT,
  "integrationId" TEXT,
  "conversationId" TEXT,
  "userId" TEXT,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "feature" TEXT NOT NULL,
  "providerRequestId" TEXT,
  "inputTokens" INTEGER,
  "outputTokens" INTEGER,
  "cachedInputTokens" INTEGER,
  "reasoningTokens" INTEGER,
  "totalTokens" INTEGER,
  "inputUnitPrice" DECIMAL(18,8),
  "outputUnitPrice" DECIMAL(18,8),
  "cachedInputUnitPrice" DECIMAL(18,8),
  "inputCost" DECIMAL(18,8),
  "outputCost" DECIMAL(18,8),
  "cachedInputCost" DECIMAL(18,8),
  "totalCost" DECIMAL(18,8),
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "pricingVersion" TEXT,
  "pricingMissing" BOOLEAN NOT NULL DEFAULT false,
  "latencyMs" INTEGER,
  "status" TEXT NOT NULL,
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AIUsageEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AIUsageEvent_tenantId_createdAt_idx" ON "AIUsageEvent"("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "AIUsageEvent_feature_createdAt_idx" ON "AIUsageEvent"("feature", "createdAt");
CREATE INDEX IF NOT EXISTS "AIUsageEvent_provider_model_createdAt_idx" ON "AIUsageEvent"("provider", "model", "createdAt");
CREATE INDEX IF NOT EXISTS "AIUsageEvent_providerRequestId_idx" ON "AIUsageEvent"("providerRequestId");

CREATE TABLE IF NOT EXISTS "AIModelPricing" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "pricingVersion" TEXT NOT NULL,
  "inputPerMillion" DECIMAL(18,8) NOT NULL,
  "outputPerMillion" DECIMAL(18,8) NOT NULL,
  "cachedInputPerMillion" DECIMAL(18,8),
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "effectiveTo" TIMESTAMP(3),
  CONSTRAINT "AIModelPricing_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "AIModelPricing_provider_model_effectiveFrom_idx" ON "AIModelPricing"("provider", "model", "effectiveFrom");
