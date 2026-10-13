import { InlineFeedback } from "../components/InlineFeedback";
import { uiMessage, uiText, useUiText, localizeUiOptions, uiFormatLocale } from "../lib/uiText";
import { useSession, useLocale } from "../lib/session";
import { useUrlState, useRequestVersion } from "../lib/useUrlState";
import { Fragment, useEffect, useMemo, useState, useRef, useId, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { PeriodSelector, type PeriodPreset } from "../components/PeriodSelector";
import { tip } from "../lib/tip";
import { api } from "../lib/api";
import { NavIcon } from "../components/NavIcon";
import { PERIOD_OPTIONS } from "../lib/period";
import "../stats.css";
import { exportAnalyticsCsv, exportAnalyticsExcel, exportAnalyticsPdf } from "../lib/statsExport";

type TabId =
  | "overview"
  | "funnel"
  | "sales"
  | "sources"
  | "services"
  | "losses"
  | "managers"
  | "tasks"
  | "communications"
  | "ai"
  | "campaigns";
type CompareMode = "previous" | "last_month" | "last_year" | "none";
type TrendMetric = "inquiries" | "clients" | "deals" | "won" | "revenue" | "conversion";
type BarMetric = "inquiries" | "won" | "revenue" | "conversion";

const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Обзор" },
  { id: "funnel", label: "Этапы" },
  { id: "sales", label: "Продажи" },
  { id: "sources", label: "Источники" },
  { id: "services", label: "Услуги и товары" },
  { id: "managers", label: "Менеджеры" },
  { id: "communications", label: "Коммуникации" },
  { id: "tasks", label: "Задачи" },
  { id: "ai", label: "AI-менеджер" },
  { id: "campaigns", label: "Рассылки" },
  { id: "losses", label: "Потери" },
];

const TREND_METRICS: { id: TrendMetric; label: string }[] = [
  { id: "inquiries", label: "Обращения" },
  { id: "clients", label: "Клиенты" },
  { id: "deals", label: "Сделки" },
  { id: "won", label: "Продажи" },
  { id: "revenue", label: "Выручка" },
  { id: "conversion", label: "Конверсия" },
];

const METRIC_HINTS: Record<TrendMetric, string> = {
  inquiries: "Количество поступивших обращений по датам выбранного периода",
  clients: "Количество новых клиентов по дате первого обращения",
  deals: "Количество созданных сделок по датам выбранного периода",
  won: "Сколько продаж закрыто в эти дни",
  revenue: "Сумма продаж по дням закрытия",
  conversion: "Доля продаж от обращений за день. Если обращений не было — показатель не считается",
};

const RECORD_STATUSES: Record<string, string> = {
  new: "Новая", qualification: "Квалификация", qualified: "Квалифицирована",
  in_progress: "В работе", waiting_client: "Ждём клиента", proposal: "КП отправлено",
  open: "В работе", won: "Продано", lost: "Потеряно",
};

function formatChartValue(value: number | null, metric: TrendMetric, currency?: string) {
  if (value == null) return "—";
  if (metric === "conversion") return `${value}%`;
  if (metric === "revenue") return `${value.toLocaleString(uiFormatLocale())}${currency ? ` ${currency === "KZT" ? "₸" : currency}` : ""}`;
  return String(value);
}

function yAxisTicks(max: number) {
  const raw = Math.max(max / 4, 1);
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  const step = nice * pow;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.01; v += step) ticks.push(Math.round(v * 10) / 10);
  if (ticks[ticks.length - 1] < max) ticks.push(Math.round((ticks[ticks.length - 1] + step) * 10) / 10);
  return ticks;
}

function deltaLabel(value: number | null | undefined, unit: "%" | "pp" = "%") {
  if (value == null) return null;
  const arrow = value > 0 ? "↑" : value < 0 ? "↓" : "→";
  const abs = Math.abs(value);
  return unit === "pp" ? uiText("{p0} {p1} п.п.", {p0: arrow, p1: abs}) : `${arrow} ${abs}%`;
}

function formatHours(hours: number | null | undefined) {
  if (hours == null) return "—";
  if (hours < 1) return uiText("{p0} мин", {p0: Math.round(hours * 60)});
  if (hours < 48) return uiText("{p0} ч", {p0: Math.round(hours * 10) / 10});
  return uiText("{p0} дн.", {p0: Math.round((hours / 24) * 10) / 10});
}

function StatsIcon({ kind }: { kind: "arrow" | "filter" | "download" | "close" | "refresh" }) {
  const paths = {
    arrow: "M5 12h14m-5-5 5 5-5 5",
    filter: "M4 7h16M7 12h10M10 17h4",
    download: "M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5",
    close: "m6 6 12 12M6 18 18 6",
    refresh: "M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2",
  };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]} /></svg>;
}

