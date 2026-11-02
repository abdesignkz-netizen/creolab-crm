import type { BusinessGoalDetail } from "@creolab/contracts";
import { goalDate, goalValue } from "./BusinessGoalCard";

const names: Record<string, string> = { created: "Цель создана", changed: "Изменены параметры цели", measured: "Показатель проверен", sales_plan_changed: "Изменён связанный план продаж", initiative_added: "Добавлена связанная задача", initiative_removed: "Связь с задачей убрана" };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const number = (value: unknown) => value === null || value === undefined ? null : Number(value);

export function BusinessGoalHistory({ goal }: { goal: BusinessGoalDetail }) {
  return <ol>{goal.history.map(e => {
    const before = record(e.changes.before), after = record(e.changes.after);
    return <li key={e.id}><b>{names[e.type] || "Изменение сохранено"}</b> · {goalDate(e.at, goal.timezone, true)}
      {e.type === "sales_plan_changed" && <p>Было: {goalValue(number(e.changes.before), goal.metric, goal.currency)} → стало: {goalValue(number(e.changes.after), goal.metric, goal.currency)}</p>}
      {e.type === "changed" && <>
        {before.target !== after.target && <p>Целевой показатель: {goalValue(number(before.target), goal.metric, goal.currency)} → {goalValue(number(after.target), goal.metric, goal.currency)}</p>}
        {before.title !== after.title && <p>Название: {String(before.title || "—")} → {String(after.title || "—")}</p>}
        {before.ownerMembershipId !== after.ownerMembershipId && <p>Назначен другой ответственный.</p>}
        {before.state !== after.state && <p>{after.state === "archived" ? "Цель перенесена в архив. Автоматические проверки остановлены." : "Цель возвращена в работу."}</p>}
      </>}
    </li>;
  })}</ol>;
}
