import { ApiError } from "../errors.ts";

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

export function pad(n: number) {
  return String(n).padStart(2, "0");
}

export function zonedYmd(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  return {
    year: Number(parts.find((p) => p.type === "year")?.value),
    month: Number(parts.find((p) => p.type === "month")?.value),
    day: Number(parts.find((p) => p.type === "day")?.value),
  };
}

export function zonedLocalToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
) {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(utcGuess);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return new Date(utcGuess.getTime() - (asUtc - utcGuess.getTime()));
}

export function addDaysYmd(ymd: { year: number; month: number; day: number }, days: number) {
  const utc = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day + days));
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

export type TrendGranularity = "hour" | "day" | "week" | "month";

export function compareYmd(
  a: { year: number; month: number; day: number },
  b: { year: number; month: number; day: number },
) {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

export function isoWeekKeyFromYmd(ymd: { year: number; month: number; day: number }) {
  const utc = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function formatBucketLabel(key: string, granularity: TrendGranularity) {
  if (granularity === "hour") {
    const match = key.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/);
    if (!match) return key;
    return `${Number(match[3])}.${match[2]} ${match[4]}:00`;
  }
  if (granularity === "day") {
    const [year, month, day] = key.split("-").map(Number);
    if (!year || !month || !day) return key;
    return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  }
  if (granularity === "week") {
    return key.replace("-W", " · нед. ");
  }
  if (granularity === "month") {
    const [year, month] = key.split("-").map(Number);
    if (!year || !month) return key;
    return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("ru-RU", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  }
  return key;
}

export function enumerateBucketKeys(
  from: Date | null,
  to: Date | null,
  granularity: TrendGranularity,
  timeZone: string,
  existingKeys: string[] = [],
) {
  if (!from || !to) {
    return fillKeysBetween(existingKeys, granularity);
  }
  const last = zonedYmd(new Date(to.getTime() - 1), timeZone);
  if (granularity === "hour") {
    const keys: string[] = [];
    let cursor = from.getTime();
    const end = to.getTime();
    while (cursor < end) {
      const mid = new Date(cursor + 30 * 60 * 1000);
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        hourCycle: "h23",
      }).formatToParts(mid);
      const get = (type: string) => parts.find((part) => part.type === type)?.value || "00";
      keys.push(`${get("year")}-${get("month")}-${get("day")}T${get("hour")}`);
      cursor += 3600_000;
      if (keys.length > 72) break;
    }
    return keys;
  }
  if (granularity === "month") {
    const keys: string[] = [];
    let ymd = zonedYmd(from, timeZone);
    while (ymd.year < last.year || (ymd.year === last.year && ymd.month <= last.month)) {
      keys.push(`${ymd.year}-${pad(ymd.month)}`);
      ymd = ymd.month === 12 ? { year: ymd.year + 1, month: 1, day: 1 } : { year: ymd.year, month: ymd.month + 1, day: 1 };
      if (keys.length > 120) break;
    }
    return keys;
  }
  if (granularity === "week") {
    const keys: string[] = [];
    const seen = new Set<string>();
    let ymd = zonedYmd(from, timeZone);
    while (compareYmd(ymd, last) <= 0) {
      const key = isoWeekKeyFromYmd(ymd);
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
      ymd = addDaysYmd(ymd, 1);
      if (keys.length > 80) break;
    }
    return keys;
  }
  const keys: string[] = [];
  let ymd = zonedYmd(from, timeZone);
  while (compareYmd(ymd, last) <= 0) {
    keys.push(`${ymd.year}-${pad(ymd.month)}-${pad(ymd.day)}`);
    ymd = addDaysYmd(ymd, 1);
    if (keys.length > 400) break;
  }
  return keys;
}

function fillKeysBetween(existingKeys: string[], granularity: TrendGranularity) {
  const sorted = [...new Set(existingKeys)].sort();
  if (sorted.length < 2) return sorted;
  if (granularity === "day" && /^\d{4}-\d{2}-\d{2}$/.test(sorted[0])) {
    const [sy, sm, sd] = sorted[0].split("-").map(Number);
    const [ey, em, ed] = sorted[sorted.length - 1].split("-").map(Number);
    const keys: string[] = [];
    let cur = { year: sy, month: sm, day: sd };
    const last = { year: ey, month: em, day: ed };
    while (compareYmd(cur, last) <= 0) {
      keys.push(`${cur.year}-${pad(cur.month)}-${pad(cur.day)}`);
      cur = addDaysYmd(cur, 1);
      if (keys.length > 400) break;
    }
    return keys;
  }
  if (granularity === "month" && /^\d{4}-\d{2}$/.test(sorted[0])) {
    const [sy, sm] = sorted[0].split("-").map(Number);
    const [ey, em] = sorted[sorted.length - 1].split("-").map(Number);
    const keys: string[] = [];
    let year = sy;
    let month = sm;
    while (year < ey || (year === ey && month <= em)) {
      keys.push(`${year}-${pad(month)}`);
      if (month === 12) {
        year += 1;
        month = 1;
      } else {
        month += 1;
      }
      if (keys.length > 120) break;
    }
    return keys;
  }
  return sorted;
}

