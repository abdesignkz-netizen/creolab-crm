import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
const source = readFileSync(new URL("../apps/web/src/lib/taskOrganization.ts", import.meta.url), "utf8");
const context = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
const { taskCategory, matchesTaskSearch } = context.exports;

test("work categories preserve meaning independently of who or when", () => {
  assert.equal(taskCategory({ type: "message", campaignId: "x", targetType: "group" }), "campaigns");
  assert.equal(taskCategory({ type: "message", parsedCommandJson: { campaignId: "legacy" } }), "campaigns");
  assert.equal(taskCategory({ type: "send_documents", contactId: "a" }), "documents");
  assert.equal(taskCategory({ type: "payment", targetType: "none" }), "payments");
  assert.equal(taskCategory({ type: "note", contactId: "a" }), "internal");
  assert.equal(taskCategory({ type: "message", source: "ai_automation" }), "clients");
  assert.equal(taskCategory({ type: "other" }), "internal");
  assert.equal(taskCategory({ type: "other", contactId: "a" }), "clients");
});

test("tasks can be found by phone despite display formatting, and by name plus action", () => {
  const item = { title: "Написать", whoName: "Алия", whoPhone: "+7 (701) 555-66-77" };
  for (const query of ["77015556677", "+7 701 555 66 77", "5556677", "Алия написать"]) {
    assert.equal(matchesTaskSearch(item, query, item.title, "Владелец"), true, query);
  }
  assert.equal(matchesTaskSearch(item, "Другой клиент", item.title, "Владелец"), false);
});
