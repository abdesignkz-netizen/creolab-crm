import JSZip from "jszip";
import { fillContextualLeftovers, markPaymentAmountPlaceholders } from "./contractTemplateScan.ts";

const W_MAIN = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const PKG_RELS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFF_RELS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";

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

function sanitizeXmlText(value: string) {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function encodeXml(value: string) {
  return sanitizeXmlText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function applyPlaceholders(text: string, values: Record<string, string>) {
  return text.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, key: string) => values[key] ?? "");
}

function fillKnownFields(text: string, values: Record<string, string>, keepItemsPlaceholder = true) {
  let next = markPaymentAmountPlaceholders(text);
  next = applyPlaceholders(next, values);
  if (!keepItemsPlaceholder) next = next.replace(/\{\{\s*items_table\s*\}\}/gi, "");
  return fillContextualLeftovers(next, values);
}

function stripStaleLayoutHints(xml: string) {
  return xml
    .replace(/<w:proofErr\b[^>]*\/>/g, "")
    .replace(/<w:lastRenderedPageBreak\b[^>]*\/>/g, "")
    .replace(/<w:lastRenderedPageBreak\b[^>]*>\s*<\/w:lastRenderedPageBreak>/g, "")
    .replace(/<w:bookmarkStart\b[^>]*\/>/g, "")
    .replace(/<w:bookmarkEnd\b[^>]*\/>/g, "")
    .replace(/<w:commentRangeStart\b[^>]*\/>/g, "")
    .replace(/<w:commentRangeEnd\b[^>]*\/>/g, "")
    .replace(/<w:del\b[\s\S]*?<\/w:del>/g, "")
    .replace(/<\/?w:ins\b[^>]*>/g, "");
}

function fixIndents(xml: string) {
  return xml.replace(/<w:ind\b[^>]*\/?>/g, (tag) => {
    let next = tag.replace(/w:(left|start)="-?\d+"/g, (attr) => {
      const n = Number(attr.match(/-?\d+/)?.[0] || 0);
      return attr.replace(/-?\d+/, String(Math.max(0, n)));
    });
    const left = Number(next.match(/w:(?:left|start)="(\d+)"/)?.[1] || 0);
    const hanging = Number(next.match(/w:hanging="(\d+)"/)?.[1] || 0);
    if (hanging > left) next = next.replace(/w:hanging="\d+"/, `w:hanging="${left}"`);
    return next;
  });
}

function runPlain(run: string) {
  return [...run.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((node) => decodeXml(node[1])).join("");
}

function isTextOnlyRun(run: string) {
  if (
    /<w:(drawing|object|pict|oleObject|fldChar|instrText|footnoteReference|endnoteReference|commentReference|tab|br|cr|sym|separator|continuationSeparator|pgNum)\b/.test(
      run,
    )
  ) {
    return false;
  }
  return /<w:t\b/.test(run);
}

function mergeTextRuns(first: string, second: string) {
  const text = runPlain(first) + runPlain(second);
  const base = runPlain(first).length >= runPlain(second).length ? first : second;
  const rPr =
    base.match(/<w:rPr\b[\s\S]*?<\/w:rPr>/)?.[0] || first.match(/<w:rPr\b[\s\S]*?<\/w:rPr>/)?.[0] || "";
  return `<w:r>${rPr}<w:t xml:space="preserve">${encodeXml(text)}</w:t></w:r>`;
}

function coalesceAdjacentTextRuns(xml: string): string {
  const parts = xml.split(/(<w:r\b[\s\S]*?<\/w:r>)/);
  const out: string[] = [];
  let pending: string | null = null;
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("<w:r") && isTextOnlyRun(part)) {
      pending = pending ? mergeTextRuns(pending, part) : part;
      continue;
    }
    if (pending) {
      out.push(pending);
      pending = null;
    }
    out.push(part);
  }
  if (pending) out.push(pending);
  return out.join("");
}

