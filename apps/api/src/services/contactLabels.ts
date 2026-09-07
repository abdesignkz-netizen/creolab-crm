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
  qualified: "Квалифицирована",
  accepted: "В работе",
  in_progress: "В работе",
  waiting_client: "Ждём клиента",
  waiting_manager: "Нужен ответ менеджера",
  proposal: "КП отправлено",
  converted: "Конвертирована в сделку",
  closed: "Отменена",
  cancelled: "Отменена",
  lost: "Потеряна",
  invalid: "Некорректная",
  spam: "Спам",
  duplicate: "Дубликат",
};

export const INQUIRY_ACTIVE_STATUSES = [
  "new",
  "qualification",
  "qualified",
  "accepted",
  "in_progress",
  "waiting_client",
  "waiting_manager",
  "proposal",
] as const;

export const SERVICE_CATEGORY_LABEL: Record<string, string> = {
  web: "Сайты",
  presentation: "Презентации",
  branding: "Брендинг",
  advertising: "Реклама",
  ai: "AI",
  other: "Другое",
};

export const SOURCE_CHANNEL_LABEL: Record<string, string> = {
  whatsapp: "WhatsApp",
  website_form: "Форма сайта",
  website: "Форма сайта",
  website_ai: "Website AI",
  telegram: "Telegram",
  instagram: "Instagram",
  phone: "Звонок",
  phone_call: "Звонок",
  manual: "Ручное добавление",
  api: "API",
  form: "Форма сайта",
  other: "Другое",
};

export const SOURCE_ATTR_LABEL: Record<string, string> = {
  google_ads: "Google Ads",
  instagram: "Instagram",
  organic: "Organic",
  referral: "Referral",
  direct: "Direct",
  other: "Другое",
};

export const INTAKE_REASON_LABEL: Record<string, string> = {
  missing_phone: "Обращение без телефона",
  needs_phone: "Нет телефона",
  no_contact: "Нет доступного способа связи",
  missing_service: "Не определена услуга",
  missing_subject: "Неизвестна тема",
  unlinked_client: "Клиент не связан",
  ai_review: "Нужна ручная проверка AI",
  possible_duplicate: "Дубликат под вопросом",
};

export const INQUIRY_LOST_REASONS = [
  { value: "expensive", label: "Дорого" },
  { value: "no_reply", label: "Не отвечает" },
  { value: "no_budget", label: "Нет бюджета" },
  { value: "competitor", label: "Выбрал конкурента" },
  { value: "changed_mind", label: "Передумал" },
  { value: "wrong_inquiry", label: "Ошибочное обращение" },
  { value: "spam", label: "Спам" },
  { value: "not_our_service", label: "Не наша услуга" },
  { value: "other", label: "Другое" },
] as const;

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

export function formatPhoneDisplay(value?: string | null) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const digits = digitsOnly(trimmed);
  if (digits.length === 11 && digits.startsWith("7")) {
    return `+7 ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7, 9)} ${digits.slice(9, 11)}`;
  }
  if (digits.length === 10) {
    return `+7 ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 8)} ${digits.slice(8, 10)}`;
  }
  return trimmed;
}

export function phoneFromContact(
  contact?: {
    methods?: Array<{ type: string; rawValue?: string | null; normalizedValue?: string | null; primary?: boolean }> | null;
  } | null,
  extras?: { phoneRaw?: string | null; phoneNormalized?: string | null; externalThreadId?: string | null } | null,
) {
  const methods = contact?.methods || [];
  const phones = methods.filter((item) => item.type === "phone" || item.type === "whatsapp");
  const primary = phones.find((item) => item.primary) || phones[0];
  if (primary?.rawValue) return primary.rawValue;
  if (primary?.normalizedValue) return formatPhoneDisplay(primary.normalizedValue);
  if (extras?.phoneRaw) return extras.phoneRaw;
  if (extras?.phoneNormalized) return formatPhoneDisplay(extras.phoneNormalized);
  if (extras?.externalThreadId) {
    const digits = digitsOnly(extras.externalThreadId);
    if (digits.length >= 10 && digits.length <= 15) return formatPhoneDisplay(digits);
  }
  return null;
}

export const CONTACT_PHONE_SELECT = {
  name: true,
  firstName: true,
  lastName: true,
  methods: { select: { type: true, rawValue: true, normalizedValue: true, primary: true } },
} as const;

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
