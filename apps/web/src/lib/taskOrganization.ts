export const TASK_CATEGORIES = [
  { id: "all", label: "Все категории" },
  { id: "clients", label: "Клиенты" },
  { id: "documents", label: "Документы и расчёты" },
  { id: "payments", label: "Оплаты" },
  { id: "internal", label: "Внутренние" },
  { id: "campaigns", label: "Рассылки" },
] as const;
export type TaskCategory = typeof TASK_CATEGORIES[number]["id"];

type CategorizedTask = {
  type?: string; campaignId?: string | null; source?: string; targetType?: string;
  contactId?: string | null; inquiryId?: string | null; dealId?: string | null;
  conversationId?: string | null; companyId?: string | null;
  parsedCommandJson?: { campaignId?: unknown } | null;
};

/** Categories describe work, independently of status, deadline or who created it. */
export function taskCategory(task: CategorizedTask): Exclude<TaskCategory, "all"> {
  if (task.campaignId || task.parsedCommandJson?.campaignId || task.source === "campaign") return "campaigns";
  if (task.type === "payment") return "payments";
  if (["proposal", "send_documents", "prepare_estimate"].includes(task.type || "")) return "documents";
  if (task.type === "note") return "internal";
  if (["call", "message", "follow_up", "meeting", "wait_client", "process_inquiry"].includes(task.type || "")) return "clients";
  if (task.contactId || task.inquiryId || task.dealId || task.conversationId || task.companyId || task.targetType === "group" || task.targetType === "client") return "clients";
  return "internal";
}

export const TASK_TEMPLATES = [
  { id: "message", label: "Связаться с клиентом", hint: "Уточнить запрос или ответить на вопрос", example: "Уточнить бюджет и сроки проекта", target: "client" },
  { id: "follow_up", label: "Напомнить о предложении", hint: "Вернуться к клиенту после разговора", example: "Узнать решение по предложению", target: "client" },
  { id: "meeting", label: "Провести встречу", hint: "Обсудить проект и договориться о следующем шаге", example: "Обсудить задачи проекта на встрече", target: "client" },
  { id: "proposal", label: "Подготовить предложение", hint: "КП, документы или расчёт стоимости", example: "Подготовить коммерческое предложение", target: "client" },
  { id: "payment", label: "Проверить оплату", hint: "Сверить поступление по счёту", example: "Проверить поступление оплаты по счёту", target: "client" },
  { id: "other", label: "Внутренняя задача", hint: "Поручение себе или коллеге", example: "Подготовить отчёт за неделю", target: "none" },
] as const;

export function matchesTaskSearch(task: Record<string, any>, query: string, title: string, assignee: string) {
  const phone = String(task.whoPhone || "").replace(/\D/g, "");
  const text = [task.title, title, task.whoName, task.whoPhone, task.contact?.name, task.contact?.firstName,
    task.contact?.lastName, task.contextLabel, assignee].filter(Boolean).join(" ").toLocaleLowerCase();
  const trimmed = query.trim().toLocaleLowerCase();
  // Phone search tolerates spaces/brackets/dashes used by the display formatter.
  if (/^[+\d\s()-]+$/.test(trimmed)) return phone.includes(trimmed.replace(/\D/g, ""));
  return trimmed.split(/\s+/).filter(Boolean).every(term => text.includes(term));
}
