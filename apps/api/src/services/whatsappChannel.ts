export const WHATSAPP_NOT_REGISTERED = "WHATSAPP_NOT_REGISTERED";
export const NO_AUTOMATED_CHANNEL = "NO_AUTOMATED_CHANNEL";
export const AI_OUTBOUND_FAILED = "AI_OUTBOUND_FAILED";

export const WHATSAPP_HOME_ATTENTION_CODES = [
  WHATSAPP_NOT_REGISTERED,
  NO_AUTOMATED_CHANNEL,
  AI_OUTBOUND_FAILED,
] as const;

const UNREGISTERED =
  /not registered|no whatsapp|does not (?:have|exist).*whatsapp|whatsapp number not exists|number is not in whatsapp|не зарегистрир|нет WhatsApp|existsWhatsapp"?\s*[:=]\s*false|checkWhatsapp"?\s*[:=]\s*false|\b466\b/i;

export function classifyWhatsAppDeliveryError(raw: unknown): {
  code: typeof WHATSAPP_NOT_REGISTERED | typeof NO_AUTOMATED_CHANNEL | typeof AI_OUTBOUND_FAILED;
  message: string;
} {
  const text = raw instanceof Error ? raw.message : String(raw || "").trim();
  if (!text || /not_configured|не подключ|NO_AUTOMATED_CHANNEL/i.test(text)) {
    return {
      code: NO_AUTOMATED_CHANNEL,
      message:
        !text || /not_configured|NO_AUTOMATED_CHANNEL/i.test(text)
          ? "WhatsApp не подключён. Приветствие не отправлено."
          : text,
    };
  }
  if (/no_phone|нет телефона/i.test(text)) {
    return {
      code: NO_AUTOMATED_CHANNEL,
      message: "У заявки нет телефона для WhatsApp. Приветствие не отправлено.",
    };
  }
  if (UNREGISTERED.test(text)) {
    return {
      code: WHATSAPP_NOT_REGISTERED,
      message: "Контакт не зарегистрирован в WhatsApp. Приветственное сообщение не отправлено.",
    };
  }
  return {
    code: AI_OUTBOUND_FAILED,
    message: text || "Не удалось отправить сообщение в WhatsApp.",
  };
}
