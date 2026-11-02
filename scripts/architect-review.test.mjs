import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const rendered = (async () => {
  const result = await build({ stdin: { contents: `
    import {renderToStaticMarkup} from 'react-dom/server';
    import {MemoryRouter} from 'react-router-dom';
    import {ArchitectReview} from './components/ArchitectReview';
    export const render=(preview,locale='ru',busy=false)=>renderToStaticMarkup(
      <MemoryRouter><ArchitectReview preview={preview} locale={locale} busy={busy} onEdit={()=>{}}/></MemoryRouter>);
  `, loader: "tsx", resolveDir: fileURLToPath(new URL("../apps/web/src", import.meta.url)) },
    jsx: "automatic", bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent" });
  const module = { exports: {} };
  new Function("exports", "module", "require", result.outputFiles[0].text)(module.exports, module, createRequire(import.meta.url));
  return module.exports;
})();

function fixture() {
  return { canApply: false, config: { ai: { successCriteria: "Пожелания собраны, запись не обещана без проверки" } },
    questions: [{ code: "owner", field: "responsibleMembershipId", text: "Кто подтверждает запись?" }],
    items: [
      { key: "pipeline", title: "Путь клиента", disposition: "keep", current: "Проверка потребности → Предложение", proposed: "Сохранить воронку", reason: "Этапы используются в работе", to: "/settings?section=ops" },
      { key: "channel", title: "Telegram", disposition: "connect", current: "Не подключён", proposed: "Подключить бота отдельно", reason: "Токен вводится в интеграциях", to: "/integrations" },
      { key: "ai", title: "ИИ", disposition: "unavailable", current: "Нет в тарифе", proposed: "Нужен доступ", reason: "Подписка не изменяется", to: "/settings/ai-manager" },
    ], limitations: ["Запись подтверждает сотрудник"] };
}
test("review distinguishes retained settings, missing connections, unavailable features and current versus proposed values", async () => {
  const html = (await rendered).render(fixture());
  for (const text of ["Сохраним как есть", "Нужно подключить", "Пока недоступно", "Сейчас", "В проекте", "Этапы используются в работе", "Это предложения по вашим ответам", "Кто подтверждает запись?", "Как проверить результат ИИ", "Запись подтверждает сотрудник"]) assert.ok(html.includes(text), text);
  assert.match(html, /href="\/settings\?section=ops"/); assert.match(html, /href="\/integrations"/);
  assert.doesNotMatch(html, />Применить|Проект применён|undefined|NaN/);
});
test("source descriptions are escaped text, never interpreted as HTML or instructions", async () => {
  const p = fixture(); p.items[0].proposed = '<img src=x onerror="alert(1)"><script>send()</script>';
  const html = (await rendered).render(p);
  assert.ok(html.includes("&lt;img")); assert.ok(html.includes("&lt;script&gt;"));
  assert.doesNotMatch(html, /<img|<script/);
});
test("Kazakh labels explain the draft boundary and remaining questions", async () => {
  const html = (await rendered).render(fixture(), "kk");
  for (const text of ["Бұл — жауаптарыңызға сай ұсыныстар", "Нақтылау керек", "Сол күйінде сақталады", "Қосу керек", "Әзірше қолжетімсіз", "Қазір", "Жобада", "Нені ескеру керек"]) assert.ok(html.includes(text), text);
});
test("editing is disabled while a request is running, and a complete review omits an empty clarification section", async () => {
  const { render } = await rendered; assert.match(render(fixture(), "ru", true), /disabled=""/);
  const p = fixture(); p.questions = []; p.config.ai.successCriteria = "";
  const html = render(p); assert.doesNotMatch(html, /architect-questions|Как проверить результат ИИ/);
});
