import { Link } from "react-router-dom";
import { INSIGHT_RULE_LABELS, type BusinessInsightView } from "@creolab/contracts";

export const INSIGHT_STATE_LABELS = { open: "Требует внимания", acknowledged: "Принято к сведению", dismissed: "Скрыто до изменения данных", resolved: "Условие больше не выполняется", unavailable: "Нет актуальных данных" };
export function insightDate(value: string | null, timezone?: string) {
  if (!value) return "Ещё не проверено";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: timezone || "Asia/Almaty" }).format(date);
}
export function BusinessInsightCard({ item, busy = false, onDecision, onRefresh, onHistory, onAction }: {
  item: BusinessInsightView; busy?: boolean;
  onDecision: (decision: "acknowledge" | "dismiss") => void; onRefresh: () => void; onHistory: () => void;
  onAction?: () => void;
}) {
  const content = item.content, canDecide = !item.stale && content && ["open", "acknowledged", "dismissed"].includes(item.state);
  return <article className={`insight-card ${!item.stale && item.state !== "resolved" && content?.severity === "urgent" ? "insight-urgent" : ""}`} aria-label={INSIGHT_RULE_LABELS[item.rule]}>
    <div className="insight-top"><span className="insight-kind">{INSIGHT_RULE_LABELS[item.rule]}</span><span className="status-badge">{item.stale ? "Нужна повторная проверка" : INSIGHT_STATE_LABELS[item.state]}</span></div>
    {item.stale || !content ? <><h3>Основание вывода изменилось или устарело</h3><p>Обновите проверку, чтобы увидеть актуальные данные и доступные действия.</p></> : <>
      <h3>{item.state === "resolved" ? `Ранее: ${content.title}` : content.title}</h3><p className="insight-subject">{content.subject}</p><p>{content.explanation}</p>
      <dl className="insight-facts">{content.facts.map((fact, index) => <div key={index}><dt>{fact.label}</dt><dd>{/^\d{4}-\d\d-\d\dT/.test(fact.value) ? insightDate(fact.value, content.period.timezone) : fact.value}</dd></div>)}</dl>
      <details><summary>Почему появился этот вывод</summary><p>{content.formula}</p><p className="muted">{content.limitation}</p>
        <p className="muted">Период: {content.period.from ? `${insightDate(content.period.from, content.period.timezone)} — ` : "на "}{insightDate(content.period.to, content.period.timezone)} · {content.period.timezone}{content.period.currency ? ` · ${content.period.currency}` : ""}</p>
        <div className="actions">{content.sources.map((source, index) => <Link key={index} to={source.href}>{source.label}</Link>)}</div>
      </details>
    </>}
    {!item.stale && content?.opportunity && <div className="opportunity-outcome">
      {item.action ? <><b>Задача создана {insightDate(item.action.at, content.period.timezone)}</b><p>Результат зарегистрирован в истории клиента. Это не подтверждение продажи или оплаты.</p>
        {item.action.taskId ? <Link to={`/tasks?open=${encodeURIComponent(item.action.taskId)}`}>Проверить задачу · {({ open: "К выполнению", in_progress: "В работе", waiting: "Ожидание", done: "Завершена", canceled: "Отменена" } as Record<string, string>)[item.action.taskStatus || ""] || "Открыть"}</Link> : <p>Задача больше недоступна.</p>}
        {item.action.runId && <p><Link to={`/control?view=plans&run=${encodeURIComponent(item.action.runId)}`}>История выполнения</Link></p>}</>
        : content.opportunity.existingTask ? <><b>По этой заявке или сделке уже есть задача</b><p>{content.opportunity.existingTask.title}</p><Link to={`/tasks?open=${encodeURIComponent(content.opportunity.existingTask.id)}`}>Проверить задачу и срок</Link></> : null}
    </div>}
    <div className="actions insight-actions">
      {canDecide && item.state !== "dismissed" && content?.opportunity && !content.opportunity.existingTask && !item.action && onAction && <button className="btn" type="button" disabled={busy} onClick={onAction}>Поставить задачу сотруднику</button>}
      {!item.stale && content && item.state !== "resolved" && <Link className={`btn${content.opportunity ? " secondary" : ""}`} to={content.next.href}>{content.next.label}</Link>}
      {item.stale && <button className="btn" type="button" disabled={busy} onClick={onRefresh}>Проверить заново</button>}
      {canDecide && item.state !== "acknowledged" && <button className="btn secondary" type="button" disabled={busy} onClick={() => onDecision("acknowledge")}>Принять к сведению</button>}
      {canDecide && item.state !== "dismissed" && <button className="btn secondary" type="button" disabled={busy} onClick={() => onDecision("dismiss")}>Скрыть до изменения данных</button>}
      <button className="btn secondary" type="button" disabled={busy} onClick={onHistory}>История</button>
    </div>
    <small className="muted">Проверено: {insightDate(item.checkedAt, content?.period.timezone)}. Отметки здесь не закрывают задачи и сделки.</small>
  </article>;
}
