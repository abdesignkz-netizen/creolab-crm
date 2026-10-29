import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { websiteFormSnippet } from '../apps/web/src/lib/websiteFormSnippet.ts';
import { websiteFormKk } from '../apps/web/src/lib/websiteFormLocale.ts';
import { systemText, kkSystemMessages } from '../packages/contracts/src/systemLocale.ts';

test('lazy form setup copy and generated visitor form have Kazakh translations', () => {
  for (const file of ['../apps/web/src/pages/WebsiteFormsPanel.tsx', '../apps/web/src/lib/websiteFormSnippet.ts']) {
    const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isStringLiteral(node) && /[А-Яа-яЁё]/.test(node.text)) {
        assert.ok(websiteFormKk[node.text] || Object.hasOwn(kkSystemMessages, node.text), `Missing form translation: ${node.text}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  const snippet = websiteFormSnippet('https://bsqr.kz/public/forms/frm_test/submissions', text => websiteFormKk[text] || systemText('kk', text));
  assert.match(snippet, /Өтінім жіберу/); assert.doesNotMatch(snippet, /Отправить заявку|Заявка отправлена/);
});

function embeddedForm(fetch, { insecureContext = false } = {}) {
  const listeners = {}, button = { disabled: false }, notice = { textContent: '' }, input = { disabled: false };
  const controls = [input, button]; let resets = 0, uuid = 0;
  const form = { action: 'https://bsqr.kz/public/forms/frm_test/submissions',
    querySelector: selector => selector.startsWith('button') ? button : notice,
    querySelectorAll: () => controls, addEventListener: (event, handler) => { listeners[event] = handler; },
    reset: () => { resets++; },
  };
  const html = websiteFormSnippet(form.action);
  const source = html.match(/<script>\n([\s\S]+)\n<\/script>/)[1];
  vm.runInNewContext(source, {
    document: { currentScript: { previousElementSibling: form } },
    crypto: { randomUUID: insecureContext ? undefined : () => `id-${++uuid}`, getRandomValues: bytes => { bytes.fill(++uuid); return bytes; } }, location: { href: 'https://company.kz/?utm_source=ads', search: '?utm_source=ads' },
    FormData: class { *[Symbol.iterator]() { yield ['name', 'Клиент']; yield ['phone', '+77015550199']; yield ['message', 'Вопрос']; } },
    AbortSignal: { timeout: () => undefined }, URLSearchParams, fetch,
  });
  return { listeners, notice, button, controls, resets: () => resets, submit: () => listeners.submit({ preventDefault() {} }) };
}

test('embedded form preserves data and submission ID after uncertainty; reports success only after server acceptance', async () => {
  const calls = []; let attempts = 0;
  const form = embeddedForm(async (url, init) => {
    calls.push({ url, init }); attempts++;
    if (attempts === 1) throw new Error('network lost');
    return { ok: true, json: async () => ({ ok: true }) };
  });
  await form.submit();
  assert.match(form.notice.textContent, /Не удалось подтвердить/); assert.equal(form.resets(), 0);
  assert.ok(form.controls.every(c => !c.disabled));
  await form.submit();
  assert.equal(calls[0].init.headers['X-Submission-Id'], calls[1].init.headers['X-Submission-Id']);
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(JSON.parse(calls[0].init.body).utm_source, 'ads');
  assert.match(form.notice.textContent, /Заявка отправлена/); assert.equal(form.resets(), 1);
  await form.submit(); assert.notEqual(calls[1].init.headers['X-Submission-Id'], calls[2].init.headers['X-Submission-Id']);
});

test('embedded form blocks repeated clicks in flight and uses a new key for an edited failed request', async () => {
  const calls = []; let finish;
  const form = embeddedForm(async (url, init) => { calls.push(init); return new Promise(resolve => { finish = resolve; }); });
  const pending = form.submit(); await form.submit(); assert.equal(calls.length, 1);
  assert.ok(form.controls.every(c => c.disabled));
  finish({ ok: false, json: async () => ({ ok: false }) }); await pending;
  assert.equal(form.resets(), 0); assert.match(form.notice.textContent, /Не удалось подтвердить/);
  form.listeners.input(); const second = form.submit();
  finish({ ok: true, json: async () => ({ ok: true }) }); await second;
  assert.notEqual(calls[0].headers['X-Submission-Id'], calls[1].headers['X-Submission-Id']);
});

test('embedded form escapes attribute content and translated script text', () => {
  assert.throws(() => websiteFormSnippet('javascript:alert(1)'));
  const html = websiteFormSnippet('https://bsqr.kz/public/forms/test?name="<&', () => '</script><img onerror="bad">');
  assert.equal((html.match(/<script>/g) || []).length, 1);
  assert.equal((html.match(/<\/script>/g) || []).length, 1);
  assert.doesNotMatch(html, /<img/);
});

test('embedded form works on HTTP websites where randomUUID is unavailable', async () => {
  const ids = [];
  const form = embeddedForm(async (_url, init) => {
    ids.push(init.headers['X-Submission-Id']);
    return { ok: true, json: async () => ({ ok: true }) };
  }, { insecureContext: true });
  await form.submit(); await form.submit();
  assert.equal(form.resets(), 2);
  assert.match(ids[0], /^[0-9a-f]{32}$/); assert.notEqual(ids[0], ids[1]);
});
