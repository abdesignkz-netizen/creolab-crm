import type { BusinessExperimentDetail, ExperimentResult, ExperimentSample } from "@creolab/contracts";
import { Link } from "react-router-dom";
export const experimentStatus = (s: string) => ({ draft: "Черновик", running: "Проверка утверждена", completed: "Период завершён", stopped: "Остановлена" }[s] || s);
export const experimentOutcome = (s: string) => ({ in_progress: "Промежуточные данные", insufficient_data: "Данных недостаточно", conditions_changed: "Условия изменились", improvement_observed: "Наблюдается сокращение времени", no_improvement: "Порог улучшения не достигнут" }[s] || s);
const number = (v: number | null) => v === null ? "Нет измерения" : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(v);
export function ExperimentSampleCard({ label, sample }: { label: string; sample: ExperimentSample | null }) {
  return <article className="experiment-sample"><h4>{label}</h4><strong>{sample?.medianMinutes === null || !sample ? "Нет измерения" : `${number(sample.medianMinutes)} мин`}</strong><p>Медианное время подготовки</p>{sample && <small>{sample.capped ? "Больше 2000 задач — выборка ограничена" : `Подготовлено ${sample.prepared} из ${sample.total}; без подготовки — ${sample.pending}`}</small>}</article>;
}
export function BusinessExperimentResult({ result, stopped = false }: { result: ExperimentResult; stopped?: boolean }) {
  return <section className="panel experiment-result" aria-labelledby="experiment-result-title"><h3 id="experiment-result-title">{stopped ? "Последнее измерение до остановки" : experimentOutcome(result.status)}</h3>
    <div className="experiment-comparison"><ExperimentSampleCard label="Исходный период" sample={result.baseline} /><ExperimentSampleCard label="Период проверки" sample={result.current} /></div>
    {result.reductionPercent !== null && <p>Наблюдаемое изменение медианы: {result.reductionPercent >= 0 ? "снижение" : "рост"} на {number(Math.abs(result.reductionPercent))}%. Оценка порога использует точное значение.</p>}
    <p>{stopped ? "Проверка остановлена. Эти данные не считаются её успешным итогом." : result.recommendation}</p>
    {result.reasons.length > 0 && <ul>{result.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
    <p className="muted">Сравнение до/после не доказывает, что изменение вызвано именно инициативой. Качество КП и реальные продажи проверяются отдельно.</p>
  </section>;
}
export function ExperimentMethodReview({ item }: { item: BusinessExperimentDetail }) {
  const m = item.method;
  return <section className="panel experiment-method"><h3>Что проверяем</h3><p><b>Гипотеза:</b> {item.hypothesis}</p><p><b>Изменение:</b> {item.change}</p>
    <dl><div><dt>Исходный период</dt><dd>{m.baselineFrom} — {m.baselineTo}</dd></div><div><dt>Период проверки</dt><dd>{m.from} — {m.to}</dd></div><div><dt>Часовой пояс</dt><dd>{item.timezone}</dd></div>
      <div><dt>Условие успеха</dt><dd>Сократить медианное время минимум на {number(m.targetReductionPercent)}%</dd></div><div><dt>Минимальная выборка</dt><dd>{m.minimumSample} КП в каждом периоде, без задач с незаписанной подготовкой</dd></div><div><dt>Группа</dt><dd>{item.members.map(m => `${m.name}${m.active ? "" : " (недоступен)"}`).join(", ")}</dd></div></dl>
    {item.initiative ? <p>Внедрение: <Link to={item.initiative.href}>{item.initiative.title}</Link> · {item.initiative.status === "done" ? "Выполнение записано" : "Нужно завершить до начала проверки"}{item.initiative.runHref && <> · <Link to={item.initiative.runHref}>История плана</Link></>}</p> : <p className="error">Задача внедрения недоступна. Проверьте связь перед запуском.</p>}
    {m.goal && <p><Link to={`/control?view=goals&goal=${m.goal.id}`}>Связанная цель</Link></p>}{m.decision && <p><Link to={`/control?view=memory&decision=${m.decision.id}`}>Основание — решение компании</Link></p>}
    <details><summary>Как считается результат и что он не доказывает</summary><ul>{item.limitations.map(t => <li key={t}>{t}</li>)}</ul></details>
  </section>;
}
