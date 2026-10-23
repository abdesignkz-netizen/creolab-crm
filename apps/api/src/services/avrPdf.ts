import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import type { PrismaClient } from "@creolab/db";
import { amountToKztWords } from "@creolab/contracts";
import type { Response } from "express";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
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
import { expandLegalFormName, type AvrSourceSnapshot } from "./avrMapper.ts";

const BLACK = rgb(0, 0, 0);
const WHITE = rgb(1, 1, 1);
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
const BODY_TOP = 276.28;
const BODY_BOTTOM = 163.28;
const TOTALS_TOP = 172.78;
const TOTALS_H = TOTALS_TOP - BODY_BOTTOM;
const ITEM_ROW_H = 34.5;
const TOTALS_VALUES_OFFSET = 2;
const STROKE = 0.4;

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

let templateCache: { png: Buffer; width: number; height: number } | null = null;

async function avrTemplatePng() {
  if (templateCache) return templateCache;
  Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const bytes = new Uint8Array(readFileSync(avrPdfTemplatePath()));
  const task = getDocument({ data: bytes, useSystemFonts: true });
  const pdf = await task.promise;
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
    templateCache = {
      png: canvas.toBuffer("image/png"),
      width,
      height,
    };
    return templateCache;
  } finally {
    page.cleanup();
    await task.destroy();
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
  return [expandLegalFormName(name), address.trim()].filter(Boolean).join(", ");
}

function money(value: number) {
  return new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .format(value)
    .replace(/\u00a0/g, " ")
    .replace(/\u202f/g, " ");
}

function wrapLines(text: string, font: PDFFont, size: number, maxWidth: number) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean).flatMap(word => {
    const chunks:string[]=[];let part="";
    for (const char of word) {
      if(part && font.widthOfTextAtSize(part+char,size)>maxWidth){chunks.push(part);part="";}
      part+=char;
    }
    if(part)chunks.push(part);
    return chunks;
  });
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
  let lines = wrapLines(text, font, size, maxWidth);
  while (lines.length > maxLines && size > 5) {size-=0.25;lines=wrapLines(text,font,size,maxWidth);}
  if (lines.length > maxLines) throw new ApiError(422,"avr_pdf_text_too_long","Текст реквизитов слишком длинный для бланка АВР. Сократите его без потери реквизитов.");
  if (!lines.length) return;
  if (lines.length === 1) {
    drawCentered(page, lines[0], cx, (y1 + y2) / 2, font, size);
    return;
  }
  const step = (y1 - y2) / (lines.length - 1);
  lines.forEach((line, index) => drawCentered(page, line, cx, y1 - step * index, font, size));
}

function coverItemBand(page: PDFPage, bottom: number, top: number) {
  white(page, COL.num.l - 0.3, bottom - 0.3, COL.vat.r - COL.num.l + 0.6, top - bottom + 0.6);
  strokeH(page, bottom);strokeH(page, top);
  for (const x of [COL.num.l, ...VLINES, COL.vat.r]) strokeV(page, x, bottom, top);
}

function fillItem(
  page: PDFPage,
  band: { bottom: number; top: number; valuesY: number; nameY1: number; nameY2: number; indexY: number },
  index: number,
  item: AvrSourceSnapshot["items"][number],
  font: PDFFont,
  options: { size?: number; maxNameLines?: number; continuation?: boolean; omitAmounts?: boolean } = {},
) {
  const size = options.size ?? BODY;
  const amount = Number(item.amountWithoutVat ?? Number(item.quantity || 0) * Number(item.unitPrice || 0));
  drawCentered(page, options.continuation ? "прод." : String(index + 1), (COL.num.l + COL.num.r) / 2, band.valuesY, font, size);
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
  if (options.omitAmounts) return;
  drawCentered(page, paperAvrMeasureUnit(item.unit), (COL.unit.l + COL.unit.r) / 2, band.valuesY, font, size);
  drawRight(page, String(item.quantity), COL.qty.r - 2.2, band.valuesY, font, size);
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
  coverItemBand(page, bottom, top);
  drawRight(page, "Итого", COL.qty.l - 3.2, valuesY, font, BODY);
  drawRight(page, String(qty), COL.qty.r - 2.2, valuesY, font, BODY);
  drawCentered(page, "x", (COL.price.l + COL.price.r) / 2, valuesY, font, BODY);
  drawRight(page, money(Number(totals.amountWithoutVat || 0)), COL.amount.r - 2.2, valuesY, font, BODY);
  drawRight(page, money(Number(totals.vatAmount || 0)), COL.vat.r - 2.2, valuesY, font, BODY);
}

