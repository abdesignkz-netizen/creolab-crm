import { systemText } from "@creolab/contracts";
import { useLocale } from "../lib/session";
import { tip } from "../lib/tip";
import { PERIOD_OPTIONS, type PeriodPreset, formatCustomPeriodLabel } from "../lib/period";

type Props = {
  period: PeriodPreset;
  onPeriodChange: (period: PeriodPreset) => void;
  dateFrom: string;
  dateTo: string;
  onDateFromChange: (value: string) => void;
  onDateToChange: (value: string) => void;
  /** Optional label shown when custom range is set */
  activeLabel?: string | null;
};

export function PeriodSelector({
  period,
  onPeriodChange,
  dateFrom,
  dateTo,
  onDateFromChange,
  onDateToChange,
  activeLabel,
}: Props) {
  const locale = useLocale();
  const customHint =
    period === "custom" && dateFrom && dateTo
      ? (locale !== "kk" && activeLabel ? activeLabel : formatCustomPeriodLabel(dateFrom, dateTo, locale))
      : null;

  return (
    <div className="period-selector">
      <label className="period-mobile-select">{systemText(locale, "Период")}
        <select value={period} onChange={event => onPeriodChange(event.target.value as PeriodPreset)}>
          {PERIOD_OPTIONS.map(option => <option key={option.id} value={option.id}>{systemText(locale, option.label)}</option>)}
        </select>
      </label>
      <div className="sit-periods" role="group" aria-label={systemText(locale, "Период")}>
        {PERIOD_OPTIONS.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={period === p.id}
            className={period === p.id ? "btn sit-chip" : "btn secondary sit-chip"}
            {...tip(p.id === "custom" ? systemText(locale, "Выбрать начальную и конечную даты периода") : systemText(locale, "Показать данные за период «{period}»", { period: systemText(locale, p.label) }))}
            onClick={() => onPeriodChange(p.id)}
          >
            {p.id === "custom" && customHint ? customHint : systemText(locale, p.label)}
          </button>
        ))}
      </div>
      {period === "custom" ? (
        <div className="sit-custom-range">
          <label>
            {systemText(locale, "С")}
            <input type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => onDateFromChange(e.target.value)} />
          </label>
          <label>
            {systemText(locale, "По")}
            <input type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => onDateToChange(e.target.value)} />
          </label>
          {customHint ? <span className="muted period-active-label">{customHint}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

export type { PeriodPreset };
