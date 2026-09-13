import { moneyRound, lineAmounts } from "./documentMoney.ts";
import type { PdfImportDraft, PdfImportParty } from "@creolab/contracts";
import { wordsToLines, type PdfPageText } from "./pdfTextExtraction.ts";
import { invoiceTableRows } from "./invoiceTableParsing.ts";
import { invoicePayment } from "./invoicePayment.ts";

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
  const rawIban = text.match(/\bKZ(?:[ \t]*[A-Z\d]){18}\b/i)?.[0]?.replace(/[ \t]/g, "") || "";
  const normalizedText = lines.join("\n");
  const inlineAddress = name ? normalizedText.slice(normalizedText.indexOf(name)+name.length).replace(/^[\s,;]+/,"").split(/Тел(?:ефон)?\.?\s*:|БИН|ИИН|ИИК|БИК|\bKZ|Директор/i)[0].trim() : "";
  return {
    name: name.replace(/^TOO/, "ТОО"),
    bin: text.match(/(?:БИН|ИИН)\s*:?\s*(\d{12})/i)?.[1] || "",
    legalAddress: name && binIndex > 0 ? relevant.slice(1, binIndex).filter(l => !/^(?:Заказчик|Исполнитель)/i.test(l)).join(" ") : /^(?:РК|Казахстан|\d{6}|г\.)/i.test(inlineAddress) ? clean(inlineAddress.replace(/\n/g," ")) : "",
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
    // Only headings near the start of the requisites section define columns.
    // Signature labels in the page footer can be indented far into a column.
    const sectionTop = heading?.y ?? requisites.height * 0.35;
    const roleHeaders = words.filter(w => w.y < sectionTop + requisites.height * 0.15 && /^(?:Заказчик|Исполнитель)[:]?$/i.test(w.text.trim()));
    // Word often places the right cell just left of 55% of the page. Anchor
    // the split to the actual first row of company names, including split runs.
    const names = words.filter(w => /^(?:ТОО|TOO|ИП|АО|ЖШС)(?:\s|$)/i.test(w.text.trim()));
    const firstNameY = Math.min(...names.map(w => w.y));
    const nameHeaders = names.filter(w => Math.abs(w.y - firstNameY) < Math.max(w.height, 6));
    const anchors = roleHeaders.length >= 2 ? roleHeaders : nameHeaders;
    const columns = anchors.length >= 2 && Math.max(...anchors.map(w=>w.x)) - Math.min(...anchors.map(w=>w.x)) > requisites.width * 0.2
      ? Math.max(...anchors.map(w=>w.x)) - 2 : requisites.width * 0.55;
    const left = party(wordsToLines(words.filter(w => w.x < columns)).map(l => l.text).join("\n"));
    const right = party(wordsToLines(words.filter(w => w.x >= columns)).map(l => l.text).join("\n"));
    // Prefer explicit organisation identity; otherwise infer the roles from the preamble.
    const intro = clean(first);
    const sellerName = intro.match(/(?:ТОО|TOO|ИП|АО|ЖШС)\s*[«"“]([^»"”]+)[»"”][\s\S]{0,90}?«Исполнитель»/i)?.[1];
    const leftRole = roleHeaders.find(w => w.x < columns)?.text || "";
    const leftIsSeller = roleHeaders.length >= 2 ? /Исполнитель/i.test(leftRole)
      : Boolean((tenantBin && left.bin === tenantBin) || (sellerName && left.name.includes(sellerName)));
    [seller, buyer] = leftIsSeller ? [left, right] : [right, left];
    if (!tenantBin || (seller.bin !== tenantBin && buyer.bin !== tenantBin)) warnings.push("Проверьте, правильно ли определены заказчик и исполнитель; при необходимости поменяйте стороны местами.");
  } else {
    const supplier = text.match(/(?:^|\n)(?:Поставщик|Исполнитель)\s*:\s*([\s\S]+?)(?=\n(?:Покупатель|Заказчик)\s*:|$)/i)?.[1];
    const customer = text.match(/(?:^|\n)(?:Покупатель|Заказчик)\s*:\s*([\s\S]+?)(?=\n(?:Основание|Договор)\s*:|\n№|$)/i)?.[1];
    if (supplier) seller = party(supplier);
    if (customer) buyer = party(customer);
    if (kind === "INVOICE") {
      const bankText = text.split(/Сч[её]т\s+на\s+оплату/i)[0];
      const bankParty = party(bankText);
      if (bankParty.bin && bankParty.bin === seller.bin) {
        seller.iban ||= bankParty.iban;
        seller.bankName ||= bankText.split("\n").find(l=>/(?:АО|ТОО).*банк|Bank/i.test(l))?.split(/\s{2,}/)[0] || "";
        seller.bik ||= bankText.match(/\b[A-Z]{6}[A-Z\d]{2}(?:[A-Z\d]{3})?\b/)?.[0] || "";
      }
    }
  }
  const totalPage = [...pages].reverse().find(p => /(?:Итого|Всего к оплате)\s*:?\s*[\d\s]+/i.test(p.text));
  const finalTotalMatch = text.match(/(?:Всего|Итого)\s+к\s+оплате\s*:?\s*([\d][\d \u00a0]*(?:[.,]\d{1,2})?)/i);
  const totalMatch = finalTotalMatch || totalPage?.text.match(/(?:Итого|Всего к оплате)\s*:?\s*([\d][\d \u00a0]*(?:[.,]\d{1,2})?)/i);
  const detectedTotal = totalMatch ? numberValue(totalMatch[1]) : null;
  const statedRate = text.match(/НДС\s*[:—(-]?\s*(\d{1,2})\s*%/i)?.[1];
  const noVat = !statedRate && /(?:без\s*НДС|не является плательщиком НДС)/i.test(text);
  const vatRate = noVat ? 0 : Number(statedRate || 0);
  if (!noVat && !vatRate) warnings.push("Ставка НДС не определена. Проверьте её для каждой позиции.");
  const items: PdfImportDraft["items"] = kind === "INVOICE" ? pages.flatMap(p => {const rows=invoiceTableRows(p,vatRate);return rows.length?rows:invoiceRows(p.text,vatRate);}) : [];
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
  if (vatRate && items.length) {
    const rawTotal = moneyRound(items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0));
    const taxedTotal = moneyRound(items.reduce((sum, item) => sum + lineAmounts(item.quantity, item.unitPrice, vatRate).totalAmount, 0));
    const exclusivePrice = /(?:цен[аы]|стоимость)\s+(?:указан[аы]\s+)?без\s*(?:уч[её]та\s*)?НДС/i.test(text);
    const includesVat = /(?:в\s*том\s*числе|включая|включает(?:\s+в\s+себя)?|с\s*уч[её]том|с)\s+НДС|НДС\s+включ[её]н/i.test(text);
    const totalsMatchGross = detectedTotal !== null && Math.abs(rawTotal - detectedTotal) <= 0.01;
    const totalsMatchNet = detectedTotal !== null && Math.abs(taxedTotal - detectedTotal) <= 0.01;
    if (!exclusivePrice && !totalsMatchNet && (includesVat || (finalTotalMatch && totalsMatchGross))) {
      const divisor = 10000n + BigInt(Math.round(vatRate * 100));
      for (const item of items) {
        const cents = BigInt(Math.round(item.unitPrice * 100));
        item.unitPrice = Number((cents * 10000n + divisor / 2n) / divisor) / 100;
      }
    } else if (!exclusivePrice && !totalsMatchNet) {
      warnings.push("Проверьте, включён ли НДС в цены документа: в форме указываются цены без НДС.");
    }
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
  if (kind === "INVOICE") {
    const payment = invoicePayment([items.map(i=>i.name).join("\n"),...text.split("\n").filter(l=>/предоплат|аванс|остаток|окончательн|доплат|доп\.?\s*объ[её]м|дополнительн|назначение платежа|условия оплаты|полная оплата|оплата\s*100\s*%/i.test(l) && !/^\s*\d+[.)]?\s/.test(l))].join("\n"));
    draft.paymentKind=payment.paymentKind;
    draft.paymentTerms=payment.paymentTerms;
    draft.contractNumber=text.match(/(?:^|\n)Договор\s*:\s*(?:№|No\.?|N)?\s*([^\s]+)(?=\s+от)/i)?.[1] || "";
  }
  if (kind === "CONTRACT" && !contactPhone) warnings.push("Телефон заказчика не распознан. Укажите его для создания сделки.");
  if (!number || !draft.date) warnings.push("Проверьте номер и дату документа.");
  if (!buyer.name || !buyer.bin) warnings.push("Заполните название и БИН заказчика.");
  if (kind === "CONTRACT" && (!seller.name || !seller.bin)) warnings.push("Реквизиты исполнителя распознаны не полностью. Заполните название и БИН / ИИН: они будут сохранены в настройках компании.");
  if (tenantBin && seller.bin && seller.bin !== tenantBin) warnings.push("БИН исполнителя в PDF отличается от реквизитов текущей организации.");
  if (pages.some(p => p.ocr)) warnings.push("Документ содержит сканы. Перед сохранением сверьте номера, БИН и банковские реквизиты с PDF.");
  if (detectedTotal !== null && Math.abs(items.reduce((s,i)=>s+i.quantity*i.unitPrice*(1+i.vatRate/100),0)-detectedTotal)>0.01) warnings.push("Сумма позиций отличается от итога PDF. Уточните цены и НДС.");
  return { draft, warnings };
}
