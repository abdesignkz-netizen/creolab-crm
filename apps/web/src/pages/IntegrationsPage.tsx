import { notifySaved } from "../components/SaveNotice";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { statusBadgeClass } from "../lib/statusBadge";

type ConnectMethod = "html" | "existing" | "js" | "tilda";

function whatsappStatusNote(wa: any) {
  if (!wa?.configured) return "Укажите Instance ID и API Token из личного кабинета Green API.";
  if (wa.reachable) {
    if (typeof wa.leadCountOnBot === "number") {
      return `На WhatsApp ${wa.leadCountOnBot} переписок · в CRM ${wa.conversationCount ?? 0} диалогов.`;
    }
    return "WhatsApp подключён.";
  }
  return "WhatsApp не отвечает. Проверьте Instance ID и API Token или обратитесь в поддержку.";
}

export function IntegrationsPage() {
  const [editingWhatsApp, setEditingWhatsApp] = useState(false);
  const [savingWhatsApp, setSavingWhatsApp] = useState(false);
  const [catalog, setCatalog] = useState<any>(null);
  const [setup, setSetup] = useState<any>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [formMethod, setFormMethod] = useState<ConnectMethod>("html");
  const [telegram, setTelegram] = useState<any>(null);

  async function load() {
    setError("");
    try {
      const [c, s] = await Promise.all([api.integrationCatalog(), api.integrationSetup()]);
      setCatalog(c);
      setSetup(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка загрузки");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (!catalog && !setup && !error) return <div className="state">Загрузка…</div>;
  if (!catalog && !setup) {
    return (
      <section>
        <p className="error">{error}</p>
        <button className="btn" onClick={() => void load()}>
          Повторить
        </button>
      </section>
    );
  }

  const formCard = catalog?.leads?.find((i: any) => i.catalogType === "WEBSITE_FORM");
  const submitUrl = formCard?.submitUrl || setup?.form?.submitUrl;
  const leadCards = (catalog?.leads || []).filter(
    (card: any) => card.catalogType === "WEBSITE_FORM" || (card.connected && card.catalogType !== "WEBHOOK_API"),
  );
  const telegramReady = Boolean(setup?.telegram?.employee?.botConfigured);
  const whatsappSender =
    setup?.whatsapp?.sender && !/\.js$/i.test(String(setup.whatsapp.sender)) ? setup.whatsapp.sender : null;

  return (
    <section className="integrations-page">
      <div className="page-head">
        <div>
          <h2>Интеграции</h2>
          <p className="muted">Форма сайта, WhatsApp и кабинет ИС ЭСФ.</p>
          <p className="muted">Подключение каналов доступно после активации тарифа. Сейчас можно изучить интерфейс.</p>
        </div>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {note ? <p className="ok">{note}</p> : null}

      <h3 className="integ-section-title">Приём заявок и обращений</h3>
      <div className="integ-grid">
        {(leadCards).map((card: any) => (
          <div className="panel integ-card" key={card.catalogType}>
            <div className="integ-card-head">
              <b>{card.title}</b>
              <span className={statusBadgeClass(card.healthLabel)}>{card.healthLabel}</span>
            </div>
            {card.connected ? (
              <>
                <p className="muted">
                  {card.inquiryCount != null ? `${card.inquiryCount} заявок` : null}
                </p>
                {card.integrationId ? (
                  <button
                    type="button"
                    className="btn secondary"
                    onClick={async () => {
                      try {
                        const result = await api.integrationHealthCheck(card.integrationId) as { healthLabel: string };
                        setNote(`Проверка «${card.title}»: ${result.healthLabel}`);
                      } catch (err) {
                        setError(err instanceof Error ? err.message : "Проверка не выполнена");
                      }
                    }}
                  >
                    Проверить подключение
                  </button>
                ) : null}
              </>
            ) : (
              <p className="muted">{card.note || "Не подключено"}</p>
            )}
          </div>
        ))}
      </div>

      {setup?.form?.connected && submitUrl ? (
        <div className="panel">
          <h3>Форма сайта — подключение</h3>
          <p className="muted">Адрес для заявок: {submitUrl}</p>
          <div className="actions" style={{ marginBottom: 12 }}>
            {(
              [
                ["html", "Готовая HTML-форма"],
                ["existing", "Существующая форма"],
                ["js", "JavaScript / React"],
                ["tilda", "Tilda / конструктор"],
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
              <p className="muted">Готовый HTML. Дополнительных ключей не нужно.</p>
              <pre className="code">{`<form method="POST" action="${submitUrl}">
  <input name="name" required />
  <input name="phone" required />
  <input name="company" />
  <textarea name="message"></textarea>
  <input name="utm_source" type="hidden" />
  <input name="pageUrl" type="hidden" />
  <input name="website" style="display:none" tabindex="-1" autocomplete="off" />
  <button type="submit">Отправить</button>
</form>`}</pre>
            </>
          ) : null}
          {formMethod === "js" ? (
            <>
              <p className="muted">Отправка заявки из кода сайта.</p>
              <pre className="code">{`await fetch("${submitUrl}", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Submission-Id": crypto.randomUUID(),
  },
  body: JSON.stringify({
    name: "Имя",
    phone: "+7701...",
    message: "Текст",
    pageUrl: location.href,
    utm_source: new URLSearchParams(location.search).get("utm_source"),
  }),
});`}</pre>
            </>
          ) : null}
          {formMethod === "existing" ? (
            <p className="muted">
              В action формы укажите адрес выше. Поля: name, phone, message, company. Скрытое поле website оставьте пустым — оно отсекает спам.
            </p>
          ) : null}
          {formMethod === "tilda" ? (
            <p className="muted">
              В Tilda: Настройки сайта → Формы → Webhook. Укажите адрес выше и поля name, phone, message.
            </p>
          ) : null}
          <p className="muted">
            Режим заявок:{" "}
            {formCard?.testMode || setup?.form?.testMode ? (
              <b>тестовый</b>
            ) : (
              <b>обычный</b>
            )}
            . Телефон обязателен.
          </p>
          {(formCard?.integrationId || setup?.form?.integrationId) && (formCard?.testMode || setup?.form?.testMode) ? (
            <button
              type="button"
              className="btn"
              onClick={async () => {
                try {
                  const id = formCard?.integrationId || setup?.form?.integrationId;
                  const result = (await api.setIntegrationTestMode(id, false)) as any;
                  setNote(result.note || "Заявки теперь обычные");
                  await load();
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Не удалось сменить режим");
                }
              }}
            >
              Сделать заявки обычными
            </button>
          ) : null}
          {(formCard?.integrationId || setup?.form?.integrationId) && !(formCard?.testMode || setup?.form?.testMode) ? (
            <button
              type="button"
              className="btn secondary"
              onClick={async () => {
                try {
                  const id = formCard?.integrationId || setup?.form?.integrationId;
                  const result = (await api.setIntegrationTestMode(id, true)) as any;
                  setNote(result.note || "Включён тестовый режим");
                  await load();
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Не удалось сменить режим");
                }
              }}
            >
              Включить тестовый режим
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="panel">
        <h3>WhatsApp</h3>
        {setup?.whatsapp?.warning ? <div className="banner warn">{setup.whatsapp.warning}</div> : null}
        <p className="muted">{whatsappStatusNote(setup?.whatsapp)}</p>
        <p className="muted">Как бот отвечает клиентам, задаёт администратор сервиса: промт и база знаний компании.</p>
        <p className="integ-status-line">
          Статус подключения
          <span className={statusBadgeClass(setup?.whatsapp?.configured ? "Подключён" : "Не подключён")}>
            {setup?.whatsapp?.configured ? "Подключён" : "Не подключён"}
          </span>
        </p>
        <p className="integ-status-line">
          AI-менеджер
          {setup?.whatsapp?.reachable ? (
            <span className="badge ok">Активен</span>
          ) : setup?.whatsapp?.configured ? (
            <span className="badge warn">Не отвечает</span>
          ) : (
            <span className="badge">Ожидает подключение</span>
          )}
        </p>
        {whatsappSender ? <p>WhatsApp · {whatsappSender}</p> : null}
        <p className="muted">Диалоги · {setup?.whatsapp?.conversationCount ?? 0}</p>
        <p className="muted">
          Последняя синхронизация ·{" "}
          {setup?.whatsapp?.lastSyncAt ? new Date(setup.whatsapp.lastSyncAt).toLocaleString("ru-RU") : "ещё не было"}
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
                    ? "WhatsApp подключён."
                    : "Сохранено. Подключение пока не подтверждено. Проверьте Instance ID и API Token.",
                );
                setEditingWhatsApp(false);
                notifySaved("WhatsApp подключён");
                await load();
              } catch (err) {
                setError(err instanceof Error ? err.message : "Не удалось сохранить");
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
              <input name="apiToken" type="password" autoComplete="off" placeholder={setup?.whatsapp?.configured ? "оставьте пустым, чтобы не менять" : ""} required={!setup?.whatsapp?.configured} />
            </label>
            <div className="actions">
              <button className="btn" disabled={savingWhatsApp}>{savingWhatsApp ? "Подключаем…" : "Подключить"}</button>
              <button type="button" className="btn secondary" onClick={() => setEditingWhatsApp(false)}>Отмена</button>
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
                setNote("Проверка подключения выполнена.");
              } catch (err) {
                setError(err instanceof Error ? err.message : "Проверка не выполнена");
              }
            }}
          >
            Проверить подключение
          </button>
          <button type="button" className="btn secondary" onClick={() => setEditingWhatsApp(true)}>
            {setup?.whatsapp?.configured ? "Переподключить" : "Подключить"}
          </button>
          {setup?.whatsapp?.configured ? (
            <button
              type="button"
              className="btn secondary"
              onClick={async () => {
                try {
                  const result = (await api.disconnectWhatsApp()) as any;
                  setNote(result.note || "WhatsApp отключён.");
                  notifySaved("WhatsApp отключён");
                  await load();
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Не удалось отключить");
                }
              }}
            >
              Отключить
            </button>
          ) : null}
          <button
            type="button"
            className="btn secondary"
            onClick={async () => {
              try {
                const result = (await api.syncWhatsApp()) as any;
                setNote(
                  result.note ||
                    `Синхронизация: новых ${result.imported}, обновлено ${result.updated}.`,
                );
              } catch (err) {
                setError(err instanceof Error ? err.message : "Синхронизация не выполнена");
              }
            }}
          >
            Забрать диалоги из бота
          </button>
        </div>
      </div>

      <h3 className="integ-section-title">Документы и ИС ЭСФ</h3>
      <div className="integ-grid">
        <div className="panel integ-card">
          <div className="integ-card-head">
            <b>ИС ЭСФ</b>
            <span className="badge warn">NCALayer</span>
          </div>
          <p className="muted">Подключение кабинета через ЭЦП на этом компьютере. PIN ключа на сервер не передаётся.</p>
          <Link className="btn" to="/integrations/esf">
            Открыть ИС ЭСФ
          </Link>
        </div>
      </div>

      {telegramReady ? (
        <>
          <h3 className="integ-section-title">Уведомления</h3>
          <div className="panel">
            <b>Telegram сотрудника</b>
            <p className="muted">Личные уведомления. Это не заявки с сайта.</p>
            <button
              className="btn"
              onClick={async () => {
                const result = await api.beginTelegram();
                setTelegram(result);
              }}
            >
              Подключить Telegram
            </button>
            {telegram ? (
              <p>
                {telegram.deepLink ? (
                  <a href={telegram.deepLink} target="_blank" rel="noreferrer">
                    Открыть бота
                  </a>
                ) : (
                  "Откройте бота и отправьте /start."
                )}
              </p>
            ) : null}
            <p className="muted" style={{ marginTop: 8 }}>
              Также: <Link to="/settings">Настройки</Link>
            </p>
          </div>
        </>
      ) : null}
    </section>
  );
}
