import { useEffect, useRef, useState } from "react";
import { BUSINESS_INSIGHT_RULES, OPPORTUNITY_RULES, INSIGHT_RULE_LABELS, type BusinessInsightList, type BusinessInsightDetail, type BusinessInsightState, type BusinessInsightRule, type BusinessInsightView } from "@creolab/contracts";
import { useSearchParams } from "react-router-dom";
import OpportunityTaskReview from "./OpportunityTaskReview";
import { api } from "../lib/api";
import { createBusinessInsightsApi } from "@creolab/api-client/business-insights";
import { BusinessInsightCard, INSIGHT_STATE_LABELS, insightDate } from "./BusinessInsightCard";
import { InlineFeedback } from "./InlineFeedback";
import "./business-insights.css";

const insightApi = createBusinessInsightsApi(api.request);
const historyLabels: Record<string, string> = { detected: "Вывод появился", reopened: "Условие возникло снова", resolved: "Условие больше не выполняется", facts_changed: "Основание изменилось — нужна новая оценка", source_unavailable: "Источник недоступен для проверки", acknowledged: "Сотрудник принял к сведению", dismissed: "Сотрудник скрыл вывод до изменения данных" };
historyLabels.action_task_created = "Создана задача по возможности";
const sourceLabels = { task: "Задачи", inquiry: "Заявки", deal: "Сделки" };
const forecastLabels: Record<string, string> = { ready: "Рассчитан", insufficient_history: "Пока мало истории: нужны минимум 3 полных месяца и 10 продаж", incomplete_data: "Не хватает корректных сумм или дат продаж", unavailable: "Данные временно недоступны", unsupported_period: "Для этого периода прогноз не рассчитывается" };

