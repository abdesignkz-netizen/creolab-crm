import { existsSync } from "node:fs";
import path from "node:path";
import { amountToKztWords, esfMeasureUnitSymbol } from "@creolab/contracts";
import PDFDocument from "pdfkit";
import { ApiError } from "../errors.ts";
import { isFullContractTemplateBody } from "./contractTemplate.ts";

export type ContractPdfItem = {
  name: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  amountWithoutVat?: number;
  totalAmount: number;
};

export type ContractPdfInput = {
  number: string;
  date: Date;
  subject: string;
  dealName: string;
  paymentTerms: string;
  completionTerms: string;
  amountWithoutVat: number;
  vatRate: number | null;
  vatAmount: number;
  totalAmount: number;
  sellerName: string;
  sellerBin: string;
  sellerAddress: string;
  sellerDirector: string;
  sellerDirectorPosition: string;
  sellerIban?: string;
  sellerBank?: string;
  sellerBik?: string;
  sellerPhone?: string;
  sellerEmail?: string;
  buyerName: string;
  buyerBin: string;
  buyerAddress: string;
  buyerDirector: string;
  buyerIban?: string;
  buyerBank?: string;
  buyerBik?: string;
  items: ContractPdfItem[];
  templateBody: string;
};

export function resolveFont(fileName: string) {
  const candidates = [
    path.resolve(import.meta.dirname, "../../assets/fonts", fileName),
    path.resolve(process.cwd(), "apps/api/assets/fonts", fileName),
    path.resolve(process.cwd(), "assets/fonts", fileName),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new ApiError(500, "font_missing", "Не найден шрифт Noto Sans для PDF");
  }
  return found;
}

export function formatKzt(amount: number) {
  return `${new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)} ₸`;
}

export function formatDate(date: Date) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

export function formatContractHeadingDate(date: Date, timeZone = "Asia/Almaty") {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone,
  }).formatToParts(date);
  const day = parts.find((part) => part.type === "day")?.value || "";
  const month = parts.find((part) => part.type === "month")?.value || "";
  const year = parts.find((part) => part.type === "year")?.value || "";
  return `«${day}» ${month} ${year} г.`;
}

export function formatGroupedInt(amount: number) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.round(Number(amount) || 0));
}

export function amountWordsCapitalized(amount: number) {
  const words = amountToKztWords(amount).replace(/\s+тенге[\s\S]*$/i, "").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "";
}

export function paymentHalves(total: number) {
  const cents = Math.round(Number(total) * 100);
  const prepaymentCents = Math.floor(cents / 2);
  return {
    prepayment: prepaymentCents / 100,
    remainder: (cents - prepaymentCents) / 100,
  };
}

function vatLine(input: ContractPdfInput) {
  if (input.vatAmount > 0) {
    const rate = input.vatRate != null ? ` ${input.vatRate}%` : "";
    return `в том числе НДС${rate}: ${formatKzt(input.vatAmount)}`;
  }
  return "НДС не облагается";
}

export function buildContractPlaceholders(input: ContractPdfInput) {
  const halves = paymentHalves(input.totalAmount);
  return {
    contract_number: input.number,
    contract_date: formatContractHeadingDate(input.date),
    seller_name: input.sellerName,
    seller_bin: input.sellerBin,
    seller_address: input.sellerAddress,
    seller_director: input.sellerDirector,
    seller_director_position: input.sellerDirectorPosition,
    seller_iban: input.sellerIban || "",
    seller_bank: input.sellerBank || "",
    seller_bik: input.sellerBik || "",
    seller_phone: input.sellerPhone || "",
    seller_email: input.sellerEmail || "",
    buyer_name: input.buyerName,
    buyer_bin: input.buyerBin,
    buyer_address: input.buyerAddress,
    buyer_director: input.buyerDirector,
    buyer_iban: input.buyerIban || "",
    buyer_bank: input.buyerBank || "",
    buyer_bik: input.buyerBik || "",
    deal_name: input.dealName,
    subject: input.subject,
    amount: formatKzt(input.totalAmount),
    amount_words: amountToKztWords(input.totalAmount),
    amount_plain: formatGroupedInt(input.totalAmount),
    prepayment_amount: formatGroupedInt(halves.prepayment),
    prepayment_amount_words: amountWordsCapitalized(halves.prepayment),
    remainder_amount: formatGroupedInt(halves.remainder),
    remainder_amount_words: amountWordsCapitalized(halves.remainder),
    vat: vatLine(input),
    payment_terms: input.paymentTerms,
    completion_terms: input.completionTerms,
    items_table: formatContractItemsTable(input),
  };
}

export function formatContractItemsTable(input: ContractPdfInput) {
  if (!input.items.length) return "";
  const lines = input.items.map((item, index) => {
    const sum = formatKzt(item.amountWithoutVat ?? item.totalAmount);
    return `${index + 1}. ${item.name} — ${item.quantity} ${esfMeasureUnitSymbol(item.unit)} × ${formatKzt(item.unitPrice)} = ${sum}`;
  });
  lines.push(`Итого: ${formatKzt(input.totalAmount)}, ${vatLine(input)}`);
  return lines.join("\n");
}

export function contractItemTableRows(input: ContractPdfInput) {
  if (!input.items.length) return [] as string[][];
  return [
    ["№", "Наименование", "Кол-во", "Ед.", "Цена", "Сумма"],
    ...input.items.map((item, index) => [
      String(index + 1),
      item.name,
      String(item.quantity),
      esfMeasureUnitSymbol(item.unit),
      formatKzt(item.unitPrice),
      formatKzt(item.amountWithoutVat ?? item.totalAmount),
    ]),
    ["", `Итого: ${formatKzt(input.totalAmount)}`, "", "", "", vatLine(input)],
  ];
}

