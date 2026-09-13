import type { PrismaClient } from "@creolab/db";
import {
  amountToKztWords,
  esfMeasureUnitSymbol,
  resolveEsfMeasureUnitCode,
} from "@creolab/contracts";
import ExcelJS from "exceljs";
import type { Response } from "express";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { AVR_SOURCE_KIND, mapAvrSource, type AvrSourceSnapshot } from "./avrMapper.ts";
import { serializeDealItem } from "./dealItemService.ts";
import { documentOrganization } from "./documentOrganization.ts";

export const AVR_EXCEL_SHEET_NAME = "Акт выполненных работ";
export const AVR_EXCEL_ITEM_START_ROW = 20;

const FONT = "Times New Roman";
const MONEY_FMT = "#,##0.00";
const THIN = { style: "thin" as const, color: { argb: "FF000000" } };
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
const COL_WIDTHS = [
  4.5,
  ...Array(9).fill(3.5),
  1.75,
  ...Array(5).fill(3.5),
  1.75,
  1.75,
  ...Array(10).fill(3.5),
  4.5,
  ...Array(5).fill(3.5),
  1.75,
  3.5,
  3.5,
  1.75,
  ...Array(11).fill(3.5),
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

function font(size: number, extra: Partial<ExcelJS.Font> = {}): Partial<ExcelJS.Font> {
  return { name: FONT, size, charset: 204, ...extra };
}

function align(
  cell: ExcelJS.Cell,
  horizontal: ExcelJS.Alignment["horizontal"],
  vertical: ExcelJS.Alignment["vertical"] = "middle",
  wrap = true,
) {
  cell.alignment = { horizontal, vertical, wrapText: wrap };
}

function style(cell: ExcelJS.Cell, size: number, extra: Partial<ExcelJS.Font> = {}) {
  cell.font = font(size, extra);
}

function grid(ws: ExcelJS.Worksheet, r1: number, c1: number, r2: number, c2: number) {
  for (let row = r1; row <= r2; row += 1) {
    for (let col = c1; col <= c2; col += 1) {
      ws.getCell(row, col).border = { top: THIN, left: THIN, bottom: THIN, right: THIN };
    }
  }
}

function mergeAll(ws: ExcelJS.Worksheet, ranges: string[]) {
  for (const range of ranges) ws.mergeCells(range);
}

function itemMerges(row: number) {
  return [
    `A${row}:B${row}`,
    `C${row}:M${row}`,
    `N${row}:T${row}`,
    `U${row}:AB${row}`,
    `AC${row}:AE${row}`,
    `AF${row}:AH${row}`,
    `AI${row}:AM${row}`,
    `AN${row}:AR${row}`,
    `AS${row}:AW${row}`,
  ];
}

function contentDisposition(filename: string) {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");
  return `attachment; filename="${ascii || "avr.xlsx"}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
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

function fillStaticHeader(ws: ExcelJS.Worksheet, input: { localNumber: string; source: AvrSourceSnapshot }) {
  const { source, localNumber } = input;
  const header: Array<[string, string, number, ExcelJS.Alignment["horizontal"], boolean?]> = [
    ["AN1", "Приложение 50", 8, "right"],
    ["AN2", "к приказу Министра финансов", 8, "right"],
    ["AN3", "Республики Казахстан", 8, "right"],
    ["AN4", "от 20 декабря 2012 года № 562", 8, "right"],
    ["AW6", "Форма Р-1", 10, "right", true],
    ["AS8", "ИИН/БИН", 8, "center"],
    ["A9", "Заказчик", 10, "left", true],
    ["E9", partyLine(source.buyer.legalName || source.buyer.name, source.buyer.legalAddress), 9, "left"],
    ["AQ9", taxId(source.buyer), 10, "center"],
    ["E10", "полное наименование, адрес, данные о средствах связи", 7, "left"],
    ["A11", "Исполнитель", 10, "left", true],
    ["E11", partyLine(source.seller.legalName, source.seller.legalAddress), 9, "left"],
    ["AQ11", taxId(source.seller), 10, "center"],
    ["E12", "полное наименование, адрес, данные о средствах связи", 7, "left"],
    ["A13", "Договор (контракт) ", 9, "left"],
    ["F13", formatAvrContractBasis(source.contract), 9, "left"],
    ["AP13", "Номер документа", 8, "center"],
    ["AT13", "Дата составления", 8, "center"],
    ["A15", "АКТ ВЫПОЛНЕННЫХ РАБОТ (ОКАЗАННЫХ УСЛУГ)", 12, "center", true],
    ["AP15", localNumber, 11, "center", true],
    ["AT15", formatDotDate(source.documentDate), 11, "center", true],
  ];
  for (const [addr, value, size, horizontal, bold] of header) {
    const cell = ws.getCell(addr);
    cell.value = value;
    style(cell, size, bold ? { bold: true } : {});
    align(cell, horizontal);
  }
  ws.getCell("E10").font = font(7, { italic: true, color: { argb: "FF666666" } });
  ws.getCell("E12").font = font(7, { italic: true, color: { argb: "FF666666" } });

  const tableHeads: Array<[string, string]> = [
    [
      "A17",
      "Номер по порядку",
    ],
    [
      "C17",
      "Наименование работ (услуг)\n(в разрезе их подвидов в соответствии с технической спецификацией, заданием, графиком выполнения работ (услуг) при их наличии)",
    ],
    ["N17", "Дата выполнения работ\n(оказания услуг)"],
    [
      "U17",
      "Сведения об отчете о научных исследованиях, маркетинговых, консультационных и прочих услугах (дата, номер, количество страниц) (при их наличии)",
    ],
    ["AC17", "Единица измерения"],
    ["AF17", "Выполнено работ (оказано услуг)"],
    ["AF18", "количество"],
    ["AI18", "цена за единицу"],
    ["AN18", "Сумма без НДС, в KZT"],
    ["AS18", "в том числе НДС, в KZT"],
  ];
  for (const [addr, value] of tableHeads) {
    const cell = ws.getCell(addr);
    cell.value = value;
    style(cell, 8, { bold: true });
    align(cell, "center");
  }
  const numbers = [
    ["A19", 1],
    ["C19", 2],
    ["N19", 3],
    ["U19", 4],
    ["AC19", 5],
    ["AF19", 6],
    ["AI19", 7],
    ["AN19", 8],
    ["AS19", 9],
  ] as const;
  for (const [addr, value] of numbers) {
    const cell = ws.getCell(addr);
    cell.value = value;
    style(cell, 8, { bold: true });
    align(cell, "center");
  }
}

function fillItemRow(
  ws: ExcelJS.Worksheet,
  row: number,
  item: AvrSourceSnapshot["items"][number] | undefined,
  index: number,
  performedDate: string,
) {
  ws.getRow(row).height = 40.5;
  const cells = {
    A: item ? String(index + 1) : "",
    C: item?.name || "",
    N: item ? performedDate : "",
    AC: item ? paperAvrMeasureUnit(item.unit) : "",
  };
  for (const [addr, value] of Object.entries(cells)) {
    const cell = ws.getCell(`${addr}${row}`);
    cell.value = value;
    style(cell, 9);
    align(cell, addr === "C" ? "left" : "center");
  }
  const qty = ws.getCell(`AF${row}`);
  const price = ws.getCell(`AI${row}`);
  const amount = ws.getCell(`AN${row}`);
  const vat = ws.getCell(`AS${row}`);
  for (const cell of [qty, price, amount, vat]) {
    style(cell, 9);
    align(cell, "center");
    cell.numFmt = MONEY_FMT;
  }
  qty.numFmt = "0.###";
  if (!item) return;
  qty.value = item.quantity;
  price.value = item.unitPrice;
  amount.value = { formula: `AF${row}*AI${row}`, result: item.amountWithoutVat };
  vat.value = item.vatAmount;
  vat.numFmt = MONEY_FMT;
  amount.numFmt = MONEY_FMT;
  price.numFmt = MONEY_FMT;
}

function fillTotals(ws: ExcelJS.Worksheet, layout: ReturnType<typeof avrExcelLayout>, source: AvrSourceSnapshot) {
  const { totalsRow, firstItemRow, lastItemRow } = layout;
  const label = ws.getCell(`AE${totalsRow}`);
  label.value = "Итого";
  style(label, 9, { bold: true });
  align(label, "right", "middle", false);

  const qty = ws.getCell(`AF${totalsRow}`);
  const cross = ws.getCell(`AI${totalsRow}`);
  const amount = ws.getCell(`AN${totalsRow}`);
  const vat = ws.getCell(`AS${totalsRow}`);
  qty.value = {
    formula: `SUM(AF${firstItemRow}:AF${lastItemRow})`,
    result: source.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
  };
  cross.value = "x";
  amount.value = {
    formula: `SUM(AN${firstItemRow}:AN${lastItemRow})`,
    result: source.totals.amountWithoutVat,
  };
  vat.value = {
    formula: `SUM(AS${firstItemRow}:AS${lastItemRow})`,
    result: source.totals.vatAmount,
  };
  for (const cell of [qty, cross, amount, vat]) {
    style(cell, 9, { bold: true });
    align(cell, "center");
  }
  qty.numFmt = "0.###";
  amount.numFmt = MONEY_FMT;
  vat.numFmt = MONEY_FMT;
}

function fillFooter(ws: ExcelJS.Worksheet, layout: ReturnType<typeof avrExcelLayout>, source: AvrSourceSnapshot) {
  const { wordsRow, captionRow, appendixRow, appendixContRow, signRow, signHintRow, signDateRow, stampRow } = layout;
  const stocks = ws.getCell(`A${wordsRow}`);
  stocks.value = "Сведения об использовании запасов, полученных от заказчика";
  style(stocks, 8);
  align(stocks, "left", "middle", true);

  const words = ws.getCell(`T${wordsRow}`);
  words.value = capitalizeRu(amountToKztWords(source.totals.amountWithoutVat || source.totals.totalAmount));
  style(words, 10, { bold: true });
  align(words, "left");

  const caption = ws.getCell(`Q${captionRow}`);
  caption.value = "наименование, количество, стоимость";
  caption.font = font(7, { italic: true, color: { argb: "FF666666" } });
  align(caption, "left");

  const appendix = ws.getCell(`A${appendixRow}`);
  appendix.value =
    "Приложение: Перечень документации, в том числе отчет(ы) о маркетинговых, научных исследованиях, консультационных и прочих услугах (обязательны при его";
  style(appendix, 8);
  align(appendix, "left");
  const appendix2 = ws.getCell(`A${appendixContRow}`);
  appendix2.value = "(их) наличии) на";
  style(appendix2, 8);
  align(appendix2, "left", "middle", false);
  const pages = ws.getCell(`F${appendixContRow}`);
  pages.value = "страниц";
  style(pages, 8);
  align(pages, "left", "middle", false);

  const signCells: Array<[string, string, number, boolean?]> = [
    [`A${signRow}`, "Сдал (Исполнитель)", 9, true],
    [`F${signRow}`, source.seller.directorPosition || "Директор", 9],
    [`K${signRow}`, "/", 12],
    [`Q${signRow}`, "/", 12],
    [`R${signRow}`, directorShortName(source.seller.directorName), 9],
    [`AA${signRow}`, "Принял (Заказчик)", 9, true],
    [`AK${signRow}`, "/", 12],
    [`AQ${signRow}`, "/", 12],
    [`F${signHintRow}`, "должность", 7],
    [`L${signHintRow}`, "подпись", 7],
    [`R${signHintRow}`, "расшифровка подписи", 7],
    [`AF${signHintRow}`, "должность", 7],
    [`AL${signHintRow}`, "подпись", 7],
    [`AR${signHintRow}`, "расшифровка подписи", 7],
    [`AG${signDateRow}`, "Дата подписания (принятия) работ(услуг)", 8],
    [`A${stampRow}`, "М.П.", 9, true],
    [`AB${stampRow}`, "М.П.", 9, true],
  ];
  for (const [addr, value, size, bold] of signCells) {
    const cell = ws.getCell(addr);
    cell.value = value;
    style(cell, size, bold ? { bold: true } : {});
    align(cell, addr.includes("K") || addr.includes("Q") || addr.startsWith("AK") || addr.startsWith("AQ") ? "center" : "left");
  }
  for (const addr of [`F${signHintRow}`, `L${signHintRow}`, `R${signHintRow}`, `AF${signHintRow}`, `AL${signHintRow}`, `AR${signHintRow}`]) {
    ws.getCell(addr).font = font(7, { italic: true, color: { argb: "FF666666" } });
    align(ws.getCell(addr), "center");
  }
}

export async function renderAvrExcel(input: { number: string; source: AvrSourceSnapshot }) {
  const layout = avrExcelLayout(input.source.items.length);
  const localNumber = avrLocalNumber(input.number, input.source.documentDate);
  const filename = avrExcelFileName({ number: input.number, source: input.source });
  const wb = new ExcelJS.Workbook();
  wb.creator = "CREOLAB CRM";
  wb.created = new Date("2026-01-01T00:00:00Z");
  const ws = wb.addWorksheet(AVR_EXCEL_SHEET_NAME, {
    views: [{ showGridLines: false, zoomScale: 85 }],
    pageSetup: {
      paperSize: 9,
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 1,
      horizontalCentered: true,
      margins: { left: 0.4, right: 0.4, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
    },
    properties: { defaultRowHeight: 15, defaultColWidth: 3.5 },
  });
  ws.columns = COL_WIDTHS.map((width) => ({ width }));

  const { totalsRow, wordsRow, captionRow, appendixRow, signRow, signHintRow, stampRow } = layout;
  mergeAll(ws, [
    "AN1:AW1",
    "AN2:AW2",
    "AN3:AW3",
    "AN4:AW4",
    "A7:AJ7",
    "A9:D9",
    "E9:AJ9",
    "AQ9:AW9",
    "E10:AJ10",
    "A11:D11",
    "E11:AJ11",
    "AQ11:AW11",
    "E12:AJ12",
    "A13:E13",
    "F13:AC13",
    "AP13:AS14",
    "AT13:AW14",
    "A15:AG15",
    "AP15:AS15",
    "AT15:AW15",
    "A17:B18",
    "C17:M18",
    "N17:T18",
    "U17:AB18",
    "AC17:AE18",
    "AF17:AW17",
    "AF18:AH18",
    "AI18:AM18",
    "AN18:AR18",
    "AS18:AW18",
    "A19:B19",
    "C19:M19",
    "N19:T19",
    "U19:AB19",
    "AC19:AE19",
    "AF19:AH19",
    "AI19:AM19",
    "AN19:AR19",
    "AS19:AW19",
    ...Array.from({ length: layout.itemCount }, (_, index) => itemMerges(AVR_EXCEL_ITEM_START_ROW + index)).flat(),
    `AF${totalsRow}:AH${totalsRow}`,
    `AI${totalsRow}:AM${totalsRow}`,
    `AN${totalsRow}:AR${totalsRow}`,
    `AS${totalsRow}:AW${totalsRow}`,
    `T${wordsRow}:AW${wordsRow}`,
    `Q${captionRow}:AW${captionRow}`,
    `A${appendixRow}:AW${appendixRow}`,
    `F${signRow}:J${signRow}`,
    `R${signRow}:X${signRow}`,
    `F${signHintRow}:J${signHintRow}`,
    `L${signHintRow}:P${signHintRow}`,
    `R${signHintRow}:X${signHintRow}`,
    `AF${signHintRow}:AJ${signHintRow}`,
    `AL${signHintRow}:AP${signHintRow}`,
    `AR${signHintRow}:AW${signHintRow}`,
  ]);

  fillStaticHeader(ws, { localNumber, source: input.source });
  const performedDate = formatDotDate(input.source.documentDate);
  for (let i = 0; i < layout.itemCount; i += 1) {
    fillItemRow(ws, AVR_EXCEL_ITEM_START_ROW + i, input.source.items[i], i, performedDate);
  }
  fillTotals(ws, layout, input.source);
  fillFooter(ws, layout, input.source);

  ws.getRow(9).height = 24;
  ws.getRow(11).height = 24.75;
  ws.getRow(17).height = 66;
  ws.getRow(18).height = 27;
  grid(ws, 9, 43, 9, 49);
  grid(ws, 11, 43, 11, 49);
  grid(ws, 13, 42, 15, 49);
  grid(ws, 17, 1, totalsRow, 49);
  ws.pageSetup.printArea = `A1:AW${stampRow}`;

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
