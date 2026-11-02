import { z } from "zod";
import type { ProcessCalendar } from "./processCalendar.ts";

export const autopilotConfigSchema = /* @__PURE__ */ (() => z.object({
  mode: z.enum(["suggest", "auto"]),
  remindMinutes: z.number().int().min(5).max(1440),
  escalateMinutes: z.number().int().min(5).max(4320),
  verifyMinutes: z.number().int().min(5).max(4320),
  hourlyLimit: z.number().int().min(1).max(50),
  routing: z.enum(["fixed", "round_robin", "least_load"]),
  members: z.array(z.string().uuid()).min(1).max(8).refine(ids => new Set(ids).size === ids.length, "Сотрудники не должны повторяться"),
  unavailable: z.array(z.object({ membershipId: z.string().uuid(), until: z.string().datetime({ offset: true }) }).strict()).max(8),
  escalationMemberId: z.string().uuid(),
}).strict().superRefine((c, ctx) => {
  if (c.routing === "fixed" && c.members.length !== 1) ctx.addIssue({ code: "custom", path: ["members"], message: "Для фиксированного назначения выберите одного сотрудника." });
  if (c.unavailable.some(u => ![...c.members, c.escalationMemberId].includes(u.membershipId)) || new Set(c.unavailable.map(u => u.membershipId)).size !== c.unavailable.length)
    ctx.addIssue({ code: "custom", path: ["unavailable"], message: "Проверьте список временно недоступных сотрудников." });
}))();
export const autopilotSaveSchema = /* @__PURE__ */ (() => z.object({ requestId: z.string().uuid(), version: z.number().int().nonnegative(), config: autopilotConfigSchema }).strict())();
export const autopilotOperationSchema = /* @__PURE__ */ (() => z.object({ requestId: z.string().uuid(), version: z.number().int().positive(), confirmed: z.literal(true) }).strict())();
export type AutopilotConfig = z.infer<typeof autopilotConfigSchema>;
export const DEFAULT_AUTOPILOT_CONFIG: AutopilotConfig = {
  mode: "suggest", remindMinutes: 15, escalateMinutes: 60, verifyMinutes: 120, hourlyLimit: 10,
  routing: "fixed", members: [], unavailable: [], escalationMemberId: "",
};
export type AutopilotCaseView = {
  id: string; version: number; inquiryId: string; title: string; customer: string; state: string;
  explanation: string; dueAt: string | null; taskId: string | null; assignedName: string | null;
  createdAt: string; canStart: boolean; canStop: boolean;
  history: Array<{ id: string; type: string; text: string; at: string; runId: string | null }>;
};
export type AutopilotView = {
  policy: { version: number; state: string; enabledAt: string | null; config: AutopilotConfig } | null;
  members: Array<{ id: string; name: string; role: string }>;
  calendar: ProcessCalendar; timezone: string; blocked: string[];
  canEdit: boolean; canEnableAuto: boolean; items: AutopilotCaseView[]; nextCursor: string | null;
};
export type AutopilotPreview = { summary: string[]; blockers: string[]; calendarHash: string };
