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
});
