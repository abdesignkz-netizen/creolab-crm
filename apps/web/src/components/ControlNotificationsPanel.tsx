import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { CONTROL_NOTICE_CATEGORIES, CONTROL_NOTICE_CATEGORIES_KK, CONTROL_NOTICE_DEFAULTS, type ControlNoticeCategory, type ControlNoticeMode } from "@creolab/contracts";
import { api } from "../lib/api";
import { useUiText } from "../lib/uiText";
import { useSession } from "../lib/session";
import { formatDateTime } from "../lib/datetime";
import { InlineFeedback } from "./InlineFeedback";

type Draft = Omit<typeof CONTROL_NOTICE_DEFAULTS, "events"> & { membershipId: string; integrationId: string; phone: string; events: Record<ControlNoticeCategory, ControlNoticeMode> };
type History = { id: string; kind: string; state: string; error: string | null; createdAt: string };
type Rule = Draft & { id: string; history: History[] };
type Data = { available: boolean; members: Array<{ id: string; name: string; role: string }>; senders: Array<{ id: string; name: string; phone: string; supported: boolean; ready: boolean; note: string | null }>; rules: Rule[] };
const stateLabels: Record<string, string> = { queued: "В очереди", sending: "Отправляем", accepted: "Принято WhatsApp", failed: "Не отправлено", uncertain: "Результат неизвестен", skipped: "Отменено" };
const errorLabels: Record<string, string> = { send_interval: "Ждём выбранного интервала отправки", quiet_hours: "Ждём окончания тихих часов", sender_offline: "Ждём подключения WhatsApp", disabled: "Уведомления отключены или доступ закрыт", settings_changed: "Настройки изменились", sender_unavailable: "Проверьте подключение отправителя", expired: "Истёк срок ожидания", rate_limit: "WhatsApp ограничил частоту. Повторим позже", provider_rejected: "WhatsApp отклонил отправку. Проверьте подключение", delivery_unknown: "WhatsApp не подтвердил результат. Проверьте чат перед повтором" };
function draftFrom(data: Data, membershipId: string): Draft {
  const rule = data.rules.find(row => row.membershipId === membershipId);
  if (rule) { const { id, history, ...draft } = rule; return structuredClone(draft); }
  return { ...structuredClone(CONTROL_NOTICE_DEFAULTS), membershipId, integrationId: data.senders.find(sender => sender.supported && sender.ready)?.id || "", phone: "" };
}

export function ControlNoticeDiscardDialog({ onStay, onDiscard }: { onStay: () => void; onDiscard: () => void }) {
  const text = useUiText(), dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="control-notices-discard-dialog" aria-labelledby="control-notices-discard-title" onCancel={event => { event.preventDefault(); onStay(); }}>
    <h3 id="control-notices-discard-title">{text("Есть несохранённые изменения")}</h3>
    <p>{text("Если продолжить, изменения настроек уведомлений будут потеряны.")}</p>
    <div className="control-notices-actions"><button type="button" className="btn" autoFocus onClick={onStay}>{text("Продолжить настройку")}</button><button type="button" className="btn secondary" onClick={onDiscard}>{text("Не сохранять и продолжить")}</button></div>
  </dialog>;
}

