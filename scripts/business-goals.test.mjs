import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const renderer = (async () => {
  const result = await build({ stdin: { contents: `
    import {renderToStaticMarkup} from 'react-dom/server';
    import {MemoryRouter} from 'react-router-dom';
    import {BusinessGoalCard} from './components/BusinessGoalCard';
    import {BusinessGoalForm} from './components/BusinessGoalForm';
    import {BusinessGoalHistory} from './components/BusinessGoalHistory';
    export const card=(goal,busy=false)=>renderToStaticMarkup(<MemoryRouter><BusinessGoalCard goal={goal} busy={busy} onOpen={()=>{}} /></MemoryRouter>);
    export const form=(options,busy=false)=>renderToStaticMarkup(<MemoryRouter><BusinessGoalForm options={options} busy={busy} onSave={()=>{}} onCancel={()=>{}}/></MemoryRouter>);
    export const history=(goal)=>renderToStaticMarkup(<BusinessGoalHistory goal={goal}/>);
  `, loader: "tsx", resolveDir: fileURLToPath(new URL("../apps/web/src", import.meta.url)) }, jsx: "automatic", bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent" });
  const module = { exports: {} }; new Function("exports", "module", "require", result.outputFiles[0].text)(module.exports, module, createRequire(import.meta.url)); return module.exports;
})();
const fixture = () => ({ id: "goal", title: "Убрать просрочки", metric: "overdue_tasks", state: "active", timezone: "Asia/Almaty", from: "2026-10-31T19:00:00Z", to: "2026-11-30T19:00:00Z", currency: null, target: 0,
  owner: { name: "Алия", active: true }, baseline: { value: 10, at: "2026-11-01T08:00:00Z", status: "ready" },
  current: { asOf: "2026-11-02T08:00:00Z", progress: 50, reached: false, sample: { status: "ready", value: 5, samples: 10, unanswered: 0 } } });
test("goal card explains baseline, target, owner, scope, date and measured progress", async () => {
  const html = (await renderer).card(fixture());
  for (const phrase of ["Убрать просрочки", "Цель — не больше", "5 задач", "0 задач", "50%", "На старте наблюдения", "10 задач", "Алия", "Asia/Almaty", "30.11.2026", "Данные на"]) assert.ok(html.includes(phrase), phrase);
  assert.match(html, /<progress[^>]*value="50"/); assert.doesNotMatch(html, /NaN|undefined/);
});
test("no data never renders zero, a green 100 percent, or a reached claim", async () => {
  const g = fixture(); g.metric = "first_response_minutes"; g.target = 15; g.baseline = null; g.current = { ...g.current, progress: null, reached: null, sample: { status: "no_data", value: null, samples: 0, unanswered: 3 } };
  const html = (await renderer).card(g); assert.match(html, /Недостаточно данных/); assert.match(html, /Без ответа: 3/);
  assert.doesNotMatch(html, /<progress|100%|0 мин|Показатель достигнут/);
});
test("changed or stale targets hide prior progress", async () => {
  const g = fixture(); g.targetChanged = true; g.stale = true;
  const html = (await renderer).card(g); assert.match(html, /План изменён/); assert.doesNotMatch(html, /<progress|50%/);
});
test("sales goal identifies won deals without claiming received money", async () => {
  const g = fixture(); g.metric = "sales_won"; g.target = 100000; g.currency = "KZT"; g.current.sample.value = 50000;
  const html = (await renderer).card(g); assert.match(html, /Выигранные сделки/); assert.match(html, /не поступление денег/); assert.match(html, /₸/);
});
test("expired snapshot states its limitation, user content is escaped and busy buttons cannot repeat actions", async () => {
  const g = fixture(); g.title = '<script>send()</script>'; g.periodEnded = true; g.current.sample.status = "ended_snapshot"; g.current.progress = null;
  const html = (await renderer).card(g, true); assert.match(html, /Последний снимок до окончания/); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
  assert.match(html, /disabled=""/);
});
test("new goal form offers three clear outcomes, a required owner/period/target and single save action", async () => {
  const html = (await renderer).form({ timezone: "Asia/Almaty", selfId: "owner", members: [{ id: "owner", name: "Руководитель" }], salesPlans: [] }, true);
  for (const phrase of ["Выполнить план продаж", "Сократить просроченные задачи", "Отвечать клиентам быстрее", "Ответственный руководитель", "Начало периода", "По какую дату включительно", "Исходное значение измерится автоматически"]) assert.ok(html.includes(phrase), phrase);
  assert.match(html, /<fieldset disabled=""/); assert.match(html, /type="number"[^>]*required=""/);
});
test("history explains changed targets, titles and archiving without raw staff IDs", async () => {
  const goal = fixture(); goal.history = [{ id: "event", type: "changed", at: "2026-11-02T08:00:00Z", changes: {
    before: { target: "4", title: "Старая цель", ownerMembershipId: "private-old-id", state: "active" },
    after: { target: "1", title: "<img src=x>", ownerMembershipId: "private-new-id", state: "archived" },
  } }];
  const html = (await renderer).history(goal);
  for (const phrase of ["4 задач → 1 задач", "Старая цель", "&lt;img", "другой ответственный", "проверки остановлены"]) assert.ok(html.includes(phrase), phrase);
  assert.doesNotMatch(html, /private-old-id|private-new-id|<img/);
});
