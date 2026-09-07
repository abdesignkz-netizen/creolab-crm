import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";

type ConnectMethod = "html" | "existing" | "js" | "tilda";

export function IntegrationsPage() {
  const [catalog, setCatalog] = useState<any>(null);
  const [setup, setSetup] = useState<any>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [telegram, setTelegram] = useState<any>(null);
  const [formMethod, setFormMethod] = useState<ConnectMethod>("html");
  const [health, setHealth] = useState<any>(null);

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
  const webhookCard = catalog?.leads?.find((i: any) => i.catalogType === "WEBHOOK_API");
  const submitUrl = formCard?.submitUrl || setup?.form?.submitUrl;

  return (
    <section className="integrations-page">
      <div className="page-head">
        <div>
          <h2>Интеграции</h2>
          <p className="muted">Приём заявок и обращений. WhatsApp — отдельно; клиентский Telegram/Instagram — следующие этапы.</p>
        </div>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {note ? <p className="ok">{note}</p> : null}
      {setup?.fileStorage?.warning ? <p className="error">{setup.fileStorage.warning}</p> : null}

      <h3 className="integ-section-title">Приём заявок и обращений</h3>
      <div className="integ-grid">
        {(catalog?.leads || []).map((card: any) => (
          <div className="panel integ-card" key={card.catalogType}>
            <div className="integ-card-head">
              <b>{card.title}</b>
              <span className={`badge ${card.connected ? "" : "warn"}`}>{card.healthLabel}</span>
            </div>
            {card.connected ? (
              <>
                <p className="muted">
                  {card.inquiryCount != null ? `${card.inquiryCount} заявок` : null}
                  {card.eventCount != null ? ` · ${card.eventCount} событий` : null}
                </p>
                <p className="muted">AI: {card.automationLabel}</p>
                {card.integrationId ? (
                  <button
                    type="button"
                    className="btn secondary"
                    onClick={async () => {
                      try {
                        const result = await api.integrationHealthCheck(card.integrationId) as { healthLabel: string };
                        setHealth(result);
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
          <p className="muted">Endpoint: {submitUrl}</p>
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
              <p className="muted">Обычный HTML POST. Секрет API в HTML не нужен.</p>
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
              <p className="muted">Для fetch нужна CORS (уже включена на endpoint) и JSON/urlencoded.</p>
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
              Поставьте action формы на endpoint выше. Имена полей: name, phone, message, company — или настройте
              mapping в integration.mappingJson (versioned). Honeypot: скрытое поле website.
            </p>
          ) : null}
          {formMethod === "tilda" ? (
            <p className="muted">
              В Tilda: Webhook / свой endpoint → POST на {submitUrl}. Передайте name, phone, message. UTM и pageUrl —
              скрытыми полями. Файлы (multipart) — на следующем этапе.
            </p>
          ) : null}
          <p className="muted">
            Режим заявок:{" "}
            {formCard?.testMode || setup?.form?.testMode ? (
              <b>тестовый</b>
            ) : (
              <b>обычный (боевой)</b>
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

      {setup?.webhook?.connected ? (
        <div className="panel">
          <h3>Webhook / API</h3>
          <p>POST {setup.webhook.eventsUrl}</p>
          <p className="muted">
            Authorization: Bearer SECRET · X-CRM-Timestamp · X-CRM-Signature = HMAC-SHA256(secret, timestamp + "." +
            rawBody). Replay window 5 мин. Idempotency: event_id.
          </p>
          <button
            className="btn secondary"
            onClick={async () => {
              const result = (await api.rotateWebhook(setup.webhook.id)) as any;
              setWebhookSecret(result.secret);
              setNote(result.note);
            }}
          >
            Выдать новый секрет
          </button>
          {webhookSecret ? <pre className="code">{webhookSecret}</pre> : null}
        </div>
      ) : null}

      <div className="panel">
        <h3>WhatsApp AI Manager</h3>
        <p className="muted">{setup?.whatsapp?.note}</p>
        <p>
          Подключено: {setup?.whatsapp?.configured ? "да" : "нет"} · Мост:{" "}
          {setup?.whatsapp?.reachable ? "отвечает" : "нет"}
        </p>
        <form
          className="stack"
          onSubmit={async (event) => {
            event.preventDefault();
            const formEl = new FormData(event.currentTarget);
            try {
              const result = (await api.connectWhatsApp(
                String(formEl.get("sellerUrl")),
                String(formEl.get("secret")),
              )) as any;
              setNote(result.note);
              await load();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Не удалось сохранить");
            }
          }}
        >
          <label>
            Адрес бота
            <input
              name="sellerUrl"
              defaultValue={setup?.whatsapp?.sellerUrl || "https://creolab-ai-manager.onrender.com"}
              required
            />
          </label>
          <label>
            Секрет моста
            <input name="secret" type="password" required placeholder="не показывается повторно" />
          </label>
          <div className="actions">
            <button className="btn">Сохранить и проверить</button>
            <button
              type="button"
              className="btn secondary"
              onClick={async () => {
                try {
                  const result = (await api.syncWhatsApp()) as any;
                  setNote(`Синхронизация: новых ${result.imported}, обновлено ${result.updated}.`);
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Синхронизация не выполнена");
                }
              }}
            >
              Забрать диалоги из бота
            </button>
          </div>
        </form>
      </div>

      <h3 className="integ-section-title">Messaging (следующие этапы)</h3>
      <div className="integ-grid">
        {(catalog?.messaging || []).map((card: any) => (
          <div className="panel integ-card" key={card.catalogType}>
            <b>{card.title}</b>
            <p className="muted">{card.note}</p>
            <span className="badge warn">{card.healthLabel}</span>
          </div>
        ))}
      </div>

      <h3 className="integ-section-title">Уведомления</h3>
      <div className="panel">
        <b>Telegram сотрудника</b>
        <p className="muted">{catalog?.notifications?.employeeTelegram?.note || setup?.telegram?.employee?.note}</p>
        <p className="muted">{setup?.telegram?.employee?.note}</p>
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
              telegram.note
            )}
          </p>
        ) : null}
        <p className="muted" style={{ marginTop: 8 }}>
          Также: <Link to="/settings">Настройки</Link> · это не источник заявок.
        </p>
      </div>

      <h3 className="integ-section-title">Журнал событий</h3>
      <div className="panel">
        {(catalog?.eventLog || []).length === 0 ? <p className="muted">Пока пусто</p> : null}
        <div className="timeline">
          {(catalog?.eventLog || []).slice(0, 20).map((e: any) => (
            <div className="timeline-item" key={e.id}>
              <div className="muted">{new Date(e.at).toLocaleString("ru-RU")}</div>
              <b>
                {e.integrationName} · {e.eventType}
              </b>
              <div className="muted">
                {e.statusLabel}
                {e.test ? " · тест" : ""}
                {e.error ? ` · ${e.error}` : ""}
              </div>
            </div>
          ))}
        </div>
      </div>

      {health ? (
        <div className="panel soft">
          <b>Результат проверки</b>
          <ul>
            {(health.checks || []).map((c: any) => (
              <li key={c.key}>
                {c.ok ? "✓" : "✕"} {c.label}
                {c.detail ? ` — ${c.detail}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
