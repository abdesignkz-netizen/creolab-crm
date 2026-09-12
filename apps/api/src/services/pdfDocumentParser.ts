import type { PdfImportDraft, PdfImportParty } from "@creolab/contracts";
import { wordsToLines, type PdfPageText } from "./pdfTextExtraction.ts";

const clean = (text: string) => text.replace(/[|¦\[\]]/g, " ").replace(/[ \t]+/g, " ").trim();
const numberValue = (value: string) => Number(value.replace(/\s/g, "").replace(",", "."));
const emptyParty = (): PdfImportParty => ({ name: "", bin: "", legalAddress: "", iban: "", bankName: "", bik: "", directorName: "" });
const months = ["январ", "феврал", "март", "апрел", "ма[йя]", "июн", "июл", "август", "сентябр", "октябр", "ноябр", "декабр"];
function documentDate(text: string) {
  const numeric = text.match(/\b(\d{2})[./-](\d{2})[./-](20\d{2})\b/);
  if (numeric) return `${numeric[3]}-${numeric[2]}-${numeric[1]}`;
  for (const [i, month] of months.entries()) {
    const m = text.match(new RegExp(`[«"“]?(\\d{1,2})[»"”]?\\s+${month}[а-я]*\\s+(20\\d{2})`, "i"));
    if (m) return `${m[2]}-${String(i + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  return "";
}
function party(text: string): PdfImportParty {
  const lines = text.split("\n").map(clean).filter(Boolean);
  const nameIndex = lines.findIndex(l => /(?:ТОО|TOO|ИП|АО|ЖШС)\s*[«"“]/i.test(l));
  const relevant = nameIndex >= 0 ? lines.slice(nameIndex) : lines;
  const name = relevant[0]?.match(/(?:ТОО|TOO|ИП|АО|ЖШС)\s*[«"“][^»"”]+[»"”]/i)?.[0] || "";
  const binIndex = relevant.findIndex(l => /(?:БИН|БИН\/ИИН|ИИН)\s*:?\s*\d{12}/i.test(l));
  const directorIndex = relevant.findIndex(l => /^Директор(?:\s|$)/i.test(l));
  const rawIban = text.match(/\b(?:KZ|КZ|КЗ|К7)[A-ZА-Я\d]{18}\b/i)?.[0] || "";
  return {
    name: name.replace(/^TOO/, "ТОО"),
    bin: text.match(/(?:БИН|ИИН)\s*:?\s*(\d{12})/i)?.[1] || "",
    legalAddress: name && binIndex > 0 ? relevant.slice(1, binIndex).filter(l => !/^(?:Заказчик|Исполнитель)/i.test(l)).join(" ") : "",
    iban: /^KZ/i.test(rawIban) ? rawIban.toUpperCase() : "",
    bankName: relevant.find(l => /банк|Bank/i.test(l)) || "",
    bik: text.match(/БИК\s*:?\s*([A-Z\d]{8,11})/i)?.[1]?.toUpperCase() || "",
    directorName: directorIndex >= 0 ? relevant.slice(directorIndex + 1).find(l => /^[А-ЯЁ][а-яё]+\s+[А-ЯЁA-Z]\.\s*[А-ЯЁA-Z]\./.test(l)) || "" : "",
  };
}

/** Recognize explicitly separated invoice columns without guessing which amount is a price. */
function invoiceRows(text: string, vatRate: number): PdfImportDraft["items"] {
  const lines = text.split("\n");
  const headers = lines.find(l => /Наименование|Товары|Работы|Услуги/i.test(l) && /Кол|Количество/i.test(l) && /Цена/i.test(l));
  if (!headers) return [];
  const columns = headers.trim().split(/\s{2,}|\t|[|¦]/).map(clean).filter(Boolean);
  const nameIndex = columns.findIndex(c => /Наименование|Товары|Работы|Услуги/i.test(c));
  const quantityIndex = columns.findIndex(c => /Кол|Количество/i.test(c));
  const unitIndex = columns.findIndex(c => /^Ед/i.test(c));
  const priceIndex = columns.findIndex(c => /Цена/i.test(c));
  if ([nameIndex, quantityIndex, unitIndex, priceIndex].some(i => i < 0)) return [];
  return lines.flatMap(line => {
    const cells = line.trim().split(/\s{2,}|\t|[|¦]/).map(clean).filter(Boolean);
    if (cells.length !== columns.length || !/^\d+[.)]?$/.test(cells[0])) return [];
    const quantity = numberValue(cells[quantityIndex]);
    const price = numberValue(cells[priceIndex]);
    if (!cells[nameIndex] || !(quantity > 0) || !(price >= 0) || !Number.isFinite(price)) return [];
    return [{ name: cells[nameIndex], quantity, unitPrice: price, unit: cells[unitIndex], vatRate }];
  });
}

export function parsePdfDocument(pages: PdfPageText[], kind: "CONTRACT" | "INVOICE", tenantBin?: string | null) {
  const text = pages.map(p => p.text).join("\n");
  const first = pages[0]?.text || "";
  const warnings: string[] = [];
  let buyer = emptyParty(), seller = emptyParty();
  const requisites = pages.find(p => /РЕКВИЗИТЫ\s+СТОРОН/i.test(p.text));
  if (requisites) {
    const heading = requisites.words.find(w => /РЕКВИЗИТЫ/i.test(w.text));
    const words = requisites.words.filter(w => w.y > (heading?.y ?? requisites.height * 0.35));
    const left = party(wordsToLines(words.filter(w => w.x < requisites.width * 0.55)).map(l => l.text).join("\n"));
    const right = party(wordsToLines(words.filter(w => w.x >= requisites.width * 0.55)).map(l => l.text).join("\n"));
    // Prefer explicit organisation identity; otherwise infer the roles from the preamble.
    const intro = clean(first);
    const sellerName = intro.match(/(?:ТОО|TOO|ИП|АО|ЖШС)\s*[«"“]([^»"”]+)[»"”][\s\S]{0,90}?«Исполнитель»/i)?.[1];
    const leftIsSeller = Boolean((tenantBin && left.bin === tenantBin) || (sellerName && left.name.includes(sellerName)));
    [seller, buyer] = leftIsSeller ? [left, right] : [right, left];
    if (!tenantBin || (seller.bin !== tenantBin && buyer.bin !== tenantBin)) warnings.push("Проверьте, правильно ли определены заказчик и исполнитель; при необходимости поменяйте стороны местами.");
  } else {
    const supplier = text.match(/(?:Поставщик|Исполнитель)\s*:?\s*([\s\S]+?)(?=Покупатель|Заказчик|$)/i)?.[1];
    const customer = text.match(/(?:Покупатель|Заказчик)\s*:?\s*([\s\S]+?)(?=Основание|Договор|№\s*(?:Наименование|Товар)|$)/i)?.[1];
    if (supplier) seller = party(supplier);
    if (customer) buyer = party(customer);
  }
  const totalPage = [...pages].reverse().find(p => /(?:Итого|Всего к оплате)\s*:?\s*[\d\s]+/i.test(p.text));
  const totalMatch = totalPage?.text.match(/(?:Итого|Всего к оплате)\s*:?\s*([\d][\d \u00a0]*(?:[.,]\d{1,2})?)/i);
  const detectedTotal = totalMatch ? numberValue(totalMatch[1]) : null;
  const noVat = /(?:без\s*(?:учета\s*)?НДС|не является плательщиком НДС|НДС\s*:?\s*без НДС)/i.test(text);
  const vatRate = noVat ? 0 : Number(text.match(/НДС\s*[:—-]?\s*(\d{1,2})\s*%/i)?.[1] || 0);
  if (vatRate) warnings.push("Проверьте, включён ли НДС в цены PDF: в форме указываются цены без НДС.");
  if (!noVat && !vatRate) warnings.push("Ставка НДС не определена. Проверьте её для каждой позиции.");
  const items: PdfImportDraft["items"] = kind === "INVOICE" ? pages.flatMap(p => invoiceRows(p.text, vatRate)) : [];
  if (totalPage && !items.length) {
    for (const raw of totalPage.text.split("\n")) {
      const line = clean(raw);
      if (/^(?:Итого|Всего|НДС)/i.test(line)) continue;
      const m = line.match(/^(?:\d+[.)]?\s+)?((?:Разработка|Верстка|Вёрстка|Создание|Услуги|Дизайн|Аудит|Изготовление|Поставка)[\s\S]+?)\s+(\d[\d ]*(?:[.,]\d{1,2})?)\s*(?:тенге|тг|₸)?$/i);
      if (!m) continue;
      const name = m[1].replace(/\s+\d+\s*[-–]\s*\d+\s+рабочих?\s+дн[яей]*\s*$/i, "").trim();
      items.push({ name, quantity: 1, unitPrice: numberValue(m[2]), vatRate, unit: "услуга" });
    }
  }
  if (!items.length) {
    const scope = text.match(/2\.2\.1\.?\s*([\s\S]+?)(?=2\.3\.|3\.\s*ПРАВА)/)?.[1];
    if (scope) for (const name of scope.split(/2\.2\.\d\.?/).map(clean).filter(Boolean)) items.push({ name: name.replace(/^Разработать\s+/i, "Разработка "), quantity: 1, unitPrice: 0, vatRate, unit: "услуга" });
    warnings.push("Проверьте состав работ и укажите стоимость позиций: таблица распознана не полностью.");
  }
  const contactPhone = clean(first).match(/Контактное\s+лицо\s+(?:от\s+)?Заказчика\s*:?\s*(\+?[78][\d ()-]{9,20})/i)?.[1]?.trim() || "";
  const paymentTerms = text.match(/(?:^|\n)4\.5\.?\s*([\s\S]+?)(?=\n4\.6\.|\n5\.\s*УСЛОВИЯ)/)?.[0] || "";
  const number = first.match(/(?:Договор|Сч[её]т(?:\s+на\s+оплату)?)[^\n№]{0,65}№\s*([^\s]+)/i)?.[1] || "";
  if (!buyer.directorName) buyer.directorName = clean(first).match(/«Заказчик»[\s\S]{0,50}?Директора\s+([А-ЯЁ][а-яё]+\s+[А-ЯЁA-Z]\.\s*[А-ЯЁA-Z]\.)/)?.[1] || "";
  const deadlineLines = totalPage?.text.split("\n").filter(l => /рабочих?\s+дн/i.test(l)).map(l => clean(l).match(/\d+\s*[-–]\s*\d+\s+рабочих?\s+дн[яей]*/i)?.[0]).filter(Boolean) || [];
  const draft: PdfImportDraft = {
    kind, number, date: documentDate(first), seller, buyer,
    contactName: buyer.directorName, contactPhone,
    subject: items.map(i => i.name).join("; ").slice(0,1000),
    paymentTerms: clean(paymentTerms).slice(0,4000), completionTerms: [...new Set(deadlineLines)].join("; "), items, detectedTotal,
  };
  if (kind === "CONTRACT" && !contactPhone) warnings.push("Телефон заказчика не распознан. Укажите его для создания сделки.");
  if (!number || !draft.date) warnings.push("Проверьте номер и дату документа.");
  if (!buyer.name || !buyer.bin) warnings.push("Заполните название и БИН заказчика.");
  if (tenantBin && seller.bin && seller.bin !== tenantBin) warnings.push("БИН исполнителя в PDF отличается от реквизитов текущей организации.");
  if (pages.some(p => p.ocr)) warnings.push("Документ содержит сканы. Перед сохранением сверьте номера, БИН и банковские реквизиты с PDF.");
  if (detectedTotal !== null && Math.abs(items.reduce((s,i)=>s+i.quantity*i.unitPrice*(1+i.vatRate/100),0)-detectedTotal)>0.01) warnings.push("Сумма позиций отличается от итога PDF. Уточните цены и НДС.");
  return { draft, warnings };
}
