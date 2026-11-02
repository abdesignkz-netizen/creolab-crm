import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const compiled = (async () => {
  const result = await build({ stdin: { contents: `
    import {renderToStaticMarkup} from 'react-dom/server';
    import {MemoryRouter} from 'react-router-dom';
    import Home,{BusinessFocusSections} from './components/BusinessHomePanel';
    import {SessionContext} from './lib/session';
    export const home=(overview,personal=false,links)=>renderToStaticMarkup(<MemoryRouter><SessionContext.Provider value={{me:{user:{locale:'ru'}}}}><Home overview={overview} personal={personal} links={links}/></SessionContext.Provider></MemoryRouter>);
    export const sections=(focus,locale='ru')=>renderToStaticMarkup(<MemoryRouter><BusinessFocusSections focus={focus} locale={locale}/></MemoryRouter>);
  `, loader: "tsx", resolveDir: fileURLToPath(new URL("../apps/web/src", import.meta.url)) }, loader: { ".css": "empty" }, jsx: "automatic", bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent" });
  const module = { exports: {} }; new Function("exports", "module", "require", result.outputFiles[0].text)(module.exports, module, createRequire(import.meta.url)); return module.exports;
})();
const focus = () => ({ scope: "company", asOf: "2026-11-02T05:00:00Z", insights: { status: "ready", items: [], scannedAt: null, sampled: true }, actions: { status: "ready", items: [], recent: [] }, goals: { status: "ready", items: [] } });
const overview = () => ({ result: { inquiries: 4, wonDeals: 2, wonAmountLabel: "20 000 ₸" }, period: { label: "Сегодня" }, attention: { items: [{ title: "Клиент ждёт ответа", contactName: "Алия", phone: "+77015556677", href: "/conversations/one" }], summary: { overdueTasks: 3 } }, payments: { paidInPeriodLabel: "10 000 ₸" } });
test("next action precedes metrics and Control; numbers and money retain their distinct meaning", async () => {
  const html = (await compiled).home(overview());
  assert.ok(html.indexOf("Ближайший шаг") < html.indexOf("home-pulses")); assert.match(html, /Алия/); assert.match(html, /href="\/conversations\/one"/);
  for (const text of ["20 000 ₸", "10 000 ₸", "Новые за выбранный период", "Успешные сделки", "Внесены в CRM за период", "Просроченных задач сейчас", "Вопрос или команда Control", "История и ответы"]) assert.ok(html.includes(text), text);
});
test("employee home shows personal queue and Control without company money or goals", async () => {
  const data = { ...overview(), items: [{ title: "Моя задача", href: "/tasks?open=mine" }] };
  const html = (await compiled).home(data, true); assert.match(html, /Моя задача/); assert.doesNotMatch(html, /20 000|10 000|home-pulses|Цели компании|Анализ бизнеса/);
});
test("empty company offers a manual next step instead of a fabricated all-clear score", async () => {
  const { home, sections } = await compiled, html = home({});
  assert.match(html, /Открыть задачи/); assert.match(html, /Настроить работу/); assert.match(html, /Поступления пока не внесены/);
  const details = sections(focus()); assert.match(details, /Первичная проверка ещё не завершена/); assert.match(details, /Задайте измеримую цель/); assert.doesNotMatch(details, /Всё хорошо|проблем нет|0%/);
});
test("partial failure does not look like an empty module, and a pending plan remains reviewable", async () => {
  const f = focus(); f.insights.status = "unavailable"; f.actions.items = [{ id: "a", title: "Подготовить предложение", status: "draft", href: "/control?view=plans&run=a" }];
  const html = (await compiled).sections(f); assert.match(html, /Не удалось проверить данные/); assert.doesNotMatch(html, /В выборке нет актуальных/);
  assert.match(html, /Ждёт проверки и подтверждения/); assert.match(html, /view=plans&amp;run=a/); assert.doesNotMatch(html, /Подтвердить все/);
});
test("fractional progress stays fractional and stale/ended goals do not advertise success", async () => {
  const f = focus(); f.goals.items = [{ id: "g", title: "План продаж", progress: 99.9, reached: false, stale: false, ended: false, href: "/control?view=goals&goal=g" }];
  let html = (await compiled).sections(f); assert.match(html, /99.9%/); assert.doesNotMatch(html, /100%|Цель достигнута/);
  f.goals.items[0].stale = true; html = (await compiled).sections(f); assert.match(html, /Измерение устарело/); assert.doesNotMatch(html, /99.9%/);
  f.goals.items[0].ended = true; html = (await compiled).sections(f); assert.match(html, /Период завершён/);
});
test("links preserve selected scope/period and user text is escaped", async () => {
  const o = overview(); o.attention.items[0].title = '<img src=x onerror=alert(1)>';
  const html = (await compiled).home(o, false, { inquiries: "/inquiries?period=last_7&scope=mine", sales: "/deals?outcome=won&scope=mine", payments: "/today?scope=mine#sit-result", tasks: "/tasks?scope=mine&filter=overdue" });
  assert.match(html, /period=last_7&amp;scope=mine/); assert.match(html, /outcome=won&amp;scope=mine/); assert.match(html, /scope=mine#sit-result/); assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img/);
});
test("Kazakh home sections remain understandable; a personal server response renders no company modules", async () => {
  const f = focus(), { sections } = await compiled; assert.match(sections(f, "kk"), /Компания мақсаттары/);
  f.scope = "personal"; f.goals.items = [{ title: "Private company data" }]; assert.equal(sections(f), "");
});
