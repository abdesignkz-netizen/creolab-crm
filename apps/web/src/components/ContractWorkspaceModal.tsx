import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { readContractReview, writeContractReview } from "../lib/contractReview";
import { CONTRACT_SIGNING_ENABLED } from "../lib/featureFlags";
import { createSigningClient, ncalayerUserMessage } from "../lib/signing/ncalayerClient";
import { ContractSignatureSummary } from "./ContractSignatureSummary";
import { ContractPreviewModal } from "./ContractPreviewModal";

type Contract = {
  id: string; number: string; date: string; updatedAt?: string | null; status: string; generatedFileId: string | null;
  importedPdf: boolean; signedAt: string | null; subject: string | null;
  paymentTerms: string | null; completionTerms: string | null; templateId: string | null;
  totalAmount: number; currency: string;
};
type SigningRequest = { id: string; signerType: string; status: string; signUrl?: string | null };
type Signing = { sellerName?: string | null; buyerName?: string | null; requests: SigningRequest[]; verificationUrl?: string | null; signatures?: Array<{ signatureRequestId: string; signerName: string | null; signedAt: string; verificationStatus: string; authorityStatus: string; cryptoStatus: string }> };
type Bundle = { contract: Contract; versions: Array<{ id: string; fileId: string | null; sha256: string | null }> };
type Template = { id: string; name: string };

