import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import type { WebsiteFormInput, WebsiteFormItem, WebsiteFormsState } from "@creolab/contracts";
import { useCompanyConfiguration } from "../lib/companyConfiguration";
import { useUiText, uiFormatLocale } from "../lib/uiText";
import { InlineFeedback } from "../components/InlineFeedback";
import { websiteFormSnippet } from "../lib/websiteFormSnippet";
import "./WebsiteFormsPanel.css";
import { useLocale } from "../lib/session";
import { websiteFormKk } from "../lib/websiteFormLocale";

export default function WebsiteFormsPanel({ onChange }: { onChange: () => void }) {
  const { api } = useCompanyConfiguration(), baseText = useUiText(), locale = useLocale();
  const t = (source: string) => locale === "kk" && websiteFormKk[source] ? websiteFormKk[source] : baseText(source);
  const [data, setData] = useState<WebsiteFormsState | null>(null), [selected, setSelected] = useState("");
  const [editing, setEditing] = useState(false), [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState(""), [sites, setSites] = useState(""), [assignee, setAssignee] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [note, setNote] = useState("");
  const [method, setMethod] = useState("html");
  const requestId = useRef(crypto.randomUUID()), revision = useRef(0), saving = useRef(false);
  const item = data?.items.find(row => row.id === selected) || data?.items[0];
  async function load() {
    const version = ++revision.current;
    const result = await api.websiteForms() as WebsiteFormsState;
    if (version === revision.current) setData(result);
    return result;
  }
  function edit(row?: WebsiteFormItem) {
    setEditingId(row?.id || null); setName(row?.name || t("Форма сайта"));
    setSites(row?.allowedDomains.join("\n") || ""); setAssignee(row?.assigneeMembershipId || "");
    requestId.current = crypto.randomUUID(); setError(""); setNote(""); setEditing(true);
  }
  useEffect(() => {
    let active = true;
    void load().then(result => { if (active && !result.items.length) edit(); }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; revision.current++; };
  }, [api]);
  async function save(event: FormEvent) {
    event.preventDefault(); if (saving.current) return;
    saving.current = true; setBusy(true); setError(""); setNote("");
    const input: WebsiteFormInput = { name, allowedDomains: sites.split(/[\s,;]+/).filter(Boolean), assigneeMembershipId: assignee || null };
    try {
      const result = (editingId ? await api.updateWebsiteForm(editingId, input) : await api.createWebsiteForm({ ...input, requestId: requestId.current })) as { id: string };
      setSelected(result.id); setEditing(false);
      setNote(t(editingId ? "Настройки формы сохранены. Адрес для заявок не изменился." : "Форма создана. Теперь установите код на сайт."));
      await load(); onChange();
    } catch (err) { setError(err instanceof Error ? err.message : t("Не удалось сохранить")); }
    finally { saving.current = false; setBusy(false); }
  }
  async function check() {
    if (saving.current) return;
    saving.current = true;
    setBusy(true); setError(""); setNote("");
    try {
      const result = await load(), current = result.items.find(row => row.id === item?.id) || result.items[0];
      if (!current) { if (!editing) edit(); }
      else setNote(t(current.lastSubmission ? "Заявка получена. Откройте её и проверьте данные клиента." : "Заявок пока нет. Отправьте форму на своём сайте, затем повторите проверку."));
      onChange();
    } catch (err) { setError(err instanceof Error ? err.message : t("Не удалось проверить")); }
    finally { saving.current = false; setBusy(false); }
  }
  async function toggle() {
    if (!item || saving.current) return;
    saving.current = true; setBusy(true); setError(""); setNote("");
    try {
      await api.updateWebsiteForm(item.id, { enabled: !item.enabled });
      await load(); onChange();
      setNote(t(item.enabled ? "Приём заявок остановлен. Сохранённые заявки остались в BasQar." : "Приём заявок включён. Код на сайте менять не нужно."));
    } catch (err) { setError(err instanceof Error ? err.message : t("Не удалось сохранить")); }
    finally { saving.current = false; setBusy(false); }
  }
  async function copy(value: string) {
    setError(""); setNote("");
    try { await navigator.clipboard.writeText(value); setNote(t("Скопировано")); }
    catch { setError(t("Не удалось скопировать. Выделите и скопируйте код вручную.")); }
  }
  async function toggleTestMode() {
    if (!item || saving.current) return;
    saving.current = true; setBusy(true); setError(""); setNote("");
    try {
      await api.setIntegrationTestMode(item.integrationId, !item.testMode);
      await load(); onChange();
      setNote(t(item.testMode ? "Заявки теперь обычные" : "Включён тестовый режим"));
    } catch (err) { setError(err instanceof Error ? err.message : t("Не удалось сменить режим")); }
    finally { saving.current = false; setBusy(false); }
  }
  if (!data) return <div className="website-forms"><p role="status">{t("Загрузка…")}</p>{error && <><InlineFeedback kind="error">{t(error)}</InlineFeedback><button className="btn secondary" onClick={() => void check()} disabled={busy}>{t("Повторить")}</button></>}</div>;
  const ready = Boolean(item?.enabled && item.lastSubmission && data.available);
  return <div className="website-forms">
    <header className="website-form-heading"><div><h3>{t("Заявки с сайта — в BasQar")}</h3><p className="muted">{t("Создайте форму, установите код на сайт и проверьте первую заявку. Помощь администратора BasQar не нужна.")}</p></div>
      {!editing && data.items.length > 0 && <button className="btn secondary" disabled={busy || !data.available} onClick={() => edit()}>{t("Добавить форму")}</button>}</header>
    {error && <div><InlineFeedback kind="error">{t(error)}</InlineFeedback><button className="btn secondary" disabled={busy} onClick={() => void check()}>{t("Обновить данные")}</button></div>}{note && <InlineFeedback kind="info">{note}</InlineFeedback>}
    {!data.available && <p className="website-form-warning" role="status">{t(data.unavailableReason === "plan" ? "Для приёма заявок с сайта нужен тариф с подключением каналов." : "Формы сайта отключены для этой компании. Обратитесь к администратору сервиса.")}{data.unavailableReason === "plan" && <> <Link to="/billing">{t("Посмотреть тарифы")}</Link></>}</p>}
    {!editing && data.items.length > 1 && <label>{t("Выберите форму")}<select value={item?.id || ""} disabled={busy} onChange={e => { setSelected(e.target.value); setError(""); setNote(""); }}>{data.items.map(row => <option key={row.id} value={row.id}>{row.name}{!row.enabled ? ` · ${t("Приостановлена")}` : ""}</option>)}</select></label>}
    <ol className="website-form-progress" aria-label={t("Шаги подключения формы")}>
      {[t("Создать форму"), t("Установить на сайт"), t("Получить заявку")].map((title, i) => <li key={title} className={item && !editing ? (i === 0 || ready ? "done" : "") : i === 0 ? "current" : ""}><span aria-hidden="true">{item && !editing && (i === 0 || ready) ? "✓" : i + 1}</span>{title}</li>)}
    </ol>
    {editing ? <form className="website-form-editor" onSubmit={save} onChange={() => { requestId.current = crypto.randomUUID(); }}>
      <h4>{t(editingId ? "Настройки формы" : "1. Создайте форму")}</h4>
      <fieldset disabled={busy || !data.available}>
        <label>{t("Название формы")}<input required maxLength={100} value={name} onChange={e => setName(e.target.value)} placeholder={t("Например: Консультация с главной страницы")} /></label>
        <label>{t("Сайт, на котором будет форма")}<textarea required rows={2} value={sites} onChange={e => setSites(e.target.value)} placeholder="company.kz" /><small>{t("Укажите домен без пути. Если сайтов несколько — каждый с новой строки. Адреса с www и поддомены учитываются автоматически.")}</small></label>
        <label>{t("Кто получит заявки")}<select value={assignee} onChange={e => setAssignee(e.target.value)}><option value="">{t("Владелец компании")}</option>{assignee && !data.members.some(m => m.id === assignee) && <option value={assignee} disabled>{t("Сотрудник недоступен — выберите другого")}</option>}{data.members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
        {!editingId && <p className="muted">{t("Сотрудник увидит контакты и вопрос в разделе «Заявки». ИИ не будет сам писать клиенту после создания формы.")}</p>}
      </fieldset>
      <div className="actions"><button className="btn" disabled={busy || !data.available}>{t(busy ? "Сохраняем…" : editingId ? "Сохранить изменения" : "Создать и получить код")}</button>{data.items.length > 0 && <button type="button" className="btn secondary" disabled={busy} onClick={() => setEditing(false)}>{t("Отмена")}</button>}</div>
    </form> : item && <>
      <div className="website-form-summary"><div><strong>{item.name}</strong><p>{item.allowedDomains.join(", ") || t("Все сайты")}</p><span className={`badge ${ready ? "ok" : "muted"}`}>{t(!item.enabled ? "Приём приостановлен" : ready ? "Заявки поступают" : "Ожидаем первую заявку")}</span></div>
        <div className="actions"><button className="btn secondary" disabled={busy || !data.available} onClick={() => edit(item)}>{t("Изменить настройки")}</button><button className="btn secondary" disabled={busy || (!item.enabled && !data.available)} onClick={() => void toggle()}>{t(item.enabled ? "Приостановить приём" : "Возобновить приём")}</button></div></div>
      <section className="website-form-install"><h4>{t("2. Установите форму на сайт")}</h4><p className="muted">{t("Выберите удобный способ. Если сайт ведёт специалист, передайте ему код или адрес для заявок.")}</p>
        <div className="actions" role="group" aria-label={t("Способ подключения")}>{[["html", "Готовая форма"], ["existing", "У меня уже есть форма"], ["builder", "Конструктор сайта"]].map(([key, label]) => <button key={key} type="button" aria-pressed={method === key} className={`btn ${method === key ? "" : "secondary"}`} onClick={() => setMethod(key)}>{t(label)}</button>)}</div>
        {method === "html" ? <><p>{t("Вставьте код в HTML-блок на нужной странице и опубликуйте сайт. Посетитель увидит поля имени, телефона и вопроса, а после отправки — подтверждение.")}</p><textarea className="website-form-code" aria-label={t("Код формы для сайта")} readOnly rows={7} value={websiteFormSnippet(item.submitUrl, t)} spellCheck={false} /><button className="btn secondary" onClick={() => void copy(websiteFormSnippet(item.submitUrl, t))}>{t("Скопировать код")}</button></> : <>
          <p>{t(method === "builder" ? "В настройках формы конструктора выберите отправку через Webhook и вставьте адрес ниже. Для Tilda: Настройки сайта → Формы → Webhook. Сохраните настройки и опубликуйте страницу." : "Укажите этот адрес в обработчике вашей формы. Поддерживаются POST с JSON и обычная отправка полей формы.")}</p>
          <label>{t("Адрес для заявок")}<input readOnly value={item.submitUrl} onFocus={e => e.target.select()} /></label><button className="btn secondary" onClick={() => void copy(item.submitUrl)}>{t("Скопировать адрес")}</button>
          <p>{t("Имена обязательных полей: name — имя, phone — телефон. Необязательные: message — вопрос, email, company, service. Поле website оставьте пустым: оно защищает от спама.")}</p>
          <p className="muted">{t("Для повторной отправки одной заявки используйте тот же X-Submission-Id. Для новой заявки создавайте новый идентификатор. Показывайте клиенту подтверждение только после успешного ответа сервера.")}</p>
        </>}
      </section>
      <section className="website-form-check"><h4>{t("3. Проверьте первую заявку")}</h4><p>{t("Откройте свой опубликованный сайт, заполните форму своим именем и телефоном и отправьте её. Затем нажмите кнопку ниже.")}</p>
        {item.testMode && <p className="website-form-warning">{t("У этой формы включён тестовый режим. Входящие заявки будут отмечены как тестовые.")}</p>}
        <div><button className="btn secondary" disabled={busy || !data.available} onClick={() => void toggleTestMode()}>{t(item.testMode ? "Сделать заявки обычными" : "Включить тестовый режим")}</button></div>
        {item.lastSubmission ? <p role="status">{t("Последняя заявка")}: {new Date(item.lastSubmission.receivedAt).toLocaleString(uiFormatLocale())}{item.lastSubmission.test ? ` · ${t("Тестовая")}` : ""}</p> : <p className="muted">{t("Заявок пока нет. Установка кода подтверждается только после поступления заявки.")}</p>}
        <div className="actions"><button className="btn" disabled={busy || !item.enabled || !data.available} onClick={() => void check()}>{t(busy ? "Проверяем…" : "Проверить поступление")}</button>{item.lastSubmission && <Link className="btn secondary" to={`/requests/${item.lastSubmission.id}`}>{t("Открыть заявку")}</Link>}<Link className="btn secondary" to="/start">{t("Вернуться к шагам запуска")}</Link></div>
      </section>
      <p className="muted">{t("Обработка заявок")}: {t(item.automationMode === "MANUAL" ? "Сотрудником" : "По сохранённым правилам автоматизации")}.</p>
    </>}
  </div>;
}
