import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import type { BusinessInsightView, ActionRunView } from "@creolab/contracts";
import { actionApi, type ActionOptions } from "../lib/aiActions";
import { parseDateTimeLocalInput } from "../lib/period";
import { InlineFeedback } from "./InlineFeedback";

export function OpportunityRunReview({ run, busy, onConfirm, onCancel, onRefresh }: { run: ActionRunView; busy: boolean;
  onConfirm: () => void; onCancel: () => void; onRefresh: () => void }) {
  const statuses = { draft: "Проверьте задачу", queued: "Задача создаётся", running: "Задача создаётся", succeeded: "Задача создана", failed: "Действие остановлено", expired: "Срок подтверждения истёк", cancelled: "План отменён" };
  return <div aria-label="Подтверждение задачи"><h3>{statuses[run.status]}</h3>
    {run.error && <InlineFeedback kind="error">{run.error}</InlineFeedback>}
    {run.steps.map(step => <div key={step.key}><p className="opportunity-review-text">{step.detail}</p>{step.result && <p role="status">{step.result}</p>}
      {step.taskId && <Link className="btn" to={`/tasks?open=${encodeURIComponent(step.taskId)}`}>Открыть задачу</Link>}</div>)}
    {run.canConfirm && <><p>Будет создана одна внутренняя задача сотруднику. Сообщение клиенту не отправляется. Продажа и оплата не отмечаются.</p>
      <button className="btn" type="button" disabled={busy} onClick={onConfirm}>Подтвердить создание задачи</button></>}
    <div className="actions">{run.canCancel && <button className="btn secondary" type="button" disabled={busy} onClick={onCancel}>Отменить план</button>}
      {!run.canConfirm && <button className="btn secondary" type="button" disabled={busy} onClick={onRefresh}>Обновить результат</button>}
      <Link to={`/control?view=plans&run=${encodeURIComponent(run.id)}`}>История выполнения</Link></div>
  </div>;
}

export default function OpportunityTaskReview({ item, onClose }: { item: BusinessInsightView; onClose: () => void }) {
  const [options, setOptions] = useState<ActionOptions | null>(null), [error, setError] = useState("");
  const [ownerId, setOwnerId] = useState(""), [due, setDue] = useState("");
  const [run, setRun] = useState<ActionRunView | null>(null), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const alive = useRef(true), busyRef = useRef(false), generation = useRef(0), request = useRef<{ body: string; id: string } | null>(null);
  const requests = useRef(new Map<string, string>()), panel = useRef<HTMLElement>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  useEffect(() => { panel.current?.focus({ preventScroll: true }); panel.current?.scrollIntoView({ block: "nearest" }); }, []);
  async function load() {
    const version = ++generation.current; setLoading(true); setError("");
    try { const result = await actionApi.options(); if (alive.current && version === generation.current) { setOptions(result); setOwnerId(result.selfId); } }
    catch (e) { if (alive.current && version === generation.current) setError(e instanceof Error ? e.message : "Не удалось загрузить сотрудников"); }
    finally { if (alive.current && version === generation.current) setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  async function perform(work: () => Promise<ActionRunView>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(""); const version = ++generation.current;
    try { const result = await work(); if (alive.current && version === generation.current) setRun(result); }
    catch (e) { if (alive.current && version === generation.current) {
      if ([401, 403].includes(Number((e as { status?: number })?.status))) { setOptions(null); setRun(null); }
      setError(e instanceof Error ? e.message : "Не удалось выполнить действие");
    } }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  useEffect(() => {
    if (!run || !["queued", "running"].includes(run.status)) return;
    let active = true, fetching = false;
    const timer = setInterval(async () => {
      if (busyRef.current || fetching) return; fetching = true; const version = generation.current;
      try { const result = await actionApi.get(run.id); if (active && alive.current && version === generation.current) { setRun(result); setError(""); } }
      catch (e) { if (active && alive.current && version === generation.current) {
        if ([401, 403].includes(Number((e as { status?: number })?.status))) { setRun(null); setOptions(null); }
        setError(e instanceof Error ? e.message : "Не удалось обновить результат");
      } }
      finally { fetching = false; }
    }, 2500);
    return () => { active = false; clearInterval(timer); };
  }, [run?.id, run?.status]);
  function requestId(kind: string) { const key = `${run?.id}:${kind}`; if (!requests.current.has(key)) requests.current.set(key, crypto.randomUUID()); return requests.current.get(key)!; }
  async function preview(e: FormEvent) {
    e.preventDefault(); if (!options) return;
    const date = parseDateTimeLocalInput(due, options.timezone);
    if (!Number.isFinite(date.getTime()) || date <= new Date()) { setError("Укажите будущие дату и время выполнения задачи."); return; }
    const body = { title: item.content!.opportunity!.taskTitle.slice(0, 160), steps: [{ kind: "opportunity.task" as const, key: "create",
      insightId: item.id, version: item.version, fingerprint: item.fingerprint, ownerMembershipId: ownerId, dueAt: date.toISOString() }] };
    const serialized = JSON.stringify(body);
    if (request.current?.body !== serialized) request.current = { body: serialized, id: crypto.randomUUID() };
    await perform(() => actionApi.preview({ ...body, requestId: request.current!.id }));
  }
  const blocked = options?.blockedReason || (options && !options.allowed.includes("opportunity.task") ? "В Control не разрешено создание задач." : null);
  return <section className="panel opportunity-review" ref={panel} tabIndex={-1} aria-label="Задача по возможности">
    <div className="insight-top"><h3>Следующее действие</h3><button className="btn secondary" type="button" disabled={busy} onClick={onClose}>Закрыть</button></div>
    {error && <InlineFeedback kind="error">{error}</InlineFeedback>}
    {loading ? <p role="status">Загружаем сотрудников…</p> : run ? <OpportunityRunReview run={run} busy={busy}
      onConfirm={() => void perform(() => actionApi.confirm(run, requestId("confirm")))}
      onCancel={() => void perform(() => actionApi.cancel(run, requestId("cancel")))} onRefresh={() => void perform(() => actionApi.get(run.id))} />
      : !options ? <button className="btn secondary" type="button" onClick={() => void load()}>Повторить загрузку</button>
      : <form onSubmit={e => void preview(e)}><p><strong>{item.content?.opportunity?.taskTitle}</strong></p>
        {blocked && <InlineFeedback kind="error">{blocked} <Link to="/settings?section=control">Настройки Control</Link></InlineFeedback>}
        <fieldset disabled={busy || Boolean(blocked)}><label>Кто выполнит задачу?<select value={ownerId} onChange={e => setOwnerId(e.target.value)} required>{options.members.map(m => <option key={m.id} value={m.id}>{m.name}{m.id === options.selfId ? " (я)" : ""}</option>)}</select></label>
          <label>Когда нужно выполнить? · {options.timezone}<input type="datetime-local" value={due} onChange={e => setDue(e.target.value)} required /></label>
          <button className="btn" type="submit">{busy ? "Проверяем…" : "Посмотреть задачу"}</button></fieldset>
        <p className="muted">Перед созданием вы увидите исполнителя, срок и ожидаемый результат.</p>
      </form>}
  </section>;
}
