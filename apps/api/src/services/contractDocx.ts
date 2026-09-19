import JSZip from "jszip";
import {
  applyPlaceholders,
  buildContractPlaceholders,
  contractItemTableRows,
  type ContractPdfInput,
} from "./contractPdf.ts";
import {
  ensureModernWordPackage,
  fillDocxPlaceholders,
  wordItemsTableXml,
} from "./docxTemplateFill.ts";

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOCX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const W_MAIN = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

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

function bodyParagraphs(text: string, itemRows: string[][]) {
  const chunks = text.replace(/\n{3,}/g, "\n\n").trim().split(/\{\{\s*items_table\s*\}\}/i);
  const rPr = `<w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>`;
  const asParagraphs = (block: string) =>
    block.split("\n").map((line) => {
      const heading = /^[А-ЯЁA-Z0-9 .«»№-]{8,}$/.test(line.trim()) && /[А-ЯЁA-Z]/.test(line);
      const pPr = heading
        ? `<w:pPr><w:spacing w:before="200" w:after="120"/><w:jc w:val="center"/><w:rPr><w:b/></w:rPr></w:pPr>`
        : `<w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr>`;
      const runPr = heading ? `<w:rPr><w:b/><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>` : rPr;
      return `<w:p>${pPr}<w:r>${runPr}<w:t xml:space="preserve">${encodeXml(line)}</w:t></w:r></w:p>`;
    }).join("");
  return chunks
    .map((chunk, index) => {
      const xml = asParagraphs(chunk);
      if (index < chunks.length - 1) return `${xml}${wordItemsTableXml(itemRows)}`;
      return xml;
    })
    .join("");
}

export async function buildPlainDocx(text: string, itemRows: string[][] = []) {
  const zip = new JSZip();
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
  );
  zip.file(
    "docProps/core.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Договор</dc:title><dc:creator>BasQar</dc:creator><cp:lastModifiedBy>BasQar</cp:lastModifiedBy></cp:coreProperties>`,
  );
  zip.file(
    "docProps/app.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>BasQar</Application></Properties>`,
  );
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
  );
  const paragraphs = bodyParagraphs(text || " ", itemRows);
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W_MAIN}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/><w:docGrid w:linePitch="360"/></w:sectPr></w:body></w:document>`,
  );
  await ensureModernWordPackage(zip);
  return Buffer.from(
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }),
  );
}

export async function renderContractDocx(input: ContractPdfInput, sourceDocx?: Buffer | null) {
  const values = buildContractPlaceholders(input);
  const itemRows = contractItemTableRows(input);
  if (sourceDocx && isDocxBytes(sourceDocx)) {
    return fillDocxPlaceholders(sourceDocx, values, itemRows, {
      items: input.items,
      completionTerms: input.completionTerms,
      totalAmount: input.totalAmount,
    });
  }
  const body = applyPlaceholders(input.templateBody || "", { ...values, items_table: "{{items_table}}" })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return buildPlainDocx(body, itemRows);
}
