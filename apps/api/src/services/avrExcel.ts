import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@creolab/db";
import {
  amountToKztWords,
  esfMeasureUnitSymbol,
  resolveEsfMeasureUnitCode,
} from "@creolab/contracts";
import ExcelJS from "exceljs";
import type { Response } from "express";
import JSZip from "jszip";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { requireDocumentsAccess } from "../lib/access.ts";
import { AVR_SOURCE_KIND, expandLegalFormName, mapAvrSource, type AvrSourceSnapshot } from "./avrMapper.ts";
import { serializeDealItem } from "./dealItemService.ts";
import { documentOrganization } from "./documentOrganization.ts";

import { resolveAvrLinks } from "./avrContractBasis.ts";

export const AVR_EXCEL_SHEET_NAME = "Акт выполненных работ";
export const AVR_EXCEL_ITEM_START_ROW = 20;
const TEMPLATE_ITEM_COUNT = 3;
const MONEY_FMT = "#,##0.00";
const DATE_FMT = "dd.mm.yyyy";
const ITEM_COLS = ["A", "C", "N", "AC", "AF", "AI", "AN", "AS"] as const;
const ITEM_MERGE_COLS: Array<[number, number]> = [
  [0, 1],
  [2, 12],
  [13, 19],
  [20, 27],
  [28, 30],
  [31, 33],
  [34, 38],
  [39, 43],
  [44, 48],
];
const MONTHS_GENITIVE = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership;
}

