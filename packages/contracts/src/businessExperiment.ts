import { z } from "zod";

const uuid = /* @__PURE__ */ (() => z.string().uuid())();
const day = /* @__PURE__ */ (() => z.string().regex(/^\d{4}-\d{2}-\d{2}$/))();
const reference = /* @__PURE__ */ (() => z.object({ id: uuid, version: z.number().int().positive() }).strict())();
export const experimentMethodSchema = /* @__PURE__ */ (() => z.object({
  metric: z.literal("proposal_preparation_minutes"), baselineFrom: day, baselineTo: day, from: day, to: day,
  memberIds: z.array(uuid).min(1).max(20).refine(ids => new Set(ids).size === ids.length, "Выберите разных сотрудников."),
  minimumSample: z.number().int().min(10).max(500), targetReductionPercent: z.number().finite().min(1).max(90),
  initiativeTaskId: uuid, goal: reference.optional(), decision: reference.optional(),
}).strict())();
export const experimentSaveSchema = /* @__PURE__ */ (() => z.object({
  requestId: uuid, version: z.number().int().positive().optional(), title: z.string().trim().min(3).max(160),
  hypothesis: z.string().trim().min(10).max(1200), change: z.string().trim().min(10).max(1200), method: experimentMethodSchema,
}).strict())();
export const experimentOperationSchema = /* @__PURE__ */ (() => z.object({
  requestId: uuid, version: z.number().int().positive(), reviewHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  note: z.string().trim().min(5).max(800).optional(),
}).strict())();
export const experimentListSchema = /* @__PURE__ */ (() => z.object({ cursor: uuid.optional(), state: z.enum(["active", "finished", "all"]).default("active") }).strict())();
export type ExperimentMethod = z.infer<typeof experimentMethodSchema>;
export type ExperimentSave = z.infer<typeof experimentSaveSchema>;
export type ExperimentOperation = z.infer<typeof experimentOperationSchema>;
export type ExperimentState = "draft" | "running" | "completed" | "stopped";
export type ExperimentSample = {
  total: number; prepared: number; pending: number; medianMinutes: number | null; meanMinutes: number | null;
  capped: boolean; fingerprint: string; byMember: Record<string, number>; from: string; to: string; asOf: string;
};
export type ExperimentResult = {
  status: "in_progress" | "insufficient_data" | "conditions_changed" | "improvement_observed" | "no_improvement";
  baseline: ExperimentSample; current: ExperimentSample; reductionPercent: number | null;
  reasons: string[]; recommendation: string; causal: false; at: string;
};
export type BusinessExperimentSummary = { id: string; title: string; state: ExperimentState; version: number; from: string; to: string; updatedAt: string };
export type BusinessExperimentDetail = BusinessExperimentSummary & {
  hypothesis: string; change: string; method: ExperimentMethod; timezone: string; methodVersion: string; canEdit: boolean;
  baseline: ExperimentSample | null; reviewHash: string | null; result: ExperimentResult | null; approvedAt: string | null; stopReason: string | null;
  initiative: { id: string; title: string; status: string; href: string; runHref: string | null } | null;
  members: Array<{ id: string; name: string; active: boolean }>;
  history: Array<{ id: string; type: string; at: string; version: number; note: string | null }>;
  measurements: Array<{ id: string; at: string; result: ExperimentResult }>;
  limitations: string[];
};
export type ExperimentOptions = { canEdit: boolean; timezone: string; today: string;
  members: Array<{ id: string; name: string }>; goals: Array<{ id: string; title: string; version: number }>;
  decisions: Array<{ id: string; title: string; version: number }>;
};
