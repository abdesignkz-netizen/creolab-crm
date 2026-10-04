import { systemText, systemMessage } from "@creolab/contracts";
import { getPublicLocale } from "../i18n";
import { useLocale } from "./session";

type Params = Record<string, string | number | null | undefined>;
/** Product-owned copy only. Keep record names, messages and document content verbatim. */
export function uiText(source: string, params: Params = {}, locale: string = getPublicLocale()): string {
  return systemText(locale, source, Object.fromEntries(Object.entries(params).map(([key, value]) => [key, value ?? ""])));
}

export function useUiText() {
  const locale = useLocale();
  return (source: string, params: Params = {}) => uiText(source, params, locale);
}

/** Translate developer-owned option/label tables at render time. Never pass API records here.
 * Identifiers and submitted values stay unchanged, including Russian measurement-unit values.
 */
export function localizeUiOptions<T>(copy: T, translate: (source: string) => string = uiText): T {
  if (typeof copy === "string") return translate(copy) as T;
  if (Array.isArray(copy)) return copy.map(item => localizeUiOptions(item, translate)) as T;
  if (copy && typeof copy === "object") {
    return Object.fromEntries(Object.entries(copy).map(([key, value]) => [key,
      ["value", "id", "key", "body", "href", "to", "code"].includes(key) ? value : localizeUiOptions(value, translate),
    ])) as T;
  }
  return copy;
}

/** Explicit server-owned labels and errors only; customer text must bypass this function. */
export function uiMessage(source: string | null | undefined, locale = getPublicLocale()): string {
  return systemMessage(locale, source || "");
}

export function uiFormatLocale() { return getPublicLocale() === "kk" ? "kk-KZ" : "ru-RU"; }

/** Legacy API duration labels only; the anchored grammar never processes customer prose. */
export function uiDurationLabel(source: string | null | undefined, locale = getPublicLocale()): string {
  if (!source || locale !== "kk") return source || "";
  const match = source.match(/^(Ждёт ответа: |Ждёт )?((?:\d+ (?:мин|ч|дн\.|час|часа|часов|день|дня|дней|месяц|месяца|месяцев|год|года|лет)(?: |$))+|меньше минуты)$/);
  if (!match) return uiText(source, {}, locale);
  const units: Record<string, string> = { ч: "сағ", "дн.": "күн", мин: "мин", час: "сағ", часа: "сағ", часов: "сағ", день: "күн", дня: "күн", дней: "күн", месяц: "ай", месяца: "ай", месяцев: "ай", год: "жыл", года: "жыл", лет: "жыл" };
  const duration = match[2] === "меньше минуты" ? "бір минуттан аз" : match[2].replace(/[а-я]+\.?/g, unit => units[unit] || unit);
  return match[1] === "Ждёт ответа: " ? `Жауап күткен уақыт: ${duration}` : match[1] ? `${duration} күтуде` : duration;
}

/** These notification bodies contain product copy. Other bodies can be customer/support messages. */
export function uiNotificationBody(type: string, body: string, locale = getPublicLocale()): string {
  return ["billing.subscription", "contract.signed", "conversation.needs_human", "agreement.needs_confirmation"].includes(type)
    ? uiMessage(body, locale) : body;
}