export function civilDateFromIso(value: string | Date | null | undefined) {
  const raw = value instanceof Date ? value.toISOString() : String(value || "");
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

export function formatDotDate(value: string | Date | null | undefined) {
  const date = civilDateFromIso(value);
  if (!date) return "";
  return `${String(date.day).padStart(2, "0")}.${String(date.month).padStart(2, "0")}.${date.year}`;
}

export function formatQuotedDayMonthYear(value: string | Date | null | undefined) {
  const date = civilDateFromIso(value);
  if (!date) return "";
  return `«${String(date.day).padStart(2, "0")}» ${MONTHS_GENITIVE[date.month - 1]} ${date.year} года`;
}

export function formatFilenameDayMonthYear(value: string | Date | null | undefined) {
  const date = civilDateFromIso(value);
  if (!date) return "";
  return `${date.day} ${MONTHS_GENITIVE[date.month - 1]} ${date.year}`;
}

export function avrLocalNumber(number: string, documentDate?: string | Date | null) {
  const raw = String(number || "").trim();
  const crm = raw.match(/^AVR-(\d{4})-(\d+)$/i);
  if (crm) return `${crm[1].slice(-2)}-${crm[2].padStart(4, "0")}`;
  if (/^\d{2}-\d+$/.test(raw)) {
    const [yy, seq] = raw.split("-");
    return `${yy}-${seq.padStart(4, "0")}`;
  }
  return raw || "1";
}

export function formatAvrContractBasis(contract: { number: string; date: string } | null | undefined) {
  if (!contract?.number?.trim()) return "";
  const number = contract.number.replace(/^\s*(№|No|Nо)\s*/i, "").trim();
  const dated = formatQuotedDayMonthYear(contract.date);
  return dated ? `No ${number} от ${dated}` : `No ${number}`;
}

export function directorShortName(fullName: string) {
  const parts = String(fullName || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return "";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts
    .slice(1)
    .map((part) => `${part[0].toUpperCase()}.`)
    .join(" ")}`;
}

export function paperAvrMeasureUnit(unit: string | null | undefined) {
  const raw = String(unit || "").trim();
  if (!raw) return "услуга";
  const lower = raw.toLowerCase();
  if (lower === "услуга" || lower === "услуги") return "услуга";
  const code = resolveEsfMeasureUnitCode(raw);
  if (code === "796") return "услуга";
  return esfMeasureUnitSymbol(raw);
}

export function capitalizeRu(value: string) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.charAt(0).toLocaleUpperCase("ru-RU") + text.slice(1);
}

function stripOrgPrefix(name: string) {
  return String(name || "")
    .replace(/[«»„“”"]/g, " ")
    .replace(
      /^(товарищество с ограниченной ответственностью|акционерное общество|индивидуальный предприниматель|ип|тоо|ао)\s+/i,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function safeFilePart(value: string) {
  return value.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
}

export function avrExcelFileName(input: { number: string; source: AvrSourceSnapshot }) {
  const local = avrLocalNumber(input.number, input.source.documentDate);
  const buyer = safeFilePart(stripOrgPrefix(input.source.buyer.legalName || input.source.buyer.name));
  const dated = formatFilenameDayMonthYear(input.source.documentDate);
  return safeFilePart([local, buyer, dated ? `от ${dated}` : ""].filter(Boolean).join(" ")) + ".xlsx";
}

export function avrExcelLayout(itemCount: number) {
  const items = Math.max(itemCount, 1);
  const extra = Math.max(0, items - TEMPLATE_ITEM_COUNT);
  const unused = Math.max(0, TEMPLATE_ITEM_COUNT - items);
  const slots = items;
  const firstItemRow = AVR_EXCEL_ITEM_START_ROW;
  const lastItemRow = firstItemRow + items - 1;
  const lastSlotRow = lastItemRow;
  const totalsRow = lastSlotRow + 1;
  const wordsRow = totalsRow + 2;
  const captionRow = totalsRow + 3;
  const appendixRow = totalsRow + 4;
  const signRow = totalsRow + 7;
  return {
    itemCount: items,
    extra,
    unused,
    slots,
    firstItemRow,
    lastItemRow,
    lastSlotRow,
    totalsRow,
    wordsRow,
    captionRow,
    appendixRow,
    appendixContRow: appendixRow + 1,
    signRow,
    signHintRow: signRow + 1,
    signDateRow: signRow + 2,
    stampRow: signRow + 3,
  };
}

function partyLine(name: string, address: string) {
  return [expandLegalFormName(name), address.trim()].filter(Boolean).join(", ");
}

function taxId(party: { bin: string; iin: string }) {
  return String(party.bin || party.iin || "").replace(/\D/g, "");
}

function asAvrSource(value: unknown): AvrSourceSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const row = value as AvrSourceSnapshot;
  if (!row.seller || !row.buyer || !Array.isArray(row.items)) return null;
  if (row.kind && row.kind !== AVR_SOURCE_KIND) return null;
  return row;
}

function contentDisposition(filename: string) {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");
  return `attachment; filename="${ascii || "avr.xlsx"}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function avrTemplatePath() {
  const names = [
    path.resolve(import.meta.dirname, "../../assets/avr-form-r1.xlsx"),
    path.resolve(process.cwd(), "apps/api/assets/avr-form-r1.xlsx"),
    path.resolve(process.cwd(), "assets/avr-form-r1.xlsx"),
  ];
  const found = names.find((file) => existsSync(file) && !path.basename(file).startsWith("~$"));
  if (!found) throw new ApiError(500, "avr_template_missing", "Не найден шаблон АВР Excel");
  return found;
}

function colLetter(index1: number) {
  let n = index1;
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function colIndex(letters: string) {
  return letters.split("").reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
}

function decodeMerge(range: string) {
  const [start, end] = range.split(":");
  const left = start.replace(/\d/g, "");
  const top = Number(start.replace(/\D/g, ""));
  const right = (end || start).replace(/\d/g, "");
  const bottom = Number((end || start).replace(/\D/g, ""));
  return { start, left, top, right, bottom };
}

function itemMergeRefs(row1: number) {
  return ITEM_MERGE_COLS.map(([c1, c2]) => `${colLetter(c1 + 1)}${row1}:${colLetter(c2 + 1)}${row1}`);
}

function unmergeAll(ws: ExcelJS.Worksheet) {
  for (const range of [...(ws.model.merges || [])]) {
    try {
      ws.unMergeCells(range);
    } catch {
      /* already cleared */
    }
  }
}

function mergeSafe(ws: ExcelJS.Worksheet, ref: string) {
  if ((ws.model.merges || []).includes(ref)) return;
  try {
    ws.mergeCells(ref);
  } catch {
    /* overlapping leftover */
  }
}

function shiftMergeRange(range: string, extra: number) {
  if (!extra) return range;
  const box = decodeMerge(range);
  const lastTemplateItem = AVR_EXCEL_ITEM_START_ROW + TEMPLATE_ITEM_COUNT - 1;
  if (box.top >= AVR_EXCEL_ITEM_START_ROW && box.bottom <= lastTemplateItem) return range;
  const startShift = lastTemplateItem + 1;
  if (box.top >= startShift) return `${box.left}${box.top + extra}:${box.right}${box.bottom + extra}`;
  if (box.bottom >= startShift) return `${box.left}${box.top}:${box.right}${box.bottom + extra}`;
  return range;
}

function shiftMergeAfterDelete(range: string, unused: number): string | null {
  if (!unused) return range;
  const box = decodeMerge(range);
  const deleteAt = AVR_EXCEL_ITEM_START_ROW + TEMPLATE_ITEM_COUNT - unused;
  const deleteEnd = AVR_EXCEL_ITEM_START_ROW + TEMPLATE_ITEM_COUNT - 1;
  if (box.top >= deleteAt && box.bottom <= deleteEnd) return null;
  if (box.bottom < deleteAt) return range;
  if (box.top > deleteEnd) return `${box.left}${box.top - unused}:${box.right}${box.bottom - unused}`;
  if (box.top < deleteAt && box.bottom >= deleteAt) {
    const bottom = box.bottom > deleteEnd ? box.bottom - unused : Math.min(box.bottom, deleteAt - 1);
    if (bottom < box.top) return null;
    return `${box.left}${box.top}:${box.right}${bottom}`;
  }
  if (box.top >= deleteAt && box.top <= deleteEnd && box.bottom > deleteEnd) {
    return `${box.left}${deleteAt}:${box.right}${box.bottom - unused}`;
  }
  return range;
}

function insertExtraItemRows(ws: ExcelJS.Worksheet, extra: number) {
  if (extra <= 0) return;
  const templateMerges = [...(ws.model.merges || [])];
  const lastTemplateItem = AVR_EXCEL_ITEM_START_ROW + TEMPLATE_ITEM_COUNT - 1;
  unmergeAll(ws);
  ws.duplicateRow(lastTemplateItem, extra, true);
  const rebuilt: string[] = [];
  for (const range of templateMerges) {
    const next = shiftMergeRange(range, extra);
    if (next) rebuilt.push(next);
  }
  for (let row = lastTemplateItem + 1; row <= lastTemplateItem + extra; row += 1) {
    rebuilt.push(...itemMergeRefs(row));
  }
  unmergeAll(ws);
  for (const range of rebuilt) mergeSafe(ws, range);
}

function deleteUnusedItemRows(ws: ExcelJS.Worksheet, unused: number) {
  if (unused <= 0) return;
  const templateMerges = [...(ws.model.merges || [])];
  const deleteAt = AVR_EXCEL_ITEM_START_ROW + TEMPLATE_ITEM_COUNT - unused;
  unmergeAll(ws);
  ws.spliceRows(deleteAt, unused);
  const rebuilt: string[] = [];
  for (const range of templateMerges) {
    const next = shiftMergeAfterDelete(range, unused);
    if (next) rebuilt.push(next);
  }
  unmergeAll(ws);
  for (const range of rebuilt) mergeSafe(ws, range);
}

function setValue(ws: ExcelJS.Worksheet, addr: string, value: ExcelJS.CellValue) {
  ws.getCell(addr).value = value;
}

function setNumber(ws: ExcelJS.Worksheet, addr: string, value: number | string | null, numFmt?: string) {
  const cell = ws.getCell(addr);
  cell.value = value;
  if (numFmt) cell.numFmt = numFmt;
}

function setDate(ws: ExcelJS.Worksheet, addr: string, value: string | Date | null | undefined) {
  const date = civilDateFromIso(value);
  const cell = ws.getCell(addr);
  if (!date) {
    cell.value = null;
    return;
  }
  cell.value = new Date(Date.UTC(date.year, date.month - 1, date.day));
  cell.numFmt = DATE_FMT;
}

function fillItemRow(
  ws: ExcelJS.Worksheet,
  row: number,
  index: number,
  item: AvrSourceSnapshot["items"][number],
) {
  const amount = Number(item.amountWithoutVat ?? Number(item.quantity || 0) * Number(item.unitPrice || 0));
  setNumber(ws, `A${row}`, index + 1, "0");
  setValue(ws, `C${row}`, item.name || "");
  setValue(ws, `N${row}`, null);
  setValue(ws, `AC${row}`, paperAvrMeasureUnit(item.unit));
  setNumber(ws, `AF${row}`, Number(item.quantity || 0), "0");
  setNumber(ws, `AI${row}`, Number(item.unitPrice || 0), MONEY_FMT);
  ws.getCell(`AN${row}`).value = { formula: `AF${row}*AI${row}`, result: amount };
  ws.getCell(`AN${row}`).numFmt = MONEY_FMT;
  setNumber(ws, `AS${row}`, Number(item.vatAmount || 0), MONEY_FMT);
}

function fillWorksheet(ws: ExcelJS.Worksheet, input: { localNumber: string; source: AvrSourceSnapshot }) {
  const layout = avrExcelLayout(input.source.items.length);
  const { source } = input;
  const buyerId = taxId(source.buyer);
  const sellerId = taxId(source.seller);

  setValue(ws, "E9", partyLine(source.buyer.legalName || source.buyer.name, source.buyer.legalAddress));
  setValue(ws, "AQ9", buyerId ? ` ${buyerId}` : "");
  setValue(ws, "E11", partyLine(source.seller.legalName, source.seller.legalAddress));
  if (/^\d{12}$/.test(sellerId)) setNumber(ws, "AQ11", Number(sellerId), "0");
  else setValue(ws, "AQ11", sellerId);
  setValue(ws, "F13", formatAvrContractBasis(source.contract));
  setValue(ws, "AP15", input.localNumber);
  setDate(ws, "AT15", source.documentDate);

  source.items.forEach((item, index) => fillItemRow(ws, layout.firstItemRow + index, index, item));

  const qty = source.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  setValue(ws, `AE${layout.totalsRow}`, "Итого");
  ws.getCell(`AF${layout.totalsRow}`).value = {
    formula: `SUM(AF${layout.firstItemRow}:AF${layout.lastSlotRow})`,
    result: qty,
  };
  ws.getCell(`AF${layout.totalsRow}`).numFmt = "0";
  setValue(ws, `AI${layout.totalsRow}`, "x");
  ws.getCell(`AN${layout.totalsRow}`).value = {
    formula: `SUM(AN${layout.firstItemRow}:AN${layout.lastSlotRow})`,
    result: source.totals.amountWithoutVat,
  };
  ws.getCell(`AN${layout.totalsRow}`).numFmt = MONEY_FMT;
  ws.getCell(`AS${layout.totalsRow}`).value = {
    formula: `SUM(AS${layout.firstItemRow}:AS${layout.lastSlotRow})`,
    result: source.totals.vatAmount,
  };
  ws.getCell(`AS${layout.totalsRow}`).numFmt = MONEY_FMT;
  setValue(
    ws,
    `T${layout.wordsRow}`,
    capitalizeRu(amountToKztWords(source.totals.amountWithoutVat || source.totals.totalAmount)),
  );
  setValue(ws, `F${layout.signRow}`, source.seller.directorPosition || "Директор");
  setValue(ws, `R${layout.signRow}`, directorShortName(source.seller.directorName));
}

function tableMergeAddresses(sheetXml: string, lastTableRow: number) {
  const addresses = new Set<string>();
  const merges = [...sheetXml.matchAll(/<mergeCell ref="([^"]+)"/g)].map((match) => decodeMerge(match[1]));
  for (const box of merges) {
    if (box.top < 17 || box.bottom > lastTableRow) continue;
    const left = colIndex(box.left);
    const right = colIndex(box.right);
    for (let r = box.top; r <= box.bottom; r += 1) {
      for (let c = left; c <= right; c += 1) addresses.add(`${colLetter(c)}${r}`);
    }
  }
  return addresses;
}

function withBoxTableBorders(stylesXml: string, sheetXml: string, lastTableRow: number) {
  const addresses = tableMergeAddresses(sheetXml, lastTableRow);
  if (!addresses.size) return { stylesXml, sheetXml };
  const bordersMatch = stylesXml.match(/<borders count="(\d+)">/);
  const borderCount = Number(bordersMatch?.[1] || 0);
  const borderId = borderCount;
  stylesXml = stylesXml.replace(`<borders count="${borderCount}">`, `<borders count="${borderCount + 1}">`);
  stylesXml = stylesXml.replace(
    "</borders>",
    `<border><left style="thin"><color indexed="64"/></left><right style="thin"><color indexed="64"/></right><top style="thin"><color indexed="64"/></top><bottom style="thin"><color indexed="64"/></bottom><diagonal/></border></borders>`,
  );
  const xfsMatch = stylesXml.match(/<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/);
  if (!xfsMatch) return { stylesXml, sheetXml };
  const xfs = xfsMatch[2].match(/<xf\b[^>]*\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g) || [];
  const used = new Set<number>();
  let missingStyle = false;
  for (const addr of addresses) {
    const sid = sheetXml.match(new RegExp(`<c r="${addr}"[^>]*s="(\\d+)"`))?.[1];
    if (sid) used.add(Number(sid));
    else missingStyle = true;
  }
  const mapped = new Map<number, number>();
  const extra: string[] = [];
  let nextId = xfs.length;
  for (const id of used) {
    const xf = xfs[id];
    if (!xf) continue;
    let clone = xf.replace(/borderId="\d+"/, `borderId="${borderId}"`);
    if (!/applyBorder=/.test(clone)) clone = clone.replace("<xf ", '<xf applyBorder="1" ');
    else clone = clone.replace(/applyBorder="0"/, 'applyBorder="1"');
    extra.push(clone);
    mapped.set(id, nextId);
    nextId += 1;
  }
  let fallback = mapped.values().next().value as number | undefined;
  if (missingStyle || fallback == null) {
    extra.push(`<xf numFmtId="0" fontId="0" fillId="0" borderId="${borderId}" xfId="0" applyBorder="1"/>`);
    fallback = nextId;
    nextId += 1;
  }
  stylesXml = stylesXml.replace(
    /<cellXfs count="\d+">[\s\S]*?<\/cellXfs>/,
    `<cellXfs count="${xfs.length + extra.length}">${xfs.join("")}${extra.join("")}</cellXfs>`,
  );
  for (const addr of addresses) {
    sheetXml = sheetXml.replace(new RegExp(`<c r="${addr}"([^>/]*)(/?)>`), (all, attrs: string, self: string) => {
      const sid = attrs.match(/\ss="(\d+)"/)?.[1];
      const next = sid && mapped.has(Number(sid)) ? mapped.get(Number(sid)) : fallback;
      if (next == null) return all;
      const rest = /\ss="\d+"/.test(attrs) ? attrs.replace(/\ss="\d+"/, ` s="${next}"`) : ` s="${next}"${attrs}`;
      return `<c r="${addr}"${rest}${self}>`;
    });
  }
  return { stylesXml, sheetXml };
}

function sortCellsInRows(xml: string) {
  return xml.replace(/<row ([^>/]*)>([\s\S]*?)<\/row>/g, (all: string, attrs: string, inner: string) => {
    const cells = inner.match(/<c [^>]+\/>|<c [^>]*>[\s\S]*?<\/c>/g);
    if (!cells || cells.length <= 1) return all;
    cells.sort((left, right) => {
      const a = left.match(/r="([A-Z]+)\d+"/)?.[1] || "A";
      const b = right.match(/r="([A-Z]+)\d+"/)?.[1] || "A";
      return colIndex(a) - colIndex(b);
    });
    return `<row ${attrs}>${cells.join("")}</row>`;
  });
}

function stripMergeSlaveValues(xml: string) {
  const merges = [...xml.matchAll(/<mergeCell ref="([^"]+)"/g)].map((match) => decodeMerge(match[1]));
  const slaves = new Set<string>();
  const masters: string[] = [];
  for (const merge of merges) {
    masters.push(merge.start);
    const left = colIndex(merge.left);
    const right = colIndex(merge.right);
    for (let r = merge.top; r <= merge.bottom; r += 1) {
      for (let c = left; c <= right; c += 1) {
        const addr = `${colLetter(c)}${r}`;
        if (addr !== merge.start) slaves.add(addr);
      }
    }
  }
  xml = xml.replace(/\sspans="[^"]*"/g, "");
  xml = xml.replace(/<c r="([A-Z]+\d+)"([^>/]*)>([\s\S]*?)<\/c>/g, (all, addr, attrs) => {
    if (!slaves.has(addr)) return all;
    const style = attrs.match(/\ss="[^"]*"/)?.[0] || "";
    return `<c r="${addr}"${style}/>`;
  });
  for (const master of masters) {
    if (new RegExp(`<c r="${master}"`).test(xml)) continue;
    const row = master.replace(/\D/g, "");
    const rowRe = new RegExp(`<row r="${row}"([^>]*)(/)?>`);
    xml = xml.replace(rowRe, (all, attrs, selfClose) => {
      if (selfClose) return `<row r="${row}"${attrs}><c r="${master}"/></row>`;
      return `<row r="${row}"${attrs}><c r="${master}"/>`;
    });
    if (!new RegExp(`<c r="${master}"`).test(xml)) {
      xml = xml.replace("</sheetData>", `<row r="${row}"><c r="${master}"/></row></sheetData>`);
    }
  }
  return xml;
}

function cleanSheetXml(xml: string) {
  return sortCellsInRows(
    stripMergeSlaveValues(
      xml
        .replace(/\shorizontalDpi="4294967295"/g, "")
        .replace(/\sverticalDpi="4294967295"/g, "")
        .replace(/x14ac:dyDescent="55"/g, 'x14ac:dyDescent="0.25"'),
    ),
  );
}

async function sanitizeAvrXlsx(buffer: Buffer, lastTableRow: number) {
  const zip = await JSZip.loadAsync(buffer);
  const typeFile = zip.file("[Content_Types].xml");
  if (typeFile && !Object.keys(zip.files).some((name) => name.endsWith(".vml"))) {
    const types = await typeFile.async("string");
    zip.file("[Content_Types].xml", types.replace(/<Default Extension="vml"[^>]*>/g, ""));
  }
  const sheetNames = Object.keys(zip.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  let stylesXml = (await zip.file("xl/styles.xml")?.async("string")) || "";
  stylesXml = stylesXml.replace(/<extLst>[\s\S]*?<\/extLst>/g, "");
  for (const name of sheetNames) {
    const sheetFile = zip.file(name);
    if (!sheetFile) continue;
    const boxed = withBoxTableBorders(stylesXml, cleanSheetXml(await sheetFile.async("string")), lastTableRow);
    stylesXml = boxed.stylesXml;
    zip.file(name, boxed.sheetXml);
  }
  if (stylesXml) zip.file("xl/styles.xml", stylesXml);
  for (const name of sheetNames) {
    const sheetFile = zip.file(name);
    if (!sheetFile) continue;
    zip.file(name, cleanSheetXml(await sheetFile.async("string")));
  }
  if (sheetNames.length === 1 && sheetNames[0] !== "xl/worksheets/sheet1.xml") {
    const xml = await zip.file(sheetNames[0])!.async("string");
    zip.file("xl/worksheets/sheet1.xml", xml);
    zip.remove(sheetNames[0]);
    const relsFile = zip.file("xl/_rels/workbook.xml.rels");
    if (relsFile) {
      const rels = await relsFile.async("string");
      zip.file("xl/_rels/workbook.xml.rels", rels.replaceAll(path.basename(sheetNames[0]), "sheet1.xml"));
    }
    const typesFile = zip.file("[Content_Types].xml");
    if (typesFile) {
      const types = await typesFile.async("string");
      zip.file("[Content_Types].xml", types.replaceAll(sheetNames[0], "xl/worksheets/sheet1.xml"));
    }
  }
  return Buffer.from(
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }),
  );
}

export async function renderAvrExcel(input: { number: string; source: AvrSourceSnapshot }) {
  const layout = avrExcelLayout(input.source.items.length);
  const localNumber = avrLocalNumber(input.number, input.source.documentDate);
  const filename = avrExcelFileName({ number: input.number, source: input.source });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Uint8Array.from(readFileSync(avrTemplatePath())).buffer);
  wb.calcProperties.fullCalcOnLoad = true;
  const ws = wb.worksheets[0];
  if (!ws) throw new ApiError(500, "avr_template_missing", "В шаблоне АВР нет листа");
  ws.name = AVR_EXCEL_SHEET_NAME;
  if (ws.pageSetup.horizontalDpi === 4294967295) ws.pageSetup.horizontalDpi = 96;
  if (ws.pageSetup.verticalDpi === 4294967295) ws.pageSetup.verticalDpi = 96;
  insertExtraItemRows(ws, layout.extra);
  deleteUnusedItemRows(ws, layout.unused);
  fillWorksheet(ws, { localNumber, source: input.source });
  const data = await wb.xlsx.writeBuffer();
  return { buffer: await sanitizeAvrXlsx(Buffer.from(data), layout.totalsRow), filename, localNumber, layout };
}

