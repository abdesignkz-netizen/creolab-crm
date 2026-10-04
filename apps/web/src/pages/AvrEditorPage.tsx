import { uiMessage, uiText, useUiText, localizeUiOptions, uiFormatLocale } from "../lib/uiText";
import { ContractSignatureSummary } from "../components/ContractSignatureSummary";
import { createSigningClient, ncalayerUserMessage } from "../lib/signing/ncalayerClient";
import { CONTRACT_SIGNING_ENABLED } from "../lib/featureFlags";
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
import { PdfDocumentViewer } from "../components/PdfDocumentViewer";

const money=(v:unknown)=>Number(v||0).toLocaleString(uiFormatLocale(),{minimumFractionDigits:2,maximumFractionDigits:2});
const empty:AvrEditorInput={documentDate:new Date().toISOString().slice(0,10),items:[]};
const partyFields=[["legalName","Название"],["bin","БИН / ИИН"],["legalAddress","Юридический адрес"],["iban","ИИК / IBAN"],["bankName","Банк"],["bik","БИК"],["directorName","Руководитель"]] as const;
const labels:Record<string,string>={CONNECTING:"Подключение NCALayer",AUTHORIZING:"Авторизация ИС ЭСФ",DRAFT:"Черновик",VALIDATED:"Готов",PENDING_SIGNATURE:"На подписи в BasQar",PARTIALLY_SIGNED:"Ожидает подписи заказчика",SIGNED:"Подписан обеими сторонами",SIGNING:"Подписание",SENDING:"Отправляется",SENT:"Отправлен",ACCEPTED:"Принят",ERROR:"Ошибка"};
export function AvrEditorPage(){
  const uiText = useUiText();
  const {id}=useParams();const [params]=useSearchParams();const navigate=useNavigate();const {hash}=useLocation();
  const [deals,setDeals]=useState<any[]>([]),[filter,setFilter]=useState(params.get("filter")==="all"?"all":"ready"),[q,setQ]=useState("");
  const [context,setContext]=useState<any>(null),[doc,setDoc]=useState<any>(null),[form,setForm]=useState<AvrEditorInput>(empty);
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[warnings,setWarnings]=useState<string[]>([]),[issues,setIssues]=useState<Record<string,string>>({});
  const [connection,setConnection]=useState<any>(null),[connected,setConnected]=useState(false),[iin,setIin]=useState(""),[phase,setPhase]=useState("");
  const [editingBuyer,setEditingBuyer]=useState(false),[buyer,setBuyer]=useState<Record<string,string>>({}),[dirty,setDirty]=useState(false);
  const [askCabinet,setAskCabinet]=useState(false),[cabinetPassword,setCabinetPassword]=useState("");
  const [localSigning,setLocalSigning]=useState<any>(null),[buyerLink,setBuyerLink]=useState("");
  const [previewPdfUrl,setPreviewPdfUrl]=useState("");
  const flight=useRef(false),version=useRef(0);
  const issueSummary=useRef<HTMLDivElement>(null);
  const signPanel=useRef<HTMLDivElement>(null);
  useEffect(() => () => { if (previewPdfUrl) URL.revokeObjectURL(previewPdfUrl); }, [previewPdfUrl]);
  useEffect(()=>{if(error || Object.keys(issues).length)issueSummary.current?.scrollIntoView({block:"center",behavior:"smooth"});},[error,issues]);
  const basqar = doc?.externalSystem === "BASQAR";
  const contractBasis = doc ? doc.source?.contract : context?.contract;
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
      const nextSigning = record ? await api.avrSigning(record.id) : null;
      if(current!==version.current)return;
      setLocalSigning(nextSigning);setBuyerLink("");
      setContext(record?.externalSystem === "BASQAR" ? {...ctx, organization:{...record.source.seller}, company:{...record.source.buyer}} : ctx);setDoc(record||null);setForm(record?{number:record.number,documentDate:record.documentDate.slice(0,10),items:toEditorItems(record.source?.items||[])}:{...empty,items:toEditorItems(ctx.items)});setDirty(false);setIssues({});setEditingBuyer(false);setPhase("");
      const readiness:any=await api.request(`/api/v1/deals/${dealId}/avr-readiness`);if(current===version.current)setWarnings(readiness.warnings||[]);
    }catch(e:any){setError(e.message);}finally{if(current===version.current)setBusy(false);}
  }
  useEffect(()=>{let live=true;if(id){void api.request<any>(`/api/v1/electronic-documents/${id}`).then(r=>{if(live)void loadDeal(r.document.dealId,r.document);}).catch(e=>setError(e.message));}else if(params.get("dealId"))void loadDeal(params.get("dealId")!);return()=>{live=false;version.current++;};},[id]);
  useEffect(()=>{if(context)return;let active=true;void api.request<any>(`/api/v1/documents/avr/eligible-deals?filter=${filter}&q=${encodeURIComponent(q)}`).then(r=>{if(active)setDeals(r.items);}).catch(e=>setError(e.message));return()=>{active=false;};},[filter,q,context]);
  useEffect(()=>{void api.esfConnection().then((row:any)=>{const stored=String(row?.connection?.signerIin||"").replace(/\D/g,"");if(stored.length===12)setIin((current)=>current||stored);}).catch(()=>{});},[]);
  useEffect(()=>{if(!context||!doc||hash!=="#sign")return;signPanel.current?.scrollIntoView({block:"start",behavior:"smooth"});},[context,doc,hash]);
  function edit(patch:Partial<AvrEditorInput>){setForm(v=>({...v,...patch}));setDirty(true);setPhase("");setIssues({});}
  function item(index:number,patch:Partial<AvrEditorInput["items"][number]>){edit({items:form.items.map((r,i)=>i===index?{...r,...patch}:r)});}
  function localCheck(){const result=avrEditorSchema.safeParse(form);if(result.success)return true;setIssues(Object.fromEntries(result.error.issues.map(i=>[i.path.join("."),uiMessage(i.message)])));return false;}
  async function save(){
    if(!context||!localCheck())throw new Error(uiText("Проверьте поля документа"));
    if(immutable) return doc;
    const result:any=doc?await api.request(`/api/v1/electronic-documents/${doc.id}`,{method:"PATCH",body:JSON.stringify({...form,updatedAt:doc.updatedAt})}):await api.request(`/api/v1/deals/${context.deal.id}/electronic-documents`,{method:"POST",body:JSON.stringify({type:"AVR",editor:form})});
    setDoc(result.document);setForm(v=>({...v,number:result.document.number}));setDirty(false);if(!id)navigate(`/documents/avr/${result.document.id}`,{replace:true});return result.document;
  }
  async function action(fn:()=>Promise<void>){
    if(flight.current)return;flight.current=true;setBusy(true);setError("");
    try{await fn();}catch(e:any){
      if(e.body?.wsseRequired||e.body?.code==="esf_wsse_required")setAskCabinet(true);
      setError(e.code==="USER_CANCELLED"?uiText("Подпись отменена. Документ не отправлен."):e.message||uiText("Не удалось выполнить действие"));
      setPhase(e.code==="USER_CANCELLED"?"":"ERROR");
      const fields=documentErrorFields(e,editingBuyer);if(Object.keys(fields).length)setIssues(fields);
    }finally{flight.current=false;setBusy(false);}
  }
  async function reloadLocalSigning(documentId:string){
    const [saved, signing]:any[] = await Promise.all([api.request(`/api/v1/electronic-documents/${documentId}`),api.avrSigning(documentId)]);
    setDoc(saved.document);setLocalSigning(signing);setPhase("");
  }
  async function signLocally(){
    const record = dirty || !doc ? await save() : doc;
    const client=createSigningClient();
    try {
      if(record.externalSystem!=="BASQAR") {
        await check(record);
        await api.prepareAvrSellerSign(record.id);
      }
      // Refresh the lock before opening NCALayer; cancellation must not leave editable stale UI.
      await reloadLocalSigning(record.id);
      const file=await api.downloadAvrSigningPdf(record.id);
      const bytes=new Uint8Array(await file.blob.arrayBuffer());
      let binary="";bytes.forEach(b=>{binary+=String.fromCharCode(b);});
      await client.connect();
      const cms=await client.signDocument(btoa(binary));
      await api.signAvrAsSeller(record.id,cms);
      await reloadLocalSigning(record.id);
      notifySaved(uiText("АВР подписан исполнителем. Теперь можно создать ссылку заказчику."));
    } catch(e) { throw new Error(ncalayerUserMessage(e)); }
    finally { client.disconnect(); }
  }
  async function sendLocalLink(){
    const result:any=await api.sendAvrToBuyer(doc.id);
    setLocalSigning(result);setBuyerLink(result.signUrl);
    notifySaved(uiText("Ссылка готова. Скопируйте и передайте её заказчику."));
  }
  async function cancelLocalSigning(){
    if(!doc)return;
    if(!window.confirm(uiText("Отменить подпись АВР и вернуть документ в исправление? Подпись исполнителя и ссылка заказчику будут аннулированы.")))return;
    await api.cancelAvrSigning(doc.id);
    await reloadLocalSigning(doc.id);
    setLocalSigning(null);setBuyerLink("");setDirty(false);
    notifySaved(uiText("Подписание отменено. АВР снова можно исправлять."));
  }
  async function deleteCurrentAvr(){
    if(!doc)return;
    if(!window.confirm(uiText("Удалить этот АВР? Действие нельзя отменить.")))return;
    await api.deleteAvr(doc.id);
    notifySaved(uiText("АВР удалён"));
    navigate("/documents?kind=AVR",{replace:true});
  }
  async function previewAvrPdf(){
    const record = dirty || !doc ? await save() : doc;
    const file:any = await api.downloadElectronicDocumentPdf(record.id);
    if (!/^application\/pdf(?:$|;)/i.test(file.blob.type)) throw new Error(uiText("Сервер вернул документ не в формате PDF"));
    setPreviewPdfUrl((current) => { if (current) URL.revokeObjectURL(current); return URL.createObjectURL(file.blob); });
  }
  async function connect(){
    setPhase("CONNECTING");
    setConnected(false);
    const client=createEsfNcaLayerClient();
    try{if(!await client.isAvailable())throw new Error(uiText("Запустите NCALayer и снова нажмите «Подписать и отправить АВР»"));const probe=await client.probe();if(!probe.officialModuleInstalled)throw new Error(uiText("В NCALayer нужен модуль ИС ЭСФ"));}finally{client.disconnect();}
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
    const validated:any=await api.validateElectronicDocument(record.id);setDoc(validated.document);setWarnings(validated.warnings||warnings);setIssues({});setPhase("VALIDATED");notifySaved(uiText("Поля документа проверены в CRM. Проверка на портале ещё не выполнена."));
  }
  async function saveBuyer(){
    const payload={...buyer,...(context.company?.iin&&!context.company?.bin?{iin:buyer.bin,bin:null}:{}),name:buyer.legalName||buyer.name||context.deal.contactName||"Заказчик"};
    if(context.company)await api.request(`/api/v1/companies/${context.company.id}`,{method:"PATCH",body:JSON.stringify(payload)});
    else{const result:any=await api.request("/api/v1/companies",{method:"POST",body:JSON.stringify(payload)});await api.request(`/api/v1/deals/${context.deal.id}`,{method:"PATCH",body:JSON.stringify({companyId:result.id})});}
    const updated:any=await api.request(`/api/v1/deals/${context.deal.id}/avr-context`);setContext(updated);setEditingBuyer(false);setIssues({});notifySaved(uiText("Реквизиты сохранены в карточке компании"));
  }
  const fieldError=(key:string)=>issues[key]?<span className="error" role="alert">{issues[key]}</span>:null;
  return <section className="avr-editor"><div className="row"><div><Link to="/documents?kind=AVR">{uiText("АВР")}</Link><h2>{doc?uiText("АВР {p0}", {p0: doc.number}):uiText("Создание АВР")}</h2></div><span className={`document-status status-${phase||(doc?.errorCode?"ERROR":doc?.status)||"DRAFT"}`}>{localizeUiOptions(labels, uiText)[phase||(doc?.errorCode?"ERROR":doc?.status)||"DRAFT"]||doc?.status}</span></div>
    {error||Object.keys(issues).length?<div ref={issueSummary} className="panel" role="alert"><b>{Object.keys(issues).length?uiText("Нужно исправить:"):error}</b>{error&&Object.keys(issues).length&& !/^Проверьте поля/.test(error)?<p>{error}</p>:null}<ul>{Object.entries(issues).map(([key,message])=><li key={key}><b>{documentFieldLabel(key)}</b>: {message}</li>)}</ul></div>:null}
    {!context?(id||params.get("dealId")?<div className="panel"><p>{error||uiText("Загружаем заполненный АВР…")}</p></div>:<div className="panel"><h3>{uiText("Сделка")}</h3><div className="actions"><button className={filter==="ready"?"btn":"btn secondary"} onClick={()=>setFilter("ready")}>{uiText("Готовы к закрытию")}</button><button className={filter==="all"?"btn":"btn secondary"} onClick={()=>setFilter("all")}>{uiText("Все незакрытые")}</button></div><label>{uiText("Найти сделку")}<input value={q} onChange={e=>setQ(e.target.value)} placeholder={uiText("Название или компания")}/></label>{!deals.length?<p>{uiText("Подходящих сделок нет. Попробуйте фильтр «Все незакрытые».")}</p>:null}{deals.map(d=><div className="card" key={d.id}><b>{d.title} — {d.companyName||d.contactName}</b><p>{uiText("Сделка #")}{d.number} · {money(d.amount)} ₸ · {d.stage} · {d.responsible||uiText("Ответственный не назначен")}</p><p>{d.paymentStatus==="PAID"?uiText("Оплачено"):uiText("Оплата не подтверждена")}{d.paidAt?` · ${new Date(d.paidAt).toLocaleDateString(uiFormatLocale())}`:""}</p><p className={d.ready?"ok":"pdf-import-warnings"}>{d.ready?uiText("Готова к закрытию"):d.reasons.map((reason: string) => uiMessage(reason)).join("; ")}</p><p>{uiMessage(d.documentState.label)}</p><button className="btn secondary" disabled={busy} onClick={()=>void loadDeal(d.id)}>{d.documentId?uiText("Открыть АВР"):uiText("Выбрать")}</button></div>)}</div>):<>
      <div className="panel"><div className="row"><h3>{uiText("Основание")}</h3>{!doc?<button className="btn secondary" disabled={busy} onClick={()=>{setContext(null);setForm(empty);setDirty(false);}}>{uiText("Выбрать другую сделку")}</button>:null}</div><Link to={`/deals/${context.deal.id}`}>{context.deal.title}</Link><p>{uiText("Сделка #")}{context.deal.number} · {context.deal.contactName||uiText("Контакт не указан")} · {context.deal.responsible||uiText("Ответственный не назначен")}</p><p>{uiText("Договор:")}{" "}{contractBasis?.number||uiText("Не указан")} · {contractBasis?.date?.slice(0,10)||uiText("Дата не указана")}</p>{warnings.map(w=><p className="pdf-import-warnings" key={w}>{uiMessage(w)}</p>)}<label>{uiText("Номер документа")}<input disabled={busy||immutable} maxLength={40} aria-invalid={Boolean(issues.number)} value={form.number||""} placeholder={uiText("Автоматически по настройкам нумерации")} onChange={e=>edit({number:e.target.value})}/>{fieldError("number")}</label><label>{uiText("Дата АВР")}<input type="date" disabled={busy||immutable} aria-invalid={Boolean(issues.documentDate)} value={form.documentDate} onChange={e=>edit({documentDate:e.target.value})}/>{fieldError("documentDate")}</label></div>
      <div className="pdf-import-parties"><div className="panel"><h3>{uiText("Исполнитель")}</h3>{localizeUiOptions(partyFields, uiText).map(([k,l])=><p key={k}>{l}: <b>{context.organization?.[k]|| (k==="bin"?context.organization?.iin:null)||uiText("Не заполнено")}</b>{fieldError(`organization.${k}`)}</p>)}<p>{uiText("НДС:")}{" "}{context.organization?.vatPayer===true?uiText("Плательщик НДС"):context.organization?.vatPayer===false?uiText("Без НДС"):uiText("Не указан")}</p><label>{uiText("Основание действия")}<input disabled={busy||immutable} value={context.organization?.directorBasis||""} onChange={e=>setContext((v:any)=>({...v,organization:{...v.organization,directorBasis:e.target.value}}))}/></label><button className="btn secondary" disabled={busy||immutable} onClick={()=>void action(async()=>{await api.updateLegalProfile({directorBasis:context.organization?.directorBasis||null});notifySaved(uiText("Основание сохранено в настройках организации"));})}>{uiText("Сохранить основание")}</button><Link className="btn secondary" to="/settings#company-requisites" target="_blank">{uiText("Заполнить данные")}</Link><button className="btn secondary" disabled={busy||immutable} onClick={()=>void action(async()=>{const r:any=await api.request(`/api/v1/deals/${context.deal.id}/avr-context`);setContext(r);})}>{uiText("Обновить реквизиты")}</button></div>
      <div className="panel"><h3>{uiText("Заказчик")}</h3><p>{uiText("Контактное лицо:")}{" "}{context.deal.contactName||uiText("Не указано")}</p>{localizeUiOptions(partyFields, uiText).map(([k,l])=>editingBuyer?<label key={k}>{l}<input value={buyer[k]||""} onChange={e=>setBuyer(v=>({...v,[k]:e.target.value}))}/>{fieldError(`customer.${k}`)}</label>:<p key={k}>{l}: <b>{context.company?.[k]||(k==="legalName"?context.company?.name:k==="bin"?context.company?.iin:null)||uiText("Не заполнено")}</b>{fieldError(`customer.${k}`)}</p>)}{fieldError("customer.company")}{!context.company?.bin&&!context.company?.iin?<p className="pdf-import-warnings">{uiText("Для отправки АВР необходимо заполнить БИН / ИИН заказчика.")}</p>:null}{editingBuyer?<button className="btn" disabled={busy} onClick={()=>void action(saveBuyer)}>{uiText("Сохранить в компании")}</button>:<button className="btn secondary" disabled={busy||immutable} onClick={()=>{setBuyer(Object.fromEntries(localizeUiOptions(partyFields, uiText).map(([k])=>[k,context.company?.[k]||(k==="legalName"?context.company?.name:k==="bin"?context.company?.iin:"")||""])));setEditingBuyer(true);}}>{uiText("Заполнить данные")}</button>}</div></div>
      <div className="panel"><h3>{uiText("Позиции АВР")}</h3>{fieldError("deal.items")}{form.items.map((r,i)=><fieldset disabled={busy||immutable} className="avr-line" key={i}><label>{uiText("Работа / услуга")}<input aria-invalid={Boolean(issues[`items.${i}.name`])} value={r.name} onChange={e=>item(i,{name:e.target.value})}/>{fieldError(`items.${i}.name`)}</label><label>{uiText("Количество")}<input type="number" min="0.001" step="0.001" aria-invalid={Boolean(issues[`items.${i}.quantity`])} value={r.quantity} onChange={e=>item(i,{quantity:Number(e.target.value)})}/>{fieldError(`items.${i}.quantity`)}</label><label>{uiText("Ед. изм.")}<EsfMeasureUnitSelect aria-label={uiText("Единица измерения {p0}", {p0: i+1})} invalid={Boolean(issues[`items.${i}.unit`])} value={r.unit} onChange={unit=>item(i,{unit})}/>{fieldError(`items.${i}.unit`)}</label><label>{uiText("Цена без НДС")}<input type="number" min="0" step="0.01" aria-invalid={Boolean(issues[`items.${i}.unitPrice`])} value={r.unitPrice} onChange={e=>item(i,{unitPrice:Number(e.target.value)})}/>{fieldError(`items.${i}.unitPrice`)}</label><label>{uiText("НДС, %")}<input type="number" min="0" max="100" step="0.01" aria-invalid={Boolean(issues[`items.${i}.vatRate`])} value={r.vatRate} onChange={e=>item(i,{vatRate:Number(e.target.value)})}/>{fieldError(`items.${i}.vatRate`)}</label><p>{money(totals?.rows[i].totalAmount)} ₸</p><button className="btn secondary" disabled={busy||immutable} onClick={()=>edit({items:form.items.filter((_,n)=>n!==i)})}>{uiText("Удалить")}</button></fieldset>)}<button className="btn secondary" disabled={busy||immutable} onClick={()=>edit({items:[...form.items,{name:"",quantity:1,unit:ESF_DEFAULT_MEASURE_UNIT_CODE,unitPrice:0,vatRate:Number(context.organization?.defaultVatRate||0)}]})}>{uiText("+ Добавить позицию")}</button><p>{uiText("Без НДС:")}{" "}{money(totals?.totals.amountWithoutVat)} {" "}{uiText("₸ · НДС:")}{" "}{money(totals?.totals.vatAmount)} ₸ · <b>{uiText("Итого:")}{" "}{money(totals?.totals.totalAmount)} ₸</b></p>{fieldError("")}{fieldError("deal.amount")}<div className="actions"><button className="btn" disabled={busy||immutable} onClick={()=>void action(async()=>{await save();notifySaved(uiText("Черновик АВР сохранён"));})}>{uiText("Сохранить черновик")}</button>{doc?<button className="btn secondary" disabled={busy} onClick={()=>void action(previewAvrPdf)}>{uiText("Просмотреть PDF")}</button>:null}{doc&&!localSigning?.status?<button className="btn secondary" disabled={busy} onClick={()=>void action(deleteCurrentAvr)}>{uiText("Удалить АВР")}</button>:null}</div>{previewPdfUrl?<div className="avr-pdf-preview"><div className="row"><h3>{uiText("Просмотр PDF")}</h3><button className="btn secondary" type="button" onClick={()=>{URL.revokeObjectURL(previewPdfUrl);setPreviewPdfUrl("");}}>{uiText("Закрыть просмотр")}</button></div><PdfDocumentViewer title={uiText("АВР {p0}", {p0: doc?.number||""})} src={previewPdfUrl}/></div>:null}</div>
      <div className="panel"><h3>{uiText("Локальный АВР")}</h3><p className="muted">{uiText("Форма Р-1 (приказ МФ РК № 562) для печати и архива. Excel и PDF собираются в CRM из того же бланка, без входа в ИС ЭСФ.")}</p><div className="actions"><button className="btn secondary" disabled={busy} onClick={()=>void action(async()=>{const record=dirty||!doc?await save():doc;await downloadAvrExcel(record.id);notifySaved(uiText("Excel-файл АВР скачан"));})}>{uiText("Скачать Excel")}</button><button className="btn secondary" disabled={busy} onClick={()=>void action(async()=>{const record=dirty||!doc?await save():doc;await downloadAvrPdf(record.id);notifySaved(uiText("PDF-файл АВР скачан"));})}>{uiText("Скачать PDF")}</button></div></div>
      <div className="panel" id="basqar-sign"><h3>{uiText("Подписание в BasQar")}</h3>
        <p className="muted">{uiText("Исполнитель подписывает АВР своей ЭЦП, затем передаёт ссылку заказчику. Заказчик подписывает через NCALayer без регистрации в BasQar.")}</p>
        {!basqar ? <p className="muted">{uiText("Выберите один способ подписания этого АВР: BasQar или ИС ЭСФ. Перед подписью проверьте скачанный PDF. После начала подписания содержание АВР фиксируется.")}</p> : <p className="muted">{uiText("Для подписи зафиксирован один PDF. Реквизиты и содержание этой версии больше не изменяются.")}</p>}
        {(!doc || basqar || !immutable) && !localSigning?.signers?.some((s:any)=>s.role==="SELLER") ? <button className="btn" disabled={busy||editingBuyer||!CONTRACT_SIGNING_ENABLED} onClick={()=>void action(signLocally)}>{uiText("Подписать АВР в BasQar")}</button> : null}
        {localSigning?.signers?.some((s:any)=>s.role==="SELLER") && localSigning.status!=="SIGNED" ? <div className="actions">
          <button className="btn" disabled={busy} onClick={()=>void action(sendLocalLink)}>{localSigning.expiresAt ? uiText("Создать новую ссылку заказчику") : uiText("Отправить на подпись клиенту")}</button>
          <button className="btn secondary" disabled={busy} onClick={()=>void action(()=>reloadLocalSigning(doc.id))}>{uiText("Обновить статус подписи")}</button>
          <button className="btn secondary" disabled={busy} onClick={()=>void action(cancelLocalSigning)}>{uiText("Отменить подпись и исправить АВР")}</button>
        </div> : null}
        {localSigning?.declinedAt ? <p className="error">{uiText("Заказчик отклонил АВР")}{localSigning.declineReason ? `: ${localSigning.declineReason}` : "."}</p> : null}
        {localSigning?.expiresAt && localSigning.status!=="SIGNED" ? <p className="muted">{uiText("Ссылка действует до")}{" "}{new Date(localSigning.expiresAt).toLocaleString(uiFormatLocale())}{uiText(". Новая ссылка заменяет предыдущую.")}</p> : null}
        {buyerLink ? <div><label>{uiText("Ссылка для заказчика")}<input readOnly value={buyerLink} onFocus={e=>e.target.select()}/></label><button className="btn secondary" disabled={busy} onClick={()=>void action(async()=>{await navigator.clipboard.writeText(buyerLink);notifySaved(uiText("Ссылка скопирована"));})}>{uiText("Скопировать ссылку")}</button><a className="btn secondary" href={buyerLink} target="_blank" rel="noreferrer">{uiText("Открыть страницу подписания")}</a></div> : null}
        <ContractSignatureSummary documentLabel={uiText("АВР")} signed={localSigning?.status==="SIGNED"} signers={localSigning?.signers||[]} sellerName={localSigning?.sellerName} buyerName={localSigning?.buyerName} verificationUrl={localSigning?.verificationUrl} download={format=>api.downloadSignedAvr(doc.id,format)} />
      </div>
      {!basqar ? <div className="panel" id="sign" ref={signPanel} style={{scrollMarginTop:24}}><h3>{uiText("Подписание и отправка в ИС ЭСФ")}</h3><p className="muted">{uiText("Проверьте реквизиты и позиции выше. Отправка в ИС ЭСФ начинается только после нажатия «Подписать и отправить АВР» на этой странице.")}</p><p className="muted">{uiText("На тестовом стенде используйте свои действующие ключи НУЦ: ключ для входа и ключ подписи организации. Демо-ключи из SDK ЭСФ принадлежат чужому БИН и для вашей организации не подойдут.")}</p><p className={connected?"ok":"muted"}>{connected?uiText("NCALayer подключён"):uiText("NCALayer подключится при нажатии «Подписать и отправить АВР»")}</p>{connection?<p>{connection.organization?.legalName} {" "}{uiText("· БИН")}{" "}{connection.connection?.organizationBin} {" "}{uiText("· Сертификат")}{" "}{connection.connection?.certificateSerial}</p>:null}<label>{uiText("ИИН пользователя для авторизации ЭСФ")}<input aria-invalid={Boolean(issues.iin)} value={iin} maxLength={12} onChange={e=>setIin(e.target.value.replace(/\D/g,""))}/>{fieldError("iin")}</label>{askCabinet?<label>{uiText("Пароль кабинета ИС ЭСФ")}<input type="password" autoComplete="current-password" disabled={busy} value={cabinetPassword} onChange={e=>setCabinetPassword(e.target.value)}/><span className="muted">{uiText("Используется только для входа в ИС ЭСФ и не сохраняется. PIN ЭЦП вводится в NCALayer.")}</span>{fieldError("cabinetPassword")}</label>:null}{fieldError("signedAuthTicket")}{fieldError("authCmsBase64")}{fieldError("publicCertificate")}{fieldError("signature")}{fieldError("ncalayer")}<div className="actions"><button className="btn secondary" disabled={busy||immutable} onClick={()=>void action(async()=>{const record=dirty||!doc?await save():doc;await check(record);})}>{uiText("Проверить документ")}</button><button className="btn" disabled={busy||immutable||editingBuyer} onClick={()=>void action(async()=>{const record=dirty||!doc?await save():doc;await check(record);await connect();const result:any=await signAndSendEsfDocument(record.id,setPhase);setDoc(result.sent.document);setPhase("");notifySaved(uiText("АВР отправлен"));})}>{uiText("Подписать и отправить АВР")}</button>{doc?.externalId?<button className="btn secondary" disabled={busy} onClick={()=>void action(async()=>{await api.refreshElectronicDocumentEsf(doc.id);const r:any=await api.request(`/api/v1/electronic-documents/${doc.id}`);setDoc(r.document);})}>{uiText("Обновить статус")}</button>:null}</div>{doc?.errorMessage?<p className="error">{doc.errorMessage}</p>:null}{doc?.externalId?<p>{uiText("Номер регистрации:")}{" "}{doc.externalNumber||doc.externalId}</p>:null}</div> : null}
    </>}
  </section>;
}
