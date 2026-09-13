import type { PrismaClient } from "@creolab/db";
import { parseAIAutomationSettings } from "./aiAutomationSettings.ts";
import { processNewRequestAutomation } from "./requestAutomationService.ts";

const REPROCESSABLE_STATUSES = new Set(["none", "failed", "awaiting_confirm"]);

function automationStatus(fieldMetaJson: unknown): string | undefined {
  if (!fieldMetaJson || typeof fieldMetaJson !== "object") return undefined;
  const automation = (fieldMetaJson as { automation?: { status?: string } }).automation;
  return automation?.status;
}

/**
 * Durable AI automation: HTTP path enqueues outbox, worker (or inline kick) runs this.
 * Idempotent if automation already applied successfully.
 */
export async function processInquiryAutomationJob(
  prisma: PrismaClient,
  payload: { inquiryId?: string; tenantId?: string },
) {
  if (!payload.inquiryId || !payload.tenantId) return { skipped: true as const };
  const inquiry = await prisma.inquiry.findFirst({
    where: { id: payload.inquiryId, tenantId: payload.tenantId },
    select: { id: true, fieldMetaJson: true },
  });
  if (!inquiry) return { skipped: true as const };

  const status = automationStatus(inquiry.fieldMetaJson);
  if (status && !REPROCESSABLE_STATUSES.has(status)) {
    return { skipped: true as const, reason: "already_processed" };
  }

  await processNewRequestAutomation(prisma, payload.tenantId, payload.inquiryId);
  return { ok: true as const };
}

export async function enqueueInquiryAutomation(
  prisma: PrismaClient,
  tenantId: string,
  inquiryId: string,
  options: { inline?: boolean } = {},
) {
  await prisma.outboxEvent.create({
    data: {
      tenantId,
      type: "inquiry.automation",
      entityType: "inquiry",
      entityId: inquiryId,
      payloadJson: { inquiryId, tenantId },
    },
  });

  const inline = options.inline ?? process.env.CRM_INLINE_AUTOMATION !== "0";
  if (inline) {
    await processInquiryAutomationJob(prisma, { inquiryId, tenantId }).catch((err) => {
      console.error("inquiry.automation inline", err);
    });
  }
}

/** When AUTO is on, pick up form inquiries that were left waiting for a confirm button. */
export async function enqueuePendingAutoStarts(prisma: PrismaClient, tenantId: string) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { settingsJson: true },
  });
  const settings = parseAIAutomationSettings(tenant?.settingsJson);
  if (!settings.autoStartAiManager) return { enqueued: 0 };

  const inquiries = await prisma.inquiry.findMany({
    where: {
      tenantId,
      archived: false,
      test: false,
      status: { notIn: ["lost", "converted", "cancelled"] },
    },
    select: { id: true, fieldMetaJson: true },
    orderBy: { receivedAt: "desc" },
    take: 40,
  });
  const pending = inquiries.filter((row) => automationStatus(row.fieldMetaJson) === "awaiting_confirm").slice(0, 8);
  if (!pending.length) return { enqueued: 0 };

  const already = await prisma.outboxEvent.findMany({
    where: {
      tenantId,
      type: "inquiry.automation",
      entityId: { in: pending.map((row) => row.id) },
      processedAt: null,
    },
    select: { entityId: true },
  });
  const pendingIds = new Set(already.map((row) => row.entityId));
  let enqueued = 0;
  for (const row of pending) {
    if (pendingIds.has(row.id)) continue;
    await enqueueInquiryAutomation(prisma, tenantId, row.id, { inline: false });
    enqueued += 1;
  }
  return { enqueued };
}
