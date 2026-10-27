import type { ProcessCalendar } from "@creolab/contracts";

const DAY = 86_400_000;
const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
const weekday = (day: number) => ((day + 4) % 7 + 7) % 7;

/** One business day is one full shift. Exact user deadlines stay absolute. */
export function createProcessClock(calendar: ProcessCalendar, timeZone: string, now = new Date()) {
  let zone = timeZone || "Asia/Almaty";
  try { new Intl.DateTimeFormat("en", { timeZone: zone }).format(now); }
  catch { zone = "Asia/Almaty"; }
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const localEpoch = (value: Date) => {
    const parts = Object.fromEntries(fmt.formatToParts(value).map(p => [p.type, p.value]));
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  };
  const dayOf = (value: Date) => Math.floor(localEpoch(value) / DAY);
  const startMinute = minutes(calendar.start), endMinute = minutes(calendar.end);
  const workdays = new Set(calendar.days);
  const excluded = new Set(calendar.excludedDates.map(value => Date.parse(`${value}T00:00:00Z`) / DAY));
  const eligible = (day: number) => workdays.has(weekday(day)) && !excluded.has(day);
  const shifts = new Map<number, { start: number; end: number }>();

  const atLocalTime = (day: number, minute: number) => {
    const target = day * DAY + minute * 60_000;
    let guess = target, previous = Number.NaN;
    for (let i = 0; i < 6; i++) {
      const next = guess + target - localEpoch(new Date(guess));
      if (next === guess) return guess;
      // A missing local clock time at a DST jump resolves to the later instant.
      if (next === previous) return Math.max(next, guess);
      previous = guess; guess = next;
    }
    return guess;
  };
  const shift = (day: number) => {
    if (!shifts.has(day)) shifts.set(day, { start: atLocalTime(day, startMinute),
      end: atLocalTime(day + (endMinute <= startMinute ? 1 : 0), endMinute) });
    return shifts.get(day)!;
  };
  const fullDays = (first: number, last: number) => {
    if (last < first) return 0;
    const count = last - first + 1, weeks = Math.floor(count / 7);
    let total = weeks * workdays.size;
    for (let offset = weeks * 7; offset < count; offset++) if (workdays.has(weekday(first + offset))) total++;
    for (const day of excluded) if (day >= first && day <= last && workdays.has(weekday(day))) total--;
    return total;
  };
  const elapsedCache = new Map<number, number>();

  function elapsedDays(since: Date) {
    const from = since.getTime(), to = now.getTime();
    if (!Number.isFinite(from) || from >= to) return 0;
    if (calendar.mode === "calendar") return (to - from) / DAY;
    if (elapsedCache.has(from)) return elapsedCache.get(from)!;
    const first = dayOf(since), last = dayOf(now);
    let total = fullDays(first + 1, last - 2);
    // Include the preceding date for overnight shifts. Interior full shifts are
    // counted in constant time so old deals do not cause a daily scan per row.
    for (const day of new Set([first - 1, first, last - 1, last])) {
      if (!eligible(day)) continue;
      const { start, end } = shift(day);
      if (end > start) total += Math.max(0, Math.min(to, end) - Math.max(from, start)) / (end - start);
    }
    elapsedCache.set(from, total);
    return total;
  }

  function afterDays(from: Date, count: number) {
    if (!Number.isFinite(count) || count < 0 || count > 365) throw new RangeError("Invalid process duration");
    if (calendar.mode === "calendar" || count === 0) return new Date(from.getTime() + count * DAY);
    let remaining = count;
    const first = dayOf(from);
    for (let day = first - 1; day < first + 366 * 8; day++) {
      if (!eligible(day)) continue;
      const { start, end } = shift(day), availableFrom = Math.max(start, from.getTime());
      if (end <= availableFrom) continue;
      const available = (end - availableFrom) / (end - start);
      if (remaining <= available + 1e-10) return new Date(Math.min(end, availableFrom + remaining * (end - start)));
      remaining -= available;
    }
    throw new RangeError("No available workday");
  }

  return { mode: calendar.mode, timeZone: zone, elapsedDays, afterDays };
}

export type ProcessClock = ReturnType<typeof createProcessClock>;
