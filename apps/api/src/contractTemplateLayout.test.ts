import assert from 'node:assert/strict';
import { it } from 'node:test';
import JSZip from 'jszip';
import { buildPlainDocx } from './services/contractDocx.ts';
import { classifyServiceTable, fillDocxPlaceholders, replaceServiceTables, trimTrailingEmptyParagraphs } from './services/docxTemplateFill.ts';
import { rewriteScannedFragment, fillContextualLeftovers } from './services/contractTemplateScan.ts';
import { wordToPdf } from './services/wordDocumentConversion.ts';

const p = (text = '') => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const cell = (content: string) => `<w:tc><w:tcPr><w:tcW w:w="4500" w:type="dxa"/></w:tcPr>${content}</w:tc>`;
const table = (rows: string[][]) => `<w:tbl><w:tblPr/><w:tblGrid/>${rows.map(row => `<w:tr>${row.map(t => cell(p(t))).join('')}</w:tr>`).join('')}</w:tbl>`;
const assignment = table([['№', 'Вид Услуг, требования к результату', 'Сроки выполнения', 'Стоимость в тенге'], ['1', 'Старая услуга', '7 дней', '120 000']]);
const items = [{ name: 'Презентация на 29 слайдов', totalAmount: 200000 }];

it('не считает БИН, счёт, адрес и подписи таблицей услуг', () => {
  for (const rows of [
    [['РК, г. Астана, д. 4, БИН 123456789012, KZ123456789012345678, БИК TESTKZKX', '']],
    [['РК, г. Астана, БИН {{buyer_bin}}, {{buyer_iban}}', '']],
    [['Заказчик', 'Исполнитель'], ['Директор Иванов, М.П.', 'Директор Петров, М.П.']],
    [['2026', 'Астана', '120000']],
  ]) assert.equal(classifyServiceTable(rows), null);
  assert.equal(classifyServiceTable([['Старая услуга', '120 000 тенге']]), 'price');
  assert.equal(classifyServiceTable([['1', 'Комбинированный дизайн', '20 000 тенге за 1 слайд/страницу']]), 'price');
  assert.equal(classifyServiceTable([['№', 'Вид услуг', 'Срок', 'Стоимость'], ['1', 'Работы', '10 дней', '120000']]), 'assignment');
});

it('учитывает итог снаружи таблицы, включая внешний ряд вложенной таблицы', () => {
  const total = p('Итого: 200 000,00 ₸');
  for (const xml of [assignment + total, `<w:tbl><w:tr>${cell(assignment + p())}</w:tr><w:tr>${cell(total)}</w:tr></w:tbl>`]) {
    const filled = replaceServiceTables(xml, items, '30 дней', 200000);
    assert.equal((filled.match(/Итого:/g) || []).length, 1);
    assert.match(filled, /Презентация на 29 слайдов/);
    assert.doesNotMatch(filled, /Старая услуга|120 000/);
  }
  const separateAppendix = replaceServiceTables(assignment + p('Приложение №2') + total, items, '30 дней', 200000);
  assert.equal((separateAppendix.match(/Итого:/g) || []).length, 2);
});

it('не меняет номер приложения на номер договора', () => {
  const text = 'Стоимость по настоящему Договору указана в Приложении № 2 к Договору. Договор № 12082026/01';
  const empty = { name: '', bin: '', legalAddress: '', directorName: '', iban: '', bankName: '', bik: '' };
  const marked = rewriteScannedFragment(text, { seller: empty, buyer: empty });
  assert.match(marked, /Приложении № 2/);
  assert.match(marked, /Договор № \{\{contract_number\}\}/);
  assert.match(fillContextualLeftovers(text, { contract_number: 'DOG-2026-0011' }), /Приложении № 2/);
});

