import path from "node:path";
import type JSZip from "jszip";
import { AI_KNOWLEDGE_FILE_BYTES } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { decodeKnowledgeHtml } from "./knowledgeWebsiteText.ts";
import { ensureKnowledgeImportMemory } from "./knowledgeImportResources.ts";

export type KnowledgeFileText = { content: string; ocr: boolean; pages: number; warnings: string[] };
const invalid = () => new ApiError(422, "knowledge_file_invalid", "Файл повреждён или его содержимое не соответствует формату. Сохраните его заново и повторите загрузку.");
const large = () => new ApiError(422, "knowledge_file_complex", "Материал слишком большой. Разделите его на несколько файлов или оставьте нужные страницы и строки.");
export function checkKnowledgeText(content: string) {
  const text = content.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/\n{4,}/g, "\n\n\n").trim();
  if (!text || !/[\p{L}\p{N}]/u.test(text)) throw new ApiError(422, "knowledge_no_text", "Не удалось найти текст. Загрузите более чёткий скан или вставьте нужные сведения вручную.");
  if (text.length > 120_000) throw large();
  return text;
}

async function readEntry(entry: JSZip.JSZipObject, maxBytes = 8 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const stream = entry.nodeStream("nodebuffer"), chunks: Buffer[] = []; let size = 0, failed = false;
    stream.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > maxBytes) { failed = true; stream.pause(); reject(large()); return; }
      chunks.push(chunk);
    }).on("error", reject).on("end", () => { if (!failed) resolve(Buffer.concat(chunks)); }).resume();
  });
}
async function checkedOfficeZip(bytes: Buffer) {
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) throw invalid();
  const { default: Zip } = await import("jszip");
  let zip: JSZip;
  try { zip = await Zip.loadAsync(bytes); } catch { throw invalid(); }
  const entries = Object.values(zip.files).filter(entry => !entry.dir);
  if (entries.length > 800) throw large();
  let size = 0;
  for (const entry of entries) {
    // Validate actual expanded lengths as well as ZIP directory declarations.
    const declared = (entry as JSZip.JSZipObject & { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
    if (typeof declared !== "number" || declared > 8 * 1024 * 1024 || size + declared > 24 * 1024 * 1024) throw large();
    size += (await readEntry(entry)).length;
    if (size > 24 * 1024 * 1024) throw large();
  }
  return zip;
}

/** Check dimensions before image decoders allocate a pixel buffer. */
export function knowledgeImageDimensions(bytes: Buffer, kind: "png" | "jpg") {
  if (kind === "png") {
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString("ascii", 12, 16) !== "IHDR") throw invalid();
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw invalid();
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) throw invalid();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) throw invalid();
    if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    offset += length;
  }
  throw invalid();
}

function wordXmlToText(xml: string) {
  const plain = (value: string) => value.replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:br\b[^>]*\/>/g, "\n").replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, "");
  const visible = xml.replace(/<w:(?:instrText|del)\b[^>]*>[\s\S]*?<\/w:(?:instrText|del)>/g, "");
  // A product and its price must stay on the same row, even when Word wraps
  // each cell in paragraphs. Decode entities after stripping XML only once.
  const rows = visible.replace(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g, (_, row: string) => {
    const cells = [...row.matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)]
      .map(cell => plain(cell[1]).trim().replace(/\s*\n\s*/g, " / ").replace(/[\t ]+/g, " "));
    return `\n${cells.join(" | ")}\n`;
  });
  return decodeKnowledgeHtml(plain(rows));
}

