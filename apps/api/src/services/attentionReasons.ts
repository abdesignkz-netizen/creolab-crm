import { systemText } from "@creolab/contracts";
/** Staff-facing labels for conversation / inquiry attention codes. Never show the raw key. */
const ATTENTION_REASON_LABEL: Record<string, string> = {
  CLIENT_REQUESTED_HUMAN: "Клиент попросил менеджера",
  LOW_CONFIDENCE: "AI не уверен в ответе",
  CUSTOM_PRICING: "Нужен индивидуальный расчёт",
  TECHNICAL_QUESTION: "Сложный технический вопрос",
  CONTRACT: "Нужен человек по договору",
  PAYMENT: "Нужен человек по оплате",
  COMPLAINT: "Жалоба — нужен менеджер",
  CONFLICT: "Конфликт — нужен менеджер",
  AI_ERROR: "Ошибка AI",
  AI_PROMPT_MISSING: "Промпт компании не опубликован. Обратитесь к администратору.",
  AI_MODEL_MISSING: "Модель ИИ не подключена. Администратору нужно проверить ключ модели.",
  AI_DISABLED: "ИИ отключён в настройках компании или сервиса.",
  AI_PLAN_REQUIRED: "ИИ-менеджер не входит в тариф",
  AI_TENANT_INACTIVE: "Доступ компании приостановлен",
  AI_CREDITS_EXHAUSTED: "Закончились AI-кредиты. Пополните лимит для продолжения ответов.",
  AI_PROVIDER_AUTH: "Провайдер ИИ отклонил ключ доступа. Обратитесь к администратору.",
  AI_PROVIDER_LIMIT: "Провайдер ИИ ограничил запросы. Администратору нужно проверить баланс и лимиты.",
  AI_PROVIDER_CONFIG: "Провайдер ИИ отклонил настройки модели. Обратитесь к администратору.",
  AI_INVALID_RESPONSE: "Модель ИИ вернула ответ в неподдерживаемом формате.",
  AI_VOICE_UNAVAILABLE: "Не удалось распознать голосовое сообщение. Прослушайте запись и ответьте клиенту.",
  AI_VOICE_UNSUPPORTED: "Формат или размер голосового сообщения не поддерживается. Прослушайте запись и ответьте клиенту.",
  AI_PROVIDER_UNAVAILABLE: "Не удалось получить ответ от модели ИИ. Повторите позже или обратитесь к администратору.",
  AI_CHANNEL_RESTRICTED: "Автоответ остановлен настройками диалога, подключения или ограничением WhatsApp.",

  MANUAL_TAKEOVER: "Диалог забрали вручную",
  taken_by_human: "Диалог уже у менеджера",
  human: "Диалог уже у менеджера",
  human_required: "AI не может продолжить без человека",
  needs_reply: "Клиент написал, AI просит человека ответить",
  escalate: "AI передал диалог человеку",
  paused: "Диалог на паузе",
  global_ai_pause: "AI на паузе",
  AI_ANALYSIS_FAILED: "Не удалось сформировать ответ",
  AI_OUTBOUND_FAILED: "Не удалось отправить сообщение",
  WHATSAPP_NOT_REGISTERED: "Контакт не зарегистрирован в WhatsApp",
  NO_AUTOMATED_CHANNEL: "Нет канала, чтобы AI ответил",
  seller_lead_rematched: "Чат отвязался от WhatsApp после перепривязки",
  OTHER: "Нужно вмешательство человека",
};

/** Reasons that only describe status, not a pending action. */
export const STATUS_ONLY_ATTENTION = new Set([
  "taken_by_human",
  "human",
  "paused",
  "seller_lead_rematched",
  "MANUAL_TAKEOVER",
]);

export function attentionReasonLabel(code: string | null | undefined, fallback = "Нужно вмешательство человека", locale = "ru") {
  const key = String(code || "").trim();
  if (!key) return systemText(locale, fallback);
  return systemText(locale, ATTENTION_REASON_LABEL[key] || fallback);
}

export function looksLikeAttentionCode(value: string | null | undefined) {
  const key = String(value || "").trim();
  return Boolean(key) && (key in ATTENTION_REASON_LABEL || /^[a-z][a-z0-9_]*$/.test(key));
}
