import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const root = fileURLToPath(new URL('../apps/web/src/', import.meta.url));
const source = readFileSync(path.join(root, 'i18n.ts'), 'utf8');
const ast = ts.createSourceFile('i18n.ts', source, ts.ScriptTarget.Latest, true);
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
function runtime(globals = {}) {
  const context = { exports: {}, ...globals };
  vm.runInNewContext(compiled, context);
  return context.exports;
}
function dictionaryNodes() {
  for (const statement of ast.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.name.getText(ast) === 'dict') return declaration.initializer.properties;
    }
  }
  throw new Error('Translation dictionaries not found');
}
const dictionaries = {};
for (const locale of dictionaryNodes()) {
  dictionaries[locale.name.getText(ast)] = locale.initializer.properties.map(property => [property.name.text, property.initializer.text]);
}

test('Kazakh translations cover all Russian keys without duplicates or empty strings', () => {
  for (const [locale, entries] of Object.entries(dictionaries)) {
    assert.equal(new Set(entries.map(([key]) => key)).size, entries.length, `${locale}: duplicate keys`);
    for (const [key, value] of entries) assert.ok(value?.trim(), `${locale}.${key}: empty text`);
  }
  assert.deepEqual(dictionaries.kk.map(([key]) => key).sort(), dictionaries.ru.map(([key]) => key).sort());
});

test('Translations preserve interpolation parameters', () => {
  const ru = Object.fromEntries(dictionaries.ru);
  const placeholders = value => [...value.matchAll(/\{([a-zA-Z]\w*)\}/g)].map(match => match[1]).sort();
  for (const [locale, entries] of Object.entries(dictionaries)) {
    for (const [key, value] of entries) assert.deepEqual(placeholders(value), placeholders(ru[key]), `${locale}.${key}`);
  }
});

test('Static translation calls refer to existing dictionary keys', () => {
  const known = new Set(dictionaries.ru.map(([key]) => key));
  function visitDirectory(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { visitDirectory(file); continue; }
      if (!/\.tsx?$/.test(file)) continue;
      const fileAst = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      function visit(node) {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't' && ts.isStringLiteral(node.arguments[1])) {
          assert.ok(known.has(node.arguments[1].text), `${file}: unknown key ${node.arguments[1].text}`);
        }
        ts.forEachChild(node, visit);
      }
      visit(fileAst);
    }
  }
  visitDirectory(root);
});

test('Profile language has a stable default independent of browser language', () => {
  const { normalizeLocale } = runtime({ navigator: { language: 'kk-KZ' } });
  assert.equal(normalizeLocale('kk'), 'kk');
  assert.equal(normalizeLocale('ru'), 'ru');
  assert.equal(normalizeLocale('unsupported'), 'ru');
  assert.equal(normalizeLocale(null), 'ru');
});

test('Public forms remember the chosen language and tolerate unavailable storage', () => {
  const values = new Map();
  const localStorage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const { getPublicLocale, rememberLocale } = runtime({ navigator: { language: 'kk-KZ' }, localStorage });
  assert.equal(getPublicLocale(), 'kk');
  rememberLocale('ru');
  assert.equal(getPublicLocale(), 'ru');
  rememberLocale('kk');
  assert.equal(getPublicLocale(), 'kk');
  assert.equal(runtime({ navigator: { language: 'kk-KZ' }, localStorage: { getItem() { throw new Error('Blocked'); } } }).getPublicLocale(), 'kk');
  assert.equal(runtime().getPublicLocale(), 'ru');
});

test('Auth errors retain recovery instructions without Russian fallback in Kazakh', () => {
  const { authErrorMessage, t } = runtime();
  assert.equal(authErrorMessage('kk', { code: 'invalid_credentials', message: 'Неверный email или пароль' }), t('kk', 'login.invalidCredentials'));
  assert.equal(authErrorMessage('kk', { code: 'rate_limited', message: 'Слишком много повторных отправок. Начните регистрацию заново.' }), t('kk', 'login.resendLimit'));
  assert.equal(authErrorMessage('kk', { message: 'Failed to fetch' }), t('kk', 'login.requestNetwork'));
  assert.equal(authErrorMessage('kk', { code: 'new_server_error', message: 'Серверная ошибка' }), t('kk', 'login.genericError'));
  assert.equal(authErrorMessage('ru', { message: 'Серверная ошибка' }), 'Серверная ошибка');
});

test('Kazakh personal settings render translated controls and preserve user-entered data', async () => {
  const { build } = await import('esbuild');
  const { createRequire } = await import('node:module');
  const result = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { renderToStaticMarkup } from 'react-dom/server';
        import { MemoryRouter } from 'react-router-dom';
        import { SettingsPage } from './pages/SettingsPage';
        import { SessionContext, emptyCaps } from './lib/session';
        export function render(section) {
          const me = { user: { locale: 'kk', firstName: 'Русское имя', email: 'test@example.test' }, activeTenant: { role: 'manager', jobTitle: 'Русская должность' } };
          return renderToStaticMarkup(<SessionContext.Provider value={{ me, caps: { ...emptyCaps, manager: true } }}>
            <MemoryRouter initialEntries={['/settings?section=' + section]}><SettingsPage /></MemoryRouter>
          </SessionContext.Provider>);
        }
      `,
      resolveDir: root,
      loader: 'tsx',
    },
    jsx: 'automatic', bundle: true, platform: 'node', format: 'cjs', write: false,
    logLevel: 'silent',
  });
  const exports = {};
  const module = { exports };
  new Function('exports', 'module', 'require', result.outputFiles[0].text)(exports, module, createRequire(import.meta.url));
  const { render } = module.exports;
  const profile = render('profile');
  assert.match(profile, /Электрондық пошта/);
  assert.match(profile, /Фотосурет/);
  assert.match(profile, /Русское имя/);
  assert.match(profile, /Русская должность/);
  assert.doesNotMatch(profile, /Фото не загружено|Должность в компании|Сохранить изменения/);
  const security = render('security');
  assert.match(security, /Қазіргі құпиясөз/);
  assert.match(security, /Құпиясөзді көрсету/);
  assert.doesNotMatch(security, /Показать пароль|Сменить пароль|Активные сессии/);
  const appearance = render('interface');
  assert.match(appearance, /Уақыт белдеуі/);
  assert.match(appearance, /Жүйе баптауына сай/);
  assert.doesNotMatch(appearance, /Светлая|Тёмная|Личный часовой пояс|24 часа/);
});

test('Interpolation uses the sentence order of each language and preserves user text literally', () => {
  const { t } = runtime();
  const values = { from: 1, to: 10, total: 20 };
  assert.equal(t('ru', 'pagination.range', values), '1–10 из 20');
  assert.equal(t('kk', 'pagination.range', values), '20 жазбаның 1–10 аралығы');
  assert.equal(t('kk', 'pdf.navigation', { title: '$& <Компания>' }), '$& <Компания> құжатын қарау');
  assert.match(t('kk', 'login.resetResendIn'), /\{n\}/);
});
