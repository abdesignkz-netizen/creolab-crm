import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const renderer = (async () => {
  const result = await build({ stdin: { contents: `
    import {renderToStaticMarkup} from 'react-dom/server';
    import {MemoryRouter} from 'react-router-dom';
    import {BusinessExperimentResult, ExperimentSampleCard, ExperimentMethodReview} from './components/BusinessExperimentResult';
    import {BusinessExperimentForm} from './components/BusinessExperimentForm';
    import {ExperimentHistory} from './components/BusinessExperimentsPanel';
    import {createBusinessExperimentsApi} from '@creolab/api-client/business-experiments';
    export const card=(result,stopped=false)=>renderToStaticMarkup(<BusinessExperimentResult result={result} stopped={stopped}/>);
    export const sample=(sample)=>renderToStaticMarkup(<ExperimentSampleCard label="Исходный период" sample={sample}/>);
    export const review=(item)=>renderToStaticMarkup(<MemoryRouter><ExperimentMethodReview item={item}/></MemoryRouter>);
    export const history=(item)=>renderToStaticMarkup(<ExperimentHistory item={item}/>);
    export const form=(options,item=null,busy=false)=>renderToStaticMarkup(<MemoryRouter><BusinessExperimentForm options={options} item={item} busy={busy} onSave={()=>{}} onCancel={()=>{}}/></MemoryRouter>);
    export const client=createBusinessExperimentsApi;
  `, loader: "tsx", resolveDir: fileURLToPath(new URL("../apps/web/src", import.meta.url)) }, jsx: "automatic", bundle: true, platform: "node", format: "cjs", loader: { ".css": "empty" }, write: false, logLevel: "silent" });
  const module = { exports: {} }; new Function("exports", "module", "require", result.outputFiles[0].text)(module.exports, module, createRequire(import.meta.url)); return module.exports;
})();
const sample = (medianMinutes = 100) => ({ medianMinutes, meanMinutes: medianMinutes, total: 10, prepared: 10, pending: 0, capped: false });
const result = (status = "improvement_observed") => ({ status, baseline: sample(), current: sample(60), reductionPercent: 40, reasons: [], recommendation: "Порог достигнут в наблюдаемых данных. Причинная связь не доказана.", causal: false });
const item = () => ({ hypothesis: "Шаблон поможет подготовить КП быстрее", change: "Согласовать структуру", method: { baselineFrom: "2026-10-26", baselineTo: "2026-11-01", from: "2026-11-03", to: "2026-11-09", targetReductionPercent: 20, minimumSample: 10, memberIds: ["member"], initiativeTaskId: "task", goal: { id: "goal", version: 1 }, decision: { id: "decision", version: 2 } },
  timezone: "Asia/Almaty", members: [{ id: "member", name: "Алия", active: true }], initiative: { id: "task", title: "Внедрить шаблон", status: "done", href: "/tasks?open=task", runHref: "/control?view=plans&run=run" }, limitations: ["Календарное время до подготовки отправки, а не факт отправки."] });
