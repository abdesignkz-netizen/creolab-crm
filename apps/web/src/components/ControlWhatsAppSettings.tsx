import { useEffect, useState } from "react";
import { CONTROL_ACTION_META, type ControlAction, type ControlChatSettings } from "@creolab/contracts";
import { api } from "../lib/api";
import { InlineFeedback } from "./InlineFeedback";
import { notifySaved } from "./SaveNotice";
import "./ControlWhatsAppSettings.css";

type Sender = { id: string; name: string; phone: string; ready: boolean; type: string };
type Identity = { id: string; provider: string; phoneNormalized: string; enabled: boolean; verified: boolean; chat: ControlChatSettings | null };
type Member = { userId: string; name: string; email: string; enabled: boolean; canReadFinancialData: boolean; canReadTeamData: boolean; canCreateTasks: boolean; canModifyDeals: boolean; canPerformBulkActions: boolean; identities: Identity[] };
type Settings = { enabled: boolean; timezone: string; senders: Sender[]; users: Member[]; deliveries: Array<{ id: string; identityId: string; state: string; kind: string; error: string | null; createdAt: string }> };
const states: Record<string, string> = { queued: "В очереди", processing: "Обработка", ready: "Готов к отправке", sending: "Отправляется", accepted: "Принято WhatsApp", failed: "Не выполнено", uncertain: "Доставка не подтверждена", skipped: "Пропущено", merged: "Объединено со сводкой" };
const displayPhone = (phone: string) => phone ? `+${phone.replace(/\D/g, "")}` : "Номер не указан";
const defaultPrefs = (integrationId: string): ControlChatSettings => ({ integrationId, enabled: true, language: "ru", morningEnabled: false, morningTime: "09:00", eveningEnabled: false, eveningTime: "18:00", weekdaysOnly: true });