it('пустой хвост удаляется, но содержимое, рисунки и разрывы разделов сохраняются', () => {
  const section = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>';
  const drawing = '<w:p><w:r><w:drawing/></w:r></w:p>';
  const signature = p('Подпись __________________');
  const xml = `<w:body>${signature}${drawing}${p().repeat(20)}${section}</w:body>`;
  const result = trimTrailingEmptyParagraphs(xml);
  assert.ok(result.includes(signature)); assert.ok(result.includes(drawing)); assert.ok(result.includes(section));
  assert.equal((result.match(/<w:p>/g) || []).length, 3);
  const internalSection = '<w:p><w:pPr><w:sectPr><w:type w:val="nextPage"/></w:sectPr></w:pPr></w:p>';
  const withSection = trimTrailingEmptyParagraphs(`<w:body>${internalSection}${p().repeat(20)}${section}</w:body>`);
  assert.ok(withSection.includes(internalSection));
  assert.equal((withSection.match(/<w:p>/g) || []).length, 2);
});

it('PDF содержит новые реквизиты, один итог и три полные страницы без пустого хвоста', async () => {
  const zip = await JSZip.loadAsync(await buildPlainDocx('Договор'));
  const existing = await zip.file('word/document.xml')!.async('string');
  const bank = `<w:tbl><w:tblPr><w:tblW w:w="4500" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="4500"/></w:tblGrid><w:tr>${cell(p('РК, город Астана, район Есиль,') + p('улица Старая, д.4, офис 23') + p('БИН {{buyer_bin}}') + p('{{buyer_iban}}') + p('Банк {{buyer_bank}}') + p('БИК {{buyer_bik}}'))}</w:tr></w:tbl>`;
  const parties = `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="4500"/><w:gridCol w:w="4500"/></w:tblGrid><w:tr>${cell(p('{{buyer_name}}') + bank + p('Директор {{buyer_director}}'))}${cell(p('{{seller_name}}') + p('{{seller_address}}') + p('БИН {{seller_bin}}'))}</w:tr></w:tbl>`;
  const body = p('Договор № {{contract_number}}') + p('Условия договора сохранены.') + parties
    + p().repeat(40) + p('Приложение №1') + table([['1', 'Старая услуга', '120 000 тенге']]) + p('Подписи сторон')
    + p().repeat(40) + p('Приложение №2') + assignment + p('Итого: {{amount}}') + p('Подписи сторон') + p().repeat(100);
  zip.file('word/document.xml', existing.replace(/(<w:body>)[\s\S]*?(<w:sectPr)/, `$1${body}$2`));
  const docx = await fillDocxPlaceholders(Buffer.from(await zip.generateAsync({ type: 'nodebuffer' })), {
    contract_number: 'QA-2026-001', buyer_name: 'ТОО Новый заказчик', buyer_bin: '123456789012',
    buyer_address: 'РК, г. Караганда, ул. Новая, 99, офис 42', buyer_iban: 'KZ123456789012345678',
    buyer_bank: 'Заказчика', buyer_bik: 'TESTKZKX', buyer_director: 'Новый руководитель',
    seller_name: 'ТОО Исполнитель', seller_address: 'г. Алматы, ул. Примерная, 10', seller_bin: '111222333444', amount: '200 000,00 ₸',
  }, [], { items, totalAmount: 200000, completionTerms: '30 дней' });
  const { DOMMatrix, ImageData, Path2D } = await import('@napi-rs/canvas');
  Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = getDocument({ data: new Uint8Array(await wordToPdf(docx, 'docx')), useSystemFonts: true });
  const pdf = await loading.promise;
  try {
    assert.equal(pdf.numPages, 3);
    const pages: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      pages.push((await page.getTextContent()).items.map(item => 'str' in item ? item.str : '').join(' ').replace(/\s+/g, ' '));
      page.cleanup();
    }
    for (const text of ['Новый заказчик', 'Караганда', 'Новая, 99', '123456789012', 'KZ123456789012345678', 'TESTKZKX', 'Новый руководитель', '111222333444', 'Условия договора сохранены']) assert.ok(pages[0].includes(text), text + ": " + pages[0]);
    assert.ok(pages[1].includes('Приложение №1'));
    assert.ok(pages[2].includes('Приложение №2'));
    assert.equal((pages.join(' ').match(/Итого:/g) || []).length, 1);
    assert.doesNotMatch(pages.join(' '), /Старая|Астана|120\s*000|\{\{/);
  } finally { await loading.destroy(); }
});