export function ControlNotificationsPanel({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const text = useUiText(); const { me } = useSession();
  const [data, setData] = useState<Data | null>(null), [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [confirmTest, setConfirmTest] = useState(false);
  const [nextRecipient, setNextRecipient] = useState<string | null>(null);
  const version = useRef(0), working = useRef(false);
  const load = useCallback(async () => {
    const current = ++version.current; const next = await api.controlNotifications() as Data;
    if (current !== version.current) return;
    setData(next); setDraft(old => old || (next.members.length ? draftFrom(next, next.members[0].id) : null));
  }, []);
  useEffect(() => {
    void load().catch(err => setError(err.message));
    const timer = setInterval(() => { if (!working.current && document.visibilityState === "visible") void load().catch(() => undefined); }, 10000);
    return () => { version.current++; clearInterval(timer); };
  }, [load]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  const rule = data?.rules.find(row => row.membershipId === draft?.membershipId);
  const sender = data?.senders.find(row => row.id === draft?.integrationId);
  const changedElsewhere = Boolean(rule && draft && rule.version !== draft.version);
  function change(patch: Partial<Draft>) { setDraft(old => old && { ...old, ...patch }); setDirty(true); setNotice(""); setError(""); setConfirmTest(false); }
  async function act(action: () => Promise<void>) {
    if (working.current) return;
    working.current = true; version.current++; setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (err) { setError(err instanceof Error ? err.message : text("Не удалось сохранить настройки")); }
    finally { working.current = false; setBusy(false); }
  }
  async function refreshDraft() {
    const next = await api.controlNotifications() as Data; setData(next);
    if (draft) setDraft(draftFrom(next, draft.membershipId)); setDirty(false); setConfirmTest(false);
  }
  function selectRecipient(membershipId: string) {
    if (!data) return;
    setDraft(draftFrom(data, membershipId)); setDirty(false); setError(""); setNotice(""); setConfirmTest(false); setNextRecipient(null);
  }
  const modeNames = { off: text("Не отправлять"), instant: text("Сразу"), digest: text("В ежедневной сводке") };
  const hasDigest = draft && Object.values(draft.events).includes("digest");
  const validationMessage = !draft ? "" : !draft.phone.trim() ? "Укажите WhatsApp получателя"
    : !sender?.supported ? "Выберите WhatsApp, подключённый через QR или Green API."
    : !draft.recipientConfirmed ? "Подтвердите согласие сотрудника на уведомления"
    : draft.quietHours.enabled && draft.quietHours.start === draft.quietHours.end ? "Начало и конец тихих часов должны отличаться"
    : draft.enabled && Object.values(draft.events).every(mode => mode === "off") ? "Выберите хотя бы одно событие."
    : draft.enabled && !sender.ready ? "Восстановите подключение WhatsApp перед включением уведомлений." : "";
  const previewLabels = draft?.language === "kk" ? CONTROL_NOTICE_CATEGORIES_KK : CONTROL_NOTICE_CATEGORIES;
  const previewLines = draft ? Object.keys(CONTROL_NOTICE_CATEGORIES).filter(category => draft.events[category as ControlNoticeCategory] !== "off").map(category => `${previewLabels[category as ControlNoticeCategory]}: 2`) : [];
  return <section className="panel control-notices" aria-label={text("Уведомления руководителю")}>
    <div className="control-notices-heading"><div><span className="control-notices-kicker">WhatsApp · BasQar Control</span><h3>{text("Уведомления руководителю")}</h3><p className="muted">{text("Получайте важные события компании и ежедневную сводку прямо в WhatsApp.")}</p></div>
      <div className="control-notices-status"><span className={`badge ${rule?.enabled ? "ok" : ""}`}>{text(rule?.enabled ? "Включены" : "Выключены")}</span>
        {rule?.enabled && <button type="button" className="btn secondary" disabled={busy} onClick={() => void act(async () => { await api.pauseControlNotifications(rule.id); await refreshDraft(); setNotice("Автоматические уведомления остановлены"); })}>{text("Остановить уведомления")}</button>}
      </div></div>
    {error && <InlineFeedback kind="error">{text(error)}</InlineFeedback>}
    {notice && <InlineFeedback kind="success">{text(notice)}</InlineFeedback>}
    {nextRecipient && <ControlNoticeDiscardDialog onStay={() => setNextRecipient(null)} onDiscard={() => selectRecipient(nextRecipient)} />}
    {!data ? error ? <button className="btn secondary" disabled={busy} onClick={() => void act(load)}>{text("Повторить")}</button> : <p>{text("Загрузка…")}</p> : !draft ? <p>{text("Нет доступных получателей")}</p> : <>
      {!data.available && <InlineFeedback kind="info">{text("Для включения уведомлений нужен BasQar Control в тарифе.")}</InlineFeedback>}
      {changedElsewhere && <InlineFeedback kind="info">{text("Настройки изменились в другой вкладке. Обновите страницу.")} <button className="btn secondary" disabled={busy} onClick={() => void act(refreshDraft)}>{text("Загрузить сохранённые настройки")}</button></InlineFeedback>}
      <form onSubmit={event => { event.preventDefault(); void act(async () => {
        if (validationMessage) { setError(text(validationMessage)); return; }
        await api.saveControlNotifications(draft); await refreshDraft(); setNotice("Настройки уведомлений сохранены");
      }); }}>
        <fieldset disabled={busy}>
          <legend>1. {text("Кому и откуда отправлять")}</legend>
          <div className="control-notices-grid">
            <label>{text("Получатель")}<select value={draft.membershipId} onChange={event => {
              if (dirty) setNextRecipient(event.target.value); else selectRecipient(event.target.value);
            }}>{data.members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
            <label>{text("WhatsApp получателя")}<input required type="tel" placeholder="+7 700 000 00 00" value={draft.phone} onChange={event => change({ phone: event.target.value, recipientConfirmed: false })} /></label>
            <label>{text("Отправлять с номера компании")}<select required value={draft.integrationId} onChange={event => change({ integrationId: event.target.value })}>
              <option value="">{text("Выберите подключение WhatsApp")}</option>
              {data.senders.map(item => <option key={item.id} value={item.id} disabled={!item.supported}>{item.name}{item.phone ? ` · +${item.phone}` : ""}{!item.ready ? ` · ${text("Недоступно")}` : ""}</option>)}
            </select></label>
            <label>{text("Язык сообщений")}<select value={draft.language} onChange={event => change({ language: event.target.value })}><option value="ru">Русский</option><option value="kk">Қазақша</option></select></label>
          </div>
          <p className="muted">{text("Номер получателя должен отличаться от номера отправителя.")} <Link to="/integrations#integration-whatsapp">{text("Настроить WhatsApp")}</Link></p>
          {sender?.note && <InlineFeedback kind="info">{text(sender.note)}</InlineFeedback>}
          {!data.senders.some(item => item.supported) && <InlineFeedback kind="info">{text("Подключите WhatsApp через QR или Green API в разделе «Интеграции».")}</InlineFeedback>}
          <label className="control-notices-check"><input type="checkbox" required checked={draft.recipientConfirmed} onChange={event => change({ recipientConfirmed: event.target.checked })} /><span>{text("Подтверждаю: это WhatsApp выбранного сотрудника, он согласен получать рабочие уведомления.")}</span></label>
        </fieldset>
        <fieldset disabled={busy}>
          <legend>2. {text("Какие события получать")}</legend>
          <p className="muted">{text("События по всей компании. Переписка и телефоны клиентов в уведомления не включаются.")}</p>
          <p className="muted">{text("«Сразу» — с выбранной частотой отправки. «В ежедневной сводке» — один раз в день.")}</p>
          <div className="control-notices-events">{Object.entries(CONTROL_NOTICE_CATEGORIES).map(([key, label]) => <label key={key}><span>{text(label)}</span><select aria-label={text(label)} value={draft.events[key as ControlNoticeCategory]} onChange={event => change({ events: { ...draft.events, [key]: event.target.value as ControlNoticeMode } })}>{Object.entries(modeNames).map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label>)}</div>
        </fieldset>
        <fieldset disabled={busy}>
          <legend>3. {text("Когда отправлять")}</legend>
          <div className="control-notices-grid">
            <label>{text("Частота отправки")}<select value={draft.minIntervalMinutes} onChange={event => change({ minIntervalMinutes: Number(event.target.value) })}>
              <option value={0}>{text("Без задержки; очередь — одним сообщением")}</option><option value={5}>{text("Не чаще раза в 5 минут")}</option><option value={15}>{text("Не чаще раза в 15 минут")}</option><option value={60}>{text("Не чаще раза в час")}</option>
            </select></label>
            {hasDigest && <label>{text("Время ежедневной сводки")}<input type="time" required value={draft.digestTime} onChange={event => change({ digestTime: event.target.value })} /></label>}
            <label>{text("Часовой пояс")}<select value={draft.timezone} onChange={event => change({ timezone: event.target.value })}>{Array.from(new Set([draft.timezone, "Asia/Almaty", "Asia/Aqtau", "Asia/Aqtobe", "Asia/Oral", "Europe/Moscow", "UTC"])).map(zone => <option key={zone} value={zone}>{zone}</option>)}</select></label>
          </div>
          <p className="muted">{text("Накопившиеся уведомления придут одной сводкой, даже после перерыва в подключении. Пустая сводка не отправляется.")}</p>
          {hasDigest && <p className="muted">{text("Сводка может прийти позже указанного времени из-за тихих часов или интервала отправки.")}</p>}
          <label className="control-notices-check"><input type="checkbox" checked={draft.quietHours.enabled} onChange={event => change({ quietHours: { ...draft.quietHours, enabled: event.target.checked } })} /><span>{text("Не беспокоить в тихие часы")}</span></label>
          {draft.quietHours.enabled && <><div className="control-notices-grid"><label>{text("С")}<input type="time" required value={draft.quietHours.start} onChange={event => change({ quietHours: { ...draft.quietHours, start: event.target.value } })} /></label><label>{text("До")}<input type="time" required value={draft.quietHours.end} onChange={event => change({ quietHours: { ...draft.quietHours, end: event.target.value } })} /></label></div>
            {draft.quietHours.start === draft.quietHours.end && <p className="field-error" role="alert">{text("Начало и конец тихих часов должны отличаться")}</p>}
            <label className="control-notices-check"><input type="checkbox" checked={draft.urgentDuringQuiet} onChange={event => change({ urgentDuringQuiet: event.target.checked })} /><span>{text("Отправлять срочные события в тихие часы")}</span></label><p className="muted">{text("Только для событий, выбранных «Сразу». Например, когда ИИ передаёт диалог сотруднику.")}</p></>}
        </fieldset>
        <details className="control-notices-preview"><summary>{text("Пример сообщения")}</summary><p>BasQar Control · {me?.activeTenant?.tenant?.name || "BasQar"}</p><p>{[draft.language === "kk" ? "Жұмыс оқиғалары" : "Рабочие события", ...previewLines, draft.language === "kk" ? "Кабинетті ашу: bsqr.kz/today" : "Открыть кабинет: bsqr.kz/today"].join("\n")}</p><small>{text("Пример. Реальное сообщение содержит только выбранные события.")}</small></details>
        <label className="control-notices-check"><input type="checkbox" checked={draft.enabled} disabled={busy || !data.available} onChange={event => change({ enabled: event.target.checked })} /><b>{text("Автоматически отправлять новые события")}</b></label>
        <p className="muted">{text("Работает при закрытом кабинете, пока подключён WhatsApp. Доступ к командам Control настраивается отдельно.")}</p>
        <p className="muted">{text("При сохранении ожидающие отправки по прежним настройкам отменяются. Уже начатую отправку отменить нельзя.")}</p>
        <div className={`control-notices-savebar ${dirty ? "is-dirty" : ""}`}>
          <span className={validationMessage && dirty ? "field-error" : "muted"} role="status">{text(validationMessage || (dirty ? "Есть несохранённые изменения" : rule ? "Все изменения сохранены" : "Заполните настройки и сохраните"))}</span>
          <div className="control-notices-actions">
            {dirty && <button className="btn secondary" type="button" disabled={busy} onClick={() => { setDraft(draftFrom(data, draft.membershipId)); setDirty(false); setError(""); setNotice(""); setConfirmTest(false); }}>{text("Сбросить изменения")}</button>}
            <button className="btn" type="submit" disabled={busy || changedElsewhere || Boolean(rule && !dirty) || Boolean(validationMessage)}>{text(busy ? "Подождите…" : "Сохранить настройки")}</button>
          </div>
        </div>
      </form>
      {rule && <div className="control-notices-history"><h4>{text("Проверка и история отправок")}</h4>
        <button className="btn secondary" disabled={busy || dirty || changedElsewhere || !sender?.ready || !data.available} onClick={() => setConfirmTest(true)}>{text("Проверить отправку")}</button>
        {dirty && <p className="muted">{text("Перед проверкой сохраните настройки.")}</p>}
        {confirmTest && <div className="control-notices-preview" role="group" aria-label={text("Подтверждение тестовой отправки")}><p>{text("Отправить проверочное сообщение на номер")} <b>{rule.phone}</b>?</p><p className="muted">{text("Тихие часы учитываются и для проверки.")}</p><div className="control-notices-actions"><button className="btn" disabled={busy} onClick={() => void act(async () => { await api.testControlNotifications(rule.id); setConfirmTest(false); await load(); setNotice("Проверочное сообщение поставлено в очередь. Результат появится ниже."); })}>{text("Отправить проверочное сообщение")}</button><button className="btn secondary" disabled={busy} onClick={() => setConfirmTest(false)}>{text("Отмена")}</button></div></div>}
        <p className="muted">{text("«Принято WhatsApp» означает, что сервис принял сообщение. Прочтение получателем не подтверждено.")}</p>
        {rule.history.length ? <ul>{rule.history.map(item => <li key={item.id}><div><b>{text(item.kind === "test" ? "Проверочное сообщение" : item.kind === "digest" ? "Ежедневная сводка" : item.kind === "summary" ? "Сводка накопившихся событий" : "События компании")}</b><small>{formatDateTime(item.createdAt, { timeZone: draft.timezone })}</small>{item.error && <p>{text(errorLabels[item.error] || "Проверьте подключение")}</p>}</div><span className={`badge ${item.state === "accepted" ? "ok" : ""}`}>{text(stateLabels[item.state] || item.state)}</span></li>)}</ul> : <p className="muted">{text("Отправок пока нет")}</p>}
      </div>}
    </>}
  </section>;
}
