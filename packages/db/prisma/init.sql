-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Almaty',
    "currency" TEXT NOT NULL DEFAULT 'KZT',
    "defaultRegion" TEXT NOT NULL DEFAULT 'KZ',
    "workingHoursJson" JSONB NOT NULL DEFAULT '{}',
    "settingsJson" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "limitsJson" JSONB NOT NULL DEFAULT '{}',
    "featuresJson" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantPlan" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3),

    CONSTRAINT "TenantPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "phone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "platformAdmin" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "permissions" JSONB NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "refreshHash" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "refreshExpiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "deviceLabel" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "inviterId" TEXT,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Credential" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "scope" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "encryptedValue" TEXT NOT NULL,
    "keyVersion" TEXT NOT NULL,
    "rotatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "schemaJson" JSONB NOT NULL DEFAULT '{}',
    "mappingJson" JSONB NOT NULL DEFAULT '{}',
    "assignmentJson" JSONB NOT NULL DEFAULT '{}',
    "credentialId" TEXT,
    "lastEventAt" TIMESTAMP(3),
    "lastError" TEXT,
    "testMode" BOOLEAN NOT NULL DEFAULT true,
    "publicKey" TEXT,
    "secretHash" TEXT,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelConnection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "channelType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "externalRef" TEXT,
    "settingsJson" JSONB NOT NULL DEFAULT '{}',
    "capabilitiesJson" JSONB NOT NULL DEFAULT '[]',
    "autoReply" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ChannelConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormDefinition" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fieldsJson" JSONB NOT NULL,
    "allowedDomains" JSONB NOT NULL DEFAULT '[]',
    "antispamJson" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "FormDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoutingRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "integrationId" TEXT,
    "kind" TEXT NOT NULL,
    "assigneeMembershipId" TEXT,
    "queueJson" JSONB NOT NULL DEFAULT '{}',
    "priority" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RoutingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT,
    "companyName" TEXT,
    "language" TEXT NOT NULL DEFAULT 'unknown',
    "ownerMembershipId" TEXT,
    "summary" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactMethod" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "rawValue" TEXT NOT NULL,
    "normalizedValue" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "primary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactMethod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalIdentity" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "integrationId" TEXT,
    "connectionId" TEXT,
    "type" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ExternalIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactFact" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "value" TEXT,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "evidenceKind" TEXT NOT NULL DEFAULT 'explicit',
    "manualLock" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactPermission" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "evidence" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactPermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Inquiry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "integrationId" TEXT,
    "source" TEXT NOT NULL,
    "inboundEventId" TEXT,
    "contactId" TEXT NOT NULL,
    "phoneRaw" TEXT NOT NULL,
    "phoneNormalized" TEXT NOT NULL,
    "phoneSource" TEXT NOT NULL,
    "phoneConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "subject" TEXT,
    "description" TEXT,
    "rawFieldsJson" JSONB NOT NULL DEFAULT '{}',
    "normalizedJson" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'new',
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "rejectReason" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "assigneeMembershipId" TEXT,
    "conversationId" TEXT,
    "dealId" TEXT,
    "attentionReason" TEXT,
    "nextStep" TEXT,
    "test" BOOLEAN NOT NULL DEFAULT false,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Inquiry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncompleteIntake" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "inboundEventId" TEXT NOT NULL,
    "contactId" TEXT,
    "conversationId" TEXT,
    "rawFieldsJson" JSONB NOT NULL DEFAULT '{}',
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "assigneeMembershipId" TEXT,
    "inquiryId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "integrationId" TEXT,

    CONSTRAINT "IncompleteIntake_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT,
    "externalThreadId" TEXT,
    "contactId" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'ai',
    "status" TEXT NOT NULL DEFAULT 'open',
    "assigneeMembershipId" TEXT,
    "controlVersion" INTEGER NOT NULL DEFAULT 1,
    "messageRevision" INTEGER NOT NULL DEFAULT 0,
    "needsAttention" BOOLEAN NOT NULL DEFAULT false,
    "attentionReason" TEXT,
    "sellerLeadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationReadState" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "lastReadCursor" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationReadState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderKind" TEXT NOT NULL,
    "senderUserId" TEXT,
    "direction" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'text',
    "text" TEXT,
    "providerMessageId" TEXT,
    "operationState" TEXT NOT NULL DEFAULT 'stored',
    "receiptState" TEXT NOT NULL DEFAULT 'unknown',
    "quotedMessageId" TEXT,
    "historical" BOOLEAN NOT NULL DEFAULT false,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "connectionScopedId" TEXT,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageStatusEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "messageId" TEXT,
    "providerRef" TEXT,
    "status" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "rawJson" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "MessageStatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "parentType" TEXT NOT NULL,
    "parentId" TEXT NOT NULL,
    "messageId" TEXT,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksum" TEXT,
    "status" TEXT NOT NULL DEFAULT 'stored',

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealStage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "systemKey" TEXT NOT NULL,

    CONSTRAINT "DealStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deal" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "inquiryId" TEXT,
    "stageId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'open',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "offerAmountMinor" DECIMAL(18,0),
    "currency" TEXT NOT NULL DEFAULT 'KZT',
    "assigneeMembershipId" TEXT,
    "nextAction" TEXT,
    "nextActionAt" TIMESTAMP(3),
    "lossReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expectedCloseAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "historicalMissingPhone" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealConversation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,

    CONSTRAINT "DealConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "amountMinor" DECIMAL(18,0) NOT NULL,
    "currency" TEXT NOT NULL,
    "confirmedByUserId" TEXT,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "comment" TEXT,
    "correctionOfId" TEXT,

    CONSTRAINT "PaymentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "contactId" TEXT,
    "inquiryId" TEXT,
    "conversationId" TEXT,
    "dealId" TEXT,
    "incompleteIntakeId" TEXT,
    "ownerMembershipId" TEXT,
    "dueAt" TIMESTAMP(3),
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'open',
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledAction" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "parentType" TEXT NOT NULL,
    "parentId" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "state" TEXT NOT NULL DEFAULT 'scheduled',
    "cancelReason" TEXT,
    "payloadJson" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "ScheduledAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "parentType" TEXT NOT NULL,
    "parentId" TEXT NOT NULL,
    "authorUserId" TEXT,
    "text" TEXT NOT NULL,
    "internal" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contactId" TEXT,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeVersion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "contentJson" JSONB NOT NULL,
    "authorUserId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "knowledgeVersionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceType" TEXT NOT NULL,
    "priceMinMinor" DECIMAL(18,0),
    "priceMaxMinor" DECIMAL(18,0),
    "currency" TEXT NOT NULL DEFAULT 'KZT',
    "terms" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "CatalogItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIConfiguration" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'company',
    "connectionId" TEXT,
    "scenario" TEXT NOT NULL DEFAULT 'sales',
    "provider" TEXT,
    "model" TEXT,
    "credentialId" TEXT,
    "publishedVersionId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "limitsJson" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "AIConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIExecution" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "model" TEXT,
    "configVersion" TEXT,
    "status" TEXT NOT NULL,
    "usageJson" JSONB NOT NULL DEFAULT '{}',
    "errorCategory" TEXT,
    "durationMs" INTEGER,
    "sandbox" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "externalEventKey" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "rawJson" JSONB NOT NULL,
    "normalizedJson" JSONB NOT NULL DEFAULT '{}',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "historical" BOOLEAN NOT NULL DEFAULT false,
    "test" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "InboundEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundOperation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "controlVersion" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "providerRef" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboundOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "episodeKey" TEXT NOT NULL,
    "recipientMembershipId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "deviceId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'created',
    "providerRef" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceInstallation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'expo',
    "token" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebPushSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "keysJson" JSONB NOT NULL,
    "environment" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'active',

    CONSTRAINT "WebPushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramBinding" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatRef" TEXT NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "pendingTokenHash" TEXT,
    "pendingExpiresAt" TIMESTAMP(3),

    CONSTRAINT "TelegramBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "id" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "eventsJson" JSONB NOT NULL DEFAULT '{}',
    "channelsJson" JSONB NOT NULL DEFAULT '{}',
    "quietHoursJson" JSONB NOT NULL DEFAULT '{}',
    "preview" TEXT NOT NULL DEFAULT 'minimal',

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "changesJson" JSONB NOT NULL DEFAULT '{}',
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "actorKey" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "resultJson" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_id_key" ON "Tenant"("id");

