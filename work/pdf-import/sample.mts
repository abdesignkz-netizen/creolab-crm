import { readFile, writeFile } from 'node:fs/promises';
import { extractPdfPages } from '../../apps/api/src/services/pdfTextExtraction.ts';
const pages=await extractPdfPages(await readFile('/Users/ashat/Documents/CreoLab/Презентации новые 2026/Самиголла рыб завод/Договор.pdf'));
await writeFile('work/pdf-import/sample-ocr.json',JSON.stringify(pages));
await writeFile('work/pdf-import/sample-ocr.txt',pages.map(p=>`PAGE ${p.page}\n${p.text}`).join('\n'));
console.log(pages.map(p=>({page:p.page,ocr:p.ocr,characters:p.text.length})));
