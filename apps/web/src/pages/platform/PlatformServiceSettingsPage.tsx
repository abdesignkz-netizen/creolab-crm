import { useEffect, useState, type FormEvent } from "react";
import { api } from "../../lib/api";
import { notifySaved } from "../../components/SaveNotice";

export function PlatformServiceSettingsPage() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.adminSettings().then(setData).catch((err) => setError(err instanceof Error ? err.message : "Ошибка"));
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <div className="state">Загрузка…</div>;

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
      notifySaved("Настройки сервиса сохранены");
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    }
  }

  return (
    <form className="panel stack" onSubmit={onSubmit}>
      <h2>Настройки сервиса</h2>
      <p className="muted">Значения по умолчанию для новых и существующих компаний, пока они не переопределены. Ключи БД, JWT и ENCRYPTION_KEY здесь не редактируются.</p>
      <h4>AI по умолчанию</h4>
      <label className="check"><input type="checkbox" name="aiEnabled" defaultChecked={data.ai?.enabled} /> AI включён на уровне сервиса</label>
      <label>Провайдер<input name="provider" defaultValue={data.ai?.provider || ""} /></label>
      <label>Модель<input name="model" defaultValue={data.ai?.model || ""} /></label>
      <h4>Функции по умолчанию</h4>
      {(["forms", "webhook", "whatsapp", "documents", "aiFeature", "esf"] as const).map((key) => (
        <label key={key} className="check">
          <input type="checkbox" name={key === "aiFeature" ? "aiFeature" : key} defaultChecked={Boolean(data.features?.[key === "aiFeature" ? "ai" : key])} />
          {key === "aiFeature" ? "ai" : key}
        </label>
      ))}
      <label>Лимит участников по умолчанию<input name="members" type="number" defaultValue={data.limits?.members || 20} /></label>
      {error ? <p className="error">{error}</p> : null}
      <button className="btn">Сохранить</button>
    </form>
  );
}
