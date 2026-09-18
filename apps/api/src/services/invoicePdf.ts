import { amountToKztWords } from "@creolab/contracts";
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
  dealName?: string;
  amountWithoutVat: number;
  vatRate: number | null;
  vatAmount: number;
  totalAmount: number;
  itemsTotalWithoutVat?: number;
  itemsVatAmount?: number;
  itemsTotalAmount?: number;
  paymentPercent?: number;
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
  buyerName: string;
  buyerBin: string;
  buyerAddress: string;
  buyerPhone?: string;
  items: InvoicePdfItem[];
};

const BLACK = "#000000";
const NOTICE =
  "Внимание!Оплата данного счета означает согласие с условиями поставки товара.Уведомление об оплате обязательно, в противном случае не гарантируется наличие товара на складе.Товар отпускается по факту прихода денег на р / с Поставщика, самовывозом, при наличии доверенности и документов удостоверяющих личность.";

const COLS = [
  { key: "num", width: 36 },
  { key: "code", width: 52 },
  { key: "name", width: 188 },
  { key: "qty", width: 46 },
  { key: "unit", width: 58 },
  { key: "price", width: 82 },
  { key: "amount", width: 83 },
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
  const iso = date instanceof Date ? date.toISOString() : String(date || new Date().toISOString());
  const year = iso.match(/^(\d{4})/)?.[1] || String(new Date().getFullYear());
  const digits = raw.replace(/\D/g, "");
  return `${year.slice(-2)}-${(digits || "1").slice(-4).padStart(4, "0")}`;
}

export function invoiceDirectorShortName(fullName: string) {
  return directorShortName(fullName).replace(/(\.)\s+(?=[A-ZА-ЯЁ])/g, "$1");
}

