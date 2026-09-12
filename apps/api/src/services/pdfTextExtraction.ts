import { createRequire } from "node:module";
import { once } from "node:events";
import type { Worker as NodeWorker } from "node:worker_threads";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearAllCache, createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import { createWorker, PSM, type Worker } from "tesseract.js";
import { ApiError } from "../errors.ts";
import { grayscaleImage, needsDetailedOcr, ocrScale, preferDetailedOcr } from "./pdfOcrImage.ts";

const require = createRequire(import.meta.url);
export type PdfWord = { text: string; x: number; y: number; width: number; height: number };
export type PdfPageText = { page: number; text: string; words: PdfWord[]; width: number; height: number; ocr: boolean };

export function wordsToLines(words: PdfWord[]) {
  const rows: Array<{ y: number; height: number; words: PdfWord[] }> = [];
  for (const word of [...words].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = [...rows].reverse().find((r) => Math.abs(r.y - word.y) < Math.max(5, Math.min(r.height, word.height) * 0.55));
    if (row) row.words.push(word);
    else rows.push({ y: word.y, height: word.height, words: [word] });
  }
  return rows.map((row) => {
    const sorted = row.words.sort((a, b) => a.x - b.x);
    return { y: row.y, text: sorted.map((word, i) => {
      const prev = sorted[i - 1];
      return `${prev ? word.x - prev.x - prev.width > row.height ? "   " : " " : ""}${word.text}`;
    }).join("") };
  });
}

/** Text and OCR stay on the CRM server. Packaged language data avoids runtime downloads. */
export async function extractPdfPages(bytes: Buffer): Promise<PdfPageText[]> {
  Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  let worker: Worker | undefined;
  let languageDir: string | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  async function releaseWorker() {
    if (!worker) return;
    const current = worker;
    worker = undefined;
    // Tesseract.js 7 resolves terminate() before the Node thread has exited.
    // Wait for that exit before releasing the document's concurrency slot.
    const thread = (current as Worker & { worker: NodeWorker }).worker;
    if (thread.threadId === -1) return;
    const exited = once(thread, "exit");
    await current.terminate();
    await exited;
  }
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 20) throw new ApiError(422, "pdf_too_many_pages", "Загрузите PDF не более 20 страниц");
    const pages: PdfPageText[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      try {
        const viewport = page.getViewport({ scale: 1 });
        if (viewport.width * viewport.height > 3_000_000) throw new ApiError(422, "pdf_page_too_large", "Слишком большой размер страницы PDF");
        const content = await page.getTextContent();
        let words: PdfWord[] = content.items.flatMap((item) => "str" in item && item.str.trim() ? [{ text: item.str, x: item.transform[4], y: viewport.height - item.transform[5] - item.height, width: item.width, height: item.height || 10 }] : []);
        let width = viewport.width, height = viewport.height;
        let ocrText = "";
        const ocr = words.map(w => w.text).join("").length < 40;
        if (ocr) {
          // One deadline covers both attempts on this page.
          const deadline = Date.now() + 45_000;
          const recognize = async (detailed: boolean) => {
            const scaled = page.getViewport({ scale: ocrScale(viewport.width, viewport.height, detailed) });
            const canvas = createCanvas(Math.max(1, Math.floor(scaled.width)), Math.max(1, Math.floor(scaled.height)));
            let image: Buffer;
            const dimensions = { width: canvas.width, height: canvas.height };
            try {
              const context = canvas.getContext("2d");
              await page.render({ canvas: canvas as never, canvasContext: context as never, viewport: scaled, background: "rgb(255,255,255)" }).promise;
              image = grayscaleImage(canvas);
            } finally {
              // Release the native RGBA surface before the OCR engine allocates its workspace.
              canvas.width = 1;
              canvas.height = 1;
              clearAllCache();
            }
            page.cleanup();
            await pdf.cleanup();
            if (!worker) {
              if (!languageDir) {
                languageDir = await mkdtemp(path.join(tmpdir(), "crm-ocr-"));
                await Promise.all(["rus", "eng"].map(async (code) => {
                  const { langPath } = require(`@tesseract.js-data/${code}`);
                  // Match the LSTM-only engine. The default 4.0.0 files also
                  // contain unused legacy models and require more memory.
                  await copyFile(path.join(langPath, "..", "4.0.0_best_int", `${code}.traineddata.gz`), path.join(languageDir!, `${code}.traineddata.gz`));
                }));
              }
              worker = await createWorker("rus+eng", 1, { langPath: languageDir, cacheMethod: "none", errorHandler: () => undefined });
              await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: "1" });
            }
            // Local adaptive thresholding on the retry helps faint text next to
            // darker print; the source image itself stays continuous grayscale.
            await worker.setParameters({ thresholding_method: detailed ? "2" : "0", thresholding_kfactor: "0.15" });
            try {
              const result = await Promise.race([
                worker!.recognize(image, { rotateAuto: true }, { text: true, blocks: true }),
                new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new ApiError(422, "pdf_ocr_timeout", "Распознавание заняло слишком много времени. Разделите PDF на части.")), Math.max(1, deadline - Date.now())); }),
              ]);
              return { data: result.data, ...dimensions };
            } finally { clearTimeout(timeout); }
          };
          let result = await recognize(false);
          if (needsDetailedOcr(result.data)) {
            const detailed = await recognize(true);
            if (preferDetailedOcr(result.data, detailed.data)) result = detailed;
          }
          ocrText = result.data.text;
          width = result.width; height = result.height;
          words = (result.data.blocks || []).flatMap(block => block.paragraphs.flatMap(p => p.lines.flatMap(line => line.words.map(w => ({ text: w.text, x: w.bbox.x0, y: w.bbox.y0, width: w.bbox.x1 - w.bbox.x0, height: w.bbox.y1 - w.bbox.y0 })))));
        }
        pages.push({ page: n, words, width, height, ocr, text: ocrText || wordsToLines(words).map(l => l.text).join("\n") });
        if (worker) {
          // Reset the previous page's image/layout without running OCR again.
          // Reuse the engine's allocated workspace instead of growing new heaps per page.
          await worker.recognize(Buffer.concat([Buffer.from("P5\n16 16\n255\n"), Buffer.alloc(256, 255)]), {}, { text: false, blocks: false });
          await worker.FS("unlink", ["/input"]);
        }
      } finally {
        page.cleanup();
        await pdf.cleanup();
        clearAllCache();
      }
    }
    return pages;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, "pdf_unreadable", "Не удалось прочитать PDF. Проверьте файл и снимите защиту паролем.");
  } finally {
    clearTimeout(timeout);
    try { await releaseWorker(); }
    finally {
      try { await task.destroy(); }
      finally { if (languageDir) await rm(languageDir, { recursive: true, force: true }); }
    }
  }
}
