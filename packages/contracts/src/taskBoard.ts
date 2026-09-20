export const TASK_BOARD_LANES = ["ai", "managers", "notes"] as const;
export type TaskBoardLane = (typeof TASK_BOARD_LANES)[number];

const AI_SOURCES = new Set(["ai_command", "ai_automation", "context_engine", "system"]);

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
