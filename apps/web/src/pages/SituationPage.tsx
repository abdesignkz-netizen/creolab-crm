import { notifySaved } from "../components/SaveNotice";
import { useUrlState, useRequestVersion } from "../lib/useUrlState";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PeriodSelector, type PeriodPreset } from "../components/PeriodSelector";
import { nameWithPhone } from "../lib/contactDisplay";
import { formatDurationMinutes } from "../lib/duration";
import { api } from "../lib/api";
import { useCapabilities, useSession } from "../lib/session";

type Scope = "all" | "mine" | "unassigned";

const ACTION_LABEL: Record<string, string> = {
  complete_phone: "Дописать контакт",
  accept_inquiry: "Взять в работу",
  open_inquiry: "Открыть заявку",
  take_conversation: "Забрать себе",
  reply_human: "Ответить",
  return_to_ai: "Вернуть AI",
  resume_paused: "Снять паузу",
  complete_task: "Закрыть задачу",
  assign_owner: "Назначить себе",
  instruct_ai: "Поручить AI",
  open_contact: "Открыть клиента",
  create_next_action: "Задать шаг",
  open_deal: "Открыть сделку",
};

function deltaText(value: number | null | undefined, percent?: number | null) {
  const parts: string[] = [];
  if (percent != null && percent !== 0) parts.push(`${percent > 0 ? "+" : ""}${percent}%`);
  if (value != null && value !== 0) parts.push(value > 0 ? `↑ ${value}` : `↓ ${Math.abs(value)}`);
  return parts.length ? parts.join(" · ") : null;
}

const ASK_PRESETS = [
  "Что сегодня требует моего внимания?",
  "Какие сделки зависли?",
  "Какие заявки не обработаны?",
  "Что изменилось сегодня?",
  "У кого высокая нагрузка?",
  "Где теряются клиенты?",
  "Сравни с прошлой неделей.",
];

function ageLabel(minutes?: number | null) {
  return formatDurationMinutes(minutes) || "срок не указан";
}

function timeShort(iso: string | null | undefined) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function dayGreeting() {
  const hour = new Date().getHours();
  if (hour < 5) return "Доброй ночи";
  if (hour < 12) return "Доброе утро";
  if (hour < 18) return "Добрый день";
  return "Добрый вечер";
}

function firstName(me: { user?: { name?: string } } | null | undefined) {
  const raw = String(me?.user?.name || "").trim();
  return raw ? raw.split(/\s+/)[0] : "";
}

const ICONS = {
  home: "M3 10 12 3l9 7M5 9v11h5v-6h4v6h5V9",
  inquiries: "M5 3h14v18H5V3m4 5h6m-6 4h6m-6 4h3",
  contacts: "M16 21v-2a5 5 0 0 0-10 0v2m5-18a4 4 0 1 0 0 8 4 4 0 0 0 0-8",
  deals: "M3 5h5v14H3V5m7 0h5v10h-5V5m7 0h4v7h-4V5",
  tasks: "M8 4h12v17H4V4h4m0-2h8v4H8V2m0 9 2 2 5-5",
  conversations: "M4 4h16v12H9l-5 4V4m4 5h8m-8 3h5",
  documents: "M7 3h8l5 5v13H7V3m8 0v5h5",
  reply: "M4 4h16v12H9l-5 4V4",
  clock: "M12 8v5l3 2m6-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  human: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8m-7 9a7 7 0 0 1 14 0",
  stalled: "M4 12h4l3-8 4 16 3-8h4",
  money: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18m-3 6h5a2 2 0 0 1 0 4h-4a2 2 0 0 0 0 4h6M12 7v2m0 8v2",
  lost: "M16 8l-8 8m0-8 8 8",
  conversion: "M4 16l5-5 4 4 7-7M14 8h6v6",
  ai: "M12 3v3m0 12v3M3 12h3m12 0h3M7.2 7.2l2.1 2.1m5.4 5.4 2.1 2.1m0-9.6-2.1 2.1M7.2 16.8l2.1-2.1",
  phone: "M7 3h10v18H7V3m3 15h4",
  contract: "M7 3h8l5 5v13H7V3m8 0v5h5M9 13h6m-6 4h4",
  warning: "M12 9v4m0 3h.01M10.3 4.7 2.8 18a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.7a2 2 0 0 0-3.4 0Z",
};

type DashTone =
  | "sky"
  | "mint"
  | "amber"
  | "rose"
  | "violet"
  | "slate"
  | "coral"
  | "orange"
  | "teal"
  | "gold"
  | "blush"
  | "indigo"
  | "stone"
  | "crimson";

function DashIcon({ d }: { d: string }) {
  return (
    <svg className="dash-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function Kpi({
  label,
  value,
  hint,
  delta,
  deltaPercent,
  to,
  emphasize,
  tone,
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  delta?: number | null;
  deltaPercent?: number | null;
  to?: string;
  emphasize?: boolean;
  tone?: DashTone;
  icon?: string;
}) {
  const change = deltaText(delta, deltaPercent);
  const inner = (
    <>
      <span className="dash-kpi-top">
        {icon ? (
          <span className="dash-kpi-icon">
            <DashIcon d={icon} />
          </span>
        ) : null}
        <span className="muted">{label}</span>
      </span>
      <strong className={emphasize ? "kpi-emphasize" : undefined}>{value}</strong>
      {hint ? <span className="kpi-hint">{hint}</span> : null}
      {change ? <span className="kpi-delta">{change}</span> : null}
    </>
  );
  const className = `sit-kpi dash-kpi${tone ? ` dash-kpi-${tone}` : ""}`;
  if (to) {
    return (
      <Link className={className} to={to}>
        {inner}
      </Link>
    );
  }
  return <div className={className}>{inner}</div>;
}

