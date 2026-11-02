import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { BusinessGoalDetail, GoalChange, GoalOptions } from "@creolab/contracts";
import { createBusinessGoalsApi } from "@creolab/api-client/business-goals";
import { api } from "../lib/api";
import { InlineFeedback } from "./InlineFeedback";
import { BusinessGoalCard, goalDate, goalSampleLabel, goalValue } from "./BusinessGoalCard";
import { BusinessGoalForm } from "./BusinessGoalForm";
import { BusinessGoalHistory } from "./BusinessGoalHistory";
import "./business-goals.css";

const goalsApi = createBusinessGoalsApi(api.request);
export default function BusinessGoalsPanel() {
  const [params, setParams] = useSearchParams(), selectedId = params.get("goal");
  const [data, setData] = useState<Awaited<ReturnType<typeof goalsApi.list>> | null>(null), [options, setOptions] = useState<GoalOptions | null>(null);
  const [selected, setSelected] = useState<BusinessGoalDetail | null>(null), [create, setCreate] = useState(false);
  const [state, setState] = useState("active"), [pages, setPages] = useState<Array<string | undefined>>([undefined]);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [title, setTitle] = useState(""), [owner, setOwner] = useState(""), [target, setTarget] = useState("");
  const [query, setQuery] = useState(""), [tasks, setTasks] = useState<Array<{ id: string; title: string }>>([]);
  const [taskId, setTaskId] = useState(""), [taskLoading, setTaskLoading] = useState(false);
  const alive = useRef(true), busyRef = useRef(false), generation = useRef(0), request = useRef<{ hash: string; id: string } | null>(null);
  const detailPanel = useRef<HTMLElement>(null), cursor = pages.at(-1);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  useEffect(() => { if (selected) { setTitle(selected.title); setOwner(selected.owner.id); setTarget(String(selected.target ?? "")); setTaskId(""); detailPanel.current?.focus({ preventScroll: true }); } }, [selected?.id, selected?.version]);
  async function load() {
    const version = ++generation.current; setLoading(true); setError("");
    try {
      const [list, opts, detail] = await Promise.all([goalsApi.list(state, cursor), goalsApi.options(), selectedId ? goalsApi.get(selectedId) : null]);
      if (alive.current && version === generation.current) { setData(list); setOptions(opts); setSelected(detail); }
    } catch (e) { if (alive.current && version === generation.current) { setData(null); setSelected(null); setOptions(null); setError(e instanceof Error ? e.message : "Не удалось загрузить цели"); } }
    finally { if (alive.current && version === generation.current) setLoading(false); }
  }
  useEffect(() => { void load(); }, [state, cursor, selectedId]);
  useEffect(() => {
    if (!selected?.canEdit || selected.state !== "active" || selected.periodEnded) return;
    let active = true; setTaskLoading(true);
    const timer = setTimeout(() => { goalsApi.tasks(query).then(r => { if (active) setTasks(r.items); }).catch(e => { if (active) { setTasks([]); setError(e.message); } }).finally(() => { if (active) setTaskLoading(false); }); }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [selected?.id, selected?.state, query]);
  function requestId(value: unknown) { const hash = JSON.stringify(value); if (request.current?.hash !== hash) request.current = { hash, id: crypto.randomUUID() }; return request.current.id; }
  async function perform(work: () => Promise<BusinessGoalDetail>) {
    if (busyRef.current) return; busyRef.current = true; setBusy(true); setError(""); const version = ++generation.current;
    try { const result = await work(); if (alive.current && version === generation.current) { request.current = null; setSelected(result); setCreate(false); setParams({ view: "goals", goal: result.id });
      const list = await goalsApi.list(state, cursor); if (alive.current && version === generation.current) setData(list); } }
    catch (e) { if (alive.current && version === generation.current) { if ([401, 403].includes(Number((e as { status?: number })?.status))) { setData(null); setSelected(null); setOptions(null); }
      setError(e instanceof Error ? e.message : "Не удалось сохранить изменение"); } }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  function change(input: Omit<GoalChange, "requestId" | "version">) {
    if (!selected) return; const body = { ...input, version: selected.version }; void perform(() => goalsApi.update(selected.id, { ...body, requestId: requestId({ id: selected.id, body }) }));
  }
  function link(remove: boolean, id = taskId) {
    if (!selected || !id) return; const body = { taskId: id, remove, version: selected.version };
    void perform(() => goalsApi.link(selected.id, { ...body, requestId: requestId({ goal: selected.id, body }) }));
  }
  return <section className="business-goals" aria-label="Бизнес-цели">
    <header className="page-head"><div><h2>Цели компании</h2><p className="muted">Какой результат нужен, кто отвечает и что уже изменилось.</p></div>{options?.canEdit && !create && <button className="btn" disabled={busy || loading} onClick={() => { setCreate(true); setParams({ view: "goals" }); }}>Новая цель</button>}</header>
    {error && <InlineFeedback kind="error">{error} <button className="btn secondary" disabled={busy || loading} onClick={() => void load()}>Обновить данные</button></InlineFeedback>}
    {loading && <p role="status">Загружаем цели…</p>}
    {!loading && create && options && <BusinessGoalForm options={options} busy={busy} onCancel={() => setCreate(false)} onSave={input => void perform(() => goalsApi.create({ ...input, requestId: requestId(input) }))} />}
    {!loading && !create && selected && <section className="goal-detail" ref={detailPanel} tabIndex={-1} aria-label="Настройка и история цели">
      <button className="btn secondary" disabled={busy} onClick={() => setParams({ view: "goals" })}>← Все цели</button>
      <BusinessGoalCard goal={selected} />
      <div className="actions">{selected.state === "active" && <button className="btn secondary" disabled={busy} onClick={() => { const key = requestId({ refresh: selected.id, measured: selected.current?.id }); void perform(() => goalsApi.refresh(selected.id, key)); }}>Проверить показатель</button>}
        {selected.canEdit && (selected.state === "active" ? <button className="btn secondary" disabled={busy} onClick={() => change({ state: "archived" })}>Убрать в архив</button> : !selected.periodEnded && <button className="btn secondary" disabled={busy} onClick={() => change({ state: "active" })}>Вернуть в работу</button>)}</div>
      <details className="panel"><summary>Как считается показатель</summary><p>{selected.current?.sample.formula}</p><p>{selected.current?.sample.limitation}</p><p>Прогресс снижения считается от первого измеренного значения до целевого. Если исходное значение уже укладывается в цель, оценивается сохранение результата. Изменение цели записывается в историю и не переписывает прежние измерения.</p>
        <p>Следующая проверка: {selected.nextCheckAt ? goalDate(selected.nextCheckAt, selected.timezone, true) : "не запланирована"}.</p></details>
      {selected.canEdit && selected.state === "active" && !selected.periodEnded && options && <details className="panel"><summary>Изменить цель или ответственного</summary><form className="goal-form" onSubmit={e => { e.preventDefault(); change({ title, ownerMembershipId: owner, ...(selected.metric === "sales_won" ? {} : { target: Number(target) }) }); }}><fieldset disabled={busy}>
        <label>Название<input required maxLength={160} value={title} onChange={e => setTitle(e.target.value)} /></label>
        <label>Ответственный<select required value={owner} onChange={e => setOwner(e.target.value)}>{options.members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
        {selected.metric === "sales_won" ? <p>Сумма общая со статистикой. <Link to="/settings?section=ops#sales-plan">Изменить план продаж</Link></p> : <label>Цель — не больше, {selected.metric === "overdue_tasks" ? "задач" : "минут"}<input required type="number" min={selected.metric === "overdue_tasks" ? 0 : 0.01} step={selected.metric === "overdue_tasks" ? 1 : 0.01} value={target} onChange={e => setTarget(e.target.value)} /></label>}
        <button className="btn" type="submit">Сохранить изменения</button></fieldset></form></details>}
      <section className="panel"><h3>Действия для достижения цели</h3><p className="muted">Свяжите задачи с целью. Завершение задачи само по себе не меняет показатель и не доказывает рост продаж.</p>
        {!selected.initiatives.length && <p>Пока нет связанных задач.</p>}
        {selected.initiatives.map(i => <div key={i.id} className="goal-initiative"><Link to={`/tasks?open=${encodeURIComponent(i.taskId)}`}>{i.title}</Link><span>{({ open: "К выполнению", in_progress: "В работе", waiting: "Ожидание", done: "Завершена", canceled: "Отменена" } as Record<string, string>)[i.status] || "Проверить статус"}</span>
          {i.runId && <Link to={`/control?view=plans&run=${encodeURIComponent(i.runId)}`}>История выполнения</Link>}{selected.canEdit && selected.state === "active" && !selected.periodEnded && <button className="btn secondary" disabled={busy} onClick={() => link(true, i.taskId)}>Убрать связь</button>}</div>)}
        {selected.canEdit && selected.state === "active" && !selected.periodEnded && <form className="goal-form" onSubmit={e => { e.preventDefault(); link(false); }}><fieldset disabled={busy}><label>Найти задачу<input value={query} onChange={e => { setQuery(e.target.value); setTaskId(""); }} placeholder="Например, разобрать просрочки" /></label>
          <label>Задача<select required disabled={taskLoading} value={taskId} onChange={e => setTaskId(e.target.value)}><option value="">{taskLoading ? "Ищем…" : "Выберите задачу"}</option>{tasks.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select></label>
          <button className="btn secondary" disabled={taskLoading || !taskId}>Связать с целью</button><Link to="/control?view=plans">Создать задачу через план действий</Link></fieldset><small className="muted">Показаны первые 20 открытых задач. При необходимости уточните название.</small></form>}
      </section>
      <details className="panel"><summary>История измерений · последние 30</summary><div className="goal-history">{selected.measurements.map(m => <article key={m.id}><b>{goalDate(m.at, selected.timezone, true)}</b><p>{goalValue(m.sample.value, selected.metric, selected.currency)} · цель: {goalValue(m.target, selected.metric, selected.currency)}</p><p>{goalSampleLabel(m)}{m.progress !== null ? ` · ${m.progress}%` : ""}</p></article>)}</div></details>
      <details className="panel"><summary>Изменения цели · последние 30</summary><BusinessGoalHistory goal={selected} /></details>
    </section>}
    {!loading && !create && !selected && data && <><div className="actions" role="group" aria-label="Состояние целей">{[["active", "В работе"], ["archived", "Архив"]].map(([v, label]) => <button key={v} className={`btn ${state === v ? "" : "secondary"}`} aria-pressed={state === v} disabled={busy} onClick={() => { setState(v); setPages([undefined]); }}>{label}</button>)}</div>
      {data.items.length ? <div className="goal-grid">{data.items.map(g => <BusinessGoalCard key={g.id} goal={g} busy={busy} onOpen={() => setParams({ view: "goals", goal: g.id })} />)}</div> : <div className="panel empty"><h3>{state === "active" ? "Выберите первый измеримый результат" : "Архив пока пуст"}</h3><p>План продаж, меньше просрочек или более быстрые ответы. BasQar сохранит исходный показатель и будет проверять изменения.</p>{!data.canEdit && <p>Цели создаёт владелец или директор компании.</p>}</div>}
      <nav className="actions" aria-label="Страницы целей"><button className="btn secondary" disabled={busy || pages.length === 1} onClick={() => setPages(p => p.slice(0, -1))}>Назад</button><span>Страница {pages.length}</span><button className="btn secondary" disabled={busy || !data.nextCursor} onClick={() => setPages(p => [...p, data.nextCursor || undefined])}>Далее</button></nav></>}
  </section>;
}
