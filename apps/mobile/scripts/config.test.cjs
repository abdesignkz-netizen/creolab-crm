const { test } = require('node:test');
const assert = require('node:assert/strict');
const configure = require('../app.config.js');

test('store configuration rejects remote substitutions and never enables HTTP', () => {
  const previous = { ...process.env };
  try {
    process.env.EAS_BUILD_PROFILE = 'production';
    for (const url of ['http://bsqr.kz', 'https://evil.example', 'https://user:password@bsqr.kz', 'https://bsqr.kz/api']) {
      process.env.BASQAR_APP_URL = url;
      assert.throws(() => configure(), url);
    }
    process.env.BASQAR_APP_URL = 'https://bsqr.kz';
    process.env.BASQAR_VERIFIED_LINKS = '1';
    const config = configure();
    const data = config.android.intentFilters.flatMap(item => item.data);
    assert.ok(data.some(item => item.path === '/tasks'));
    assert.ok(!data.some(item => item.pathPrefix === '/' || item.path?.startsWith('/api') || item.path?.startsWith('/billing')));
    assert.equal(config.ios.infoPlist.NSAppTransportSecurity.NSAllowsArbitraryLoads, false);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
