import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { parsePhoneListText } from "./services/phoneListService.ts";
import { parseContactImportText } from "./services/contactImportService.ts";
import { composeRecipientOffer, resolveRecipientSendText } from "./services/campaignPersonalize.ts";

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

  it("составляет разные предложения из задачи и интереса клиента", () => {
    const site = composeRecipientOffer({
      taskText: "Отправь КП всем этим клиентам",
      sharedDraft: "{{firstName}}, добрый день! Направляем коммерческое предложение.",
      firstName: "Алия",
      interest: "Корпоративный сайт",
    });
    const deck = composeRecipientOffer({
      taskText: "Отправь КП всем этим клиентам",
      sharedDraft: "{{firstName}}, добрый день! Направляем коммерческое предложение.",
      firstName: "Марат",
      interest: "Презентация для инвесторов",
    });
    assert.match(site, /Алия/);
    assert.match(site, /Корпоративный сайт/);
    assert.match(deck, /Марат/);
    assert.match(deck, /Презентация для инвесторов/);
    assert.notEqual(site, deck);
  });

  it("отправка берёт индивидуальный текст, если включена персонализация", () => {
    const text = resolveRecipientSendText({
      personalizeEach: true,
      recipientDraft: "Алия, добрый день! По вашему запросу «сайт» направляем КП.",
      campaignDraft: "{{firstName}}, добрый день! Общий текст.",
      firstName: "Алия",
    });
    assert.match(text, /сайт/);
    assert.doesNotMatch(text, /Общий текст/);
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

  it("personalize-recipients пишет разные тексты и prepare их показывает", async () => {
    const tenant = await prisma.tenant.findFirst({ where: { slug: "creolab" } });
    assert.ok(tenant);
    const site = await prisma.contact.create({
      data: {
        tenantId: tenant.id,
        name: "Алия Сайт",
        firstName: "Алия",
        companyName: "Site Co",
        methods: {
          create: {
            type: "phone",
            rawValue: "+7 701 111 00 21",
            normalizedValue: "77011110021",
            source: "manual",
            primary: true,
          },
        },
      },
    });
    await prisma.inquiry.create({
      data: {
        tenantId: tenant.id,
        contactId: site.id,
        source: "manual",
        status: "new",
        phoneRaw: "+7 701 111 00 21",
        phoneNormalized: "77011110021",
        phoneSource: "manual",
        subject: "Нужен корпоративный сайт",
        service: "Корпоративный сайт",
      },
    });
    const deck = await prisma.contact.create({
      data: {
        tenantId: tenant.id,
        name: "Марат Питч",
        firstName: "Марат",
        companyName: "Deck Lab",
        methods: {
          create: {
            type: "phone",
            rawValue: "+7 701 111 00 22",
            normalizedValue: "77011110022",
            source: "manual",
            primary: true,
          },
        },
      },
    });
    await prisma.inquiry.create({
      data: {
        tenantId: tenant.id,
        contactId: deck.id,
        source: "manual",
        status: "new",
        phoneRaw: "+7 701 111 00 22",
        phoneNormalized: "77011110022",
        phoneSource: "manual",
        subject: "Презентация для инвесторов",
        service: "Презентация",
      },
    });

    const create = await fetch(`${url}/api/v1/campaigns`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        title: "КП по заявкам",
        contactIds: [site.id, deck.id],
        rawCommandText: "Отправь КП этим клиентам",
        messageDraft: "{{firstName}}, добрый день! Направляем коммерческое предложение.",
        messageMode: "manual",
      }),
    });
    const createBody = await create.text();
    assert.equal(create.status, 201, createBody);
    const created = JSON.parse(createBody);
    const id = created.campaign.id;

    const personalize = await fetch(`${url}/api/v1/campaigns/${id}/personalize-recipients`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ useLlm: false }),
    });
    const personalizeBody = await personalize.text();
    assert.equal(personalize.status, 200, personalizeBody);
    const personalized = JSON.parse(personalizeBody);
    assert.equal(personalized.personalizeEach, true);
    const pending = (personalized.recipients || []).filter((row: { status: string }) => row.status === "pending");
    const siteRow = pending.find((row: { contactId: string }) => row.contactId === site.id);
    const deckRow = pending.find((row: { contactId: string }) => row.contactId === deck.id);
    assert.match(String(siteRow?.messageDraft || ""), /сайт/i);
    assert.match(String(deckRow?.messageDraft || ""), /презентац/i);
    assert.notEqual(siteRow?.messageDraft, deckRow?.messageDraft);

    const prepare = await fetch(`${url}/api/v1/campaigns/${id}/prepare`, {
      method: "POST",
      headers: { cookie },
    });
    const prepareBody = await prepare.text();
    assert.equal(prepare.status, 200, prepareBody);
    const preview = JSON.parse(prepareBody);
    assert.equal(preview.personalizeEach, true);
    const messages = (preview.recipientsPreview || []).map((row: { message?: string }) => String(row.message || ""));
    assert.ok(messages.some((text: string) => /сайт/i.test(text)));
    assert.ok(messages.some((text: string) => /презентац/i.test(text)));
  });
});
