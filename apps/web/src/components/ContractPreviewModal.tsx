import { useEffect, useRef, useState } from "react";
import { api, downloadContractFile, downloadContractPreview } from "../lib/api";

function isPdfFile(blob: Blob, filename: string) {
  return /pdf/i.test(blob.type) || /\.pdf$/i.test(filename);
}

export function ContractPreviewModal({
  contract,
  onClose,
}: {
  contract: { id: string; number?: string; preview?: boolean };
  onClose: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pdfUrl, setPdfUrl] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
        if (isPdfFile(file.blob, file.filename)) {
          objectUrl = URL.createObjectURL(file.blob);
          setPdfUrl(objectUrl);
          setLoading(false);
          return;
        }
        const { renderAsync } = await import("docx-preview");
        if (cancelled || !host.current) return;
        host.current.replaceChildren();
        await renderAsync(file.blob, host.current, undefined, {
          inWrapper: true,
          ignoreWidth: false,
          breakPages: true,
          useBase64URL: true,
        });
        if (!cancelled) setLoading(false);
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
  }, [contract.id, contract.preview]);

  return (
    <div className="stats-modal-backdrop" onClick={onClose}>
      <div
        className="stats-modal invoice-preview-modal contract-preview-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Просмотр договора ${contract.number || ""}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="row sit-head">
          <h3>Договор {contract.number || ""}</h3>
          <button type="button" className="btn secondary" onClick={onClose}>
            Закрыть
          </button>
        </div>
        {error ? <p className="error">{error}</p> : null}
        {loading ? <p className="muted">Открываем Word…</p> : null}
        {pdfUrl ? <iframe title="Просмотр договора" src={pdfUrl} /> : null}
        <div
          ref={host}
          className="contract-preview-host"
          hidden={Boolean(pdfUrl) || Boolean(error)}
        />
        <div className="actions">
          <button
            type="button"
            className="btn"
            disabled={loading && !error}
            onClick={() =>
              void (contract.preview ? downloadContractPreview(contract.id) : downloadContractFile(contract.id))
            }
          >
            Скачать Word
          </button>
          <button type="button" className="btn secondary" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}
