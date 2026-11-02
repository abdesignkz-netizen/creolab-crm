import { z } from "zod";

export const GOAL_METRICS = ["sales_won", "overdue_tasks", "first_response_minutes"] as const;
export type GoalMetric = typeof GOAL_METRICS[number];
export const GOAL_LABELS: Record<GoalMetric, string> = {
  sales_won: "Выполнить план продаж", overdue_tasks: "Сократить просроченные задачи", first_response_minutes: "Отвечать клиентам быстрее",
};
const id = /* @__PURE__ */ (() => z.string().uuid())(), date = /* @__PURE__ */ (() => z.string().regex(/^\d{4}-\d{2}-\d{2}$/))();
export const goalCreateSchema = /* @__PURE__ */ (() => z.object({
  requestId: id, title: z.string().trim().min(1).max(160), metric: z.enum(GOAL_METRICS), ownerMembershipId: id,
  from: date.optional(), to: date.optional(), target: z.number().finite().min(0).max(1_000_000).multipleOf(0.01, "Укажите не больше двух знаков после запятой.").optional(),
  salesMonth: z.string().regex(/^[1-9]\d{3}-(0[1-9]|1[0-2])$/).optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional(),
}).strict().superRefine((v, c) => {
  if (v.metric === "sales_won") {
    if (!v.salesMonth || !v.currency || v.target !== undefined || v.from || v.to) c.addIssue({ code: "custom", message: "Выберите существующий месячный план продаж." });
  } else {
    if (!v.from || !v.to || v.target === undefined || v.currency || v.salesMonth) c.addIssue({ code: "custom", message: "Укажите период и целевой показатель." });
    if (v.metric === "overdue_tasks" && !Number.isSafeInteger(v.target)) c.addIssue({ code: "custom", message: "Количество задач должно быть целым." });
    if (v.metric === "first_response_minutes" && (v.target === undefined || v.target < 0.01 || v.target > 10080)) c.addIssue({ code: "custom", message: "Укажите время от 0,01 до 10 080 минут." });
  }
}))();
export const goalChangeSchema = /* @__PURE__ */ (() => z.object({ requestId: id, version: z.number().int().positive(),
  title: z.string().trim().min(1).max(160).optional(), ownerMembershipId: id.optional(),
  target: z.number().finite().min(0).max(1_000_000).multipleOf(0.01, "Укажите не больше двух знаков после запятой.").optional(), state: z.enum(["active", "archived"]).optional(),
}).strict().refine(v => v.title !== undefined || v.ownerMembershipId || v.target !== undefined || v.state, "Укажите изменение."))();
export const goalRefreshSchema = /* @__PURE__ */ (() => z.object({ requestId: id }).strict())();
export const goalLinkSchema = /* @__PURE__ */ (() => z.object({ requestId: id, version: z.number().int().positive(), taskId: id, remove: z.boolean().default(false) }).strict())();
export const goalListSchema = /* @__PURE__ */ (() => z.object({ state: z.enum(["active", "archived", "all"]).default("active"), cursor: id.optional() }).strict())();
export type GoalCreate = z.infer<typeof goalCreateSchema>;
export type GoalChange = z.infer<typeof goalChangeSchema>;
export type GoalSample = {
  value: number | null; exact: string | null; status: "ready" | "no_data" | "incomplete" | "not_started" | "config_changed" | "plan_missing" | "ended_snapshot";
  samples: number; unanswered: number; excluded: number; formula: string; limitation: string;
};
export type GoalMeasurementView = {
  id: string; at: string; asOf: string; version: number; target: number | null; baseline: number | null;
  sample: GoalSample; progress: number | null; reached: boolean | null;
};
export type BusinessGoalView = {
  id: string; title: string; metric: GoalMetric; state: "active" | "archived"; version: number;
  from: string; to: string; timezone: string; currency: string | null; salesMonth: string | null; target: number | null;
  owner: { id: string; name: string; active: boolean }; canEdit: boolean; targetChanged: boolean;
  baseline: { value: number | null; at: string; status: GoalSample["status"] } | null;
  current: GoalMeasurementView | null; nextCheckAt: string | null; stale: boolean; periodEnded: boolean;
};
export type BusinessGoalDetail = BusinessGoalView & {
  measurements: GoalMeasurementView[];
  history: Array<{ id: string; type: string; at: string; version: number; changes: Record<string, unknown> }>;
  initiatives: Array<{ id: string; taskId: string; title: string; status: string; runId: string | null }>;
};
export type GoalOptions = { canEdit: boolean; timezone: string; members: Array<{ id: string; name: string }>;
  salesPlans: Array<{ month: string; currency: string; amount: number }>; selfId: string };
