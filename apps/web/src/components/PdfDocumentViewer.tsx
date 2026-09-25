import { useEffect, useRef, useState } from "react";

type PdfDocumentViewerProps = {
  src: string;
  title: string;
  className?: string;
};

type PdfJsModule = {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument: (source: { url: string }) => { promise: Promise<PdfDocument> };
};

type PdfDocument = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPage>;
};

type PdfPage = {
  getViewport: (options: { scale: number }) => { width: number; height: number };
  render: (options: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => { promise: Promise<void> };
};

let pdfJsPromise: Promise<PdfJsModule> | null = null;
function loadPdfJs() {
  if (!pdfJsPromise) {
    // PDF.js 6 references the Iterator proposal during module evaluation;
    // older Safari versions do not expose the global yet.
    if (!("Iterator" in globalThis)) {
      (globalThis as typeof globalThis & { Iterator?: new () => unknown }).Iterator = class Iterator {};
    }
    pdfJsPromise = import("pdfjs-dist").then((module) => {
      const pdfJs = module as unknown as PdfJsModule;
      pdfJs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
      return pdfJs;
    });
  }
  return pdfJsPromise;
}

export function PdfDocumentViewer({ src, title, className = "" }: PdfDocumentViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [document, setDocument] = useState<PdfDocument | null>(null);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(""); setDocument(null); setPage(1);
    void loadPdfJs().then((pdfJs) => pdfJs.getDocument({ url: src }).promise).then((pdf) => {
      if (!cancelled) setDocument(pdf);
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "Не удалось открыть PDF");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [src]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !document) return;
    let cancelled = false;
    void document.getPage(page).then((pdfPage) => {
      if (cancelled) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const available = Math.max(240, host.clientWidth - 16);
      const fit = Math.min(1.8, Math.max(0.45, available / base.width));
      const viewport = pdfPage.getViewport({ scale: fit * scale });
      const canvas = window.document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      canvas.className = "pdf-page-canvas";
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Не удалось подготовить просмотр PDF");
      host.replaceChildren(canvas);
      return pdfPage.render({ canvasContext: context, viewport }).promise;
    }).catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Не удалось отобразить страницу"); });
    return () => { cancelled = true; };
  }, [document, page, scale]);

  return <div className={`pdf-document-viewer ${className}`}>
    <div className="pdf-viewer-toolbar" aria-label={`Навигация по документу ${title}`}>
      <button type="button" className="btn secondary" disabled={!document || page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>‹</button>
      <span aria-live="polite">{document ? `${page} / ${document.numPages}` : "…"}</span>
      <button type="button" className="btn secondary" disabled={!document || page >= document.numPages} onClick={() => setPage((value) => Math.min(document?.numPages || value, value + 1))}>›</button>
      <button type="button" className="btn secondary" disabled={!document} onClick={() => setScale((value) => Math.max(0.75, value - 0.15))}>−</button>
      <button type="button" className="btn secondary" disabled={!document} onClick={() => setScale((value) => Math.min(1.8, value + 0.15))}>+</button>
    </div>
    <div ref={hostRef} className="pdf-viewer-page" role="document" aria-label={`${title}, страница ${page}`}>
      {loading ? <p className="muted">Открываем PDF…</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </div>
  </div>;
}
