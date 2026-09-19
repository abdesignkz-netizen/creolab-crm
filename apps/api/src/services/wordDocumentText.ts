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

function looksLikeContractText(text: string) {
  const compact = text.replace(/\s+/g, " ");
  return compact.length >= 200 && /договор/i.test(compact) && /исполнител|заказчик|сторон/i.test(compact);
}

function fromCharCodes(codes: number[]) {
  const parts: string[] = [];
  for (let i = 0; i < codes.length; i += 8000) {
    parts.push(String.fromCharCode(...codes.slice(i, i + 8000)));
  }
  return parts.join("");
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
      if (c === 0 || c === 0x0d || c === 0x07 || c === 0x0b || c === 0x0c) {
        chars.push(10);
        j += 2;
        continue;
      }
      if (c === 0x0a) {
        chars.push(10);
        j += 2;
        continue;
      }
      if (c === 9) {
        chars.push(9);
        j += 2;
        continue;
      }
      const ok =
        (c >= 32 && c <= 126) ||
        (c >= 160 && c <= 255) ||
        (c >= 0x0400 && c <= 0x052f) ||
        c === 0x2116 ||
        c === 0x2013 ||
        c === 0x2014 ||
        c === 0x00ab ||
        c === 0x00bb ||
        c === 0x201c ||
        c === 0x201d ||
        c === 0x2026 ||
        c === 0x00a0;
      if (!ok) break;
      chars.push(c);
      j += 2;
    }
    const text = fromCharCodes(chars)
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (text.length >= 8 && /[А-Яа-яЁё]/.test(text)) runs.push(text);
    i = Math.max(j, i + 2);
  }
  return runs.join("\n").replace(/\n{3,}/g, "\n\n").trim();
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
    const fromTextutil = await textutilToText(bytes, kind);
    if (looksLikeContractText(fromTextutil)) return fromTextutil;
    const ole = extractDocUnicodeText(bytes);
    if (looksLikeContractText(ole)) return ole;
  }
  try {
    const converted = await sofficeToText(bytes, kind);
    if (converted) return converted;
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
  if (fromTextutil) return fromTextutil;
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
