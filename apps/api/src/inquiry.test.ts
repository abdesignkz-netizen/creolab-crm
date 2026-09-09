import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";

describe("inquiries overhaul", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let server: { close: (cb?: (err?: Error) => void) => void; address: () => { port: number } | string | null };
  let cookie = "";
  let url = "";

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
    if (!cookie) {
      const raw = login.headers.get("set-cookie") || "";
      cookie = raw.split(";")[0];
    }
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await prisma.$disconnect();
  });

  it("создаёт заявку, list DTO, take и convert сохраняет заявку", async () => {
    const created = await fetch(`${url}/api/v1/inquiries`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        name: "Александр Садыков",
        phone: "+7 701 123 45 67",
        subject: "Расчёт презентации",
        message: "Нужна инвестиционная презентация",
        serviceCategory: "presentation",
        sourceChannel: "manual",
      }),
    });
    assert.equal(created.status, 201);
    const inquiry = await created.json();
    assert.ok(inquiry.id);

    const listRes = await fetch(`${url}/api/v1/inquiries?filter=all`, { headers: { cookie } });
    assert.equal(listRes.status, 200);
    const list = await listRes.json();
    assert.ok(Array.isArray(list.items));
    assert.ok(list.counts);
    const row = list.items.find((item: { id: string }) => item.id === inquiry.id);
    assert.ok(row);
    assert.equal(row.statusLabel, "Новая");
    assert.ok(row.sourceLine);

    const takeRes = await fetch(`${url}/api/v1/inquiries/${inquiry.id}/take`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(takeRes.status, 200);
    const taken = await takeRes.json();
    assert.equal(taken.status, "in_progress");
    assert.equal(taken.statusLabel, "В работе");

    const detailRes = await fetch(`${url}/api/v1/inquiries/${inquiry.id}`, { headers: { cookie } });
    assert.equal(detailRes.status, 200);
    const detail = await detailRes.json();
    assert.ok(detail.qualification);
    assert.ok(Array.isArray(detail.timeline));

    const dealRes = await fetch(`${url}/api/v1/inquiries/${inquiry.id}/convert-to-deal`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ title: "Презентация" }),
    });
    assert.equal(dealRes.status, 200);

    const afterRes = await fetch(`${url}/api/v1/inquiries/${inquiry.id}`, { headers: { cookie } });
    const after = await afterRes.json();
    assert.equal(after.status, "converted");
    assert.equal(after.hasDeal, true);
  });

  it("lookup находит клиента по телефону", async () => {
    const lookup = await fetch(`${url}/api/v1/inquiries/lookup-contact`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ phone: "+7 701 123 45 67" }),
    });
    assert.equal(lookup.status, 200);
    const body = await lookup.json();
    assert.equal(body.found, true);
    assert.ok(body.contact?.id);
  });

  it("цифра в меню совпадает с «требуют внимания» и не зависит от периода", async () => {
    const created = await fetch(`${url}/api/v1/inquiries`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        name: "Старая заявка для бейджа",
        phone: "+7 701 555 11 22",
        subject: "Сайт",
        message: "Нужен сайт, заявка не за сегодня",
        serviceCategory: "web",
        sourceChannel: "manual",
      }),
    });
    assert.equal(created.status, 201);
    const inquiry = await created.json();
    const receivedAt = new Date(Date.now() - 12 * 24 * 60 * 60 * 1000);
    await prisma.inquiry.update({
      where: { id: inquiry.id },
      data: { receivedAt, status: "new", archived: false },
    });

    const todayRes = await fetch(`${url}/api/v1/inquiries?period=today`, { headers: { cookie } });
    assert.equal(todayRes.status, 200);
    const today = await todayRes.json();
    assert.ok(!today.items.some((item: { id: string }) => item.id === inquiry.id));
    assert.ok((today.counts.attention || 0) >= 1);

    const attentionRes = await fetch(`${url}/api/v1/inquiries?filter=attention&period=today`, { headers: { cookie } });
    assert.equal(attentionRes.status, 200);
    const attention = await attentionRes.json();
    assert.ok(attention.items.some((item: { id: string }) => item.id === inquiry.id));
    assert.equal(attention.counts.attention, today.counts.attention);

    const badgesRes = await fetch(`${url}/api/v1/nav-badges`, { headers: { cookie } });
    assert.equal(badgesRes.status, 200);
    const badges = await badgesRes.json();
    assert.equal(badges.badges["/inquiries"], today.counts.attention);
    assert.equal(badges.hrefs["/inquiries"], "/inquiries?filter=attention");
    assert.match(badges.hints["/inquiries"], /требуют внимания|требует внимания/);
  });

  it("будущая запланированная отправка не считается просроченной в бейдже задач", async () => {
    const meRes = await fetch(`${url}/api/v1/me`, { headers: { cookie } });
    const me = await meRes.json();
    const tenantId = me.activeTenant.tenant.id;
    const ownerMembershipId = me.activeTenant.membershipId;
    const { overdueTasksWhere } = await import("./services/attentionCounts.ts");
    const future = await prisma.task.create({
      data: {
        tenantId,
        ownerMembershipId,
        type: "message",
        title: "Запланированная отправка завтра",
        status: "open",
        dueAt: new Date(Date.now() + 60 * 60 * 1000),
        executionStatus: "scheduled",
        commandStatus: "scheduled",
        dedupeKey: `test-nav-scheduled-future-${Date.now()}`,
      },
    });
    try {
      const before = await prisma.task.count({ where: overdueTasksWhere(tenantId, new Date()) });
      const badges = await (await fetch(`${url}/api/v1/nav-badges`, { headers: { cookie } })).json();
      assert.equal(badges.badges["/tasks"], before);
    } finally {
      await prisma.task.delete({ where: { id: future.id } });
    }
  });

  it("наступивший срок запланированной отправки считается в бейдже задач", async () => {
    const meRes = await fetch(`${url}/api/v1/me`, { headers: { cookie } });
    const me = await meRes.json();
    const tenantId = me.activeTenant.tenant.id;
    const ownerMembershipId = me.activeTenant.membershipId;
    const { overdueTasksWhere } = await import("./services/attentionCounts.ts");
    const task = await prisma.task.create({
      data: {
        tenantId,
        ownerMembershipId,
        type: "message",
        title: "Запланированная отправка вчера",
        status: "open",
        dueAt: new Date(Date.now() - 60 * 60 * 1000),
        executionStatus: "scheduled",
        commandStatus: "scheduled",
        dedupeKey: `test-nav-scheduled-past-${Date.now()}`,
      },
    });
    try {
      const counted = await prisma.task.count({ where: overdueTasksWhere(tenantId, new Date()) });
      const badges = await (await fetch(`${url}/api/v1/nav-badges`, { headers: { cookie } })).json();
      assert.equal(badges.badges["/tasks"], counted);
      assert.ok(counted >= 1);
    } finally {
      await prisma.task.delete({ where: { id: task.id } });
    }
  });
});
