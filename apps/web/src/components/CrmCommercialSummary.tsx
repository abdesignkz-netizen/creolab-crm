import type { CrmCommercialValues, CrmMoney, CrmReviewValue } from "@creolab/contracts";
import { Link } from "react-router-dom";
import { uiFormatLocale, useUiText } from "../lib/uiText";

export function formatCrmMoney(value: CrmMoney, text: (value: string) => string) {
  const n = (v: number) => v.toLocaleString(uiFormatLocale());
  const amount = value.min === value.max ? n(value.min!) : value.min === null ? `${text("до")} ${n(value.max!)}`
    : value.max === null ? `${text("от")} ${n(value.min)}` : `${n(value.min)}–${n(value.max)}`;
  return `${amount} ${value.currency}`;
}
export const isCrmMoney = (value: CrmReviewValue): value is CrmMoney => value !== null && typeof value === "object";

export function CrmCommercialSummary({ values, conversationId }: { values?: CrmCommercialValues | null; conversationId?: string | null }) {
  const uiText = useUiText();
  if (!values || !Object.values(values).some(v => v !== null)) return null;
  const rows = [
    [uiText("Бюджет клиента"), values.customerBudget], [uiText("Предложенная цена"), values.proposedPrice],
    [uiText("Согласованная цена"), values.agreedPrice], [uiText("Последнее возражение"), values.objection],
    [uiText("Последняя причина отказа"), values.refusalReason],
  ] as const;
  return <section className="panel soft crm-commercial" aria-label={uiText("Условия и замечания клиента")}>
    <b>{uiText("Условия и замечания клиента")}</b>
    <dl className="kv">{rows.map(([label, value]) => value === null ? null : <div key={label}><dt>{label}</dt>
      <dd style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{typeof value === "object" ? formatCrmMoney(value, uiText) : value}</dd></div>)}</dl>
    <p className="muted">{uiText("Последние сохранённые сведения. Согласованная цена не подтверждает оплату, а причина отказа не закрывает заявку или сделку.")}</p>
    {conversationId ? <Link to={`/conversations/${encodeURIComponent(conversationId)}`}>{uiText("Проверить источники в диалоге")}</Link> : null}
  </section>;
}
