CREATE TABLE IF NOT EXISTS "SituationSweepState" (
  "tenantId" TEXT PRIMARY KEY REFERENCES "Tenant"("id") ON DELETE CASCADE,
  "cursorsJson" JSONB NOT NULL DEFAULT '{}', "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastCompletedAt" TIMESTAMP(3)
);
CREATE INDEX IF NOT EXISTS "SituationSweepState_nextRunAt_idx" ON "SituationSweepState"("nextRunAt");
ALTER TABLE "ControlNotificationItem" ADD COLUMN IF NOT EXISTS "episodeOccurrence" INTEGER;
ALTER TABLE "ControlNotificationItem" ADD COLUMN IF NOT EXISTS "suppressedAt" TIMESTAMP(3);
ALTER TABLE "ControlNotificationItem" ADD COLUMN IF NOT EXISTS "suppressionReason" TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ControlNotificationItem' AND column_name = 'episodeId') THEN
    ALTER TABLE "ControlNotificationItem" ADD COLUMN "episodeId" TEXT REFERENCES "SituationEpisode"("id") ON DELETE CASCADE;
    UPDATE "ControlNotificationItem" SET "suppressedAt" = CURRENT_TIMESTAMP, "suppressionReason" = 'legacy_unverified'
    WHERE "category" IN ('new_inquiries', 'dialogs', 'ai_events', 'tasks') AND "suppressedAt" IS NULL
      AND ("batchId" IS NULL OR "batchId" IN (SELECT "id" FROM "ControlNotificationBatch" WHERE "state" = 'queued'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "ControlNotificationItem_episodeId_idx" ON "ControlNotificationItem"("episodeId");
