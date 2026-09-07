import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { PeriodSelector, type PeriodPreset } from "../components/PeriodSelector";
import { api } from "../lib/api";
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
  { id: "funnel", label: "Воронка" },
  { id: "sales", label: "Продажи" },
  { id: "sources", label: "Источники" },
  { id: "services", label: "Услуги" },
  { id: "managers", label: "Менеджеры" },
  { id: "communications", label: "Коммуникации" },
  { id: "tasks", label: "Задачи" },
  { id: "ai", label: "AI Manager" },
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

function formatChartValue(value: number, metric: TrendMetric) {
  if (metric === "conversion") return `${value}%`;
  if (metric === "revenue") return value.toLocaleString("ru-RU");
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
  return unit === "pp" ? `${arrow} ${abs} п.п.` : `${arrow} ${abs}%`;
}

function formatHours(hours: number | null | undefined) {
  if (hours == null) return "—";
  if (hours < 1) return `${Math.round(hours * 60)} мин`;
  if (hours < 48) return `${Math.round(hours * 10) / 10} ч`;
  return `${Math.round((hours / 24) * 10) / 10} дн.`;
}

function LineChart({
  points,
  comparePoints,
  label,
  metric,
}: {
  points: { label: string; value: number }[];
  comparePoints?: { value: number }[] | null;
  label: string;
  metric: TrendMetric;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (!points.length) {
    return <p className="empty">Пока недостаточно данных для графика.</p>;
  }
  const w = 720;
  const h = 260;
  const padL = 48;
  const padR = 16;
  const padT = 20;
  const padB = 44;
  const values = [...points.map((p) => p.value), ...(comparePoints || []).map((p) => p.value)];
  const max = Math.max(...values, 1);
  const ticks = yAxisTicks(max);
  const scaleMax = Math.max(max, ticks[ticks.length - 1] || 1);
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const stepX = points.length > 1 ? innerW / (points.length - 1) : innerW / 2;
  const toX = (i: number) => padL + (points.length > 1 ? i * stepX : innerW / 2);
  const toY = (v: number) => padT + innerH - (v / scaleMax) * innerH;
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"} ${toX(i)} ${toY(p.value)}`).join(" ");
  const area = `${path} L ${toX(points.length - 1)} ${toY(0)} L ${toX(0)} ${toY(0)} Z`;
  const comparePath =
    comparePoints && comparePoints.length
      ? comparePoints
          .slice(0, points.length)
          .map((p, i) => `${i === 0 ? "M" : "L"} ${toX(i)} ${toY(p.value)}`)
          .join(" ")
      : null;
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));

  return (
    <div className="stats-chart-wrap">
      <svg viewBox={`0 0 ${w} ${h}`} className="stats-line-chart" role="img" aria-label={label}>
        {ticks.map((tick) => (
          <g key={`tick-${tick}`}>
            <line x1={padL} y1={toY(tick)} x2={w - padR} y2={toY(tick)} className="stats-grid" />
            <text x={padL - 8} y={toY(tick) + 4} textAnchor="end" className="stats-tick">
              {formatChartValue(tick, metric)}
            </text>
          </g>
        ))}
        <line x1={padL} y1={h - padB} x2={w - padR} y2={h - padB} className="stats-axis" />
        <line x1={padL} y1={padT} x2={padL} y2={h - padB} className="stats-axis" />
        <path d={area} className="stats-area" />
        {comparePath ? <path d={comparePath} className="stats-line-compare" fill="none" /> : null}
        <path d={path} className="stats-line" fill="none" />
        {points.map((p, i) => {
          const showLabel = i === 0 || i === points.length - 1 || i % labelEvery === 0;
          return (
            <g key={p.label + i}>
              <circle
                cx={toX(i)}
                cy={toY(p.value)}
                r={hover === i ? 5 : 3.5}
                className="stats-dot"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              >
                <title>
                  {p.label}: {formatChartValue(p.value, metric)}
                </title>
              </circle>
              {points.length <= 16 ? (
                <text x={toX(i)} y={toY(p.value) - 8} textAnchor="middle" className="stats-dot-value">
                  {formatChartValue(p.value, metric)}
                </text>
              ) : null}
              {showLabel ? (
                <text x={toX(i)} y={h - padB + 16} textAnchor="middle" className="stats-tick">
                  {p.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <div className="stats-chart-legend muted">
        <span>● Текущий период</span>
        {comparePath ? <span>○ Сравнение</span> : null}
        {hover != null ? (
          <span>
            {points[hover].label}: {formatChartValue(points[hover].value, metric)}
          </span>
        ) : null}
      </div>
      {points.length <= 31 ? (
        <div className="stats-day-table-wrap">
          <table className="stats-day-table">
            <thead>
              <tr>
                {points.map((p, i) => (
                  <th key={`h-${p.label}-${i}`}>{p.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                {points.map((p, i) => (
                  <td key={`v-${p.label}-${i}`}>{formatChartValue(p.value, metric)}</td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function BarChart({
  items,
  valueKey,
}: {
  items: { name: string; inquiries?: number; won?: number; revenue?: number; conversion?: number | null }[];
  valueKey: BarMetric;
}) {
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
    .slice(0, 12);
  if (!rows.length) return <p className="empty">Нет данных для диаграммы.</p>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className="stats-bars">
      {rows.map((r) => (
        <div className="stats-bar-row" key={r.name}>
          <span className="stats-bar-label" title={r.name}>
            {r.name}
          </span>
          <div className="stats-bar-track">
            <div className="stats-bar-fill" style={{ width: `${Math.max(4, (r.value / max) * 100)}%` }} />
          </div>
          <span className="stats-bar-value">
            {valueKey === "conversion" ? `${r.value}%` : valueKey === "revenue" ? r.value.toLocaleString("ru-RU") : r.value}
          </span>
        </div>
      ))}
    </div>
  );
}

function KpiCard({
  label,
  value,
  delta,
  deltaUnit = "%",
  onClick,
}: {
  label: string;
  value: ReactNode;
  delta?: number | null;
  deltaUnit?: "%" | "pp";
  onClick?: () => void;
}) {
  const d = deltaLabel(delta, deltaUnit);
  const inner = (
    <>
      <span className="muted">{label}</span>
      <strong>{value}</strong>
      {d ? <span className={`kpi-delta ${delta && delta < 0 ? "down" : ""}`}>{d}</span> : null}
      {onClick ? <span className="kpi-hint">Открыть список</span> : null}
    </>
  );
  if (onClick) {
    return (
      <button type="button" className="sit-kpi stats-kpi-btn" onClick={onClick}>
        {inner}
      </button>
    );
  }
  return <div className="sit-kpi">{inner}</div>;
}

export function StatsPage() {
  const [tab, setTab] = useState<TabId>("overview");
  const [period, setPeriod] = useState<PeriodPreset>("this_month");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
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
  const [trend, setTrend] = useState<any>(null);
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
    try {
      setDrillLoading(true);
      setDrill({ title: "Загрузка…", items: [] });
      const res = await api.analyticsDrilldown({ ...query, entity, key });
      setDrill(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось открыть детализацию");
      setDrill(null);
    } finally {
      setDrillLoading(false);
    }
  }

  async function load() {
    try {
      if (period === "custom" && (!dateFrom || !dateTo)) {
        setError("Укажите даты С и По");
        setLoading(false);
        return;
      }
      setLoading(true);
      const [dash, tr] = await Promise.all([
        api.analyticsDashboard(query),
        api.analyticsTrend({ ...query, metric: trendMetric }),
      ]);
      setData(dash);
      setTrend(tr);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка загрузки");
    } finally {
      setLoading(false);
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
  }, [query, trendMetric]);

  const trendPoints = (trend?.points || data?.trend?.points || []).map((p: any) => ({
    label: p.label,
    value: Number(p.value) || 0,
  }));
  const comparePoints =
    compare !== "none" && data?.trendCompare?.points
      ? data.trendCompare.points.map((p: any) => {
          const metric = trendMetric;
          const value =
            metric === "inquiries"
              ? p.inquiries
              : metric === "clients"
                ? p.clients
                : metric === "deals"
                  ? p.deals
                  : metric === "won"
                    ? p.won
                    : metric === "revenue"
                      ? p.revenue
                      : p.conversion || 0;
          return { value: Number(value) || 0 };
        })
      : null;

  if (loading && !data) return <div className="state">Загрузка статистики…</div>;
  if (!data && error) {
    return (
      <section>
        <p className="error">{error}</p>
        <button type="button" className="btn" onClick={() => void load()}>
          Повторить
        </button>
      </section>
    );
  }

  const o = data?.overview || {};
  const sales = data?.sales || {};

  return (
    <section className="stats-page">
      <div className="row sit-head">
        <div>
          <h2>Статистика</h2>
          <p className="muted">Что произошло, почему и где эффективность выше или ниже</p>
        </div>
        <div className="sit-toolbar-side">
          <button type="button" className="btn secondary" onClick={() => setFiltersOpen((v) => !v)}>
            Фильтры
          </button>
          <button type="button" className="btn" onClick={() => setExportOpen(true)}>
            Скачать отчёт
          </button>
        </div>
      </div>

      <div className="sit-toolbar">
        <PeriodSelector
          period={period}
          onPeriodChange={setPeriod}
          dateFrom={dateFrom}
          dateTo={dateTo}
          onDateFromChange={setDateFrom}
          onDateToChange={setDateTo}
          activeLabel={data?.period?.label}
        />
        <label className="stats-compare">
          Сравнить с
          <select value={compare} onChange={(e) => setCompare(e.target.value as CompareMode)}>
            <option value="previous">Предыдущим периодом</option>
            <option value="last_month">Прошлым месяцем</option>
            <option value="last_year">Прошлым годом</option>
            <option value="none">Не сравнивать</option>
          </select>
        </label>
      </div>

      {filtersOpen ? (
        <div className="stats-filters">
          <label>
            Ответственный
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">Все</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Услуга
            <input value={serviceCategory} onChange={(e) => setServiceCategory(e.target.value)} placeholder="Сайты" />
          </label>
          <label>
            Источник
            <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="Google Ads" />
          </label>
          <label>
            Канал
            <input value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="WhatsApp" />
          </label>
          <label>
            Город
            <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Алматы" />
          </label>
          <label>
            Кампания
            <input value={campaign} onChange={(e) => setCampaign(e.target.value)} placeholder="utm_campaign" />
          </label>
        </div>
      ) : null}

      {error ? <p className="error">{error}</p> : null}

      <div className="stats-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? "btn sit-chip" : "btn secondary sit-chip"}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {data?.empty ? (
        <div className="sit-section">
          <h3>Пока недостаточно данных для построения отчёта</h3>
          <p className="muted">
            После появления первых сделок здесь будет показана конверсия, динамика продаж и эффективность источников.
          </p>
        </div>
      ) : null}

      {tab === "overview" && data ? (
        <>
          <div className="sit-section">
            <div className="sit-section-head">
              <h3>Обзор · {data.period?.label}</h3>
              {data.compare?.label ? <span className="muted">vs {data.compare.label}</span> : null}
            </div>
            <div className="sit-kpi-grid stats-kpi-grid">
              <KpiCard label="Обращения" value={o.inquiries} delta={o.deltas?.inquiries} onClick={() => void openDrill("inquiries")} />
              <KpiCard label="Уникальные клиенты" value={o.clients} onClick={() => void openDrill("clients")} />
              <KpiCard label="Заявки" value={o.requests} onClick={() => void openDrill("inquiries")} />
              <KpiCard label="Создано сделок" value={o.dealsCreated} onClick={() => void openDrill("deals")} />
              <KpiCard label="Договоры" value={o.contracts} />
              <KpiCard label="Продажи" value={o.won} delta={o.deltas?.won} onClick={() => void openDrill("won")} />
              <KpiCard label="Продано" value={o.revenueLabel || "—"} delta={o.deltas?.revenue} onClick={() => void openDrill("won")} />
              <KpiCard label="Конверсия" value={o.conversion != null ? `${o.conversion}%` : "—"} delta={o.deltas?.conversionPp} deltaUnit="pp" />
              <KpiCard label="Средний чек" value={o.avgCheckLabel || "—"} />
              <KpiCard label="Потеряно" value={o.lost} onClick={() => void openDrill("lost")} />
            </div>
            {data.dataQuality ? (
              <p className="muted stats-quality-hint">
                Качество данных: без телефона {data.dataQuality.noPhone}, без источника {data.dataQuality.noSource}, без
                ответственного {data.dataQuality.noOwner}, LOST без причины {data.dataQuality.lostNoReason}, без next
                action {data.dataQuality.openNoNextAction}
              </p>
            ) : null}
          </div>

          <div className="sit-section">
            <div className="sit-section-head">
              <h3>Динамика</h3>
              <div className="stats-metric-switch">
                {TREND_METRICS.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={trendMetric === m.id ? "btn sit-chip" : "btn secondary sit-chip"}
                    onClick={() => setTrendMetric(m.id)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
            <LineChart
              points={trendPoints}
              comparePoints={comparePoints}
              metric={trendMetric}
              label={`Динамика: ${TREND_METRICS.find((m) => m.id === trendMetric)?.label}`}
            />
          </div>

          <div className="stats-overview-split">
            <div className="sit-section">
              <div className="sit-section-head">
                <h3>Воронка</h3>
              </div>
              <p className="stats-funnel-mini">
                {(data.funnel?.steps || []).map((s: any) => s.count).join(" → ")}
              </p>
              {data.biggestLoss ? (
                <p className="muted">
                  Самая большая потеря: {data.biggestLoss.from} → {data.biggestLoss.to} ({data.biggestLoss.lost})
                </p>
              ) : null}
              <button type="button" className="btn secondary" onClick={() => setTab("funnel")}>
                Открыть воронку
              </button>
            </div>
            <div className="sit-section">
              <div className="sit-section-head">
                <h3>Источники</h3>
              </div>
              <BarChart items={data.sources || []} valueKey="inquiries" />
              <button type="button" className="btn secondary" onClick={() => setTab("sources")}>
                Подробнее
              </button>
            </div>
            <div className="sit-section">
              <div className="sit-section-head">
                <h3>Услуги</h3>
              </div>
              <BarChart items={data.services || []} valueKey="revenue" />
              <button type="button" className="btn secondary" onClick={() => setTab("services")}>
                Подробнее
              </button>
            </div>
          </div>
        </>
      ) : null}

      {tab === "funnel" && data ? (
        <div className="sit-section">
          <div className="sit-section-head">
            <h3>Воронка продаж</h3>
            <div className="stats-metric-switch">
              <button
                type="button"
                className={funnelMode === "events" ? "btn sit-chip" : "btn secondary sit-chip"}
                onClick={() => setFunnelMode("events")}
              >
                События периода
              </button>
              <button
                type="button"
                className={funnelMode === "cohort" ? "btn sit-chip" : "btn secondary sit-chip"}
                onClick={() => setFunnelMode("cohort")}
              >
                Когорта обращений
              </button>
            </div>
          </div>
          <div className="stats-funnel-steps">
            {(data.funnel?.steps || []).map((s: any, i: number) => (
              <div key={s.key} className="stats-funnel-step">
                <div>
                  <b>{s.name}</b>
                  <div className="muted">
                    {s.fromStartPct != null ? `${s.fromStartPct}% от начала` : null}
                    {i > 0 && s.fromPrevPct != null ? ` · ${s.fromPrevPct}% от предыдущего` : null}
                  </div>
                </div>
                <strong>{s.count}</strong>
              </div>
            ))}
          </div>

          <h4>Потери между этапами</h4>
          <div className="stats-table-wrap">
            <table className="stats-table">
              <thead>
                <tr>
                  <th>Переход</th>
                  <th>Было</th>
                  <th>Перешло</th>
                  <th>Потеря</th>
                  <th>Конверсия</th>
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

          <h4>Время прохождения</h4>
          <div className="stats-table-wrap">
            <table className="stats-table">
              <thead>
                <tr>
                  <th>Стадия</th>
                  <th>Среднее</th>
                  <th>Медиана</th>
                  <th>Зависших</th>
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
            <KpiCard label="Средний цикл продажи" value={sales.cycle?.avgDays != null ? `${sales.cycle.avgDays} дн.` : "—"} />
            <KpiCard label="Медианный цикл" value={sales.cycle?.medianDays != null ? `${sales.cycle.medianDays} дн.` : "—"} />
            <KpiCard label="Самая быстрая" value={sales.cycle?.minDays != null ? `${sales.cycle.minDays} дн.` : "—"} />
            <KpiCard label="Самая длинная" value={sales.cycle?.maxDays != null ? `${sales.cycle.maxDays} дн.` : "—"} />
          </div>
        </div>
      ) : null}

      {tab === "sales" && data ? (
        <div className="sit-section">
          <div className="sit-section-head">
            <h3>Продажи</h3>
          </div>
          <div className="sit-kpi-grid stats-kpi-grid">
            <KpiCard label="WON" value={sales.won} onClick={() => void openDrill("won")} />
            <KpiCard label="Продано" value={sales.revenueLabel || "—"} onClick={() => void openDrill("won")} />
            <KpiCard label="Средний чек" value={sales.avgCheckLabel || "—"} />
            <KpiCard label="Медианный чек" value={sales.medianCheckLabel || "—"} />
            <KpiCard label="Максимальная сделка" value={sales.maxCheckLabel || "—"} />
            <KpiCard label="Pipeline" value={sales.pipelineLabel || "—"} />
            <KpiCard label="Взвешенный pipeline" value={sales.weightedPipelineLabel || "—"} />
          </div>
          <div className="stats-metric-switch">
            {(["won", "revenue"] as TrendMetric[]).map((m) => (
              <button
                key={m}
                type="button"
                className={trendMetric === m ? "btn sit-chip" : "btn secondary sit-chip"}
                onClick={() => setTrendMetric(m)}
              >
                {m === "won" ? "Количество продаж" : "Сумма продаж"}
              </button>
            ))}
          </div>
          <LineChart points={trendPoints} comparePoints={comparePoints} metric={trendMetric} label="Продажи по времени" />
        </div>
      ) : null}

      {tab === "sources" && data ? (
        <div className="sit-section">
          <div className="sit-section-head">
            <h3>Источники привлечения</h3>
            <div className="stats-metric-switch">
              {(
                [
                  ["inquiries", "По обращениям"],
                  ["won", "По продажам"],
                  ["revenue", "По выручке"],
                  ["conversion", "По конверсии"],
                ] as [BarMetric, string][]
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={sourceBar === id ? "btn sit-chip" : "btn secondary sit-chip"}
                  onClick={() => setSourceBar(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <BarChart items={data.sources || []} valueKey={sourceBar} />
          <div className="stats-table-wrap">
            <table className="stats-table">
              <thead>
                <tr>
                  <th>Источник</th>
                  <th>Обращения</th>
                  <th>Сделки</th>
                  <th>Продажи</th>
                  <th>Конверсия</th>
                  <th>Выручка</th>
                  <th>Средний чек</th>
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
          <button type="button" className="btn secondary" onClick={() => exportAnalyticsCsv(data, "sources")}>
            CSV источников
          </button>
        </div>
      ) : null}

      {tab === "services" && data ? (
        <div className="sit-section">
          <div className="sit-section-head">
            <h3>Услуги</h3>
            <div className="stats-metric-switch">
              {(
                [
                  ["revenue", "Выручка"],
                  ["won", "Продажи"],
                  ["inquiries", "Обращения"],
                  ["conversion", "Конверсия"],
                ] as [BarMetric, string][]
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={serviceBar === id ? "btn sit-chip" : "btn secondary sit-chip"}
                  onClick={() => setServiceBar(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <BarChart items={data.services || []} valueKey={serviceBar} />
          <div className="stats-table-wrap">
            <table className="stats-table">
              <thead>
                <tr>
                  <th>Услуга</th>
                  <th>Обращения</th>
                  <th>Продажи</th>
                  <th>Конверсия</th>
                  <th>Выручка</th>
                  <th>Средний чек</th>
                </tr>
              </thead>
              <tbody>
                {(data.services || []).map((r: any) => (
                  <Fragment key={r.name}>
                    <tr>
                      <td>
                        <b>{r.name}</b>
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
            <h3>Потери</h3>
          </div>
          <div className="sit-kpi-grid stats-kpi-grid">
            <KpiCard label="LOST" value={data.losses?.lost ?? 0} onClick={() => void openDrill("lost")} />
            <KpiCard label="Потерянная сумма" value={data.losses?.lostAmountLabel || "—"} onClick={() => void openDrill("lost")} />
          </div>
          <h4>Почему теряем</h4>
          <BarChart
            items={(data.losses?.reasons || []).map((r: any) => ({ name: r.reason, inquiries: r.count }))}
            valueKey="inquiries"
          />
          <div className="stats-table-wrap">
            <table className="stats-table">
              <thead>
                <tr>
                  <th>Причина</th>
                  <th>Количество</th>
                </tr>
              </thead>
              <tbody>
                {(data.losses?.reasons || []).map((r: any) => (
                  <tr key={r.reason}>
                    <td>{r.reason}</td>
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
                  <th>Стадия</th>
                  <th>Потеряно</th>
                  <th>Потенциальная сумма</th>
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
            <h3>Менеджеры</h3>
            <span className="muted">Attribution: текущий ответственный / ответственный на сделке</span>
          </div>
          <div className="stats-table-wrap">
            <table className="stats-table">
              <thead>
                <tr>
                  <th>Менеджер</th>
                  <th>Лиды</th>
                  <th>WON</th>
                  <th>LOST</th>
                  <th>Конверсия</th>
                  <th>Выручка</th>
                  <th>Ср. ответ</th>
                  <th>Просрочки</th>
                  <th>Без next</th>
                  <th>Цикл</th>
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
                    <td>{m.avgFirstResponseMin != null ? `${m.avgFirstResponseMin} мин` : "—"}</td>
                    <td>{m.overdueTasks}</td>
                    <td>{m.noNextAction}</td>
                    <td>{m.avgCycleDays != null ? `${m.avgCycleDays} дн.` : "—"}</td>
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
            <h3>Задачи</h3>
          </div>
          <div className="sit-kpi-grid stats-kpi-grid">
            <KpiCard label="Создано" value={data.tasks?.created ?? 0} />
            <KpiCard label="Выполнено" value={data.tasks?.done ?? 0} />
            <KpiCard label="В срок" value={data.tasks?.doneOnTime ?? 0} />
            <KpiCard label="С просрочкой" value={data.tasks?.doneLate ?? 0} />
            <KpiCard label="Открыто" value={data.tasks?.open ?? 0} />
            <KpiCard label="Просрочено" value={data.tasks?.overdue ?? 0} />
            <KpiCard label="Отменено" value={data.tasks?.canceled ?? 0} />
            <KpiCard label="% в срок" value={data.tasks?.onTimePct != null ? `${data.tasks.onTimePct}%` : "—"} />
          </div>
          <h4>По типам</h4>
          <BarChart
            items={(data.tasks?.byType || []).map((t: any) => ({ name: t.type, inquiries: t.created, won: t.done }))}
            valueKey="inquiries"
          />
          <div className="stats-table-wrap">
            <table className="stats-table">
              <thead>
                <tr>
                  <th>Тип</th>
                  <th>Создано</th>
                  <th>Выполнено</th>
                  <th>Просрочено</th>
                </tr>
              </thead>
              <tbody>
                {(data.tasks?.byType || []).map((t: any) => (
                  <tr key={t.type}>
                    <td>{t.type}</td>
                    <td>{t.created}</td>
                    <td>{t.done}</td>
                    <td>{t.overdue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h4>Встречи и созвоны</h4>
          <div className="sit-kpi-grid stats-kpi-grid">
            <KpiCard label="Созвоны" value={data.tasks?.meetings?.calls ?? 0} />
            <KpiCard label="Онлайн" value={data.tasks?.meetings?.online ?? 0} />
            <KpiCard label="Личные" value={data.tasks?.meetings?.offline ?? 0} />
            <KpiCard label="Состоялось" value={data.tasks?.meetings?.done ?? 0} />
            <KpiCard label="Перенесено" value={data.tasks?.meetings?.rescheduled ?? 0} />
            <KpiCard label="Отменено" value={data.tasks?.meetings?.cancelled ?? 0} />
            <KpiCard label="Пропущено" value={data.tasks?.meetings?.missed ?? 0} />
          </div>
        </div>
      ) : null}

      {tab === "communications" && data ? (
        <div className="sit-section">
          <div className="sit-section-head">
            <h3>Коммуникации</h3>
          </div>
          <div className="sit-kpi-grid stats-kpi-grid">
            <KpiCard label="Входящие" value={data.communications?.inbound ?? 0} />
            <KpiCard label="Исходящие" value={data.communications?.outbound ?? 0} />
            <KpiCard label="Диалоги" value={data.communications?.dialogs ?? 0} />
            <KpiCard
              label="Среднее время ответа"
              value={data.communications?.avgResponseMin != null ? `${data.communications.avgResponseMin} мин` : "—"}
            />
            <KpiCard label="Ждали &gt;15 мин" value={data.communications?.waitedOver15 ?? 0} />
            <KpiCard label="AI обработал" value={data.communications?.aiHandled ?? 0} />
            <KpiCard label="Менеджер обработал" value={data.communications?.staffHandled ?? 0} />
            <KpiCard label="AI → Human" value={data.communications?.handedToHuman ?? 0} />
          </div>
          <h4>Время ответа</h4>
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
            <h3>AI Manager</h3>
          </div>
          <div className="sit-kpi-grid stats-kpi-grid">
            <KpiCard label="Диалогов AI" value={data.aiManager?.dialogs ?? 0} />
            <KpiCard label="Клиентов" value={data.aiManager?.clients ?? 0} />
            <KpiCard label="Квалифицировано" value={data.aiManager?.qualified ?? 0} />
            <KpiCard label="Задач из AI" value={data.aiManager?.tasksCreated ?? 0} />
            <KpiCard label="Передано человеку" value={data.aiManager?.handedToHuman ?? 0} />
            <KpiCard label="Дошло до сделки" value={data.aiManager?.dealsReached ?? 0} />
            <KpiCard label="WON среди AI" value={data.aiManager?.won ?? 0} onClick={() => void openDrill("won")} />
          </div>
          <p className="stats-funnel-mini">
            {data.aiManager?.funnel?.clients ?? 0} → {data.aiManager?.funnel?.qualified ?? 0} →{" "}
            {data.aiManager?.funnel?.deals ?? 0} → {data.aiManager?.funnel?.won ?? 0}
          </p>
          <p className="muted">Клиенты AI → квалификация → сделки → продажи</p>
          <h4>Причины передачи человеку</h4>
          <BarChart
            items={(data.aiManager?.handoffReasons || []).map((r: any) => ({ name: r.reason, inquiries: r.count }))}
            valueKey="inquiries"
          />
        </div>
      ) : null}

      {tab === "campaigns" && data ? (
        <div className="sit-section">
          <div className="sit-section-head">
            <h3>Рассылки</h3>
          </div>
          {(data.campaigns || []).length === 0 ? (
            <p className="empty">За период рассылок нет.</p>
          ) : (
            <>
              <div className="stats-table-wrap">
                <table className="stats-table">
                  <thead>
                    <tr>
                      <th>Рассылка</th>
                      <th>Получатели</th>
                      <th>Доставлено</th>
                      <th>Прочитано</th>
                      <th>Ответили</th>
                      <th>Заявки</th>
                      <th>Сделки</th>
                      <th>Продажи</th>
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
                  <p className="muted">получатели → доставлено → прочитано → ответили → заявки → сделки → продажи</p>
                </div>
              ))}
            </>
          )}
        </div>
      ) : null}

      {drill ? (
        <div className="stats-modal-backdrop" onClick={() => setDrill(null)}>
          <div className="stats-modal stats-drill-modal" onClick={(e) => e.stopPropagation()}>
            <div className="sit-section-head">
              <h3>{drill.title || "Детализация"}</h3>
              <button type="button" className="btn secondary sit-chip" onClick={() => setDrill(null)}>
                Закрыть
              </button>
            </div>
            <p className="muted">{drillLoading ? "Загрузка…" : `Всего: ${drill.total ?? drill.items?.length ?? 0}`}</p>
            <div className="stats-table-wrap">
              <table className="stats-table">
                <thead>
                  <tr>
                    <th>Дата</th>
                    <th>Клиент</th>
                    <th>Телефон</th>
                    <th>Название</th>
                    <th>Сумма</th>
                    <th>Статус</th>
                    <th>Менеджер</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {(drill.items || []).map((item: any) => (
                    <tr key={`${item.kind}-${item.id}`}>
                      <td>{item.date ? new Date(item.date).toLocaleDateString("ru-RU") : "—"}</td>
                      <td>{item.client}</td>
                      <td>{item.phone || "Нет телефона"}</td>
                      <td>{item.title}</td>
                      <td>{item.amountLabel || "—"}</td>
                      <td>{item.status || item.source || "—"}</td>
                      <td>{item.manager || "—"}</td>
                      <td>
                        {item.href ? (
                          <Link to={item.href} onClick={() => setDrill(null)}>
                            Открыть
                          </Link>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!drillLoading && !(drill.items || []).length ? <p className="empty">Список пуст.</p> : null}
          </div>
        </div>
      ) : null}

      {exportOpen ? (
        <div className="stats-modal-backdrop" onClick={() => setExportOpen(false)}>
          <div className="stats-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Скачать отчёт</h3>
            <p className="muted">Включить в отчёт</p>
            <div className="stats-export-checks">
              {(
                [
                  ["overview", "Общий результат"],
                  ["funnel", "Воронка"],
                  ["sources", "Источники"],
                  ["services", "Услуги"],
                  ["sales", "Продажи"],
                  ["losses", "Потери"],
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
                CSV воронки
              </button>
              <button type="button" className="btn secondary" onClick={() => setExportOpen(false)}>
                Отмена
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
