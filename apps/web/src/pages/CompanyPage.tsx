import { notifySaved } from "../components/SaveNotice";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { nameWithPhone, phoneText } from "../lib/contactDisplay";
import { api } from "../lib/api";

const LIFECYCLE_OPTIONS = [
  ["PROSPECT", "Потенциальный клиент"],
  ["CUSTOMER", "Клиент"],
  ["INACTIVE_CUSTOMER", "Неактивный клиент"],
  ["PARTNER", "Партнёр"],
  ["ARCHIVED", "Архив"],
] as const;

type CompanyDraft = {
  name: string;
  legalName: string;
  bin: string;
  iin: string;
  legalAddress: string;
  vatPayer: boolean;
  directorName: string;
  directorPosition: string;
  iban: string;
  bankName: string;
  bik: string;
  industry: string;
  city: string;
  website: string;
  phone: string;
  email: string;
  description: string;
  lifecycleStatus: string;
  assigneeMembershipId: string;
};

type PersonDraft = {
  linkId: string;
  name: string;
  position: string;
  department: string;
  isPrimary: boolean;
  isDecisionMaker: boolean;
  isBillingContact: boolean;
};

function draftFromCompany(c: any): CompanyDraft {
  return {
    name: c.name || "",
    legalName: c.legalName || "",
    bin: c.bin || "",
    iin: c.iin || "",
    legalAddress: c.legalAddress || "",
    vatPayer: Boolean(c.vatPayer),
    directorName: c.directorName || "",
    directorPosition: c.directorPosition || "",
    iban: c.iban || "",
    bankName: c.bankName || "",
    bik: c.bik || "",
    industry: c.industry || "",
    city: c.city || "",
    website: c.website || "",
    phone: c.phone || "",
    email: c.email || "",
    description: c.description || "",
    lifecycleStatus: c.lifecycleStatus || "PROSPECT",
    assigneeMembershipId: c.assigneeMembershipId || "",
  };
}

