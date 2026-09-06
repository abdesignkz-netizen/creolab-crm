import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { PGlite } from "@electric-sql/pglite";
import { PrismaPGlite } from "pglite-prisma-adapter";
import { readFile } from "node:fs/promises";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  pglite?: PGlite;
  crmDbShutdown?: boolean;
};

function isLivePostgresUrl(url: string | undefined): boolean {
  if (!url || !/^postgres(ql)?:\/\//i.test(url)) {
    return false;
  }
  if (process.env.CRM_USE_PGLITE === "1") {
    return false;
  }
  return !/unused|55432|example\.invalid/i.test(url);
}

async function applyInitSql(pglite: PGlite) {
  const check = await pglite.query("SELECT to_regclass('public.\"Tenant\"') AS t");
  const rows = (check.rows || []) as Array<{ t: string | null }>;
  if (rows[0]?.t) {
    return;
  }
  const sqlPath = path.resolve(process.cwd(), "packages/db/prisma/init.sql");
  const alt = path.resolve(import.meta.dirname, "../prisma/init.sql");
  const file = existsSync(sqlPath) ? sqlPath : alt;
  const sql = await readFile(file, "utf8");
  await pglite.exec(sql);
}

async function applyAdditiveSchema(pglite: PGlite) {
  await pglite.exec(`
    CREATE TABLE IF NOT EXISTS "SituationSnooze" (
      "id" TEXT NOT NULL,
      "tenantId" TEXT NOT NULL,
      "itemId" TEXT NOT NULL,
      "until" TIMESTAMP(3) NOT NULL,
      "byUserId" TEXT NOT NULL,
      "reason" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "SituationSnooze_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "SituationSnooze_tenantId_itemId_key" ON "SituationSnooze"("tenantId", "itemId");
    CREATE INDEX IF NOT EXISTS "SituationSnooze_tenantId_until_idx" ON "SituationSnooze"("tenantId", "until");

    ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "firstName" TEXT;
    ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "lastName" TEXT;
    ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "middleName" TEXT;
    ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "jobTitle" TEXT;
    ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "city" TEXT;
    ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "country" TEXT;
    ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "lifecycleStatus" TEXT DEFAULT 'new';
    ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "leadTemperature" TEXT DEFAULT 'unknown';
    ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "leadScore" INTEGER;
    ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);
    ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "lastInboundMessageAt" TIMESTAMP(3);
    ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "lastOutboundMessageAt" TIMESTAMP(3);
    ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "lastContactAt" TIMESTAMP(3);
    ALTER TABLE "Contact" ADD COLUMN IF NOT EXISTS "attributionJson" JSONB DEFAULT '{}';

    ALTER TABLE "Inquiry" ADD COLUMN IF NOT EXISTS "service" TEXT;
    ALTER TABLE "Inquiry" ADD COLUMN IF NOT EXISTS "budgetMin" INTEGER;
    ALTER TABLE "Inquiry" ADD COLUMN IF NOT EXISTS "budgetMax" INTEGER;
    ALTER TABLE "Inquiry" ADD COLUMN IF NOT EXISTS "currency" TEXT DEFAULT 'KZT';
    ALTER TABLE "Inquiry" ADD COLUMN IF NOT EXISTS "desiredDeadline" TEXT;
    ALTER TABLE "Inquiry" ADD COLUMN IF NOT EXISTS "sourceType" TEXT;
    ALTER TABLE "Inquiry" ADD COLUMN IF NOT EXISTS "sourceChannel" TEXT;
    ALTER TABLE "Inquiry" ADD COLUMN IF NOT EXISTS "sourceIntegration" TEXT;
    ALTER TABLE "Inquiry" ADD COLUMN IF NOT EXISTS "utmSource" TEXT;
    ALTER TABLE "Inquiry" ADD COLUMN IF NOT EXISTS "utmMedium" TEXT;
    ALTER TABLE "Inquiry" ADD COLUMN IF NOT EXISTS "utmCampaign" TEXT;
    ALTER TABLE "Inquiry" ADD COLUMN IF NOT EXISTS "utmContent" TEXT;
    ALTER TABLE "Inquiry" ADD COLUMN IF NOT EXISTS "utmTerm" TEXT;
    ALTER TABLE "Inquiry" ADD COLUMN IF NOT EXISTS "landingPage" TEXT;
    ALTER TABLE "Inquiry" ADD COLUMN IF NOT EXISTS "referrer" TEXT;
    ALTER TABLE "Inquiry" ADD COLUMN IF NOT EXISTS "lostReason" TEXT;
    ALTER TABLE "Inquiry" ADD COLUMN IF NOT EXISTS "lostComment" TEXT;
    ALTER TABLE "Inquiry" ADD COLUMN IF NOT EXISTS "fieldMetaJson" JSONB DEFAULT '{}';
    ALTER TABLE "Inquiry" ADD COLUMN IF NOT EXISTS "serviceCategory" TEXT;
    ALTER TABLE "Inquiry" ADD COLUMN IF NOT EXISTS "serviceSubcategory" TEXT;
    ALTER TABLE "Inquiry" ADD COLUMN IF NOT EXISTS "companyName" TEXT;
    ALTER TABLE "Inquiry" ADD COLUMN IF NOT EXISTS "city" TEXT;
    ALTER TABLE "Inquiry" ADD COLUMN IF NOT EXISTS "aiSummary" TEXT;
    ALTER TABLE "Inquiry" ADD COLUMN IF NOT EXISTS "classification" TEXT;
    ALTER TABLE "Inquiry" ADD COLUMN IF NOT EXISTS "needsReply" BOOLEAN DEFAULT true;
    ALTER TABLE "Inquiry" ADD COLUMN IF NOT EXISTS "firstContactAt" TIMESTAMP(3);
    ALTER TABLE "Inquiry" ADD COLUMN IF NOT EXISTS "qualifiedAt" TIMESTAMP(3);
    ALTER TABLE "Inquiry" ADD COLUMN IF NOT EXISTS "convertedAt" TIMESTAMP(3);
    ALTER TABLE "Inquiry" ADD COLUMN IF NOT EXISTS "lostAt" TIMESTAMP(3);
    ALTER TABLE "Inquiry" ADD COLUMN IF NOT EXISTS "closedAt" TIMESTAMP(3);
    ALTER TABLE "Inquiry" ALTER COLUMN "phoneRaw" SET DEFAULT '';
    ALTER TABLE "Inquiry" ALTER COLUMN "phoneNormalized" SET DEFAULT '';
    ALTER TABLE "Inquiry" ALTER COLUMN "phoneSource" SET DEFAULT 'unknown';
    CREATE INDEX IF NOT EXISTS "Inquiry_tenantId_needsReply_receivedAt_idx"
      ON "Inquiry"("tenantId", "needsReply", "receivedAt");

    CREATE TABLE IF NOT EXISTS "InquiryStatusHistory" (
      "id" TEXT NOT NULL,
      "tenantId" TEXT NOT NULL,
      "inquiryId" TEXT NOT NULL,
      "fromStatus" TEXT,
      "toStatus" TEXT NOT NULL,
      "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "changedByType" TEXT NOT NULL DEFAULT 'system',
      "changedById" TEXT,
      "note" TEXT,
      CONSTRAINT "InquiryStatusHistory_pkey" PRIMARY KEY ("id")
    );
    CREATE INDEX IF NOT EXISTS "InquiryStatusHistory_tenantId_inquiryId_changedAt_idx"
      ON "InquiryStatusHistory"("tenantId", "inquiryId", "changedAt");
    CREATE INDEX IF NOT EXISTS "InquiryStatusHistory_inquiryId_changedAt_idx"
      ON "InquiryStatusHistory"("inquiryId", "changedAt");

    ALTER TABLE "Note" ADD COLUMN IF NOT EXISTS "pinned" BOOLEAN DEFAULT false;

    ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "targetType" TEXT DEFAULT 'none';
    ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "parentTaskId" TEXT;
    ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "segmentSnapshotJson" JSONB DEFAULT '{}';
    ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "executionStatus" TEXT DEFAULT 'none';
    ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "messageDraft" TEXT;
    ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "resultCode" TEXT;
    ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "resultText" TEXT;
    ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "completionSource" TEXT;
    ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "confirmedAt" TIMESTAMP(3);
    ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "sentAt" TIMESTAMP(3);
    ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "rawCommandText" TEXT;
    ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "parsedCommandJson" JSONB DEFAULT '{}';
    ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "commandStatus" TEXT DEFAULT 'none';
    CREATE INDEX IF NOT EXISTS "Task_tenantId_parentTaskId_idx" ON "Task"("tenantId", "parentTaskId");
    CREATE INDEX IF NOT EXISTS "Task_tenantId_targetType_status_idx" ON "Task"("tenantId", "targetType", "status");
    CREATE INDEX IF NOT EXISTS "Task_tenantId_executionStatus_idx" ON "Task"("tenantId", "executionStatus");
    CREATE INDEX IF NOT EXISTS "Task_tenantId_commandStatus_idx" ON "Task"("tenantId", "commandStatus");

    ALTER TABLE "Attachment" ADD COLUMN IF NOT EXISTS "originalFileName" TEXT;
    ALTER TABLE "Attachment" ADD COLUMN IF NOT EXISTS "documentType" TEXT DEFAULT 'document';
    ALTER TABLE "Attachment" ADD COLUMN IF NOT EXISTS "uploadedById" TEXT;
    ALTER TABLE "Attachment" ADD COLUMN IF NOT EXISTS "sendState" TEXT DEFAULT 'pending';
    ALTER TABLE "Attachment" ADD COLUMN IF NOT EXISTS "sendError" TEXT;
    ALTER TABLE "Attachment" ADD COLUMN IF NOT EXISTS "providerMessageId" TEXT;
    ALTER TABLE "Attachment" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;

    CREATE TABLE IF NOT EXISTS "ExecutionConfirmation" (
      "id" TEXT NOT NULL,
      "tenantId" TEXT NOT NULL,
      "taskId" TEXT NOT NULL,
      "contactId" TEXT,
      "inquiryId" TEXT,
      "dealId" TEXT,
      "conversationId" TEXT,
      "channel" TEXT NOT NULL,
      "destination" TEXT,
      "messageSnapshot" TEXT,
      "attachmentSnapshotsJson" JSONB NOT NULL DEFAULT '[]',
      "contentHash" TEXT NOT NULL,
      "confirmedById" TEXT,
      "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "voidedAt" TIMESTAMP(3),
      CONSTRAINT "ExecutionConfirmation_pkey" PRIMARY KEY ("id")
    );
    CREATE INDEX IF NOT EXISTS "ExecutionConfirmation_tenantId_taskId_confirmedAt_idx"
      ON "ExecutionConfirmation"("tenantId", "taskId", "confirmedAt");

    CREATE TABLE IF NOT EXISTS "Tag" (
      "id" TEXT NOT NULL,
      "tenantId" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "Tag_tenantId_name_key" ON "Tag"("tenantId", "name");

    CREATE TABLE IF NOT EXISTS "ContactTag" (
      "id" TEXT NOT NULL,
      "tenantId" TEXT NOT NULL,
      "contactId" TEXT NOT NULL,
      "tagId" TEXT NOT NULL,
      CONSTRAINT "ContactTag_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "ContactTag_tenantId_contactId_tagId_key" ON "ContactTag"("tenantId", "contactId", "tagId");

    CREATE TABLE IF NOT EXISTS "Activity" (
      "id" TEXT NOT NULL,
      "tenantId" TEXT NOT NULL,
      "contactId" TEXT NOT NULL,
      "inquiryId" TEXT,
      "type" TEXT NOT NULL,
      "title" TEXT NOT NULL,
      "description" TEXT,
      "actorType" TEXT NOT NULL DEFAULT 'system',
      "actorId" TEXT,
      "metadataJson" JSONB NOT NULL DEFAULT '{}',
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
    );
    CREATE INDEX IF NOT EXISTS "Activity_tenantId_contactId_createdAt_idx" ON "Activity"("tenantId", "contactId", "createdAt");

    CREATE TABLE IF NOT EXISTS "Campaign" (
      "id" TEXT NOT NULL,
      "tenantId" TEXT NOT NULL,
      "title" TEXT NOT NULL,
      "channel" TEXT NOT NULL DEFAULT 'whatsapp',
      "status" TEXT NOT NULL DEFAULT 'draft',
      "source" TEXT NOT NULL DEFAULT 'manual',
      "messageDraft" TEXT,
      "messageMode" TEXT NOT NULL DEFAULT 'manual',
      "createMissingClients" BOOLEAN NOT NULL DEFAULT true,
      "scheduledAt" TIMESTAMP(3),
      "startedAt" TIMESTAMP(3),
      "completedAt" TIMESTAMP(3),
      "pausedAt" TIMESTAMP(3),
      "confirmedAt" TIMESTAMP(3),
      "confirmedById" TEXT,
      "contentHash" TEXT,
      "messageSnapshot" TEXT,
      "attachmentSnapshotsJson" JSONB NOT NULL DEFAULT '[]',
      "recipientSnapshotJson" JSONB NOT NULL DEFAULT '[]',
      "statsJson" JSONB NOT NULL DEFAULT '{}',
      "segmentSnapshotJson" JSONB NOT NULL DEFAULT '{}',
      "rawCommandText" TEXT,
      "parsedCommandJson" JSONB NOT NULL DEFAULT '{}',
      "createdByMembershipId" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
    );
    CREATE INDEX IF NOT EXISTS "Campaign_tenantId_status_scheduledAt_idx" ON "Campaign"("tenantId", "status", "scheduledAt");
    CREATE INDEX IF NOT EXISTS "Campaign_tenantId_createdAt_idx" ON "Campaign"("tenantId", "createdAt");

    CREATE TABLE IF NOT EXISTS "CampaignRecipient" (
      "id" TEXT NOT NULL,
      "tenantId" TEXT NOT NULL,
      "campaignId" TEXT NOT NULL,
      "contactId" TEXT,
      "phoneRaw" TEXT,
      "phoneNormalized" TEXT,
      "displayName" TEXT,
      "status" TEXT NOT NULL DEFAULT 'pending',
      "skipReason" TEXT,
      "error" TEXT,
      "textSendState" TEXT NOT NULL DEFAULT 'none',
      "filesSendState" TEXT NOT NULL DEFAULT 'none',
      "providerMessageId" TEXT,
      "sentAt" TIMESTAMP(3),
      "deliveredAt" TIMESTAMP(3),
      "readAt" TIMESTAMP(3),
      "repliedAt" TIMESTAMP(3),
      "conversationId" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "CampaignRecipient_pkey" PRIMARY KEY ("id")
    );
    CREATE INDEX IF NOT EXISTS "CampaignRecipient_tenantId_campaignId_status_idx" ON "CampaignRecipient"("tenantId", "campaignId", "status");
    CREATE INDEX IF NOT EXISTS "CampaignRecipient_tenantId_phoneNormalized_idx" ON "CampaignRecipient"("tenantId", "phoneNormalized");
    CREATE INDEX IF NOT EXISTS "CampaignRecipient_tenantId_contactId_idx" ON "CampaignRecipient"("tenantId", "contactId");

    ALTER TABLE "DealStage" ADD COLUMN IF NOT EXISTS "defaultProbability" INTEGER DEFAULT 10;
    ALTER TABLE "DealStage" ADD COLUMN IF NOT EXISTS "isTerminal" BOOLEAN DEFAULT false;

    ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS "probability" INTEGER DEFAULT 10;
    ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS "paymentStatus" TEXT DEFAULT 'NOT_INVOICED';
    ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS "fulfillmentStatus" TEXT DEFAULT 'NOT_STARTED';
    ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
    ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS "stageEnteredAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
    ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS "wonAt" TIMESTAMP(3);
    ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS "lostAt" TIMESTAMP(3);
    ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS "wonAmountMinor" DECIMAL(18,0);

    CREATE TABLE IF NOT EXISTS "DealStageHistory" (
      "id" TEXT NOT NULL,
      "tenantId" TEXT NOT NULL,
      "dealId" TEXT NOT NULL,
      "fromStageId" TEXT,
      "fromSystemKey" TEXT,
      "toStageId" TEXT NOT NULL,
      "toSystemKey" TEXT NOT NULL,
      "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "leftAt" TIMESTAMP(3),
      "changedByType" TEXT NOT NULL DEFAULT 'system',
      "changedById" TEXT,
      "note" TEXT,
      CONSTRAINT "DealStageHistory_pkey" PRIMARY KEY ("id")
    );
    CREATE INDEX IF NOT EXISTS "DealStageHistory_tenantId_dealId_enteredAt_idx"
      ON "DealStageHistory"("tenantId", "dealId", "enteredAt");
    CREATE INDEX IF NOT EXISTS "DealStageHistory_dealId_enteredAt_idx"
      ON "DealStageHistory"("dealId", "enteredAt");

    ALTER TABLE "Activity" ADD COLUMN IF NOT EXISTS "dealId" TEXT;
    CREATE INDEX IF NOT EXISTS "Activity_tenantId_dealId_createdAt_idx"
      ON "Activity"("tenantId", "dealId", "createdAt");

    ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "recurrenceRule" TEXT;
    ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "completionResult" TEXT;
  `);
}

