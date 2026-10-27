import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import ts from "typescript";
const source = readFileSync(new URL("../apps/web/src/lib/messageAttempt.ts", import.meta.url), "utf8");
const context = { exports: {}, crypto: webcrypto, TextEncoder };
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
const { messageAttempt } = context.exports;
function memory() { const map = new Map(); return { map, getItem: key => map.get(key), setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) }; }
test("a retry after a lost response or page reload keeps the original delivery key", async () => {
  const store = memory(), first = await messageAttempt("user:conversation", ["Hello", [{ data: "bytes" }]], store);
  assert.equal((await messageAttempt("user:conversation", ["Hello", [{ data: "bytes" }]], store)).key, first.key);
  assert.ok(!JSON.stringify([...store.map]).includes("Hello")); assert.ok(!JSON.stringify([...store.map]).includes("bytes"));
});
test("different users, conversations, content and same-size file bytes have separate attempts", async () => {
  const store = memory(), first = await messageAttempt("u:c", ["Message", "aaaa"], store);
  for (const [scope, payload] of [["u:d", ["Message", "aaaa"]], ["v:c", ["Message", "aaaa"]], ["u:c", ["Message", "bbbb"]], ["u:c", ["Different", "aaaa"]]]) {
    assert.notEqual((await messageAttempt(scope, payload, store)).key, first.key);
  }
  assert.equal((await messageAttempt("u:c", ["Message", "aaaa"], store)).key, first.key);
});
test("confirmed success permits a later intentional identical message", async () => {
  const store = memory(), first = await messageAttempt("u:c", "Message", store); first.clear();
  assert.notEqual((await messageAttempt("u:c", "Message", store)).key, first.key);
});
test("disabled browser storage does not prevent preparing a message", async () => {
  const blocked = { getItem() { throw Error("Disabled"); }, setItem() { throw Error("Disabled"); }, removeItem() { throw Error("Disabled"); } };
  const attempt = await messageAttempt("u:c", "Message", blocked); assert.match(attempt.key, /^[0-9a-f-]{36}$/); attempt.clear();
});
