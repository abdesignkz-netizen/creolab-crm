-- Additive only: preserve every existing stage, deal and history entry.
ALTER TABLE "DealStage" ADD COLUMN IF NOT EXISTS "isArchived" BOOLEAN NOT NULL DEFAULT false;
