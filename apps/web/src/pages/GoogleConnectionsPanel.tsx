import { InlineFeedback } from "../components/InlineFeedback";
import { uiText, useUiText, localizeUiOptions } from "../lib/uiText";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { IntegrationHelp } from "../components/IntegrationHelp";

type Connection = { kind: string; title: string; id: string | null; connected: boolean; resource: string | null; lastError: string | null; healthStatus: string };
const descriptions: Record<string,string> = {
  calendar: "Встречи CRM передаются в Google Calendar. Переносы обновляют события, отмены удаляют их. События, созданные вручную в Google, в CRM не импортируются.",
  google_forms: "Новые ответы формы становятся заявками. Если нет телефона, обращение поступает в очередь уточнения. Поля можно сопоставить после подключения.",
  email: "Новые входящие письма Gmail и поддерживаемые вложения появляются в диалогах. Ответы отправляйте из Gmail; автоматические заявки из писем не создаются.",
};
export function GoogleConnectionsPanel({ onChange, kind }: { onChange: () => void; kind?: string }) {
  const uiText = useUiText();
  const [data,setData] = useState<{ configured: boolean; items: Connection[] } | null>(null);
  const [busy,setBusy] = useState(""); const [error,setError] = useState(""); const [note,setNote] = useState("");
  const [resource,setResource] = useState<Record<string,string>>({calendar:"primary"});
  const [questions,setQuestions] = useState<{ id: string; items: Array<{ id: string; title: string }> } | null>(null);
  const [mapping,setMapping] = useState<Record<string,string>>({});
  async function load() { setData(await api.googleConnections() as typeof data); }
  useEffect(() => { void load().catch(err => setError(err.message)); },[]);
  async function run(key: string, action: () => Promise<void>) { setBusy(key);setError("");setNote("");try { await action();await load(); onChange(); } catch(err) { setError(err instanceof Error ? err.message : uiText("Не удалось выполнить действие")); } finally { setBusy(""); } }
  return <div className="panel"><div className="row"><h3>{kind ? ({ calendar: "Google Calendar", google_forms: "Google Forms", email: "Gmail" }[kind] || "Google") : uiText("Google: календарь, формы и входящая почта")}</h3><IntegrationHelp kind={kind === "google_forms" ? "google_forms" : kind === "email" ? "google_email" : "google_calendar"} /></div>
    {error ? <InlineFeedback kind="error" className="error">{error}</InlineFeedback> : null}{note ? <InlineFeedback kind="success" className="ok">{note}</InlineFeedback> : null}
    {!data?.configured && data ? <p className="muted">{uiText("Администратору сервиса нужно настроить подключение приложения к Google. После этого здесь станет доступен вход в аккаунт.")}</p> : null}
    {(data?.items || []).filter(item => !kind || item.kind === kind).map(item => <div key={item.kind} className="panel">
      <h4>{item.title} · {item.connected ? uiText("Подключено") : uiText("Не подключено")}</h4><p className="muted">{localizeUiOptions(descriptions, uiText)[item.kind]}</p><IntegrationHelp kind={item.kind === "calendar" ? "google_calendar" : item.kind === "google_forms" ? "google_forms" : "google_email"} />
      {item.resource ? <p>{item.resource}</p> : null}{item.lastError ? <p className="error">{item.lastError}</p> : null}
      {item.kind !== "email" ? <label>{item.kind === "calendar" ? uiText("ID календаря (primary — основной)") : uiText("ID Google Forms из адреса редактора")}<input value={resource[item.kind] || ""} onChange={event => setResource({...resource,[item.kind]:event.target.value})} /></label> : null}
      <div className="actions"><button className="btn" disabled={Boolean(busy) || !data?.configured} onClick={() => void run(item.kind, async () => {
        const result = await api.connectGoogle(item.kind, resource[item.kind]) as { url: string }; window.location.assign(result.url);
      })}>{busy === item.kind ? uiText("Подождите…") : item.connected ? uiText("Подключить заново") : uiText("Подключить через Google")}</button>
      {item.connected && item.id ? <>
        <button className="btn secondary" disabled={Boolean(busy)} onClick={() => void run(item.kind, async () => { await api.syncGoogle(item.id!);setNote(uiText("Синхронизация выполнена")); })}>{uiText("Синхронизировать")}</button>
        <button className="btn secondary" disabled={Boolean(busy)} onClick={() => void run(item.kind, async () => { await api.disconnectGoogle(item.id!);setNote(uiText("Подключение отключено. Данные в CRM сохранены.")); })}>{uiText("Отключить")}</button>
        {item.kind === "google_forms" ? <button className="btn secondary" disabled={Boolean(busy)} onClick={() => void run(item.kind, async () => { const result = await api.googleFormQuestions(item.id!) as { items: Array<{ id: string; title: string }>; mapping: Record<string,string> };setQuestions({id:item.id!,items:result.items});setMapping(result.mapping); })}>{uiText("Сопоставить поля")}</button> : null}
      </> : null}</div>
    </div>)}
    {questions ? <form onSubmit={event => { event.preventDefault();void run("mapping",async () => { await api.saveGoogleFormMapping(questions.id,mapping);setQuestions(null);setNote(uiText("Сопоставление сохранено")); }); }}>
      <h4>{uiText("Поля Google Forms")}</h4>{[["phone",uiText("Телефон")],["name",uiText("Имя")],["email","Email"],["message",uiText("Сообщение")]].map(([key,label]) => <label key={key}>{label}<select value={mapping[key] || ""} onChange={event => setMapping({...mapping,[key]:event.target.value})}><option value="">{uiText("Определять по названию")}</option>{questions.items.map(q => <option key={q.id} value={q.id}>{q.title}</option>)}</select></label>)}
      <button className="btn" disabled={Boolean(busy)}>{uiText("Сохранить поля")}</button>
    </form> : null}
    <p className="muted">{uiText("Синхронизация проверяется примерно раз в минуту, пока сервер CRM работает. Формы и почта импортируются с момента подключения.")}</p>
  </div>;
}
