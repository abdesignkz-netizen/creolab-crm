import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { InlineFeedback } from "./InlineFeedback";
import "./sales-process.css";

export function SalesControlPanel({ canManageSettings = true }: { canManageSettings?: boolean }) {
  const [params] = useSearchParams();
  const [data, setData] = useState<any>(null), [error, setError] = useState(''), [busy, setBusy] = useState('');
  const [filter, setFilter] = useState(() => ['attention', 'ready', 'goal'].includes(params.get('filter') || '') ? params.get('filter')! : 'all'), [selected, setSelected] = useState<Record<string, string>>({});
  const [confirmation, setConfirmation] = useState<{ proposal: any; decision: 'create' | 'link' | 'dismiss' } | null>(null);
  const [confirmedLatest, setConfirmedLatest] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null), busyRef = useRef(busy);
  busyRef.current = busy;
  useEffect(() => { setConfirmedLatest(false); }, [confirmation]);
  const [notice, setNotice] = useState('');
  async function load() { try { setData(await api.salesControl()); setError(''); } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось загрузить продажи'); } }
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!confirmation) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const controls = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]') || []);
    (controls()[0] || dialog)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busyRef.current) { e.preventDefault(); setConfirmation(null); }
      if (e.key !== "Tab") return;
      const items = controls(), first = items[0], last = items.at(-1);
      if (!first) { e.preventDefault(); dialog?.focus(); }
      else if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); if (previous?.isConnected) previous.focus(); };
  }, [confirmation]);
  async function review() {
    if (!confirmation || busy) return;
    const { proposal, decision } = confirmation;
    setBusy(proposal.id); setError(''); setNotice('');
    try { await api.reviewSalesProposal(proposal.id, { decision, revision: proposal.revision, confirmedLatest, ...(decision === 'link' ? { dealId: selected[proposal.id] } : {}) }); setConfirmation(null); setNotice(decision === 'dismiss' ? 'Предложение отклонено' : 'Сделка сохранена'); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось сохранить'); }
    finally { setBusy(''); }
  }
  return <div className="sales-control">
    <div className="page-head"><div><h3>Продажи под контролем</h3><p className="muted">Кто готов к следующему шагу, что мешает и где нужен сотрудник.</p></div><div className="actions"><button className="btn secondary" onClick={() => void load()}>Обновить</button>{canManageSettings && <Link className="btn secondary" to="/settings/ai-automation?section=sales">Настроить сопровождение</Link>}</div></div>
    {error && <InlineFeedback kind="error">{error}</InlineFeedback>}{notice && <p role="status">{notice}</p>}
    {!data && !error && <p role="status">Загружаем сделки…</p>}
    {data && <>
      <p>Цель: <b>{data.goalLabel}</b>. {data.settings.mode === 'off' ? 'Автоматическое сопровождение выключено.' : !data.automationReady ? 'Анализ переписки выключен. Проверьте настройки.' : data.settings.mode === 'suggest' ? 'ИИ предлагает новые сделки для проверки.' : 'ИИ создаёт однозначные сделки автоматически.'}</p>
      <div className="sales-metrics">{[['all', 'Активные', data.summary.active], ['attention', 'Нужно участие', data.summary.needsAttention], ['ready', 'Близки к покупке', data.summary.closeToSale], ['goal', 'Цель достигнута', data.summary.goalReached]].map(([id, label, count]) => <button key={id} aria-pressed={filter === id} onClick={() => setFilter(String(id))}><b>{count}</b><span>{label}</span></button>)}</div>
      {data.limited && <p className="warn">Показаны первые 200 сделок. Счётчики внимания и достижения цели относятся к этому списку. Все сделки доступны в разделе «Сделки».</p>}
      {data.proposalsLimited && <p className="muted">Показаны 200 последних предложений. После рассмотрения появятся следующие.</p>}
      {data.proposals.length > 0 && <section aria-label="Предложения ИИ"><h3>Проверьте предложения ИИ · {data.proposals.length}</h3>{data.proposals.map((p: any) => <article className="panel" key={p.id}><b>{p.contactName}{p.phone ? ` · ${p.phone}` : ''}</b><h4>{p.title}</h4><p>{p.reason}</p><p>Следующий шаг: {p.nextAction}</p><Link to={`/conversations/${p.conversationId}`}>Открыть переписку</Link>
        {p.alternatives.length > 0 && <label>Продолжить существующую сделку<select value={selected[p.id] || ''} onChange={e => setSelected({ ...selected, [p.id]: e.target.value })}><option value="">Выберите сделку</option>{p.alternatives.map((d: any) => <option value={d.id} key={d.id}>{d.title}</option>)}</select></label>}
        <div className="actions">{p.alternatives.length > 0 && <button className="btn" disabled={data.settings.mode === "off" || !selected[p.id] || !!busy} onClick={() => setConfirmation({ proposal: p, decision: 'link' })}>Связать с выбранной</button>}<button className={p.alternatives.length ? 'btn secondary' : 'btn'} disabled={data.settings.mode === "off" || !!busy} onClick={() => setConfirmation({ proposal: p, decision: 'create' })}>{p.alternatives.length ? 'Это отдельный заказ' : 'Создать сделку'}</button><button className="btn secondary" disabled={!!busy} onClick={() => setConfirmation({ proposal: p, decision: 'dismiss' })}>Не создавать</button></div>
      </article>)}</section>}
      <div className="sales-deals">{data.items.filter((d: any) => filter === 'all' || filter === 'attention' && d.blockers.length || filter === 'ready' && d.closeToSale || filter === 'goal' && d.goalReached).map((d: any) => <article className="panel" key={d.id}>
        <div className="sales-deal-head"><div><Link to={`/deals/${d.id}`}><h3>{d.title}</h3></Link><p>{d.contactName}{d.phone ? ` · ${d.phone}` : ''}</p></div><span className="badge">{d.stage}</span></div>
        <p><b>Следующий шаг:</b> {d.nextAction || 'Нужно запланировать'}{d.nextActionAt ? ` · ${new Date(d.nextActionAt).toLocaleString('ru-RU', { timeZone: data?.timezone || 'Asia/Almaty' })}` : ''}</p><p className="muted">Ответственный: {d.ownerName || 'Не назначен'}</p>
        {d.blockers.length > 0 && <ul className="sales-blockers">{d.blockers.map((b: string) => <li key={b}>{b}</li>)}</ul>}{d.goalReached && <p className="success">Цель сопровождения достигнута</p>}
        <div className="actions"><Link className="btn secondary" to={`/deals/${d.id}`}>Открыть сделку</Link><Link className="btn secondary" to={`/tasks?dealId=${d.id}`}>Запланировать шаг</Link>{d.conversationId && <Link className="btn secondary" to={`/conversations/${d.conversationId}`}>Диалог</Link>}</div>
        {d.history.length > 0 && <details><summary>Что сделала система</summary>{d.history.map((h: any, i: number) => <p key={i}><b>{h.title}</b> · {new Date(h.createdAt).toLocaleString('ru-RU', { timeZone: data?.timezone || 'Asia/Almaty' })}<br />{h.reason || h.description}</p>)}</details>}
      </article>)}</div>
      {!!data.items.length && !data.items.some((d: any) => filter === "all" || filter === "attention" && d.blockers.length || filter === "ready" && d.closeToSale || filter === "goal" && d.goalReached) && <p role="status">По этому фильтру сделок нет.</p>}
      {!data.items.length && <div className="panel"><h3>Активных сделок пока нет</h3><p>После подтверждённого интереса клиента здесь появится предложение создать сделку. Также можно создать её из заявки.</p><Link to="/requests">Открыть заявки</Link></div>}
    </>}
    {confirmation && <div className="stats-modal-backdrop"><div ref={dialogRef} tabIndex={-1} className="stats-modal" role="dialog" aria-modal="true" aria-labelledby="sales-review-title"><h3 id="sales-review-title">{confirmation.decision === 'create' ? 'Создать сделку?' : confirmation.decision === 'link' ? 'Связать переписку со сделкой?' : 'Отклонить предложение?'}</h3><p>{confirmation.proposal.contactName} · {confirmation.proposal.title}</p><p>{confirmation.decision === 'create' ? `Следующий шаг: ${confirmation.proposal.nextAction}. Задача создастся по настройкам сопровождения.` : confirmation.decision === 'link' ? `Заявка и переписка будут связаны со сделкой «${confirmation.proposal.alternatives.find((d: any) => d.id === selected[confirmation.proposal.id])?.title || ''}».` : 'По этому предложению новая сделка не будет создана автоматически.'}</p><div>{confirmation.proposal.changed && confirmation.decision !== "dismiss" && <div className="warn"><p>После предложения клиент написал новое сообщение:</p><blockquote>{confirmation.proposal.latestMessage || "Откройте переписку для просмотра вложения"}</blockquote><label><input type="checkbox" checked={confirmedLatest} onChange={e => setConfirmedLatest(e.target.checked)} />Я проверил переписку: предложение актуально</label></div>}</div><div className="actions"><button className="btn" disabled={!!busy || confirmation.decision !== "dismiss" && confirmation.proposal.changed && !confirmedLatest} onClick={() => void review()}>{busy ? 'Сохраняем…' : 'Подтвердить'}</button><button className="btn secondary" disabled={!!busy} onClick={() => setConfirmation(null)}>Назад</button></div>{error && <p role="alert">{error}</p>}</div></div>}
  </div>;
}