export function applyPlaceholders(text: string, values: Record<string, string>) {
  return text.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, key: string) => values[key] ?? "");
}

export function collectPdf(doc: PDFKit.PDFDocument) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk as Buffer));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

export function drawItemsTable(doc: PDFKit.PDFDocument, items: ContractPdfItem[]) {
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const cols = [
    { title: "№", width: 24 },
    { title: "Наименование", width: pageWidth - 314 },
    { title: "Кол-во", width: 50 },
    { title: "Ед.", width: 50 },
    { title: "Цена", width: 90 },
    { title: "Сумма", width: 100 },
  ];
  const startX = doc.page.margins.left;
  const rowH = 20;
  let y = doc.y;

  const ensureSpace = (height: number) => {
    if (y + height > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.page.margins.top;
    }
  };

  const drawRow = (cells: string[], header = false) => {
    ensureSpace(rowH);
    doc.font(header ? "NotoSans-Bold" : "NotoSans").fontSize(8);
    let x = startX;
    cells.forEach((cell, index) => {
      doc.text(cell, x + 2, y + 5, { width: cols[index].width - 4, lineBreak: false, ellipsis: true });
      x += cols[index].width;
    });
    doc
      .moveTo(startX, y + rowH)
      .lineTo(startX + pageWidth, y + rowH)
      .strokeColor("#cccccc")
      .lineWidth(0.5)
      .stroke();
    y += rowH;
  };

  drawRow(
    cols.map((col) => col.title),
    true,
  );
  items.forEach((item, index) => {
    drawRow([
      String(index + 1),
      item.name,
      String(item.quantity),
      esfMeasureUnitSymbol(item.unit),
      formatKzt(item.unitPrice),
      formatKzt(item.amountWithoutVat ?? item.totalAmount),
    ]);
  });
  doc.y = y + 8;
  doc.x = startX;
  doc.fillColor("#111111");
}

export function looksLikeFullContractTemplate(body: string) {
  return isFullContractTemplateBody(body);
}

export async function renderContractPdf(input: ContractPdfInput) {
  const regular = resolveFont("NotoSans-Regular.ttf");
  const bold = resolveFont("NotoSans-Bold.ttf");
  const values = buildContractPlaceholders(input);
  const body = input.templateBody || "";
  const fullTemplate = looksLikeFullContractTemplate(body);
  const hasOwnHeader = fullTemplate || /^\s*договор/i.test(body) || /\{\{\s*contract_number\s*\}\}/i.test(body.slice(0, 400));
  const hasOwnSignatures = fullTemplate || /реквизиты\s+сторон/i.test(body) || /_{5,}/.test(body);
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 50, bottom: 56, left: 50, right: 50 },
    info: {
      Title: `Договор ${input.number}`,
      Author: input.sellerName,
      Creator: "CreoLab CRM",
      Producer: "CreoLab CRM",
      CreationDate: input.date,
      ModDate: input.date,
    },
  });
  const done = collectPdf(doc);
  doc.registerFont("NotoSans", regular);
  doc.registerFont("NotoSans-Bold", bold);

  if (!hasOwnHeader) {
    doc.font("NotoSans-Bold").fontSize(16).text(`ДОГОВОР № ${values.contract_number}`, { align: "center" });
    doc.moveDown(0.3);
    doc.font("NotoSans").fontSize(11).text(`от ${values.contract_date}`, { align: "center" });
    doc.moveDown(1.2);
  }

  const parts = body.split(/\{\{\s*items_table\s*\}\}/i);
  parts.forEach((part, index) => {
    const text = applyPlaceholders(part, values).replace(/\n{3,}/g, "\n\n").trim();
    if (text) {
      doc.font("NotoSans").fontSize(fullTemplate ? 10 : 11).text(text, {
        align: fullTemplate ? "left" : "justify",
        paragraphGap: fullTemplate ? 4 : 8,
        lineGap: fullTemplate ? 1 : 0,
      });
      doc.moveDown(fullTemplate ? 0.25 : 0.6);
    }
    if (index < parts.length - 1) {
      drawItemsTable(doc, input.items);
      doc.moveDown(0.4);
    }
  });

  if (!fullTemplate && !/\{\{\s*items_table\s*\}\}/i.test(body) && input.items.length) {
    doc.font("NotoSans-Bold").fontSize(11).text("Спецификация");
    doc.moveDown(0.4);
    drawItemsTable(doc, input.items);
  }

  if (!hasOwnSignatures) {
    doc.moveDown(1.2);
    doc.font("NotoSans-Bold").fontSize(11).text("Подписи сторон");
    doc.moveDown(0.6);
    const colWidth = (doc.page.width - doc.page.margins.left - doc.page.margins.right - 24) / 2;
    const y = doc.y;
    doc.font("NotoSans").fontSize(10);
    doc.text(`Исполнитель\n${input.sellerDirectorPosition} ${input.sellerDirector}\n________________`, doc.page.margins.left, y, {
      width: colWidth,
    });
    doc.text(`Заказчик\n${input.buyerDirector}\n________________`, doc.page.margins.left + colWidth + 24, y, {
      width: colWidth,
    });
  }

  doc.end();
  return done;
}
