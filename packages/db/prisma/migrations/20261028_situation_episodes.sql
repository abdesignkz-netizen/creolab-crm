-- Situation lifecycle; identical additive statements run by database bootstrap.
ALTER TABLE "SituationSnooze" ADD COLUMN IF NOT EXISTS "evidenceKey" TEXT;

CREATE TABLE IF NOT EXISTS "SituationEpisode" (
    "id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
    "itemId" TEXT NOT NULL, "title" TEXT NOT NULL, "state" TEXT NOT NULL DEFAULT 'open',
    "occurrence" INTEGER NOT NULL DEFAULT 1, "version" INTEGER NOT NULL DEFAULT 1, "evidenceKey" TEXT NOT NULL,
    "assignedMembershipId" TEXT, "taskId" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "resolvedAt" TIMESTAMP(3));

CREATE UNIQUE INDEX IF NOT EXISTS "SituationEpisode_tenantId_itemId_key" ON "SituationEpisode"("tenantId", "itemId");

CREATE UNIQUE INDEX IF NOT EXISTS "SituationEpisode_tenantId_id_key" ON "SituationEpisode"("tenantId", "id");

CREATE INDEX IF NOT EXISTS "SituationEpisode_tenantId_state_checkedAt_idx" ON "SituationEpisode"("tenantId", "state", "checkedAt");

CREATE INDEX IF NOT EXISTS "SituationEpisode_tenantId_updatedAt_idx" ON "SituationEpisode"("tenantId", "updatedAt");

CREATE TABLE IF NOT EXISTS "SituationEpisodeEvent" (
    "id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "episodeId" TEXT NOT NULL, "version" INTEGER NOT NULL,
    "kind" TEXT NOT NULL, "actorUserId" TEXT, "detailsJson" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("tenantId", "episodeId") REFERENCES "SituationEpisode"("tenantId", "id") ON DELETE CASCADE);

CREATE UNIQUE INDEX IF NOT EXISTS "SituationEpisodeEvent_episodeId_version_key" ON "SituationEpisodeEvent"("episodeId", "version");

CREATE INDEX IF NOT EXISTS "SituationEpisodeEvent_tenantId_episodeId_createdAt_idx" ON "SituationEpisodeEvent"("tenantId", "episodeId", "createdAt");