function paragraphPlainWithBreaks(paragraph: string) {
  return coalesceAdjacentTextRuns(paragraph)
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:br\b[^>]*\/>/g, "\n")
    .replace(/<w:cr\b[^>]*\/>/g, "\n")
    .replace(/<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/g, "")
    .replace(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g, (_, text: string) => decodeXml(text))
    .replace(/<[^>]+>/g, "");
}

function dominantRpr(paragraph: string) {
  let best = "";
  let bestLen = -1;
  for (const match of paragraph.matchAll(/<w:r\b[\s\S]*?<\/w:r>/g)) {
    if (!isTextOnlyRun(match[0])) continue;
    const len = runPlain(match[0]).length;
    if (len > bestLen) {
      bestLen = len;
      best = match[0].match(/<w:rPr\b[\s\S]*?<\/w:rPr>/)?.[0] || "";
    }
  }
  return best;
}

function drawingRuns(paragraph: string) {
  return [...paragraph.matchAll(/<w:r\b[\s\S]*?<\/w:r>/g)]
    .map((match) => match[0])
    .filter((run) => /<w:(drawing|object|pict|oleObject)\b/.test(run));
}

function runsFromLine(line: string, rPr: string) {
  return line.split("\t").map((part, index) => {
    const textRun = `<w:r>${rPr}<w:t xml:space="preserve">${encodeXml(part)}</w:t></w:r>`;
    return index === 0 ? textRun : `<w:r>${rPr}<w:tab/></w:r>${textRun}`;
  }).join("");
}

function rebuildParagraphs(original: string, text: string) {
  const open = original.match(/^<w:p\b[^>]*>/)?.[0] || "<w:p>";
  const pPr = original.match(/<w:pPr\b[\s\S]*?<\/w:pPr>/)?.[0] || "";
  const rPr = dominantRpr(original);
  const drawings = drawingRuns(original);
  const lines = text.split("\n");
  return lines
    .map((line, index) => {
      const extra = index === 0 ? drawings.join("") : "";
      return `${open}${pPr}${runsFromLine(line, rPr)}${extra}</w:p>`;
    })
    .join("");
}

