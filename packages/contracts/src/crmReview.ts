import type { CrmCommercialField, CrmCommercialValues, CrmMoney } from "./crmCommercial.ts";
export type CrmReviewEntity = "contact" | "inquiry";
export type CrmReviewField = "summary" | "aiSummary" | "nextStep" | "status" | "needsReply" | CrmCommercialField;
export type CrmReviewValue = string | boolean | CrmMoney | null;
export type CrmReviewStatus = "pending" | "accepted" | "automatic" | "dismissed" | "superseded" | "undone";
export type CrmReviewBlock = "changed" | "conversation_changed" | "permissions" | "unavailable" | "effects_started" | "calendar" | "related_activity" | "settings_changed" | "expired" | null;
export type CrmCalendarEffect = {
  agreementId: string; integrationId: string; title: string; calendar: string;
  state: "pending" | "removal_pending" | "syncing" | "synced" | "removed" | "error" | "uncertain" | "disconnected" | "unverified";
  checkedAt: string | null;
};
export type CrmProcessQueue = {
  kind: "reminders" | "actions";
  queued: number; running: number; processed: number; canceled: number; needsCheck: number;
};
export type CrmProcessReviewEntry = {
  entityType: "deal" | "agreement" | "task";
  entityId: string;
  title: string;
  created: boolean;
  fields: Array<{ label: string; before: string | null; after: string | null; status?: boolean }>;
};
export type CrmReviewItem = {
  id: string;
  entityType: CrmReviewEntity | "process";
  entityId: string;
  status: CrmReviewStatus;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  createdAt: string;
  fields: Array<{ key: CrmReviewField; before: CrmReviewValue; after: CrmReviewValue }>;
  evidence: Array<{ id: string; text: string | null; quote?: string; createdAt: string; senderKind: string; direction: string }>;
  canAccept: boolean;
  canDismiss: boolean;
  canUndo: boolean;
  blockedReason: CrmReviewBlock;
  process?: { entries: CrmProcessReviewEntry[]; reminders: number; calendarSync?: boolean; calendarEffects?: CrmCalendarEffect[]; queues?: CrmProcessQueue[] };
};
export type CrmReviewList = { items: CrmReviewItem[]; hasMore: boolean; commercial?: CrmCommercialValues | null };
