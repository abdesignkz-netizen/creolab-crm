import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { parsePhoneListText } from "./services/phoneListService.ts";
import { parseContactImportText } from "./services/contactImportService.ts";

describe("campaign mass send foundations", () => {
  it("парсит список номеров с разделителями и дублями", () => {
    const items = parsePhoneListText("+7 701 111 22 33\n87071112233; +7 701 111 22 33\n8701");
    assert.ok(items.some((i) => i.status === "ok_new" || i.status === "duplicate"));
    assert.ok(items.some((i) => i.status === "duplicate"));
    assert.ok(items.some((i) => i.status === "invalid"));
  });

  it("угадывает mapping CSV импорта", () => {
    const csv = "Имя,Телефон,Компания\nАлия,+77071112233,Creo\n";
    const parsed = parseContactImportText(csv);
    assert.ok(Object.values(parsed.mapping).includes("phone"));
    assert.ok(Object.values(parsed.mapping).includes("name"));
    assert.equal(parsed.rows[0]?.mapped.phone, "+77071112233");
  });

  it("персонализация не оставляет запятую без имени", () => {
    const template = "{{firstName}}, добрый день! КП во вложении.";
    const withName = template.replace(/\{\{\s*firstName\s*\}\}\s*,?\s*/gi, "Алия, ");
    const without = template.replace(/\{\{\s*firstName\s*\}\}\s*,?\s*/gi, "");
    assert.match(withName, /^Алия,/);
    assert.match(without, /^добрый день/i);
  });
});

describe("campaign API flow", () => {
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

  it("parse-phones → create → prepare → confirm snapshot", async () => {
    const parse = await fetch(`${url}/api/v1/campaigns/parse-phones`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ text: "+7 701 999 88 77\n87019998877\nbad" }),
    });
    assert.equal(parse.status, 200);
    const parsed = await parse.json();
    assert.ok(parsed.summary.valid >= 1);

    const create = await fetch(`${url}/api/v1/campaigns`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        title: "Тест рассылки",
        phoneListText: "+7 701 999 88 77",
        messageDraft: "{{firstName}}, добрый день! Тест.",
        messageMode: "manual",
        createMissingClients: true,
      }),
    });
    const createBody = await create.text();
    assert.equal(create.status, 201, createBody);
    const created = JSON.parse(createBody);
    const id = created.campaign.id;

    const prepare = await fetch(`${url}/api/v1/campaigns/${id}/prepare`, {
      method: "POST",
      headers: { cookie },
    });
    const prepareBody = await prepare.text();
    assert.equal(prepare.status, 200, prepareBody);
    const preview = JSON.parse(prepareBody);
    assert.ok(preview.recipients >= 1);
    assert.ok(String(preview.buttons?.confirm || "").includes(String(preview.recipients)));

    const confirm = await fetch(`${url}/api/v1/campaigns/${id}/confirm`, {
      method: "POST",
      headers: { cookie },
    });
    const confirmBody = await confirm.text();
    assert.equal(confirm.status, 200, confirmBody);
    const confirmed = JSON.parse(confirmBody);
    assert.ok(confirmed.campaign);
  });
});
