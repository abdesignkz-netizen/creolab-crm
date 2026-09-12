import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { extractPdfPages } from '../../apps/api/src/services/pdfTextExtraction.ts';
import { parsePdfDocument } from '../../apps/api/src/services/pdfDocumentParser.ts';
const start = Date.now();
let peak = 0;
const monitor = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
try {
  const pages = await extractPdfPages(await readFile('/Users/ashat/Documents/CreoLab/Презентации новые 2026/Самиголла рыб завод/Договор.pdf'));
  await writeFile('work/pdf-502/optimized-pages.json', JSON.stringify(pages));
  await writeFile('work/pdf-502/optimized-draft.json', JSON.stringify(parsePdfDocument(pages, 'CONTRACT'), null, 2));
  const { draft } = parsePdfDocument(pages, 'CONTRACT');
  const baseline = JSON.parse(await readFile('work/pdf-import/sample-draft.json', 'utf8')).draft;
  for (const field of ['number', 'date', 'contactPhone', 'detectedTotal'] as const) assert.equal(draft[field], baseline[field], field);
  for (const field of ['bin', 'iban', 'bik'] as const) assert.equal(draft.buyer[field], baseline.buyer[field], `buyer.${field}`);
  assert.equal(draft.seller.bin, baseline.seller.bin, 'seller.bin');
  assert.deepEqual(draft.items.map(i => [i.quantity, i.unitPrice]), baseline.items.map((i: {quantity: number; unitPrice: number}) => [i.quantity, i.unitPrice]));
  console.log('Contract regression passed: identifiers, buyer bank details, quantities, all three prices and total.');
  console.log(JSON.stringify({ pages: pages.length, ocrPages: pages.filter(p => p.ocr).length, seconds: (Date.now() - start) / 1000, peakRssMiB: Math.round(peak / 1024 / 1024), maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) }));
} finally { clearInterval(monitor); }
