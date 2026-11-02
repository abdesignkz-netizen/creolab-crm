import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { ActionInput, ActionPlanInput, ActionRunView, BusinessMemoryContext, DecisionRef } from "@creolab/contracts";
import { createBusinessMemoryApi } from "@creolab/api-client/business-memory";
import { api } from "../lib/api";
import { actionApi, type ActionChoice, type ActionOptions } from "../lib/aiActions";
import { parseDateTimeLocalInput } from "../lib/period";
import { InlineFeedback } from "./InlineFeedback";
import "./action-plans.css";

const statusText = { draft: "Проверьте план", queued: "В очереди", running: "Выполняется", succeeded: "Выполнено", failed: "Остановлено", cancelled: "Отменено", expired: "Срок истёк" };
const stepStatus = { pending: "Ожидает", succeeded: "Выполнено", failed: "Не выполнено", skipped: "Пропущено" };
const memoryApi = createBusinessMemoryApi(api.request);
function Choice({ kind, value, onChange }: { kind: "task" | "contact"; value: ActionChoice | null; onChange: (v: ActionChoice | null) => void }) {
  const [q, setQ] = useState(""), [items, setItems] = useState<ActionChoice[]>([]), [error, setError] = useState(""), [loading, setLoading] = useState(false);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      setLoading(true);
      actionApi.choices(kind, q).then(data => { if (active) { setItems(data.items); setError(""); } }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [kind, q]);
  if (value) return <div className="action-choice"><span>{value.label}</span><button type="button" className="btn secondary" onClick={() => onChange(null)}>Изменить</button></div>;
  return <div className="action-picker"><label>{kind === "task" ? "Найдите задачу" : "Клиент — необязательно"}<input value={q} onChange={e => setQ(e.target.value)} placeholder={kind === "task" ? "Название задачи" : "Имя или телефон"} /></label>
    {error && <InlineFeedback kind="error">{error}</InlineFeedback>}
    <div className="action-picker-results" aria-label="Результаты поиска">{loading ? <p role="status">Ищем…</p> : items.map(item => <button type="button" key={item.id} onClick={() => onChange(item)}>{item.label}</button>)}{!loading && !items.length && !error && <p>Совпадений нет</p>}</div>
    {items.length === 30 && <p className="muted">Первые 30 совпадений. Уточните поиск.</p>}
  </div>;
}

