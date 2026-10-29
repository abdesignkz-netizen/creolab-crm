import { useEsfEnabled } from "../lib/session";
import { EmployeeTelegramPanel } from "../components/EmployeeTelegramPanel";
import { WebsiteChatPanel } from "./WebsiteChatPanel";
import { ChannelAiControl } from "../components/ChannelAiControl";
import { InlineFeedback } from "../components/InlineFeedback";
import { IntegrationDisclosure } from "../components/IntegrationDisclosure";
import { WhatsAppConnectionsPanel } from "./WhatsAppConnectionsPanel";
import { uiText, useUiText, localizeUiOptions, uiMessage, uiFormatLocale } from "../lib/uiText";
import { TikTokConnectionsPanel } from "./TikTokConnectionsPanel";
import { MetaConnectionsPanel } from "./MetaConnectionsPanel";
import { GoogleConnectionsPanel } from "./GoogleConnectionsPanel";
import { notifySaved } from "../components/SaveNotice";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useCompanyConfiguration } from "../lib/companyConfiguration";
import { statusBadgeClass } from "../lib/statusBadge";
import { IntegrationHelp } from "../components/IntegrationHelp";

const WebsiteFormsPanel = lazy(() => import("./WebsiteFormsPanel"));

function whatsappStatusNote(wa: any) {
  if (!wa?.configured) return uiText("Укажите Instance ID и API Token из личного кабинета Green API.");
  if (wa.reachable) {
    if (typeof wa.leadCountOnBot === "number") {
      return uiText("На WhatsApp {p0} переписок · в CRM {p1} диалогов.", {p0: wa.leadCountOnBot, p1: wa.conversationCount ?? 0});
    }
    return uiText("WhatsApp подключён.");
  }
  return uiText("WhatsApp не отвечает. Проверьте Instance ID и API Token или обратитесь в поддержку.");
}

