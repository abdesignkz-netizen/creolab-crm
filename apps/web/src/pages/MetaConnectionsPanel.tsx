import { uiText, useUiText, localizeUiOptions } from "../lib/uiText";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { IntegrationHelp } from "../components/IntegrationHelp";
type Row = { id:string;kind:string;connected:boolean;status:string;lastError:string|null;settings:{label?:string;callbackUrl?:string} };
export function MetaConnectionsPanel({ onChange }: { onChange: () => void }){
  const uiText = useUiText();
  const [rows,setRows]=useState<Row[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(""),[note,setNote]=useState("");
  const [form,setForm]=useState({kind:"instagram_direct",appId:"",pageId:"",accessToken:"",appSecret:"",apiVersion:"v25.0"});
  const [verification,setVerification]=useState<{callbackUrl:string;verifyToken:string}|null>(null);
  async function load(){setRows((await api.metaConnections()as{items:Row[]}).items);}
  useEffect(()=>{void load().catch(err=>setError(err.message));},[]);
  async function run(action:()=>Promise<void>){setBusy(true);setError("");setNote("");try{await action();await load();onChange();}catch(err){setError(err instanceof Error?err.message:uiText("Ошибка подключения"));}finally{setBusy(false);}}
  return <div className="panel"><div className="row"><h3>{uiText("Instagram Direct и Meta Lead Forms")}</h3><IntegrationHelp kind="meta_instagram" /></div>
    <p className="muted">{uiText("Подключение через страницу Facebook и токен приложения Meta. Для Instagram нужен привязанный профессиональный аккаунт. Для внешних клиентов приложение должно иметь необходимые разрешения Meta.")}</p>
    {error?<p className="error">{error}</p>:null}{note?<p className="ok">{note}</p>:null}
    <form onSubmit={event=>{event.preventDefault();void run(async()=>{const result=await api.connectMeta(form)as{callbackUrl:string;verifyToken:string;note:string};if(result.verifyToken)setVerification(result);setForm({...form,accessToken:"",appSecret:""});setNote(result.note);});}}>
      <label>{uiText("Подключение")}<select value={form.kind} onChange={event=>setForm({...form,kind:event.target.value})}><option value="instagram_direct">Instagram Direct</option><option value="meta_lead_forms">Meta Lead Forms</option></select></label>
      <label>{uiText("App ID приложения Meta")}<input required value={form.appId} onChange={event=>setForm({...form,appId:event.target.value})}/></label>
      <label>{uiText("ID страницы Facebook")}<input required value={form.pageId} onChange={event=>setForm({...form,pageId:event.target.value})}/></label>
      <label>Page Access Token<input required type="password" autoComplete="new-password" value={form.accessToken} onChange={event=>setForm({...form,accessToken:event.target.value})}/></label>
      <label>{uiText("App Secret приложения Meta")}<input required type="password" autoComplete="new-password" value={form.appSecret} onChange={event=>setForm({...form,appSecret:event.target.value})}/></label>
      <label>{uiText("Версия API приложения")}<input required value={form.apiVersion} onChange={event=>setForm({...form,apiVersion:event.target.value})}/></label>
      <button className="btn" disabled={busy}>{busy?uiText("Подождите…"):uiText("Настроить подключение")}</button>
    </form>
    {verification?<div className="panel"><p>{uiText("В разделе Webhooks приложения Meta укажите:")}</p><label>Callback URL<input readOnly value={verification.callbackUrl}/></label><label>{uiText("Verify Token (показывается сейчас)")}<input readOnly value={verification.verifyToken}/></label><p className="muted">{uiText("Для Instagram выберите объект Instagram и поле messages; для форм — объект Page и leadgen. Сохраните проверку в Meta, затем включите подключение ниже. Не заменяйте callback, который обслуживает другую компанию.")}</p></div>:null}
    {rows.map(row=><div className="panel" key={row.id}><b>{row.kind==="instagram_direct"?"Instagram Direct":"Meta Lead Forms"} · {row.settings.label}</b><p>{row.connected?uiText("Подключено"):row.status==="DISCONNECTED"?uiText("Отключено"):uiText("Ожидает настройки в Meta")}</p><IntegrationHelp kind={row.kind === "instagram_direct" ? "meta_instagram" : "meta_leads"} />{row.lastError?<p className="error">{row.lastError}</p>:null}<div className="actions">
      <button className="btn secondary" disabled={busy||row.status==="DISCONNECTED"} onClick={()=>void run(async()=>{const result=await api.activateMeta(row.id)as{note:string};setNote(result.note);})}>{uiText("Проверить и включить")}</button>
      <button className="btn secondary" disabled={busy||row.status==="DISCONNECTED"} onClick={()=>void run(async()=>{await api.disconnectMeta(row.id);setNote(uiText("Приём в CRM отключён. История сохранена. При необходимости удалите подписку и в приложении Meta."));})}>{uiText("Отключить")}</button>
    </div></div>)}
    <p className="muted">{uiText("Instagram: входящие сообщения и текстовые ответы в пределах 24 часов после сообщения клиента. Вложения открывайте в Instagram. Формы Meta создают заявки; обращения без телефона сохраняются для уточнения.")}</p>
  </div>;
}
