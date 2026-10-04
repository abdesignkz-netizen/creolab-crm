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
const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
const properties = ast.statements.find(s => ts.isVariableStatement(s)).declarationList.declarations[0].initializer.properties;
const entries = properties.map(p => [p.name.text, p.initializer.text]);
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
        if (ts.isCallExpression(n) && n.expression.getText(source) === 'systemText' && ts.isStringLiteral(n.arguments[1])) {
          assert.ok(known.has(n.arguments[1].text), `${full}: ${n.arguments[1].text}`);
        }
        if (ts.isCallExpression(n) && n.expression.getText(source) === 'uiText' && ts.isStringLiteral(n.arguments[0])) {
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
  const result = await build({ stdin: { contents, loader: 'tsx', resolveDir: path.join(root, 'apps/web/src') }, jsx: 'automatic', bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent', plugins });
  const module = { exports: {} };
  new Function('exports', 'module', 'require', result.outputFiles[0].text)(module.exports, module, createRequire(import.meta.url));
  return module.exports;
}

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

test('WhatsApp AI setup can be requested and shows localized administrator guidance without claiming readiness', async () => {
  const { render } = await bundle(`
    import { renderToStaticMarkup } from 'react-dom/server';
    import { WhatsAppAiControls } from './components/WhatsAppAiControls';
    import { SessionContext, emptyCaps } from './lib/session';
    export const render = (locale, connection) => renderToStaticMarkup(<SessionContext.Provider value={{me:{user:{locale}},caps:emptyCaps}}><WhatsAppAiControls connection={connection} busy={false} onToggle={()=>{}} /></SessionContext.Provider>);
  `);
  const base = { status:'CONNECTED', aiEnabled:false, aiAvailable:false, aiUnavailableReason:'ai_model_missing' };
  for (const locale of ['ru','kk','en']) {
    const before = render(locale, base);
    assert.doesNotMatch(before, /disabled=""/);
    const pending = render(locale, {...base, aiEnabled:true});
    assert.match(pending, /href="https:\/\/wa.me\/77067301301"/);
    assert.match(pending, /\+7 706 730 13 01/);
    assert.match(pending, /role="status"/);
    assert.match(pending, locale === 'ru' ? /Ожидают настройки администратором/ : locale === 'kk' ? /Әкімшінің баптауын күтуде/ : /Awaiting administrator setup/);
    const ready = render(locale, {...base, aiEnabled:true, aiAvailable:true, aiUnavailableReason:null});
    assert.match(ready, /wa.me\/77067301301/);
    assert.match(ready, locale === 'ru' ? /<strong>Включены/ : locale === 'kk' ? /<strong>Қосылған/ : /<strong>Enabled/);
  }
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
  assert.doesNotMatch(kk, /Чьи записи|Все действия|Спросите о бизнесе|Нужно ответить|Обновлено|Добрый|Важные сделки/);
  assert.match(render('kk',true), /Қазір маңызды/);
  assert.match(render('ru'), /Чьи записи показывать/);
  assert.match(render('en'), /Чьи записи показывать/); // Existing English fallback is preserved.
});

test('Kazakh billing renders plan cards, comparison, resource warnings and onboarding; Russian and English are preserved', async () => {
  const { render } = await bundle(`
    import { renderToStaticMarkup } from 'react-dom/server';
    import { MemoryRouter } from 'react-router-dom';
    import { BillingPage } from './pages/BillingPage';
    import { BillingCatalog } from './components/BillingCatalog';
    import { CATALOG_BY_CODE } from '@creolab/contracts';
    import { SessionContext, emptyCaps } from './lib/session';
    export const render = (locale, yearly=false) => renderToStaticMarkup(<SessionContext.Provider value={{me:{user:{locale},billing:{planCode:'BASQAR_FREE',planName:'BasQar Free',subscriptionStatus:'active',entitlements:{AI_MANAGER:true,TEAM:true},usage:[{key:'AI_CREDITS',label:'AI-кредиты · пробный пакет один раз',used:100,cap:100}],warnings:[{code:'AI_CREDITS_exhausted',message:'AI-кредиты: использовано 100 из 100.'}],onboarding:{needed:true,steps:{}}}},caps:emptyCaps}}><MemoryRouter initialEntries={['/billing']}>{yearly ? <BillingCatalog items={Object.values(CATALOG_BY_CODE)} period="YEARLY" selected="" disabled={false} onSelect={()=>{}}/> : <BillingPage/>}</MemoryRouter></SessionContext.Provider>);
  `);
  const kk = render('kk');
  for (const text of ['Тарифтер және төлем','ЖИ кредиттері','Пайдаланушылар','Байланыс арналарының қосылымдары','Қосымша ресурстар','Жұмыс кабинетін баптаңыз','100 лимитінен 100 пайдаланылды','Сынақ режимі · 100 ЖИ кредиті бір рет']) assert.ok(kk.includes(text), text);
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
    StatsPage: {period:{label:'Бүгін'},overview:{},dataQuality:{},trend:{points:[]}},
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
    export const render=(name,locale)=>{const Page=pages[name];return renderToStaticMarkup(<SessionContext.Provider value={{me:{user:{locale}},caps:{...emptyCaps,companyAdmin:true,analytics:true,documents:true}}}><MemoryRouter><Page avr /></MemoryRouter></SessionContext.Provider>)};
  `,[plugin]);
  const before=globalThis.localStorage;let locale='kk';globalThis.localStorage={getItem:key=>key==='basqar.locale'?locale:null};
  try {
    for(const name of Object.keys(fixtures)) {
      const html=render(name,'kk');
      assert.doesNotMatch(html,/>\s*(?:Черновик|Активен|Новый|В работе|АВР|Обзор|Управление)\s*</,name);
      if(name==='ClientsPage') assert.match(html,/Клиент по-русски/);
      if(name==='SignPage') {assert.match(html,/123/);assert.match(html,/Орындалған жұмыстар актісі/);assert.doesNotMatch(html,/Акт выполненных работ/);assert.match(html,/ТОО Заказчик/);}
      if(name==='ControlPage') {assert.match(html,/2 күн 3 сағ/);assert.match(html,/Иван диалогты ЖИ-ден алды/);}
    }
    locale='ru';assert.match(render('SignPage','ru'),/Акт выполненных работ/);
  } finally {if(before)globalThis.localStorage=before;else delete globalThis.localStorage;}
});
