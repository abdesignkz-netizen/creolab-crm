import { Link } from "react-router-dom";
import type { AutopilotCaseView } from "@creolab/contracts";

export const autopilotStates: Record<string, string> = { proposed: "Ждёт подтверждения", ready: "Ожидаем срок ответа", reminded: "Сотруднику напомнили", escalated: "Передано руководителю", resolved: "Ответ подтверждён", stopped: "Остановлено", attention: "Нужно внимание" };
export function autopilotTime(value: string, zone: string) { return new Date(value).toLocaleString("ru-RU", { timeZone: zone, dateStyle: "short", timeStyle: "short" }); }
export function AutopilotCaseCard({ row, timezone, busy, onAction }: { row: AutopilotCaseView; timezone: string; busy: boolean; onAction: (id: string, op: "start" | "stop") => void }) {
  return <article className="autopilot-case">
    <div className="autopilot-case-head"><div><b>{row.customer}</b><p><Link to={`/requests/${row.inquiryId}`}>{row.title}</Link></p></div><span className={`badge ${row.state === "resolved" ? "ok" : ""}`}>{autopilotStates[row.state] || row.state}</span></div>
    <p>{row.explanation}</p>
    {row.assignedName && <p className="muted">Ответственный: {row.assignedName}</p>}
    {row.dueAt && <p className="muted">Следующий этап: {autopilotTime(row.dueAt, timezone)}</p>}
    <div className="actions">
      {row.taskId && <Link className="btn secondary" to={`/tasks?open=${row.taskId}`}>Открыть задачу</Link>}
      {row.canStart && <button type="button" className="btn" disabled={busy} onClick={() => onAction(row.id, "start")}>Рассмотреть запуск</button>}
      {row.canStop && <button type="button" className="btn secondary" disabled={busy} onClick={() => onAction(row.id, "stop")}>Остановить сценарий</button>}
    </div>
    <details><summary>История сценария</summary><ol className="autopilot-history">{row.history.map(h => <li key={h.id}><p>{h.text}</p><small className="muted">{autopilotTime(h.at, timezone)}</small>{h.runId && <> · <Link to={`/control?view=actions&run=${h.runId}`}>Выполненное действие</Link></>}</li>)}</ol></details>
  </article>;
}
