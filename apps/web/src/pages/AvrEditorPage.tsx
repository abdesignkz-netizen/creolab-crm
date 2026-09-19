import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { avrEditorAmounts, avrEditorSchema, ESF_DEFAULT_MEASURE_UNIT_CODE, resolveEsfMeasureUnitCode, type AvrEditorInput } from "@creolab/contracts";
import { documentErrorFields, documentFieldLabel } from "../lib/documentErrors";
import { api, downloadAvrExcel, downloadAvrPdf } from "../lib/api";
import { EsfMeasureUnitSelect } from "../components/EsfMeasureUnitSelect";
import { notifySaved } from "../components/SaveNotice";
import { ensureEsfCabinetSession } from "../lib/signing/esfConnect";
import { createEsfNcaLayerClient } from "../lib/signing/esfNcaLayerClient";
import { signAndSendEsfDocument } from "../lib/signing/esfSignAndSend";

const money=(v:unknown)=>Number(v||0).toLocaleString("ru-RU",{minimumFractionDigits:2,maximumFractionDigits:2});
const empty:AvrEditorInput={documentDate:new Date().toISOString().slice(0,10),items:[]};
const partyFields=[["legalName","Название"],["bin","БИН / ИИН"],["legalAddress","Юридический адрес"],["iban","ИИК / IBAN"],["bankName","Банк"],["bik","БИК"],["directorName","Руководитель"]] as const;
const labels:Record<string,string>={CONNECTING:"Подключение NCALayer",AUTHORIZING:"Авторизация ИС ЭСФ",DRAFT:"Черновик",VALIDATED:"Готов",SIGNING:"Подписание",SENDING:"Отправляется",SENT:"Отправлен",ACCEPTED:"Принят",ERROR:"Ошибка"};
export function AvrEditorPage(){
  const {id}=useParams();const [params]=useSearchParams();const navigate=useNavigate();const {hash}=useLocation();
  const [deals,setDeals]=useState<any[]>([]),[filter,setFilter]=useState(params.get("filter")==="all"?"all":"ready"),[q,setQ]=useState("");
  const [context,setContext]=useState<any>(null),[doc,setDoc]=useState<any>(null),[form,setForm]=useState<AvrEditorInput>(empty);
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[warnings,setWarnings]=useState<string[]>([]),[issues,setIssues]=useState<Record<string,string>>({});
  const [connection,setConnection]=useState<any>(null),[connected,setConnected]=useState(false),[iin,setIin]=useState(""),[phase,setPhase]=useState("");
  const [editingBuyer,setEditingBuyer]=useState(false),[buyer,setBuyer]=useState<Record<string,string>>({}),[dirty,setDirty]=useState(false);
  const [askCabinet,setAskCabinet]=useState(false),[cabinetPassword,setCabinetPassword]=useState("");
  const flight=useRef(false),version=useRef(0);
  const issueSummary=useRef<HTMLDivElement>(null);
  const signPanel=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(error || Object.keys(issues).length)issueSummary.current?.scrollIntoView({block:"center",behavior:"smooth"});},[error,issues]);
  const immutable=Boolean(doc&&(doc.externalId||!["DRAFT","VALIDATED"].includes(doc.status)));
  const totals=avrEditorSchema.safeParse(form).success?avrEditorAmounts(form.items):null;
  async function loadDeal(dealId:string,existing?:any){
    const current=++version.current;setBusy(true);setError("");
    try{
      const ctx:any=await api.request(`/api/v1/deals/${dealId}/avr-context`);if(current!==version.current)return;
      let record=existing;
      if(!record&&ctx.existingDocumentId){const r:any=await api.request(`/api/v1/electronic-documents/${ctx.existingDocumentId}`);record=r.document;}
      if(current!==version.current)return;
      const toEditorItems=(rows:any[]=[])=>rows.map((r:any)=>({name:r.name||"",quantity:r.quantity,unit:resolveEsfMeasureUnitCode(r.unit),unitPrice:r.unitPrice,vatRate:r.vatRate??0}));
      setContext(ctx);setDoc(record||null);setForm(record?{documentDate:record.documentDate.slice(0,10),items:toEditorItems(record.source?.items||[])}:{...empty,items:toEditorItems(ctx.items)});setDirty(false);setIssues({});setEditingBuyer(false);setPhase("");
      const readiness:any=await api.request(`/api/v1/deals/${dealId}/avr-readiness`);if(current===version.current)setWarnings(readiness.warnings||[]);
    }catch(e:any){setError(e.message);}finally{if(current===version.current)setBusy(false);}
  }
  useEffect(()=>{let live=true;if(id){void api.request<any>(`/api/v1/electronic-documents/${id}`).then(r=>{if(live)void loadDeal(r.document.dealId,r.document);}).catch(e=>setError(e.message));}else if(params.get("dealId"))void loadDeal(params.get("dealId")!);return()=>{live=false;version.current++;};},[id]);
  useEffect(()=>{if(context)return;let active=true;void api.request<any>(`/api/v1/documents/avr/eligible-deals?filter=${filter}&q=${encodeURIComponent(q)}`).then(r=>{if(active)setDeals(r.items);}).catch(e=>setError(e.message));return()=>{active=false;};},[filter,q,context]);
  useEffect(()=>{void api.esfConnection().then((row:any)=>{const stored=String(row?.connection?.signerIin||"").replace(/\D/g,"");if(stored.length===12)setIin((current)=>current||stored);}).catch(()=>{});},[]);
  useEffect(()=>{if(!context||!doc||hash!=="#sign")return;signPanel.current?.scrollIntoView({block:"start",behavior:"smooth"});},[context,doc,hash]);
  function edit(patch:Partial<AvrEditorInput>){setForm(v=>({...v,...patch}));setDirty(true);setPhase("");setIssues({});}
  function item(index:number,patch:Partial<AvrEditorInput["items"][number]>){edit({items:form.items.map((r,i)=>i===index?{...r,...patch}:r)});}
  function localCheck(){const result=avrEditorSchema.safeParse(form);if(result.success)return true;setIssues(Object.fromEntries(result.error.issues.map(i=>[i.path.join("."),i.message])));return false;}
  async function save(){
    if(!context||!localCheck())throw new Error("Проверьте поля документа");
    if(immutable) return doc;
    const result:any=doc?await api.request(`/api/v1/electronic-documents/${doc.id}`,{method:"PATCH",body:JSON.stringify({...form,updatedAt:doc.updatedAt})}):await api.request(`/api/v1/deals/${context.deal.id}/electronic-documents`,{method:"POST",body:JSON.stringify({type:"AVR",editor:form})});
    setDoc(result.document);setDirty(false);if(!id)navigate(`/documents/avr/${result.document.id}`,{replace:true});return result.document;
  }
  async function action(fn:()=>Promise<void>){
    if(flight.current)return;flight.current=true;setBusy(true);setError("");
    try{await fn();}catch(e:any){
      if(e.body?.wsseRequired||e.body?.code==="esf_wsse_required")setAskCabinet(true);
      setError(e.code==="USER_CANCELLED"?"Подпись отменена. Документ не отправлен.":e.message||"Не удалось выполнить действие");
      setPhase(e.code==="USER_CANCELLED"?"":"ERROR");
      const fields=documentErrorFields(e,editingBuyer);if(Object.keys(fields).length)setIssues(fields);
    }finally{flight.current=false;setBusy(false);}
  }
  async function connect(){
    setPhase("CONNECTING");
    setConnected(false);
    const client=createEsfNcaLayerClient();
    try{if(!await client.isAvailable())throw new Error("Запустите NCALayer и снова нажмите «Подписать и отправить АВР»");const probe=await client.probe();if(!probe.officialModuleInstalled)throw new Error("В NCALayer нужен модуль ИС ЭСФ");}finally{client.disconnect();}
    setPhase("AUTHORIZING");
    try{
      const updated:any=await ensureEsfCabinetSession({iin,cabinetPassword});
      setCabinetPassword("");
      setConnection(updated);setConnected(true);setAskCabinet(false);setIssues({});
    }catch(err:any){
      if(err.wsseRequired||err.body?.wsseRequired||err.code==="esf_wsse_required")setAskCabinet(true);
      throw err;
    }
  }
  async function check(record:any){
    const validated:any=await api.validateElectronicDocument(record.id);setDoc(validated.document);setWarnings(validated.warnings||warnings);setIssues({});setPhase("VALIDATED");notifySaved("Поля документа проверены в CRM. Проверка на портале ещё не выполнена.");
  }
  async function saveBuyer(){
    const payload={...buyer,...(context.company?.iin&&!context.company?.bin?{iin:buyer.bin,bin:null}:{}),name:buyer.legalName||buyer.name||context.deal.contactName||"Заказчик"};
    if(context.company)await api.request(`/api/v1/companies/${context.company.id}`,{method:"PATCH",body:JSON.stringify(payload)});
    else{const result:any=await api.request("/api/v1/companies",{method:"POST",body:JSON.stringify(payload)});await api.request(`/api/v1/deals/${context.deal.id}`,{method:"PATCH",body:JSON.stringify({companyId:result.id})});}
    const updated:any=await api.request(`/api/v1/deals/${context.deal.id}/avr-context`);setContext(updated);setEditingBuyer(false);setIssues({});notifySaved("Реквизиты сохранены в карточке компании");
  }
  const fieldError=(key:string)=>issues[key]?<span className="error" role="alert">{issues[key]}</span>:null;
  return <section className="avr-editor"><div className="row"><div><Link to="/documents?kind=AVR">АВР</Link><h2>{doc?`АВР ${doc.number}`:"Создание АВР"}</h2></div><span className={`document-status status-${phase||(doc?.errorCode?"ERROR":doc?.status)||"DRAFT"}`}>{labels[phase||(doc?.errorCode?"ERROR":doc?.status)||"DRAFT"]||doc?.status}</span></div>
    {error||Object.keys(issues).length?<div ref={issueSummary} className="panel" role="alert"><b>{Object.keys(issues).length?"Нужно исправить:":error}</b>{error&&Object.keys(issues).length&& !/^Проверьте поля/.test(error)?<p>{error}</p>:null}<ul>{Object.entries(issues).map(([key,message])=><li key={key}><b>{documentFieldLabel(key)}</b>: {message}</li>)}</ul></div>:null}
    {!context?(id||params.get("dealId")?<div className="panel"><p>{error||"Загружаем заполненный АВР…"}</p></div>:<div className="panel"><h3>Сделка</h3><div className="actions"><button className={filter==="ready"?"btn":"btn secondary"} onClick={()=>setFilter("ready")}>Готовы к закрытию</button><button className={filter==="all"?"btn":"btn secondary"} onClick={()=>setFilter("all")}>Все незакрытые</button></div><label>Найти сделку<input value={q} onChange={e=>setQ(e.target.value)} placeholder="Название или компания"/></label>{!deals.length?<p>Подходящих сделок нет. Попробуйте фильтр «Все незакрытые».</p>:null}{deals.map(d=><div className="card" key={d.id}><b>{d.title} — {d.companyName||d.contactName}</b><p>Сделка #{d.number} · {money(d.amount)} ₸ · {d.stage} · {d.responsible||"Ответственный не назначен"}</p><p>{d.paymentStatus==="PAID"?"Оплачено":"Оплата не подтверждена"}{d.paidAt?` · ${new Date(d.paidAt).toLocaleDateString("ru-RU")}`:""}</p><p className={d.ready?"ok":"pdf-import-warnings"}>{d.ready?"Готова к закрытию":d.reasons.join("; ")}</p><p>{d.documentState.label}</p><button className="btn secondary" disabled={busy} onClick={()=>void loadDeal(d.id)}>{d.documentId?"Открыть АВР":"Выбрать"}</button></div>)}</div>):<>
      <div className="panel"><div className="row"><h3>Основание</h3>{!doc?<button className="btn secondary" disabled={busy} onClick={()=>{setContext(null);setForm(empty);setDirty(false);}}>Выбрать другую сделку</button>:null}</div><Link to={`/deals/${context.deal.id}`}>{context.deal.title}</Link><p>Сделка #{context.deal.number} · {context.deal.contactName||"Контакт не указан"} · {context.deal.responsible||"Ответственный не назначен"}</p><p>Договор: {doc?.source?.contract?.number||context.contract?.number||"Не указан"} · {(doc?.source?.contract?.date||context.contract?.date)?.slice(0,10)||"Дата не указана"}</p>{warnings.map(w=><p className="pdf-import-warnings" key={w}>{w}</p>)}<label>Дата АВР<input type="date" disabled={busy||immutable} aria-invalid={Boolean(issues.documentDate)} value={form.documentDate} onChange={e=>edit({documentDate:e.target.value})}/>{fieldError("documentDate")}</label></div>
      <div className="pdf-import-parties"><div className="panel"><h3>Исполнитель</h3>{partyFields.map(([k,l])=><p key={k}>{l}: <b>{context.organization?.[k]|| (k==="bin"?context.organization?.iin:null)||"Не заполнено"}</b>{fieldError(`organization.${k}`)}</p>)}<p>НДС: {context.organization?.vatPayer===true?"Плательщик НДС":context.organization?.vatPayer===false?"Без НДС":"Не указан"}</p><label>Основание действия<input disabled={busy||immutable} value={context.organization?.directorBasis||""} onChange={e=>setContext((v:any)=>({...v,organization:{...v.organization,directorBasis:e.target.value}}))}/></label><button className="btn secondary" disabled={busy||immutable} onClick={()=>void action(async()=>{await api.updateLegalProfile({directorBasis:context.organization?.directorBasis||null});notifySaved("Основание сохранено в настройках организации");})}>Сохранить основание</button><Link className="btn secondary" to="/settings#company-requisites" target="_blank">Заполнить данные</Link><button className="btn secondary" disabled={busy} onClick={()=>void action(async()=>{const r:any=await api.request(`/api/v1/deals/${context.deal.id}/avr-context`);setContext(r);})}>Обновить реквизиты</button></div>
      <div className="panel"><h3>Заказчик</h3><p>Контактное лицо: {context.deal.contactName||"Не указано"}</p>{partyFields.map(([k,l])=>editingBuyer?<label key={k}>{l}<input value={buyer[k]||""} onChange={e=>setBuyer(v=>({...v,[k]:e.target.value}))}/>{fieldError(`customer.${k}`)}</label>:<p key={k}>{l}: <b>{context.company?.[k]||(k==="legalName"?context.company?.name:k==="bin"?context.company?.iin:null)||"Не заполнено"}</b>{fieldError(`customer.${k}`)}</p>)}{fieldError("customer.company")}{!context.company?.bin&&!context.company?.iin?<p className="pdf-import-warnings">Для отправки АВР необходимо заполнить БИН / ИИН заказчика.</p>:null}{editingBuyer?<button className="btn" disabled={busy} onClick={()=>void action(saveBuyer)}>Сохранить в компании</button>:<button className="btn secondary" disabled={busy||immutable} onClick={()=>{setBuyer(Object.fromEntries(partyFields.map(([k])=>[k,context.company?.[k]||(k==="legalName"?context.company?.name:k==="bin"?context.company?.iin:"")||""])));setEditingBuyer(true);}}>Заполнить данные</button>}</div></div>
      <div className="panel"><h3>Позиции АВР</h3>{fieldError("deal.items")}{form.items.map((r,i)=><fieldset disabled={busy||immutable} className="avr-line" key={i}><label>Работа / услуга<input aria-invalid={Boolean(issues[`items.${i}.name`])} value={r.name} onChange={e=>item(i,{name:e.target.value})}/>{fieldError(`items.${i}.name`)}</label><label>Количество<input type="number" min="0.001" step="0.001" aria-invalid={Boolean(issues[`items.${i}.quantity`])} value={r.quantity} onChange={e=>item(i,{quantity:Number(e.target.value)})}/>{fieldError(`items.${i}.quantity`)}</label><label>Ед. изм.<EsfMeasureUnitSelect aria-label={`Единица измерения ${i+1}`} invalid={Boolean(issues[`items.${i}.unit`])} value={r.unit} onChange={unit=>item(i,{unit})}/>{fieldError(`items.${i}.unit`)}</label><label>Цена без НДС<input type="number" min="0" step="0.01" aria-invalid={Boolean(issues[`items.${i}.unitPrice`])} value={r.unitPrice} onChange={e=>item(i,{unitPrice:Number(e.target.value)})}/>{fieldError(`items.${i}.unitPrice`)}</label><label>НДС, %<input type="number" min="0" max="100" step="0.01" aria-invalid={Boolean(issues[`items.${i}.vatRate`])} value={r.vatRate} onChange={e=>item(i,{vatRate:Number(e.target.value)})}/>{fieldError(`items.${i}.vatRate`)}</label><p>{money(totals?.rows[i].totalAmount)} ₸</p><button className="btn secondary" onClick={()=>edit({items:form.items.filter((_,n)=>n!==i)})}>Удалить</button></fieldset>)}<button className="btn secondary" disabled={busy||immutable} onClick={()=>edit({items:[...form.items,{name:"",quantity:1,unit:ESF_DEFAULT_MEASURE_UNIT_CODE,unitPrice:0,vatRate:Number(context.organization?.defaultVatRate||0)}]})}>+ Добавить позицию</button><p>Без НДС: {money(totals?.totals.amountWithoutVat)} ₸ · НДС: {money(totals?.totals.vatAmount)} ₸ · <b>Итого: {money(totals?.totals.totalAmount)} ₸</b></p>{fieldError("")}{fieldError("deal.amount")}<button className="btn" disabled={busy||immutable} onClick={()=>void action(async()=>{await save();notifySaved("Черновик АВР сохранён");})}>Сохранить черновик</button></div>
      <div className="panel"><h3>Локальный АВР</h3><p className="muted">Форма Р-1 (приказ МФ РК № 562) для печати и архива. Excel и PDF собираются в CRM из того же бланка, без входа в ИС ЭСФ.</p><div className="actions"><button className="btn secondary" disabled={busy} onClick={()=>void action(async()=>{const record=dirty||!doc?await save():doc;await downloadAvrExcel(record.id);notifySaved("Excel-файл АВР скачан");})}>Скачать Excel</button><button className="btn secondary" disabled={busy} onClick={()=>void action(async()=>{const record=dirty||!doc?await save():doc;await downloadAvrPdf(record.id);notifySaved("PDF-файл АВР скачан");})}>Скачать PDF</button></div></div>
      <div className="panel" id="sign" ref={signPanel} style={{scrollMarginTop:24}}><h3>Подписание и отправка</h3><p className="muted">Проверьте реквизиты и позиции выше. Отправка в ИС ЭСФ начинается только после нажатия «Подписать и отправить АВР» на этой странице.</p><p className="muted">На тестовом стенде используйте свои действующие ключи НУЦ: ключ для входа и ключ подписи организации. Демо-ключи из SDK ЭСФ принадлежат чужому БИН и для вашей организации не подойдут.</p><p className={connected?"ok":"muted"}>{connected?"NCALayer подключён":"NCALayer подключится при нажатии «Подписать и отправить АВР»"}</p>{connection?<p>{connection.organization?.legalName} · БИН {connection.connection?.organizationBin} · Сертификат {connection.connection?.certificateSerial}</p>:null}<label>ИИН пользователя для авторизации ЭСФ<input aria-invalid={Boolean(issues.iin)} value={iin} maxLength={12} onChange={e=>setIin(e.target.value.replace(/\D/g,""))}/>{fieldError("iin")}</label>{askCabinet?<label>Пароль кабинета ИС ЭСФ<input type="password" autoComplete="current-password" disabled={busy} value={cabinetPassword} onChange={e=>setCabinetPassword(e.target.value)}/><span className="muted">Используется только для входа в ИС ЭСФ и не сохраняется. PIN ЭЦП вводится в NCALayer.</span>{fieldError("cabinetPassword")}</label>:null}{fieldError("signedAuthTicket")}{fieldError("authCmsBase64")}{fieldError("publicCertificate")}{fieldError("signature")}{fieldError("ncalayer")}<div className="actions"><button className="btn secondary" disabled={busy||immutable} onClick={()=>void action(async()=>{const record=dirty||!doc?await save():doc;await check(record);})}>Проверить документ</button><button className="btn" disabled={busy||immutable||editingBuyer} onClick={()=>void action(async()=>{const record=dirty||!doc?await save():doc;await check(record);await connect();const result:any=await signAndSendEsfDocument(record.id,setPhase);setDoc(result.sent.document);setPhase("");notifySaved("АВР отправлен");})}>Подписать и отправить АВР</button>{doc?.externalId?<button className="btn secondary" disabled={busy} onClick={()=>void action(async()=>{await api.refreshElectronicDocumentEsf(doc.id);const r:any=await api.request(`/api/v1/electronic-documents/${doc.id}`);setDoc(r.document);})}>Обновить статус</button>:null}</div>{doc?.errorMessage?<p className="error">{doc.errorMessage}</p>:null}{doc?.externalId?<p>Номер регистрации: {doc.externalNumber||doc.externalId}</p>:null}</div>
    </>}
  </section>;
}
