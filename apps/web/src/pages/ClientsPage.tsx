import { notifySaved } from "../components/SaveNotice";
import { useUrlState, useRequestVersion } from "../lib/useUrlState";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PERIOD_OPTIONS, formatCustomPeriodLabel } from "../lib/period";
import { tip } from "../lib/tip";
import { formatWaitSince } from "../lib/duration";
import { api } from "../lib/api";
import { Pagination } from "../components/Pagination";

const FILTERS = [
  ["all", "Все"],
  ["new", "Новые"],
  ["in_progress", "В работе"],
  ["needs_reply", "Нужен ответ"],
  ["today", "Сегодня"],
  ["overdue", "Просрочено"],
  ["no_next", "Без следующего шага"],
] as const;

function clientsNewLabel(n: number) {
  const n10 = n % 10;
  const n100 = n % 100;
  const word = n10 === 1 && n100 !== 11 ? "новый клиент" : n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) ? "новых клиента" : "новых клиентов";
  return `${n} ${word}`;
}

export function ClientsPage() {
  const requestVersion = useRequestVersion();
  const navigate = useNavigate();
  const [filter, setFilter] = useUrlState("filter", "all", FILTERS.map(([value]) => value));
  const [q, setQ] = useUrlState<string>("q", "");
  const [draft, setDraft] = useState(q);
  const [showFilters, setShowFilters] = useState(false);
  const [status, setStatus] = useUrlState<string>("status", "");
  const [source, setSource] = useUrlState<string>("source", "");
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [period] = useUrlState<string>("period", "all");
  const [dateFrom] = useUrlState<string>("from", "");
  const [dateTo] = useUrlState<string>("to", "");
  const [owner] = useUrlState<string>("owner", "");
  const [creating, setCreating] = useState(false);
  const [offset, setOffset] = useUrlState<string>("offset", "0");
  const [loading, setLoading] = useState(true);

  async function load(next: { filter?: string; q?: string; status?: string; source?: string } = {}) {
    const request = ++requestVersion.current;
    setLoading(true);
    try {
      const query: Record<string, string> = {
        filter: next.filter ?? filter,
        owner,
        period,
        dateFrom,
        dateTo,
        offset,
      };
      const queryText = next.q ?? q;
      if (queryText) query.q = queryText;
      const st = next.status ?? status;
      const src = next.source ?? source;
      if (st) query.status = st;
      if (src) query.source = src;
      const result = await api.contacts(query);
      if (request !== requestVersion.current) return;
      setData(result);
      setError("");
    } catch (err) {
      if (request !== requestVersion.current) return;
      setError(err instanceof Error ? err.message : "Ошибка");
    } finally {
      if (request === requestVersion.current) setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [filter, q, status, source, period, dateFrom, dateTo, owner, offset]);

  useEffect(() => setDraft(q), [q]);

  const newClients = Number(data?.attention?.new ?? data?.metrics?.new ?? 0);
  const waitingReply = Number(data?.attention?.needsReply ?? data?.metrics?.needsReply ?? 0);
  function openNewClients() {
    navigate("/contacts?filter=new");
  }

  return (
    <section className="clients-page">
      <div className="page-head">
        <div>
          <h2>Клиенты</h2>
          {filter === "new" ? (
            <p className="muted">Как цифра в меню: клиенты со статусом «Новый», ещё не взятые в работу.</p>
          ) : (
            <p className="muted">
              Кто · откуда · что нужно · что делать дальше
              {newClients > 0 ? `. Цифра в меню — ${clientsNewLabel(newClients)}.` : ""}
            </p>
          )}
        </div>
        <button className="btn" onClick={() => setCreating((value) => !value)}>
          + Клиент
        </button>
      </div>

      {period !== "all" || owner ? <div className="active-filter-note">
        <span>{period !== "all" ? `Первое обращение: ${period === "custom" ? formatCustomPeriodLabel(dateFrom, dateTo) : PERIOD_OPTIONS.find(option => option.id === period)?.label || period}` : ""}{owner ? ` · ${owner === "me" ? "Мои клиенты" : "Без ответственного"}` : ""}</span>
        <button className="btn secondary" onClick={() => navigate("/contacts")}>Снять отбор</button>
      </div> : null}
      {filter !== "new" && !q && newClients > 0 ? (
        <div className="active-filter-note">
          <span>{clientsNewLabel(newClients)} — те же, что цифра у «Клиенты» в меню.</span>
          <button type="button" className="btn secondary" onClick={openNewClients}>
            Показать
          </button>
        </div>
      ) : null}
      {creating ? (
        <form
          className="panel"
          onSubmit={async (event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            try {
              const created = (await api.createContact({
                name: form.get("name"),
                phone: form.get("phone") || undefined,
                source: form.get("source") || "manual",
                comment: form.get("comment") || undefined,
                companyName: form.get("companyName") || undefined,
              })) as any;
              notifySaved("Клиент создан");
              navigate(`/contacts/${created.client.id}`);
            } catch (err) {
              setError(err instanceof Error ? err.message : "Не создано");
            }
          }}
        >
          <b>Новый клиент</b>
          <label>
            Имя
            <input name="name" required />
          </label>
          <label>
            Телефон
            <input name="phone" placeholder="+7 ..." />
          </label>
          <label>
            Компания
            <input name="companyName" />
          </label>
          <label>
            Источник
            <select name="source" defaultValue="manual">
              <option value="manual">Вручную</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="form">Форма сайта</option>
              <option value="phone_call">Звонок</option>
              <option value="api">API</option>
            </select>
          </label>
          <label>
            Задача / комментарий
            <textarea name="comment" />
          </label>
          <button className="btn">Создать</button>
        </form>
      ) : null}

      <form
        className="search-bar"
        onSubmit={(event) => {
          event.preventDefault();
          setQ(draft.trim());
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Имя, телефон, компания, задача, тег…"
        />
        <button className="btn">Найти</button>
        <button type="button" className="btn secondary" onClick={() => setShowFilters((value) => !value)}>
          Фильтры
        </button>
      </form>

      {showFilters ? (
        <div className="filter-panel">
          <label>
            Статус
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">Любой</option>
              <option value="new">Новый</option>
              <option value="in_progress">В работе</option>
              <option value="active">Активный</option>
              <option value="paused">На паузе</option>
              <option value="lost">Потерян</option>
            </select>
          </label>
          <label>
            Источник
            <select value={source} onChange={(event) => setSource(event.target.value)}>
              <option value="">Любой</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="form">Форма</option>
              <option value="manual">Вручную</option>
              <option value="webhook">Webhook</option>
            </select>
          </label>
        </div>
      ) : null}

      <div className="actions chip-row">
        {FILTERS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={filter === value ? "btn" : "btn secondary"}
            {...(value === "today"
              ? tip("Клиенты, с которыми был контакт сегодня")
              : value === "new"
                ? tip("Как цифра в меню: статус «Новый»")
                : value === "needs_reply"
                  ? tip("Последнее сообщение было от клиента — ещё не ответили")
                  : {})}
            onClick={() => (value === "new" ? openNewClients() : setFilter(value))}
          >
            {label}
            {value === "new" && newClients > 0 ? ` · ${newClients}` : ""}
            {value === "needs_reply" && waitingReply > 0 ? ` · ${waitingReply}` : ""}
          </button>
        ))}
      </div>

      {error ? <p className="error">{error}</p> : null}
      {!data ? <div className="state">Загрузка…</div> : null}
      {data && data.items.length === 0 ? (
        <p className="empty">
          {filter === "new"
            ? "Нет новых клиентов."
            : filter === "needs_reply"
            ? "Нет клиентов, которые ждут ответа."
            : q || filter !== "all"
              ? "По выбранным условиям клиенты не найдены."
              : "Клиентов нет. Создайте вручную или дождитесь заявки."}
        </p>
      ) : null}

      {data ? <Pagination total={data.total} offset={data.offset} limit={data.limit} loading={loading} onChange={next => setOffset(String(next))} /> : null}
      {data?.items.map((item: any) => (
        <Link className="client-row" key={item.id} to={`/contacts/${item.id}`}>
          <div className="client-row-main">
            <div className="client-row-title">
              <b>{item.name}</b>
              {item.companyName ? <span className="muted"> · {item.companyName}</span> : null}
            </div>
            <div className="muted">{item.phone || "Нет телефона"}</div>
            <div className="client-meta">
              <span className="badge">{item.lifecycleLabel}</span>
              {item.inquiryStatusLabel ? <span className="badge">{item.inquiryStatusLabel}</span> : null}
              {item.needsReply ? (
                <span className="badge warn">
                  Нужен ответ{item.waitMinutes != null ? ` · ${formatWaitSince(item.waitMinutes)}` : ""}
                </span>
              ) : null}
              {item.overdue ? <span className="badge danger">Просрочено</span> : null}
              {item.activeDeal ? <span className="badge">Сделка</span> : null}
            </div>
            <div className="muted">
              {item.interest || "Интерес пока не определён"}
              {item.interestSource === "conversation" ? (
                <span className="badge" {...tip("Определено по сообщению клиента. Откройте карточку, чтобы проверить переписку.")}>Из переписки</span>
              ) : null}
              {item.sourceLabel ? ` · ${item.sourceLabel}` : ""}
              {item.acquisition ? ` · ${item.acquisition}` : ""}
            </div>
            <div className="muted">
              Первое: {item.firstContactLabel || "—"} · Последний: {item.lastContactLabel || "—"}
              {item.inquiryCount ? ` · Заявок: ${item.inquiryCount}` : ""}
              {item.openTaskCount ? ` · Задач: ${item.openTaskCount}` : ""}
            </div>
          </div>
          <div className="client-row-side">
            <div>
              <span className="muted">Следующее действие</span>
              <div>
                {item.nextAction ? (
                  <>
                    {item.nextAction.title}
                    {item.nextAction.dueLabel ? ` · ${item.nextAction.dueLabel}` : ""}
                  </>
                ) : item.missingNextAction ? (
                  <span className="warn-text">Нет следующего действия</span>
                ) : (
                  "—"
                )}
              </div>
            </div>
            <div className="muted">Ответственный: {item.ownerName || "не назначен"}</div>
          </div>
        </Link>
      ))}
      {data && (data.hasMore || data.offset > 0) ? <Pagination total={data.total} offset={data.offset} limit={data.limit} loading={loading} onChange={next => setOffset(String(next))} /> : null}
    </section>
  );
}
