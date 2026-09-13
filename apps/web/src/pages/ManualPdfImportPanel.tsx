import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { INVOICE_PAYMENT_KIND_LABEL, type InvoiceImportMatches, type PdfImportDraft, type PdfImportParty, type PdfImportPreview } from "@creolab/contracts";
import { api } from "../lib/api";
import { notifySaved } from "../components/SaveNotice";

const partyFields: Array<[keyof PdfImportParty,string]> = [["name","Название"],["bin","БИН / ИИН"],["legalAddress","Юридический адрес"],["iban","ИИК / IBAN"],["bankName","Банк"],["bik","БИК"],["directorName","Директор"]];
function readBase64(file: File) {
  return new Promise<string>((resolve,reject)=>{
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Не удалось прочитать файл"));
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.readAsDataURL(file);
  });
}
export function ManualPdfImportPanel({ onSaved }: { onSaved: () => void }) {
  const [open,setOpen] = useState(false);
  const [kind,setKind] = useState<"CONTRACT"|"INVOICE">("CONTRACT");
  const [file,setFile] = useState<File|null>(null);
  const [fileUrl,setFileUrl] = useState("");
  const [preview,setPreview] = useState<PdfImportPreview|null>(null);
  const [draft,setDraft] = useState<PdfImportDraft|null>(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const [dealId,setDealId] = useState("");
  const [deals,setDeals] = useState<Array<{id:string;title:string}>>([]);
  const [matches,setMatches] = useState<InvoiceImportMatches|null>(null);
  const [matching,setMatching] = useState(false);
  const [matchError,setMatchError] = useState("");
  const [saved,setSaved] = useState<{dealId:string;kind:string}|null>(null);
  useEffect(()=>{
    if (!file) { setFileUrl(""); return; }
    const url=URL.createObjectURL(file);setFileUrl(url);
    return ()=>URL.revokeObjectURL(url);
  },[file]);
  useEffect(()=>{
    if (!open || kind !== "INVOICE") return;
    void api.request<{items:Array<{id:string;title:string}>}>("/api/v1/deals?view=list")
      .then(res=>setDeals(res.items)).catch(err=>setError(err.message));
  },[open,kind]);
  useEffect(()=>{
    setDealId("");setMatches(null);setMatchError("");
    if (!preview || draft?.kind !== "INVOICE" || !/^\d{12}$/.test(draft.buyer.bin)) { setMatching(false);return; }
    let active=true;
    setMatching(true);
    const timer=setTimeout(()=>{
      void api.request<InvoiceImportMatches>(`/api/v1/documents/import-pdf/matches?buyerBin=${encodeURIComponent(draft.buyer.bin)}&contractNumber=${encodeURIComponent(draft.contractNumber||"")}`)
        .then(result=>{if(active){setMatches(result);setDealId(result.suggestedDealId||"");}})
        .catch(err=>{if(active)setMatchError(err.message);})
        .finally(()=>{if(active)setMatching(false);});
    },250);
    return ()=>{active=false;clearTimeout(timer);};
  },[preview?.importId,draft?.kind,draft?.buyer.bin,draft?.contractNumber]);
  async function discard() {
    if (busy) return;
    setError("");
    try {
      if (preview) await api.request(`/api/v1/documents/import-pdf/${preview.importId}`,{method:"DELETE"});
      setOpen(false);setPreview(null);setDraft(null);setFile(null);
    } catch (err) { setError(err instanceof Error ? err.message : "Не удалось отменить загрузку"); }
  }
  async function recognize() {
    if (busy || !file) return;
    if (!(kind === "CONTRACT" ? /\.(pdf|docx|doc)$/i : /\.pdf$/i).test(file.name) || file.size>20*1024*1024) { setError(kind === "CONTRACT" ? "Выберите договор PDF или Word (.docx, .doc) размером до 20 МБ" : "Выберите счёт PDF размером до 20 МБ");return; }
    setBusy(true);setError("");
    try {
      const result = await api.request<PdfImportPreview>("/api/v1/documents/import-pdf/preview",{method:"POST",body:JSON.stringify({kind,fileName:file.name,fileBase64:await readBase64(file)})});
      setPreview(result);setDraft(result.draft);
    } catch (err) { setError(err instanceof Error ? err.message : "Не удалось распознать документ"); }
    finally { setBusy(false); }
  }
  async function save() {
    if (busy || matching || !preview || !draft) return;
    setBusy(true);setError("");
    try {
      const result=await api.request<{dealId:string;kind:string;warning?:string|null}>("/api/v1/documents/import-pdf/confirm",{method:"POST",body:JSON.stringify({importId:preview.importId,draft,dealId:kind==="INVOICE"?dealId:undefined})});
      if (result.warning) setError(result.warning);
      setSaved(result);setOpen(false);setPreview(null);setDraft(null);setFile(null);
      notifySaved(kind==="CONTRACT"?"Договор загружен, сделка создана":"Счёт добавлен в сделку");
      onSaved();
    } catch (err: any) {
      const fields=err?.body?.field_errors;
      setError(fields ? `${err.message}: ${Object.values(fields).flat().join("; ")}` : err instanceof Error?err.message:"Не удалось сохранить документ");
    } finally { setBusy(false); }
  }
  const round = (value:number) => Math.round((value+Number.EPSILON)*100)/100;
  const total=round(draft?.items.reduce((sum,item)=>{
    const base=round(item.quantity*item.unitPrice);
    return sum+round(base+round(base*item.vatRate/100));
  },0) || 0);
  function updateItem(index:number,patch:Partial<PdfImportDraft["items"][number]>) {
    if (!draft) return;
    setDraft({...draft,items:draft.items.map((item,i)=>i===index?{...item,...patch}:item)});
  }
  return <div className="panel manual-pdf-import">
    <div className="saved-editor-summary">
      <div><b>Загрузить готовый документ</b><p className="muted">Договор PDF или Word (.docx, .doc) → реквизиты, состав работ и новая сделка. PDF счёта → выбранная сделка.</p></div>
      {!open?<button type="button" className="btn" onClick={()=>{setOpen(true);setSaved(null);setError("");}}>Загрузить документ</button>:null}
    </div>
    {saved?<p className="ok">{saved.kind==="CONTRACT"?"Договор сохранён и связан с новой сделкой.":"Счёт сохранён."} <Link to={`/deals/${saved.dealId}`}>Открыть сделку</Link></p>:null}
    {error?<p className="error" role="alert">{error}</p>:null}
    {open?<>
      {!preview?<div className="stack">
        <label>Тип документа<select value={kind} disabled={busy} onChange={e=>{setKind(e.target.value as typeof kind);setFile(null);setError("");}}><option value="CONTRACT">Договор</option><option value="INVOICE">Счёт на оплату</option></select></label>
        <label>{kind === "CONTRACT" ? "Файл договора (PDF, DOCX, DOC)" : "PDF-файл счёта"}<input key={kind} type="file" accept={kind === "CONTRACT" ? ".pdf,.docx,.doc,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "application/pdf,.pdf"} disabled={busy} onChange={e=>{setFile(e.target.files?.[0]||null);setError("");}}/></label>
        <p className="muted">До 20 МБ и 20 страниц. PDF, сканы и Word распознаются на сервере CRM. Для Word создаётся PDF-копия; оригинал сохраняется.</p>
        <div className="actions"><button type="button" className="btn" disabled={busy||!file} onClick={()=>void recognize()}>{busy?"Распознаём страницы…":"Распознать документ"}</button><button type="button" className="btn secondary" disabled={busy} onClick={()=>void discard()}>Отмена</button></div>
        {busy?<p role="status">Распознавание скана может занять несколько минут. Дождитесь формы проверки.</p>:null}
      </div>:draft?<form onSubmit={e=>{e.preventDefault();void save();}}>
        <p>{preview.fileName} · {preview.pageCount} стр. · {preview.usedOcr?"Распознан скан":"Извлечён текст"} {fileUrl?<a href={fileUrl} target="_blank" rel="noreferrer">Открыть исходный файл</a>:null}</p>
        <p className="muted">Проверьте поля перед сохранением. Загрузка документа не подтверждает электронную подпись или оплату.</p>
        {preview.warnings.length?<ul className="pdf-import-warnings">{preview.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul>:null}
        <fieldset disabled={busy} className="pdf-import-fields">
          <div className="deal-edit">
            <label>Номер {kind==="CONTRACT"?"договора":"счёта"}<input required value={draft.number} onChange={e=>setDraft({...draft,number:e.target.value})}/></label>
            <label>Дата документа<input required type="date" value={draft.date} onChange={e=>setDraft({...draft,date:e.target.value})}/></label>
            <label>{kind==="CONTRACT"?"Заказ / название сделки":"Содержание счёта"}<textarea required maxLength={1000} value={draft.subject} onChange={e=>setDraft({...draft,subject:e.target.value})}/></label>
          </div>
          {kind==="INVOICE"?<div className="stack">
            <label>Назначение счёта<select value={draft.paymentKind||"UNSPECIFIED"} onChange={e=>setDraft({...draft,paymentKind:e.target.value as PdfImportDraft["paymentKind"]})}>{Object.entries(INVOICE_PAYMENT_KIND_LABEL).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
            <label>Номер договора из счёта<input maxLength={100} value={draft.contractNumber||""} onChange={e=>setDraft({...draft,contractNumber:e.target.value})}/></label>
            {matching?<p role="status">Ищем компанию и сделку…</p>:null}
            {matchError?<p className="error">Не удалось подобрать компанию: {matchError}. Выберите сделку вручную.</p>:null}
            {matches?<p className="muted">{matches.companies.length ? `По БИН / ИИН найдены: ${matches.companies.map(c=>c.name).join("; ")}. ${matches.suggestedDealId?"Сделка подобрана автоматически — проверьте выбор.":"Выберите нужную сделку."}` : "Компания с этим БИН / ИИН не найдена. Выберите сделку без компании: при сохранении будет создана и привязана карточка заказчика."}</p>:null}
            <label>Сделка для счёта<select required disabled={matching} value={dealId} onChange={e=>setDealId(e.target.value)}><option value="">Выберите сделку</option>
              {matches?.deals.length?<optgroup label="Сделки заказчика">{matches.deals.map(d=><option key={d.id} value={d.id}>{d.title}</option>)}</optgroup>:null}
              <optgroup label="Другие сделки">{deals.filter(d=>!matches?.deals.some(m=>m.id===d.id)).map(d=><option key={d.id} value={d.id}>{d.title}</option>)}</optgroup>
            </select></label>
          </div>:null}
          <div className="actions"><button type="button" className="btn secondary" onClick={()=>setDraft({...draft,buyer:draft.seller,seller:draft.buyer,contactName:"",contactPhone:""})}>Поменять заказчика и исполнителя местами</button></div>
          <div className="pdf-import-parties">{(["buyer","seller"] as const).map(side=><div key={side} className="card">
            <h3>{side==="buyer"?"Заказчик":"Исполнитель"}</h3>
            {partyFields.map(([key,label])=><label key={key}>{label} ({side==="buyer"?"заказчик":"исполнитель"})<input required={key==="name"&&side==="buyer"&&kind==="CONTRACT"} value={draft[side][key]} onChange={e=>setDraft({...draft,[side]:{...draft[side],[key]:e.target.value}})}/></label>)}
            {side==="seller"?(kind==="CONTRACT"?<p className="muted">Пустые реквизиты вашей организации будут заполнены данными исполнителя. Заполненные значения сохранятся. При несовпадении БИН перенос не выполняется.</p>:null):<p className="muted">{kind==="CONTRACT"?"Компания сопоставляется по БИН. В существующей карточке заполняются только пустые реквизиты.":"Компания определяется по БИН / ИИН. Если у сделки ещё нет компании, заказчик будет привязан при сохранении. Реквизиты существующей компании сохранятся."}</p>}
          </div>)}</div>
          {kind==="CONTRACT"?<div className="deal-edit"><label>Контактное лицо заказчика<input value={draft.contactName} onChange={e=>setDraft({...draft,contactName:e.target.value})}/></label><label>Телефон заказчика<input required type="tel" value={draft.contactPhone} onChange={e=>setDraft({...draft,contactPhone:e.target.value})}/></label></div>:null}
          <h3>Состав работ / позиции счёта</h3>
          {draft.items.map((item,i)=><div className="card pdf-import-item" key={i}>
            <label>Работа / товар {i+1}<input required value={item.name} onChange={e=>updateItem(i,{name:e.target.value})}/></label>
            <label>Количество {i+1}<input required type="number" min="0.001" step="0.001" value={item.quantity} onChange={e=>updateItem(i,{quantity:Number(e.target.value)})}/></label>
            <label>Единица {i+1}<input required value={item.unit} onChange={e=>updateItem(i,{unit:e.target.value})}/></label>
            <label>Цена без НДС {i+1}<input required type="number" min="0" step="0.01" value={item.unitPrice} onChange={e=>updateItem(i,{unitPrice:Number(e.target.value)})}/></label>
            <label>НДС, % {i+1}<input required type="number" min="0" max="100" step="0.01" value={item.vatRate} onChange={e=>updateItem(i,{vatRate:Number(e.target.value)})}/></label>
            <p>Сумма с НДС: {round(round(item.quantity*item.unitPrice)*(1+item.vatRate/100)).toLocaleString("ru-RU")} ₸</p>
            <button type="button" className="btn secondary" onClick={()=>setDraft({...draft,items:draft.items.filter((_,n)=>n!==i)})}>Убрать позицию {i+1}</button>
          </div>)}
          <button type="button" className="btn secondary" onClick={()=>setDraft({...draft,items:[...draft.items,{name:"",quantity:1,unitPrice:0,vatRate:0,unit:"услуга"}]})}>Добавить позицию</button>
          <div className="deal-edit"><label>Итого в документе, ₸<input type="number" min="0" step="0.01" value={draft.detectedTotal??""} onChange={e=>setDraft({...draft,detectedTotal:e.target.value===""?null:Number(e.target.value)})}/></label><p><b>Сумма позиций с НДС: {total.toLocaleString("ru-RU")} ₸</b></p></div>
          <label>{kind==="INVOICE"?"Уточнение платежа / условия оплаты":"Условия оплаты"}<textarea value={draft.paymentTerms} onChange={e=>setDraft({...draft,paymentTerms:e.target.value})}/></label>
          <label>Сроки выполнения<textarea value={draft.completionTerms} onChange={e=>setDraft({...draft,completionTerms:e.target.value})}/></label>
          <details><summary>Распознанный текст по страницам</summary>{preview.pages.map(p=><div key={p.page}><b>Страница {p.page}</b><pre className="pdf-import-text">{p.text}</pre></div>)}</details>
          <div className="actions"><button className="btn" type="submit" disabled={!draft.items.length||busy||matching}>{busy?"Сохраняем…":kind==="CONTRACT"?"Сохранить договор и создать сделку":"Добавить счёт в сделку"}</button><button type="button" className="btn secondary" onClick={()=>void discard()}>Отмена</button></div>
        </fieldset>
      </form>:null}
    </>:null}
  </div>;
}
