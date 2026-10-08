import assert from "node:assert/strict";
import { it } from "node:test";
import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import { renderBillingInvoice, sellerSchema } from "./services/billing/documents.ts";

const seller = {
  legalName: 'ТОО «Тестовый поставщик»', bin: '123456789012',
  legalAddress: 'РК, г. Алматы, тестовая улица, 1',
  iban: 'KZ123456789012345678', bankName: 'Тестовый банк', bik: 'TESTKZKX', kbe: '17',
  vatEnabled: false, vatRate: 0, supportEmail: 'billing@example.test',
  supportPhone: '+77000000000', invoicePrefix: 'BSQ-INV',
};
const invoice = {
  invoiceNumber: 'BSQ-INV-2026-000001', issueDate: new Date('2026-10-07T20:30:00Z'),
  dueDate: new Date('2026-10-15T12:00:00Z'), description: 'Подписка BasQar — BasQar Pro, 1 месяц',
  amountMinor: 69990, sellerJson: seller, buyerJson: {
    legalName: 'ТОО «Покупатель»', bin: '987654321012', legalAddress: 'г. Астана, тестовая улица, 2',
    email: 'buyer@example.test', phone: '+77000000001',
  }, status: 'ISSUED',
};
async function inspect(buffer: Buffer) {
  Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = getDocument({ data: new Uint8Array(buffer), useSystemFonts: true });
  const pdf = await loading.promise;
  const pages: string[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items = content.items.filter((item): item is Extract<typeof item, { str: string }> => 'str' in item && !!item.str.trim());
    for (const item of items) {
      assert(item.transform[4] >= 35, `left overflow: ${item.str}`);
      assert(item.transform[4] + item.width <= 561, `right overflow: ${item.str}`);
      assert(item.transform[5] > 20 && item.transform[5] < 811, `vertical overflow: ${item.str}`);
    }
    pages.push(items.map(item => item.str).join(' ').replace(/\s+/g, ' '));
  }
  await loading.destroy();
  return pages;
}
it('legacy invoice renders a complete one-page payment invoice without inventing a contract or signature', async () => {
  const pages = await inspect(await renderBillingInvoice(invoice));
  assert.equal(pages.length, 1);
  const text = pages[0];
  for (const expected of ['Получатель', seller.iban, seller.bik, 'Кол-во', 'Ед.', 'Цена, ₸', 'Сумма, ₸',
    '69 990,00', 'Шестьдесят девять тысяч девятьсот девяносто тенге 00 тиын', 'Без НДС', '08.10.2026', '15.10.2026', 'Назначение платежа', 'Уполномоченное лицо']) {
    assert(text.includes(expected), expected);
  }
  assert(!text.includes('Оферта'));
  assert(!text.includes('НДС 16%'));
});
it('uses the snapshotted order and signatory, with bounded PNG assets', async () => {
  const png = createCanvas(100, 40).toDataURL('image/png');
  const pages = await inspect(await renderBillingInvoice({ ...invoice, sellerJson: {
    ...seller, knp: '859', signerName: 'Тестов А.Б.', signerPosition: 'Исполнитель',
    signatureDataUrl: png, stampDataUrl: png,
    orderBasis: { number: 'BSQ-2026-000007', date: '2026-10-07T20:30:00Z' },
  } }));
  assert.equal(pages.length, 1);
  assert(pages[0].includes('Заказ BasQar № BSQ-2026-000007 от 08.10.2026'));
  assert(pages[0].includes('Тестов А.Б.'));
});
it('long legal names, addresses and descriptions paginate with every word and footer preserved', async () => {
  const description = Array.from({ length: 160 }, (_, i) => `Услуга-${String(i).padStart(3, '0')}`).join(' ');
  const pages = await inspect(await renderBillingInvoice({ ...invoice, description,
    sellerJson: { ...seller, legalName: 'Компания '.repeat(22).trim(), legalAddress: 'Адрес '.repeat(80).trim(), bankName: 'Банк '.repeat(38).trim() },
    buyerJson: { ...invoice.buyerJson, legalName: 'Покупатель '.repeat(18).trim(), legalAddress: 'Мекенжай '.repeat(55).trim() },
  }));
  assert(pages.length > 1);
  const text = pages.join(' ');
  for (let i = 0; i < 160; i++) assert(text.includes(`Услуга-${String(i).padStart(3, '0')}`));
  pages.forEach((page, i) => assert(page.includes(`${i + 1} / ${pages.length}`)));
  assert(text.includes('Шестьдесят девять тысяч девятьсот девяносто тенге'));
});
it('paid, expired and cancelled invoices clearly prevent a repeat payment', async () => {
  for (const [status, expected] of [['PAID', 'Повторная оплата не требуется'], ['CANCELLED', 'Счёт отменён'], ['EXPIRED', 'Срок оплаты истёк']]) {
    const pages = await inspect(await renderBillingInvoice({ ...invoice, status }));
    assert(pages.join(' ').includes(expected));
  }
});
it('inclusive VAT preserves the gross price and makes the tax amount explicit', async () => {
  const pages = await inspect(await renderBillingInvoice({ ...invoice, amountMinor: 116000,
    sellerJson: { ...seller, vatEnabled: true, vatRate: 16 },
  }));
  assert(pages[0].includes('НДС 16%: 16 000,00 ₸'));
  assert(pages[0].includes('Итого к оплате: 116 000,00 ₸'));
});
it('seller validation rejects remote assets, incorrect KNP, unnamed signatures and oversized PNG dimensions', () => {
  assert(sellerSchema.safeParse(seller).success);
  assert(!sellerSchema.safeParse({ ...seller, stampDataUrl: 'https://example.test/stamp.png' }).success);
  assert(!sellerSchema.safeParse({ ...seller, knp: '85' }).success);
  const png = createCanvas(1, 1).toDataURL('image/png');
  assert(!sellerSchema.safeParse({ ...seller, signatureDataUrl: png }).success);
  assert(sellerSchema.safeParse({ ...seller, signatureDataUrl: png, signerName: 'Тестов А.Б.' }).success);
  const huge = Buffer.from(png.slice(22), 'base64'); huge.writeUInt32BE(90000, 16);
  assert(!sellerSchema.safeParse({ ...seller, stampDataUrl: `data:image/png;base64,${huge.toString('base64')}` }).success);
});
