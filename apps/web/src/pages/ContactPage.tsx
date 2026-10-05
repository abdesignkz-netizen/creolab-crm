import { uiTaskStatus, uiTaskTitle, uiText, useUiText, localizeUiOptions, uiMessage, uiFormatLocale } from "../lib/uiText";
import { notifySaved } from "../components/SaveNotice";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { nameWithPhone, phoneText } from "../lib/contactDisplay";
import { formatWaitSince } from "../lib/duration";
import { api } from "../lib/api";
import { statusBadgeClass } from "../lib/statusBadge";
import { useCapabilities } from "../lib/session";
import { CALLS_ENABLED } from "../lib/featureFlags";
import { tip } from "../lib/tip";
import { conversationModeLabel, dealOutcomeLabel } from "../lib/labels";

export function ContactPage() {
  const uiText = useUiText();
  const caps = useCapabilities();
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"history" | "requests" | "conversations" | "deals" | "tasks">("history");
  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [companyLinkOpen, setCompanyLinkOpen] = useState(false);
  const [companySearch, setCompanySearch] = useState("");
  const [companyHits, setCompanyHits] = useState<any[]>([]);
  const [linkPosition, setLinkPosition] = useState("");
  const [linkPrimary, setLinkPrimary] = useState(false);
  const [linkLpr, setLinkLpr] = useState(false);
  const [linkBilling, setLinkBilling] = useState(false);
  const [newCompanyName, setNewCompanyName] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [noteOpen, setNoteOpen] = useState(true);
  const [noteBusy, setNoteBusy] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [writeBusy, setWriteBusy] = useState(false);
  const [writeBlocked, setWriteBlocked] = useState(false);

  async function load() {
    if (!id) return;
    try {
      setData(await api.contactOverview(id));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Ошибка"));
    }
  }

  useEffect(() => {
    setWriteBlocked(false);
    setWriteBusy(false);
    load();
  }, [id]);

  useEffect(() => {
    if (!editOpen) return;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [editOpen]);

  useEffect(() => {
    if (!companyLinkOpen) return;
    const t = setTimeout(() => {
      api
        .companies({ q: companySearch.trim() || undefined })
        .then((res: any) => setCompanyHits(res.items || []))
        .catch(() => setCompanyHits([]));
    }, companySearch.trim() ? 220 : 0);
    return () => clearTimeout(t);
  }, [companySearch, companyLinkOpen]);

  if (!data && !error) return <div className="state">{uiText("Загрузка…")}</div>;
  if (!data) {
    return (
      <section>
        <p className="error">{error}</p>
        <button className="btn" onClick={load}>{uiText("Повторить")}</button>
      </section>
    );
  }

  const { client, currentRequest, control, attribution, tags, notes, requests, conversations, deals, tasks, timeline, gaps, members } = data;
  const tel = client.phoneNormalized || client.phone?.replace(/\D+/g, "");
  const whatsapp = conversations.find((item: { sellerLeadId?: string | null }) => item.sellerLeadId) || null;

  async function openWhatsAppChat() {
    if (writeBusy || writeBlocked) return;
    setWriteBusy(true);
    setError("");
    try {
      const opened = await api.openContactWhatsAppChat(client.id);
      navigate(`/conversations/${opened.conversationId}?focus=reply`);
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? String((err as { code?: string }).code) : "";
      const message = err instanceof Error ? err.message : uiText("Не удалось открыть WhatsApp");
      if (code === "WHATSAPP_NOT_REGISTERED") {
        setWriteBlocked(true);
      }
      setError(message);
    } finally {
      setWriteBusy(false);
    }
  }

  return (
    <section className="contact-page">
      <div className="page-head">
        <div>
          <Link className="muted" to="/contacts">{uiText("← Клиенты")}</Link>
          <h2>{nameWithPhone(client.name, client.phone)}</h2>
          <div className="muted">
            {phoneText(client.phone)}
            {client.companyName ? ` · ${client.companyName}` : ""}
          </div>
          <div className="client-meta">
            <span className={statusBadgeClass(uiMessage(client.lifecycleLabel))}>{uiMessage(client.lifecycleLabel)}</span>
            {uiMessage(client.temperatureLabel) && client.leadTemperature !== "unknown" ? (
              <span className="badge">{uiMessage(client.temperatureLabel)}</span>
            ) : null}
            {control.needsReply ? (
              <span className="badge warn">
                {uiText("Нужен ответ")}{control.waitMinutes != null ? ` · ${formatWaitSince(control.waitMinutes)}` : ""}
              </span>
            ) : null}
            {control.overdue ? <span className="badge danger">{uiText("Просрочка")}</span> : null}
            {control.missingNextAction ? <span className="badge warn">{uiText("Нет следующего действия")}</span> : null}
          </div>
        </div>
        <div className="actions sticky-actions">
          {whatsapp ? (
            <Link
              className="btn"
              to={`/conversations/${whatsapp.id}?focus=reply`}
              {...tip(uiText("Открыть WhatsApp-диалог и ответить клиенту"))}
            >
              {uiText("Написать")}</Link>
          ) : writeBlocked ? (
            <button className="btn secondary" disabled {...tip(uiText("Этот номер не зарегистрирован в WhatsApp"))}>
              {uiText("Написать")}</button>
          ) : !tel ? (
            <button className="btn secondary" disabled {...tip(uiText("Укажите телефон клиента, чтобы написать в WhatsApp"))}>
              {uiText("Написать")}</button>
          ) : (
            <button
              className="btn"
              disabled={writeBusy}
              {...tip(uiText("Открыть WhatsApp, даже если переписки ещё не было"))}
              onClick={() => void openWhatsAppChat()}
            >
              {writeBusy ? uiText("Открываем…") : uiText("Написать")}
            </button>
          )}
          {CALLS_ENABLED && tel ? (
            <a className="btn secondary" href={`tel:+${tel}`} {...tip(uiText("Позвонить с телефона"))}>
              {uiText("Позвонить")}</a>
          ) : null}
          {CALLS_ENABLED && !tel ? (
            <button className="btn secondary" disabled {...tip(uiText("Телефон не указан"))}>
              {uiText("Позвонить")}</button>
          ) : null}
          <Link className="btn secondary" to={`/tasks?contactId=${client.id}`} {...tip(uiText("Создать задачу по этому клиенту"))}>
            {uiText("+ Задача")}</Link>
          {currentRequest ? (
            <Link
              className="btn secondary"
              to={`/requests/${currentRequest.id}`}
              {...tip(uiText("Открыть текущую заявку клиента"))}
            >
              {uiText("+ Сделка / заявка")}</Link>
          ) : (
            <Link
              className="btn secondary"
              to={`/inquiries?contact=${client.id}`}
              {...tip(uiText("Создать новую заявку с уже выбранным клиентом"))}
            >
              {uiText("+ Заявка")}</Link>
          )}
          <div className="menu-wrap">
            <button
              className="btn secondary"
              {...tip(uiText("Дополнительные действия: редактировать, теги, архив, удаление"))}
              onClick={() => setMenuOpen((value) => !value)}
            >
              •••
            </button>
            {menuOpen ? (
              <div className="menu">
                {!caps.manager ? <button type="button" onClick={() => { setEditOpen(true); setMenuOpen(false); }}>{uiText("Редактировать")}</button> : null}
                <button
                  type="button"
                  onClick={async () => {
                    const text = prompt(uiText("Внутренняя заметка"));
                    if (!text) return;
                    await api.addContactNote(client.id, { text });
                    notifySaved(uiText("Заметка сохранена"));
                    await load();
                    setMenuOpen(false);
                  }}
                >
                  {uiText("Добавить заметку")}</button>
                <button
                  type="button"
                  onClick={async () => {
                    const name = prompt(uiText("Тег"));
                    if (!name) return;
                    await api.addContactTag(client.id, name);
                    await load();
                    setMenuOpen(false);
                  }}
                >
                  {uiText("Добавить тег")}</button>
                <button
                  type="button"
                  onClick={async () => {
                    await api.updateContact(client.id, { archived: true });
                    navigate("/contacts");
                  }}
                >
                  {uiText("Архивировать")}</button>
                {caps.companyAdmin ? (
                  <button
                    type="button"
                    className="danger"
                    onClick={() => {
                      setDeleteError("");
                      setDeleteConfirm(true);
                      setMenuOpen(false);
                    }}
                  >
                    {uiText("Удалить клиента")}</button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}

      {deleteConfirm && caps.companyAdmin ? (
        <div className="panel contact-delete-confirm" role="alertdialog" aria-labelledby="contact-delete-title">
          <p id="contact-delete-title">
            {uiText("Удалить клиента безвозвратно вместе с заявками и диалогами? Сделки с выставленными счетами, подписанными договорами или ЭСФ удалить нельзя — тогда архивируйте карточку. Отменить удаление нельзя.")}</p>
          {deleteError ? <p className="error" role="alert">{deleteError}</p> : null}
          <div className="actions">
            <button
              type="button"
              className="btn danger"
              disabled={deleteBusy}
              onClick={async () => {
                if (deleteBusy) return;
                setDeleteBusy(true);
                setDeleteError("");
                try {
                  await api.deleteContact(client.id);
                  notifySaved(uiText("Клиент удалён"));
                  window.dispatchEvent(new Event("creolab:attention-changed"));
                  navigate("/contacts");
                } catch (err) {
                  setDeleteError(err instanceof Error ? err.message : uiText("Не удалось удалить клиента"));
                } finally {
                  setDeleteBusy(false);
                }
              }}
            >
              {deleteBusy ? uiText("Удаляем…") : uiText("Да, удалить")}
            </button>
            <button
              type="button"
              className="btn secondary"
              disabled={deleteBusy}
              onClick={() => {
                setDeleteConfirm(false);
                setDeleteError("");
              }}
            >
              {uiText("Отмена")}</button>
          </div>
        </div>
      ) : null}

      {editOpen && !caps.manager ? (
        <form
          className="panel contact-edit-card"
          onSubmit={async (event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const text = (key: string) => {
              const value = String(form.get(key) || "").trim();
              return value || null;
            };
            setEditBusy(true);
            try {
              const firstName = text("firstName");
              const lastName = text("lastName");
              const composedName = [firstName, lastName].filter(Boolean).join(" ");
              await api.updateContact(client.id, {
                firstName,
                lastName,
                companyName: text("companyName"),
                jobTitle: text("jobTitle"),
                city: text("city"),
                summary: text("summary"),
                leadTemperature: String(form.get("leadTemperature") || "unknown"),
                ...(composedName ? { name: composedName } : {}),
              });
              setEditOpen(false);
              notifySaved(uiText("Данные клиента сохранены"));
              setError("");
              await load();
            } catch (err) {
              setError(err instanceof Error ? err.message : uiText("Не удалось сохранить клиента"));
            } finally {
              setEditBusy(false);
            }
          }}
        >
          <b>{uiText("Редактировать клиента")}</b>
          <p className="muted">{uiText("Изменения применятся после сохранения. Пустые поля можно оставить — они не обязательны.")}</p>
          <label>{uiText("Имя")}<input name="firstName" defaultValue={client.firstName || ""} /></label>
          <label>{uiText("Фамилия")}<input name="lastName" defaultValue={client.lastName || ""} /></label>
          <label>{uiText("Компания")}<input name="companyName" defaultValue={client.companyName || ""} /></label>
          <label>{uiText("Должность")}<input name="jobTitle" defaultValue={client.jobTitle || ""} /></label>
          <label>{uiText("Город")}<input name="city" defaultValue={client.city || ""} /></label>
          <label>
            {uiText("Насколько горячий клиент")}<select name="leadTemperature" defaultValue={client.leadTemperature || "unknown"}>
              <option value="unknown">{uiText("Не указано")}</option>
              <option value="hot">{uiText("Горячий — готов обсуждать")}</option>
              <option value="warm">{uiText("Тёплый — думает")}</option>
              <option value="cold">{uiText("Холодный — пока не актуально")}</option>
            </select>
          </label>
          <label>{uiText("Кратко о клиенте")}<textarea name="summary" defaultValue={client.summary || ""} /></label>
          <div className="actions">
            <button type="submit" className="btn" disabled={editBusy}>
              {editBusy ? uiText("Сохранение…") : uiText("Сохранить")}
            </button>
            <button type="button" className="btn secondary" onClick={() => setEditOpen(false)}>
              {uiText("Отмена")}</button>
          </div>
        </form>
      ) : null}

      <div className="summary-card">
        <p>{client.summary}</p>
        <div className="summary-grid">
          <div>
            <span className="muted">{uiText("Интерес")}</span>
            <div>{client.interest || currentRequest?.title || uiText("Интерес пока не определён")}</div>
            {client.interestSource === "conversation" ? <span className="badge" {...tip(uiText("Определено по сообщению клиента в переписке"))}>{uiText("Из переписки")}</span> : null}
          </div>
          <div>
            <span className="muted">{uiText("Источник")}</span>
            <div>
              {attribution.sourceType || uiText("Не указано")}
              {attribution.utmSource ? ` · ${attribution.utmSource}` : ""}
              {attribution.utmCampaign ? ` / ${attribution.utmCampaign}` : ""}
            </div>
          </div>
          <div>
            <span className="muted">{uiText("Следующий шаг")}</span>
            <div>
              {control.nextAction
                ? `${uiTaskTitle(control.nextAction)}${control.nextAction.dueLabel ? ` · ${control.nextAction.dueLabel}` : ""}`
                : control.nextStepText || <span className="warn-text">{uiText("Нет следующего действия")}</span>}
            </div>
          </div>
          <div>
            <span className="muted">{uiText("Ответственный")}</span>
            <div>{control.ownerName || uiText("не назначен")}</div>
          </div>
        </div>
      </div>

      <div className="contact-layout">
        <div className="contact-main">
          <div className="card">
            <b>{uiText("Текущая заявка")}</b>
            {currentRequest ? (
              <>
                <p>{currentRequest.title}</p>
                <p className="muted">{currentRequest.description || uiText("Описание не указано")}</p>
                <div className="muted">
                  {uiText("Статус:")}{" "}{uiMessage(currentRequest.statusLabel)}
                  {currentRequest.service ? uiText(" · Услуга: {p0}", {p0: currentRequest.service}) : ""}
                  {currentRequest.budgetLabel ? uiText(" · Бюджет: {p0}", {p0: currentRequest.budgetLabel}) : uiText(" · Бюджет пока не определён")}
                  {currentRequest.desiredDeadline ? uiText(" · Срок: {p0}", {p0: currentRequest.desiredDeadline}) : ""}
                </div>
                <div className="actions" style={{ marginTop: 10 }}>
                  <Link className="btn secondary" to={`/requests/${currentRequest.id}`}>
                    {uiText("Открыть заявку")}</Link>
                </div>
              </>
            ) : (
              <p className="muted">{uiText("Активной заявки нет.")}{" "}<button className="linkish" onClick={() => navigate("/inquiries")}>{uiText("Добавить")}</button></p>
            )}
          </div>

          <div className="card">
            <b>{uiText("Контактные данные")}</b>
            <dl className="kv">
              <div><dt>{uiText("Имя")}</dt><dd>{client.firstName || client.name || uiText("Не указано")}</dd></div>
              <div><dt>{uiText("Фамилия")}</dt><dd>{client.lastName || uiText("Не указано")}</dd></div>
              <div><dt>{uiText("Телефон")}</dt><dd>{client.phone || uiText("Не указано")}</dd></div>
              <div><dt>Email</dt><dd>{client.email || uiText("Не указано")}</dd></div>
              <div><dt>{uiText("Компания (текст)")}</dt><dd>{client.companyName || uiText("Не указано")}</dd></div>
              <div><dt>{uiText("Должность")}</dt><dd>{client.jobTitle || uiText("Не указано")}</dd></div>
              <div><dt>{uiText("Город")}</dt><dd>{client.city || uiText("Не указано")}</dd></div>
              <div><dt>{uiText("Язык")}</dt><dd>{client.language === "unknown" ? uiText("Не указано") : client.language}</dd></div>
            </dl>
          </div>

          <div className="card">
            <b>{uiText("Компания")}</b>
            {(data.companies || []).length ? (
              (data.companies || []).map((item: any) => (
                <div key={item.linkId} style={{ marginTop: 10 }}>
                  <Link to={item.href}>
                    <b>{item.company.name}</b>
                  </Link>
                  <div className="muted">
                    {[
                      item.position,
                      item.isPrimary ? uiText("Основной контакт") : null,
                      item.isDecisionMaker ? uiText("ЛПР") : null,
                      item.isBillingContact ? uiText("Финансовый") : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                  <button
                    type="button"
                    className="linkish"
                    style={{ marginTop: 4 }}
                    onClick={async () => {
                      if (!window.confirm(uiText("Убрать клиента из «{p0}»?", {p0: item.company.name}))) return;
                      try {
                        await api.unlinkCompanyContact(item.company.id, item.linkId);
                        await load();
                      } catch (err) {
                        setError(err instanceof Error ? err.message : uiText("Не удалось убрать из компании"));
                      }
                    }}
                  >
                    {uiText("Убрать из компании")}</button>
                </div>
              ))
            ) : (
              <p className="muted" style={{ marginTop: 8 }}>
                {uiText("Компания не указана")}</p>
            )}
            <div className="actions" style={{ marginTop: 10 }}>
              <button type="button" className="btn secondary" onClick={() => setCompanyLinkOpen(true)}>
                {uiText("Связать с компанией")}</button>
            </div>
          </div>

          <div className="card">
            <b>{uiText("Откуда пришёл")}</b>
            <dl className="kv">
              <div><dt>{uiText("Источник обращения")}</dt><dd>{attribution.sourceType || uiText("Не указано")}</dd></div>
              <div><dt>{uiText("Канал")}</dt><dd>{attribution.sourceChannel || uiText("Не указано")}</dd></div>
              <div><dt>{uiText("Интеграция")}</dt><dd>{attribution.sourceIntegration || uiText("Не указано")}</dd></div>
              <div><dt>{uiText("Откуда пришёл")}</dt><dd>{attribution.utmSource || uiText("Не указано")}</dd></div>
              <div><dt>{uiText("Канал рекламы")}</dt><dd>{attribution.utmMedium || uiText("Не указано")}</dd></div>
              <div><dt>{uiText("Кампания")}</dt><dd>{attribution.utmCampaign || uiText("Не указано")}</dd></div>
              <div><dt>{uiText("Страница")}</dt><dd>{attribution.landingPage || uiText("Не указано")}</dd></div>
              <div><dt>{uiText("Предыдущая страница")}</dt><dd>{attribution.referrer || uiText("Не указано")}</dd></div>
            </dl>
          </div>

          {notes.filter((item: any) => item.pinned).length ? (
            <div className="card">
              <b>{uiText("Важно")}</b>
              {notes.filter((item: any) => item.pinned).map((item: any) => (
                <p key={item.id}>{item.text}</p>
              ))}
            </div>
          ) : null}
        </div>

        <aside className="contact-side">
          <div className="card control-card">
            <b>{uiText("Контроль")}</b>
            <dl className="kv">
              <div>
                <dt>{uiText("Ответственный")}</dt>
                <dd>
                  <select
                    value={control.ownerMembershipId || ""}
                    onChange={async (event) => {
                      try {
                        await api.updateContact(client.id, { ownerMembershipId: event.target.value || null });
                        notifySaved(uiText("Ответственный сохранён"));
                        await load();
                      } catch (err) { setError(err instanceof Error ? err.message : uiText("Не удалось сохранить ответственного")); }
                    }}
                  >
                    <option value="">{uiText("Не назначен")}</option>
                    {members.map((member: any) => (
                      <option key={member.id} value={member.id}>{member.name}</option>
                    ))}
                  </select>
                </dd>
              </div>
              <div>
                <dt>{uiText("Следующее действие")}</dt>
                <dd>
                  {control.nextAction ? (
                    <>
                      {uiMessage(control.nextAction.typeLabel)}: {uiTaskTitle(control.nextAction)}
                      <div className="muted">
                        {control.nextAction.dueLabel || uiText("без срока")}
                        {control.nextAction.overdue ? uiText(" · Просрочено на {p0} ч", {p0: control.nextAction.overdueHours}) : ""}
                      </div>
                    </>
                  ) : control.nextStepText ? (
                    control.nextStepText
                  ) : (
                    <span className="warn-text">{uiText("Нет следующего действия")}</span>
                  )}
                </dd>
              </div>
              <div><dt>{uiText("Последний контакт")}</dt><dd>{control.lastContactLabel || "—"}</dd></div>
              <div><dt>{uiText("Последним написал")}</dt><dd>{uiMessage(control.lastWriterLabel)}</dd></div>
              <div><dt>AI</dt><dd>{uiMessage(control.aiModeLabel)}</dd></div>
              {control.attentionReason ? <div><dt>{uiText("Причина эскалации")}</dt><dd>{control.attentionReason}</dd></div> : null}
              <div><dt>{uiText("Просрочка")}</dt><dd>{control.overdue ? uiText("Да") : uiText("Нет")}</dd></div>
            </dl>
          </div>

          <div className="card">
            <b>{uiText("Статус клиента")}</b>
            <select
              value={client.lifecycleStatus}
              onChange={async (event) => {
                try {
                  await api.updateContact(client.id, { lifecycleStatus: event.target.value });
                  notifySaved(uiText("Статус клиента сохранён"));
                  await load();
                } catch (err) { setError(err instanceof Error ? err.message : uiText("Не удалось сохранить статус")); }
              }}
            >
              <option value="new">{uiText("Новый")}</option>
              <option value="in_progress">{uiText("В работе")}</option>
              <option value="active">{uiText("Активный")}</option>
              <option value="paused">{uiText("На паузе")}</option>
              <option value="lost">{uiText("Потерян")}</option>
              <option value="archived">{uiText("Архив")}</option>
            </select>
            <div className="muted" style={{ marginTop: 10 }}>
              {uiText("Первое обращение:")}{" "}{client.firstContactLabel || "—"}
              <br />
              {uiText("Последний inbound:")}{" "}{client.lastInboundLabel || "—"}
              <br />
              {uiText("Последний outbound:")}{" "}{client.lastOutboundLabel || "—"}
            </div>
          </div>

          <div className="card">
            <b>{uiText("Теги")}</b>
            <div className="client-meta">
              {tags.length === 0 ? <span className="muted">{uiText("Нет тегов")}</span> : null}
              {tags.map((tag: any) => (
                <button
                  key={tag.id}
                  className="badge"
                  onClick={async () => {
                    await api.removeContactTag(client.id, tag.id);
                    await load();
                  }}
                  title={uiText("Убрать тег")}
                >
                  {tag.name} ×
                </button>
              ))}
            </div>
          </div>

          {gaps?.length ? (
            <div className="card">
              <b>{uiText("Не хватает данных")}</b>
              <p className="muted">{gaps.join(", ")}</p>
            </div>
          ) : null}
        </aside>
      </div>

      <div className="actions chip-row">
        {(
          [
            ["history", uiText("История")],
            ["requests", uiText("Заявки")],
            ["conversations", uiText("Диалоги")],
            ["deals", uiText("Сделки")],
            ["tasks", uiText("Задачи")],
          ] as const
        ).map(([value, label]) => (
          <button key={value} className={tab === value ? "btn" : "btn secondary"} onClick={() => setTab(value)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "history" ? (
        <div className="timeline">
          {timeline.length === 0 ? <p className="empty">{uiText("История пока пуста")}</p> : null}
          {timeline.map((item: any) => (
            <div className="timeline-item" key={`${item.kind}-${item.id}`}>
              <div className="muted">{item.atLabel}</div>
              <b>{item.kind === "activity" ? uiMessage(item.title) : item.title}</b>
              {item.description ? <div>{item.description}</div> : null}
            </div>
          ))}
          <div className="card">
            <b>{uiText("Заметки")}</b>
            {notes.length === 0 ? <p className="muted">{uiText("Нет заметок")}</p> : null}
            {notes.map((item: any) => (
              <div key={item.id} className="row" style={{ marginTop: 8 }}>
                <div>
                  {item.pinned ? <span className="badge">{uiText("Закреплено")}</span> : null}
                  <div>{item.text}</div>
                  <div className="muted">{item.createdLabel}</div>
                </div>
              </div>
            ))}
            {!noteOpen ? <button type="button" className="btn secondary" onClick={() => setNoteOpen(true)}>{uiText("Добавить заметку")}</button> : <form
              className="inline-form"
              onSubmit={async (event) => {
                event.preventDefault();
                if (noteBusy) return;
                const formElement = event.currentTarget;
                const form = new FormData(formElement);
                setNoteBusy(true);
                setError("");
                try {
                  await api.addContactNote(client.id, {
                    text: String(form.get("text")), pinned: Boolean(form.get("pinned")),
                  });
                  formElement.reset();
                  setNoteOpen(false);
                  notifySaved(uiText("Заметка сохранена"));
                  await load();
                } catch (err) {
                  setError(err instanceof Error ? err.message : uiText("Не удалось сохранить заметку"));
                } finally { setNoteBusy(false); }
              }}
            >
              <input name="text" required placeholder={uiText("Внутренняя заметка")} />
              <label className="check">
                <input type="checkbox" name="pinned" /> {" "}{uiText("Закрепить")}</label>
              <button className="btn" disabled={noteBusy}>{noteBusy ? uiText("Сохраняем…") : uiText("Сохранить")}</button>
            </form>}
          </div>
        </div>
      ) : null}

      {tab === "requests" ? (
        <div>
          {requests.map((item: any) => (
            <div className="row" key={item.id}>
              <div>
                <b>{item.title}</b>
                <div className="muted">{item.receivedLabel} · {uiMessage(item.statusLabel)}</div>
              </div>
              <Link to={`/requests/${item.id}`}>{uiText("Открыть")}</Link>
            </div>
          ))}
        </div>
      ) : null}

      {tab === "conversations" ? (
        <div>
          {conversations.length === 0 ? <p className="empty">{uiText("Диалогов нет")}</p> : null}
          {conversations.map((item: any) => (
            <Link className="row" key={item.id} to={`/conversations/${item.id}`}>
              <div>
                <b>{item.channel}</b>
                <div className="muted">{item.updatedLabel} · {item.lastMessage || uiText("нет сообщений")}</div>
              </div>
              <span className="badge">{conversationModeLabel(item.mode, uiMessage(item.modeLabel))}</span>
            </Link>
          ))}
        </div>
      ) : null}

      {tab === "deals" ? (
        <div>
          {deals.length === 0 ? <p className="empty">{uiText("Сделок нет")}</p> : null}
          {deals.map((item: any) => (
            <div className="row" key={item.id}>
              <div>
                <b>{item.title}</b>
                <div className="muted">
                  {dealOutcomeLabel(item.outcome, item.stage)}
                  {item.amountMinor != null ? ` · ${Number(item.amountMinor).toLocaleString(uiFormatLocale())} ${item.currency || "₸"}` : ""}
                  {item.createdLabel ? ` · ${item.createdLabel}` : ""}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {tab === "tasks" ? (
        <div>
          {tasks.length === 0 ? <p className="empty">{uiText("Задач нет")}</p> : null}
          {tasks.map((item: any) => (
            <div className="row" key={item.id}>
              <div>
                <b>{uiTaskTitle(item)}</b>
                <div className="muted">
                  {uiMessage(item.typeLabel)} · {uiTaskStatus(item.status)}
                  {item.dueLabel ? ` · ${item.dueLabel}` : ""}
                  {item.overdue ? uiText(" · просрочено") : ""}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <details className="card">
        <summary>{uiText("Системная информация")}</summary>
        <p className="muted">
          Client ID: {client.id}
          <br />
          {uiText("Создан:")}{" "}{client.firstContactLabel}
          <br />
          {uiText("Обновлён:")}{" "}{client.lastContactLabel}
          <br />
          Score: {client.leadScore ?? "—"}
        </p>
      </details>

      {companyLinkOpen ? (
        <div className="stats-modal-backdrop" onClick={() => setCompanyLinkOpen(false)}>
          <div className="stats-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{uiText("Связать с компанией")}</h3>
            <label>
              {uiText("Поиск компании")}<input
                value={companySearch}
                onChange={(e) => setCompanySearch(e.target.value)}
                placeholder={uiText("Название или БИН")}
              />
            </label>
            <label>
              {uiText("Должность")}<input value={linkPosition} onChange={(e) => setLinkPosition(e.target.value)} />
            </label>
            <label>
              <input type="checkbox" checked={linkPrimary} onChange={(e) => setLinkPrimary(e.target.checked)} />{" "}
              {uiText("Основной контакт")}</label>
            <label>
              <input type="checkbox" checked={linkLpr} onChange={(e) => setLinkLpr(e.target.checked)} /> {" "}{uiText("ЛПР")}</label>
            <label>
              <input type="checkbox" checked={linkBilling} onChange={(e) => setLinkBilling(e.target.checked)} />{" "}
              {uiText("Финансовый контакт")}</label>
            <div className="picker-list">
              {companyHits.map((hit) => (
                <button
                  key={hit.id}
                  type="button"
                  className="picker-item"
                  disabled={linkBusy}
                  onClick={async () => {
                    setLinkBusy(true);
                    try {
                      await api.linkCompanyContact(hit.id, {
                        contactId: client.id,
                        position: linkPosition || client.jobTitle || null,
                        isPrimary: linkPrimary,
                        isDecisionMaker: linkLpr,
                        isBillingContact: linkBilling,
                      });
                      setCompanyLinkOpen(false);
                      await load();
                    } catch (err) {
                      setError(err instanceof Error ? err.message : uiText("Ошибка"));
                    } finally {
                      setLinkBusy(false);
                    }
                  }}
                >
                  <b>{hit.name}</b>
                  <div className="muted">{[hit.city, hit.industry].filter(Boolean).join(" · ")}</div>
                </button>
              ))}
            </div>
            <hr />
            <label>
              {uiText("Или создать компанию")}<input
                value={newCompanyName}
                onChange={(e) => setNewCompanyName(e.target.value)}
                placeholder={client.companyName || uiText("Название")}
              />
            </label>
            <button
              type="button"
              className="btn"
              disabled={linkBusy || !(newCompanyName || client.companyName)}
              onClick={async () => {
                setLinkBusy(true);
                try {
                  const created: any = await api.createCompany({
                    name: newCompanyName || client.companyName,
                    forceCreate: true,
                    city: client.city || undefined,
                  });
                  await api.linkCompanyContact(created.id, {
                    contactId: client.id,
                    position: linkPosition || client.jobTitle || null,
                    isPrimary: true,
                    isDecisionMaker: linkLpr,
                    isBillingContact: linkBilling,
                  });
                  setCompanyLinkOpen(false);
                  await load();
                } catch (err) {
                  setError(err instanceof Error ? err.message : uiText("Ошибка"));
                } finally {
                  setLinkBusy(false);
                }
              }}
            >
              {uiText("+ Создать компанию и связать")}</button>
            <button type="button" className="btn secondary" onClick={() => setCompanyLinkOpen(false)}>
              {uiText("Закрыть")}</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