test("method review shows actual team, periods, criterion, implementation and exact source links", async () => {
  const html = (await renderer).review(item());
  for (const text of ["Шаблон поможет", "2026-10-26", "2026-11-09", "Asia/Almaty", "20%", "10 КП", "Алия", "Внедрить шаблон", "Выполнение записано", "не факт отправки"]) assert.ok(html.includes(text), text);
  for (const path of ["/tasks?open=task", "view=goals&amp;goal=goal", "view=memory&amp;decision=decision", "view=plans&amp;run=run"]) assert.ok(html.includes(path), path);
});
test("unknown and capped samples never display a fabricated zero", async () => {
  for (const s of [null, { ...sample(null), total: 0, prepared: 0 }, { ...sample(null), capped: true, total: 2001 }]) {
    const html = (await renderer).sample(s); assert.match(html, /Нет измерения/); assert.doesNotMatch(html, />0 мин/);
  }
});
test("positive before-after result is observational and explicitly disclaims quality and causal claims", async () => {
  const html = (await renderer).card(result());
  for (const text of ["Наблюдается сокращение времени", "100 мин", "60 мин", "Подготовлено 10 из 10", "40%", "не доказывает", "Качество КП и реальные продажи проверяются отдельно"]) assert.ok(html.includes(text), text);
});
test("insufficient data, changed conditions and in-progress states cannot render a successful headline", async () => {
  for (const [status, label] of [["insufficient_data", "Данных недостаточно"], ["conditions_changed", "Условия изменились"], ["in_progress", "Промежуточные данные"], ["no_improvement", "Порог улучшения не достигнут"]]) {
    const html = (await renderer).card({ ...result(status), recommendation: "Эффект не подтверждён.", reasons: ["Нужно больше наблюдений"], current: { ...sample(60), pending: 3 } });
    assert.ok(html.includes(label)); assert.match(html, /Нужно больше наблюдений/); assert.match(html, /без подготовки — 3/); assert.doesNotMatch(html, /Наблюдается сокращение времени/);
  }
});
test("stopped run is never presented as a successful experiment", async () => {
  const html = (await renderer).card(result(), true); assert.match(html, /Последнее измерение до остановки/); assert.match(html, /не считаются её успешным итогом/); assert.doesNotMatch(html, /Порог достигнут/);
});
test("shared view hides unavailable initiative link and safely escapes user material", async () => {
  const i = item(); i.initiative = null; i.hypothesis = '<img src=x onerror="steal()">'; i.members[0].active = false;
  const html = (await renderer).review(i); assert.match(html, /Задача внедрения недоступна/); assert.match(html, /Алия \(недоступен\)/); assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img|href="\/tasks/);
});
test("setup uses three understandable steps, valid default periods and explicit separate confirmation", async () => {
  const html = (await renderer).form({ today: "2026-11-02", timezone: "Asia/Almaty", members: [{ id: "member", name: "Алия" }], goals: [], decisions: [] }, null, true);
  for (const text of ["1. Улучшение и его внедрение", "2. Группа и периоды", "3. Критерий результата", "2026-10-26", "2026-11-01", "2026-11-03", "2026-11-09", "Методика фиксируется отдельным подтверждением", "Сохранить и проверить условия"]) assert.ok(html.includes(text), text);
  assert.equal((html.match(/type="date"/g) || []).length, 4); assert.match(html, /<fieldset disabled=""/); assert.match(html, /type="checkbox"/);
});
test("history retains versions, company timezone, explanations and escaped notes", async () => {
  const i = item(); i.history = [{ id: "e", type: "note", version: 4, at: "2026-11-02T07:00:00Z", note: "<script>test()</script>" }];
  i.measurements = [{ id: "m", at: "2026-11-02T07:00:00Z", result: { ...result("conditions_changed"), reasons: ["Изменились цены"] } }];
  const html = (await renderer).history(i);
  for (const text of ["версия 4", "12:00", "Условия изменились", "Изменились цены", "&lt;script&gt;"]) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<script>/);
});
test("API client keeps explicit version, reviewed hash and retry ID for mutation and escapes URL selectors", async () => {
  const calls = [], client = (await renderer).client(async (...args) => { calls.push(args); return {}; });
  const body = { version: 3, reviewHash: "a".repeat(64), requestId: "retry-key" };
  await client.operate("id/with slash", "approve", body); await client.save("draft", { ...body, title: "Изменение" }); await client.list("all", "cursor"); await client.tasks("100%_ + КП");
  assert.match(calls[0][0], /id%2Fwith%20slash\/approve$/); assert.equal(calls[0][1].method, "POST"); assert.deepEqual(JSON.parse(calls[0][1].body), body);
  assert.equal(calls[1][1].method, "PATCH"); assert.match(calls[2][0], /state=all&cursor=cursor/); assert.match(calls[3][0], /q=100%25_\+%2B\+/);
});
