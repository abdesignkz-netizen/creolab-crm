export type PdfSource = { data: Uint8Array };

export async function readPdfSource(file: Blob, signal: AbortSignal): Promise<PdfSource> {
  // Read the already authenticated download directly. Blob URL requests fail
  // under CSP / PDF.js's XHR transport; the URL is only for open/download links.
  if (signal.aborted) throw new DOMException("PDF preview cancelled", "AbortError");
  const buffer = await file.arrayBuffer();
  if (signal.aborted) throw new DOMException("PDF preview cancelled", "AbortError");
  // Each attempt gets its own buffer: PDF.js transfers it to its worker.
  return { data: new Uint8Array(buffer) };
}
