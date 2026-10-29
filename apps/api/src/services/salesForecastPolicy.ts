import type { SalesForecast, SalesForecastMonth } from "@creolab/contracts";
import { MoneyDecimal, moneyValue } from "./financialMetrics.ts";
import { addDaysYmd, zonedLocalToUtc, zonedYmd } from "./periodRange.ts";

export const FORECAST_MIN_MONTHS = 3;
export const FORECAST_MIN_SALES = 10;
export const FORECAST_MAX_MONTHS = 6;

export function forecastMonth(timeZone: string, year: number, month: number) {
  const normalized = new Date(Date.UTC(year, month - 1, 1));
  year = normalized.getUTCFullYear(); month = normalized.getUTCMonth() + 1;
  const next = new Date(Date.UTC(year, month, 1));
  return {
    month: `${year}-${String(month).padStart(2, "0")}`,
    days: new Date(Date.UTC(year, month, 0)).getUTCDate(),
    from: zonedLocalToUtc(timeZone, year, month, 1),
    to: zonedLocalToUtc(timeZone, next.getUTCFullYear(), next.getUTCMonth() + 1, 1),
  };
}

export function forecastContext(now: Date, timeZone: string, currency: string, filtered = false): SalesForecast {
  const today = zonedYmd(now, timeZone);
  const month = forecastMonth(timeZone, today.year, today.month);
  const tomorrow = addDaysYmd(today, 1);
  const dayStart = zonedLocalToUtc(timeZone, today.year, today.month, today.day);
  const dayEnd = zonedLocalToUtc(timeZone, tomorrow.year, tomorrow.month, tomorrow.day);
  // Calendar days remain comparable across DST; only today's actual length varies.
  const elapsedDays = today.day - 1 + (now.getTime() - dayStart.getTime()) / (dayEnd.getTime() - dayStart.getTime());
  const empty = () => moneyValue(null, currency);
  return {
    status: "insufficient_history", method: "median_daily_sales_v1", source: "recorded_won_deals",
    asOf: now.toISOString(), timeZone, currency, month: month.month, from: month.from.toISOString(), to: month.to.toISOString(),
    elapsedDays, remainingDays: month.days - elapsedDays, filtered,
    actual: empty(), estimate: empty(), range: { low: empty(), high: empty() }, history: [],
    evidence: { firstRecordAt: null, months: 0, sales: 0, requiredMonths: FORECAST_MIN_MONTHS,
      requiredSales: FORECAST_MIN_SALES, maxMonths: FORECAST_MAX_MONTHS, missingAmounts: 0, missingClosedDates: 0,
      negativeAmounts: 0, futureClosedDates: 0, otherCurrencySales: 0 },
    deviation: { status: "unavailable", expected: empty(), percent: null, minimumDays: 7, thresholdPercent: 20 },
    target: { status: "unavailable", amount: empty(), estimatedGap: empty(), estimatedPercent: null },
    validation: { method: "rolling_month_start", periods: [], meanAbsoluteError: empty(), weightedAbsoluteErrorPercent: null },
  };
}

function medianRate(months: SalesForecastMonth[]) {
  const values = months.map(row => new MoneyDecimal(row.total.exact!).div(row.days)).sort((a, b) => a.comparedTo(b));
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : values[mid - 1].plus(values[mid]).div(2);
}

function percent(value: InstanceType<typeof MoneyDecimal>) {
  const rounded = value.toDecimalPlaces(1).toNumber();
  return Number.isFinite(rounded) && Math.abs(rounded) <= Number.MAX_SAFE_INTEGER ? rounded : null;
}

/** No probabilities or model-generated numbers: every estimate is reproducible.
 * A zero-sales month is data; a missing amount is not a zero. */
