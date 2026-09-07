function plural(n: number, one: string, few: string, many: string) {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}

function part(n: number, one: string, few: string, many: string) {
  return `${n} ${plural(n, one, few, many)}`;
}

/** Human-readable wait/age from whole minutes: "5 часов 45 мин", "2 дня 3 часа", "1 месяц 12 дней". */
export function formatDurationMinutes(minutes: number | null | undefined) {
  if (minutes == null || !Number.isFinite(minutes)) return null;
  const mins = Math.max(0, Math.floor(minutes));
  if (mins < 1) return "меньше минуты";
  if (mins < 60) return `${mins} мин`;

  const hours = Math.floor(mins / 60);
  const remMin = mins % 60;
  if (hours < 24) {
    const hourPart = part(hours, "час", "часа", "часов");
    return remMin ? `${hourPart} ${remMin} мин` : hourPart;
  }

  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  if (days < 30) {
    const dayPart = part(days, "день", "дня", "дней");
    return remHours ? `${dayPart} ${part(remHours, "час", "часа", "часов")}` : dayPart;
  }

  const months = Math.floor(days / 30);
  const remDays = days % 30;
  if (months < 12) {
    const monthPart = part(months, "месяц", "месяца", "месяцев");
    return remDays ? `${monthPart} ${part(remDays, "день", "дня", "дней")}` : monthPart;
  }

  const years = Math.floor(months / 12);
  const remMonths = months % 12;
  const yearPart = part(years, "год", "года", "лет");
  return remMonths ? `${yearPart} ${part(remMonths, "месяц", "месяца", "месяцев")}` : yearPart;
}

export function formatWaitSince(minutes: number | null | undefined) {
  const duration = formatDurationMinutes(minutes);
  return duration ? `Ждёт ${duration}` : null;
}

export function formatWaitReply(minutes: number | null | undefined) {
  const duration = formatDurationMinutes(minutes);
  return duration ? `Ждёт ответа: ${duration}` : null;
}
