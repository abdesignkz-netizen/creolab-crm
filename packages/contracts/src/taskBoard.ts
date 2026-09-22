export const TASK_BOARD_LANES = ["ai", "managers", "notes"] as const;
export type TaskBoardLane = (typeof TASK_BOARD_LANES)[number];

export const AI_TASK_SOURCES = new Set(["ai_command", "ai_automation", "context_engine", "system"]);
export const SYSTEM_TASK_SOURCES = new Set(["rule", "campaign"]);

export const AI_ASSIGNABLE_TASK_TYPES = [
  "proposal",
  "message",
  "send_documents",
  "prepare_estimate",
  "follow_up",
  "process_inquiry",
] as const;

export type AiAssignableTaskType = (typeof AI_ASSIGNABLE_TASK_TYPES)[number];
export type TaskCreatedByKind = "ai" | "system" | "user";
export type TaskAssigneeKind = "user" | "ai" | "unassigned";

const AI_SOURCES = AI_TASK_SOURCES;

function snapshotObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function isAiAssignableTaskType(type?: string | null): boolean {
  return AI_ASSIGNABLE_TASK_TYPES.includes(String(type || "") as AiAssignableTaskType);
}

export function taskBoardLane(task: {
  source?: string | null;
  type?: string | null;
  targetType?: string | null;
  contactId?: string | null;
  inquiryId?: string | null;
  dealId?: string | null;
  conversationId?: string | null;
  companyId?: string | null;
  campaignId?: string | null;
}): TaskBoardLane {
  const source = String(task.source || "manual");
  if (AI_SOURCES.has(source) || task.type === "process_inquiry") return "ai";
  const linked = Boolean(
    task.contactId ||
      task.inquiryId ||
      task.dealId ||
      task.conversationId ||
      task.companyId ||
      task.campaignId ||
      task.targetType === "client" ||
      task.targetType === "group",
  );
  if (!linked && (task.type === "note" || task.type === "other")) return "notes";
  return "managers";
}

export function mergeTaskContextSnapshot(
  existing: unknown,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...snapshotObject(existing), ...patch };
}

export function taskCreatorSnapshot(args: {
  createdByKind: TaskCreatedByKind;
  createdByMembershipId?: string | null;
  executorType?: "AI" | "USER";
  existing?: unknown;
}): Record<string, unknown> {
  return mergeTaskContextSnapshot(args.existing, {
    createdByKind: args.createdByKind,
    ...(args.createdByMembershipId ? { createdByMembershipId: args.createdByMembershipId } : {}),
    ...(args.executorType ? { executorType: args.executorType } : {}),
  });
}

export function taskCreatedByKind(task: {
  source?: string | null;
  type?: string | null;
  contextSnapshotJson?: unknown;
}): TaskCreatedByKind {
  const snap = snapshotObject(task.contextSnapshotJson);
  if (snap.createdByKind === "ai" || snap.createdByKind === "system" || snap.createdByKind === "user") {
    return snap.createdByKind;
  }
  const source = String(task.source || "manual");
  if (AI_TASK_SOURCES.has(source) || task.type === "process_inquiry") return "ai";
  if (SYSTEM_TASK_SOURCES.has(source)) return "system";
  return "user";
}

export function taskCreatedByLabel(kind: TaskCreatedByKind): string {
  if (kind === "ai") return "AI Manager";
  if (kind === "system") return "Автоматизация";
  return "Сотрудник";
}

export function taskAssigneeKind(task: {
  ownerMembershipId?: string | null;
  contextSnapshotJson?: unknown;
}): TaskAssigneeKind {
  const snap = snapshotObject(task.contextSnapshotJson);
  if (String(snap.executorType || "").toUpperCase() === "AI" && !task.ownerMembershipId) return "ai";
  if (task.ownerMembershipId) return "user";
  return "unassigned";
}

export function displayTaskStatus(status?: string | null): string {
  if (status === "open") return "К выполнению";
  if (status === "in_progress") return "В работе";
  if (status === "waiting") return "Жду";
  if (status === "done") return "Завершено";
  if (status === "canceled") return "Отменено";
  return status || "";
}
