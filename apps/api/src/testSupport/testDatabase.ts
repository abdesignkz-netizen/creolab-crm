import assert from "node:assert/strict";

/** Destructive fixtures may only run against the isolated runner's database. */
export function assertTestDatabase() {
  assert.equal(process.env.NODE_ENV, "test");
  assert.ok(process.env.STORAGE_DIR);
  if (process.env.CRM_USE_PGLITE === "1") {
    assert.ok(process.env.CRM_PGLITE_DIR);
    return;
  }
  assert.equal(process.env.CRM_TEST_POSTGRES, "1", "Use scripts/test-api.mjs with isolated storage");
  const url = new URL(process.env.DATABASE_URL || "invalid:");
  assert.match(url.protocol, /^postgres(ql)?:$/);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /^\/basqar_test_[a-f0-9]{16}_\d+$/);
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
}
