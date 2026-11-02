import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
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

for (const failure of [false, true]) {
  test(`supervisor waits for API drain beyond five seconds and propagates cleanup ${failure ? "failure" : "success"}`, { timeout: 15000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "basqar-supervisor-"));
    const ready = join(dir, "ready"), finished = join(dir, "finished");
    let stopping;
    try {
      const child = `
        const fs = require('node:fs');
        const interval = setInterval(() => {}, 1000);
        let closing = false;
        process.on('SIGTERM', () => {
          if (closing) return;
          closing = true;
          setTimeout(() => {
            fs.writeFileSync(process.env.ACCEPTANCE_FINISHED, 'drained');
            clearInterval(interval); process.exit(${failure ? 1 : 0});
          }, 5400);
        });
        fs.writeFileSync(process.env.ACCEPTANCE_READY, 'ready');
      `;
      stopping = startApi({ env: { ...process.env, KALKAN_LIB_DIR: dir, KALKAN_VERIFY_URL: "", ACCEPTANCE_READY: ready, ACCEPTANCE_FINISHED: finished },
        apiCommand: process.execPath, apiArgs: ["-e", child] });
      for (let n = 0; n < 100 && !(await access(ready).then(() => true, () => false)); n++) await delay(25);
      await access(ready);
      process.emit("SIGTERM"); process.emit("SIGINT");
      assert.equal(await stopping, failure ? 1 : 0);
      await access(finished);
    } finally {
      if (stopping) { process.emit("SIGTERM"); await stopping; }
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("embedded verifier remains available until the API finishes accepted work", { timeout: 15000 }, async () => {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const dir = await mkdtemp(join(tmpdir(), "basqar-sidecar-drain-"));
  const ready = join(dir, "ready"), verified = join(dir, "verified"), java = join(dir, "java-stub");
  let stopping;
  try {
    await writeFile(join(dir, "test-placeholder.jar"), "not an SDK");
    await writeFile(java, `#!${process.execPath}\n
      const server = require('node:http').createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({status:'ready', authorityCheckEnabled:true}));
      });
      server.listen(Number(process.env.KALKAN_VERIFY_PORT), '127.0.0.1');
      process.on('SIGTERM', () => server.close(() => process.exit(0)));
    `, { mode: 0o700 });
    const child = `
      const fs = require('node:fs');
      setInterval(() => {}, 1000);
      process.once('SIGTERM', async () => {
        await new Promise(resolve => setTimeout(resolve, 250));
        try {
          const reply = await fetch(process.env.KALKAN_VERIFY_URL + '/health', {signal: AbortSignal.timeout(2000)});
          if ((await reply.json()).status !== 'ready') process.exit(2);
          fs.writeFileSync(process.env.ACCEPTANCE_VERIFIED, 'available'); process.exit(0);
        } catch { process.exit(3); }
      });
      fs.writeFileSync(process.env.ACCEPTANCE_READY, 'ready');
    `;
    stopping = startApi({ env: { ...process.env, KALKAN_LIB_DIR: dir, KALKAN_VERIFY_URL: "", KALKAN_VERIFY_PORT: String(port), ACCEPTANCE_READY: ready, ACCEPTANCE_VERIFIED: verified },
      javaCommand: java, apiCommand: process.execPath, apiArgs: ["-e", child] });
    for (let n = 0; n < 200 && !(await access(ready).then(() => true, () => false)); n++) await delay(25);
    await access(ready); process.emit("SIGTERM");
    assert.equal(await stopping, 0); await access(verified);
  } finally {
    if (stopping) { process.emit("SIGTERM"); await stopping; }
    await rm(dir, { recursive: true, force: true });
  }
});
