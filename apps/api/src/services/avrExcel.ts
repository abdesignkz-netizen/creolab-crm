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
import * as XLSX from "xlsx";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { requireDocumentsAccess } from "../lib/access.ts";
import { AVR_SOURCE_KIND, mapAvrSource, type AvrSourceSnapshot } from "./avrMapper.ts";
import { serializeDealItem } from "./dealItemService.ts";
import { documentOrganization } from "./documentOrganization.ts";

export const AVR_EXCEL_SHEET_NAME = "Акт выполненных работ";
export const AVR_EXCEL_ITEM_START_ROW = 20;
const TEMPLATE_ITEM_COUNT = 3;
const MONEY_FMT = "#,##0.00";
const THIN = { style: "thin" as const, color: { argb: "FF000000" } };
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
  const date = civilDateFromIso(documentDate) || civilDateFromIso(new Date().toISOString());
  const yy = String(date?.year || new Date().getFullYear()).slice(-2);
  const digits = raw.replace(/\D/g, "");
  return `${yy}-${(digits || "1").slice(-4).padStart(4, "0")}`;
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
  const totalsRow = AVR_EXCEL_ITEM_START_ROW + items;
  const wordsRow = totalsRow + 2;
  const captionRow = totalsRow + 3;
  const appendixRow = totalsRow + 4;
  const signRow = totalsRow + 7;
  return {
    itemCount: items,
    firstItemRow: AVR_EXCEL_ITEM_START_ROW,
    lastItemRow: AVR_EXCEL_ITEM_START_ROW + items - 1,
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
  return [name.trim(), address.trim()].filter(Boolean).join(", ");
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
    path.resolve(import.meta.dirname, "../../assets/avr-form-r1.xls"),
    path.resolve(process.cwd(), "apps/api/assets/avr-form-r1.xls"),
    path.resolve(process.cwd(), "assets/avr-form-r1.xls"),
  ];
  const found = names.find((file) => existsSync(file));
  if (!found) throw new ApiError(500, "avr_template_missing", "Не найден шаблон АВР Excel");
  return found;
}

const PAPER_FONT: Partial<ExcelJS.Font> = { name: "Times New Roman", charset: 204, size: 9 };
const MAX_TEMPLATE_COL = 57;

function excelSerial(value: string | Date | null | undefined) {
  const date = civilDateFromIso(value);
  if (!date) return null;
  return Math.round(Date.UTC(date.year, date.month - 1, date.day) / 86400000 + 25569);
}

function mergeRef(range: XLSX.Range) {
  return `${XLSX.utils.encode_cell(range.s)}:${XLSX.utils.encode_cell(range.e)}`;
}

function isMergeMaster(r: number, c: number, merges: XLSX.Range[]) {
  for (const merge of merges) {
    if (r >= merge.s.r && r <= merge.e.r && c >= merge.s.c && c <= merge.e.c) {
      return r === merge.s.r && c === merge.s.c;
    }
  }
  return true;
}

function readTemplateSheet() {
  const parsed = XLSX.read(readFileSync(avrTemplatePath()), {
    type: "buffer",
    cellNF: true,
    cellDates: false,
    cellStyles: true,
    bookSST: true,
  });
  const sheetName = parsed.SheetNames[0] || AVR_EXCEL_SHEET_NAME;
  const sheet = parsed.Sheets[sheetName];
  if (!sheet) throw new ApiError(500, "avr_template_missing", "В шаблоне АВР нет листа");
  return sheet;
}

function cellValueFromTemplate(cell: XLSX.CellObject): ExcelJS.CellValue {
  if (cell.f) {
    const result = cell.t === "n" ? Number(cell.v) : cell.v == null ? undefined : String(cell.v);
    return { formula: String(cell.f), result };
  }
  if (cell.t === "z" || cell.v == null || cell.v === "") return null;
  if (cell.t === "n" || typeof cell.v === "number") return Number(cell.v);
  if (cell.t === "b") return Boolean(cell.v);
  return String(cell.v);
}