function StatsDialog({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const uiText = useUiText();
  useEffect(() => {
    const element = ref.current;
    element?.showModal();
    return () => { element?.close(); };
  }, []);
  return <dialog ref={ref} className={`stats-dialog${wide ? " stats-dialog-wide" : ""}`} aria-labelledby={titleId} onCancel={onClose}>
    <div className="stats-dialog-heading"><h3 id={titleId}>{title}</h3><button type="button" className="stats-icon-button" aria-label={uiText("Закрыть")} onClick={onClose}><StatsIcon kind="close" /></button></div>
    {children}
  </dialog>;
}

function LineChart({ points, comparePoints, label, metric, currency }: {
  points: { label: string; value: number | null }[];
  comparePoints?: { value: number | null }[] | null;
  label: string;
  metric: TrendMetric;
  currency?: string;
}) {
  const uiText = useUiText();
  const [hover, setHover] = useState<number | null>(null);
  const [width, setWidth] = useState(720);
  const ref = useRef<HTMLDivElement>(null);
  const gradient = useId().replace(/:/g, "");
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => setWidth(Math.max(260, entries[0].contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, [points.length]);
  if (!points.length) return <p className="empty">{uiText("Пока недостаточно данных для графика.")}</p>;
  const w = width, h = 260, padL = metric === "revenue" ? 66 : 48, padR = 14, padT = 20, padB = 35;
  const values = [...points, ...(comparePoints || []).slice(0, points.length)].map(p => p.value).filter((v): v is number => v != null);
  const ticks = yAxisTicks(Math.max(...values, 1));
  const scaleMax = ticks.at(-1) || 1;
  const innerW = w - padL - padR, innerH = h - padT - padB;
  const toX = (i: number) => padL + (points.length > 1 ? i * innerW / (points.length - 1) : innerW / 2);
  const toY = (v: number | null) => padT + innerH - ((v ?? 0) / scaleMax) * innerH;
  const hitStart = (i: number) => i === 0 ? padL : (toX(i - 1) + toX(i)) / 2;
  const hitEnd = (i: number) => i === points.length - 1 ? w - padR : (toX(i) + toX(i + 1)) / 2;
  const makePath = (rows: {value: number | null}[]) => rows.slice(0, points.length).map((p, i) => p.value == null ? "" : `${i === 0 || rows[i - 1].value == null ? "M" : "L"} ${toX(i)} ${toY(p.value)}`).join(" ");
  const path = makePath(points);
  const area = points.some(p => p.value == null) ? "" : `${path} L ${toX(points.length - 1)} ${toY(0)} L ${toX(0)} ${toY(0)} Z`;
  const comparePath = comparePoints?.length ? makePath(comparePoints) : null;
  const labelEvery = Math.max(1, Math.ceil((points.length - 1) / (w < 450 ? 3 : 6)));
  const active = hover != null && points[hover] ? hover : null;
  const compact = (n: number) => metric === "conversion" ? `${n}%` : new Intl.NumberFormat(uiFormatLocale(), { notation: "compact", maximumFractionDigits: 1 }).format(n);
  return <div className="stats-chart-wrap" ref={ref}>
    <div className="stats-chart-legend">
      <span><i />{uiText("Текущий период")}</span>
      {comparePath ? <span><i className="is-compare" />{uiText("Сравнение")}</span> : null}
      <output className="stats-chart-reading">{active != null ? `${points[active].label} · ${formatChartValue(points[active].value, metric, currency)}` : uiText("Выберите точку на графике")}</output>
    </div>
    <svg viewBox={`0 0 ${w} ${h}`} className="stats-line-chart" role="img" aria-label={label}>
      <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#2475ee" stopOpacity=".2" /><stop offset="100%" stopColor="#2475ee" stopOpacity=".015" /></linearGradient></defs>
      {ticks.map(tick => <g key={tick}><line x1={padL} y1={toY(tick)} x2={w-padR} y2={toY(tick)} className="stats-grid" /><text x={padL-10} y={toY(tick)+4} textAnchor="end" className="stats-tick">{compact(tick)}</text></g>)}
      <path d={area} fill={`url(#${gradient})`} />
      {comparePath ? <path d={comparePath} className="stats-line-compare" fill="none" /> : null}
      <path d={path} className="stats-line" fill="none" />
      {active != null ? <line x1={toX(active)} x2={toX(active)} y1={padT} y2={h-padB} className="stats-crosshair" /> : null}
      {points.map((p, i) => <g key={`${p.label}-${i}`}>
        {p.value != null ? <circle cx={toX(i)} cy={toY(p.value)} r={active === i ? 5 : points.length <= 16 ? 3 : 0} className="stats-dot" /> : null}
        {i === 0 || i === points.length-1 || (i % labelEvery === 0 && points.length-1-i >= labelEvery) ? <text x={toX(i)} y={h-10} textAnchor={i === 0 ? "start" : i === points.length-1 ? "end" : "middle"} className="stats-tick">{p.label}</text> : null}
        <rect x={hitStart(i)} y={padT} width={hitEnd(i) - hitStart(i)} height={innerH} fill="transparent" onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)}><title>{p.label}: {formatChartValue(p.value, metric, currency)}</title></rect>
      </g>)}
    </svg>
    {metric === "conversion" && points.some(p => p.value == null) ? <p className="stats-chart-note">{uiText("«—» — нет обращений для расчёта. Продажи могут относиться к обращениям прошлых дат.")}</p> : null}
    <details className="stats-chart-data"><summary>{uiText("Данные таблицей")}</summary><div className="stats-table-wrap"><table className="stats-table"><thead><tr><th>{uiText("Дата")}</th><th>{uiText("Текущий период")}</th>{comparePath ? <th>{uiText("Сравнение")}</th> : null}</tr></thead><tbody>{points.map((p,i) => <tr key={`${p.label}-${i}`}><td>{p.label}</td><td>{formatChartValue(p.value,metric,currency)}</td>{comparePath ? <td>{formatChartValue(comparePoints?.[i]?.value ?? null,metric,currency)}</td> : null}</tr>)}</tbody></table></div></details>
  </div>;
}

function BarChart({
  items,
  valueKey,
  currency,
}: {
  items: { name: string; inquiries?: number; won?: number; revenue?: number; conversion?: number | null }[];
  valueKey: BarMetric;
  currency?: string;
}) {
  const uiText = useUiText();
  const rows = items
    .map((item) => ({
      name: item.name,
      value:
        valueKey === "inquiries"
          ? item.inquiries || 0
          : valueKey === "won"
            ? item.won || 0
            : valueKey === "revenue"
              ? item.revenue || 0
              : item.conversion || 0,
    }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 12);
  if (!rows.length) return <p className="empty">{uiText("Нет данных для диаграммы.")}</p>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className="stats-bars">
      {rows.map((r) => (
        <div className="stats-bar-row" key={r.name}>
          <span className="stats-bar-label" title={r.name}>
            {r.name}
          </span>
          <div className="stats-bar-track">
            <div className="stats-bar-fill" style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
          <span className="stats-bar-value">
            {formatChartValue(r.value, valueKey, currency)}
          </span>
        </div>
      ))}
    </div>
  );
}

function KpiCard({ label, value, delta, deltaUnit = "%", onClick, icon, featured = false, description }: {
  label: string; value: ReactNode; delta?: number | null; deltaUnit?: "%" | "pp"; onClick?: () => void;
  icon?: string; featured?: boolean; description?: string;
}) {
  const d = deltaLabel(delta, deltaUnit);
  const content = <>
    <span className="stats-kpi-heading"><span>{label}</span>{icon ? <NavIcon to={icon} /> : null}</span>
    <strong>{value ?? "—"}</strong>
    <span className="stats-kpi-footer">{d ? <span className={`kpi-delta ${delta === 0 ? "neutral" : delta && delta < 0 ? "down" : ""}`}>{d}</span> : null}{description ? <span>{description}</span> : null}{onClick ? <StatsIcon kind="arrow" /> : null}</span>
  </>;
  const className = `sit-kpi stats-kpi${featured ? " stats-kpi-featured" : ""}`;
  return onClick ? <button type="button" className={`${className} stats-kpi-btn`} aria-label={uiText("Показать записи показателя «{p0}»", {p0:label})} onClick={onClick}>{content}</button> : <div className={className}>{content}</div>;
}

