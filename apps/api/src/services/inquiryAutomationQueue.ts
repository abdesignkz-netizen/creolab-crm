import type { PrismaClient } from "@creolab/db";
import { processNewRequestAutomation } from "./requestAutomationService.ts";
import { claimOutboxEvent } from "./outboxLease.ts";
import { logServerError } from "../lib/redact.ts";

// A later switch to AUTO must not replay requests already assigned to staff.
const REPROCESSABLE_STATUSES = new Set(["failed"]);

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
  const { canUseFeature } = await import("./entitlementService.ts");
  if (!(await canUseFeature(prisma, payload.tenantId, "AI_MANAGER"))) return { skipped: true as const, reason: "feature_required" };


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
  const event = await prisma.outboxEvent.create({
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
    const lease = await claimOutboxEvent(prisma, event.id);
    if (!lease) return;
    try {
      await processInquiryAutomationJob(prisma, { inquiryId, tenantId });
    } catch (error) {
      logServerError(error, "inquiry.automation inline");
      await lease.finish({ attempts: { increment: 1 }, availableAt: new Date(Date.now() + 5000) });
      return;
    }
    await lease.finish({ processedAt: new Date(), attempts: { increment: 1 } });
  }
}
