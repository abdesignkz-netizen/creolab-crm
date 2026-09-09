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
  MANUAL_TAKEOVER: "Диалог забрали вручную",
  taken_by_human: "Диалог уже у менеджера",
  human: "Диалог уже у менеджера",
  human_required: "AI не может продолжить без человека",
  needs_reply: "Клиент написал, AI просит человека ответить",
  escalate: "AI передал диалог человеку",
  paused: "Диалог на паузе",
  global_ai_pause: "AI Manager на паузе",
  AI_ANALYSIS_FAILED: "Не удалось сформировать ответ",
  AI_OUTBOUND_FAILED: "Не удалось отправить сообщение",
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

export function attentionReasonLabel(code: string | null | undefined, fallback = "Нужно вмешательство человека") {
  const key = String(code || "").trim();
  if (!key) return fallback;
  return ATTENTION_REASON_LABEL[key] || fallback;
}

export function looksLikeAttentionCode(value: string | null | undefined) {
  const key = String(value || "").trim();
  return Boolean(key) && (key in ATTENTION_REASON_LABEL || /^[a-z][a-z0-9_]*$/.test(key));
}