function copyTemplateToWorksheet(ws: ExcelJS.Worksheet, template: XLSX.WorkSheet) {
  const merges = (template["!merges"] || []) as XLSX.Range[];
  const cols = (template["!cols"] || []) as Array<XLSX.ColInfo | undefined>;
  const rows = (template["!rows"] || []) as Array<XLSX.RowInfo | undefined>;
  cols.slice(0, MAX_TEMPLATE_COL).forEach((col, index) => {
    if (col?.wch != null) ws.getColumn(index + 1).width = col.wch;
  });
  rows.forEach((row, index) => {
    if (row?.hpt) ws.getRow(index + 1).height = row.hpt;
  });
  for (const key of Object.keys(template)) {
    if (key[0] === "!") continue;
    const pos = XLSX.utils.decode_cell(key);
    if (pos.c >= MAX_TEMPLATE_COL) continue;
    if (!isMergeMaster(pos.r, pos.c, merges)) continue;
    const src = template[key] as XLSX.CellObject;
    if (!src || src.t === "z") continue;
    const value = cellValueFromTemplate(src);
    if (value == null) continue;
    const cell = ws.getCell(key);
    cell.value = value;
    if (src.z && src.z !== "General") cell.numFmt = src.z;
    cell.font = { ...PAPER_FONT };
    cell.alignment = { vertical: "middle", wrapText: true };
  }
  for (const merge of merges) {
    if (merge.s.c >= MAX_TEMPLATE_COL || merge.e.c >= MAX_TEMPLATE_COL) continue;
    if (merge.s.r === merge.e.r && merge.s.c === merge.e.c) continue;
    const ref = mergeRef(merge);
    if ((ws.model.merges || []).includes(ref)) continue;
    try {
      ws.mergeCells(ref);
    } catch {
      /* already merged after row copy */
    }
  }
}

function itemMergeRefs(row1: number) {
  const r = row1 - 1;
  return ITEM_MERGE_COLS.map(([c1, c2]) => mergeRef({ s: { r, c: c1 }, e: { r, c: c2 } }));
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
  if (box.top >= AVR_EXCEL_ITEM_START_ROW && box.bottom <= lastTemplateItem) {
    return box.top <= AVR_EXCEL_ITEM_START_ROW + Math.max(1, TEMPLATE_ITEM_COUNT + extra) - 1 ? range : "";
  }
  const startShift = lastTemplateItem + 1;
  if (box.top >= startShift) return `${box.left}${box.top + extra}:${box.right}${box.bottom + extra}`;
  if (box.bottom >= startShift) return `${box.left}${box.top}:${box.right}${box.bottom + extra}`;
  return range;
}

function rebuildMerges(ws: ExcelJS.Worksheet, templateMerges: string[], itemCount: number) {
  const needed = Math.max(itemCount, 1);
  const extra = needed - TEMPLATE_ITEM_COUNT;
  const lastTemplateItem = AVR_EXCEL_ITEM_START_ROW + TEMPLATE_ITEM_COUNT - 1;
  const rebuilt: string[] = [];
  for (const range of templateMerges) {
    const next = shiftMergeRange(range, extra);
    if (next) rebuilt.push(next);
  }
  for (let row = lastTemplateItem + 1; row < AVR_EXCEL_ITEM_START_ROW + needed; row += 1) {
    rebuilt.push(...itemMergeRefs(row));
  }
  unmergeAll(ws);
  for (const range of rebuilt) mergeSafe(ws, range);
}

