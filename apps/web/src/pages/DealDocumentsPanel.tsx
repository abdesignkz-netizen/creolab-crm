import { EsfSubmissionStatus, ESF_SEND_PHASES, type EsfSubmission } from "../components/EsfSubmissionStatus";
import { notifySaved } from "../components/SaveNotice";
import { esfMeasureUnitShortLabel, INVOICE_PAYMENT_KIND_LABEL, type PdfImportDraft } from "@creolab/contracts";
import { DeleteContractButton } from "../components/DeleteContractButton";
import { ContractPreviewModal } from "../components/ContractPreviewModal";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { api, downloadAvrExcel, downloadAvrPdf } from "../lib/api";
import { signAndSendEsfDocument } from "../lib/signing/esfSignAndSend";
import { ensureEsfCabinetSession } from "../lib/signing/esfConnect";
import { createSigningClient, ncalayerUserMessage } from "../lib/signing/ncalayerClient";
import { CONTRACT_SIGNING_ENABLED } from "../lib/featureFlags";
import { signatureCheckLabel } from "../lib/signing/verificationLabels";
import { tip } from "../lib/tip";

type ContractReviewState = { viewed: boolean; confirmed: boolean };

function contractReviewKey(fileKey: string) {
  return `basqar-contract-review:${fileKey}`;
}

function readContractReview(fileKey: string): ContractReviewState {
  if (!fileKey) return { viewed: false, confirmed: false };
  try {
    const parsed = JSON.parse(sessionStorage.getItem(contractReviewKey(fileKey)) || "null");
    return { viewed: Boolean(parsed?.viewed), confirmed: Boolean(parsed?.confirmed) };
  } catch {
    return { viewed: false, confirmed: false };
  }
}

function writeContractReview(fileKey: string, state: ContractReviewState) {
  if (!fileKey) return;
  sessionStorage.setItem(contractReviewKey(fileKey), JSON.stringify(state));
}

const CONTRACT_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Черновик",
  READY_TO_SIGN: "Сформирован",
  PENDING_SIGNATURE: "На подписи",
  PARTIALLY_SIGNED: "Частично подписан",
  SIGNED: "Подписан",
};

const INVOICE_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Черновик",
  ISSUED: "Выставлен",
  PARTIALLY_PAID: "Частично оплачен",
  PAID: "Оплачен",
  OVERDUE: "Просрочен",
  CANCELLED: "Отменён",
};

const EDOC_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Черновик",
  VALIDATED: "Проверен",
  SIGNED: "Подписан",
  SENDING: "Ожидается подтверждение отправки",
  ERROR: "Ошибка",
  SENT: "Отправлен",
  ACCEPTED: "Подтверждён",
};

const AWP_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Черновик ИС ЭСФ",
  NOT_VIEWED: "Не просмотрен",
  DELIVERED: "Доставлен",
  CREATED: "Создан",
  IMPORTED: "Импортирован",
  FAILED: "Ошибочный",
  CONFIRMED: "Подтверждён",
  DECLINED: "Отклонён",
  REVOKED: "Отозван",
  IN_TERMINATING: "Расторжение",
  TERMINATED: "Расторгнут",
};

const INVOICE_ESF_STATUS_LABEL: Record<string, string> = {
  IN_QUEUE: "В очереди",
  IN_PROCESSING: "В обработке",
  CREATED: "Создан",
  DELIVERED: "Доставлен",
  CANCELED: "Аннулирован",
  CANCELED_BY_OGD: "Аннулирован ИС ЭСФ",
  CANCELED_BY_SNT_DECLINE: "Аннулирован при отклонении СНТ",
  CANCELED_BY_SNT_REVOKE: "Аннулирован при отзыве СНТ",
  REVOKED: "Отозван",
  IMPORTED: "Импортирован",
  DRAFT: "Черновик ИС ЭСФ",
  FAILED: "Ошибочный",
  DELETED: "Удалён",
  DECLINED: "Отклонён",
  SEND_TO_ISGO: "Заблокирован ИС ЭСФ",
  WAIT_BIOMETRICS_VERIFICATION: "Ожидает биометрию",
  FAILED_BIOMETRICS_VERIFICATION: "Биометрия не пройдена",
  DELETED_BIOMETRICS_VERIFICATION: "Удалён после биометрии",
  WAITING_CUSTOMER_CONFIRMATION: "Ждёт подтверждения покупателя",
  WAITING_CUSTOMER_REVOKE_CONFIRMATION: "Ждёт подтверждения отзыва",
};

function esfStatusLabel(type: string, status?: string) {
  if (!status) return "";
  if (type === "ESF") return INVOICE_ESF_STATUS_LABEL[status] || status;
  return AWP_STATUS_LABEL[status] || status;
}

function MissingList({
  ready,
  ok,
  title,
  fields,
  labels,
}: {
  ready?: boolean;
  ok: string;
  title: string;
  fields?: string[];
  labels?: Record<string, string>;
}) {
  if (ready == null) return null;
  if (ready) return <p className="muted">{ok}</p>;
  return (
    <div>
      <p className="error">{title}</p>
      <ul>
        {(fields || []).map((code) => (
          <li key={code}>{labels?.[code] || code}</li>
        ))}
      </ul>
    </div>
  );
}

function stepTone(done: boolean, started: boolean) {
  if (done) return "done";
  if (started) return "current";
  return "todo";
}

