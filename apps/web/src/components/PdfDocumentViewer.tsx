import { useEffect, useRef, useState } from "react";

import { useLocale } from "../lib/session";
import { readPdfSource } from "../lib/pdfSource";
import { t } from "../i18n";

type PdfDocumentViewerProps = {
  file: Blob;
  title: string;
  className?: string;
};

type PdfLoadingTask = { promise: Promise<PdfDocument>; destroy: () => Promise<void> };
type PdfRenderTask = { promise: Promise<void>; cancel: () => void };
type Viewport = { width: number; height: number };
type PdfJsModule = {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument: (source: Awaited<ReturnType<typeof readPdfSource>>) => PdfLoadingTask;
};
type PdfDocument = { numPages: number; getPage: (pageNumber: number) => Promise<PdfPage> };
type PdfPage = {
  getViewport: (options: { scale: number }) => Viewport;
  render: (options: {
    canvas: HTMLCanvasElement;
    canvasContext: CanvasRenderingContext2D;
    viewport: Viewport;
    transform: number[];
  }) => PdfRenderTask;
};

const PDF_TIMEOUT_MS = 30_000;
let pdfJsPromise: Promise<PdfJsModule> | null = null;
function loadPdfJs() {
  if (!pdfJsPromise) {
    // The legacy build includes the complete Safari compatibility polyfills.
    pdfJsPromise = import("pdfjs-dist/legacy/build/pdf.mjs").then((module) => {
      const pdfJs = module as unknown as PdfJsModule;
      pdfJs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
      return pdfJs;
    }).catch((error) => { pdfJsPromise = null; throw error; });
  }
  return pdfJsPromise;
}

export function PdfDocumentViewer({ file, title, className = "" }: PdfDocumentViewerProps) {
  const locale = useLocale();
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const [document, setDocument] = useState<PdfDocument | null>(null);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [width, setWidth] = useState(0);
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<"pdf.loadError" | "pdf.renderError" | null>(null);
  const [retry, setRetry] = useState(0);
  const [download, setDownload] = useState<{ file: Blob; url: string } | null>(null);
  const src = download?.file === file ? download.url : "";

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setDownload({ file, url });
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    let task: PdfLoadingTask | undefined;
    const controller = new AbortController();
    const stop = () => {
      controller.abort();
      if (task) { void task.destroy().catch(() => {}); task = undefined; }
    };
    setLoading(true); setRendering(false); setError(null); setDocument(null); setPage(1); setScale(1);
    const timer = window.setTimeout(() => {
      active = false; stop(); setLoading(false); setError("pdf.loadError");
    }, PDF_TIMEOUT_MS);
    void (async () => {
      try {
        const [pdfJs, source] = await Promise.all([loadPdfJs(), readPdfSource(file, controller.signal)]);
        if (!active) return;
        task = pdfJs.getDocument(source);
        const pdf = await task.promise;
        if (active) setDocument(pdf);
      } catch {
        if (active) { stop(); setError("pdf.loadError"); }
      } finally {
        window.clearTimeout(timer);
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; window.clearTimeout(timer); stop(); };
  }, [file, retry]);

  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;
    // React owns the status UI; PDF.js owns only this dedicated canvas host.
    host.replaceChildren();
    if (!document || !width) return;
    let active = true;
    let task: PdfRenderTask | undefined;
    setRendering(true); setError(null);
    const timer = window.setTimeout(() => {
      active = false; task?.cancel(); setRendering(false); setError("pdf.renderError");
    }, PDF_TIMEOUT_MS);
    void (async () => {
      try {
        const pdfPage = await document.getPage(page);
        if (!active) return;
        const base = pdfPage.getViewport({ scale: 1 });
        const fit = Math.min(1.8, width / base.width);
        const viewport = pdfPage.getViewport({ scale: fit * scale });
        const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(12_000_000 / (viewport.width * viewport.height)));
        const canvas = window.document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width * ratio); canvas.height = Math.ceil(viewport.height * ratio);
        canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
        canvas.className = "pdf-page-canvas";
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas unavailable");
        task = pdfPage.render({ canvas, canvasContext: context, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
        await task.promise;
        if (active) host.replaceChildren(canvas);
      } catch {
        if (active) setError("pdf.renderError");
      } finally {
        window.clearTimeout(timer);
        if (active) setRendering(false);
      }
    })();
    return () => { active = false; window.clearTimeout(timer); task?.cancel(); host.replaceChildren(); };
  }, [document, page, scale, width]);

  return <div className={`pdf-document-viewer ${className}`}>
    <div className="pdf-viewer-toolbar" role="group" aria-label={t(locale, "pdf.navigation", { title })}>
      <div className="pdf-viewer-controls">
        <button type="button" className="btn secondary" aria-label={t(locale, "common.previous")} disabled={!document || page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>‹</button>
        <span aria-live="polite">{document ? `${page} / ${document.numPages}` : loading ? "…" : "—"}</span>
        <button type="button" className="btn secondary" aria-label={t(locale, "common.next")} disabled={!document || page >= document.numPages} onClick={() => setPage((value) => Math.min(document?.numPages || value, value + 1))}>›</button>
        <button type="button" className="btn secondary" aria-label={t(locale, "pdf.zoomOut")} disabled={!document || scale <= 0.75} onClick={() => setScale((value) => Math.max(0.75, value - 0.15))}>−</button>
        <button type="button" className="btn secondary" aria-label={t(locale, "pdf.zoomIn")} disabled={!document || scale >= 1.8} onClick={() => setScale((value) => Math.min(1.8, value + 0.15))}>+</button>
      </div>
      {src ? <div className="pdf-viewer-actions">
        <a className="btn secondary" href={src} target="_blank" rel="noopener noreferrer">{t(locale, "pdf.openSeparately")}</a>
        <a className="btn secondary" href={src} download={`${title.replace(/[\\/:*?"<>|]/g, "-")}.pdf`}>{t(locale, "pdf.download")}</a>
      </div> : null}
    </div>
    <div ref={hostRef} className="pdf-viewer-page" role="document" aria-label={t(locale, "pdf.page", { title, page })} aria-busy={loading || rendering}>
      {loading || rendering ? <p className="muted" role="status">{t(locale, "pdf.opening")}</p> : null}
      {error ? <div className="pdf-fallback-message" role="alert"><p>{t(locale, error)}</p><button className="btn secondary" type="button" onClick={() => setRetry(value => value + 1)}>{t(locale, "legal.retry")}</button></div> : null}
      <div ref={canvasHostRef} />
    </div>
  </div>;
}
