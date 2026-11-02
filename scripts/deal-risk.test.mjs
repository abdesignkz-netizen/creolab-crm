import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const rendered = (async () => {
  const result = await build({ stdin: { contents: `
    import {renderToStaticMarkup} from 'react-dom/server';
    import {MemoryRouter} from 'react-router-dom';
    import {SessionContext,emptyCaps} from './lib/session';
    import {DealRiskDetails} from './components/DealRiskDetails';
    export const render=(locale,risk)=>renderToStaticMarkup(
      <SessionContext.Provider value={{me:{user:{locale}},caps:emptyCaps}}><MemoryRouter>
        <DealRiskDetails dealId="deal-test" risk={risk} timeZone="Asia/Almaty" members={[]} onSaved={async()=>{}}/>
      </MemoryRouter></SessionContext.Provider>);
  `, loader: 'tsx', resolveDir: fileURLToPath(new URL('../apps/web/src', import.meta.url)) },
    loader: { '.css': 'empty' }, jsx: 'automatic', bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
  const module = { exports: {} };
  new Function('exports', 'module', 'require', result.outputFiles[0].text)(module.exports, module, createRequire(import.meta.url));
  return module.exports;
})();

function fixture() {
  return { priority: 'attention', checkedAt: '2026-10-29T07:00:00Z', timeBasis: 'business', fingerprint: 'a'.repeat(64),
    signals: [{ code: 'step_missing', urgency: 'attention', source: 'deal', sourceId: 'deal-test', at: null }],
    recommendation: { kind: 'create_task', title: 'Согласовать следующий шаг с клиентом', titleFromRecord: false,
      reason: 'step_missing', href: '/deals/deal-test', dueAt: '2026-10-30T07:00:00Z', deadlineBasis: 'suggested',
      ownerMembershipId: 'member-test', ownerName: 'Айбек', canCreate: true } };
}

test('A suggested next step shows the evidence, owner and company-local proposed deadline before confirmation', async () => {
  const { render } = await rendered;
  const html = render('ru', fixture());
  for (const text of ['Нет следующего действия', 'Основание', 'Айбек', 'Предлагаемый срок', 'Asia/Almaty', '12:00', 'Проверить и создать задачу']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /role="dialog"|Задача создана|undefined|NaN/);
});

test('An existing task links to that task with its exact deadline and no duplicate-creation action', async () => {
  const { render } = await rendered, risk = fixture();
  risk.priority = 'urgent'; risk.signals = [{ code: 'task_overdue', urgency: 'urgent', source: 'task', sourceId: 'task-test', at: '2026-10-27T07:00:00Z' }];
  risk.recommendation = { ...risk.recommendation, kind: 'task', reason: 'task_overdue', title: 'Согласовать смету', titleFromRecord: true,
    href: '/tasks?open=task-test', dueAt: '2026-10-27T07:00:00Z', deadlineBasis: 'existing', canCreate: false };
  const html = render('ru', risk);
  assert.match(html, /href="\/tasks\?open=task-test"/); assert.match(html, /Согласовать смету/);
  assert.match(html, /27\.10\.2026/); assert.match(html, /Задача уже есть/);
  assert.doesNotMatch(html, /Проверить и создать|Предлагаемый срок/);
});

test('A staff member without task-creation permission is directed to review the deal', async () => {
  const { render } = await rendered, risk = fixture(); risk.recommendation.canCreate = false;
  const html = render('ru', risk);
  assert.match(html, /href="\/deals\/deal-test"/); assert.match(html, /Проверить сделку/);
  assert.doesNotMatch(html, /<button|Проверить и создать/);
});

test('Kazakh risk details keep the company time zone and translate the generated action and thresholds', async () => {
  const { render } = await rendered, risk = fixture();
  risk.signals = [{ code: 'stage_overdue', urgency: 'attention', source: 'deal', sourceId: 'deal-test', at: risk.checkedAt, thresholdDays: 3 }];
  risk.recommendation.reason = 'stage_overdue';
  const html = render('kk', risk);
  assert.match(html, /Ұсынылатын мерзім/); assert.match(html, /Жауапты/); assert.match(html, /3 жұмыс күні/);
  assert.match(html, /Asia\/Almaty/); assert.doesNotMatch(html, /Предлагаемый срок|Основание|Согласовать следующий/);
});

test('Titles and names from CRM are escaped in risk recommendations', async () => {
  const { render } = await rendered, risk = fixture();
  risk.recommendation.titleFromRecord = true; risk.recommendation.title = '<script>alert(1)</script>';
  risk.recommendation.ownerName = '<img src=x onerror=alert(1)>';
  const html = render('ru', risk);
  assert.match(html, /&lt;script&gt;/); assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<script|<img/);
});

test('A clear assessment is explicitly limited to checked rules and contains no creation action', async () => {
  const { render } = await rendered, risk = { ...fixture(), priority: 'clear', signals: [], recommendation: null };
  const html = render('ru', risk);
  assert.match(html, /По плану/); assert.match(html, /не гарантия успешной продажи/);
  assert.doesNotMatch(html, /Рекомендуемый шаг|<button|создать задачу/);
});
