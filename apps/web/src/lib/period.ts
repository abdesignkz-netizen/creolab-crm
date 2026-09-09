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
      ? parseDateTimeLocal(raw)
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

function parseDateTimeLocal(value: string) {
  const [datePart, timePart = "00:00"] = value.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);
  return new Date(year, (month || 1) - 1, day || 1, hour || 0, minute || 0);
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
