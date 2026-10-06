import { uiText, useUiText, localizeUiOptions } from "../../lib/uiText";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../../lib/api";
import { notifySaved } from "../../components/SaveNotice";

export function PlatformServiceSettingsPage() {
  const uiText = useUiText();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.adminSettings().then(setData).catch((err) => setError(err instanceof Error ? err.message : uiText("Ошибка")));
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <div className="state">{uiText("Загрузка…")}</div>;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      setData(await api.adminUpdateSettings({
        ai: {
          enabled: form.get("aiEnabled") === "on",
          provider: String(form.get("provider") || ""),
          model: String(form.get("model") || ""),
        },
        features: {
          forms: form.get("forms") === "on",
          webhook: form.get("webhook") === "on",
          whatsapp: form.get("whatsapp") === "on",
          documents: form.get("documents") === "on",
          ai: form.get("aiFeature") === "on",
          esf: form.get("esf") === "on",
        },
        limits: { members: Number(form.get("members") || 20) },
      }));
      notifySaved(uiText("Настройки сервиса сохранены"));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Ошибка"));
    }
  }

  return (
    <form className="panel stack" onSubmit={onSubmit}>
      <h2>{uiText("Настройки сервиса")}</h2>
      <p className="muted">{uiText("Значения по умолчанию для новых и существующих компаний, пока они не переопределены. Ключи БД, JWT и ENCRYPTION_KEY здесь не редактируются.")}</p>
      <h4>{uiText("AI по умолчанию")}</h4>
      <label className="check"><input type="checkbox" name="aiEnabled" defaultChecked={data.ai?.enabled} /> {" "}{uiText("AI включён на уровне сервиса")}</label>
      <label>{uiText("Провайдер")}<input name="provider" defaultValue={data.ai?.provider || ""} /></label>
      <label>{uiText("Модель")}<input name="model" defaultValue={data.ai?.model || ""} /></label>
      <section className="panel stack">
        <h4>{uiText("Распознавание голосовых сообщений")}</h4>
        <p>{uiText("Аудио сначала преобразуется в текст отдельным сервисом. Затем ИИ-менеджер обрабатывает текст с промптом и базой знаний компании.")}</p>
        <strong>{data.transcription?.configured ? uiText("Настройки распознавания заданы") : uiText("Нужно настроить сервис распознавания")}</strong>
        {data.transcription?.configured ? <p className="muted">{uiText("Провайдер")}: {data.transcription.provider} · {uiText("Модель")}: {data.transcription.model}</p> : null}
        <p className="muted">{data.transcription?.engine === "local"
          ? uiText("Аудио распознаётся локально на сервере BasQar. API-ключ для распознавания не нужен. Модель ИИ-менеджера выбирается отдельно.")
          : uiText("Настройки задаются на сервере отдельно от модели ИИ-менеджера: TRANSCRIPTION_API_KEY, TRANSCRIPTION_BASE_URL, TRANSCRIPTION_MODEL.")}</p>
        {data.transcription?.engine === "local" ? <p className="muted">{uiText("Для распознавания нужно не менее 2 ГиБ свободной памяти. Одна запись — до двух минут; записи обрабатываются по очереди.")}</p> : null}
        <p className="muted">{uiText("Наличие настроек не подтверждает доступность сервиса. Результаты запросов отображаются в разделе «Расход AI».")}</p>
      </section>
      <h4>{uiText("Функции по умолчанию")}</h4>
      {(["forms", "webhook", "whatsapp", "documents", "aiFeature", "esf"] as const).map((key) => (
        <label key={key} className="check">
          <input type="checkbox" name={key === "aiFeature" ? "aiFeature" : key} defaultChecked={Boolean(data.features?.[key === "aiFeature" ? "ai" : key])} />
          {key === "aiFeature" ? "ai" : key}
        </label>
      ))}
      <label>{uiText("Лимит участников по умолчанию")}<input name="members" type="number" defaultValue={data.limits?.members || 20} /></label>
      {error ? <p className="error">{error}</p> : null}
      <button className="btn">{uiText("Сохранить")}</button>
    </form>
  );
}
