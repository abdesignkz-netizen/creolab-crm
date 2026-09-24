import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import type { PrismaClient } from "@creolab/db";
import { amountToKztWords } from "@creolab/contracts";
import type { Response } from "express";
import { PDFDocument, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { requireDocumentsAccess } from "../lib/access.ts";
import { resolveFont } from "./contractPdf.ts";
import {
  avrExcelFileName,
  avrLocalNumber,
  capitalizeRu,
  directorShortName,
  formatAvrContractBasis,
  formatDotDate,
  paperAvrMeasureUnit,
  resolveAvrSource,
} from "./avrExcel.ts";
import type { AvrSourceSnapshot } from "./avrMapper.ts";

const BLACK = rgb(0, 0, 0);
const WHITE = rgb(1, 1, 1);
const PAD = 1.35;
const BODY = 6.9;
const PARTY = 7.45;
const COL = {
  num: { l: 51, r: 78.5 },
  name: { l: 78.5, r: 205 },
  date: { l: 205, r: 277 },
  report: { l: 277, r: 373.5 },
  unit: { l: 373.5, r: 413 },
  qty: { l: 413, r: 449 },
  price: { l: 449, r: 497.5 },
  amount: { l: 497.5, r: 557.5 },
  vat: { l: 557.5, r: 617.5 },
};
const VLINES = [78.5, 205, 277, 373.5, 413, 449, 497.5, 557.5];
const ITEM_BANDS = [
  { bottom: 241.78, top: 276.28, valuesY: 256.44, nameY1: 261.6, nameY2: 252.14, indexY: 243.54 },
  { bottom: 207.28, top: 241.78, valuesY: 222.04, nameY1: 227.2, nameY2: 217.74, indexY: 209.14 },
  { bottom: 172.78, top: 207.28, valuesY: 187.64, nameY1: 192.8, nameY2: 183.34, indexY: 174.74 },
] as const;
const BODY_TOP = 276.28;
const BODY_BOTTOM = 163.28;
const TOTALS_TOP = 172.78;
const TOTALS_H = TOTALS_TOP - BODY_BOTTOM;
const ITEM_ROW_H = ITEM_BANDS[0].top - ITEM_BANDS[0].bottom;
const TOTALS_VALUES_OFFSET = 2;
const STROKE = 0.4;
const TEMPLATE_ITEMS = ITEM_BANDS.length;

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership;
}

function avrPdfTemplatePath() {
  const names = [
    path.resolve(import.meta.dirname, "../../assets/avr-form-r1.pdf"),
    path.resolve(process.cwd(), "apps/api/assets/avr-form-r1.pdf"),
    path.resolve(process.cwd(), "assets/avr-form-r1.pdf"),
  ];
  const found = names.find((file) => existsSync(file));
  if (!found) throw new ApiError(500, "avr_template_missing", "Не найден шаблон АВР PDF");
  return found;
}

let templateCache: { png: Buffer; footerPng: Buffer; width: number; height: number } | null = null;

function unusedRowShift(itemCount: number) {
  return Math.max(0, TEMPLATE_ITEMS - Math.max(itemCount, 1)) * ITEM_ROW_H;
}

async function avrTemplatePng() {
  if (templateCache) return templateCache;
  Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const bytes = new Uint8Array(readFileSync(avrPdfTemplatePath()));
  const pdf = await getDocument({ data: bytes, useSystemFonts: true }).promise;
  const page = await pdf.getPage(1);
  try {
    const scale = 3;
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
    const context = canvas.getContext("2d");
    await page.render({
      canvas: canvas as never,
      canvasContext: context as never,
      viewport,
      background: "rgb(255,255,255)",
    }).promise;
    const width = viewport.width / scale;
    const height = viewport.height / scale;
    const srcY = Math.max(0, Math.round(canvas.height - (BODY_BOTTOM / height) * canvas.height));
    const srcH = Math.max(1, canvas.height - srcY);
    const footer = createCanvas(canvas.width, srcH);
    footer.getContext("2d").drawImage(canvas, 0, srcY, canvas.width, srcH, 0, 0, canvas.width, srcH);
    templateCache = {
      png: canvas.toBuffer("image/png"),
      footerPng: footer.toBuffer("image/png"),
      width,
      height,
    };
    return templateCache;
  } finally {
    page.cleanup();
  }
}

