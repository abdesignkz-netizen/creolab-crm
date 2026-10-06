-- AlterTable
ALTER TABLE "TenantPlan" ADD COLUMN     "autoRenew" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "currentPeriodStart" TIMESTAMP(3),
ADD COLUMN     "gracePeriodEndsAt" TIMESTAMP(3),
ADD COLUMN     "nextPlanJson" JSONB,
ADD COLUMN     "providerCustomerId" TEXT,
ADD COLUMN     "recurringProfileEncrypted" TEXT,
ADD COLUMN     "renewalConsentAt" TIMESTAMP(3),
ADD COLUMN     "trialEndsAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "BillingPayment" ADD COLUMN     "autoRenewRequested" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "checkoutUrl" TEXT,
ADD COLUMN     "failedAt" TIMESTAMP(3),
ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "metadataJson" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "orderId" TEXT,
ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "provider" TEXT NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "providerPaymentId" TEXT,
ADD COLUMN     "providerTransactionId" TEXT,
ADD COLUMN     "recurring" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "refundedAt" TIMESTAMP(3),
ADD COLUMN     "subscriptionId" TEXT;

-- CreateTable
CREATE TABLE "BillingOrder" (
    "id" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "planId" TEXT NOT NULL,
    "planCode" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'KZT',
    "billingPeriod" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'NEW_SUBSCRIPTION',
    "status" TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
    "description" TEXT NOT NULL,
    "snapshotJson" JSONB NOT NULL,
    "renewalKey" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "effectiveAt" TIMESTAMP(3),

    CONSTRAINT "BillingOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingInvoice" (
    "id" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "paymentId" TEXT,
    "sellerJson" JSONB NOT NULL,
    "buyerJson" JSONB NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'KZT',
    "description" TEXT NOT NULL,
    "issueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "BillingInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentWebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "paymentId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "errorCode" TEXT,
    "payloadJson" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "PaymentWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingSequence" (
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "BillingSequence_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "BillingOrder_orderNumber_key" ON "BillingOrder"("orderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "BillingOrder_renewalKey_key" ON "BillingOrder"("renewalKey");

-- CreateIndex
CREATE INDEX "BillingOrder_tenantId_createdAt_idx" ON "BillingOrder"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "BillingOrder_status_expiresAt_idx" ON "BillingOrder"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingOrder_tenantId_id_key" ON "BillingOrder"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BillingInvoice_invoiceNumber_key" ON "BillingInvoice"("invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "BillingInvoice_orderId_key" ON "BillingInvoice"("orderId");

-- CreateIndex
CREATE INDEX "BillingInvoice_tenantId_issueDate_idx" ON "BillingInvoice"("tenantId", "issueDate");

-- CreateIndex
CREATE INDEX "PaymentWebhookEvent_paymentId_idx" ON "PaymentWebhookEvent"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentWebhookEvent_provider_eventId_key" ON "PaymentWebhookEvent"("provider", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantPlan_tenantId_id_key" ON "TenantPlan"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPayment_idempotencyKey_key" ON "BillingPayment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "BillingPayment_orderId_idx" ON "BillingPayment"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPayment_tenantId_id_key" ON "BillingPayment"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPayment_provider_providerPaymentId_key" ON "BillingPayment"("provider", "providerPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPayment_provider_providerTransactionId_key" ON "BillingPayment"("provider", "providerTransactionId");


-- Cross-tenant references must be impossible even outside application code.
ALTER TABLE "BillingOrder" ADD CONSTRAINT "BillingOrder_tenant_fk" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT;
ALTER TABLE "BillingOrder" ADD CONSTRAINT "BillingOrder_plan_fk" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT;
ALTER TABLE "BillingOrder" ADD CONSTRAINT "BillingOrder_subscription_fk" FOREIGN KEY ("tenantId", "subscriptionId") REFERENCES "TenantPlan"("tenantId", "id") ON DELETE RESTRICT;
ALTER TABLE "BillingPayment" ADD CONSTRAINT "BillingPayment_order_fk" FOREIGN KEY ("tenantId", "orderId") REFERENCES "BillingOrder"("tenantId", "id") ON DELETE RESTRICT;
ALTER TABLE "BillingInvoice" ADD CONSTRAINT "BillingInvoice_order_fk" FOREIGN KEY ("tenantId", "orderId") REFERENCES "BillingOrder"("tenantId", "id") ON DELETE RESTRICT;
ALTER TABLE "BillingInvoice" ADD CONSTRAINT "BillingInvoice_payment_fk" FOREIGN KEY ("tenantId", "paymentId") REFERENCES "BillingPayment"("tenantId", "id") ON DELETE RESTRICT;
ALTER TABLE "BillingOrder" ADD CONSTRAINT "BillingOrder_positive_amount" CHECK ("amountMinor" > 0 AND "currency" = 'KZT');
CREATE UNIQUE INDEX "BillingPayment_one_open_attempt" ON "BillingPayment"("orderId") WHERE "orderId" IS NOT NULL AND "status" IN ('PENDING','PROCESSING');
ALTER TABLE "BillingPayment" ADD CONSTRAINT "BillingPayment_subscription_fk" FOREIGN KEY ("tenantId", "subscriptionId") REFERENCES "TenantPlan"("tenantId", "id") ON DELETE RESTRICT;
CREATE UNIQUE INDEX "BillingPayment_unique_kaspi_link" ON "BillingPayment"("checkoutUrl") WHERE "provider" = 'KASPI' AND "checkoutUrl" IS NOT NULL;
