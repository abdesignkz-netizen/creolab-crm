import { Link } from "react-router-dom";
import { DECISION_LABELS, type BusinessDecisionView } from "@creolab/contracts";
import { goalDate } from "./BusinessGoalCard";

export const decisionStateLabels: Record<BusinessDecisionView["effective"], string> = { draft: "Черновик — ещё не применяется", hypothesis: "Гипотеза — требует проверки", active: "Утверждено и действует", scheduled: "Начнёт действовать позже", expired: "Срок действия истёк", source_changed: "Основание изменилось — нужна проверка", source_unavailable: "Источник недоступен", superseded: "Заменено новым решением", revoked: "Отозвано", deleted: "Содержимое удалено" };
export function BusinessDecisionCard({ item, timezone, onOpen, busy = false }: { item: BusinessDecisionView; timezone: string; onOpen?: () => void; busy?: boolean }) {
  const c = item.content;
  return <article className="decision-card"><div className="decision-top"><span>{DECISION_LABELS[item.kind]}</span><span className="status-badge">{decisionStateLabels[item.effective]}</span></div>
    <h3>{c?.title || (item.effective === "deleted" ? "Удалённая запись" : "Содержимое недоступно")}</h3>
    {c && <><p className="muted">Тема: {c.topic}</p><p className="decision-body">{c.body}</p><details><summary>Почему принято</summary><p className="decision-body">{c.rationale}</p></details>
      <p>Действует: {goalDate(c.validFrom, timezone, true)} — {goalDate(c.validUntil, timezone, true)}.</p><small className="muted">Хранить содержимое до {goalDate(c.retentionUntil, timezone, true)}.</small></>}
    <p>Автор: {item.author}. {item.approver && <>Утвердил: {item.approver} · {item.approvedAt && goalDate(item.approvedAt, timezone, true)}.</>}</p>
    {item.source.href && item.source.available ? <Link to={item.source.href}>Открыть основание: {item.source.label}</Link> : <span className="muted">{item.source.label}</span>}
    {item.supersededById && <p><Link to={`/control?view=memory&decision=${encodeURIComponent(item.supersededById)}`}>Открыть заменяющее решение</Link></p>}
    {onOpen && <p><button type="button" className="btn secondary" disabled={busy} onClick={onOpen}>Открыть решение и историю</button></p>}
  </article>;
}
