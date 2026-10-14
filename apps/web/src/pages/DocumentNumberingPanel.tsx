import { InlineFeedback } from "../components/InlineFeedback";
import { systemText } from "@creolab/contracts";
import { useLocale, useEsfEnabled } from "../lib/session";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { notifySaved } from "../components/SaveNotice";

const types = [["DOG", "Договоры"], ["INV", "Счета на оплату"], ["AVR", "АВР"], ["ESF", "ЭСФ"]] as const;
type Settings = Record<string, { start: number; next: number; example: string }>;
export function DocumentNumberingPanel() {
  const locale = useLocale();
  const esfEnabled = useEsfEnabled();
  const visibleTypes = types.filter(([type]) => esfEnabled || type !== "ESF");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  function apply(data: Settings) {
    setSettings(data);
    setValues(Object.fromEntries(visibleTypes.map(([type]) => [type, String(data[type]?.start || 1)])));
  }
  useEffect(() => {
    let active = true;
    void api.request<Settings>("/api/v1/settings/document-numbering").then(data => {
      if (!active) return;
      setSettings(data);
      setValues(current => Object.fromEntries(visibleTypes.map(([type]) => [type, current[type] ?? String(data[type]?.start || 1)])));
    }).catch(e => { if (active) setError(locale === "kk" ? systemText(locale, "Не удалось загрузить данные. Повторите попытку.") : e.message); });
    return () => { active = false; };
  }, [esfEnabled]);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const input = Object.fromEntries(visibleTypes.map(([type]) => [type, Number(values[type])]));
      if (Object.values(input).some(value => !Number.isInteger(value) || value < 1 || value > 999999999)) throw new Error(systemText(locale, "Укажите целые номера от 1 до 999999999"));
      apply(await api.request<Settings>("/api/v1/settings/document-numbering", { method: "PATCH", body: JSON.stringify(input) }));
      notifySaved(systemText(locale, "Нумерация документов сохранена"));
    } catch (e) { setError(locale !== "kk" && e instanceof Error ? e.message : systemText(locale, "Не удалось сохранить нумерацию")); }
    finally { setBusy(false); }
  }
  return <form className="panel" id="document-numbering" onSubmit={event => void save(event)}>
    <h3>{systemText(locale, "Нумерация документов")}</h3>
    <p className="muted">{systemText(locale, "Укажите, с какого числа начинается нумерация каждого типа документов. Уже созданные документы сохранят свои номера. Если номера уже выдавались, отсчёт продолжится после последнего номера. Удаление документа не сбрасывает счётчик.")}</p>
    {error ? <InlineFeedback kind="error" className="error">{error}</InlineFeedback> : null}
    {settings ? <><div className="deal-edit">{visibleTypes.map(([type, label]) => <label key={type}>{systemText(locale, "{type} — начальный номер", { type: systemText(locale, label) })}
      <input type="number" min="1" max="999999999" step="1" required disabled={busy} value={values[type] || ""} onChange={event => setValues(current => ({ ...current, [type]: event.target.value }))} />
      <span className="muted">{systemText(locale, "Следующий по сохранённым настройкам: {number}", { number: settings[type]?.example || "" })}</span>
    </label>)}</div><button type="submit" className="btn" disabled={busy}>{busy ? systemText(locale, "Сохраняем…") : systemText(locale, "Сохранить нумерацию")}</button></> : <p>{error ? systemText(locale, "Обновите страницу для повторной загрузки.") : systemText(locale, "Загружаем нумерацию…")}</p>}
  </form>;
}
