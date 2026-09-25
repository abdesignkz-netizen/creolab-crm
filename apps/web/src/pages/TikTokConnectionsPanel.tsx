import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { IntegrationHelp } from "../components/IntegrationHelp";

type Row = { id: string; connected: boolean; status: string; lastError: string | null; settings: { label?: string; advertiserId?: string } };
export function TikTokConnectionsPanel({ onChange }: { onChange: () => void }) {
  const [rows, setRows] = useState<Row[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [form, setForm] = useState({ appId: "", advertiserId: "", pageId: "", accessToken: "", appSecret: "" });
  async function load() { setRows((await api.tiktokConnections() as { items: Row[] }).items); }
  useEffect(() => { void load().catch(err => setError(err.message)); }, []);
  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await action(); } catch (err) { setError(err instanceof Error ? err.message : "Ошибка подключения"); }
    finally { await load().catch(() => undefined); onChange(); setBusy(false); }
  }
  return <div className="panel"><div className="row"><h3>TikTok Leads</h3><IntegrationHelp kind="tiktok" /></div>
    <p className="muted">Новые заявки из Instant Form автоматически поступают в CRM. Нужны приложение TikTok for Business с доступом к Lead Generation и права администратора рекламного аккаунта.</p>
    {error ? <p className="error">{error}</p> : null}
    <form onSubmit={event => { event.preventDefault(); void run(async () => { await api.connectTikTok(form); setForm({ ...form, accessToken: "", appSecret: "" }); }); }}>
      <label>App ID приложения TikTok<input required value={form.appId} onChange={event => setForm({ ...form, appId: event.target.value })}/></label>
      <label>ID рекламного аккаунта<input required value={form.advertiserId} onChange={event => setForm({ ...form, advertiserId: event.target.value })}/></label>
      <label>ID формы (Page ID)<input required value={form.pageId} onChange={event => setForm({ ...form, pageId: event.target.value })}/></label>
      <label>Access Token<input required type="password" autoComplete="new-password" value={form.accessToken} onChange={event => setForm({ ...form, accessToken: event.target.value })}/></label>
      <label>App Secret<input required type="password" autoComplete="new-password" value={form.appSecret} onChange={event => setForm({ ...form, appSecret: event.target.value })}/></label>
      <button className="btn" disabled={busy}>{busy ? "Подождите…" : "Подключить форму"}</button>
    </form>
    {rows.map(row => <div className="panel" key={row.id}><b>{row.settings.label} · {row.settings.advertiserId}</b>
      <p>{row.connected ? "Подключено" : row.status === "DISCONNECTED" ? "Отключено" : "Подключение требует проверки"}</p>
      {row.lastError ? <p className="error">{row.lastError}</p> : null}
      <div className="actions"><button className="btn secondary" disabled={busy || row.status === "DISCONNECTED"} onClick={() => void run(() => api.checkTikTok(row.id))}>Проверить подключение</button>
        <button className="btn secondary" disabled={busy || row.status === "DISCONNECTED"} onClick={() => void run(() => api.disconnectTikTok(row.id))}>Отключить</button></div>
    </div>)}
    <p className="muted">Сначала проверяется доступ к форме, затем создаётся подписка на новые заявки. Повторная доставка не создаёт дубликаты. Заявки без телефона сохраняются для уточнения. История остаётся в CRM после отключения.</p>
  </div>;
}
