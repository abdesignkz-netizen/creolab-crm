import { STATUS_ONLY_ATTENTION } from "./attentionReasons.ts";
import { taskMarkedForScheduledSend } from "./taskExecutionService.ts";
import { PROCESS_OPEN_TASK_STATUSES } from "./dealProcessPolicy.ts";

export function conversationNeedsPriorityAction(conversation: {
  mode?: string | null; needsAttention?: boolean | null; attentionReason?: string | null; updatedAt: Date;
}, waitingReply: boolean, now: Date) {
  if (conversation.mode === "ai") return Boolean(conversation.needsAttention);
  if (conversation.mode === "paused") return now.getTime() - conversation.updatedAt.getTime() >= 120 * 60_000;
  if (conversation.mode === "human") return waitingReply || Boolean(conversation.needsAttention &&
    conversation.attentionReason && !STATUS_ONLY_ATTENTION.has(conversation.attentionReason));
  return false;
}

export function attentionTaskKind(task: Parameters<typeof taskMarkedForScheduledSend>[0] & {
  status: string; dueAt: Date | null; priority: string; ownerMembershipId: string | null;
}, now: Date, timeZone: string) {
  if (!PROCESS_OPEN_TASK_STATUSES.includes(task.status) || taskMarkedForScheduledSend(task, now)) return null;
  if (task.dueAt && task.dueAt < now) return "task_overdue";
  if (task.status === "waiting") return null;
  if (task.dueAt && new Intl.DateTimeFormat("en-CA", { timeZone }).format(task.dueAt) ===
    new Intl.DateTimeFormat("en-CA", { timeZone }).format(now)) return "task_due_today";
  if (!task.dueAt && task.priority === "high" && !task.ownerMembershipId && task.status === "open") return "task_unassigned_hot";
  return null;
}
