import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PeriodSelector, type PeriodPreset } from "../components/PeriodSelector";
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

function deltaText(value: number | null | undefined) {
  if (value == null || value === 0) return null;
  return value > 0 ? `↑ ${value}` : `↓ ${Math.abs(value)}`;
}

function ageLabel(minutes: number) {
  if (minutes < 60) return `${minutes} мин`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} ч`;
  return `${Math.round(minutes / 1440)} дн.`;
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
  to,
  emphasize,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  delta?: number | null;
  to?: string;
  emphasize?: boolean;
}) {
  const inner = (
    <>
      <span className="muted">{label}</span>
      <strong className={emphasize ? "kpi-emphasize" : undefined}>{value}</strong>
      {hint ? <span className="kpi-hint">{hint}</span> : null}
      {deltaText(delta) ? <span className="kpi-delta">{deltaText(delta)}</span> : null}
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
  const navigate = useNavigate();
  const [scope, setScope] = useState<Scope>("all");
  const [period, setPeriod] = useState<PeriodPreset>("today");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [onlyImportant, setOnlyImportant] = useState(false);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [meMissing, setMeMissing] = useState(false);

  async function load() {
    try {
      const me = (await api.me()) as any;
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
      setData(
        await api.situationOverview({
          period,
          scope,
          onlyImportant,
          dateFrom: period === "custom" ? dateFrom : undefined,
          dateTo: period === "custom" ? dateTo : undefined,
        }),
      );
      setError("");
    } catch (err) {
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
        <h2>Ситуация</h2>
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

  return (
    <section className="situation-page">
      <div className="page-head sit-head">
        <div>
          <p className="page-kicker">Оперативный центр</p>
          <h2>Ситуация</h2>
        </div>
        <div className="sit-meta">
          <span className={data.aiManager?.status === "error" ? "error" : "muted"}>{data.aiManager?.label}</span>
          <span className="muted">Обновлено {timeShort(data.asOf)}</span>
        </div>
      </div>

      {data.aiManager?.newRequests ? (
        <div className="sit-kpi-grid" style={{ marginBottom: 12 }}>
          <Kpi label="AI обрабатывает заявки" value={data.aiManager.newRequests.processing} to="/inquiries" />
          <Kpi label="Ожидают менеджера" value={data.aiManager.newRequests.needsHuman} to="/inquiries" />
          <Kpi label="Ошибка AI-обработки" value={data.aiManager.newRequests.analysisFailed} to="/inquiries" />
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

      <div className="sit-brief">
        <b>Кратко</b>
        <p>{data.brief}</p>
      </div>

      <div className="sit-section sit-result">
        <div className="sit-section-head">
          <h3>За {data.period.label.toLowerCase()}</h3>
          <span className="muted">Результат выбранного периода</span>
        </div>
        <div className="sit-kpi-grid">
          <Kpi label="Обращения" value={r.inquiries} delta={r.deltas?.inquiries} to="/inquiries" />
          <Kpi label="Новые клиенты" value={r.newClients} delta={r.deltas?.newClients} to="/contacts" />
          <Kpi label="Заявки" value={r.requests} to="/inquiries" />
          <Kpi label="Сделки" value={r.dealsCreated} delta={r.deltas?.dealsCreated} to="/deals" />
          <Kpi label="Продажи" value={r.wonDeals} delta={r.deltas?.wonDeals} to="/deals" emphasize />
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
            to="/deals"
            emphasize
          />
          <Kpi
            label="Потеряно"
            value={r.lostDeals}
            hint={r.lostReasons?.[0] ? `${r.lostReasons[0].reason} · ${r.lostReasons[0].count}` : undefined}
            to="/deals"
          />
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
          <Kpi label="Активные сделки" value={c.activeDeals} to="/deals" emphasize />
          <Kpi
            label="В работе"
            value={c.activePipelineAmountLabel || "—"}
            hint={
              c.amountKnownOf
                ? `сумма известна у ${c.amountKnownCount} из ${c.amountKnownOf}`
                : undefined
            }
            to="/deals"
            emphasize
          />
          <Kpi label="Взвешенный прогноз" value={c.weightedPipelineLabel || "—"} to="/deals" />
          <Kpi label="На договоре" value={c.contractStage} to="/deals" />
          <Kpi label="Ждём клиента" value={c.waitingClient} to={c.hrefs?.inquiriesWaiting || "/inquiries"} />
          <Kpi label="Нужен ответ" value={c.needsReply} to="/conversations" />
          <Kpi label="Без след. шага" value={c.noNextAction} to="/tasks" />
          <Kpi label="Просрочено" value={c.overdueTasks} to="/tasks" />
          <Kpi label="Зависли" value={c.stalledDeals} to="/deals" />
          <Kpi label="КП без ответа" value={c.proposalWithoutReply ?? 0} to="/deals" />
        </div>
        <div className="sit-pipeline">
          <b>На стадиях сейчас</b>
          <div className="sit-pipeline-row">
            {(data.pipeline?.stages || []).map((stage: any) => (
              <Link key={stage.systemKey} className="sit-pipe-chip" to="/deals">
                <span>{stage.name}</span>
                <strong>{stage.count}</strong>
              </Link>
            ))}
          </div>
        </div>
      </div>

      <div className="sit-section sit-attention">
        <div className="sit-section-head">
          <h3>Требует внимания</h3>
          <span className="muted">Приоритетные действия</span>
        </div>
        <div className="sit-attn-summary">
          <Link to="/conversations">Нужно ответить · {attention.summary.needsReply}</Link>
          <Link to="/tasks">Просрочено · {attention.summary.overdueTasks}</Link>
          <Link to="/deals">КП без ответа · {attention.summary.proposalWithoutReply ?? 0}</Link>
          <Link to="/tasks">Без шага · {attention.summary.noNextAction}</Link>
          <Link to="/deals">Зависли · {attention.summary.stalledDeals}</Link>
          <Link to="/conversations">Нужен человек · {attention.summary.needsHuman}</Link>
          <Link to="/inquiries?filter=needs_clarification">Нет контакта · {attention.summary.noContact}</Link>
        </div>

        {attention.items.length === 0 ? (
          <p className="empty sit-empty-ok">{attention.emptyLabel}</p>
        ) : (
          attention.items.map((item: any) => (
            <div className={`row severity-${item.severity} sit-attn-row`} key={item.id}>
              <div>
                <b>{item.title}</b>
                <div className="muted">{item.reason}</div>
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
                        api.completeIntake(item.entityId, { phone: form.get("phone"), name: form.get("name") }),
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
                        return navigate(item.links?.contactId ? `/contacts/${item.links.contactId}` : "/tasks");
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

      <div className="sit-two-col sit-today-row">
        <div className="sit-section">
          <div className="sit-section-head">
            <h3>Сегодня</h3>
            <span className="muted">
              {today.totalDueToday} задач · выполнено {today.doneToday} · осталось {today.remaining}
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
                  {[agr.contactName, agr.inquiryTitle, agr.dealStage].filter(Boolean).join(" · ")}
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
            <Link className="sit-list-row" key={task.id} to="/tasks">
              <div>
                <b>{task.title}</b>
                <div className="muted">
                  {task.typeLabel}
                  {task.contactName ? ` · ${task.contactName}` : ""}
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
            <Link className="sit-list-row" key={deal.id} to="/deals">
              <div>
                <b>{deal.title}</b>
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

      <div className="sit-two-col sit-events-row">
        <div className="sit-section">
          <div className="sit-section-head">
            <h3>Последние обращения</h3>
          </div>
          {data.recentInquiries?.map((inq: any) => (
            <Link className="sit-list-row" key={inq.id} to={inq.href}>
              <div>
                <b>{inq.contactName}</b>
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
                    <div className="muted">{item.title}</div>
                  </div>
                  <span className="muted">{timeShort(item.at)}</span>
                </Link>
              ))
            : null}
          {data.recentEvents?.map((ev: any) => (
            <Link className="sit-list-row" key={ev.id} to={ev.href}>
              <div>
                <b>{ev.title}</b>
                <div className="muted">{ev.contactName || ev.description || ev.type}</div>
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
