/** Read-only estimates from recorded sales. These are not payment promises. */
export type ForecastMoney = { amount: number | null; exact: string | null; label: string | null };

export type SalesForecastMonth = {
  month: string;
  days: number;
  sales: number;
  missingAmounts: number;
  total: ForecastMoney;
};

export type SalesForecast = {
  status: "ready" | "insufficient_history" | "incomplete_data" | "unsupported_period" | "unavailable";
  method: "median_daily_sales_v1";
  source: "recorded_won_deals";
  asOf: string;
  timeZone: string;
  currency: string;
  month: string;
  from: string;
  to: string;
  elapsedDays: number;
  remainingDays: number;
  filtered: boolean;
  actual: ForecastMoney;
  estimate: ForecastMoney;
  range: { low: ForecastMoney; high: ForecastMoney };
  history: SalesForecastMonth[];
  evidence: {
    firstRecordAt: string | null;
    months: number;
    sales: number;
    requiredMonths: number;
    requiredSales: number;
    maxMonths: number;
    missingAmounts: number;
    missingClosedDates: number;
    negativeAmounts: number;
    futureClosedDates: number;
    otherCurrencySales: number;
  };
  deviation: {
    status: "unavailable" | "too_early" | "no_baseline" | "below" | "above" | "typical";
    expected: ForecastMoney;
    percent: number | null;
    minimumDays: number;
    thresholdPercent: number;
  };
  target: {
    status: "unavailable" | "filtered" | "not_set" | "zero_target" | "achieved" | "below_range" | "at_risk" | "within_range" | "range_above_plan";
    amount: ForecastMoney;
    estimatedGap: ForecastMoney;
    estimatedPercent: number | null;
  };
  validation: {
    method: "rolling_month_start";
    periods: Array<{ month: string; estimate: ForecastMoney; actual: ForecastMoney; absoluteError: ForecastMoney }>;
    meanAbsoluteError: ForecastMoney;
    weightedAbsoluteErrorPercent: number | null;
  };
};
