import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { GOAL_LABELS, GOAL_METRICS, type GoalMetric, type GoalOptions, type GoalCreate } from "@creolab/contracts";

export function BusinessGoalForm({ options, busy, onSave, onCancel }: { options: GoalOptions; busy: boolean; onSave: (input: Omit<GoalCreate, "requestId">) => void; onCancel: () => void }) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: options.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const [year, month] = today.split("-").map(Number), monthEnd = `${today.slice(0, 7)}-${new Date(Date.UTC(year, month, 0)).getUTCDate()}`;
  const [metric, setMetric] = useState<GoalMetric>("overdue_tasks"), [title, setTitle] = useState(GOAL_LABELS.overdue_tasks);
  const [owner, setOwner] = useState(options.selfId), [from, setFrom] = useState(today), [to, setTo] = useState(monthEnd);
  const [target, setTarget] = useState("0"), [plan, setPlan] = useState("");
  function selectMetric(next: GoalMetric) { setMetric(next); setTitle(GOAL_LABELS[next]); setTarget(next === "first_response_minutes" ? "15" : "0"); }
  function submit(e: FormEvent) {
    e.preventDefault(); const p = options.salesPlans.find(p => `${p.month}:${p.currency}` === plan);
    onSave({ metric, title: title.trim(), ownerMembershipId: owner, ...(metric === "sales_won" ? { salesMonth: p?.month, currency: p?.currency } : { from, to, target: Number(target) }) });
  }
  return <form className="panel goal-form" onSubmit={submit} aria-label="Новая бизнес-цель">
    <h3>Какой результат нужен?</h3><fieldset disabled={busy}><div className="goal-templates">{GOAL_METRICS.map(m => <button key={m} type="button" className={`btn ${metric === m ? "" : "secondary"}`} aria-pressed={metric === m} onClick={() => selectMetric(m)}>{GOAL_LABELS[m]}</button>)}</div>
      <label>Название цели<input required maxLength={160} value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label>Ответственный руководитель<select required value={owner} onChange={e => setOwner(e.target.value)}>{options.members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
      {metric === "sales_won" ? <><label>Месячный план продаж<select required value={plan} onChange={e => setPlan(e.target.value)}><option value="">Выберите месяц и валюту</option>{options.salesPlans.filter(p => p.amount > 0 && p.month >= today.slice(0, 7)).map(p => <option key={`${p.month}:${p.currency}`} value={`${p.month}:${p.currency}`}>{p.month} · {p.amount.toLocaleString("ru-RU")} {p.currency}</option>)}</select></label>
        <p>Используется тот же план, что и в статистике. <Link to="/settings?section=ops#sales-plan">Добавить или изменить план продаж</Link></p></>
        : <><div className="goal-form-grid"><label>Начало периода<input type="date" required value={from} onChange={e => setFrom(e.target.value)} /></label><label>По какую дату включительно<input type="date" required min={from} value={to} onChange={e => setTo(e.target.value)} /></label></div>
          <label>{metric === "overdue_tasks" ? "Просроченных задач — не больше" : "Среднее время первого ответа — не больше, минут"}<input type="number" required min={metric === "overdue_tasks" ? 0 : 0.01} max={metric === "overdue_tasks" ? 1000000 : 10080} step={metric === "overdue_tasks" ? 1 : 0.01} value={target} onChange={e => setTarget(e.target.value)} /></label></>}
      <p className="muted">Исходное значение измерится автоматически. Проверка — раз в сутки и вручную по кнопке. Период считается по времени {options.timezone}. После сохранения показатель и период сохраняются в истории; для другого периода создайте новую цель.</p>
      <div className="actions"><button className="btn" type="submit">{busy ? "Сохраняем…" : "Сохранить цель"}</button><button className="btn secondary" type="button" onClick={onCancel}>Отмена</button></div>
    </fieldset>
  </form>;
}
