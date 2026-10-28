import { useUiText } from "../lib/uiText";
import "./FinancialBreakdown.css";

type CurrencyTotal = { currency: string; label: string | null; missing?: number };
type Props = { currency: string; sales?: CurrencyTotal[]; receipts?: CurrencyTotal[]; pipeline?: CurrencyTotal[]; outstanding?: CurrencyTotal[] };

/** Show the detail when the headline alone cannot describe the money: other
 * currencies or deals whose amount has not yet been entered. */
export function FinancialBreakdown({ currency, sales, receipts, pipeline, outstanding }: Props) {
  const text = useUiText();
  const groups = [
    { label: text("Сумма продаж"), rows: sales },
    { label: text("Подтверждённые оплаты"), rows: receipts },
    { label: text("Сумма открытых сделок"), rows: pipeline },
    { label: text("Ожидаемая оплата"), rows: outstanding },
  ].filter(group => group.rows?.length);
  if (!groups.some(group => group.rows!.some(row => row.currency !== currency || row.missing))) return null;
  return <details className="financial-breakdown">
    <summary>{text("Суммы по валютам и полнота данных")}</summary>
    <div className="financial-breakdown-grid">
      {groups.map(group => <div key={group.label}>
        <strong>{group.label}</strong>
        {group.rows!.map(row => <p key={row.currency}>
          <span>{row.currency}</span> <b>{row.label ?? "—"}</b>
          {!!row.missing && <small>{text("Сделок без суммы: {count}", { count: row.missing })}</small>}
        </p>)}
      </div>)}
    </div>
  </details>;
}
