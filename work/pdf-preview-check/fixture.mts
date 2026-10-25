import { writeFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { renderAvrPdf } from '../../apps/api/src/services/avrPdf.ts';
import { AVR_SOURCE_KIND } from '../../apps/api/src/services/avrMapper.ts';
const pdf = await PDFDocument.create();
for (const n of [1, 2]) {
  const amount = n * 120000;
  const { buffer } = await renderAvrPdf({ number: `AVR-2026-000${n}`, source: {
    kind: AVR_SOURCE_KIND,
    seller: { legalName: 'ТОО «Демо исполнитель»', bin: '111111111111', iin: '', legalAddress: 'Алматы, тестовый адрес, 1', directorName: 'Тестовый Исполнитель', directorPosition: 'Директор' },
    buyer: { name: 'Демо заказчик', legalName: 'ТОО «Демо заказчик»', bin: '222222222222', iin: '', legalAddress: 'Астана, тестовый адрес, 2', directorName: 'Тестовый Заказчик', directorPosition: 'Директор' },
    deal: { id: 'demo', title: 'Разработка презентации' },
    contract: { id: 'demo', number: 'DEMO-42', date: '2026-10-23T00:00:00.000Z', status: 'DRAFT' },
    invoice: null,
    items: [{ dealItemId: 'demo', name: 'Разработка презентации компании', description: null, quantity: n, unit: 'услуга', unitPrice: 120000, amountWithoutVat: amount, vatRate: 0, vatAmount: 0, totalAmount: amount, sortOrder: 0 }],
    totals: { amountWithoutVat: amount, vatAmount: 0, totalAmount: amount, currency: 'KZT' },
    documentDate: '2026-10-23T00:00:00.000Z'
  } });
  const rendered = await PDFDocument.load(buffer);
  const [page] = await pdf.copyPages(rendered, [0]);
  pdf.addPage(page);
}
await writeFile(new URL('./public/fixture.pdf', import.meta.url), await pdf.save());
