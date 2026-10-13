import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { InlineFeedback } from "../components/InlineFeedback";
import { ChannelAiControl } from "../components/ChannelAiControl";
import { useUiText } from "../lib/uiText";
type Settings = { enabled: boolean; origins: string[]; title: string; greeting: string; color: string };
type Item = { id: string; connected: boolean; snippet: string; settings: Settings };
export function WebsiteChatPanel({ onChange }: { onChange: () => void }) {
  const t = useUiText();
  const [item, setItem] = useState<Item | null>(null), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(""), [note, setNote] = useState("");
  const [form, setForm] = useState<Settings>({ enabled: true, origins: [], title: "Помощник компании", greeting: "Здравствуйте! Чем можем помочь?", color: "#0065ca" });
  const [sites, setSites] = useState("");
  useEffect(() => { void api.websiteChat().then(result => { const row = (result as { item: Item | null }).item; setItem(row); if(row) { setForm({ ...row.settings, enabled: row.connected }); setSites(row.settings.origins.join("\n")); } }).catch(err => setError(err.message)).finally(() => setLoading(false)); }, []);
  if(loading) return <p>{t("Загрузка…")}</p>;
  return <div className="panel">
    <h3>{t("Чат на вашем сайте")}</h3><p className="muted">{t("Посетитель пишет прямо на сайте. ИИ или сотрудник отвечает из BasQar, история сохраняется в «Диалогах». Начать общение можно без номера телефона.")}</p>
    <form onSubmit={async event => { event.preventDefault(); setBusy(true); setError(""); setNote(""); try { const result = await api.saveWebsiteChat({ ...form, origins: sites.split(/\s+/).filter(Boolean) }) as { item: Item }; setItem(result.item); setForm(result.item.settings); onChange(); setNote(t("Настройки сохранены. Установите код на сайт и отправьте пробное сообщение.")); } catch(err) { setError(err instanceof Error ? err.message : t("Не удалось сохранить")); } finally { setBusy(false); } }}>
      <label>{t("1. Адрес вашего сайта")}<textarea required rows={2} placeholder="https://company.kz" value={sites} onChange={event => setSites(event.target.value)}/><span className="muted">{t("Укажите HTTPS-адрес без пути. Каждый сайт — с новой строки; адрес с www добавьте отдельно.")}</span></label>
      <div className="form-grid"><label>{t("Название чата")}<input required maxLength={60} value={form.title} onChange={event => setForm({ ...form, title: event.target.value })}/></label><label>{t("Цвет кнопки")}<input aria-label={t("Цвет кнопки")} type="color" value={form.color} onChange={event => setForm({ ...form, color: event.target.value })}/></label></div>
      <label>{t("Приветствие посетителю")}<textarea required rows={2} maxLength={500} value={form.greeting} onChange={event => setForm({ ...form, greeting: event.target.value })}/></label>
      <label className="check-row"><input type="checkbox" checked={form.enabled} onChange={event => setForm({ ...form, enabled: event.target.checked })}/>{t("Показывать чат на сайте")}</label>
      <button className="btn" disabled={busy}>{t(busy ? "Сохраняем…" : item ? "Сохранить изменения" : "Создать чат")}</button>
    </form>
    {error && <InlineFeedback kind="error">{error}</InlineFeedback>}{note && <InlineFeedback kind="success">{note}</InlineFeedback>}
    {item && <><hr/><h3>{t("2. Установите код на сайт")}</h3><p className="muted">{t("Добавьте эту строку перед закрывающим тегом </body> или в раздел пользовательского кода конструктора сайта. Настройки оформления обновляются без замены кода.")}</p><pre className="code" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{item.snippet}</pre><button className="btn secondary" type="button" onClick={async () => { try { await navigator.clipboard.writeText(item.snippet); setNote(t("Код скопирован")); } catch { setError(t("Не удалось скопировать. Выделите и скопируйте код вручную.")); } }}>{t("Скопировать код")}</button><hr/><h3>{t("3. Выберите, кто отвечает")}</h3><ChannelAiControl key={`${item.id}:${item.connected}`} id={item.id}/><p className="muted">{t("Откройте свой сайт и напишите в чат. Проверьте сообщение в «Диалогах». В первой версии доступны текстовые сообщения; посетитель может продолжить переписку в этом браузере в течение 7 дней. История остаётся в BasQar.")}</p></>}
  </div>;
}
