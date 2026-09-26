import { amountToKztWords } from "@creolab/contracts";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import PDFDocument from "pdfkit";
import {
  collectPdf,
  resolveFont,
} from "./contractPdf.ts";
import {
  capitalizeRu,
  directorShortName,
  formatDotDate,
  formatFilenameDayMonthYear,
  formatQuotedDayMonthYear,
  paperAvrMeasureUnit,
} from "./avrExcel.ts";

export type InvoicePdfItem = {
  name: string;
  code?: string | null;
  quantity: number;
  unit: string;
  unitPrice: number;
  amountWithoutVat?: number;
  totalAmount: number;
};

export type InvoicePdfInput = {
  number: string;
  date: Date;
  dueDate?: Date | null;
  contractNumber: string;
  contractDate: Date | string | null;
  withoutContract?: boolean;
  dealName?: string;
  amountWithoutVat: number;
  vatRate: number | null;
  vatAmount: number;
  totalAmount: number;
  itemsTotalWithoutVat?: number;
  itemsVatAmount?: number;
  itemsTotalAmount?: number;
  paymentPercent?: number;
  paymentKind?: "PREPAYMENT" | "BALANCE" | "ADDITIONAL" | "FULL";
  sellerName: string;
  sellerBin: string;
  sellerAddress: string;
  sellerPhone?: string;
  sellerIban: string;
  sellerBankName: string;
  sellerBik: string;
  sellerKbe?: string;
  sellerKnp?: string;
  sellerDirector?: string;
  sellerEmail?: string;
  buyerName: string;
  buyerBin: string;
  buyerAddress: string;
  buyerPhone?: string;
  buyerEmail?: string;
  withStamp?: boolean;
  stampPng?: Buffer | null;
  signaturePng?: Buffer | null;
  items: InvoicePdfItem[];
};

const BLACK = "#000000";
const NOTICE =
  "Внимание!Оплата данного счета означает согласие с условиями поставки товара.Уведомление об оплате обязательно, в противном случае не гарантируется наличие товара на складе.Товар отпускается по факту прихода денег на р / с Поставщика, самовывозом, при наличии доверенности и документов удостоверяющих личность.";

const COLS = [
  { key: "num", width: 40 },
  { key: "code", width: 48 },
  { key: "name", width: 186 },
  { key: "qty", width: 46 },
  { key: "unit", width: 62 },
  { key: "price", width: 82 },
  { key: "amount", width: 81 },
] as const;

function money(value: number) {
  return new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .format(value)
    .replace(/\u00a0/g, " ")
    .replace(/\u202f/g, " ");
}

function qty(value: number) {
  if (Number.isInteger(value)) return String(value);
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 })
    .format(value)
    .replace(/\u00a0/g, " ")
    .replace(/\u202f/g, " ");
}

export function invoiceLocalNumber(number: string, date?: Date | string | null) {
  const raw = String(number || "").trim();
  const crm = raw.match(/^INV-(\d{4})-(\d+)$/i);
  if (crm) return `${crm[1].slice(-2)}-${crm[2].padStart(4, "0")}`;
  if (/^\d{2}-\d+$/.test(raw)) {
    const [yy, seq] = raw.split("-");
    return `${yy}-${seq.padStart(4, "0")}`;
  }
  return raw || "1";
}

export function invoiceDirectorShortName(fullName: string) {
  return directorShortName(fullName).replace(/(\.)\s+(?=[A-ZА-ЯЁ])/g, "$1");
}

export function formatInvoiceContractBasis(
  number: string,
  date: Date | string | null | undefined,
  withoutContract = false,
) {
  if (withoutContract) return "без договора";
  const raw = String(number || "").replace(/^\s*(№|No|Nо)\s*/i, "").trim();
  if (!raw) return "";
  const dated = formatInvoiceQuotedDate(date);
  return dated ? `№ ${raw} от ${dated}` : `№ ${raw}`;
}

function formatInvoiceQuotedDate(value: Date | string | null | undefined) {
  const padded = formatQuotedDayMonthYear(value);
  return padded.replace(/«0(\d)»/, "«$1»");
}

