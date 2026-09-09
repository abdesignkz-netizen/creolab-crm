export type PeriodPreset =
  | "today"
  | "yesterday"
  | "last_7"
  | "last_30"
  | "this_month"
  | "last_month"
  | "this_year"
  | "all"
  | "custom";

export const PERIOD_OPTIONS: { id: PeriodPreset; label: string }[] = [
  { id: "today", label: "Сегодня" },
  { id: "yesterday", label: "Вчера" },
  { id: "last_7", label: "7 дней" },
  { id: "last_30", label: "30 дней" },
  { id: "this_month", label: "Этот месяц" },
  { id: "last_month", label: "Прошлый месяц" },
  { id: "this_year", label: "Этот год" },
  { id: "all", label: "Всё время" },
  { id: "custom", label: "Период" },
];

/** Short display for custom ranges, e.g. "1 авг. — 31 авг." */
/** Show an instant in the company timezone. ISO from API must not use the server clock locale. */
export function formatDateTimeRu(value: string | Date | null | undefined, timeZone = "Asia/Almaty") {
  if (!value) return "";
  const raw = typeof value === "string" ? value.trim() : "";
  const date =
    raw && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)
      ? parseDateTimeLocalInput(raw, timeZone)
      : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** Naive `YYYY-MM-DDTHH:mm` as the company clock. ISO with Z/offset stays absolute. */
export function parseDateTimeLocalInput(value: string | Date | null | undefined, timeZone = "Asia/Almaty") {
  if (value instanceof Date) return value;
  const raw = String(value || "").trim();
  if (!raw) return new Date(NaN);
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) return new Date(raw);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return new Date(raw);
  if (timeZone === "Asia/Almaty") {
    return new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] || "00"}+05:00`);
  }
  return new Date(yearMonthDayLocalFallback(match));
}

function yearMonthDayLocalFallback(match: RegExpMatchArray) {
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] || 0),
  );
}

/** Format an instant for `<input type="datetime-local">` in the company timezone. */
export function toDateTimeLocalValue(value: Date, timeZone = "Asia/Almaty") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** Format a datetime-local value exactly as the user typed it, without UTC shift. */
export function formatDateTimeLocalInput(value: string) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return formatDateTimeRu(value);
  return `${match[3]}.${match[2]}.${match[1]}, ${match[4]}:${match[5]}`;
}

export function formatCustomPeriodLabel(dateFrom: string, dateTo: string) {
  if (!dateFrom || !dateTo) return "Период";
  const a = new Date(`${dateFrom}T12:00:00`);
  const b = new Date(`${dateTo}T12:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return "Период";
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  const sameYear = a.getFullYear() === b.getFullYear();
  const left = a.toLocaleDateString("ru-RU", sameYear ? opts : { ...opts, year: "numeric" });
  const right = b.toLocaleDateString("ru-RU", sameYear ? opts : { ...opts, year: "numeric" });
  return `${left} — ${right}`;
}
