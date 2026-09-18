import path from "node:path";
import JSZip from "jszip";
import type { PrismaClient } from "@creolab/db";
import { parseCompanyRequisitesSchema, type ParseCompanyRequisitesInput } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { requireTenant } from "../lib/access.ts";
import type { AuthContext } from "../lib/types.ts";
import { beginDocumentExtraction } from "./documentExtractionGate.ts";
import { extractPdfPages, type PdfPageText } from "./pdfTextExtraction.ts";
import { wordToPdf } from "./wordDocumentConversion.ts";
import { recognizeCompanyRequisites, scoreCompanyRequisites } from "./companyRequisitesParser.ts";

const PDF_MAGIC = Buffer.from("%PDF-");
const DOCX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const DOC_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

function decodeXmlEntities(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export async function docxToText(bytes: Buffer) {
  if (!bytes.subarray(0, 4).equals(DOCX_MAGIC)) {
    throw new ApiError(422, "word_invalid", "Файл не соответствует формату Word. Выберите .docx или .doc");
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new ApiError(422, "word_invalid", "Не удалось открыть Word. Проверьте, что файл не повреждён.");
  }
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) throw new ApiError(422, "word_invalid", "В файле Word нет текста документа.");
  return decodeXmlEntities(
    xml
      .replace(/<w:tab\b[^>]*\/>/g, "\t")
      .replace(/<w:br\b[^>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<\/w:tc>/g, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\n{3,}/g, "\n\n"),
  ).trim();
}

function sniffKind(bytes: Buffer, fileName: string) {
  if (bytes.subarray(0, 5).equals(PDF_MAGIC)) return "pdf" as const;
  if (bytes.subarray(0, 8).equals(DOC_MAGIC)) return "doc" as const;
  if (bytes.subarray(0, 4).equals(DOCX_MAGIC)) return "docx" as const;
  const extension = path.extname(fileName).slice(1).toLowerCase();
  if (extension === "pdf" || extension === "docx" || extension === "doc") {
    throw new ApiError(422, "requisites_file_invalid", "Файл повреждён или не соответствует расширению. Загрузите PDF, Word или вставьте текст.");
  }
  throw new ApiError(422, "requisites_file_type", "Загрузите PDF или Word (.docx, .doc), либо вставьте текст реквизитов");
}

async function extractFromFile(fileName: string, fileBase64: string) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(fileBase64)) {
    throw new ApiError(422, "requisites_file_invalid", "Не удалось прочитать файл. Выберите PDF или Word ещё раз.");
  }
  const bytes = Buffer.from(fileBase64, "base64");
  if (bytes.length > 20 * 1024 * 1024 || bytes.length < 8) {
    throw new ApiError(422, "requisites_file_invalid", "Нужен непустой файл PDF или Word размером до 20 МБ");
  }
  const kind = sniffKind(bytes, fileName);
  if (kind === "pdf") {
    const pages = await extractPdfPages(bytes);
    if (!pages.some((page) => page.text.trim())) {
      throw new ApiError(422, "pdf_no_text", "На страницах не удалось распознать текст. Загрузите более чёткий скан или вставьте реквизиты текстом.");
    }
    return { text: pages.map((page) => page.text).join("\n"), pages, ocr: pages.some((page) => page.ocr) };
  }
  if (kind === "docx") {
    const text = await docxToText(bytes);
    if (scoreCompanyRequisites(recognizeCompanyRequisites(text).draft) >= 6) {
      return { text, pages: undefined as PdfPageText[] | undefined, ocr: false };
    }
    try {
      const pdfBytes = await wordToPdf(bytes, "docx");
      const pages = await extractPdfPages(pdfBytes);
      return {
        text: pages.map((page) => page.text).join("\n") || text,
        pages,
        ocr: pages.some((page) => page.ocr),
      };
    } catch (error) {
      if (text.trim()) return { text, pages: undefined, ocr: false };
      throw error;
    }
  }
  const pdfBytes = await wordToPdf(bytes, "doc");
  const pages = await extractPdfPages(pdfBytes);
  if (!pages.some((page) => page.text.trim())) {
    throw new ApiError(422, "pdf_no_text", "Не удалось прочитать Word. Сохраните файл как PDF или вставьте реквизиты текстом.");
  }
  return { text: pages.map((page) => page.text).join("\n"), pages, ocr: pages.some((page) => page.ocr) };
}

export async function parseCompanyRequisitesUpload(
  prisma: PrismaClient,
  auth: AuthContext,
  raw: ParseCompanyRequisitesInput | unknown,
) {
  const membership = requireTenant(auth);
  const input = parseCompanyRequisitesSchema.parse(raw);
  let text = input.text?.trim() || "";
  let pages: PdfPageText[] | undefined;
  let ocr = false;
  if (input.fileBase64 && input.fileName) {
    const release = beginDocumentExtraction();
    try {
      const extracted = await extractFromFile(input.fileName, input.fileBase64);
      text = extracted.text;
      pages = extracted.pages;
      ocr = extracted.ocr;
    } finally {
      release();
    }
  }
  if (!text.trim()) {
    throw new ApiError(422, "requisites_empty", "Вставьте текст реквизитов или загрузите PDF / Word");
  }
  const legal = await prisma.tenantLegalProfile.findUnique({ where: { tenantId: membership.tenantId } });
  const recognized = recognizeCompanyRequisites(text, {
    tenantBin: legal?.bin || legal?.iin || null,
    ocr,
    pages,
  });
  if (scoreCompanyRequisites(recognized.draft) < 3) {
    throw new ApiError(
      422,
      "requisites_unrecognized",
      "Не удалось распознать реквизиты. Вставьте текст или загрузите более читаемый файл.",
    );
  }
  return recognized;
}
