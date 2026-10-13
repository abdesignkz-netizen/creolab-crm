import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useUiText, uiMessage } from "../lib/uiText";
import { InlineFeedback } from "./InlineFeedback";

type Status = {
  connected: boolean; botConfigured: boolean; enabled: boolean; connectionStatus: string;
  botUsername: string | null; expiresAt: string | null; note: string | null;
  lastDelivery: { state: string; error: string | null } | null;
};

export function EmployeeTelegramPanel({ onChange, showPreferencesLink = true }: { onChange?: () => void; showPreferencesLink?: boolean }) {
  const uiText = useUiText();
  const [status, setStatus] = useState<Status | null>(null);
  const [link, setLink] = useState<{ deepLink: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const version = useRef(0);
  const working = useRef(false);
  const callback = useRef(onChange);
  callback.current = onChange;
  const previous = useRef<string | null>(null);
  const load = useCallback(async () => {
    const current = ++version.current;
    const result = await api.employeeTelegramStatus() as Status;
    if (current !== version.current) return;
    setStatus(result);
    if (result.lastDelivery && !["created", "sending"].includes(result.lastDelivery.state)) setNote("");
    if (result.connected || result.connectionStatus !== "PENDING") setLink(null);
    const key = `${result.connectionStatus}:${result.enabled}`;
    if (previous.current && key !== previous.current) callback.current?.();
    previous.current = key;
  }, []);
  useEffect(() => {
    void load().catch(err => setError(err.message));
    const timer = window.setInterval(() => {
      if (!working.current && document.visibilityState === "visible") void load().catch(() => undefined);
    }, 5000);
    return () => { version.current++; window.clearInterval(timer); };
  }, [load]);

  async function act(action: () => Promise<unknown>) {
    working.current = true;
    setBusy(true); setError(""); setNote(""); version.current++;
    try { await action(); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : uiText("Ошибка загрузки")); }
    finally { working.current = false; setBusy(false); }
  }
  return <div className="panel">
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}><h3 style={{ margin: 0 }}>{uiText("Telegram сотрудника")}</h3>
      <span className={`badge ${status?.connected ? "ok" : "neutral"}`}>
        {status?.connected ? uiText("Подключено") : status?.connectionStatus === "PENDING" ? uiText("Ожидает подтверждения") : uiText("Не подключено")}
      </span>
    </div>
    <p className="muted">{uiText("Получайте личные уведомления о заявках, диалогах и задачах, даже когда BasQar закрыт. Бот компании для клиентов подключается отдельно.")}</p>
    {error && <InlineFeedback kind="error">{uiMessage(error)}</InlineFeedback>}
    {note && <InlineFeedback kind="info">{note}</InlineFeedback>}
    {!status ? <button className="btn secondary" disabled={busy} onClick={() => void act(load)}>{uiText("Обновить")}</button> : <>
      {!status.botConfigured ? <p role="status">{uiMessage(status.note)}</p> : !status.connected ? <>
        <ol>
          <li>{uiText("Создайте личную ссылку и откройте бота.")}</li>
          <li>{uiText("Нажмите «Запустить» в Telegram. Статус здесь обновится автоматически.")}</li>
        </ol>
        {link && <>
          <a className="btn" href={link.deepLink} target="_blank" rel="noreferrer">{uiText("Открыть бота")}</a>
          <p className="muted">{uiText("Ссылка действует 10 минут. Не передавайте её другим людям.")}</p>
        </>}
        {!link && status.connectionStatus === "PENDING" && <p>{uiText("Ожидаем нажатия «Запустить» в Telegram. Если ссылка потерялась, создайте новую.")}</p>}
        <button className={`btn ${link ? "secondary" : ""}`} disabled={busy} onClick={() => void act(async () => {
          setLink(await api.beginTelegram() as { deepLink: string; expiresAt: string });
        })}>{busy ? uiText("Подождите…") : status.connectionStatus === "PENDING" ? uiText("Создать новую ссылку") : uiText("Подключить Telegram")}</button>
        {status.connectionStatus === "PENDING" && <button className="btn secondary" disabled={busy} onClick={() => void act(async () => { await api.disconnectEmployeeTelegram(); setLink(null); })}>{uiText("Отменить подключение")}</button>}
      </> : <>
        <p>@{status.botUsername}</p>
        <label className="check-row"><input type="checkbox" checked={status.enabled} disabled={busy} onChange={event => {
          const enabled = event.currentTarget.checked;
          void act(async () => { await api.updateNotificationPreferences({ channels: { telegram: enabled } }); });
        }} />{uiText("Получать уведомления этой компании в Telegram")}</label>
        <div className="actions">
          <button className="btn secondary" disabled={busy || !status.enabled} onClick={() => void act(async () => {
            await api.testEmployeeTelegram(); setNote(uiText("Проверка поставлена в очередь. В тихие часы уведомление придёт позже."));
          })}>{uiText("Проверить доставку")}</button>
          <button className="btn secondary" disabled={busy} onClick={() => setConfirmDisconnect(true)}>{uiText("Отключить Telegram")}</button>
        </div>
        {confirmDisconnect && <div role="group" aria-label={uiText("Отключить Telegram")}>
          <p>{uiText("Отключить личные уведомления Telegram для вашего аккаунта во всех компаниях?")}</p>
          <div className="actions"><button className="btn secondary" disabled={busy} onClick={() => setConfirmDisconnect(false)}>{uiText("Оставить подключённым")}</button>
            <button className="btn" disabled={busy} onClick={() => void act(async () => { await api.disconnectEmployeeTelegram(); setConfirmDisconnect(false); })}>{uiText("Отключить")}</button></div>
        </div>}
      </>}
      {status.connected && status.lastDelivery && <p role="status" className="muted">{
        status.lastDelivery.state === "delivered" ? uiText("Последнее уведомление доставлено в Telegram.")
        : ["created", "sending"].includes(status.lastDelivery.state) ? uiText("Уведомление в очереди. Учитываются ваши тихие часы.")
        : status.lastDelivery.state === "uncertain" ? uiText("Telegram не подтвердил доставку. Проверьте чат с ботом; повторно это уведомление не отправляем.")
        : status.lastDelivery.state === "failed" ? uiText("Не удалось доставить уведомление. Проверьте, что бот не заблокирован, и повторите проверку.")
        : uiText("Уведомление пропущено: оно уже прочитано или настройки доставки изменились.")
      }</p>}
      <p className="muted">{uiText("Категории и тихие часы общие для личных уведомлений. В Telegram не передаётся текст переписки с клиентом.")}</p>
      {showPreferencesLink && <Link to="/settings?section=notifications">{uiText("Настроить события и тихие часы")}</Link>}
    </>}
  </div>;
}
