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

function excelDate(value: string | Date | null | undefined) {
  const date = civilDateFromIso(value);
  if (!date) return null;
  return new Date(date.year, date.month - 1, date.day);
}

function sheetCells(ws: XLSX.WorkSheet) {
  return Object.keys(ws)
    .filter((key) => key[0] !== "!")
    .map((key) => ({ key, ...XLSX.utils.decode_cell(key) }));
}

function setCell(ws: XLSX.WorkSheet, addr: string, cell: XLSX.CellObject) {
  const prev = ws[addr] as XLSX.CellObject | undefined;
  ws[addr] = { ...(prev || {}), ...cell };
}

function clearCell(ws: XLSX.WorkSheet, addr: string) {
  const prev = ws[addr] as XLSX.CellObject | undefined;
  if (!prev) return;
  const kept: XLSX.CellObject = { t: "s", v: "" };
  if (prev.z) kept.z = prev.z;
  if (prev.s) kept.s = prev.s;
  ws[addr] = kept;
}

function shiftFormula(formula: string, start0: number, delta: number) {
  return formula.replace(/([A-Z]{1,3})(\d+)/g, (full, col: string, row: string) => {
    const n = Number(row);
    if (n - 1 < start0) return full;
    return `${col}${n + delta}`;
  });
}

function moveSheetRows(ws: XLSX.WorkSheet, start0: number, delta: number) {
  if (!delta) return;
  const cells = sheetCells(ws);
  const ordered =
    delta > 0 ? cells.sort((a, b) => b.r - a.r || b.c - a.c) : cells.sort((a, b) => a.r - b.r || a.c - b.c);
  for (const cell of ordered) {
    if (cell.r < start0) continue;
    const value = ws[cell.key] as XLSX.CellObject;
    const next = XLSX.utils.encode_cell({ r: cell.r + delta, c: cell.c });
    if (value?.f) value.f = shiftFormula(String(value.f), start0, delta);
    ws[next] = value;
    delete ws[cell.key];
  }
  const merges = (ws["!merges"] || []) as XLSX.Range[];
  for (const merge of merges) {
    if (merge.s.r >= start0) merge.s.r += delta;
    if (merge.e.r >= start0) merge.e.r += delta;
  }
  const rows = (ws["!rows"] || []) as Array<XLSX.RowInfo | undefined>;
  if (delta > 0) rows.splice(start0, 0, ...Array.from({ length: delta }, () => ({ hpt: 40.5 })));
  else rows.splice(start0 + delta, -delta);
  ws["!rows"] = rows;
  const range = XLSX.utils.decode_range(ws["!ref"] || "A1");
  range.e.r += delta;
  if (range.e.r < range.s.r) range.e.r = range.s.r;
  ws["!ref"] = XLSX.utils.encode_range(range);
}

function deleteSheetRows(ws: XLSX.WorkSheet, start1: number, count: number) {
  if (count <= 0) return;
  const start0 = start1 - 1;
  const end0 = start0 + count;
  for (const cell of sheetCells(ws)) {
    if (cell.r >= start0 && cell.r < end0) delete ws[cell.key];
  }
  ws["!merges"] = ((ws["!merges"] || []) as XLSX.Range[]).filter((merge) => merge.e.r < start0 || merge.s.r >= end0);
  moveSheetRows(ws, end0, -count);
}

function addItemMerges(ws: XLSX.WorkSheet, row1: number) {
  const r = row1 - 1;
  const merges = (ws["!merges"] ||= []) as XLSX.Range[];
  for (const [c1, c2] of ITEM_MERGE_COLS) {
    if (merges.some((merge) => merge.s.r === r && merge.s.c === c1 && merge.e.c === c2)) continue;
    merges.push({ s: { r, c: c1 }, e: { r, c: c2 } });
  }
}

