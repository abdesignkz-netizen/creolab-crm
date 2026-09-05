import { useEffect, useState } from "react";
import { api } from "../lib/api";

export function IntegrationsPage() {
  const [setup, setSetup] = useState<any>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [telegram, setTelegram] = useState<any>(null);

  async function load() {
    setError("");
    try {
      setSetup(await api.integrationSetup());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка загрузки");
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (!setup && !error) return <div className="state">Загрузка…</div>;
  if (!setup) {
    return (
      <section>
        <p className="error">{error}</p>
        <button className="btn" onClick={load}>Повторить</button>
      </section>
    );
  }

  return (
    <section>
      <h2>Интеграции</h2>
      <p className="muted">Подключения настраиваются здесь. Ядро CRM работает и без WhatsApp.</p>
      {error ? <p className="error">{error}</p> : null}
      {note ? <p className="card">{note}</p> : null}

      <div className="card">
        <b>WhatsApp ИИ-менеджер</b>
        <p className="muted">{setup.whatsapp.note}</p>
        <p>
          Подключено: {setup.whatsapp.configured ? "да" : "нет"} · Мост:{" "}
          {setup.whatsapp.reachable ? "отвечает" : "нет"}
        </p>
        {setup.whatsapp.leadCountOnBot !== null && setup.whatsapp.leadCountOnBot !== undefined ? (
          <p>
            На боте {setup.whatsapp.leadCountOnBot} лидов · в CRM {setup.whatsapp.conversationCount ?? 0} диалогов
            {setup.whatsapp.storePathKind === "ephemeral" ? " · хранилище бота временное" : ""}
          </p>
        ) : null}
        <form
          className="panel"
          onSubmit={async (event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            try {
              const result = (await api.connectWhatsApp(
                String(form.get("sellerUrl")),
                String(form.get("secret")),
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
              defaultValue={setup.whatsapp.sellerUrl || "https://creolab-ai-manager.onrender.com"}
              required
              placeholder="https://creolab-ai-manager.onrender.com"
            />
          </label>
          <label>
            Секрет моста (тот же, что CRM_BRIDGE_SECRET у бота)
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
                  setNote(
                    [
                      `Синхронизация: новых ${result.imported}, обновлено ${result.updated}, без телефона ${result.needsPhone} из ${result.total}.`,
                      result.note,
                    ]
                      .filter(Boolean)
                      .join(" "),
                  );
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Синхронизация не выполнена");
                }
              }}
            >
              Забрать диалоги из бота
            </button>
          </div>
        </form>
        <p className="muted">
          Укажите адрес боевого бота, не localhost. Green API webhook не переключайте на CRM.
          Чтобы история лидов переживала деплой Render, нужен диск `/var/data` и `DATA_DIR=/var/data`.
          Без диска `leads.json` обнуляется, хотя чаты WhatsApp у клиентов остаются.
        </p>
      </div>

      <div className="card">
        <b>Форма сайта</b>
        {setup.form.connected ? (
          <>
            <p>Приём: {setup.form.submitUrl}</p>
            <pre className="code">{`<form action="${setup.form.submitUrl}" method="post">
  <input name="name" required />
  <input name="phone" required />
  <textarea name="message"></textarea>
  <input name="website" style="display:none" />
</form>`}</pre>
            <p className="muted">Телефон обязателен. WhatsApp из формы сам не пишется.</p>
          </>
        ) : (
          <p>Форма ещё не создана.</p>
        )}
      </div>

      <div className="card">
        <b>Серверный webhook</b>
        {setup.webhook.connected ? (
          <>
            <p>POST {setup.webhook.eventsUrl}</p>
            <p className="muted">Заголовки: Authorization Bearer, X-CRM-Timestamp, X-CRM-Signature</p>
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
          </>
        ) : (
          <p>Webhook не найден. Он создаётся seed-ом первой компании.</p>
        )}
      </div>

      <div className="card">
        <b>Telegram сотрудника</b>
        <p className="muted">{setup.telegram.employee.note}</p>
        <p className="muted">{setup.telegram.siteLeads.note}</p>
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
      </div>

      <div className="card">
        <b>Instagram и прочее</b>
        <p className="muted">{setup.instagram.note}</p>
      </div>
    </section>
  );
}
