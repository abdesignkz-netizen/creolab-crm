import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const compiled = (async () => {
  const result = await build({ stdin: { contents: `
    import {renderToStaticMarkup} from 'react-dom/server';
    import {MemoryRouter} from 'react-router-dom';
    import {ControlAnalysisCard,controlAnalysisHref} from './components/ControlAnalysisCard';
    export {controlAnalysisHref};
    export const card=(analysis,busy=false)=>renderToStaticMarkup(<MemoryRouter><ControlAnalysisCard analysis={analysis} busy={busy} onPrepare={()=>{}}/></MemoryRouter>);
  `, loader: "tsx", resolveDir: fileURLToPath(new URL("../apps/web/src", import.meta.url)) }, jsx: "automatic", bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent" });
  const module = { exports: {} }; new Function("exports", "module", "require", result.outputFiles[0].text)(module.exports, module, createRequire(import.meta.url)); return module.exports;
})();
const sample = () => ({ profile: "sales", title: "Разбор продаж", asOf: "2026-11-02T05:00:00Z", timezone: "Asia/Almaty", summary: "Данные проверены", cards: [
  { kind: "facts", title: "Продажи", text: "Продажи: 1000 ₸", href: "/stats?tab=sales", asOf: "2026-11-02T05:00:00Z" },
  { kind: "decision", title: "Договориться о контакте", text: "Связаться после предложения", href: "/control?view=memory&decision=abc", asOf: "2026-11-02T05:00:00Z" },
], limitations: ["Причина снижения продаж не установлена"], suggestion: { title: "Проверить сделки", steps: ["Проверить историю"], href: "/deals", command: "Подготовь план действий по продажам" }, plan: null, budget: { reads: 5, maxReads: 5, modelCalls: 0, elapsedMs: 1000, limited: false } });
test("analysis attributes sources, context and time separately from a suggested next step", async () => {
  const html = (await compiled).card(sample());
  for (const text of ["10:00", "Данные сервиса", "Утверждённый контекст", "Предлагаемый следующий шаг", "Причина снижения", "Открыть источник", "выполнить вручную"]) assert.ok(html.includes(text), text);
  assert.match(html, /href="\/stats\?tab=sales"/); assert.match(html, /Подготовить план по свежим данным/);
});
test("a draft navigates to the actual review panel and does not offer execution from an old reply", async () => {
  const a = sample(); a.plan = { id: "run", href: "/control?view=plans&run=run", status: "draft", completed: 0, stepCount: 1 };
  const html = (await compiled).card(a); assert.match(html, /Ждёт проверки и подтверждения/); assert.match(html, /view=plans&amp;run=run/); assert.doesNotMatch(html, /Подготовить план по свежим данным/);
});
test("completed steps are not presented as achieved business results and canceled plans stay canceled", async () => {
  const a = sample(); a.plan = { id: "run", href: "/control?view=plans&run=run", status: "succeeded", completed: 1, stepCount: 1 };
  let html = (await compiled).card(a); assert.match(html, /Шаги плана выполнены/); assert.match(html, /не означает, что бизнес-результат достигнут/);
  a.plan.status = "cancelled"; html = (await compiled).card(a); assert.match(html, /Отменено/); assert.doesNotMatch(html, /Проверить план и подтвердить/);
});
test("partial analysis expands limitations and never offers to prepare an unsupported plan", async () => {
  const a = sample(); a.budget.limited = true; a.suggestion = null;
  const html = (await compiled).card(a); assert.match(html, /class="control-analysis-limitations" open=""/); assert.doesNotMatch(html, /Подготовить план по свежим данным/);
});
test("untrusted text is escaped and only supported local sources can be linked", async () => {
  const a = sample(); a.cards[0].text = '<script>alert(1)</script>'; a.cards[0].href = 'https://attacker.example/';
  const { card, controlAnalysisHref } = await compiled, html = card(a);
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script|attacker/);
  for (const href of ["//attacker.example", "javascript:alert(1)", "/api/secrets", "/control?next=https://example.com"]) assert.equal(controlAnalysisHref(href), "/control");
  assert.equal(controlAnalysisHref("/control?view=plans&run=abc"), "/control?view=plans&run=abc");
});
test("duplicate-click protection disables the prepare action while a request is pending", async () => {
  const html = (await compiled).card(sample(), true); assert.match(html, /disabled=""/);
});
