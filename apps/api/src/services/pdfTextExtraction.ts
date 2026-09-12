import { createRequire } from "node:module";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import { createWorker, PSM, type Worker } from "tesseract.js";
import { ApiError } from "../errors.ts";

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
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 20) throw new ApiError(422, "pdf_too_many_pages", "Загрузите PDF не более 20 страниц");
    const pages: PdfPageText[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      if (viewport.width * viewport.height > 3_000_000) throw new ApiError(422, "pdf_page_too_large", "Слишком большой размер страницы PDF");
      const content = await page.getTextContent();
      let words: PdfWord[] = content.items.flatMap((item) => "str" in item && item.str.trim() ? [{ text: item.str, x: item.transform[4], y: viewport.height - item.transform[5] - item.height, width: item.width, height: item.height || 10 }] : []);
      let width = viewport.width, height = viewport.height;
      let ocrText = "";
      const ocr = words.map(w => w.text).join("").length < 40;
      if (ocr) {
        if (!worker) {
          languageDir = await mkdtemp(path.join(tmpdir(), "crm-ocr-"));
          await Promise.all(["rus", "eng"].map(async (code) => {
            const { langPath } = require(`@tesseract.js-data/${code}`);
            await copyFile(`${langPath}/${code}.traineddata.gz`, path.join(languageDir!, `${code}.traineddata.gz`));
          }));
          worker = await createWorker("rus+eng", 1, { langPath: languageDir, cacheMethod: "none", errorHandler: () => undefined });
          await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: "1" });
        }
        const scaled = page.getViewport({ scale: Math.min(2.6, 2200 / viewport.width) });
        const canvas = createCanvas(Math.ceil(scaled.width), Math.ceil(scaled.height));
        const context = canvas.getContext("2d");
        await page.render({ canvas: canvas as never, canvasContext: context as never, viewport: scaled }).promise;
        const result = await Promise.race([
          worker.recognize(canvas.toBuffer("image/png"), { rotateAuto: true }, { text: true, blocks: true }),
          new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new ApiError(422, "pdf_ocr_timeout", "Распознавание заняло слишком много времени. Разделите PDF на части.")), 45_000); }),
        ]);
        clearTimeout(timeout);
        ocrText = result.data.text;
        width = canvas.width; height = canvas.height;
        words = (result.data.blocks || []).flatMap(block => block.paragraphs.flatMap(p => p.lines.flatMap(line => line.words.map(w => ({ text: w.text, x: w.bbox.x0, y: w.bbox.y0, width: w.bbox.x1 - w.bbox.x0, height: w.bbox.y1 - w.bbox.y0 })))));
      }
      pages.push({ page: n, words, width, height, ocr, text: ocrText || wordsToLines(words).map(l => l.text).join("\n") });
      page.cleanup();
    }
    return pages;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, "pdf_unreadable", "Не удалось прочитать PDF. Проверьте файл и снимите защиту паролем.");
  } finally {
    clearTimeout(timeout);
    await worker?.terminate();
    await task.destroy();
    if (languageDir) await rm(languageDir, { recursive: true, force: true });
  }
}
