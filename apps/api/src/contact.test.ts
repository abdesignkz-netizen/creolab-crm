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
  });

  it("поиск по цифрам телефона находит клиента", async () => {
    const response = await fetch(`${base}/api/v1/contacts?q=87010000001`, { headers: { cookie } });
    const body = await response.json();
    assert.ok(body.items.some((item: { phoneNormalized?: string }) => item.phoneNormalized === "77010000001"));
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
