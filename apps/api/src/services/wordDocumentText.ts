import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";
import { ApiError } from "../errors.ts";
import { wordToPdf } from "./wordDocumentConversion.ts";
import { extractPdfPages } from "./pdfTextExtraction.ts";

const run = promisify(execFile);
export const DOCX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
export const DOC_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

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

export function sniffWordKind(bytes: Buffer, fileName: string) {
  if (bytes.subarray(0, 8).equals(DOC_MAGIC)) return "doc" as const;
  if (bytes.subarray(0, 4).equals(DOCX_MAGIC)) return "docx" as const;
  const extension = path.extname(fileName).slice(1).toLowerCase();
  if (extension === "docx" || extension === "doc") {
    throw new ApiError(422, "word_invalid", "Файл повреждён или не соответствует расширению. Загрузите .docx или .doc");
  }
  throw new ApiError(422, "word_file_type", "Загрузите шаблон договора в Word (.docx или .doc)");
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
  return cleanWordExtractedText(
    decodeXmlEntities(
      xml
        .replace(/<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/g, "")
        .replace(/<w:tab\b[^>]*\/>/g, "\t")
        .replace(/<w:br\b[^>]*\/>/g, "\n")
        .replace(/<\/w:p>/g, "\n")
        .replace(/<\/w:tc>/g, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/\n{3,}/g, "\n\n"),
    ),
  );
}

function looksLikeContractText(text: string) {
  const compact = text.replace(/\s+/g, " ");
  return compact.length >= 200 && /договор/i.test(compact) && /исполнител|заказчик|сторон/i.test(compact);
}

const WORD_CHROME_LINE =
  /^(?:текст примечания|тема примечания|сетка таблицы|без интервала|основной текст(?:\s+\d+)?|абзац списка|рецензия|гиперссылка|обычный(?:\s+\d+)?|заголовок\s*\d*|название|подзаголовок|(?:верхний|нижний) колонтитул|сноска|концевая сноска|оглавление\s*\d*|table grid|no spacing|list paragraph|comment (?:text|subject)|balloon text|normal|heading \d*|title|subtitle|emphasis|strong|quote)(?:\s+знак)?$/i;