function adjustItemRows(ws: ExcelJS.Worksheet, itemCount: number, templateMerges: string[]) {
  const needed = Math.max(itemCount, 1);
  const lastTemplateItem = AVR_EXCEL_ITEM_START_ROW + TEMPLATE_ITEM_COUNT - 1;
  if (needed > TEMPLATE_ITEM_COUNT) {
    ws.duplicateRow(lastTemplateItem, needed - TEMPLATE_ITEM_COUNT, true);
  } else if (needed < TEMPLATE_ITEM_COUNT) {
    ws.spliceRows(AVR_EXCEL_ITEM_START_ROW + needed, TEMPLATE_ITEM_COUNT - needed);
  }
  rebuildMerges(ws, templateMerges, needed);
  for (let row = AVR_EXCEL_ITEM_START_ROW; row < AVR_EXCEL_ITEM_START_ROW + needed; row += 1) {
    ws.getRow(row).height = 40.5;
  }
}

function applyPrintSetup(ws: ExcelJS.Worksheet) {
  ws.properties.dyDescent = 0.25;
  ws.views = [{ showGridLines: true, zoomScale: 85, state: "normal" }];
  ws.pageSetup.paperSize = 9;
  ws.pageSetup.orientation = "landscape";
  ws.pageSetup.horizontalCentered = true;
  ws.pageSetup.fitToPage = false;
  ws.pageSetup.margins = {
    left: 0.7086614173228347,
    right: 0.7086614173228347,
    top: 0.7480314960629921,
    bottom: 0.7480314960629921,
    header: 0.31496062992125984,
    footer: 0.31496062992125984,
  };
  const setup = ws.pageSetup as unknown as Record<string, unknown>;
  setup.horizontalDpi = 96;
  setup.verticalDpi = 96;
  delete setup.scale;
  delete setup.fitToWidth;
  delete setup.fitToHeight;
  delete setup.copies;
  delete setup.firstPageNumber;
}

