import test from 'node:test';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';
import { readPdfSource } from '../apps/web/src/lib/pdfSource.ts';

Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
const { getDocument: openPdf } = await import('pdfjs-dist/legacy/build/pdf.mjs');
const fontDir = join(dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')), 'standard_fonts/');
const getDocument = source => openPdf({ ...source, standardFontDataUrl: fontDir });

async function pdfBlob(text, pageCount = 1) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pageCount; i++) pdf.addPage().drawText(`${text} - page ${i + 1}`, { font });
  return new Blob([await pdf.save()], { type: 'application/pdf' });
}

test('generated PDF blob opens in the installed PDF.js engine with its content and page count', async () => {
  const file = await pdfBlob('AVR 120000 KZT', 2);
  let task;
  try {
    const source = await readPdfSource(file, new AbortController().signal);
    assert.ok(source.data instanceof Uint8Array, 'blob URLs must not enter the PDF.js XHR transport');
    task = getDocument(source);
    const pdf = await task.promise;
    assert.equal(pdf.numPages, 2);
    const content = await (await pdf.getPage(2)).getTextContent();
    assert.match(content.items.map(item => item.str).join(' '), /AVR 120000 KZT - page 2/);
  } finally { await task?.destroy(); }
});

test('reopening a changed document reads fresh bytes, without a detached or stale buffer', async () => {
  const files = [await pdfBlob('First'), await pdfBlob('Second', 3)];
  for (const index of [0, 1, 0]) {
    const source = await readPdfSource(files[index], new AbortController().signal);
    const task = getDocument(source);
    try {
      const pdf = await task.promise;
      assert.equal(pdf.numPages, index === 0 ? 1 : 3);
      const content = await (await pdf.getPage(1)).getTextContent();
      assert.match(content.items.map(item => item.str).join(' '), index === 0 ? /First/ : /Second/);
    } finally { await task.destroy(); }
  }
});

test('closing a preview aborts before its file is read', async () => {
  const file = await pdfBlob('Cancelled');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readPdfSource(file, controller.signal), { name: 'AbortError' });
});

test('closing during a file read prevents it from reaching PDF.js', async () => {
  const controller = new AbortController();
  const file = { arrayBuffer: async () => { controller.abort(); return new ArrayBuffer(1); } };
  await assert.rejects(readPdfSource(file, controller.signal), { name: 'AbortError' });
});

test('invalid PDF bytes surface a failure for the viewer to display', async () => {
  const file = new Blob(['invalid PDF'], { type: 'application/pdf' });
  const task = getDocument(await readPdfSource(file, new AbortController().signal));
  try { await assert.rejects(task.promise, { name: 'InvalidPDFException' }); }
  finally { await task.destroy(); }
});

test('already downloaded PDFs require no second network request', async (t) => {
  const file = await pdfBlob('Offline preview');
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('No network allowed'); });
  const source = await readPdfSource(file, new AbortController().signal);
  assert.ok(source.data.byteLength > 0);
  assert.equal(fetch.mock.callCount(), 0);
});
