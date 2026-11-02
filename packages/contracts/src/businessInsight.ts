import { z } from "zod";

export const BUSINESS_INSIGHT_RULES = ["inquiry_unhandled", "task_overdue", "deal_next_step", "proposal_delayed", "payment_delayed", "sales_plan_risk", "opportunity_deal", "opportunity_inquiry"] as const;
export const OPPORTUNITY_RULES = ["opportunity_deal", "opportunity_inquiry"] as const;
export type BusinessInsightRule = typeof BUSINESS_INSIGHT_RULES[number];
export const BUSINESS_INSIGHT_STATES = ["open", "acknowledged", "dismissed", "resolved", "unavailable"] as const;
export type BusinessInsightState = typeof BUSINESS_INSIGHT_STATES[number];
export const insightListSchema = z.object({
  kind: z.enum(["insight", "opportunity"]).default("insight"),
  state: z.enum([...BUSINESS_INSIGHT_STATES, "all"]).default("open"),
  rule: z.enum(BUSINESS_INSIGHT_RULES).optional(), cursor: z.string().uuid().optional(),
}).strict();
export const insightDecisionSchema = z.object({
  version: z.number().int().positive(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  requestId: z.string().uuid(),
}).strict();
export type InsightDecision = z.infer<typeof insightDecisionSchema>;
export type InsightContent = {
  title: string; subject: string; explanation: string; formula: string; limitation: string;
  severity: "attention" | "urgent";
  facts: Array<{ label: string; value: string }>;
  sources: Array<{ label: string; href: string }>;
  next: { label: string; href: string };
  period: { from: string | null; to: string; timezone: string; currency: string | null };
  opportunity?: {
    reasons: Array<"proposal_requested" | "late_no_step" | "unhandled_inquiry">;
    existingTask: { id: string; title: string } | null;
    taskTitle: string;
  };
};
export type BusinessInsightView = {
  id: string; rule: BusinessInsightRule; state: BusinessInsightState; occurrence: number; version: number;
  fingerprint: string; generatedAt: string; checkedAt: string; validUntil: string;
  schemaVersion: number; formulaVersion: string; stale: boolean;
  /** Stale/private source snapshots are never sent as current evidence. */
  content: InsightContent | null;
  action?: { runId: string | null; taskId: string | null; taskStatus: string | null; outcomeEventId: string; at: string } | null;
};
export type InsightCoverage = {
  scope: "company"; asOf: string | null; timezone: string; currency: string;
  sources: Array<{ kind: "inquiry" | "task" | "deal"; lastFullPassAt: string | null; inProgress: boolean }>;
  forecast: { checkedAt: string; status: string; months: number; sales: number; otherCurrencySales: number; targetStatus: string; timezone: string; currency: string } | null;
  nextScanAt: string | null;
};
export type BusinessInsightList = { items: BusinessInsightView[]; nextCursor: string | null; coverage: InsightCoverage };
export type BusinessInsightDetail = BusinessInsightView & {
  history: Array<{ id: string; type: string; at: string; version: number; actor: "employee" | "system" }>;
};
export const INSIGHT_RULE_LABELS: Record<BusinessInsightRule, string> = {
  inquiry_unhandled: "Обращения без обработки", task_overdue: "Просроченные задачи", deal_next_step: "Сделки без следующего шага",
  proposal_delayed: "Предложения без ответа", payment_delayed: "Проверка оплаты", sales_plan_risk: "План продаж",
  opportunity_deal: "Возможности по сделкам", opportunity_inquiry: "Возможности по обращениям",
};