export function cleanWordExtractedText(raw: string) {
  const lines = String(raw || "")
    .replace(/\u0000/g, "\n")
    .split(/\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => {
      if (!line) return false;
      if (WORD_CHROME_LINE.test(line)) return false;
      if (/^[@&%#<>\\/|*+=~^]+$/.test(line)) return false;
      if (line.length <= 2 && !/[0-9А-Яа-яЁёA-Za-z]{2}/.test(line)) return false;
      const letters = (line.match(/[А-Яа-яЁёA-Za-z]/g) || []).length;
      if (line.length >= 4 && letters / line.length < 0.2 && !/\d/.test(line)) return false;
      return true;
    });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function fromCharCodes(codes: number[]) {
  const parts: string[] = [];
  for (let i = 0; i < codes.length; i += 8000) {
    parts.push(String.fromCharCode(...codes.slice(i, i + 8000)));
  }
  return parts.join("");
}

function oleCharOk(c: number) {
  return (
    (c >= 32 && c <= 126) ||
    (c >= 0x0400 && c <= 0x052f) ||
    c === 9 ||
    c === 0x00a0 ||
    c === 0x00ab ||
    c === 0x00bb ||
    c === 0x2013 ||
    c === 0x2014 ||
    c === 0x201c ||
    c === 0x201d ||
    c === 0x2026 ||
    c === 0x2116
  );
}

function isUsefulOleRun(text: string) {
  const cleaned = cleanWordExtractedText(text);
  const letters = (cleaned.match(/[А-Яа-яЁё]{3,}/g) || []).join("").length;
  if (letters < 12) return false;
  const lines = cleaned.split(/\n/).filter(Boolean);
  const short = lines.filter((line) => line.length <= 2).length;
  return !(lines.length >= 8 && short / lines.length > 0.5);
}

/** Read UTF-16LE runs from an OLE .doc when LibreOffice is not available. */
export function extractDocUnicodeText(bytes: Buffer) {
  const runs: string[] = [];
  let i = 0;
  while (i + 1 < bytes.length) {
    const code = bytes[i] + bytes[i + 1] * 256;
    if (code < 0x0400 || code > 0x04ff) {
      i += 1;
      continue;
    }
    const chars: number[] = [];
    let j = i;
    while (j + 1 < bytes.length) {
      const c = bytes[j] + bytes[j + 1] * 256;
      if (c === 0) break;
      if (c === 0x0d || c === 0x07 || c === 0x0b || c === 0x0c || c === 0x0a) {
        chars.push(10);
        j += 2;
        continue;
      }
      if (!oleCharOk(c)) break;
      chars.push(c);
      j += 2;
    }
    const text = fromCharCodes(chars)
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (isUsefulOleRun(text)) runs.push(cleanWordExtractedText(text));
    i = Math.max(j, i + 2);
  }
  const unique = [...new Set(runs.filter(Boolean))];
  const contractRun = [...unique].sort((a, b) => b.length - a.length).find(looksLikeContractText);
  return (contractRun || unique.join("\n\n")).replace(/\n{3,}/g, "\n\n").trim();
}

async function sofficeToText(bytes: Buffer, extension: "doc" | "docx") {
  const dir = await mkdtemp(path.join(tmpdir(), "crm-word-txt-"));
  try {
    const profile = path.join(dir, "profile");
    await mkdir(path.join(profile, "user"), { recursive: true });
    await writeFile(
      path.join(profile, "user", "registrymodifications.xcu"),
      `<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>`,
    );
    const input = path.join(dir, `contract.${extension}`);
    await writeFile(input, bytes);
    await run(
      process.env.CRM_SOFFICE_PATH || "soffice",
      [
        `-env:UserInstallation=${pathToFileURL(profile).href}`,
        "--headless",
        "--nologo",
        "--nodefault",
        "--norestore",
        "--convert-to",
        "txt:Text",
        "--outdir",
        dir,
        input,
      ],
      { timeout: 60_000, maxBuffer: 2_000_000 },
    );
    return (await readFile(path.join(dir, "contract.txt"), "utf8")).trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function textutilConvert(bytes: Buffer, fromExt: "doc" | "docx", toExt: "docx" | "pdf") {
  if (process.platform !== "darwin") return null;
  const dir = await mkdtemp(path.join(tmpdir(), "crm-textutil-"));
  try {
    const input = path.join(dir, `contract.${fromExt}`);
    await writeFile(input, bytes);
    await run("textutil", ["-convert", toExt, input], { timeout: 30_000, maxBuffer: 8_000_000 });
    const output = path.join(dir, `contract.${toExt}`);
    const converted = await readFile(output);
    if (toExt === "pdf" && !converted.subarray(0, 5).equals(Buffer.from("%PDF-"))) return null;
    if (toExt === "docx" && !converted.subarray(0, 4).equals(DOCX_MAGIC)) return null;
    return converted;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function textutilToText(bytes: Buffer, extension: "doc" | "docx") {
  if (process.platform !== "darwin") return "";
  const dir = await mkdtemp(path.join(tmpdir(), "crm-textutil-"));
  try {
    const input = path.join(dir, `contract.${extension}`);
    await writeFile(input, bytes);
    const { stdout } = await run("textutil", ["-convert", "txt", "-stdout", input], {
      timeout: 30_000,
      maxBuffer: 2_000_000,
    });
    return String(stdout || "").trim();
  } catch {
    return "";
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function pdfFallbackText(bytes: Buffer, extension: "doc" | "docx") {
  const pdf = await wordToPdf(bytes, extension);
  const pages = await extractPdfPages(pdf);
  return pages.map((page) => page.text).join("\n").trim();
}

export async function wordFileToText(bytes: Buffer, fileName: string) {
  if (bytes.length > 20 * 1024 * 1024 || bytes.length < 8) {
    throw new ApiError(422, "word_invalid", "Нужен непустой файл Word размером до 20 МБ");
  }
  const kind = sniffWordKind(bytes, fileName);
  if (kind === "docx") {
    const xmlText = await docxToText(bytes);
    if (looksLikeContractText(xmlText) || xmlText.length >= 80) return xmlText;
  } else {
    const asDocx = await textutilConvert(bytes, "doc", "docx");
    if (asDocx) {
      try {
        const xmlText = await docxToText(asDocx);
        if (xmlText.length >= 80) return xmlText;
      } catch {
        /* read .doc another way */
      }
    }
    const fromTextutil = await textutilToText(bytes, kind);
    if (fromTextutil.length >= 80 && /[А-Яа-яЁё]/.test(fromTextutil)) {
      return cleanWordExtractedText(fromTextutil);
    }
    const ole = extractDocUnicodeText(bytes);
    if (looksLikeContractText(ole) || ole.length >= 80) return ole;
  }
  try {
    const converted = await sofficeToText(bytes, kind);
    if (converted) return cleanWordExtractedText(converted);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      try {
        const fromPdf = await pdfFallbackText(bytes, kind);
        if (fromPdf) return fromPdf;
      } catch {
        /* try textutil / OLE next */
      }
    }
  }
  const fromTextutil = await textutilToText(bytes, kind);
  if (fromTextutil) return cleanWordExtractedText(fromTextutil);
  if (kind === "docx") {
    const xmlText = await docxToText(bytes);
    if (xmlText) return xmlText;
  } else {
    const ole = extractDocUnicodeText(bytes);
    if (ole.length >= 80) return ole;
  }
  throw new ApiError(
    422,
    "word_conversion_unavailable",
    "Не удалось прочитать Word. Сохраните файл как .docx и загрузите снова.",
  );
}
