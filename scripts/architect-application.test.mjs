import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const renderer = (async () => {
  const result = await build({ stdin: { contents: `
    import {renderToStaticMarkup} from 'react-dom/server';
    import {MemoryRouter} from 'react-router-dom';
    import {ArchitectApplicationReview} from './components/ArchitectApplicationReview';
    export const render=(review,props={})=>renderToStaticMarkup(<MemoryRouter>
      <ArchitectApplicationReview review={review} locale="ru" busy={false} confirmed={false} onConfirm={()=>{}} onApply={()=>{}} onCancel={()=>{}} onRefresh={()=>{}} {...props}/>
    </MemoryRouter>);
  `, loader: "tsx", resolveDir: fileURLToPath(new URL("../apps/web/src", import.meta.url)) },
    jsx: "automatic", bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent" });
  const module = { exports: {} };
  new Function("exports", "module", "require", result.outputFiles[0].text)(module.exports, module, createRequire(import.meta.url));
  return module.exports.render;
})();
const fixture = () => ({ draftId: "draft", revision: 1, canApply: true, applicationHash: "hash", blockers: [], run: null,
  changes: [{ key: "reply_rules", title: "Аудитория и часы", before: "Всем круглосуточно", after: "Только новым. Пн–Пт 10:00–19:00", to: "/settings/ai-automation" }],
  pending: [{ text: "Подключите WhatsApp и отдельно проверьте ответ ИИ", to: "/integrations" }] });

test("exact before/after and unfinished steps remain separate; explicit unchecked confirmation disables apply", async () => {
  const html = (await renderer)(fixture());
  for (const phrase of ["До применения", "После применения", "Всем круглосуточно", "Только новым", "Осталось сделать отдельно", "Подключите WhatsApp", "подтверждаю применение"]) assert.ok(html.includes(phrase), phrase);
  assert.match(html, /<input[^>]*type="checkbox"/); assert.doesNotMatch(html, /checked=""/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Применить перечисленные изменения/);
  assert.match(html, /href="\/integrations"/); assert.doesNotMatch(html, /Настройки сохранены|undefined|NaN/);
});
test("apply is available only after confirmation and is blocked during a request", async () => {
  const render = await renderer;
  assert.match(render(fixture(), { confirmed: true }), /<button class="btn" type="button">Применить перечисленные изменения/);
  assert.match(render(fixture(), { confirmed: true, busy: true }), /<button[^>]*disabled=""[^>]*>Проверяем/);
  const p = fixture(); p.canApply = false; p.blockers = ["Настройки изменились в другой вкладке"];
  const html = render(p, { confirmed: true }); assert.match(html, /role="alert"/); assert.ok(html.includes(p.blockers[0])); assert.doesNotMatch(html, />Применить перечисленные изменения/);
});
test("queued and completed application display actual progress without promising completed connections", async () => {
  const render = await renderer, p = fixture(); p.canApply = false;
  p.run = { status: "queued", error: null, canCancel: true, steps: [{ key: "reply_rules", status: "pending" }] };
  const queued = render(p); assert.match(queued, /Ожидает выполнения/); assert.match(queued, /Отменить применение/); assert.doesNotMatch(queued, />Применить перечисленные изменения|>Выполнено</);
  p.run = { status: "succeeded", error: null, canCancel: false, steps: [{ key: "reply_rules", status: "succeeded" }] };
  const done = render(p); assert.match(done, /Настройки сохранены/); assert.match(done, /Выполнено/); assert.match(done, /Подключите WhatsApp/); assert.doesNotMatch(done, /Отменить применение|type="checkbox"/);
});
test("failed applications show the reason; source content stays text and Kazakh controls remain usable", async () => {
  const render = await renderer, p = fixture(); p.canApply = false; p.run = { status: "failed", error: "Сохранение не подтверждено", canCancel: false, steps: [] };
  p.changes[0].after = '<script>send()</script>';
  const html = render(p); assert.match(html, /Изменения не применены/); assert.match(html, /Сохранение не подтверждено/); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script|>Выполнено</);
  const kk = render(fixture(), { locale: "kk" });
  for (const phrase of ["Қолдануға дейін", "Қолданудан кейін", "Бөлек орындау керек", "Аталған өзгерістерді қолдану"]) assert.ok(kk.includes(phrase), phrase);
});
