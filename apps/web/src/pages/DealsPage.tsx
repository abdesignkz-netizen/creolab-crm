import { uiTaskTitle, uiMessage, uiText, useUiText, localizeUiOptions, uiFormatLocale , uiDurationLabel } from "../lib/uiText";
import { esfMeasureUnitSymbol } from "@creolab/contracts";
import { notifySaved } from "../components/SaveNotice";
import { MeasureUnitSelect } from "../components/MeasureUnitSelect";
import { useUrlState, useRequestVersion } from "../lib/useUrlState";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { PeriodSelector, type PeriodPreset } from "../components/PeriodSelector";
import { nameWithPhone, phoneText } from "../lib/contactDisplay";
import { api } from "../lib/api";
import { useCapabilities } from "../lib/session";
import { tip } from "../lib/tip";
import { DealDocumentsPanel } from "./DealDocumentsPanel";
import { CONTRACT_SIGNING_ENABLED } from "../lib/featureFlags";
import { dealOutcomeLabel } from "../lib/labels";
import { DealList } from "../components/DealList";
import { ContractWorkspaceModal } from "../components/ContractWorkspaceModal";

type Scope = "all" | "mine" | "unassigned";
type TimeMode = "now" | "period";
type PeriodBasis = "created" | "activity" | "closed";
type Focus =
  | "all"
  | "stalled"
  | "needs_reply"
  | "no_next_action"
  | "proposal_no_reply"
  | "over_sla"
  | "payment_overdue"
  | "overdue_next_action";

const FOCUS_VALUES = new Set<Focus>([
  "all",
  "stalled",
  "needs_reply",
  "no_next_action",
  "proposal_no_reply",
  "over_sla",
  "payment_overdue",
  "overdue_next_action",
]);

const PAYMENT_STATUS_LABEL: Record<string, string> = {
  NOT_REQUIRED: "Не требуется",
  NOT_INVOICED: "Не выставлен",
  INVOICED: "Счёт выставлен",
  PARTIALLY_PAID: "Частично оплачен",
  PAID: "Оплачен",
  OVERDUE: "Просрочен",
  CANCELLED: "Отменён",
};

const EDOC_KPI_RANK: Record<string, number> = {
  ACCEPTED: 6,
  SENT: 5,
  SENDING: 4,
  SIGNED: 3,
  VALIDATED: 2,
  DRAFT: 1,
  ERROR: 0,
};

const EDOC_KPI_LABEL: Record<string, string> = {
  DRAFT: "Черновик",
  VALIDATED: "Сформирован",
  SIGNED: "Подписан",
  SENDING: "Отправлен",
  SENT: "Отправлен",
  ACCEPTED: "Подтверждён",
  ERROR: "Ошибка",
};

function electronicDocKpi(docs: any, type: "AVR" | "ESF") {
  if (!docs) return "—";
  const items = (docs.electronicDocuments || []).filter((row: { type?: string }) => row.type === type);
  if (!items.length) return uiText("Нет");
  const best = items.reduce((current: { status?: string }, row: { status?: string }) =>
    (EDOC_KPI_RANK[row.status || ""] || 0) > (EDOC_KPI_RANK[current.status || ""] || 0) ? row : current,
  );
  return localizeUiOptions(EDOC_KPI_LABEL, uiText)[best.status || ""] || uiText("Черновик");
}

function toDatetimeLocal(iso?: string | null) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function dealAttention(deal: any): { text: string; tone: "ok" | "warn" | "next" | "muted" } | null {
  if (deal.outcome === "won") return { text: uiText("Продажа"), tone: "ok" };
  if (deal.outcome === "lost") return { text: deal.lossReason ? uiText("Потеря · {p0}", {p0: deal.lossReason}) : uiText("Потеря"), tone: "muted" };
  if (deal.flags?.overdueTask) return { text: uiText("Просрочена задача"), tone: "warn" };
  if (deal.flags?.paymentOverdue) return { text: uiText("Просрочена оплата"), tone: "warn" };
  if (deal.flags?.overdueNextAction) return { text: uiText("Просрочен follow-up"), tone: "warn" };
  if (deal.flags?.overSla || deal.flags?.slaStatus === "OVERDUE") return { text: uiText("Просрочен SLA"), tone: "warn" };
  if (deal.flags?.needsReply) return { text: uiText("Нужен ответ"), tone: "warn" };
  if (deal.flags?.proposalWithoutReply) return { text: uiText("КП без ответа"), tone: "warn" };
  if (deal.flags?.slaStatus === "WARNING") return { text: uiText("SLA близко"), tone: "warn" };
  if (deal.flags?.stalled) return { text: uiText("Зависла"), tone: "warn" };
  if (deal.nextAction) {
    return {
      text: deal.nextActionAt
        ? `${deal.nextAction} · ${new Date(deal.nextActionAt).toLocaleString(uiFormatLocale(), { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`
        : deal.nextAction,
      tone: "next",
    };
  }
  if (deal.outcome === "open") return { text: uiText("Нет следующего шага"), tone: "warn" };
  return null;
}

