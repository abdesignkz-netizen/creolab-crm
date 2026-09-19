-- Additive: BasQar in-app support center (FAQ + tickets).
-- Safe to run more than once. Does not drop tables or existing data.

CREATE TABLE IF NOT EXISTS "SupportArticle" (
  "id" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "keywords" TEXT NOT NULL DEFAULT '',
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isPopular" BOOLEAN NOT NULL DEFAULT false,
  "isPublished" BOOLEAN NOT NULL DEFAULT true,
  "relatedRoute" TEXT,
  "relatedLabel" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupportArticle_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SupportArticle_slug_key" ON "SupportArticle"("slug");
CREATE INDEX IF NOT EXISTS "SupportArticle_isPublished_isPopular_sortOrder_idx" ON "SupportArticle"("isPublished", "isPopular", "sortOrder");
CREATE INDEX IF NOT EXISTS "SupportArticle_category_sortOrder_idx" ON "SupportArticle"("category", "sortOrder");

CREATE TABLE IF NOT EXISTS "SupportArticleFeedback" (
  "id" TEXT NOT NULL,
  "articleId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "helpful" BOOLEAN NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupportArticleFeedback_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SupportArticleFeedback_articleId_userId_key" ON "SupportArticleFeedback"("articleId", "userId");
CREATE INDEX IF NOT EXISTS "SupportArticleFeedback_tenantId_createdAt_idx" ON "SupportArticleFeedback"("tenantId", "createdAt");

CREATE TABLE IF NOT EXISTS "SupportTicket" (
  "id" TEXT NOT NULL,
  "number" SERIAL NOT NULL,
  "tenantId" TEXT NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "assignedToUserId" TEXT,
  "subject" TEXT,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "priority" TEXT NOT NULL DEFAULT 'NORMAL',
  "sourceRoute" TEXT,
  "sourceModule" TEXT,
  "contextJson" JSONB NOT NULL DEFAULT '{}',
  "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "customerUnread" INTEGER NOT NULL DEFAULT 0,
  "adminUnread" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SupportTicket_number_key" ON "SupportTicket"("number");
CREATE INDEX IF NOT EXISTS "SupportTicket_tenantId_status_lastMessageAt_idx" ON "SupportTicket"("tenantId", "status", "lastMessageAt");
CREATE INDEX IF NOT EXISTS "SupportTicket_status_lastMessageAt_idx" ON "SupportTicket"("status", "lastMessageAt");
CREATE INDEX IF NOT EXISTS "SupportTicket_assignedToUserId_status_idx" ON "SupportTicket"("assignedToUserId", "status");
CREATE INDEX IF NOT EXISTS "SupportTicket_createdByUserId_tenantId_idx" ON "SupportTicket"("createdByUserId", "tenantId");

CREATE TABLE IF NOT EXISTS "SupportMessage" (
  "id" TEXT NOT NULL,
  "ticketId" TEXT NOT NULL,
  "senderUserId" TEXT,
  "senderType" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'TEXT',
  "content" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupportMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "SupportMessage_ticketId_createdAt_idx" ON "SupportMessage"("ticketId", "createdAt");

CREATE TABLE IF NOT EXISTS "SupportQuickReply" (
  "id" TEXT NOT NULL,
  "shortcut" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupportQuickReply_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SupportQuickReply_shortcut_key" ON "SupportQuickReply"("shortcut");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SupportArticleFeedback_articleId_fkey'
  ) THEN
    ALTER TABLE "SupportArticleFeedback"
      ADD CONSTRAINT "SupportArticleFeedback_articleId_fkey"
      FOREIGN KEY ("articleId") REFERENCES "SupportArticle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SupportArticleFeedback_tenantId_fkey'
  ) THEN
    ALTER TABLE "SupportArticleFeedback"
      ADD CONSTRAINT "SupportArticleFeedback_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SupportTicket_tenantId_fkey'
  ) THEN
    ALTER TABLE "SupportTicket"
      ADD CONSTRAINT "SupportTicket_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SupportMessage_ticketId_fkey'
  ) THEN
    ALTER TABLE "SupportMessage"
      ADD CONSTRAINT "SupportMessage_ticketId_fkey"
      FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
