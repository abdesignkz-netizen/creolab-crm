import assert from "node:assert/strict";
import { test } from "node:test";
import { ciFailureAnnotations } from "./ci-error-annotation.mjs";

test("reports real TAP failures rather than expected errors from passing tests", () => {
  const annotations = ciFailureAnnotations([
    "# Error: expected refusal", "ok 1 - rejects unconfirmed send",
    "# Subtest: restart", "not ok 2 - restart", "  ---", "  error: 'expected 1, actual 2'", "  ...",
    "# Subtest: unrelated success", "ok 3 - unrelated success", "not ok 4 - access", "  error: 'expected refusal'", "  ...",
    "::error title=Previous annotation::do not nest me", "TAP version 13", "# Next suite booting",
    "Failed files:", "apps/api/src/restart.test.ts", "apps/api/src/access.test.ts",
  ].join("\n"));
  assert.match(annotations[0], /not ok 2 - restart/);
  assert.match(annotations[0], /expected 1, actual 2/);
  assert.doesNotMatch(annotations[0], /expected refusal|unrelated success/);
  assert.match(annotations[1], /not ok 4 - access/);
  assert.doesNotMatch(annotations[1], /Previous annotation|Next suite|TAP version/);
  assert.match(annotations.at(-1), /restart\.test\.ts%0Aapps\/api\/src\/access\.test\.ts/);
});

test("retains process startup errors when no TAP test could start", () => {
  const [annotation] = ciFailureAnnotations("startup\nError: Cannot find module fixture\n  at import\n", "Failed: api, module");
  assert.match(annotation, /title=Failed%3A api%2C module/);
  assert.match(annotation, /Error: Cannot find module fixture%0A  at import/);
});

test("bounds annotations and escapes workflow control characters", () => {
  const log = Array.from({ length: 12 }, (_, i) => `not ok ${i + 1} - failure\n  error: '100% failed'\n${"x".repeat(10000)}`).join("\n");
  const annotations = ciFailureAnnotations(log);
  assert.equal(annotations.length, 8);
  assert.ok(annotations.every(value => value.length < 6200 && !value.includes("\n")));
  assert.match(annotations[0], /100%25 failed/);
});
