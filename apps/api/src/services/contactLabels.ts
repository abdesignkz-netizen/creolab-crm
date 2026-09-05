export const LIFECYCLE_LABEL: Record<string, string> = {
  new: "Новый",
  in_progress: "В работе",
  active: "Активный",
  paused: "На паузе",
  lost: "Потерян",
  archived: "Архив",
};

export const INQUIRY_STATUS_LABEL: Record<string, string> = {
  new: "Новая",
  qualification: "Квалификация",
  qualified: "Квалифицирован",
  accepted: "В работе",
  in_progress: "В работе",
  waiting_client: "Ждём клиента",
  waiting_manager: "Нужен ответ менеджера",
  converted: "Конвертирована",
  closed: "Закрыта",
  lost: "Потеряна",
};

export const TEMP_LABEL: Record<string, string> = {
  hot: "Горячий",
  warm: "Тёплый",
  cold: "Холодный",
  unknown: "Не указано",
};

export const SOURCE_LABEL: Record<string, string> = {
  whatsapp: "WhatsApp",
  form: "Форма сайта",
  webhook: "Webhook",
  manual: "Вручную",
  seed_form: "Форма (демо)",
  seed_manual: "Вручную (демо)",
  telegram: "Telegram",
  instagram: "Instagram",
  api: "API",
  phone_call: "Звонок",
};

export const TASK_TYPE_LABEL: Record<string, string> = {
  process_inquiry: "Обработать обращение",
  call: "Позвонить",
  proposal: "Отправить КП",
  payment: "Проверить оплату",
  message: "Написать",
  follow_up: "Напомнить",
  meeting: "Встреча",
  send_documents: "Отправить документы",
  prepare_estimate: "Подготовить расчёт",
  wait_client: "Ждать клиента",
  other: "Другое",
};

export const LOST_REASONS = [
  "дорого",
  "выбрал конкурента",
  "не отвечает",
  "передумал",
  "не подходит услуга",
  "нет бюджета",
  "отложил",
  "ошибочная заявка",
  "спам",
  "другое",
] as const;

export function displayName(contact: {
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}) {
  const parts = [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim();
  return parts || contact.name || "Без имени";
}

export function digitsOnly(value: string) {
  return value.replace(/\D+/g, "");
}

export function formatWhen(value: Date | string | null | undefined, timeZone = "Asia/Almaty") {
  if (!value) return null;
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function minutesAgo(value: Date | null | undefined, now = new Date()) {
  if (!value) return null;
  return Math.max(0, Math.floor((now.getTime() - value.getTime()) / 60000));
}

export function whoWroteLast(contact: {
  lastInboundMessageAt?: Date | null;
  lastOutboundMessageAt?: Date | null;
  lastContactAt?: Date | null;
}) {
  const inbound = contact.lastInboundMessageAt?.getTime() || 0;
  const outbound = contact.lastOutboundMessageAt?.getTime() || 0;
  if (!inbound && !outbound) return null;
  if (inbound > outbound) return "client" as const;
  if (outbound > inbound) return "team" as const;
  return "unknown" as const;
}

export function needsReply(contact: {
  lastInboundMessageAt?: Date | null;
  lastOutboundMessageAt?: Date | null;
}) {
  const inbound = contact.lastInboundMessageAt;
  if (!inbound) return false;
  const outbound = contact.lastOutboundMessageAt;
  if (!outbound) return true;
  return inbound.getTime() > outbound.getTime();
}

export function budgetLabel(inquiry: {
  budgetMin?: number | null;
  budgetMax?: number | null;
  currency?: string | null;
}) {
  const currency = inquiry.currency || "KZT";
  if (inquiry.budgetMin != null && inquiry.budgetMax != null) {
    if (inquiry.budgetMin === inquiry.budgetMax) return `${inquiry.budgetMin.toLocaleString("ru-RU")} ${currency}`;
    return `${inquiry.budgetMin.toLocaleString("ru-RU")} – ${inquiry.budgetMax.toLocaleString("ru-RU")} ${currency}`;
  }
  if (inquiry.budgetMin != null) return `от ${inquiry.budgetMin.toLocaleString("ru-RU")} ${currency}`;
  if (inquiry.budgetMax != null) return `до ${inquiry.budgetMax.toLocaleString("ru-RU")} ${currency}`;
  return null;
}
