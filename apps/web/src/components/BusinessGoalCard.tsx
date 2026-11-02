import type { BusinessGoalView, GoalMeasurementView, GoalMetric } from "@creolab/contracts";
import { GOAL_LABELS } from "@creolab/contracts";

export function goalValue(value: number | null | undefined, metric: GoalMetric, currency: string | null) {
  if (value == null || !Number.isFinite(value)) return "Нет данных";
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: metric === "first_response_minutes" ? 2 : 0 }).format(value)} ${metric === "sales_won" ? currency === "KZT" ? "₸" : currency || "" : metric === "overdue_tasks" ? "задач" : "мин"}`;
}
export function goalDate(value: string, timezone: string, time = false) {
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", ...(time ? { timeStyle: "short" as const } : {}), timeZone: timezone }).format(new Date(value));
}
export function goalSampleLabel(m: GoalMeasurementView | null) {
  if (!m) return "Измерение ещё не выполнено";
  if (m.sample.status === "no_data") return "Недостаточно данных для оценки";
  if (m.sample.status === "not_started") return "Период ещё не начался";
  if (m.sample.status === "incomplete") return "Нужно проверить исходные данные";
  if (m.sample.status === "config_changed") return "Изменился часовой пояс компании — создайте цель для нового периода";
  if (m.sample.status === "plan_missing") return "План продаж удалён из настроек";
  if (m.sample.status === "ended_snapshot") return "Последний снимок до окончания периода";
  if (m.sample.unanswered) return "Есть диалоги без ответа";
  if (m.target === 0 && m.progress === null) return "Положительный план не задан";
  return m.reached ? "Показатель достигнут на момент проверки" : "Цель ещё не достигнута";
}
export function BusinessGoalCard({ goal, busy = false, onOpen }: { goal: BusinessGoalView; busy?: boolean; onOpen?: () => void }) {
  const current = goal.current, percentage = goal.stale ? null : current?.progress;
  return <article className="goal-card" aria-label={goal.title}>
    <div className="goal-top"><span className="muted">{GOAL_LABELS[goal.metric]}</span><span className="status-badge">{goal.state === "archived" ? "Архив" : goal.periodEnded ? "Период завершён" : "В работе"}</span></div>
    <h3>{goal.title}</h3><p className="muted">{goalDate(goal.from, goal.timezone)} — {goalDate(new Date(Date.parse(goal.to) - 1).toISOString(), goal.timezone)} · {goal.timezone}</p>
    <div className="goal-values"><div><span>{goal.metric === "overdue_tasks" ? "Просрочено при проверке" : goal.metric === "sales_won" ? "Выигранные сделки" : "Среднее время ответа"}</span><strong>{goalValue(current?.sample.value, goal.metric, goal.currency)}</strong></div>
      <div><span>{goal.metric === "sales_won" ? "План" : "Цель — не больше"}</span><strong>{goalValue(goal.target, goal.metric, goal.currency)}</strong></div></div>
    {typeof percentage === "number" && <div className="goal-progress"><progress max={100} value={percentage} aria-label="Прогресс цели" /><b>{percentage}%</b></div>}
    <p role="status">{goal.targetChanged ? "План изменён. Обновите измерение, чтобы пересчитать прогресс." : goal.stale ? "Показано предыдущее измерение. Требуется обновление." : goalSampleLabel(current)}</p>
    {goal.metric === "first_response_minutes" && current && <p>Диалогов с ответом: {current.sample.samples}. Без ответа: {current.sample.unanswered}.</p>}
    {goal.baseline && <p className="muted">На старте наблюдения: {goalValue(goal.baseline.value, goal.metric, goal.currency)} · {goalDate(goal.baseline.at, goal.timezone, true)}</p>}
    <p>Ответственный: {goal.owner.name}{goal.owner.active ? "" : " · требуется переназначение"}</p>
    {current && <small className="muted">Данные на {goalDate(current.asOf, goal.timezone, true)}. {goal.metric === "sales_won" ? "Это продажи по CRM, не поступление денег." : "Оценка по данным BasQar."}</small>}
    {onOpen && <p><button type="button" className="btn secondary" disabled={busy} onClick={onOpen}>Открыть цель и действия</button></p>}
  </article>;
}
