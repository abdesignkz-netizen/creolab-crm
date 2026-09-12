import { notifySaved } from "../components/SaveNotice";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { nameWithPhone, phoneText } from "../lib/contactDisplay";
import { formatWaitSince } from "../lib/duration";
import { api } from "../lib/api";
import { CALLS_ENABLED } from "../lib/featureFlags";
import { tip } from "../lib/tip";

export function ContactPage() {
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

  async function load() {
    if (!id) return;
    try {
      setData(await api.contactOverview(id));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    }
  }

  useEffect(() => {
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

  if (!data && !error) return <div className="state">Загрузка…</div>;
  if (!data) {
    return (
      <section>
        <p className="error">{error}</p>
        <button className="btn" onClick={load}>Повторить</button>
      </section>
    );
  }

  const { client, currentRequest, control, attribution, tags, notes, requests, conversations, deals, tasks, timeline, gaps, members } = data;
  const tel = client.phoneNormalized || client.phone?.replace(/\D+/g, "");

  return (
    <section className="contact-page">
      <div className="page-head">
        <div>
          <Link className="muted" to="/contacts">← Клиенты</Link>
          <h2>{nameWithPhone(client.name, client.phone)}</h2>
          <div className="muted">
            {phoneText(client.phone)}
            {client.companyName ? ` · ${client.companyName}` : ""}
          </div>
          <div className="client-meta">
            <span className="badge">{client.lifecycleLabel}</span>
            {client.temperatureLabel && client.leadTemperature !== "unknown" ? (
              <span className="badge">{client.temperatureLabel}</span>
            ) : null}
            {control.needsReply ? (
              <span className="badge warn">
                Нужен ответ{control.waitMinutes != null ? ` · ${formatWaitSince(control.waitMinutes)}` : ""}
              </span>
            ) : null}
            {control.overdue ? <span className="badge danger">Просрочка</span> : null}
            {control.missingNextAction ? <span className="badge warn">Нет следующего действия</span> : null}
          </div>
        </div>
        <div className="actions sticky-actions">
          {conversations[0] ? (
            <Link
              className="btn"
              to={`/conversations/${conversations[0].id}?focus=reply`}
              {...tip("Открыть WhatsApp-диалог и ответить клиенту")}
            >
              Написать
            </Link>
          ) : (
            <button className="btn secondary" disabled {...tip("Нет связанного диалога WhatsApp")}>
              Написать
            </button>
          )}
          {CALLS_ENABLED && tel ? (
            <a className="btn secondary" href={`tel:+${tel}`} {...tip("Позвонить с телефона")}>
              Позвонить
            </a>
          ) : null}
          {CALLS_ENABLED && !tel ? (
            <button className="btn secondary" disabled {...tip("Телефон не указан")}>
              Позвонить
            </button>
          ) : null}
          <Link className="btn secondary" to={`/tasks?contactId=${client.id}`} {...tip("Создать задачу по этому клиенту")}>
            + Задача
          </Link>
          {currentRequest ? (
            <Link
              className="btn secondary"
              to={`/requests/${currentRequest.id}`}
              {...tip("Открыть текущую заявку клиента")}
            >
              + Сделка / заявка
            </Link>
          ) : (
            <Link
              className="btn secondary"
              to={`/inquiries?contact=${client.id}`}
              {...tip("Создать новую заявку с уже выбранным клиентом")}
            >
              + Заявка
            </Link>
          )}
          <div className="menu-wrap">
            <button
              className="btn secondary"
              {...tip("Дополнительные действия: редактировать, теги, архив")}
              onClick={() => setMenuOpen((value) => !value)}
            >
              •••
            </button>
            {menuOpen ? (
              <div className="menu">
                <button onClick={() => { setEditOpen(true); setMenuOpen(false); }}>Редактировать</button>
                <button
                  onClick={async () => {
                    const text = prompt("Внутренняя заметка");
                    if (!text) return;
                    await api.addContactNote(client.id, { text });
                    notifySaved("Заметка сохранена");
                    await load();
                    setMenuOpen(false);
                  }}
                >
                  Добавить заметку
                </button>
                <button
                  onClick={async () => {
                    const name = prompt("Тег");
                    if (!name) return;
                    await api.addContactTag(client.id, name);
                    await load();
                    setMenuOpen(false);
                  }}
                >
                  Добавить тег
                </button>
                <button
                  onClick={async () => {
                    await api.updateContact(client.id, { archived: true });
                    navigate("/contacts");
                  }}
                >
                  Архивировать
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}

      {editOpen ? (
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
              notifySaved("Данные клиента сохранены");
              setError("");
              await load();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Не удалось сохранить клиента");
            } finally {
              setEditBusy(false);
            }
          }}
        >
          <b>Редактировать клиента</b>
          <p className="muted">Изменения применятся после сохранения. Пустые поля можно оставить — они не обязательны.</p>
          <label>Имя<input name="firstName" defaultValue={client.firstName || ""} /></label>
          <label>Фамилия<input name="lastName" defaultValue={client.lastName || ""} /></label>
          <label>Компания<input name="companyName" defaultValue={client.companyName || ""} /></label>
          <label>Должность<input name="jobTitle" defaultValue={client.jobTitle || ""} /></label>
          <label>Город<input name="city" defaultValue={client.city || ""} /></label>
          <label>
            Насколько горячий клиент
            <select name="leadTemperature" defaultValue={client.leadTemperature || "unknown"}>
              <option value="unknown">Не указано</option>
              <option value="hot">Горячий — готов обсуждать</option>
              <option value="warm">Тёплый — думает</option>
              <option value="cold">Холодный — пока не актуально</option>
            </select>
          </label>
          <label>Кратко о клиенте<textarea name="summary" defaultValue={client.summary || ""} /></label>
          <div className="actions">
            <button type="submit" className="btn" disabled={editBusy}>
              {editBusy ? "Сохранение…" : "Сохранить"}
            </button>
            <button type="button" className="btn secondary" onClick={() => setEditOpen(false)}>
              Отмена
            </button>
          </div>
        </form>
      ) : null}

      <div className="summary-card">
        <p>{client.summary}</p>
        <div className="summary-grid">
          <div>
            <span className="muted">Интерес</span>
            <div>{client.interest || currentRequest?.title || "Интерес пока не определён"}</div>
            {client.interestSource === "conversation" ? <span className="badge" {...tip("Определено по сообщению клиента в переписке")}>Из переписки</span> : null}
          </div>
          <div>
            <span className="muted">Источник</span>
            <div>
              {attribution.sourceType || "Не указано"}
              {attribution.utmSource ? ` · ${attribution.utmSource}` : ""}
              {attribution.utmCampaign ? ` / ${attribution.utmCampaign}` : ""}
            </div>
          </div>
          <div>
            <span className="muted">Следующий шаг</span>
            <div>
              {control.nextAction
                ? `${control.nextAction.title}${control.nextAction.dueLabel ? ` · ${control.nextAction.dueLabel}` : ""}`
                : control.nextStepText || <span className="warn-text">Нет следующего действия</span>}
            </div>
          </div>
          <div>
            <span className="muted">Ответственный</span>
            <div>{control.ownerName || "не назначен"}</div>
          </div>
        </div>
      </div>

      <div className="contact-layout">
        <div className="contact-main">
          <div className="card">
            <b>Текущая заявка</b>
            {currentRequest ? (
              <>
                <p>{currentRequest.title}</p>
                <p className="muted">{currentRequest.description || "Описание не указано"}</p>
                <div className="muted">
                  Статус: {currentRequest.statusLabel}
                  {currentRequest.service ? ` · Услуга: ${currentRequest.service}` : ""}
                  {currentRequest.budgetLabel ? ` · Бюджет: ${currentRequest.budgetLabel}` : " · Бюджет пока не определён"}
                  {currentRequest.desiredDeadline ? ` · Срок: ${currentRequest.desiredDeadline}` : ""}
                </div>
                <div className="actions" style={{ marginTop: 10 }}>
                  <Link className="btn secondary" to={`/requests/${currentRequest.id}`}>
                    Открыть заявку
                  </Link>
                </div>
              </>
            ) : (
              <p className="muted">Активной заявки нет. <button className="linkish" onClick={() => navigate("/inquiries")}>Добавить</button></p>
            )}
          </div>

          <div className="card">
            <b>Контактные данные</b>
            <dl className="kv">
              <div><dt>Имя</dt><dd>{client.firstName || client.name || "Не указано"}</dd></div>
              <div><dt>Фамилия</dt><dd>{client.lastName || "Не указано"}</dd></div>
              <div><dt>Телефон</dt><dd>{client.phone || "Не указано"}</dd></div>
              <div><dt>Email</dt><dd>{client.email || "Не указано"}</dd></div>
              <div><dt>Компания (текст)</dt><dd>{client.companyName || "Не указано"}</dd></div>
              <div><dt>Должность</dt><dd>{client.jobTitle || "Не указано"}</dd></div>
              <div><dt>Город</dt><dd>{client.city || "Не указано"}</dd></div>
              <div><dt>Язык</dt><dd>{client.language === "unknown" ? "Не указано" : client.language}</dd></div>
            </dl>
          </div>

          <div className="card">
            <b>Компания</b>
            {(data.companies || []).length ? (
              (data.companies || []).map((item: any) => (
                <div key={item.linkId} style={{ marginTop: 10 }}>
                  <Link to={item.href}>
                    <b>{item.company.name}</b>
                  </Link>
                  <div className="muted">
                    {[
                      item.position,
                      item.isPrimary ? "Основной контакт" : null,
                      item.isDecisionMaker ? "ЛПР" : null,
                      item.isBillingContact ? "Финансовый" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                  <button
                    type="button"
                    className="linkish"
                    style={{ marginTop: 4 }}
                    onClick={async () => {
                      if (!window.confirm(`Убрать клиента из «${item.company.name}»?`)) return;
                      try {
                        await api.unlinkCompanyContact(item.company.id, item.linkId);
                        await load();
                      } catch (err) {
                        setError(err instanceof Error ? err.message : "Не удалось убрать из компании");
                      }
                    }}
                  >
                    Убрать из компании
                  </button>
                </div>
              ))
            ) : (
              <p className="muted" style={{ marginTop: 8 }}>
                Компания не указана
              </p>
            )}
            <div className="actions" style={{ marginTop: 10 }}>
              <button type="button" className="btn secondary" onClick={() => setCompanyLinkOpen(true)}>
                Связать с компанией
              </button>
            </div>
          </div>

          <div className="card">
            <b>Откуда пришёл</b>
            <dl className="kv">
              <div><dt>Источник обращения</dt><dd>{attribution.sourceType || "Не указано"}</dd></div>
              <div><dt>Канал</dt><dd>{attribution.sourceChannel || "Не указано"}</dd></div>
              <div><dt>Интеграция</dt><dd>{attribution.sourceIntegration || "Не указано"}</dd></div>
              <div><dt>UTM Source</dt><dd>{attribution.utmSource || "Не указано"}</dd></div>
              <div><dt>UTM Medium</dt><dd>{attribution.utmMedium || "Не указано"}</dd></div>
              <div><dt>UTM Campaign</dt><dd>{attribution.utmCampaign || "Не указано"}</dd></div>
              <div><dt>Landing</dt><dd>{attribution.landingPage || "Не указано"}</dd></div>
              <div><dt>Referrer</dt><dd>{attribution.referrer || "Не указано"}</dd></div>
            </dl>
          </div>

          {notes.filter((item: any) => item.pinned).length ? (
            <div className="card">
              <b>Важно</b>
              {notes.filter((item: any) => item.pinned).map((item: any) => (
                <p key={item.id}>{item.text}</p>
              ))}
            </div>
          ) : null}
        </div>

        <aside className="contact-side">
          <div className="card control-card">
            <b>Контроль</b>
            <dl className="kv">
              <div>
                <dt>Ответственный</dt>
                <dd>
                  <select
                    value={control.ownerMembershipId || ""}
                    onChange={async (event) => {
                      try {
                        await api.updateContact(client.id, { ownerMembershipId: event.target.value || null });
                        notifySaved("Ответственный сохранён");
                        await load();
                      } catch (err) { setError(err instanceof Error ? err.message : "Не удалось сохранить ответственного"); }
                    }}
                  >
                    <option value="">Не назначен</option>
                    {members.map((member: any) => (
                      <option key={member.id} value={member.id}>{member.name}</option>
                    ))}
                  </select>
                </dd>
              </div>
              <div>
                <dt>Следующее действие</dt>
                <dd>
                  {control.nextAction ? (
                    <>
                      {control.nextAction.typeLabel}: {control.nextAction.title}
                      <div className="muted">
                        {control.nextAction.dueLabel || "без срока"}
                        {control.nextAction.overdue ? ` · Просрочено на ${control.nextAction.overdueHours} ч` : ""}
                      </div>
                    </>
                  ) : control.nextStepText ? (
                    control.nextStepText
                  ) : (
                    <span className="warn-text">Нет следующего действия</span>
                  )}
                </dd>
              </div>
              <div><dt>Последний контакт</dt><dd>{control.lastContactLabel || "—"}</dd></div>
              <div><dt>Последним написал</dt><dd>{control.lastWriterLabel}</dd></div>
              <div><dt>AI</dt><dd>{control.aiModeLabel}</dd></div>
              {control.attentionReason ? <div><dt>Причина эскалации</dt><dd>{control.attentionReason}</dd></div> : null}
              <div><dt>Просрочка</dt><dd>{control.overdue ? "Да" : "Нет"}</dd></div>
            </dl>
          </div>

          <div className="card">
            <b>Статус клиента</b>
            <select
              value={client.lifecycleStatus}
              onChange={async (event) => {
                try {
                  await api.updateContact(client.id, { lifecycleStatus: event.target.value });
                  notifySaved("Статус клиента сохранён");
                  await load();
                } catch (err) { setError(err instanceof Error ? err.message : "Не удалось сохранить статус"); }
              }}
            >
              <option value="new">Новый</option>
              <option value="in_progress">В работе</option>
              <option value="active">Активный</option>
              <option value="paused">На паузе</option>
              <option value="lost">Потерян</option>
              <option value="archived">Архив</option>
            </select>
            <div className="muted" style={{ marginTop: 10 }}>
              Первое обращение: {client.firstContactLabel || "—"}
              <br />
              Последний inbound: {client.lastInboundLabel || "—"}
              <br />
              Последний outbound: {client.lastOutboundLabel || "—"}
            </div>
          </div>

          <div className="card">
            <b>Теги</b>
            <div className="client-meta">
              {tags.length === 0 ? <span className="muted">Нет тегов</span> : null}
              {tags.map((tag: any) => (
                <button
                  key={tag.id}
                  className="badge"
                  onClick={async () => {
                    await api.removeContactTag(client.id, tag.id);
                    await load();
                  }}
                  title="Убрать тег"
                >
                  {tag.name} ×
                </button>
              ))}
            </div>
          </div>

          {gaps?.length ? (
            <div className="card">
              <b>Не хватает данных</b>
              <p className="muted">{gaps.join(", ")}</p>
            </div>
          ) : null}
        </aside>
      </div>

      <div className="actions chip-row">
        {(
          [
            ["history", "История"],
            ["requests", "Заявки"],
            ["conversations", "Диалоги"],
            ["deals", "Сделки"],
            ["tasks", "Задачи"],
          ] as const
        ).map(([value, label]) => (
          <button key={value} className={tab === value ? "btn" : "btn secondary"} onClick={() => setTab(value)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "history" ? (
        <div className="timeline">
          {timeline.length === 0 ? <p className="empty">История пока пуста</p> : null}
          {timeline.map((item: any) => (
            <div className="timeline-item" key={`${item.kind}-${item.id}`}>
              <div className="muted">{item.atLabel}</div>
              <b>{item.title}</b>
              {item.description ? <div>{item.description}</div> : null}
            </div>
          ))}
          <div className="card">
            <b>Заметки</b>
            {notes.length === 0 ? <p className="muted">Нет заметок</p> : null}
            {notes.map((item: any) => (
              <div key={item.id} className="row" style={{ marginTop: 8 }}>
                <div>
                  {item.pinned ? <span className="badge">Закреплено</span> : null}
                  <div>{item.text}</div>
                  <div className="muted">{item.createdLabel}</div>
                </div>
              </div>
            ))}
            {!noteOpen ? <button type="button" className="btn secondary" onClick={() => setNoteOpen(true)}>Добавить заметку</button> : <form
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
                  notifySaved("Заметка сохранена");
                  await load();
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Не удалось сохранить заметку");
                } finally { setNoteBusy(false); }
              }}
            >
              <input name="text" required placeholder="Внутренняя заметка" />
              <label className="check">
                <input type="checkbox" name="pinned" /> Закрепить
              </label>
              <button className="btn" disabled={noteBusy}>{noteBusy ? "Сохраняем…" : "Сохранить"}</button>
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
                <div className="muted">{item.receivedLabel} · {item.statusLabel}</div>
              </div>
              <Link to={`/requests/${item.id}`}>Открыть</Link>
            </div>
          ))}
        </div>
      ) : null}

      {tab === "conversations" ? (
        <div>
          {conversations.length === 0 ? <p className="empty">Диалогов нет</p> : null}
          {conversations.map((item: any) => (
            <Link className="row" key={item.id} to={`/conversations/${item.id}`}>
              <div>
                <b>{item.channel}</b>
                <div className="muted">{item.updatedLabel} · {item.lastMessage || "нет сообщений"}</div>
              </div>
              <span className="badge">{item.mode}</span>
            </Link>
          ))}
        </div>
      ) : null}

      {tab === "deals" ? (
        <div>
          {deals.length === 0 ? <p className="empty">Сделок нет</p> : null}
          {deals.map((item: any) => (
            <div className="row" key={item.id}>
              <div>
                <b>{item.title}</b>
                <div className="muted">
                  {item.stage || item.outcome}
                  {item.amountMinor != null ? ` · ${item.amountMinor} ${item.currency}` : ""}
                  {item.createdLabel ? ` · ${item.createdLabel}` : ""}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {tab === "tasks" ? (
        <div>
          {tasks.length === 0 ? <p className="empty">Задач нет</p> : null}
          {tasks.map((item: any) => (
            <div className="row" key={item.id}>
              <div>
                <b>{item.title}</b>
                <div className="muted">
                  {item.typeLabel} · {item.status}
                  {item.dueLabel ? ` · ${item.dueLabel}` : ""}
                  {item.overdue ? " · просрочено" : ""}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <details className="card">
        <summary>Системная информация</summary>
        <p className="muted">
          Client ID: {client.id}
          <br />
          Создан: {client.firstContactLabel}
          <br />
          Обновлён: {client.lastContactLabel}
          <br />
          Score: {client.leadScore ?? "—"}
        </p>
      </details>

      {companyLinkOpen ? (
        <div className="stats-modal-backdrop" onClick={() => setCompanyLinkOpen(false)}>
          <div className="stats-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Связать с компанией</h3>
            <label>
              Поиск компании
              <input
                value={companySearch}
                onChange={(e) => setCompanySearch(e.target.value)}
                placeholder="Название или БИН"
              />
            </label>
            <label>
              Должность
              <input value={linkPosition} onChange={(e) => setLinkPosition(e.target.value)} />
            </label>
            <label>
              <input type="checkbox" checked={linkPrimary} onChange={(e) => setLinkPrimary(e.target.checked)} />{" "}
              Основной контакт
            </label>
            <label>
              <input type="checkbox" checked={linkLpr} onChange={(e) => setLinkLpr(e.target.checked)} /> ЛПР
            </label>
            <label>
              <input type="checkbox" checked={linkBilling} onChange={(e) => setLinkBilling(e.target.checked)} />{" "}
              Финансовый контакт
            </label>
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
                      setError(err instanceof Error ? err.message : "Ошибка");
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
              Или создать компанию
              <input
                value={newCompanyName}
                onChange={(e) => setNewCompanyName(e.target.value)}
                placeholder={client.companyName || "Название"}
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
                  setError(err instanceof Error ? err.message : "Ошибка");
                } finally {
                  setLinkBusy(false);
                }
              }}
            >
              + Создать компанию и связать
            </button>
            <button type="button" className="btn secondary" onClick={() => setCompanyLinkOpen(false)}>
              Закрыть
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
