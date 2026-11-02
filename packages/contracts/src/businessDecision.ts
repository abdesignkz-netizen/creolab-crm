import { z } from "zod";

export const DECISION_KINDS = ["decision", "preference", "hypothesis"] as const;
export type DecisionKind = typeof DECISION_KINDS[number];
export const DECISION_LABELS = { decision: "Решение", preference: "Предпочтение", hypothesis: "Гипотеза для проверки" };
export const DECISION_TOPICS = ["Продажи", "Работа с клиентами", "Задачи команды", "Документы", "Другое"] as const;
const id = /* @__PURE__ */ (() => z.string().uuid())();
export const decisionFieldsSchema = /* @__PURE__ */ (() => z.object({
  kind: z.enum(DECISION_KINDS), topic: z.string().trim().min(2).max(80), title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(1200), rationale: z.string().trim().min(1).max(800),
  sourceKind: z.enum(["manual", "goal", "insight", "action_run"]), sourceId: id.nullable().default(null),
  validFrom: z.string().datetime({ offset: true }), validUntil: z.string().datetime({ offset: true }), retentionUntil: z.string().datetime({ offset: true }),
}).strict().refine(v => v.sourceKind === "manual" ? v.sourceId === null : v.sourceId !== null, "Выберите источник решения."))();
export const decisionSaveSchema = /* @__PURE__ */ (() => z.object({ requestId: id, version: z.number().int().nonnegative(), content: decisionFieldsSchema }).strict())();
export const decisionApproveSchema = /* @__PURE__ */ (() => z.object({ requestId: id, version: z.number().int().positive(), confirmed: z.literal(true), replacesId: id.optional() }).strict())();
export const decisionOperationSchema = /* @__PURE__ */ (() => z.object({ requestId: id, version: z.number().int().positive(), confirmed: z.literal(true) }).strict())();
export const decisionListSchema = /* @__PURE__ */ (() => z.object({ state: z.enum(["all", "draft", "approved", "revoked", "superseded", "deleted"]).default("all"), q: z.string().max(80).default(""), cursor: id.optional() }).strict())();
export const decisionContextSchema = /* @__PURE__ */ (() => z.object({ topic: z.string().trim().max(80).optional() }).strict())();
export type DecisionContent = z.infer<typeof decisionFieldsSchema>;
export type DecisionSave = z.infer<typeof decisionSaveSchema>;
export type DecisionRef = { id: string; version: number };
export type BusinessDecisionView = {
  id: string; version: number; kind: DecisionKind; state: "draft" | "approved" | "revoked" | "superseded" | "deleted";
  content: DecisionContent | null; effective: "draft" | "hypothesis" | "active" | "scheduled" | "expired" | "source_changed" | "source_unavailable" | "superseded" | "revoked" | "deleted";
  source: { label: string; href: string | null; available: boolean; changed: boolean }; canEdit: boolean;
  author: string; approver: string | null; approvedAt: string | null; createdAt: string; updatedAt: string; supersededById: string | null;
};
export type BusinessDecisionDetail = BusinessDecisionView & {
  history: Array<{ id: string; type: string; at: string; version: number; actor: string; fields: string[] }>;
  conflicts: Array<{ id: string; version: number; title: string }>;
};
export type BusinessMemoryContext = { entries: Array<DecisionRef & { title: string; body: string; kind: "decision" | "preference"; validUntil: string; href: string }>;
  asOf: string; limited: boolean; boundary: string };