export function DealDocumentsPanel(props: {
  deal: any;
  docs: any;
  readiness: any;
  invoiceReadiness: any;
  avrReadiness: any;
  esfInvoiceReadiness: any;
  closeReadiness: any;
  setReadiness: (value: any) => void;
  setInvoiceReadiness: (value: any) => void;
  setAvrReadiness: (value: any) => void;
  setEsfInvoiceReadiness: (value: any) => void;
  busy: boolean;
  setBusy: (value: boolean) => void;
  setError: (value: string) => void;
  load: () => Promise<void>;
  signing: any;
  buyerLink: string;
  setBuyerLink: (value: string) => void;
  esfPreview: any;
  setEsfPreview: (value: any) => void;
  esfInvoicePreview: any;
  setEsfInvoicePreview: (value: any) => void;
}) {
  const {
    deal: d,
    docs,
    readiness,
    invoiceReadiness,
    avrReadiness,
    esfInvoiceReadiness,
    closeReadiness,
    setReadiness,
    setInvoiceReadiness,
    setAvrReadiness,
    setEsfInvoiceReadiness,
    busy,
    setBusy,
    setError,
    load,
    signing,
    buyerLink,
    setBuyerLink,
    esfPreview,
    setEsfPreview,
    esfInvoicePreview,
    setEsfInvoicePreview,
  } = props;

  const navigate = useNavigate();
  const contracts = docs?.contracts || [];
  const invoices = docs?.invoices || [];
  const { hash } = useLocation();
  useEffect(() => {
    if (!docs) return;
    if (hash === "#esf") document.getElementById("esf")?.scrollIntoView({ block: "start" });
    if (hash === "#avr") document.getElementById("avr")?.scrollIntoView({ block: "start" });
    if (hash === "#contract") document.getElementById("contract")?.scrollIntoView({ block: "start" });
  }, [hash, docs]);
  const edocs = docs?.electronicDocuments || [];
  const avr = edocs.find((row: any) => row.type === "AVR");
  const esf = edocs.find((row: any) => row.type === "ESF");
  const [submissions, setSubmissions] = useState<Record<string, EsfSubmission>>({});
  const [esfSystem, setEsfSystem] = useState<any>(null);
  const [esfIin, setEsfIin] = useState("");
  const [cabinetPassword, setCabinetPassword] = useState("");
  const [askCabinet, setAskCabinet] = useState(false);
  const [templates, setTemplates] = useState<Array<{ id: string; name: string; isDefault: boolean }>>([]);
  const [templateId, setTemplateId] = useState("");
  const [completionTerms, setCompletionTerms] = useState("5–7 рабочих дней");
  const [previewContract, setPreviewContract] = useState<{ id: string; number?: string } | null>(null);
  const [confirmSellerSign, setConfirmSellerSign] = useState(false);
  const [contractEditOpen, setContractEditOpen] = useState(false);
  const [review, setReview] = useState<ContractReviewState>({ viewed: false, confirmed: false });
  const sendFlight = useRef(false);
  useEffect(() => {
    setSubmissions({});
    setConfirmSellerSign(false);
    setContractEditOpen(false);
    setPreviewContract(null);
  }, [d.id]);
  useEffect(() => {
    void api.contractTemplates().then((data: any) => {
      const list = data.items || [];
      setTemplates(list);
      setTemplateId((current) => current || list.find((row: any) => row.isDefault)?.id || list[0]?.id || "");
    }).catch(() => setTemplates([]));
  }, [d.id]);
  useEffect(() => {
    if (contracts[0]?.templateId) setTemplateId(contracts[0].templateId);
    if (contracts[0]?.completionTerms) setCompletionTerms(contracts[0].completionTerms);
  }, [contracts[0]?.templateId, contracts[0]?.completionTerms]);
  function submission(type: string, value: EsfSubmission) {
    setSubmissions(previous => ({ ...previous, [type]: value }));
  }
  function currentDocument(type: string, stored: any) {
    const recent = submissions[type]?.document;
    return !stored || (recent?.id === stored.id && !(stored.updatedAt > recent.updatedAt)) ? recent || stored : stored;
  }
  function sendBlocked(type: string, stored: any) {
    const doc = currentDocument(type, stored);
    return busy || Boolean(doc?.externalId) || ["SENDING", "SENT", "ACCEPTED"].includes(doc?.status) || doc?.errorCode === "send_result_unknown" || submissions[type]?.uncertain;
  }
  async function sendDocument(type: string, document: any) {
    if (sendFlight.current || sendBlocked(type, document)) return;
    sendFlight.current = true;
    setBusy(true); setError("");
    let phase = "CHECKING";
    submission(type, { phase });
    try {
      if (!document?.id) throw new Error(`Сначала создайте ${type}`);
      await api.validateElectronicDocument(document.id);
      phase = "AUTHORIZING"; submission(type, { phase });
      await ensureEsfCabinetSession({ iin: esfIin, cabinetPassword });
      setCabinetPassword("");
      setAskCabinet(false);
      phase = "CONNECTING"; submission(type, { phase });
      const result: any = await signAndSendEsfDocument(document.id, next => {
        phase = next; submission(type, { phase });
      });
      const receipt = { document: result.sent.document, provider: result.sent.provider };
      submission(type, receipt);
      try { await load(); }
      catch { submission(type, { ...receipt, error: "Ответ об отправке получен, но обновить карточку сделки не удалось. Обновите страницу." }); }
    } catch (err: any) {
      if (err.wsseRequired || err.body?.wsseRequired || err.code === "esf_wsse_required" || err.body?.code === "esf_wsse_required") {
        setAskCabinet(true);
      }
      const code = err.code || err.body?.error?.code || err.body?.error || err.body?.code;
      const error = code === "USER_CANCELLED" ? "Подпись отменена. Документ не отправлен." : phase === "SENDING" && !err.body ? "Связь с сервером прервалась. Ответ об отправке не получен." : err.message || `Не удалось отправить ${type}`;
      const uncertain = phase === "SENDING" && (!err.body || code === "send_result_unknown" || code === "document_sending");
      let saved;
      if (document?.id) {
        try { saved = (await api.request(`/api/v1/electronic-documents/${document.id}`) as any).document; } catch { /* Keep the uncertain result visible when the server is unavailable. */ }
      }
      submission(type, { error: saved?.externalId && uncertain ? undefined : error, uncertain: saved?.externalId ? false : uncertain, document: saved });
      try { await load(); } catch { /* The result above remains visible next to the send button. */ }
    } finally { sendFlight.current = false; setBusy(false); }
  }
  async function refreshSubmission(type: string, document: any) {
    if (!document?.id) return;
    setBusy(true); setError("");
    const previous = submissions[type] || {};
    submission(type, { ...previous, error: undefined, phase: "REFRESHING" });
    try {
      const result: any = await api.refreshElectronicDocumentEsf(document.id);
      const saved: any = result.document || (await api.request(`/api/v1/electronic-documents/${document.id}`) as any).document;
      submission(type, { document: saved, provider: previous.provider });
      await load();
    } catch (err: any) {
      submission(type, { ...previous, error: `Не удалось обновить статус: ${err.message}`, phase: undefined });
    } finally { setBusy(false); }
  }
  const [legacyPocEnabled, setLegacyPocEnabled] = useState(false);
  useEffect(() => {
    void api
      .esfConnection()
      .then((row: any) => {
        setEsfSystem(row.system);
        setLegacyPocEnabled(Boolean(row?.system?.legacyPocEnabled));
        setEsfIin((current) => current || row?.connection?.signerIin || "");
        setAskCabinet(Boolean(row?.wsseRequired && !row?.connection?.sessionActive));
      })
      .catch(() => setLegacyPocEnabled(false));
  }, []);
  const contract = contracts[0];
  const invoice = invoices[0];
  const importedContract = Boolean(contract?.importedPdf);
  const fileKey = contract?.id && contract?.generatedFileId ? `${contract.id}:${contract.generatedFileId}` : "";
  const hasContractFile = Boolean(contract?.generatedFileId);
  const readyView = hasContractFile && !contractEditOpen;
  const canEditContract = Boolean(contract && !importedContract && ["DRAFT", "READY_TO_SIGN"].includes(contract.status));
  const needsReview = Boolean(
    CONTRACT_SIGNING_ENABLED && hasContractFile && contract?.status === "READY_TO_SIGN",
  );
  const canSendForSign = Boolean(CONTRACT_SIGNING_ENABLED && hasContractFile && contract?.status !== "SIGNED");

  useEffect(() => {
    setReview(readContractReview(fileKey));
  }, [fileKey]);

  function setReviewState(next: ContractReviewState) {
    setReview(next);
    writeContractReview(fileKey, next);
  }

  function openContractPreview() {
    if (!contract?.id) return;
    setPreviewContract({ id: contract.id, number: contract.number });
  }

  function markContractViewed() {
    if (!fileKey) return;
    setReview((current) => {
      const next = { viewed: true, confirmed: current.confirmed };
      writeContractReview(fileKey, next);
      return next;
    });
  }

  function confirmContract(fromPreview = false) {
    if (!fileKey || !contract?.id) return;
    if (!fromPreview && !review.viewed) {
      openContractPreview();
      setError("Просмотрите договор, затем нажмите «Подтвердить».");
      return;
    }
    setReviewState({ viewed: true, confirmed: true });
    setError("");
    notifySaved("Договор подтверждён");
  }

  function sendContractForSignature() {
    const contractId = contract?.id;
    if (!contractId) return;
    if (needsReview && !review.confirmed) {
      setError("Сначала просмотрите и подтвердите договор");
      return;
    }
    setBusy(true);
    setError("");
    void api
      .sendContractForSign(contractId)
      .then((res: any) => {
        const url = res.requests?.find((row: any) => row.signerType === "BUYER")?.signUrl;
        if (url) setBuyerLink(url);
        return load();
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Не удалось отправить на подпись"))
      .finally(() => setBusy(false));
  }

  function contractPayload() {
    return {
      ...(templateId ? { templateId } : {}),
      completionTerms: completionTerms.trim() || null,
    };
  }

  async function generateWord() {
    setBusy(true);
    setError("");
    try {
      let contractId = contracts[0]?.id as string | undefined;
      if (!contractId) {
        const created: any = await api.createContractDraft(d.id, contractPayload());
        contractId = created.contract.id;
      }
      const generated: any = await api.generateContract(contractId!, contractPayload());
      notifySaved("Договор сформирован");
      setContractEditOpen(false);
      await load();
      setPreviewContract({
        id: generated.contract?.id || contractId,
        number: generated.contract?.number,
      });
    } catch (err: any) {
      const missing = err?.body?.details?.missingFields || err?.body?.missingFields;
      if (Array.isArray(missing) && missing.length) {
        setReadiness({
          ready: false,
          missingFields: missing,
          missingFieldLabels: err.body?.details?.missingFieldLabels || err.body?.missingFieldLabels || {},
        });
      }
      setError(err instanceof Error ? err.message : "Не удалось сформировать договор");
    } finally {
      setBusy(false);
    }
  }

  async function saveContract() {
    setBusy(true);
    setError("");
    try {
      await api.createContractDraft(d.id, contractPayload());
      notifySaved("Договор сохранён");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить договор");
    } finally {
      setBusy(false);
    }
  }

  const steps = [
    { id: "contract", label: "Договор", tone: stepTone(contract?.status === "SIGNED", Boolean(contract)) },
    { id: "invoice", label: "Счёт — по необходимости", tone: stepTone(["ISSUED", "PARTIALLY_PAID", "PAID"].includes(invoice?.status), Boolean(invoice)) },
    { id: "avr", label: "АВР", tone: stepTone(avr?.status === "ACCEPTED", Boolean(avr)) },
    { id: "esf", label: "ЭСФ", tone: stepTone(esf?.status === "ACCEPTED", Boolean(esf)) },
    {
      id: "close",
      label: "Закрытие",
      tone: stepTone(d.outcome === "won" || closeReadiness?.alreadyClosed, Boolean(closeReadiness?.ready)),
    },
  ];

  return (
    <>
      <div className="panel">
        <div className="row sit-head">
          <div>
            <b>Документы</b>
            {docs?.documentState?<p className="deal-flag">{docs.documentState.label}</p>:null}
            <p className="muted">АВР и ЭСФ формируются из договора, позиций сделки и реквизитов сторон. Счёт на оплату — отдельный документ, его загрузка или создание не обязательны.</p>
          </div>
          <Link className="btn secondary" to="/documents">
            Все документы
          </Link>
        </div>
        <div className="doc-progress" aria-label="Этапы документов">
          {steps.map((step) => (
            <span key={step.id} className={`doc-progress-chip ${step.tone}`}>
              {step.label}
            </span>
          ))}
        </div>

        <div className="doc-step" id="contract">
          <div className="doc-step-title">
            <b>Договор</b>
          </div>
          <MissingList
            ready={readiness?.ready}
            ok="Данных достаточно для договора."
            title={contracts[0]?.importedPdf ? "Для следующих документов нужно дополнить реквизиты:" : "Не хватает данных для договора:"}
            fields={readiness?.missingFields}
            labels={readiness?.missingFieldLabels}
          />
          {contracts[0]?.importedPdf && readiness?.missingFields?.some((field:string)=>field.startsWith("organization.")) ? (
            <div className="stack">
              <p className="muted">Заполните реквизиты исполнителя из сохранённого договора. Если часть данных была пропущена, система повторно прочитает его PDF-копию.</p>
              <button className="btn secondary" disabled={busy} onClick={()=>{
                setBusy(true);setError("");
                void api.request(`/api/v1/contracts/${contracts[0].id}/imported-requisites`,{method:"POST"})
                  .then(async()=>{await load();notifySaved("Реквизиты из договора сохранены");})
                  .catch(err=>setError(err.message)).finally(()=>setBusy(false));
              }}>Заполнить реквизиты из договора</button>
              <Link to="/settings#company-requisites">Реквизиты компании в настройках</Link>
            </div>
          ) : null}
          {contracts.map((doc: any) => (
            <div className="row" key={doc.id}>
              <div>
                <b>Договор {doc.number}</b>
                {doc.originalFileName && /\.docx?$/i.test(doc.originalFileName) ? <a className="btn secondary" href={`/api/v1/contracts/${doc.id}/original`}>Скачать оригинал Word</a> : null}{doc.importedPdf ? <div className="muted">Загружен вручную</div> : null}
                <div className="muted">
                  {CONTRACT_STATUS_LABEL[doc.status] || doc.status} · {Number(doc.totalAmount).toLocaleString("ru-RU")} ₸
                </div>
              </div>
              <DeleteContractButton id={doc.id} number={doc.number} disabled={busy} onDeleted={async()=>{setBuyerLink("");setContractEditOpen(false);await load();}} />
            </div>
          ))}
          {readyView ? (
            <>
              {needsReview && review.confirmed ? (
                <p className="muted">Договор просмотрен и подтверждён. Можно отправить на подпись.</p>
              ) : needsReview && review.viewed ? (
                <p className="muted">Договор просмотрен. Подтвердите его перед отправкой на подпись.</p>
              ) : needsReview ? (
                <p className="muted">Просмотрите PDF, подтвердите текст, затем отправьте на подпись.</p>
              ) : contract?.status === "SIGNED" ? (
                <p className="muted">Договор подписан.</p>
              ) : contract?.status === "PENDING_SIGNATURE" || contract?.status === "PARTIALLY_SIGNED" ? (
                <p className="muted">Договор уже отправлен на подпись.</p>
              ) : null}
              <div className="actions" style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  {...tip("Открыть сформированный PDF для проверки")}
                  onClick={openContractPreview}
                >
                  Просмотр договора
                </button>
                {canEditContract ? (
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={busy}
                    {...tip("Открыть шаблон и условия, чтобы сформировать договор заново")}
                    onClick={() => { setError(""); setContractEditOpen(true); }}
                  >
                    Изменить
                  </button>
                ) : null}
                {needsReview ? (
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={busy || review.confirmed}
                    {...tip("Подтвердить, что текст договора проверен и его можно отправлять на подпись")}
                    onClick={() => confirmContract()}
                  >
                    {review.confirmed ? "Подтверждён" : "Подтвердить"}
                  </button>
                ) : null}
                {canSendForSign ? (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || (needsReview && !review.confirmed)}
                    {...tip(
                      needsReview && !review.confirmed
                        ? "Сначала просмотрите и подтвердите договор"
                        : "Отправить договор исполнителю и заказчику на подпись ЭЦП",
                    )}
                    onClick={sendContractForSignature}
                  >
                    Отправить на подпись
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <>
              {contractEditOpen ? (
                <p className="muted">После изменения позиций, шаблона или срока сформируйте договор заново — на подпись уйдёт новая PDF-копия.</p>
              ) : null}
              <div className="actions" style={{ marginTop: 8 }}>
                {templates.length ? (
                  <label>
                    Шаблон договора
                    <select value={templateId} disabled={busy || importedContract} onChange={(e) => setTemplateId(e.target.value)}>
                      {templates.map((row) => (
                        <option key={row.id} value={row.id}>{row.name}{row.isDefault ? " (по умолчанию)" : ""}</option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label>
                  Срок исполнения
                  <input
                    value={completionTerms}
                    disabled={busy || importedContract}
                    placeholder="5–7 рабочих дней"
                    onChange={(e) => setCompletionTerms(e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="btn"
                  disabled={busy || readiness?.ready === false || importedContract}
                  title={importedContract ? "Загруженный PDF уже сохранён в исходном виде" : undefined}
                  onClick={() => void generateWord()}
                >
                  Сформировать договор
                </button>
                {importedContract ? null : (
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={busy}
                    onClick={() => void saveContract()}
                  >
                    Сохранить договор
                  </button>
                )}
                {contractEditOpen ? (
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={busy}
                    onClick={() => setContractEditOpen(false)}
                  >
                    Отмена
                  </button>
                ) : null}
              </div>
            </>
          )}
        </div>

        {CONTRACT_SIGNING_ENABLED ? (
        <div className="doc-step">
          <div className="doc-step-title">
            <b>Подпись договора</b>
          </div>
          <p className="muted">Сначала исполнитель в кабинете, затем заказчик по ссылке. Нужен NCALayer с ключом подписи НУЦ.</p>
          {(signing?.requests || []).map((row: any) => {
            const signature = (signing?.signatures || []).find(
              (item: any) =>
                (item.signatureRequestId && item.signatureRequestId === row.id) ||
                (row.signerIin && item.signerIin === row.signerIin) ||
                (row.signerName && item.signerName === row.signerName),
            );
            const check = row.status === "SIGNED" ? signatureCheckLabel(signature || {}) : "";
            return (
            <div className="row" key={row.id}>
              <div>
                <b>{row.signerType === "SELLER" ? "Исполнитель" : "Заказчик"}</b>
                <div className="muted">
                  {row.signerName || "—"} · {row.status}
                  {check ? ` · ${check}` : ""}
                </div>
              </div>
            </div>
            );
          })}
          {buyerLink ? (
            <p className="muted" style={{ wordBreak: "break-all" }}>
              Ссылка заказчику: <a href={buyerLink}>{buyerLink}</a>
            </p>
          ) : null}
          {signing?.verificationUrl ? (
            <p>
              <Link to={signing.verificationUrl}>Страница проверки</Link>
            </p>
          ) : null}
          <div className="actions" style={{ marginTop: 8 }}>
            {confirmSellerSign ? (
              <div className="panel" style={{ marginTop: 8 }}>
                <p>
                  Подписать ЭЦП договор <b>{contracts[0]?.number}</b>?
                </p>
                <p className="muted">
                  {d.company?.name || d.companyName || contracts[0]?.companyName || "Контрагент"}
                  {contracts[0]?.totalAmount != null
                    ? ` · ${Number(contracts[0].totalAmount).toLocaleString("ru-RU")} ${contracts[0].currency || "KZT"}`
                    : ""}
                </p>
                <div className="actions">
                  <button type="button" className="btn secondary" disabled={busy} onClick={() => setConfirmSellerSign(false)}>
                    Отмена
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => {
                      const current = contracts[0];
                      const seller = signing?.requests?.find((row: any) => row.signerType === "SELLER");
                      if (!current || !seller) {
                        setError("Сначала отправьте договор на подпись");
                        setConfirmSellerSign(false);
                        return;
                      }
                      setBusy(true);
                      const client = createSigningClient();
                      void (async () => {
                        const pdf = await fetch(api.contractPdfUrl(current.id), { credentials: "include" });
                        if (!pdf.ok) throw new Error("Не удалось открыть договор");
                        const bytes = new Uint8Array(await pdf.arrayBuffer());
                        let binary = "";
                        bytes.forEach((byte) => {
                          binary += String.fromCharCode(byte);
                        });
                        await client.connect();
                        const cms = await client.signDocument(btoa(binary));
                        await api.signSignatureRequest(seller.id, cms);
                        setConfirmSellerSign(false);
                        await load();
                      })()
                        .catch((err: unknown) => {
                          setError(ncalayerUserMessage(err));
                        })
                        .finally(() => {
                          client.disconnect();
                          setBusy(false);
                        });
                    }}
                  >
                    {busy ? "Подписываем…" : "Подписать ЭЦП"}
                  </button>
                </div>
              </div>
            ) : (
            <button
              type="button"
              className="btn secondary"
              disabled={busy || signing?.requests?.find((row: any) => row.signerType === "SELLER")?.status === "SIGNED"}
              onClick={() => {
                const current = contracts[0];
                const seller = signing?.requests?.find((row: any) => row.signerType === "SELLER");
                if (!current || !seller) {
                  setError("Сначала отправьте договор на подпись");
                  return;
                }
                setConfirmSellerSign(true);
              }}
            >
              Подписать со стороны компании
            </button>
            )}
          </div>
        </div>
        ) : null}

        <div className="doc-step">
          <div className="doc-step-title">
            <b>Счёт на оплату — по необходимости</b>
          </div>
          <MissingList
            ready={invoiceReadiness?.ready}
            ok="Можно сформировать счёт."
            title="Не хватает данных для счёта:"
            fields={invoiceReadiness?.missingFields}
            labels={invoiceReadiness?.missingFieldLabels}
          />
          {invoices.map((doc: any) => (
            <div className="row" key={doc.id}>
              <div>
                <Link to={`/documents/invoices/${doc.id}`}><b>Счёт {doc.number}</b> · Открыть</Link>
                {doc.importedPdf ? <div className="muted">Загружен вручную</div> : null}
                {doc.importDetails ? <>
                  <div>{doc.importDetails.subject}</div>
                  {doc.importDetails.paymentKind && doc.importDetails.paymentKind !== "UNSPECIFIED" ? <div>{INVOICE_PAYMENT_KIND_LABEL[doc.importDetails.paymentKind as NonNullable<PdfImportDraft["paymentKind"]>]}</div> : null}
                  {doc.importDetails.paymentTerms && doc.importDetails.paymentTerms !== doc.importDetails.subject ? <div className="muted">{doc.importDetails.paymentTerms}</div> : null}
                  {doc.items?.map((item: {id:string;name:string;quantity:number;unit:string;unitPrice:number;totalAmount:number})=><div className="muted" key={item.id}>{item.name}: {Number(item.quantity).toLocaleString("ru-RU")} {esfMeasureUnitShortLabel(item.unit)} × {Number(item.unitPrice).toLocaleString("ru-RU")} ₸ без НДС · итого {Number(item.totalAmount).toLocaleString("ru-RU")} ₸</div>)}
                </> : null}
                <div className="muted">
                  {INVOICE_STATUS_LABEL[doc.status] || doc.status} · {Number(doc.totalAmount).toLocaleString("ru-RU")} ₸
                </div>
              </div>
              {doc.pdfFileId ? (
                <a className="btn secondary" href={api.invoicePdfUrl(doc.id)} target="_blank" rel="noreferrer">
                  Открыть счёт
                </a>
              ) : null}
            </div>
          ))}
          <div className="actions" style={{ marginTop: 8 }}>
            <Link className="btn" to={`/documents/invoices/new?dealId=${d.id}`}>Создать счёт</Link>
            <button
              type="button"
              className="btn secondary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void api
                  .createInvoiceDraft(d.id)
                  .then(() => {
                    window.dispatchEvent(new Event("creolab:attention-changed"));
                    return load();
                  })
                  .catch((err) => setError(err instanceof Error ? err.message : "Не удалось создать счёт"))
                  .finally(() => setBusy(false));
              }}
            >
              Черновик счёта
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || invoiceReadiness?.ready === false || invoices[0]?.importedPdf}
              title={invoices[0]?.importedPdf ? "Загруженный PDF уже сохранён в исходном виде" : undefined}
              onClick={() => {
                setBusy(true);
                void (async () => {
                  let invoiceId = invoices[0]?.id as string | undefined;
                  if (!invoiceId) {
                    const created: any = await api.createInvoiceDraft(d.id);
                    invoiceId = created.invoice.id;
                  }
                  await api.generateInvoice(invoiceId!);
                  window.dispatchEvent(new Event("creolab:attention-changed"));
                  await load();
                })()
                  .catch((err: any) => {
                    const missing = err?.body?.details?.missingFields || err?.body?.missingFields;
                    if (Array.isArray(missing) && missing.length) {
                      setInvoiceReadiness({
                        ready: false,
                        missingFields: missing,
                        missingFieldLabels: err.body?.details?.missingFieldLabels || err.body?.missingFieldLabels || {},
                      });
                    }
                    setError(err instanceof Error ? err.message : "Не удалось сформировать счёт");
                  })
                  .finally(() => setBusy(false));
              }}
            >
              Сформировать счёт
            </button>
          </div>
        </div>

        <div className="doc-step" id="avr" style={{ scrollMarginTop: 24 }}>
          <div className="doc-step-title">
            <b>АВР</b>
          </div>
          <p className="muted">Счёт на оплату не требуется. АВР можно сформировать и проверить до подписания договора. Excel и PDF (форма Р-1) скачиваются локально, без входа в ИС ЭСФ.</p>
          {avrReadiness?.warnings?.map((warning:string)=><p className="pdf-import-warnings" role="status" key={warning}>{warning}</p>)}
          <p className="muted">Подпись и отправка подтверждаются на странице заполненного АВР.</p>
          <MissingList
            ready={avrReadiness?.ready}
            ok="Данных достаточно, АВР можно проверить."
            title="Для проверки и отправки АВР требуется:"
            fields={avrReadiness?.missingFields}
            labels={avrReadiness?.missingFieldLabels}
          />
          {edocs
            .filter((doc: any) => doc.type === "AVR")
            .map((doc: any) => (
              <div className="row" key={doc.id}>
                <div>
                  <Link to={`/documents/avr/${doc.id}`}><b>АВР {doc.number}</b> · Открыть</Link>
                  <div className="muted">
                    {EDOC_STATUS_LABEL[doc.status] || doc.status}
                    {doc.xmlPrepared ? " · XML AwpV1" : ""}
                    {doc.externalStatus ? ` · ${esfStatusLabel(doc.type, doc.externalStatus)}` : ""}
                    {doc.externalId ? ` · ${doc.externalId}` : ""}
                  </div>
                </div>
              </div>
            ))}
          <div className="actions" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="btn secondary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void api
                  .createElectronicDocumentDraft(d.id, { type: "AVR" })
                  .then(() => load())
                  .catch((err) => setError(err instanceof Error ? err.message : "Не удалось создать АВР"))
                  .finally(() => setBusy(false));
              }}
            >
              Черновик АВР
            </button>
            <button
              type="button"
              className="btn secondary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError("");
                void (async () => {
                  let documentId = avr?.id as string | undefined;
                  if (!documentId) {
                    const created: any = await api.createElectronicDocumentDraft(d.id, { type: "AVR" });
                    documentId = created.document.id;
                    await load();
                  }
                  await downloadAvrExcel(documentId!);
                })()
                  .catch((err) => setError(err instanceof Error ? err.message : "Не удалось скачать Excel АВР"))
                  .finally(() => setBusy(false));
              }}
            >
              Скачать Excel
            </button>
            <button
              type="button"
              className="btn secondary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError("");
                void (async () => {
                  let documentId = avr?.id as string | undefined;
                  if (!documentId) {
                    const created: any = await api.createElectronicDocumentDraft(d.id, { type: "AVR" });
                    documentId = created.document.id;
                    await load();
                  }
                  await downloadAvrPdf(documentId!);
                })()
                  .catch((err) => setError(err instanceof Error ? err.message : "Не удалось скачать PDF АВР"))
                  .finally(() => setBusy(false));
              }}
            >
              Скачать PDF
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || avrReadiness?.ready === false}
              onClick={() => {
                setBusy(true);
                void (async () => {
                  let documentId = avr?.id as string | undefined;
                  if (!documentId) {
                    const created: any = await api.createElectronicDocumentDraft(d.id, { type: "AVR" });
                    documentId = created.document.id;
                  }
                  await api.validateElectronicDocument(documentId!);
                  await load();
                })()
                  .catch((err: any) => {
                    const missing = err?.body?.details?.missingFields || err?.body?.missingFields;
                    if (Array.isArray(missing) && missing.length) {
                      setAvrReadiness({
                        ...avrReadiness,
                        ready: false,
                        missingFields: missing,
                        missingFieldLabels: err.body?.details?.missingFieldLabels || err.body?.missingFieldLabels || {},
                      });
                    }
                    setError(err instanceof Error ? err.message : "Не удалось проверить АВР");
                  })
                  .finally(() => setBusy(false));
              }}
            >
              Проверить АВР
            </button>
            <button
              type="button"
              className="btn secondary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void (async () => {
                  let documentId = avr?.id as string | undefined;
                  if (!documentId) {
                    const created: any = await api.createElectronicDocumentDraft(d.id, { type: "AVR" });
                    documentId = created.document.id;
                  }
                  const preview = await api.previewElectronicDocumentEsf(documentId!);
                  setEsfPreview(preview);
                  await load();
                })()
                  .catch((err) => setError(err instanceof Error ? err.message : "Не удалось собрать XML АВР"))
                  .finally(() => setBusy(false));
              }}
            >
              XML для ИС ЭСФ
            </button>
            {avr?.id ? (
              <Link className="btn" to={`/documents/avr/${avr.id}#sign`}>
                Открыть АВР и подтвердить отправку
              </Link>
            ) : (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError("");
                  void (async () => {
                    const created: any = await api.createElectronicDocumentDraft(d.id, { type: "AVR" });
                    navigate(`/documents/avr/${created.document.id}#sign`);
                  })()
                    .catch((err) => setError(err instanceof Error ? err.message : "Не удалось открыть АВР"))
                    .finally(() => setBusy(false));
                }}
              >
                Открыть АВР и подтвердить отправку
              </button>
            )}
            {legacyPocEnabled ? (
            <button
              type="button"
              className="btn secondary"
              disabled={sendBlocked("AVR", avr)}
              onClick={() => {
                setBusy(true);
                void (async () => {
                  const documentId = avr?.id as string | undefined;
                  if (!documentId) {
                    setError("Сначала создайте и проверьте АВР");
                    return;
                  }
                  const sent = await api.sendElectronicDocumentEsf(documentId);
                  setEsfPreview(sent);
                  await load();
                })()
                  .catch((err: any) => {
                    const details = err?.body?.details;
                    if (details?.validation || details?.signing) setEsfPreview({ ...details, error: err.message });
                    setError(err instanceof Error ? err.message : "Не удалось отправить в ИС ЭСФ");
                  })
                  .finally(() => setBusy(false));
              }}
            >
              Отправить в TEST ИС ЭСФ
            </button>
            ) : null}
            <button
              type="button"
              className="btn secondary"
              disabled={busy || !currentDocument("AVR", avr)?.externalId}
              onClick={() => void refreshSubmission("AVR", currentDocument("AVR", avr))}
            >
              Обновить статус ИС ЭСФ
            </button>
          </div>
          {(avr || submissions.AVR) ? <EsfSubmissionStatus document={currentDocument("AVR", avr)} submission={submissions.AVR} system={esfSystem} statusLabel={esfStatusLabel("AVR", currentDocument("AVR", avr)?.externalStatus)} /> : null}
          {currentDocument("AVR", avr)?.errorMessage && !currentDocument("AVR", avr)?.externalId ? (
            <p className="muted">Это результат прошлой отправки с карточки сделки. Откройте заполненный АВР, проверьте данные и подтвердите отправку там.</p>
          ) : null}
          {esfPreview?.validation || esfPreview?.externalStatus ? (
            <div style={{ marginTop: 12 }}>
              <p className="muted">
                {esfPreview.validation ? `AwpV1 XSD: ${esfPreview.validation.valid ? "ок" : "ошибки"}` : ""}
                {esfPreview.signing?.code ? ` · подпись: ${esfPreview.signing.code}` : ""}
                {esfPreview.provider ? ` · ${esfPreview.provider}` : ""}
                {esfPreview.externalStatus
                  ? ` · ${AWP_STATUS_LABEL[esfPreview.externalStatus] || esfPreview.externalStatus}`
                  : ""}
              </p>
              {esfPreview.xml ? (
                <pre className="muted" style={{ whiteSpace: "pre-wrap", maxHeight: 220, overflow: "auto" }}>
                  {String(esfPreview.xml).slice(0, 2500)}
                </pre>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="doc-step" id="esf" style={{ scrollMarginTop: 24 }}>
          <div className="doc-step-title">
            <b>ЭСФ</b>
          </div>
          <p className="muted">Счёт на оплату не требуется. Данные берутся из сделки и договора.</p>
          {esfInvoiceReadiness?.warnings?.map((warning:string)=><p className="pdf-import-warnings" role="status" key={warning}>{warning}</p>)}
          <MissingList
            ready={esfInvoiceReadiness?.ready}
            ok={
              esfInvoiceReadiness?.sendReady
                ? "Можно отправить ЭСФ через syncInvoice."
                : "XML ЭСФ можно собрать. Отправка — после АВР в ИС ЭСФ."
            }
            title="Не готов к ЭСФ:"
            fields={esfInvoiceReadiness?.missingFields}
            labels={esfInvoiceReadiness?.missingFieldLabels}
          />
          {edocs
            .filter((doc: any) => doc.type === "ESF")
            .map((doc: any) => (
              <div className="row" key={doc.id}>
                <div>
                  <b>ЭСФ {doc.number}</b>
                  <div className="muted">
                    {EDOC_STATUS_LABEL[doc.status] || doc.status}
                    {doc.xmlPrepared ? " · XML InvoiceV2" : ""}
                    {doc.externalStatus ? ` · ${esfStatusLabel(doc.type, doc.externalStatus)}` : ""}
                    {doc.externalId ? ` · ${doc.externalId}` : ""}
                  </div>
                </div>
              </div>
            ))}
          <div className="actions" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="btn secondary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void api
                  .createElectronicDocumentDraft(d.id, { type: "ESF" })
                  .then(() => load())
                  .catch((err) => setError(err instanceof Error ? err.message : "Не удалось создать ЭСФ"))
                  .finally(() => setBusy(false));
              }}
            >
              Черновик ЭСФ
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || esfInvoiceReadiness?.ready === false}
              onClick={() => {
                setBusy(true);
                void (async () => {
                  let documentId = esf?.id as string | undefined;
                  if (!documentId) {
                    const created: any = await api.createElectronicDocumentDraft(d.id, { type: "ESF" });
                    documentId = created.document.id;
                  }
                  await api.validateElectronicDocument(documentId!);
                  await load();
                })()
                  .catch((err: any) => {
                    const missing = err?.body?.details?.missingFields || err?.body?.missingFields;
                    if (Array.isArray(missing) && missing.length) {
                      setEsfInvoiceReadiness({
                        ...esfInvoiceReadiness,
                        ready: false,
                        missingFields: missing,
                        missingFieldLabels: err.body?.details?.missingFieldLabels || err.body?.missingFieldLabels || {},
                      });
                    }
                    setError(err instanceof Error ? err.message : "Не удалось проверить ЭСФ");
                  })
                  .finally(() => setBusy(false));
              }}
            >
              Проверить ЭСФ
            </button>
            <button
              type="button"
              className="btn secondary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void (async () => {
                  let documentId = esf?.id as string | undefined;
                  if (!documentId) {
                    const created: any = await api.createElectronicDocumentDraft(d.id, { type: "ESF" });
                    documentId = created.document.id;
                  }
                  const preview = await api.previewElectronicDocumentEsf(documentId!);
                  setEsfInvoicePreview(preview);
                  await load();
                })()
                  .catch((err) => setError(err instanceof Error ? err.message : "Не удалось собрать XML ЭСФ"))
                  .finally(() => setBusy(false));
              }}
            >
              XML ЭСФ InvoiceV2
            </button>
            <button
              type="button"
              className="btn"
              disabled={sendBlocked("ESF", esf)}
              onClick={() => void sendDocument("ESF", esf)}
            >
              {submissions.ESF?.phase ? ESF_SEND_PHASES[submissions.ESF.phase!] : "Подписать и отправить"}
            </button>
            {legacyPocEnabled ? (
            <button
              type="button"
              className="btn secondary"
              disabled={sendBlocked("ESF", esf)}
              onClick={() => {
                setBusy(true);
                void (async () => {
                  const documentId = esf?.id as string | undefined;
                  if (!documentId) {
                    setError("Сначала создайте и проверьте ЭСФ");
                    return;
                  }
                  const sent = await api.sendElectronicDocumentEsf(documentId);
                  setEsfInvoicePreview(sent);
                  await load();
                })()
                  .catch((err: any) => {
                    const details = err?.body?.details;
                    if (details?.validation || details?.signing) setEsfInvoicePreview({ ...details, error: err.message });
                    setError(err instanceof Error ? err.message : "Не удалось отправить ЭСФ");
                  })
                  .finally(() => setBusy(false));
              }}
            >
              Отправить ЭСФ в ИС ЭСФ
            </button>
            ) : null}
            <button
              type="button"
              className="btn secondary"
              disabled={busy || !currentDocument("ESF", esf)?.externalId}
              onClick={() => void refreshSubmission("ESF", currentDocument("ESF", esf))}
            >
              Обновить статус ИС ЭСФ
            </button>
          </div>
          {(esf || submissions.ESF) ? <EsfSubmissionStatus document={currentDocument("ESF", esf)} submission={submissions.ESF} system={esfSystem} statusLabel={esfStatusLabel("ESF", currentDocument("ESF", esf)?.externalStatus)} /> : null}
          {esfInvoicePreview?.validation || esfInvoicePreview?.externalStatus ? (
            <div style={{ marginTop: 12 }}>
              <p className="muted">
                {esfInvoicePreview.validation ? `InvoiceV2 XSD: ${esfInvoicePreview.validation.valid ? "ок" : "ошибки"}` : ""}
                {esfInvoicePreview.signing?.code ? ` · подпись: ${esfInvoicePreview.signing.code}` : ""}
                {esfInvoicePreview.provider ? ` · ${esfInvoicePreview.provider}` : ""}
                {esfInvoicePreview.externalStatus
                  ? ` · ${INVOICE_ESF_STATUS_LABEL[esfInvoicePreview.externalStatus] || esfInvoicePreview.externalStatus}`
                  : ""}
              </p>
              {esfInvoicePreview.xml ? (
                <pre className="muted" style={{ whiteSpace: "pre-wrap", maxHeight: 220, overflow: "auto" }}>
                  {String(esfInvoicePreview.xml).slice(0, 2500)}
                </pre>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="doc-step">
          <div className="doc-step-title">
            <b>Закрытие</b>
          </div>
          {closeReadiness ? (
            closeReadiness.alreadyClosed ? (
              <p className="muted">Сделка уже закрыта.</p>
            ) : closeReadiness.ready ? (
              <p className="muted">ЭСФ доставлен в ИС ЭСФ — сделку можно закрыть.</p>
            ) : (
              <div>
                <p className="error">Ещё рано закрывать сделку:</p>
                <ul>
                  {(closeReadiness.missingFields || []).map((code: string) => (
                    <li key={code}>{closeReadiness.missingFieldLabels?.[code] || code}</li>
                  ))}
                </ul>
              </div>
            )
          ) : null}
          <div className="actions" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="btn secondary"
              disabled={busy || !edocs.some((row: any) => row.externalId)}
              onClick={() => {
                setBusy(true);
                void api
                  .syncDealEsf(d.id)
                  .then(() => load())
                  .catch((err) => setError(err instanceof Error ? err.message : "Не удалось синхронизировать ИС ЭСФ"))
                  .finally(() => setBusy(false));
              }}
            >
              Синхронизировать ИС ЭСФ
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || closeReadiness?.ready !== true || d.outcome === "won"}
              onClick={() => {
                setBusy(true);
                void api
                  .markDealWon(d.id, { wonAmountMinor: d.amount })
                  .then(() => load())
                  .catch((err) => setError(err instanceof Error ? err.message : "Не удалось закрыть сделку"))
                  .finally(() => setBusy(false));
              }}
            >
              Закрыть сделку
            </button>
          </div>
        </div>
      </div>
    {previewContract ? (
      <ContractPreviewModal
        contract={previewContract}
        onClose={() => setPreviewContract(null)}
        onViewed={markContractViewed}
        onConfirm={needsReview && !review.confirmed ? () => confirmContract(true) : undefined}
        confirmed={review.confirmed}
      />
    ) : null}
    </>
  );
}
