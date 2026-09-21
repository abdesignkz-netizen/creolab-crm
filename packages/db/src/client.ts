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

async function applyLivePostgresPatches(prisma: PrismaClient) {
  const statements = [
    `ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "personalizeEach" BOOLEAN DEFAULT false`,
    `ALTER TABLE "CampaignRecipient" ADD COLUMN IF NOT EXISTS "messageDraft" TEXT`,
    ...DOCUMENT_DOMAIN_SQL.split(";")
      .map((s) => s.trim())
      .filter(Boolean),
    ...ACCOUNT_DOMAIN_SQL.split(";")
      .map((s) => s.trim())
      .filter(Boolean),
    ...PLATFORM_DOMAIN_SQL.split(";")
      .map((s) => s.trim())
      .filter(Boolean),
    ...AI_DOMAIN_SQL.split(";")
      .map((s) => s.trim())
      .filter(Boolean),
    ...SUPPORT_DOMAIN_SQL.split(";")
      .map((s) => s.trim())
      .filter(Boolean),
    ...CONTROL_DOMAIN_SQL.split(";")
      .map((s) => s.trim())
      .filter(Boolean),
    ...BILLING_DOMAIN_SQL.split(";")
      .map((s) => s.trim())
      .filter(Boolean),
  ];
  for (const sql of statements) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (error) {
      console.error("[db] additive patch failed", sql, error);
    }
  }
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
      "personalizeEach" BOOLEAN NOT NULL DEFAULT false,
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
    CREATE UNIQUE INDEX IF NOT EXISTS "Campaign_tenantId_id_key" ON "Campaign"("tenantId", "id");

    CREATE TABLE IF NOT EXISTS "CampaignRecipient" (
      "id" TEXT NOT NULL,
      "tenantId" TEXT NOT NULL,
      "campaignId" TEXT NOT NULL,
      "contactId" TEXT,
      "phoneRaw" TEXT,
      "phoneNormalized" TEXT,
      "displayName" TEXT,
      "messageDraft" TEXT,
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

    ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "personalizeEach" BOOLEAN DEFAULT false;
    ALTER TABLE "CampaignRecipient" ADD COLUMN IF NOT EXISTS "messageDraft" TEXT;

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
    ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "agreementId" TEXT;
    ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "contextSnapshotJson" JSONB DEFAULT '{}';
    ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "sourceMessageIdsJson" JSONB DEFAULT '[]';
    ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "purpose" TEXT;
    ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "briefingText" TEXT;
    ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "preparationHintsJson" JSONB DEFAULT '[]';

    ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "waitingFor" TEXT DEFAULT 'NONE';
    ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "contextSummary" TEXT;
    ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "lastContextAnalyzedAt" TIMESTAMP(3);
    ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "lastAnalyzedMessageId" TEXT;

    CREATE TABLE IF NOT EXISTS "Agreement" (
      "id" TEXT NOT NULL,
      "tenantId" TEXT NOT NULL,
      "contactId" TEXT,
      "inquiryId" TEXT,
      "dealId" TEXT,
      "conversationId" TEXT,
      "type" TEXT NOT NULL,
      "title" TEXT NOT NULL,
      "summary" TEXT,
      "purpose" TEXT,
      "status" TEXT NOT NULL DEFAULT 'DETECTED',
      "scheduledAt" TIMESTAMP(3),
      "scheduledEndAt" TIMESTAMP(3),
      "previousScheduledAt" TIMESTAMP(3),
      "responsibleMembershipId" TEXT,
      "locationName" TEXT,
      "address" TEXT,
      "meetingProvider" TEXT,
      "meetingUrl" TEXT,
      "meetingId" TEXT,
      "meetingPassword" TEXT,
      "phone" TEXT,
      "sourceMessageIdsJson" JSONB NOT NULL DEFAULT '[]',
      "contextSnapshotJson" JSONB NOT NULL DEFAULT '{}',
      "remindersJson" JSONB NOT NULL DEFAULT '[]',
      "confidence" TEXT NOT NULL DEFAULT 'MEDIUM',
      "detectedBy" TEXT NOT NULL DEFAULT 'context_engine',
      "clarificationNeeded" TEXT,
      "dedupeKey" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "completedAt" TIMESTAMP(3),
      "cancelledAt" TIMESTAMP(3),
      CONSTRAINT "Agreement_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "Agreement_tenantId_id_key" ON "Agreement"("tenantId", "id");
    CREATE UNIQUE INDEX IF NOT EXISTS "Agreement_tenantId_dedupeKey_key" ON "Agreement"("tenantId", "dedupeKey");
    CREATE INDEX IF NOT EXISTS "Agreement_tenantId_status_scheduledAt_idx" ON "Agreement"("tenantId", "status", "scheduledAt");
    CREATE INDEX IF NOT EXISTS "Agreement_tenantId_conversationId_status_idx" ON "Agreement"("tenantId", "conversationId", "status");
    CREATE INDEX IF NOT EXISTS "Agreement_tenantId_contactId_status_idx" ON "Agreement"("tenantId", "contactId", "status");
    CREATE INDEX IF NOT EXISTS "Agreement_tenantId_type_status_idx" ON "Agreement"("tenantId", "type", "status");
    CREATE UNIQUE INDEX IF NOT EXISTS "Task_agreementId_key" ON "Task"("agreementId");

    CREATE TABLE IF NOT EXISTS "Company" (
      "id" TEXT NOT NULL,
      "tenantId" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "legalName" TEXT,
      "shortName" TEXT,
      "nameNormalized" TEXT,
      "bin" TEXT,
      "industry" TEXT,
      "website" TEXT,
      "email" TEXT,
      "phone" TEXT,
      "phoneNormalized" TEXT,
      "country" TEXT,
      "city" TEXT,
      "address" TEXT,
      "description" TEXT,
      "lifecycleStatus" TEXT NOT NULL DEFAULT 'PROSPECT',
      "assigneeMembershipId" TEXT,
      "initialSource" TEXT,
      "bankDetailsJson" JSONB NOT NULL DEFAULT '{}',
      "firstContactAt" TIMESTAMP(3),
      "lastActivityAt" TIMESTAMP(3),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "archivedAt" TIMESTAMP(3),
      "version" INTEGER NOT NULL DEFAULT 1,
      CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "Company_tenantId_id_key" ON "Company"("tenantId", "id");
    CREATE INDEX IF NOT EXISTS "Company_tenantId_name_idx" ON "Company"("tenantId", "name");
    CREATE INDEX IF NOT EXISTS "Company_tenantId_nameNormalized_idx" ON "Company"("tenantId", "nameNormalized");
    CREATE INDEX IF NOT EXISTS "Company_tenantId_bin_idx" ON "Company"("tenantId", "bin");
    CREATE INDEX IF NOT EXISTS "Company_tenantId_lastActivityAt_idx" ON "Company"("tenantId", "lastActivityAt");
    CREATE INDEX IF NOT EXISTS "Company_tenantId_assigneeMembershipId_idx" ON "Company"("tenantId", "assigneeMembershipId");
    CREATE INDEX IF NOT EXISTS "Company_tenantId_lifecycleStatus_archivedAt_idx" ON "Company"("tenantId", "lifecycleStatus", "archivedAt");

    CREATE TABLE IF NOT EXISTS "CompanyContact" (
      "id" TEXT NOT NULL,
      "tenantId" TEXT NOT NULL,
      "companyId" TEXT NOT NULL,
      "contactId" TEXT NOT NULL,
      "position" TEXT,
      "department" TEXT,
      "isPrimary" BOOLEAN NOT NULL DEFAULT false,
      "isDecisionMaker" BOOLEAN NOT NULL DEFAULT false,
      "isBillingContact" BOOLEAN NOT NULL DEFAULT false,
      "isActive" BOOLEAN NOT NULL DEFAULT true,
      "startedAt" TIMESTAMP(3),
      "endedAt" TIMESTAMP(3),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "CompanyContact_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "CompanyContact_tenantId_id_key" ON "CompanyContact"("tenantId", "id");
    CREATE UNIQUE INDEX IF NOT EXISTS "CompanyContact_tenantId_companyId_contactId_key" ON "CompanyContact"("tenantId", "companyId", "contactId");
    CREATE INDEX IF NOT EXISTS "CompanyContact_tenantId_contactId_idx" ON "CompanyContact"("tenantId", "contactId");
    CREATE INDEX IF NOT EXISTS "CompanyContact_tenantId_companyId_isPrimary_idx" ON "CompanyContact"("tenantId", "companyId", "isPrimary");

    CREATE TABLE IF NOT EXISTS "DealContact" (
      "id" TEXT NOT NULL,
      "tenantId" TEXT NOT NULL,
      "dealId" TEXT NOT NULL,
      "contactId" TEXT NOT NULL,
      "role" TEXT,
      "isPrimary" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "DealContact_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "DealContact_tenantId_id_key" ON "DealContact"("tenantId", "id");
    CREATE UNIQUE INDEX IF NOT EXISTS "DealContact_tenantId_dealId_contactId_key" ON "DealContact"("tenantId", "dealId", "contactId");
    CREATE INDEX IF NOT EXISTS "DealContact_tenantId_contactId_idx" ON "DealContact"("tenantId", "contactId");

    CREATE TABLE IF NOT EXISTS "CompanyTag" (
      "id" TEXT NOT NULL,
      "tenantId" TEXT NOT NULL,
      "companyId" TEXT NOT NULL,
      "tagId" TEXT NOT NULL,
      CONSTRAINT "CompanyTag_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "CompanyTag_tenantId_companyId_tagId_key" ON "CompanyTag"("tenantId", "companyId", "tagId");

    ALTER TABLE "Inquiry" ADD COLUMN IF NOT EXISTS "companyId" TEXT;
    ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS "companyId" TEXT;
    ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "companyId" TEXT;
    ALTER TABLE "Activity" ADD COLUMN IF NOT EXISTS "companyId" TEXT;
    CREATE INDEX IF NOT EXISTS "Inquiry_tenantId_companyId_idx" ON "Inquiry"("tenantId", "companyId");
    CREATE INDEX IF NOT EXISTS "Deal_tenantId_companyId_idx" ON "Deal"("tenantId", "companyId");
    CREATE INDEX IF NOT EXISTS "Task_tenantId_companyId_idx" ON "Task"("tenantId", "companyId");
    CREATE INDEX IF NOT EXISTS "Activity_tenantId_companyId_createdAt_idx" ON "Activity"("tenantId", "companyId", "createdAt");

    ALTER TABLE "Integration" ADD COLUMN IF NOT EXISTS "connectionStatus" TEXT DEFAULT 'pending';
    ALTER TABLE "Integration" ADD COLUMN IF NOT EXISTS "healthStatus" TEXT DEFAULT 'UNKNOWN';
    ALTER TABLE "Integration" ADD COLUMN IF NOT EXISTS "lastSuccessAt" TIMESTAMP(3);
    ALTER TABLE "Integration" ADD COLUMN IF NOT EXISTS "lastErrorAt" TIMESTAMP(3);
    ALTER TABLE "Integration" ADD COLUMN IF NOT EXISTS "lastErrorCode" TEXT;
    ALTER TABLE "Integration" ADD COLUMN IF NOT EXISTS "previousSecretHash" TEXT;
    ALTER TABLE "Integration" ADD COLUMN IF NOT EXISTS "previousSecretExpiresAt" TIMESTAMP(3);
    ALTER TABLE "Integration" ADD COLUMN IF NOT EXISTS "automationMode" TEXT;
    CREATE INDEX IF NOT EXISTS "Integration_tenantId_connectionStatus_healthStatus_idx"
      ON "Integration"("tenantId", "connectionStatus", "healthStatus");

    ALTER TABLE "InboundEvent" ADD COLUMN IF NOT EXISTS "provider" TEXT DEFAULT 'unknown';
    ALTER TABLE "InboundEvent" ADD COLUMN IF NOT EXISTS "eventType" TEXT DEFAULT 'LEAD_SUBMISSION';
    ALTER TABLE "InboundEvent" ADD COLUMN IF NOT EXISTS "status" TEXT DEFAULT 'RECEIVED';
    ALTER TABLE "InboundEvent" ADD COLUMN IF NOT EXISTS "attempts" INTEGER DEFAULT 0;
    ALTER TABLE "InboundEvent" ADD COLUMN IF NOT EXISTS "lastError" TEXT;
    ALTER TABLE "InboundEvent" ADD COLUMN IF NOT EXISTS "occurredAt" TIMESTAMP(3);
    CREATE INDEX IF NOT EXISTS "InboundEvent_tenantId_status_receivedAt_idx" ON "InboundEvent"("tenantId", "status", "receivedAt");
    CREATE INDEX IF NOT EXISTS "InboundEvent_tenantId_eventType_receivedAt_idx" ON "InboundEvent"("tenantId", "eventType", "receivedAt");

    UPDATE "Integration" SET "connectionStatus" = CASE
      WHEN "status" = 'active' THEN 'CONNECTED'
      WHEN "status" = 'pending' THEN 'PENDING'
      ELSE COALESCE(NULLIF("connectionStatus", ''), 'DISCONNECTED')
    END
    WHERE "connectionStatus" IS NULL OR "connectionStatus" = 'pending';

    UPDATE "Integration" SET "healthStatus" = CASE
      WHEN "lastError" IS NOT NULL AND "lastError" <> '' THEN 'ERROR'
      WHEN "lastEventAt" IS NULL THEN 'NO_EVENTS_YET'
      ELSE 'HEALTHY'
    END
    WHERE "healthStatus" IS NULL OR "healthStatus" = 'UNKNOWN';

    ${DOCUMENT_DOMAIN_SQL}
    ${ACCOUNT_DOMAIN_SQL}
    ${PLATFORM_DOMAIN_SQL}
    ${AI_DOMAIN_SQL}
    ${SUPPORT_DOMAIN_SQL}
    ${CONTROL_DOMAIN_SQL}
    ${BILLING_DOMAIN_SQL}
  `);
}

const DOCUMENT_DOMAIN_SQL = `
    ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "iin" TEXT;
    ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "legalAddress" TEXT;
    ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "vatPayer" BOOLEAN;
    ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "directorName" TEXT;
    ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "directorPosition" TEXT;
    ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "iban" TEXT;
    ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "bankName" TEXT;
    ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "bik" TEXT;

    CREATE TABLE IF NOT EXISTS "TenantLegalProfile" (
      "id" TEXT NOT NULL,
      "tenantId" TEXT NOT NULL,
      "legalName" TEXT,
      "shortName" TEXT,
      "bin" TEXT,
      "iin" TEXT,
      "legalAddress" TEXT,
      "actualAddress" TEXT,
      "iban" TEXT,
      "bankName" TEXT,
      "bik" TEXT,
      "vatPayer" BOOLEAN,
      "vatRegistrationNumber" TEXT,
      "defaultVatMode" TEXT,
      "defaultVatRate" DECIMAL(5,2),
      "directorName" TEXT,
      "directorPosition" TEXT,
      "email" TEXT,
      "phone" TEXT,
      "country" TEXT DEFAULT 'KZ',
      "currency" TEXT DEFAULT 'KZT',
      "documentsEnabled" BOOLEAN NOT NULL DEFAULT true,
      "contractSigningEnabled" BOOLEAN NOT NULL DEFAULT false,
      "esfIntegrationEnabled" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "TenantLegalProfile_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "TenantLegalProfile_tenantId_key" ON "TenantLegalProfile"("tenantId");
    CREATE UNIQUE INDEX IF NOT EXISTS "TenantLegalProfile_tenantId_id_key" ON "TenantLegalProfile"("tenantId", "id");

    CREATE TABLE IF NOT EXISTS "DealItem" (
      "id" TEXT NOT NULL,
      "tenantId" TEXT NOT NULL,
      "dealId" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "description" TEXT,
      "quantity" DECIMAL(12,3) NOT NULL,
      "unit" TEXT NOT NULL DEFAULT 'услуга',
      "unitPrice" DECIMAL(18,2) NOT NULL,
      "amountWithoutVat" DECIMAL(18,2) NOT NULL,
      "vatRate" DECIMAL(5,2) NOT NULL,
      "vatAmount" DECIMAL(18,2) NOT NULL,
      "totalAmount" DECIMAL(18,2) NOT NULL,
      "sortOrder" INTEGER NOT NULL DEFAULT 0,
      "catalogItemId" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "DealItem_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "DealItem_tenantId_id_key" ON "DealItem"("tenantId", "id");
    CREATE INDEX IF NOT EXISTS "DealItem_tenantId_dealId_sortOrder_idx" ON "DealItem"("tenantId", "dealId", "sortOrder");

    CREATE TABLE IF NOT EXISTS "Contract" (
      "id" TEXT NOT NULL,
      "tenantId" TEXT NOT NULL,
      "dealId" TEXT NOT NULL,
      "companyId" TEXT,
      "number" TEXT NOT NULL,
      "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "subject" TEXT,
      "amountWithoutVat" DECIMAL(18,2) NOT NULL,
      "vatRate" DECIMAL(5,2),
      "vatAmount" DECIMAL(18,2) NOT NULL,
      "totalAmount" DECIMAL(18,2) NOT NULL,
      "currency" TEXT NOT NULL DEFAULT 'KZT',
      "paymentTerms" TEXT,
      "completionTerms" TEXT,
      "status" TEXT NOT NULL DEFAULT 'DRAFT',
      "templateId" TEXT,
      "originalFileId" TEXT,
      "generatedFileId" TEXT,
      "finalSignedFileId" TEXT,
      "signedAt" TIMESTAMP(3),
      "createdByUserId" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "Contract_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "Contract_tenantId_id_key" ON "Contract"("tenantId", "id");
    CREATE UNIQUE INDEX IF NOT EXISTS "Contract_tenantId_number_key" ON "Contract"("tenantId", "number");
    CREATE INDEX IF NOT EXISTS "Contract_tenantId_dealId_status_idx" ON "Contract"("tenantId", "dealId", "status");

    CREATE TABLE IF NOT EXISTS "ContractVersion" (
      "id" TEXT NOT NULL,
      "tenantId" TEXT NOT NULL,
      "contractId" TEXT NOT NULL,
      "version" INTEGER NOT NULL,
      "fileId" TEXT,
      "sha256" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ContractVersion_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "ContractVersion_tenantId_id_key" ON "ContractVersion"("tenantId", "id");
    CREATE UNIQUE INDEX IF NOT EXISTS "ContractVersion_tenantId_contractId_version_key" ON "ContractVersion"("tenantId", "contractId", "version");

    CREATE TABLE IF NOT EXISTS "Invoice" (
      "id" TEXT NOT NULL,
      "tenantId" TEXT NOT NULL,
      "dealId" TEXT NOT NULL,
      "contractId" TEXT,
      "companyId" TEXT,
      "number" TEXT NOT NULL,
      "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "dueDate" TIMESTAMP(3),
      "currency" TEXT NOT NULL DEFAULT 'KZT',
      "amountWithoutVat" DECIMAL(18,2) NOT NULL,
      "vatRate" DECIMAL(5,2),
      "vatAmount" DECIMAL(18,2) NOT NULL,
      "totalAmount" DECIMAL(18,2) NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'DRAFT',
      "pdfFileId" TEXT,
      "createdByUserId" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "Invoice_tenantId_id_key" ON "Invoice"("tenantId", "id");
    CREATE UNIQUE INDEX IF NOT EXISTS "Invoice_tenantId_number_key" ON "Invoice"("tenantId", "number");
    CREATE INDEX IF NOT EXISTS "Invoice_tenantId_dealId_status_idx" ON "Invoice"("tenantId", "dealId", "status");

    CREATE TABLE IF NOT EXISTS "InvoiceItem" (
      "id" TEXT NOT NULL,
      "tenantId" TEXT NOT NULL,
      "invoiceId" TEXT NOT NULL,
      "dealItemId" TEXT,
      "name" TEXT NOT NULL,
      "description" TEXT,
      "quantity" DECIMAL(12,3) NOT NULL,
      "unit" TEXT NOT NULL DEFAULT 'услуга',
      "unitPrice" DECIMAL(18,2) NOT NULL,
      "amountWithoutVat" DECIMAL(18,2) NOT NULL,
      "vatRate" DECIMAL(5,2) NOT NULL,
      "vatAmount" DECIMAL(18,2) NOT NULL,
      "totalAmount" DECIMAL(18,2) NOT NULL,
      "sortOrder" INTEGER NOT NULL DEFAULT 0,
      CONSTRAINT "InvoiceItem_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "InvoiceItem_tenantId_id_key" ON "InvoiceItem"("tenantId", "id");
    CREATE INDEX IF NOT EXISTS "InvoiceItem_tenantId_invoiceId_sortOrder_idx" ON "InvoiceItem"("tenantId", "invoiceId", "sortOrder");

    CREATE TABLE IF NOT EXISTS "ElectronicDocument" (
      "id" TEXT NOT NULL,
      "tenantId" TEXT NOT NULL,
      "type" TEXT NOT NULL,
      "dealId" TEXT NOT NULL,
      "contractId" TEXT,
      "companyId" TEXT,
      "invoiceId" TEXT,
      "number" TEXT NOT NULL,
      "documentDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "amountWithoutVat" DECIMAL(18,2) NOT NULL,
      "vatAmount" DECIMAL(18,2) NOT NULL,
      "totalAmount" DECIMAL(18,2) NOT NULL,
      "currency" TEXT NOT NULL DEFAULT 'KZT',
      "status" TEXT NOT NULL DEFAULT 'DRAFT',
      "externalSystem" TEXT,
      "externalId" TEXT,
      "externalNumber" TEXT,
      "externalStatus" TEXT,
      "sourceDataJson" JSONB NOT NULL DEFAULT '{}',
      "xmlStorageKey" TEXT,
      "signedXmlStorageKey" TEXT,
      "createdByUserId" TEXT,
      "signedByUserId" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "validatedAt" TIMESTAMP(3),
      "signedAt" TIMESTAMP(3),
      "sentAt" TIMESTAMP(3),
      "acceptedAt" TIMESTAMP(3),
      "errorCode" TEXT,
      "errorMessage" TEXT,
      CONSTRAINT "ElectronicDocument_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "ElectronicDocument_tenantId_id_key" ON "ElectronicDocument"("tenantId", "id");
    CREATE UNIQUE INDEX IF NOT EXISTS "ElectronicDocument_tenantId_type_number_key" ON "ElectronicDocument"("tenantId", "type", "number");
    CREATE INDEX IF NOT EXISTS "ElectronicDocument_tenantId_dealId_type_status_idx" ON "ElectronicDocument"("tenantId", "dealId", "type", "status");

    CREATE TABLE IF NOT EXISTS "ContractTemplate" (
      "id" TEXT NOT NULL,
      "tenantId" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "body" TEXT NOT NULL,
      "isDefault" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ContractTemplate_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "ContractTemplate_tenantId_id_key" ON "ContractTemplate"("tenantId", "id");
    CREATE INDEX IF NOT EXISTS "ContractTemplate_tenantId_isDefault_idx" ON "ContractTemplate"("tenantId", "isDefault");
    ALTER TABLE "ContractTemplate" ADD COLUMN IF NOT EXISTS "sourceFileName" TEXT;
    ALTER TABLE "ContractTemplate" ADD COLUMN IF NOT EXISTS "sourceStorageKey" TEXT;

    ALTER TABLE "Contract" ADD COLUMN IF NOT EXISTS "verificationPublicId" TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS "Contract_verificationPublicId_key" ON "Contract"("verificationPublicId");

    CREATE TABLE IF NOT EXISTS "SignatureRequest" (
      "id" TEXT NOT NULL,
      "tenantId" TEXT NOT NULL,
      "contractId" TEXT NOT NULL,
      "contractVersionId" TEXT,
      "signerType" TEXT NOT NULL,
      "signerUserId" TEXT,
      "signerCompanyId" TEXT,
      "signerName" TEXT,
      "signerIin" TEXT,
      "signerBin" TEXT,
      "order" INTEGER NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'PENDING',
      "tokenHash" TEXT,
      "expiresAt" TIMESTAMP(3),
      "openedAt" TIMESTAMP(3),
      "signedAt" TIMESTAMP(3),
      "declinedAt" TIMESTAMP(3),
      "declineReason" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "SignatureRequest_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "SignatureRequest_tenantId_id_key" ON "SignatureRequest"("tenantId", "id");
    CREATE UNIQUE INDEX IF NOT EXISTS "SignatureRequest_tokenHash_key" ON "SignatureRequest"("tokenHash");
    CREATE INDEX IF NOT EXISTS "SignatureRequest_tenantId_contractId_status_idx" ON "SignatureRequest"("tenantId", "contractId", "status");

    CREATE TABLE IF NOT EXISTS "DocumentSignature" (
      "id" TEXT NOT NULL,
      "tenantId" TEXT NOT NULL,
      "contractId" TEXT NOT NULL,
      "contractVersionId" TEXT,
      "signatureRequestId" TEXT,
      "signerName" TEXT,
      "signerIin" TEXT,
      "signerBin" TEXT,
      "certificateSerial" TEXT,
      "certificateIssuer" TEXT,
      "certificateValidFrom" TIMESTAMP(3),
      "certificateValidTo" TIMESTAMP(3),
      "signatureFormat" TEXT NOT NULL DEFAULT 'CMS_DETACHED',
      "signatureFileId" TEXT,
      "documentHash" TEXT NOT NULL,
      "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "verificationStatus" TEXT NOT NULL,
      "verificationDetails" JSONB NOT NULL DEFAULT '{}',
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "DocumentSignature_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "DocumentSignature_tenantId_id_key" ON "DocumentSignature"("tenantId", "id");
    CREATE INDEX IF NOT EXISTS "DocumentSignature_tenantId_contractId_idx" ON "DocumentSignature"("tenantId", "contractId");
    CREATE INDEX IF NOT EXISTS "DocumentSignature_tenantId_signatureRequestId_idx" ON "DocumentSignature"("tenantId", "signatureRequestId");

    ALTER TABLE "TenantLegalProfile" ADD COLUMN IF NOT EXISTS "defaultCatalogTruId" TEXT;
    ALTER TABLE "DealItem" ADD COLUMN IF NOT EXISTS "catalogTruId" TEXT;

    ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "contractNumber" TEXT;
    ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "contractDate" TIMESTAMP(3);
    ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "withoutContract" BOOLEAN NOT NULL DEFAULT false;

    CREATE TABLE IF NOT EXISTS "EsfConnection" (
      "id" TEXT NOT NULL,
      "tenantId" TEXT NOT NULL,
      "environment" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'NOT_CONNECTED',
      "sessionId" TEXT,
      "sessionCreatedAt" TIMESTAMP(3),
      "sessionExpiresAt" TIMESTAMP(3),
      "organizationBin" TEXT,
      "signerIin" TEXT,
      "authCertificatePem" TEXT,
      "authCertificateSerial" TEXT,
      "authCertificateValidFrom" TIMESTAMP(3),
      "authCertificateValidTo" TIMESTAMP(3),
      "lastConnectedAt" TIMESTAMP(3),
      "lastErrorCode" TEXT,
      "lastErrorMessage" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "EsfConnection_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "EsfConnection_tenantId_environment_key" ON "EsfConnection"("tenantId", "environment");
    CREATE UNIQUE INDEX IF NOT EXISTS "EsfConnection_tenantId_id_key" ON "EsfConnection"("tenantId", "id");
    CREATE INDEX IF NOT EXISTS "EsfConnection_tenantId_status_idx" ON "EsfConnection"("tenantId", "status");
`;

const ACCOUNT_DOMAIN_SQL = `
    ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "firstName" TEXT;
    ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastName" TEXT;
    ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "middleName" TEXT;
    ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "city" TEXT;
    ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "avatarStorageKey" TEXT;
    ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "locale" TEXT DEFAULT 'ru';
    ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "timezone" TEXT;
    ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "timeFormat" TEXT DEFAULT '24';
    ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "theme" TEXT DEFAULT 'system';
    ALTER TABLE "Membership" ADD COLUMN IF NOT EXISTS "jobTitle" TEXT;
    ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "userAgent" TEXT;
    ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "ip" TEXT;
    ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "lastSeenAt" TIMESTAMP(3);
    ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastLoginAt" TIMESTAMP(3);
    ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP(3);
    ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "phoneVerifiedAt" TIMESTAMP(3);
    CREATE TABLE IF NOT EXISTS "PasswordResetToken" (
      "id" TEXT NOT NULL,
      "userId" TEXT NOT NULL,
      "tokenHash" TEXT NOT NULL,
      "expiresAt" TIMESTAMP(3) NOT NULL,
      "usedAt" TIMESTAMP(3),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");
    CREATE INDEX IF NOT EXISTS "PasswordResetToken_userId_usedAt_idx" ON "PasswordResetToken"("userId", "usedAt");
    ALTER TABLE "PasswordResetToken" ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE "PasswordResetToken" ADD COLUMN IF NOT EXISTS "purpose" TEXT NOT NULL DEFAULT 'code';
    CREATE UNIQUE INDEX IF NOT EXISTS "Campaign_tenantId_id_key" ON "Campaign"("tenantId", "id");
`;

const PLATFORM_DOMAIN_SQL = `
    ALTER TABLE "Invitation" ADD COLUMN IF NOT EXISTS "revokedAt" TIMESTAMP(3);
    ALTER TABLE "Invitation" ADD COLUMN IF NOT EXISTS "name" TEXT;
    ALTER TABLE "Invitation" ADD COLUMN IF NOT EXISTS "phone" TEXT;

    CREATE TABLE IF NOT EXISTS "PlatformSetting" (
      "id" TEXT NOT NULL,
      "key" TEXT NOT NULL,
      "valueJson" JSONB NOT NULL DEFAULT '{}',
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "PlatformSetting_key_key" ON "PlatformSetting"("key");

    CREATE TABLE IF NOT EXISTS "PlatformIntegrationType" (
      "id" TEXT NOT NULL,
      "type" TEXT NOT NULL,
      "title" TEXT NOT NULL,
      "description" TEXT NOT NULL DEFAULT '',
      "purpose" TEXT NOT NULL DEFAULT '',
      "available" BOOLEAN NOT NULL DEFAULT true,
      "defaultSettingsJson" JSONB NOT NULL DEFAULT '{}',
      "allowedParamsJson" JSONB NOT NULL DEFAULT '{}',
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "PlatformIntegrationType_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "PlatformIntegrationType_type_key" ON "PlatformIntegrationType"("type");

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
`;

const AI_DOMAIN_SQL = `
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
`;

const SUPPORT_DOMAIN_SQL = `
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
`;

const CONTROL_DOMAIN_SQL = `
    CREATE TABLE IF NOT EXISTS "ControlAccess" (
      "id" TEXT NOT NULL,
      "tenantId" TEXT NOT NULL,
      "userId" TEXT NOT NULL,
      "enabled" BOOLEAN NOT NULL DEFAULT false,
      "allowedSources" JSONB NOT NULL DEFAULT '[]',
      "allowedActions" JSONB NOT NULL DEFAULT '[]',
      "canReadFinancialData" BOOLEAN NOT NULL DEFAULT false,
      "canReadTeamData" BOOLEAN NOT NULL DEFAULT false,
      "canCreateTasks" BOOLEAN NOT NULL DEFAULT false,
      "canModifyDeals" BOOLEAN NOT NULL DEFAULT false,
      "canPerformBulkActions" BOOLEAN NOT NULL DEFAULT false,
      "requiresConfirmationForWrites" BOOLEAN NOT NULL DEFAULT true,
      "status" TEXT NOT NULL DEFAULT 'disabled',
      "lastActivityAt" TIMESTAMP(3),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ControlAccess_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "ControlAccess_tenantId_userId_key" ON "ControlAccess"("tenantId", "userId");
    CREATE INDEX IF NOT EXISTS "ControlAccess_tenantId_enabled_status_idx" ON "ControlAccess"("tenantId", "enabled", "status");

    CREATE TABLE IF NOT EXISTS "ControlIdentity" (
      "id" TEXT NOT NULL,
      "tenantId" TEXT NOT NULL,
      "userId" TEXT NOT NULL,
      "provider" TEXT NOT NULL,
      "externalUserId" TEXT NOT NULL,
      "phoneNormalized" TEXT,
      "verifiedAt" TIMESTAMP(3),
      "enabled" BOOLEAN NOT NULL DEFAULT true,
      "verificationCodeHash" TEXT,
      "verificationExpiresAt" TIMESTAMP(3),
      "metadata" JSONB NOT NULL DEFAULT '{}',
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ControlIdentity_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "ControlIdentity_tenantId_provider_externalUserId_key"
      ON "ControlIdentity"("tenantId", "provider", "externalUserId");
    CREATE INDEX IF NOT EXISTS "ControlIdentity_tenantId_phoneNormalized_idx"
      ON "ControlIdentity"("tenantId", "phoneNormalized");
    CREATE INDEX IF NOT EXISTS "ControlIdentity_tenantId_userId_provider_idx"
      ON "ControlIdentity"("tenantId", "userId", "provider");

    CREATE TABLE IF NOT EXISTS "ControlConfirmation" (
      "id" TEXT NOT NULL,
      "tenantId" TEXT NOT NULL,
      "userId" TEXT NOT NULL,
      "identityId" TEXT,
      "source" TEXT NOT NULL,
      "action" TEXT NOT NULL,
      "paramsJson" JSONB NOT NULL DEFAULT '{}',
      "summary" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'pending',
      "requestId" TEXT NOT NULL,
      "expiresAt" TIMESTAMP(3) NOT NULL,
      "confirmedAt" TIMESTAMP(3),
      "executedAt" TIMESTAMP(3),
      "resultJson" JSONB,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ControlConfirmation_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "ControlConfirmation_tenantId_requestId_key"
      ON "ControlConfirmation"("tenantId", "requestId");
    CREATE INDEX IF NOT EXISTS "ControlConfirmation_tenantId_status_expiresAt_idx"
      ON "ControlConfirmation"("tenantId", "status", "expiresAt");
`;

const BILLING_DOMAIN_SQL = `
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
`;

export async function createPrismaClient(): Promise<PrismaClient> {
  if (globalForPrisma.prisma) {
    return globalForPrisma.prisma;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (isLivePostgresUrl(databaseUrl)) {
    const prisma = new PrismaClient({
      datasourceUrl: databaseUrl,
    });
    await applyLivePostgresPatches(prisma);
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
