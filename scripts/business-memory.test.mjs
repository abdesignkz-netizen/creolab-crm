import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const renderer = (async () => {
  const result = await build({ stdin: { contents: `
    import {renderToStaticMarkup} from 'react-dom/server';
    import {MemoryRouter} from 'react-router-dom';
    import {BusinessDecisionCard} from './components/BusinessDecisionCard';
    import {BusinessDecisionForm} from './components/BusinessDecisionForm';
    export const card=(item,busy=false)=>renderToStaticMarkup(<MemoryRouter><BusinessDecisionCard item={item} timezone="Asia/Almaty" busy={busy} onOpen={()=>{}}/></MemoryRouter>);
    export const form=(initial,busy=false)=>renderToStaticMarkup(<MemoryRouter><BusinessDecisionForm initial={initial} timezone="Asia/Almaty" busy={busy} onSave={()=>{}} onCancel={()=>{}}/></MemoryRouter>);
  `, loader: "tsx", resolveDir: fileURLToPath(new URL("../apps/web/src", import.meta.url)) }, jsx: "automatic", bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent" });
  const module = { exports: {} }; new Function("exports", "module", "require", result.outputFiles[0].text)(module.exports, module, createRequire(import.meta.url)); return module.exports;
})();
const fixture = () => ({ id: "decision", version: 2, kind: "decision", state: "approved", effective: "active", author: "Алия", approver: "Директор", approvedAt: "2026-11-02T08:00:00Z", canEdit: true,
  content: { kind: "decision", topic: "Первый ответ", title: "Ответ за 15 минут", body: "Проверяем новые обращения каждые 15 минут.", rationale: "Проверена загрузка команды", sourceKind: "goal", sourceId: "goal",
    validFrom: "2026-11-01T08:00:00Z", validUntil: "2026-11-30T08:00:00Z", retentionUntil: "2027-02-01T08:00:00Z" }, source: { label: "Бизнес-цель", href: "/control?view=goals&goal=goal", available: true, changed: false } });

test("decision shows actionable content, source, author, approval and review/retention dates", async () => {
  const html = (await renderer).card(fixture());
  for (const text of ["Ответ за 15 минут", "Проверяем новые обращения", "Почему принято", "Проверена загрузка команды", "Утверждено и действует", "Алия", "Директор", "30.11.2026", "01.02.2027", "Открыть решение и историю"]) assert.ok(html.includes(text), text);
  assert.match(html, /href="\/control\?view=goals&amp;goal=goal"/);
});
test("drafts and hypotheses clearly state that they are not approved", async () => {
  const d = fixture(); d.state = "draft"; d.effective = "draft"; d.approver = null;
  assert.match((await renderer).card(d), /Черновик — ещё не применяется/);
  d.kind = "hypothesis"; d.effective = "hypothesis";
  const html = (await renderer).card(d); assert.match(html, /Гипотеза — требует проверки/); assert.doesNotMatch(html, /Утверждено и действует|Утвердил:/);
});
test("expired, revoked, replaced and changed decisions cannot look like active rules", async () => {
  for (const [effective, label] of [["expired", "Срок действия истёк"], ["revoked", "Отозвано"], ["source_changed", "Основание изменилось — нужна проверка"], ["superseded", "Заменено новым решением"]]) {
    const d = { ...fixture(), effective }; const html = (await renderer).card(d); assert.ok(html.includes(label)); assert.doesNotMatch(html, /Утверждено и действует/);
  }
  assert.match((await renderer).card({ ...fixture(), effective: "superseded", supersededById: "new-decision" }), /view=memory&amp;decision=new-decision/);
});
test("erased or unavailable contents remain hidden and no unavailable source link is rendered", async () => {
  const d = { ...fixture(), content: null, effective: "deleted", source: { label: "Содержимое удалено", href: null, available: false } };
  const html = (await renderer).card(d); assert.match(html, /Удалённая запись/); assert.doesNotMatch(html, /Ответ за 15 минут|Проверена загрузка|view=goals/);
  assert.match((await renderer).card({ ...d, effective: "source_unavailable" }), /Содержимое недоступно/);
});
test("untrusted decision markup is rendered as text", async () => {
  const d = fixture(); d.content.body = '<img src=x onerror="alert(1)">'; d.content.rationale = "<script>steal()</script>";
  const html = (await renderer).card(d); assert.match(html, /&lt;img/); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<img|<script/);
});
test("form saves only drafts and explains scope, source privacy and date limits without automatic activation", async () => {
  const html = (await renderer).form(fixture().content);
  for (const text of ["Тема — один конкретный вопрос", "Почему — факты", "Когда пересмотреть", "Когда удалить содержимое", "Asia/Almaty", "Сохранить черновик", "Утверждение — отдельным действием", "Гипотезы не участвуют", "видно только его автору"]) assert.ok(html.includes(text), text);
  assert.equal((html.match(/type="datetime-local"/g) || []).length, 3); assert.doesNotMatch(html, /Подтвердить и выполнить/);
});
test("hypothesis form asks for assumptions and busy form prevents duplicate submission", async () => {
  const initial = { ...fixture().content, kind: "hypothesis", sourceKind: "manual", sourceId: null };
  const html = (await renderer).form(initial, true); assert.match(html, /Что предполагаем и хотим проверить/); assert.match(html, /<fieldset disabled=""/); assert.match(html, /Сохраняем/);
  assert.match((await renderer).card(fixture(), true), /disabled=""/);
});
