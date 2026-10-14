import { systemText } from "@creolab/contracts";
import { getPublicLocale } from "../i18n";
export function phoneText(phone?: string | null, locale: string = getPublicLocale()) {
  const value = phone == null ? "" : String(phone).trim();
  return value || systemText(locale, "Нет телефона");
}

export function nameWithPhone(name?: string | null, phone?: string | null, locale: string = getPublicLocale()) {
  const n = name == null ? "" : String(name).trim();
  return `${n || systemText(locale, "Без имени")} · ${phoneText(phone, locale)}`;
}

export function channelPhoneText(phone?: string | null, channel?: string | null, locale: string = getPublicLocale()) {
  return phone?.trim() || systemText(locale, channel === "whatsapp" ? "Номер ещё не получен из WhatsApp" : "Нет телефона");
}
