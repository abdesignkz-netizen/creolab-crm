import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const result = await build({ stdin: { contents: `
  export {saveBlob} from './lib/download';
  export {isNativeApp, downloadInNativeApp, printPdfInNativeApp} from './lib/nativeApp';
  export {exportAnalyticsCsv, exportAnalyticsPdf} from './lib/statsExport';
`, resolveDir: fileURLToPath(new URL('../apps/web/src', import.meta.url)), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
const module = { exports: {} };
new Function('exports', 'module', 'require', result.outputFiles[0].text)(module.exports, module, createRequire(import.meta.url));
const api = module.exports;
const data = { period: { dateFrom: '2026-11-01', dateTo: '2026-11-03', label: '<script>unsafe()</script>' },
  sources: [{ name: 'WhatsApp', inquiries: 3, deals: 2, won: 1, conversion: 50, revenue: '120000.00' }] };
const sections = { overview: true, sources: true };

test('native CSV and PDF exports preserve content without a popup or detached download link', async t => {
  const files = [], prints = [];
  t.mock.method(globalThis, 'setTimeout', () => { throw new Error('Web download path must not run'); });
  const prior = globalThis.window;
  globalThis.window = { BasQarNative: { version: 1,
    download: async (blob, name) => { files.push({ blob, name }); }, printPdf: (html, name) => prints.push({ html, name }) },
    open: () => { throw new Error('Native PDF must not use window.open'); } };
  t.after(() => { globalThis.window = prior; });
  api.exportAnalyticsCsv(data, 'sources');
  assert.equal(files.length, 1);
  assert.match(files[0].name, /2026-11-01_2026-11-03_sources\.csv$/);
  assert.match(await files[0].blob.text(), /WhatsApp;3;2;1;50;120000\.00/);
  api.exportAnalyticsPdf(data, sections);
  assert.equal(prints.length, 1);
  assert.match(prints[0].name, /\.pdf$/);
  assert.match(prints[0].html, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/);
  assert.ok(!prints[0].html.includes('<script>'));
  const document = new Blob(['original signed content']);
  api.saveBlob(document, 'Договор.pdf');
  assert.equal(files.at(-1).blob, document, 'Existing documents must not be regenerated');
  assert.equal(files.at(-1).name, 'Договор.pdf');
});

test('browser exports still use a download link and the existing print window', t => {
  const previous = { window: globalThis.window, document: globalThis.document };
  const events = [], timers = [];
  globalThis.window = { open: () => ({ document: { write: html => events.push(html), close: () => {} },
    focus: () => {}, print: () => events.push('print') }) };
  globalThis.document = { createElement: () => ({ click() { events.push(this.download); }, remove() {} }),
    body: { appendChild: () => {} } };
  t.after(() => { globalThis.window = previous.window; globalThis.document = previous.document; });
  t.mock.method(globalThis, 'setTimeout', fn => { timers.push(fn); });
  t.mock.method(URL, 'createObjectURL', () => 'blob:https://bsqr.kz/test');
  t.mock.method(URL, 'revokeObjectURL', value => events.push(value));
  api.saveBlob(new Blob(['csv']), 'clients.csv');
  assert.ok(events.includes('clients.csv'));
  api.exportAnalyticsPdf(data, sections);
  for (const callback of timers) callback();
  assert.ok(events.some(event => event.startsWith('<!DOCTYPE html>')));
  assert.ok(events.includes('print'));
  assert.ok(events.includes('blob:https://bsqr.kz/test'));
});

test('native helpers are safe before browser initialization and require a compatible bridge', t => {
  const prior = globalThis.window;
  t.after(() => { globalThis.window = prior; });
  globalThis.window = undefined;
  assert.equal(api.isNativeApp(), false);
  assert.equal(api.downloadInNativeApp(new Blob(), 'file'), false);
  globalThis.window = { navigator: { userAgent: 'BasQarNative/1' }, BasQarNative: { version: 9,
    download: () => { throw new Error('Unknown bridge version'); }, printPdf: () => { throw new Error('Unknown bridge version'); } } };
  assert.equal(api.printPdfInNativeApp('<!DOCTYPE html>', 'report.pdf'), false);
  assert.equal(api.downloadInNativeApp(new Blob(), 'file'), false);
});
