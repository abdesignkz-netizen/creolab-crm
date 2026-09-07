import { useUrlState, useRequestVersion } from "../lib/useUrlState";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PERIOD_OPTIONS, formatCustomPeriodLabel } from "../lib/period";
import { tip } from "../lib/tip";
import { api } from "../lib/api";

const FILTERS = [
  ["all", "Все"],
  ["new", "Новые"],
  ["in_progress", "В работе"],
  ["needs_reply", "Нужен ответ"],
  ["today", "Сегодня"],
  ["overdue", "Просрочено"],
  ["no_next", "Без следующего шага"],
] as const;

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

  async function load(next: { filter?: string; q?: string; status?: string; source?: string } = {}) {
    const request = ++requestVersion.current;
    try {
      const query: Record<string, string> = {
        filter: next.filter ?? filter,
        owner,
        period,
        dateFrom,
        dateTo,
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
    }
  }

  useEffect(() => {
    load();
  }, [filter, q, status, source, period, dateFrom, dateTo, owner]);

  useEffect(() => setDraft(q), [q]);

  return (
    <section className="clients-page">
      <div className="page-head">
        <div>
          <h2>Клиенты</h2>
          <p className="muted">Кто · откуда · что нужно · что делать дальше</p>
        </div>
        <button className="btn" onClick={() => setCreating((value) => !value)}>
          + Клиент
        </button>
      </div>

      {period !== "all" || owner ? <div className="active-filter-note">
        <span>{period !== "all" ? `Первое обращение: ${period === "custom" ? formatCustomPeriodLabel(dateFrom, dateTo) : PERIOD_OPTIONS.find(option => option.id === period)?.label || period}` : ""}{owner ? ` · ${owner === "me" ? "Мои клиенты" : "Без ответственного"}` : ""}</span>
        <button className="btn secondary" onClick={() => navigate("/contacts")}>Снять отбор</button>
      </div> : null}
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
          <button key={value} className={filter === value ? "btn" : "btn secondary"} {...(value === "today" ? tip("Клиенты, с которыми был контакт сегодня") : {})} onClick={() => setFilter(value)}>
            {label}
          </button>
        ))}
      </div>

      {error ? <p className="error">{error}</p> : null}
      {!data ? <div className="state">Загрузка…</div> : null}
      {data && data.items.length === 0 ? <p className="empty">Клиентов нет. Создайте вручную или дождитесь заявки.</p> : null}

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
              {item.needsReply ? <span className="badge warn">Нужен ответ</span> : null}
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
    </section>
  );
}
