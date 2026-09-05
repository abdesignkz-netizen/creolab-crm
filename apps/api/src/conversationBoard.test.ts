import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";

describe("Conversations board", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let server: { close: () => void };
  let base = "";
  let cookie = "";
  let conversationId = "";

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
    assert.ok(cookie);

    const contact = await prisma.contact.findFirst({ where: { name: { contains: "Александр" } } });
    assert.ok(contact);
    const conversation = await prisma.conversation.create({
      data: {
        tenantId: contact.tenantId,
        contactId: contact.id,
        mode: "ai",
        status: "open",
        sellerLeadId: "LEAD-board-test",
        needsAttention: true,
      },
    });
    conversationId = conversation.id;
    await prisma.message.create({
      data: {
        tenantId: contact.tenantId,
        conversationId,
        senderKind: "client",
        direction: "inbound",
        text: "Нужен корпоративный сайт, бюджет около 400 тысяч",
      },
    });
    await prisma.contact.update({
      where: { id: contact.id },
      data: { lastInboundMessageAt: new Date(), lastContactAt: new Date() },
    });
  });

  after(() => {
    server?.close();
  });

  it("список не показывает LEAD как заголовок и отдаёт бизнес-контекст", async () => {
    const response = await fetch(`${base}/api/v1/conversations`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(Array.isArray(body.items));
    const item = body.items.find((row: { id: string }) => row.id === conversationId);
    assert.ok(item);
    assert.notEqual(item.title, "LEAD-board-test");
    assert.ok(item.title.includes("Александр") || item.phone);
    assert.ok(item.lastMessagePreview.includes("сайт") || item.lastMessagePreview.includes("400"));
    assert.ok(item.sourceLine.includes("WhatsApp"));
    assert.ok("needsReply" in item);
    assert.ok("modeLabel" in item);
    assert.ok(item.topic);
  });

  it("workspace отдаёт переписку и контекст клиента без сырых LEAD в заголовке", async () => {
    const response = await fetch(`${base}/api/v1/conversations/${conversationId}`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.conversation);
    assert.ok(body.client);
    assert.notEqual(body.client.name, "LEAD-board-test");
    assert.ok(Array.isArray(body.messages));
    assert.ok(body.control);
    assert.ok(body.conversation.sourceLine.includes("WhatsApp"));
  });
});
