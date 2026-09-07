import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";

type ListResponse = {
  items: any[];
  counts: Record<string, number>;
  sourceCounts?: Record<string, number>;
  categoryCounts?: Record<string, number>;
  clarification: any[];
};

const STATUS_FILTERS: Array<{ key: string; label: string }> = [
  { key: "all", label: "Все" },
  { key: "new", label: "Новые" },
  { key: "needs_reply", label: "Нужен ответ" },
  { key: "in_progress", label: "В работе" },
  { key: "waiting_client", label: "Ждём клиента" },
  { key: "qualified", label: "Квалифицированные" },
  { key: "converted", label: "В сделке" },
  { key: "lost", label: "Потерянные" },
];

const ATTENTION_FILTERS: Array<{ key: string; label: string }> = [
  { key: "unassigned", label: "Без ответственного" },
  { key: "no_phone", label: "Без телефона" },
  { key: "needs_clarification", label: "Требует уточнения" },
  { key: "today", label: "Сегодня" },
];

const SERVICE_OPTIONS = [
  { value: "web", label: "Сайты" },
  { value: "presentation", label: "Презентации" },
  { value: "branding", label: "Брендинг" },
  { value: "advertising", label: "Реклама" },
  { value: "ai", label: "AI" },
  { value: "other", label: "Другое" },
];

const SOURCE_OPTIONS = [
  { value: "manual", label: "Ручное добавление" },
  { value: "website_form", label: "Форма сайта" },
  { value: "website_ai", label: "Website AI" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "telegram", label: "Telegram" },
  { value: "instagram", label: "Instagram" },
  { value: "phone", label: "Звонок" },
  { value: "api", label: "API" },
  { value: "other", label: "Другое" },
];

const FILTER_LABELS: Record<string, string> = Object.fromEntries(
  [...STATUS_FILTERS, ...ATTENTION_FILTERS].map((item) => [item.key, item.label]),
);