export function invoicePayableWords(amount: number) {
  const safe = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  const tenge = Math.floor(safe + 1e-9);
  const tiyn = Math.round((safe - tenge) * 100);
  return `${capitalizeRu(amountToKztWords(tenge))} ${String(tiyn).padStart(2, "0")} тиын`;
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

export function invoicePdfFileName(input: InvoicePdfInput) {
  const local = invoiceLocalNumber(input.number, input.date);
  const buyer = safeFilePart(stripOrgPrefix(input.buyerName));
  const dated = formatFilenameDayMonthYear(input.date);
  return safeFilePart([local, buyer, dated ? `от ${dated}` : ""].filter(Boolean).join(" ")) + ".pdf";
}

export function invoicePdfContentDisposition(filename: string, inline = false) {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");
  const mode = inline ? "inline" : "attachment";
  return `${mode}; filename="${ascii || "invoice.pdf"}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function formatInvoiceBin(value: string) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.replace(/(\d{3})(?=\d)/g, "$1 ").trim();
}

export function cyrillicOrgName(name: string) {
  return String(name || "")
    .replace(/\bTOO\b/gi, "ТОО")
    .replace(/\bAO\b/gi, "АО")
    .replace(/\bIP\b/gi, "ИП");
}

/** White paper around a scan of the stamp/signature becomes transparent for overlay. */
export async function punchInvoiceStampBackground(png: Buffer) {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = pixels.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 242 && data[i + 1] > 242 && data[i + 2] > 242) data[i + 3] = 0;
  }
  ctx.putImageData(pixels, 0, 0);
  return canvas.toBuffer("image/png");
}

function defaultKbe(input: InvoicePdfInput) {
  return String(input.sellerKbe || (input.sellerBin ? "17" : "19")).replace(/\D/g, "") || "17";
}

function partyDetails(bin: string, name: string, address: string) {
  const tax = formatInvoiceBin(bin) || String(bin || "").replace(/\D/g, "");
  return [`БИН/ИИН ${tax || "—"}`, cyrillicOrgName(name), address].filter((part) => part && part !== "—").join(", ");
}

function lineAmount(item: InvoicePdfItem) {
  return Number(item.amountWithoutVat ?? item.totalAmount ?? Number(item.quantity || 0) * Number(item.unitPrice || 0));
}

export async function renderInvoicePdf(input: InvoicePdfInput) {
  const regular = resolveFont("NotoSans-Regular.ttf");
  const bold = resolveFont("NotoSans-Bold.ttf");
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 32, bottom: 36, left: 25, right: 25 },
    info: {
      Title: `Счёт на оплату № ${invoiceLocalNumber(input.number, input.date)}`,
      Author: input.sellerName,
      Creator: "BasQar CRM",
      Producer: "BasQar CRM",
      CreationDate: input.date,
      ModDate: input.date,
    },
  });
  const done = collectPdf(doc);
  doc.registerFont("NotoSans", regular);
  doc.registerFont("NotoSans-Bold", bold);

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;
  const itemsTotal = input.itemsTotalAmount ?? input.items.reduce((sum, item) => sum + lineAmount(item), 0);
  const payableTotal = input.totalAmount;
  const percent = input.paymentPercent && input.paymentPercent < 100 - 1e-6 ? input.paymentPercent : itemsTotal > 0 && payableTotal + 0.005 < itemsTotal ? Math.round((payableTotal / itemsTotal) * 10000) / 100 : 100;
  const showPrepayment = percent < 100 - 1e-6;
  const paymentLabel = input.paymentKind === "BALANCE" ? "Остаток" : input.paymentKind === "ADDITIONAL" ? "Дополнительный платёж" : "Предоплата";
  const localNumber = invoiceLocalNumber(input.number, input.date);

  doc.fillColor(BLACK).font("NotoSans").fontSize(9).text(NOTICE, left, 34, { width, align: "left", lineGap: 1.2 });
  let y = doc.y + 10;
  doc.font("NotoSans-Bold").fontSize(14).text("Образец платежного поручения", left, y);
  y = doc.y + 8;

  const row1H = 58;
  const row2H = 46;
  const boxH = row1H + row2H;
  const col3 = 52;
  const col2 = 148;
  const col1 = width - col2 - col3;
  const boxY = y;
  doc.lineWidth(0.8).strokeColor(BLACK);
  doc.rect(left, boxY, width, boxH).stroke();
  doc.moveTo(left + col1, boxY).lineTo(left + col1, boxY + boxH).stroke();
  doc.moveTo(left + col1 + col2, boxY).lineTo(left + col1 + col2, boxY + boxH).stroke();
  doc.moveTo(left, boxY + row1H).lineTo(right, boxY + row1H).stroke();

  const pad = 6;
  const binText = `БИН: ${String(input.sellerBin || "").replace(/\s/g, "")}`;
  const inner1 = col1 - pad * 2;
  doc.save();
  doc.rect(left, boxY, col1, row1H).clip();
  doc.font("NotoSans").fontSize(12).text("Бенефициар", left + pad, boxY + 4, { width: inner1, lineBreak: false });
  doc.font("NotoSans-Bold").fontSize(10).text(cyrillicOrgName(input.sellerName || ""), left + pad, boxY + 20, {
    width: inner1,
    height: 13,
    lineBreak: false,
  });
  doc.font("NotoSans").fontSize(10).text(binText, left + pad, boxY + 36, {
    width: inner1,
    height: 13,
    lineBreak: false,
  });
  doc.restore();
  doc.font("NotoSans").fontSize(12).text("ИИК", left + col1, boxY + 4, { width: col2, align: "center", lineBreak: false });
  doc.fontSize(10).text(input.sellerIban || "", left + col1, boxY + 22, { width: col2, align: "center", lineBreak: false });
  doc.fontSize(12).text("КБе", left + col1 + col2, boxY + 4, { width: col3, align: "center", lineBreak: false });
  doc.fontSize(10).text(defaultKbe(input), left + col1 + col2, boxY + 22, { width: col3, align: "center", lineBreak: false });

  const row2 = boxY + row1H;
  doc.save();
  doc.rect(left, row2, col1, row2H).clip();
  doc.font("NotoSans").fontSize(12).text("Банк бенефициара", left + pad, row2 + 5, { width: inner1, lineBreak: false });
  doc.fontSize(10).text(input.sellerBankName || "", left + pad, row2 + 23, { width: inner1, height: 16, lineBreak: false });
  doc.restore();
  doc.fontSize(12).text("БИК", left + col1, row2 + 5, { width: col2, align: "center", lineBreak: false });
  doc.fontSize(10).text(input.sellerBik || "", left + col1, row2 + 23, { width: col2, align: "center", lineBreak: false });
  doc.fontSize(12).text("КНП", left + col1 + col2, row2 + 5, { width: col3, align: "center", lineBreak: false });
  doc.fontSize(10).text(String(input.sellerKnp || "859"), left + col1 + col2, row2 + 23, {
    width: col3,
    align: "center",
    lineBreak: false,
  });

  y = boxY + boxH + 16;
  doc.font("NotoSans-Bold").fontSize(16).text(`Счет на оплату № ${localNumber} от ${formatDotDate(input.date)} г.`, left, y, {
    width,
  });
  y = doc.y + 14;

  const partyIndent = 93;
  function drawParty(label: string, details: string, phone: string, email: string, phoneLabel: string) {
    const start = y;
    doc.font("NotoSans-Bold").fontSize(12).text(label, left, start, { width: partyIndent - 4, lineBreak: false });
    doc.font("NotoSans").fontSize(10).text(details, left + partyIndent, start + 1, { width: width - partyIndent });
    y = Math.max(doc.y, start + 14);
    if (phone) {
      doc.text(`${phoneLabel} ${phone}`, left + partyIndent, y, { width: width - partyIndent });
      y = doc.y;
    }
    if (email) {
      doc.text(`E-mail: ${email}`, left + partyIndent, y, { width: width - partyIndent });
      y = doc.y;
    }
    y += 10;
  }

  drawParty(
    "Поставщик:",
    partyDetails(input.sellerBin, input.sellerName, input.sellerAddress),
    input.sellerPhone || "",
    input.sellerEmail || "",
    "Тел.:",
  );
  drawParty(
    "Покупатель:",
    partyDetails(input.buyerBin, input.buyerName, input.buyerAddress),
    input.buyerPhone || "",
    input.buyerEmail || "",
    "Тел:",
  );

  const contract = formatInvoiceContractBasis(input.contractNumber, input.contractDate, input.withoutContract);
  doc.font("NotoSans-Bold").fontSize(12).text("Договор:", left, y, { width: partyIndent - 4, lineBreak: false });
  doc.font("NotoSans").fontSize(10).text(contract, left + partyIndent, y + 1, { width: width - partyIndent });
  y = Math.max(doc.y, y + 14) + 10;

  const tableHeaders = ["№", "Код", "", "", "Ед. изм.", "Цена", "Сумма"];
  const colXs: number[] = [];
  let x = left;
  for (const col of COLS) {
    colXs.push(x);
    x += col.width;
  }

  function ensureSpace(needed: number) {
    if (y + needed <= doc.page.height - doc.page.margins.bottom) return;
    doc.addPage();
    y = doc.page.margins.top;
    drawHeader();
  }

  function drawHeader() {
    const h = 22;
    doc.lineWidth(0.8).rect(left, y, width, h).stroke();
    for (let i = 1; i < COLS.length; i += 1) {
      doc.moveTo(colXs[i], y).lineTo(colXs[i], y + h).stroke();
    }
    doc.font("NotoSans-Bold").fontSize(12);
    tableHeaders.forEach((title, index) => {
      if (!title) return;
      doc.text(title, colXs[index], y + 5, { width: COLS[index].width, align: "center" });
    });
    y += h;
  }

  drawHeader();

  input.items.forEach((item, index) => {
    const name = item.name || "";
    const nameH = Math.max(28, doc.font("NotoSans").fontSize(10).heightOfString(name, { width: COLS[2].width - 8 }) + 12);
    ensureSpace(nameH);
    doc.rect(left, y, width, nameH).stroke();
    for (let i = 1; i < COLS.length; i += 1) {
      doc.moveTo(colXs[i], y).lineTo(colXs[i], y + nameH).stroke();
    }
    const mid = y + nameH / 2 - 6;
    doc.font("NotoSans").fontSize(10);
    doc.text(`${index + 1}.`, colXs[0], mid, { width: COLS[0].width, align: "center" });
    doc.text(item.code || "", colXs[1], mid, { width: COLS[1].width, align: "center" });
    doc.text(name, colXs[2] + 4, y + 6, { width: COLS[2].width - 8, align: "left" });
    doc.text(qty(Number(item.quantity || 0)), colXs[3], mid, { width: COLS[3].width, align: "center" });
    doc.text(paperAvrMeasureUnit(item.unit), colXs[4], mid, { width: COLS[4].width, align: "center" });
    doc.text(money(Number(item.unitPrice || 0)), colXs[5], mid, { width: COLS[5].width - 6, align: "right" });
    doc.text(money(lineAmount(item)), colXs[6], mid, { width: COLS[6].width - 6, align: "right" });
    y += nameH;
  });

  y += 8;
  const summaryX = left + width * 0.55;
  const summaryW = width * 0.45;
  doc.font("NotoSans-Bold").fontSize(12);
  doc.text("Итого:", summaryX, y, { width: summaryW * 0.55, align: "left" });
  doc.text(money(input.itemsTotalWithoutVat ?? input.amountWithoutVat), summaryX, y, { width: summaryW, align: "right" });
  y = doc.y + 4;
  if (showPrepayment) {
    doc.text(`${paymentLabel} ${String(percent).replace(".", ",")}%:`, summaryX, y, { width: summaryW * 0.7, align: "left" });
    doc.text(money(payableTotal), summaryX, y, { width: summaryW, align: "right" });
    y = doc.y + 4;
  }
  if (input.vatAmount > 0) {
    const rate = input.vatRate != null ? ` ${String(input.vatRate).replace(".", ",")}%` : "";
    doc.text(`НДС${rate}:`, summaryX, y, { width: summaryW * 0.55, align: "left" });
    doc.text(money(input.vatAmount), summaryX, y, { width: summaryW, align: "right" });
  } else {
    doc.text("Без НДС", summaryX, y, { width: summaryW, align: "left" });
  }

  const stamped = Boolean(input.withStamp && (input.stampPng || input.signaturePng));
  const footerH = stamped ? 140 : 72;
  y = doc.y + 48;
  if (y + footerH > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
    y = doc.page.margins.top;
  }

  doc.font("NotoSans").fontSize(10).text(
    `Всего наименований ${input.items.length}, на сумму ${money(payableTotal)} KZT`,
    left,
    y,
    { width },
  );
  y = doc.y + 6;
  doc.font("NotoSans-Bold").fontSize(12).text(`Всего к оплате: ${invoicePayableWords(payableTotal)}`, left, y, { width });
  y = doc.y + (stamped ? 42 : 22);
  const signer = invoiceDirectorShortName(input.sellerDirector || "");
  doc.font("NotoSans").fontSize(10).text(
    `Исполнитель ________________________________________${signer ? ` /${signer}/` : ""}`,
    left,
    y,
    { width },
  );
  if (stamped) {
    if (input.stampPng) {
      try {
        doc.image(input.stampPng, left + 40, y - 18, { fit: [100, 100] });
      } catch {
        /* keep the line even if the stamp file is unreadable */
      }
    }
    if (input.signaturePng) {
      try {
        doc.image(input.signaturePng, left + 86, y - 24, { fit: [126, 50] });
      } catch {
        /* keep the line even if the signature file is unreadable */
      }
    }
  }

  doc.end();
  return done;
}
