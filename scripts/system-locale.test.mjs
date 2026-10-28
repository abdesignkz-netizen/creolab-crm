import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { build } from 'esbuild';
const root = fileURLToPath(new URL('../', import.meta.url));
const file = path.join(root, 'packages/contracts/src/systemLocale.ts');
// Read literal entries before JavaScript can overwrite duplicate keys, including
// dictionaries brought in by object spread. Fail on unsupported expressions.
function dictionaryEntries(file, name, visiting = new Set()) {
  const key = `${file}:${name}`;
  assert.ok(!visiting.has(key), `Circular dictionary spread: ${key}`);
  const next = new Set(visiting).add(key);
  const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.filter(ts.isVariableStatement)
    .flatMap(s => [...s.declarationList.declarations]).find(d => d.name.getText(ast) === name);
  if (!declaration) {
    for (const statement of ast.statements.filter(ts.isImportDeclaration)) {
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      const binding = bindings.elements.find(b => b.name.text === name);
      if (!binding) continue;
      assert.ok(ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.startsWith('./'));
      return dictionaryEntries(path.resolve(path.dirname(file), statement.moduleSpecifier.text), (binding.propertyName || binding.name).text, next);
    }
  }
  assert.ok(declaration?.initializer && ts.isObjectLiteralExpression(declaration.initializer), `Expected literal dictionary: ${key}`);
  return declaration.initializer.properties.flatMap(property => {
    if (ts.isSpreadAssignment(property)) {
      assert.ok(ts.isIdentifier(property.expression), `Unsupported dictionary spread: ${property.getText(ast)}`);
      return dictionaryEntries(file, property.expression.text, next);
    }
    assert.ok(ts.isPropertyAssignment(property) && (ts.isStringLiteral(property.name) || ts.isIdentifier(property.name))
      && ts.isStringLiteral(property.initializer), `Expected literal translation: ${property.getText(ast)}`);
    return [[property.name.text, property.initializer.text]];
  });
}
const entries = dictionaryEntries(file, 'kkSystemMessages');
const known = new Set(entries.map(([key]) => key));

test('Reviewed Kazakh product copy has unique entries and preserves every parameter', () => {
  assert.equal(known.size, entries.length);
  const params = value => [...value.matchAll(/\{([a-zA-Z]\w*)\}/g)].map(m => m[1]).sort();
  for (const [ru, kk] of entries) {
    assert.ok(kk?.trim(), ru);
    assert.deepEqual(params(kk), params(ru), ru);
  }
});

test('All explicit product text calls have a Kazakh translation', () => {
  function walk(dir) {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(full)) continue;
      const source = ts.createSourceFile(full, readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true);
      function visit(n) {
        if (ts.isCallExpression(n) && n.expression.getText(source) === 'systemText' && n.arguments[1] && ts.isStringLiteral(n.arguments[1])) {
          assert.ok(known.has(n.arguments[1].text), `${full}: ${n.arguments[1].text}`);
        }
        if (ts.isCallExpression(n) && n.expression.getText(source) === 'uiText' && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
          assert.ok(known.has(n.arguments[0].text), `${full}: ${n.arguments[0].text}`);
        }
        ts.forEachChild(n, visit);
      }
      visit(source);
    }
  }
  walk(path.join(root, 'apps/web/src')); walk(path.join(root, 'apps/api/src'));
});

