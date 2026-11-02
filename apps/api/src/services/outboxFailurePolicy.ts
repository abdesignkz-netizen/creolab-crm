import type { Prisma } from "@creolab/db";
import { ApiError } from "../errors.ts";

export const OUTBOX_MAX_ATTEMPTS = 8;
// Also keep terminal jobs out of the legacy availableAt poll during a staged
// upgrade. They are not completed; only an authorized retry makes them due.
export const OUTBOX_QUARANTINED_UNTIL = new Date("9999-12-31T00:00:00.000Z");
export const OUTBOX_TYPES = ["billing.email", "whatsapp.ai_reply", "channel.ai_reply", "whatsapp.cloud_send", "channel.send", "campaign.run", "conversation.context", "inquiry.automation", "sales.reconcile", "contract.signed", "avr.sent", "esf.sent", "ai.action_run"] as const;
const known = new Set<string>(OUTBOX_TYPES);
// These handlers may contact a provider. An unclassified failure does NOT prove
// that nothing was sent; use their existing delivery review instead of replaying.
const external = new Set(["billing.email", "whatsapp.ai_reply", "channel.ai_reply", "whatsapp.cloud_send", "channel.send", "campaign.run", "inquiry.automation"]);
const manualRetryTypes = new Set(["conversation.context", "sales.reconcile", "contract.signed", "avr.sent", "esf.sent"]);
export type FailureKind = "retryable" | "permanent" | "uncertain" | "exhausted";
export class OutboxFailure extends Error {
  public kind: Exclude<FailureKind, "exhausted">;
  public code: string;
  constructor(kind: Exclude<FailureKind, "exhausted">, code: string) { super(code); this.kind = kind; this.code = code; }
}
type Event = { entityType?: string; type: string; tenantId: string; entityId: string; payloadJson: unknown; retryAttempts: number };

export function validateOutboxEvent(event: Event) {
  if (!known.has(event.type)) throw new OutboxFailure("permanent", "unknown_event_type");
  const p = event.payloadJson as Record<string, unknown> | null;
  const has = (key: string) => typeof p?.[key] === "string" && Boolean((p[key] as string).trim());
  if (!p || typeof p !== "object" || Array.isArray(p) || !event.entityId
    || event.type === "ai.action_run" && (event.entityType !== undefined && event.entityType !== "action_run" || p.version !== 1)
    || event.type === "billing.email" && !["to", "subject", "text"].every(has)
    || event.type === "whatsapp.cloud_send" && !has("integrationId")
    || event.type === "campaign.run" && (!has("campaignId") || p.campaignId !== event.entityId)
    || event.type === "inquiry.automation" && (p.tenantId !== event.tenantId || p.inquiryId !== event.entityId)
    || event.type === "contract.signed" && !["contractId", "dealId"].every(has)
    || ["avr.sent", "esf.sent"].includes(event.type) && !has("documentId")) {
    throw new OutboxFailure("permanent", "invalid_payload");
  }
}

export function outboxFailureUpdate(event: Pick<Event, "type" | "retryAttempts">, error: unknown, now = new Date()): Prisma.OutboxEventUpdateManyMutationInput {
  let kind: FailureKind = external.has(event.type) ? "uncertain" : "retryable";
  let code = "handler_failed";
  if (error instanceof OutboxFailure) { kind = error.kind; code = error.code; }
  else if (error instanceof ApiError) {
    // Only explicit local validation/authorization failures are terminal. Pending
    // prerequisites (409), throttling and server failures may recover.
    if ([400, 401, 403, 404, 410, 422].includes(error.status)) { kind = "permanent"; code = "request_rejected"; }
    else if (!external.has(event.type)) code = error.status === 409 ? "prerequisite_pending" : "service_unavailable";
  }
  if (kind === "retryable" && event.retryAttempts >= OUTBOX_MAX_ATTEMPTS) kind = "exhausted";
  return {
    attempts: { increment: 1 }, failureKind: kind, errorCode: code,
    ...(kind === "retryable"
      ? { availableAt: new Date(now.getTime() + Math.min(300_000, 5000 * 2 ** Math.min(Math.max(0, event.retryAttempts - 1), 6))) }
      : { failedAt: now, availableAt: OUTBOX_QUARANTINED_UNTIL }),
  };
}

export function canRetryOutbox(event: { type: string; failedAt: Date | null; failureKind: string | null; errorCode: string | null }) {
  return Boolean(event.failedAt && event.failureKind === "exhausted" && manualRetryTypes.has(event.type));
}
