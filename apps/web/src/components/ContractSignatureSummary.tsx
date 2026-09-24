import { useState } from "react";
import { signatureCheckLabel } from "../lib/signing/verificationLabels";

type Signer = { role?: string; name?: string | null; signedAt?: string | null; verificationStatus?: string; authorityStatus?: string; cryptoStatus?: string };
export function ContractSignatureSummary({ signed, signers, verificationUrl, download, sellerName, buyerName, documentLabel = "договора" }: {
  documentLabel?: string;
  sellerName?: string | null; buyerName?: string | null;
  signed: boolean; signers: Signer[]; verificationUrl?: string | null;
  download: (format: "pdf" | "zip") => Promise<{ blob: Blob; filename: string }>;
}) {
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
    } catch (err) { setError(err instanceof Error ? err.message : "Не удалось скачать документ"); }
    finally { setBusy(false); }
  }
  if (!signers.length && !signed) return null;
  return <section className="panel" aria-label={`Подписи ${documentLabel}`}>
    <h3>{signed ? "Подписан обеими сторонами" : `Подписи ${documentLabel}`}</h3>
    {signers.map((signer, index) => <p key={`${signer.role}-${index}`}>
      {(signer.role === "SELLER" ? sellerName : buyerName) ? <><span>{signer.role === "SELLER" ? sellerName : buyerName}</span><br /></> : null}
      <strong>{signer.role === "SELLER" ? "Исполнитель" : signer.role === "BUYER" ? "Заказчик" : "Подписант"}: {signer.name || "—"}</strong><br />
      {signer.signedAt ? new Date(signer.signedAt).toLocaleString("ru-RU") : ""}
      {signatureCheckLabel(signer) ? ` · ${signatureCheckLabel(signer)}` : ""}
    </p>)}
    {verificationUrl ? <p><a href={verificationUrl} target="_blank" rel="noreferrer">Проверить подписание</a></p> : null}
    {signed ? <>
      <div className="actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void save("pdf")}>{busy ? "Подождите…" : "Скачать PDF с отметками"}</button>
        <button type="button" className="btn secondary" disabled={busy} onClick={() => void save("zip")}>Скачать оригинал и ЭЦП</button>
      </div>
      <p className="muted">PDF содержит документ и лист подписания с QR-кодом. В архиве — неизменённый оригинал, обе ЭЦП и сведения о подписании.</p>
    </> : null}
    {error ? <p className="error" role="alert">{error}</p> : null}
  </section>;
}
