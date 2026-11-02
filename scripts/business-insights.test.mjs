import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const rendered = (async () => {
  const result = await build({ stdin: { contents: `
    import {renderToStaticMarkup} from 'react-dom/server';
    import {MemoryRouter} from 'react-router-dom';
    import {BusinessInsightCard} from './components/BusinessInsightCard';
    import {OpportunityRunReview} from './components/OpportunityTaskReview';
    export const render=(item,busy=false)=>renderToStaticMarkup(<MemoryRouter><BusinessInsightCard item={item} busy={busy} onAction={()=>{}} onDecision={()=>{}} onHistory={()=>{}} onRefresh={()=>{}}/></MemoryRouter>);
    export const review=(run,busy=false)=>renderToStaticMarkup(<MemoryRouter><OpportunityRunReview run={run} busy={busy} onConfirm={()=>{}} onCancel={()=>{}} onRefresh={()=>{}}/></MemoryRouter>);
  `, loader: "tsx", resolveDir: fileURLToPath(new URL("../apps/web/src", import.meta.url)) }, jsx: "automatic", bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent" });
  const module = { exports: {} };
  new Function("exports", "module", "require", result.outputFiles[0].text)(module.exports, module, createRequire(import.meta.url));
  return module.exports;
})();
function fixture(overrides = {}) {
  return { id: "test", rule: "task_overdue", state: "open", stale: false, checkedAt: "2026-11-01T10:00:00Z", content: {
    title: "Срок задачи прошёл", subject: "Перезвонить", explanation: "Срок прошёл, завершение не зарегистрировано.", formula: "Срок раньше времени проверки.",
    limitation: "Вне системы действия могли быть выполнены.", severity: "urgent", facts: [{ label: "Срок", value: "2026-10-30T08:00:00Z" }],
    period: { from: "2026-10-30T08:00:00Z", to: "2026-11-01T10:00:00Z", timezone: "Asia/Almaty", currency: null },
    sources: [{ label: "Задача", href: "/tasks?open=1" }], next: { label: "Проверить результат задачи", href: "/tasks?open=1" },
  }, ...overrides };
}
test("shows evidence, source, period, limitation and a concrete next action without claiming task completion", async () => {
  const html = (await rendered).render(fixture());
  for (const text of ["Перезвонить", "Почему появился этот вывод", "Срок раньше времени проверки", "Asia/Almaty", "Проверить результат задачи", "Принять к сведению", "Скрыть до изменения данных", "Отметки здесь не закрывают задачи и сделки", "История"]) assert.ok(html.includes(text), text);
  assert.match(html, /href="\/tasks\?open=1"/); assert.doesNotMatch(html, /undefined|NaN|Закрыть задачу/);
});
test("stale conclusions hide all old amounts and titles and expose only refresh and history", async () => {
  const item = fixture({ stale: true }); item.content.subject = "PRIVATE OLD TITLE"; item.content.facts = [{ label: "Оплата", value: "999999 ₸" }];
  const html = (await rendered).render(item);
  assert.match(html, /Нужна повторная проверка|Проверить заново/);
  assert.doesNotMatch(html, /PRIVATE|999999|Принять к сведению|Скрыть до изменения|href=/);
});
test("resolved conclusions cannot be acknowledged or dismissed as an active problem", async () => {
  const html = (await rendered).render(fixture({ state: "resolved" }));
  assert.match(html, /Условие больше не выполняется/);
  assert.match(html, /Ранее: Срок задачи прошёл/);
  assert.doesNotMatch(html, /Принять к сведению|Скрыть до изменения данных|class="btn"|insight-urgent/);
});
test("untrusted titles remain escaped text and busy state prevents duplicate decisions", async () => {
  const item = fixture(); item.content.subject = '<img src=x onerror="send()"><script>send()</script>';
  const html = (await rendered).render(item, true);
  assert.match(html, /&lt;img/); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<img|<script/);
  assert.equal((html.match(/disabled=""/g) || []).length, 3);
});
function opportunity(overrides = {}) {
  const item = fixture({ rule: "opportunity_deal", ...overrides });
  item.content.opportunity = { reasons: ["late_no_step"], existingTask: null, taskTitle: "Согласовать следующий шаг" };
  return item;
}
test("opportunity creates a reviewable task and existing work replaces the create button", async () => {
  const item = opportunity();
  assert.match((await rendered).render(item), /Поставить задачу сотруднику/);
  item.content.opportunity.existingTask = { id: "existing", title: "Обсудить детали с Алией" };
  const html = (await rendered).render(item);
  assert.match(html, /Обсудить детали с Алией/); assert.match(html, /\/tasks\?open=existing/);
  assert.doesNotMatch(html, /Поставить задачу сотруднику/);
});
test("resolved, hidden and stale opportunities cannot offer an executable new task", async () => {
  for (const overrides of [{ state: "resolved" }, { state: "dismissed" }, { stale: true }]) {
    assert.doesNotMatch((await rendered).render(opportunity(overrides)), /Поставить задачу сотруднику/);
  }
});
test("actual task outcome links history and status without claiming sales revenue", async () => {
  const html = (await rendered).render(opportunity({ action: { runId: "run", taskId: "task", taskStatus: "canceled", at: "2026-11-02T08:00:00Z", outcomeEventId: "event" } }));
  assert.match(html, /Задача создана/); assert.match(html, /Отменена/); assert.match(html, /view=plans&amp;run=run/);
  assert.match(html, /не подтверждение продажи или оплаты/); assert.doesNotMatch(html, /Поставить задачу сотруднику/);
});
test("task review discloses effect and requires explicit confirmation with escaped source text", async () => {
  const html = (await rendered).review({ id: "run", status: "draft", canConfirm: true, canCancel: true, steps: [{ key: "create", detail: '<script>send()</script> Ответственный: Алия, срок: завтра' }] }, true);
  assert.match(html, /одна внутренняя задача/); assert.match(html, /Подтвердить создание задачи/);
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
  assert.equal((html.match(/disabled=""/g) || []).length, 2);
});
test("completed and failed reviews never offer confirmation again", async () => {
  for (const status of ["succeeded", "failed", "cancelled", "expired"]) {
    const html = (await rendered).review({ id: "run", status, canConfirm: false, canCancel: false, error: status === 'failed' ? 'Данные изменились' : null, steps: [] });
    assert.doesNotMatch(html, /Подтвердить создание задачи/); assert.match(html, /Обновить результат/);
    if (status === 'failed') assert.match(html, /Данные изменились/);
  }
});
