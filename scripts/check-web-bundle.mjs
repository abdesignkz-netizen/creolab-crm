import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "apps/web/dist");
const manifest = JSON.parse(readFileSync(resolve(dist, ".vite/manifest.json"), "utf8"));
const entries = Object.keys(manifest).filter(key => manifest[key].isEntry);
assert.ok(entries.length, "No browser entry found in the Vite manifest");

// Count the complete initial JS graph, not just index.js: moving code into
// eagerly imported vendor chunks must not disguise a first-load regression.
const visited = new Set();
const files = new Set();
function visit(key) {
  if (visited.has(key)) return;
  visited.add(key);
  const chunk = manifest[key];
  assert.ok(chunk, `Missing manifest entry: ${key}`);
  if (chunk.file.endsWith(".js")) files.add(chunk.file);
  for (const dependency of chunk.imports || []) visit(dependency);
}
entries.forEach(visit);
let bytes = 0;
let gzipBytes = 0;
for (const file of files) {
  const source = readFileSync(resolve(dist, file));
  bytes += source.length;
  gzipBytes += gzipSync(source).length;
}
console.log(`Initial JavaScript: ${(bytes / 1000).toFixed(1)} kB; gzip ${(gzipBytes / 1000).toFixed(1)} kB (${files.size} files)`);
assert.ok(bytes <= 1_100_000, `Initial JS exceeds 1100 kB (${bytes} bytes). Check eager imports.`);
assert.ok(gzipBytes <= 285_000, `Initial gzip JS exceeds 285 kB (${gzipBytes} bytes). Check eager imports.`);
