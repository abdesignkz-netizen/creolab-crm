import { uiTaskTitle, uiText, useUiText, localizeUiOptions, uiMessage } from "../lib/uiText";
import { notifySaved } from "../components/SaveNotice";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { nameWithPhone, phoneText } from "../lib/contactDisplay";
import { api } from "../lib/api";
import { useCapabilities } from "../lib/session";
import { dealOutcomeLabel } from "../lib/labels";
import { ContractPreviewModal } from "../components/ContractPreviewModal";
import {
  ContractGenerateItems,
  newContractDraftLine,
  parseContractDraftLines,
  type ContractDraftLine,
} from "../components/ContractGenerateItems";

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
  const uiText = useUiText();
  const caps = useCapabilities();
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
  const [templates, setTemplates] = useState<Array<{ id: string; name: string; isDefault: boolean }>>([]);
  const [templateId, setTemplateId] = useState("");
  const [templateBusy, setTemplateBusy] = useState(false);
  const [contractLines, setContractLines] = useState<ContractDraftLine[]>([newContractDraftLine()]);
  const [contractNumber, setContractNumber] = useState("");
  const [contractDate, setContractDate] = useState(new Date().toISOString().slice(0, 10));
  const [completionTerms, setCompletionTerms] = useState("");
  const [formed, setFormed] = useState<{ previewId: string; number: string } | null>(null);
  const [viewOpen, setViewOpen] = useState(false);

  async function load() {
    try {
      setData(await api.companyOverview(id));
      if (caps.documents) {
        const docs: any = await api.documents({ companyId: id, limit: "20" }).catch(() => ({ items: [] }));
        setDocuments(docs.items || []);
      } else {
        setDocuments([]);
      }
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Ошибка"));
    }
  }

  useEffect(() => {
    void load();
    setFormed(null);
    setViewOpen(false);
    setContractNumber("");
    setContractDate(new Date().toISOString().slice(0, 10));
  }, [id, caps.documents]);

  useEffect(() => {
    if (!caps.documents) return;
    void api.contractTemplates().then((result: any) => {
      const list = result.items || [];
      setTemplates(list);
      const nextId = list.find((row: any) => row.isDefault)?.id || list[0]?.id || "";
      setTemplateId(nextId);
      setContractLines((current) => {
        if (current.length !== 1 || current[0].name.trim()) return current;
        const chosen = list.find((row: any) => row.id === nextId);
        return [{ ...current[0], name: chosen?.name || "" }];
      });
    }).catch(() => setTemplates([]));
  }, [caps.documents, id]);

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
      setError(uiText("Укажите название компании"));
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
      notifySaved(uiText("Данные компании сохранены"));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Не удалось сохранить"));
    } finally {
      setBusy(false);
    }
  }

  async function removeCompany() {
    if (!window.confirm(uiText("Удалить компанию из списка? Клиенты, заявки и сделки останутся."))) return;
    setBusy(true);
    try {
      await api.deleteCompany(id);
      navigate("/companies");
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Не удалось удалить"));
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
      notifySaved(uiText("Данные сотрудника сохранены"));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Не удалось сохранить состав"));
    } finally {
      setBusy(false);
    }
  }

  async function removePerson(person: any) {
    if (!window.confirm(uiText("Убрать «{p0}» из состава компании? Карточка клиента останется.", {p0: person.name}))) return;
    setBusy(true);
    try {
      await api.unlinkCompanyContact(id, person.linkId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Не удалось убрать контакт"));
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
      setError(err instanceof Error ? err.message : uiText("Не удалось связать"));
    } finally {
      setBusy(false);
    }
  }

  if (!data && !error) return <div className="state">{uiText("Загрузка…")}</div>;
  if (!data) {
    return (
      <section>
        <p className="error">{error}</p>
        <Link to="/companies">{uiText("К списку")}</Link>
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
            {uiText("← Компании")}</Link>
          <h2>{c.name}</h2>
          <p className="muted">
            {[uiMessage(c.lifecycleLabel), c.industry, c.city].filter(Boolean).join(" · ")}
          </p>
          <p className="muted">
            {[c.website, c.bin ? uiText("БИН: {p0}", {p0: c.bin}) : null, c.iin ? uiText("ИИН: {p0}", {p0: c.iin}) : null].filter(Boolean).join(" · ")}
          </p>
          <p className="muted">{uiText("Ответственный:")}{" "}{c.assigneeName || "—"}</p>
        </div>
        <div className="sit-toolbar-side">
          {!caps.manager ? (
            <>
          <button type="button" className="btn secondary" onClick={openEdit}>
            {uiText("Изменить")}</button>
          <button type="button" className="btn danger" disabled={busy} onClick={() => void removeCompany()}>
            {uiText("Удалить")}</button>
            </>
          ) : null}
          <button type="button" className="btn" onClick={() => setLinkOpen(true)}>
            {uiText("Добавить контакт")}</button>
          <Link className="btn secondary" to={`/inquiries?company=${c.id}`}>
            {uiText("Создать заявку")}</Link>
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}

      <div className="sit-section">
        <div className="sit-section-head">
          <h3>{uiText("Сейчас")}</h3>
        </div>
        <div className="sit-kpi-grid stats-kpi-grid">
          <div className="sit-kpi">
            <span className="muted">{uiText("Активные заявки")}</span>
            <strong>{cur.activeRequests}</strong>
          </div>
          <div className="sit-kpi">
            <span className="muted">{uiText("Активные сделки")}</span>
            <strong>{cur.activeDeals}</strong>
          </div>
          {!caps.manager ? (
          <div className="sit-kpi">
            <span className="muted">{uiText("Сумма сделок")}</span>
            <strong>{cur.pipelineLabel || "—"}</strong>
          </div>
          ) : null}
          <div className="sit-kpi">
            <span className="muted">{uiText("На договоре")}</span>
            <strong>{cur.contractDeals}</strong>
          </div>
          <div className="sit-kpi">
            <span className="muted">{uiText("Нужен ответ")}</span>
            <strong>{cur.needsReply}</strong>
          </div>
          <div className="sit-kpi">
            <span className="muted">{uiText("Просрочено")}</span>
            <strong>{cur.overdueTasks}</strong>
          </div>
        </div>
        {cur.nextAction ? (
          <p style={{ marginTop: 10 }}>
            <b>{uiText("Следующее действие:")}</b>{" "}
            <Link to={cur.nextAction.href}>{uiTaskTitle(cur.nextAction)}</Link>
            {cur.nextAction.dueLabel ? <span className="muted"> · {cur.nextAction.dueLabel}</span> : null}
          </p>
        ) : (
          <p className="muted" style={{ marginTop: 10 }}>
            {uiText("Нет следующего действия")}</p>
        )}
      </div>

      <div className="sit-section">
        <div className="sit-section-head">
          <h3>{uiText("Контактные лица")}</h3>
        </div>
        {!data.contacts?.length ? <p className="empty">{uiText("Пока нет связанных контактов")}</p> : null}
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
                    person.isPrimary ? uiText("Основной контакт") : null,
                    person.isDecisionMaker ? uiText("ЛПР") : null,
                    person.isBillingContact ? uiText("Финансовый контакт") : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
                <div className="muted">{[phoneText(person.phone), person.email].filter(Boolean).join(" · ")}</div>
                {person.lastContactLabel ? (
                  <div className="muted">{uiText("Последний контакт:")}{" "}{person.lastContactLabel}</div>
                ) : null}
              </div>
              <div className="company-row-actions">
                <Link className="btn secondary" to={person.href}>
                  {uiText("Открыть")}</Link>
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
                  {uiText("Изменить")}</button>
                <button type="button" className="btn danger" disabled={busy} onClick={() => void removePerson(person)}>
                  {uiText("Убрать")}</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="sit-section">
        <div className="sit-section-head">
          <h3>{uiText("Сделки")}</h3>
        </div>
        <div className="stats-table-wrap">
          <table className="stats-table">
            <thead>
              <tr>
                <th>{uiText("Сделка")}</th>
                <th>{uiText("Стадия")}</th>
                <th>{uiText("Сумма")}</th>
                <th>{uiText("Контакты")}</th>
              </tr>
            </thead>
            <tbody>
              {(data.deals || []).map((d: any) => (
                <tr key={d.id}>
                  <td>
                    <Link to={d.href}>{d.title}</Link>
                  </td>
                  <td>
                    {dealOutcomeLabel(d.outcome, d.stageName)}
                  </td>
                  <td>{d.amountLabel || "—"}</td>
                  <td className="muted">
                    {[
                      nameWithPhone(d.primaryContactName || d.contactName, d.primaryContactPhone || d.phone),
                      d.decisionMakerName
                        ? uiText("ЛПР: {p0}", {p0: nameWithPhone(d.decisionMakerName, d.decisionMakerPhone)})
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

      {caps.documents ? (
      <div className="sit-section">
        <div className="sit-section-head">
          <h3>{uiText("Документы")}</h3>
          <Link className="btn secondary" to="/documents">{uiText("Все документы")}</Link>
        </div>
        {templates.length ? (
          <div className="stack" style={{ marginBottom: 12 }}>
            <p className="muted">{uiText("Сформировать договор по сохранённому шаблону — реквизиты этой компании подставятся в текст.")}</p>
            <label>
              {uiText("Шаблон")}<select
                value={templateId}
                disabled={templateBusy}
                onChange={(e) => {
                  const nextId = e.target.value;
                  const previous = templates.find((row) => row.id === templateId)?.name || "";
                  setTemplateId(nextId);
                  setFormed(null);
                  const nextName = templates.find((row) => row.id === nextId)?.name || "";
                  setContractLines((current) => {
                    if (current.length === 1 && (!current[0].name.trim() || current[0].name === previous)) {
                      return [{ ...current[0], name: nextName }];
                    }
                    return current;
                  });
                }}
              >
                {templates.map((row) => (
                  <option key={row.id} value={row.id}>{row.name}{row.isDefault ? uiText(" (по умолчанию)") : ""}</option>
                ))}
              </select>
            </label>
            <label>{uiText("Номер договора")}<input maxLength={40} value={contractNumber} disabled={templateBusy} placeholder={uiText("Автоматически по настройкам нумерации")} onChange={event => { setContractNumber(event.target.value); setFormed(null); }} /></label>
              <label>{uiText("Дата договора")}<input type="date" value={contractDate} disabled={templateBusy} onChange={event => { setContractDate(event.target.value); setFormed(null); }} /></label>
              <ContractGenerateItems lines={contractLines} onChange={(next) => { setContractLines(next); setFormed(null); }}
              completionTerms={completionTerms} onCompletionTermsChange={(value) => { setCompletionTerms(value); setFormed(null); }} disabled={templateBusy} />
            <div className="actions">
              {formed ? (
                <>
                  <button type="button" className="btn" disabled={templateBusy} onClick={() => setViewOpen(true)}>
                    {uiText("Посмотреть договор")}</button>
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={templateBusy}
                    onClick={() => {
                      setTemplateBusy(true);
                      setError("");
                      void api
                        .createCompanyContractFromTemplate(id, { save: true, previewId: formed.previewId })
                        .then(async () => {
                          notifySaved(uiText("Договор сохранён"));
                          setFormed(null);
                          setViewOpen(false);
                          await load();
                        })
                        .catch((err) => setError(err instanceof Error ? err.message : uiText("Не удалось сохранить договор")))
                        .finally(() => setTemplateBusy(false));
                    }}
                  >
                    {templateBusy ? uiText("Сохраняем…") : uiText("Сохранить договор")}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn"
                  disabled={templateBusy || !templateId}
                  onClick={() => {
                    let items;
                    try {
                      items = parseContractDraftLines(contractLines);
                    } catch (err) {
                      setError(err instanceof Error ? err.message : uiText("Проверьте услуги"));
                      return;
                    }
                    setTemplateBusy(true);
                    setError("");
                    void api.createCompanyContractFromTemplate(id, { templateId, items, completionTerms, number: contractNumber, documentDate: contractDate })
                      .then((result: any) => {
                        if (!result.previewId) throw new Error(uiText("Не удалось сформировать договор"));
                        setFormed({ previewId: result.previewId, number: result.number });
                        setViewOpen(true);
                        notifySaved(uiText("Договор сформирован по шаблону"));
                      })
                      .catch((err) => setError(err instanceof Error ? err.message : uiText("Не удалось сформировать договор")))
                      .finally(() => setTemplateBusy(false));
                  }}
                >
                  {templateBusy ? uiText("Формируем…") : uiText("Сформировать по шаблону")}
                </button>
              )}
            </div>
          </div>
        ) : null}
        {!documents.length ? <p className="empty">{uiText("Документов по этой компании пока нет.")}</p> : null}
        {documents.map((item) => (
          <Link key={`${item.kind}-${item.id}`} className="sit-list-row" to={item.href}>
            <div>
              <b>{uiMessage(item.kindLabel)} {item.number}</b>
              <div className="muted">{item.dealTitle}</div>
            </div>
            <span className={item.attention ? "deal-flag" : "muted"}>{uiMessage(item.statusLabel)}</span>
          </Link>
        ))}
      </div>
      ) : null}

      {viewOpen && formed ? (
        <ContractPreviewModal
          contract={{ id: formed.previewId, number: formed.number, preview: true }}
          onClose={() => setViewOpen(false)}
        />
      ) : null}

      <div className="sit-section">
        <div className="sit-section-head">
          <h3>{uiText("Заявки")}</h3>
        </div>
        <div className="stats-table-wrap">
          <table className="stats-table">
            <thead>
              <tr>
                <th>{uiText("Заявка")}</th>
                <th>{uiText("Обратился")}</th>
                <th>{uiText("Источник")}</th>
                <th>{uiText("Дата")}</th>
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
          <h3>{uiText("Задачи")}</h3>
        </div>
        {(data.tasks || []).length === 0 ? <p className="empty">{uiText("Нет открытых задач")}</p> : null}
        <ul className="company-task-list">
          {(data.tasks || []).map((t: any) => (
            <li key={t.id}>
              <Link to={t.href}>{uiTaskTitle(t)}</Link>
              <span className="muted">{t.dueLabel ? ` · ${t.dueLabel}` : ""}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="sit-section">
        <div className="sit-section-head">
          <h3>{uiText("Итог отношений")}</h3>
        </div>
        <div className="sit-kpi-grid stats-kpi-grid">
          <div className="sit-kpi">
            <span className="muted">{uiText("С нами с")}</span>
            <strong style={{ fontSize: "1rem" }}>{life.withUsSinceLabel}</strong>
          </div>
          <div className="sit-kpi">
            <span className="muted">{uiText("Заявок")}</span>
            <strong>{life.requests}</strong>
          </div>
          <div className="sit-kpi">
            <span className="muted">{uiText("Сделок")}</span>
            <strong>{life.deals}</strong>
          </div>
          <div className="sit-kpi">
            <span className="muted">{uiText("Продажи")}</span>
            <strong>{life.wonDeals}</strong>
          </div>
          {!caps.manager ? (
          <>
          <div className="sit-kpi">
            <span className="muted">{uiText("Продано")}</span>
            <strong>{life.revenueLabel || "—"}</strong>
          </div>
          <div className="sit-kpi">
            <span className="muted">{uiText("Средний чек")}</span>
            <strong>{life.averageDealLabel || "—"}</strong>
          </div>
          </>
          ) : null}
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
          {!data.timeline?.length ? <p className="empty">{uiText("Пока нет событий")}</p> : null}
        </div>
      </div>

      {editOpen && editDraft && !caps.manager ? (
        <div className="stats-modal-backdrop" onClick={() => setEditOpen(false)}>
          <div className="stats-modal company-edit-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{uiText("Изменить компанию")}</h3>
            <div className="company-create-grid">
              <label className="span-2">
                {uiText("Название *")}<input value={editDraft.name} onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })} />
              </label>
              <label className="span-2">
                {uiText("Юридическое название")}<input
                  value={editDraft.legalName}
                  onChange={(e) => setEditDraft({ ...editDraft, legalName: e.target.value })}
                />
              </label>
              <label>
                {uiText("Статус")}<select
                  value={editDraft.lifecycleStatus}
                  onChange={(e) => setEditDraft({ ...editDraft, lifecycleStatus: e.target.value })}
                >
                  {localizeUiOptions(LIFECYCLE_OPTIONS, uiText).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {uiText("Ответственный")}<select
                  value={editDraft.assigneeMembershipId}
                  onChange={(e) => setEditDraft({ ...editDraft, assigneeMembershipId: e.target.value })}
                >
                  <option value="">{uiText("Без ответственного")}</option>
                  {editDraft.assigneeMembershipId && !members.some((m) => m.id === editDraft.assigneeMembershipId) ? (
                    <option value={editDraft.assigneeMembershipId}>
                      {data.company.assigneeName || uiText("Текущий ответственный")}
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
                {uiText("БИН")}<input value={editDraft.bin} onChange={(e) => setEditDraft({ ...editDraft, bin: e.target.value })} />
              </label>
              <label>
                {uiText("ИИН")}<input value={editDraft.iin} onChange={(e) => setEditDraft({ ...editDraft, iin: e.target.value })} />
              </label>
              <label className="span-2">
                {uiText("Юридический адрес")}<input
                  value={editDraft.legalAddress}
                  onChange={(e) => setEditDraft({ ...editDraft, legalAddress: e.target.value })}
                />
              </label>
              <label className="span-2">
                <span className="check-line">
                  <input
                    type="checkbox"
                    checked={editDraft.vatPayer}
                    onChange={(e) => setEditDraft({ ...editDraft, vatPayer: e.target.checked })}
                  />
                  {uiText("Плательщик НДС")}</span>
              </label>
              <label>
                {uiText("Руководитель")}<input
                  value={editDraft.directorName}
                  onChange={(e) => setEditDraft({ ...editDraft, directorName: e.target.value })}
                  placeholder={uiText("Фамилия И. О.")}
                />
              </label>
              <label>
                {uiText("Должность")}<input
                  value={editDraft.directorPosition}
                  onChange={(e) => setEditDraft({ ...editDraft, directorPosition: e.target.value })}
                  placeholder={uiText("Директор")}
                />
              </label>
              <p className="muted tiny span-2">
                {uiText("Для договора: «в лице директора / генерального директора». Если пусто — подставим «Директор».")}</p>
              <label>
                {uiText("Банк")}<input
                  value={editDraft.bankName}
                  onChange={(e) => setEditDraft({ ...editDraft, bankName: e.target.value })}
                />
              </label>
              <label>
                {uiText("ИИК / IBAN")}<input value={editDraft.iban} onChange={(e) => setEditDraft({ ...editDraft, iban: e.target.value })} />
              </label>
              <label>
                {uiText("БИК")}<input value={editDraft.bik} onChange={(e) => setEditDraft({ ...editDraft, bik: e.target.value })} />
              </label>
              <label>
                {uiText("Отрасль")}<input
                  value={editDraft.industry}
                  onChange={(e) => setEditDraft({ ...editDraft, industry: e.target.value })}
                />
              </label>
              <label>
                {uiText("Город")}<input value={editDraft.city} onChange={(e) => setEditDraft({ ...editDraft, city: e.target.value })} />
              </label>
              <label>
                {uiText("Сайт")}<input
                  value={editDraft.website}
                  onChange={(e) => setEditDraft({ ...editDraft, website: e.target.value })}
                />
              </label>
              <label>
                {uiText("Телефон")}<input value={editDraft.phone} onChange={(e) => setEditDraft({ ...editDraft, phone: e.target.value })} />
              </label>
              <label>
                Email
                <input value={editDraft.email} onChange={(e) => setEditDraft({ ...editDraft, email: e.target.value })} />
              </label>
              <label className="span-2">
                {uiText("Комментарий")}<textarea
                  value={editDraft.description}
                  onChange={(e) => setEditDraft({ ...editDraft, description: e.target.value })}
                  rows={3}
                />
              </label>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn" disabled={busy || !editDraft.name.trim()} onClick={() => void saveCompany()}>
                {uiText("Сохранить")}</button>
              <button type="button" className="btn secondary" onClick={() => setEditOpen(false)}>
                {uiText("Отмена")}</button>
            </div>
          </div>
        </div>
      ) : null}

      {personEdit ? (
        <div className="stats-modal-backdrop" onClick={() => setPersonEdit(null)}>
          <div className="stats-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{uiText("Состав компании")}</h3>
            <p className="muted">{personEdit.name}</p>
            <label>
              {uiText("Должность")}<input
                value={personEdit.position}
                onChange={(e) => setPersonEdit({ ...personEdit, position: e.target.value })}
              />
            </label>
            <label>
              {uiText("Отдел")}<input
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
              {uiText("Основной контакт")}</label>
            <label>
              <input
                type="checkbox"
                checked={personEdit.isDecisionMaker}
                onChange={(e) => setPersonEdit({ ...personEdit, isDecisionMaker: e.target.checked })}
              />{" "}
              {uiText("ЛПР")}</label>
            <label>
              <input
                type="checkbox"
                checked={personEdit.isBillingContact}
                onChange={(e) => setPersonEdit({ ...personEdit, isBillingContact: e.target.checked })}
              />{" "}
              {uiText("Финансовый контакт")}</label>
            <div className="row" style={{ gap: 8, marginTop: 12 }}>
              <button type="button" className="btn" disabled={busy} onClick={() => void savePerson()}>
                {uiText("Сохранить")}</button>
              <button type="button" className="btn secondary" onClick={() => setPersonEdit(null)}>
                {uiText("Отмена")}</button>
            </div>
          </div>
        </div>
      ) : null}

      {linkOpen ? (
        <div className="stats-modal-backdrop" onClick={() => setLinkOpen(false)}>
          <div className="stats-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{uiText("Добавить контакт")}</h3>
            <label>
              {uiText("Найти клиента")}<input value={searchQ} onChange={(e) => setSearchQ(e.target.value)} placeholder={uiText("Имя или телефон")} />
            </label>
            <label>
              {uiText("Должность")}<input value={position} onChange={(e) => setPosition(e.target.value)} />
            </label>
            <label>
              <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} /> {" "}{uiText("Основной контакт")}</label>
            <label>
              <input
                type="checkbox"
                checked={isDecisionMaker}
                onChange={(e) => setIsDecisionMaker(e.target.checked)}
              />{" "}
              {uiText("ЛПР")}</label>
            <label>
              <input
                type="checkbox"
                checked={isBillingContact}
                onChange={(e) => setIsBillingContact(e.target.checked)}
              />{" "}
              {uiText("Финансовый контакт")}</label>
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
              {uiText("Закрыть")}</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