export default function ActionPlansPanel() {
  const [params] = useSearchParams();
  const requestedRun = params.get("run");
  const requestedDecision = params.get("decision"), decisionVersion = Number(params.get("decisionVersion"));
  const [memory, setMemory] = useState<BusinessMemoryContext | null>(null), [decisions, setDecisions] = useState<DecisionRef[]>([]), [memoryError, setMemoryError] = useState("");
  const [basisPending, setBasisPending] = useState(Boolean(requestedDecision)), [basisError, setBasisError] = useState("");
  const [options, setOptions] = useState<ActionOptions | null>(null), [history, setHistory] = useState<Awaited<ReturnType<typeof actionApi.list>> | null>(null);
  const [offset, setOffset] = useState(0), [selected, setSelected] = useState<ActionRunView | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<"new" | "existing">("new"), [title, setTitle] = useState(""), [description, setDescription] = useState("");
  const [task, setTask] = useState<ActionChoice | null>(null), [contact, setContact] = useState<ActionChoice | null>(null);
  const [type, setType] = useState<"note" | "message" | "meeting" | "proposal">("message"), [ownerId, setOwnerId] = useState(""), [due, setDue] = useState("");
  const [draft, setDraft] = useState(""), [notify, setNotify] = useState(false), [recipientId, setRecipientId] = useState(""), [notice, setNotice] = useState("");
  const requests = useRef(new Map<string, string>()), previewRequest = useRef<{ body: string; id: string } | null>(null), mounted = useRef(true), busyRef = useRef(false);
  const selectionVersion = useRef(0);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const chosenId = useRef<string | null>(null); chosenId.current = selected?.id || null;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    setBasisPending(Boolean(requestedDecision)); setBasisError(""); setDecisions([]);
    const requested = requestedDecision
      ? /^[a-f0-9-]{36}$/i.test(requestedDecision) && Number.isSafeInteger(decisionVersion) && decisionVersion > 0
        ? memoryApi.get(requestedDecision) : Promise.reject(new Error("Ссылка на решение некорректна."))
      : Promise.resolve(null);
    Promise.allSettled([memoryApi.context(), requested]).then(([context, detail]) => {
      if (!active) return;
      let result: BusinessMemoryContext | null = context.status === "fulfilled" ? context.value : null;
      setMemoryError(context.status === "rejected" && Number(context.reason?.status) !== 403 ? context.reason?.message || "Не удалось загрузить решения" : "");
      if (detail.status === "rejected") setBasisError(detail.reason?.message || "Не удалось проверить выбранное решение.");
      else if (detail.value) {
        const d = detail.value;
        if (d.effective !== "active" || d.version !== decisionVersion || !d.content) setBasisError("Решение больше не актуально. Проверьте основание перед подготовкой плана.");
        else {
          const entry = { id: d.id, version: d.version, title: d.content.title, body: d.content.body, kind: d.kind as "decision" | "preference", validUntil: d.content.validUntil, href: `/control?view=memory&decision=${d.id}` };
          result = { ...(result || { asOf: new Date().toISOString(), boundary: "", limited: false }), entries: [entry, ...(result?.entries || []).filter(e => e.id !== d.id)] };
          setDecisions([{ id: d.id, version: d.version }]);
        }
      }
      setMemory(result); setBasisPending(false);
    });
    return () => { active = false; };
  }, [requestedDecision, decisionVersion]);
  useEffect(() => { if (options && !options.allowed.includes("task.create")) setMode("existing"); }, [options]);
  useEffect(() => {
    if (!selected) return;
    reviewHeading.current?.focus({ preventScroll: true });
    reviewHeading.current?.scrollIntoView({ block: "start", behavior: "instant" });
  }, [selected?.id]);
  async function refresh() {
    const [config, rows] = await Promise.all([actionApi.options(), actionApi.list(offset)]);
    if (!mounted.current) return;
    setOptions(config); setHistory(rows);
  }
  useEffect(() => {
    let active = true; setLoading(true);
    Promise.all([actionApi.options(), actionApi.list(offset)]).then(([config, rows]) => {
      if (active) { setOptions(config); setHistory(rows); setError(""); }
    }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [offset]);
  useEffect(() => {
    if (!selected || !["queued", "running"].includes(selected.status)) return;
    let active = true, fetching = false;
    const timer = setInterval(async () => {
      if (fetching || busyRef.current) return;
      fetching = true;
      const version = selectionVersion.current;
      try {
        const next = await actionApi.get(selected.id);
        if (active && version === selectionVersion.current && chosenId.current === next.id) { setSelected(next); if (!["queued", "running"].includes(next.status)) await refresh(); }
      } catch (e) { if (active && version === selectionVersion.current) setError(e instanceof Error ? e.message : "Не удалось обновить результат"); }
      finally { fetching = false; }
    }, 2500);
    return () => { active = false; clearInterval(timer); };
  }, [selected?.id, selected?.status]);
  function requestId(key: string) { if (!requests.current.has(key)) requests.current.set(key, crypto.randomUUID()); return requests.current.get(key)!; }
  async function perform(work: () => Promise<ActionRunView>) {
    if (busyRef.current) return;
    selectionVersion.current++;
    busyRef.current = true; setBusy(true); setError("");
    try { const run = await work(); if (mounted.current) { setSelected(run); await refresh(); } }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "Не удалось выполнить действие"); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  useEffect(() => { if (requestedRun && /^[a-f0-9-]{36}$/i.test(requestedRun)) void perform(() => actionApi.get(requestedRun)); }, [requestedRun]);
  async function preview(e: FormEvent) {
    e.preventDefault();
    if (!options || basisPending || basisError) return;
    let dueAt: string | undefined;
    if (mode === "new" && due) {
      const parsed = parseDateTimeLocalInput(due, options.timezone);
      if (Number.isNaN(parsed.getTime())) { setError("Укажите корректные дату и время срока"); return; }
      dueAt = parsed.toISOString();
    }
    const steps: ActionInput[] = [], target = mode === "new" ? { fromStep: "create" } : { taskId: task?.id || "" };
    if (mode === "existing" && !task) { setError("Выберите задачу"); return; }
    if (mode === "new") steps.push({ key: "create", kind: "task.create", title: title.trim(), type,
      ...(description.trim() ? { description: description.trim() } : {}), ...(contact ? { contactId: contact.id } : {}),
      ownerMembershipId: ownerId || options.selfId, ...(dueAt ? { dueAt } : {}) });
    else if (ownerId) steps.push({ key: "assign", kind: "task.assign", target, membershipId: ownerId });
    if (draft.trim()) steps.push({ key: "draft", kind: "task.draft", target, text: draft.trim() });
    if (notify) steps.push({ key: "notify", kind: "staff.notify", target, membershipId: recipientId || ownerId || options.selfId, text: notice.trim() });
    if (!steps.length) { setError("Выберите действие: назначить сотрудника, сохранить черновик или уведомить"); return; }
    const body = { title: mode === "new" ? title.trim().slice(0, 160) : task!.label.slice(0, 160), steps, ...(decisions.length ? { decisions } : {}) };
    const fingerprint = JSON.stringify(body);
    if (previewRequest.current?.body !== fingerprint) previewRequest.current = { body: fingerprint, id: crypto.randomUUID() };
    await perform(() => actionApi.preview({ ...body, requestId: previewRequest.current!.id } as ActionPlanInput));
  }
  function newPlan(existing?: ActionChoice) {
    selectionVersion.current++;
    setSelected(null); setError(""); setMode(existing || options && !options.allowed.includes("task.create") ? "existing" : "new"); setTask(existing || null); setTitle(""); setDescription("");
    setContact(null); setOwnerId(""); setDue(""); setDraft(""); setNotify(false); setRecipientId(""); setNotice(""); setDecisions([]); setBasisError(""); previewRequest.current = null;
  }
  const firstTask = selected?.steps.find(s => s.taskId)?.taskId;
  return <div className="action-plans">
    <div className="page-head"><div><h2>Планы действий</h2><p className="muted">Соберите действия для задачи, проверьте их и запустите одним подтверждением.</p></div><button type="button" className="btn secondary" disabled={busy || basisPending} onClick={() => newPlan()}>Новый план</button></div>
    {error && <InlineFeedback kind="error">{error}</InlineFeedback>}
    {loading && <p role="status">Загружаем…</p>}
    {options?.blockedReason && <InlineFeedback kind="error" message={options.blockedReason}>{options.blockedReason} <Link to="/settings?section=control">Настройки Control</Link></InlineFeedback>}
    {!options && !loading && <button type="button" className="btn secondary" onClick={() => { setError(""); void refresh().catch(e => setError(e.message)); }}>Повторить загрузку</button>}
    <div className="action-plans-grid">
      {selected ? <section className="panel action-plan-review" aria-label="План действий">
        <div className="action-plan-heading"><h3 ref={reviewHeading} tabIndex={-1}>{selected.title}</h3><span className={`badge ${selected.status === "succeeded" ? "ok" : ""}`}>{statusText[selected.status]}</span></div>
        <p role="status">Выполнено: {selected.completed} из {selected.steps.length}</p>
        {Boolean(selected.decisions?.length) && <aside><b>Основания плана</b><ul>{selected.decisions!.map((d, i) => <li key={d.id}><Link to={`/control?view=memory&decision=${d.id}`}>Решение {i + 1} · версия {d.version}</Link></li>)}</ul><p className="muted">Актуальность проверяется перед каждым шагом. Отзыв или изменение основания остановит оставшиеся действия.</p></aside>}
        {selected.error && <InlineFeedback kind="error">{selected.error}</InlineFeedback>}
        <ol className="action-plan-steps">{selected.steps.map(step => <li key={step.key} data-state={step.status}>
          <div className="action-plan-heading"><strong>{step.label}</strong><span>{stepStatus[step.status]}</span></div>
          <p className="action-plan-detail">{step.detail}</p>
          {step.result && <p>{step.result}</p>}{step.error && <InlineFeedback kind="error">{step.error}</InlineFeedback>}
          {step.taskId && <Link to={`/tasks?open=${encodeURIComponent(step.taskId)}`}>Открыть задачу</Link>}
        </li>)}</ol>
        {selected.canConfirm && <><p className="muted">Будут выполнены только перечисленные действия. Подтверждение доступно до {new Date(selected.expiresAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: options?.timezone || "Asia/Almaty" })}. Черновик останется в задаче, уведомление — внутри BasQar.</p><button type="button" className="btn" disabled={busy || Boolean(options?.blockedReason)} onClick={() => void perform(() => actionApi.confirm(selected, requestId(`confirm:${selected.id}`)))}>{busy ? "Проверяем…" : "Подтвердить и выполнить"}</button></>}
        {selected.canCancel && <button type="button" className="btn secondary" disabled={busy} onClick={() => void perform(() => actionApi.cancel(selected, requestId(`cancel:${selected.id}`)))}>{selected.source === "architect" ? "Отменить применение проекта" : selected.status === "draft" ? "Отменить план" : "Остановить оставшиеся шаги"}</button>}
        {selected.source === "autopilot" ? <p className="muted">Выполнен внутренний этап контроля ответа. Итог переписки проверяется отдельно. <Link to="/settings/ai-automation?section=autopilot">Открыть сценарии и остановку правила</Link></p> : selected.source === "architect" ? <p className="muted">Настройки проекта сохраняются вместе. <Link to="/start?view=project">Открыть проект и оставшиеся шаги</Link></p> : selected.status !== "draft" && <p className="muted">При остановке уже выполненные действия сохраняются.</p>}
        {!selected.canCancel && firstTask && selected.status !== "succeeded" && <button type="button" className="btn secondary" onClick={() => newPlan({ id: firstTask, label: selected.title })}>Подготовить оставшиеся действия для этой задачи</button>}
        <button type="button" className="btn secondary" disabled={busy} onClick={() => void perform(() => actionApi.get(selected.id))}>Обновить результат</button>
      </section> : <form className="panel action-plan-form" onSubmit={e => void preview(e)}>
        {basisPending && <p role="status">Проверяем выбранное основание…</p>}
        {basisError && <InlineFeedback kind="error">{basisError} <Link to="/control?view=memory">Проверить решения компании</Link> <button type="button" className="btn secondary" onClick={() => { setBasisError(""); setDecisions([]); }}>Убрать основание из нового плана</button></InlineFeedback>}
        <h3>Что нужно сделать?</h3><fieldset disabled={busy || !options || Boolean(options.blockedReason)}>
          <label>Задача<select value={mode} onChange={e => { setMode(e.target.value as typeof mode); setOwnerId(""); }}><option value="new" disabled={!options?.allowed.includes("task.create")}>Создать новую</option><option value="existing">Работать с существующей</option></select></label>
          {mode === "new" ? <><label>Что должен сделать сотрудник?<input required maxLength={240} value={title} onChange={e => setTitle(e.target.value)} placeholder="Например, подготовить предложение клиенту" /></label>
            <label>Тип задачи<select value={type} onChange={e => setType(e.target.value as typeof type)}><option value="message">Написать клиенту</option><option value="proposal">Подготовить предложение</option><option value="meeting">Провести встречу</option><option value="note">Внутренняя задача</option></select></label>
            <Choice kind="contact" value={contact} onChange={setContact} />
            <label>Подробности<textarea maxLength={4000} value={description} onChange={e => setDescription(e.target.value)} placeholder="Ожидаемый результат, важные условия" /></label>
            <label>Срок — необязательно ({options?.timezone || "Asia/Almaty"})<input type="datetime-local" value={due} onChange={e => setDue(e.target.value)} /></label>
          </> : <Choice kind="task" value={task} onChange={setTask} />}
          <label>Ответственный<select value={ownerId} onChange={e => setOwnerId(e.target.value)} disabled={mode === "existing" && !options?.allowed.includes("task.assign")}><option value="">{mode === "new" ? "Я" : "Не менять"}</option>{options?.members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
          <details><summary>Учитывать утверждённые решения — необязательно</summary>
            {memoryError && <p>{memoryError} <Link to="/control?view=memory">Проверить решения компании</Link></p>}
            {memory?.entries.map(d => <label className="action-plan-check" key={d.id}><input type="checkbox" checked={decisions.some(v => v.id === d.id)} disabled={decisions.length >= 3 && !decisions.some(v => v.id === d.id)} onChange={e => setDecisions(old => e.target.checked ? [...old, { id: d.id, version: d.version }] : old.filter(v => v.id !== d.id))} /><span>{d.title}<small className="muted" style={{ display: "block" }}>{d.body}</small><Link to={d.href}>Проверить основание · версия {d.version}</Link></span></label>)}
            {memory && !memory.entries.length && <p>Нет актуальных утверждённых решений в этой подборке.</p>}
            {memory?.limited && <p>Показана ограниченная подборка. Нужное решение можно открыть в памяти компании и перейти к плану оттуда.</p>}
            <p className="muted">До трёх оснований. Текст решения не даёт дополнительных прав и не запускает действия.</p>
          </details>
          {options?.allowed.includes("task.draft") && <label>Черновик ответа — необязательно<textarea maxLength={6000} value={draft} onChange={e => setDraft(e.target.value)} placeholder="Текст для проверки сотрудником перед отправкой" /></label>}
          {options?.allowed.includes("staff.notify") && <><label className="action-plan-check"><input type="checkbox" checked={notify} onChange={e => setNotify(e.target.checked)} />Уведомить сотрудника в BasQar</label>
            {notify && <><label>Получатель<select value={recipientId} onChange={e => setRecipientId(e.target.value)}><option value="">{ownerId ? "Выбранный ответственный" : "Я"}</option>{options?.members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label><label>Сообщение сотруднику<textarea required maxLength={1000} value={notice} onChange={e => setNotice(e.target.value)} placeholder="Что нужно проверить или сделать" /></label></>}
          </>}
          <button className="btn" type="submit" disabled={basisPending || Boolean(basisError)}>{busy ? "Готовим план…" : "Посмотреть план"}</button><p className="muted">На следующем шаге вы увидите все изменения перед подтверждением.</p>
        </fieldset>
      </form>}
      <aside className="panel action-plan-history"><div className="action-plan-heading"><h3>Мои планы</h3><span>{history?.total || 0}</span></div>
        {!history?.items.length && !loading && <p className="muted">Здесь появятся подготовленные планы и результаты их выполнения.</p>}
        {history?.items.map(run => <button type="button" className="action-history-item" aria-pressed={run.id === selected?.id} disabled={busy} key={run.id} onClick={() => void perform(() => actionApi.get(run.id))}>
          <strong>{run.title}</strong><span>{statusText[run.status]} · {run.completed}/{run.stepCount}</span><small>{new Date(run.createdAt).toLocaleString("ru-RU", { timeZone: options?.timezone || "Asia/Almaty" })}</small>
        </button>)}
        {history && (offset > 0 || offset + history.limit < history.total) && <nav className="actions" aria-label="Страницы планов"><button type="button" className="btn secondary" disabled={!offset || busy} onClick={() => setOffset(Math.max(0, offset - history.limit))}>Назад</button><button type="button" className="btn secondary" disabled={busy || offset + history.limit >= history.total} onClick={() => setOffset(offset + history.limit)}>Далее</button></nav>}
      </aside>
    </div>
  </div>;
}