export function IntegrationsPage() {
  const { api, managed, href, me: configurationMe } = useCompanyConfiguration();
  const esfEnabled = configurationMe?.serviceFeatures?.esf === true;
  const uiText = useUiText();
  const location = useLocation();
  const navigate = useNavigate();
  const me = configurationMe;
  const aiManagerAllowed = Boolean(me?.billing?.entitlements?.AI_MANAGER);
  const aiManagerTrial = aiManagerAllowed && me?.billing?.planCode === "BASQAR_FREE";
  const [editingWhatsApp, setEditingWhatsApp] = useState(false);
  const [savingWhatsApp, setSavingWhatsApp] = useState(false);
  const [catalog, setCatalog] = useState<any>(null);
  const [setup, setSetup] = useState<any>(null);
  const [error, setErrorMessage] = useState("");
  const [notice, setNotice] = useState<{ message: string; kind: "success" | "info" } | null>(null);
  const [checkingWhatsApp, setCheckingWhatsApp] = useState(false);
  const loadVersion = useRef(0);
  const summaryVersion = useRef(0);
  function setError(message: string) {
    setErrorMessage(message);
    if (message) setNotice(null);
  }
  function setNote(message: string, kind: "success" | "info" = "success") {
    setNotice(message ? { message, kind } : null);
  }
  const [botToken, setBotToken] = useState("");
  const [savingBot, setSavingBot] = useState(false);
  const [summaries, setSummaries] = useState<Record<string, any>>({});

  async function load() {
    const version = ++loadVersion.current;
    setError("");
    try {
      const [c, s] = await Promise.all([api.integrationCatalog(), api.integrationSetup()]);
      if (version !== loadVersion.current) return null;
      setCatalog(c);
      setSetup(s);
      return s;
    } catch (err) {
      if (version === loadVersion.current) setError(err instanceof Error ? err.message : uiText("Ошибка загрузки"));
      return null;
    }
  }

  async function loadSummaries() {
    const version = ++summaryVersion.current;
    const results = await Promise.allSettled([api.whatsAppConnections(), api.googleConnections(), esfEnabled ? api.esfConnection() : Promise.resolve(null)]);
    if (version !== summaryVersion.current) return;
    setSummaries(Object.fromEntries(["whatsapp", "google", "esf"].map((key, index) => [key,
      results[index].status === "fulfilled" ? (results[index] as PromiseFulfilledResult<any>).value : { failed: true }])));
  }
  function refresh() { void load(); void loadSummaries(); }

  useEffect(() => {
    void load();
    const searchParams = new URLSearchParams(location.search);
    const google = searchParams.get("google");
    if (google) {
      if (google === "connected") setNote(uiText("Google подключён. Проверьте выбранный сервис ниже."));
      else if (google === "cancelled") setNote(uiText("Подключение Google отменено. Когда будете готовы, повторите вход."), "info");
      else setError(uiText(google === "expired"
        ? "Подтверждение Google истекло или уже использовано. Начните подключение заново."
        : google === "permissions"
          ? "Google не предоставил доступ к выбранному сервису. Проверьте аккаунт и разрешите запрошенные права."
          : "Не удалось подключить Google. Повторите вход. Если ошибка повторится, обратитесь в поддержку."));
      // Consume the one-time outcome so it cannot reappear after reconnecting or disconnecting.
      searchParams.delete("google");
      navigate({ search: searchParams.toString(), hash: location.hash }, { replace: true });
    }
  }, []);

  useEffect(() => { void loadSummaries(); }, [esfEnabled]);

  if (!catalog && !setup && !error) return <div className="state">{uiText("Загрузка…")}</div>;
  if (!catalog && !setup) {
    return (
      <section>
        <InlineFeedback kind="error" className="error">{error}</InlineFeedback>
        <button className="btn" onClick={() => void load()}>
          {uiText("Повторить")}</button>
      </section>
    );
  }

  const leadCards = (catalog?.leads || []).filter(
    (card: any) => card.catalogType === "WEBSITE_FORM" || card.catalogType === "WEBHOOK_API" || card.connected,
  );
  const companyTelegram = catalog?.messaging?.find((card: any) => card.catalogType === "TELEGRAM");
  const whatsappSender =
    setup?.whatsapp?.sender && !/\.js$/i.test(String(setup.whatsapp.sender)) ? setup.whatsapp.sender : null;

  function summary(item: any): { status: string; tone: "neutral" | "ok" | "warn" } {
    if (!item) return { status: uiText("Загрузка…"), tone: "neutral" };
    if (item.failed) return { status: uiText("Не удалось проверить"), tone: "warn" };
    if (item.available === false) return { status: uiMessage(item.healthLabel) || uiText("Требуется настройка"), tone: "neutral" };
    const problem = item.lastError || ["ERROR", "TOKEN_EXPIRED", "REAUTH_REQUIRED", "RECONNECT_REQUIRED"].some(status => status === item.healthStatus || status === item.connectionStatus);
    return { status: problem ? uiText("Требует внимания") : uiMessage(item.healthLabel) || (item.connected ? uiText("Подключено") : uiText("Не подключено")), tone: problem ? "warn" : item.connected ? "ok" : "neutral" };
  }
  function catalogSummary(type: string) {
    const item = [...(catalog?.leads || []), ...(catalog?.messaging || [])].find(row => row.catalogType === type);
    return summary(item || (catalog ? { connected: false } : { failed: true }));
  }
  function googleSummary(kind: string) {
    return summary(summaries.google?.failed ? summaries.google : summaries.google
      ? summaries.google.items?.find((row: any) => row.kind === kind) || { connected: false } : undefined);
  }
  const direct = summaries.whatsapp?.items || [];
  const whatsappSummary = summary(direct.some((row: any) => row.status === "RECONNECT_REQUIRED" || row.lastError)
    ? { lastError: true } : direct.some((row: any) => row.status === "CONNECTED") || setup?.whatsapp?.reachable
    ? { connected: true } : !summaries.whatsapp || summaries.whatsapp.failed ? summaries.whatsapp
    : setup?.whatsapp?.configured ? { lastError: true } : { connected: false, healthLabel: direct.length ? "Ожидает настройки" : "Не подключено" });
  const esf = summaries.esf?.connection;
  const esfSummary = summary(summaries.esf?.failed ? summaries.esf : esf ? {
    connected: esf.status === "CONNECTED" && esf.sessionActive && !esf.reauthRequired,
    lastError: esf.lastErrorMessage || esf.reauthRequired,
  } : summaries.esf ? { connected: false } : undefined);
  const leadDetails = (selectedType: string) => <>
        {(leadCards.filter((card: any) => card.catalogType === selectedType)).map((card: any) => (
          <div className="panel integ-card" key={card.catalogType}>
            <div className="integ-card-head">
              <b>{uiMessage(card.title)}</b>
              <span className={statusBadgeClass(uiMessage(card.healthLabel))}>{uiMessage(card.healthLabel)}</span>
            </div>
            {card.connected ? (
              <>
                <p className="muted">
                  {card.inquiryCount != null ? uiText("{p0} заявок", {p0: card.inquiryCount}) : null}
                </p>
                {card.integrationId ? (
                  <button
                    type="button"
                    className="btn secondary"
                    onClick={async () => {
                      try {
                        setError(""); setNote("");
                        const result = await api.integrationHealthCheck(card.integrationId) as { healthLabel: string; allOk: boolean };
                        setNote(uiText("Проверка «{p0}»: {p1}", {p0: uiMessage(card.title), p1: uiMessage(result.healthLabel)}), result.allOk ? "success" : "info");
                        await load();
                      } catch (err) {
                        setError(err instanceof Error ? err.message : uiText("Проверка не выполнена"));
                      }
                    }}
                  >
                    {uiText("Проверить подключение")}</button>
                ) : null}
              </>
            ) : (
              <p className="muted">{uiMessage(card.note) || uiText("Не подключено")}</p>
            )}
            <IntegrationHelp kind={card.catalogType === "WEBSITE_FORM" ? "website_form" : card.catalogType === "WEBHOOK_API" ? "webhook_api" : card.catalogType === "GOOGLE_FORMS" ? "google_forms" : card.catalogType === "META_LEAD_FORMS" ? "meta_leads" : card.catalogType === "TIKTOK_LEADS" ? "tiktok" : "website_form"} />
          </div>
        ))}
  </>;

  return (
    <section className="integrations-page">
      <div className="page-head">
        <div>
          <h2>{uiText("Интеграции")}</h2>
          <p className="muted">{uiText("Подключайте сервисы и управляйте ими в одном месте.")}</p>
          <p className="muted">{uiText("Выберите карточку, чтобы открыть настройки и инструкции.")}</p>
        </div>
      </div>
      {error ? <InlineFeedback kind="error" className="error">{error}</InlineFeedback> : null}
      {notice ? <InlineFeedback kind={notice.kind} className={notice.kind === "success" ? "ok" : "muted"}>{notice.message}</InlineFeedback> : null}

      <div className="integration-catalog-grid">
        <IntegrationDisclosure id="whatsapp" icon="whatsapp" title="WhatsApp" description={uiText("Переписка и ИИ · QR, Green API, Meta")} {...whatsappSummary}>
      <WhatsAppConnectionsPanel onChange={refresh}>
      <div>
        <h4>Green API</h4>
        <IntegrationHelp kind="whatsapp" />
        {setup?.whatsapp?.warning ? <div className="banner warn">{uiMessage(setup.whatsapp.warning)}</div> : null}
        <p className="muted">{whatsappStatusNote(setup?.whatsapp)}</p>
        <p className="muted">{aiManagerAllowed ? uiText("Задайте цель, базу знаний и правила ответов в настройках ИИ-менеджера.") : uiText("WhatsApp доступен для переписки с клиентами. ИИ-менеджер не включён в ваш тариф.")}</p>
        {aiManagerAllowed && (managed || me?.capabilities?.aiSettings) && <div className="actions"><Link to={href("/settings/ai-manager")}>{uiText("Знания и цель ИИ")}</Link><Link to={href("/settings/ai-automation")}>{uiText("Кому и когда отвечать")}</Link></div>}
        <p className="integ-status-line">
          {uiText("Статус подключения")}<span className={setup?.whatsapp?.reachable ? "badge ok" : setup?.whatsapp?.configured ? "badge warn" : "badge"}>
            {setup?.whatsapp?.reachable ? uiText("Работает") : setup?.whatsapp?.configured ? uiText("Ошибка проверки") : uiText("Не подключён")}
          </span>
        </p>
        {aiManagerTrial && <p className="muted">{uiText("Пробный режим · 100 AI-кредитов один раз")}</p>}
        {whatsappSender ? <p>WhatsApp · {whatsappSender}</p> : null}
        <p className="muted">{uiText("Диалоги ·")}{" "}{setup?.whatsapp?.conversationCount ?? 0}</p>
        <p className="muted">
          {uiText("Последняя синхронизация ·")}{" "}
          {setup?.whatsapp?.lastSyncAt ? new Date(setup.whatsapp.lastSyncAt).toLocaleString(uiFormatLocale()) : uiText("ещё не было")}
        </p>
        {editingWhatsApp ? (
          <form
            className="stack"
            onSubmit={async (event) => {
              event.preventDefault();
              if (savingWhatsApp) return;
              const formEl = new FormData(event.currentTarget);
              setSavingWhatsApp(true);
              setError(""); setNote("");
              try {
                const result = (await api.connectWhatsApp({
                  instanceId: String(formEl.get("instanceId") || ""),
                  apiToken: String(formEl.get("apiToken") || ""),
                })) as any;
                setNote(
                  result?.reachable
                    ? uiText("WhatsApp подключён.")
                    : uiText("Сохранено. Подключение пока не подтверждено. Проверьте Instance ID и API Token."),
                  result?.reachable ? "success" : "info",
                );
                setEditingWhatsApp(false);
                if (result?.reachable) notifySaved(uiText("WhatsApp подключён"));
                await load();
              } catch (err) {
                setError(err instanceof Error ? err.message : uiText("Не удалось сохранить"));
              } finally {
                setSavingWhatsApp(false);
              }
            }}
          >
            <label>
              Instance ID
              <input name="instanceId" defaultValue={setup?.whatsapp?.instanceId || ""} required={!setup?.whatsapp?.configured} />
            </label>
            <label>
              API Token
              <input name="apiToken" type="password" autoComplete="off" placeholder={setup?.whatsapp?.configured ? uiText("оставьте пустым, чтобы не менять") : ""} required={!setup?.whatsapp?.configured} />
            </label>
            <div className="actions">
              <button className="btn" disabled={savingWhatsApp}>{savingWhatsApp ? uiText("Подключаем…") : uiText("Подключить")}</button>
              <button type="button" className="btn secondary" onClick={() => setEditingWhatsApp(false)}>{uiText("Отмена")}</button>
            </div>
          </form>
        ) : null}
        <div className="actions" style={{ marginTop: 12 }}>
          <button
            type="button"
            className="btn secondary"
            disabled={checkingWhatsApp || savingWhatsApp}
            onClick={async () => {
              setCheckingWhatsApp(true); setNote("");
              try {
                const result = await load() as { whatsapp?: { reachable?: boolean; configured?: boolean } } | null;
                if (result) setNote(whatsappStatusNote(result.whatsapp), result.whatsapp?.reachable ? "success" : "info");
              } finally { setCheckingWhatsApp(false); }
            }}
          >
            {checkingWhatsApp ? uiText("Подождите…") : uiText("Проверить подключение")}</button>
          <button type="button" className="btn secondary" onClick={() => setEditingWhatsApp(true)}>
            {setup?.whatsapp?.configured ? uiText("Переподключить") : uiText("Подключить")}
          </button>
          {setup?.whatsapp?.configured ? (
            <button
              type="button"
              className="btn secondary"
              onClick={async () => {
                try {
                  const result = (await api.disconnectWhatsApp()) as any;
                  setNote(result.note || uiText("WhatsApp отключён."));
                  notifySaved(uiText("WhatsApp отключён"));
                  await load();
                } catch (err) {
                  setError(err instanceof Error ? err.message : uiText("Не удалось отключить"));
                }
              }}
            >
              {uiText("Отключить")}</button>
          ) : null}
          <button
            type="button"
            className="btn secondary"
            onClick={async () => {
              try {
                const result = (await api.syncWhatsApp()) as any;
                setNote(
                  result.note ||
                    uiText("Синхронизация: новых {p0}, обновлено {p1}.", {p0: result.imported, p1: result.updated}),
                );
              } catch (err) {
                setError(err instanceof Error ? err.message : uiText("Синхронизация не выполнена"));
              }
            }}
          >
            {uiText("Забрать диалоги из бота")}</button>
        </div>
      </div>

      </WhatsAppConnectionsPanel>

        </IntegrationDisclosure>
        <IntegrationDisclosure id="instagram" icon="instagram" title="Instagram Direct" description={uiText("Сообщения клиентов из Instagram")} {...catalogSummary("INSTAGRAM_DIRECT")}>
          <MetaConnectionsPanel kind="instagram_direct" onChange={refresh} />
        </IntegrationDisclosure>
        <IntegrationDisclosure id="telegram" icon="telegram" title={uiText("Telegram-бот компании")} description={uiText("Общение с клиентами через бота")} {...catalogSummary("TELEGRAM")}>
      <div className="panel">
        <h3>{uiText("Telegram-бот компании")}</h3>
        <IntegrationHelp kind="telegram_bot" />
        <p className="muted">{uiText("Клиенты пишут вашему боту. Отвечать может ИИ-менеджер или сотрудник из раздела «Диалоги».")}</p>
        <p><span className="badge">{uiMessage(companyTelegram?.healthLabel) || uiText("Не подключено")}</span> {companyTelegram?.username ? `@${companyTelegram.username}` : ""}</p>
        <form onSubmit={async event => {
          event.preventDefault(); setSavingBot(true); setError(""); setNote("");
          try { await api.connectCompanyTelegram(botToken); setBotToken(""); setNote(uiText("Telegram-бот подключён. Напишите ему из другого аккаунта для проверки.")); await load(); }
          catch (err) { setError(err instanceof Error ? err.message : uiText("Не удалось подключить бота")); }
          finally { setSavingBot(false); }
        }}>
          <label>{uiText("Токен бота из BotFather")}<input type="password" autoComplete="new-password" value={botToken} onChange={event => setBotToken(event.target.value)} placeholder={uiText("Токен Telegram-бота")} required disabled={savingBot} /></label>
          <p className="muted">{uiText("Создайте бота командой /newbot в @BotFather. Используйте отдельного бота, который не подключён к другой системе. Токен хранится зашифрованным.")}</p>
          <button className="btn" type="submit" disabled={savingBot || !botToken.trim()}>{savingBot ? uiText("Подключение…") : uiText("Подключить или обновить бота")}</button>
        </form>
        {(companyTelegram?.connections || []).map((bot: any) => <div className="panel" key={bot.integrationId}><p><b>{bot.username ? `@${bot.username}` : "Telegram"}</b> · {uiMessage(bot.healthLabel)}</p><div className="actions">
          <button type="button" className="btn secondary" disabled={savingBot} onClick={async () => {
            setSavingBot(true); setError(""); setNote("");
            try { const result = await api.checkCompanyTelegram(bot.integrationId) as { healthLabel: string; connected: boolean }; setNote(uiMessage(result.healthLabel), result.connected ? "success" : "info"); await load(); }
            catch (err) { setError(err instanceof Error ? err.message : uiText("Проверка не выполнена")); }
            finally { setSavingBot(false); }
          }}>{uiText("Проверить подключение")}</button>
          {bot.status !== "disabled" ? <button type="button" className="btn secondary" disabled={savingBot} onClick={async () => {
            setSavingBot(true); setError("");
            try { await api.disconnectCompanyTelegram(bot.integrationId); setNote(uiText("Telegram-бот отключён. История диалогов сохранена.")); await load(); }
            catch (err) { setError(err instanceof Error ? err.message : uiText("Не удалось отключить бота")); }
            finally { setSavingBot(false); }
          }}>{uiText("Отключить бота")}</button> : null}
        </div>{bot.connected && <><p><a href={`https://t.me/${bot.username}`} target="_blank" rel="noopener noreferrer">{uiText("Открыть бота и отправить пробное сообщение")}</a></p><ChannelAiControl id={bot.integrationId}/></>}</div>)}
      </div>

        </IntegrationDisclosure>
        <IntegrationDisclosure id="website-chat" icon="form" title={uiText("Чат на сайте")} description={uiText("ИИ-консультант и сотрудники прямо на вашем сайте")} {...catalogSummary("WEBSITE_CHAT")}><WebsiteChatPanel onChange={refresh} /></IntegrationDisclosure>
        <IntegrationDisclosure id="website" icon="form" title={uiText("Форма сайта")} description={uiText("Заявки с вашего сайта в одном месте")} {...catalogSummary("WEBSITE_FORM")}>
          {managed ? <Link className="btn" to={href("/integrations/forms")}>{uiText("Настроить подключение")}</Link> : <Suspense fallback={<p>{uiText("Загрузка…")}</p>}><WebsiteFormsPanel onChange={refresh} /></Suspense>}
        </IntegrationDisclosure>
        {esfEnabled ? <IntegrationDisclosure id="esf" icon="esf" title={uiText("ИС ЭСФ")} description={uiText("Электронные счета-фактуры и ЭЦП")} {...esfSummary}>
      <h3 className="integ-section-title">{uiText("Документы и ИС ЭСФ")}</h3>
      <div className="integ-grid">
        <div className="panel integ-card">
          <div className="integ-card-head">
            <b>{uiText("ИС ЭСФ")}</b>
            <span className="badge warn">NCALayer</span>
          </div>
          <p className="muted">{uiText("Подключение кабинета через ЭЦП на этом компьютере. PIN ключа на сервер не передаётся.")}</p>
          <Link className="btn" to={href("/integrations/esf")}>
            {uiText("Открыть ИС ЭСФ")}</Link>
          <IntegrationHelp kind="esf" />
        </div>
      </div>

        </IntegrationDisclosure> : null}
        <IntegrationDisclosure id="calendar" icon="calendar" title="Google Calendar" description={uiText("Встречи и события вашего бизнеса")} {...googleSummary("calendar")}>
          <GoogleConnectionsPanel kind="calendar" onChange={refresh} />
        </IntegrationDisclosure>
        <IntegrationDisclosure id="email" icon="email" title="Gmail" description={uiText("Входящие письма в диалогах")} {...googleSummary("email")}>
          <GoogleConnectionsPanel kind="email" onChange={refresh} />
        </IntegrationDisclosure>
        <IntegrationDisclosure id="google-forms" icon="form" title="Google Forms" description={uiText("Ответы на формы становятся заявками")} {...googleSummary("google_forms")}>
          <GoogleConnectionsPanel kind="google_forms" onChange={refresh} />
        </IntegrationDisclosure>
        <IntegrationDisclosure id="meta-leads" icon="meta" title="Meta Lead Forms" description={uiText("Заявки из рекламы Facebook и Instagram")} {...catalogSummary("META_LEAD_FORMS")}>
          <MetaConnectionsPanel kind="meta_lead_forms" onChange={refresh} />
        </IntegrationDisclosure>
        <IntegrationDisclosure id="tiktok" icon="tiktok" title="TikTok Leads" description={uiText("Заявки из рекламы TikTok")} {...catalogSummary("TIKTOK_LEADS")}>
          <TikTokConnectionsPanel onChange={refresh} />
        </IntegrationDisclosure>
        <IntegrationDisclosure id="webhook" icon="webhook" title="Webhook / API" description={uiText("Приём заявок из других сервисов")} {...catalogSummary("WEBHOOK_API")}>
          {managed ? <Link className="btn" to={href("/integrations/webhook")}>{uiText("Настроить подключение")}</Link> : leadDetails("WEBHOOK_API")}
        </IntegrationDisclosure>
        {!managed && <IntegrationDisclosure id="notifications" icon="notification" title={uiText("Telegram сотрудника")} description={uiText("Личные уведомления о работе")} {...summary(catalog?.notifications?.employeeTelegram)}>
          <EmployeeTelegramPanel onChange={refresh} />
        </IntegrationDisclosure>}
      </div>
    </section>
  );
}
