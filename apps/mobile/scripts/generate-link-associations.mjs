import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const team = process.env.BASQAR_APPLE_TEAM_ID || '';
const fingerprints = (process.env.BASQAR_ANDROID_SHA256 || '').split(',').map(value => value.trim()).filter(Boolean);
if (!/^[A-Z0-9]{10}$/.test(team) || !fingerprints.length || fingerprints.some(value => !/^([A-F0-9]{2}:){31}[A-F0-9]{2}$/i.test(value))) {
  throw new Error('Provide a real BASQAR_APPLE_TEAM_ID and comma-separated BASQAR_ANDROID_SHA256 fingerprints from Play App Signing.');
}
const routes = JSON.parse(fs.readFileSync(path.join(mobile, 'link-paths.json'), 'utf8'));
const directory = path.join(mobile, 'generated', '.well-known');
fs.mkdirSync(directory, { recursive: true });
const save = (name, data) => fs.writeFileSync(path.join(directory, name), `${JSON.stringify(data, null, 2)}\n`);
save('apple-app-site-association', { applinks: { details: [{ appIDs: [`${team}.kz.bsqr.app`],
  components: routes.flatMap(route => [{ '/': `/${route}` }, { '/': `/${route}/*` }]) }] } });
save('assetlinks.json', [{ relation: ['delegate_permission/common.handle_all_urls'], target: {
  namespace: 'android_app', package_name: 'kz.bsqr.app', sha256_cert_fingerprints: fingerprints.map(value => value.toUpperCase()),
} }]);
console.log(`Prepared ${directory}. Serve both files as application/json over HTTPS without redirects; only then enable BASQAR_VERIFIED_LINKS=1 and rebuild.`);
