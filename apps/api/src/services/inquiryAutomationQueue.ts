import type { PrismaClient } from "@creolab/db";
import { processNewRequestAutomation } from "./requestAutomationService.ts";
import { claimOutboxEvent } from "./outboxLease.ts";
import { logServerError } from "../lib/redact.ts";
import { ApiError } from "../errors.ts";
import { OutboxFailure, outboxFailureUpdate } from "./outboxFailurePolicy.ts";

// A later switch to AUTO must not replay requests already assigned to staff.
const REPROCESSABLE_STATUSES = new Set(["failed"]);

function preflightFailure(error: unknown): never {
  if (error instanceof ApiError) throw error;
  throw new OutboxFailure("retryable", "inquiry_read_failed");
}

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
  }).catch(preflightFailure);
  if (!inquiry) return { skipped: true as const };
  const { canUseFeature } = await import("./entitlementService.ts");
  if (!(await canUseFeature(prisma, payload.tenantId, "AI_MANAGER").catch(preflightFailure))) return { skipped: true as const, reason: "feature_required" };


  const status = automationStatus(inquiry.fieldMetaJson);
  if (status && !REPROCESSABLE_STATUSES.has(status)) {
    return { skipped: true as const, reason: "already_processed" };
  }

  // AUTO can send a welcome through the seller. Only the read-only preflight
  // above is known safe to retry; an unclassified error after it is uncertain.
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
      await lease.finish(outboxFailureUpdate(lease.event, error));
      return;
    }
    await lease.finish({ processedAt: new Date(), attempts: { increment: 1 } });
  }
}
