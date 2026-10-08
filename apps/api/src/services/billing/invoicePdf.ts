import PDFDocument from "pdfkit";
import { amountToKztWords } from "@creolab/contracts";
import { collectPdf, resolveFont } from "../contractPdf.ts";

export type SubscriptionInvoiceInput = {
  invoiceNumber: string;
  issueDate: Date;
  dueDate: Date;
  description: string;
  // Billing stores KZT in whole tenge despite the historical field name.
  amountMinor: number;
  status: string;
  orderBasis?: { number: string; date: string };
  seller: {
    legalName: string; bin: string; legalAddress: string;
    iban: string; bankName: string; bik: string; kbe: string; knp?: string;
    vatEnabled: boolean; vatRate: number;
    supportEmail: string; supportPhone: string;
    signerName?: string; signerPosition?: string;
    signatureDataUrl?: string; stampDataUrl?: string;
  };
  buyer: { legalName: string; bin: string; legalAddress: string };
};
const date = (value: Date) => value.toLocaleDateString("ru-RU", { timeZone: "Asia/Almaty" });
const money = (value: number) => new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
}).format(value).replace(/[\u00a0\u202f]/g, " ");

export async function renderSubscriptionInvoice(input: SubscriptionInvoiceInput) {
  const s = input.seller, b = input.buyer;
  const doc = new PDFDocument({
    size: "A4", margins: { top: 36, bottom: 54, left: 36, right: 36 },
    bufferPages: true,
    info: { Title: `Счёт на оплату ${input.invoiceNumber}`, Author: s.legalName },
  });
  const done = collectPdf(doc);
  doc.registerFont("regular", resolveFont("NotoSans-Regular.ttf"));
  doc.registerFont("bold", resolveFont("NotoSans-Bold.ttf"));
  const left = 36, width = doc.page.width - 72, right = left + width;
  const ink = "#17243c", muted = "#526175", border = "#c8d2df", blue = "#0866c6";
  let y = 36;
  const font = (bold = false, size = 9) => doc.font(bold ? "bold" : "regular").fontSize(size).fillColor(ink);
  const height = (text: string, w: number, size = 9, bold = false) => {
    font(bold, size);
    return doc.heightOfString(text, { width: w, lineGap: 2 });
  };
  const text = (value: string, x: number, top: number, w: number, bold = false, size = 9, align: "left" | "right" | "center" = "left") => {
    font(bold, size).text(value, x, top, { width: w, lineGap: 2, align });
  };
  const rule = (top: number, from = left, to = right) => doc.moveTo(from, top).lineTo(to, top).lineWidth(0.6).strokeColor(border).stroke();
  function nextPage() {
    doc.addPage();
    text(`Счёт ${input.invoiceNumber} · продолжение`, left, 36, width, false, 8);
    y = 62;
  }
  function ensure(h: number) { if (y + h > doc.page.height - 65) nextPage(); }
  function paragraph(value: string, bold = false, size = 9, gap = 8) {
    ensure(Math.min(height(value, width, size, bold), 100));
    text(value, left, y, width, bold, size);
    y = doc.y + gap;
  }
  function party(label: string, value: string) {
    const h = Math.max(height(value, width - 95), 14);
    ensure(h + 9);
    text(label, left, y, 90, true);
    text(value, left + 95, y, width - 95);
    y += h + 9;
  }

  doc.font("bold").fontSize(24).fillColor(blue).text("BasQar", left, y);
  text("Реквизиты для оплаты в тенге", right - 240, y + 12, 240, false, 8, "right");
  y += 44;

  // Bank details use measured rows: long legal and bank names remain readable.
  const bankRows = [
    [
      { label: "Получатель", value: `${s.legalName}\nБИН ${s.bin}`, w: width * .49 },
      { label: "ИИК", value: s.iban, w: width * .37 },
      { label: "КБе", value: s.kbe, w: width * .14 },
    ],
    [
      { label: "Банк получателя", value: s.bankName, w: width * .49 },
      { label: "БИК", value: s.bik, w: width * .37 },
      { label: "КНП", value: s.knp || "—", w: width * .14 },
    ],
  ];
  for (const row of bankRows) {
    const h = Math.max(...row.map(c => height(c.value, c.w - 18))) + 32;
    ensure(h);
    let x = left;
    for (const cell of row) {
      doc.rect(x, y, cell.w, h).lineWidth(.6).strokeColor(border).stroke();
      font(false, 7).fillColor(muted).text(cell.label, x + 9, y + 6, { width: cell.w - 18 });
      text(cell.value, x + 9, y + 21, cell.w - 18);
      x += cell.w;
    }
    y += h;
  }
  y += 22;
  paragraph(`СЧЁТ НА ОПЛАТУ № ${input.invoiceNumber}`, true, 16, 4);
  paragraph(`от ${date(input.issueDate)} · Оплатить до ${date(input.dueDate)}`, false, 9, 5);
  const status: Record<string, string> = {
    PAID: "Оплачено. Повторная оплата не требуется.",
    CANCELLED: "Счёт отменён. Не оплачивать.",
    EXPIRED: "Срок оплаты истёк. Не оплачивать.",
  };
  if (status[input.status]) paragraph(status[input.status], true, 10, 6);
  rule(y + 4); y += 18;
  party("Поставщик", `${s.legalName}, БИН ${s.bin}\n${s.legalAddress}`);
  party("Покупатель", `${b.legalName}, БИН / ИИН ${b.bin}\n${b.legalAddress}`);
  party("Основание", input.orderBasis
    ? `Заказ BasQar № ${input.orderBasis.number} от ${date(new Date(input.orderBasis.date))}`
    : "Подписка BasQar согласно наименованию услуги в этом счёте");
  y += 6;

  const columns = [28, width - 28 - 42 - 48 - 84 - 90, 42, 48, 84, 90];
  const tableHead = () => {
    const h = 29;
    doc.rect(left, y, width, h).fill("#eef3f8");
    let x = left;
    ["№", "Наименование услуги", "Кол-во", "Ед.", "Цена, ₸", "Сумма, ₸"].forEach((v, i) => {
      text(v, x + 5, y + 8, columns[i] - 10, true, 8, i > 3 ? "right" : i === 1 ? "left" : "center");
      x += columns[i];
    });
    rule(y); y += h; rule(y);
  };
  // Keep long descriptions inside the table and repeat the header on new pages.
  font(false, 9);
  const lines: string[] = [];
  for (const part of input.description.split(/\r?\n/)) {
    let line = "";
    for (const word of part.split(/\s+/).filter(Boolean)) {
      if (line && doc.widthOfString(`${line} ${word}`) > columns[1] - 14) {
        lines.push(line); line = "";
      }
      // Even an unbroken identifier must not overflow into quantity/price.
      for (const char of (line ? ` ${word}` : word)) {
        if (doc.widthOfString(line + char) > columns[1] - 14) { lines.push(line); line = ""; }
        line += char;
      }
    }
    lines.push(line);
  }
  ensure(75); tableHead();
  let first = true;
  while (lines.length) {
    const capacity = Math.floor((doc.page.height - 75 - y - 16) / 15);
    if (capacity < 1) { nextPage(); tableHead(); continue; }
    const chunk = lines.splice(0, capacity);
    const rowHeight = Math.max(40, chunk.length * 15 + 16);
    let x = left;
    const values = first ? ["1", "", "1", "услуга", money(input.amountMinor), money(input.amountMinor)] : ["", "", "", "", "", ""];
    for (let i = 0; i < columns.length; i++) {
      if (i === 1) chunk.forEach((line, index) => text(line, x + 7, y + 8 + index * 15, columns[i] - 14));
      else text(values[i], x + 5, y + 8, columns[i] - 10, false, 9, i > 3 ? "right" : "center");
      doc.moveTo(x, y).lineTo(x, y + rowHeight).strokeColor(border).lineWidth(.6).stroke();
      x += columns[i];
    }
    doc.moveTo(right, y).lineTo(right, y + rowHeight).stroke();
    y += rowHeight; rule(y); first = false;
    if (lines.length) { nextPage(); tableHead(); }
  }
  y += 14;
  ensure(100);
  const vat = s.vatEnabled
    ? `В том числе НДС ${s.vatRate}%: ${money(input.amountMinor * s.vatRate / (100 + s.vatRate))} ₸`
    : "Без НДС";
  text(vat, left, y, width, false, 9, "right"); y += 23;
  text(`Итого к оплате: ${money(input.amountMinor)} ₸`, left, y, width, true, 12, "right"); y += 30;
  const words = amountToKztWords(input.amountMinor);
  paragraph(`Всего наименований: 1. На сумму ${money(input.amountMinor)} ₸.`, false, 9, 4);
  paragraph(`${words.charAt(0).toUpperCase()}${words.slice(1)} 00 тиын`, true, 10, 16);
  paragraph(`Назначение платежа: Оплата подписки BasQar по счёту № ${input.invoiceNumber} от ${date(input.issueDate)}. ${s.vatEnabled ? `Включая НДС ${s.vatRate}%.` : "Без НДС."}`, false, 9, 15);

  const signer = s.signerName || "____________________________";
  const position = s.signerPosition || "Уполномоченное лицо";
  const signatureHeight = Math.max(112, height(position, 148) + 24, height(signer, 130) + 24);
  ensure(signatureHeight + 50);
  rule(y);
  const signatureTop = y + 10;
  text(position, left, signatureTop + 49, 148);
  const sigX = left + 158;
  if (s.signatureDataUrl) doc.image(Buffer.from(s.signatureDataUrl.slice(22), "base64"), sigX, signatureTop, { fit: [115, 56], align: "center", valign: "bottom" });
  rule(signatureTop + 63, sigX, sigX + 115);
  text("подпись", sigX, signatureTop + 66, 115, false, 7, "center");
  text(signer, left + 294, signatureTop + 49, 130);
  if (s.stampDataUrl) doc.image(Buffer.from(s.stampDataUrl.slice(22), "base64"), right - 84, signatureTop + 4, { fit: [84, 84], align: "center", valign: "center" });
  y += signatureHeight;
  paragraph(`${s.supportEmail}${s.supportPhone ? ` · ${s.supportPhone}` : ""}`, false, 8, 4);
  paragraph("Счёт на оплату не заменяет акт оказанных услуг и фискальный чек.", false, 8, 0);

  const pages = doc.bufferedPageRange();
  for (let page = 0; page < pages.count; page++) {
    doc.switchToPage(page);
    // Footer stays within printable bounds; no accidental empty PDF page.
    doc.page.margins.bottom = 20;
    rule(doc.page.height - 45);
    text(`${input.invoiceNumber} · ${page + 1} / ${pages.count}`, left, doc.page.height - 40, width, false, 7, "right");
  }
  doc.end();
  return done;
}
