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
    for (const item of [
      ...body.interventions,
      ...body.waitingForManager,
      ...body.aiConversations,
      ...body.humanConversations,
    ]) {
      assert.ok("phone" in item);
    }
    for (const item of body.pendingApprovals) {
      assert.ok("phone" in item);
    }
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

  it("includes contact phones on conversations and pending approvals", async () => {
    const tenant = await prisma.tenant.findFirst({ where: { slug: "creolab" } });
    assert.ok(tenant);
    const contact = await prisma.contact.create({
      data: {
        tenantId: tenant.id,
        name: "Без имени",
        methods: {
          create: {
            type: "phone",
            rawValue: "+7 700 099 07 87",
            normalizedValue: "77000990787",
            source: "whatsapp_seller",
            primary: true,
          },
        },
      },
    });
    const inquiry = await prisma.inquiry.create({
      data: {
        tenantId: tenant.id,
        source: "whatsapp",
        contactId: contact.id,
        phoneRaw: "+7 700 099 07 87",
        phoneNormalized: "77000990787",
        subject: "Диалог WhatsApp",
        status: "new",
      },
    });
    const conversation = await prisma.conversation.create({
      data: {
        tenantId: tenant.id,
        contactId: contact.id,
        mode: "ai",
        status: "open",
        sellerLeadId: "LEAD-mgmt-phone",
        externalThreadId: "77000990787",
      },
    });
    await prisma.task.create({
      data: {
        tenantId: tenant.id,
        type: "proposal",
        title: "Отправить КП",
        contactId: contact.id,
        inquiryId: inquiry.id,
        conversationId: conversation.id,
        status: "open",
        executionStatus: "awaiting_confirm",
        source: "test",
      },
    });

    const res = await fetch(`${base}/api/v1/management/overview`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    const card = [...body.aiConversations, ...body.waitingForManager, ...body.interventions].find(
      (item: { id: string }) => item.id === conversation.id,
    );
    assert.ok(card);
    assert.match(String(card.phone), /700 099 07 87/);
    const approval = body.pendingApprovals.find((item: { id: string; phone?: string }) => item.phone?.includes("700"));
    assert.ok(approval);
    assert.match(String(approval.phone), /700 099 07 87/);
  });
});
