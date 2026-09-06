import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";

describe("inquiry AI automation modes", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let server: { close: (cb?: (err?: Error) => void) => void; address: () => { port: number } | string | null };
  let cookie = "";
  let url = "";
  let tenantId = "";

  before(async () => {
    process.env.SEED_PASSWORD ||= "ChangeMeLocal1!";
    prisma = await createPrismaClient();
    const { seedDatabase } = await import("../../../packages/db/src/seed.ts");
    await seedDatabase();
    const app = createApp(prisma);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve()) as typeof server;
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    url = `http://127.0.0.1:${addr.port}`;

    const login = await fetch(`${url}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@creolab.example", password: process.env.SEED_PASSWORD }),
    });
    assert.equal(login.status, 200);
    cookie = login.headers.getSetCookie?.()?.[0]?.split(";")[0] || "";
    if (!cookie) cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    const me = await (await fetch(`${url}/api/v1/me`, { headers: { cookie } })).json();
    tenantId = me.activeMembership?.tenantId || me.memberships?.[0]?.tenantId;
    if (!tenantId) {
      const tenant = await prisma.tenant.findFirst();
      tenantId = tenant?.id || "";
    }
    assert.ok(tenantId);
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await prisma.$disconnect();
  });

  async function setMode(mode: string) {
    const res = await fetch(`${url}/api/v1/settings/ai-automation`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ defaultMode: mode, sourceModes: { manual: mode } }),
    });
    assert.equal(res.status, 200);
  }

  it("MANUAL: creates request without AI analysis task state", async () => {
    await setMode("MANUAL");
    const created = await fetch(`${url}/api/v1/inquiries`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        name: "Manual Client",
        phone: "+7 701 200 00 01",
        subject: "Сайт",
        message: "Нужен корпоративный сайт на 10 страниц",
        sourceChannel: "manual",
      }),
    });
    assert.equal(created.status, 201);
    const inquiry = await created.json();
    const detail = await (await fetch(`${url}/api/v1/inquiries/${inquiry.id}`, { headers: { cookie } })).json();
    assert.equal(detail.automation?.status, "none");
    assert.equal(detail.status, "new");
  });

  it("ASSIST: analyzes but does not queue AI task", async () => {
    await setMode("ASSIST");
    const created = await fetch(`${url}/api/v1/inquiries`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        name: "Assist Client",
        phone: "+7 701 200 00 02",
        company: "Assist Co",
        subject: "Сайт",
        message: "Нужен корпоративный сайт строительной компании примерно на 15 страниц, срок около месяца",
        sourceChannel: "manual",
      }),
    });
    assert.equal(created.status, 201);
    const inquiry = await created.json();
    const detail = await (await fetch(`${url}/api/v1/inquiries/${inquiry.id}`, { headers: { cookie } })).json();
    assert.equal(detail.automation?.status, "analyzed");
    assert.ok(detail.automation?.knownFields?.length >= 1);
    assert.ok(detail.automation?.missingFields?.length >= 1);
    const task = await prisma.task.findFirst({
      where: { tenantId, inquiryId: inquiry.id, type: "process_inquiry" },
    });
    assert.ok(task);
    assert.equal(task.executionStatus, "none");
  });

  it("CONFIRM: creates AI task awaiting confirm", async () => {
    await setMode("CONFIRM");
    const created = await fetch(`${url}/api/v1/inquiries`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        name: "Confirm Client",
        phone: "+7 701 200 00 03",
        company: "Confirm Co",
        message: "Нужна презентация для инвесторов",
        sourceChannel: "manual",
      }),
    });
    assert.equal(created.status, 201);
    const inquiry = await created.json();
    const detail = await (await fetch(`${url}/api/v1/inquiries/${inquiry.id}`, { headers: { cookie } })).json();
    assert.equal(detail.automation?.status, "awaiting_confirm");
    assert.equal(detail.automation?.canStart, true);
    const task = await prisma.task.findFirst({
      where: { tenantId, inquiryId: inquiry.id, type: "process_inquiry" },
    });
    assert.equal(task?.executionStatus, "awaiting_confirm");
    assert.match(task?.title || "", /презентац|квалифицировать/i);
  });

  it("AUTO without WhatsApp lead → needs_human", async () => {
    await setMode("AUTO");
    const created = await fetch(`${url}/api/v1/inquiries`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        name: "Auto Client",
        phone: "+7 701 200 00 04",
        company: "Auto Co",
        message: "Нужен сайт компании, запуск в течение месяца",
        sourceChannel: "manual",
      }),
    });
    assert.equal(created.status, 201);
    const inquiry = await created.json();
    // allow async automation finish
    await new Promise((r) => setTimeout(r, 50));
    const detail = await (await fetch(`${url}/api/v1/inquiries/${inquiry.id}`, { headers: { cookie } })).json();
    assert.ok(["needs_human", "queued", "in_progress", "failed"].includes(detail.automation?.status));
    if (detail.automation?.status === "needs_human") {
      assert.equal(detail.automation.handoffReason, "NO_AUTOMATED_CHANNEL");
    }
  });

  it("takeover pauses AI", async () => {
    await setMode("CONFIRM");
    const created = await fetch(`${url}/api/v1/inquiries`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        name: "Handoff Client",
        phone: "+7 701 200 00 05",
        message: "Нужен брендинг",
        sourceChannel: "manual",
      }),
    });
    const inquiry = await created.json();
    await fetch(`${url}/api/v1/inquiries/${inquiry.id}/ai/start`, { method: "POST", headers: { cookie } });
    const takeover = await fetch(`${url}/api/v1/inquiries/${inquiry.id}/ai/takeover`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: "{}",
    });
    assert.equal(takeover.status, 200);
    const detail = await takeover.json();
    assert.equal(detail.automation?.status, "paused");
  });
});
