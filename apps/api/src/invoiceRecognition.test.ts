import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { invoiceTableRows } from "./services/invoiceTableParsing.ts";
import { invoicePayment } from "./services/invoicePayment.ts";
import { parsePdfDocument } from "./services/pdfDocumentParser.ts";
import { wordsToLines, type PdfPageText, type PdfWord } from "./services/pdfTextExtraction.ts";

// Synthetic, anonymized invoice: name/quantity headers are blank and names wrap.
function fixture(): PdfPageText {
  const word = (text: string, x: number, y: number, width: number): PdfWord => ({text,x,y,width,height:10});
  const words = [word("№",38,370,12),word("Код",84,370,20),word("Ед.изм.",355,370,41),word("Цена",440,370,26),word("Сумма",514,370,34),
    word("1",41,400,7),word("Доп. объем к презентации",132,394,155),word("на 2 слайда/страницы",132,408,100),word("2",312,400,5),word("услуга",362,400,27),word("12 500,00",432,400,40),word("25 000,00",510,400,40),
    word("2",41,440,7),word("Верстка материалов",132,435,155),word("для печати",132,449,100),word("3",312,440,5),word("шт",362,440,27),word("1 000,00",432,440,40),word("3 000,00",510,440,40),
    word("Итого: 28 000,00",450,475,100),word("Без НДС",450,490,70)];
  const preamble = 'Счёт на оплату № TEST-71 от 28.04.2026\nУведомление об оплате Поставщика обязательно.\nПоставщик: БИН / ИИН 123456789012, ТОО «Студия», РК, г. Алматы, ул. Примерная 1\nПокупатель: БИН / ИИН 987654321012, АО «Заказчик», РК, г. Астана, ул. Тестовая 2\nДоговор: № TEST-01 от 01.04.2026\n';
  return {page:1,words,width:595,height:842,ocr:false,text:preamble+wordsToLines(words).map(l=>l.text).join("\n")};
}
describe("Invoice recognition",()=>{
  it("extracts multiline work, volume and amounts without name/quantity headers",()=>{
    const {draft}=parsePdfDocument([fixture()],"INVOICE");
    assert.deepEqual(draft.items.map(i=>[i.name,i.quantity,i.unit,i.unitPrice]),[
      ["Доп. объем к презентации на 2 слайда/страницы",2,"услуга",12500],
      ["Верстка материалов для печати",3,"шт",1000],
    ]);
    assert.equal(draft.detectedTotal,28000);
    assert.equal(draft.paymentKind,"ADDITIONAL");
    assert.equal(draft.contractNumber,"TEST-01");
    assert.equal(draft.buyer.name,'АО «Заказчик»');
    assert.equal(draft.buyer.bin,"987654321012");
    assert.equal(draft.buyer.legalAddress,"РК, г. Астана, ул. Тестовая 2");
    assert.equal(draft.seller.name,'ТОО «Студия»');
    assert.ok(draft.subject.includes("на 2 слайда/страницы"));
  });
  it("does not guess a row whose quantity and price disagree with its amount",()=>{
    const page=fixture();page.words.find(w=>w.text==="25 000,00")!.text="90 000,00";
    assert.equal(invoiceTableRows(page,0).length,1);
    page.text=page.text.replace("25 000,00","90 000,00");
    const result=parsePdfDocument([page],"INVOICE");
    assert.ok(result.warnings.some(w=>w.includes("Сумма позиций отличается")));
  });
  it("preserves payment percentages, with no invented qualifier",()=>{
    for (const [text,kind] of [["Предоплата 50% за дизайн","PREPAYMENT"],["Аванс 30% за услуги","PREPAYMENT"],["Остаток 70% за разработку сайта","BALANCE"],["Окончательный расчёт за услуги","BALANCE"],["Дополнительные работы по макету","ADDITIONAL"],["Полная оплата за дизайн","FULL"],["Оплата 100% за услуги","FULL"]] as const) {
      const result=invoicePayment(text);assert.equal(result.paymentKind,kind);assert.equal(result.paymentTerms,text);
    }
    assert.equal(invoicePayment("Дизайн презентации").paymentKind,"UNSPECIFIED");
    const mixed=invoicePayment("Предоплата 50%, остаток 50% после сдачи");
    assert.equal(mixed.paymentKind,"UNSPECIFIED");assert.match(mixed.paymentTerms,/остаток 50%/);
  });
});