export function periodLabel(preset: PeriodPreset, from: Date | null, to: Date | null, timeZone: string) {
  const labels: Record<PeriodPreset, string> = {
    today: "Сегодня",
    yesterday: "Вчера",
    last_7: "7 дней",
    last_30: "30 дней",
    this_month: "Этот месяц",
    last_month: "Прошлый месяц",
    this_year: "Этот год",
    all: "Всё время",
    custom: "Период",
  };
  if (preset === "custom" && from && to) {
    const end = new Date(to.getTime() - 1);
    const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", timeZone };
    return `${from.toLocaleDateString("ru-RU", opts)} — ${end.toLocaleDateString("ru-RU", opts)}`;
  }
  return labels[preset];
}

export function resolvePeriodRange(
  timeZone: string,
  preset: PeriodPreset,
  customFrom?: string,
  customTo?: string,
  now = new Date(),
): { from: Date | null; to: Date | null; previousFrom: Date | null; previousTo: Date | null } {
  const today = zonedYmd(now, timeZone);
  const startToday = zonedLocalToUtc(timeZone, today.year, today.month, today.day);
  const tomorrow = addDaysYmd(today, 1);
  const startTomorrow = zonedLocalToUtc(timeZone, tomorrow.year, tomorrow.month, tomorrow.day);

  if (preset === "all") {
    return { from: null, to: null, previousFrom: null, previousTo: null };
  }

  if (preset === "custom") {
    if (!customFrom || !customTo) {
      throw new ApiError(422, "invalid_period", "Укажите даты С и По");
    }
    const [fy, fm, fd] = customFrom.split("-").map(Number);
    const [ty, tm, td] = customTo.split("-").map(Number);
    if (![fy, fm, fd, ty, tm, td].every((n) => Number.isFinite(n))) {
      throw new ApiError(422, "invalid_period", "Некорректные даты периода");
    }
    const from = zonedLocalToUtc(timeZone, fy, fm, fd);
    const next = addDaysYmd({ year: ty, month: tm, day: td }, 1);
    const to = zonedLocalToUtc(timeZone, next.year, next.month, next.day);
    const ms = to.getTime() - from.getTime();
    return { from, to, previousFrom: new Date(from.getTime() - ms), previousTo: from };
  }

  if (preset === "today") {
    const y = addDaysYmd(today, -1);
    return {
      from: startToday,
      to: startTomorrow,
      previousFrom: zonedLocalToUtc(timeZone, y.year, y.month, y.day),
      previousTo: startToday,
    };
  }
  if (preset === "yesterday") {
    const y = addDaysYmd(today, -1);
    const from = zonedLocalToUtc(timeZone, y.year, y.month, y.day);
    const p = addDaysYmd(today, -2);
    return {
      from,
      to: startToday,
      previousFrom: zonedLocalToUtc(timeZone, p.year, p.month, p.day),
      previousTo: from,
    };
  }
  if (preset === "last_7") {
    const fromYmd = addDaysYmd(today, -6);
    const from = zonedLocalToUtc(timeZone, fromYmd.year, fromYmd.month, fromYmd.day);
    const prevFromYmd = addDaysYmd(today, -13);
    return {
      from,
      to: startTomorrow,
      previousFrom: zonedLocalToUtc(timeZone, prevFromYmd.year, prevFromYmd.month, prevFromYmd.day),
      previousTo: from,
    };
  }
  if (preset === "last_30") {
    const fromYmd = addDaysYmd(today, -29);
    const from = zonedLocalToUtc(timeZone, fromYmd.year, fromYmd.month, fromYmd.day);
    const prevFromYmd = addDaysYmd(today, -59);
    return {
      from,
      to: startTomorrow,
      previousFrom: zonedLocalToUtc(timeZone, prevFromYmd.year, prevFromYmd.month, prevFromYmd.day),
      previousTo: from,
    };
  }
  if (preset === "this_month") {
    const from = zonedLocalToUtc(timeZone, today.year, today.month, 1);
    const prevMonth =
      today.month === 1 ? { year: today.year - 1, month: 12 } : { year: today.year, month: today.month - 1 };
    const previousFrom = zonedLocalToUtc(timeZone, prevMonth.year, prevMonth.month, 1);
    return { from, to: startTomorrow, previousFrom, previousTo: from };
  }
  if (preset === "last_month") {
    const prevMonth =
      today.month === 1 ? { year: today.year - 1, month: 12 } : { year: today.year, month: today.month - 1 };
    const from = zonedLocalToUtc(timeZone, prevMonth.year, prevMonth.month, 1);
    const to = zonedLocalToUtc(timeZone, today.year, today.month, 1);
    const prevPrev =
      prevMonth.month === 1
        ? { year: prevMonth.year - 1, month: 12 }
        : { year: prevMonth.year, month: prevMonth.month - 1 };
    const previousFrom = zonedLocalToUtc(timeZone, prevPrev.year, prevPrev.month, 1);
    return { from, to, previousFrom, previousTo: from };
  }

  const from = zonedLocalToUtc(timeZone, today.year, 1, 1);
  const previousFrom = zonedLocalToUtc(timeZone, today.year - 1, 1, 1);
  return { from, to: startTomorrow, previousFrom, previousTo: from };
}
