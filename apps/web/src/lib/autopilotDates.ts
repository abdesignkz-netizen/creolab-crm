export function absenceDate(iso: string, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
/** Last second of the selected local date; browser timezone is irrelevant. */
export function absenceUntil(date: string, timeZone: string) {
  const target = Date.parse(`${date}T23:59:59Z`);
  if (!Number.isFinite(target)) throw new Error("Укажите дату отсутствия.");
  const fmt = new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  let guess = target;
  for (let i = 0; i < 6; i++) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(guess)).map(p => [p.type, p.value]));
    const local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
    const next = guess + target - local;
    if (next === guess) break; guess = next;
  }
  return new Date(guess).toISOString();
}