function ChannelForm({ identity, data, accessEnabled, busy, run, onDirty }: { identity: Identity; data: Settings; accessEnabled: boolean; busy: boolean; run: (task: () => Promise<unknown>) => Promise<void>; onDirty: (dirty: boolean) => void }) {
  const initial = identity.chat || defaultPrefs(data.senders.find(s => s.ready)?.id || data.senders[0]?.id || "");
  const [prefs, setPrefs] = useState(initial);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(prefs) !== JSON.stringify(initial);
  useEffect(() => { onDirty(dirty); return () => onDirty(false); }, [dirty]);
  const sender = data.senders.find(s => s.id === prefs.integrationId);
  const savedSender = data.senders.find(s => s.id === identity.chat?.integrationId);
  const ready = Boolean(data.enabled && accessEnabled && identity.enabled && identity.verified && identity.chat?.enabled && savedSender?.ready);
  const status = !identity.enabled ? "Номер отключён" : !identity.verified ? "Ожидает подтверждения" : !data.enabled ? "Control выключен" : !accessEnabled ? "Доступ выключен" : !identity.chat?.enabled ? "Команды выключены" : !savedSender?.ready ? "WhatsApp не подключён" : "Готов к работе";
  const patch = (p: Partial<ControlChatSettings>) => setPrefs(v => ({ ...v, ...p }));
  return <form className="control-wa-channel" onSubmit={event => {
    event.preventDefault(); setSaving(true);
    void run(() => api.updateControlChat(identity.id, prefs)).finally(() => setSaving(false));
  }}>
    <div className="control-wa-heading"><div><strong>{displayPhone(identity.phoneNormalized)}</strong><p className="muted">{!identity.enabled ? "Номер отключён" : identity.verified ? "Номер подтверждён" : "Подтвердите номер сообщением в WhatsApp"}</p></div>
      <span className={`control-wa-status ${ready ? "ready" : ""}`}>{status}</span></div>
    {!identity.enabled && <p className="muted">Чтобы снова подключить этот номер, получите новый код ниже и подтвердите его в WhatsApp.</p>}
    <div className="control-wa-grid">
      <label>WhatsApp компании<select aria-label="WhatsApp компании для команд" value={prefs.integrationId} onChange={e => patch({ integrationId: e.target.value, morningEnabled: false, eveningEnabled: false })}>
        <option value="">Выберите подключение</option>{data.senders.map(s => <option key={s.id} value={s.id}>{s.name} {s.phone} {!s.ready ? "· отключён" : ""}</option>)}
      </select></label>
      <label>Язык ответов<select value={prefs.language} onChange={e => patch({ language: e.target.value as "ru" | "kk" })}><option value="ru">Русский</option><option value="kk">Қазақша</option></select></label>
    </div>
    <label className="control-wa-check"><input type="checkbox" checked={prefs.enabled} onChange={e => patch({ enabled: e.target.checked })} />Принимать команды с этого личного номера</label>
    <details className="control-wa-schedule"><summary>Плановые сводки {prefs.morningEnabled || prefs.eveningEnabled ? "· включены" : "· выключены"}</summary>
      <p className="muted">Время компании: {data.timezone}. Сводки приходят автоматически, без запроса. Накопившиеся части сводки объединяются в одно сообщение.</p>
      {sender?.type !== "whatsapp_qr" ? <p className="muted">Для плановых сводок выберите WhatsApp QR. Cloud API поддерживает ответы на запросы; для автоматических сообщений нужны шаблоны Meta.</p> : <>
        <div className="control-wa-grid"><div className="control-wa-slot"><label className="control-wa-check"><input type="checkbox" checked={prefs.morningEnabled} onChange={e => patch({ morningEnabled: e.target.checked })} />Утро: задачи и внимание</label><input type="time" aria-label="Время утренней сводки" value={prefs.morningTime} onChange={e => patch({ morningTime: e.target.value })} disabled={!prefs.morningEnabled} /></div>
          <div className="control-wa-slot"><label className="control-wa-check"><input type="checkbox" checked={prefs.eveningEnabled} onChange={e => patch({ eveningEnabled: e.target.checked })} />Вечер: итоги и внимание</label><input type="time" aria-label="Время вечерней сводки" value={prefs.eveningTime} onChange={e => patch({ eveningTime: e.target.value })} disabled={!prefs.eveningEnabled} /></div></div>
        <label className="control-wa-check"><input type="checkbox" checked={prefs.weekdaysOnly} onChange={e => patch({ weekdaysOnly: e.target.checked })} />Только по будням</label>
      </>}
    </details>
    <div className="actions"><button className="btn" disabled={busy || saving || !identity.enabled || !prefs.integrationId || !dirty && Boolean(identity.chat)}>{saving ? "Сохраняем…" : "Сохранить настройки"}</button>
      {ready && savedSender?.phone && <a className="btn secondary" href={`https://wa.me/${savedSender.phone.replace(/\D/g, "")}?text=${encodeURIComponent(identity.chat?.language === "kk" ? "Мәзір" : "Меню")}`} target="_blank" rel="noreferrer">Открыть Control в WhatsApp</a>}
      {identity.enabled && <button className="btn secondary" type="button" disabled={busy || saving} onClick={() => { void run(() => api.disableControlIdentity(identity.id)); }}>Отключить номер</button>}
    </div>
  </form>;
}

