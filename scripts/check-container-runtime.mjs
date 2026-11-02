import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const url = new URL(process.env.BASQAR_CONTAINER_POSTGRES_URL || "invalid:");
assert.ok(/^postgres(ql)?:$/.test(url.protocol) && ["127.0.0.1", "localhost"].includes(url.hostname)
  && url.pathname === "/basqar_runtime_acceptance" && !url.search && !url.hash, "Use the dedicated loopback container acceptance database");
const folder = mkdtempSync(join(tmpdir(), "basqar-container-"));
const envFile = join(folder, "runtime.env"), containers = [];
const id = randomBytes(5).toString("hex");
const env = {
  NODE_ENV: "production", DATABASE_URL: url.href, CRM_USE_PGLITE: "0", API_PORT: "4100",
  RENDER_GIT_COMMIT: process.env.GITHUB_SHA || "a".repeat(40),
  APP_BASE_URL: "https://acceptance.invalid", API_BASE_URL: "https://acceptance.invalid", ALLOWED_ORIGINS: "https://acceptance.invalid",
  STORAGE_DIR: "/tmp/basqar-acceptance-files", STORAGE_PERSISTENT: "1", WHATSAPP_QR_ENABLED: "0", CRM_INLINE_AUTOMATION: "0",
  ESF_PROVIDER: "mock", ESF_ENV: "off", ESF_ALLOW_LIVE_SEND: "0", BILLING_PROVIDER: "none",
  PLATFORM_ADMIN_EMAIL: "", PLATFORM_ADMIN_PASSWORD: "", OPENAI_API_KEY: "", ANYMODEL_API_KEY: "",
};
for (const name of ["SESSION_SECRET", "JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET", "ENCRYPTION_KEY"]) env[name] = randomBytes(32).toString("hex");
writeFileSync(envFile, Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n"), { mode: 0o600 });
function docker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout.trim();
}
function sql(input) {
  const result = spawnSync("psql", ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1"], { input, encoding: "utf8", timeout: 15000,
    env: { ...process.env, PGHOST: url.hostname, PGPORT: url.port || "5432", PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: url.pathname.slice(1) } });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout.trim();
}
function stopContainer(name) {
  docker(["stop", "--time", "30", name]);
  assert.equal(docker(["inspect", "--format", "{{.State.ExitCode}}", name]), "0", `${name} failed to drain cleanly`);
}
try {
  for (const role of ["api", "worker"]) {
    const name = `basqar-acceptance-${id}-${role}`;
    docker(["run", "-d", "--name", name, "--network", "host", "--env-file", envFile,
      ...(role === "worker" ? ["--entrypoint", "node"] : []), "basqar:acceptance",
      ...(role === "worker" ? ["--experimental-strip-types", "apps/worker/src/index.ts"] : [])]);
    containers.push(name);
  }
  let ready = false;
  for (let n = 0; n < 60; n++) {
    assert.ok(containers.every(name => docker(["inspect", "--format", "{{.State.Running}}", name]) === "true"), "API or worker exited during startup");
    try {
      const response = await fetch("http://127.0.0.1:4100/ready", { signal: AbortSignal.timeout(2000) });
      if (response.ok && (await response.json()).status === "ready") { ready = true; break; }
    } catch { /* startup in progress */ }
    await delay(1000);
  }
  assert.ok(ready, "API never became ready against real PostgreSQL");
  const health = await (await fetch("http://127.0.0.1:4100/health")).json(); assert.equal(health.status, "ok");
  assert.equal(health.revision, env.RENDER_GIT_COMMIT.toLowerCase());
  const page = await fetch("http://127.0.0.1:4100/login"); assert.equal(page.status, 200);
  assert.match(await page.text(), /\/assets\/[^"']+\.js/);
  await delay(5000);
  for (const name of containers) assert.equal(docker(["inspect", "--format", "{{.State.Running}}", name]), "true");
  assert.match(docker(["logs", containers[1]]), /CRM worker started/);
  // Stop the API so its inline polling cannot pass a broken worker's check.
  stopContainer(containers[0]); stopContainer(containers[1]);
  const tenantId = randomUUID(), eventId = randomUUID();
  sql(`INSERT INTO "Tenant" ("id", "name", "slug", "updatedAt") VALUES ('${tenantId}', 'Container acceptance', '${tenantId}', NOW());
    INSERT INTO "OutboxEvent" ("id", "tenantId", "type", "entityType", "entityId", "payloadJson")
    VALUES ('${eventId}', '${tenantId}', 'acceptance.invalid', 'tenant', '${tenantId}', '{}');`);
  docker(["start", containers[1]]);
  let handled = false;
  for (let n = 0; n < 60; n++) {
    assert.equal(docker(["inspect", "--format", "{{.State.Running}}", containers[1]]), "true");
    const state = sql(`SELECT "failureKind" || ':' || "errorCode" FROM "OutboxEvent" WHERE "id" = '${eventId}' AND "failedAt" IS NOT NULL;`);
    if (state === "permanent:unknown_event_type") { handled = true; break; }
    await delay(1000);
  }
  assert.ok(handled, "The standalone production worker did not process a durable queued event");
  assert.equal(sql(`SELECT "attempts" FROM "OutboxEvent" WHERE "id" = '${eventId}';`), "1");
  assert.equal(sql(`SELECT COUNT(*) FROM "Message" WHERE "tenantId" = '${tenantId}';`), "0");
  stopContainer(containers[1]); docker(["start", containers[1]]);
  await delay(6000);
  assert.equal(sql(`SELECT "attempts" FROM "OutboxEvent" WHERE "id" = '${eventId}';`), "1", "terminal job replayed after restart");
  stopContainer(containers[1]);
  console.log("Production image: exact revision, DB readiness, web assets, graceful API/worker stop, standalone durable queue and restart passed; no external delivery.");
} catch (error) {
  for (const name of containers) {
    const result = spawnSync("docker", ["logs", "--tail", "80", name], { encoding: "utf8" });
    console.error(result.stdout, result.stderr);
  }
  throw error;
} finally {
  for (const name of containers) spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  rmSync(folder, { recursive: true, force: true });
}
