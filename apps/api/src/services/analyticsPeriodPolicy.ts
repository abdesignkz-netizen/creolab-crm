import { MoneyDecimal, moneyValue } from "./financialMetrics.ts";
import { addDaysYmd, zonedLocalToUtc, zonedYmd } from "./periodRange.ts";

export type MonthlySalesPlan = { month: string; amount: number; currency: string };

export function closedDealConversion(won: number, lost: number) {
  return won + lost ? Math.round(won / (won + lost) * 1000) / 10 : null;
}

/** Compare local calendar days, not milliseconds across a DST transition. */
export function analyticsComparison(timeZone: string, mode: string, from: Date | null, to: Date | null) {
  if (mode === "none" || !from || !to) return { from: null, to: null };
  const start = zonedYmd(from, timeZone), end = zonedYmd(new Date(to.getTime() - 1), timeZone);
  const utc = (d: typeof start) => Date.UTC(d.year, d.month - 1, d.day);
  const local = (d: typeof start) => zonedLocalToUtc(timeZone, d.year, d.month, d.day);
  if (mode === "previous") return { from: local(addDaysYmd(start, -Math.round((utc(end) - utc(start)) / 86400000) - 1)), to: from };
  if (mode === "last_month") {
    const prev = start.month === 1 ? { year: start.year - 1, month: 12, day: 1 } : { year: start.year, month: start.month - 1, day: 1 };
    return { from: local(prev), to: local({ ...start, day: 1 }) };
  }
  // Clamp February 29 to February 28 rather than moving the start to March.
  const lastYear = (d: typeof start) => ({ year: d.year - 1, month: d.month,
    day: Math.min(d.day, new Date(Date.UTC(d.year - 1, d.month, 0)).getUTCDate()) });
  return { from: local(lastYear(start)), to: local(addDaysYmd(lastYear(end), 1)) };
}

/** A company's monthly plan applies only to the company report, in its currency.
 * Partial months use their share of calendar days; missing months stay unknown. */
export function periodSalesPlan(input: {
  plans: MonthlySalesPlan[]; legacyAmount: number | null; currency: string; timeZone: string;
  from: Date | null; to: Date | null; filtered: boolean; actual: string | null; missingAmounts: number;
}) {
  const { currency, from, to } = input;
  const base = { currency, amount: null as number | null, exact: null as string | null, label: null as string | null,
    percent: null as number | null, actual: moneyValue(input.actual ?? (input.missingAmounts ? null : 0), currency), missingAmounts: input.missingAmounts,
    missingMonths: [] as string[], months: [] as Array<{ month: string; coveredDays: number; days: number; plan: number }>, prorated: false };
  if (input.filtered) return { ...base, status: "filtered" as const };
  if (!from || !to) return { ...base, status: "unbounded" as const };
  const start = zonedYmd(from, input.timeZone), end = zonedYmd(new Date(to.getTime() - 1), input.timeZone);
  const months = base.months, missingMonths = base.missingMonths;
  let year = start.year, month = start.month, sum = new MoneyDecimal(0);
  for (; year < end.year || year === end.year && month <= end.month; month === 12 ? (year++, month = 1) : month++) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const first = year === start.year && month === start.month ? start.day : 1;
    const last = year === end.year && month === end.month ? end.day : days;
    const coveredDays = last - first + 1;
    const plan = input.plans.find(row => row.month === key && row.currency === currency);
    if (!plan) missingMonths.push(key);
    else { months.push({ month: key, coveredDays, days, plan: plan.amount }); sum = sum.plus(new MoneyDecimal(plan.amount).mul(coveredDays).div(days)); }
  }
  if (missingMonths.length) return { ...base, status: !input.plans.length && input.legacyAmount != null ? "legacy" as const : "missing" as const };
  const target = moneyValue(sum, currency);
  const actual = new MoneyDecimal(input.actual ?? 0);
  return { ...base, ...target, status: "ready" as const, prorated: months.some(row => row.coveredDays !== row.days),
    percent: target.exact && new MoneyDecimal(target.exact).gt(0) && input.missingAmounts === 0
      ? moneyValue(actual.div(target.exact).mul(100), "").amount : null };
}