export function StatsPage() {
  const locale = useLocale();
  const uiText = useUiText();
  const { me } = useSession();
  const exportAllowed = Boolean(me?.billing?.entitlements?.EXPORT);
  const requestVersion = useRequestVersion();
  const [tab, setTab] = useUrlState<TabId>("tab", "overview", localizeUiOptions(TABS, uiText).map(t => t.id));
  const [period, setPeriod] = useUrlState<PeriodPreset>("period", "this_month", PERIOD_OPTIONS.map(p => p.id));
  const [dateFrom, setDateFrom] = useUrlState<string>("from", "");
  const [dateTo, setDateTo] = useUrlState<string>("to", "");
  const [compare, setCompare] = useState<CompareMode>("previous");
  const [funnelMode, setFunnelMode] = useState<"events" | "cohort">("events");
  const [trendMetric, setTrendMetric] = useState<TrendMetric>("inquiries");
  const [sourceBar, setSourceBar] = useState<BarMetric>("inquiries");
  const [serviceBar, setServiceBar] = useState<BarMetric>("revenue");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [assignee, setAssignee] = useState("");
  const [serviceCategory, setServiceCategory] = useState("");
  const [source, setSource] = useState("");
  const [channel, setChannel] = useState("");
  const [city, setCity] = useState("");
  const [campaign, setCampaign] = useState("");
  const [members, setMembers] = useState<{ id: string; name: string }[]>([]);
  const [data, setData] = useState<any>(null);
  const drillVersion = useRequestVersion();
  const [filterDraft, setFilterDraft] = useState({ assignee: "", serviceCategory: "", source: "", channel: "", city: "", campaign: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [sections, setSections] = useState({
    overview: true,
    funnel: true,
    sources: true,
    services: true,
    sales: true,
    losses: true,
  });
  const [drill, setDrill] = useState<any>(null);
  const [drillLoading, setDrillLoading] = useState(false);

  const query = useMemo(
    () => ({
      period,
      dateFrom: period === "custom" ? dateFrom : undefined,
      dateTo: period === "custom" ? dateTo : undefined,
      compare,
      funnelMode,
      assignee: assignee || undefined,
      serviceCategory: serviceCategory || undefined,
      source: source || undefined,
      channel: channel || undefined,
      city: city || undefined,
      campaign: campaign || undefined,
    }),
    [period, dateFrom, dateTo, compare, funnelMode, assignee, serviceCategory, source, channel, city, campaign],
  );

  async function openDrill(entity: string, key?: string) {
    const request = ++drillVersion.current;
    try {
      setDrillLoading(true);
      setDrill({ title: uiText("Загрузка…"), items: [] });
      const res = await api.analyticsDrilldown({ ...query, entity, key });
      if (request === drillVersion.current) setDrill(res);
    } catch (err) {
      if (request !== drillVersion.current) return;
      setError(err instanceof Error ? err.message : uiText("Не удалось открыть детализацию"));
      setDrill(null);
    } finally {
      if (request === drillVersion.current) setDrillLoading(false);
    }
  }

  async function load() {
    const request = ++requestVersion.current;
    try {
      if (period === "custom" && (!dateFrom || !dateTo)) {
        setData(null);
        setError("");
        setLoading(false);
        return;
      }
      if (period === "custom" && dateFrom > dateTo) {
        setData(null);
        setError(uiText("Укажите начало и конец периода. Начало не должно быть позже окончания."));
        setLoading(false);
        return;
      }
      setLoading(true);
      const result = await api.analyticsDashboard(query);
      if (request !== requestVersion.current) return;
      setData(result);
      setError("");
    } catch (err) {
      if (request !== requestVersion.current) return;
      setData(null);
      setError(err instanceof Error ? err.message : uiText("Ошибка загрузки"));
    } finally {
      if (request === requestVersion.current) setLoading(false);
    }
  }

  useEffect(() => {
    void api.workspaceMembers().then((res: any) => {
      const items = (res.items || res || []).map((m: any) => ({
        id: m.id || m.membershipId,
        name: m.name || m.user?.name || m.displayName || "Менеджер",
      }));
      setMembers(items.filter((m: { id: string }) => m.id));
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    void load();
  }, [query, locale]);

  const chartMetric = tab === "sales" && !["won", "revenue"].includes(trendMetric) ? "revenue" : trendMetric;
  const trendPoints = (data?.trend?.points || []).map((p: any) => ({ label: p.label, value: p[chartMetric] == null ? null : Number(p[chartMetric]) }));
  const comparePoints = compare !== "none" ? data?.trendCompare?.points?.map((p: any) => ({ value: p[chartMetric] == null ? null : Number(p[chartMetric]) })) : null;
  const appliedFilters = [
    { label: uiText("Ответственный"), value: assignee, text: members.find(m => m.id === assignee)?.name || assignee, clear: () => setAssignee("") },
    { label: uiText("Услуга / товар"), value: serviceCategory, text: serviceCategory, clear: () => setServiceCategory("") },
    { label: uiText("Источник"), value: source, text: source, clear: () => setSource("") },
    { label: uiText("Канал"), value: channel, text: channel, clear: () => setChannel("") },
    { label: uiText("Город"), value: city, text: city, clear: () => setCity("") },
    { label: uiText("Кампания"), value: campaign, text: campaign, clear: () => setCampaign("") },
  ].filter(f => f.value);
  function resetFilters() { setAssignee(""); setServiceCategory(""); setSource(""); setChannel(""); setCity(""); setCampaign(""); setFiltersOpen(false); }
  function closeDrill() { drillVersion.current++; setDrill(null); }

  const o = data?.overview || {};
  const sales = data?.sales || {};

  return (
    <section className="stats-page">
      <header className="stats-heading">
        <div><span className="stats-eyebrow">{uiText("Аналитика бизнеса")}</span><h1>{uiText("Статистика")}</h1><p>{uiText("От первого обращения до продажи — всё в одном месте.")}</p></div>
        <div className="stats-heading-actions">
          <button type="button" className="stats-icon-button" disabled={loading} aria-label={uiText("Обновить статистику")} onClick={() => void load()}><StatsIcon kind="refresh" /></button>
          <button type="button" className="btn secondary" disabled={!exportAllowed || !data || loading} title={exportAllowed ? undefined : uiText("Экспорт доступен начиная с CRM Start")} onClick={() => setExportOpen(true)}><StatsIcon kind="download" />{uiText("Скачать отчёт")}</button>
        </div>
      </header>
      <div className="stats-controls">
        <PeriodSelector period={period} onPeriodChange={setPeriod} dateFrom={dateFrom} dateTo={dateTo} onDateFromChange={setDateFrom} onDateToChange={setDateTo} activeLabel={data?.period?.label} />
        <div className="stats-control-bottom">
          <label className="stats-compare">{uiText("Сравнить с")}<select aria-label={uiText("Сравнить с")} value={compare} onChange={e => setCompare(e.target.value as CompareMode)}>
            <option value="previous">{uiText("Предыдущим периодом")}</option><option value="last_month">{uiText("Прошлым месяцем")}</option><option value="last_year">{uiText("Прошлым годом")}</option><option value="none">{uiText("Не сравнивать")}</option>
          </select></label>
          <button type="button" className={`btn secondary stats-filter-toggle${filtersOpen ? " is-open" : ""}`} aria-expanded={filtersOpen} aria-controls="stats-filters" onClick={() => { setFilterDraft({assignee, serviceCategory, source, channel, city, campaign}); setFiltersOpen(v => !v); }}><StatsIcon kind="filter" />{uiText("Фильтры")}{appliedFilters.length ? <span className="stats-count">{appliedFilters.length}</span> : null}</button>
          <span className="stats-freshness" role="status">{loading ? uiText("Обновляем данные…") : data?.asOf ? uiText("Обновлено в {time}", {time: new Date(data.asOf).toLocaleTimeString(uiFormatLocale(), {hour: "2-digit", minute: "2-digit"})}) : ""}</span>
        </div>
      </div>
      {filtersOpen ? (
        <form id="stats-filters" className="stats-filters" onSubmit={e => { e.preventDefault(); setAssignee(filterDraft.assignee); setServiceCategory(filterDraft.serviceCategory.trim()); setSource(filterDraft.source.trim()); setChannel(filterDraft.channel.trim()); setCity(filterDraft.city.trim()); setCampaign(filterDraft.campaign.trim()); setFiltersOpen(false); }}>
          <label>
            {uiText("Ответственный")}<select value={filterDraft.assignee} onChange={(e) => setFilterDraft(d => ({...d, assignee: e.target.value}))}>
              <option value="">{uiText("Все")}</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {uiText("Услуга / товар")}<input value={filterDraft.serviceCategory} onChange={(e) => setFilterDraft(d => ({...d, serviceCategory: e.target.value}))} placeholder={uiText("Сайты")} />
          </label>
          <label>
            {uiText("Источник")}<input value={filterDraft.source} onChange={(e) => setFilterDraft(d => ({...d, source: e.target.value}))} placeholder="Google Ads" />
          </label>
          <label>
            {uiText("Канал")}<input value={filterDraft.channel} onChange={(e) => setFilterDraft(d => ({...d, channel: e.target.value}))} placeholder="WhatsApp" />
          </label>
          <label>
            {uiText("Город")}<input value={filterDraft.city} onChange={(e) => setFilterDraft(d => ({...d, city: e.target.value}))} placeholder={uiText("Алматы")} />
          </label>
          <label>
            {uiText("Кампания")}<input value={filterDraft.campaign} onChange={(e) => setFilterDraft(d => ({...d, campaign: e.target.value}))} placeholder="utm_campaign" />
          </label>
          <div className="stats-filter-actions"><button type="button" className="btn secondary" onClick={resetFilters}>{uiText("Сбросить фильтры")}</button><button type="submit" className="btn">{uiText("Применить")}</button></div>
        </form>
      ) : null}

      {error ? (
        <div className="row">
          <InlineFeedback kind="error" className="error">{error}</InlineFeedback>
          <button type="button" className="btn secondary" onClick={() => void load()}>
            {uiText("Повторить")}</button>
        </div>
      ) : null}

      {period === "custom" && (!dateFrom || !dateTo) ? <p className="stats-date-prompt" role="status">{uiText("Выберите начальную и конечную даты, чтобы построить отчёт.")}</p> : null}

      {appliedFilters.length ? <div className="stats-applied-filters" aria-label={uiText("Активные фильтры")}>{appliedFilters.map(f => <button type="button" key={f.label} onClick={f.clear} aria-label={uiText("Убрать фильтр: {filter}", {filter: f.label})}>{f.label}: <b>{f.text}</b><StatsIcon kind="close" /></button>)}<button type="button" className="stats-clear-all" onClick={resetFilters}>{uiText("Сбросить всё")}</button></div> : null}
      <nav className="stats-navigation" aria-label={uiText("Разделы статистики")}>
        <div className="stats-tabs">{localizeUiOptions(TABS, uiText).map(t => <button key={t.id} type="button" aria-current={tab === t.id ? "page" : undefined} className={tab === t.id ? "is-active" : ""} onClick={() => setTab(t.id)}>{t.label}</button>)}</div>
        <label className="stats-mobile-nav">{uiText("Раздел отчёта")}<select aria-label={uiText("Раздел отчёта")} value={tab} onChange={e => setTab(e.target.value as TabId)}>{localizeUiOptions(TABS,uiText).map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select></label>
      </nav>
      {loading && !data ? <div className="stats-skeleton" role="status"><span>{uiText("Загрузка статистики…")}</span><div /><div /><div /><div /></div> : null}
      <div className={`stats-content${loading && data ? " is-refreshing" : ""}`} aria-busy={loading} inert={loading || undefined}>
      {data?.empty ? (
        <div className="sit-section">
          <h3>{uiText("По выбранным условиям нет данных")}</h3>
          <p className="muted">
            {uiText("Измените период или фильтры. Новые обращения и сделки появятся здесь автоматически.")}</p>
        </div>
      ) : null}

      {tab === "overview" && data ? (
        <>
          <div className="stats-period-caption"><h2>{uiMessage(data.period?.label)}</h2>{data.compare?.label ? <span>{uiText("Сравнение")}: {data.compare.label}</span> : null}</div>
          <div className="stats-primary-kpis">
            <KpiCard label={uiText("Выручка")} value={o.revenueLabel || "—"} delta={o.deltas?.revenue} onClick={() => void openDrill("won")} icon="/billing" featured description={uiText("Закрытые продажи")} />
            <KpiCard label={uiText("Обращения")} value={o.inquiries} delta={o.deltas?.inquiries} onClick={() => void openDrill("inquiries")} icon="/conversations" description={uiText("За выбранный период")} />
            <KpiCard label={uiText("Продажи")} value={o.won} delta={o.deltas?.won} onClick={() => void openDrill("won")} icon="/deals" description={uiText("Успешные сделки")} />
            <KpiCard label={uiText("Конверсия")} value={o.conversion != null ? `${o.conversion}%` : "—"} delta={o.deltas?.conversionPp} deltaUnit="pp" icon="/stats" description={uiText("Продажи / обращения")} />
          </div>
          <div className="stats-secondary-kpis">
            <KpiCard label={uiText("Новые клиенты")} value={o.clients} onClick={() => void openDrill("clients")} />
            <KpiCard label={uiText("Создано сделок")} value={o.dealsCreated} onClick={() => void openDrill("deals")} />
            <KpiCard label={uiText("Договоры")} value={o.contracts} />
            <KpiCard label={uiText("Средний чек")} value={o.avgCheckLabel || "—"} />
            <KpiCard label={uiText("Потеряно")} value={o.lost} onClick={() => void openDrill("lost")} />
          </div>
          <div className="stats-analysis-grid">
            <div className="sit-section stats-trend-card">
              <div className="sit-section-head"><div><span className="stats-eyebrow">{uiText("Результат во времени")}</span><h3>{uiText("Динамика")}</h3></div><select className="stats-metric-select" aria-label={uiText("Показатель графика")} value={trendMetric} onChange={e => setTrendMetric(e.target.value as TrendMetric)}>{localizeUiOptions(TREND_METRICS,uiText).map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select></div>
              <p className="stats-chart-note">{localizeUiOptions(METRIC_HINTS,uiText)[chartMetric]}</p>
              <LineChart currency={data.currency} points={trendPoints} comparePoints={comparePoints} metric={chartMetric} label={uiText("Динамика: {p0}", {p0:localizeUiOptions(TREND_METRICS,uiText).find(m => m.id === chartMetric)?.label})} />
            </div>
            <aside className="sit-section stats-insights">
              <div><span className="stats-eyebrow">{uiText("Фокус руководителя")}</span><h3>{uiText("На что обратить внимание")}</h3></div>
              <button type="button" className="stats-insight" onClick={() => setTab("tasks")}><span className="stats-insight-icon"><NavIcon to="/tasks" /></span><span><strong>{data.tasks?.overdue ?? 0}</strong><b>{uiText("Просрочено задач")}</b><small>{uiText("Проверьте сроки и загрузку команды")}</small></span><StatsIcon kind="arrow" /></button>
              <button type="button" className="stats-insight" onClick={() => setTab("communications")}><span className="stats-insight-icon is-blue"><NavIcon to="/conversations" /></span><span><strong>{data.communications?.waitedOver15 ?? 0}</strong><b>{uiText("Ожидали ответа больше 15 минут")}</b><small>{uiText("Оцените скорость ответа клиентам")}</small></span><StatsIcon kind="arrow" /></button>
              <button type="button" className="stats-insight" onClick={() => setTab("losses")}><span className="stats-insight-icon is-purple"><NavIcon to="/deals" /></span><span><strong>{o.lost ?? 0}</strong><b>{uiText("Потерянные сделки")}</b><small>{uiText("Разберите причины отказов")}</small></span><StatsIcon kind="arrow" /></button>
            </aside>
          </div>
          <div className="stats-overview-split">
            <div className="sit-section"><div className="sit-section-head"><h3>{uiText("Путь к продаже")}</h3><button type="button" className="stats-text-button" onClick={() => setTab("funnel")}>{uiText("Подробнее")}<StatsIcon kind="arrow" /></button></div><div className="stats-funnel-visual">{(data.funnel?.steps || []).map((step:any,i:number) => <div key={step.key}><div><span><small>{String(i+1).padStart(2,"0")}</small>{step.name}</span><b>{step.count}</b></div><div className="stats-funnel-track"><span style={{width:`${Math.max(0,Math.min(100,step.count / Math.max(1,...data.funnel.steps.map((s:any)=>s.count)) * 100))}%`,opacity:1-i*.1}} /></div></div>)}</div><p className="stats-chart-note">{funnelMode === "cohort" ? uiText("Кто пришёл за период") : uiText("События выбранного периода. Сделки могут быть из более ранних обращений.")}</p></div>
            <div className="sit-section"><div className="sit-section-head"><h3>{uiText("Откуда приходят клиенты")}</h3><button type="button" className="stats-text-button" onClick={() => setTab("sources")}>{uiText("Подробнее")}<StatsIcon kind="arrow" /></button></div><p className="stats-chart-note">{uiText("Источники по количеству обращений")}</p><BarChart currency={data.currency} items={data.sources || []} valueKey="inquiries" /></div>
            <div className="sit-section"><div className="sit-section-head"><h3>{uiText("Что приносит выручку")}</h3><button type="button" className="stats-text-button" onClick={() => setTab("services")}>{uiText("Подробнее")}<StatsIcon kind="arrow" /></button></div><p className="stats-chart-note">{uiText("Услуги и товары по сумме продаж")}</p><BarChart currency={data.currency} items={(data.services || []).map((r:any)=>({...r,name:r.label || r.name}))} valueKey="revenue" /></div>
          </div>
          {data.dataQuality ? <details className="stats-quality"><summary><NavIcon to="/documents" /><span>{uiText("Качество данных")}<small>{uiText("Полные карточки делают отчёт точнее")}</small></span></summary><div className="stats-quality-grid">{[[uiText("Без телефона"),data.dataQuality.noPhone],[uiText("Без источника"),data.dataQuality.noSource],[uiText("Без ответственного"),data.dataQuality.noOwner],[uiText("Без причины отказа"),data.dataQuality.lostNoReason],[uiText("Без следующего шага"),data.dataQuality.openNoNextAction]].map(([label,count])=><div key={label}><span>{label}</span><b>{count}</b></div>)}</div></details> : null}
        </>
      ) : null}

      {tab === "funnel" && data ? (
        <div className="sit-section">
          <div className="sit-section-head">
            <h3>{uiText("Этапы продаж")}</h3>
            <div className="stats-metric-switch">
              <button
                type="button"
                className={funnelMode === "events" ? "btn sit-chip" : "btn secondary sit-chip"}
                onClick={() => setFunnelMode("events")}
              >
                {uiText("Что случилось за период")}</button>
              <button
                type="button"
                className={funnelMode === "cohort" ? "btn sit-chip" : "btn secondary sit-chip"}
                onClick={() => setFunnelMode("cohort")}
              >
                {uiText("Кто пришёл за период")}</button>
            </div>
          </div>
          <div className="stats-funnel-steps">
            {(data.funnel?.steps || []).map((s: any, i: number) => (
              <div key={s.key} className="stats-funnel-step">
                <div>
                  <b>{s.name}</b>
                  <div className="muted">
                    {s.fromStartPct != null ? uiText("{p0}% от начала", {p0: s.fromStartPct}) : null}
                    {i > 0 && s.fromPrevPct != null ? uiText(" · {p0}% от предыдущего", {p0: s.fromPrevPct}) : null}
                  </div>
                </div>
                <strong>{s.count}</strong>
              </div>
            ))}
          </div>

          <h4>{uiText("Потери между этапами")}</h4>
          <div className="stats-table-wrap">
            <table className="stats-table">
              <thead>
                <tr>
                  <th>{uiText("Переход")}</th>
                  <th>{uiText("Было")}</th>
                  <th>{uiText("Перешло")}</th>
                  <th>{uiText("Потеря")}</th>
                  <th>{uiText("Конверсия")}</th>
                </tr>
              </thead>
              <tbody>
                {(data.funnel?.transitions || []).map((t: any) => (
                  <tr key={`${t.from}-${t.to}`}>
                    <td>
                      {t.from} → {t.to}
                    </td>
                    <td>{t.was}</td>
                    <td>{t.passed}</td>
                    <td>{t.lost}</td>
                    <td>{t.conversion != null ? `${t.conversion}%` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h4>{uiText("Время прохождения")}</h4>
          <div className="stats-table-wrap">
            <table className="stats-table">
              <thead>
                <tr>
                  <th>{uiText("Стадия")}</th>
                  <th>{uiText("Среднее")}</th>
                  <th>{uiText("Медиана")}</th>
                  <th>{uiText("Зависших")}</th>
                </tr>
              </thead>
              <tbody>
                {(data.stageDurations || []).map((s: any) => (
                  <tr key={s.systemKey}>
                    <td>{s.name}</td>
                    <td>{formatHours(s.avgHours)}</td>
                    <td>{formatHours(s.medianHours)}</td>
                    <td>{s.stalled}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="sit-kpi-grid stats-kpi-grid">
            <KpiCard label={uiText("Средний цикл продажи")} value={sales.cycle?.avgDays != null ? uiText("{p0} дн.", {p0: sales.cycle.avgDays}) : "—"} />
            <KpiCard label={uiText("Медианный цикл")} value={sales.cycle?.medianDays != null ? uiText("{p0} дн.", {p0: sales.cycle.medianDays}) : "—"} />
            <KpiCard label={uiText("Самая быстрая")} value={sales.cycle?.minDays != null ? uiText("{p0} дн.", {p0: sales.cycle.minDays}) : "—"} />
            <KpiCard label={uiText("Самая длинная")} value={sales.cycle?.maxDays != null ? uiText("{p0} дн.", {p0: sales.cycle.maxDays}) : "—"} />
          </div>
        </div>
      ) : null}

      {tab === "sales" && data ? (
        <div className="sit-section">
          <div className="sit-section-head">
            <h3>{uiText("Продажи")}</h3>
          </div>
          <div className="sit-kpi-grid stats-kpi-grid">
            <KpiCard label={uiText("Продажи")} value={sales.won} onClick={() => void openDrill("won")} />
            <KpiCard label={uiText("Продано")} value={sales.revenueLabel || "—"} onClick={() => void openDrill("won")} />
            <KpiCard label={uiText("Средний чек")} value={sales.avgCheckLabel || "—"} />
            <KpiCard label={uiText("Медианный чек")} value={sales.medianCheckLabel || "—"} />
            <KpiCard label={uiText("Максимальная сделка")} value={sales.maxCheckLabel || "—"} />
            <KpiCard label={uiText("В работе")} value={sales.pipelineLabel || "—"} />
            <KpiCard
              label={uiText("Прогноз")}
              value={sales.weightedPipelineLabel || "—"}
            />
            <KpiCard label={uiText("План")} value={sales.planLabel || uiText("не задан")} />
            <KpiCard
              label={uiText("План / факт")}
              value={sales.planPercent != null ? `${sales.planPercent}%` : "—"}
            />
          </div>
          <div className="stats-metric-switch">
            {(["won", "revenue"] as TrendMetric[]).map((m) => (
              <button
                key={m}
                type="button"
                className={chartMetric === m ? "btn sit-chip" : "btn secondary sit-chip"}
                {...tip(localizeUiOptions(METRIC_HINTS, uiText)[m])}
                onClick={() => setTrendMetric(m)}
              >
                {m === "won" ? uiText("Количество продаж") : uiText("Сумма продаж")}
              </button>
            ))}
          </div>
          <LineChart currency={data.currency} points={trendPoints} comparePoints={comparePoints} metric={chartMetric} label={uiText("Продажи по времени")} />
        </div>
      ) : null}

      {tab === "sources" && data ? (
        <div className="sit-section">
          <div className="sit-section-head">
            <h3>{uiText("Источники привлечения")}</h3>
            <div className="stats-metric-switch">
              {(
                [
                  ["inquiries", uiText("По обращениям")],
                  ["won", uiText("По продажам")],
                  ["revenue", uiText("По выручке")],
                  ["conversion", uiText("По конверсии")],
                ] as [BarMetric, string][]
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={sourceBar === id ? "btn sit-chip" : "btn secondary sit-chip"}
                  {...tip(localizeUiOptions(METRIC_HINTS, uiText)[id])}
                  onClick={() => setSourceBar(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <BarChart currency={data.currency} items={data.sources || []} valueKey={sourceBar} />
          <div className="stats-table-wrap">
            <table className="stats-table">
              <thead>
                <tr>
                  <th>{uiText("Источник")}</th>
                  <th>{uiText("Обращения")}</th>
                  <th>{uiText("Сделки")}</th>
                  <th>{uiText("Продажи")}</th>
                  <th>{uiText("Конверсия")}</th>
                  <th>{uiText("Выручка")}</th>
                  <th>{uiText("Средний чек")}</th>
                </tr>
              </thead>
              <tbody>
                {(data.sources || []).map((r: any) => (
                  <tr key={r.name}>
                    <td>{r.name}</td>
                    <td>
                      <button type="button" className="linkish" onClick={() => void openDrill("source_inquiries", r.name)}>
                        {r.inquiries}
                      </button>
                    </td>
                    <td>{r.deals}</td>
                    <td>
                      <button type="button" className="linkish" onClick={() => void openDrill("source_won", r.name)}>
                        {r.won}
                      </button>
                    </td>
                    <td>{r.conversion != null ? `${r.conversion}%` : "—"}</td>
                    <td>{r.revenueLabel || "—"}</td>
                    <td>{r.avgCheckLabel || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" className="btn secondary" disabled={!exportAllowed} onClick={() => exportAnalyticsCsv(data, "sources")}>
            {uiText("CSV источников")}</button>
        </div>
      ) : null}

      {tab === "services" && data ? (
        <div className="sit-section">
          <div className="sit-section-head">
            <h3>{uiText("Услуги и товары")}</h3>
            <div className="stats-metric-switch">
              {(
                [
                  ["revenue", uiText("Выручка")],
                  ["won", uiText("Продажи")],
                  ["inquiries", uiText("Обращения")],
                  ["conversion", uiText("Конверсия")],
                ] as [BarMetric, string][]
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={serviceBar === id ? "btn sit-chip" : "btn secondary sit-chip"}
                  {...tip(localizeUiOptions(METRIC_HINTS, uiText)[id])}
                  onClick={() => setServiceBar(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <BarChart currency={data.currency} items={data.services || []} valueKey={serviceBar} />
          <div className="stats-table-wrap">
            <table className="stats-table">
              <thead>
                <tr>
                  <th>{uiText("Услуга / товар")}</th>
                  <th>{uiText("Обращения")}</th>
                  <th>{uiText("Продажи")}</th>
                  <th>{uiText("Конверсия")}</th>
                  <th>{uiText("Выручка")}</th>
                  <th>{uiText("Средний чек")}</th>
                </tr>
              </thead>
              <tbody>
                {(data.services || []).map((r: any) => (
                  <Fragment key={r.name}>
                    <tr>
                      <td>
                        <b>{r.label || r.name}</b>
                      </td>
                      <td>{r.inquiries}</td>
                      <td>
                        <button type="button" className="linkish" onClick={() => void openDrill("service_won", r.name)}>
                          {r.won}
                        </button>
                      </td>
                      <td>{r.conversion != null ? `${r.conversion}%` : "—"}</td>
                      <td>{r.revenueLabel || "—"}</td>
                      <td>{r.avgCheckLabel || "—"}</td>
                    </tr>
                    {(r.subcategories || []).map((sub: any) => (
                      <tr key={`${r.name}-${sub.name}`} className="stats-subrow">
                        <td>↳ {sub.name}</td>
                        <td>{sub.count}</td>
                        <td colSpan={4} />
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {tab === "losses" && data ? (
        <div className="sit-section">
          <div className="sit-section-head">
            <h3>{uiText("Потери")}</h3>
          </div>
          <div className="sit-kpi-grid stats-kpi-grid">
            <KpiCard label={uiText("Потери")} value={data.losses?.lost ?? 0} onClick={() => void openDrill("lost")} />
            <KpiCard label={uiText("Потерянная сумма")} value={data.losses?.lostAmountLabel || "—"} onClick={() => void openDrill("lost")} />
          </div>
          <h4>{uiText("Почему теряем")}</h4>
          <BarChart
            items={(data.losses?.reasons || []).map((r: any) => ({ name: r.reason, inquiries: r.count }))}
            valueKey="inquiries"
          />
          <div className="stats-table-wrap">
            <table className="stats-table">
              <thead>
                <tr>
                  <th>{uiText("Причина")}</th>
                  <th>{uiText("Количество")}</th>
                </tr>
              </thead>
              <tbody>
                {(data.losses?.reasons || []).map((r: any) => (
                  <tr key={r.reason}>
                    <td>{uiMessage(r.reason)}</td>
                    <td>
                      <button type="button" className="linkish" onClick={() => void openDrill("loss_reason", r.reason)}>
                        {r.count}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="stats-table-wrap">
            <table className="stats-table">
              <thead>
                <tr>
                  <th>{uiText("Стадия")}</th>
                  <th>{uiText("Потеряно")}</th>
                  <th>{uiText("Потенциальная сумма")}</th>
                </tr>
              </thead>
              <tbody>
                {(data.losses?.byStage || []).map((r: any) => (
                  <tr key={r.stage}>
                    <td>{r.stage}</td>
                    <td>
                      <button type="button" className="linkish" onClick={() => void openDrill("loss_stage", r.stage)}>
                        {r.count}
                      </button>
                    </td>
                    <td>{r.amountLabel || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {tab === "managers" && data ? (
        <div className="sit-section">
          <div className="sit-section-head">
            <h3>{uiText("Менеджеры")}</h3>
            <span className="muted">{uiText("По текущему ответственному и по сделке")}</span>
          </div>
          <div className="stats-table-wrap">
            <table className="stats-table">
              <thead>
                <tr>
                  <th>{uiText("Менеджер")}</th>
                  <th>{uiText("Заявки")}</th>
                  <th>{uiText("Продажи")}</th>
                  <th>{uiText("Потери")}</th>
                  <th>{uiText("Конверсия")}</th>
                  <th>{uiText("Выручка")}</th>
                  <th>{uiText("Ср. ответ")}</th>
                  <th>{uiText("Просрочки")}</th>
                  <th>{uiText("Без шага")}</th>
                  <th>{uiText("Цикл")}</th>
                </tr>
              </thead>
              <tbody>
                {(data.managers || []).map((m: any) => (
                  <tr key={m.id}>
                    <td>{m.name}</td>
                    <td>
                      <button type="button" className="linkish" onClick={() => void openDrill("manager_leads", m.id)}>
                        {m.leads}
                      </button>
                    </td>
                    <td>
                      <button type="button" className="linkish" onClick={() => void openDrill("manager_won", m.id)}>
                        {m.won}
                      </button>
                    </td>
                    <td>
                      <button type="button" className="linkish" onClick={() => void openDrill("manager_lost", m.id)}>
                        {m.lost}
                      </button>
                    </td>
                    <td>{m.conversion != null ? `${m.conversion}%` : "—"}</td>
                    <td>{m.revenueLabel || "—"}</td>
                    <td>{m.avgFirstResponseMin != null ? uiText("{p0} мин", {p0: m.avgFirstResponseMin}) : "—"}</td>
                    <td>{m.overdueTasks}</td>
                    <td>{m.noNextAction}</td>
                    <td>{m.avgCycleDays != null ? uiText("{p0} дн.", {p0: m.avgCycleDays}) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {tab === "tasks" && data ? (
        <div className="sit-section">
          <div className="sit-section-head">
            <h3>{uiText("Задачи")}</h3>
          </div>
          <div className="sit-kpi-grid stats-kpi-grid">
            <KpiCard label={uiText("Создано")} value={data.tasks?.created ?? 0} />
            <KpiCard label={uiText("Выполнено")} value={data.tasks?.done ?? 0} />
            <KpiCard label={uiText("В срок")} value={data.tasks?.doneOnTime ?? 0} />
            <KpiCard label={uiText("С просрочкой")} value={data.tasks?.doneLate ?? 0} />
            <KpiCard label={uiText("Открыто")} value={data.tasks?.open ?? 0} />
            <KpiCard label={uiText("Просрочено")} value={data.tasks?.overdue ?? 0} />
            <KpiCard label={uiText("Отменено")} value={data.tasks?.canceled ?? 0} />
            <KpiCard label={uiText("% в срок")} value={data.tasks?.onTimePct != null ? `${data.tasks.onTimePct}%` : "—"} />
          </div>
          <h4>{uiText("По типам")}</h4>
          <BarChart
            items={(data.tasks?.byType || []).map((t: any) => ({ name: t.type, inquiries: t.created, won: t.done }))}
            valueKey="inquiries"
          />
          <div className="stats-table-wrap">
            <table className="stats-table">
              <thead>
                <tr>
                  <th>{uiText("Тип")}</th>
                  <th>{uiText("Создано")}</th>
                  <th>{uiText("Выполнено")}</th>
                  <th>{uiText("Просрочено")}</th>
                </tr>
              </thead>
              <tbody>
                {(data.tasks?.byType || []).map((t: any) => (
                  <tr key={t.type}>
                    <td>{uiMessage(t.type)}</td>
                    <td>{t.created}</td>
                    <td>{t.done}</td>
                    <td>{t.overdue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h4>{uiText("Встречи и созвоны")}</h4>
          <div className="sit-kpi-grid stats-kpi-grid">
            <KpiCard label={uiText("Созвоны")} value={data.tasks?.meetings?.calls ?? 0} />
            <KpiCard label={uiText("Онлайн")} value={data.tasks?.meetings?.online ?? 0} />
            <KpiCard label={uiText("Личные")} value={data.tasks?.meetings?.offline ?? 0} />
            <KpiCard label={uiText("Состоялось")} value={data.tasks?.meetings?.done ?? 0} />
            <KpiCard label={uiText("Перенесено")} value={data.tasks?.meetings?.rescheduled ?? 0} />
            <KpiCard label={uiText("Отменено")} value={data.tasks?.meetings?.cancelled ?? 0} />
            <KpiCard label={uiText("Пропущено")} value={data.tasks?.meetings?.missed ?? 0} />
          </div>
        </div>
      ) : null}

      {tab === "communications" && data ? (
        <div className="sit-section">
          <div className="sit-section-head">
            <h3>{uiText("Коммуникации")}</h3>
          </div>
          <div className="sit-kpi-grid stats-kpi-grid">
            <KpiCard label={uiText("Входящие")} value={data.communications?.inbound ?? 0} />
            <KpiCard label={uiText("Исходящие")} value={data.communications?.outbound ?? 0} />
            <KpiCard label={uiText("Диалоги")} value={data.communications?.dialogs ?? 0} />
            <KpiCard
              label={uiText("Среднее время ответа")}
              value={data.communications?.avgResponseMin != null ? uiText("{p0} мин", {p0: data.communications.avgResponseMin}) : "—"}
            />
            <KpiCard label={uiText("Ожидали ответа больше 15 минут")} value={data.communications?.waitedOver15 ?? 0} />
            <KpiCard label={uiText("AI обработал")} value={data.communications?.aiHandled ?? 0} />
            <KpiCard label={uiText("Менеджер обработал")} value={data.communications?.staffHandled ?? 0} />
            <KpiCard label={uiText("Передано человеку")} value={data.communications?.handedToHuman ?? 0} />
          </div>
          <h4>{uiText("Время ответа")}</h4>
          <BarChart
            items={(data.communications?.responseBuckets || []).map((b: any) => ({
              name: b.key,
              inquiries: b.count,
            }))}
            valueKey="inquiries"
          />
        </div>
      ) : null}

      {tab === "ai" && data ? (
        <div className="sit-section">
          <div className="sit-section-head">
            <h3>{uiText("AI-менеджер")}</h3>
          </div>
          <div className="sit-kpi-grid stats-kpi-grid">
            <KpiCard label={uiText("Диалогов AI")} value={data.aiManager?.dialogs ?? 0} />
            <KpiCard label={uiText("Клиентов")} value={data.aiManager?.clients ?? 0} />
            <KpiCard label={uiText("С потребностью")} value={data.aiManager?.qualified ?? 0} />
            <KpiCard label={uiText("Задач из AI")} value={data.aiManager?.tasksCreated ?? 0} />
            <KpiCard label={uiText("Передано человеку")} value={data.aiManager?.handedToHuman ?? 0} />
            <KpiCard label={uiText("Дошло до сделки")} value={data.aiManager?.dealsReached ?? 0} />
            <KpiCard label={uiText("Продажи с AI")} value={data.aiManager?.won ?? 0} onClick={() => void openDrill("won")} />
          </div>
          <p className="stats-funnel-mini">
            {data.aiManager?.funnel?.clients ?? 0} → {data.aiManager?.funnel?.qualified ?? 0} →{" "}
            {data.aiManager?.funnel?.deals ?? 0} → {data.aiManager?.funnel?.won ?? 0}
          </p>
          <p className="muted">{uiText("Клиенты → потребность → сделки → продажи")}</p>
          <h4>{uiText("Причины передачи человеку")}</h4>
          <BarChart
            items={(data.aiManager?.handoffReasons || []).map((r: any) => ({ name: r.reason, inquiries: r.count }))}
            valueKey="inquiries"
          />
        </div>
      ) : null}

      {tab === "campaigns" && data ? (
        <div className="sit-section">
          <div className="sit-section-head">
            <h3>{uiText("Рассылки")}</h3>
          </div>
          {(data.campaigns || []).length === 0 ? (
            <p className="empty">{uiText("За период рассылок нет.")}</p>
          ) : (
            <>
              <div className="stats-table-wrap">
                <table className="stats-table">
                  <thead>
                    <tr>
                      <th>{uiText("Рассылка")}</th>
                      <th>{uiText("Получатели")}</th>
                      <th>{uiText("Доставлено")}</th>
                      <th>{uiText("Прочитано")}</th>
                      <th>{uiText("Ответили")}</th>
                      <th>{uiText("Заявки")}</th>
                      <th>{uiText("Сделки")}</th>
                      <th>{uiText("Продажи")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.campaigns || []).map((c: any) => (
                      <tr key={c.id}>
                        <td>{c.title}</td>
                        <td>{c.recipients}</td>
                        <td>{c.delivered}</td>
                        <td>{c.read}</td>
                        <td>{c.replied}</td>
                        <td>{c.inquiries}</td>
                        <td>{c.deals}</td>
                        <td>{c.won}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {(data.campaigns || []).slice(0, 3).map((c: any) => (
                <div key={`funnel-${c.id}`} className="stats-campaign-funnel">
                  <b>{c.title}</b>
                  <p className="stats-funnel-mini">
                    {c.funnel.recipients} → {c.funnel.delivered} → {c.funnel.read} → {c.funnel.replied} →{" "}
                    {c.funnel.inquiries} → {c.funnel.deals} → {c.funnel.won}
                  </p>
                  <p className="muted">{uiText("получатели → доставлено → прочитано → ответили → заявки → сделки → продажи")}</p>
                </div>
              ))}
            </>
          )}
        </div>
      ) : null}

      </div>
      {drill ? (
        <StatsDialog title={drill.title || uiText("Детализация")} onClose={closeDrill} wide>
            <p className="muted">{drillLoading ? uiText("Загрузка…") : uiText("Всего: {p0}", {p0: drill.total ?? drill.items?.length ?? 0})}</p>
            <div className="stats-table-wrap">
              <table className="stats-table">
                <thead>
                  <tr>
                    <th>{uiText("Дата")}</th>
                    <th>{uiText("Клиент")}</th>
                    <th>{uiText("Телефон")}</th>
                    <th>{uiText("Название")}</th>
                    <th>{uiText("Сумма")}</th>
                    <th>{uiText("Статус")}</th>
                    <th>{uiText("Менеджер")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {(drill.items || []).map((item: any) => (
                    <tr key={`${item.kind}-${item.id}`}>
                      <td>{item.date ? new Date(item.date).toLocaleDateString(uiFormatLocale()) : "—"}</td>
                      <td>{item.client}</td>
                      <td>{item.phone || uiText("Нет телефона")}</td>
                      <td>{item.title}</td>
                      <td>{item.amountLabel || "—"}</td>
                      <td>{item.status ? uiMessage(RECORD_STATUSES[item.status] || item.status) : item.source || "—"}</td>
                      <td>{item.manager || "—"}</td>
                      <td>
                        {item.href ? (
                          <Link to={item.href} onClick={closeDrill}>
                            {uiText("Открыть")}</Link>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!drillLoading && !(drill.items || []).length ? <p className="empty">{uiText("Список пуст.")}</p> : null}
        </StatsDialog>
      ) : null}

      {exportOpen ? (
        <StatsDialog title={uiText("Скачать отчёт")} onClose={() => setExportOpen(false)}>
            <p className="muted">{uiText("Включить в отчёт")}</p>
            <div className="stats-export-checks">
              {(
                [
                  ["overview", uiText("Общий результат")],
                  ["funnel", uiText("Этапы")],
                  ["sources", uiText("Источники")],
                  ["services", uiText("Услуги и товары")],
                  ["sales", uiText("Продажи")],
                  ["losses", uiText("Потери")],
                ] as const
              ).map(([key, label]) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={sections[key]}
                    onChange={(e) => setSections((s) => ({ ...s, [key]: e.target.checked }))}
                  />
                  {label}
                </label>
              ))}
            </div>
            <div className="row" style={{ gap: 8, marginTop: 12 }}>
              <button
                type="button"
                className="btn"
                disabled={!Object.values(sections).some(Boolean)}
                onClick={() => {
                  exportAnalyticsPdf(data, sections);
                  setExportOpen(false);
                }}
              >
                PDF
              </button>
              <button
                type="button"
                className="btn secondary"
                disabled={!Object.values(sections).some(Boolean)}
                onClick={() => {
                  exportAnalyticsExcel(data, sections);
                  setExportOpen(false);
                }}
              >
                Excel
              </button>
              <button
                type="button"
                className="btn secondary"
                onClick={() => {
                  exportAnalyticsCsv(data, "funnel");
                  setExportOpen(false);
                }}
              >
                {uiText("CSV этапов")}</button>
              <button type="button" className="btn secondary" onClick={() => setExportOpen(false)}>
                {uiText("Отмена")}</button>
            </div>
        </StatsDialog>
      ) : null}
    </section>
  );
}
