import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";

describe("Management overview", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let base: string;
  let server: { close: () => void };
  let cookie = "";

  before(async () => {
    process.env.SEED_PASSWORD ||= "ChangeMeLocal1!";
    prisma = await createPrismaClient();
    const { seedDatabase } = await import("../../../packages/db/src/seed.ts");
    await seedDatabase();
    app = createApp(prisma);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const address = (server as { address: () => { port: number } }).address();
    base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "owner@creolab.example",
        password: process.env.SEED_PASSWORD,
        client: "web",
      }),
    });
    cookie = login.headers.get("set-cookie") || "";
  });

  after(() => {
    server?.close();
  });

  it("overview aggregates AI runtime state without breaking", async () => {
    const res = await fetch(`${base}/api/v1/management/overview`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.ai);
    assert.equal(typeof body.ai.aiControlled, "number");
    assert.equal(typeof body.ai.humanControlled, "number");
    assert.equal(typeof body.ai.paused, "boolean");
    assert.ok(Array.isArray(body.interventions));
    assert.ok(Array.isArray(body.pendingApprovals));
    assert.ok(Array.isArray(body.aiConversations));
    assert.ok(Array.isArray(body.humanConversations));
    assert.ok(Array.isArray(body.problems));
  });

  it("runtime pause does not change permanent AI settings", async () => {
    const beforeSettings = await fetch(`${base}/api/v1/settings/ai-automation`, { headers: { cookie } });
    const beforeBody = await beforeSettings.json();
    const pause = await fetch(`${base}/api/v1/management/ai-pause`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ paused: true }),
    });
    assert.equal(pause.status, 200);
    const paused = await pause.json();
    assert.equal(paused.paused, true);

    const afterSettings = await fetch(`${base}/api/v1/settings/ai-automation`, { headers: { cookie } });
    const afterBody = await afterSettings.json();
    assert.equal(afterBody.defaultMode, beforeBody.defaultMode);

    const overview = await (await fetch(`${base}/api/v1/management/overview`, { headers: { cookie } })).json();
    assert.equal(overview.ai.paused, true);

    const resume = await fetch(`${base}/api/v1/management/ai-pause`, {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ paused: false }),
    });
    assert.equal(resume.status, 200);
  });
});
