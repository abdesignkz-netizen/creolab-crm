import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

test('tariff cards and comparison agree on Free trial and excluded Start AI Manager', async () => {
  const result = await build({
    stdin: { contents: `
      import { renderToStaticMarkup } from 'react-dom/server';
      import { BillingCatalog } from './components/BillingCatalog';
      import { CATALOG_BY_CODE } from '@creolab/contracts';
      export function render() { return renderToStaticMarkup(<BillingCatalog items={['BASQAR_FREE','CRM_START','CONTROL','SALES'].map(code=>CATALOG_BY_CODE[code])} period="MONTHLY" selected="" disabled={false} onSelect={()=>{}} />); }
    `, resolveDir: fileURLToPath(new URL('../apps/web/src/',import.meta.url)), loader: 'tsx' },
    jsx:'automatic',bundle:true,platform:'node',format:'cjs',write:false,logLevel:'silent',
  });
  const module = {exports:{}};
  new Function('exports','module','require',result.outputFiles[0].text)(module.exports,module,createRequire(import.meta.url));
  const html = module.exports.render();
  const cards = [...html.matchAll(/<article\b[^>]*>(.*?)<\/article>/gs)].map(m=>m[1]);
  assert.equal(cards.length,4);
  assert.match(cards[0],/AI Manager: пробный режим/);
  assert.doesNotMatch(cards[1],/AI Manager: консультации/);
  const row = html.match(/<tr><th scope="row">AI-менеджер продаж<\/th>(.*?)<\/tr>/s)?.[1];
  assert.ok(row);
  const cells = [...row.matchAll(/<td\b[^>]*>(.*?)<\/td>/gs)].map(m=>m[1]);
  assert.deepEqual(cells,['Пробный режим · 100 AI-кредитов один раз','—','Включено','Включено']);
});
