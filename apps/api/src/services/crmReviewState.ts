import { createHash } from "node:crypto";
import type { CrmReviewEntity, CrmCommercialValues } from "@creolab/contracts";

// Exclude communication counters, but include ownership, links, state and manual
// fields. A change elsewhere in the card must not silently rebase an old proposal.
const fields = {
  contact: ["id", "tenantId", "version", "name", "firstName", "lastName", "middleName", "companyName", "jobTitle", "city", "country", "language", "ownerMembershipId", "summary", "lifecycleStatus", "leadTemperature", "leadScore", "archivedAt", "attributionJson"],
  inquiry: ["id", "tenantId", "version", "contactId", "conversationId", "dealId", "companyId", "status", "archived", "assigneeMembershipId", "subject", "description", "service", "serviceCategory", "serviceSubcategory", "companyName", "city", "aiSummary", "nextStep", "needsReply", "budgetMin", "budgetMax", "currency", "desiredDeadline", "phoneRaw", "phoneNormalized", "lostReason", "lostComment", "rejectReason", "classification", "fieldMetaJson", "normalizedJson"],
} as const;
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value ?? null;
}
export function crmReviewFingerprint(entity: CrmReviewEntity, row: object) {
  const data = row as Record<string, unknown>;
  return createHash("sha256").update(JSON.stringify(fields[entity].map(key => [key, canonical(data[key])]))).digest("hex");
}
export type CrmReviewSnapshot = {
  contact: { id: string; fingerprint: string; summary: string | null } | null;
  inquiry: { id: string; fingerprint: string; aiSummary: string | null; nextStep: string | null; commercial?: CrmCommercialValues; currency?: string } | null;
};