export async function extractKnowledgeFile(fileName: string, bytes: Buffer, temporaryRoot?: string): Promise<KnowledgeFileText> {
  if (bytes.length < 1 || bytes.length > AI_KNOWLEDGE_FILE_BYTES) throw new ApiError(422, "knowledge_file_size", "Выберите непустой файл размером до 10 МБ.");
  const extension = path.extname(fileName).toLowerCase();
  const warnings: string[] = [];
  let content = "", ocr = false, pages = 0;
  if ([".pdf", ".png", ".jpg", ".jpeg"].includes(extension)) {
    let pdfBytes = bytes;
    if (extension === ".pdf") {
      if (bytes.toString("ascii", 0, 5) !== "%PDF-") throw invalid();
    } else {
      const kind = extension === ".png" ? "png" : "jpg";
      const { width, height } = knowledgeImageDimensions(bytes, kind);
      if (!width || !height || width * height > 12_000_000 || width > 12000 || height > 12000) throw new ApiError(422, "knowledge_image_dimensions", "Слишком большое разрешение изображения: максимум 12 млн пикселей и 12 000 пикселей по каждой стороне. Уменьшите разрешение и повторите загрузку.");
      const { PDFDocument } = await import("pdf-lib");
      const doc = await PDFDocument.create();
      const image = kind === "png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      const scale = Math.min(1, 1200 / Math.max(width, height));
      const page = doc.addPage([width * scale, height * scale]);
      page.drawImage(image, { x: 0, y: 0, width: width * scale, height: height * scale });
      pdfBytes = Buffer.from(await doc.save());
    }
    const { extractPdfPages } = await import("./pdfTextExtraction.ts");
    const extracted = await extractPdfPages(pdfBytes, temporaryRoot, () => ensureKnowledgeImportMemory("ocr"));
    pages = extracted.length; ocr = extracted.some(page => page.ocr);
    content = extracted.map(page => `[Страница ${page.page}]\n${page.text.trim()}`).join("\n\n");
    if (!extracted.some(page => page.text.trim())) throw new ApiError(422, "knowledge_no_text", "На изображении или страницах не удалось распознать текст. Загрузите более чёткий файл.");
    if (extracted.some(page => !page.text.trim())) warnings.push("Часть страниц не содержит распознанного текста. Проверьте, не потерялись ли важные сведения.");
    if (ocr) warnings.push("Текст распознан со скана. Обязательно сверьте цены, номера, таблицы и казахские буквы с оригиналом.");
  } else if (extension === ".docx") {
    const zip = await checkedOfficeZip(bytes);
    if (!zip.file("word/document.xml")) throw invalid();
    const names = Object.keys(zip.files).filter(name => /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(name));
    const parts: string[] = [];
    for (const name of names) {
      const xml = (await readEntry(zip.file(name)!)).toString("utf8");
      parts.push(wordXmlToText(xml));
    }
    content = parts.join("\n\n");
    if (Object.keys(zip.files).some(name => name.startsWith("word/media/"))) warnings.push("В Word есть изображения. Их текст не включён: загрузите важные изображения отдельно или сохраните документ в PDF.");
  } else if (extension === ".xlsx" || extension === ".csv") {
    const XLSX = await import("xlsx");
    if (extension === ".xlsx") {
      const zip = await checkedOfficeZip(bytes);
      if (!zip.file("xl/workbook.xml")) throw invalid();
    }
    let data: string | Buffer = bytes;
    if (extension === ".csv") {
      try { data = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { throw new ApiError(422, "knowledge_text_encoding", "Сохраните таблицу в CSV UTF-8 или загрузите XLSX."); }
    }
    const book = XLSX.read(data, { type: typeof data === "string" ? "string" : "buffer", dense: true, sheetRows: 2001, cellFormula: false, cellHTML: false, bookVBA: false });
    if (book.SheetNames.length > 10) throw large();
    const tables: string[] = [];
    for (const name of book.SheetNames) {
      const sheet = book.Sheets[name], range = sheet["!fullref"] || sheet["!ref"];
      if (range) { const decoded = XLSX.utils.decode_range(range); if (decoded.e.r >= 2000 || decoded.e.c >= 50) throw large(); }
      tables.push(`[Лист: ${name}]\n${XLSX.utils.sheet_to_csv(sheet, { FS: " | ", blankrows: false }).trim()}`);
    }
    if (!book.SheetNames.some(name => XLSX.utils.sheet_to_csv(book.Sheets[name], { blankrows: false }).replace(/[,\s";]/g, ""))) throw new ApiError(422, "knowledge_no_text", "В таблице нет данных. Добавьте товары и цены перед загрузкой.");
    content = tables.join("\n\n");
    warnings.push("Проверьте соответствие товаров, цен и столбцов. Формулы не пересчитываются; используются сохранённые значения.");
  } else if (extension === ".txt" || extension === ".md") {
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new ApiError(422, "knowledge_text_encoding", "Сохраните текст в кодировке UTF-8 или загрузите PDF / DOCX."); }
  } else throw new ApiError(422, "knowledge_file_type", "Поддерживаются PDF, DOCX, PNG, JPG, XLSX, CSV, TXT и MD.");
  return { content: checkKnowledgeText(content), ocr, pages, warnings };
}
