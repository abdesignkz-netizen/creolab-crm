import { getPublicLocale } from "../i18n";
export function formatDateTime(
  value: string | Date | null | undefined,
  opts: { timeZone?: string | null; timeFormat?: string | null; locale?: string | null } = {},
) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const selectedLocale = opts.locale || getPublicLocale();
  const locale = selectedLocale === "kk" ? "kk-KZ" : selectedLocale === "en" ? "en-GB" : "ru-RU";
  return new Intl.DateTimeFormat(locale, {
    timeZone: opts.timeZone || undefined,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: opts.timeFormat === "12",
  }).format(date);
}