export async function resolveAvrSource(
  prisma: PrismaClient,
  tenantId: string,
  document: {
    dealId: string;
    contractId: string | null;
    invoiceId: string | null;
    documentDate: Date;
    currency: string;
    sourceDataJson: unknown;
    status?: string;
    externalId?: string | null;
    externalSystem?: string | null;
  },
): Promise<AvrSourceSnapshot> {
  const stored = asAvrSource(document.sourceDataJson);
  if (stored) {
    if (stored.contract?.number?.trim() || !["DRAFT", "VALIDATED"].includes(document.status || "") || document.externalId || document.externalSystem === "BASQAR") return stored;
    const { basis, invoice } = await resolveAvrLinks(prisma, tenantId, document.dealId, document);
    return { ...stored, contract: basis, invoice: stored.invoice || (invoice ? { id: invoice.id, number: invoice.number, date: invoice.date.toISOString(), status: invoice.status } : null) };
  }
  const deal = await prisma.deal.findFirst({
    where: { id: document.dealId, tenantId },
    include: { items: { orderBy: { sortOrder: "asc" } }, company: true },
  });
  if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");
  const { contract, invoice, basis } = await resolveAvrLinks(prisma, tenantId, deal.id, document);
  const [profile, tenant] = await Promise.all([
    documentOrganization(prisma, tenantId, deal.id, contract?.id),
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
  ]);
  return mapAvrSource({
    documentDate: document.documentDate,
    currency: document.currency || deal.currency || "KZT",
    deal,
    items: deal.items.map(serializeDealItem),
    profile,
    tenantName: tenant?.name,
    company: deal.company,
    contract,
    contractBasis: basis,
    invoice,
  });
}

export async function sendAvrExcel(prisma: PrismaClient, auth: AuthContext, documentId: string, res: Response) {
  requireDocumentsAccess(auth);
  const membership = requireTenant(auth);
  const document = await prisma.electronicDocument.findFirst({
    where: { id: documentId, tenantId: membership.tenantId },
  });
  if (!document) throw new ApiError(404, "not_found", "Документ не найден");
  if (document.type !== "AVR") {
    throw new ApiError(422, "not_avr", "Excel-форма доступна только для АВР");
  }
  const source = await resolveAvrSource(prisma, membership.tenantId, document);
  const { buffer, filename } = await renderAvrExcel({ number: document.number, source });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", contentDisposition(filename));
  res.setHeader("Cache-Control", "no-store");
  res.send(buffer);
}