function liveSpotCount(value: unknown) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function SpotCard({
  label,
  value,
  to,
  tone,
  icon,
}: {
  label: string;
  value: unknown;
  to: string;
  tone: DashTone;
  icon: string;
}) {
  const count = liveSpotCount(value);
  if (!count) return null;
  return (
    <Link className={`dash-spot dash-spot-${tone} is-live`} to={to}>
      <span className="dash-spot-icon">
        <DashIcon d={icon} />
      </span>
      <span className="dash-spot-copy">
        <strong>{count}</strong>
        <span>{label}</span>
      </span>
    </Link>
  );
}

export function SituationPage() {
  const caps = useCapabilities();
  const { me } = useSession();
  const requestVersion = useRequestVersion();
  const navigate = useNavigate();
  const [scope, setScope] = useUrlState<Scope>("scope", "all");
  const [period, setPeriod] = useUrlState<PeriodPreset>("period", "today");
  const [dateFrom, setDateFrom] = useUrlState<string>("from", "");
  const [dateTo, setDateTo] = useUrlState<string>("to", "");
  const [attentionFilter, setAttentionFilter] = useUrlState<string>("attention", "");
  const [onlyImportant, setOnlyImportant] = useState(false);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [meMissing, setMeMissing] = useState(false);
  const [badgeHint, setBadgeHint] = useState("");
  const [askText, setAskText] = useState("");
  const [askBusy, setAskBusy] = useState(false);
  const [askAnswer, setAskAnswer] = useState<{
    question: string;
    headline: string;
    bullets: Array<{ text: string; href?: string }>;
    links: Array<{ label: string; href: string }>;
    usedLlm?: boolean;
    command?: boolean;
  } | null>(null);

  async function load() {
    const request = ++requestVersion.current;
    try {
      const me = (await api.me()) as any;
      if (request !== requestVersion.current) return;
      if (!me.activeTenant) {
        setMeMissing(true);
        setData(null);
        return;
      }
      setMeMissing(false);
      if (period === "custom" && (!dateFrom || !dateTo)) {
        setError("Укажите даты С и По");
        return;
      }
      const [result, badges] = await Promise.all([
        caps.manager
          ? api.situation({ scope: "all" })
          : api.situationOverview({
              period,
              scope,
              onlyImportant,
              dateFrom: period === "custom" ? dateFrom : undefined,
              dateTo: period === "custom" ? dateTo : undefined,
            }),
        api.navBadges().catch(() => null),
      ]);
      if (request !== requestVersion.current) return;
      setData(result);
      const hints = (badges as { hints?: Record<string, string> } | null)?.hints || {};
      setBadgeHint(hints["/today"] || "");
      setError("");
    } catch (err) {
      if (request !== requestVersion.current) return;
      setError(err instanceof Error ? err.message : "Ошибка");
    }
  }

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [scope, period, onlyImportant, dateFrom, dateTo, caps.manager]);

  async function run(item: any, action: () => Promise<unknown>) {
    setBusyId(item.id);
    try {
      await action();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не выполнено");
    } finally {
      setBusyId("");
    }
  }

  if (meMissing) {
    return (
      <section>
        <h2>Главная</h2>
        <p className="empty">Нет компании — войдите заново.</p>
        <Link className="btn" to="/login">
          Войти
        </Link>
      </section>
    );
  }
  if (!data && !error) return <div className="state">Загрузка…</div>;
  if (!data) {
    return (
      <section>
        <p className="error">{error}</p>
        <button type="button" className="btn" onClick={() => void load()}>
          Повторить
        </button>
      </section>
    );
  }

  if (caps.manager) {
    const items = Array.isArray(data.items) ? data.items : [];
    const inquiries = items.filter((item: any) => String(item.kind || "").startsWith("inquiry") || item.entityType === "inquiry");
    const deals = items.filter((item: any) => String(item.kind || "").includes("deal"));
    const tasks = items.filter((item: any) => String(item.kind || "").startsWith("task"));
    const dialogs = items.filter((item: any) => String(item.kind || "").startsWith("conversation"));
    return (
      <section className="situation-page dash-home">
        <div className="page-head sit-head">
          <div>
            <h2 className="dash-title">
              {dayGreeting()}
              {firstName(me) ? (
                <>
                  , <span className="dash-title-name">{firstName(me)}</span>
                </>
              ) : null}
            </h2>
            {badgeHint ? <p className="muted sit-badge-explain">{badgeHint}</p> : <p className="muted">Что нужно сделать сейчас.</p>}
          </div>
        </div>
        {error ? <p className="error">{error}</p> : null}
        {liveSpotCount(inquiries.length) || liveSpotCount(deals.length) || liveSpotCount(tasks.length) || liveSpotCount(dialogs.length) ? (
          <>
            <p className="dash-block-label">Сейчас важно</p>
            <div className="dash-spot-grid">
              <SpotCard label="Заявки" value={inquiries.length} to="/inquiries" tone="sky" icon={ICONS.inquiries} />
              <SpotCard label="Сделки" value={deals.length} to="/deals" tone="mint" icon={ICONS.deals} />
              <SpotCard label="Задачи" value={tasks.length} to="/tasks" tone="amber" icon={ICONS.tasks} />
              <SpotCard label="Диалоги" value={dialogs.length} to="/conversations" tone="violet" icon={ICONS.conversations} />
            </div>
          </>
        ) : null}
        <div className="sit-section dash-panel">
          <div className="sit-section-head">
            <h3>Что требует внимания</h3>
            <span className="muted">{items.length ? `${items.length}` : "Пусто"}</span>
          </div>
          {!items.length ? <p className="empty sit-empty-ok">Сейчас ничего не требует внимания</p> : null}
          {items.slice(0, 40).map((item: any) => (
            <div className="dash-attn-item" key={item.id}>
              <div>
                <b>{item.title}</b>
                <div className="muted">{item.subtitle || item.reason || item.kind}</div>
              </div>
              {item.href ? (
                <Link className="btn secondary" to={item.href}>
                  Открыть
                </Link>
              ) : null}
            </div>
          ))}
        </div>
      </section>
    );
  }

  const r = data.result;
  const c = data.current;
  const attention = data.attention;
  const today = data.todayTasks;
  const periodParams = { period, ...(period === "custom" ? { from: dateFrom, to: dateTo } : {}), scope };
  const path = (base: string, parameters: Record<string, string> = {}, withPeriod = false) => `${base}?${new URLSearchParams({ ...(withPeriod ? periodParams : { scope }), ...parameters })}`;
  const nextActionItems = attention.items.filter((item: any) => item.kind === "missing_next_action");
  const visibleAttention = attentionFilter
    ? attention.items.filter((item: any) => item.group === attentionFilter)
    : attention.items;
  const noNextHref = path("/today", { ...periodParams, attention: "no_next_action" }) + "#attention";
  const summary = attention.summary || {};
  const aiRequests = data.aiManager?.newRequests;
  const hasAttentionSpots = [
    summary.needsReply,
    summary.needsHuman,
    summary.overdueTasks,
    summary.noNextAction ?? nextActionItems.length,
    summary.stalledDeals,
    summary.overSlaDeals,
    summary.paymentOverdue,
    summary.overdueAgreements,
    summary.proposalWithoutReply,
    summary.documentsToClose,
    summary.noContact,
    aiRequests?.processing,
    aiRequests?.needsHuman,
    aiRequests?.analysisFailed,
  ].some((value) => liveSpotCount(value) > 0);
  const insights = Array.isArray(data.insights) ? data.insights : [];
  const sources = Array.isArray(data.sources) ? data.sources : [];
  const team = Array.isArray(data.team) ? data.team : [];
  const ai = data.aiManager || {};

  async function goAsk(question: string) {
    const text = question.trim();
    if (!text) return;
    setAskText(text);
    setAskBusy(true);
    setError("");
    try {
      const answer = (await api.situationAsk({
        text,
        period,
        scope,
        onlyImportant,
        dateFrom: period === "custom" ? dateFrom : undefined,
        dateTo: period === "custom" ? dateTo : undefined,
      })) as {
        question: string;
        headline: string;
        bullets?: Array<{ text: string; href?: string }>;
        links?: Array<{ label: string; href: string }>;
        usedLlm?: boolean;
        command?: boolean;
        documentCommand?: boolean;
        suggestedPeriod?: PeriodPreset | null;
      };
      if (answer.command) {
        navigate(
          answer.documentCommand
            ? `/documents?command=${encodeURIComponent(text)}`
            : `/tasks?command=${encodeURIComponent(text)}`,
        );
        return;
      }
      if (answer.suggestedPeriod && answer.suggestedPeriod !== period) {
        setPeriod(answer.suggestedPeriod);
      }
      setAskAnswer({
        question: answer.question || text,
        headline: answer.headline,
        bullets: answer.bullets || [],
        links: answer.links || [],
        usedLlm: answer.usedLlm,
      });
      requestAnimationFrame(() => document.getElementById("ask-ai")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось ответить");
    } finally {
      setAskBusy(false);
    }
  }

  function onAsk(event: FormEvent) {
    event.preventDefault();
    void goAsk(askText);
  }


  return (
    <section className="situation-page dash-home">
      <div className="page-head sit-head">
        <div>
          <h2 className="dash-title">
            {dayGreeting()}
            {firstName(me) ? (
              <>
                , <span className="dash-title-name">{firstName(me)}</span>
              </>
            ) : null}
          </h2>
          {badgeHint ? <p className="muted sit-badge-explain">{badgeHint}</p> : <p className="muted">Обзор работы компании на одном экране.</p>}
        </div>
        <div className="sit-meta">
          <span className={data.aiManager?.status === "error" ? "error" : "muted"}>{data.aiManager?.label}</span>
          <span className="muted">Обновлено {timeShort(data.asOf)}</span>
        </div>
      </div>
      {me?.billing?.previewMode && me?.billing?.preview?.situation ? (
        <div className="panel preview-demo">
          <p className="muted">Пример показателей — так выглядит живой кабинет. После подключения тарифа здесь останутся только ваши данные.</p>
          <div className="dash-spot-grid">
            <div><b>{me.billing.preview.situation.inquiries}</b><div className="muted">обращений</div></div>
            <div><b>{me.billing.preview.situation.inProgress}</b><div className="muted">в работе</div></div>
            <div><b>{me.billing.preview.situation.needsAttention}</b><div className="muted">требуют внимания</div></div>
            <div><b>{me.billing.preview.situation.dialogs}</b><div className="muted">диалогов</div></div>
          </div>
        </div>
      ) : null}

      <div className="dash-controls" role="group" aria-labelledby="dashboard-owner-label" aria-describedby="dashboard-owner-help">
        <b id="dashboard-owner-label">Чьи записи показывать</b>
        <div className="segmented sit-scope dashboard-owner-filter">
          {([
            ["all", "Вся команда", "Показать доступные записи компании, включая записи без ответственного"],
            ["mine", "Назначены мне", "Показать записи, за которые отвечаете вы, независимо от того, кто их создал"],
            ["unassigned", "Без ответственного", "Показать записи, которым ещё не назначен ответственный сотрудник"],
          ] as const).map(([value, label, hint]) => (
            <button key={value} type="button" className={scope === value ? "btn" : "btn secondary"}
              aria-pressed={scope === value} data-tip={hint} onClick={() => setScope(value)}>
              {label}
            </button>
          ))}
        </div>
        <p className="muted dashboard-filter-help" id="dashboard-owner-help">
          {scope === "mine"
            ? "Показаны записи, за которые отвечаете вы. Автор записи может быть другим сотрудником."
            : scope === "unassigned"
              ? "Показаны записи, которым ещё не назначен ответственный сотрудник."
              : "Показаны доступные записи всей команды, включая записи без ответственного."}
        </p>
      </div>

      {error ? <p className="error">{error}</p> : null}

      {(data.integrationAlerts || []).length > 0 ? (
        <div className="banner warn dash-alert">
          <div>
            {(data.integrationAlerts as any[]).map((a) => (
              <div key={a.id}>
                <b>{a.title}</b>
                <div className="muted">{a.detail}</div>
              </div>
            ))}
          </div>
          <Link className="btn secondary" to="/integrations">
            Интеграции
          </Link>
        </div>
      ) : null}

      {hasAttentionSpots ? (
        <>
          <p className="dash-block-label">Сейчас важно</p>
          <div className="dash-spot-grid">
            <SpotCard label="Нужно ответить" value={summary.needsReply} to="/contacts?filter=needs_reply" tone="amber" icon={ICONS.reply} />
            <SpotCard label="Нужен человек" value={summary.needsHuman} to="/conversations?filter=attention" tone="coral" icon={ICONS.human} />
            <SpotCard label="Просрочено" value={summary.overdueTasks} to="/tasks?filter=overdue" tone="rose" icon={ICONS.clock} />
            <SpotCard label="Без шага" value={summary.noNextAction ?? nextActionItems.length} to={noNextHref} tone="orange" icon={ICONS.tasks} />
            <SpotCard label="Зависли" value={summary.stalledDeals} to={path("/deals", { focus: "stalled" })} tone="slate" icon={ICONS.stalled} />
            <SpotCard label="Сверх SLA" value={summary.overSlaDeals ?? 0} to={path("/deals", { focus: "over_sla" })} tone="teal" icon={ICONS.clock} />
            <SpotCard label="Просрочена оплата" value={summary.paymentOverdue ?? 0} to={path("/deals", { focus: "payment_overdue" })} tone="gold" icon={ICONS.money} />
            <SpotCard label="Договорённости" value={summary.overdueAgreements ?? 0} to={path("/today", { ...periodParams, attention: "overdue" }) + "#attention"} tone="blush" icon={ICONS.warning} />
            <SpotCard label="КП без ответа" value={summary.proposalWithoutReply ?? 0} to={path("/deals", { focus: "proposal_no_reply" })} tone="indigo" icon={ICONS.documents} />
            <SpotCard label="Документы" value={summary.documentsToClose ?? 0} to="/documents/avr/new?filter=all" tone="sky" icon={ICONS.contract} />
            <SpotCard label="Нет контакта" value={summary.noContact} to={path("/today", { ...periodParams, attention: "no_contact" }) + "#attention"} tone="stone" icon={ICONS.phone} />
            <SpotCard label="AI обрабатывает" value={aiRequests?.processing} to="/inquiries?filter=ai_processing" tone="violet" icon={ICONS.ai} />
            <SpotCard label="Ждут менеджера" value={aiRequests?.needsHuman} to="/inquiries?filter=ai_needs_human" tone="mint" icon={ICONS.human} />
            <SpotCard label="Ошибка AI" value={aiRequests?.analysisFailed} to="/inquiries?filter=ai_failed" tone="crimson" icon={ICONS.warning} />
          </div>
        </>
      ) : null}

      <div className="dash-home-split">
      <div className="sit-section sit-attention dash-panel" id="attention">
        <div className="sit-section-head">
          <div>
            <h3>Требует внимания</h3>
            <p className="muted sit-attn-principle">
              {attention.principle ||
                "Только то, где человек должен что-то сделать сейчас: ответить клиенту, забрать диалог у AI, закрыть просроченное, задать шаг или дописать телефон. Диалог уже у менеджера без ожидания ответа сюда не попадает."}
            </p>
          </div>
        </div>

        <div className="dashboard-attention-filter" role="group" aria-label="Какие действия показывать" aria-describedby="dashboard-attention-help">
          <span className="muted">Какие действия показывать</span>
          <div className="segmented sit-scope">
            <button type="button" className={!onlyImportant ? "btn" : "btn secondary"} aria-pressed={!onlyImportant}
              data-tip="Показать весь список действий, требующих внимания" onClick={() => setOnlyImportant(false)}>Все действия</button>
            <button type="button" className={onlyImportant ? "btn" : "btn secondary"} aria-pressed={onlyImportant}
              data-tip="Оставить ответы клиентам, просрочки, помощь AI и записи без контакта или следующего шага" onClick={() => setOnlyImportant(true)}>Приоритетные действия</button>
          </div>
          <p className="muted dashboard-filter-help" id="dashboard-attention-help">
            {onlyImportant
              ? "Ответы клиентам, просроченные задачи, сроки и оплаты, помощь AI, записи без контакта или следующего шага."
              : "Все действия из списка «Требует внимания»."}
            {" "}Этот переключатель меняет только список ниже; показатели обзора остаются прежними.
          </p>
        </div>
        {attentionFilter ? <button className="btn secondary" onClick={() => setAttentionFilter("")}>Снять отбор по типу действия</button> : null}
        {visibleAttention.length === 0 ? (
          <p className="empty sit-empty-ok">{attention.emptyLabel}</p>
        ) : (
          visibleAttention.map((item: any) => (
            <div className={`dash-attn-item severity-${item.severity}`} key={item.id}>
              <span className="attention-icon" aria-hidden="true"><DashIcon d={item.nextAction === "complete_phone" ? ICONS.phone : item.nextAction === "complete_task" ? ICONS.tasks : ICONS.warning} /></span>
              <div className="attention-content">
                <div className="sit-attn-why">
                  {item.whyLabel ? <b>{item.whyLabel}</b> : null}
                  {item.reason && item.reason !== item.whyLabel ? <span>{item.reason}</span> : null}
                </div>
                <b>{nameWithPhone(item.contactName || item.title, item.phone)}</b>
                {item.interest && item.interest !== item.reason ? <div className="muted">{item.interest}</div> : null}
                {item.contactName && item.title && item.title !== item.contactName && item.title !== item.interest ? (
                  <div className="muted">{item.title}</div>
                ) : null}
                <div className="attention-next muted">
                  <span>{ACTION_LABEL[item.nextAction] || item.nextAction}</span>
                  <span>{ageLabel(item.ageMinutes)}</span>
                  {item.ownerMembershipId ? null : <span>Без ответственного</span>}
                </div>
                {item.nextAction === "complete_phone" ? (
                  <form
                    className="inline-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const form = new FormData(event.currentTarget);
                      void run(item, () =>
                        api.completeIntake(item.entityId, { phone: form.get("phone"), name: form.get("name") })
                          .then((result) => { notifySaved("Контакт сохранён"); return result; }),
                      );
                    }}
                  >
                    <input name="name" placeholder="Имя" />
                    <input name="phone" required placeholder="+7..." />
                    <button className="btn" disabled={busyId === item.id} type="submit">
                      Сохранить контакт
                    </button>
                  </form>
                ) : null}
              </div>
              <div className="actions">
                {item.nextAction !== "complete_phone" ? (
                  <button
                    type="button"
                    className="btn"
                    disabled={busyId === item.id}
                    onClick={() => {
                      if (item.nextAction === "accept_inquiry") return void run(item, () => api.acceptInquiry(item.entityId));
                      if (item.nextAction === "open_inquiry") return navigate(`/requests/${item.entityId}`);
                      if (item.nextAction === "take_conversation") {
                        return void run(item, () => api.takeConversation(item.entityId));
                      }
                      if (item.nextAction === "reply_human") {
                        return navigate(`/conversations/${item.entityId}?focus=reply`);
                      }
                      if (item.nextAction === "return_to_ai" || item.nextAction === "resume_paused") {
                        return void run(item, () => api.returnToAi(item.entityId));
                      }
                      if (item.nextAction === "complete_task") return void run(item, () => api.completeTask(item.entityId));
                      if (item.nextAction === "assign_owner") return void run(item, () => api.assignTask(item.entityId));
                      if (item.nextAction === "instruct_ai") return navigate("/control");
                      if (item.nextAction === "open_contact") return navigate(`/contacts/${item.entityId}`);
                      if (item.nextAction === "create_next_action") {
                        return navigate(`/tasks?${new URLSearchParams({ ...(item.links?.contactId ? { contactId: item.links.contactId } : {}), ...(item.links?.dealId ? { dealId: item.links.dealId } : {}), ...(item.links?.inquiryId ? { inquiryId: item.links.inquiryId } : {}) })}`);
                      }
                      if (item.nextAction === "open_deal") {
                        return navigate(item.href || `/deals/${item.entityId}`);
                      }
                      return navigate(item.href || "/today");
                    }}
                  >
                    {ACTION_LABEL[item.nextAction] || "Открыть"}
                  </button>
                ) : null}
                <Link className="btn secondary" to={item.href || "/today"}>
                  Карточка
                </Link>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="dash-side">
      <form className="sit-section sit-ask dash-panel dash-ask" id="ask-ai" onSubmit={onAsk}>
        <div className="sit-section-head">
          <h3>Спросите о бизнесе</h3>
        </div>
        <div className="sit-ask-row">
          <input
            className="sit-ask-input"
            value={askText}
            onChange={(event) => setAskText(event.target.value)}
            placeholder="Что сегодня требует моего внимания?"
            aria-label="Вопрос CreoLab AI"
          />
          <button type="submit" className="btn" disabled={askBusy}>
            {askBusy ? "Думаю…" : "Спросить"}
          </button>
        </div>
        <div className="sit-ask-presets">
          {ASK_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              className="sit-ask-chip"
              disabled={askBusy}
              onClick={() => void goAsk(preset)}
            >
              {preset}
            </button>
          ))}
        </div>
        {askAnswer ? (
          <div className="sit-ask-answer">
            <div className="muted sit-ask-question">{askAnswer.question}</div>
            <p>{askAnswer.headline}</p>
            {askAnswer.bullets.length ? (
              <ul className="sit-insights">
                {askAnswer.bullets.map((item) => (
                  <li key={item.text}>
                    {item.href?.startsWith("#") ? (
                      <a href={item.href}>{item.text}</a>
                    ) : item.href ? (
                      <Link to={item.href}>{item.text}</Link>
                    ) : (
                      <span>{item.text}</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
            {askAnswer.links.length ? (
              <div className="sit-ask-links">
                {askAnswer.links.map((link) =>
                  link.href.startsWith("#") ? (
                    <a key={link.href} className="btn secondary" href={link.href}>
                      {link.label}
                    </a>
                  ) : (
                    <Link key={link.href} className="btn secondary" to={link.href}>
                      {link.label}
                    </Link>
                  ),
                )}
              </div>
            ) : null}
          </div>
        ) : null}
        <p className="muted sit-ask-note">
          AI смотрит заявки, сделки, задачи и диалоги. Команды вроде «напиши» открывают постановку задачи.
        </p>
      </form>

      <div className="sit-brief dash-brief" id="insights">
        <b>AI-сводка</b>
        {insights.length ? (
          <ul className="sit-insights">
            {insights.map((item: { text: string; href?: string; tone?: string }) => (
              <li key={item.text} className={`sit-insight sit-insight-${item.tone || "observe"}`}>
                {item.href?.startsWith("#") ? (
                  <a href={item.href}>{item.text}</a>
                ) : item.href ? (
                  <Link to={item.href}>{item.text}</Link>
                ) : (
                  <span>{item.text}</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p>{data.brief}</p>
        )}
      </div>
      </div>
      </div>

      <div className="sit-period-bar dash-period" id="sit-result">
        <PeriodSelector
          period={period}
          onPeriodChange={setPeriod}
          dateFrom={dateFrom}
          dateTo={dateTo}
          onDateFromChange={setDateFrom}
          onDateToChange={setDateTo}
          activeLabel={data.period?.label}
        />
      </div>

      <div className="sit-section sit-result">
        <div className="sit-section-head">
          <h3>За {data.period.label.toLowerCase()}</h3>
          <span className="muted">Результат выбранного периода</span>
        </div>
        <div className="sit-kpi-grid">
          <Kpi label="Обращения" value={r.inquiries} delta={r.deltas?.inquiries} deltaPercent={r.deltas?.inquiriesPct} to={path("/inquiries", { test: "false" }, true)} tone="sky" icon={ICONS.inquiries} />
          <Kpi label="Новые клиенты" value={r.newClients} delta={r.deltas?.newClients} deltaPercent={r.deltas?.newClientsPct} to={path("/contacts", { owner: scope === "mine" ? "me" : scope === "unassigned" ? "unassigned" : "" }, true)} tone="sky" icon={ICONS.contacts} />
          <Kpi label="Сделки" value={r.dealsCreated} delta={r.deltas?.dealsCreated} deltaPercent={r.deltas?.dealsCreatedPct} to={path("/deals", { timeMode: "period", basis: "created" }, true)} tone="slate" icon={ICONS.deals} />
          <Kpi label="Продажи" value={r.wonDeals} delta={r.deltas?.wonDeals} deltaPercent={r.deltas?.wonDealsPct} to={path("/deals", { timeMode: "period", basis: "closed", outcome: "won" }, true)} emphasize tone="mint" icon={ICONS.money} />
          <Kpi
            label="Продано"
            value={r.wonAmountLabel || "—"}
            hint={
              r.wonAmountTotalDeals
                ? r.wonAmountKnownCount < r.wonAmountTotalDeals
                  ? `сумма у ${r.wonAmountKnownCount} из ${r.wonAmountTotalDeals}`
                  : undefined
                : "нет сумм"
            }
            delta={r.deltas?.wonAmount}
            deltaPercent={r.deltas?.wonAmountPct}
            to={path("/deals", { timeMode: "period", basis: "closed", outcome: "won" }, true)}
            emphasize
            tone="mint"
            icon={ICONS.money}
          />
          <Kpi
            label="Потеряно"
            value={r.lostDeals}
            hint={r.lostReasons?.[0] ? `${r.lostReasons[0].reason} · ${r.lostReasons[0].count}` : undefined}
            to={path("/deals", { timeMode: "period", basis: "closed", outcome: "lost" }, true)}
            tone="rose"
            icon={ICONS.lost}
          />
          {r.conversionRate != null ? (
            <Kpi
              label="Конверсия"
              value={r.conversionLabel}
              hint={`${r.wonDeals} продаж из ${r.inquiries} обращений`}
              deltaPercent={r.deltas?.conversionPct}
              to={path("/deals", { timeMode: "period", basis: "closed", outcome: "won" }, true)}
              tone="violet"
              icon={ICONS.conversion}
            />
          ) : null}
        </div>
        {data.payments ? (
          <p className="muted sit-pay">
            Оплачено за период: <b>{data.payments.paidInPeriodLabel}</b>
            {data.payments.count ? ` · ${data.payments.count} платежей` : ""}
          </p>
        ) : null}
        {data.allTime ? (
          <p className="muted">
            Всего: {data.allTime.inquiries} обращений · {data.allTime.clients} клиентов · {data.allTime.deals} сделок ·{" "}
            {data.allTime.won} продаж
          </p>
        ) : null}
      </div>

      <div className="sit-section sit-current">
        <div className="sit-section-head">
          <h3>Сейчас в работе</h3>
          <span className="muted">Не за период — как сейчас</span>
        </div>
        <div className="sit-kpi-grid sit-kpi-grid-current">
          <Kpi label="Новые заявки" value={c.newInquiries ?? 0} to={path("/inquiries", { filter: "new", test: "false" })} emphasize tone="sky" icon={ICONS.inquiries} />
          <Kpi label="Заявки в работе" value={c.inWorkInquiries ?? 0} to={path("/inquiries", { filter: "in_progress", test: "false" })} tone="slate" icon={ICONS.inquiries} />
          <Kpi label="Активные сделки" value={c.activeDeals} to={path("/deals")} emphasize tone="mint" icon={ICONS.deals} />
            <Kpi
              label="Сумма сделок"
              value={c.activePipelineAmountLabel || "—"}
              hint={
                c.amountKnownOf
                  ? `сумма известна у ${c.amountKnownCount} из ${c.amountKnownOf}`
                  : undefined
              }
              to={path("/deals")}
              emphasize
              tone="mint"
              icon={ICONS.money}
            />
          <Kpi label="На договоре" value={c.contractStage} to={path("/deals", { stage: "contract" })} tone="violet" icon={ICONS.contract} />
          <Kpi label="Заявки ждут клиента" value={c.waitingClientInquiries} to={path("/inquiries", {filter: "waiting_client", test: "false"})} tone="amber" icon={ICONS.clock} />
          <Kpi label="Нужен ответ" value={c.needsReply} to="/contacts?filter=needs_reply" tone="amber" icon={ICONS.reply} />
          <Kpi label="Без следующего шага" value={nextActionItems.length} to={noNextHref} tone="amber" icon={ICONS.tasks} />
          <Kpi label="Просрочено" value={c.overdueTasks} to="/tasks?filter=overdue" tone="rose" icon={ICONS.clock} />
          <Kpi label="Зависли" value={c.stalledDeals} to={path("/deals", { focus: "stalled" })} tone="rose" icon={ICONS.stalled} />
          <Kpi label="КП без ответа" value={c.proposalWithoutReply ?? 0} to={path("/deals", { focus: "proposal_no_reply" })} tone="violet" icon={ICONS.documents} />
        </div>
        <div className="sit-pipeline" id="funnel">
          <b>На стадиях сейчас</b>
          <div className="sit-pipeline-row">
            {(data.pipeline?.stages || []).map((stage: any) => (
              <Link key={stage.systemKey} className="sit-pipe-chip" to={path("/deals", { stage: stage.systemKey })}>
                <span>{stage.name}</span>
                <strong>{stage.count}</strong>
                {stage.toNextRate != null && stage.toNextRate > 0 ? <span className="muted">{stage.toNextRate}% далее</span> : null}
              </Link>
            ))}
          </div>
          {data.pipeline?.biggestDrop ? (
            <p className="muted">
              Наибольшая потеря сейчас между «{data.pipeline.biggestDrop.fromName}» и «
              {data.pipeline.biggestDrop.toName}»: {data.pipeline.biggestDrop.fromCount} → {data.pipeline.biggestDrop.toCount}.
            </p>
          ) : null}
        </div>
      </div>

      <div className="sit-two-col sit-ops-row">
        <div className="sit-section sit-team" id="team">
          <div className="sit-section-head">
            <h3>Команда</h3>
            <span className="muted">По сотрудникам</span>
          </div>
          {team.length === 0 ? (
            <p className="empty">Нет данных по менеджерам за выбранные условия.</p>
          ) : (
            <div className="sit-table-wrap">
              <table className="sit-table">
                <thead>
                  <tr>
                    <th>Менеджер</th>
                    <th>Новые</th>
                    <th>В работе</th>
                    <th>Внимание</th>
                    <th>Просрочено</th>
                  </tr>
                </thead>
                <tbody>
                  {team.map((row: any) => (
                    <tr key={row.membershipId || "unassigned"}>
                      <td>{row.name}</td>
                      <td>{row.newInquiries}</td>
                      <td>{row.inWork}</td>
                      <td>{row.attention}</td>
                      <td>{row.overdueTasks}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="sit-section sit-ai-card">
          <div className="sit-section-head">
            <h3>AI-менеджер</h3>
            <span className={ai.status === "error" ? "error" : "muted"}>{ai.label}</span>
          </div>
          <div className="sit-kpi-grid sit-kpi-grid-ai">
            <Kpi label="Диалоги AI" value={ai.conversations?.ai ?? 0} to="/conversations?filter=ai" tone="violet" icon={ICONS.ai} />
            <Kpi label="У менеджера" value={ai.conversations?.human ?? 0} to="/conversations?filter=human" tone="sky" icon={ICONS.human} />
            <Kpi label="Требуют вмешательства" value={ai.conversations?.needsAttention ?? 0} to="/conversations?filter=attention" emphasize tone="rose" icon={ICONS.warning} />
            <Kpi label="Заявки из WhatsApp" value={ai.whatsappInquiries ?? 0} to={path("/inquiries", { source: "whatsapp", test: "false" }, true)} tone="mint" icon={ICONS.conversations} />
          </div>
        </div>
      </div>

      <div className="sit-section sit-sources" id="sources">
        <div className="sit-section-head">
          <h3>Источники</h3>
          <span className="muted">За {data.period.label.toLowerCase()}</span>
        </div>
        {sources.length === 0 ? (
          <p className="empty">За выбранный период заявок нет — источники появятся после обращений.</p>
        ) : (
          <div className="sit-table-wrap">
            <table className="sit-table">
              <thead>
                <tr>
                  <th>Источник</th>
                  <th>Заявки</th>
                  <th>Сделки</th>
                  <th>Конверсия</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((row: any) => (
                  <tr key={row.key}>
                    <td>
                      <Link to={path("/inquiries", { ...(row.key === "unspecified" ? {} : { source: row.key }), test: "false" }, true)}>
                        {row.label}
                      </Link>
                    </td>
                    <td>{row.inquiries}</td>
                    <td>{row.deals}</td>
                    <td>{row.conversionRate != null ? `${row.conversionRate}%` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="sit-two-col sit-today-row">
        <div className="sit-section">
          <div className="sit-section-head">
            <h3>Ближайшие задачи</h3>
            <span className="muted">
              Сегодня: {today.totalDueToday} задач · выполнено {today.doneToday} · осталось {today.remaining}
              {today.overdue ? ` · просрочено ${today.overdue}` : ""}
            </span>
          </div>
          {today.byType?.length ? (
            <div className="sit-type-row">
              {today.byType.map((t: any) => (
                <span key={t.type} className="sit-type-chip">
                  {t.type} · {t.count}
                </span>
              ))}
            </div>
          ) : null}
          {data.agreements?.byType?.length ? (
            <div className="sit-type-row">
              {data.agreements.byType.map((t: any) => (
                <span key={t.type} className="sit-type-chip">
                  {t.label} · {t.count}
                </span>
              ))}
            </div>
          ) : null}
          {(data.agreements?.today || []).map((agr: any) => (
            <Link className="sit-list-row" key={agr.id} to={agr.href || "/tasks"}>
              <div>
                <b>{agr.title}</b>
                <div className="muted">
                  {[nameWithPhone(agr.contactName, agr.phone), agr.inquiryTitle, agr.dealStage]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
                {agr.attention ? <div className="warn-text">{agr.attention}</div> : null}
              </div>
              <span className="muted">{agr.scheduledAt ? timeShort(agr.scheduledAt) : ""}</span>
            </Link>
          ))}
          {today.nearest?.length === 0 && !(data.agreements?.today || []).length ? (
            <p className="empty">На сегодня задач нет</p>
          ) : null}
          {today.nearest?.map((task: any) => (
            <Link className="sit-list-row" key={task.id} to={`/tasks?open=${task.id}`}>
              <div>
                <b>{task.title}</b>
                <div className="muted">
                  {task.typeLabel}
                  {task.contactName || task.phone ? ` · ${nameWithPhone(task.contactName, task.phone)}` : ""}
                  {task.overdue ? " · просрочено" : ""}
                </div>
              </div>
              <span className="muted">{task.dueAt ? timeShort(task.dueAt) : "без срока"}</span>
            </Link>
          ))}
        </div>

        <div className="sit-section">
          <div className="sit-section-head">
            <h3>Важные сделки</h3>
            <span className="muted">Контроль руководителя</span>
          </div>
          {data.importantDeals?.length === 0 ? <p className="empty">Нет сделок, требующих контроля</p> : null}
          {data.importantDeals?.map((deal: any) => (
            <Link className="sit-list-row" key={deal.id} to={`/deals/${deal.id}`}>
              <div>
                <b>{deal.title}</b>
                <div className="muted">{nameWithPhone(deal.contactName, deal.phone)}</div>
                <div className="muted">
                  {deal.stageName}
                  {deal.amountLabel ? ` · ${deal.amountLabel}` : ""}
                </div>
                <div className="muted">{deal.reason}</div>
              </div>
            </Link>
          ))}
        </div>
      </div>

      <div className="sit-two-col sit-events-row" id="events">
        <div className="sit-section">
          <div className="sit-section-head">
            <h3>Последние обращения</h3>
          </div>
          {data.recentInquiries?.map((inq: any) => (
            <Link className="sit-list-row" key={inq.id} to={inq.href}>
              <div>
                <b>{nameWithPhone(inq.contactName, inq.phone)}</b>
                <div className="muted">
                  {inq.title}
                  {inq.source ? ` · ${inq.source}` : ""}
                  {inq.needsReply ? " · нужен ответ" : ""}
                </div>
              </div>
              <span className="muted">{timeShort(inq.receivedAt)}</span>
            </Link>
          ))}
        </div>

        <div className="sit-section">
          <div className="sit-section-head">
            <h3>Последние события</h3>
          </div>
          {data.recentResults?.length
            ? data.recentResults.map((item: any) => (
                <Link className="sit-list-row" key={`win-${item.id}`} to={item.href}>
                  <div>
                    <b>Продажа{item.amountLabel ? ` · ${item.amountLabel}` : ""}</b>
                    <div className="muted">
                      {nameWithPhone(item.contactName, item.phone)}
                      {item.title ? ` · ${item.title}` : ""}
                    </div>
                  </div>
                  <span className="muted">{timeShort(item.at)}</span>
                </Link>
              ))
            : null}
          {data.recentEvents?.map((ev: any) => (
            <Link className="sit-list-row" key={ev.id} to={ev.href}>
              <div>
                <b>{ev.title}</b>
                <div className="muted">
                  {ev.contactName || ev.phone
                    ? nameWithPhone(ev.contactName, ev.phone)
                    : ev.description || ev.type}
                </div>
              </div>
              <span className="muted">{timeShort(ev.createdAt)}</span>
            </Link>
          ))}
          {!data.recentResults?.length && !data.recentEvents?.length ? (
            <p className="empty">Пока нет активности. Новые обращения и сделки появятся здесь автоматически.</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