export function CompanyPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
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
  const [editOpen, setEditOpen] = useState(false);
  const [editDraft, setEditDraft] = useState<CompanyDraft | null>(null);
  const [members, setMembers] = useState<Array<{ id: string; name: string }>>([]);
  const [personEdit, setPersonEdit] = useState<PersonDraft | null>(null);
  const [documents, setDocuments] = useState<any[]>([]);

  async function load() {
    try {
      setData(await api.companyOverview(id));
      const docs: any = await api.documents({ companyId: id, limit: "20" }).catch(() => ({ items: [] }));
      setDocuments(docs.items || []);
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

  function openEdit() {
    if (!data?.company) return;
    setEditDraft(draftFromCompany(data.company));
    setEditOpen(true);
    void api
      .workspaceMembers()
      .then((res: any) => setMembers(res.items || []))
      .catch(() => setMembers([]));
  }

  async function saveCompany() {
    if (!editDraft?.name.trim()) {
      setError("Укажите название компании");
      return;
    }
    setBusy(true);
    try {
      await api.updateCompany(id, {
        name: editDraft.name.trim(),
        legalName: editDraft.legalName.trim() || null,
        bin: editDraft.bin.trim() || null,
        iin: editDraft.iin.trim() || null,
        legalAddress: editDraft.legalAddress.trim() || null,
        vatPayer: editDraft.vatPayer,
        directorName: editDraft.directorName.trim() || null,
        directorPosition: editDraft.directorPosition.trim() || null,
        iban: editDraft.iban.trim() || null,
        bankName: editDraft.bankName.trim() || null,
        bik: editDraft.bik.trim() || null,
        industry: editDraft.industry.trim() || null,
        city: editDraft.city.trim() || null,
        website: editDraft.website.trim() || null,
        phone: editDraft.phone.trim() || null,
        email: editDraft.email.trim() || null,
        description: editDraft.description.trim() || null,
        lifecycleStatus: editDraft.lifecycleStatus,
        assigneeMembershipId: editDraft.assigneeMembershipId || null,
      });
      setEditOpen(false);
      notifySaved("Данные компании сохранены");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  async function removeCompany() {
    if (!window.confirm("Удалить компанию из списка? Клиенты, заявки и сделки останутся.")) return;
    setBusy(true);
    try {
      await api.deleteCompany(id);
      navigate("/companies");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось удалить");
      setBusy(false);
    }
  }

  async function savePerson() {
    if (!personEdit) return;
    setBusy(true);
    try {
      await api.updateCompanyContact(id, personEdit.linkId, {
        position: personEdit.position.trim() || null,
        department: personEdit.department.trim() || null,
        isPrimary: personEdit.isPrimary,
        isDecisionMaker: personEdit.isDecisionMaker,
        isBillingContact: personEdit.isBillingContact,
      });
      setPersonEdit(null);
      notifySaved("Данные сотрудника сохранены");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить состав");
    } finally {
      setBusy(false);
    }
  }

  async function removePerson(person: any) {
    if (!window.confirm(`Убрать «${person.name}» из состава компании? Карточка клиента останется.`)) return;
    setBusy(true);
    try {
      await api.unlinkCompanyContact(id, person.linkId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось убрать контакт");
    } finally {
      setBusy(false);
    }
  }

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
            {[c.website, c.bin ? `БИН: ${c.bin}` : null, c.iin ? `ИИН: ${c.iin}` : null].filter(Boolean).join(" · ")}
          </p>
          <p className="muted">Ответственный: {c.assigneeName || "—"}</p>
        </div>
        <div className="sit-toolbar-side">
          <button type="button" className="btn secondary" onClick={openEdit}>
            Изменить
          </button>
          <button type="button" className="btn danger" disabled={busy} onClick={() => void removeCompany()}>
            Удалить
          </button>
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
              <div className="company-row-actions">
                <Link className="btn secondary" to={person.href}>
                  Открыть
                </Link>
                <button
                  type="button"
                  className="btn secondary"
                  onClick={() =>
                    setPersonEdit({
                      linkId: person.linkId,
                      name: person.name,
                      position: person.position || "",
                      department: person.department || "",
                      isPrimary: Boolean(person.isPrimary),
                      isDecisionMaker: Boolean(person.isDecisionMaker),
                      isBillingContact: Boolean(person.isBillingContact),
                    })
                  }
                >
                  Изменить
                </button>
                <button type="button" className="btn danger" disabled={busy} onClick={() => void removePerson(person)}>
                  Убрать
                </button>
              </div>
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
          <h3>Документы</h3>
          <Link className="btn secondary" to="/documents">Все документы</Link>
        </div>
        {!documents.length ? <p className="empty">Документов по этой компании пока нет.</p> : null}
        {documents.map((item) => (
          <Link key={`${item.kind}-${item.id}`} className="sit-list-row" to={item.href}>
            <div>
              <b>{item.kindLabel} {item.number}</b>
              <div className="muted">{item.dealTitle}</div>
            </div>
            <span className={item.attention ? "deal-flag" : "muted"}>{item.statusLabel}</span>
          </Link>
        ))}
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

      {editOpen && editDraft ? (
        <div className="stats-modal-backdrop" onClick={() => setEditOpen(false)}>
          <div className="stats-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Изменить компанию</h3>
            <div className="stats-filters" style={{ gridTemplateColumns: "1fr" }}>
              <label>
                Название *
                <input value={editDraft.name} onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })} />
              </label>
              <label>
                Юридическое название
                <input
                  value={editDraft.legalName}
                  onChange={(e) => setEditDraft({ ...editDraft, legalName: e.target.value })}
                />
              </label>
              <label>
                Статус
                <select
                  value={editDraft.lifecycleStatus}
                  onChange={(e) => setEditDraft({ ...editDraft, lifecycleStatus: e.target.value })}
                >
                  {LIFECYCLE_OPTIONS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Ответственный
                <select
                  value={editDraft.assigneeMembershipId}
                  onChange={(e) => setEditDraft({ ...editDraft, assigneeMembershipId: e.target.value })}
                >
                  <option value="">Без ответственного</option>
                  {editDraft.assigneeMembershipId && !members.some((m) => m.id === editDraft.assigneeMembershipId) ? (
                    <option value={editDraft.assigneeMembershipId}>
                      {data.company.assigneeName || "Текущий ответственный"}
                    </option>
                  ) : null}
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                БИН
                <input value={editDraft.bin} onChange={(e) => setEditDraft({ ...editDraft, bin: e.target.value })} />
              </label>
              <label>
                ИИН
                <input value={editDraft.iin} onChange={(e) => setEditDraft({ ...editDraft, iin: e.target.value })} />
              </label>
              <label>
                Юридический адрес
                <input
                  value={editDraft.legalAddress}
                  onChange={(e) => setEditDraft({ ...editDraft, legalAddress: e.target.value })}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={editDraft.vatPayer}
                  onChange={(e) => setEditDraft({ ...editDraft, vatPayer: e.target.checked })}
                />{" "}
                Плательщик НДС
              </label>
              <label>
                Директор
                <input
                  value={editDraft.directorName}
                  onChange={(e) => setEditDraft({ ...editDraft, directorName: e.target.value })}
                />
              </label>
              <label>
                Должность директора
                <input
                  value={editDraft.directorPosition}
                  onChange={(e) => setEditDraft({ ...editDraft, directorPosition: e.target.value })}
                />
              </label>
              <label>
                Банк
                <input
                  value={editDraft.bankName}
                  onChange={(e) => setEditDraft({ ...editDraft, bankName: e.target.value })}
                />
              </label>
              <label>
                ИИК / IBAN
                <input value={editDraft.iban} onChange={(e) => setEditDraft({ ...editDraft, iban: e.target.value })} />
              </label>
              <label>
                БИК
                <input value={editDraft.bik} onChange={(e) => setEditDraft({ ...editDraft, bik: e.target.value })} />
              </label>
              <label>
                Отрасль
                <input
                  value={editDraft.industry}
                  onChange={(e) => setEditDraft({ ...editDraft, industry: e.target.value })}
                />
              </label>
              <label>
                Город
                <input value={editDraft.city} onChange={(e) => setEditDraft({ ...editDraft, city: e.target.value })} />
              </label>
              <label>
                Сайт
                <input
                  value={editDraft.website}
                  onChange={(e) => setEditDraft({ ...editDraft, website: e.target.value })}
                />
              </label>
              <label>
                Телефон
                <input value={editDraft.phone} onChange={(e) => setEditDraft({ ...editDraft, phone: e.target.value })} />
              </label>
              <label>
                Email
                <input value={editDraft.email} onChange={(e) => setEditDraft({ ...editDraft, email: e.target.value })} />
              </label>
              <label>
                Комментарий
                <textarea
                  value={editDraft.description}
                  onChange={(e) => setEditDraft({ ...editDraft, description: e.target.value })}
                  rows={3}
                />
              </label>
            </div>
            <div className="row" style={{ gap: 8, marginTop: 12 }}>
              <button type="button" className="btn" disabled={busy || !editDraft.name.trim()} onClick={() => void saveCompany()}>
                Сохранить
              </button>
              <button type="button" className="btn secondary" onClick={() => setEditOpen(false)}>
                Отмена
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {personEdit ? (
        <div className="stats-modal-backdrop" onClick={() => setPersonEdit(null)}>
          <div className="stats-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Состав компании</h3>
            <p className="muted">{personEdit.name}</p>
            <label>
              Должность
              <input
                value={personEdit.position}
                onChange={(e) => setPersonEdit({ ...personEdit, position: e.target.value })}
              />
            </label>
            <label>
              Отдел
              <input
                value={personEdit.department}
                onChange={(e) => setPersonEdit({ ...personEdit, department: e.target.value })}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={personEdit.isPrimary}
                onChange={(e) => setPersonEdit({ ...personEdit, isPrimary: e.target.checked })}
              />{" "}
              Основной контакт
            </label>
            <label>
              <input
                type="checkbox"
                checked={personEdit.isDecisionMaker}
                onChange={(e) => setPersonEdit({ ...personEdit, isDecisionMaker: e.target.checked })}
              />{" "}
              ЛПР
            </label>
            <label>
              <input
                type="checkbox"
                checked={personEdit.isBillingContact}
                onChange={(e) => setPersonEdit({ ...personEdit, isBillingContact: e.target.checked })}
              />{" "}
              Финансовый контакт
            </label>
            <div className="row" style={{ gap: 8, marginTop: 12 }}>
              <button type="button" className="btn" disabled={busy} onClick={() => void savePerson()}>
                Сохранить
              </button>
              <button type="button" className="btn secondary" onClick={() => setPersonEdit(null)}>
                Отмена
              </button>
            </div>
          </div>
        </div>
      ) : null}

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
