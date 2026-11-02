import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { BusinessExperimentDetail, ExperimentOptions, ExperimentSave } from "@creolab/contracts";
import { createBusinessExperimentsApi } from "@creolab/api-client/business-experiments";
import { api } from "../lib/api";
import { InlineFeedback } from "./InlineFeedback";
import { BusinessExperimentForm } from "./BusinessExperimentForm";
import { BusinessExperimentResult, ExperimentSampleCard, ExperimentMethodReview, experimentStatus, experimentOutcome } from "./BusinessExperimentResult";
import "./business-experiments.css";

const requests = createBusinessExperimentsApi(api.request);
const date = (v: string, timezone: string) => new Intl.DateTimeFormat("ru-RU", { timeZone: timezone, dateStyle: "short", timeStyle: "short" }).format(new Date(v));
const eventLabel: Record<string, string> = { created: "Создан черновик", edited: "Изменены условия", approve: "Условия подтверждены", stop: "Проверка остановлена", note: "Зафиксировано изменение условий", result: "Сохранено измерение" };
type Action = "approve" | "stop" | "result" | "note";

export function ExperimentHistory({ item }: { item: BusinessExperimentDetail }) {
  return <><details className="panel"><summary>История измерений · последние 30</summary>{item.measurements.length ? <ol className="experiment-history">{item.measurements.map(m => <li key={m.id}><b>{date(m.at, item.timezone)}</b><p>{experimentOutcome(m.result.status)}</p><p>Подготовлено: {m.result.current.prepared} из {m.result.current.total}.</p><details><summary>Основания этого вывода</summary><p>{m.result.recommendation}</p><ul>{m.result.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul></details></li>)}</ol> : <p>Измерений пока нет.</p>}</details>
    <details className="panel"><summary>История проверки · последние 30</summary><ol className="experiment-history">{item.history.map(e => <li key={e.id}><b>{eventLabel[e.type] || "Изменение проверки"}</b><small>{date(e.at, item.timezone)} · версия {e.version}</small>{e.note && <p>{e.note}</p>}</li>)}</ol></details></>;
}

export default function BusinessExperimentsPanel() {
  const [params, setParams] = useSearchParams(), selectedId = params.get("experiment");
  const [data, setData] = useState<Awaited<ReturnType<typeof requests.list>> | null>(null), [options, setOptions] = useState<ExperimentOptions | null>(null);
  const [selected, setSelected] = useState<BusinessExperimentDetail | null>(null), [form, setForm] = useState<"new" | "edit" | null>(null);
  const [state, setState] = useState("active"), [pages, setPages] = useState<Array<string | undefined>>([undefined]);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(""), [success, setSuccess] = useState("");
  const [confirm, setConfirm] = useState<Action | null>(null), [note, setNote] = useState("");
  const alive = useRef(true), generation = useRef(0), locked = useRef(false), retry = useRef<{ key: string; id: string } | null>(null), detailPanel = useRef<HTMLElement>(null);
  const cursor = pages.at(-1);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  async function load() {
    const g = ++generation.current; setLoading(true); setError(""); setConfirm(null); setNote("");
    try { const [list, opts, item] = await Promise.all([requests.list(state, cursor), requests.options(), selectedId ? requests.get(selectedId) : null]);
      if (alive.current && g === generation.current) { setData(list); setOptions(opts); setSelected(item); }
    } catch (e) { if (alive.current && g === generation.current) { setData(null); setOptions(null); setSelected(null); setError(e instanceof Error ? e.message : "Не удалось загрузить проверки."); } }
    finally { if (alive.current && g === generation.current) setLoading(false); }
  }
  useEffect(() => { void load(); }, [state, cursor, selectedId]);
  useEffect(() => { if (selected && !loading && !form) detailPanel.current?.focus({ preventScroll: true }); }, [selected?.id, loading, form]);
  function requestId(value: unknown) { const key = JSON.stringify(value); if (retry.current?.key !== key) retry.current = { key, id: crypto.randomUUID() }; return retry.current.id; }
  async function perform(work: () => Promise<BusinessExperimentDetail>, message: string) {
    if (locked.current) return; locked.current = true; setBusy(true); setError(""); setSuccess(""); const g = ++generation.current;
    try { const item = await work(); if (alive.current && g === generation.current) { retry.current = null; setSelected(item); setForm(null); setConfirm(null); setNote(""); setSuccess(message); setParams({ view: "experiments", experiment: item.id }); } }
    catch (e) { if (alive.current && g === generation.current) { if ([401, 403].includes(Number((e as { status?: number }).status))) { setSelected(null); setOptions(null); setData(null); setForm(null); }
      setError(e instanceof Error ? e.message : "Изменение не подтверждено. Повторите тот же запрос или обновите данные."); } }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  function save(input: Omit<ExperimentSave, "requestId">) {
    const id = form === "edit" ? selected!.id : null;
    void perform(() => requests.save(id, { ...input, requestId: requestId({ id, input }) }), "Черновик сохранён. Проверьте условия и исходные данные перед запуском.");
  }
  function operate(action: Action) {
    if (!selected) return;
    const body = { version: selected.version, ...(action === "approve" ? { reviewHash: selected.reviewHash! } : {}), ...(["note", "stop"].includes(action) ? { note } : {}) };
    void perform(() => requests.operate(selected.id, action, { ...body, requestId: requestId({ id: selected.id, action, body }) }),
      ({ approve: "Условия подтверждены. Выполните задачу внедрения до начала периода проверки.", stop: "Проверка остановлена. История сохранена.", result: "Измерение сохранено. Вывод и его ограничения приведены ниже.", note: "Изменение условий записано и будет учтено при следующем измерении." })[action]);
  }
  function back() { setForm(null); setSuccess(""); setParams({ view: "experiments" }); }
  return <section className="business-experiments" aria-label="Проверки улучшений">
    <header className="page-head"><div><h2>Проверки улучшений</h2><p className="muted">Помогло ли изменение в работе? Согласуйте условия заранее и сравните фактические данные.</p></div>{options?.canEdit && !form && <button className="btn" disabled={busy || loading} onClick={() => { setForm("new"); setSuccess(""); setParams({ view: "experiments" }); }}>Новая проверка</button>}</header>
    {error && <InlineFeedback kind="error" message={error}>{error} <button className="btn secondary" disabled={busy || loading} onClick={() => void load()}>Обновить данные</button></InlineFeedback>}
    {success && <InlineFeedback kind="success">{success}</InlineFeedback>}
    {loading && <p role="status">Загружаем проверки…</p>}
    {!loading && form && options && <BusinessExperimentForm key={form === "edit" ? `${selected?.id}-${selected?.version}` : "new"} options={options} item={form === "edit" ? selected : null} busy={busy} onSave={save} onCancel={() => setForm(null)} />}
    {!loading && !form && selected && <section className="experiment-detail" ref={detailPanel} tabIndex={-1} aria-label="Условия и результат проверки">
      <button className="btn secondary" disabled={busy} onClick={back}>← Все проверки</button>
      <header className="panel"><span className="experiment-state">{experimentStatus(selected.state)}</span><h3>{selected.title}</h3><p>{selected.state === "draft" ? "Черновик можно менять. Наблюдение начнётся только после подтверждения." : "Условия зафиксированы. Для другого периода, группы или критерия создайте новую проверку."}</p>
        {selected.approvedAt && <small>Подтверждено {date(selected.approvedAt, selected.timezone)}</small>}
        {selected.stopReason && <p><b>Причина остановки:</b> {selected.stopReason}</p>}
      </header>
      <ExperimentMethodReview item={selected} />
      {selected.result ? <BusinessExperimentResult result={selected.result} stopped={selected.state === "stopped"} /> : <div className="panel"><ExperimentSampleCard label={selected.state === "draft" ? "Исходные данные перед запуском" : "Зафиксированный исходный период"} sample={selected.baseline} />
        {selected.baseline && (selected.baseline.prepared < selected.method.minimumSample || selected.baseline.pending > 0 || selected.baseline.capped || selected.baseline.medianMinutes === 0) && <p className="experiment-warning">Исходных данных недостаточно для положительного вывода. Выберите в черновике период с полной историей и достаточным числом КП.</p>}
        {selected.state === "running" && <p>Для промежуточных данных или итогового вывода нажмите «Проверить результат». До конца периода итог не подводится.</p>}
      </div>}
      {selected.canEdit && !["stopped", "completed"].includes(selected.state) && <section className="panel experiment-actions"><h3>Следующее действие</h3><div className="actions">
        {selected.state === "draft" ? <><button className="btn" disabled={busy || !selected.reviewHash} onClick={() => setConfirm("approve")}>Проверить и подтвердить запуск</button><button className="btn secondary" disabled={busy} onClick={() => { setConfirm(null); setForm("edit"); }}>Изменить черновик</button></> : <><button className="btn" disabled={busy} onClick={() => operate("result")}>Проверить результат</button><button className="btn secondary" disabled={busy} onClick={() => { setNote(""); setConfirm("note"); }}>Условия изменились</button></>}
        <button className="btn secondary" disabled={busy} onClick={() => { setNote(""); setConfirm("stop"); }}>Остановить проверку</button>
      </div>{confirm && <form className="experiment-confirm" onSubmit={e => { e.preventDefault(); operate(confirm); }}><h4>{confirm === "approve" ? "Подтвердить эти условия?" : confirm === "stop" ? "Остановить проверку?" : "Что изменилось во время проверки?"}</h4>
        {confirm === "approve" ? <p>Сохраним исходные данные, выбранных сотрудников, периоды и критерий результата. После подтверждения их нельзя менять. Задача внедрения выполняется отдельно; настройки ИИ и сообщения клиентам не изменяются.</p> : <label>{confirm === "stop" ? "Причина остановки" : "Изменение условий"}<textarea autoFocus required minLength={5} maxLength={800} disabled={busy} value={note} onChange={e => setNote(e.target.value)} placeholder={confirm === "note" ? "Например: в периоде изменились цены или сложность заказов" : "Почему прекращаем проверку"} /></label>}
        {confirm === "note" && <p>Запись сохранится в истории. Итог учтёт, что периоды больше нельзя считать сопоставимыми.</p>}
        <div className="actions"><button className="btn" disabled={busy || (confirm !== "approve" && note.trim().length < 5)}>{busy ? "Сохраняем…" : confirm === "approve" ? "Подтвердить условия" : confirm === "stop" ? "Подтвердить остановку" : "Записать изменение"}</button><button className="btn secondary" type="button" disabled={busy} onClick={() => setConfirm(null)}>Назад</button></div>
      </form>}</section>}
      <ExperimentHistory item={selected} />
    </section>}
    {!loading && !form && !selected && data && <><div className="actions" role="group" aria-label="Состояние проверок">{[["active", "В работе"], ["finished", "Завершённые"], ["all", "Все"]].map(([v, label]) => <button key={v} className={`btn ${state === v ? "" : "secondary"}`} aria-pressed={state === v} disabled={busy} onClick={() => { setState(v); setPages([undefined]); }}>{label}</button>)}</div>
      {data.items.length ? <div className="experiment-list">{data.items.map(item => <article className="panel" key={item.id}><span className="experiment-state">{experimentStatus(item.state)}</span><h3>{item.title}</h3><button className="btn secondary" disabled={busy} onClick={() => { setSuccess(""); setParams({ view: "experiments", experiment: item.id }); }}>Условия и результат</button></article>)}</div> : <div className="panel empty"><h3>{state === "active" ? "Проверьте одно конкретное улучшение" : "Завершённых проверок пока нет"}</h3><p>Первый сценарий — сокращение времени подготовки коммерческих предложений. Свяжите изменение с задачей, выберите сотрудников и два периода.</p><p>Учитываем время от создания задачи типа «КП» до первой подготовки отправки. Данные измеряются по записям CRM.</p>{!data.canEdit && <p>Проверку создаёт и утверждает владелец или директор.</p>}</div>}
      <nav className="actions" aria-label="Страницы проверок"><button className="btn secondary" disabled={busy || pages.length === 1} onClick={() => setPages(p => p.slice(0, -1))}>Назад</button><span>Страница {pages.length}</span><button className="btn secondary" disabled={busy || !data.nextCursor} onClick={() => setPages(p => [...p, data.nextCursor || undefined])}>Далее</button></nav>
    </>}
  </section>;
}