function cellXml(text: string, width: number, bold = false) {
  const rPr = bold
    ? `<w:rPr><w:b/><w:sz w:val="20"/><w:szCs w:val="20"/><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/></w:rPr>`
    : `<w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/></w:rPr>`;
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/><w:tcMar><w:top w:w="40" w:type="dxa"/><w:left w:w="60" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="60" w:type="dxa"/></w:tcMar></w:tcPr><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r>${rPr}<w:t xml:space="preserve">${encodeXml(text)}</w:t></w:r></w:p></w:tc>`;
}

const ITEM_COL_WIDTHS = [700, 4320, 900, 800, 1450, 1468];
const PRICE_COL_WIDTHS = [900, 6800, 2200];
const ASSIGNMENT_COL_WIDTHS = [700, 4800, 2100, 2100];

function looksLikeMoney(text: string) {
  return /(?:\d{1,3}(?:\s\d{3})+|\d{4,7})\s*(?:тенге|₸)?/i.test(text) || /тенге|₸/.test(text);
}

function tableCellTexts(tbl: string) {
  return [...tbl.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((row) =>
    [...row[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((cell) =>
      paragraphPlainWithBreaks(cell[0]).replace(/\s+/g, " ").trim(),
    ),
  );
}

export function classifyServiceTable(rows: string[][]) {
  if (!rows.length) return null;
  const blob = rows.flat().join(" \n ").toLowerCase();
  if (/м\.п\.|основании устава/.test(blob) && !/стоимость|прайс|вид услуг/.test(blob)) return null;
  const moneyRows = rows.filter((row) => looksLikeMoney(row[row.length - 1] || "") || row.some(looksLikeMoney)).length;
  if (!moneyRows) return null;
  const header = (rows[0] || []).join(" ").toLowerCase();
  const cols = Math.max(...rows.map((row) => row.length), 0);
  if (/срок|вид услуг/.test(header) || (cols >= 4 && /стоимость|тенге/.test(blob))) return "assignment";
  if (cols >= 2 && cols <= 3) return "price";
  if (/услуг|слайд|презентац|разработк|прайс/.test(blob)) return cols >= 4 ? "assignment" : "price";
  return null;
}

function wordSimpleTableXml(
  rows: string[][],
  widths: number[],
  headerRow = false,
  spanLast = false,
) {
  const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`;
  const grid = widths.map((width) => `<w:gridCol w:w="${width}"/>`).join("");
  const totalWidth = widths.reduce((sum, width) => sum + width, 0);
  const body = rows
    .map((row, rowIndex) => {
      if (spanLast && rowIndex === rows.length - 1 && row.length === 1) {
        const rPr = `<w:rPr><w:b/><w:sz w:val="20"/><w:szCs w:val="20"/><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/></w:rPr>`;
        return `<w:tr><w:tc><w:tcPr><w:tcW w:w="${totalWidth}" w:type="dxa"/><w:gridSpan w:val="${widths.length}"/></w:tcPr><w:p><w:pPr><w:jc w:val="right"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r>${rPr}<w:t xml:space="preserve">${encodeXml(row[0])}</w:t></w:r></w:p></w:tc></w:tr>`;
      }
      const cells = widths.map((width, index) => cellXml(row[index] || "", width, headerRow && rowIndex === 0)).join("");
      return `<w:tr>${cells}</w:tr>`;
    })
    .join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="${totalWidth}" w:type="dxa"/><w:tblBorders>${border("top")}${border("left")}${border("bottom")}${border("right")}${border("insideH")}${border("insideV")}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblLook w:val="04A0"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>`;
}

type ServiceItem = { name: string; amountWithoutVat?: number; totalAmount: number };

function formatItemAmount(item: ServiceItem) {
  const amount = item.amountWithoutVat ?? item.totalAmount;
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.round(Number(amount) || 0));
}

export function replaceServiceTables(
  xml: string,
  items: ServiceItem[],
  completionTerms: string,
  totalAmount: number,
) {
  if (!items.length) return xml;
  const total = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.round(Number(totalAmount) || 0));
  return xml.replace(/<w:tbl\b[\s\S]*?<\/w:tbl>/g, (tbl) => {
    const rows = tableCellTexts(tbl);
    const kind = classifyServiceTable(rows);
    if (!kind) return tbl;
    if (kind === "assignment") {
      return wordSimpleTableXml(
        [
          ["№", "Вид Услуг, требования к результату", "Сроки выполнения", "Стоимость в тенге"],
          ...items.map((item, index) => [String(index + 1), item.name, completionTerms, formatItemAmount(item)]),
          [`Итого: ${total}`],
        ],
        ASSIGNMENT_COL_WIDTHS,
        true,
        true,
      );
    }
    return wordSimpleTableXml(
      items.map((item, index) => [String(index + 1), item.name, `${formatItemAmount(item)} тенге`]),
      PRICE_COL_WIDTHS,
    );
  });
}

export function documentHasServiceTables(xml: string) {
  return [...xml.matchAll(/<w:tbl\b[\s\S]*?<\/w:tbl>/g)].some((match) => classifyServiceTable(tableCellTexts(match[0])));
}

export function wordItemsTableXml(rows: string[][]) {
  if (!rows.length) return "";
  const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="666666"/>`;
  const grid = ITEM_COL_WIDTHS.map((width) => `<w:gridCol w:w="${width}"/>`).join("");
  const body = rows
    .map((row, rowIndex) => {
      const cells = ITEM_COL_WIDTHS.map((width, index) => cellXml(row[index] || "", width, rowIndex === 0)).join("");
      return `<w:tr>${cells}</w:tr>`;
    })
    .join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="${ITEM_COL_WIDTHS.reduce((a, b) => a + b, 0)}" w:type="dxa"/><w:tblBorders>${border("top")}${border("left")}${border("bottom")}${border("right")}${border("insideH")}${border("insideV")}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblLook w:val="04A0"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl><w:p><w:pPr><w:spacing w:after="200"/></w:pPr></w:p>`;
}

function tableFromPlaceholder(
  paragraph: string,
  joined: string,
  transform: (text: string) => string,
  itemsTableXml: string | undefined,
) {
  if (!itemsTableXml || !/\{\{\s*items_table\s*\}\}/i.test(joined)) return null;
  const [before = "", after = ""] = joined.split(/\{\{\s*items_table\s*\}\}/i);
  const beforeXml = before.trim() ? rebuildParagraphs(paragraph, transform(before.replace(/\s+$/, ""))) : "";
  const afterXml = after.trim() ? rebuildParagraphs(paragraph, transform(after.replace(/^\s+/, ""))) : "";
  return `${beforeXml}${itemsTableXml}${afterXml}`;
}

function rewriteParagraph(
  paragraph: string,
  transform: (text: string) => string,
  itemsTableXml?: string,
) {
  const cleaned = stripStaleLayoutHints(paragraph);
  const coalesced = coalesceAdjacentTextRuns(cleaned);
  const joined = paragraphPlainWithBreaks(coalesced);
  const asTable = tableFromPlaceholder(coalesced, joined, transform, itemsTableXml);
  if (asTable != null) return asTable;
  if (/<w:fldChar\b/.test(cleaned) && !/\{\{/.test(joined)) return cleaned;
  const next = transform(joined);
  if (next === joined) return cleaned;
  return rebuildParagraphs(coalesced, next);
}

function fillParagraph(
  paragraph: string,
  values: Record<string, string>,
  itemsTableXml?: string,
  keepItemsPlaceholder = true,
) {
  const transform = (text: string) => fillKnownFields(text, values, keepItemsPlaceholder);
  const cleaned = stripStaleLayoutHints(paragraph);
  const coalesced = coalesceAdjacentTextRuns(cleaned);
  const joined = paragraphPlainWithBreaks(coalesced);
  const asTable = tableFromPlaceholder(coalesced, joined, transform, itemsTableXml);
  if (asTable != null) return asTable;
  if (/<w:fldChar\b/.test(cleaned) && !/\{\{/.test(joined) && !/№\s*\d{6,}\//.test(joined)) return cleaned;
  const next = transform(joined);
  if (next === joined) return cleaned;
  return rebuildParagraphs(coalesced, next);
}

function mapParagraphs(
  xml: string,
  rewrite: (paragraph: string) => string,
) {
  return xml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, rewrite);
}

function upsertContentType(xml: string, partName: string, contentType: string) {
  if (xml.includes(`PartName="${partName}"`)) return xml;
  return xml.replace(
    /<\/Types>/,
    `<Override PartName="${partName}" ContentType="${contentType}"/></Types>`,
  );
}

function upsertDefault(xml: string, extension: string, contentType: string) {
  if (new RegExp(`Extension="${extension}"`, "i").test(xml)) return xml;
  return xml.replace(
    /<\/Types>/,
    `<Default Extension="${extension}" ContentType="${contentType}"/></Types>`,
  );
}

function upsertRel(xml: string, type: string, target: string) {
  if (xml.includes(`Target="${target}"`)) return xml;
  const ids = [...xml.matchAll(/\bId="rId(\d+)"/g)].map((match) => Number(match[1]));
  const nextId = `rId${Math.max(0, ...ids) + 1}`;
  if (!xml.includes("<Relationships")) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG_RELS}"><Relationship Id="${nextId}" Type="${type}" Target="${target}"/></Relationships>`;
  }
  return xml.replace(/<\/Relationships>/, `<Relationship Id="${nextId}" Type="${type}" Target="${target}"/></Relationships>`);
}

function modernSettingsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="${W_MAIN}"><w:zoom w:percent="100"/><w:defaultTabStop w:val="708"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/><w:compatSetting w:name="overrideTableStyleFontSizeAndJustification" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/><w:compatSetting w:name="enableOpenTypeFeatures" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/></w:compat></w:settings>`;
}

function modernStylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W_MAIN}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman" w:eastAsia="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="ru-RU" w:eastAsia="ru-RU" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style></w:styles>`;
}

function modernFontTableXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:fonts xmlns:w="${W_MAIN}"><w:font w:name="Times New Roman"><w:charset w:val="CC"/><w:family w:val="roman"/><w:pitch w:val="variable"/></w:font><w:font w:name="Calibri"><w:charset w:val="CC"/><w:family w:val="swiss"/><w:pitch w:val="variable"/></w:font></w:fonts>`;
}

function forceModernSettings(xml: string) {
  let next = xml;
  next = next.replace(/<w:documentProtection\b[^/]*\/>/g, "");
  next = next.replace(/<w:documentProtection\b[\s\S]*?<\/w:documentProtection>/g, "");
  next = next.replace(/<w:writeProtection\b[^/]*\/>/g, "");
  next = next.replace(/<w:writeProtection\b[\s\S]*?<\/w:writeProtection>/g, "");
  next = next.replace(/<w:shapeLayoutLikeWW8\b[^/]*\/>/g, "");
  next = next.replace(/<w:footnoteLayoutLikeWW8\b[^/]*\/>/g, "");
  next = next.replace(/<w:alignTablesRowByRow\b[^/]*\/>/g, "");
  next = next.replace(/<w:doNotWrapTextWithPunct\b[^/]*\/>/g, "");
  next = next.replace(/<w:useWord97LineBreakingRules\b[^/]*\/>/g, "");
  next = next.replace(/<w:compatSetting w:name="compatibilityMode"[^/]*\/>/g, "");
  if (!/<w:characterSpacingControl\b/.test(next)) {
    next = next.replace(/<w:settings\b[^>]*>/, (open) => `${open}<w:characterSpacingControl w:val="doNotCompress"/>`);
  } else {
    next = next.replace(
      /<w:characterSpacingControl\b[^/]*\/>/,
      `<w:characterSpacingControl w:val="doNotCompress"/>`,
    );
  }
  const mode =
    `<w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>`;
  if (/<w:compat>/.test(next)) next = next.replace(/<w:compat>/, `<w:compat>${mode}`);
  else next = next.replace(/<\/w:settings>/, `<w:compat>${mode}</w:compat></w:settings>`);
  return next;
}

function ensureSectPr(xml: string) {
  if (!/<w:sectPr\b/.test(xml)) {
    return xml.replace(
      /<\/w:body>/,
      `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body>`,
    );
  }
  return xml.replace(/<w:pgMar\b[^/]*\/>/g, (tag) => {
    const num = (name: string, fallback: number) => {
      const raw = Number(tag.match(new RegExp(`w:${name}="(-?\\d+)"`))?.[1]);
      if (!Number.isFinite(raw) || raw < 720) return fallback;
      return raw;
    };
    return `<w:pgMar w:top="${num("top", 1134)}" w:right="${num("right", 1134)}" w:bottom="${num("bottom", 1134)}" w:left="${num("left", 1134)}" w:header="${num("header", 708)}" w:footer="${num("footer", 708)}" w:gutter="0"/>`;
  });
}

export async function ensureModernWordPackage(zip: JSZip) {
  if (!zip.file("word/styles.xml")) zip.file("word/styles.xml", modernStylesXml());
  const settings = await zip.file("word/settings.xml")?.async("string");
  zip.file("word/settings.xml", settings ? forceModernSettings(settings) : modernSettingsXml());
  if (!zip.file("word/fontTable.xml")) zip.file("word/fontTable.xml", modernFontTableXml());
  const app = await zip.file("docProps/app.xml")?.async("string");
  if (app) {
    zip.file(
      "docProps/app.xml",
      app.replace(/<DocSecurity>\d+<\/DocSecurity>/i, "<DocSecurity>0</DocSecurity>"),
    );
  }
  const custom = await zip.file("docProps/custom.xml")?.async("string");
  if (custom && /_MarkAsFinal/i.test(custom)) {
    zip.file("docProps/custom.xml", custom.replace(/<vt:bool>\s*true\s*<\/vt:bool>/gi, "<vt:bool>false</vt:bool>"));
  }
  const core = await zip.file("docProps/core.xml")?.async("string");
  if (core) {
    zip.file("docProps/core.xml", core.replace(/<cp:contentStatus>[\s\S]*?<\/cp:contentStatus>/i, ""));
  }

  let types = (await zip.file("[Content_Types].xml")?.async("string")) ||
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${CT_NS}"></Types>`;
  types = upsertDefault(types, "rels", "application/vnd.openxmlformats-package.relationships+xml");
  types = upsertDefault(types, "xml", "application/xml");
  types = upsertContentType(
    types,
    "/word/document.xml",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  );
  types = upsertContentType(types, "/word/styles.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml");
  types = upsertContentType(
    types,
    "/word/settings.xml",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml",
  );
  types = upsertContentType(
    types,
    "/word/fontTable.xml",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml",
  );
  zip.file("[Content_Types].xml", types);

  let rels = (await zip.file("word/_rels/document.xml.rels")?.async("string")) ||
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG_RELS}"></Relationships>`;
  rels = upsertRel(rels, `${OFF_RELS}/styles`, "styles.xml");
  rels = upsertRel(rels, `${OFF_RELS}/settings`, "settings.xml");
  rels = upsertRel(rels, `${OFF_RELS}/fontTable`, "fontTable.xml");
  zip.file("word/_rels/document.xml.rels", rels);

  const document = await zip.file("word/document.xml")?.async("string");
  if (document) {
    zip.file("word/document.xml", ensureSectPr(fixIndents(stripStaleLayoutHints(document))));
  }
}

