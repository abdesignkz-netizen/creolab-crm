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
