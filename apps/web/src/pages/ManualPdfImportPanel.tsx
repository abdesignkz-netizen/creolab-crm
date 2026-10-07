import { InlineFeedback } from "../components/InlineFeedback";
import { uiMessage, uiText, useUiText, localizeUiOptions, uiFormatLocale } from "../lib/uiText";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ESF_DEFAULT_MEASURE_UNIT_CODE, INVOICE_PAYMENT_KIND_LABEL, type InvoiceImportMatches, type PdfImportDraft, type PdfImportParty, type PdfImportPreview } from "@creolab/contracts";
import { api } from "../lib/api";
import { EsfMeasureUnitSelect } from "../components/EsfMeasureUnitSelect";
import { notifySaved } from "../components/SaveNotice";

const partyFields: Array<[keyof PdfImportParty,string]> = [["name","Название"],["bin","БИН / ИИН"],["legalAddress","Юридический адрес"],["iban","ИИК / IBAN"],["bankName","Банк"],["bik","БИК"],["directorName","Директор"]];
function readBase64(file: File) {
  return new Promise<string>((resolve,reject)=>{
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(uiText("Не удалось прочитать файл")));
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.readAsDataURL(file);
  });
}
export function ManualPdfImportPanel({ onSaved }: { onSaved: () => void }) {
  const uiText = useUiText();
  const [open,setOpen] = useState(false);
  const [kind,setKind] = useState<"CONTRACT"|"INVOICE">("CONTRACT");
  const [file,setFile] = useState<File|null>(null);
  const [fileUrl,setFileUrl] = useState("");
  const [preview,setPreview] = useState<PdfImportPreview|null>(null);
  const [draft,setDraft] = useState<PdfImportDraft|null>(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const [dealId,setDealId] = useState("");
  const [createDeal,setCreateDeal] = useState(false);
  const [matchAttempt,setMatchAttempt] = useState(0);
  const [matches,setMatches] = useState<InvoiceImportMatches|null>(null);
  const [matching,setMatching] = useState(false);
  const [matchError,setMatchError] = useState("");
  const [sellerCompanies,setSellerCompanies] = useState<Array<{id:string;name:string}>>([]);
  const [savedCompanies,setSavedCompanies] = useState<Partial<Record<"buyer"|"seller",{id:string;name:string}>>>({});
  const [ownOrg,setOwnOrg] = useState<{bin:string;name:string}>({bin:"",name:""});
  const [saved,setSaved] = useState<{dealId:string;kind:string;createdDeal?:boolean}|null>(null);
  function taxId(value: string) {
    const digits = String(value || "").replace(/\D/g, "");
    return digits.length === 12 ? digits : "";
  }
  useEffect(()=>{
    if (!file) { setFileUrl(""); return; }
    const url=URL.createObjectURL(file);setFileUrl(url);
    return ()=>URL.revokeObjectURL(url);
  },[file]);
  useEffect(()=>{
    if (!preview) { setOwnOrg({bin:"",name:""}); return; }
    let active=true;
    void api.legalProfile().then((raw) => {
      const profile = raw as { bin?: string | null; legalName?: string | null };
      if (active) setOwnOrg({ bin: taxId(profile.bin || ""), name: String(profile.legalName || "").trim() });
    }).catch(() => { if (active) setOwnOrg({ bin: "", name: "" }); });
    return ()=>{active=false;};
  },[preview?.importId]);
  useEffect(()=>{
    setDealId("");setCreateDeal(false);setMatches(null);setSellerCompanies([]);setMatchError("");
    const buyerBin = taxId(draft?.buyer.bin || "");
    const sellerBin = taxId(draft?.seller.bin || "");
    if (!preview || (!buyerBin && !sellerBin)) { setMatching(false);return; }
    let active=true;
    setMatching(true);
    const timer=setTimeout(()=>{
      const lookups: Array<Promise<void>> = [];
      if (buyerBin) lookups.push(api.request<InvoiceImportMatches>(`/api/v1/documents/import-pdf/matches?buyerBin=${encodeURIComponent(buyerBin)}&contractNumber=${encodeURIComponent(draft?.contractNumber||"")}`)
        .then(result=>{if(active){setMatches(result);setDealId(result.suggestedDealId||"");}}));
      if (sellerBin && sellerBin !== buyerBin) lookups.push(api.request<InvoiceImportMatches>(`/api/v1/documents/import-pdf/matches?buyerBin=${encodeURIComponent(sellerBin)}`)
        .then(result=>{if(active) setSellerCompanies(result.companies);}));
      void Promise.all(lookups)
        .catch(err=>{if(active)setMatchError(err instanceof Error?err.message:uiText("Не удалось проверить компанию"));})
        .finally(()=>{if(active)setMatching(false);});
    },250);
    return ()=>{active=false;clearTimeout(timer);};
  },[preview?.importId,draft?.kind,draft?.buyer.bin,draft?.seller.bin,draft?.contractNumber,matchAttempt]);
  async function discard() {
    if (busy) return;
    setError("");
    try {
      if (preview) await api.request(`/api/v1/documents/import-pdf/${preview.importId}`,{method:"DELETE"});
      setOpen(false);setPreview(null);setDraft(null);setFile(null);setSavedCompanies({});
    } catch (err) { setError(err instanceof Error ? err.message : uiText("Не удалось отменить загрузку")); }
  }
  async function recognize() {
    if (busy || !file) return;
    if (!(kind === "CONTRACT" ? /\.(pdf|docx|doc)$/i : /\.pdf$/i).test(file.name) || file.size>20*1024*1024) { setError(kind === "CONTRACT" ? uiText("Выберите договор PDF или Word (.docx, .doc) размером до 20 МБ") : uiText("Выберите счёт PDF размером до 20 МБ"));return; }
    setBusy(true);setError("");
    try {
      const result = await api.request<PdfImportPreview>("/api/v1/documents/import-pdf/preview",{method:"POST",body:JSON.stringify({kind,fileName:file.name,fileBase64:await readBase64(file)})});
      setPreview(result);setDraft(result.draft);setSavedCompanies({});
    } catch (err) { setError(err instanceof Error ? err.message : uiText("Не удалось распознать документ")); }
    finally { setBusy(false); }
  }
  async function save() {
    if (busy || matching || !preview || !draft) return;
    setBusy(true);setError("");
    try {
      const result=await api.request<{dealId:string;kind:string;createdDeal?:boolean;warning?:string|null}>("/api/v1/documents/import-pdf/confirm",{method:"POST",body:JSON.stringify({importId:preview.importId,draft,dealId:kind==="INVOICE"&&dealId?dealId:undefined,createDeal:kind==="INVOICE"&&createDeal})});
      if (result.warning) setError(result.warning);
      setSaved(result);setOpen(false);setPreview(null);setDraft(null);setFile(null);setSavedCompanies({});
      notifySaved(kind==="CONTRACT"?uiText("Договор загружен, сделка создана"):result.createdDeal?uiText("Сделка создана, счёт сохранён"):uiText("Счёт добавлен в сделку"));
      onSaved();
    } catch (err: any) {
      const fields=err?.body?.field_errors;
      setError(fields ? `${err.message}: ${Object.values(fields).flat().join("; ")}` : err instanceof Error?err.message:uiText("Не удалось сохранить документ"));
    } finally { setBusy(false); }
  }
  async function saveCompany(side: "buyer"|"seller") {
    if (busy || !draft) return;
    if (matching && taxId(draft[side].bin)) return;
    const party = draft[side];
    const name = party.name.trim();
    if (!name) { setError(side==="buyer"?uiText("Укажите название заказчика, чтобы сохранить компанию"):uiText("Укажите название исполнителя, чтобы сохранить компанию")); return; }
    setBusy(true);setError("");
    const payload = {
      name,
      legalName: name,
      bin: taxId(party.bin) || null,
      legalAddress: (party.legalAddress || "").slice(0,400) || null,
      iban: party.iban || null,
      bankName: party.bankName || null,
      bik: party.bik || null,
      directorName: party.directorName || null,
      phone: side==="buyer" ? (draft.contactPhone || null) : null,
      initialSource: "manual_pdf",
      forceCreate: Boolean(taxId(party.bin)),
    };
    try {
      let created: {id:string;name:string};
      try {
        created = await api.createCompany(payload) as {id:string;name:string};
      } catch (err: any) {
        const binError = Boolean(payload.bin && err?.status===422 && (err?.body?.field_errors?.bin || String(err?.body?.message || err?.message || "").includes("БИН")));
        if (!binError) throw err;
        created = await api.createCompany({...payload, bin: null, forceCreate: false}) as {id:string;name:string};
      }
      setSavedCompanies((prev)=>({...prev,[side]:{id:created.id,name:created.name||name}}));
      setMatchAttempt((n)=>n+1);
      notifySaved(uiText("Компания сохранена"));
    } catch (err: any) {
      const duplicates = err?.status===409 ? (err.body?.details?.duplicates || []) : [];
      if (duplicates.length===1 && duplicates[0]?.id) {
        setSavedCompanies((prev)=>({...prev,[side]:{id:duplicates[0].id,name:duplicates[0].name||name}}));
        notifySaved(uiText("Компания уже есть в справочнике"));
        setMatchAttempt((n)=>n+1);
        return;
      }
      const fields=err?.body?.field_errors;
      setError(fields ? `${err.message}: ${Object.values(fields).flat().join("; ")}` : err instanceof Error?err.message:uiText("Не удалось сохранить компанию"));
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
      <div><b>{uiText("Загрузить готовый документ")}</b><p className="muted">{uiText("Договор PDF или Word (.docx, .doc) → реквизиты, состав работ и новая сделка. PDF счёта → автоматический подбор компании и сделки.")}</p></div>
      {!open?<button type="button" className="btn" onClick={()=>{setOpen(true);setSaved(null);setError("");}}>{uiText("Загрузить документ")}</button>:null}
    </div>
    {saved?<p className="ok">{saved.kind==="CONTRACT"?uiText("Договор сохранён и связан с новой сделкой."):saved.createdDeal?uiText("Новая сделка создана, счёт сохранён и связан с компанией."):uiText("Счёт сохранён.")} <Link to={`/deals/${saved.dealId}`}>{uiText("Открыть сделку")}</Link></p>:null}
    {error?<InlineFeedback kind="error" className="error">{error}</InlineFeedback>:null}
    {open?<>
      {!preview?<div className="stack">
        <label>{uiText("Тип документа")}<select value={kind} disabled={busy} onChange={e=>{setKind(e.target.value as typeof kind);setFile(null);setError("");}}><option value="CONTRACT">{uiText("Договор")}</option><option value="INVOICE">{uiText("Счёт на оплату")}</option></select></label>
        <label>{kind === "CONTRACT" ? uiText("Файл договора (PDF, DOCX, DOC)") : uiText("PDF-файл счёта")}<input key={kind} type="file" accept={kind === "CONTRACT" ? ".pdf,.docx,.doc,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "application/pdf,.pdf"} disabled={busy} onChange={e=>{setFile(e.target.files?.[0]||null);setError("");}}/></label>
        <p className="muted">{uiText("До 20 МБ и 20 страниц. PDF, сканы и Word распознаются на сервере CRM. Для Word создаётся PDF-копия; оригинал сохраняется.")}</p>
        <div className="actions"><button type="button" className="btn" disabled={busy||!file} onClick={()=>void recognize()}>{busy?uiText("Распознаём страницы…"):uiText("Распознать документ")}</button><button type="button" className="btn secondary" disabled={busy} onClick={()=>void discard()}>{uiText("Отмена")}</button></div>
        {busy?<p role="status">{uiText("Распознавание скана может занять несколько минут. Дождитесь формы проверки.")}</p>:null}
      </div>:draft?<form onSubmit={e=>{e.preventDefault();void save();}}>
        <p>{preview.fileName} · {preview.pageCount} {" "}{uiText("стр. ·")}{" "}{preview.usedOcr?uiText("Распознан скан"):uiText("Извлечён текст")} {fileUrl?<a href={fileUrl} target="_blank" rel="noreferrer">{uiText("Открыть исходный файл")}</a>:null}</p>
        <p className="muted">{uiText("Проверьте поля перед сохранением. Загрузка документа не подтверждает электронную подпись или оплату.")}</p>
        {preview.warnings.length?<ul className="pdf-import-warnings">{preview.warnings.map((w,i)=><li key={i}>{uiMessage(w)}</li>)}</ul>:null}
        <fieldset disabled={busy} className="pdf-import-fields">
          <div className="deal-edit">
            <label>{uiText("Номер")}{" "}{kind==="CONTRACT"?uiText("договора"):uiText("счёта")}<input required value={draft.number} onChange={e=>setDraft({...draft,number:e.target.value})}/></label>
            <label>{uiText("Дата документа")}<input required type="date" value={draft.date} onChange={e=>setDraft({...draft,date:e.target.value})}/></label>
            <label>{kind==="CONTRACT"?uiText("Заказ / название сделки"):uiText("Содержание счёта")}<textarea required maxLength={1000} value={draft.subject} onChange={e=>setDraft({...draft,subject:e.target.value})}/></label>
          </div>
          {kind==="INVOICE"?<div className="stack">
            <label>{uiText("Назначение счёта")}<select value={draft.paymentKind||"UNSPECIFIED"} onChange={e=>setDraft({...draft,paymentKind:e.target.value as PdfImportDraft["paymentKind"]})}>{Object.entries(INVOICE_PAYMENT_KIND_LABEL).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
            <label>{uiText("Номер договора из счёта")}<input maxLength={100} value={draft.contractNumber||""} onChange={e=>setDraft({...draft,contractNumber:e.target.value})}/></label>
            {matching?<p role="status">{uiText("Ищем компанию и сделку…")}</p>:null}
            {matchError?<div><p className="error">{uiText("Не удалось подобрать компанию:")}{" "}{matchError}</p><button type="button" className="btn secondary" onClick={()=>setMatchAttempt(n=>n+1)}>{uiText("Повторить подбор")}</button></div>:null}
            {!/^\d{12}$/.test(taxId(draft.buyer.bin))?<p className="muted">{uiText("Укажите БИН / ИИН заказчика ниже — компания и сделка будут подобраны автоматически.")}</p>:null}
            {matches?<div className="card">
              <b>{uiText("Заказчик:")}{" "}{matches.companies.length===1?matches.companies[0].name:draft.buyer.name}</b>
              {matches.suggestedDealId?<p>{uiText("Сделка подобрана автоматически:")}{" "}<Link to={`/deals/${matches.suggestedDealId}`}>{matches.deals.find(d=>d.id===matches.suggestedDealId)?.title}</Link></p>:null}
              {matches.canCreateDeal?<>
                <p>{matches.companies.length?uiText("У компании ещё нет сделок."):uiText("Карточка компании и сделки ещё не созданы.")} {" "}{uiText("Можно создать сделку из этого счёта.")}</p>
                {!createDeal?<button type="button" className="btn secondary" onClick={()=>setCreateDeal(true)}>{uiText("Создать сделку из счёта")}</button>:<p className="ok">{uiText("При сохранении будет создана сделка «")}{draft.subject || uiText("по счёту")}{uiText("» и привязана к заказчику.")}</p>}
              </>:!matches.suggestedDealId?<>
                <p>{matches.companies.length>1?uiText("Найдено несколько карточек с этим БИН / ИИН. Выберите сделку нужной компании."):uiText("У компании несколько сделок. Уточните, к какой относится счёт.")}</p>
                {matches.deals.length?<label>{uiText("Сделки заказчика")}<select required value={dealId} onChange={e=>setDealId(e.target.value)}><option value="">{uiText("Выберите сделку заказчика")}</option>{matches.deals.map(d=><option key={d.id} value={d.id}>{d.title}{matches.companies.length>1?` · ${matches.companies.find(c=>c.id===d.companyId)?.name}`:""}</option>)}</select></label>:<p>{uiText("Уточните дублирующиеся карточки в разделе «Компании», затем")}{" "}<button type="button" className="btn secondary" onClick={()=>setMatchAttempt(n=>n+1)}>{uiText("Повторить подбор")}</button></p>}
              </>:null}
            </div>:null}
          </div>:null}
          <div className="actions"><button type="button" className="btn secondary" onClick={()=>{setSavedCompanies({buyer:savedCompanies.seller,seller:savedCompanies.buyer});setDraft({...draft,buyer:draft.seller,seller:draft.buyer,contactName:"",contactPhone:""});}}>{uiText("Поменять заказчика и исполнителя местами")}</button></div>
          <div className="pdf-import-parties">{(["buyer","seller"] as const).map(side=>{
            const partyBin = taxId(draft[side].bin);
            const known = side==="buyer"
              ? (matches?.companies.length ? matches.companies : savedCompanies.buyer ? [savedCompanies.buyer] : [])
              : (sellerCompanies.length ? sellerCompanies : savedCompanies.seller ? [savedCompanies.seller] : []);
            const ownByBin = Boolean(ownOrg.bin && partyBin && partyBin === ownOrg.bin);
            const ownByName = !partyBin && Boolean(ownOrg.name) && ownOrg.name.replace(/\s+/g,"").toLowerCase() === draft[side].name.replace(/\s+/g,"").toLowerCase();
            const isOwn = ownByBin || ownByName;
            const looking = matching && Boolean(partyBin);
            const isNew = !isOwn && known.length===0 && Boolean(draft[side].name.trim());
            return <div key={side} className="card">
            <h3>{side==="buyer"?uiText("Заказчик"):uiText("Исполнитель")}</h3>
            {localizeUiOptions(partyFields, uiText).map(([key,label])=><label key={key}>{label} ({side==="buyer"?uiText("заказчик"):uiText("исполнитель")})<input required={key==="name"&&side==="buyer"&&kind==="CONTRACT"} value={draft[side][key]} onChange={e=>{if(key==="name"||key==="bin") setSavedCompanies((prev)=>({...prev,[side]:undefined})); setDraft({...draft,[side]:{...draft[side],[key]:e.target.value}});}}/></label>)}
            {isOwn && kind==="CONTRACT"?<p className="muted">{uiText("Пустые реквизиты вашей организации будут заполнены данными этой стороны. Заполненные значения сохранятся. При несовпадении БИН перенос не выполняется.")}</p>:null}
            {!isOwn && looking?<p role="status">{uiText("Ищем компанию в справочнике…")}</p>:null}
            {!isOwn && matchError && side==="buyer"?<p className="error">{uiText("Не удалось проверить компанию:")}{" "}{matchError}</p>:null}
            {!isOwn && known.length===1?<p className="ok">{uiText("Компания уже есть в справочнике:")}{" "}<Link to={`/companies/${known[0].id}`}>{known[0].name}</Link>{uiText(". При сохранении документа заполнятся только пустые реквизиты.")}</p>:null}
            {!isOwn && known.length>1?<p className="pdf-import-warnings">{uiText("Найдено несколько карточек с этим БИН / ИИН. Уточните дубли в разделе «Компании».")}</p>:null}
            {isNew?<div className="pdf-import-save-company">
              <p>{uiText("Этой компании ещё нет в справочнике. Сохраните карточку — договор можно будет сразу привязать к ней.")}</p>
              <button type="button" className="btn" disabled={busy||(matching&&Boolean(partyBin))} onClick={()=>void saveCompany(side)}>{uiText("Сохранить компанию")}</button>
            </div>:null}
            {!isOwn && !isNew && !known.length && !looking?<p className="muted">{kind==="CONTRACT"?uiText("Компания сопоставляется по БИН. В существующей карточке заполняются только пустые реквизиты."):uiText("Компания определяется по БИН / ИИН. Если у сделки ещё нет компании, заказчик будет привязан при сохранении. Реквизиты существующей компании сохранятся.")}</p>:null}
            {!isOwn && side==="seller" && kind==="CONTRACT" && !isNew && !known.length?<p className="muted">{uiText("Пустые реквизиты вашей организации будут заполнены данными исполнителя. Заполненные значения сохранятся. При несовпадении БИН перенос не выполняется.")}</p>:null}
          </div>;
          })}</div>
          {kind==="CONTRACT"?<div className="deal-edit"><label>{uiText("Контактное лицо заказчика")}<input value={draft.contactName} onChange={e=>setDraft({...draft,contactName:e.target.value})}/></label><label>{uiText("Телефон заказчика")}<input required type="tel" value={draft.contactPhone} onChange={e=>setDraft({...draft,contactPhone:e.target.value})}/></label></div>:null}
          <h3>{uiText("Состав работ / позиции счёта")}</h3>
          {draft.items.map((item,i)=><div className="card pdf-import-item" key={i}>
            <label>{uiText("Работа / товар")}{" "}{i+1}<input required value={item.name} onChange={e=>updateItem(i,{name:e.target.value})}/></label>
            <label>{uiText("Количество")}{" "}{i+1}<input required type="number" min="0.001" step="0.001" value={item.quantity} onChange={e=>updateItem(i,{quantity:Number(e.target.value)})}/></label>
            <label>{uiText("Ед. изм.")}{" "}{i+1}<EsfMeasureUnitSelect required aria-label={uiText("Единица измерения {p0}", {p0: i+1})} value={item.unit} onChange={unit=>updateItem(i,{unit})}/></label>
            <label>{uiText("Цена без НДС")}{" "}{i+1}<input required type="number" min="0" step="0.01" value={item.unitPrice} onChange={e=>updateItem(i,{unitPrice:Number(e.target.value)})}/></label>
            <label>{uiText("НДС, %")}{" "}{i+1}<input required type="number" min="0" max="100" step="0.01" value={item.vatRate} onChange={e=>updateItem(i,{vatRate:Number(e.target.value)})}/></label>
            <p>{uiText("Сумма с НДС:")}{" "}{round(round(item.quantity*item.unitPrice)*(1+item.vatRate/100)).toLocaleString(uiFormatLocale())} ₸</p>
            <button type="button" className="btn secondary" onClick={()=>setDraft({...draft,items:draft.items.filter((_,n)=>n!==i)})}>{uiText("Убрать позицию")}{" "}{i+1}</button>
          </div>)}
          <button type="button" className="btn secondary" onClick={()=>setDraft({...draft,items:[...draft.items,{name:"",quantity:1,unitPrice:0,vatRate:0,unit:ESF_DEFAULT_MEASURE_UNIT_CODE}]})}>{uiText("Добавить позицию")}</button>
          <div className="deal-edit"><label>{uiText("Итого в документе, ₸")}<input type="number" min="0" step="0.01" value={draft.detectedTotal??""} onChange={e=>setDraft({...draft,detectedTotal:e.target.value===""?null:Number(e.target.value)})}/></label><p><b>{uiText("Сумма позиций с НДС:")}{" "}{total.toLocaleString(uiFormatLocale())} ₸</b></p></div>
          <label>{kind==="INVOICE"?uiText("Уточнение платежа / условия оплаты"):uiText("Условия оплаты")}<textarea value={draft.paymentTerms} onChange={e=>setDraft({...draft,paymentTerms:e.target.value})}/></label>
          <label>{uiText("Сроки выполнения")}<textarea value={draft.completionTerms} onChange={e=>setDraft({...draft,completionTerms:e.target.value})}/></label>
          <details><summary>{uiText("Распознанный текст по страницам")}</summary>{preview.pages.map(p=><div key={p.page}><b>{uiText("Страница")}{" "}{p.page}</b><pre className="pdf-import-text">{p.text}</pre></div>)}</details>
          <div className="actions"><button className="btn" type="submit" disabled={!draft.items.length||busy||matching||(kind==="INVOICE"&&(!matches||(!dealId&&!createDeal)))}>{busy?uiText("Сохраняем…"):kind==="CONTRACT"?uiText("Сохранить договор и создать сделку"):createDeal?uiText("Создать сделку и сохранить счёт"):uiText("Сохранить счёт в сделке")}</button><button type="button" className="btn secondary" onClick={()=>void discard()}>{uiText("Отмена")}</button></div>
        </fieldset>
      </form>:null}
    </>:null}
  </div>;
}
