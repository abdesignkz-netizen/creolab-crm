import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kalkanRuntime, startApi } from "./start-api-with-kalkan.mjs";

test("runtime preserves external verifier and requires jars for explicit local verifier", async () => {
  const dir = await mkdtemp(join(tmpdir(), "basqar-runtime-"));
  try {
    const remote = { KALKAN_VERIFY_URL: "https://verifier.example.test", KALKAN_LIB_DIR: dir };
    assert.deepEqual(await kalkanRuntime(remote), { embedded: false, env: remote });
    assert.equal((await kalkanRuntime({ KALKAN_LIB_DIR: dir })).embedded, false);
    await assert.rejects(kalkanRuntime({ KALKAN_LIB_DIR: dir, KALKAN_VERIFY_URL: "http://127.0.0.1:4170" }), /no SDK jars/);
    await writeFile(join(dir, "test-placeholder.jar"), "not an actual SDK");
    const local = await kalkanRuntime({ KALKAN_LIB_DIR: dir, KALKAN_VERIFY_SECRET: "test-only", KALKAN_VERIFY_PORT: "4171" });
    assert.equal(local.embedded, true);
    assert.equal(local.env.KALKAN_VERIFY_URL, "http://127.0.0.1:4171");
    assert.equal(local.env.KALKAN_OCSP, "1");
    assert.equal(local.env.KALKAN_VERIFY_SECRET, "test-only");
    await assert.rejects(kalkanRuntime({ KALKAN_VERIFY_PORT: "invalid" }), /Invalid/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("failed Java startup does not start the API or leave a supervisor running", async () => {
  const dir = await mkdtemp(join(tmpdir(), "basqar-runtime-"));
  try {
    await writeFile(join(dir, "test-placeholder.jar"), "not an actual SDK");
    const code = await startApi({ env: { ...process.env, KALKAN_LIB_DIR: dir, KALKAN_VERIFY_URL: "", KALKAN_VERIFY_PORT: "4179" },
      javaCommand: join(dir, "missing-java"), apiCommand: process.execPath, apiArgs: ["-e", "throw new Error('API must not start')"] });
    assert.equal(code, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