function sortCellsInRows(xml: string) {
  return xml.replace(/<row ([^>/]*)>([\s\S]*?)<\/row>/g, (all, attrs, inner) => {
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

function stripMergeSlaveCells(xml: string) {
  const merges = [...xml.matchAll(/<mergeCell ref="([^"]+)"/g)].map((match) => decodeMerge(match[1]));
  const slaves = new Set<string>();
  const masters: string[] = [];
  for (const merge of merges) {
    masters.push(merge.start);
    const left = colIndex(merge.left);
    const right = colIndex(merge.right);
    for (let r = merge.top; r <= merge.bottom; r += 1) {
      for (let c = left; c <= right; c += 1) {
        const addr = XLSX.utils.encode_cell({ r: r - 1, c: c - 1 });
        if (addr !== merge.start) slaves.add(addr);
      }
    }
  }
  xml = xml.replace(/\sspans="[^"]*"/g, "");
  xml = xml.replace(/<c r="([A-Z]+\d+)"[^/]*\/>/g, (all, addr) => (slaves.has(addr) ? "" : all));
  xml = xml.replace(/<c r="([A-Z]+\d+)"[^>]*>[\s\S]*?<\/c>/g, (all, addr) => (slaves.has(addr) ? "" : all));
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

async function sanitizeAvrXlsx(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const typeFile = zip.file("[Content_Types].xml");
  if (typeFile && !Object.keys(zip.files).some((name) => name.endsWith(".vml"))) {
    const types = await typeFile.async("string");
    zip.file(
      "[Content_Types].xml",
      types.replace(/<Default Extension="vml"[^>]*>/g, ""),
    );
  }
  const stylesFile = zip.file("xl/styles.xml");
  if (stylesFile) {
    const styles = await stylesFile.async("string");
    zip.file("xl/styles.xml", styles.replace(/<extLst>[\s\S]*?<\/extLst>/g, ""));
  }
  const sheetFile = zip.file("xl/worksheets/sheet1.xml");
  if (sheetFile) {
    const xml = await sheetFile.async("string");
    zip.file(
      "xl/worksheets/sheet1.xml",
      sortCellsInRows(
        stripMergeSlaveCells(
          xml
            .replace(/\shorizontalDpi="4294967295"/g, "")
            .replace(/\sverticalDpi="4294967295"/g, "")
            .replace(/x14ac:dyDescent="55"/g, 'x14ac:dyDescent="0.25"')
            .replace(/\sfitToWidth="1"/g, "")
            .replace(/\sfitToHeight="1"/g, ""),
        ),
      ),
    );
  }
  return Buffer.from(
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }),
  );
}

function writeCell(ws: ExcelJS.Worksheet, addr: string, value: ExcelJS.CellValue, numFmt?: string) {
  const cell = ws.getCell(addr);
  cell.value = value;
  if (numFmt) cell.numFmt = numFmt;
  cell.font = { ...(cell.font || {}), ...PAPER_FONT };
  cell.alignment = { ...(cell.alignment || {}), vertical: "middle", wrapText: true };
}

function fillWorksheet(ws: ExcelJS.Worksheet, input: { localNumber: string; source: AvrSourceSnapshot }) {
  const layout = avrExcelLayout(input.source.items.length);
  const { source } = input;
  const buyerId = taxId(source.buyer);
  const sellerId = taxId(source.seller);
  const performed = excelSerial(source.documentDate);

  writeCell(ws, "E9", partyLine(source.buyer.legalName || source.buyer.name, source.buyer.legalAddress));
  writeCell(ws, "AQ9", buyerId ? ` ${buyerId}` : "", "@");
  writeCell(ws, "E11", partyLine(source.seller.legalName, source.seller.legalAddress));
  if (/^\d{12}$/.test(sellerId)) writeCell(ws, "AQ11", Number(sellerId), "0");
  else writeCell(ws, "AQ11", sellerId, "@");
  writeCell(ws, "F13", formatAvrContractBasis(source.contract));
  writeCell(ws, "AP15", input.localNumber, "00000000000");
  if (performed != null) writeCell(ws, "AT15", performed, "m/d/yy");
  else writeCell(ws, "AT15", formatDotDate(source.documentDate));

  for (let i = 0; i < layout.itemCount; i += 1) {
    const row = layout.firstItemRow + i;
    const item = source.items[i];
    if (!item) {
      for (const col of ["A", "C", "N", "AC", "AF", "AI", "AN", "AS"]) writeCell(ws, `${col}${row}`, "");
      continue;
    }
    const amount = Number(item.amountWithoutVat ?? Number(item.quantity || 0) * Number(item.unitPrice || 0));
    writeCell(ws, `A${row}`, i === 0 ? String(i + 1) : i + 1, "0");
    writeCell(ws, `C${row}`, item.name || "");
    if (performed != null) writeCell(ws, `N${row}`, performed, "m/d/yy");
    else writeCell(ws, `N${row}`, formatDotDate(source.documentDate));
    writeCell(ws, `AC${row}`, paperAvrMeasureUnit(item.unit));
    writeCell(ws, `AF${row}`, item.quantity, "0");
    writeCell(ws, `AI${row}`, item.unitPrice, MONEY_FMT);
    writeCell(ws, `AN${row}`, { formula: `AF${row}*AI${row}`, result: amount }, MONEY_FMT);
    writeCell(ws, `AS${row}`, item.vatAmount, MONEY_FMT);
  }

  const qty = source.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  writeCell(ws, `AE${layout.totalsRow}`, "Итого");
  writeCell(ws, `AF${layout.totalsRow}`, {
    formula: `SUM(AF${layout.firstItemRow}:AF${layout.lastItemRow})`,
    result: qty,
  }, "0");
  writeCell(ws, `AI${layout.totalsRow}`, "x", MONEY_FMT);
  writeCell(ws, `AN${layout.totalsRow}`, {
    formula: `SUM(AN${layout.firstItemRow}:AN${layout.lastItemRow})`,
    result: source.totals.amountWithoutVat,
  }, MONEY_FMT);
  writeCell(ws, `AS${layout.totalsRow}`, {
    formula: `SUM(AS${layout.firstItemRow}:AS${layout.lastItemRow})`,
    result: source.totals.vatAmount,
  }, MONEY_FMT);
  writeCell(
    ws,
    `T${layout.wordsRow}`,
    capitalizeRu(amountToKztWords(source.totals.amountWithoutVat || source.totals.totalAmount)),
  );
  writeCell(ws, `F${layout.signRow}`, source.seller.directorPosition || "Директор");
  writeCell(ws, `R${layout.signRow}`, directorShortName(source.seller.directorName));
}

function decodeMerge(range: string) {
  const [start, end] = range.split(":");
  const left = start.replace(/\d/g, "");
  const top = Number(start.replace(/\D/g, ""));
  const right = (end || start).replace(/\d/g, "");
  const bottom = Number((end || start).replace(/\D/g, ""));
  return { start, left, top, right, bottom };
}

function colIndex(letters: string) {
  return letters.split("").reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
}

function restorePaperLook(ws: ExcelJS.Worksheet, totalsRow: number) {
  applyPrintSetup(ws);
  for (const range of ws.model.merges || []) {
    const box = decodeMerge(range);
    const col = colIndex(box.left);
    const table = box.top >= 17 && box.top <= totalsRow;
    const bin = (box.top === 9 || box.top === 11) && col >= 43;
    const number = box.top >= 13 && box.top <= 15 && col >= 42;
    const party = (box.top === 9 || box.top === 11) && col <= 36;
    const contract = box.top === 13 && col <= 29;
    if (!table && !bin && !number && !party && !contract) continue;
    const cell = ws.getCell(box.start);
    cell.border = { top: THIN, left: THIN, bottom: THIN, right: THIN };
    cell.font = { ...(cell.font || {}), ...PAPER_FONT };
  }
}

export async function renderAvrExcel(input: { number: string; source: AvrSourceSnapshot }) {
  const layout = avrExcelLayout(input.source.items.length);
  const localNumber = avrLocalNumber(input.number, input.source.documentDate);
  const filename = avrExcelFileName({ number: input.number, source: input.source });
  const template = readTemplateSheet();
  const wb = new ExcelJS.Workbook();
  wb.calcProperties.fullCalcOnLoad = true;
  const ws = wb.addWorksheet(AVR_EXCEL_SHEET_NAME);
  copyTemplateToWorksheet(ws, template);
  const templateMerges = [...(ws.model.merges || [])];
  adjustItemRows(ws, input.source.items.length, templateMerges);
  fillWorksheet(ws, { localNumber, source: input.source });
  restorePaperLook(ws, layout.totalsRow);
  const data = await wb.xlsx.writeBuffer();
  return { buffer: await sanitizeAvrXlsx(Buffer.from(data)), filename, localNumber, layout };
}

async function resolveAvrSource(
  prisma: PrismaClient,
  tenantId: string,
  document: {
    dealId: string;
    contractId: string | null;
    invoiceId: string | null;
    documentDate: Date;
    currency: string;
    sourceDataJson: unknown;
  },
): Promise<AvrSourceSnapshot> {
  const stored = asAvrSource(document.sourceDataJson);
  if (stored) return stored;
  const deal = await prisma.deal.findFirst({
    where: { id: document.dealId, tenantId },
    include: { items: { orderBy: { sortOrder: "asc" } }, company: true },
  });
  if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");
  const [profile, tenant, contract, invoice] = await Promise.all([
    documentOrganization(prisma, tenantId, deal.id, document.contractId),
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
    document.contractId
      ? prisma.contract.findFirst({ where: { id: document.contractId, tenantId } })
      : prisma.contract.findFirst({ where: { tenantId, dealId: deal.id }, orderBy: { createdAt: "desc" } }),
    document.invoiceId ? prisma.invoice.findFirst({ where: { id: document.invoiceId, tenantId } }) : null,
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
