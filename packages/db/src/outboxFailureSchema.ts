/** Additive upgrade: preserve historical attempts and all unfinished jobs. */
export const OUTBOX_FAILURE_SQL = [
  `ALTER TABLE "OutboxEvent" ADD COLUMN IF NOT EXISTS "failedAt" TIMESTAMP(3)`,
  `ALTER TABLE "OutboxEvent" ADD COLUMN IF NOT EXISTS "failureKind" TEXT`,
  `ALTER TABLE "OutboxEvent" ADD COLUMN IF NOT EXISTS "errorCode" TEXT`,
  // Nullable first: backfill only once, including jobs that already exhausted retries.
  `ALTER TABLE "OutboxEvent" ADD COLUMN IF NOT EXISTS "retryAttempts" INTEGER`,
  `UPDATE "OutboxEvent" SET "retryAttempts" = "attempts" WHERE "retryAttempts" IS NULL`,
  `ALTER TABLE "OutboxEvent" ALTER COLUMN "retryAttempts" SET DEFAULT 0`,
  `ALTER TABLE "OutboxEvent" ALTER COLUMN "retryAttempts" SET NOT NULL`,
  `CREATE INDEX IF NOT EXISTS "OutboxEvent_tenantId_failedAt_idx" ON "OutboxEvent" ("tenantId", "failedAt")`,
];