function DealBoardCard({
  deal,
  dragging,
  canDrag,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  deal: any;
  dragging: boolean;
  canDrag: boolean;
  onOpen: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const uiText = useUiText();
  const companyName = String(deal.company?.name || "").trim();
  const contactName = String(deal.contact?.name || "").trim();
  const client = companyName || contactName || uiText("Клиент не указан");
  const person = companyName && contactName && contactName !== companyName ? contactName : "";
  const phone = deal.contact ? phoneText(deal.contact.phone) : "";
  const attention = dealAttention(deal);

  return (
    <article
      className={`deal-card${dragging ? " dragging" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={uiText("Открыть сделку: {p0}", {p0: deal.title})}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      draggable={canDrag}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
    >
      <b className="deal-card-title">{deal.title}</b>
      <div className="deal-card-who">
        <span className="deal-card-client">{client}</span>
        {person ? <span className="deal-card-person">{person}</span> : null}
        {phone ? <span className="deal-card-phone">{phone}</span> : null}
      </div>
      <div className="deal-card-meta">
        <span className="deal-card-amount">{deal.amountLabel || uiText("Сумма не указана")}</span>
        {deal.outcome === "open" && uiDurationLabel(deal.stageDurationLabel) ? (
          <span className="deal-card-age">{uiDurationLabel(deal.stageDurationLabel)} {" "}{uiText("на этапе")}</span>
        ) : null}
      </div>
      {attention ? <div className={`deal-card-status ${attention.tone}`}>{attention.text}</div> : null}
      {deal.assigneeName ? <div className="deal-card-owner">{deal.assigneeName}</div> : null}
    </article>
  );
}

export function DealsPage() {
  const uiText = useUiText();
  const caps = useCapabilities();
  const [view, setView] = useUrlState("view", "list", ["list", "board"]);
  const [selectedContractId, setSelectedContractId] = useState<string | null>(null);
  const requestVersion = useRequestVersion();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [timeMode, setTimeMode] = useUrlState<TimeMode>("timeMode", "now");
  const [period, setPeriod] = useUrlState<PeriodPreset>("period", "today");
  const [dateFrom, setDateFrom] = useUrlState<string>("from", "");
  const [dateTo, setDateTo] = useUrlState<string>("to", "");
  const [basis, setBasis] = useUrlState<PeriodBasis>("basis", "created");
  const [scope, setScope] = useUrlState<Scope>("scope", "all");
  const [focus, setFocus] = useUrlState<Focus>("focus", "all", [...FOCUS_VALUES]);
  const [stage, setStage] = useUrlState<string>("stage", "");
  const [outcome, setOutcome] = useUrlState<string>("outcome", "");
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [contactQ, setContactQ] = useState("");
  const [contactHits, setContactHits] = useState<any[]>([]);
  const [pickedContact, setPickedContact] = useState<any>(null);
  const [pickedCompanyId, setPickedCompanyId] = useState("");
  const [contactCompanies, setContactCompanies] = useState<any[]>([]);
  const [createError, setCreateError] = useState("");
  const [createBusy, setCreateBusy] = useState(false);

  useEffect(() => {
    const focusParam = searchParams.get("focus");
    if (!focusParam) return;
    if (FOCUS_VALUES.has(focusParam as Focus)) {
      return;
    }
    // Legacy/deep link: /deals?focus=<dealId> → card
    navigate(`/deals/${focusParam}`, { replace: true });
  }, [searchParams, navigate]);

  async function load() {
    const request = ++requestVersion.current;
    try {
      if (timeMode === "period" && period === "custom" && (!dateFrom || !dateTo)) {
        setError(uiText("Укажите даты С и По"));
        return;
      }
      const result = await api.deals({
          scope,
          stage,
          outcome,
          view: "board",
          timeMode,
          period: timeMode === "period" ? period : undefined,
          dateFrom: timeMode === "period" && period === "custom" ? dateFrom : undefined,
          dateTo: timeMode === "period" && period === "custom" ? dateTo : undefined,
          basis: timeMode === "period" ? basis : undefined,
          focus: timeMode === "now" ? focus : undefined,
        });
      if (request !== requestVersion.current) return;
      setData(result);
      setError("");
    } catch (err) {
      if (request !== requestVersion.current) return;
      setError(err instanceof Error ? err.message : uiText("Ошибка"));
    }
  }

  useEffect(() => {
    void load();
  }, [scope, timeMode, period, dateFrom, dateTo, basis, focus, stage, outcome]);

  useEffect(() => {
    if (!createOpen) return;
    const t = setTimeout(() => {
      api
        .searchContacts(contactQ.trim())
        .then((res: any) => setContactHits(res.clients || []))
        .catch(() => setContactHits([]));
    }, contactQ.trim() ? 220 : 0);
    return () => clearTimeout(t);
  }, [contactQ, createOpen]);

  useEffect(() => {
    if (!pickedContact?.id) {
      setContactCompanies([]);
      setPickedCompanyId("");
      return;
    }
    void api
      .contactCompanies(pickedContact.id)
      .then((res: any) => {
        const list = res.companies || res.items || [];
        setContactCompanies(list);
        setPickedCompanyId(list[0]?.company?.id || "");
      })
      .catch(() => setContactCompanies([]));
  }, [pickedContact?.id]);

  async function createDeal() {
    if (!createTitle.trim() || !pickedContact?.id) {
      setCreateError(uiText("Укажите название и клиента"));
      return;
    }
    setCreateBusy(true);
    setCreateError("");
    try {
      const created: any = await api.createDeal({
        title: createTitle.trim(),
        contactId: pickedContact.id,
        companyId: pickedCompanyId || null,
      });
      const id = created.deal?.id || created.id;
      setCreateOpen(false);
      setCreateTitle("");
      setPickedContact(null);
      notifySaved(uiText("Сделка создана"));
      navigate(`/deals/${id}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : uiText("Не удалось создать сделку"));
    } finally {
      setCreateBusy(false);
    }
  }

  async function onDrop(stageId: string) {
    if (!dragId || busy || timeMode !== "now") return;
    setBusy(true);
    try {
      await api.changeDealStage(dragId, { stageId });
      setDragId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Не удалось переместить"));
    } finally {
      setBusy(false);
    }
  }

  if (!data && !error) return <div className="state">{uiText("Загрузка…")}</div>;
  if (!data) {
    return (
      <section>
        <p className="error">{error}</p>
        <button type="button" className="btn" onClick={() => void load()}>
          {uiText("Повторить")}</button>
      </section>
    );
  }

  const s = data.summary;

  return (
    <section className="deals-page">
      <div className="page-head">
        <div>
          <h2>{uiText("Сделки")}</h2>
          <p className="muted">{uiText("Заказы, суммы и состояние документов по каждой сделке.")}</p>
        </div>
        <div className="sit-toolbar-side">
          {data.period?.label ? <span className="muted">{uiMessage(data.period.label)}</span> : null}
          <button type="button" className="btn" onClick={() => setCreateOpen(true)}>
            {uiText("Новая сделка")}</button>
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}
      {stage || outcome ? <div className="active-filter-note">
        <span>{uiText("Отбор:")}{" "}{stage ? data.columns?.find((column: any) => column.systemKey === stage)?.name || stage : ""}{stage && outcome ? " · " : ""}{({ won: uiText("Продажи"), lost: uiText("Потери"), open: uiText("Активные"), on_hold: uiText("На паузе") } as Record<string, string>)[outcome]}</span>
        <button className="btn secondary" onClick={() => navigate(`/deals?${new URLSearchParams({ timeMode, period, from: dateFrom, to: dateTo, basis, scope })}`)}>{uiText("Снять отбор")}</button>
      </div> : null}

      <div className="segmented sit-scope" style={{ width: "fit-content", marginBottom: 10 }}>
        {(
          [
            ["now", uiText("Сейчас")],
            ["period", uiText("За период")],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={timeMode === value ? "btn" : "btn secondary"}
            onClick={() => {
              setTimeMode(value);
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {timeMode === "period" ? (
        <>
          <PeriodSelector
            period={period}
            onPeriodChange={setPeriod}
            dateFrom={dateFrom}
            dateTo={dateTo}
            onDateFromChange={setDateFrom}
            onDateToChange={setDateTo}
            activeLabel={data.period?.label}
          />
          <div className="segmented sit-scope" style={{ width: "fit-content", marginTop: 8 }}>
            {(
              [
                ["created", uiText("Созданные")],
                ["activity", uiText("С активностью")],
                ["closed", uiText("Закрытые")],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={basis === value ? "btn" : "btn secondary"}
                onClick={() => setBasis(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      ) : null}

      <div className="sit-kpi-grid deals-summary" style={{ marginTop: 12 }}>
        {s.mode === "period" ? (
          <>
            <div className="sit-kpi">
              <span className="muted">{uiText("Создано сделок")}</span>
              <strong>{s.createdDeals ?? "—"}</strong>
            </div>
            <div className="sit-kpi">
              <span className="muted">{uiText("Закрыто успешно")}</span>
              <strong>{s.wonDeals ?? "—"}</strong>
            </div>
            <div className="sit-kpi">
              <span className="muted">{uiText("Потеряно")}</span>
              <strong>{s.lostDeals ?? "—"}</strong>
            </div>
            <div className="sit-kpi">
              <span className="muted">{uiText("Продано")}</span>
              <strong>{s.soldAmountLabel || "—"}</strong>
            </div>
          </>
        ) : (
          <>
            <div className="sit-kpi">
              <span className="muted">{uiText("Активные")}</span>
              <strong>{s.activeDeals}</strong>
            </div>
            <div className="sit-kpi">
              <span className="muted">{uiText("Сумма сделок")}</span>
              <strong>{s.pipelineAmountLabel || "—"}</strong>
              {s.amountKnownOf ? (
                <span className="kpi-hint">
                  {uiText("сумма у")}{" "}{s.amountKnownCount} {" "}{uiText("из")}{" "}{s.amountKnownOf}
                </span>
              ) : null}
            </div>
            <div className="sit-kpi">
              <span className="muted">{uiText("Ожидаемые оплаты")}</span>
              <strong>{s.expectedPaymentsLabel || "—"}</strong>
            </div>
          </>
        )}
      </div>

      <div className="deals-filters-row">
        <div className="segmented sit-scope" style={{ width: "fit-content" }}>
          {(
            [
              ["all", uiText("Все")],
              ["mine", uiText("Мои")],
              ["unassigned", uiText("Без ответственного")],
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
        {timeMode === "now" ? (
          <div className="segmented sit-scope" style={{ width: "fit-content" }}>
            {(
              [
                ["all", uiText("Все")],
                ["stalled", uiText("Зависшие")],
                ["needs_reply", uiText("Нужен ответ")],
                ["no_next_action", uiText("Без следующего шага")],
                ["over_sla", uiText("Сверх SLA")],
                ["overdue_next_action", uiText("Просрочен шаг")],
                ["payment_overdue", uiText("Оплата")],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={focus === value ? "btn" : "btn secondary"}
                onClick={() => setFocus(value)}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="deal-view-toolbar">
        <div className="segmented" aria-label={uiText("Вид сделок")}>
          <button type="button" className={view === "list" ? "btn" : "btn secondary"} aria-pressed={view === "list"} onClick={() => setView("list")}>{uiText("Список")}</button>
          <button type="button" className={view === "board" ? "btn" : "btn secondary"} aria-pressed={view === "board"} onClick={() => setView("board")}>{uiText("Доска по этапам")}</button>
        </div>
        <label>{uiText("Этап")}<select aria-label={uiText("Этап")} value={stage} onChange={(event) => setStage(event.target.value)}><option value="">{uiText("Все этапы")}</option>{(data.columns || []).map((column: any) => <option key={column.stageId} value={column.systemKey}>{column.name}</option>)}</select></label>
        <label>{uiText("Статус сделки")}<select aria-label={uiText("Статус сделки")} value={outcome} onChange={(event) => setOutcome(event.target.value)}><option value="">{timeMode === "now" ? uiText("Активные и на паузе") : uiText("Все статусы")}</option><option value="open">{uiText("В работе")}</option><option value="on_hold">{uiText("На паузе")}</option><option value="won">{uiText("Успешно завершена")}</option><option value="lost">{uiText("Потеряна")}</option></select></label>
        <button type="button" className="btn secondary" onClick={() => void load()}>{uiText("Обновить")}</button>
      </div>
      {data.limitReached ? <p className="warn">{uiText("Показаны первые")}{" "}{data.limit} {" "}{uiText("сделок. Уточните период, этап или ответственного, чтобы сузить список.")}</p> : null}
      {view === "list" ? <DealList items={data.items || [...(data.columns || []).flatMap((column: any) => column.deals), ...(data.onHold || [])]} documentsAllowed={caps.documents && data.documentsAllowed !== false} onOpenContract={setSelectedContractId} /> : <div className="deal-kanban">
        {(data.columns || []).map((col: any) => (
          <div
            key={col.stageId}
            className={`deal-column${col.deals.length ? "" : " is-empty"}`}
            onDragOver={(e) => {
              if (timeMode === "now") e.preventDefault();
            }}
            onDrop={() => void onDrop(col.stageId)}
          >
            <div className="deal-column-head">
              <b>{col.name}</b>
              <span className="muted">
                {col.count
                  ? `${col.count} · ${col.amountLabel || uiText("без сумм")}`
                  : uiText("Пусто")}
              </span>
            </div>
            <div className="deal-column-body">
              {col.deals.map((deal: any) => (
                <DealBoardCard
                  key={deal.id}
                  deal={deal}
                  dragging={dragId === deal.id}
                  canDrag={timeMode === "now" && deal.outcome === "open"}
                  onOpen={() => navigate(`/deals/${deal.id}`)}
                  onDragStart={() => setDragId(deal.id)}
                  onDragEnd={() => setDragId(null)}
                />
              ))}
              {col.deals.length === 0 ? <p className="deal-column-empty">{uiText("Нет сделок")}</p> : null}
            </div>
          </div>
        ))}
      </div>}

      {view === "board" && data.onHold?.length ? (
        <div className="sit-section">
          <h3>{uiText("На паузе")}</h3>
          {data.onHold.map((deal: any) => (
            <Link key={deal.id} className="sit-list-row" to={`/deals/${deal.id}`}>
              <div>
                <b>{deal.title}</b>
                <div className="muted">{nameWithPhone(deal.contact?.name, deal.contact?.phone)}</div>
              </div>
              <span className="muted">{deal.amountLabel || "—"}</span>
            </Link>
          ))}
        </div>
      ) : null}

      {selectedContractId ? <ContractWorkspaceModal key={selectedContractId} contractId={selectedContractId} onClose={() => setSelectedContractId(null)} onChanged={load} /> : null}
      {createOpen ? (
        <div className="stats-modal-backdrop" onClick={() => setCreateOpen(false)}>
          <div className="stats-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{uiText("Новая сделка")}</h3>
            <p className="muted">{uiText("Без заявки. Клиент обязателен, компанию можно указать позже.")}</p>
            {createError ? <p className="error">{createError}</p> : null}
            <label>
              {uiText("Название")}<input value={createTitle} onChange={(e) => setCreateTitle(e.target.value)} placeholder={uiText("Сайт для…")} />
            </label>
            <label>
              {uiText("Клиент")}<input
                value={pickedContact ? pickedContact.name || "" : contactQ}
                onChange={(e) => {
                  setPickedContact(null);
                  setContactQ(e.target.value);
                }}
                placeholder={uiText("Имя или телефон")}
              />
            </label>
            {!pickedContact ? (
              <div className="picker-list" style={{ marginTop: 8 }}>
                {contactHits.map((hit) => (
                  <button
                    key={hit.id}
                    type="button"
                    className="picker-item"
                    onClick={() => {
                      setPickedContact(hit);
                      setContactQ("");
                      if (!createTitle.trim()) setCreateTitle(hit.name || "");
                    }}
                  >
                    <b>{hit.name}</b>
                    <div className="muted">{[hit.phone, hit.companyName].filter(Boolean).join(" · ")}</div>
                  </button>
                ))}
              </div>
            ) : (
              <p className="muted">{uiText("Клиент:")}{" "}{pickedContact.name}</p>
            )}
            {contactCompanies.length ? (
              <label>
                {uiText("Компания")}<select value={pickedCompanyId} onChange={(e) => setPickedCompanyId(e.target.value)}>
                  <option value="">{uiText("Без компании")}</option>
                  {contactCompanies.map((row: any) => {
                    const company = row.company || row;
                    return (
                      <option key={company.id} value={company.id}>
                        {company.name}
                      </option>
                    );
                  })}
                </select>
              </label>
            ) : null}
            <div className="row" style={{ gap: 8, marginTop: 12 }}>
              <button
                type="button"
                className="btn"
                disabled={createBusy || !createTitle.trim() || !pickedContact}
                onClick={() => void createDeal()}
              >
                {createBusy ? uiText("Создаём…") : uiText("Создать")}
              </button>
              <button type="button" className="btn secondary" onClick={() => setCreateOpen(false)}>
                {uiText("Отмена")}</button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function DealDetailPage() {
  const uiText = useUiText();
  const caps = useCapabilities();
  const { dealId } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [amount, setAmount] = useState("");
  const [probability, setProbability] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [nextActionAt, setNextActionAt] = useState("");
  const [paymentStatus, setPaymentStatus] = useState("NOT_INVOICED");
  const [lossReason, setLossReason] = useState("Дорого");
  const [lossNote, setLossNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [board, setBoard] = useState<any>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payComment, setPayComment] = useState("");
  const [itemName, setItemName] = useState("");
  const [itemQty, setItemQty] = useState("1");
  const [itemPrice, setItemPrice] = useState("");
  const [itemUnit, setItemUnit] = useState("шт");
  const [itemVat, setItemVat] = useState("0");
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [itemFormOpen, setItemFormOpen] = useState(false);
  const itemLoadedDeal = useRef<string | null>(null);
  function resetItemForm() {
    setEditingItemId(null);
    setItemName("");
    setItemQty("1");
    setItemPrice("");
    setItemUnit("шт");
    setItemVat("0");
  }
  function editItem(item: any) {
    setEditingItemId(item.id);
    setItemName(item.name);
    setItemQty(String(item.quantity));
    setItemPrice(String(item.unitPrice));
    setItemUnit(esfMeasureUnitSymbol(item.unit));
    setItemVat(String(item.vatRate ?? 0));
    setItemFormOpen(true);
  }
  function newItem() {
    resetItemForm();
    setItemFormOpen(true);
  }
  function closeItemForm() {
    setItemFormOpen(false);
    resetItemForm();
  }
  const [docs, setDocs] = useState<any>(null);
  const [readiness, setReadiness] = useState<any>(null);
  const [invoiceReadiness, setInvoiceReadiness] = useState<any>(null);
  const [avrReadiness, setAvrReadiness] = useState<any>(null);
  const [esfInvoiceReadiness, setEsfInvoiceReadiness] = useState<any>(null);
  const [closeReadiness, setCloseReadiness] = useState<any>(null);
  const [companyQ, setCompanyQ] = useState("");
  const [companyHits, setCompanyHits] = useState<any[]>([]);
  const [signing, setSigning] = useState<any>(null);
  const [buyerLink, setBuyerLink] = useState("");
  const [esfPreview, setEsfPreview] = useState<any>(null);
  const [esfInvoicePreview, setEsfInvoicePreview] = useState<any>(null);

  async function load() {
    if (!dealId) return;
    try {
      const [detail, boardData, documents, contractReady, invoiceReady, avrReady, esfReady, closeReady] = await Promise.all([
        api.deal(dealId),
        api.deals({ timeMode: "now" }),
        caps.documents ? api.dealDocuments(dealId).catch(() => null) : Promise.resolve(null),
        caps.documents ? api.contractReadiness(dealId).catch(() => null) : Promise.resolve(null),
        caps.documents ? api.invoiceReadiness(dealId).catch(() => null) : Promise.resolve(null),
        caps.documents ? api.avrReadiness(dealId).catch(() => null) : Promise.resolve(null),
        caps.documents ? api.esfInvoiceReadiness(dealId).catch(() => null) : Promise.resolve(null),
        caps.documents ? api.dealCloseReadiness(dealId).catch(() => null) : Promise.resolve(null),
      ]);
      setData(detail);
      setBoard(boardData);
      setDocs(documents);
      setReadiness(contractReady);
      setInvoiceReadiness(invoiceReady);
      setAvrReadiness(avrReady);
      setEsfInvoiceReadiness(esfReady);
      setCloseReadiness(closeReady);
      const contractId = (documents as any)?.contracts?.[0]?.id;
      setSigning(CONTRACT_SIGNING_ENABLED && contractId ? await api.contractSigning(contractId).catch(() => null) : null);
      const d = (detail as any).deal;
      if (itemLoadedDeal.current !== dealId) {
        itemLoadedDeal.current = dealId;
        setItemFormOpen(false);
        resetItemForm();
      }
      setAmount(d.amount != null ? String(d.amount) : "");
      setProbability(String(d.probability ?? 10));
      setNextAction(d.nextAction || "");
      setNextActionAt(toDatetimeLocal(d.nextActionAt));
      setPaymentStatus(d.paymentStatus || "NOT_INVOICED");
      if (d.lossReason) setLossReason(d.lossReason);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Ошибка"));
    }
  }

  useEffect(() => {
    void load();
  }, [dealId]);

  useEffect(() => {
    const t = setTimeout(() => {
      api
        .companies({ q: companyQ.trim() || undefined })
        .then((res: any) => setCompanyHits(res.items || []))
        .catch(() => setCompanyHits([]));
    }, companyQ.trim() ? 220 : 0);
    return () => clearTimeout(t);
  }, [companyQ]);

  const [editing, setEditing] = useState(true);

  async function save() {
    if (!dealId || busy) return;
    setBusy(true);
    try {
      await api.updateDeal(dealId, {
        ...((data as any)?.deal?.amountFromItems || caps.manager
          ? {}
          : { offerAmountMinor: amount === "" ? null : Number(amount) }),
        probability: Number(probability),
        nextAction: nextAction || null,
        nextActionAt: nextActionAt ? new Date(nextActionAt).toISOString() : null,
        ...(caps.confirmPayments ? { paymentStatus } : {}),
      });
      setEditing(false);
      notifySaved(uiText("Изменения сделки сохранены"));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Не сохранено"));
    } finally {
      setBusy(false);
    }
  }

  async function confirmPayment() {
    if (!dealId) return;
    const amountMinor = Math.round(Number(String(payAmount).replace(/\s+/g, "").replace(",", ".")));
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
      setError(uiText("Укажите сумму оплаты"));
      return;
    }
    setBusy(true);
    try {
      await api.addDealPayment(dealId, {
        amountMinor,
        comment: payComment.trim() || undefined,
      });
      setPayAmount("");
      setPayComment("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Не удалось подтвердить оплату"));
    } finally {
      setBusy(false);
    }
  }

  if (!data && !error) return <div className="state">{uiText("Загрузка…")}</div>;
  if (!data) {
    return (
      <section>
        <p className="error">{error}</p>
        <Link to="/deals">{uiText("К списку сделок")}</Link>
      </section>
    );
  }

  const d = data.deal;
  const payments = data.payments || [];
  const paidTotal = payments.reduce((sum: number, p: any) => sum + Number(p.amountMinor || 0), 0);
  const dealAmount = d.amount != null ? Number(d.amount) : null;
  const remaining =
    dealAmount != null && Number.isFinite(dealAmount) ? Math.max(0, dealAmount - paidTotal) : null;

  return (
    <section className="deal-detail">
      <div className="page-head">
        <div>
          <p className="page-kicker">
            <Link to="/deals">{uiText("Сделки")}</Link>
            {caps.documents ? (
              <>
                {" · "}
                <Link to="/documents">{uiText("Документы")}</Link>
              </>
            ) : null}
          </p>
          <h2>{d.title}</h2>
          {d.number ? <p className="muted">{uiText("Сделка")}{" "}{d.number}</p> : null}
          <p className="muted">
            {nameWithPhone(d.contact?.name, d.contact?.phone)}
            {d.stage?.name ? ` · ${d.stage.name}` : ""}
            {d.outcome && d.outcome !== "open" ? ` · ${dealOutcomeLabel(d.outcome)}` : ""}
          </p>
        </div>
      </div>
      {error ? <p className="error">{error}</p> : null}

      <div className={`sit-kpi-grid${caps.documents ? " deal-kpi-5" : ""}`}>
        <div className="sit-kpi">
          <span className="muted">{uiText("Сумма")}</span>
          <strong>{d.amountLabel || "—"}</strong>
        </div>
        <div className="sit-kpi">
          <span className="muted">{uiText("На этапе")}</span>
          <strong>{uiDurationLabel(d.stageDurationLabel)}</strong>
        </div>
        <div className="sit-kpi">
          <span className="muted">{uiText("Оплата")}</span>
          <strong>{localizeUiOptions(PAYMENT_STATUS_LABEL, uiText)[d.paymentStatus] || d.paymentStatus}</strong>
        </div>
        {caps.documents ? (
          <>
            <a className="sit-kpi" href="#avr">
              <span className="muted">{uiText("АВР")}</span>
              <strong>{electronicDocKpi(docs, "AVR")}</strong>
            </a>
            <a className="sit-kpi" href="#esf">
              <span className="muted">{uiText("ЭСФ")}</span>
              <strong>{electronicDocKpi(docs, "ESF")}</strong>
            </a>
          </>
        ) : null}
      </div>

      <div className="panel">
        <div className="row"><b>{uiText("Позиции")}</b><button type="button" className="btn secondary" disabled={busy} onClick={newItem}>{uiText("Добавить новую позицию")}</button></div>
        <p className="muted">{uiText("Они же попадут в договор, счёт, АВР и ЭСФ.")}</p>
        {(d.items || []).length === 0 ? <p className="empty">{uiText("Позиций пока нет")}</p> : null}
        {(d.items || []).map((item: any) => (
          <div className="row" key={item.id}>
            <div>
              <b>{item.name}</b>
              <div className="muted">
                {item.quantity} {esfMeasureUnitSymbol(item.unit)} × {Number(item.unitPrice).toLocaleString(uiFormatLocale())} ₸
                {item.vatRate ? uiText(" · НДС {p0}%", {p0: item.vatRate}) : uiText(" · без НДС")}
              </div>
            </div>
            <div>
              <b>{Number(item.totalAmount).toLocaleString(uiFormatLocale())} ₸</b>
              <div>
                <button type="button" className="btn secondary" disabled={busy} onClick={() => editItem(item)}>{uiText("Изменить")}</button>
                <button
                  type="button"
                  className="btn secondary"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void api
                      .deleteDealItem(d.id, item.id)
                      .then(() => { if (editingItemId === item.id) closeItemForm(); return load(); })
                      .catch((err) => setError(err instanceof Error ? err.message : uiText("Не удалось удалить")))
                      .finally(() => setBusy(false));
                  }}
                >
                  {uiText("Удалить")}</button>
              </div>
            </div>
          </div>
        ))}
        {d.itemTotals ? (
          <p>
            {uiText("Итого:")}{" "}<b>{Number(d.itemTotals.totalAmount).toLocaleString(uiFormatLocale())} ₸</b>
            {d.itemTotals.vatAmount ? uiText(" · НДС {p0} ₸", {p0: Number(d.itemTotals.vatAmount).toLocaleString(uiFormatLocale())}) : ""}
          </p>
        ) : null}
        {itemFormOpen ? (
        <div className="deal-edit" style={{ marginTop: 12 }}>
          <b>{editingItemId ? uiText("Редактирование позиции") : uiText("Новая позиция")}</b>
          <label>
            {uiText("Услуга")}<input value={itemName} onChange={(e) => setItemName(e.target.value)} placeholder={uiText("Разработка сайта")} />
          </label>
          <label>
            {uiText("Кол-во")}<input value={itemQty} onChange={(e) => setItemQty(e.target.value)} />
          </label>
          <label>
            {uiText("Ед. изм.")}<MeasureUnitSelect value={itemUnit} onChange={setItemUnit} />
          </label>
          <label>
            {uiText("Цена без НДС (₸)")}<input value={itemPrice} onChange={(e) => setItemPrice(e.target.value)} />
          </label>
          <label>
            {uiText("НДС")}<select aria-label={uiText("НДС")} value={itemVat} onChange={(e) => setItemVat(e.target.value)}>
              <option value="0">{uiText("Без НДС")}</option>
              <option value="12">{uiText("С НДС (12%)")}</option>
              {!["0", "12"].includes(itemVat) ? <option value={itemVat}>{uiText("С НДС (")}{itemVat}{uiText("%) — из документа")}</option> : null}
            </select>
          </label>
          <div className="actions">
            <button
              type="button"
              className="btn"
              disabled={busy || !itemName.trim() || !itemPrice}
              onClick={() => {
                setBusy(true);
                const input = {
                  name: itemName.trim(),
                  quantity: Number(String(itemQty).replace(",", ".")),
                  unit: itemUnit,
                  unitPrice: Number(String(itemPrice).replace(/\s+/g, "").replace(",", ".")),
                  vatRate: Number(itemVat),
                };
                void (editingItemId ? api.updateDealItem(d.id, editingItemId, input) : api.addDealItem(d.id, input))
                  .then(() => {
                    notifySaved(editingItemId ? uiText("Позиция сохранена") : uiText("Позиция добавлена"));
                    closeItemForm();
                    return load();
                  })
                  .catch((err) => setError(err instanceof Error ? err.message : uiText("Не удалось добавить позицию")))
                  .finally(() => setBusy(false));
              }}
            >
              {editingItemId ? uiText("Сохранить позицию") : uiText("Добавить позицию")}
            </button>
            <button type="button" className="btn secondary" disabled={busy} onClick={closeItemForm}>
              {uiText("Отмена")}</button>
          </div>
        </div>
        ) : null}
      </div>

      <div className="panel">
        <b>{uiText("Покупатель для договора")}</b>
        <p className="muted">
          {d.company ? (
            <>
              {uiText("Компания:")}{" "}<Link to={`/companies/${d.company.id}`}>{d.company.name}</Link>
            </>
          ) : (
            uiText("Компания не указана — без неё PDF не собрать.")
          )}
        </p>
        <label>
          {uiText("Найти компанию")}<input value={companyQ} onChange={(e) => setCompanyQ(e.target.value)} placeholder={uiText("Название или БИН")} />
        </label>
        {companyHits.length ? (
          <div className="picker-list" style={{ marginTop: 8 }}>
            {companyHits.slice(0, 8).map((company: any) => (
              <button
                key={company.id}
                type="button"
                className="picker-item"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void api
                    .updateDeal(d.id, { companyId: company.id })
                    .then(() => {
                      setCompanyQ("");
                      return load();
                    })
                    .catch((err) => setError(err instanceof Error ? err.message : uiText("Не удалось привязать компанию")))
                    .finally(() => setBusy(false));
                }}
              >
                <b>{company.name}</b>
                <div className="muted">{[company.legalName, company.bin].filter(Boolean).join(" · ")}</div>
              </button>
            ))}
          </div>
        ) : null}
        {d.company ? (
          <div className="actions" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="btn secondary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void api
                  .updateDeal(d.id, { companyId: null })
                  .then(() => load())
                  .catch((err) => setError(err instanceof Error ? err.message : uiText("Не удалось отвязать компанию")))
                  .finally(() => setBusy(false));
              }}
            >
              {uiText("Отвязать компанию")}</button>
          </div>
        ) : null}
      </div>

      {caps.documents ? (
      <DealDocumentsPanel
        deal={d}
        docs={docs}
        readiness={readiness}
        invoiceReadiness={invoiceReadiness}
        avrReadiness={avrReadiness}
        esfInvoiceReadiness={esfInvoiceReadiness}
        closeReadiness={closeReadiness}
        setReadiness={setReadiness}
        setInvoiceReadiness={setInvoiceReadiness}
        setAvrReadiness={setAvrReadiness}
        setEsfInvoiceReadiness={setEsfInvoiceReadiness}
        busy={busy}
        setBusy={setBusy}
        setError={setError}
        load={load}
        signing={signing}
        buyerLink={buyerLink}
        setBuyerLink={setBuyerLink}
        esfPreview={esfPreview}
        setEsfPreview={setEsfPreview}
        esfInvoicePreview={esfInvoicePreview}
        setEsfInvoicePreview={setEsfInvoicePreview}
      />
      ) : null}

      {!editing ? <div className="panel saved-editor-summary">
        <b>{uiText("Данные сделки")}</b>
        <button type="button" className="btn secondary" autoFocus onClick={() => setEditing(true)}>{uiText("Редактировать сделку")}</button>
      </div> : <div className="panel deal-edit">
        <b>{uiText("Редактирование")}</b>
        <label>
          {uiText("Сумма (₸)")}<input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={uiText("пусто = неизвестна")}
            disabled={Boolean(d.amountFromItems) || caps.manager}
          />
        </label>
        <label>
          {uiText("Следующий шаг")}<input value={nextAction} onChange={(e) => setNextAction(e.target.value)} placeholder={uiText("Позвонить клиенту")} />
        </label>
        <label>
          {uiText("Когда")}<input type="datetime-local" value={nextActionAt} onChange={(e) => setNextActionAt(e.target.value)} />
        </label>
        {caps.confirmPayments ? (
        <label>
          {uiText("Статус оплаты")}<select value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value)}>
            {(board?.paymentStatuses || ["NOT_INVOICED", "INVOICED", "PAID"]).map((s: string) => (
              <option key={s} value={s}>
                {localizeUiOptions(PAYMENT_STATUS_LABEL, uiText)[s] || s}
              </option>
            ))}
          </select>
        </label>
        ) : null}
        <div className="actions">
          <button
            type="button"
            className="btn"
            disabled={busy}
            {...tip(uiText("Сохранить сумму, следующий шаг и статус оплаты"))}
            onClick={() => void save()}
          >
            {uiText("Сохранить")}</button>
          {d.contact?.id ? (
            <Link className="btn secondary" to={`/contacts/${d.contact.id}`} {...tip(uiText("Открыть карточку клиента"))}>
              {uiText("Клиент")}</Link>
          ) : null}
          {d.inquiryId ? (
            <Link className="btn secondary" to={`/requests/${d.inquiryId}`} {...tip(uiText("Открыть исходную заявку"))}>
              {uiText("Заявка")}</Link>
          ) : null}
        </div>
      </div>}

      {caps.confirmPayments ? (
      <div className="panel">
        <b>{uiText("Платежи")}</b>
        <div className="muted" style={{ marginBottom: 8 }}>
          {uiText("Оплачено:")}{" "}{paidTotal.toLocaleString(uiFormatLocale())} ₸
          {remaining != null ? uiText(" · остаток: {p0} ₸", {p0: remaining.toLocaleString(uiFormatLocale())}) : ""}
        </div>
        {payments.length === 0 ? <p className="empty">{uiText("Платежей пока нет")}</p> : null}
        {payments.map((p: any) => (
          <div className="row" key={p.id}>
            <div>
              <b>{Number(p.amountMinor || 0).toLocaleString(uiFormatLocale())} {p.currency || "KZT"}</b>
              <div className="muted">
                {p.createdAt ? new Date(p.createdAt).toLocaleString(uiFormatLocale()) : ""}
                {p.comment ? ` · ${p.comment}` : ""}
              </div>
            </div>
          </div>
        ))}
        <div className="deal-edit" style={{ marginTop: 12 }}>
          <label>
            {uiText("Сумма платежа (₸)")}<input
              value={payAmount}
              onChange={(e) => setPayAmount(e.target.value)}
              placeholder={remaining != null && remaining > 0 ? String(remaining) : uiText("например 150000")}
            />
          </label>
          <label>
            {uiText("Комментарий")}<input value={payComment} onChange={(e) => setPayComment(e.target.value)} placeholder={uiText("необязательно")} />
          </label>
          <div className="actions">
            <button
              type="button"
              className="btn"
              disabled={busy}
              {...tip(uiText("Зафиксировать платёж и обновить статус оплаты сделки"))}
              onClick={() => void confirmPayment()}
            >
              {uiText("Подтвердить оплату")}</button>
          </div>
        </div>
      </div>
      ) : null}

      <div className="panel">
        <b>{uiText("Перевести на стадию")}</b>
        <div className="deal-stage-actions">
          {(board?.columns || []).map((col: any) => (
            <button
              key={col.stageId}
              type="button"
              className={col.stageId === d.stageId ? "btn" : "btn secondary"}
              disabled={busy || col.stageId === d.stageId}
              onClick={() => {
                setBusy(true);
                void api
                  .changeDealStage(d.id, { stageId: col.stageId })
                  .then(() => load())
                  .catch((err) => setError(err instanceof Error ? err.message : uiText("Ошибка")))
                  .finally(() => setBusy(false));
              }}
            >
              {col.name}
            </button>
          ))}
        </div>
      </div>

      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={busy || d.outcome === "won"}
          {...tip(uiText("Отметить, что сделка продана"))}
          onClick={() => {
            setBusy(true);
            void api
              .markDealWon(d.id, { wonAmountMinor: d.amount })
              .then(() => load())
              .catch((err) => setError(err instanceof Error ? err.message : uiText("Ошибка")))
              .finally(() => setBusy(false));
          }}
        >
          {uiText("Продажа")}</button>
        <button
          type="button"
          className="btn secondary"
          disabled={busy}
          {...tip(
            d.outcome === "on_hold"
              ? uiText("Вернуть сделку в работу")
              : uiText("Отложить сделку, не закрывая её"),
          )}
          onClick={() => {
            setBusy(true);
            void api
              .holdDeal(d.id, d.outcome !== "on_hold")
              .then(() => load())
              .catch((err) => setError(err instanceof Error ? err.message : uiText("Ошибка")))
              .finally(() => setBusy(false));
          }}
        >
          {d.outcome === "on_hold" ? uiText("Снять с паузы") : uiText("На паузу")}
        </button>
        <select value={lossReason} onChange={(e) => setLossReason(e.target.value)} title={uiText("Причина проигрыша")}>
          {(board?.lostReasons || ["Дорого", "Другое"]).map((r: string) => (
            <option key={r} value={r}>
              {uiMessage(r)}
            </option>
          ))}
        </select>
        <input
          value={lossNote}
          onChange={(e) => setLossNote(e.target.value)}
          placeholder={uiText("Комментарий к потере")}
          style={{ minWidth: 160 }}
        />
        <button
          type="button"
          className="btn danger"
          disabled={busy || d.outcome === "lost"}
          {...tip(uiText("Отметить, что сделка не состоялась"))}
          onClick={() => {
            setBusy(true);
            void api
              .markDealLost(d.id, { lossReason, note: lossNote || undefined })
              .then(() => load())
              .catch((err) => setError(err instanceof Error ? err.message : uiText("Ошибка")))
              .finally(() => setBusy(false));
          }}
        >
          {uiText("Потеря")}</button>
        <button
          type="button"
          className="btn secondary"
          {...tip(uiText("Создать задачу, привязанную к этой сделке и клиенту"))}
          onClick={() =>
            navigate(
              `/tasks?dealId=${d.id}${d.contact?.id || d.contactId ? `&contactId=${d.contact?.id || d.contactId}` : ""}`,
            )
          }
        >
          {uiText("+ Задача")}</button>
      </div>

      <div className="panel">
        <b>{uiText("История стадий")}</b>
        {(data.stageHistory || []).length === 0 ? <p className="empty">{uiText("Пока нет")}</p> : null}
        {(data.stageHistory || []).map((h: any) => (
          <div className="row" key={h.id}>
            <div>
              <b>
                {h.fromSystemKey || "—"} → {h.toSystemKey}
              </b>
              <div className="muted">{new Date(h.enteredAt).toLocaleString(uiFormatLocale())}</div>
            </div>
          </div>
        ))}
      </div>

      {d.tasks?.length ? (
        <div className="panel">
          <b>{uiText("Открытые задачи")}</b>
          {d.tasks.map((t: any) => (
            <div className="row" key={t.id}>
              <div>
                <b>{uiTaskTitle(t)}</b>
                <div className="muted">{t.dueAt ? new Date(t.dueAt).toLocaleString(uiFormatLocale()) : uiText("без срока")}</div>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
