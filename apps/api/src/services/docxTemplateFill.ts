import JSZip from "jszip";

function decodeXml(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function encodeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function applyPlaceholders(text: string, values: Record<string, string>) {
  return text.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, key: string) => values[key] ?? "");
}

function rewriteParagraph(paragraph: string, transform: (text: string) => string) {
  const nodes = [...paragraph.matchAll(/<w:t\b([^>]*)>([\s\S]*?)<\/w:t>/g)];
  if (!nodes.length) return paragraph;
  const joined = nodes.map((node) => decodeXml(node[2])).join("");
  const next = transform(joined);
  if (next === joined) return paragraph;
  let index = 0;
  return paragraph.replace(/<w:t\b([^>]*)>([\s\S]*?)<\/w:t>/g, (_, attrs: string) => {
    index += 1;
    if (index === 1) {
      const withSpace = /xml:space=/.test(attrs) ? attrs : `${attrs} xml:space="preserve"`;
      const xml = next
        .split("\n")
        .map((line) => encodeXml(line))
        .join('</w:t><w:br/><w:t xml:space="preserve">');
      return `<w:t${withSpace}>${xml}</w:t>`;
    }
    return `<w:t${attrs}></w:t>`;
  });
}

async function mapDocxXml(bytes: Buffer, transform: (text: string) => string) {
  const zip = await JSZip.loadAsync(bytes);
  const paths = Object.keys(zip.files).filter((name) => /^word\/(document|header\d*|footer\d*)\.xml$/i.test(name));
  for (const filePath of paths) {
    const xml = await zip.file(filePath)?.async("string");
    if (!xml) continue;
    zip.file(filePath, xml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (paragraph) => rewriteParagraph(paragraph, transform)));
  }
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

export async function rewriteDocxText(bytes: Buffer, transform: (text: string) => string) {
  return mapDocxXml(bytes, transform);
}

export async function fillDocxPlaceholders(bytes: Buffer, values: Record<string, string>) {
  return mapDocxXml(bytes, (text) => applyPlaceholders(text, values));
}

function paragraphPlainText(paragraph: string) {
  return [...paragraph.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((node) => decodeXml(node[1])).join("");
}

export async function ensureDocxItemsPlaceholder(bytes: Buffer) {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml || /\{\{\s*items_table\s*\}\}/i.test(paragraphPlainText(xml))) return bytes;
  let inserted = false;
  const next = xml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (paragraph) => {
    if (inserted) return paragraph;
    if (!/РЕКВИЗИТЫ/i.test(paragraphPlainText(paragraph))) return paragraph;
    inserted = true;
    return `<w:p><w:r><w:t xml:space="preserve">{{items_table}}</w:t></w:r></w:p>${paragraph}`;
  });
  if (!inserted) {
    zip.file(
      "word/document.xml",
      xml.replace(/<w:sectPr\b/, `<w:p><w:r><w:t xml:space="preserve">{{items_table}}</w:t></w:r></w:p><w:sectPr`),
    );
  } else {
    zip.file("word/document.xml", next);
  }
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}