export function ContractWorkspaceModal({ contractId, onClose, onChanged }: {
  contractId: string; onClose: () => void; onChanged: () => Promise<void>;
}) {
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [signing, setSigning] = useState<Signing>({ requests: [] });
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [form, setForm] = useState({ number: "", documentDate: "", subject: "", paymentTerms: "", completionTerms: "", templateId: "" });
  const [review, setReview] = useState({ viewed: false, confirmed: false });
  const [buyerLink, setBuyerLink] = useState("");
  const inFlight = useRef(false);
  const contract = bundle?.contract;
  const fileKey = contract?.generatedFileId ? `${contract.id}:${contract.generatedFileId}` : "";
  const seller = signing.requests.find(row => row.signerType === "SELLER" && row.status === "SIGNED");
  const buyerSigned = signing.requests.some(row => row.signerType === "BUYER" && row.status === "SIGNED");
  const fullySigned = contract?.status === "SIGNED" || Boolean(contract?.signedAt);
  const editable = Boolean(contract && !contract.importedPdf && ["DRAFT", "READY_TO_SIGN"].includes(contract.status) && !fullySigned);

  async function read() {
    const [next, nextSigning] = await Promise.all([
      api.request<Bundle>(`/api/v1/contracts/${encodeURIComponent(contractId)}`),
      api.contractSigning(contractId) as Promise<Signing>,
    ]);
    setBundle(next); setSigning(nextSigning);
    return next;
  }

  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.request<Bundle>(`/api/v1/contracts/${encodeURIComponent(contractId)}`), api.contractSigning(contractId) as Promise<Signing>])
      .then(([next, nextSigning]) => { if (!cancelled) { setBundle(next); setSigning(nextSigning); } })
      .catch(err => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [contractId]);

  useEffect(() => { setReview(readContractReview(fileKey)); }, [fileKey]);

  function markViewed() {
    if (!fileKey) return;
    setReview(current => {
      const next = { viewed: true, confirmed: current.confirmed };
      writeContractReview(fileKey, next); return next;
    });
  }

  async function action(work: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(""); setNote("");
    try { await work(); }
    catch (err) { setError(err instanceof Error ? err.message : "Не удалось выполнить действие"); }
    finally { inFlight.current = false; setBusy(false); }
  }

  async function refresh() {
    await read();
    await onChanged();
  }

  async function edit() {
    if (!contract || !editable) return;
    setForm({ number: contract.number, documentDate: contract.date.slice(0, 10), subject: contract.subject || "", paymentTerms: contract.paymentTerms || "", completionTerms: contract.completionTerms || "", templateId: contract.templateId || "" });
    const result = await api.contractTemplates() as { items: Template[] };
    setTemplates(result.items || []); setEditing(true);
  }

  async function save() {
    await api.generateContract(contractId, { ...form, updatedAt: contract?.updatedAt || undefined, templateId: form.templateId || undefined });
    setEditing(false); setBuyerLink("");
    setReview({ viewed: false, confirmed: false });
    writeContractReview(fileKey, { viewed: false, confirmed: false });
    await refresh();
    setNote("Изменения сохранены. Просмотрите и подтвердите новую версию договора.");
  }

  async function sign() {
    if (!bundle || !review.confirmed) return;
    const checked = await read();
    if (checked.contract.generatedFileId !== bundle.contract.generatedFileId || checked.versions.at(-1)?.id !== bundle.versions.at(-1)?.id) {
      throw new Error("Договор изменился. Просмотрите и подтвердите его новую версию.");
    }
    const client = createSigningClient();
    try {
      // The company signs first. This request does not create or release a buyer link.
      const prepared = await api.prepareContractSellerSign(contractId) as Signing;
      const request = prepared.requests.find(row => row.signerType === "SELLER" && ["PENDING", "OPENED"].includes(row.status));
      if (!request) { await refresh(); throw new Error("Обновлён статус подписи. Проверьте доступные действия."); }
      const { blob } = await api.downloadContractFile(contractId);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const expectedHash = checked.versions.at(-1)?.sha256;
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map(value => value.toString(16).padStart(2, "0")).join("");
      if (!expectedHash || hash !== expectedHash) throw new Error("Файл договора изменился. Обновите просмотр перед подписанием.");
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      setNote("Выберите ключ подписи в NCALayer и подтвердите подписание договора.");
      await client.connect();
      const cms = await client.signDocument(btoa(binary));
      await api.signSignatureRequest(request.id, cms);
      await refresh();
      setNote("Договор подписан со стороны компании. Теперь его можно отправить на подпись заказчику.");
    } catch (err) {
      await read().catch(() => undefined);
      setNote(""); throw new Error(ncalayerUserMessage(err));
    } finally { client.disconnect(); }
  }

  async function sendToBuyer() {
    const result = await api.sendContractToBuyer(contractId) as Signing;
    const url = result.requests.find(row => row.signerType === "BUYER")?.signUrl;
    if (!url) throw new Error("Ссылка на подпись не получена. Обновите состояние договора.");
    setBuyerLink(url);
    await refresh();
    setNote("Ссылка для подписи готова. Скопируйте её и отправьте заказчику.");
  }
  async function cancelSigning() {
    if (!window.confirm("Отменить подписание договора и вернуть его в исправление? Подпись исполнителя и ссылка заказчику будут аннулированы.")) return;
    await api.cancelContractSigning(contractId);
    setBuyerLink("");
    await refresh();
    setNote("Подписание отменено. Договор снова можно исправлять.");
  }
  async function deleteCurrentContract() {
    if (!window.confirm("Удалить этот договор? Действие нельзя отменить.")) return;
    await api.deleteContract(contractId);
    setNote("Договор удалён");
    await onChanged();
    onClose();
  }

  return <ContractPreviewModal
    contract={{ id: contractId, number: contract?.number }}
    fileRevision={contract?.generatedFileId}
    busy={busy}
    onClose={onClose}
    onViewed={markViewed}
    actions={ready => <>
      <button type="button" className="btn secondary" disabled={busy || !editable || editing} onClick={() => void action(edit)}>Изменить</button>
      {contract && !review.confirmed && !seller && !fullySigned ? <button type="button" className="btn" disabled={busy || editing || !ready || !fileKey} onClick={() => {
        const next = { viewed: true, confirmed: true }; setReview(next); writeContractReview(fileKey, next); setError(""); setNote("Договор подтверждён. Можно подписать его со стороны компании.");
      }}>Подтвердить</button> : null}
      {contract && !seller && !fullySigned ? <button type="button" className="btn" disabled={busy || editing || !ready || !review.confirmed || !CONTRACT_SIGNING_ENABLED} onClick={() => void action(sign)}>{busy ? "Подождите…" : "Подписать"}</button> : null}
      {seller && !buyerSigned && !fullySigned ? <button type="button" className="btn" disabled={busy || !CONTRACT_SIGNING_ENABLED} onClick={() => void action(sendToBuyer)}>Отправить на подпись заказчику</button> : null}
      {signing.requests.length > 0 && !buyerSigned && !fullySigned ? <button type="button" className="btn secondary" disabled={busy || !CONTRACT_SIGNING_ENABLED} onClick={() => void action(cancelSigning)}>Отменить подпись и исправить договор</button> : null}
      {contract && !seller && !buyerSigned && !fullySigned ? <button type="button" className="btn secondary" disabled={busy} onClick={() => void action(deleteCurrentContract)}>Удалить договор</button> : null}
    </>}
  >
    {error ? <p className="error" role="alert">{error}</p> : null}
    {!contract && !error ? <p className="muted">Загружаем сведения о договоре…</p> : null}
    {!contract && error ? <button type="button" className="btn secondary" disabled={busy} onClick={() => void action(async () => { await read(); })}>Повторить загрузку</button> : null}
    {note ? <p role="status">{note}</p> : null}
    {contract ? <p className="muted">{Number(contract.totalAmount).toLocaleString("ru-RU")} {contract.currency === "KZT" ? "₸" : contract.currency} · {fullySigned ? "Подписан обеими сторонами" : seller ? "Подписан компанией, ожидается подпись заказчика" : review.confirmed ? "Подтверждён" : "Требует проверки"}</p> : null}
    {contract?.importedPdf ? <p className="muted">Загруженный договор сохраняется в исходном виде. Для изменения загрузите новую редакцию.</p> : contract && !editable ? <p className="muted">{seller || fullySigned ? "Договор уже подписан компанией. Изменение этой версии недоступно." : "Версия договора зафиксирована для подписания. Если попытка не удалась, нажмите «Подписать» повторно."}</p> : null}
    {editing ? <form className="panel contract-edit-form" onSubmit={event => { event.preventDefault(); void action(save); }}>
      <label>Номер договора<input maxLength={40} value={form.number} disabled={busy} onChange={event => setForm({ ...form, number: event.target.value })}/></label>
      <label>Дата договора<input type="date" required value={form.documentDate} disabled={busy} onChange={event => setForm({ ...form, documentDate: event.target.value })}/></label>
      <label>Предмет договора<textarea required value={form.subject} disabled={busy} onChange={event => setForm({ ...form, subject: event.target.value })}/></label>
      <label>Условия оплаты<textarea value={form.paymentTerms} disabled={busy} onChange={event => setForm({ ...form, paymentTerms: event.target.value })}/></label>
      <label>Срок исполнения<input value={form.completionTerms} disabled={busy} onChange={event => setForm({ ...form, completionTerms: event.target.value })}/></label>
      <label>Шаблон<select value={form.templateId} disabled={busy} onChange={event => setForm({ ...form, templateId: event.target.value })}><option value="">Шаблон по умолчанию</option>{templates.map(template => <option value={template.id} key={template.id}>{template.name}</option>)}</select></label>
      <p className="muted">Сохранение сформирует новую PDF-копию договора. Её потребуется подтвердить заново.</p>
      <div className="actions"><button className="btn" disabled={busy}>Сохранить изменения</button><button type="button" className="btn secondary" disabled={busy} onClick={() => setEditing(false)}>Отмена</button></div>
    </form> : null}
    <ContractSignatureSummary signed={fullySigned} verificationUrl={signing.verificationUrl} sellerName={signing.sellerName} buyerName={signing.buyerName}
      signers={(signing.signatures || []).map(row => ({ ...row, name: row.signerName, role: signing.requests.find(request => request.id === row.signatureRequestId)?.signerType }))}
      download={format => api.downloadSignedContract(contractId, format)} />
    {buyerLink ? <div className="panel"><label>Ссылка заказчику для подписи<input readOnly value={buyerLink} onFocus={event => event.target.select()}/></label><button type="button" className="btn secondary" onClick={() => void action(async () => { await navigator.clipboard.writeText(buyerLink); setNote("Ссылка скопирована. Отправьте её заказчику."); })}>Скопировать ссылку</button></div> : null}
  </ContractPreviewModal>;
}
