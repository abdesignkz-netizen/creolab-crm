import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const compiled = (async () => {
  const result = await build({ stdin: { contents: `
    import {renderToStaticMarkup} from 'react-dom/server';
    import {MemoryRouter} from 'react-router-dom';
    import {AutopilotCaseCard} from './components/AutopilotCaseCard';
    export {absenceDate,absenceUntil} from './lib/autopilotDates';
    export const card=(row,busy=false)=>renderToStaticMarkup(<MemoryRouter><AutopilotCaseCard row={row} timezone="Asia/Almaty" busy={busy} onAction={()=>{}}/></MemoryRouter>);
  `, loader: "tsx", resolveDir: fileURLToPath(new URL("../apps/web/src", import.meta.url)) }, jsx: "automatic", bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent" });
  const module = { exports: {} }; new Function("exports", "module", "require", result.outputFiles[0].text)(module.exports, module, createRequire(import.meta.url)); return module.exports;
})();
const row = () => ({ id: "case", version: 1, inquiryId: "inquiry", title: "Подготовить презентацию", customer: "Айбек", state: "proposed", explanation: "Предлагаем напомнить сотруднику", dueAt: "2026-11-02T04:15:00Z", taskId: null, assignedName: null, canStart: true, canStop: true,
  createdAt: "2026-11-02T04:00:00Z", history: [{ id: "event", type: "detected", text: "Клиент ждёт ответа", at: "2026-11-02T04:00:00Z", runId: null }] });

test("proposals show source, local deadline and a review action rather than claiming work is done", async () => {
  const html = (await compiled).card(row());
  for (const text of ["Айбек", "Подготовить презентацию", "Ждёт подтверждения", "09:15", "Рассмотреть запуск", "Остановить сценарий", "История сценария"]) assert.ok(html.includes(text), text);
  assert.match(html, /href="\/requests\/inquiry"/); assert.doesNotMatch(html, /Ответ подтверждён/);
});
test("assignment is shown separately from verified reply, and task links open the existing task drawer", async () => {
  const html = (await compiled).card({ ...row(), state: "escalated", taskId: "task", assignedName: "Руководитель", canStart: false });
  assert.match(html, /Передано руководителю/); assert.match(html, /Ответственный: Руководитель/);
  assert.match(html, /href="\/tasks\?open=task"/); assert.doesNotMatch(html, /Рассмотреть запуск|Ответ подтверждён/);
});
test("resolved, stopped and attention states have no start or stop buttons", async () => {
  for (const [state, label] of [["resolved", "Ответ подтверждён"], ["stopped", "Остановлено"], ["attention", "Нужно внимание"]]) {
    const html = (await compiled).card({ ...row(), state, canStart: false, canStop: false, dueAt: null });
    assert.ok(html.includes(label)); assert.doesNotMatch(html, /Рассмотреть запуск|Остановить сценарий|Следующий этап/);
  }
});
test("busy state disables commands and history preserves the actual action link", async () => {
  const r = row(); r.history[0].runId = "run";
  const html = (await compiled).card(r, true);
  assert.equal((html.match(/disabled=""/g) || []).length, 2);
  assert.match(html, /href="\/control\?view=actions&amp;run=run"/);
});
test("untrusted customer and history text cannot become markup", async () => {
  const r = row(); r.customer = '<img src=x onerror="steal()">'; r.history[0].text = "<script>steal()</script>";
  const html = (await compiled).card(r); assert.match(html, /&lt;img/); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<img|<script/);
});
test("absence ends at company midnight independently of browser timezone and round-trips in Kazakhstan and DST zones", async () => {
  const { absenceUntil, absenceDate } = await compiled;
  assert.equal(absenceUntil("2026-11-02", "Asia/Almaty"), "2026-11-02T18:59:59.000Z");
  for (const [day, zone] of [["2026-11-02", "Asia/Almaty"], ["2026-03-08", "America/New_York"], ["2026-11-01", "America/New_York"], ["2026-12-31", "Pacific/Auckland"]]) assert.equal(absenceDate(absenceUntil(day, zone), zone), day);
});
