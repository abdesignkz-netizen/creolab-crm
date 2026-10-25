import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
const root = fileURLToPath(new URL('./', import.meta.url));
const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const resolve = { alias: { 'react-dom': dirname(webRequire.resolve('react-dom/package.json')), 'react': dirname(webRequire.resolve('react/package.json')) } };
await build({ root, configFile: false, resolve, plugins: [react()], build: { emptyOutDir: true } });
if (!process.argv.includes('--build-only')) {
  const server = await preview({ root, configFile: false, preview: { host: '127.0.0.1', port: 4509, strictPort: true, headers: {
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self' wss://127.0.0.1:13579; worker-src 'self' blob:; object-src 'self' blob:; frame-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff'
  } } });
  server.printUrls();
}