export function ControlWhatsAppSettings({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const [data, setData] = useState<Settings | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [phone, setPhone] = useState<Record<string, string>>({});
  const [senderIds, setSenderIds] = useState<Record<string, string>>({});
  const [codes, setCodes] = useState<Record<string, { code: string; senderId: string }>>({});
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  useEffect(() => { onDirtyChange(Object.values(dirty).some(Boolean)); }, [dirty]);
  useEffect(() => () => onDirtyChange(false), []);
  async function load() {
    const [settings, log] = await Promise.all([api.controlSettings(), api.controlHistory({ limit: 20 })]);
    setData(settings as Settings); setHistory((log as any).items || []);
  }
  useEffect(() => { void load().catch(e => setError(e.message)); }, []);
  async function run(task: () => Promise<unknown>) {
    if (busy) return; setBusy(true); setError("");
    try { await task(); await load(); notifySaved("Настройки BasQar Control сохранены"); }
    catch (e) { setError(e instanceof Error ? e.message : "Не удалось сохранить настройки"); }
    finally { setBusy(false); }
  }
  async function link(user: Member) {
    const senderId = senderIds[user.userId] || data?.senders.find(s => s.ready)?.id || "";
    if (!senderId || !phone[user.userId]) { setError("Выберите WhatsApp компании и укажите личный номер сотрудника"); return; }
    await run(async () => {
      const result = await api.createControlIdentity({ userId: user.userId, provider: "WHATSAPP", phone: phone[user.userId] }) as { identity: { id: string }; verificationCode: string };
      const existing = user.identities.find(item => item.id === result.identity.id)?.chat;
      await api.updateControlChat(result.identity.id, existing && existing.integrationId === senderId ? { ...existing, enabled: true } : defaultPrefs(senderId));
      setCodes(v => ({ ...v, [result.identity.id]: { code: result.verificationCode, senderId } }));
    });
  }
  if (!data) return <div className="panel">{error ? <InlineFeedback kind="error">{error}</InlineFeedback> : "Загружаем BasQar Control…"}</div>;
  return <div className="control-wa-settings">
    <section className="panel control-wa-intro"><div className="control-wa-heading"><div><span className="control-wa-eyebrow">BASQAR CONTROL</span><h2>Управляйте компанией из WhatsApp</h2><p className="muted">Пишите с личного номера на WhatsApp компании: узнавайте результаты, находите клиентов и ставьте задачи.</p></div>
      <button className={`btn ${data.enabled ? "secondary" : ""}`} disabled={busy} onClick={() => { void run(() => api.updateControlSettings({ enabled: !data.enabled })); }}>{data.enabled ? "Выключить Control" : "Включить Control"}</button></div>
      <div className="control-wa-steps"><div><b>1. Доступ</b><span>Выберите сотрудника и разрешения</span></div><div><b>2. Личный номер</b><span>Подтвердите его кодом в WhatsApp</span></div><div><b>3. Запрос или меню</b><span>Напишите «Меню» на номер компании</span></div></div>
      {!data.enabled && <p className="control-wa-hint">Control выключен для компании. Настройки можно подготовить заранее.</p>}
      {!data.senders.some(s => s.ready) && <p className="control-wa-hint">Сначала <a href="/integrations">подключите WhatsApp компании</a> через QR или Cloud API.</p>}
      <p className="muted">Сведения доступны в пределах прав сотрудника. Любое изменение из WhatsApp требует отдельного подтверждения. Сообщения сотрудника не попадают в клиентские диалоги.</p>
    </section>
    {error && <InlineFeedback kind="error">{error}</InlineFeedback>}
    {data.users.map(user => <section className="panel" key={user.userId}>
      <div className="control-wa-heading"><div><h3>{user.name}</h3><p className="muted">{user.email}</p></div><button className="btn secondary" disabled={busy} onClick={() => { void run(() => api.upsertControlAccess(user.userId, { enabled: !user.enabled })); }}>{user.enabled ? "Отключить доступ" : "Разрешить доступ"}</button></div>
      <fieldset className="control-wa-permissions" disabled={busy}><legend>Что разрешено сотруднику</legend>{([
        ["canReadFinancialData", "Финансы"], ["canReadTeamData", "Данные команды"], ["canCreateTasks", "Изменение задач"], ["canModifyDeals", "Изменение сделок"],
      ] as const).map(([key,label]) => <label key={key}><input type="checkbox" checked={user[key]} onChange={e => { void run(() => api.upsertControlAccess(user.userId, { [key]: e.target.checked })); }} />{label}</label>)}</fieldset>
      {user.identities.filter(identity => identity.provider === "WHATSAPP").map(identity => <div key={identity.id}>
        {codes[identity.id] && !identity.verified && identity.enabled && <div className="control-wa-activation"><b>Подтвердите личный номер</b><p>С указанного личного номера отправьте на WhatsApp компании:</p><code>Control {codes[identity.id].code}</code><p className="muted">Код действует 30 минут. После ответа в WhatsApp нажмите «Обновить статус».</p><div className="actions">
          {data.senders.find(s => s.id === codes[identity.id].senderId)?.phone && <a className="btn" target="_blank" rel="noreferrer" href={`https://wa.me/${data.senders.find(s => s.id === codes[identity.id].senderId)!.phone.replace(/\D/g, "")}?text=${encodeURIComponent(`Control ${codes[identity.id].code}`)}`}>Открыть WhatsApp</a>}
          <button className="btn secondary" disabled={busy} onClick={() => { void run(load); }}>Обновить статус</button></div></div>}
        <ChannelForm key={`${identity.id}:${JSON.stringify(identity.chat)}`} identity={identity} data={data} accessEnabled={user.enabled} busy={busy} run={run} onDirty={value => setDirty(prev => prev[identity.id] === value ? prev : { ...prev, [identity.id]: value })} />
      </div>)}
      <details open={!user.identities.some(identity => identity.provider === "WHATSAPP")} className="control-wa-add"><summary>Подключить личный номер / получить новый код</summary><form className="control-wa-grid" onSubmit={e => { e.preventDefault(); void link(user); }}>
        <label>WhatsApp компании<select value={senderIds[user.userId] || data.senders.find(s => s.ready)?.id || ""} onChange={e => setSenderIds(v => ({ ...v, [user.userId]: e.target.value }))}><option value="">Выберите подключение</option>{data.senders.map(s => <option key={s.id} value={s.id} disabled={!s.ready}>{s.name} {s.phone} {!s.ready ? "· отключён" : ""}</option>)}</select></label>
        <label>Личный номер сотрудника<input type="tel" autoComplete="off" placeholder="+7…" value={phone[user.userId] || ""} onChange={e => setPhone(v => ({ ...v, [user.userId]: e.target.value }))} required /></label>
        <button className="btn secondary" disabled={busy || !data.enabled || !user.enabled || !data.senders.some(s => s.ready)}>Получить код</button>
        {(!data.enabled || !user.enabled) && <p className="muted">Сначала включите Control для компании и разрешите доступ сотруднику.</p>}
      </form></details>
    </section>)}
    <section className="panel"><h3>Что можно написать</h3><div className="control-wa-examples">{["Меню", "Задачи на сегодня", "Найди клиента Айбек", "Создай задачу подготовить КП завтра к 15:00", "Что требует внимания", "Продажи за неделю"].map(text => <span key={text}>{text}</span>)}</div><p className="muted">В меню WhatsApp отвечайте номером пункта. Если найдено несколько клиентов, Control попросит выбрать запись. Удаление, рассылки и массовые изменения выполняются в кабинете.</p></section>
    <details className="panel"><summary>История команд и доставки</summary><p className="muted">«Принято WhatsApp» означает, что сервис принял сообщение. Это не подтверждение прочтения. При неопределённой доставке повторной отправки нет.</p>
      {data.deliveries.map(item => <div key={item.id} className="control-wa-log"><span>{new Date(item.createdAt).toLocaleString("ru-RU", { timeZone: data.timezone })}</span><b>{item.kind === "briefing" ? "Плановая сводка" : "Запрос из WhatsApp"}</b><span>{states[item.state] || "Обрабатывается"}</span></div>)}
      {history.map(item => <div key={item.id} className="control-wa-log"><span>{new Date(item.createdAt).toLocaleString("ru-RU", { timeZone: data.timezone })}</span><b>{item.actor?.name || "Сотрудник"}</b><span>{CONTROL_ACTION_META[item.action as ControlAction]?.label || "Настройки Control"} · {item.status ? ({ OK: "Выполнено", CONFIRMATION_REQUIRED: "Ожидает подтверждения" } as Record<string,string>)[item.status] || "Не выполнено" : "Сохранено"}</span></div>)}
      {!history.length && !data.deliveries.length && <p className="muted">Здесь появятся запросы сотрудников и результаты доставки.</p>}
    </details>
  </div>;
}