function contentDisposition(filename: string) {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");
  return `attachment; filename="${ascii || "avr.pdf"}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function taxId(party: { bin: string; iin: string }) {
  return String(party.bin || party.iin || "").replace(/\D/g, "");
}

function partyLine(name: string, address: string) {
  return [name.trim(), address.trim()].filter(Boolean).join(", ");
}

function money(value: number) {
  return new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .format(value)
    .replace(/\u00a0/g, " ")
    .replace(/\u202f/g, " ");
}

function wrapLines(text: string, font: PDFFont, size: number, maxWidth: number) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [] as string[];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= maxWidth) current = next;
    else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function white(page: PDFPage, x: number, y: number, w: number, h: number) {
  if (w <= 0 || h <= 0) return;
  page.drawRectangle({ x, y, width: w, height: h, color: WHITE, borderWidth: 0 });
}

function cell(col: { l: number; r: number }, bottom: number, top: number) {
  return { x: col.l + PAD, y: bottom + PAD, w: col.r - col.l - PAD * 2, h: top - bottom - PAD * 2 };
}

function coverCell(page: PDFPage, col: { l: number; r: number }, bottom: number, top: number) {
  const box = cell(col, bottom, top);
  white(page, box.x, box.y, box.w, box.h);
}

function drawCentered(page: PDFPage, text: string, cx: number, y: number, font: PDFFont, size: number) {
  if (!text) return;
  const width = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: cx - width / 2, y, size, font, color: BLACK });
}

function drawRight(page: PDFPage, text: string, right: number, y: number, font: PDFFont, size: number) {
  if (!text) return;
  const width = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: right - width, y, size, font, color: BLACK });
}

function drawLeft(page: PDFPage, text: string, x: number, y: number, font: PDFFont, size: number) {
  if (!text) return;
  page.drawText(text, { x, y, size, font, color: BLACK });
}

function drawWrappedCenter(
  page: PDFPage,
  text: string,
  cx: number,
  y1: number,
  y2: number,
  font: PDFFont,
  size: number,
  maxWidth: number,
  maxLines = 3,
) {
  const lines = wrapLines(text, font, size, maxWidth).slice(0, maxLines);
  if (!lines.length) return;
  if (lines.length === 1) {
    drawCentered(page, lines[0], cx, (y1 + y2) / 2, font, size);
    return;
  }
  const step = (y1 - y2) / (lines.length - 1);
  lines.forEach((line, index) => drawCentered(page, line, cx, y1 - step * index, font, size));
}

function coverItemBand(page: PDFPage, bottom: number, top: number, includeDate = true) {
  coverCell(page, COL.num, bottom, top);
  coverCell(page, COL.name, bottom, top);
  if (includeDate) coverCell(page, COL.date, bottom, top);
  coverCell(page, COL.report, bottom, top);
  coverCell(page, COL.unit, bottom, top);
  coverCell(page, COL.qty, bottom, top);
  coverCell(page, COL.price, bottom, top);
  coverCell(page, COL.amount, bottom, top);
  coverCell(page, COL.vat, bottom, top);
}

function fillItem(
  page: PDFPage,
  band: { bottom: number; top: number; valuesY: number; nameY1: number; nameY2: number; indexY: number },
  index: number,
  item: AvrSourceSnapshot["items"][number],
  font: PDFFont,
  options: { size?: number; maxNameLines?: number } = {},
) {
  const size = options.size ?? BODY;
  const amount = Number(item.amountWithoutVat ?? Number(item.quantity || 0) * Number(item.unitPrice || 0));
  drawCentered(page, String(index + 1), (COL.num.l + COL.num.r) / 2, band.indexY, font, size);
  drawWrappedCenter(
    page,
    item.name || "",
    (COL.name.l + COL.name.r) / 2,
    band.nameY1,
    band.nameY2,
    font,
    size,
    COL.name.r - COL.name.l - 4,
    options.maxNameLines ?? 3,
  );
  drawCentered(page, paperAvrMeasureUnit(item.unit), (COL.unit.l + COL.unit.r) / 2, band.valuesY, font, size);
  drawRight(page, String(item.quantity), COL.qty.r - 2.2, band.indexY, font, size);
  drawRight(page, money(Number(item.unitPrice || 0)), COL.price.r - 2.2, band.valuesY, font, size);
  drawRight(page, money(amount), COL.amount.r - 2.2, band.valuesY, font, size);
  drawRight(page, money(Number(item.vatAmount || 0)), COL.vat.r - 2.2, band.valuesY, font, size);
}

function strokeH(page: PDFPage, y: number, x1 = COL.num.l, x2 = COL.vat.r) {
  page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: STROKE, color: BLACK });
}

function strokeV(page: PDFPage, x: number, y1: number, y2: number) {
  page.drawLine({ start: { x, y: y1 }, end: { x, y: y2 }, thickness: STROKE, color: BLACK });
}

function fillTotals(
  page: PDFPage,
  items: AvrSourceSnapshot["items"],
  totals: AvrSourceSnapshot["totals"],
  font: PDFFont,
  valuesY = BODY_BOTTOM + TOTALS_VALUES_OFFSET,
  bottom = BODY_BOTTOM,
  top = TOTALS_TOP,
) {
  const qty = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  coverCell(page, COL.qty, bottom, top);
  coverCell(page, COL.price, bottom, top);
  coverCell(page, COL.amount, bottom, top);
  coverCell(page, COL.vat, bottom, top);
  drawRight(page, String(qty), COL.qty.r - 2.2, valuesY, font, BODY);
  drawCentered(page, "x", (COL.price.l + COL.price.r) / 2, valuesY, font, BODY);
  drawRight(page, money(Number(totals.amountWithoutVat || 0)), COL.amount.r - 2.2, valuesY, font, BODY);
  drawRight(page, money(Number(totals.vatAmount || 0)), COL.vat.r - 2.2, valuesY, font, BODY);
}

function removeUnusedItemRows(
  page: PDFPage,
  items: AvrSourceSnapshot["items"],
  totals: AvrSourceSnapshot["totals"],
  font: PDFFont,
  footerImage: PDFImage,
  pageWidth: number,
  shift: number,
) {
  const lastBand = ITEM_BANDS[Math.max(items.length, 1) - 1];
  const totalsTop = lastBand.bottom;
  const totalsBottom = totalsTop - TOTALS_H;
  const valuesY = totalsBottom + TOTALS_VALUES_OFFSET;
  white(page, 0, 0, pageWidth, lastBand.bottom - 0.35);
  page.drawImage(footerImage, { x: 0, y: shift, width: pageWidth, height: BODY_BOTTOM });
  strokeH(page, totalsTop);
  strokeH(page, totalsBottom);
  strokeV(page, COL.num.l, totalsBottom, totalsTop);
  strokeV(page, COL.vat.r, totalsBottom, totalsTop);
  for (const x of VLINES) strokeV(page, x, totalsBottom, totalsTop);
  drawRight(page, "Итого", COL.qty.l - 3.2, valuesY, font, BODY);
  fillTotals(page, items, totals, font, valuesY, totalsBottom, totalsTop);
}

function fillExtraItems(
  page: PDFPage,
  items: AvrSourceSnapshot["items"],
  totals: AvrSourceSnapshot["totals"],
  font: PDFFont,
) {
  white(page, COL.num.l + PAD, TOTALS_TOP + PAD, COL.vat.r - COL.num.l - PAD * 2, BODY_TOP - TOTALS_TOP - PAD * 2);
  const rowH = (BODY_TOP - TOTALS_TOP) / items.length;
  for (let i = 1; i < items.length; i += 1) {
    const y = BODY_TOP - rowH * i;
    page.drawLine({
      start: { x: COL.num.l, y },
      end: { x: COL.vat.r, y },
      thickness: 0.4,
      color: BLACK,
    });
  }
  for (const x of VLINES) {
    page.drawLine({
      start: { x, y: TOTALS_TOP },
      end: { x, y: BODY_TOP },
      thickness: 0.4,
      color: BLACK,
    });
  }
  const size = rowH < 26 ? 6.05 : BODY;
  const nameShift = Math.min(4.2, Math.max(3.2, rowH / 6));
  items.forEach((item, index) => {
    const top = BODY_TOP - rowH * index;
    const bottom = top - rowH;
    const mid = (top + bottom) / 2 - 1.5;
    fillItem(
      page,
      { bottom, top, valuesY: mid, nameY1: mid + nameShift, nameY2: mid - nameShift, indexY: mid },
      index,
      item,
      font,
      { size, maxNameLines: 2 },
    );
  });
  fillTotals(page, items, totals, font);
}

export function avrPdfFileName(input: { number: string; source: AvrSourceSnapshot }) {
  return avrExcelFileName(input).replace(/\.xlsx$/i, ".pdf");
}

export async function renderAvrPdf(input: { number: string; source: AvrSourceSnapshot }) {
  const localNumber = avrLocalNumber(input.number, input.source.documentDate);
  const filename = avrPdfFileName({ number: input.number, source: input.source });
  const background = await avrTemplatePng();
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const page = pdf.addPage([background.width, background.height]);
  const image = await pdf.embedPng(background.png);
  page.drawImage(image, { x: 0, y: 0, width: background.width, height: background.height });
  const font = await pdf.embedFont(readFileSync(resolveFont("NotoSans-Regular.ttf")), { subset: true });
  const bold = await pdf.embedFont(readFileSync(resolveFont("NotoSans-Bold.ttf")), { subset: true });
  const { source } = input;
  const buyer = partyLine(source.buyer.legalName || source.buyer.name, source.buyer.legalAddress);
  const seller = partyLine(source.seller.legalName, source.seller.legalAddress);
  const buyerId = taxId(source.buyer);
  const sellerId = taxId(source.seller);
  const shift = source.items.length > TEMPLATE_ITEMS ? 0 : unusedRowShift(source.items.length);

  white(page, 103.2, 445.9, 362.5, 18.2);
  white(page, 534.9, 446.2, 81.2, 17.6);
  white(page, 103.2, 415.6, 362.5, 18.2);
  white(page, 534.9, 415.7, 81.2, 17.6);
  white(page, 115.9, 396.2, 272, 9.8);
  white(page, 522.9, 366.7, 45.2, 18.2);
  white(page, 570.9, 366.7, 45.2, 18.2);

  drawWrappedCenter(page, buyer, 284.5, 456.82, 446.5, bold, PARTY, 368);
  drawCentered(page, buyerId ? ` ${buyerId}` : "", 575.5, 452.52, bold, PARTY);
  drawWrappedCenter(page, seller, 284.5, 426.72, 416.4, bold, PARTY, 368);
  drawCentered(page, sellerId, 575.5, 422.42, bold, PARTY);
  drawLeft(page, formatAvrContractBasis(source.contract), 116.1, 397.48, font, BODY);
  drawCentered(page, localNumber, 545.5, 376.84, bold, BODY);
  drawCentered(page, formatDotDate(source.documentDate), 593.5, 376.84, bold, BODY);

  if (source.items.length > TEMPLATE_ITEMS) {
    fillExtraItems(page, source.items, source.totals, font);
  } else {
    const used = Math.max(source.items.length, 1);
    for (const band of ITEM_BANDS.slice(0, used)) coverItemBand(page, band.bottom, band.top);
    source.items.forEach((item, index) => fillItem(page, ITEM_BANDS[index], index, item, font));
    if (shift > 0) {
      const footerImage = await pdf.embedPng(background.footerPng);
      removeUnusedItemRows(page, source.items, source.totals, font, footerImage, background.width, shift);
    } else {
      fillTotals(page, source.items, source.totals, font);
    }
  }

  white(page, 365, 139.6 + shift, 253.5, 14.2);
  white(page, 118, 86.6 + shift, 52, 10.2);
  white(page, 247.4, 86.6 + shift, 78, 10.2);
  drawCentered(
    page,
    capitalizeRu(amountToKztWords(source.totals.amountWithoutVat || source.totals.totalAmount)),
    441.8,
    146.36 + shift,
    font,
    BODY,
  );
  drawCentered(page, source.seller.directorPosition || "Директор", 145.1, 90.46 + shift, font, BODY);
  drawCentered(page, directorShortName(source.seller.directorName), 286.5, 90.46 + shift, font, BODY);

  return { buffer: Buffer.from(await pdf.save()), filename, localNumber };
}

export async function sendAvrPdf(prisma: PrismaClient, auth: AuthContext, documentId: string, res: Response) {
  requireDocumentsAccess(auth);
  const membership = requireTenant(auth);
  const document = await prisma.electronicDocument.findFirst({
    where: { id: documentId, tenantId: membership.tenantId },
  });
  if (!document) throw new ApiError(404, "not_found", "Документ не найден");
  if (document.type !== "AVR") {
    throw new ApiError(422, "not_avr", "PDF-форма доступна только для АВР");
  }
  if (document.externalSystem === "BASQAR") {
    const { sendAvrSigningPdf } = await import("./avrSigningService.ts");
    return sendAvrSigningPdf(prisma, res, { auth, id: documentId });
  }
  const source = await resolveAvrSource(prisma, membership.tenantId, document);
  const { buffer, filename } = await renderAvrPdf({ number: document.number, source });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", contentDisposition(filename));
  res.setHeader("Cache-Control", "no-store");
  res.send(buffer);
}