export default function BusinessInsightsPanel() {
  const [params, setParams] = useSearchParams();
  const kind = params.get("kind") === "opportunity" ? "opportunity" : "insight";
  const [action, setAction] = useState<BusinessInsightView | null>(null);
  const [data, setData] = useState<BusinessInsightList | null>(null), [error, setError] = useState(""), [note, setNote] = useState("");
  const [state, setState] = useState<BusinessInsightState | "all">("open"), [rule, setRule] = useState<BusinessInsightRule | "">("");
  const [pages, setPages] = useState<Array<string | undefined>>([undefined]), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<BusinessInsightDetail | null>(null);
  const alive = useRef(true), generation = useRef(0), busyRef = useRef(false), requests = useRef(new Map<string, string>());
  const historyPanel = useRef<HTMLElement>(null), historyTrigger = useRef<HTMLElement | null>(null);
  const cursor = pages.at(-1);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  useEffect(() => {
    if (!history) return;
    historyPanel.current?.focus({ preventScroll: true });
    historyPanel.current?.scrollIntoView({ block: "nearest" });
  }, [history]);
  async function load() {
    const token = ++generation.current; setLoading(true); setHistory(null); setAction(null);
    try {
      const result = await insightApi.list({ kind, state, rule: rule || undefined, cursor });
      if (alive.current && token === generation.current) { setData(result); setError(""); }
      const requested = params.get("insight");
      if (requested && /^[a-f0-9-]{36}$/i.test(requested)) {
        const detail = await insightApi.get(requested);
        if (alive.current && token === generation.current) setHistory(detail);
      }
    } catch (err) {
      if (alive.current && token === generation.current) { setData(null); setError(err instanceof Error ? err.message : "Не удалось загрузить выводы"); }
    } finally { if (alive.current && token === generation.current) setLoading(false); }
  }
  useEffect(() => { void load(); }, [kind, state, rule, cursor, params.get("insight")]);
  async function run(work: () => Promise<string>, reload = true) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(""); setNote("");
    try {
      const message = await work();
      if (!alive.current) return;
      if (reload) await load();
      if (alive.current) setNote(message);
    } catch (err) { if (alive.current) {
      if ([401, 403].includes(Number((err as { status?: number })?.status))) { setData(null); setHistory(null); }
      else if ((err as { code?: string })?.code === "insight_stale") await load();
      if (alive.current) setError(err instanceof Error ? err.message : "Не удалось выполнить действие");
    } }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  function decide(item: BusinessInsightView, decision: "acknowledge" | "dismiss") {
    void run(async () => {
      const key = `${item.id}:${item.version}:${item.fingerprint}:${decision}`;
      if (!requests.current.has(key)) requests.current.set(key, crypto.randomUUID());
      await insightApi.decide(item.id, decision, { requestId: requests.current.get(key)!, version: item.version, fingerprint: item.fingerprint });
      return decision === "acknowledge" ? "Принято к сведению. Запись сохранена в истории." : "Вывод скрыт из списка требующих внимания. При изменении основания он появится снова.";
    });
  }
  function refresh(id?: string) { void run(async () => {
    const result = await insightApi.refresh(id);
    return result.advanced ? id ? "Вывод проверен по текущим данным." : "Порция данных проверена. Полный обход продолжается автоматически." : "Проверка уже выполняется или недавно завершилась. Повторите обновление позже.";
  }); }
  function showHistory(id: string) {
    historyTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void run(async () => {
      const detail = await insightApi.get(id);
      if (alive.current) setHistory(detail);
      return "";
    }, false);
  }
  const historyView = history && <section ref={historyPanel} tabIndex={-1} className="panel insight-history" aria-label="История вывода"><div className="insight-top"><h3>История вывода · случай {history.occurrence}</h3><button type="button" className="btn secondary" onClick={() => { setHistory(null); historyTrigger.current?.focus(); }}>Закрыть историю</button></div>
    {history.content ? <><h4>{history.content.title}</h4><p>{history.content.subject}</p><p>{history.content.explanation}</p>{history.content.sources.map(s => <p key={s.href}><a href={s.href}>{s.label}</a></p>)}</> : <p>Основание изменилось или недоступно. Обновите проверку вывода.</p>}
    <p className="muted">Последние 30 событий этого случая. Отметки сотрудника не меняют записи CRM.</p><ol>{history.history.map(event => <li key={event.id}><b>{historyLabels[event.type] || "Состояние обновлено"}</b><span>{insightDate(event.at, history.content?.period.timezone)} · {event.actor === "employee" ? "Сотрудник" : "Система"}</span></li>)}</ol>
  </section>;
  return <section className="business-insights" aria-label="Бизнес-выводы">
    <header className="page-head"><div><h2>Бизнес-выводы</h2><p className="muted">Что требует внимания, на каких данных основано и что можно сделать дальше.</p></div>
      <button className="btn secondary" type="button" disabled={busy || loading || Boolean(action)} onClick={() => refresh()}>Обновить проверку</button></header>
    <div className="actions" role="group" aria-label="Раздел выводов">{([['insight', 'Риски и контроль'], ['opportunity', 'Возможности для продаж']] as const).map(([value, label]) => <button key={value} className={`btn ${kind === value ? '' : 'secondary'}`} aria-pressed={kind === value} disabled={busy || Boolean(action)} onClick={() => { setRule(''); setPages([undefined]); setState('open'); setNote(''); setParams({ view: 'insights', kind: value }); }}>{label}</button>)}</div>
    {kind === "opportunity" && <p>Обращения и сделки, которым нужен следующий шаг. Причины по одной сделке объединены. Денежный потенциал не рассчитывается.</p>}
    {error && <InlineFeedback kind="error">{error} <button type="button" className="btn secondary" disabled={busy || loading} onClick={() => void load()}>Обновить список</button></InlineFeedback>}
    {note && <InlineFeedback kind="success">{note}</InlineFeedback>}
    <div className="insight-filters"><label>Состояние<select value={state} disabled={busy || Boolean(action)} onChange={e => { setState(e.target.value as typeof state); setPages([undefined]); setNote(""); }}><option value="all">Все состояния</option>{Object.entries(INSIGHT_STATE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Тип вывода<select value={rule} disabled={busy || Boolean(action)} onChange={e => { setRule(e.target.value as typeof rule); setPages([undefined]); setNote(""); }}><option value="">Все типы</option>{BUSINESS_INSIGHT_RULES.filter(value => kind === 'opportunity' ? (OPPORTUNITY_RULES as readonly string[]).includes(value) : !(OPPORTUNITY_RULES as readonly string[]).includes(value)).map(value => <option key={value} value={value}>{INSIGHT_RULE_LABELS[value]}</option>)}</select></label></div>
    {loading ? <p role="status">Проверяем актуальность данных…</p> : data && <>
      <aside className="panel soft insight-coverage"><b>Данные компании · {data.coverage.timezone} · {data.coverage.currency}</b>
        <p>Проверка идёт по частям. Список не является общим количеством проблем и не подтверждает отсутствие других рисков.</p>
        <details><summary>Что проверено</summary><p>Последняя порция: {insightDate(data.coverage.asOf, data.coverage.timezone)}</p>
          {data.coverage.sources.map(source => <p key={source.kind}>{sourceLabels[source.kind]}: полный обход — {insightDate(source.lastFullPassAt, data.coverage.timezone)}{source.inProgress ? "; следующий обход продолжается" : ""}</p>)}
          <p>Прогноз продаж: {data.coverage.forecast ? forecastLabels[data.coverage.forecast.status] || "Нужна проверка" : "Ещё не проверен"}.</p>
          {data.coverage.forecast && <p>История: {data.coverage.forecast.months} месяцев, {data.coverage.forecast.sales} продаж. Проверено {insightDate(data.coverage.forecast.checkedAt, data.coverage.timezone)}.{["not_set", "zero_target"].includes(data.coverage.forecast.targetStatus) ? " Положительный план продаж не задан." : ""}</p>}
        </details>
      </aside>
      {history && !data.items.some(item => item.id === history.id) && historyView}
      {!data.items.length ? <div className="panel empty"><h3>В этом списке пока нет выводов</h3><p>Проверьте другое состояние или обновите проверку. {kind === 'insight' ? 'Если история продаж ещё мала, прогноз появится после накопления данных.' : 'Возможности появятся при наличии подтверждённых оснований в заявках и сделках.'}</p></div> : data.items.map(item => <div key={item.id} className="insight-entry"><BusinessInsightCard item={item} busy={busy || Boolean(action)} onDecision={decision => decide(item, decision)} onRefresh={() => refresh(item.id)} onHistory={() => showHistory(item.id)} onAction={() => { setHistory(null); setAction(item); }} />{history?.id === item.id && historyView}{action?.id === item.id && <OpportunityTaskReview key={item.id} item={action} onClose={() => { setAction(null); refresh(item.id); }} />}</div>)}
      <nav className="actions" aria-label="Страницы выводов"><button className="btn secondary" disabled={busy || Boolean(action) || pages.length === 1} onClick={() => setPages(old => old.slice(0, -1))}>Назад</button><span>Страница {pages.length}</span><button className="btn secondary" disabled={busy || Boolean(action) || !data.nextCursor} onClick={() => setPages(old => [...old, data.nextCursor || undefined])}>Далее</button></nav>
    </>}
  </section>;
}
