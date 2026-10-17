import assert from "node:assert/strict";
import { it } from "node:test";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

it("the production worker boots with native Node, keeps polling and shuts down cleanly", { timeout: 30_000 }, async () => {
  assert.equal(process.env.CRM_USE_PGLITE, "1", "Use the isolated test runner");
  const child = spawn(process.execPath, ["--experimental-strip-types", "apps/worker/src/index.ts"], {
    env: {
      ...process.env, NODE_ENV: "production",
      SESSION_SECRET: randomBytes(32).toString("hex"),
      JWT_ACCESS_SECRET: randomBytes(32).toString("hex"),
      JWT_REFRESH_SECRET: randomBytes(32).toString("hex"),
      ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      APP_BASE_URL: "https://basqar.test.invalid", API_BASE_URL: "https://basqar.test.invalid",
      CRM_INLINE_AUTOMATION: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const closed = once(child, "close");
  try {
    for (let i = 0; i < 100 && !output.includes("CRM worker started.") && child.exitCode === null; i++) await delay(100);
    assert.match(output, /CRM worker started\./, output);
    await delay(5500); // At least one full background polling interval.
    assert.equal(child.exitCode, null, output);
    assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|Cannot find package|background:.*Error|uncaughtException/);
    child.kill("SIGTERM");
    const [code, signal] = await closed;
    assert.equal(code, 0, output);
    assert.equal(signal, null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
});
