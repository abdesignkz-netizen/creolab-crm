import { absenceDate, absenceUntil } from "../lib/autopilotDates";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { DEFAULT_AUTOPILOT_CONFIG, type AutopilotConfig, type AutopilotView, type AutopilotPreview } from "@creolab/contracts";
import { createAutopilotApi } from "@creolab/api-client/autopilot";
import { api } from "../lib/api";
import { InlineFeedback } from "./InlineFeedback";
import { AutopilotCaseCard, autopilotTime } from "./AutopilotCaseCard";
import "./autopilot.css";

const client = createAutopilotApi(api.request);
const days = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
export default function AutopilotPanel({ onDirtyChange }: { onDirtyChange?: (value: boolean) => void }) {
  const [data, setData] = useState<AutopilotView | null>(null), [draft, setDraft] = useState<AutopilotConfig>(DEFAULT_AUTOPILOT_CONFIG);
  const [review, setReview] = useState<AutopilotPreview | null>(null), [confirm, setConfirm] = useState<"enable" | string | null>(null);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const [pages, setPages] = useState<Array<string | undefined>>([undefined]);
  const reviewRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true), lock = useRef(false), generation = useRef(0), retry = useRef<{ key: string; id: string } | null>(null);
  const saved = data?.policy?.config || DEFAULT_AUTOPILOT_CONFIG, dirty = Boolean(data && JSON.stringify(draft) !== JSON.stringify(saved));
  const cursor = pages.at(-1);
  useEffect(() => { if (review) { reviewRef.current?.scrollIntoView({ block: "center", behavior: "smooth" }); reviewRef.current?.focus({ preventScroll: true }); } }, [review]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; onDirtyChange?.(false); }; }, []);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", handler); return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
  async function load(reset = false) {
    const token = ++generation.current; setLoading(true); setError("");
    try { const next = await client.get(reset ? undefined : cursor); if (alive.current && token === generation.current) { setData(next); if (!dirty || reset) setDraft(next.policy?.config || DEFAULT_AUTOPILOT_CONFIG); } }
    catch (e) { if (alive.current && token === generation.current) setError(e instanceof Error ? e.message : "Не удалось загрузить правило."); }
    finally { if (alive.current && token === generation.current) setLoading(false); }
  }
  useEffect(() => { void load(); }, [cursor]);
  async function perform(fn: () => Promise<void>) {
    if (lock.current) return; lock.current = true; generation.current++; setLoading(false); setBusy(true); setError(""); setNotice("");
    try { await fn(); } catch (e) { if (alive.current) { setError(e instanceof Error ? e.message : "Не удалось выполнить действие."); setConfirm(null); } }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  function requestId(value: unknown) { const key = JSON.stringify(value); if (retry.current?.key !== key) retry.current = { key, id: crypto.randomUUID() }; return retry.current.id; }
  function edit(patch: Partial<AutopilotConfig>) { setDraft(v => ({ ...v, ...patch })); setReview(null); setConfirm(null); setNotice(""); }
  const version = data?.policy?.version || 0;
  async function operate(op: "enable" | "pause") {
    const body = { version, confirmed: true as const, requestId: requestId({ op, version }) };
    const next = await client.operation(op, body); if (!alive.current) return;
    setData(next); if (op === "enable" || !dirty) setDraft(next.policy!.config); setConfirm(null); setReview(null); setPages([undefined]);
    setNotice(op === "enable" ? "Правило включено. Новые заявки начнут проверяться в течение минуты." : "Правило на паузе. Созданные задачи сохранены.");
  }
  async function caseAction(id: string, op: "start" | "stop") {
    const row = data!.items.find(r => r.id === id)!;
    await client.caseOperation(id, op, { requestId: requestId({ id, op, version: row.version }), version: row.version, confirmed: true });
    if (!alive.current) return; setConfirm(null); setReview(null); await load();
    setNotice(op === "start" ? "Сценарий подтверждён. Перед каждым этапом система заново проверит заявку." : "Сценарий остановлен. Созданная задача сохранена.");
  }
  if (!data) return <div className="panel stack">{error ? <><InlineFeedback kind="error">{error}</InlineFeedback><button type="button" className="btn secondary" onClick={() => void load()}>Повторить</button></> : <p role="status">Загрузка контроля заявок…</p>}</div>;
  const isEnabled = data.policy?.state === "enabled";
  return <section className="autopilot-panel stack" aria-label="Контроль первого ответа" aria-busy={busy || loading}>
    <div className="panel stack"><div className="autopilot-case-head"><div><h3>Ни одна новая заявка без внимания</h3><p>Напомнить сотруднику → передать руководителю → проверить ответ.</p></div><span className={`badge ${isEnabled ? "ok" : ""}`}>{isEnabled ? saved.mode === "auto" ? "Автоматически" : "Предлагать запуск" : "На паузе"}</span></div>
      <p className="muted">Контроль только новых заявок с диалогом после включения. Уведомления — внутри BasQar, ответ клиенту пишет сотрудник.</p>
      {data.policy?.enabledAt && <p>Начало текущего периода: {autopilotTime(data.policy.enabledAt, data.timezone)}</p>}
      {data.blocked.map((text, i) => <InlineFeedback kind="error" key={i}>{text}</InlineFeedback>)}
      {error && <InlineFeedback kind="error">{error}</InlineFeedback>}{notice && <InlineFeedback kind="success">{notice}</InlineFeedback>}
      <div className="actions">{data.canEdit && isEnabled && <button type="button" className="btn secondary" disabled={busy} onClick={() => void perform(() => operate("pause"))}>Приостановить правило</button>}
        {data.canEdit && !isEnabled && data.policy && <button type="button" className="btn" disabled={busy || dirty || data.blocked.length > 0 || saved.mode === "auto" && !data.canEnableAuto} onClick={() => void perform(async () => { const r = await client.preview(saved); if (alive.current) { setReview(r); setConfirm("enable"); } })}>{saved.mode === "auto" ? "Включить автоматический режим" : "Начать предлагать"}</button>}
        <button type="button" className="btn secondary" disabled={busy || dirty || loading} onClick={() => void load()}>Обновить состояние</button></div>
      {saved.mode === "auto" && !data.canEnableAuto && <p className="muted">Автоматический режим включает владелец компании.</p>}
    </div>
    <div className="panel stack"><h3>Правило первого ответа</h3>
      <p>Рабочее время: {data.calendar.mode === "business" ? `${data.calendar.days.map(d => days[d]).join(", ")} · ${data.calendar.start}–${data.calendar.end} · ${data.timezone}` : "не настроено"}. <Link to="/settings?section=ops">Настроить календарь</Link></p>
      {data.calendar.excludedDates.length > 0 && <p className="muted">Выходные по исключениям: {data.calendar.excludedDates.join(", ")}</p>}
      <fieldset disabled={busy || !data.canEdit} className="autopilot-fields"><div className="autopilot-grid">
        <label>Режим<select value={draft.mode} onChange={e => edit({ mode: e.target.value as AutopilotConfig["mode"] })}><option value="suggest">Предлагать — каждый запуск подтверждает руководитель</option><option value="auto">Автоматически — по разрешению владельца</option></select></label>
        <label>Назначение свободной заявки<select value={draft.routing} onChange={e => edit({ routing: e.target.value as AutopilotConfig["routing"], members: e.target.value === "fixed" ? draft.members.slice(0, 1) : draft.members })}><option value="fixed">Всегда одному сотруднику</option><option value="round_robin">По очереди среди доступных</option><option value="least_load">У кого меньше открытых задач</option></select></label>
        {([['remindMinutes', 'Напомнить через, рабочих минут', 1440], ['escalateMinutes', 'После напоминания передать через, рабочих минут', 4320], ['verifyMinutes', 'После передачи проверять ответ, рабочих минут', 4320], ['hourlyLimit', 'Максимум этапов с изменениями в час', 50]] as const).map(([key, label, max]) => <label key={key}>{label}<input type="number" min={key === "hourlyLimit" ? 1 : 5} max={max} value={draft[key]} onChange={e => edit({ [key]: Number(e.target.value) })} /></label>)}
        <label>Руководитель для одной передачи<select value={draft.escalationMemberId} onChange={e => edit({ escalationMemberId: e.target.value, unavailable: draft.unavailable.filter(u => draft.members.includes(u.membershipId) || u.membershipId === e.target.value) })}><option value="">Выберите руководителя</option>{data.members.filter(m => m.role !== "manager").map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
      </div>
      <div><b>Кому назначать свободные заявки</b><p className="muted">До 8 сотрудников. Существующий ответственный сохраняется. Недоступные сотрудники пропускаются.</p><div className="autopilot-members">{data.members.map(m => <label className="check-row" key={m.id}><input type={draft.routing === "fixed" ? "radio" : "checkbox"} name="autopilot-member" checked={draft.members.includes(m.id)} onChange={e => { const members = draft.routing === "fixed" ? [m.id] : e.target.checked ? [...draft.members, m.id] : draft.members.filter(id => id !== m.id); edit({ members, unavailable: draft.unavailable.filter(u => members.includes(u.membershipId) || u.membershipId === draft.escalationMemberId) }); }} /><span>{m.name}</span></label>)}</div></div>
      <details><summary>Временно недоступные сотрудники</summary><p className="muted">Например, отпуск. Сотрудник пропускается до конца выбранной даты по времени компании.</p>{[...new Set([...draft.members, draft.escalationMemberId])].filter(Boolean).map(id => <label key={id}>{data.members.find(m => m.id === id)?.name || "Недоступный сотрудник"}<input type="date" value={draft.unavailable.some(u => u.membershipId === id) ? absenceDate(draft.unavailable.find(u => u.membershipId === id)!.until, data.timezone) : ""} onChange={e => { const value = e.target.value; edit({ unavailable: [...draft.unavailable.filter(u => u.membershipId !== id), ...(value ? [{ membershipId: id, until: absenceUntil(value, data.timezone) }] : [])] }); }} /></label>)}</details>
      </fieldset>
      <p className="muted">Ручное изменение заявки, диалога или задачи остановит сценарий. Открытая задача не создаётся повторно. После одной передачи обратного переназначения нет.</p>
      {data.canEdit && <div className="actions"><button type="button" className="btn" disabled={busy || !dirty} onClick={() => void perform(async () => { const r = await client.preview(draft); if (alive.current) { setReview(r); setConfirm(null); } })}>Проверить сценарий</button>{dirty && <button type="button" className="btn secondary" disabled={busy} onClick={() => { setDraft(saved); setReview(null); setConfirm(null); }}>Отменить изменения</button>}</div>}
    </div>
    {review && <div ref={reviewRef} tabIndex={-1} className="panel stack autopilot-review" role="region" aria-label="Подтверждение сценария"><h3>{confirm === "enable" ? "Включить это правило?" : confirm ? "Запустить для выбранной заявки?" : "Проверьте перед сохранением"}</h3><ol>{review.summary.map((text, i) => <li key={i}>{text}</li>)}</ol>
      {review.blockers.map((text, i) => <InlineFeedback kind="error" key={i}>{text}</InlineFeedback>)}
      <div className="actions">{confirm === "enable" ? <button type="button" className="btn" disabled={busy || review.blockers.length > 0} onClick={() => void perform(() => operate("enable"))}>{saved.mode === "auto" ? "Разрешаю автоматическое выполнение" : "Включить предложения"}</button>
        : confirm ? <button type="button" className="btn" disabled={busy || review.blockers.length > 0} onClick={() => void perform(() => caseAction(confirm, "start"))}>Подтвердить весь сценарий</button>
        : <button type="button" className="btn" disabled={busy || !dirty} onClick={() => void perform(async () => { const next = await client.save({ requestId: requestId({ version, draft }), version, config: draft }); if (alive.current) { setData(next); setDraft(next.policy!.config); setReview(null); setPages([undefined]); setNotice("Правило сохранено на паузе. Включите его, когда будете готовы."); } })}>{isEnabled ? "Сохранить и остановить текущие сценарии" : "Сохранить на паузе"}</button>}
        <button type="button" className="btn secondary" disabled={busy} onClick={() => { setConfirm(null); setReview(null); }}>Закрыть</button></div>
    </div>}
    <div className="panel stack"><h3>Заявки под контролем</h3><p className="muted">До 100 активных сценариев. Здесь виден результат каждого этапа; назначение сотрудника ещё не означает ответ клиенту.</p>
      {!data.items.length ? <p>Пока нет сценариев. Сохраните и включите правило. Оно начнёт отслеживать новые заявки с диалогом.</p> : data.items.map(row => <AutopilotCaseCard key={row.id} row={row} timezone={data.timezone} busy={busy || dirty} onAction={(id, op) => { void perform(async () => { if (op === "stop") return caseAction(id, op); const r = await client.preview(saved); if (alive.current) { setReview(r); setConfirm(id); } }); }} />)}
      <div className="actions">{pages.length > 1 && <button type="button" className="btn secondary" disabled={busy || dirty || loading} onClick={() => setPages(p => p.slice(0, -1))}>Назад</button>}{data.nextCursor && <button type="button" className="btn secondary" disabled={busy || dirty || loading} onClick={() => setPages(p => [...p, data.nextCursor!])}>Далее</button>}</div>
    </div>
  </section>;
}