export function RequestsPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filter = params.get("filter") || "all";
  const sourceChannel = params.get("source") || "";
  const serviceCategory = params.get("category") || "";
  const q = params.get("q") || "";
  const companyId = params.get("company") || "";
  const contactId = params.get("contact") || "";
  const [query, setQuery] = useState(q);
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(Boolean(companyId || contactId));
  const [createError, setCreateError] = useState("");
  const [lookup, setLookup] = useState<any>(null);
  const [forceNew, setForceNew] = useState(false);
  const [companyPrefill, setCompanyPrefill] = useState("");
  const [contactPrefill, setContactPrefill] = useState<{ name: string; phone: string }>({ name: "", phone: "" });

  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    setShowCreate(true);
    void api
      .company(companyId)
      .then((company: any) => {
        if (cancelled) return;
        setCompanyPrefill(company?.name || company?.legalName || "");
      })
      .catch(() => {
        if (!cancelled) setCompanyPrefill("");
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  useEffect(() => {
    if (!contactId) return;
    let cancelled = false;
    setShowCreate(true);
    void api
      .contactOverview(contactId)
      .then((overview: any) => {
        if (cancelled) return;
        const client = overview?.client || overview;
        setContactPrefill({
          name: client?.name || "",
          phone: client?.phone || "",
        });
        if (client?.companyName) setCompanyPrefill((prev) => prev || client.companyName);
        setLookup(
          overview?.client
            ? {
                found: true,
                contact: {
                  id: contactId,
                  name: client.name,
                  inquiryCount: overview.requests?.length || 0,
                  lastInquiryAt: overview.currentRequest?.receivedAt || null,
                },
              }
            : null,
        );
      })
      .catch(() => {
        if (!cancelled) setContactPrefill({ name: "", phone: "" });
      });
    return () => {
      cancelled = true;
    };
  }, [contactId]);

  async function load(
    nextFilter = filter,
    nextQ = q,
    nextSource = sourceChannel,
    nextCategory = serviceCategory,
  ) {
    setLoading(true);
    try {
      const result = (await api.inquiries({
        filter: nextFilter,
        q: nextQ,
        sourceChannel: nextSource || undefined,
        serviceCategory: nextCategory || undefined,
        limit: 80,
      })) as ListResponse;
      setData(result);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка загрузки");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(filter, q, sourceChannel, serviceCategory);
  }, [filter, q, sourceChannel, serviceCategory]);

  const counts = data?.counts || {};
  const sourceCounts = data?.sourceCounts || {};
  const categoryCounts = data?.categoryCounts || {};

  function patchParams(patch: Record<string, string | null>) {
    const nextParams = new URLSearchParams(params);
    Object.entries(patch).forEach(([key, value]) => {
      if (!value) nextParams.delete(key);
      else nextParams.set(key, value);
    });
    setParams(nextParams);
  }

  function setFilter(next: string) {
    patchParams({ filter: next === "all" ? null : next });
  }

  function setSource(next: string) {
    patchParams({ source: sourceChannel === next ? null : next || null });
  }

  function setCategory(next: string) {
    patchParams({ category: serviceCategory === next ? null : next || null });
  }

  function clearExtraFilters() {
    patchParams({ source: null, category: null, filter: filter === "all" ? null : filter });
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    patchParams({ q: query.trim() || null });
  }

  const activeExtras = [
    filter !== "all" ? { key: "filter", label: FILTER_LABELS[filter] || filter } : null,
    sourceChannel
      ? {
          key: "source",
          label: `Откуда: ${SOURCE_OPTIONS.find((o) => o.value === sourceChannel)?.label || sourceChannel}`,
        }
      : null,
    serviceCategory
      ? {
          key: "category",
          label: `Услуга: ${SERVICE_OPTIONS.find((o) => o.value === serviceCategory)?.label || serviceCategory}`,
        }
      : null,
    q ? { key: "q", label: `Поиск: ${q}` } : null,
  ].filter(Boolean) as Array<{ key: string; label: string }>;

  async function onPhoneBlur(phone: string) {
    if (!phone.trim()) {
      setLookup(null);
      return;
    }
    try {
      const result = await api.lookupInquiryContact(phone);
      setLookup(result);
      setForceNew(false);
    } catch {
      setLookup(null);
    }
  }

  async function createRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setCreateError("");
    try {
      const created = (await api.createInquiry({
        name: form.get("name"),
        phone: form.get("phone") || undefined,
        company: form.get("company") || undefined,
        serviceCategory: form.get("serviceCategory") || undefined,
        subject: form.get("subject") || undefined,
        message: form.get("message") || undefined,
        sourceChannel: form.get("sourceChannel") || "manual",
        contactId: !forceNew && lookup?.found ? lookup.contact.id : undefined,
        forceNewContact: forceNew,
      })) as { id: string };
      setShowCreate(false);
      navigate(`/requests/${created.id}`);
    } catch (err: any) {
      setCreateError(err.body?.field_errors?.phone || err.message || "Не удалось создать");
    }
  }

  const clarification = useMemo(() => data?.clarification || [], [data]);

  if (loading && !data) return <div className="state">Загрузка заявок…</div>;

  return (
    <section className="requests-page">
      <div className="page-head">
        <div>
          <p className="page-kicker">Воронка обращений</p>
          <h2>Заявки</h2>
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? "Скрыть форму" : "+ Новая заявка"}
          </button>
        </div>
      </div>

      <div className="request-metrics cards">
        <div className="card"><span className="muted">Все</span><strong>{counts.all ?? 0}</strong></div>
        <div className="card"><span className="muted">Новые</span><strong>{counts.new ?? 0}</strong></div>
        <div className="card"><span className="muted">Нужен ответ</span><strong>{counts.needs_reply ?? 0}</strong></div>
        <div className="card"><span className="muted">В работе</span><strong>{counts.in_progress ?? 0}</strong></div>
        <div className="card"><span className="muted">Требует уточнения</span><strong>{counts.needs_clarification ?? 0}</strong></div>
      </div>

      <form className="search-bar" onSubmit={submitSearch}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Имя, телефон, компания, тема или задача"
        />
        <button className="btn secondary" type="submit">
          Найти
        </button>
      </form>

      <div className="request-filter-board">
        <div className="request-filter-group">
          <span className="request-filter-label">Статус</span>
          <div className="request-status-tabs" role="tablist" aria-label="Статус заявок">
            {STATUS_FILTERS.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`chip ${filter === item.key ? "active" : ""}`}
                onClick={() => setFilter(item.key)}
              >
                {item.label}
                {counts[item.key] != null ? ` · ${counts[item.key]}` : ""}
              </button>
            ))}
          </div>
        </div>

        <div className="request-toolbar">
          <label className="request-filter-label" style={{ display: "grid", gap: 4 }}>
            Внимание
            <select
              className="filter-select"
              value={ATTENTION_FILTERS.some((f) => f.key === filter) ? filter : ""}
              onChange={(e) => setFilter(e.target.value || "all")}
            >
              <option value="">Не выбрано</option>
              {ATTENTION_FILTERS.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                  {counts[item.key] != null ? ` (${counts[item.key]})` : ""}
                </option>
              ))}
            </select>
          </label>

          <label className="request-filter-label" style={{ display: "grid", gap: 4 }}>
            Откуда пришли
            <select
              className="filter-select"
              value={sourceChannel}
              onChange={(e) => setSource(e.target.value)}
            >
              <option value="">Все источники</option>
              {SOURCE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                  {sourceCounts[opt.value] != null ? ` (${sourceCounts[opt.value]})` : ""}
                </option>
              ))}
            </select>
          </label>

          <label className="request-filter-label" style={{ display: "grid", gap: 4 }}>
            Услуга
            <select
              className="filter-select"
              value={serviceCategory}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">Все услуги</option>
              {SERVICE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                  {categoryCounts[opt.value] != null ? ` (${categoryCounts[opt.value]})` : ""}
                </option>
              ))}
            </select>
          </label>
        </div>

        {activeExtras.length > 0 ? (
          <div className="request-filter-active">
            <span className="muted">Сейчас:</span>
            {activeExtras.map((item) => (
              <button
                key={item.key}
                type="button"
                className="chip active"
                onClick={() => {
                  if (item.key === "filter") setFilter("all");
                  else if (item.key === "source") setSource("");
                  else if (item.key === "category") setCategory("");
                  else if (item.key === "q") {
                    setQuery("");
                    patchParams({ q: null });
                  }
                }}
                title="Сбросить"
              >
                {item.label} ×
              </button>
            ))}
            {(sourceChannel || serviceCategory || filter !== "all") && (
              <button type="button" className="linkish" onClick={clearExtraFilters}>
                Сбросить фильтры
              </button>
            )}
          </div>
        ) : null}
      </div>

      {error ? <p className="error">{error}</p> : null}

      {showCreate ? (
        <form className="panel request-create" onSubmit={createRequest}>
          <b>Новая заявка</b>
          <label>
            Клиент
            <input
              key={contactPrefill.name || "name-empty"}
              name="name"
              required
              placeholder="Имя, телефон или существующий клиент"
              defaultValue={contactPrefill.name}
            />
          </label>
          <label>
            Телефон
            <input
              key={contactPrefill.phone || "phone-empty"}
              name="phone"
              placeholder="+7 ..."
              defaultValue={contactPrefill.phone}
              onBlur={(e) => void onPhoneBlur(e.target.value)}
            />
          </label>
          {lookup?.found ? (
            <div className="panel soft lookup-banner">
              <div>
                <b>Найден существующий клиент</b>
                <div>{lookup.contact.name}</div>
                <div className="muted">
                  {lookup.contact.inquiryCount} предыдущих заявок
                  {lookup.contact.lastInquiryAt
                    ? ` · последний контакт: ${new Date(lookup.contact.lastInquiryAt).toLocaleDateString("ru-RU")}`
                    : ""}
                </div>
              </div>
              <div className="actions">
                <button type="button" className={`btn ${!forceNew ? "" : "secondary"}`} onClick={() => setForceNew(false)}>
                  Использовать клиента
                </button>
                <button
                  type="button"
                  className={`btn ${forceNew ? "" : "secondary"}`}
                  onClick={() => {
                    if (
                      forceNew ||
                      window.confirm("Может получиться дубль клиента. Создать нового всё равно?")
                    ) {
                      setForceNew(true);
                    }
                  }}
                >
                  Создать нового всё равно
                </button>
              </div>
            </div>
          ) : null}
          <label>
            Компания
            <input
              key={companyPrefill || "company-empty"}
              name="company"
              placeholder="необязательно"
              defaultValue={companyPrefill}
            />
          </label>
          <label>
            Что интересует
            <select name="serviceCategory" defaultValue="presentation">
              {SERVICE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Краткая тема
            <input name="subject" placeholder="Например: расчёт презентации" />
          </label>
          <label>
            Задача
            <textarea name="message" placeholder="Опишите потребность клиента" rows={3} />
          </label>
          <label>
            Источник обращения
            <select name="sourceChannel" defaultValue="manual">
              {SOURCE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          {createError ? <p className="error">{createError}</p> : null}
          <button className="btn" type="submit">
            Создать заявку
          </button>
        </form>
      ) : null}

      {clarification.length > 0 && (filter === "all" || filter === "needs_clarification") ? (
        <div className="panel soft">
          <h3>Требует уточнения</h3>
          {clarification.map((item) => (
            <div className="row request-clarify" key={`${item.kind}-${item.id}`}>
              <div>
                <b>{item.title}</b>
                <div className="muted">{item.detail}</div>
                <div className="muted">{item.receivedLabel}</div>
              </div>
              <div className="actions">
                {item.kind === "intake" && item.canCompletePhone ? (
                  <CompleteIntakeInline id={item.id} onDone={() => void load()} />
                ) : (
                  <Link className="btn secondary" to={`/requests/${item.inquiryId || item.id}`}>
                    Уточнить
                  </Link>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="request-list">
        {!data?.items?.length ? <p className="empty" style={{ border: 0, margin: 0 }}>Заявок по этому фильтру нет</p> : null}
        {data?.items?.length ? (
          <div className="request-list-head" aria-hidden>
            <span>Клиент</span>
            <span>Тема / услуга</span>
            <span>Источник</span>
            <span>Статус</span>
            <span>Следующий шаг</span>
            <span />
          </div>
        ) : null}
        {data?.items?.map((item) => (
          <Link key={item.id} className="request-row" to={`/requests/${item.id}`}>
            <div className="request-row-main">
              <div className="request-cell">
                <b>{item.contactName}</b>
                <div className="muted">{item.phone || "Нет телефона"}</div>
                <div className="muted">{item.receivedLabel}</div>
              </div>
              <div className="request-cell">
                <div className="request-subject">{item.subject}</div>
                <div className="muted">{item.serviceLabel || "—"}</div>
              </div>
              <div className="request-cell">
                <div>{item.sourceLine}</div>
                <div className="client-meta" style={{ marginTop: 4 }}>
                  {item.aiProcess?.status && item.aiProcess.status !== "none" ? (
                    <span className="badge">{item.aiProcess.statusLabel}</span>
                  ) : null}
                  {item.needsReply ? (
                    <span className="badge warn">
                      Нужен ответ{item.waitingMinutes != null ? ` · ${item.waitingMinutes} мин` : ""}
                    </span>
                  ) : null}
                  {item.hasDeal ? <span className="badge">Сделка</span> : null}
                  {!item.hasPhone ? <span className="badge danger">Нет телефона</span> : null}
                </div>
              </div>
              <div className="request-cell">
                <span className="badge">{item.statusLabel}</span>
                <div className="muted" style={{ marginTop: 4 }}>
                  {item.assigneeName || "не назначен"}
                </div>
              </div>
              <div className="request-cell">
                <div>{item.nextStep || "не задан"}</div>
              </div>
            </div>
            <span className="request-row-open">Открыть</span>
          </Link>
        ))}
      </div>
    </section>
  );
}

function CompleteIntakeInline({ id, onDone }: { id: string; onDone: () => void }) {
  return (
    <form
      className="inline-form"
      onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        await api.completeIntake(id, { phone: form.get("phone"), name: form.get("name") });
        onDone();
      }}
    >
      <input name="name" placeholder="Имя" />
      <input name="phone" required placeholder="+7..." />
      <button className="btn" type="submit">
        Сохранить
      </button>
    </form>
  );
}