export async function createPrismaClient(): Promise<PrismaClient> {
  if (globalForPrisma.prisma) {
    return globalForPrisma.prisma;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (isLivePostgresUrl(databaseUrl)) {
    const prisma = new PrismaClient({
      datasourceUrl: databaseUrl,
    });
    globalForPrisma.prisma = prisma;
    return prisma;
  }

  const dataDir = path.resolve(
    process.env.CRM_PGLITE_DIR || path.resolve(import.meta.dirname, "../../../data/pglite"),
  );
  mkdirSync(dataDir, { recursive: true });
  const pidFile = path.join(dataDir, "postmaster.pid");
  if (existsSync(pidFile) && !globalForPrisma.pglite) {
    try {
      unlinkSync(pidFile);
    } catch {
      /* stale lock from a crashed WASM postgres */
    }
  }

  let pglite = globalForPrisma.pglite;
  if (!pglite) {
    try {
      pglite = new PGlite(dataDir);
      await pglite.waitReady;
    } catch (error) {
      if (existsSync(pidFile)) {
        try {
          unlinkSync(pidFile);
        } catch {
          /* retry without leftover lock */
        }
      }
      pglite = new PGlite(dataDir);
      await pglite.waitReady;
    }
  }
  globalForPrisma.pglite = pglite;
  await applyInitSql(pglite);
  await applyAdditiveSchema(pglite);
  const adapter = new PrismaPGlite(pglite);
  const prisma = new PrismaClient({ adapter } as never);
  globalForPrisma.prisma = prisma;
  if (!globalForPrisma.crmDbShutdown) {
    globalForPrisma.crmDbShutdown = true;
    const close = async () => {
      try {
        await prisma.$disconnect();
      } catch {
        /* already closed */
      }
      try {
        await pglite.close();
      } catch {
        /* already closed */
      }
      globalForPrisma.prisma = undefined;
      globalForPrisma.pglite = undefined;
    };
    process.once("SIGTERM", () => {
      void close().finally(() => process.exit(0));
    });
    process.once("SIGINT", () => {
      void close().finally(() => process.exit(0));
    });
  }
  return prisma;
}

export type { PrismaClient };
