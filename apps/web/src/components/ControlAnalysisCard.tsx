import { Link } from "react-router-dom";
import type { ControlAnalysis } from "@creolab/contracts";

const states: Record<string, string> = { draft: "Ждёт проверки и подтверждения", queued: "В очереди", running: "Выполняется", succeeded: "Шаги плана выполнены", failed: "Остановлено с ошибкой", cancelled: "Отменено", expired: "Подтверждение истекло" };
const kinds = { facts: "Данные сервиса", insight: "Вывод для проверки", goal: "Цель компании", decision: "Утверждённый контекст" };
// Never turn material, decision or provider text into arbitrary navigation.
export function controlAnalysisHref(value: string) {
  return /^\/(?:today|stats|tasks|requests|deals|control)(?:\?[a-zA-Z0-9_=&%.-]+)?$/.test(value) ? value : "/control";
}
export function ControlAnalysisCard({ analysis: a, busy, onPrepare }: { analysis: ControlAnalysis; busy: boolean; onPrepare: (command: string) => void }) {
  return <div className="control-analysis">
    <header><h4>{a.title}</h4><p>{a.summary}</p><small>Снимок: {new Date(a.asOf).toLocaleString("ru-RU", { timeZone: a.timezone })} · {a.timezone}</small></header>
    {a.limitations.length > 0 && <details className="control-analysis-limitations" open={a.budget.limited}><summary>Что учтено и чего пока нельзя утверждать</summary><ul>{[...new Set(a.limitations)].map((text, i) => <li key={i}>{text}</li>)}</ul></details>}
    <div className="control-analysis-evidence">{a.cards.map((card, i) => <details key={i} open={card.kind === "facts"}><summary><span>{kinds[card.kind]}</span> {card.title}</summary><p>{card.text}</p><Link to={controlAnalysisHref(card.href)}>Открыть источник</Link><small>Проверено: {new Date(card.asOf).toLocaleString("ru-RU", { timeZone: a.timezone })}</small></details>)}</div>
    {a.suggestion && <section className="control-analysis-next"><h4>Предлагаемый следующий шаг</h4><b>{a.suggestion.title}</b><ol>{a.suggestion.steps.map((s, i) => <li key={i}>{s}</li>)}</ol><Link to={controlAnalysisHref(a.suggestion.href)}>Перейти к данным и выполнить вручную</Link>
      {!a.plan && <button type="button" className="btn" disabled={busy} onClick={() => onPrepare(a.suggestion!.command)}>Подготовить план по свежим данным</button>}
    </section>}
    {a.plan && <section className="control-analysis-plan" aria-label="План действий"><b>{states[a.plan.status] || "Проверьте состояние плана"}</b><p>Выполнено шагов: {a.plan.completed} из {a.plan.stepCount}. Создание задачи не означает, что бизнес-результат достигнут.</p><Link className="btn secondary" to={controlAnalysisHref(a.plan.href)}>{a.plan.status === "draft" ? "Проверить план и подтвердить" : "Открыть план и результат"}</Link></section>}
    <small>Проверок: {a.budget.reads} из {a.budget.maxReads}. Ответ составлен по данным BasQar.</small>
  </div>;
}
