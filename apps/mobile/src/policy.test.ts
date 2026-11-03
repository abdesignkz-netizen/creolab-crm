import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { appLink, expiredExportFolder, externalLink, fileLink, FileTransfer, FILE_LIMIT, PRINT_HTML_LIMIT, oauthCallback, oauthRequest, pdfRequest, safeFileName, trustedUrl } from './policy.ts';
import { bridgeScript } from './webBridge.ts';

const origin = 'https://bsqr.kz';
test('only first-party navigation and known app links are accepted', () => {
  assert.equal(appLink('basqar://app/tasks?view=today', origin), `${origin}/tasks?view=today`);
  assert.equal(appLink(`${origin}/documents/avr/id`, origin), `${origin}/documents/avr/id`);
  for (const value of ['https://bsqr.kz.evil.example/tasks', 'https://evil.example/tasks', 'basqar://evil/tasks',
    'basqar://app//evil.example/tasks', 'basqar://app/api/v1/auth/logout', `${origin}/%2f%2fevil.example`,
    'https://user:password@bsqr.kz/tasks', 'javascript:alert(1)', 'file:///etc/passwd', `${origin}/billing/checkout/id`]) {
    assert.equal(appLink(value, origin), null, value);
  }
  assert.equal(trustedUrl('https://bsqr.kz@evil.example', origin), false);
  assert.equal(trustedUrl('blob:https://bsqr.kz/file', origin), false);
  for (const value of [`${origin}/api/v1/attachments/file-1`, `${origin}/api/v1/documents/avr/id/pdf`, `blob:${origin}/document`]) assert.equal(fileLink(value, origin), true);
  for (const value of [`${origin}/documents/avr/id`, 'https://outside.example/api/v1/attachments/id', 'blob:https://outside.example/document']) assert.equal(fileLink(value, origin), false);
  assert.equal(externalLink('https://example.com'), true);
  assert.equal(externalLink('tel:+77000000000'), true);
  for (const value of ['javascript:alert(1)', 'file:///tmp/private', 'intent://secret', 'http://insecure.example', 'mailto:test@example.com%0d%0aBcc:other@example.com']) assert.equal(externalLink(value), false);
});
test('OAuth result must match the pending provider and nonce; no session credential is carried', () => {
  const state = 'a'.repeat(64);
  const url = `https://accounts.google.com/o/oauth2/v2/auth?state=${state}&redirect_uri=${encodeURIComponent(`${origin}/api/v1/integrations/google/callback`)}`;
  const pending = oauthRequest(url, origin);
  assert.deepEqual(pending, { provider: 'google', state });
  const result = `basqar://oauth?provider=google&state=${state}&code=one-use-code`;
  assert.equal(oauthCallback(result, origin, pending), `${origin}/api/v1/integrations/google/callback?state=${state}&code=one-use-code`);
  assert.equal(oauthCallback(result, origin, null), null);
  assert.equal(oauthCallback(result.replace('provider=google', 'provider=instagram'), origin, pending), null);
  assert.equal(oauthCallback(`${result}&code=second`, origin, pending), null);
  assert.equal(oauthRequest(url.replace('accounts.google.com', 'accounts.google.com.evil.example'), origin), null);
  assert.equal(oauthRequest(url.replace(encodeURIComponent(`${origin}/api/v1/integrations/google/callback`), encodeURIComponent('https://evil.example/callback')), origin), null);
});
test('file transfer rejects partial, oversized, out-of-order and cross-file chunks', () => {
  const transfer = new FileTransfer();
  assert.throws(() => transfer.accept({ type: 'file:start', id: 'id', size: FILE_LIMIT + 1 }));
  transfer.accept({ type: 'file:start', id: 'id', size: 4, name: '../../Счёт.pdf' });
  assert.throws(() => transfer.accept({ type: 'file:chunk', id: 'id', index: 1, data: 'YWJjZA==' }));
  transfer.accept({ type: 'file:start', id: 'id', size: 4, name: '../../Счёт.pdf' });
  transfer.accept({ type: 'file:chunk', id: 'id', index: 0, data: 'YWJjZA==' });
  assert.deepEqual(transfer.accept({ type: 'file:end', id: 'id' }), { name: 'Счёт.pdf', base64: 'YWJjZA==' });
  transfer.accept({ type: 'file:start', id: 'other', size: 4, name: 'test' });
  assert.throws(() => transfer.accept({ type: 'file:end', id: 'other' }));
  assert.equal(safeFileName('../..'), 'document');
});
test('PDF conversion requires a bounded HTML document and a safe PDF filename', () => {
  const html = '<!DOCTYPE html><html><body>Отчёт</body></html>';
  assert.deepEqual(pdfRequest({ html, name: '../../Отчёт.pdf' }), { html, name: 'Отчёт.pdf' });
  for (const value of [null, '', 'file:///private/document', `<!DOCTYPE html>${'a'.repeat(PRINT_HTML_LIMIT)}`]) {
    assert.throws(() => pdfRequest({ html: value, name: 'report' }));
  }
});
test('export cleanup retains recent shared files and never selects unrelated cache paths', () => {
  const now = Date.UTC(2026, 10, 3, 12), old = now - 86400000;
  for (const name of [`basqar-${old}`, `basqar-pdf-${old}`]) assert.equal(expiredExportFolder(name, now), true);
  for (const name of [`basqar-${now}`, `basqar-pdf-${old + 1}`, `basqar-${now + 100000}`, 'other-app-file',
    `../basqar-${old}`, `basqar-${old}/other`, 'basqar-0', `basqar-pdf-${old}.pdf`]) {
    assert.equal(expiredExportFolder(name, now), false, name);
  }
});
test('bridge is executable JavaScript, does not run on another origin, and binds logout to this device', async () => {
  const posts: any[] = [], requests: any[] = [];
  const host: any = { ReactNativeWebView: { postMessage: (value: string) => posts.push(JSON.parse(value)) },
    fetch: async (url: string, init?: any) => { requests.push({ url, init }); return { ok: true, json: async () => ({ user: { id: 'user-one' } }) }; } };
  host.top = host;
  const context = { window: host, location: { origin, href: `${origin}/today` }, URL, console, setTimeout,
    document: { addEventListener: () => {} }, localStorage: { getItem: () => null } };
  vm.runInNewContext(bridgeScript(origin), context);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(posts[0], { protocol: 1, type: 'session', userId: 'user-one' });
  host.BasQarNative.setDeviceToken('test-device');
  await host.fetch('/api/v1/auth/logout', { method: 'POST', body: '{}' });
  assert.deepEqual(JSON.parse(requests.find(item => item.url === '/api/v1/auth/logout').init.body), { mobileDeviceToken: 'test-device' });
  await host.fetch('https://outside.example/api/v1/auth/logout', { method: 'POST', body: '{}' });
  assert.equal(requests.at(-1).init.body, '{}');
  await new Promise(resolve => setTimeout(resolve, 0));
  const sessions = posts.filter(item => item.type === 'session').length;
  await host.fetch('/api/v1/auth/login', { method: 'POST', body: '{}' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(posts.filter(item => item.type === 'session').length, sessions + 1, 'SPA login must notify the native shell');
  const count = requests.length;
  await host.BasQarNative.request('bad', '/api/v1/auth/login', 'POST', { password: 'must-not-be-forwarded' });
  assert.equal(requests.length, count);
  const html = '<!DOCTYPE html><html><body>Отчёт</body></html>';
  host.BasQarNative.printPdf(html, 'report.pdf');
  assert.deepEqual(posts.at(-1), { protocol: 1, type: 'print:pdf', html, name: 'report.pdf' });
  host.BasQarNative.printPdf('x'.repeat(PRINT_HTML_LIMIT + 1), 'report.pdf');
  assert.equal(posts.at(-1).type, 'error');
  const foreign: any = { ...host, BasQarNative: undefined }; foreign.top = foreign;
  vm.runInNewContext(bridgeScript(origin), { ...context, window: foreign, location: { origin: 'https://outside.example' } });
  assert.equal(foreign.BasQarNative, undefined);
});