async function bundle(contents, plugins = []) {
  const result = await build({ stdin: { contents, loader: 'tsx', resolveDir: path.join(root, 'apps/web/src') }, loader: { '.css': 'empty' }, jsx: 'automatic', bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent', plugins });
  const module = { exports: {} };
  new Function('exports', 'module', 'require', result.outputFiles[0].text)(module.exports, module, createRequire(import.meta.url));
  return module.exports;
}

test('Task delivery separates accepted, unknown and unsent parts in Russian and Kazakh', async () => {
  const { render } = await bundle(`
    import {renderToStaticMarkup} from 'react-dom/server';
    import {MemoryRouter} from 'react-router-dom';
    import TaskDeliveryNotice from './components/TaskDeliveryNotice';
    import {SessionContext,emptyCaps} from './lib/session';
    export const render=(locale,result,reconcile=false)=>renderToStaticMarkup(<SessionContext.Provider value={{me:{user:{locale}},caps:emptyCaps}}><MemoryRouter><TaskDeliveryNotice result={result} conversationId="test-conversation" onReconcile={reconcile?async()=>{}:undefined}/></MemoryRouter></SessionContext.Provider>);
  `);
  const result = { textOk:true,textState:'accepted',needsCheck:true,partial:true,files:[
    {id:'file-1',fileName:'<script>bad()</script>.pdf',state:'unknown',ok:false},
    {id:'file-2',fileName:'Прайс.pdf',state:'pending',ok:false},
  ] };
  const ru=render('ru',result), kk=render('kk',result);
  assert.match(ru,/Нужно проверить/); assert.match(ru,/Ещё не отправлено/);
  assert.match(ru,/Повтор заблокирован/); assert.match(ru,/не подтверждает доставку или прочтение/);
  assert.doesNotMatch(ru,/Не отправлено<\/b>/);
  assert.match(kk,/Тексеру қажет/); assert.match(kk,/Әлі жіберілмеді/);
  assert.doesNotMatch(kk,/Нужно проверить|Ещё не отправлено|Результат отправки/);
  for(const html of [ru,kk]) {
    assert.match(html,/role="status"/); assert.match(html,/href="\/conversations\/test-conversation"/);
    assert.match(html,/&lt;script&gt;bad\(\)&lt;\/script&gt;/); assert.doesNotMatch(html,/<script>/);
  }
  const pending=render('ru',{textState:'sending',sending:true,files:[]});
  assert.match(pending,/Отправка выполняется/); assert.doesNotMatch(pending,/Повтор заблокирован/);
  assert.match(pending,/Отправляется/);
  assert.doesNotMatch(ru,/Записать результат сверки/);
  assert.match(render('ru',result,true),/Записать результат сверки/);
  assert.match(render('kk',result,true),/Тексеру нәтижесін жазу/);
  assert.doesNotMatch(render('ru',{...result,sending:true},true),/Записать результат сверки/);
  assert.match(render('ru',{textOk:true,textState:'accepted',textReconciled:true,files:[]}),/Сверено сотрудником/);
  const partial=render('ru',{...result,needsCheck:false,files:[{id:'f',fileName:'КП.pdf',state:'failed',ok:false}]});
  assert.match(partial,/Повторятся только неотправленные файлы/); assert.match(partial,/Не отправлено/);
});

test('Shared website chat copy preserves Russian, Kazakh and English independently', async () => {
  const { systemText } = await bundle(`export { systemText } from '@creolab/contracts';`);
  assert.equal(systemText('ru', 'Чат на сайте'), 'Чат на сайте');
  assert.equal(systemText('kk', 'Чат на сайте'), 'Сайттағы чат');
  assert.equal(systemText('en', 'Чат на сайте'), 'Website chat');
});

test('CRM review exposes before/after and evidence safely, with permissions and translated controls', async () => {
  const { render } = await bundle(`
    import {renderToStaticMarkup} from 'react-dom/server';
    import {CrmReviewCard} from './components/ConversationCrmReview';
    import {SessionContext,emptyCaps} from './lib/session';
    export const render=(locale,item)=>renderToStaticMarkup(<SessionContext.Provider value={{me:{user:{locale}},caps:emptyCaps}}><CrmReviewCard item={item} busy={false} onDecision={()=>{}}/></SessionContext.Provider>);
  `);
  const item = {id:'review',entityType:'inquiry',entityId:'inquiry',status:'pending',confidence:'MEDIUM',createdAt:'2026-10-26T08:00:00Z',
    fields:[{key:'nextStep',before:'Прежний ручной шаг',after:'Отправить примеры работ'}],
    evidence:[{id:'message',text:'<script>bad()</script> Нужна презентация',createdAt:'2026-10-26T08:00:00Z',senderKind:'client',direction:'inbound'}],
    canAccept:true,canDismiss:true,canUndo:false,blockedReason:null};
  const ru=render('ru',item), kk=render('kk',item);
  assert.match(ru,/Применить изменения/); assert.match(kk,/Өзгерістерді қолдану/);
  for(const html of [ru,kk]) {
    assert.match(html,/Прежний ручной шаг/); assert.match(html,/Отправить примеры работ/);
    assert.match(html,/&lt;script&gt;bad\(\)&lt;\/script&gt; Нужна презентация/);
    assert.doesNotMatch(html,/<script>/); assert.match(html,/<blockquote/);
  }
  assert.match(ru,/ИИ не уверен в выводе/); assert.match(kk,/ЖИ қорытындыға сенімді емес/);
  const blocked=render('ru',{...item,canAccept:false,blockedReason:'changed'});
  assert.match(blocked,/disabled=""[^>]*>Применить изменения/);
  assert.match(blocked,/Карточка уже изменена/);
  const history=render('ru',{...item,status:'automatic',canAccept:false,canDismiss:false,canUndo:true});
  assert.match(history,/Отменить изменение/); assert.doesNotMatch(history,/Применить изменения/);
});

test('Process review explains coupled undo, blocked side effects and preserves customer text in both locales', async () => {
  const { render } = await bundle(`
    import {renderToStaticMarkup} from 'react-dom/server';
    import {CrmReviewCard} from './components/ConversationCrmReview';
    import {SessionContext,emptyCaps} from './lib/session';
    export const render=(locale,item)=>renderToStaticMarkup(<SessionContext.Provider value={{me:{user:{locale}},caps:emptyCaps}}><CrmReviewCard item={item} busy={false} onDecision={()=>{}}/></SessionContext.Provider>);
  `);
  const item={id:'process',entityType:'process',entityId:'conversation',status:'automatic',confidence:'HIGH',createdAt:'2026-10-26T08:00:00Z',fields:[],evidence:[],canAccept:false,canDismiss:false,canUndo:true,blockedReason:null,
    process:{reminders:3,entries:[{entityType:'agreement',entityId:'agreement',title:'<img src=x onerror=bad()>',created:true,fields:[{label:'Описание',before:null,after:'Новая'}, {label:'Статус договорённости',before:null,after:'Запланирована',status:true}]}]}};
  const ru=render('ru',item), kk=render('kk',item);
  assert.match(ru,/Связанные изменения отменяются вместе/); assert.match(kk,/Байланысты өзгерістер бірге/);
  for(const html of [ru,kk]) { assert.match(html,/&lt;img/); assert.doesNotMatch(html,/<img/); assert.match(html,/>Новая</); assert.doesNotMatch(html,/Применить изменения/); }
  assert.match(kk,/Жоспарланған/); assert.doesNotMatch(ru,/Запись не существовала/); assert.match(ru,/Запланировано напоминаний/);
  for(const reason of ['effects_started','calendar','related_activity']) {
    const html=render('ru',{...item,canUndo:false,blockedReason:reason});
    assert.doesNotMatch(html,/Отменить изменение/); assert.match(html,/crm-review-warning/);
  }
  assert.match(render('ru',{...item,canUndo:false,blockedReason:'effects_started'}),/Уже началось выполнение/);
});

test('ASSIST process preview is expanded, explicit, translated and distinct from applied history', async () => {
  const {render}=await bundle(`
    import {renderToStaticMarkup} from 'react-dom/server';
    import {CrmReviewCard} from './components/ConversationCrmReview';
    import {SessionContext,emptyCaps} from './lib/session';
    export const render=(locale,item)=>renderToStaticMarkup(<SessionContext.Provider value={{me:{user:{locale}},caps:emptyCaps}}><CrmReviewCard item={item} busy={false} onDecision={()=>{}}/></SessionContext.Provider>);
  `);
  const item={id:'process',entityType:'process',entityId:'conversation',status:'pending',confidence:'HIGH',createdAt:'2026-10-26T08:00:00Z',fields:[],evidence:[],canAccept:true,canDismiss:true,canUndo:false,blockedReason:null,
    process:{reminders:3,calendarSync:true,entries:[{entityType:'task',entityId:'task',title:'Позвонить <script>bad()</script>',created:true,fields:[{label:'Исполнитель',before:null,after:'Айбек'},{label:'Срок',before:null,after:'29.10.2026, 16:00'}]}]}};
  const ru=render('ru',item),kk=render('kk',item);
  assert.match(ru,/записи ещё не изменены/); assert.match(kk,/жазбалар әлі өзгертілген жоқ/);
  assert.match(ru,/Подтвердить действия/); assert.match(kk,/Әрекеттерді растау/);
  assert.match(ru,/Действия по переписке/); assert.match(kk,/Хат алмасу бойынша әрекеттер/);
  assert.match(ru,/Напоминаний после подтверждения/); assert.match(kk,/Растаудан кейінгі еске салулар/);
  assert.match(ru,/Отправка сообщений и документов подтверждается отдельно/); assert.match(ru,/Подключён календарь/);
  for(const html of [ru,kk]) { assert.match(html,/class="crm-review-process-entry" open=""/); assert.match(html,/Айбек/); assert.match(html,/29.10.2026, 16:00/); assert.match(html,/&lt;script&gt;/); assert.doesNotMatch(html,/<script>/); }
  assert.doesNotMatch(ru,/Создано ИИ|Отменить изменение/);
  for(const reason of ['settings_changed','expired','permissions']) {
    const blocked=render('ru',{...item,canAccept:false,blockedReason:reason});
    assert.match(blocked,/disabled=""[^>]*>Подтвердить действия/); assert.match(blocked,/crm-review-warning/);
  }
  for(const status of ['dismissed','superseded']) {
    const closed=render('ru',{...item,status,canAccept:false,canDismiss:false});
    assert.doesNotMatch(closed,/Создано ИИ|Подтвердить действия|Напоминаний после подтверждения|применятся вместе/); assert.match(closed,/Новая запись/);
  }
  const standalone=render('kk',{...item,process:{reminders:0,calendarSync:false,entries:[{entityType:'task',entityId:'standalone',title:'Подготовить расчёт',created:true,fields:[
    {label:'Срок',status:true,before:null,after:'Без срока'}, {label:'Подготовка',before:null,after:'Уточнить объём <script>bad()</script>'}
  ]}]}});
  assert.match(standalone,/Мерзімсіз/); assert.match(standalone,/Дайындық/); assert.match(standalone,/&lt;script&gt;/);
  assert.doesNotMatch(standalone,/crm-review-before/); assert.match(standalone,/crm-review-new-fields/);
  assert.doesNotMatch(standalone,/Подключён календарь|Күнтізбе қосылған|<script>|Жоспарланған еске салулар/);
});

test('Commercial review distinguishes budget bounds, prices and refusal notes with exact safe quotes', async () => {
  const { render, summary, paywall } = await bundle(`
    import {renderToStaticMarkup} from 'react-dom/server';
    import {MemoryRouter} from 'react-router-dom';
    import {CrmReviewCard} from './components/ConversationCrmReview';
    import {CrmCommercialSummary} from './components/CrmCommercialSummary';
    import PaywallContent from './components/PaywallContent';
    import {SessionContext,emptyCaps} from './lib/session';
    const wrap=(locale,child)=>renderToStaticMarkup(<SessionContext.Provider value={{me:{user:{locale}},caps:emptyCaps}}><MemoryRouter>{child}</MemoryRouter></SessionContext.Provider>);
    export const render=(locale,item)=>wrap(locale,<CrmReviewCard item={item} busy={false} onDecision={()=>{}}/>);
    export const summary=(locale,values)=>wrap(locale,<CrmCommercialSummary values={values} conversationId="test-thread"/>);
    export const paywall=(locale)=>wrap(locale,<PaywallContent open={{feature:'AI_MANAGER'}} onClose={()=>{}}/>);
  `);
  const budget={min:null,max:200000,currency:'KZT'}, price={min:150000,max:150000,currency:'USD'};
  const item={id:'review',entityType:'inquiry',entityId:'inquiry',status:'pending',confidence:'HIGH',createdAt:'2026-10-26T08:00:00Z',
    fields:[{key:'customerBudget',before:null,after:budget}],evidence:[{id:'source',text:'Наш бюджет до 200000 тенге. <img src=x onerror=bad()>',quote:'Наш бюджет до 200000 тенге.',createdAt:'2026-10-26T08:00:00Z',senderKind:'client',direction:'inbound'}],
    canAccept:true,canDismiss:true,canUndo:false,blockedReason:null};
  const ru=render('ru',item), kk=render('kk',item);
  assert.match(ru,/Бюджет клиента/); assert.match(kk,/Клиент бюджеті/);
  assert.match(ru,/до 200\s000 KZT/); assert.match(ru,/Наш бюджет до 200000 тенге\./);
  assert.match(ru,/Сообщение целиком/); assert.match(ru,/&lt;img/); assert.doesNotMatch(ru,/<img/);
  for(const locale of ['ru','kk']) {
    const html=summary(locale,{customerBudget:budget,proposedPrice:price,agreedPrice:null,objection:'Дорого <script>bad()</script>',refusalReason:'Выбрали другую компанию'});
    assert.match(html,/USD/); assert.match(html,/KZT/); assert.match(html,/Дорого &lt;script&gt;/); assert.doesNotMatch(html,/<script>/);
    assert.match(html,/href="\/conversations\/test-thread"/);
  }
  assert.match(summary('ru',{customerBudget:budget,proposedPrice:null,agreedPrice:null,objection:null,refusalReason:null}),/не подтверждает оплату/);
  assert.match(paywall('ru'),/Подключите подходящий тариф/); assert.match(paywall('kk'),/Сәйкес тарифті/);
});

test('Incomplete analytics coverage stays visible in CSV, Excel and printable reports', async () => {
  const exports = await bundle(`export { exportAnalyticsCsv, exportAnalyticsExcel, exportAnalyticsPdf } from './lib/statsExport';`);
  const data = { period: { label: 'Сегодня' }, sources: [{name:'Source',inquiries:5000}], coverage: {partial:true,totalsComplete:true,
    sections:[{key:'inquiries',label:'Обращения: подробные разрезы',loaded:5000,atLeast:5001,status:'partial'}]} };
  const previous = { document: globalThis.document, window: globalThis.window, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  const blobs = [];
  globalThis.document = { createElement: () => ({ click() {} }) };
  globalThis.window = { open: () => null };
  URL.createObjectURL = blob => { blobs.push(blob); return 'blob:local-test'; };
  URL.revokeObjectURL = () => {};
  try {
    exports.exportAnalyticsCsv(data, 'sources');
    exports.exportAnalyticsExcel(data, {sources:true});
    exports.exportAnalyticsPdf(data, {sources:true});
    assert.equal(blobs.length, 3);
    for (const blob of blobs) {
      const text = await blob.text();
      assert.match(text, /Часть подробного отчёта неполная/);
      assert.match(text, /по всем подходящим записям/);
      assert.match(text, /5000 записей; найдено не менее 5001/);
      assert.match(text, /Source/);
    }
    exports.exportAnalyticsCsv({...data,coverage:{partial:false,sections:[]}}, 'sources');
    assert.doesNotMatch(await blobs[3].text(), /неполная/);
  } finally {
    if (previous.document === undefined) delete globalThis.document; else globalThis.document = previous.document;
    if (previous.window === undefined) delete globalThis.window; else globalThis.window = previous.window;
    URL.createObjectURL = previous.create; URL.revokeObjectURL = previous.revoke;
  }
});

test('Financial exports distinguish sales from payments and retain exact currency amounts', async () => {
  const exports = await bundle(`export { exportAnalyticsCsv, exportAnalyticsExcel, exportAnalyticsPdf } from './lib/statsExport';`);
  const data = { currency: 'KZT', period: { label: '24.10.2029' }, sources: [{ name: '<Source>', revenueExact: '18014398509481987' }],
    overview: { revenueLabel: '1 160 ₸', receiptsLabel: '545 ₸' }, sales: { revenueLabel: '1 160 ₸', receiptsLabel: '545 ₸' },
    financial: { sales: { byCurrency: [{currency:'KZT',label:'1 160 ₸',missing:1},{currency:'USD',label:'30 USD'}] },
      receipts: { byCurrency: [{currency:'KZT',label:'545 ₸'},{currency:'USD',label:'10 USD'}] } } };
  const previous = { document: globalThis.document, window: globalThis.window, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  const blobs = [];
  globalThis.document = { createElement: () => ({ click() {} }) };
  globalThis.window = { open: () => null };
  URL.createObjectURL = blob => { blobs.push(blob); return 'blob:finance-test'; }; URL.revokeObjectURL = () => {};
  try {
    exports.exportAnalyticsCsv(data, 'sources');
    exports.exportAnalyticsExcel(data, {overview:true,sources:true,sales:true});
    exports.exportAnalyticsPdf(data, {overview:true,sources:true,sales:true});
    for (const blob of blobs) {
      const text = await blob.text();
      assert.match(text, /Сумма продаж/); assert.match(text, /Подтверждённые оплаты/);
      assert.match(text, /545 ₸/); assert.match(text, /30 USD/); assert.match(text, /10 USD/);
      assert.match(text, /дате подтверждения/); assert.match(text, /Валюты не суммируются/);
      assert.match(text, /Сделок без суммы: 1/); assert.doesNotMatch(text, /Выручка/);
    }
    assert.match(await blobs[0].text(), /18014398509481987/);
    assert.match(await blobs[2].text(), /&lt;Source&gt;/);
  } finally {
    if (previous.document === undefined) delete globalThis.document; else globalThis.document = previous.document;
    if (previous.window === undefined) delete globalThis.window; else globalThis.window = previous.window;
    URL.createObjectURL = previous.create; URL.revokeObjectURL = previous.revoke;
  }
});

test('Currency breakdown explains missing prices, preserves zero and translates into Kazakh', async () => {
  const { render } = await bundle(`import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
    import {SessionContext,emptyCaps} from './lib/session';import {FinancialBreakdown} from './components/FinancialBreakdown';
    export const render=(locale,rows)=>renderToStaticMarkup(<SessionContext.Provider value={{me:{user:{locale}},caps:emptyCaps}}><FinancialBreakdown currency="KZT" sales={rows} receipts={[{currency:'USD',label:'10 USD'}]}/></SessionContext.Provider>);`);
  for (const locale of ['ru','kk']) {
    const html = render(locale, [{currency:'KZT',label:'0 ₸',missing:1},{currency:'USD',label:'30 USD'}]);
    assert.match(html, /<summary>/); assert.match(html, /0 ₸/); assert.match(html, /30 USD/); assert.match(html, /10 USD/);
    if (locale === 'ru') assert.match(html, /Сделок без суммы: 1/);
    else { assert.match(html, /Сомасы жоқ мәмілелер: 1/); assert.doesNotMatch(html, /Сумма продаж|Подтверждённые оплаты/); }
  }
});

test('Global ESF switch hides tenant document controls, including stale loaded data and old URLs', async () => {
  const plugin = { name:'esf-visibility-fixture', setup(build) { build.onLoad({filter:/(LegalSettingsPanel|DocumentNumberingPanel|AvrEditorPage)\.tsx$/}, args => {
    let source = readFileSync(args.path, 'utf8');
    if (args.path.endsWith('LegalSettingsPanel.tsx')) source = source.replace('[loaded, setLoaded] = useState(false)', '[loaded, setLoaded] = useState(true)');
    if (args.path.endsWith('DocumentNumberingPanel.tsx')) source = source.replace('useState<Settings | null>(null)', 'useState<Settings | null>({DOG:{example:"1"},INV:{example:"2"},AVR:{example:"3"},ESF:{example:"4"}})');
    if (args.path.endsWith('AvrEditorPage.tsx')) source = source.replace('[context,setContext]=useState<any>(null)', '[context,setContext]=useState<any>({deal:{id:"d",title:"Test"},organization:{},company:{},items:[]})');
    return { contents: source, loader:'tsx', resolveDir:path.dirname(args.path) };
  }); } };
  const { render } = await bundle(`
    import {renderToStaticMarkup} from 'react-dom/server'; import {MemoryRouter} from 'react-router-dom';
    import {SessionContext,emptyCaps} from './lib/session';
    import {DocumentsPage} from './pages/DocumentsPage'; import {LegalSettingsPanel} from './pages/LegalSettingsPanel';
    import {DocumentNumberingPanel} from './pages/DocumentNumberingPanel'; import {AvrEditorPage} from './pages/AvrEditorPage';
    import {DealList} from './components/DealList'; import {DealDocumentsPanel} from './pages/DealDocumentsPanel';
    const noop=()=>{};
    const props={deal:{id:'d',outcome:'open'},docs:{contracts:[],invoices:[],electronicDocuments:[],documentState:{label:'АВР принят · требуется ЭСФ'}},closeReadiness:{ready:false,missingFields:['esf.sent'],missingFieldLabels:{'esf.sent':'ЭСФ, отправленный в ИС ЭСФ'}},setBusy:noop,setError:noop,load:noop,setReadiness:noop,setInvoiceReadiness:noop,setAvrReadiness:noop,setEsfInvoiceReadiness:noop,setBuyerLink:noop,setEsfPreview:noop,setEsfInvoicePreview:noop};
    export const render=esf=>renderToStaticMarkup(<SessionContext.Provider value={{me:{user:{locale:'ru'},serviceFeatures:{esf}},caps:{...emptyCaps,documents:true}}}><MemoryRouter initialEntries={['/documents?kind=ESF&docFilter=esf_unsent']}><DocumentsPage/><LegalSettingsPanel/><DocumentNumberingPanel/><AvrEditorPage/><DealList items={[]} documentsAllowed/><DealDocumentsPanel {...props}/></MemoryRouter></SessionContext.Provider>);
  `, [plugin]);
  const previous = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  try {
    const off = render(false);
    assert.deepEqual([...off.matchAll(/.{0,80}(?:ЭСФ|\/integrations\/esf|href="#esf"|XML AwpV1).{0,80}/g)].map(m => m[0]), []);
    assert.match(off, /Создать АВР/); assert.match(off, /Скачать PDF/); assert.match(off, /Закрыть сделку/);
    const on = render(true);
    assert.match(on, /ИС ЭСФ/); assert.match(on, /Создать ЭСФ/); assert.match(on, /Подписать и отправить АВР/);
  } finally { globalThis.localStorage = previous; }
});

test('WhatsApp connection choices and setup instructions render in Russian, Kazakh and English', async () => {
  for (const method of ['green', 'qr', 'cloud']) {
    const plugins = [{ name: 'whatsapp-selected-method', setup(build) { build.onLoad({ filter: /WhatsAppConnectionsPanel\.tsx$/ }, args => ({
      contents: readFileSync(args.path, 'utf8').replace('useState<"green" | "qr" | "cloud">("green")', `useState<"green" | "qr" | "cloud">("${method}")`), loader: 'tsx',
    })); } }];
    const { render } = await bundle(`
      import { renderToStaticMarkup } from 'react-dom/server';
      import { WhatsAppConnectionsPanel } from './pages/WhatsAppConnectionsPanel';
      import { SessionContext, emptyCaps } from './lib/session';
      export const render = locale => renderToStaticMarkup(<SessionContext.Provider value={{me:{user:{locale}},caps:emptyCaps}}><WhatsAppConnectionsPanel><p>Green API</p></WhatsAppConnectionsPanel></SessionContext.Provider>);
    `, plugins);
    const kk = render('kk'), ru = render('ru'), en = render('en');
    assert.match(kk, /Нөмірді қосу тәсілін таңдаңыз/); assert.match(kk, /Ресми қосылым/);
    assert.match(ru, /Выберите способ подключения номера/); assert.match(en, /Choose how to connect your number/);
    assert.doesNotMatch(kk, /Выберите|Подключите|Проверить|Связанные устройства|официальн/);
    if (method === 'qr') { assert.match(kk, /ЖИ жауаптарын пайдалануға болады/); assert.match(ru, /без аккаунта Green API/); assert.match(en, /Linked devices/); }
    if (method === 'cloud') { assert.match(kk, /24 сағат/); assert.match(ru, /бизнес-номер/); assert.match(en, /type="password"/); }
  }
});

test('WhatsApp AI setup links owners to company settings without claiming model readiness', async () => {
  const { render } = await bundle(`
    import { renderToStaticMarkup } from 'react-dom/server';
    import { MemoryRouter } from 'react-router-dom';
    import { WhatsAppAiControls } from './components/WhatsAppAiControls';
    import { SessionContext, emptyCaps } from './lib/session';
    export const render = (locale, connection, canSetup = true) => renderToStaticMarkup(<SessionContext.Provider value={{me:{user:{locale},capabilities:{aiSettings:canSetup}},caps:emptyCaps}}><MemoryRouter><WhatsAppAiControls connection={connection} busy={false} onToggle={()=>{}} /></MemoryRouter></SessionContext.Provider>);
  `);
  const base = { status:'CONNECTED', aiEnabled:false, aiAvailable:false, aiUnavailableReason:'ai_model_missing' };
  for (const locale of ['ru','kk','en']) {
    const before = render(locale, base);
    assert.doesNotMatch(before, /disabled=""/);
    const pending = render(locale, {...base, aiEnabled:true});
    assert.match(pending, /href="\/settings\/ai-manager"/);
    assert.match(pending, /href="\/settings\/ai-automation"/);
    assert.match(pending, /role="status"/);
    assert.match(pending, locale === 'ru' ? /Ожидают настройки/ : locale === 'kk' ? /Баптауды күтуде/ : /Awaiting setup/);
    const ready = render(locale, {...base, aiEnabled:true, aiAvailable:true, aiUnavailableReason:null});
    assert.match(ready, /href="\/settings\/ai-manager"/);
    assert.doesNotMatch(ready, /role="status"/);
    assert.match(ready, locale === 'ru' ? /<strong>Включены/ : locale === 'kk' ? /<strong>Қосылған/ : /<strong>Enabled/);
  }
  assert.doesNotMatch(render('ru', base, false), /href="\/settings\/ai-manager"/);
  for (const reason of ['feature_required','tenant_inactive']) assert.match(render('ru', {...base, aiUnavailableReason:reason}), /disabled=""/);
  assert.match(render('ru', {...base, status:'RECONNECT_REQUIRED'}), /disabled=""/);
  assert.doesNotMatch(render('ru', {...base, aiEnabled:true, status:'RECONNECT_REQUIRED'}), /disabled=""/);
});

test('Kazakh durations, contacts and period controls render without changing customer content', async () => {
  const { check, render } = await bundle(`
    import { renderToStaticMarkup } from 'react-dom/server';
    import { formatDurationMinutes, formatWaitReply, systemText } from '@creolab/contracts';
    import { nameWithPhone } from './lib/contactDisplay';
    import { PeriodSelector } from './components/PeriodSelector';
    import { SessionContext, emptyCaps } from './lib/session';
    export const check = () => [formatDurationMinutes(1500, 'kk'), formatDurationMinutes(1500, 'ru'), formatWaitReply(90, 'kk'), nameWithPhone('Русское имя', null, 'kk'), systemText('kk', 'Выбран {p0}', {p0: '$& <Имя>'})];
    export const render = locale => renderToStaticMarkup(<SessionContext.Provider value={{me:{user:{locale}},caps:emptyCaps}}><PeriodSelector period="custom" dateFrom="2026-09-01" dateTo="2026-09-30" onPeriodChange={()=>{}} onDateFromChange={()=>{}} onDateToChange={()=>{}} activeLabel="сентябрь" /></SessionContext.Provider>);
  `);
  assert.deepEqual(check(), ['1 күн 1 сағ', '1 день 1 час', 'Жауап күткен уақыт: 1 сағ 30 мин', 'Русское имя · Телефон нөмірі жоқ', '$& <Имя> таңдалды']);
  const kk = render('kk');
  assert.match(kk, /Бүгін/); assert.match(kk, /Басталуы/); assert.doesNotMatch(kk, /Сегодня|Вчера|Период|сентябрь/);
  assert.match(render('ru'), /Сегодня/);
});

test('Entire owner and manager dashboards render translated controls while preserving record names', async () => {
  const fixture = {
    asOf:'2026-09-28T07:13:00Z', period:{label:'Бүгін'}, result:{inquiries:3,wonDeals:1}, current:{},
    attention:{items:[{id:'a',kind:'inquiry_new',nextAction:'accept_inquiry',entityId:'a',title:'Русский заголовок клиента',contactName:'Русское имя',reason:'Жаңа өтінім',whyLabel:'Өтінім жұмысқа алынбаған',severity:'high',ageMinutes:90,href:'/requests/a'}],summary:{needsReply:3,overdueTasks:7},emptyLabel:'Қазір шұғыл әрекет қажет емес.'},
    todayTasks:{totalDueToday:1,doneToday:0,remaining:1,nearest:[]},aiManager:{status:'active',label:'ЖИ · белсенді'},
    items:[{id:'a',title:'Русский заголовок клиента',reason:'Жаңа өтінім',href:'/requests/a',kind:'inquiry_new'}]
  };
  // Supply a fetched snapshot to the real component's data state for SSR; rendering code is unchanged.
  const plugins = [{ name:'dashboard-fetched-fixture', setup(build) { build.onLoad({filter:/SituationPage\.tsx$/}, args => {
    const source = readFileSync(args.path,'utf8');
    assert.ok(source.includes('useState<any>(null)'));
    return { contents:source.replace('useState<any>(null)',`useState<any>(${JSON.stringify(fixture)})`), loader:'tsx', resolveDir:path.dirname(args.path) };
  }); } }];
  const { render } = await bundle(`
    import { renderToStaticMarkup } from 'react-dom/server';
    import { MemoryRouter } from 'react-router-dom';
    import { SituationPage } from './pages/SituationPage';
    import { SessionContext, emptyCaps } from './lib/session';
    export const render = (locale,manager=false) => renderToStaticMarkup(<SessionContext.Provider value={{me:{user:{locale,name:'Русское имя владельца'}},caps:{...emptyCaps,manager}}}><MemoryRouter initialEntries={['/today']}><SituationPage /></MemoryRouter></SessionContext.Provider>);
  `, plugins);
  const kk = render('kk');
  for (const text of ['Кімнің жазбаларын көрсету керек','Бүкіл команда','Маған тағайындалған','Бизнес туралы сұраңыз','Жауап беру керек','Мерзімі өткен','Кезең','Русский заголовок клиента','Русское имя']) assert.ok(kk.includes(text), text);
  const chips = html => [...html.matchAll(/<button[^>]*class="sit-ask-chip"[^>]*>(.*?)<\/button>/g)].map(match => match[1]);
  assert.deepEqual(chips(kk), ['Бүгін неге назар аударуым керек?', 'Қай мәмілелер тоқтап тұр?', 'Қай өтінімдер өңделмеген?', 'Бүгін не өзгерді?', 'Кімнің жұмыс жүктемесі жоғары?', 'Клиенттер қай кезеңде кетіп қалады?', 'Өткен аптамен салыстыр.']);
  assert.deepEqual(chips(render('ru')), ['Что сегодня требует моего внимания?', 'Какие сделки зависли?', 'Какие заявки не обработаны?', 'Что изменилось сегодня?', 'У кого высокая нагрузка?', 'Где теряются клиенты?', 'Сравни с прошлой неделей.']);
  assert.deepEqual(chips(render('en')), chips(render('ru'))); // Preserve the current English fallback.
  assert.doesNotMatch(kk, /Чьи записи|Все действия|Спросите о бизнесе|Нужно ответить|Обновлено|Добрый|Важные сделки/);
  assert.match(render('kk',true), /Қазір маңызды/);
  assert.match(render('ru'), /Чьи записи показывать/);
  assert.match(render('en'), /Чьи записи показывать/); // Existing English fallback is preserved.
});

test('Kazakh billing renders plan cards, comparison, resource warnings and onboarding; Russian and English are preserved', async () => {
  const setup = { suggested: true, completed: false, deferred: false, steps: [{ id: 'channel', done: false }] };
  const plugin = { name: 'billing-onboarding-state', setup(build) { build.onLoad({ filter: /SetupAssistant\.tsx$/ }, args => {
    const source = readFileSync(args.path, 'utf8');
    assert.ok(source.includes('useState<SetupState | null>(null)'));
    return { contents: source.replace('useState<SetupState | null>(null)', `useState<SetupState | null>(${JSON.stringify(setup)})`), loader: 'tsx', resolveDir: path.dirname(args.path) };
  }); } };
  const { render } = await bundle(`
    import { renderToStaticMarkup } from 'react-dom/server';
    import { MemoryRouter } from 'react-router-dom';
    import { BillingPage } from './pages/BillingPage';
    import { BillingCatalog } from './components/BillingCatalog';
    import { SetupProvider } from './components/SetupAssistant';
    import { CATALOG_BY_CODE } from '@creolab/contracts';
    import { SessionContext, emptyCaps } from './lib/session';
    export const render = (locale, yearly=false) => renderToStaticMarkup(<SessionContext.Provider value={{me:{user:{locale},billing:{planCode:'BASQAR_FREE',planName:'BasQar Free',subscriptionStatus:'active',entitlements:{AI_MANAGER:true,TEAM:true},usage:[{key:'AI_CREDITS',label:'AI-кредиты · пробный пакет один раз',used:100,cap:100}],warnings:[{code:'AI_CREDITS_exhausted',message:'AI-кредиты: использовано 100 из 100.'}]}},caps:{...emptyCaps,companyAdmin:true}}}><MemoryRouter initialEntries={['/billing']}><SetupProvider>{yearly ? <BillingCatalog items={Object.values(CATALOG_BY_CODE)} period="YEARLY" selected="" disabled={false} onSelect={()=>{}}/> : <BillingPage/>}</SetupProvider></MemoryRouter></SessionContext.Provider>);
  `, [plugin]);
  // Plan cards live in their own section now; verify both the overview and the catalog.
  const kk = render('kk') + render('kk', true);
  for (const text of ['Тарифтер және төлем','ЖИ кредиттері','Пайдаланушылар','Байланыс арналарының қосылымдары','Жұмысты бастау','Баптауды жалғастыру','100 лимитінен 100 пайдаланылды','Сынақ режимі · 100 ЖИ кредиті бір рет']) assert.ok(kk.includes(text), text);
  assert.doesNotMatch(kk, /Для ежедневной|Ваш тариф|Настройте|Укажите Instance|Запуски автоматизации|Стоимость услуг|Дополнительный пользователь|Хранилище, ГБ|Черновик|Подробное сравнение|Приглашение команды/);
  assert.match(render('kk', true), /стандартты бағамен салыстырғандағы үнем/);
  assert.match(render('ru'), /Тарифы и оплата/);
  assert.match(render('en'), /Тарифы и оплата/);
});

test('Kazakh page shells and forms render throughout the workspace without breaking other locales', async () => {
  const modules = [];
  for (const dir of ['pages', 'pages/platform']) {
    for (const filename of readdirSync(path.join(root, 'apps/web/src', dir))) {
      if (!filename.endsWith('.tsx')) continue;
      const source = readFileSync(path.join(root, 'apps/web/src', dir, filename), 'utf8');
      for (const match of source.matchAll(/export function (\w+)\(/g)) {
        // Panels below need domain fixtures; the route pages have their own loading/empty states.
        if (['CampaignMassPanel', 'DealDocumentsPanel', 'FormConnectionWizard', 'AssignIntegrationForm', 'ConversationsRoute'].includes(match[1])) continue;
        modules.push([match[1], `./${dir}/${filename}`]);
      }
    }
  }
  const { render } = await bundle(`
    import { renderToStaticMarkup } from 'react-dom/server';
    import { MemoryRouter } from 'react-router-dom';
    import { SessionContext, emptyCaps } from './lib/session';
    ${modules.map(([name, file]) => `import { ${name} } from '${file}';`).join('\n')}
    const components = {${modules.map(([name]) => name).join(',')}};
    export const render = (name, locale) => {
      const C = components[name];
      return renderToStaticMarkup(<SessionContext.Provider value={{me:{user:{locale,name:'Русское имя'}, memberships:[],activeMembership:{role:'owner',tenantId:'test'}},caps:{...emptyCaps,role:'owner',companyAdmin:true,documents:true,analytics:true,aiSettings:true,integrations:true,members:true,manageTasks:true}}}><MemoryRouter><C onChange={()=>{}} onSaved={()=>{}} tenantId="test" mode="list" /></MemoryRouter></SessionContext.Provider>);
    };
  `);
  const priorStorage = globalThis.localStorage;
  let locale = 'kk';
  globalThis.localStorage = { getItem: key => key === 'basqar.locale' ? locale : null, setItem() {}, removeItem() {} };
  try {
    for (locale of ['kk','ru','en']) {
      for (const [name] of modules) {
        let html;
        assert.doesNotThrow(() => { html = render(name, locale); }, `${name} (${locale})`);
        if (locale === 'kk') assert.doesNotMatch(html, />\s*(?:Загрузка…|Создать|Отмена|Сохранить|Нет данных|Пользователи|Настройки)\s*</, name);
      }
    }
  } finally { if (priorStorage) globalThis.localStorage = priorStorage; else delete globalThis.localStorage; }
});

test('Labels translate without mutating submitted option values or customer content; API errors keep their codes and details', async () => {
  const { check, createApiClient, systemMessage, uiNotificationBody } = await bundle(`
    import { localizeUiOptions, uiDurationLabel, uiNotificationBody } from './lib/uiText';
    export {uiNotificationBody};
    import { systemText, systemMessage } from '@creolab/contracts';
    export { systemMessage };
    export { createApiClient } from '@creolab/api-client';
    export const check = () => {
      const original = [{value:'шт',label:'шт'}, {value:'open',label:'Открыто',body:'Текст клиента',id:'Открыто'}];
      return {original,translated:localizeUiOptions(original, s=>systemText('kk',s)),wait:uiDurationLabel('Ждёт 2 дня 3 часа','kk'),untouched:uiDurationLabel('Клиент ждёт 2 дня','kk')};
    };
  `);
  const {original,translated,wait,untouched} = check();
  assert.equal(original[0].label,'шт'); assert.equal(translated[0].value,'шт'); assert.notEqual(translated[0].label,'шт');
  assert.equal(translated[1].body,'Текст клиента'); assert.equal(translated[1].id,'Открыто');
  assert.equal(wait,'2 күн 3 сағ күтуде'); assert.equal(untouched,'Клиент ждёт 2 дня');
  assert.equal(uiNotificationBody('support.replied','Подписка активна.','kk'),'Подписка активна.');
  assert.equal(uiNotificationBody('billing.subscription','Подписка активна.','kk'),'Жазылым белсенді.');
  assert.equal(systemMessage('kk','Иван забрал диалог у AI'),'Иван диалогты ЖИ-ден алды');
  const body={code:'forbidden',message:'Недостаточно прав',details:{name:'Задача'}};
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify(body),{status:403,headers:{'Content-Type':'application/json'}});
  try {
    for (const locale of ['kk','ru','en']) {
      const api=createApiClient({baseUrl:'http://test',formatErrorMessage:s=>systemMessage(locale,s)});
      await assert.rejects(api.request('/test'), error => {
        assert.equal(error.status,403); assert.equal(error.code,'forbidden'); assert.deepEqual(error.body,body);
        assert.equal(error.message,systemMessage(locale,body.message)); return true;
      });
    }
    globalThis.fetch=async()=>{throw new TypeError('Failed to fetch');};
    await assert.rejects(createApiClient({baseUrl:'http://test',formatErrorMessage:s=>systemMessage('kk',s)}).request('/test'), /Сервермен байланысу/);
  } finally { globalThis.fetch=originalFetch; }
});

test('Fetched client, document, control and analytics screens show Kazakh system labels and keep record text', async () => {
  const fixtures = {
    ClientsPage: {items:[{id:'c',name:'Клиент по-русски',companyName:'Название компании',lifecycleLabel:'Новый',inquiryStatusLabel:'В работе'}],total:1,offset:0,limit:25},
    ControlPage: {waitingForManager:[{id:'w',contactName:'Имя клиента',waitLabel:'2 дня 3 часа',reasonLabel:'Клиент попросил менеджера'}],ai:{status:'Активен',note:'AI отвечает клиентам как обычно.'},interventions:[{id:'c',contactName:'Клиент по-русски',reasonLabel:'Клиент попросил менеджера',waitLabel:'2 дня 3 часа'}],audit:[{id:'a',text:'Иван забрал диалог у AI'}]},
    StatsPage: {period:{label:'Бүгін'},overview:{},dataQuality:{},trend:{points:[]},coverage:{partial:true,totalsComplete:true,sections:[{key:'inquiries',label:'Обращения: подробные разрезы',loaded:5000,atLeast:5001,status:'partial'}]}},
    SignPage: {number:'123',date:'2026-09-28',sellerName:'ТОО Заказчик',buyerName:'ТОО Клиент',amount:100,currency:'KZT',contractStatus:'PENDING_SIGNATURE',signers:[]},
    DocumentsPage: [{id:'d',kind:'AVR',kindLabel:'АВР',number:'123',companyName:'Название компании',dealTitle:'Название сделки',href:'/documents/avr/d',date:'2026-09-28',statusLabel:'Черновик'}],
  };
  const plugin = {name:'loaded-page-fixtures',setup(build) {build.onLoad({filter:/(Clients|Control|Stats|Sign|Documents)Page\.tsx$/},args=>{
    let source=readFileSync(args.path,'utf8');const name=path.basename(args.path,'.tsx');
    if(name==='DocumentsPage') source=source.replace(/(\[items, setItems\] = useState<[^;]+?)\(\[\]\)/,`$1(${JSON.stringify(fixtures[name])})`);
    else source=source.replace('useState<any>(null)',`useState<any>(${JSON.stringify(fixtures[name])})`);
    return {contents:source,loader:'tsx',resolveDir:path.dirname(args.path)};
  });}};
  const {render}=await bundle(`
    import {renderToStaticMarkup} from 'react-dom/server'; import {MemoryRouter} from 'react-router-dom';
    import {SessionContext,emptyCaps} from './lib/session';
    ${Object.keys(fixtures).map(name=>`import {${name}} from './pages/${name}';`).join('\n')}
    const pages={${Object.keys(fixtures).join(',')}};
    export const render=(name,locale)=>{const Page=pages[name];return renderToStaticMarkup(<SessionContext.Provider value={{me:{user:{locale}},caps:{...emptyCaps,companyAdmin:true,analytics:true,documents:true}}}><MemoryRouter initialEntries={[name==='ControlPage'?'/control?view=overview':'/']}><Page avr /></MemoryRouter></SessionContext.Provider>)};
  `,[plugin]);
  const before=globalThis.localStorage;let locale='kk';globalThis.localStorage={getItem:key=>key==='basqar.locale'?locale:null};
  try {
    for(const name of Object.keys(fixtures)) {
      const html=render(name,'kk');
      assert.doesNotMatch(html,/>\s*(?:Черновик|Активен|Новый|В работе|АВР|Обзор|Управление)\s*</,name);
      if(name==='ClientsPage') assert.match(html,/Клиент по-русски/);
      if(name==='SignPage') {assert.match(html,/123/);assert.match(html,/Орындалған жұмыстар актісі/);assert.doesNotMatch(html,/Акт выполненных работ/);assert.match(html,/ТОО Заказчик/);}
      if(name==='ControlPage') {assert.match(html,/2 күн 3 сағ/);assert.match(html,/Иван диалогты ЖИ-ден алды/);}
      if(name==='StatsPage') {assert.match(html,/Деректердің қамтылуы/);assert.match(html,/5000 жазба есепке алынды/);assert.match(html,/кемінде 5001/);}
    }
    locale='ru';assert.match(render('SignPage','ru'),/Акт выполненных работ/);
  } finally {if(before)globalThis.localStorage=before;else delete globalThis.localStorage;}
});

test('Integration catalog prioritizes messaging, shows actual provider status and keeps settings collapsed', async () => {
  const catalog = {leads:[{catalogType:'WEBSITE_FORM',title:'Форма сайта',connected:true,healthLabel:'Работает',integrationId:'form-1'}], messaging:[], notifications:{employeeTelegram:{connected:false}}};
  const setup = {form:{connected:true,submitUrl:'https://example.test/secret-form-endpoint'},whatsapp:{configured:false}};
  const summaries = {whatsapp:{items:[{provider:'qr',status:'CONNECTED'}]},google:{failed:true},esf:{connection:{status:'CONNECTED',sessionActive:true}}};
  const plugin = {name:'catalog-fixture',setup(build) {build.onLoad({filter:/IntegrationsPage\.tsx$/}, args => ({
    contents:readFileSync(args.path,'utf8')
      .replace('[catalog, setCatalog] = useState<any>(null)',`[catalog, setCatalog] = useState<any>(${JSON.stringify(catalog)})`)
      .replace('[setup, setSetup] = useState<any>(null)',`[setup, setSetup] = useState<any>(${JSON.stringify(setup)})`)
      .replace('[summaries, setSummaries] = useState<Record<string, any>>({})',`[summaries, setSummaries] = useState<Record<string, any>>(${JSON.stringify(summaries)})`),
    loader:'tsx',resolveDir:path.dirname(args.path),
  }));}};
  const {render} = await bundle(`
    import {renderToStaticMarkup} from 'react-dom/server'; import {MemoryRouter} from 'react-router-dom';
    import {SessionContext,emptyCaps} from './lib/session'; import {IntegrationsPage} from './pages/IntegrationsPage';
    export const render=(locale,esf=false)=>renderToStaticMarkup(<SessionContext.Provider value={{me:{user:{locale},serviceFeatures:{esf}},caps:emptyCaps}}><MemoryRouter><IntegrationsPage /></MemoryRouter></SessionContext.Provider>);
  `,[plugin]);
  const prior = globalThis.localStorage;
  try {
    for (const locale of ['ru','kk','en']) {
      globalThis.localStorage={getItem:()=>locale};
      const html=render(locale);
      const ids=[...html.matchAll(/<details[^>]*id="integration-([^"]+)"/g)].map(match=>match[1]);
      assert.equal(ids.length,12); assert.ok(!ids.includes("esf")); assert.doesNotMatch(html, /ИС ЭСФ|ЭШФ АЖ/);
      assert.match(render(locale,true), /id="integration-esf"/); assert.ok(ids.includes("website-chat")); assert.deepEqual(ids.slice(0,3),['whatsapp','instagram','telegram']);
      assert.doesNotMatch(html,/<details[^>]*\bopen(?:=|\s|>)/);
      assert.doesNotMatch(html,/secret-form-endpoint|<form|<input|<pre|Page Access Token/);
      const whatsapp=html.split('id="integration-whatsapp"')[1].split('</details>')[0];
      assert.match(whatsapp,/integration-tile-status ok/);
      const google=html.split('id="integration-calendar"')[1].split('</details>')[0];
      assert.match(google, /integration-tile-status warn/);
      assert.match(google, locale==='kk'?/Тексеру мүмкін болмады/:locale==='en'?/Could not check/:/Не удалось проверить/);
      if(locale==='kk') assert.doesNotMatch(html, /Подключено|Не подключено|Заявки|Переписка|Выберите карточку/);
      if(locale==='en') assert.doesNotMatch(html, /Подключено|Не подключено|Заявки|Переписка|Выберите карточку/);
    }
  } finally { if(prior) globalThis.localStorage=prior; else delete globalThis.localStorage; }
});

test('Google integration details show only the chosen service while the legacy combined panel remains available', async () => {
  const items=['calendar','google_forms','email'].map(kind=>({kind,title:kind,id:kind,connected:true,resource:`RESOURCE-${kind}`}));
  const plugin={name:'google-fixture',setup(build) {build.onLoad({filter:/GoogleConnectionsPanel\.tsx$/},args=>({
    contents:readFileSync(args.path,'utf8').replace('useState<{ configured: boolean; items: Connection[] } | null>(null)',`useState<{ configured: boolean; items: Connection[] } | null>(${JSON.stringify({configured:true,items})})`),loader:'tsx',resolveDir:path.dirname(args.path),
  }));}};
  const {render}=await bundle(`
    import {renderToStaticMarkup} from 'react-dom/server'; import {GoogleConnectionsPanel} from './pages/GoogleConnectionsPanel';
    import {SessionContext,emptyCaps} from './lib/session';
    export const render=kind=>renderToStaticMarkup(<SessionContext.Provider value={{me:{user:{locale:'ru'}},caps:emptyCaps}}><GoogleConnectionsPanel kind={kind} onChange={()=>{}} /></SessionContext.Provider>);
  `,[plugin]);
  for(const {kind} of items){const html=render(kind);assert.ok(html.includes('RESOURCE-'+kind));for(const other of items.filter(x=>x.kind!==kind))assert.ok(!html.includes('RESOURCE-'+other.kind));}
  for(const {kind} of items)assert.ok(render().includes('RESOURCE-'+kind));
});

test('Task summaries keep deadlines, ownership and send warnings visible; workflows remain inside closed disclosures', async () => {
  const fixtures = [
    {id:'task-open',title:'Обсудить макет',status:'open',type:'call',whoName:'Клиент Алия',whoPhone:'+77015556677',assigneeName:'Дана',dueAt:'2020-01-01T12:00:00Z',createdAt:'2020-01-01T11:00:00Z',briefingText:'PRIVATE BRIEFING',conversationId:'conversation-1'},
    {id:'task-progress',title:'Проверить смету',status:'in_progress',type:'other',assigneeName:'Ерлан',createdAt:'2020-01-01T11:00:00Z'},
    {id:'task-file',title:'Отправить файл',status:'waiting',type:'message',needsFileRetry:true,createdAt:'2020-01-01T11:00:00Z'},
    {id:'task-done',title:'Согласовать договор',status:'done',type:'other',doneAt:'2020-01-02T12:00:00Z',createdAt:'2020-01-01T11:00:00Z'},
  ];
  const plugin={name:'task-fixtures',setup(build){build.onLoad({filter:/TasksPage\.tsx$/},args=>({
    contents:readFileSync(args.path,'utf8').replace('[items, setItems] = useState<any[]>([])',`[items, setItems] = useState<any[]>(${JSON.stringify(fixtures)})`)+'\nexport {dueGroup};',loader:'tsx',resolveDir:path.dirname(args.path),
  }));}};
  const {render,dueGroup}=await bundle(`
    import {renderToStaticMarkup} from 'react-dom/server'; import {MemoryRouter} from 'react-router-dom';
    import {SessionContext,emptyCaps} from './lib/session'; import {TasksPage} from './pages/TasksPage';
    export {dueGroup} from './pages/TasksPage';
    export const render=(locale,url='/tasks')=>renderToStaticMarkup(<SessionContext.Provider value={{me:{user:{locale}},caps:{...emptyCaps,manageTasks:true}}}><MemoryRouter initialEntries={[url]}><TasksPage /></MemoryRouter></SessionContext.Provider>);
  `,[plugin]);
  const prior=globalThis.localStorage;
  try {
    for(const locale of ['ru','kk','en']) {
      globalThis.localStorage={getItem:()=>locale};
      const html=render(locale);
      const cards=[...html.matchAll(/<details class="task-card[^]*?<\/details>/g)].map(m=>m[0]);
      assert.equal(cards.length,3); // Default view includes waiting tasks, but keeps completed tasks in Archive.
      assert.doesNotMatch(html, /Согласовать договор/);
      for(const card of cards) {
        assert.doesNotMatch(card, /^<details[^>]*\bopen(?:=|\s|>)/);
        const summary=card.split('</summary>')[0];
        assert.doesNotMatch(summary, /PRIVATE BRIEFING|<button|<a\s|<input/);
        assert.match(summary,/task-card-owner/);
      }
      assert.match(cards[0].split('</summary>')[0],/Клиент Алия/);
      assert.match(cards[0].split('</summary>')[0],/\+7 701 555 66 77/);
      assert.match(cards[0],/PRIVATE BRIEFING/);
      assert.match(cards[0],/href="\/conversations\/conversation-1"/);
      assert.match(cards[2].split('</summary>')[0],/task-card-alerts/);
      if(locale==='ru') {
        assert.match(cards[1],/>Изменить<\/button>/);
        assert.match(cards[1],/>Завершить<\/button>/);
        assert.match(cards[2].split('</summary>')[0],/Текст ушёл · файл не отправлен/);
        assert.match(html,/type="search"/);
      }
      if(locale==='kk')assert.match(html,/Тапсырмаларды іздеу/);
      if(locale==='en')assert.match(html,/Search tasks/);
    }
    globalThis.localStorage={getItem:()=> 'ru'};
    const search=render('ru','/tasks?taskSearch='+encodeURIComponent('МАКЕТ дана'));
    assert.equal((search.match(/<details class="task-card/g)||[]).length,1);
    assert.match(search,/Обсудить макет/);
    assert.doesNotMatch(search,/Проверить смету|Согласовать договор/);
    assert.match(render('ru','/tasks?taskSearch=does-not-exist'),/Ничего не найдено/);
    const completed=render('ru','/tasks?filter=done');
    assert.equal((completed.match(/<details class="task-card/g)||[]).length,1);
    assert.match(completed,/Согласовать договор/);
    const internal=render('ru','/tasks?category=internal');
    assert.match(internal,/Проверить смету/);
    assert.doesNotMatch(internal,/Обсудить макет|Отправить файл/);
    assert.equal((render('ru','/tasks?filter=all').match(/<details class="task-card/g)||[]).length,4);
    // Later today belongs to Today, rather than Upcoming; scheduled sends retain their own group.
    const now=new Date('2035-03-15T10:00:00');
    assert.equal(dueGroup({status:'open',dueAt:'2035-03-15T15:00:00'},now),'today');
    assert.equal(dueGroup({status:'open',dueAt:'2035-03-15T09:00:00'},now),'overdue');
    assert.equal(dueGroup({status:'open',dueAt:'2035-03-16T15:00:00'},now),'later');
    assert.equal(dueGroup({status:'open'},now),'none');
    assert.equal(dueGroup({status:'open',dueAt:'2035-03-15T15:00:00',sendScheduled:true},now),'later');
  } finally {if(prior)globalThis.localStorage=prior;else delete globalThis.localStorage;}
});

test('Kazakh generated task titles translate on client cards and tasks while preserving manual text and names', async () => {
  const task={id:'generated-task',title:'Связаться с клиентом: Заявка из WhatsApp',source:'rule',dedupeKey:'inquiry-process:inquiry-1',type:'process_inquiry',status:'open',createdAt:'2026-09-22T10:00:00Z'};
  const manual={...task,id:'manual-task',source:'manual',dedupeKey:null};
  const nextAction={title:task.title,titlePresentation:{kind:'inquiry_contact',subject:'Заявка из WhatsApp'}};
  const fixture={items:[{id:'client-1',name:'Владелец CREOLAB',ownerName:'Владелец CREOLAB',sourceLabel:'Форма сайта',nextAction}],total:1,offset:0,limit:25};
  const plugin={name:'kazakh-record-fixtures',setup(build){build.onLoad({filter:/(Clients|Tasks)Page\.tsx$/},args=>({
    contents:readFileSync(args.path,'utf8')
      .replace('useState<any>(null)',`useState<any>(${JSON.stringify(fixture)})`)
      .replace('[items, setItems] = useState<any[]>([])',`[items, setItems] = useState<any[]>(${JSON.stringify([task,manual])})`),loader:'tsx',resolveDir:path.dirname(args.path),
  }));}};
  const {render,localizedTaskTitle,taskTitlePresentation}=await bundle(`
    import {renderToStaticMarkup} from 'react-dom/server';import {MemoryRouter} from 'react-router-dom';
    import {SessionContext,emptyCaps} from './lib/session';import {ClientsPage} from './pages/ClientsPage';import {TasksPage} from './pages/TasksPage';
    export {localizedTaskTitle,taskTitlePresentation} from '@creolab/contracts';
    export const render=(page,locale)=>renderToStaticMarkup(<SessionContext.Provider value={{me:{user:{locale}},caps:emptyCaps}}><MemoryRouter>{page==='clients'?<ClientsPage />:<TasksPage />}</MemoryRouter></SessionContext.Provider>);
  `,[plugin]);
  const prior=globalThis.localStorage;
  try {
    globalThis.localStorage={getItem:()=> 'kk'};
    const clients=render('clients','kk');
    assert.match(clients,/Клиентпен байланысу: WhatsApp арқылы келген өтінім/);
    assert.match(clients,/Сайттағы форма/);
    assert.match(clients,/Владелец CREOLAB/);
    assert.doesNotMatch(clients,/Связаться с клиентом|Заявка из WhatsApp|Форма сайта/);
    const tasks=render('tasks','kk');
    assert.match(tasks,/>Клиентпен байланысу<\/strong>/);
    assert.match(tasks,/Связаться с клиентом: Заявка из WhatsApp/); // Identical manual task is still user content.
    assert.equal(localizedTaskTitle('ru',task),task.title);
    assert.equal(localizedTaskTitle('en',task),'Contact the client: Inquiry from WhatsApp');
    assert.equal(localizedTaskTitle('kk',manual),manual.title);
    assert.equal(taskTitlePresentation({...task,title:'Моя изменённая задача'}),null);
    const custom={...task,title:'Связаться с клиентом: Создать сайт для ТОО Пример'};
    assert.equal(localizedTaskTitle('kk',custom),'Клиентпен байланысу: Создать сайт для ТОО Пример');
    assert.equal(localizedTaskTitle('kk',nextAction),localizedTaskTitle('kk',task));
  } finally {if(prior)globalThis.localStorage=prior;else delete globalThis.localStorage;}
});

test('Server-owned contact and inquiry label catalogs have Kazakh coverage', () => {
  for (const relative of ['apps/api/src/services/contactLabels.ts', 'apps/api/src/services/inquiryPresentation.ts']) {
    const source=ts.createSourceFile(relative,readFileSync(path.join(root,relative),'utf8'),ts.ScriptTarget.Latest,true);
    function visit(node) {
      if(ts.isStringLiteral(node) && /[а-яё]/i.test(node.text)) assert.ok(known.has(node.text),`${relative}: ${node.text}`);
      ts.forEachChild(node,visit);
    }
    visit(source);
  }
});

test('Paused conversations offer both AI resume and human takeover without bypassing channel or plan restrictions', async t => {
  const previousStorage = globalThis.localStorage;
  const previousFixture = globalThis.__conversationFixture;
  globalThis.localStorage = { getItem: key => key === 'basqar.locale' ? globalThis.__conversationFixture?.locale || 'ru' : null };
  t.after(() => {
    if (previousStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = previousStorage;
    if (previousFixture === undefined) delete globalThis.__conversationFixture; else globalThis.__conversationFixture = previousFixture;
  });
  const plugins = [{ name: 'paused-conversation-fixture', setup(build) { build.onLoad({ filter: /ConversationsPage\.tsx$/ }, args => {
    const source = readFileSync(args.path, 'utf8');
    assert.ok(source.includes('const [workspace, setWorkspace] = useState<any>(null)'));
    return { contents: source.replace('const [workspace, setWorkspace] = useState<any>(null)', 'const [workspace, setWorkspace] = useState<any>(globalThis.__conversationFixture)'), loader: 'tsx', resolveDir: path.dirname(args.path) };
  }); } }];
  const { render } = await bundle(`
    import { renderToStaticMarkup } from 'react-dom/server';
    import { MemoryRouter } from 'react-router-dom';
    import { ConversationsPage } from './pages/ConversationsPage';
    import { SessionContext, emptyCaps } from './lib/session';
    export function render(locale, mode='paused', allowed=true, channel='whatsapp') {
      globalThis.__conversationFixture = { locale, conversation:{id:'test-conv', mode, modeLabel:mode==='paused'?'AI на паузе':'AI', channelType:channel, aiAvailable:true}, client:{id:'customer',name:'Имя клиента'}, messages:[],control:{},attribution:{},extracted:{} };
      return renderToStaticMarkup(<SessionContext.Provider value={{me:{user:{locale},billing:{entitlements:{AI_MANAGER:allowed}}},caps:emptyCaps}}><MemoryRouter><ConversationsPage /></MemoryRouter></SessionContext.Provider>);
    }
  `, plugins);
  const buttonLabels = html => [...html.matchAll(/<button\b[^>]*>(.*?)<\/button>/gs)].map(match => match[1].trim());
  const paused = render('ru');
  assert.match(paused, /AI на паузе/); assert.doesNotMatch(paused, /AI отключён/);
  assert.ok(buttonLabels(paused).includes('Вернуть AI')); assert.ok(buttonLabels(paused).includes('Передать менеджеру'));
  assert.ok(buttonLabels(render('ru','human')).includes('Вернуть AI'));
  assert.ok(!buttonLabels(render('ru','ai')).includes('Вернуть AI'));
  assert.ok(!buttonLabels(render('ru','paused',false)).includes('Вернуть AI'));
  assert.ok(!buttonLabels(render('ru','paused',true,'email')).includes('Вернуть AI'));
  const kk = render('kk'); assert.match(kk, /ЖИ кідіртілген/); assert.doesNotMatch(kk, /AI на паузе|Вернуть AI|Передать менеджеру/);
});


test('Period report translations and monthly plan explanations preserve meaning in both languages', async () => {
  const entries = dictionaryEntries(path.join(root,'apps/web/src/lib/analyticsCopy.ts'),'analyticsKk');
  assert.equal(new Set(entries.map(([key])=>key)).size,entries.length);
  const params=value=>[...value.matchAll(/\{([a-zA-Z]\w*)\}/g)].map(m=>m[1]).sort();
  for(const [ru,kk] of entries) {assert.ok(kk.trim());assert.deepEqual(params(ru),params(kk),ru);}
  const {analyticsText,planExplanation}=await bundle(`export {analyticsText,planExplanation} from './lib/analyticsCopy';`);
  for(const locale of ['ru','kk']) {
    const text=(value,params={})=>analyticsText(value,params,locale);
    assert.match(text('{won} успешных из {closed} закрытых',{won:3,closed:4}),/3/);
    const ready=planExplanation({status:'ready',prorated:true,missingAmounts:1},text);
    assert.match(ready,/календарных|күнтізбелік/);assert.match(ready,/без суммы|сомасы жоқ/);
    assert.match(planExplanation({status:'missing',missingMonths:['2029-11'],currency:'USD'},text),/2029-11 \(USD\)/);
    assert.match(planExplanation({status:'filtered'},text),/фильтр|сүзгі/i);
    assert.match(planExplanation({status:'legacy'},text),/месяц|айға/);
  }
});

test('Comparison chart retains the longer period and missing conversion is not drawn as zero', async () => {
  const plugin={name:'chart-export',setup(build){build.onLoad({filter:/StatsPage\.tsx$/},args=>({contents:readFileSync(args.path,'utf8')+'\nexport {LineChart,BarChart};',loader:'tsx',resolveDir:path.dirname(args.path)}));}};
  const {render}=await bundle(`import {renderToStaticMarkup} from 'react-dom/server';import {LineChart} from './pages/StatsPage';
    import {SessionContext,emptyCaps} from './lib/session';export const render=()=>renderToStaticMarkup(<SessionContext.Provider value={{me:{user:{locale:'ru'}},caps:emptyCaps}}><LineChart points={[{label:'15 октября',value:null}]} comparePoints={[{label:'1 сентября',value:10},{label:'2 сентября',value:20},{label:'30 сентября',value:75}]} metric="conversion" label="Comparison"/></SessionContext.Provider>);`,[plugin]);
  const html=render(); assert.match(html,/30 сентября/);assert.match(html,/75%/);
  assert.match(html,/нет закрытых сделок/);assert.match(html,/даты обоих периодов/);
  assert.doesNotMatch(html,/NaN|Infinity/);
});

test('Plan/fact and real cohort stages survive CSV, SpreadsheetML and printable exports', async () => {
  const exports=await bundle(`export {exportAnalyticsCsv,exportAnalyticsExcel,exportAnalyticsPdf} from './lib/statsExport';`);
  const data={currency:'KZT',period:{label:'Октябрь 2029'},financial:{sales:{byCurrency:[]},receipts:{byCurrency:[]}},
    sales:{plan:{status:'ready',label:'3 100 ₸',actual:{label:'1 550 ₸'},percent:50,prorated:true}},
    funnel:{mode:'cohort',steps:[{name:'КП отправлено',count:1,fromStartPct:25},{name:'Продано',count:2,fromStartPct:50}]}};
  const previous={document:globalThis.document,window:globalThis.window,create:URL.createObjectURL,revoke:URL.revokeObjectURL},blobs=[];
  globalThis.document={createElement:()=>({click(){}})};globalThis.window={open:()=>null};
  URL.createObjectURL=blob=>{blobs.push(blob);return 'blob:plan-test';};URL.revokeObjectURL=()=>{};
  try {
    exports.exportAnalyticsCsv(data,'funnel');exports.exportAnalyticsExcel(data,{funnel:true,sales:true});exports.exportAnalyticsPdf(data,{funnel:true,sales:true});
    for(const blob of blobs) {
      const text=await blob.text();assert.match(text,/1 550 ₸/);assert.match(text,/50%/);assert.match(text,/КП отправлено/);
      assert.match(text,/поздние продажи тоже входят/);assert.match(text,/не считаются потерей/);
    }
    const excel=await blobs[1].text();assert.match(excel,/<Row><Cell><Data ss:Type="String">/);assert.doesNotMatch(excel,/<tr>|<td>|<th>/);
    exports.exportAnalyticsExcel({...data,sales:{plan:{status:'filtered'}}},{sales:true});
    const filtered=await blobs[3].text();assert.match(filtered,/Снимите фильтры/);assert.doesNotMatch(filtered,/50%/);
  } finally {
    if(previous.document===undefined)delete globalThis.document;else globalThis.document=previous.document;
    if(previous.window===undefined)delete globalThis.window;else globalThis.window=previous.window;
    URL.createObjectURL=previous.create;URL.revokeObjectURL=previous.revoke;
  }
});


test('Conversion bars retain a genuine zero and exclude an unknown denominator', async () => {
 const plugin={name:'bar-export',setup(build){build.onLoad({filter:/StatsPage\.tsx$/},args=>({contents:readFileSync(args.path,'utf8')+'\nexport {BarChart};',loader:'tsx',resolveDir:path.dirname(args.path)}));}};
 const {render}=await bundle(`import {renderToStaticMarkup} from 'react-dom/server';import {BarChart} from './pages/StatsPage';export const render=()=>renderToStaticMarkup(<BarChart items={[{name:'All lost',conversion:0},{name:'Open only',conversion:null}]} valueKey="conversion"/>);`,[plugin]);
 const html=render();assert.match(html,/All lost/);assert.match(html,/0%/);assert.doesNotMatch(html,/Open only|Нет данных/);
});


test('Monthly plan editor renders accessible month, currency and amount fields in both languages', async () => {
 const fixture={stalledDealDays:7,proposalFollowUpThresholdDays:3,silenceReturnDays:14,salesPlanMinor:500,currency:'KZT',salesPlans:[{month:'2029-10',amount:3100,currency:'KZT'}],lostReasons:[],timeZone:'Asia/Almaty',revision:'a'.repeat(64),stages:[],processCalendar:{mode:'calendar',days:[1,2,3,4,5],start:'09:00',end:'18:00',excludedDates:[]}};
 const plugin={name:'loaded-ops',setup(build){build.onLoad({filter:/OpsSection\.tsx$/},args=>({contents:readFileSync(args.path,'utf8').replace('useState<Ops | null>(null)',`useState<Ops | null>(${JSON.stringify(fixture)})`),loader:'tsx',resolveDir:path.dirname(args.path)}));}};
 const {render}=await bundle(`import {renderToStaticMarkup} from 'react-dom/server';import {MemoryRouter} from 'react-router-dom';import OpsSection from './pages/OpsSection';export const render=locale=>renderToStaticMarkup(<MemoryRouter initialEntries={['/settings?section=ops#sales-plan']}><OpsSection locale={locale}/></MemoryRouter>);`,[plugin]);
 const ru=render('ru'),kk=render('kk');
 for(const html of [ru,kk]) {assert.match(html,/type="month"[^>]*value="2029-10"/);assert.match(html,/value="3100"/);assert.match(html,/value="KZT"/);assert.match(html,/inputMode="numeric"/);assert.doesNotMatch(html,/undefined|NaN/);}
 assert.match(ru,/Добавить месяц/);assert.match(kk,/Ай қосу/);assert.match(ru,/доля календарных дней/);assert.match(kk,/күнтізбелік күндер/);
});
