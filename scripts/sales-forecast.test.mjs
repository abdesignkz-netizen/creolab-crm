import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
async function bundle(contents) {
  const result = await build({ stdin: { contents, loader: 'tsx', resolveDir: path.join(root, 'apps/web/src') },
    loader: { '.css': 'empty' }, jsx: 'automatic', bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
  const module = { exports: {} };
  new Function('exports', 'module', 'require', result.outputFiles[0].text)(module.exports, module, createRequire(import.meta.url));
  return module.exports;
}
const money = amount => ({ amount, exact: String(amount), label: `${amount} ₸` });
function fixture() {
  return { status: 'ready', method: 'median_daily_sales_v1', source: 'recorded_won_deals', asOf: '2029-10-16T07:00:00Z', timeZone: 'Asia/Almaty', currency: 'KZT',
    month: '2029-10', from: '2029-09-30T19:00:00Z', to: '2029-10-31T19:00:00Z', elapsedDays: 15.5, remainingDays: 15.5, filtered: false,
    actual: money(700), estimate: money(2250), range: { low: money(700), high: money(3800) },
    history: [{ month: '2029-07', days: 31, sales: 5, total: money(3100), missingAmounts: 0 }],
    evidence: { firstRecordAt: '2029-03-15T10:00:00Z', months: 6, sales: 25, requiredMonths: 3, requiredSales: 10, maxMonths: 6, missingAmounts: 0, missingClosedDates: 0, negativeAmounts: 0, futureClosedDates: 0, otherCurrencySales: 1 },
    deviation: { status: 'below', expected: money(1550), percent: -54.8, minimumDays: 7, thresholdPercent: 20 },
    target: { status: 'at_risk', amount: money(3100), estimatedGap: money(850), estimatedPercent: 72.6 },
    validation: { method: 'rolling_month_start', periods: [{ month: '2029-07', estimate: money(3100), actual: money(3200), absoluteError: money(100) }], meanAbsoluteError: money(100), weightedAbsoluteErrorPercent: 3.1 } };
}
const renderModule = bundle(`
  import {renderToStaticMarkup} from 'react-dom/server';
  import {MemoryRouter} from 'react-router-dom';
  import {SessionContext,emptyCaps} from './lib/session';
  import {SalesForecastCard} from './components/SalesForecastCard';
  export const render=(locale,forecast,canSetPlan=true)=>renderToStaticMarkup(<SessionContext.Provider value={{me:{user:{locale}},caps:emptyCaps}}><MemoryRouter><SalesForecastCard forecast={forecast} canSetPlan={canSetPlan} onCurrentMonth={()=>{}} onRefresh={()=>{}}/></MemoryRouter></SessionContext.Provider>);
`);

test('Forecast translations have unique keys and retain every parameter', () => {
  const source = ts.createSourceFile('forecast.ts', readFileSync(path.join(root, 'apps/web/src/lib/salesForecastPresentation.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.filter(ts.isVariableStatement).flatMap(s => s.declarationList.declarations).find(d => d.name.getText(source) === 'forecastKk');
  const pairs = declaration.initializer.properties.map(p => [p.name.text, p.initializer.text]);
  assert.equal(new Set(pairs.map(([key]) => key)).size, pairs.length);
  const params = value => [...value.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
  for (const [ru, kk] of pairs) { assert.ok(kk?.trim(), ru); assert.deepEqual(params(ru), params(kk), ru); }
});

test('Forecast card exposes the method, data period, uncertainty, risk and validation in both languages', async () => {
  const { render } = await renderModule;
  const ru = render('ru', fixture()), kk = render('kk', fixture());
  for (const html of [ru, kk]) {
    assert.match(html, /2250 ₸/); assert.match(html, /700 ₸ — 3800 ₸/); assert.match(html, /72\.6%/);
    assert.match(html, /<details/); assert.match(html, /Asia\/Almaty/); assert.match(html, /href="\/deals"/);
    assert.match(html, /href="\/tasks"/); assert.match(html, /scope="col"/); assert.doesNotMatch(html, /NaN|undefined/);
  }
  assert.match(ru, /не вероятность результата/); assert.match(ru, /не точность сегодняшнего прогноза/);
  assert.match(ru, /Базовая оценка ниже плана/); assert.match(ru, /Тестовые и архивные/);
  assert.match(kk, /Сату қарқыны/); assert.match(kk, /сату болжамы/); assert.match(kk, /маусымдық/);
  assert.doesNotMatch(kk, /Прогноз|Оценка|Сначала|История|План на этот|Расчёт на/);
});

test('Unavailable, sparse, incomplete and non-current periods never render a stale estimate', async () => {
  const { render } = await renderModule;
  for (const status of ['unavailable', 'insufficient_history', 'incomplete_data', 'unsupported_period']) {
    const f = fixture(); f.status = status; f.evidence.missingAmounts = status === 'incomplete_data' ? 2 : 0;
    for (const locale of ['ru', 'kk']) {
      const html = render(locale, f); assert.doesNotMatch(html, /2250 ₸|72\.6%|700 ₸ — 3800 ₸/);
      assert.doesNotMatch(html, /NaN|undefined/);
    }
  }
  assert.match(render('ru', { ...fixture(), status: 'unsupported_period' }), /Показать текущий месяц/);
  assert.match(render('ru', { ...fixture(), status: 'unavailable' }), /Обновить расчёт/);
  assert.equal(render('ru', undefined), '');
});

test('Filtered estimates do not compare against company targets and plan editing obeys capabilities', async () => {
  const { render } = await renderModule;
  const f = fixture(); f.filtered = true; f.target.status = 'filtered'; f.target.estimatedPercent = null; f.target.estimatedGap = { amount: null, exact: null, label: null };
  const filtered = render('ru', f); assert.match(filtered, /не сравнивается с отфильтрованной/); assert.doesNotMatch(filtered, /72\.6%/);
  f.target.status = 'not_set';
  assert.match(render('ru', f, true), /href="\/settings\?section=ops#sales-plan"/);
  assert.doesNotMatch(render('ru', f, false), /href="\/settings/);
  f.validation.periods = [];
  assert.match(render('ru', f), /Пока нет месяцев для независимой проверки/);
});

test('CSV, spreadsheet and printable exports retain the forecast basis and do not publish an unexplained number', async () => {
  const exports = await bundle(`export {exportAnalyticsCsv,exportAnalyticsExcel,exportAnalyticsPdf} from './lib/statsExport';`);
  const data = { currency: 'KZT', period: { label: 'Октябрь 2029' }, financial: { sales: { byCurrency: [] }, receipts: { byCurrency: [] } }, sales: { forecast: fixture() }, funnel: { steps: [] } };
  const previous = { document: globalThis.document, window: globalThis.window, create: URL.createObjectURL, revoke: URL.revokeObjectURL }, blobs = [];
  globalThis.document = { createElement: () => ({ click() {} }) }; globalThis.window = { open: () => null };
  URL.createObjectURL = blob => { blobs.push(blob); return 'blob:forecast-test'; }; URL.revokeObjectURL = () => {};
  try {
    exports.exportAnalyticsCsv(data, 'funnel'); exports.exportAnalyticsExcel(data, { sales: true }); exports.exportAnalyticsPdf(data, { sales: true });
    assert.equal(blobs.length, 3);
    for (const blob of blobs) {
      const text = await blob.text(); assert.match(text, /2250 ₸/); assert.match(text, /Asia\/Almaty/);
      assert.match(text, /медианный дневной темп/); assert.match(text, /не вероятность/); assert.match(text, /72\.6%/);
      assert.match(text, /только по более ранним месяцам/); assert.match(text, /сезонность/);
    }
    const bad = fixture(); bad.status = 'incomplete_data'; bad.history[0].missingAmounts = 1;
    exports.exportAnalyticsExcel({ ...data, sales: { forecast: bad } }, { sales: true });
    const incomplete = await blobs[3].text(); assert.doesNotMatch(incomplete, /2250 ₸|72\.6%/); assert.match(incomplete, /Сумма продаж —; Без суммы: 1/);
  } finally {
    if (previous.document === undefined) delete globalThis.document; else globalThis.document = previous.document;
    if (previous.window === undefined) delete globalThis.window; else globalThis.window = previous.window;
    URL.createObjectURL = previous.create; URL.revokeObjectURL = previous.revoke;
  }
});