-- CreateIndex
CREATE UNIQUE INDEX "Plan_code_key" ON "Plan"("code");

-- CreateIndex
CREATE INDEX "TenantPlan_tenantId_status_idx" ON "TenantPlan"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Membership_userId_active_idx" ON "Membership"("userId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_tenantId_userId_key" ON "Membership"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_tenantId_id_key" ON "Membership"("tenantId", "id");

-- CreateIndex
CREATE INDEX "Session_userId_revokedAt_idx" ON "Session"("userId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "Invitation_tenantId_email_idx" ON "Invitation"("tenantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_publicKey_key" ON "Integration"("publicKey");

-- CreateIndex
CREATE INDEX "Integration_tenantId_type_status_idx" ON "Integration"("tenantId", "type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_tenantId_id_key" ON "Integration"("tenantId", "id");

-- CreateIndex
CREATE INDEX "ChannelConnection_tenantId_channelType_status_idx" ON "ChannelConnection"("tenantId", "channelType", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelConnection_tenantId_id_key" ON "ChannelConnection"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "FormDefinition_publicKey_key" ON "FormDefinition"("publicKey");

-- CreateIndex
CREATE INDEX "FormDefinition_tenantId_idx" ON "FormDefinition"("tenantId");

-- CreateIndex
CREATE INDEX "RoutingRule_tenantId_priority_idx" ON "RoutingRule"("tenantId", "priority");

-- CreateIndex
CREATE INDEX "Contact_tenantId_lastSeenAt_idx" ON "Contact"("tenantId", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_tenantId_id_key" ON "Contact"("tenantId", "id");

-- CreateIndex
CREATE INDEX "ContactMethod_tenantId_type_normalizedValue_idx" ON "ContactMethod"("tenantId", "type", "normalizedValue");

-- CreateIndex
CREATE INDEX "ExternalIdentity_tenantId_contactId_idx" ON "ExternalIdentity"("tenantId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalIdentity_tenantId_type_externalId_connectionId_key" ON "ExternalIdentity"("tenantId", "type", "externalId", "connectionId");

-- CreateIndex
CREATE INDEX "ContactFact_tenantId_contactId_field_idx" ON "ContactFact"("tenantId", "contactId", "field");

-- CreateIndex
CREATE INDEX "ContactPermission_tenantId_contactId_purpose_idx" ON "ContactPermission"("tenantId", "contactId", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "Inquiry_dealId_key" ON "Inquiry"("dealId");

-- CreateIndex
CREATE INDEX "Inquiry_tenantId_receivedAt_idx" ON "Inquiry"("tenantId", "receivedAt");

-- CreateIndex
CREATE INDEX "Inquiry_tenantId_status_assigneeMembershipId_idx" ON "Inquiry"("tenantId", "status", "assigneeMembershipId");

-- CreateIndex
CREATE UNIQUE INDEX "Inquiry_tenantId_id_key" ON "Inquiry"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Inquiry_tenantId_dealId_key" ON "Inquiry"("tenantId", "dealId");

-- CreateIndex
CREATE UNIQUE INDEX "IncompleteIntake_inquiryId_key" ON "IncompleteIntake"("inquiryId");

-- CreateIndex
CREATE INDEX "IncompleteIntake_tenantId_status_receivedAt_idx" ON "IncompleteIntake"("tenantId", "status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "IncompleteIntake_tenantId_id_key" ON "IncompleteIntake"("tenantId", "id");

-- CreateIndex
CREATE INDEX "Conversation_tenantId_updatedAt_idx" ON "Conversation"("tenantId", "updatedAt");

-- CreateIndex
CREATE INDEX "Conversation_tenantId_mode_status_idx" ON "Conversation"("tenantId", "mode", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_tenantId_id_key" ON "Conversation"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationReadState_tenantId_conversationId_membershipId_key" ON "ConversationReadState"("tenantId", "conversationId", "membershipId");

-- CreateIndex
CREATE INDEX "Message_tenantId_conversationId_createdAt_idx" ON "Message"("tenantId", "conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_tenantId_id_key" ON "Message"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Message_connectionScopedId_key" ON "Message"("connectionScopedId");

-- CreateIndex
CREATE INDEX "MessageStatusEvent_tenantId_providerRef_idx" ON "MessageStatusEvent"("tenantId", "providerRef");

-- CreateIndex
CREATE INDEX "Attachment_tenantId_parentType_parentId_idx" ON "Attachment"("tenantId", "parentType", "parentId");

-- CreateIndex
CREATE INDEX "DealStage_tenantId_sortOrder_idx" ON "DealStage"("tenantId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "DealStage_tenantId_id_key" ON "DealStage"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Deal_inquiryId_key" ON "Deal"("inquiryId");

-- CreateIndex
CREATE INDEX "Deal_tenantId_outcome_stageId_idx" ON "Deal"("tenantId", "outcome", "stageId");

-- CreateIndex
CREATE UNIQUE INDEX "Deal_tenantId_id_key" ON "Deal"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DealConversation_tenantId_dealId_conversationId_key" ON "DealConversation"("tenantId", "dealId", "conversationId");

-- CreateIndex
CREATE INDEX "PaymentRecord_tenantId_dealId_confirmedAt_idx" ON "PaymentRecord"("tenantId", "dealId", "confirmedAt");

-- CreateIndex
CREATE INDEX "Task_tenantId_status_dueAt_idx" ON "Task"("tenantId", "status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "Task_tenantId_id_key" ON "Task"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Task_tenantId_dedupeKey_key" ON "Task"("tenantId", "dedupeKey");

-- CreateIndex
CREATE INDEX "ScheduledAction_tenantId_state_dueAt_idx" ON "ScheduledAction"("tenantId", "state", "dueAt");

-- CreateIndex
CREATE INDEX "Note_tenantId_parentType_parentId_idx" ON "Note"("tenantId", "parentType", "parentId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeVersion_tenantId_version_key" ON "KnowledgeVersion"("tenantId", "version");

-- CreateIndex
CREATE INDEX "AIExecution_tenantId_createdAt_idx" ON "AIExecution"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "InboundEvent_tenantId_receivedAt_idx" ON "InboundEvent"("tenantId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "InboundEvent_integrationId_externalEventKey_key" ON "InboundEvent"("integrationId", "externalEventKey");

-- CreateIndex
CREATE INDEX "OutboxEvent_processedAt_availableAt_idx" ON "OutboxEvent"("processedAt", "availableAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_tenantId_type_idx" ON "OutboxEvent"("tenantId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundOperation_tenantId_idempotencyKey_key" ON "OutboundOperation"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "Notification_tenantId_recipientMembershipId_readAt_idx" ON "Notification"("tenantId", "recipientMembershipId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_tenantId_episodeKey_recipientMembershipId_key" ON "Notification"("tenantId", "episodeKey", "recipientMembershipId");

-- CreateIndex
CREATE INDEX "NotificationDelivery_notificationId_channel_idx" ON "NotificationDelivery"("notificationId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceInstallation_userId_token_key" ON "DeviceInstallation"("userId", "token");

-- CreateIndex
CREATE UNIQUE INDEX "WebPushSubscription_endpoint_key" ON "WebPushSubscription"("endpoint");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramBinding_pendingTokenHash_key" ON "TelegramBinding"("pendingTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_tenantId_membershipId_key" ON "NotificationPreference"("tenantId", "membershipId");

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_createdAt_idx" ON "AuditEvent"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_scope_actorKey_key_key" ON "IdempotencyRecord"("scope", "actorKey", "key");

-- AddForeignKey
ALTER TABLE "TenantPlan" ADD CONSTRAINT "TenantPlan_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantPlan" ADD CONSTRAINT "TenantPlan_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Credential" ADD CONSTRAINT "Credential_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelConnection" ADD CONSTRAINT "ChannelConnection_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelConnection" ADD CONSTRAINT "ChannelConnection_tenantId_integrationId_fkey" FOREIGN KEY ("tenantId", "integrationId") REFERENCES "Integration"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormDefinition" ADD CONSTRAINT "FormDefinition_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormDefinition" ADD CONSTRAINT "FormDefinition_tenantId_integrationId_fkey" FOREIGN KEY ("tenantId", "integrationId") REFERENCES "Integration"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoutingRule" ADD CONSTRAINT "RoutingRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactMethod" ADD CONSTRAINT "ContactMethod_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactMethod" ADD CONSTRAINT "ContactMethod_tenantId_contactId_fkey" FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalIdentity" ADD CONSTRAINT "ExternalIdentity_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalIdentity" ADD CONSTRAINT "ExternalIdentity_tenantId_contactId_fkey" FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalIdentity" ADD CONSTRAINT "ExternalIdentity_tenantId_connectionId_fkey" FOREIGN KEY ("tenantId", "connectionId") REFERENCES "ChannelConnection"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactFact" ADD CONSTRAINT "ContactFact_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactFact" ADD CONSTRAINT "ContactFact_tenantId_contactId_fkey" FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactPermission" ADD CONSTRAINT "ContactPermission_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactPermission" ADD CONSTRAINT "ContactPermission_tenantId_contactId_fkey" FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inquiry" ADD CONSTRAINT "Inquiry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inquiry" ADD CONSTRAINT "Inquiry_tenantId_contactId_fkey" FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inquiry" ADD CONSTRAINT "Inquiry_tenantId_integrationId_fkey" FOREIGN KEY ("tenantId", "integrationId") REFERENCES "Integration"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inquiry" ADD CONSTRAINT "Inquiry_tenantId_assigneeMembershipId_fkey" FOREIGN KEY ("tenantId", "assigneeMembershipId") REFERENCES "Membership"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inquiry" ADD CONSTRAINT "Inquiry_tenantId_conversationId_fkey" FOREIGN KEY ("tenantId", "conversationId") REFERENCES "Conversation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inquiry" ADD CONSTRAINT "Inquiry_tenantId_dealId_fkey" FOREIGN KEY ("tenantId", "dealId") REFERENCES "Deal"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncompleteIntake" ADD CONSTRAINT "IncompleteIntake_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncompleteIntake" ADD CONSTRAINT "IncompleteIntake_tenantId_contactId_fkey" FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncompleteIntake" ADD CONSTRAINT "IncompleteIntake_tenantId_conversationId_fkey" FOREIGN KEY ("tenantId", "conversationId") REFERENCES "Conversation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncompleteIntake" ADD CONSTRAINT "IncompleteIntake_tenantId_assigneeMembershipId_fkey" FOREIGN KEY ("tenantId", "assigneeMembershipId") REFERENCES "Membership"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncompleteIntake" ADD CONSTRAINT "IncompleteIntake_inquiryId_fkey" FOREIGN KEY ("inquiryId") REFERENCES "Inquiry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncompleteIntake" ADD CONSTRAINT "IncompleteIntake_tenantId_integrationId_fkey" FOREIGN KEY ("tenantId", "integrationId") REFERENCES "Integration"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_tenantId_connectionId_fkey" FOREIGN KEY ("tenantId", "connectionId") REFERENCES "ChannelConnection"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_tenantId_contactId_fkey" FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_tenantId_assigneeMembershipId_fkey" FOREIGN KEY ("tenantId", "assigneeMembershipId") REFERENCES "Membership"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationReadState" ADD CONSTRAINT "ConversationReadState_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationReadState" ADD CONSTRAINT "ConversationReadState_tenantId_conversationId_fkey" FOREIGN KEY ("tenantId", "conversationId") REFERENCES "Conversation"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationReadState" ADD CONSTRAINT "ConversationReadState_tenantId_membershipId_fkey" FOREIGN KEY ("tenantId", "membershipId") REFERENCES "Membership"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_tenantId_conversationId_fkey" FOREIGN KEY ("tenantId", "conversationId") REFERENCES "Conversation"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageStatusEvent" ADD CONSTRAINT "MessageStatusEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageStatusEvent" ADD CONSTRAINT "MessageStatusEvent_tenantId_messageId_fkey" FOREIGN KEY ("tenantId", "messageId") REFERENCES "Message"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_tenantId_messageId_fkey" FOREIGN KEY ("tenantId", "messageId") REFERENCES "Message"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealStage" ADD CONSTRAINT "DealStage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_tenantId_contactId_fkey" FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_tenantId_stageId_fkey" FOREIGN KEY ("tenantId", "stageId") REFERENCES "DealStage"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_tenantId_assigneeMembershipId_fkey" FOREIGN KEY ("tenantId", "assigneeMembershipId") REFERENCES "Membership"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealConversation" ADD CONSTRAINT "DealConversation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealConversation" ADD CONSTRAINT "DealConversation_tenantId_dealId_fkey" FOREIGN KEY ("tenantId", "dealId") REFERENCES "Deal"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealConversation" ADD CONSTRAINT "DealConversation_tenantId_conversationId_fkey" FOREIGN KEY ("tenantId", "conversationId") REFERENCES "Conversation"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRecord" ADD CONSTRAINT "PaymentRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRecord" ADD CONSTRAINT "PaymentRecord_tenantId_dealId_fkey" FOREIGN KEY ("tenantId", "dealId") REFERENCES "Deal"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_tenantId_contactId_fkey" FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_tenantId_inquiryId_fkey" FOREIGN KEY ("tenantId", "inquiryId") REFERENCES "Inquiry"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_tenantId_dealId_fkey" FOREIGN KEY ("tenantId", "dealId") REFERENCES "Deal"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_tenantId_ownerMembershipId_fkey" FOREIGN KEY ("tenantId", "ownerMembershipId") REFERENCES "Membership"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledAction" ADD CONSTRAINT "ScheduledAction_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_tenantId_contactId_fkey" FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeVersion" ADD CONSTRAINT "KnowledgeVersion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogItem" ADD CONSTRAINT "CatalogItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogItem" ADD CONSTRAINT "CatalogItem_knowledgeVersionId_fkey" FOREIGN KEY ("knowledgeVersionId") REFERENCES "KnowledgeVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIConfiguration" ADD CONSTRAINT "AIConfiguration_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIExecution" ADD CONSTRAINT "AIExecution_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundEvent" ADD CONSTRAINT "InboundEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundEvent" ADD CONSTRAINT "InboundEvent_tenantId_integrationId_fkey" FOREIGN KEY ("tenantId", "integrationId") REFERENCES "Integration"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundOperation" ADD CONSTRAINT "OutboundOperation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundOperation" ADD CONSTRAINT "OutboundOperation_tenantId_conversationId_fkey" FOREIGN KEY ("tenantId", "conversationId") REFERENCES "Conversation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_tenantId_recipientMembershipId_fkey" FOREIGN KEY ("tenantId", "recipientMembershipId") REFERENCES "Membership"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceInstallation" ADD CONSTRAINT "DeviceInstallation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebPushSubscription" ADD CONSTRAINT "WebPushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramBinding" ADD CONSTRAINT "TelegramBinding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_tenantId_membershipId_fkey" FOREIGN KEY ("tenantId", "membershipId") REFERENCES "Membership"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportSession" ADD CONSTRAINT "SupportSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "SituationSnooze" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,
    "byUserId" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SituationSnooze_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SituationSnooze_tenantId_itemId_key" ON "SituationSnooze"("tenantId", "itemId");
CREATE INDEX "SituationSnooze_tenantId_until_idx" ON "SituationSnooze"("tenantId", "until");

ALTER TABLE "SituationSnooze" ADD CONSTRAINT "SituationSnooze_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