function drawFooter(page: PDFPage, source: AvrSourceSnapshot, bottom: number, font: PDFFont) {
  const words = capitalizeRu(amountToKztWords(source.totals.amountWithoutVat));
  const wordsSize = Math.min(BODY, 565 / Math.max(font.widthOfTextAtSize(`Всего без НДС: ${words}`, 1), 1));
  drawRight(page, `Всего без НДС: ${words}`, COL.vat.r, bottom - 12, font, wordsSize);
  drawLeft(page, "Сведения об использовании запасов, полученных от заказчика", 53, bottom - 29, font, BODY);
  strokeH(page, bottom - 31, 365, 617.5);
  drawCentered(page, "наименование, количество, стоимость", 490, bottom - 40, font, 5.8);
  drawLeft(page, "Приложение: перечень документации, в том числе отчётов о научных, маркетинговых, консультационных и прочих услугах", 53, bottom - 54, font, BODY);
  drawLeft(page, "(при их наличии) на ______ страницах", 53, bottom - 65, font, BODY);
  for (const [label, party, x] of [["Сдал (Исполнитель)", source.seller, 53], ["Принял (Заказчик)", source.buyer, 354]] as const) {
    drawLeft(page, label, x, bottom - 83, font, BODY);
    const y = bottom - 99;
    for (const [start, end, caption] of [[x,x+68,"должность"],[x+77,x+135,"подпись"],[x+144,x+263,"расшифровка подписи"]] as const) {
      strokeH(page, y, start, end);drawCentered(page, caption, (start+end)/2, y-9, font, 5.8);
    }
    const position=party.directorPosition||"";
    const name=directorShortName(party.directorName);
    drawCentered(page, position, x+34, y+3, font, Math.min(BODY,66/Math.max(font.widthOfTextAtSize(position,1),1)));
    drawCentered(page, name, x+203.5, y+3, font, Math.min(BODY,117/Math.max(font.widthOfTextAtSize(name,1),1)));
    drawLeft(page, "М.П.", x, y-29, font, BODY);
  }
  drawLeft(page, "Дата подписания (принятия) работ ____________________", 415, bottom-134, font, BODY);
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
  const image = await pdf.embedPng(background.png);
  const font = await pdf.embedFont(readFileSync(resolveFont("NotoSans-Regular.ttf")), { subset: true });
  const bold = await pdf.embedFont(readFileSync(resolveFont("NotoSans-Bold.ttf")), { subset: true });
  const { source } = input;
  const buyer = partyLine(source.buyer.legalName || source.buyer.name, source.buyer.legalAddress);
  const seller = partyLine(source.seller.legalName, source.seller.legalAddress);
  const buyerId = taxId(source.buyer);
  const sellerId = taxId(source.seller);
  type PrintRow = { item: AvrSourceSnapshot["items"][number]; index: number; height: number; lines: number; continuation: boolean; omitAmounts: boolean };
  const pages: PrintRow[][] = [[]];
  let used = 0;
  for (const [index, item] of source.items.entries()) {
    const lines = wrapLines(item.name, font, BODY, COL.name.r-COL.name.l-4);
    for (let offset=0; offset<Math.max(lines.length,1); offset+=12) {
      const part=lines.slice(offset,offset+12);
      const height=Math.max(ITEM_ROW_H,part.length*8.5+8);
      if (used+height>BODY_TOP-TOTALS_TOP+0.01 && used) { pages.push([]);used=0; }
      pages.at(-1)!.push({item:{...item,name:part.join(" ")},index,height,lines:part.length,continuation:offset>0,omitAmounts:offset+12<lines.length});
      used+=height;
    }
  }
  for (const [pageIndex, rows] of pages.entries()) {
    const page=pdf.addPage([background.width,background.height]);
    page.drawImage(image,{x:0,y:0,width:background.width,height:background.height});
  // Clear descenders of the template's second address line as well as its underline.
  white(page, 102.2, 443.8, 366, 22.1);
  strokeH(page, 444.35, 102.34, 467.84);
  white(page, 534.9, 446.2, 81.2, 17.6);
  white(page, 102.2, 413.7, 366, 21.9);
  strokeH(page, 414.25, 102.34, 467.84);
  white(page, 534.9, 415.7, 81.2, 17.6);
  white(page, 115.9, 396.2, 272, 9.8);
  white(page, 522.9, 366.7, 45.2, 18.2);
  white(page, 570.9, 366.7, 45.2, 18.2);

  drawWrappedCenter(page, buyer, 284.5, 456.82, 446.5, bold, PARTY, 368);
  drawCentered(page, buyerId ? ` ${buyerId}` : "", 575.5, 452.52, bold, PARTY);
  drawWrappedCenter(page, seller, 284.5, 426.72, 416.4, bold, PARTY, 368);
  drawCentered(page, sellerId, 575.5, 422.42, bold, PARTY);
  drawLeft(page, formatAvrContractBasis(source.contract), 116.1, 397.48, font, BODY);
  // Restore the lower edge erased by the value masks in the raster template.
  page.drawLine({ start: { x: 522, y: 374.5 }, end: { x: 618.5, y: 374.5 }, thickness: 0.65, color: BLACK });
  const numberSize = Math.min(BODY, 43 / Math.max(bold.widthOfTextAtSize(localNumber, 1), 1));
  drawCentered(page, localNumber, 545.5, 376.84, bold, numberSize);
  drawCentered(page, formatDotDate(source.documentDate), 593.5, 376.84, bold, BODY);

  // The template contains sample values: clear the entire body and footer,
  // including glyphs touching a grid line, before drawing the document data.
  white(page,0,0,background.width,BODY_TOP+0.1);
  let top=BODY_TOP;
  if (!rows.length) {coverItemBand(page,top-ITEM_ROW_H,top);top-=ITEM_ROW_H;}
  for (const row of rows) {
    const bottom=top-row.height;
    coverItemBand(page,bottom,top);
    const mid=(top+bottom)/2-2;
    const textHeight=Math.max(0,row.lines-1)*8.5;
    fillItem(page,{bottom,top,valuesY:mid,nameY1:mid+textHeight/2,nameY2:mid-textHeight/2,indexY:mid},row.index,row.item,font,{maxNameLines:12,continuation:row.continuation,omitAmounts:row.omitAmounts});
    top=bottom;
  }
  if(pageIndex===pages.length-1) {
    fillTotals(page,source.items,source.totals,font,top-TOTALS_H+TOTALS_VALUES_OFFSET,top-TOTALS_H,top);
    drawFooter(page,source,top-TOTALS_H,font);
  } else drawLeft(page,"Продолжение акта на следующей странице",53,top-14,font,BODY);
  drawRight(page,`${localNumber} · ${pageIndex+1} / ${pages.length}`,617.5,18,font,BODY);
  }

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
