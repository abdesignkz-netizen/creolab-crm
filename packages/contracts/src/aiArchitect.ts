import { z } from "zod";
import { AI_MANAGER_ROLES, type AiManagerGoalId } from "./aiManagerSetup.ts";
import type { SetupChannel } from "./onboarding.ts";
import type { ActionRunView } from "./aiAction.ts";

export const ARCHITECT_CHANNELS = ["whatsapp", "telegram", "instagram", "website-chat", "form"] as const;
export const ARCHITECT_KINDS = ["services", "retail", "booking", "food", "other", "unknown"] as const;
const text = (max: number) => z.string().trim().max(max);
export const architectAnswersSchema = z.object({
  locale: z.enum(["ru", "kk"]).default("ru"),
  businessKind: z.enum(ARCHITECT_KINDS).default("unknown"),
  description: text(3000).default(""), offerings: text(1500).default(""), audience: text(600).default(""),
  goal: z.enum([...AI_MANAGER_ROLES, "unknown"]).default("unknown"),
  channels: z.array(z.enum(ARCHITECT_CHANNELS)).max(5).default([]).refine(v => new Set(v).size === v.length),
  replyMode: z.enum(["manual", "assist", "auto"]).default("assist"),
  replyAudience: z.enum(["all", "new", "existing"]).default("all"),
  languages: z.array(z.enum(["ru", "kk"])).min(1).max(2).default(["ru", "kk"]).refine(v => new Set(v).size === v.length),
  hours: z.object({
    mode: z.enum(["always", "schedule", "unknown"]).default("unknown"),
    days: z.array(z.number().int().min(0).max(6)).max(7).default([]).refine(v => new Set(v).size === v.length),
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("09:00"),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("18:00"),
  }).strict().default({ mode: "unknown", days: [], start: "09:00", end: "18:00" }),
  responsibleMembershipId: z.string().uuid().nullable().default(null),
  firstResponseMinutes: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(30), z.literal(60)]).nullable().default(null),
  otherRequirements: text(1000).default(""),
}).strict();
export type ArchitectAnswers = z.infer<typeof architectAnswersSchema>;
export const architectPreviewSchema = z.object({ answers: architectAnswersSchema }).strict();
export const architectSaveSchema = architectPreviewSchema.extend({
  revision: z.number().int().nonnegative(), requestId: z.string().uuid(),
  baseRevision: z.string().regex(/^[a-f0-9]{64}$/), previewHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ArchitectSaveInput = z.infer<typeof architectSaveSchema>;

export type ArchitectItem = {
  key: string; title: string; disposition: "propose" | "keep" | "review" | "connect" | "unavailable";
  current: string; proposed: string; reason: string; sources: Array<keyof ArchitectAnswers | "currentSettings" | "capabilities">;
  to: string;
};
export type ArchitectQuestion = { field: keyof ArchitectAnswers; code: string; text: string };
export type ArchitectConfig = {
  schemaVersion: 1;
  // Free text remains owner-supplied evidence, never executable system instructions.
  profile: Pick<ArchitectAnswers, "businessKind" | "description" | "offerings" | "audience" | "languages">;
  pipeline: { strategy: "preserve" | "create_missing"; stages: Array<{ id?: string; systemKey: string; name: string; terminal: boolean }> };
  ai: { role: ArchitectAnswers["goal"]; goalPreset: AiManagerGoalId | null; goalText: string; successCriteria: string;
    replyMode: ArchitectAnswers["replyMode"]; replyAudience: ArchitectAnswers["replyAudience"]; hours: ArchitectAnswers["hours"];
    rules: Array<"approved_facts_only" | "clarify_unknown" | "human_on_request" | "no_unverified_confirmation" | "no_proactive_messages">;
    activation: "unchanged"; existingConfiguration: boolean };
  channels: Array<{ kind: SetupChannel; available: boolean; connected: boolean; connectionIds: string[] }>;
  handoff: { membershipId: string | null; firstResponseMinutes: ArchitectAnswers["firstResponseMinutes"]; notificationChannel: "in_app"; permissions: "unchanged" };
  task: { type: "follow_up"; title: string; executor: "human"; trigger: "review_required"; existingAutomation: "preserve" };
};
export type ArchitectPreview = {
  schemaVersion: 1; generator: "validated_templates_v1"; baseRevision: string; previewHash: string;
  config: ArchitectConfig; items: ArchitectItem[]; questions: ArchitectQuestion[]; limitations: string[];
  canApply: false; readyForReview: boolean;
};
export type ArchitectSavedDraft = {
  id: string; revision: number; answers: ArchitectAnswers; preview: ArchitectPreview;
  savedAt: string; expiresAt: string; stale: boolean; expired: boolean;
  appliedRevision?: number | null; appliedAt?: string | null; applicationRunId?: string | null;
};
export type ArchitectState = {
  companyName: string; timezone: string; revision: number;
  members: Array<{ id: string; name: string; role: string }>;
  channels: ArchitectConfig["channels"]; aiAvailable: boolean;
  defaults: ArchitectAnswers; draft: ArchitectSavedDraft | null;
};

export const architectApplyReviewSchema = z.object({ revision: z.number().int().positive() }).strict();
export const architectApplySchema = architectApplyReviewSchema.extend({
  requestId: z.string().uuid(), confirmed: z.literal(true), applicationHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ArchitectApplyInput = z.infer<typeof architectApplySchema>;
export type ArchitectApplyChange = {
  key: "pipeline" | "ai_draft" | "reply_rules" | "onboarding";
  title: string; before: string; after: string; to: string;
};
export type ArchitectApplyReview = {
  draftId: string; revision: number; applicationHash: string; expiresAt: string;
  canApply: boolean; blockers: string[]; changes: ArchitectApplyChange[]; pending: Array<{ text: string; to: string }>;
  run: ActionRunView | null;
};