function copyItemRow(ws: XLSX.WorkSheet, from1: number, to1: number) {
  const from0 = from1 - 1;
  const to0 = to1 - 1;
  for (const cell of sheetCells(ws).filter((item) => item.r === from0)) {
    const clone = JSON.parse(JSON.stringify(ws[cell.key])) as XLSX.CellObject;
    if (clone.f) clone.f = shiftFormula(String(clone.f), from0, to0 - from0);
    ws[XLSX.utils.encode_cell({ r: to0, c: cell.c })] = clone;
  }
  const rows = (ws["!rows"] ||= []) as Array<XLSX.RowInfo | undefined>;
  rows[to0] = { ...(rows[from0] || {}), hpt: rows[from0]?.hpt || 40.5 };
  addItemMerges(ws, to1);
}

function adjustItemRows(ws: XLSX.WorkSheet, itemCount: number) {
  const needed = Math.max(itemCount, 1);
  const totals1 = AVR_EXCEL_ITEM_START_ROW + TEMPLATE_ITEM_COUNT;
  if (needed > TEMPLATE_ITEM_COUNT) {
    const extra = needed - TEMPLATE_ITEM_COUNT;
    moveSheetRows(ws, totals1 - 1, extra);
    const source = AVR_EXCEL_ITEM_START_ROW + TEMPLATE_ITEM_COUNT - 1;
    for (let i = 0; i < extra; i += 1) copyItemRow(ws, source, source + 1 + i);
  } else if (needed < TEMPLATE_ITEM_COUNT) {
    deleteSheetRows(ws, AVR_EXCEL_ITEM_START_ROW + needed, TEMPLATE_ITEM_COUNT - needed);
  }
  for (let row = AVR_EXCEL_ITEM_START_ROW; row < AVR_EXCEL_ITEM_START_ROW + needed; row += 1) {
    addItemMerges(ws, row);
  }
}

function fillTemplate(ws: XLSX.WorkSheet, input: { localNumber: string; source: AvrSourceSnapshot }) {
  const layout = avrExcelLayout(input.source.items.length);
  const { source } = input;
  const buyerId = taxId(source.buyer);
  const sellerId = taxId(source.seller);
  const performed = excelDate(source.documentDate);

  setCell(ws, "E9", { t: "s", v: partyLine(source.buyer.legalName || source.buyer.name, source.buyer.legalAddress) });
  setCell(ws, "AQ9", { t: "s", v: buyerId ? ` ${buyerId}` : "", z: "@" });
  setCell(ws, "E11", { t: "s", v: partyLine(source.seller.legalName, source.seller.legalAddress) });
  if (/^\d{12}$/.test(sellerId)) setCell(ws, "AQ11", { t: "n", v: Number(sellerId), z: "0" });
  else setCell(ws, "AQ11", { t: "s", v: sellerId, z: "@" });
  setCell(ws, "F13", { t: "s", v: formatAvrContractBasis(source.contract) });
  setCell(ws, "AP15", { t: "s", v: input.localNumber, z: "00000000000" });
  if (performed) setCell(ws, "AT15", { t: "d", v: performed, z: "m/d/yy" });
  else setCell(ws, "AT15", { t: "s", v: formatDotDate(source.documentDate) });

  for (let i = 0; i < layout.itemCount; i += 1) {
    const row = layout.firstItemRow + i;
    const item = source.items[i];
    if (!item) {
      for (const col of ["A", "C", "N", "AC", "AF", "AI", "AN", "AS"]) clearCell(ws, `${col}${row}`);
      continue;
    }
    const amount = Number(item.amountWithoutVat ?? Number(item.quantity || 0) * Number(item.unitPrice || 0));
    setCell(ws, `A${row}`, { t: i === 0 ? "s" : "n", v: i === 0 ? String(i + 1) : i + 1, z: "0" });
    setCell(ws, `C${row}`, { t: "s", v: item.name || "" });
    if (performed) setCell(ws, `N${row}`, { t: "d", v: performed, z: "m/d/yy" });
    else setCell(ws, `N${row}`, { t: "s", v: formatDotDate(source.documentDate) });
    setCell(ws, `AC${row}`, { t: "s", v: paperAvrMeasureUnit(item.unit) });
    setCell(ws, `AF${row}`, { t: "n", v: item.quantity, z: "0" });
    setCell(ws, `AI${row}`, { t: "n", v: item.unitPrice, z: MONEY_FMT });
    setCell(ws, `AN${row}`, { t: "n", f: `AF${row}*AI${row}`, v: amount, z: MONEY_FMT });
    setCell(ws, `AS${row}`, { t: "n", v: item.vatAmount, z: MONEY_FMT });
  }

  const qty = source.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  setCell(ws, `AE${layout.totalsRow}`, { t: "s", v: "Итого" });
  setCell(ws, `AF${layout.totalsRow}`, {
    t: "n",
    f: `SUM(AF${layout.firstItemRow}:AF${layout.lastItemRow})`,
    v: qty,
    z: "0",
  });
  setCell(ws, `AI${layout.totalsRow}`, { t: "s", v: "x", z: MONEY_FMT });
  setCell(ws, `AN${layout.totalsRow}`, {
    t: "n",
    f: `SUM(AN${layout.firstItemRow}:AN${layout.lastItemRow})`,
    v: source.totals.amountWithoutVat,
    z: MONEY_FMT,
  });
  setCell(ws, `AS${layout.totalsRow}`, {
    t: "n",
    f: `SUM(AS${layout.firstItemRow}:AS${layout.lastItemRow})`,
    v: source.totals.vatAmount,
    z: MONEY_FMT,
  });
  setCell(ws, `T${layout.wordsRow}`, {
    t: "s",
    v: capitalizeRu(amountToKztWords(source.totals.amountWithoutVat || source.totals.totalAmount)),
  });
  setCell(ws, `F${layout.signRow}`, { t: "s", v: source.seller.directorPosition || "Директор" });
  setCell(ws, `R${layout.signRow}`, { t: "s", v: directorShortName(source.seller.directorName) });
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
  ws.views = [{ showGridLines: true, zoomScale: 85, state: "normal" }];
  ws.pageSetup = {
    ...ws.pageSetup,
    paperSize: 9,
    orientation: "landscape",
    fitToPage: false,
    horizontalCentered: true,
    margins: {
      left: 0.7086614173228347,
      right: 0.7086614173228347,
      top: 0.7480314960629921,
      bottom: 0.7480314960629921,
      header: 0.31496062992125984,
      footer: 0.31496062992125984,
    },
  };
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
    const font = cell.font || {};
    cell.font = { ...font, name: "Times New Roman", charset: 204, size: font.size || 9 };
  }
}