export function calculateSalesForecast(base: SalesForecast, input: {
  history: SalesForecastMonth[];
  current: SalesForecastMonth;
  evidence: Partial<SalesForecast["evidence"]>;
  monthlyPlan: number | null;
}): SalesForecast {
  const history = input.history;
  const currency = base.currency;
  const evidence = { ...base.evidence, ...input.evidence, months: history.length,
    sales: history.reduce((sum, row) => sum + row.sales, 0),
    missingAmounts: history.reduce((sum, row) => sum + row.missingAmounts, input.current.missingAmounts) };
  const result: SalesForecast = { ...base, history, evidence, actual: input.current.total,
    target: { ...base.target }, validation: { ...base.validation, periods: [] } };
  if (evidence.missingAmounts || evidence.missingClosedDates || evidence.negativeAmounts || evidence.futureClosedDates) {
    return { ...result, status: "incomplete_data" };
  }
  if (history.length < FORECAST_MIN_MONTHS || evidence.sales < FORECAST_MIN_SALES) return result;

  const actual = new MoneyDecimal(input.current.total.exact!);
  const typical = medianRate(history);
  const rates = history.map(row => new MoneyDecimal(row.total.exact!).div(row.days));
  const projection = (rate: InstanceType<typeof MoneyDecimal>) => actual.plus(rate.mul(base.remainingDays));
  const estimate = projection(typical).toDecimalPlaces(0);
  const low = projection(MoneyDecimal.min(...rates)).toDecimalPlaces(0), high = projection(MoneyDecimal.max(...rates)).toDecimalPlaces(0);
  result.status = "ready";
  result.estimate = moneyValue(estimate, currency);
  result.range = { low: moneyValue(low, currency), high: moneyValue(high, currency) };

  const expected = typical.mul(base.elapsedDays);
  const deviation = expected.gt(0) ? actual.minus(expected).div(expected).mul(100) : null;
  result.deviation = { ...base.deviation, expected: moneyValue(expected, currency), percent: deviation ? percent(deviation) : null,
    status: base.elapsedDays < base.deviation.minimumDays ? "too_early" : !deviation ? "no_baseline"
      : deviation.lte(-base.deviation.thresholdPercent) ? "below" : deviation.gte(base.deviation.thresholdPercent) ? "above" : "typical" };

  if (base.filtered) result.target.status = "filtered";
  else if (input.monthlyPlan == null) result.target.status = "not_set";
  else {
    const plan = new MoneyDecimal(input.monthlyPlan);
    result.target = { amount: moneyValue(plan, currency), estimatedGap: moneyValue(MoneyDecimal.max(0, plan.minus(estimate)), currency),
      estimatedPercent: plan.gt(0) ? percent(estimate.div(plan).mul(100)) : null,
      status: plan.eq(0) ? "zero_target" : actual.gte(plan) ? "achieved" : high.lt(plan) ? "below_range"
        : estimate.lt(plan) ? "at_risk" : low.lt(plan) ? "within_range" : "range_above_plan" };
  }

  // Walk forward: a historical month is predicted only from earlier months.
  // Validation is at month start, a longer horizon than today's remaining days.
  let errorSum = new MoneyDecimal(0), actualSum = new MoneyDecimal(0);
  for (let i = FORECAST_MIN_MONTHS; i < history.length; i++) {
    const training = history.slice(0, i);
    if (training.reduce((sum, row) => sum + row.sales, 0) < FORECAST_MIN_SALES) continue;
    const prediction = medianRate(training).mul(history[i].days);
    const observed = new MoneyDecimal(history[i].total.exact!);
    const error = prediction.minus(observed).abs();
    result.validation.periods.push({ month: history[i].month, estimate: moneyValue(prediction, currency), actual: history[i].total, absoluteError: moneyValue(error, currency) });
    errorSum = errorSum.plus(error); actualSum = actualSum.plus(observed);
  }
  const n = result.validation.periods.length;
  if (n) result.validation = { ...result.validation, meanAbsoluteError: moneyValue(errorSum.div(n), currency),
    weightedAbsoluteErrorPercent: actualSum.gt(0) ? percent(errorSum.div(actualSum).mul(100)) : null };
  return result;
}
