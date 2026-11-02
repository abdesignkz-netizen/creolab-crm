import { z } from "zod";

export const ACTION_PLAN_MAX_STEPS = 5;
const id = z.string().uuid();
const text = (max: number) => z.string().trim().min(1).max(max);
const key = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);
const target = z.union([
  z.object({ taskId: id }).strict(),
  z.object({ fromStep: key }).strict(),
]);
export const actionStepSchema = z.discriminatedUnion("kind", [
  z.object({ key, kind: z.literal("opportunity.task"), insightId: id, version: z.number().int().positive(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/), ownerMembershipId: id,
    dueAt: z.string().datetime({ offset: true }),
  }).strict(),
  z.object({ key, kind: z.literal("task.create"), title: text(240),
    type: z.enum(["note", "message", "proposal", "follow_up", "meeting", "send_documents"]),
    description: text(4000).optional(), contactId: id.optional(), dueAt: z.string().datetime({ offset: true }).optional(),
    ownerMembershipId: id.optional(),
  }).strict(),
  z.object({ key, kind: z.literal("task.assign"), target, membershipId: id }).strict(),
  z.object({ key, kind: z.literal("task.draft"), target, text: text(6000) }).strict(),
  z.object({ key, kind: z.literal("staff.notify"), target, membershipId: id, text: text(1000) }).strict(),
]);
export const actionPlanSchema = z.object({
  requestId: id, title: text(160), steps: z.array(actionStepSchema).min(1).max(ACTION_PLAN_MAX_STEPS),
  decisions: z.array(z.object({ id, version: z.number().int().positive() }).strict()).max(3).optional(),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>(), created = new Set<string>();
  const tasks = new Set<string>();
  value.steps.forEach((step, i) => {
    if (seen.has(step.key)) ctx.addIssue({ code: "custom", path: ["steps", i, "key"], message: "Ключ шага повторяется" });
    if ("target" in step && "fromStep" in step.target && !created.has(step.target.fromStep)) {
      ctx.addIssue({ code: "custom", path: ["steps", i, "target"], message: "Выберите задачу из предыдущего шага создания" });
    }
    seen.add(step.key);
    if (step.kind === "opportunity.task") {
      tasks.add(`opportunity:${step.insightId}`);
      if (value.steps.length !== 1) ctx.addIssue({ code: "custom", path: ["steps"], message: "Действие по возможности подтверждается отдельно." });
    }
    else if (step.kind === "task.create") { created.add(step.key); tasks.add(`new:${step.key}`); }
    else tasks.add("taskId" in step.target ? `existing:${step.target.taskId}` : `new:${step.target.fromStep}`);
  });
  // This first registry version is a small individual workflow, not bulk control.
  if (created.size > 1) ctx.addIssue({ code: "custom", path: ["steps"], message: "В одном плане можно создать одну задачу" });
  if (tasks.size > 1) ctx.addIssue({ code: "custom", path: ["steps"], message: "Один план работает с одной задачей. Для другой задачи подготовьте отдельный план." });
});
export const actionConfirmSchema = z.object({ requestId: id, confirmed: z.literal(true), planHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const actionCancelSchema = z.object({ requestId: id }).strict();
export type ActionInput = z.infer<typeof actionStepSchema>;
export type ActionPlanInput = z.infer<typeof actionPlanSchema>;
export type ActionRunStatus = "draft" | "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired";
export type ActionRunView = {
  id: string; title: string; status: ActionRunStatus; planHash: string; createdAt: string; expiresAt: string;
  confirmedAt: string | null; finishedAt: string | null; error: string | null;
  canConfirm: boolean; canCancel: boolean; completed: number;
  source?: "control" | "architect" | "opportunity" | "autopilot";
  decisions?: Array<{ id: string; version: number }>;
  steps: Array<{ key: string; kind: ActionInput["kind"] | "architect.settings" | "autopilot.internal"; label: string; detail: string;
    status: "pending" | "succeeded" | "failed" | "skipped"; error: string | null;
    taskId: string | null; result: string | null; finishedAt: string | null }>;
};
export type ActionRunSummary = Pick<ActionRunView, "id" | "title" | "status" | "createdAt" | "completed" | "source"> & { stepCount: number };
