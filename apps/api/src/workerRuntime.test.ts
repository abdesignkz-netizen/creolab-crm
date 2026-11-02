import assert from "node:assert/strict";
import { it } from "node:test";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createPrismaClient, disconnectPrismaClient } from "@creolab/db";
import { assertTestDatabase } from "./testSupport/testDatabase.ts";
import { authForUserInTenant } from "./services/authService.ts";
import { previewActionPlan, confirmActionRun, processActionStep } from "./services/aiActionService.ts";

it("the production worker resumes a committed plan without duplicating its task and shuts down cleanly", { timeout: 45_000 }, async () => {
  assertTestDatabase();
  assert.equal(process.env.CRM_USE_PGLITE, "1", "Use the isolated test runner");
  const db = await createPrismaClient({ registerSignalHandlers: false });
  let runId = "", tenantId = "";
  try {
    const tenant = await db.tenant.create({ data: { name: "Worker acceptance", slug: randomUUID(), settingsJson: { control: { enabled: true } } } });
    tenantId = tenant.id;
    const user = await db.user.create({ data: { name: "Test owner", email: `${randomUUID()}@example.test`, passwordHash: "unused" } });
    await db.membership.create({ data: { tenantId, userId: user.id, role: "owner" } });
    await db.controlAccess.create({ data: { tenantId, userId: user.id, enabled: true, status: "active", allowedSources: ["CRM_CHAT"], canCreateTasks: true, canReadTeamData: true } });
    const auth = await authForUserInTenant(db, user.id, tenantId);
    const run = await previewActionPlan(db, auth, { requestId: randomUUID(), title: "Worker acceptance plan", steps: [
      { key: "create", kind: "task.create", type: "message", title: "Internal acceptance task" },
      { key: "draft", kind: "task.draft", target: { fromStep: "create" }, text: "Internal draft. Do not send." },
    ] });
    runId = run.id;
    await confirmActionRun(db, auth, runId, { requestId: randomUUID(), confirmed: true, planHash: run.planHash });
    await processActionStep(db, tenantId, runId);
    assert.equal(await db.task.count({ where: { tenantId } }), 1);
  } finally { await disconnectPrismaClient(); }
  const child = spawn(process.execPath, ["--experimental-strip-types", "apps/worker/src/index.ts"], {
    env: {
      ...process.env, NODE_ENV: "production",
      SESSION_SECRET: randomBytes(32).toString("hex"),
      JWT_ACCESS_SECRET: randomBytes(32).toString("hex"),
      JWT_REFRESH_SECRET: randomBytes(32).toString("hex"),
      ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      APP_BASE_URL: "https://basqar.test.invalid", API_BASE_URL: "https://basqar.test.invalid",
      ALLOWED_ORIGINS: "https://basqar.test.invalid",
      CRM_INLINE_AUTOMATION: "0", WHATSAPP_QR_ENABLED: "0",
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
    assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|Cannot find package|server_error|uncaughtException/);
    child.kill("SIGTERM");
    const [code, signal] = await closed;
    assert.equal(code, 0, output);
    assert.equal(signal, null);
    const reopened = await createPrismaClient({ registerSignalHandlers: false });
    try {
      const run = await reopened.actionRun.findUniqueOrThrow({ where: { id: runId }, include: { steps: true } });
      assert.equal(run.status, "succeeded"); assert.equal(run.steps.filter(s => s.status === "succeeded").length, 2);
      assert.equal(await reopened.task.count({ where: { tenantId } }), 1);
      assert.equal(await reopened.auditEvent.count({ where: { tenantId, action: "task.created" } }), 1);
      const task = await reopened.task.findFirstOrThrow({ where: { tenantId } });
      assert.equal(task.messageDraft, "Internal draft. Do not send."); assert.equal(task.sentAt, null);
      assert.ok((await reopened.outboxEvent.findUniqueOrThrow({ where: { id: run.outboxId! } })).processedAt);
      assert.equal(await reopened.message.count({ where: { tenantId } }), 0);
    } finally { await disconnectPrismaClient(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
});
