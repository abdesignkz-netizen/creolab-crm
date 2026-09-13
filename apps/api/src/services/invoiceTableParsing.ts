import type { PdfImportDraft } from "@creolab/contracts";
import { wordsToLines, type PdfPageText, type PdfWord } from "./pdfTextExtraction.ts";

const center = (w: PdfWord) => w.x + w.width / 2;
const numeric = (text: string) => /^\d[\d \u00a0]*(?:[.,]\d+)?$/.test(text.trim()) ? Number(text.replace(/\s/g, "").replace(",", ".")) : NaN;
const join = (words: PdfWord[]) => wordsToLines(words).map(l=>l.text).join(" ").replace(/\s+/g," ").trim();

/** Read by column positions, including invoices with blank name/quantity headers. */
export function invoiceTableRows(page: PdfPageText, vatRate: number): PdfImportDraft["items"] {
  const price = page.words.find(w=>/^Цена$/i.test(w.text.trim()));
  if (!price) return [];
  const headers = page.words.filter(w=>Math.abs(w.y-price.y)<Math.max(w.height,price.height));
  const unit = headers.find(w=>/^Ед\.?\s*(?:изм\.?)?$/i.test(w.text.trim()));
  const sum = headers.find(w=>/^Сумма$/i.test(w.text.trim()));
  const index = headers.find(w=>/^№$/.test(w.text.trim()));
  if (!unit || !sum || !index || !(unit.x < price.x && price.x < sum.x)) return [];
  const code = headers.find(w=>/^Код$/i.test(w.text.trim()));
  const nameHeader = headers.find(w=>/Наименование|Товары|Работы|Услуги/i.test(w.text));
  const nameMin = nameHeader?.x ?? (code ? code.x+code.width : index.x+index.width+3);
  const end = page.words.filter(w=>w.y>price.y && /^(?:Итого|Всего|Без НДС)/i.test(w.text.trim())).sort((a,b)=>a.y-b.y)[0]?.y ?? page.height;
  const numbers = page.words.filter(w=>w.y>price.y+price.height && w.y<end && Math.abs(center(w)-center(index))<Math.max(12,index.width) && /^\d+[.)]?$/.test(w.text.trim())).sort((a,b)=>a.y-b.y);
  const priceMin=(center(unit)+center(price))/2, sumMin=(center(price)+center(sum))/2;
  const items: PdfImportDraft["items"] = [];
  for (const [i, row] of numbers.entries()) {
    const top=i ? (numbers[i-1].y+row.y)/2 : price.y+price.height;
    const bottom=i+1<numbers.length ? (row.y+numbers[i+1].y)/2 : end;
    const words=page.words.filter(w=>w.y>top && w.y<bottom);
    const quantityWord=words.filter(w=>w.x>=nameMin && center(w)<unit.x && Number.isFinite(numeric(w.text))).sort((a,b)=>b.x-a.x)[0];
    if (!quantityWord) continue;
    const quantity=numeric(quantityWord.text);
    const unitPrice=numeric(join(words.filter(w=>center(w)>=priceMin && center(w)<sumMin)));
    const amount=numeric(join(words.filter(w=>center(w)>=sumMin)));
    const name=join(words.filter(w=>w.x>=nameMin-2 && center(w)<quantityWord.x));
    const unitName=join(words.filter(w=>center(w)>center(quantityWord) && center(w)<priceMin));
    // A row with inconsistent amounts needs manual review, never guessed totals.
    if (!name || !unitName || !(quantity>0) || !(unitPrice>=0) || !Number.isFinite(amount) || Math.abs(quantity*unitPrice-amount)>0.02) continue;
    items.push({name,quantity,unitPrice,unit:unitName,vatRate});
  }
  return items;
}

