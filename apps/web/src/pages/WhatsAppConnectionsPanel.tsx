import { useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { useLocale } from "../lib/session";
import { WhatsAppAiControls } from "../components/WhatsAppAiControls";

type Connection = { id: string; provider: "qr" | "cloud"; status: string; phone: string | null; callbackUrl: string | null; webhookVerified: boolean; lastError: string | null; aiEnabled: boolean; aiAvailable: boolean; aiUnavailableReason: string | null };
type Qr = { qr: string | null; expiresAt: string | null; status: string };

export function WhatsAppConnectionsPanel({ children }: { children?: ReactNode } = {}) {
  const locale = useLocale();
  const translate = (ru: string, kk: string, en: string) => locale === "kk" ? kk : locale === "en" ? en : ru;
  const [method, setMethod] = useState<"green" | "qr" | "cloud">("green");
  const [items, setItems] = useState<Connection[]>([]);
  const [qrAvailable, setQrAvailable] = useState(true);
  const [pollRevision, setPollRevision] = useState(0);
  const [qrId, setQrId] = useState("");
  const [qr, setQr] = useState<Qr | null>(null);
  const [setup, setSetup] = useState<{ id: string; callbackUrl: string; verifyToken: string | null } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  async function load() {
    const result = await api.whatsAppConnections() as { items: Connection[]; qrAvailable: boolean };
    setItems(result.items); setQrAvailable(result.qrAvailable); setLoaded(true);
  }
  async function perform(work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setError("");
    try { await work(); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : translate("Не удалось выполнить действие", "Әрекетті орындау мүмкін болмады", "The action could not be completed")); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load().catch(() => setError(translate("Не удалось загрузить подключения", "Қосылымдарды жүктеу мүмкін болмады", "Could not load connections"))); }, []);
  useEffect(() => {
    if (!qrId || method !== "qr") return;
    let cancelled = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await api.whatsAppQr(qrId) as Qr;
        if (cancelled) return;
        setQr(result);
        if (result.status === "CONNECTED" || result.status === "RECONNECT_REQUIRED") { await load(); return; }
        timer = setTimeout(() => void poll(), 3000);
      } catch { if (!cancelled) { setQr(null); setError(translate("Не удалось обновить QR-код. Повторите проверку подключения.", "QR-кодты жаңарту мүмкін болмады. Қосылымды қайта тексеріңіз.", "Could not refresh the QR code. Check the connection again.")); } }
    };
    void poll(); return () => { cancelled = true; clearTimeout(timer); };
  }, [qrId, method, pollRevision]);
  const qrVisible = qr?.qr && qr.expiresAt && new Date(qr.expiresAt).getTime() > Date.now();
  const status = (value: string) => value === "CONNECTED" ? translate("Подключено", "Қосылды", "Connected") : value === "RECONNECT_REQUIRED" ? translate("Требуется повторное подключение", "Қайта қосылу қажет", "Reconnect required") : value === "QR_READY" ? translate("Отсканируйте QR-код", "QR-кодты сканерлеңіз", "Scan the QR code") : value === "PENDING" ? translate("Завершите настройку Meta", "Meta баптауын аяқтаңыз", "Complete Meta setup") : translate("Подключение…", "Қосылуда…", "Connecting…");
  return <section className="panel">
    <h3>WhatsApp</h3>
    <p>{translate("Выберите способ подключения номера", "Нөмірді қосу тәсілін таңдаңыз", "Choose how to connect your number")}</p>
    <div className="actions" role="group" aria-label="WhatsApp">
      <button className={`btn ${method === "green" ? "" : "secondary"}`} aria-pressed={method === "green"} onClick={() => setMethod("green")}>Green API</button>
      <button className={`btn ${method === "qr" ? "" : "secondary"}`} aria-pressed={method === "qr"} onClick={() => setMethod("qr")}>{translate("Через QR-код", "QR-код арқылы", "QR code")}</button>
      <button className={`btn ${method === "cloud" ? "" : "secondary"}`} aria-pressed={method === "cloud"} onClick={() => setMethod("cloud")}>{translate("Официальное подключение", "Ресми қосылым", "Official connection")}</button>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    {method === "green" && <div style={{ marginTop: 16 }}>{children}</div>}
    {method === "qr" && <div className="stack" style={{ marginTop: 16 }}>
      <p>{translate("Подключите WhatsApp прямо к BasQar, без аккаунта Green API. На телефоне откройте WhatsApp → Связанные устройства → Привязка устройства и отсканируйте код.", "WhatsApp-ты Green API аккаунтынсыз тікелей BasQar-ға қосыңыз. Телефонда WhatsApp → Байланыстырылған құрылғылар → Құрылғыны байланыстыру бөлімін ашып, кодты сканерлеңіз.", "Connect WhatsApp directly to BasQar without a Green API account. On your phone, open WhatsApp → Linked devices → Link a device and scan the code.")}</p>
      <p className="muted">{translate("Это подключение через связанную сессию WhatsApp Web. Оно не является официальным Cloud API Meta. Доступны переписка, файлы и ИИ-ответы по настройкам компании.", "Бұл — WhatsApp Web сеансы арқылы қосылу тәсілі, Meta-ның ресми Cloud API қызметі емес. Хабарлама және файл алмасуға және компания баптауларына сәйкес ЖИ жауаптарын пайдалануға болады.", "This uses a linked WhatsApp Web session, separate from Meta’s official Cloud API. Messaging, files and AI replies using your company settings are supported.")}</p>
      {!qrAvailable && <p className="banner warn">{translate("QR-подключение временно недоступно", "QR арқылы қосылу уақытша қолжетімсіз", "QR connection is temporarily unavailable")}</p>}
      <button className="btn" disabled={busy || !loaded || !qrAvailable} onClick={() => void perform(async () => {
        const existing = items.find(item => item.provider === "qr" && ["QR_READY", "CONNECTING"].includes(item.status));
        const result = existing || await api.connectWhatsAppQr() as { id: string };
        setQr(null); setQrId(result.id); setPollRevision(value => value + 1);
      })}>{translate("Показать QR-код", "QR-кодты көрсету", "Show QR code")}</button>
      {qrId && <div aria-live="polite">
        {qrVisible ? <img src={qr!.qr!} width="280" height="280" style={{ maxWidth: "100%", height: "auto" }} alt={translate("QR-код для подключения WhatsApp", "WhatsApp қосуға арналған QR-код", "WhatsApp pairing QR code")} /> : <p>{status(qr?.status || "CONNECTING")}</p>}
        {qrVisible && <p className="muted">{translate("Код обновляется автоматически. Не передавайте его другим людям.", "Код автоматты түрде жаңарады. Оны басқа адамдарға бермеңіз.", "The code refreshes automatically. Do not share it with others.")}</p>}
      </div>}
    </div>}
    {method === "cloud" && <div className="stack" style={{ marginTop: 16 }}>
      <p>{translate("Официальный WhatsApp Business Platform (Cloud API Meta). Для подключения нужен зарегистрированный бизнес-номер и доступ к приложению Meta.", "Ресми WhatsApp Business Platform (Meta Cloud API). Қосылу үшін тіркелген бизнес-нөмір және Meta қолданбасына қолжетімділік қажет.", "Official WhatsApp Business Platform (Meta Cloud API). You need a registered business phone number and access to a Meta app.")}</p>
      <p className="muted">{translate("Здесь доступны переписка и файлы. Ответить можно в течение 24 часов после сообщения клиента. ИИ-ответы доступны по настройкам компании. Шаблонные сообщения пока не подключены.", "Хабарлама және файл алмасуға болады. Клиенттің хабарламасынан кейін 24 сағат ішінде жауап беруге болады. ЖИ жауаптары компания баптауларына сәйкес қолжетімді. Үлгі хабарламалар әзірге қосылмаған.", "Messaging and files are supported. Reply within 24 hours of the customer’s message. AI replies use your company settings. Template messages are not connected yet.")}</p>
      <form className="stack" onSubmit={event => {
        event.preventDefault(); const form = event.currentTarget, values = new FormData(form);
        void perform(async () => { const result = await api.connectWhatsAppCloud({ appId: String(values.get("appId")), wabaId: String(values.get("wabaId")), phoneNumberId: String(values.get("phoneNumberId")), accessToken: String(values.get("accessToken")), appSecret: String(values.get("appSecret")) }) as { id: string; callbackUrl: string; verifyToken: string | null }; setSetup(result); form.reset(); });
      }}>
        <label>App ID<input name="appId" required inputMode="numeric" pattern="[0-9]+" /></label>
        <label>WhatsApp Business Account ID (WABA)<input name="wabaId" required inputMode="numeric" pattern="[0-9]+" /></label>
        <label>Phone Number ID<input name="phoneNumberId" required inputMode="numeric" pattern="[0-9]+" /></label>
        <label>Access Token<input name="accessToken" required type="password" autoComplete="off" /></label>
        <label>App Secret<input name="appSecret" required type="password" autoComplete="off" /></label>
        <button className="btn" disabled={busy || !loaded}>{translate("Проверить и сохранить", "Тексеру және сақтау", "Verify and save")}</button>
      </form>
      {setup?.verifyToken && <div className="banner">
        <p>{translate("В приложении Meta откройте WhatsApp → Configuration. Укажите адрес и проверочный токен ниже, затем подпишитесь на поле messages и нажмите «Проверить и включить». Сохраните токен: он показывается только сейчас.", "Meta қолданбасында WhatsApp → Configuration бөлімін ашыңыз. Төмендегі мекенжай мен тексеру токенін енгізіңіз, messages өрісіне жазылыңыз және «Тексеру және қосу» түймесін басыңыз. Токенді сақтап алыңыз: ол тек қазір көрсетіледі.", "In your Meta app, open WhatsApp → Configuration. Enter the callback and verification token below, subscribe to the messages field, then select Verify and enable. Save the token: it is shown only now.")}</p>
        <label>Callback URL<input readOnly value={setup.callbackUrl} /></label>
        <label>Verify Token<input readOnly value={setup.verifyToken} /></label>
      </div>}
    </div>}
    {items.length > 0 && <div className="stack" style={{ marginTop: 24 }}>
      <h4>{translate("Подключения QR и Meta", "QR және Meta қосылымдары", "QR and Meta connections")}</h4>
      {items.map(item => <div key={item.id} className="panel">
        <b>{item.provider === "qr" ? "WhatsApp · QR" : "WhatsApp · Cloud API"}{item.phone ? ` · ${item.phone}` : ""}</b>
        <p role="status">{status(item.status)}</p>
        <WhatsAppAiControls connection={item} busy={busy} onToggle={() => void perform(() => api.setWhatsAppAi(item.id, !item.aiEnabled))} />
        {item.lastError && <p className="muted">{translate("Проверьте подключение. Если повторная проверка не помогает, отключите номер и подключите его заново.", "Қосылымды тексеріңіз. Қайта тексеру көмектеспесе, нөмірді ажыратып, қайта қосыңыз.", "Check the connection. If checking again does not help, disconnect and reconnect the number.")}</p>}
        {item.provider === "cloud" && item.status !== "CONNECTED" && <>
          <label>Callback URL<input readOnly value={item.callbackUrl || ""} /></label>
          <button className="btn" disabled={busy} onClick={() => void perform(() => api.activateWhatsAppCloud(item.id))}>{translate("Проверить и включить", "Тексеру және қосу", "Verify and enable")}</button>
        </>}
        <button className="btn secondary" disabled={busy} onClick={() => void perform(async () => { await api.disconnectDirectWhatsApp(item.id); if (qrId === item.id) { setQrId(""); setQr(null); } if (setup?.id === item.id) setSetup(null); })}>{translate("Отключить", "Ажырату", "Disconnect")}</button>
      </div>)}
      <button className="btn secondary" disabled={busy} onClick={() => void perform(async () => { await load(); if (qrId) { setQr(await api.whatsAppQr(qrId) as Qr); setPollRevision(value => value + 1); } })}>{translate("Проверить подключение", "Қосылымды тексеру", "Check connection")}</button>
    </div>}
  </section>;
}
