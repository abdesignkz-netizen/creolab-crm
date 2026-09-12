import { readFile, writeFile } from 'node:fs/promises';
import { extractPdfPages } from '../../apps/api/src/services/pdfTextExtraction.ts';
import { parsePdfDocument } from '../../apps/api/src/services/pdfDocumentParser.ts';
const start = Date.now();
let peak = 0;
const monitor = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
try {
  const pages = await extractPdfPages(await readFile('/Users/ashat/Documents/CreoLab/Презентации новые 2026/Самиголла рыб завод/Договор.pdf'));
  await writeFile('work/pdf-502/optimized-pages.json', JSON.stringify(pages));
  await writeFile('work/pdf-502/optimized-draft.json', JSON.stringify(parsePdfDocument(pages, 'CONTRACT'), null, 2));
  console.log(JSON.stringify({ pages: pages.length, ocrPages: pages.filter(p => p.ocr).length, seconds: (Date.now() - start) / 1000, peakRssMiB: Math.round(peak / 1024 / 1024), maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) }));
} finally { clearInterval(monitor); }
