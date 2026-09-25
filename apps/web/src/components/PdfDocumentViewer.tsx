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
    installPdfCompatibility();
    pdfJsPromise = import("pdfjs-dist/legacy/build/pdf.mjs").then((module) => {
      const pdfJs = module as unknown as PdfJsModule;
      pdfJs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
      return pdfJs;
    });
  }
  return pdfJsPromise;
}

function installPdfCompatibility() {
  const runtime = globalThis as typeof globalThis & {
    Iterator?: new () => unknown;
    Promise: typeof Promise & { withResolvers?: <T>() => { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void } };
  };
  // PDF.js 6 uses the Iterator Helpers proposal and Promise.withResolvers.
  // Older Safari versions need these tiny fallbacks before the module loads.
  if (!runtime.Iterator) runtime.Iterator = class Iterator {};
  if (!runtime.Promise.withResolvers) {
    runtime.Promise.withResolvers = function withResolvers<T>() {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    };
  }
  const mapPrototype = Map.prototype as Map<unknown, unknown> & { getOrInsertComputed?: (key: unknown, factory: () => unknown) => unknown };
  if (!mapPrototype.getOrInsertComputed) {
    mapPrototype.getOrInsertComputed = function (key, factory) {
      if (this.has(key)) return this.get(key);
      const value = factory(); this.set(key, value); return value;
    };
  }
  const iteratorPrototype = runtime.Iterator.prototype as { join?: (separator?: string) => string };
  if (!iteratorPrototype.join) iteratorPrototype.join = function (separator = ",") { return Array.from(this as never).join(separator); };
}

export function PdfDocumentViewer({ src, title, className = "" }: PdfDocumentViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [document, setDocument] = useState<PdfDocument | null>(null);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [nativeFallback, setNativeFallback] = useState(false);

  const isSafari = /Safari/i.test(navigator.userAgent) && !/(Chrome|Chromium|CriOS|Android)/i.test(navigator.userAgent);

  useEffect(() => {
    let cancelled = false;
    setLoading(!isSafari); setError(""); setDocument(null); setPage(1); setNativeFallback(isSafari);
    if (isSafari) return () => { cancelled = true; };
    void loadPdfJs().then((pdfJs) => pdfJs.getDocument({ url: src }).promise).then((pdf) => {
      if (!cancelled) setDocument(pdf);
    }).catch((reason) => {
      if (!cancelled) { setError(""); setNativeFallback(true); }
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
      {nativeFallback ? <object className="pdf-native-fallback" data={src} type="application/pdf" aria-label={title}>
        <div className="pdf-fallback-message"><p className="muted">Встроенный просмотр недоступен в этом браузере.</p><a className="btn secondary" href={src} target="_blank" rel="noreferrer">Открыть PDF отдельно</a></div>
      </object> : null}
      {loading ? <p className="muted">Открываем PDF…</p> : null}
      {error ? <p className="muted">Открываем PDF в режиме совместимости…</p> : null}
    </div>
  </div>;
}