export function formatInvoiceContractBasis(number: string, date: Date | string | null | undefined) {
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

export function invoicePdfContentDisposition(filename: string) {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");
  return `attachment; filename="${ascii || "invoice.pdf"}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function defaultKbe(input: InvoicePdfInput) {
  return String(input.sellerKbe || (input.sellerBin ? "17" : "19")).replace(/\D/g, "") || "17";
}

function partyDetails(bin: string, name: string, address: string) {
  const tax = String(bin || "").replace(/\s/g, "");
  return [`БИН/ИИН ${tax || "—"}`, name, address].filter((part) => part && part !== "—").join(", ");
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
  const localNumber = invoiceLocalNumber(input.number, input.date);

  doc.fillColor(BLACK).font("NotoSans").fontSize(9).text(NOTICE, left, 34, { width, align: "left", lineGap: 1.2 });

  let y = doc.y + 10;
  doc.font("NotoSans-Bold").fontSize(14).text("Образец платежного поручения", left, y);
  y = doc.y + 6;

  const boxH = 72;
  const col1 = width * 0.62;
  const col3 = 58;
  const col2 = width - col1 - col3;
  doc.lineWidth(0.8).strokeColor(BLACK);
  doc.rect(left, y, width, boxH).stroke();
  doc.moveTo(left + col1, y).lineTo(left + col1, y + boxH).stroke();
  doc.moveTo(left + col1 + col2, y).lineTo(left + col1 + col2, y + boxH).stroke();
  doc.moveTo(left, y + boxH / 2).lineTo(right, y + boxH / 2).stroke();

  const pad = 6;
  doc.font("NotoSans").fontSize(11).text("Бенефициар", left + pad, y + 4, { width: col1 - pad * 2 });
  doc.font("NotoSans-Bold").fontSize(10).text(input.sellerName || "", left + pad, y + 18, { width: col1 - pad * 2 });
  doc.font("NotoSans").fontSize(10).text(`БИН: ${String(input.sellerBin || "").replace(/\s/g, "")}`, left + pad, y + 32, {
    width: col1 - pad * 2,
  });
  doc.fontSize(11).text("ИИК", left + col1 + pad, y + 4, { width: col2 - pad * 2, align: "center" });
  doc.fontSize(10).text(input.sellerIban || "", left + col1 + pad, y + 20, { width: col2 - pad * 2, align: "center" });
  doc.fontSize(11).text("КБе", left + col1 + col2 + pad, y + 4, { width: col3 - pad * 2, align: "center" });
  doc.fontSize(10).text(defaultKbe(input), left + col1 + col2 + pad, y + 20, { width: col3 - pad * 2, align: "center" });

  const row2 = y + boxH / 2;
  doc.fontSize(11).text("Банк бенефициара", left + pad, row2 + 4, { width: col1 - pad * 2 });
  doc.fontSize(10).text(input.sellerBankName || "", left + pad, row2 + 20, { width: col1 - pad * 2 });
  doc.fontSize(11).text("БИК", left + col1 + pad, row2 + 4, { width: col2 - pad * 2, align: "center" });
  doc.fontSize(10).text(input.sellerBik || "", left + col1 + pad, row2 + 20, { width: col2 - pad * 2, align: "center" });
  doc.fontSize(11).text("КНП", left + col1 + col2 + pad, row2 + 4, { width: col3 - pad * 2, align: "center" });
  doc.fontSize(10).text(String(input.sellerKnp || "859"), left + col1 + col2 + pad, row2 + 20, {
    width: col3 - pad * 2,
    align: "center",
  });

  y = y + boxH + 16;
  doc.font("NotoSans-Bold").fontSize(16).text(`Счет на оплату № ${localNumber} от ${formatDotDate(input.date)} г.`, left, y, {
    width,
  });
  y = doc.y + 14;

  const labelW = 78;
  doc.font("NotoSans-Bold").fontSize(11).text("Поставщик:", left, y, { width: labelW });
  doc.font("NotoSans").fontSize(10).text(partyDetails(input.sellerBin, input.sellerName, input.sellerAddress), left + labelW, y - 1, {
    width: width - labelW,
  });
  y = Math.max(doc.y, y + 12);
  if (input.sellerPhone) {
    doc.text(`Тел.: ${input.sellerPhone}`, left + labelW, y, { width: width - labelW });
    y = doc.y + 8;
  } else {
    y += 8;
  }

  doc.font("NotoSans-Bold").fontSize(11).text("Покупатель:", left, y, { width: labelW });
  doc.font("NotoSans").fontSize(10).text(partyDetails(input.buyerBin, input.buyerName, input.buyerAddress), left + labelW, y - 1, {
    width: width - labelW,
  });
  y = Math.max(doc.y, y + 12);
  if (input.buyerPhone) {
    doc.text(`Тел: ${input.buyerPhone}`, left + labelW, y, { width: width - labelW });
    y = doc.y + 10;
  } else {
    y += 10;
  }

  const contract = formatInvoiceContractBasis(input.contractNumber, input.contractDate);
  doc.font("NotoSans-Bold").fontSize(11).text("Договор:", left, y, { width: labelW });
  doc.font("NotoSans").fontSize(10).text(contract, left + labelW, y, { width: width - labelW });
  y = Math.max(doc.y, y + 12) + 8;

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
    doc.font("NotoSans-Bold").fontSize(11);
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
    doc.text(`Предоплата ${String(percent).replace(".", ",")}%:`, summaryX, y, { width: summaryW * 0.7, align: "left" });
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

  const footerH = 78;
  if (doc.y + footerH + 24 > doc.page.height - doc.page.margins.bottom) doc.addPage();
  y = Math.max(doc.y + 36, doc.page.height - doc.page.margins.bottom - footerH);

  doc.font("NotoSans").fontSize(10).text(
    `Всего наименований ${input.items.length}, на сумму ${money(payableTotal)} KZT`,
    left,
    y,
    { width },
  );
  y = doc.y + 6;
  doc.font("NotoSans-Bold").fontSize(12).text(`Всего к оплате: ${invoicePayableWords(payableTotal)}`, left, y, { width });
  y = doc.y + 18;
  const signer = invoiceDirectorShortName(input.sellerDirector || "");
  doc.font("NotoSans").fontSize(10).text(
    `Исполнитель ________________________________________${signer ? ` /${signer}/` : ""}`,
    left,
    y,
    { width },
  );

  doc.end();
  return done;
}
