import { ApiError } from "../errors.ts";
import { addDaysYmd, pad, resolvePeriodRange, zonedYmd, type PeriodPreset } from "./periodRange.ts";

export const CONTROL_PERIODS = ["today", "yesterday", "this_week", "last_week", "last_7", "last_30", "this_month", "last_month", "this_year", "all", "custom"] as const;
export type ControlPeriodName = typeof CONTROL_PERIODS[number];
const ymd = (d: { year: number; month: number; day: number }) => `${d.year}-${pad(d.month)}-${pad(d.day)}`;

/** A named calendar week is Monday–Sunday in the company timezone, not a rolling seven days. */
export function mapControlPeriod(params: Record<string, unknown>, timeZone: string, now = new Date(), fallback: ControlPeriodName = "today") {
  const value = params.period ?? params.periodPreset;
  const object = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  let dateFrom = String(object?.from || object?.dateFrom || params.dateFrom || params.from || "").trim() || undefined;
  let dateTo = String(object?.to || object?.dateTo || params.dateTo || params.to || "").trim() || undefined;
  const input = String(object ? "custom" : value || (dateFrom || dateTo ? "custom" : fallback)).toLowerCase();
  const raw = ({ last_7_days: "last_7", last_30_days: "last_30" } as Record<string, string>)[input] || input;
  if (!(CONTROL_PERIODS as readonly string[]).includes(raw)) throw new ApiError(422, "invalid_period", "Уточните период: сегодня, эта неделя, этот месяц или даты С и По.");
  if (raw !== "custom" && (dateFrom || dateTo)) throw new ApiError(422, "invalid_period", "Укажите один период: название или даты С и По.");
  let period = raw as PeriodPreset;
  if (raw === "this_week" || raw === "last_week") {
    const today = zonedYmd(now, timeZone);
    const dow = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay() || 7;
    const monday = addDaysYmd(today, 1 - dow - (raw === "last_week" ? 7 : 0));
    dateFrom = ymd(monday); dateTo = ymd(addDaysYmd(monday, 6)); period = "custom";
  }
  const range = resolvePeriodRange(timeZone, period, dateFrom, dateTo, now);
  // Freeze boundaries for all queries in this command, even across local midnight.
  if (range.from && range.to) {
    dateFrom = ymd(zonedYmd(range.from, timeZone));
    dateTo = ymd(zonedYmd(new Date(range.to.getTime() - 1), timeZone));
  }
  return { period: range.from ? "custom" as PeriodPreset : "all" as PeriodPreset, dateFrom, dateTo,
    label: raw as ControlPeriodName, from: range.from, to: range.to, now, timeZone };
}

export type ControlPeriod = ReturnType<typeof mapControlPeriod>;
