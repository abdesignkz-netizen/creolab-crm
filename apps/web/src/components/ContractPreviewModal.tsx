import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, downloadContractFile, downloadContractPreview } from "../lib/api";

function isPdfFile(blob: Blob, filename: string) {
  return /pdf/i.test(blob.type) || /\.pdf$/i.test(filename);
}

export function ContractPreviewModal({
  contract,
  onClose,
  onViewed,
  onConfirm,
  confirmed,
  fileRevision,
  busy = false,
  children,
  actions,
}: {
  contract: { id: string; number?: string; preview?: boolean };
  onClose: () => void;
  onViewed?: () => void;
  onConfirm?: () => void;
  confirmed?: boolean;
  fileRevision?: string | null;
  busy?: boolean;
  children?: ReactNode;
  actions?: (ready: boolean) => ReactNode;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pdfUrl, setPdfUrl] = useState("");
  const [retry, setRetry] = useState(0);
  const [format, setFormat] = useState<"pdf" | "docx">("pdf");
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const onViewedRef = useRef(onViewed);
  onViewedRef.current = onViewed;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  useEffect(() => {
    let cancelled = false;
    let objectUrl = "";
    setLoading(true);
    setError("");
    setPdfUrl("");
    setDownloadError("");
    void (async () => {
      try {
        const file = contract.preview
          ? await api.downloadContractPreview(contract.id)
          : await api.downloadContractFile(contract.id);
        if (cancelled) return;
        if (!isPdfFile(file.blob, file.filename)) {
          setError("Договор должен открываться как PDF. Сформируйте его ещё раз.");
          setLoading(false);
          return;
        }
        objectUrl = URL.createObjectURL(file.blob);
        setPdfUrl(objectUrl);
        setLoading(false);
        onViewedRef.current?.();
      } catch (err) {
        if (!cancelled) {
          const code = (err as { code?: string })?.code;
          setError(code === "word_conversion_failed" || code === "word_conversion_unavailable"
            ? "Не удалось подготовить PDF для просмотра. Повторите открытие или скачайте исходный договор в Word."
            : err instanceof Error ? err.message : "Не удалось открыть договор");
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [contract.id, contract.preview, fileRevision, retry]);

  async function download() {
    if (downloading) return;
    setDownloading(true); setDownloadError("");
    try {
      await (contract.preview ? downloadContractPreview(contract.id, format) : downloadContractFile(contract.id, format));
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : "Не удалось скачать договор. Повторите попытку.");
    } finally { setDownloading(false); }
  }

  return (
    <div className="stats-modal-backdrop" onClick={() => { if (!busy) onClose(); }}>
      <div
        className="stats-modal invoice-preview-modal contract-preview-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Просмотр договора ${contract.number || ""}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="row sit-head">
          <h3>Договор {contract.number || ""}</h3>
          <button type="button" className="btn secondary" disabled={busy} onClick={onClose}>
            Закрыть
          </button>
        </div>
        {children}
        {error ? <div role="alert"><p className="error">{error}</p><button type="button" className="btn secondary" disabled={busy} onClick={() => setRetry(value => value + 1)}>Повторить открытие PDF</button></div> : null}
        {loading ? <p className="muted">Открываем PDF…</p> : null}
        {pdfUrl ? <iframe title="Просмотр договора" src={pdfUrl} /> : null}
        {downloadError ? <p className="error" role="alert">{downloadError}</p> : null}
        <div className="actions">
          {actions?.(!loading && !error && Boolean(pdfUrl))}
          <div className="actions contract-download-actions">
            <select aria-label="Формат скачивания договора" value={format} disabled={busy || downloading} onChange={(event) => setFormat(event.target.value as "pdf" | "docx")}>
              <option value="pdf">PDF</option><option value="docx">Word (.docx)</option>
            </select>
            <button type="button" className="btn" disabled={busy || downloading || (format === "pdf" && loading)} onClick={() => void download()}>
              {downloading ? "Скачиваем…" : `Скачать в ${format === "pdf" ? "PDF" : "Word"}`}
            </button>
          </div>
          {onConfirm && !contract.preview ? (
            <button
              type="button"
              className="btn"
              disabled={loading || Boolean(error) || confirmed}
              onClick={() => {
                onConfirm();
                onClose();
              }}
            >
              {confirmed ? "Подтверждён" : "Подтвердить"}
            </button>
          ) : null}
          <button type="button" className="btn secondary" disabled={busy} onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}
