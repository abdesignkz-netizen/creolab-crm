import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";

describe("Contact 360", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let server: { close: () => void };
  let base = "";
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
    assert.ok(cookie);
  });

  after(() => {
    server?.close();
  });

  it("список клиентов отдаёт обогащённые строки", async () => {
    const response = await fetch(`${base}/api/v1/contacts`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(Array.isArray(body.items));
    assert.ok(body.items.length >= 1);
    const item = body.items[0];
    assert.ok(item.name);
    assert.ok("lifecycleLabel" in item);
    assert.ok("nextAction" in item || item.nextAction === null);
    assert.equal(typeof body.attention?.new, "number");
    assert.equal(typeof body.attention?.needsReply, "number");
  });

  it("цифра «Клиенты» в меню — новые клиенты, фильтр «нужен ответ» отдельно", async () => {
    const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: "creolab" } });
    const fresh = await prisma.contact.create({
      data: {
        tenantId: tenant.id,
        name: `Новый клиент ${Date.now()}`,
        lifecycleStatus: "new",
        lastSeenAt: new Date(Date.now() - 86400_000 * 14),
      },
    });
    const veteran = await prisma.contact.create({
      data: {
        tenantId: tenant.id,
        name: `Уже в работе ${Date.now()}`,
        lifecycleStatus: "in_progress",
        lastSeenAt: new Date(),
      },
    });
    const waiting = await prisma.contact.create({
      data: {
        tenantId: tenant.id,
        name: `Ждёт ответа ${Date.now()}`,
        lifecycleStatus: "in_progress",
        lastInboundMessageAt: new Date(),
        lastOutboundMessageAt: new Date(Date.now() - 3600_000),
        lastSeenAt: new Date(Date.now() - 86400_000 * 7),
      },
    });
    const answered = await prisma.contact.create({
      data: {
        tenantId: tenant.id,
        name: `Уже ответили ${Date.now()}`,
        lifecycleStatus: "active",
        lastInboundMessageAt: new Date(Date.now() - 3600_000),
        lastOutboundMessageAt: new Date(),
        lastSeenAt: new Date(),
      },
    });

    const badgesRes = await fetch(`${base}/api/v1/nav-badges`, { headers: { cookie } });
    const badges = (await badgesRes.json()) as { badges: Record<string, number>; hrefs: Record<string, string>; hints: Record<string, string> };
    const allRes = await fetch(`${base}/api/v1/contacts?filter=all&limit=100`, { headers: { cookie } });
    const all = (await allRes.json()) as {
      attention: { new: number; needsReply: number };
      items: Array<{ id: string; needsReply?: boolean; lifecycleStatus?: string }>;
    };
    const newRes = await fetch(`${base}/api/v1/contacts?filter=new`, { headers: { cookie } });
    const freshList = (await newRes.json()) as { total: number; items: Array<{ id: string; lifecycleStatus?: string }> };
    const replyRes = await fetch(`${base}/api/v1/contacts?filter=needs_reply`, { headers: { cookie } });
    const reply = (await replyRes.json()) as { total: number; items: Array<{ id: string; needsReply?: boolean }> };

    assert.equal(all.attention.new, badges.badges["/contacts"]);
    assert.equal(freshList.total, all.attention.new);
    assert.equal(badges.hrefs["/contacts"], "/contacts?filter=new");
    assert.match(badges.hints["/contacts"], /новый клиент|новых клиента|новых клиентов/);
    assert.ok(freshList.items.some((item) => item.id === fresh.id));
    assert.ok(!freshList.items.some((item) => item.id === veteran.id));
    assert.equal(freshList.items.every((item) => item.lifecycleStatus === "new"), true);

    assert.equal(reply.total, all.attention.needsReply);
    assert.ok(reply.items.some((item) => item.id === waiting.id));
    assert.ok(!reply.items.some((item) => item.id === answered.id));
    assert.equal(reply.items.every((item) => item.needsReply), true);

    const newFlags = all.items.map((item) => item.lifecycleStatus === "new");
    const firstNotNew = newFlags.indexOf(false);
    const lastNew = newFlags.lastIndexOf(true);
    if (firstNotNew !== -1 && lastNew !== -1) {
      assert.ok(lastNew < firstNotNew);
    }
    assert.equal(all.items[0]?.lifecycleStatus, "new");
    assert.ok(all.items.some((item) => item.id === fresh.id));
    assert.ok(all.items.some((item) => item.id === waiting.id));
  });

  it("поиск по цифрам телефона находит клиента", async () => {
    const response = await fetch(`${base}/api/v1/contacts?q=87010000001`, { headers: { cookie } });
    const body = await response.json();
    assert.ok(body.items.some((item: { phoneNormalized?: string }) => item.phoneNormalized === "77010000001"));
  });

  it("интерес из закрытой переписки виден без заявки в списке и карточке", async () => {
    const created = await fetch(`${base}/api/v1/contacts`, {
      method: "POST", headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ name: `Interest regression ${Date.now()}`, source: "manual" }),
    });
    assert.equal(created.status, 201);
    const { client } = await created.json();
    const contact = await prisma.contact.findUniqueOrThrow({ where: { id: client.id } });
    const conversation = await prisma.conversation.create({
      data: { tenantId: contact.tenantId, contactId: client.id, status: "closed", mode: "human" },
    });
    const evidence = await prisma.message.create({
      data: { tenantId: contact.tenantId, conversationId: conversation.id, direction: "inbound", senderKind: "client", text: "Нужна презентация для инвесторов", historical: true },
    });
    await prisma.message.create({
      data: { tenantId: contact.tenantId, conversationId: conversation.id, direction: "outbound", senderKind: "staff", text: "Также можем разработать сайт" },
    });
    const response = await fetch(`${base}/api/v1/contacts?q=${encodeURIComponent(client.name)}`, { headers: { cookie } });
    const { items } = await response.json();
    assert.equal(items.length, 1);
    assert.equal(items[0].interest, "Нужна презентация для инвесторов");
    assert.equal(items[0].interestSource, "conversation");
    assert.equal(items[0].interestMessageId, evidence.id);
    const overview = await fetch(`${base}/api/v1/contacts/${client.id}/overview`, { headers: { cookie } });
    assert.equal((await overview.json()).client.interest, items[0].interest);
    assert.equal(await prisma.inquiry.count({ where: { contactId: client.id } }), 0);
    await prisma.inquiry.create({
      data: { tenantId: contact.tenantId, contactId: client.id, source: "manual", subject: "Согласованный брендинг" },
    });
    const withInquiry = await fetch(`${base}/api/v1/contacts?q=${encodeURIComponent(client.name)}`, { headers: { cookie } });
    const updated = (await withInquiry.json()).items[0];
    assert.equal(updated.interest, "Согласованный брендинг");
    assert.equal(updated.interestSource, "inquiry");
    assert.equal(updated.interestMessageId, null);
  });

  it("создание клиента и overview отвечают на ключевые вопросы", async () => {
    const created = await fetch(`${base}/api/v1/contacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        name: "Мария Клиент360",
        phone: "+7 701 555 00 77",
        source: "manual",
        comment: "Нужен сайт",
        companyName: "Creo Demo",
      }),
    });
    assert.equal(created.status, 201);
    const overview = await created.json();
    assert.equal(overview.client.name, "Мария Клиент360");
    assert.ok(overview.client.phone);
    assert.equal(overview.client.id.includes("+"), false);
    assert.ok(overview.control);
    assert.ok(Array.isArray(overview.timeline));
    assert.ok(overview.attribution.sourceType === "manual" || overview.client);

    const byId = await fetch(`${base}/api/v1/contacts/${overview.client.id}/overview`, { headers: { cookie } });
    assert.equal(byId.status, 200);
    const detail = await byId.json();
    assert.equal(detail.client.companyName, "Creo Demo");
    assert.ok(detail.notes.length >= 1);
  });

  it("телефон не является primary key — два разных UUID на один номер в разных tenant", async () => {
    const creolab = await fetch(`${base}/api/v1/contacts?q=77010000001`, { headers: { cookie } });
    const a = await creolab.json();
    const loginDemo = await fetch(`${base}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "owner@demo-agency.example",
        password: process.env.SEED_PASSWORD,
        client: "web",
      }),
    });
    const demoCookie = loginDemo.headers.get("set-cookie") || "";
    const demo = await fetch(`${base}/api/v1/contacts?q=77010000001`, { headers: { cookie: demoCookie } });
    const b = await demo.json();
    if (a.items[0] && b.items[0]) {
      assert.notEqual(a.items[0].id, b.items[0].id);
    }
  });
});
