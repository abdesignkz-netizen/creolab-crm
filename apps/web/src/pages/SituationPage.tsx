import { notifySaved } from "../components/SaveNotice";
import { useUrlState, useRequestVersion } from "../lib/useUrlState";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PeriodSelector, type PeriodPreset } from "../components/PeriodSelector";
import { nameWithPhone } from "../lib/contactDisplay";
import { formatDurationMinutes } from "../lib/duration";
import { api } from "../lib/api";

type Scope = "all" | "mine" | "unassigned";

const ACTION_LABEL: Record<string, string> = {
  complete_phone: "Дописать контакт",
  accept_inquiry: "Взять в работу",
  open_inquiry: "Открыть заявку",
  take_conversation: "Забрать себе",
  reply_human: "Ответить",
  return_to_ai: "Вернуть ИИ",
  resume_paused: "Снять паузу",
  complete_task: "Закрыть задачу",
  assign_owner: "Назначить себе",
  instruct_ai: "Поручить ИИ",
  open_contact: "Открыть клиента",
  create_next_action: "Задать шаг",
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

function Kpi({
  label,
  value,
  hint,
  delta,
  deltaPercent,
  to,
  emphasize,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  delta?: number | null;
  deltaPercent?: number | null;
  to?: string;
  emphasize?: boolean;
}) {
  const change = deltaText(delta, deltaPercent);
  const inner = (
    <>
      <span className="muted">{label}</span>
      <strong className={emphasize ? "kpi-emphasize" : undefined}>{value}</strong>
      {hint ? <span className="kpi-hint">{hint}</span> : null}
      {change ? <span className="kpi-delta">{change}</span> : null}
    </>
  );
  if (to) {
    return (
      <Link className="sit-kpi" to={to}>
        {inner}
      </Link>
    );
  }
  return <div className="sit-kpi">{inner}</div>;
}

export function SituationPage() {
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
        api.situationOverview({
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
  }, [scope, period, onlyImportant, dateFrom, dateTo]);

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
    <section className="situation-page">
      <div className="page-head sit-head">
        <div>
          <p className="page-kicker">Оперативный центр</p>
          <h2>Главная</h2>
          {badgeHint ? <p className="muted sit-badge-explain">{badgeHint}</p> : null}
        </div>
        <div className="sit-meta">
          <span className={data.aiManager?.status === "error" ? "error" : "muted"}>{data.aiManager?.label}</span>
          <span className="muted">Обновлено {timeShort(data.asOf)}</span>
        </div>
      </div>

      {data.aiManager?.newRequests && Object.values(data.aiManager.newRequests).some(value => Number(value) > 0) ? (
        <div className="sit-kpi-grid" style={{ marginBottom: 12 }}>
          <Kpi label="AI обрабатывает заявки" value={data.aiManager.newRequests.processing} to="/inquiries?filter=ai_processing" />
          <Kpi label="Ожидают менеджера" value={data.aiManager.newRequests.needsHuman} to="/inquiries?filter=ai_needs_human" />
          <Kpi label="Ошибка AI-обработки" value={data.aiManager.newRequests.analysisFailed} to="/inquiries?filter=ai_failed" />
        </div>
      ) : null}

      {(data.integrationAlerts || []).length > 0 ? (
        <div className="banner warn" style={{ marginBottom: 12 }}>
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

      {data.freshness?.warning ? (
        <div className="banner warn">
          <span>{data.freshness.warning}</span>
          <Link className="btn secondary" to="/integrations">
            Интеграции
          </Link>
        </div>
      ) : null}
      {error ? <p className="error">{error}</p> : null}

      <div className="sit-section sit-attention" id="attention">
        <div className="sit-section-head">
          <div>
            <h3>Требует внимания</h3>
            <p className="muted sit-attn-principle">
              {attention.principle ||
                "Только то, где человек должен что-то сделать сейчас: ответить клиенту, забрать диалог у AI, закрыть просроченное, задать шаг или дописать телефон. Диалог уже у менеджера без ожидания ответа сюда не попадает."}
            </p>
          </div>
        </div>
        <div className="sit-attn-summary">
          <Link to="/contacts?filter=needs_reply">Нужно ответить · {attention.summary.needsReply}</Link>
          <Link to="/tasks?filter=overdue">Просрочено · {attention.summary.overdueTasks}</Link>
          <Link to={path("/deals", { focus: "proposal_no_reply" })}>КП без ответа · {attention.summary.proposalWithoutReply ?? 0}</Link>
          <Link to={noNextHref}>Без шага · {attention.summary.noNextAction ?? nextActionItems.length}</Link>
          <Link to={path("/deals", { focus: "stalled" })}>Зависли · {attention.summary.stalledDeals}</Link>
          <Link to="/conversations?filter=attention">Нужен человек · {attention.summary.needsHuman}</Link>
          <Link to={path("/today", { ...periodParams, attention: "no_contact" }) + "#attention"}>Нет контакта · {attention.summary.noContact}</Link>
        </div>

        {attentionFilter ? <button className="btn secondary" onClick={() => setAttentionFilter("")}>Показать все действия</button> : null}
        {visibleAttention.length === 0 ? (
          <p className="empty sit-empty-ok">{attention.emptyLabel}</p>
        ) : (
          visibleAttention.map((item: any) => (
            <div className={`row severity-${item.severity} sit-attn-row`} key={item.id}>
              <div>
                <b>{nameWithPhone(item.contactName || item.title, item.phone)}</b>
                {item.interest && item.interest !== item.reason ? <div className="muted">{item.interest}</div> : null}
                {item.contactName && item.title && item.title !== item.contactName && item.title !== item.interest ? (
                  <div className="muted">{item.title}</div>
                ) : null}
                <div className="sit-attn-why">
                  {item.whyLabel ? <span className="badge warn">{item.whyLabel}</span> : null}
                  {item.reason && item.reason !== item.whyLabel ? <span>{item.reason}</span> : null}
                </div>
                <div className="muted">
                  {ACTION_LABEL[item.nextAction] || item.nextAction}
                  {" · "}
                  {ageLabel(item.ageMinutes)}
                  {item.ownerMembershipId ? "" : " · без ответственного"}
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

      <div className="sit-toolbar">
        <PeriodSelector
          period={period}
          onPeriodChange={setPeriod}
          dateFrom={dateFrom}
          dateTo={dateTo}
          onDateFromChange={setDateFrom}
          onDateToChange={setDateTo}
          activeLabel={data.period?.label}
        />
        <div className="sit-toolbar-side">
          <div className="segmented sit-scope">
            {(
              [
                ["all", "Все"],
                ["mine", "Мои"],
                ["unassigned", "Без ответственного"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={scope === value ? "btn" : "btn secondary"}
                onClick={() => setScope(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={onlyImportant ? "btn" : "btn secondary"}
            onClick={() => setOnlyImportant((v) => !v)}
          >
            Только важное
          </button>
        </div>
      </div>

      <form className="sit-section sit-ask" id="ask-ai" onSubmit={onAsk}>
        <div className="sit-section-head">
          <h3>Спросите CreoLab AI о Вашем бизнесе</h3>
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
          AI смотрит текущие заявки, сделки, задачи и диалоги и отвечает по смыслу вопроса. Команды вроде «напиши» или «отправь КП» открывают постановку задачи.
        </p>
      </form>

      <div className="sit-brief" id="insights">
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

      <div className="sit-section sit-result" id="sit-result">
        <div className="sit-section-head">
          <h3>За {data.period.label.toLowerCase()}</h3>
          <span className="muted">Результат выбранного периода</span>
        </div>
        <div className="sit-kpi-grid">
          <Kpi label="Обращения" value={r.inquiries} delta={r.deltas?.inquiries} deltaPercent={r.deltas?.inquiriesPct} to={path("/inquiries", { test: "false" }, true)} />
          <Kpi label="Новые клиенты" value={r.newClients} delta={r.deltas?.newClients} deltaPercent={r.deltas?.newClientsPct} to={path("/contacts", { owner: scope === "mine" ? "me" : scope === "unassigned" ? "unassigned" : "" }, true)} />
          <Kpi label="Сделки" value={r.dealsCreated} delta={r.deltas?.dealsCreated} deltaPercent={r.deltas?.dealsCreatedPct} to={path("/deals", { timeMode: "period", basis: "created" }, true)} />
          <Kpi label="Продажи" value={r.wonDeals} delta={r.deltas?.wonDeals} deltaPercent={r.deltas?.wonDealsPct} to={path("/deals", { timeMode: "period", basis: "closed", outcome: "won" }, true)} emphasize />
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
          />
          <Kpi
            label="Потеряно"
            value={r.lostDeals}
            hint={r.lostReasons?.[0] ? `${r.lostReasons[0].reason} · ${r.lostReasons[0].count}` : undefined}
            to={path("/deals", { timeMode: "period", basis: "closed", outcome: "lost" }, true)}
          />
          {r.conversionRate != null ? (
            <Kpi
              label="Конверсия"
              value={r.conversionLabel}
              hint={`${r.wonDeals} продаж из ${r.inquiries} обращений`}
              deltaPercent={r.deltas?.conversionPct}
              to={path("/deals", { timeMode: "period", basis: "closed", outcome: "won" }, true)}
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
          <span className="muted">Текущее состояние, не период</span>
        </div>
        <div className="sit-kpi-grid sit-kpi-grid-current">
          <Kpi label="Новые заявки" value={c.newInquiries ?? 0} to={path("/inquiries", { filter: "new", test: "false" })} emphasize />
          <Kpi label="Заявки в работе" value={c.inWorkInquiries ?? 0} to={path("/inquiries", { filter: "in_progress", test: "false" })} />
          <Kpi label="Активные сделки" value={c.activeDeals} to={path("/deals")} emphasize />
          <Kpi
            label="Сумма воронки"
            value={c.activePipelineAmountLabel || "—"}
            hint={
              c.amountKnownOf
                ? `сумма известна у ${c.amountKnownCount} из ${c.amountKnownOf}`
                : undefined
            }
            to={path("/deals")}
            emphasize
          />
          <Kpi label="Взвешенный прогноз" value={c.weightedPipelineLabel || "—"} to={path("/deals")} />
          <Kpi label="На договоре" value={c.contractStage} to={path("/deals", { stage: "contract" })} />
          <Kpi label="Заявки ждут клиента" value={c.waitingClientInquiries} to={path("/inquiries", {filter: "waiting_client", test: "false"})} />
          <Kpi label="Нужен ответ" value={c.needsReply} to="/contacts?filter=needs_reply" />
          <Kpi label="Без след. шага" value={nextActionItems.length} to={noNextHref} />
          <Kpi label="Просрочено" value={c.overdueTasks} to="/tasks?filter=overdue" />
          <Kpi label="Зависли" value={c.stalledDeals} to={path("/deals", { focus: "stalled" })} />
          <Kpi label="КП без ответа" value={c.proposalWithoutReply ?? 0} to={path("/deals", { focus: "proposal_no_reply" })} />
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
            <span className="muted">Компактный снимок</span>
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
            <Kpi label="Диалоги AI" value={ai.conversations?.ai ?? 0} to="/conversations?filter=ai" />
            <Kpi label="У менеджера" value={ai.conversations?.human ?? 0} to="/conversations?filter=human" />
            <Kpi label="Требуют вмешательства" value={ai.conversations?.needsAttention ?? 0} to="/conversations?filter=attention" emphasize />
            <Kpi label="Заявки из WhatsApp" value={ai.whatsappInquiries ?? 0} to={path("/inquiries", { source: "whatsapp", test: "false" }, true)} />
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
