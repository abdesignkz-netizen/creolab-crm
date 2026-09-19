import JSZip from "jszip";
import {
  applyPlaceholders,
  buildContractPlaceholders,
  type ContractPdfInput,
} from "./contractPdf.ts";
import { fillDocxPlaceholders } from "./docxTemplateFill.ts";

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOCX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export function isDocxBytes(bytes: Buffer) {
  return bytes.length >= 4 && bytes.subarray(0, 4).equals(DOCX_MAGIC);
}

function encodeXml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function isWordAttachment(attachment: { mimeType?: string | null; fileName?: string | null; originalFileName?: string | null }) {
  return /wordprocessingml|msword|\.docx?$/i.test(
    `${attachment.mimeType || ""} ${attachment.fileName || ""} ${attachment.originalFileName || ""}`,
  );
}

export function contractFileDownload(number: string, attachment: { mimeType?: string | null; fileName?: string | null; originalFileName?: string | null }) {
  const word = isWordAttachment(attachment);
  const ext = word ? (/\.doc$/i.test(attachment.fileName || "") ? "doc" : "docx") : "pdf";
  const downloadName = `${number}.${ext}`;
  return {
    contentType: attachment.mimeType || (word ? DOCX_MIME : "application/pdf"),
    disposition: `${word ? "attachment" : "inline"}; filename="${encodeURIComponent(downloadName)}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
  };
}

export async function buildPlainDocx(text: string) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  const paragraphs = (text.replace(/\n{3,}/g, "\n\n").trim() || " ")
    .split("\n")
    .map((line) => {
      const run = `<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr><w:t xml:space="preserve">${encodeXml(line)}</w:t></w:r>`;
      return `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr>${run}</w:p>`;
    })
    .join("");
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`,
  );
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

export async function renderContractDocx(input: ContractPdfInput, sourceDocx?: Buffer | null) {
  const values = buildContractPlaceholders(input);
  if (sourceDocx && isDocxBytes(sourceDocx)) {
    return fillDocxPlaceholders(sourceDocx, values);
  }
  const body = applyPlaceholders(input.templateBody || "", values).replace(/\n{3,}/g, "\n\n").trim();
  return buildPlainDocx(body);
}
