import { amountToKztWords } from "@creolab/contracts";
import PDFDocument from "pdfkit";
import {
  collectPdf,
  drawItemsTable,
  formatDate,
  formatKzt,
  resolveFont,
  type ContractPdfItem,
} from "./contractPdf.ts";

export type InvoicePdfItem = ContractPdfItem;

export type InvoicePdfInput = {
  number: string;
  date: Date;
  dueDate: Date | null;
  contractNumber: string;
  contractDate: Date;
  dealName: string;
  amountWithoutVat: number;
  vatRate: number | null;
  vatAmount: number;
  totalAmount: number;
  sellerName: string;
  sellerBin: string;
  sellerAddress: string;
  sellerIban: string;
  sellerBankName: string;
  sellerBik: string;
  buyerName: string;
  buyerBin: string;
  buyerAddress: string;
  items: InvoicePdfItem[];
};

function vatLine(input: InvoicePdfInput) {
  if (input.vatAmount > 0) {
    const rate = input.vatRate != null ? ` ${input.vatRate}%` : "";
    return `в том числе НДС${rate}: ${formatKzt(input.vatAmount)}`;
  }
  return "НДС не облагается";
}

export async function renderInvoicePdf(input: InvoicePdfInput) {
  const regular = resolveFont("NotoSans-Regular.ttf");
  const bold = resolveFont("NotoSans-Bold.ttf");
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 50, bottom: 56, left: 50, right: 50 },
    info: {
      Title: `Счёт ${input.number}`,
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

  doc.font("NotoSans-Bold").fontSize(16).text(`СЧЁТ НА ОПЛАТУ № ${input.number}`, { align: "center" });
  doc.moveDown(0.3);
  doc.font("NotoSans").fontSize(11).text(`от ${formatDate(input.date)}`, { align: "center" });
  if (input.dueDate) {
    doc.moveDown(0.2);
    doc.text(`Оплатить до ${formatDate(input.dueDate)}`, { align: "center" });
  }
  doc.moveDown(1.1);

  doc.font("NotoSans-Bold").fontSize(11).text("Поставщик");
  doc.moveDown(0.25);
  doc.font("NotoSans").fontSize(10);
  doc.text(input.sellerName);
  doc.text(`БИН ${input.sellerBin}`);
  doc.text(input.sellerAddress);
  if (input.sellerBankName) doc.text(`Банк: ${input.sellerBankName}`);
  doc.text(`ИИК ${input.sellerIban}`);
  doc.text(`БИК ${input.sellerBik}`);
  doc.moveDown(0.8);

  doc.font("NotoSans-Bold").fontSize(11).text("Покупатель");
  doc.moveDown(0.25);
  doc.font("NotoSans").fontSize(10);
  doc.text(input.buyerName);
  doc.text(`БИН / ИИН ${input.buyerBin}`);
  doc.text(input.buyerAddress);
  doc.moveDown(0.8);

  doc.font("NotoSans").fontSize(10).text(
    `Основание: договор № ${input.contractNumber} от ${formatDate(input.contractDate)}. ${input.dealName}`,
  );
  doc.moveDown(0.8);

  doc.font("NotoSans-Bold").fontSize(11).text("Спецификация");
  doc.moveDown(0.4);
  drawItemsTable(doc, input.items);

  doc.moveDown(0.6);
  doc.font("NotoSans").fontSize(11);
  doc.text(`Сумма без НДС: ${formatKzt(input.amountWithoutVat)}`, { align: "right" });
  doc.text(vatLine(input), { align: "right" });
  doc.font("NotoSans-Bold").text(`Итого к оплате: ${formatKzt(input.totalAmount)}`, { align: "right" });
  doc.moveDown(0.5);
  doc.font("NotoSans").fontSize(10).text(`Сумма прописью: ${amountToKztWords(input.totalAmount)}`);
  doc.moveDown(1.2);
  doc.font("NotoSans").fontSize(9).fillColor("#555555").text(
    "Документ сформирован в CRM. Это не электронный счёт-фактура (ЭСФ) и не акт выполненных работ.",
  );

  doc.end();
  return done;
}
