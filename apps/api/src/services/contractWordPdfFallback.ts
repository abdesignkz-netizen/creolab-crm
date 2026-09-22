import JSZip from "jszip";
import PDFDocument from "pdfkit";
import { collectPdf, resolveFont } from "./contractPdf.ts";

function text(xml: string) {
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/>|(<\/w:p>)/g)]
    .map((match) => match[3] ? "\n" : match[2] ? (match[2] === "tab" ? "   " : "\n") : match[1])
    .join("").replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** Emergency renderer for ordinary text/table contracts. Never substitute current CRM data
 * for the saved document or silently omit images, fields, revisions or embedded content. */
export async function renderSimpleWordPdf(bytes: Buffer): Promise<Buffer | null> {
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes); } catch { return null; }
  if (Object.keys(zip.files).some((name) => /^word\/(media|embeddings)\/|^word\/(header|footer|footnotes|endnotes|comments)/.test(name))) return null;
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml || /<w:(drawing|pict|object|altChunk|fldChar|fldSimple|instrText|del|ins|sdt|txbxContent|sym|vMerge|hMerge)\b|<m:oMath\b|<mc:AlternateContent\b/.test(xml)) return null;
  const body = xml.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/)?.[1];
  if (!body) return null;
  const blocks = [...body.matchAll(/<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g)].map(([block]) => {
    if (block.startsWith("<w:tbl")) return [...block.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)]
      .map(([row]) => [...row.matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map(([cell]) => ({
        text: text(cell).trim(), colSpan: Math.max(1, Math.min(20, Number(cell.match(/<w:gridSpan\b[^>]*w:val="(\d+)"/)?.[1] || 1))),
      })));
    return text(block).trimEnd();
  });
  // Reject structures the simple renderer cannot account for.
  const normalize = (value: string) => value.replace(/\s/g, "");
  const content = blocks.map((block) => typeof block === "string" ? block : block.flat().map((cell) => cell.text).join("")).join("");
  if (!content.trim() || normalize(content) !== normalize(text(body))) return null;
  const doc = new PDFDocument({ size: "A4", margin: 50, info: { CreationDate: new Date(0), ModDate: new Date(0), Creator: "BasQar" } });
  const done = collectPdf(doc);
  doc.font(resolveFont("NotoSans-Regular.ttf")).fontSize(10);
  for (const block of blocks) {
    if (typeof block !== "string") {
      doc.table({ data: block, defaultStyle: { padding: 6, border: 0.5, borderColor: "#aaaaaa" } });
      doc.moveDown(0.5);
    } else if (block.trim()) doc.text(block, { paragraphGap: 6 });
    else doc.moveDown(0.3);
  }
  doc.end();
  return done;
}
