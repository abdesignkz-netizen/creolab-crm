import { z } from "zod";

// Inquiry budgets use whole currency units in Int columns. Never silently round
// fractions, convert currencies, or treat a deposit/periodic price as a total.
export const crmMoneySchema = z.object({
  min: z.number().int().min(0).max(2_147_483_647).nullable(),
  max: z.number().int().min(0).max(2_147_483_647).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
}).strict().refine(v => (v.min !== null || v.max !== null) && (v.min === null || v.max === null || v.min <= v.max));
export type CrmMoney = z.infer<typeof crmMoneySchema>;
export const CRM_COMMERCIAL_FIELDS = ["customerBudget", "proposedPrice", "agreedPrice", "objection", "refusalReason"] as const;
export type CrmCommercialField = (typeof CRM_COMMERCIAL_FIELDS)[number];
export type CrmCommercialValues = {
  customerBudget: CrmMoney | null;
  proposedPrice: CrmMoney | null;
  agreedPrice: CrmMoney | null;
  objection: string | null;
  refusalReason: string | null;
};
export const crmCommercialFactSchema = z.object({
  field: z.enum(CRM_COMMERCIAL_FIELDS),
  value: z.union([crmMoneySchema, z.string().trim().min(1).max(2000)]),
  confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
  evidence: z.array(z.object({ messageId: z.string().min(1).max(200), quote: z.string().trim().min(3).max(2000) }).strict()).min(1).max(4),
}).strict().refine(f => ["objection", "refusalReason"].includes(f.field) ? typeof f.value === "string"
  : typeof f.value === "object" && (f.field === "customerBudget" || (f.value.min !== null && f.value.min === f.value.max)));
export type CrmCommercialFact = z.infer<typeof crmCommercialFactSchema>;

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function readCrmCommercial(inquiry: { budgetMin?: number | null; budgetMax?: number | null; currency?: string; normalizedJson?: unknown }): CrmCommercialValues {
  const saved = object(object(inquiry.normalizedJson).crmCommercial);
  const money = (raw: unknown, exact = false) => {
    const parsed = crmMoneySchema.safeParse(raw);
    return parsed.success && (!exact || (parsed.data.min !== null && parsed.data.min === parsed.data.max)) ? parsed.data : null;
  };
  const text = (raw: unknown) => typeof raw === "string" && raw.trim().length > 0 && raw.length <= 2000 ? raw : null;
  return {
    customerBudget: money({ min: inquiry.budgetMin ?? null, max: inquiry.budgetMax ?? null, currency: inquiry.currency || "KZT" }),
    proposedPrice: money(saved.proposedPrice, true), agreedPrice: money(saved.agreedPrice, true),
    objection: text(saved.objection), refusalReason: text(saved.refusalReason),
  };
}
