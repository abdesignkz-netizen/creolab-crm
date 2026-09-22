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
          setError(err instanceof Error ? err.message : "Не удалось открыть договор");
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [contract.id, contract.preview, fileRevision, retry]);

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
        <div className="actions">
          {actions?.(!loading && !error && Boolean(pdfUrl))}
          <button
            type="button"
            className="btn"
            disabled={busy || (loading && !error)}
            onClick={() =>
              void (contract.preview ? downloadContractPreview(contract.id) : downloadContractFile(contract.id))
            }
          >
            Скачать PDF
          </button>
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
