export const EVENT_CATEGORY: Record<string, string> = {
  "inquiry.created": "new_inquiries",
  "inquiry.available": "new_inquiries",
  needs_phone: "new_inquiries",
  "inquiry.assigned": "assignment",
  "inquiry.taken": "assignment",
  "deal.assigned": "assignment",
  "conversation.needs_human": "dialogs",
  "conversation.message": "dialogs",
  "task.assigned": "tasks",
  "task.due": "tasks",
  "task.reminder": "tasks",
  "task.send_failed": "tasks",
  "agreement.reminder": "tasks",
  "agreement.needs_confirmation": "tasks",
  "contract.signed": "deals",
  "support.replied": "dialogs",
  "billing.subscription": "management",
  "sales.proposal": "deals",
  "sales.attention": "deals",
  "deal.updated": "deals",
  "deal.stage_changed": "deals",
  "ai.needs_human": "ai_events",
  "inquiry.needs_human": "ai_events",
  "integration.error": "management",
  "ai_manager.pause": "management",
  "campaign.failed": "management",
};

export function inQuietHours(quiet: { enabled?: boolean; start?: string; end?: string } | null | undefined, timeZone?: string | null) {
  if (!quiet?.enabled) return false;
  const start = String(quiet.start || "22:00");
  const end = String(quiet.end || "08:00");
  const now = new Date();
  let safeZone = timeZone || "Asia/Almaty";
  try { new Intl.DateTimeFormat("en", { timeZone: safeZone }); } catch { safeZone = "Asia/Almaty"; }
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: safeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hh = parts.find((part) => part.type === "hour")?.value || "00";
  const mm = parts.find((part) => part.type === "minute")?.value || "00";
  const current = `${hh}:${mm}`;
  if (start <= end) return current >= start && current < end;
  return current >= start || current < end;
}

