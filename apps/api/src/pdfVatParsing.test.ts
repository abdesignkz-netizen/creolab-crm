import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePdfDocument } from './services/pdfDocumentParser.ts';
function parse(text:string,kind:'INVOICE'|'CONTRACT'='INVOICE') {
  return parsePdfDocument([{page:1,text,words:[],width:600,height:800,ocr:false}],kind);
}
const table=(price:number,header='Цена')=>`Счет на оплату № 1 от 13.09.2026\n№ | Наименование | Количество | Ед. | ${header} | Сумма\n1 | Разработка сайта | 2 | услуга | ${price} | ${price*2}`;
test('Без НДС: preserves price and zero rate',()=>{
 const p=parse(table(150000)+'\nИтого: 300000\nБез НДС');
 assert.equal(p.draft.items[0].unitPrice,150000);assert.equal(p.draft.items[0].vatRate,0);
});
test('С НДС (12%): extracts net price instead of applying VAT twice',()=>{
 const p=parse(table(112000)+'\nИтого: 224000\nС НДС (12%)');
 assert.equal(p.draft.items[0].unitPrice,100000);assert.equal(p.draft.items[0].vatRate,12);
 assert.ok(!p.warnings.some(w=>w.includes('отличается от итога')));
});
test('separate net price column and gross payable total remain unchanged',()=>{
 const p=parse(table(100000,'Цена без НДС')+'\nИтого: 200000\nВ том числе НДС 12%\nВсего к оплате: 224000');
 assert.equal(p.draft.detectedTotal,224000);assert.equal(p.draft.items[0].unitPrice,100000);assert.equal(p.draft.items[0].vatRate,12);
});
test('subtotal followed by separate VAT must not be mistaken for a gross price',()=>{
 const p=parse(table(100000)+'\nИтого: 200000\nНДС 12%: 24000\nВсего к оплате: 224000');
 assert.equal(p.draft.items[0].unitPrice,100000);assert.equal(p.draft.detectedTotal,224000);
});
test('ambiguous subtotal does not trigger a guessed VAT deduction',()=>{
 const p=parse(table(100000)+'\nИтого: 200000\nНДС 12%: 24000');
 assert.equal(p.draft.items[0].unitPrice,100000);assert.ok(p.warnings.some(w=>w.includes('включён ли НДС')));
});
test('contract price with included VAT is normalized and fractional cents rounded',()=>{
 const p=parse('Договор № 1\nРазработка сайта 300000\nИтого: 300000\nСтоимость включает НДС 12%','CONTRACT');
 assert.equal(p.draft.items[0].unitPrice,267857.14);assert.equal(p.draft.items[0].vatRate,12);
});
