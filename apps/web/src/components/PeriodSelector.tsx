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
  const customHint =
    period === "custom" && dateFrom && dateTo
      ? activeLabel || formatCustomPeriodLabel(dateFrom, dateTo)
      : null;

  return (
    <div className="period-selector">
      <div className="sit-periods" role="tablist" aria-label="Период">
        {PERIOD_OPTIONS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={period === p.id ? "btn sit-chip" : "btn secondary sit-chip"}
            {...tip(p.id === "custom" ? "Выбрать начальную и конечную даты периода" : `Показать данные за период «${p.label}»`)}
            onClick={() => onPeriodChange(p.id)}
          >
            {p.id === "custom" && customHint ? customHint : p.label}
          </button>
        ))}
      </div>
      {period === "custom" ? (
        <div className="sit-custom-range">
          <label>
            С
            <input type="date" value={dateFrom} onChange={(e) => onDateFromChange(e.target.value)} />
          </label>
          <label>
            По
            <input type="date" value={dateTo} onChange={(e) => onDateToChange(e.target.value)} />
          </label>
          {customHint ? <span className="muted period-active-label">{customHint}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

export type { PeriodPreset };
