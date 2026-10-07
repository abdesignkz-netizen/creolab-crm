import { InlineFeedback } from "./InlineFeedback";
import { uiText, useUiText, localizeUiOptions, uiFormatLocale } from "../lib/uiText";
import { useState } from "react";
import { signatureCheckLabel } from "../lib/signing/verificationLabels";

type Signer = { role?: string; name?: string | null; signedAt?: string | null; verificationStatus?: string; authorityStatus?: string; cryptoStatus?: string };
export function ContractSignatureSummary({ signed, signers, verificationUrl, download, sellerName, buyerName, documentLabel = "договора" }: {
  documentLabel?: string;
  sellerName?: string | null; buyerName?: string | null;
  signed: boolean; signers: Signer[]; verificationUrl?: string | null;
  download: (format: "pdf" | "zip") => Promise<{ blob: Blob; filename: string }>;
}) {
  const uiText = useUiText();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(format: "pdf" | "zip") {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const file = await download(format);
      const url = URL.createObjectURL(file.blob);
      const link = document.createElement("a"); link.href = url; link.download = file.filename;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) { setError(err instanceof Error ? err.message : uiText("Не удалось скачать документ")); }
    finally { setBusy(false); }
  }
  if (!signers.length && !signed) return null;
  return <section className="panel" aria-label={uiText("Подписи {p0}", {p0: uiText(documentLabel)})}>
    <h3>{signed ? uiText("Подписан обеими сторонами") : uiText("Подписи {p0}", {p0: uiText(documentLabel)})}</h3>
    {signers.map((signer, index) => <p key={`${signer.role}-${index}`}>
      {(signer.role === "SELLER" ? sellerName : buyerName) ? <><span>{signer.role === "SELLER" ? sellerName : buyerName}</span><br /></> : null}
      <strong>{signer.role === "SELLER" ? uiText("Исполнитель") : signer.role === "BUYER" ? uiText("Заказчик") : uiText("Подписант")}: {signer.name || "—"}</strong><br />
      {signer.signedAt ? new Date(signer.signedAt).toLocaleString(uiFormatLocale()) : ""}
      {signatureCheckLabel(signer) ? ` · ${signatureCheckLabel(signer)}` : ""}
    </p>)}
    {verificationUrl ? <p><a href={verificationUrl} target="_blank" rel="noreferrer">{uiText("Проверить подписание")}</a></p> : null}
    {signed ? <>
      <div className="actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void save("pdf")}>{busy ? uiText("Подождите…") : uiText("Скачать PDF с отметками")}</button>
        <button type="button" className="btn secondary" disabled={busy} onClick={() => void save("zip")}>{uiText("Скачать оригинал и ЭЦП")}</button>
      </div>
      <p className="muted">{uiText("PDF содержит документ и лист подписания с QR-кодом. В архиве — неизменённый оригинал, обе ЭЦП и сведения о подписании.")}</p>
    </> : null}
    {error ? <InlineFeedback kind="error" className="error">{error}</InlineFeedback> : null}
  </section>;
}
