import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { BusinessDecisionDetail, DecisionContent } from "@creolab/contracts";
import { createBusinessMemoryApi } from "@creolab/api-client/business-memory";
import { api } from "../lib/api";
import { InlineFeedback } from "./InlineFeedback";
import { BusinessDecisionCard } from "./BusinessDecisionCard";
import { BusinessDecisionForm } from "./BusinessDecisionForm";
import { goalDate } from "./BusinessGoalCard";
import "./business-memory.css";

const memoryApi = createBusinessMemoryApi(api.request);
const eventNames: Record<string, string> = { created: "Создан черновик", edited: "Черновик изменён", approved: "Утверждено", superseded: "Заменено новым решением", revoked: "Отозвано", erased: "Содержимое удалено", retention_erased: "Содержимое удалено по сроку хранения" };
const fieldNames: Record<string, string> = { topic: "тема", title: "название", body: "текст", rationale: "основание", kind: "тип", sourceKind: "источник", sourceId: "связанная запись", validFrom: "начало действия", validUntil: "срок пересмотра", retentionUntil: "срок хранения" };
export default function BusinessMemoryPanel() {
  const [params, setParams] = useSearchParams(), id = params.get("decision");
  const [data, setData] = useState<Awaited<ReturnType<typeof memoryApi.list>> | null>(null), [selected, setSelected] = useState<BusinessDecisionDetail | null>(null);
  const [config, setConfig] = useState<Awaited<ReturnType<typeof memoryApi.options>> | null>(null), [filter, setFilter] = useState("all"), [search, setSearch] = useState(""), [query, setQuery] = useState("");
  const [pages, setPages] = useState<Array<string | undefined>>([undefined]), [form, setForm] = useState<{ id: string | null; version: number; content?: DecisionContent } | null>(null);
  const [operation, setOperation] = useState<"approve" | "revoke" | "erase" | null>(null), [replacement, setReplacement] = useState("");
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const alive = useRef(true), generation = useRef(0), busyRef = useRef(false), key = useRef<{ hash: string; id: string } | null>(null), heading = useRef<HTMLElement>(null);
  const cursor = pages.at(-1);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  useEffect(() => { const t = setTimeout(() => { setQuery(search); setPages([undefined]); }, 300); return () => clearTimeout(t); }, [search]);
  useEffect(() => { setOperation(null); setReplacement(""); heading.current?.focus({ preventScroll: true }); }, [selected?.id, selected?.version]);
  async function load() {
    const token = ++generation.current; setLoading(true); setError("");
    try { const [rows, opts, detail] = await Promise.all([memoryApi.list(filter, query, cursor), memoryApi.options(), id ? memoryApi.get(id) : null]);
      if (alive.current && token === generation.current) { setData(rows); setConfig(opts); setSelected(detail); } }
    catch (e) { if (alive.current && token === generation.current) { setData(null); setSelected(null); setConfig(null); setError(e instanceof Error ? e.message : "Не удалось загрузить решения"); } }
    finally { if (alive.current && token === generation.current) setLoading(false); }
  }
  useEffect(() => { void load(); }, [filter, query, cursor, id]);
  function requestId(value: unknown) { const hash = JSON.stringify(value); if (key.current?.hash !== hash) key.current = { hash, id: crypto.randomUUID() }; return key.current.id; }
  async function perform(work: () => Promise<BusinessDecisionDetail>) {
    if (busyRef.current) return; busyRef.current = true; setBusy(true); setError(""); const token = ++generation.current;
    try { const item = await work(); if (alive.current && token === generation.current) { key.current = null; setSelected(item); setForm(null); setOperation(null); setParams({ view: "memory", decision: item.id });
      const rows = await memoryApi.list(filter, query, cursor); if (alive.current && token === generation.current) setData(rows); } }
    catch (e) { if (alive.current && token === generation.current) { if ([401, 403].includes(Number((e as { status?: number })?.status))) { setData(null); setSelected(null); setConfig(null); setForm(null); } setError(e instanceof Error ? e.message : "Изменение не сохранено"); } }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  function confirm() {
    if (!selected || !operation) return;
    const body = { version: selected.version, confirmed: true as const, ...(operation === "approve" && replacement ? { replacesId: replacement } : {}) };
    void perform(() => memoryApi.operation(selected.id, operation, { ...body, requestId: requestId({ id: selected.id, operation, body }) }));
  }
  return <section className="business-memory" aria-label="Память решений"><header className="page-head"><div><h2>Решения компании</h2><p className="muted">Что решили, почему и до какого срока это актуально.</p></div>{config?.canEdit && !form && <button className="btn" disabled={busy || loading} onClick={() => { setForm({ id: null, version: 0 }); setParams({ view: "memory" }); }}>Записать решение</button>}</header>
    <p>Здесь хранится управленческий контекст для планов. Он не меняет настройки, права сотрудников или ответы клиентам автоматически.</p>
    {error && <InlineFeedback kind="error" message={error}>{error} <button className="btn secondary" disabled={busy || loading} onClick={() => void load()}>Обновить данные</button></InlineFeedback>}
    {loading && <p role="status">Проверяем решения…</p>}
    {!loading && config && form && <BusinessDecisionForm key={`${form.id || "new"}:${form.version}`} initial={form.content} timezone={config.timezone} busy={busy} onCancel={() => setForm(null)} onSave={content => { const body = { version: form.version, content }; void perform(() => memoryApi.save(form.id, { ...body, requestId: requestId({ id: form.id, body }) })); }} />}
    {!loading && !form && config && selected && <section className="decision-detail" ref={heading} tabIndex={-1} aria-label="Решение и история">
      <button className="btn secondary" disabled={busy} onClick={() => setParams({ view: "memory" })}>← Все решения</button>
      <BusinessDecisionCard item={selected} timezone={config.timezone} />
      <div className="actions">{selected.canEdit && selected.content && <button className="btn secondary" disabled={busy} onClick={() => setForm({ id: selected.state === "draft" ? selected.id : null, version: selected.state === "draft" ? selected.version : 0, content: selected.content! })}>{selected.state === "draft" ? "Редактировать черновик" : "Подготовить новое решение"}</button>}
        {selected.canEdit && selected.state === "draft" && selected.kind !== "hypothesis" && <button className="btn" disabled={busy || ["source_changed", "source_unavailable", "deleted"].includes(selected.effective)} onClick={() => setOperation("approve")}>Проверить и утвердить</button>}
        {selected.canEdit && ["approved", "draft"].includes(selected.state) && <button className="btn secondary" disabled={busy} onClick={() => setOperation("revoke")}>Отозвать</button>}
        {selected.canEdit && <button className="btn secondary" disabled={busy} onClick={() => setOperation("erase")}>Удалить содержимое</button>}
        {selected.effective === "active" && <Link className="btn secondary" to={`/control?view=plans&decision=${selected.id}&decisionVersion=${selected.version}`}>Подготовить план с этим основанием</Link>}
      </div>
      {operation && <section className="panel decision-confirm" aria-label="Подтверждение изменения"><h3>{operation === "approve" ? "Утвердить показанную версию?" : operation === "revoke" ? "Отозвать решение?" : "Удалить содержимое решения?"}</h3>
        <p>{operation === "approve" ? "Решение сможет служить основанием для плана в пределах указанного срока. Вы подтверждаете проверку его текста и основания. Это не запускает действия." : operation === "revoke" ? "Решение перестанет участвовать в новых планах. Ещё не выполненные шаги связанных планов остановятся при следующей проверке. Выполненная работа сохранится." : "Текст, название, объяснение и связь с источником будут удалены. В журнале останется факт операции и её автор. Удаление не отменяет уже выполненную работу."}</p>
        {operation === "approve" && selected.conflicts.length > 0 && <label>По этой теме уже есть решение. Что заменить?<select required value={replacement} onChange={e => setReplacement(e.target.value)}><option value="">Выберите прежнее решение после проверки</option>{selected.conflicts.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label>}
        {operation === "approve" && selected.conflicts.map(c => <Link key={c.id} to={`/control?view=memory&decision=${c.id}`}>Проверить прежнее решение: {c.title}</Link>)}
        <div className="actions"><button className="btn" disabled={busy || operation === "approve" && selected.conflicts.length > 0 && !replacement} onClick={confirm}>{busy ? "Сохраняем…" : operation === "approve" ? "Подтверждаю утверждение" : operation === "revoke" ? "Подтверждаю отзыв" : "Подтверждаю удаление содержимого"}</button><button className="btn secondary" disabled={busy} onClick={() => setOperation(null)}>Отмена</button></div>
      </section>}
      <details className="panel"><summary>История · последние 30 событий</summary><ol>{selected.history.map(e => <li key={e.id}><b>{eventNames[e.type] || "Изменение сохранено"}</b> · {goalDate(e.at, config.timezone, true)} · {e.actor}{e.fields.length > 0 && <p>Изменены: {e.fields.map(k => fieldNames[k] || "параметр").join(", ")}.</p>}</li>)}</ol><small className="muted">История содержит события и авторов. Копии удалённых текстов в ней не сохраняются.</small></details>
    </section>}
    {!loading && !form && !selected && data && config && <><div className="decision-filters"><label>Показать<select value={filter} disabled={busy} onChange={e => { setFilter(e.target.value); setPages([undefined]); }}><option value="all">Все записи</option><option value="draft">Черновики и гипотезы</option><option value="approved">Утверждённые</option><option value="revoked">Отозванные</option><option value="superseded">Заменённые</option><option value="deleted">Удалённые</option></select></label><label>Поиск по теме или названию<input maxLength={80} value={search} disabled={busy} onChange={e => setSearch(e.target.value)} /></label></div>
      <div className="decision-grid">{data.items.map(item => <BusinessDecisionCard key={item.id} item={item} timezone={config.timezone} busy={busy} onOpen={() => setParams({ view: "memory", decision: item.id })} />)}</div>
      {!data.items.length && <div className="panel empty"><h3>Здесь будут решения и их основания</h3><p>Например: за какое время отвечаем новому клиенту и почему выбрали этот срок. Для начала сохраните черновик, затем проверьте и утвердите его.</p></div>}
      <nav className="actions" aria-label="Страницы решений"><button className="btn secondary" disabled={busy || pages.length === 1} onClick={() => setPages(p => p.slice(0, -1))}>Назад</button><span>Страница {pages.length}</span><button className="btn secondary" disabled={busy || !data.nextCursor} onClick={() => setPages(p => [...p, data.nextCursor || undefined])}>Далее</button></nav>
    </>}
  </section>;
}
