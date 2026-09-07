import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { nameWithPhone, phoneText } from "../lib/contactDisplay";
import { api } from "../lib/api";

export function CompanyPage() {
  const { id = "" } = useParams();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [hits, setHits] = useState<any[]>([]);
  const [position, setPosition] = useState("");
  const [isPrimary, setIsPrimary] = useState(false);
  const [isDecisionMaker, setIsDecisionMaker] = useState(false);
  const [isBillingContact, setIsBillingContact] = useState(false);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setData(await api.companyOverview(id));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    }
  }

  useEffect(() => {
    void load();
  }, [id]);

  useEffect(() => {
    if (!linkOpen) return;
    const t = setTimeout(() => {
      api
        .searchContacts(searchQ.trim())
        .then((res: any) => setHits(res.clients || []))
        .catch(() => setHits([]));
    }, searchQ.trim() ? 220 : 0);
    return () => clearTimeout(t);
  }, [searchQ, linkOpen]);

  async function linkContact(contactId: string) {
    setBusy(true);
    try {
      await api.linkCompanyContact(id, {
        contactId,
        position: position || null,
        isPrimary,
        isDecisionMaker,
        isBillingContact,
      });
      setLinkOpen(false);
      setSearchQ("");
      setPosition("");
      setIsPrimary(false);
      setIsDecisionMaker(false);
      setIsBillingContact(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось связать");
    } finally {
      setBusy(false);
    }
  }

  if (!data && !error) return <div className="state">Загрузка…</div>;
  if (!data) {
    return (
      <section>
        <p className="error">{error}</p>
        <Link to="/companies">К списку</Link>
      </section>
    );
  }

  const c = data.company;
  const cur = data.current || {};
  const life = data.lifetime || {};

  return (
    <section className="company-page">
      <div className="row sit-head">
        <div>
          <Link className="muted" to="/companies">
            ← Компании
          </Link>
          <h2>{c.name}</h2>
          <p className="muted">
            {[c.lifecycleLabel, c.industry, c.city].filter(Boolean).join(" · ")}
          </p>
          <p className="muted">
            {[c.website, c.bin ? `БИН: ${c.bin}` : null].filter(Boolean).join(" · ")}
          </p>
          <p className="muted">Ответственный: {c.assigneeName || "—"}</p>
        </div>
        <div className="sit-toolbar-side">
          <button type="button" className="btn" onClick={() => setLinkOpen(true)}>
            Добавить контакт
          </button>
          <Link className="btn secondary" to={`/inquiries?company=${c.id}`}>
            Создать заявку
          </Link>
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}

      <div className="sit-section">
        <div className="sit-section-head">
          <h3>Сейчас</h3>
        </div>
        <div className="sit-kpi-grid stats-kpi-grid">
          <div className="sit-kpi">
            <span className="muted">Активные заявки</span>
            <strong>{cur.activeRequests}</strong>
          </div>
          <div className="sit-kpi">
            <span className="muted">Активные сделки</span>
            <strong>{cur.activeDeals}</strong>
          </div>
          <div className="sit-kpi">
            <span className="muted">Pipeline</span>
            <strong>{cur.pipelineLabel || "—"}</strong>
          </div>
          <div className="sit-kpi">
            <span className="muted">На договоре</span>
            <strong>{cur.contractDeals}</strong>
          </div>
          <div className="sit-kpi">
            <span className="muted">Нужен ответ</span>
            <strong>{cur.needsReply}</strong>
          </div>
          <div className="sit-kpi">
            <span className="muted">Просрочено</span>
            <strong>{cur.overdueTasks}</strong>
          </div>
        </div>
        {cur.nextAction ? (
          <p style={{ marginTop: 10 }}>
            <b>Следующее действие:</b>{" "}
            <Link to={cur.nextAction.href}>{cur.nextAction.title}</Link>
            {cur.nextAction.dueLabel ? <span className="muted"> · {cur.nextAction.dueLabel}</span> : null}
          </p>
        ) : (
          <p className="muted" style={{ marginTop: 10 }}>
            Нет следующего действия
          </p>
        )}
      </div>

      <div className="sit-section">
        <div className="sit-section-head">
          <h3>Контактные лица</h3>
        </div>
        {!data.contacts?.length ? <p className="empty">Пока нет связанных контактов</p> : null}
        <div className="companies-list">
          {(data.contacts || []).map((person: any) => (
            <div key={person.linkId} className="company-row">
              <div>
                <b>{nameWithPhone(person.name, person.phone)}</b>
                <div className="muted">
                  {[person.position, person.department].filter(Boolean).join(" · ")}
                </div>
                <div className="muted">
                  {[
                    person.isPrimary ? "Основной контакт" : null,
                    person.isDecisionMaker ? "ЛПР" : null,
                    person.isBillingContact ? "Финансовый контакт" : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
                <div className="muted">{[phoneText(person.phone), person.email].filter(Boolean).join(" · ")}</div>
                {person.lastContactLabel ? (
                  <div className="muted">Последний контакт: {person.lastContactLabel}</div>
                ) : null}
              </div>
              <Link className="btn secondary" to={person.href}>
                Открыть клиента
              </Link>
            </div>
          ))}
        </div>
      </div>

      <div className="sit-section">
        <div className="sit-section-head">
          <h3>Сделки</h3>
        </div>
        <div className="stats-table-wrap">
          <table className="stats-table">
            <thead>
              <tr>
                <th>Сделка</th>
                <th>Стадия</th>
                <th>Сумма</th>
                <th>Контакты</th>
              </tr>
            </thead>
            <tbody>
              {(data.deals || []).map((d: any) => (
                <tr key={d.id}>
                  <td>
                    <Link to={d.href}>{d.title}</Link>
                  </td>
                  <td>
                    {d.outcome === "open" ? d.stageName : d.outcome.toUpperCase()}
                  </td>
                  <td>{d.amountLabel || "—"}</td>
                  <td className="muted">
                    {[
                      nameWithPhone(d.primaryContactName || d.contactName, d.primaryContactPhone || d.phone),
                      d.decisionMakerName
                        ? `ЛПР: ${nameWithPhone(d.decisionMakerName, d.decisionMakerPhone)}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="sit-section">
        <div className="sit-section-head">
          <h3>Заявки</h3>
        </div>
        <div className="stats-table-wrap">
          <table className="stats-table">
            <thead>
              <tr>
                <th>Заявка</th>
                <th>Обратился</th>
                <th>Источник</th>
                <th>Дата</th>
              </tr>
            </thead>
            <tbody>
              {(data.inquiries || []).map((r: any) => (
                <tr key={r.id}>
                  <td>
                    <Link to={r.href}>{r.title}</Link>
                    <div className="muted">{r.status}</div>
                  </td>
                  <td>{nameWithPhone(r.contactName, r.phone)}</td>
                  <td>{r.source || "—"}</td>
                  <td>{r.receivedLabel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="sit-section">
        <div className="sit-section-head">
          <h3>Задачи</h3>
        </div>
        {(data.tasks || []).length === 0 ? <p className="empty">Нет открытых задач</p> : null}
        <ul className="company-task-list">
          {(data.tasks || []).map((t: any) => (
            <li key={t.id}>
              <Link to={t.href}>{t.title}</Link>
              <span className="muted">{t.dueLabel ? ` · ${t.dueLabel}` : ""}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="sit-section">
        <div className="sit-section-head">
          <h3>Итог отношений</h3>
        </div>
        <div className="sit-kpi-grid stats-kpi-grid">
          <div className="sit-kpi">
            <span className="muted">С нами с</span>
            <strong style={{ fontSize: "1rem" }}>{life.withUsSinceLabel}</strong>
          </div>
          <div className="sit-kpi">
            <span className="muted">Заявок</span>
            <strong>{life.requests}</strong>
          </div>
          <div className="sit-kpi">
            <span className="muted">Сделок</span>
            <strong>{life.deals}</strong>
          </div>
          <div className="sit-kpi">
            <span className="muted">WON</span>
            <strong>{life.wonDeals}</strong>
          </div>
          <div className="sit-kpi">
            <span className="muted">Продано</span>
            <strong>{life.revenueLabel || "—"}</strong>
          </div>
          <div className="sit-kpi">
            <span className="muted">Средний чек</span>
            <strong>{life.averageDealLabel || "—"}</strong>
          </div>
        </div>
      </div>

      <div className="sit-section">
        <div className="sit-section-head">
          <h3>Timeline</h3>
        </div>
        <div className="company-timeline">
          {(data.timeline || []).map((a: any) => (
            <div key={a.id} className="company-timeline-item">
              <div className="muted">{a.createdLabel}</div>
              <b>{a.title}</b>
              <div className="muted">
                {a.contactName || a.phone ? nameWithPhone(a.contactName, a.phone) : ""}
                {a.description ? ` · ${a.description}` : ""}
              </div>
            </div>
          ))}
          {!data.timeline?.length ? <p className="empty">Пока нет событий</p> : null}
        </div>
      </div>

      {linkOpen ? (
        <div className="stats-modal-backdrop" onClick={() => setLinkOpen(false)}>
          <div className="stats-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Добавить контакт</h3>
            <label>
              Найти клиента
              <input value={searchQ} onChange={(e) => setSearchQ(e.target.value)} placeholder="Имя или телефон" />
            </label>
            <label>
              Должность
              <input value={position} onChange={(e) => setPosition(e.target.value)} />
            </label>
            <label>
              <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} /> Основной
              контакт
            </label>
            <label>
              <input
                type="checkbox"
                checked={isDecisionMaker}
                onChange={(e) => setIsDecisionMaker(e.target.checked)}
              />{" "}
              ЛПР
            </label>
            <label>
              <input
                type="checkbox"
                checked={isBillingContact}
                onChange={(e) => setIsBillingContact(e.target.checked)}
              />{" "}
              Финансовый контакт
            </label>
            <div className="picker-list" style={{ marginTop: 8 }}>
              {hits.map((hit) => (
                <button
                  key={hit.id}
                  type="button"
                  className="picker-item"
                  disabled={busy}
                  onClick={() => void linkContact(hit.id)}
                >
                  <b>{hit.name}</b>
                  <div className="muted">{[hit.phone, hit.companyName].filter(Boolean).join(" · ")}</div>
                </button>
              ))}
            </div>
            <button type="button" className="btn secondary" style={{ marginTop: 8 }} onClick={() => setLinkOpen(false)}>
              Закрыть
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