export async function renderAvrExcel(input: { number: string; source: AvrSourceSnapshot }) {
  const layout = avrExcelLayout(input.source.items.length);
  const localNumber = avrLocalNumber(input.number, input.source.documentDate);
  const filename = avrExcelFileName({ number: input.number, source: input.source });
  const parsed = XLSX.read(readFileSync(avrTemplatePath()), {
    type: "buffer",
    cellNF: true,
    cellDates: true,
    cellStyles: true,
    bookSST: true,
  });
  const sheetName = parsed.SheetNames[0] || AVR_EXCEL_SHEET_NAME;
  const template = parsed.Sheets[sheetName];
  if (!template) throw new ApiError(500, "avr_template_missing", "В шаблоне АВР нет листа");
  adjustItemRows(template, input.source.items.length);
  fillTemplate(template, { localNumber, source: input.source });
  parsed.SheetNames = [AVR_EXCEL_SHEET_NAME];
  parsed.Sheets = { [AVR_EXCEL_SHEET_NAME]: template };

  const raw = XLSX.write(parsed, { type: "buffer", bookType: "xlsx", cellStyles: true, bookSST: true });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(raw);
  const ws = wb.getWorksheet(AVR_EXCEL_SHEET_NAME) || wb.worksheets[0];
  if (!ws) throw new ApiError(500, "avr_template_missing", "Не удалось открыть шаблон АВР");
  restorePaperLook(ws, layout.totalsRow);
  ws.pageSetup.printArea = `A1:AW${layout.stampRow}`;
  const data = await wb.xlsx.writeBuffer();
  return { buffer: Buffer.from(data), filename, localNumber, layout };
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
