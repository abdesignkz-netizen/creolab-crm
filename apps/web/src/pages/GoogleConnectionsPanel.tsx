import { useEffect, useState } from "react";
import { api } from "../lib/api";

type Connection = { kind: string; title: string; id: string | null; connected: boolean; resource: string | null; lastError: string | null; healthStatus: string };
const descriptions: Record<string,string> = {
  calendar: "Встречи CRM передаются в Google Calendar. Переносы обновляют события, отмены удаляют их. События, созданные вручную в Google, в CRM не импортируются.",
  google_forms: "Новые ответы формы становятся заявками. Если нет телефона, обращение поступает в очередь уточнения. Поля можно сопоставить после подключения.",
  email: "Новые входящие письма Gmail и поддерживаемые вложения появляются в диалогах. Ответы отправляйте из Gmail; автоматические заявки из писем не создаются.",
};
export function GoogleConnectionsPanel({ onChange }: { onChange: () => void }) {
  const [data,setData] = useState<{ configured: boolean; items: Connection[] } | null>(null);
  const [busy,setBusy] = useState(""); const [error,setError] = useState(""); const [note,setNote] = useState("");
  const [resource,setResource] = useState<Record<string,string>>({calendar:"primary"});
  const [questions,setQuestions] = useState<{ id: string; items: Array<{ id: string; title: string }> } | null>(null);
  const [mapping,setMapping] = useState<Record<string,string>>({});
  async function load() { setData(await api.googleConnections() as typeof data); }
  useEffect(() => { void load().catch(err => setError(err.message)); },[]);
  async function run(key: string, action: () => Promise<void>) { setBusy(key);setError("");setNote("");try { await action();await load(); onChange(); } catch(err) { setError(err instanceof Error ? err.message : "Не удалось выполнить действие"); } finally { setBusy(""); } }
  return <div className="panel"><h3>Google: календарь, формы и входящая почта</h3>
    {error ? <p className="error">{error}</p> : null}{note ? <p className="ok">{note}</p> : null}
    {!data?.configured && data ? <p className="muted">Администратору сервиса нужно настроить подключение приложения к Google. После этого здесь станет доступен вход в аккаунт.</p> : null}
    {(data?.items || []).map(item => <div key={item.kind} className="panel">
      <h4>{item.title} · {item.connected ? "Подключено" : "Не подключено"}</h4><p className="muted">{descriptions[item.kind]}</p>
      {item.resource ? <p>{item.resource}</p> : null}{item.lastError ? <p className="error">{item.lastError}</p> : null}
      {item.kind !== "email" ? <label>{item.kind === "calendar" ? "ID календаря (primary — основной)" : "ID Google Forms из адреса редактора"}<input value={resource[item.kind] || ""} onChange={event => setResource({...resource,[item.kind]:event.target.value})} /></label> : null}
      <div className="actions"><button className="btn" disabled={Boolean(busy) || !data?.configured} onClick={() => void run(item.kind, async () => {
        const result = await api.connectGoogle(item.kind, resource[item.kind]) as { url: string }; window.location.assign(result.url);
      })}>{busy === item.kind ? "Подождите…" : item.connected ? "Подключить заново" : "Подключить через Google"}</button>
      {item.connected && item.id ? <>
        <button className="btn secondary" disabled={Boolean(busy)} onClick={() => void run(item.kind, async () => { await api.syncGoogle(item.id!);setNote("Синхронизация выполнена"); })}>Синхронизировать</button>
        <button className="btn secondary" disabled={Boolean(busy)} onClick={() => void run(item.kind, async () => { await api.disconnectGoogle(item.id!);setNote("Подключение отключено. Данные в CRM сохранены."); })}>Отключить</button>
        {item.kind === "google_forms" ? <button className="btn secondary" disabled={Boolean(busy)} onClick={() => void run(item.kind, async () => { const result = await api.googleFormQuestions(item.id!) as { items: Array<{ id: string; title: string }>; mapping: Record<string,string> };setQuestions({id:item.id!,items:result.items});setMapping(result.mapping); })}>Сопоставить поля</button> : null}
      </> : null}</div>
    </div>)}
    {questions ? <form onSubmit={event => { event.preventDefault();void run("mapping",async () => { await api.saveGoogleFormMapping(questions.id,mapping);setQuestions(null);setNote("Сопоставление сохранено"); }); }}>
      <h4>Поля Google Forms</h4>{[["phone","Телефон"],["name","Имя"],["email","Email"],["message","Сообщение"]].map(([key,label]) => <label key={key}>{label}<select value={mapping[key] || ""} onChange={event => setMapping({...mapping,[key]:event.target.value})}><option value="">Определять по названию</option>{questions.items.map(q => <option key={q.id} value={q.id}>{q.title}</option>)}</select></label>)}
      <button className="btn" disabled={Boolean(busy)}>Сохранить поля</button>
    </form> : null}
    <p className="muted">Синхронизация проверяется примерно раз в минуту, пока сервер CRM работает. Формы и почта импортируются с момента подключения.</p>
  </div>;
}
