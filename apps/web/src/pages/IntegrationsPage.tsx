import { InlineFeedback } from "../components/InlineFeedback";
import { IntegrationDisclosure } from "../components/IntegrationDisclosure";
import { WhatsAppConnectionsPanel } from "./WhatsAppConnectionsPanel";
import { uiText, useUiText, localizeUiOptions, uiMessage, uiFormatLocale } from "../lib/uiText";
import { useSession } from "../lib/session";
import { TikTokConnectionsPanel } from "./TikTokConnectionsPanel";
import { MetaConnectionsPanel } from "./MetaConnectionsPanel";
import { GoogleConnectionsPanel } from "./GoogleConnectionsPanel";
import { notifySaved } from "../components/SaveNotice";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { statusBadgeClass } from "../lib/statusBadge";
import { IntegrationHelp } from "../components/IntegrationHelp";

type ConnectMethod = "html" | "existing" | "js" | "tilda";

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
  const uiText = useUiText();
  const { me } = useSession();
  const aiManagerAllowed = Boolean(me?.billing?.entitlements?.AI_MANAGER);
  const aiManagerTrial = aiManagerAllowed && me?.billing?.planCode === "BASQAR_FREE";
  const [editingWhatsApp, setEditingWhatsApp] = useState(false);
  const [savingWhatsApp, setSavingWhatsApp] = useState(false);
  const [catalog, setCatalog] = useState<any>(null);
  const [setup, setSetup] = useState<any>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [formMethod, setFormMethod] = useState<ConnectMethod>("html");
  const [botToken, setBotToken] = useState("");
  const [savingBot, setSavingBot] = useState(false);
  const [summaries, setSummaries] = useState<Record<string, any>>({});
  const [telegram, setTelegram] = useState<any>(null);

  async function load() {
    setError("");
    try {
      const [c, s] = await Promise.all([api.integrationCatalog(), api.integrationSetup()]);
      setCatalog(c);
      setSetup(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Ошибка загрузки"));
    }
  }

  async function loadSummaries() {
    const results = await Promise.allSettled([api.whatsAppConnections(), api.googleConnections(), api.esfConnection()]);
    setSummaries(Object.fromEntries(["whatsapp", "google", "esf"].map((key, index) => [key,
      results[index].status === "fulfilled" ? (results[index] as PromiseFulfilledResult<any>).value : { failed: true }])));
  }
  function refresh() { void load(); void loadSummaries(); }

  useEffect(() => {
    void load();
    void loadSummaries();
  }, []);

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

  const formCard = catalog?.leads?.find((i: any) => i.catalogType === "WEBSITE_FORM");
  const submitUrl = formCard?.submitUrl || setup?.form?.submitUrl;
  const leadCards = (catalog?.leads || []).filter(
    (card: any) => card.catalogType === "WEBSITE_FORM" || card.catalogType === "WEBHOOK_API" || card.connected,
  );
  const companyTelegram = catalog?.messaging?.find((card: any) => card.catalogType === "TELEGRAM");
  const telegramReady = Boolean(setup?.telegram?.employee?.botConfigured);
  const whatsappSender =
    setup?.whatsapp?.sender && !/\.js$/i.test(String(setup.whatsapp.sender)) ? setup.whatsapp.sender : null;

  function summary(item: any): { status: string; tone: "neutral" | "ok" | "warn" } {
    if (!item) return { status: uiText("Загрузка…"), tone: "neutral" };
    if (item.failed) return { status: uiText("Не удалось проверить"), tone: "warn" };
    const problem = item.lastError || ["ERROR", "TOKEN_EXPIRED", "REAUTH_REQUIRED", "RECONNECT_REQUIRED"].some(status => status === item.healthStatus || status === item.connectionStatus);
    return { status: problem ? uiText("Требует внимания") : uiMessage(item.healthLabel) || (item.connected ? uiText("Подключено") : uiText("Не подключено")), tone: problem ? "warn" : item.connected ? "ok" : "neutral" };
  }
  function catalogSummary(type: string) {
    const item = [...(catalog?.leads || []), ...(catalog?.messaging || [])].find(row => row.catalogType === type);
    return summary(item || (catalog ? { connected: false } : { failed: true }));
  }
  function googleSummary(kind: string) {
    return summary(summaries.google?.failed ? summaries.google : summaries.google?.items?.find((row: any) => row.kind === kind));
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
  } : undefined);
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
                        const result = await api.integrationHealthCheck(card.integrationId) as { healthLabel: string };
                        setNote(uiText("Проверка «{p0}»: {p1}", {p0: uiMessage(card.title), p1: uiMessage(result.healthLabel)}));
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
      {note ? <InlineFeedback kind="success" className="ok">{note}</InlineFeedback> : null}

      <div className="integration-catalog-grid">
        <IntegrationDisclosure id="whatsapp" icon="whatsapp" title="WhatsApp" description={uiText("Переписка и ИИ · QR, Green API, Meta")} {...whatsappSummary}>
      <WhatsAppConnectionsPanel onChange={refresh}>
      <div>
        <h4>Green API</h4>
        <IntegrationHelp kind="whatsapp" />
        {setup?.whatsapp?.warning ? <div className="banner warn">{uiMessage(setup.whatsapp.warning)}</div> : null}
        <p className="muted">{whatsappStatusNote(setup?.whatsapp)}</p>
        <p className="muted">{aiManagerAllowed ? uiText("Как бот отвечает клиентам, задаёт администратор сервиса: промпт и база знаний компании.") : uiText("WhatsApp доступен для переписки с клиентами. ИИ-менеджер не включён в ваш тариф.")}</p>
        <p className="integ-status-line">
          {uiText("Статус подключения")}<span className={statusBadgeClass(setup?.whatsapp?.configured ? "Подключён" : "Не подключён")}>
            {setup?.whatsapp?.reachable ? uiText("Работает") : setup?.whatsapp?.configured ? uiText("Ошибка проверки") : uiText("Не подключён")}
          </span>
        </p>
        <p className="integ-status-line">
          {uiText("AI-менеджер")}{!aiManagerAllowed ? <span className="badge">{uiText("Не входит в тариф")}</span> : aiManagerTrial ? <span className="badge">{uiText("Пробный режим · 100 AI-кредитов один раз")}</span> : setup?.whatsapp?.reachable ? (
            <span className="badge ok">{uiText("Активен")}</span>
          ) : setup?.whatsapp?.configured ? (
            <span className="badge warn">{uiText("Не отвечает")}</span>
          ) : (
            <span className="badge">{uiText("Ожидает подключение")}</span>
          )}
        </p>
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
              setError("");
              try {
                const result = (await api.connectWhatsApp({
                  instanceId: String(formEl.get("instanceId") || ""),
                  apiToken: String(formEl.get("apiToken") || ""),
                })) as any;
                setNote(
                  result?.reachable
                    ? uiText("WhatsApp подключён.")
                    : uiText("Сохранено. Подключение пока не подтверждено. Проверьте Instance ID и API Token."),
                );
                setEditingWhatsApp(false);
                notifySaved(uiText("WhatsApp подключён"));
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
            onClick={async () => {
              try {
                await load();
                setNote(uiText("Проверка подключения выполнена."));
              } catch (err) {
                setError(err instanceof Error ? err.message : uiText("Проверка не выполнена"));
              }
            }}
          >
            {uiText("Проверить подключение")}</button>
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
        <p className="muted">{uiText("Клиенты пишут вашему боту, сотрудники отвечают в разделе «Диалоги». Сообщения не создают заявки автоматически.")}</p>
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
            setSavingBot(true); setError("");
            try { const result = await api.checkCompanyTelegram(bot.integrationId) as { healthLabel: string }; setNote(uiMessage(result.healthLabel)); await load(); }
            catch (err) { setError(err instanceof Error ? err.message : uiText("Проверка не выполнена")); }
            finally { setSavingBot(false); }
          }}>{uiText("Проверить подключение")}</button>
          {bot.status !== "disabled" ? <button type="button" className="btn secondary" disabled={savingBot} onClick={async () => {
            setSavingBot(true); setError("");
            try { await api.disconnectCompanyTelegram(bot.integrationId); setNote(uiText("Telegram-бот отключён. История диалогов сохранена.")); await load(); }
            catch (err) { setError(err instanceof Error ? err.message : uiText("Не удалось отключить бота")); }
            finally { setSavingBot(false); }
          }}>{uiText("Отключить бота")}</button> : null}
        </div></div>)}
      </div>

        </IntegrationDisclosure>
        <IntegrationDisclosure id="website" icon="form" title={uiText("Форма сайта")} description={uiText("Заявки с вашего сайта в одном месте")} {...catalogSummary("WEBSITE_FORM")}>
          {leadDetails("WEBSITE_FORM")}
      {setup?.form?.connected && submitUrl ? (
        <div className="panel">
          <h3>{uiText("Форма сайта — подключение")}</h3>
          <IntegrationHelp kind="website_form" />
          <p className="muted integration-endpoint">{uiText("Адрес для заявок:")}{" "}{submitUrl}</p>
          <div className="actions" style={{ marginBottom: 12 }}>
            {(
              [
                ["html", uiText("Готовая HTML-форма")],
                ["existing", uiText("Существующая форма")],
                ["js", "JavaScript / React"],
                ["tilda", uiText("Tilda / конструктор")],
              ] as Array<[ConnectMethod, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`btn ${formMethod === key ? "" : "secondary"}`}
                onClick={() => setFormMethod(key)}
              >
                {label}
              </button>
            ))}
          </div>
          {formMethod === "html" ? (
            <>
              <p className="muted">{uiText("Готовый HTML. Дополнительных ключей не нужно.")}</p>
              <pre className="code">{uiText("<form method=\"POST\" action=\"{p0}\">\n  <input name=\"name\" required />\n  <input name=\"phone\" required />\n  <input name=\"company\" />\n  <textarea name=\"message\"></textarea>\n  <input name=\"utm_source\" type=\"hidden\" />\n  <input name=\"pageUrl\" type=\"hidden\" />\n  <input name=\"website\" style=\"display:none\" tabindex=\"-1\" autocomplete=\"off\" />\n  <button type=\"submit\">Отправить</button>\n</form>", {p0: submitUrl})}</pre>
            </>
          ) : null}
          {formMethod === "js" ? (
            <>
              <p className="muted">{uiText("Отправка заявки из кода сайта.")}</p>
              <pre className="code">{uiText("await fetch(\"{p0}\", {\n  method: \"POST\",\n  headers: {\n    \"Content-Type\": \"application/json\",\n    \"X-Submission-Id\": crypto.randomUUID(),\n  },\n  body: JSON.stringify({\n    name: \"Имя\",\n    phone: \"+7701...\",\n    message: \"Текст\",\n    pageUrl: location.href,\n    utm_source: new URLSearchParams(location.search).get(\"utm_source\"),\n  }),\n});", {p0: submitUrl})}</pre>
            </>
          ) : null}
          {formMethod === "existing" ? (
            <p className="muted">
              {uiText("В action формы укажите адрес выше. Поля: name, phone, message, company. Скрытое поле website оставьте пустым — оно отсекает спам.")}</p>
          ) : null}
          {formMethod === "tilda" ? (
            <p className="muted">
              {uiText("В Tilda: Настройки сайта → Формы → Webhook. Укажите адрес выше и поля name, phone, message.")}</p>
          ) : null}
          <p className="muted">
            {uiText("Режим заявок:")}{" "}
            {formCard?.testMode || setup?.form?.testMode ? (
              <b>{uiText("тестовый")}</b>
            ) : (
              <b>{uiText("обычный")}</b>
            )}
            {uiText(". Телефон обязателен.")}</p>
          {(formCard?.integrationId || setup?.form?.integrationId) && (formCard?.testMode || setup?.form?.testMode) ? (
            <button
              type="button"
              className="btn"
              onClick={async () => {
                try {
                  const id = formCard?.integrationId || setup?.form?.integrationId;
                  const result = (await api.setIntegrationTestMode(id, false)) as any;
                  setNote(result.note || uiText("Заявки теперь обычные"));
                  await load();
                } catch (err) {
                  setError(err instanceof Error ? err.message : uiText("Не удалось сменить режим"));
                }
              }}
            >
              {uiText("Сделать заявки обычными")}</button>
          ) : null}
          {(formCard?.integrationId || setup?.form?.integrationId) && !(formCard?.testMode || setup?.form?.testMode) ? (
            <button
              type="button"
              className="btn secondary"
              onClick={async () => {
                try {
                  const id = formCard?.integrationId || setup?.form?.integrationId;
                  const result = (await api.setIntegrationTestMode(id, true)) as any;
                  setNote(result.note || uiText("Включён тестовый режим"));
                  await load();
                } catch (err) {
                  setError(err instanceof Error ? err.message : uiText("Не удалось сменить режим"));
                }
              }}
            >
              {uiText("Включить тестовый режим")}</button>
          ) : null}
        </div>
      ) : null}

        </IntegrationDisclosure>
        <IntegrationDisclosure id="esf" icon="esf" title={uiText("ИС ЭСФ")} description={uiText("Электронные счета-фактуры и ЭЦП")} {...esfSummary}>
      <h3 className="integ-section-title">{uiText("Документы и ИС ЭСФ")}</h3>
      <div className="integ-grid">
        <div className="panel integ-card">
          <div className="integ-card-head">
            <b>{uiText("ИС ЭСФ")}</b>
            <span className="badge warn">NCALayer</span>
          </div>
          <p className="muted">{uiText("Подключение кабинета через ЭЦП на этом компьютере. PIN ключа на сервер не передаётся.")}</p>
          <Link className="btn" to="/integrations/esf">
            {uiText("Открыть ИС ЭСФ")}</Link>
          <IntegrationHelp kind="esf" />
        </div>
      </div>

        </IntegrationDisclosure>
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
          {leadDetails("WEBHOOK_API")}
        </IntegrationDisclosure>
        <IntegrationDisclosure id="notifications" icon="notification" title={uiText("Telegram сотрудника")} description={uiText("Личные уведомления о работе")} {...summary(catalog?.notifications?.employeeTelegram)}>
      {
        <>
          <h3 className="integ-section-title">{uiText("Уведомления")}</h3>
          <div className="panel">
            <b>{uiText("Telegram сотрудника")}</b>
            <IntegrationHelp kind="employee_telegram" />
            <p className="muted">{uiText("Личные уведомления. Это не заявки с сайта.")}</p>
            {!telegramReady ? <p className="muted">{uiText("Администратору сервиса нужно настроить Telegram-бота для уведомлений.")}</p> : null}
            <button
              className="btn"
              disabled={!telegramReady}
              onClick={async () => {
                const result = await api.beginTelegram();
                setTelegram(result);
              }}
            >
              {uiText("Подключить Telegram")}</button>
            {telegram ? (
              <p>
                {telegram.deepLink ? (
                  <a href={telegram.deepLink} target="_blank" rel="noreferrer">
                    {uiText("Открыть бота")}</a>
                ) : (
                  uiText("Откройте бота и отправьте /start.")
                )}
              </p>
            ) : null}
            <p className="muted" style={{ marginTop: 8 }}>
              {uiText("Также:")}{" "}<Link to="/settings">{uiText("Настройки")}</Link>
            </p>
          </div>
        </>
      }
        </IntegrationDisclosure>
      </div>
    </section>
  );
}