async function saveZip(zip: JSZip) {
  await ensureModernWordPackage(zip);
  return Buffer.from(
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }),
  );
}

async function mapDocxXml(
  bytes: Buffer,
  rewrite: (paragraph: string, filePath: string) => string,
  after?: (xml: string, filePath: string) => string,
) {
  const zip = await JSZip.loadAsync(bytes);
  const paths = Object.keys(zip.files).filter((name) => /^word\/(document|header\d*|footer\d*)\.xml$/i.test(name));
  for (const filePath of paths) {
    const xml = await zip.file(filePath)?.async("string");
    if (!xml) continue;
    let next = mapParagraphs(stripStaleLayoutHints(xml), (paragraph) => rewrite(paragraph, filePath));
    if (after) next = after(next, filePath);
    zip.file(filePath, next);
  }
  return saveZip(zip);
}

export async function rewriteDocxText(bytes: Buffer, transform: (text: string) => string) {
  return mapDocxXml(bytes, (paragraph) => rewriteParagraph(paragraph, transform));
}

export async function fillDocxPlaceholders(
  bytes: Buffer,
  values: Record<string, string>,
  itemRows: string[][] = [],
  extras: { items?: ServiceItem[]; completionTerms?: string; totalAmount?: number } = {},
) {
  const peek = await JSZip.loadAsync(bytes);
  const sourceXml = (await peek.file("word/document.xml")?.async("string")) || "";
  const hasServiceTables = documentHasServiceTables(sourceXml);
  const itemsTableXml = !hasServiceTables && itemRows.length ? wordItemsTableXml(itemRows) : "";
  return mapDocxXml(
    bytes,
    (paragraph, filePath) =>
      fillParagraph(
        paragraph,
        values,
        filePath.endsWith("document.xml") ? itemsTableXml : undefined,
        Boolean(itemsTableXml) || !hasServiceTables,
      ),
    (xml, filePath) =>
      filePath.endsWith("document.xml") && extras.items?.length && hasServiceTables
        ? replaceServiceTables(xml, extras.items, extras.completionTerms || "", extras.totalAmount || 0)
        : xml,
  );
}

function paragraphPlainText(paragraph: string) {
  return paragraphPlainWithBreaks(paragraph);
}

export async function ensureDocxItemsPlaceholder(bytes: Buffer) {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml || /\{\{\s*items_table\s*\}\}/i.test(paragraphPlainText(xml))) return bytes;
  if (documentHasServiceTables(xml)) return bytes;
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
  return saveZip(zip);
}

export const docxXml = { encodeXml, decodeXml, paragraphPlainWithBreaks };
