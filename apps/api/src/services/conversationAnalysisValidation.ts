import { z } from "zod";
import { AGREEMENT_TYPE_LABEL, AGREEMENT_STATUS_LABEL, BUSINESS_EVENT_TYPES, type ConversationAnalysis } from "./conversationContextTypes.ts";

const text = z.string().max(4000).nullable().optional();
const confidence = z.enum(["HIGH", "MEDIUM", "LOW"]);
const ids = z.array(z.string().max(200)).max(80);
const datetime = z.string().datetime({ offset: true }).nullable().optional();
const agreement = z.object({
  action: z.enum(["create", "update", "reschedule", "cancel", "complete"]),
  existingAgreementId: text,
  type: z.enum(Object.keys(AGREEMENT_TYPE_LABEL) as [keyof typeof AGREEMENT_TYPE_LABEL, ...Array<keyof typeof AGREEMENT_TYPE_LABEL>]),
  title: z.string().min(1).max(500), summary: text, purpose: text,
  status: z.enum(Object.keys(AGREEMENT_STATUS_LABEL) as [keyof typeof AGREEMENT_STATUS_LABEL, ...Array<keyof typeof AGREEMENT_STATUS_LABEL>]),
  scheduledAt: datetime, scheduledEndAt: datetime,
  locationName: text, address: text, meetingProvider: text, meetingUrl: text, meetingId: text, meetingPassword: text,
  phone: text, clarificationNeeded: text, confidence, createTask: z.boolean(), taskType: text, evidenceMessageIds: ids,
});
const schema = z.object({
  clientIntent: text, detectedNeed: text, suggestedRequestStatus: text, suggestedDealStage: text,
  waitingFor: z.enum(["CLIENT", "MANAGER", "AI", "THIRD_PARTY", "NONE"]).optional(),
  needsReply: z.boolean().optional(), humanRequired: z.boolean().optional(), humanReason: text,
  summaryUpdate: text, suggestedNextAction: text, confidence: confidence.optional(), evidenceMessageIds: ids.optional(),
  agreements: z.array(agreement).max(20).optional(),
  suggestedTasks: z.array(z.object({
    type: z.string(), title: z.string(), dueAt: datetime, purpose: text, briefingText: text,
    preparationHints: z.array(z.string()).max(20).optional(), linkedAgreementIndex: z.number().int().min(0).nullable().optional(),
    evidenceMessageIds: ids, confidence,
  })).max(20).optional(),
  facts: z.object({ service: text, budget: text, deadline: text, company: text, meetingDate: text, meetingTime: text,
    proposalSent: z.boolean().optional(), pricesSent: z.boolean().optional(), waitingForManagement: z.boolean().optional(),
  }).optional(),
  events: z.array(z.object({
    type: z.enum(BUSINESS_EVENT_TYPES), amount: z.number().finite().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
    currency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(), confidence, evidenceMessageIds: ids,
  })).max(40).optional(),
});

export function validateConversationRefinement(raw: unknown, messageIds: string[]): Partial<ConversationAnalysis> | null {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return null;
  const value = parsed.data;
  const known = new Set(messageIds);
  const grounded = (evidence: string[]) => evidence.length > 0 && evidence.every(id => known.has(id));
  value.agreements = value.agreements?.filter(item => grounded(item.evidenceMessageIds));
  value.events = value.events?.filter(item => grounded(item.evidenceMessageIds)).map(item =>
    item.type === "PAYMENT_RECEIVED" ? { ...item, type: "OTHER_RELEVANT_BUSINESS_EVENT" } : item);
  // No LLM date may create a scheduled activity while its own output requests clarification of time.
  for (const item of value.agreements || []) {
    if (item.status === "NEEDS_CLARIFICATION") { item.scheduledAt = null; item.createTask = false; }
  }
  value.suggestedTasks = value.suggestedTasks?.filter(item => grounded(item.evidenceMessageIds));
  if (value.evidenceMessageIds && !grounded(value.evidenceMessageIds)) {
    value.confidence = "LOW";
    value.evidenceMessageIds = [];
  }
  return value;
}
