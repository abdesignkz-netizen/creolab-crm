import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const config = require('../app.config.js')();
const eas = require('../eas.json');
const failures = [], passed = [], pending = [];
function check(name, fn) { try { fn(); passed.push(name); } catch (error) { failures.push(`${name}: ${error.message}`); } }
check('Production origin and identity', () => {
  assert.equal(config.extra.environment, 'production'); assert.equal(config.extra.appOrigin, 'https://bsqr.kz');
  assert.equal(config.name, 'BasQar'); assert.equal(config.scheme, 'basqar');
  assert.equal(config.ios.bundleIdentifier, 'kz.bsqr.app'); assert.equal(config.android.package, 'kz.bsqr.app');
});
check('No cleartext transport or app backups', () => {
  assert.equal(config.ios.infoPlist.NSAppTransportSecurity.NSAllowsArbitraryLoads, false);
  assert.equal(config.android.allowBackup, false);
  const build = config.plugins.find(item => Array.isArray(item) && item[0] === 'expo-build-properties')[1];
  assert.equal(build.android.usesCleartextTraffic, false); assert.ok(build.android.targetSdkVersion >= 36);
});
check('Real icon/splash files', () => {
  for (const name of ['icon', 'adaptive-icon', 'notification-icon', 'splash']) {
    const png = fs.readFileSync(path.join(mobile, `assets/${name}.png`));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    if (name === 'icon') { assert.equal(png.readUInt32BE(16), 1024); assert.equal(png.readUInt32BE(20), 1024); }
  }
});
check('APK/AAB profiles without auto-submit', () => {
  assert.equal(eas.build.preview.android.buildType, 'apk');
  assert.equal(eas.build.production.android.buildType, 'app-bundle'); assert.equal(eas.submit, undefined);
});
if (fs.existsSync(path.join(mobile, 'android/app/build.gradle'))) check('Native Android release never uses the debug signing key', () => {
  const gradle = fs.readFileSync(path.join(mobile, 'android/app/build.gradle'), 'utf8');
  const release = gradle.slice(gradle.indexOf('release {', gradle.indexOf('buildTypes {')));
  assert.ok(release.includes('signingConfigs.basqarRelease')); assert.ok(!release.includes('signingConfig signingConfigs.debug'));
}); else pending.push('Generate Android and iOS projects with npm run prebuild --workspace @creolab/mobile.');
if (!config.extra.eas?.projectId) pending.push('Link a real Expo project (BASQAR_EAS_PROJECT_ID) for cloud builds and push.');
if (!config.ios.appleTeamId) pending.push('Apple Developer team, signing certificate/provisioning and App Store Connect record.');
if (!config.android.googleServicesFile) pending.push('Firebase Android configuration and FCM v1 credential for push.');
pending.push('Real Android upload key / Play App Signing and Play Console record.');
pending.push('Device acceptance, store privacy declarations, operational account deletion and review screenshots.');
const tools = [
  ['Xcode', 'xcodebuild', ['-version']], ['Java', 'java', ['-version']], ['CocoaPods', 'pod', ['--version']],
];
for (const [label, command, args] of tools) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10000 });
  if (result.status !== 0) pending.push(`${label} is unavailable locally.`);
}
if (!process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT) pending.push('Android SDK location is not configured.');
console.log(JSON.stringify({ status: failures.length ? 'failed' : 'source_prepared_not_store_certified', passed, failures, pending }, null, 2));
process.exitCode = failures.length ? 1 : 0;
