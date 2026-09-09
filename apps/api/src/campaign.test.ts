import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { parsePhoneListText } from "./services/phoneListService.ts";
import { parseContactImportText } from "./services/contactImportService.ts";
import { composeRecipientOffer, firstNameOf, pickPersonFirstName, resolveRecipientSendText } from "./services/campaignPersonalize.ts";

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

  it("не копирует «Узнать актуальность заявки» и не подставляет ярлык «интерес»", () => {
    const unnamed = composeRecipientOffer({
      taskText: "Узнать актуальность заявки",
      sharedDraft: "Узнать актуальность заявки",
      firstName: "Без имени",
      interest: "интерес",
      companyName: "менеджер WhatsApp",
    });
    const named = composeRecipientOffer({
      taskText: "Узнать актуальность заявки",
      sharedDraft: "Узнать актуальность заявки",
      firstName: "Тест",
      interest: "ИИ-менеджер для WhatsApp",
    });
    const fromDescription = composeRecipientOffer({
      taskText: "Узнать актуальность заявки",
      firstName: "Aikeka",
      interest: "Нужен бот, который отвечает клиентам в WhatsApp",
    });
    assert.match(unnamed, /добрый день/i);
    assert.match(unnamed, /хотели узнать, актуальна ли ещё ваша заявка/i);
    assert.doesNotMatch(unnamed, /^Узнать актуальность/i);
    assert.doesNotMatch(unnamed, /«интерес»/i);
    assert.doesNotMatch(unnamed, /менеджер WhatsApp/i);
    assert.match(named, /^Тест,/);
    assert.match(named, /хотели узнать, актуальна ли ещё ваша заявка/i);
    assert.match(named, /ИИ-менеджер/i);
    assert.doesNotMatch(named, /^Узнать актуальность/i);
    assert.match(fromDescription, /Aikeka/);
    assert.match(fromDescription, /хотели узнать, актуальна ли ещё ваша заявка/i);
    assert.match(fromDescription, /бот|WhatsApp/i);
    assert.doesNotMatch(fromDescription, /^Узнать актуальность/i);
  });

  it("не копирует команду менеджера и ярлык WhatsApp в текст клиенту", () => {
    const unnamed = composeRecipientOffer({
      taskText: "Уточни актуальность заявки",
      sharedDraft: "Уточни актуальность заявки",
      firstName: "Без имени",
      interest: "Заявка из WhatsApp",
    });
    const named = composeRecipientOffer({
      taskText: "Уточни актуальность заявки",
      sharedDraft: "Уточни актуальность заявки",
      firstName: "Алия",
      interest: "Сайт",
    });
    assert.doesNotMatch(unnamed, /Уточни актуальность/i);
    assert.doesNotMatch(unnamed, /Заявка из WhatsApp/i);
    assert.doesNotMatch(unnamed, /^Без,/);
    assert.match(unnamed, /актуальн/i);
    assert.match(named, /Алия/);
    assert.match(named, /сайт/i);
    assert.notEqual(unnamed, named);
  });

  it("собирает текст из задачи, а не из шаблона «актуален ли запрос»", () => {
    const text = composeRecipientOffer({
      taskText: "Уточнить удобное время для созвона",
      sharedDraft: "Уточнить удобное время для созвона",
      firstName: "Тест",
      interest: "интересует ИИ-менеджер",
    });
    assert.match(text, /Тест/);
    assert.match(text, /созвон|время/i);
    assert.doesNotMatch(text, /актуален ли ещё запрос/i);
    assert.doesNotMatch(text, /^Уточнить удобное/i);
    assert.doesNotMatch(text, /^Интерес,/);
  });

  it("не берёт ярлык поля «Интерес» как имя", () => {
    assert.equal(firstNameOf("Интерес"), null);
    assert.equal(pickPersonFirstName("Интерес", "Тест"), "Тест");
    const text = composeRecipientOffer({
      taskText: "Уточнить удобное время для созвона",
      firstName: "Интерес",
      interest: "интересует ИИ",
    });
    assert.match(text, /^Добрый день!/);
    assert.doesNotMatch(text, /^Интерес,/);
  });

  it("свободная команда не подменяется шаблоном актуальности", () => {
    const text = composeRecipientOffer({
      taskText: "Попроси прислать реквизиты для счёта",
      firstName: "Марат",
      interest: "Презентация",
    });
    assert.match(text, /Марат/);
    assert.match(text, /реквизит|сч[её]т/i);
    assert.doesNotMatch(text, /актуальна ли ещё заявка|актуален ли ещё запрос|подскажем следующий шаг/i);

    const remind = composeRecipientOffer({
      taskText: "Напомни про согласование макета до пятницы",
      firstName: "Алия",
    });
    assert.match(remind, /макет|согласован/i);
    assert.doesNotMatch(remind, /актуальна ли ещё заявка/i);
  });

  it("составная команда берёт смысл вопроса, а не «позвони»", () => {
    const text = composeRecipientOffer({
      taskText: "Позвони клиенту и узнай, готов ли он к презентации",
      firstName: "Жаным",
      interest: "презентация для инвесторов",
    });
    assert.match(text, /готов/i);
    assert.match(text, /презентац/i);
    assert.doesNotMatch(text, /уточнить клиенту|узнай,/i);
    assert.doesNotMatch(text, /актуальна ли ещё ваша заявка/i);

    const callOnly = composeRecipientOffer({
      taskText: "Позвони клиенту",
      firstName: "Марат",
    });
    assert.match(callOnly, /созвон/i);
    assert.doesNotMatch(callOnly, /хотели позвонить/i);
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

  it("personalize из задачи про созвон не подменяет шаблоном актуальности", async () => {
    const tenant = await prisma.tenant.findFirst({ where: { slug: "creolab" } });
    assert.ok(tenant);
    const contact = await prisma.contact.create({
      data: {
        tenantId: tenant.id,
        name: "Тест",
        firstName: "Интерес",
        methods: {
          create: {
            type: "phone",
            rawValue: "+7 701 111 00 24",
            normalizedValue: "77011110024",
            source: "manual",
            primary: true,
          },
        },
      },
    });
    await prisma.inquiry.create({
      data: {
        tenantId: tenant.id,
        contactId: contact.id,
        source: "manual",
        status: "new",
        phoneRaw: "+7 701 111 00 24",
        phoneNormalized: "77011110024",
        phoneSource: "manual",
        subject: "интересует ИИ-менеджер",
        service: "ИИ",
      },
    });

    const create = await fetch(`${url}/api/v1/campaigns`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        title: "Созвон",
        contactIds: [contact.id],
        rawCommandText: "Уточнить удобное время для созвона",
        messageDraft: "Уточнить удобное время для созвона",
        messageMode: "ai",
        personalizeEach: true,
      }),
    });
    const createBody = await create.text();
    assert.equal(create.status, 201, createBody);
    const id = JSON.parse(createBody).campaign.id;

    const personalize = await fetch(`${url}/api/v1/campaigns/${id}/personalize-recipients`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ useLlm: false }),
    });
    const personalizeBody = await personalize.text();
    assert.equal(personalize.status, 200, personalizeBody);
    const draft = String(
      (JSON.parse(personalizeBody).recipients || []).find((row: { contactId: string }) => row.contactId === contact.id)
        ?.messageDraft || "",
    );
    assert.match(draft, /Тест/);
    assert.match(draft, /созвон|время/i);
    assert.doesNotMatch(draft, /актуален ли ещё запрос/i);
    assert.doesNotMatch(draft, /^Интерес,/);
  });

  it("personalize из «Узнать актуальность» берёт текст заявки, а не команду", async () => {
    const tenant = await prisma.tenant.findFirst({ where: { slug: "creolab" } });
    assert.ok(tenant);
    const contact = await prisma.contact.create({
      data: {
        tenantId: tenant.id,
        name: "Aikeka",
        firstName: "Aikeka",
        methods: {
          create: {
            type: "phone",
            rawValue: "+7 770 748 18 68",
            normalizedValue: "77707481868",
            source: "manual",
            primary: true,
          },
        },
      },
    });
    await prisma.inquiry.create({
      data: {
        tenantId: tenant.id,
        contactId: contact.id,
        source: "whatsapp",
        status: "new",
        phoneRaw: "+7 770 748 18 68",
        phoneNormalized: "77707481868",
        phoneSource: "whatsapp",
        subject: "Заявка из WhatsApp",
        description: "Здравствуйте\n\nНужен бот, который отвечает клиентам в WhatsApp",
      },
    });

    const create = await fetch(`${url}/api/v1/campaigns`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        title: "Актуальность",
        contactIds: [contact.id],
        rawCommandText: "Узнать актуальность заявки",
        messageDraft: "Узнать актуальность заявки",
        messageMode: "ai",
        personalizeEach: true,
      }),
    });
    const createBody = await create.text();
    assert.equal(create.status, 201, createBody);
    const id = JSON.parse(createBody).campaign.id;

    const personalize = await fetch(`${url}/api/v1/campaigns/${id}/personalize-recipients`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ useLlm: false }),
    });
    const personalizeBody = await personalize.text();
    assert.equal(personalize.status, 200, personalizeBody);
    const draft = String(
      (JSON.parse(personalizeBody).recipients || []).find((row: { contactId: string }) => row.contactId === contact.id)
        ?.messageDraft || "",
    );
    assert.match(draft, /Aikeka/);
    assert.match(draft, /хотели узнать, актуальна ли ещё ваша заявка/i);
    assert.match(draft, /бот|WhatsApp/i);
    assert.doesNotMatch(draft, /^Узнать актуальность/i);
    assert.doesNotMatch(draft, /«интерес»/i);
  });

  it("будущая дата ставит рассылку в очередь и не отправляет сразу", async () => {
    const due = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const create = await fetch(`${url}/api/v1/campaigns`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        title: "Плановая рассылка",
        phoneListText: "+7 701 999 00 31",
        messageDraft: "Добрый день! Плановая проверка.",
        messageMode: "manual",
        createMissingClients: true,
        scheduledAt: due,
      }),
    });
    const createBody = await create.text();
    assert.equal(create.status, 201, createBody);
    const id = JSON.parse(createBody).campaign.id as string;

    const prepare = await fetch(`${url}/api/v1/campaigns/${id}/prepare`, { method: "POST", headers: { cookie } });
    assert.equal(prepare.status, 200, await prepare.text());

    const confirm = await fetch(`${url}/api/v1/campaigns/${id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ scheduledAt: due }),
    });
    const confirmBody = await confirm.text();
    assert.equal(confirm.status, 200, confirmBody);
    const confirmed = JSON.parse(confirmBody);
    assert.equal(confirmed.campaign.status, "scheduled");

    const start = await fetch(`${url}/api/v1/campaigns/${id}/start`, { method: "POST", headers: { cookie } });
    assert.equal(start.status, 409);

    const { processCampaignQueue } = await import("./services/campaignService.ts");
    await processCampaignQueue(prisma, id);
    const campaign = await prisma.campaign.findUniqueOrThrow({
      where: { id },
      include: { recipients: true },
    });
    assert.equal(campaign.status, "scheduled");
    assert.equal(campaign.recipients.filter((row) => row.status === "sent").length, 0);
    const action = await prisma.scheduledAction.findFirst({
      where: { parentType: "campaign", parentId: id, type: "campaign_run", state: "scheduled" },
    });
    assert.ok(action);
    assert.equal(new Date(action.dueAt).getTime(), new Date(due).getTime());

    const task = await prisma.task.findFirst({
      where: { dedupeKey: `campaign:${id}` },
    });
    assert.ok(task);
    assert.equal(task.executionStatus, "scheduled");
    assert.equal(task.targetType, "group");
    assert.equal(new Date(task.dueAt || 0).getTime(), new Date(due).getTime());

    const tasks = await fetch(`${url}/api/v1/tasks`, { headers: { cookie } });
    assert.equal(tasks.status, 200);
    const listed = await tasks.json();
    const row = (listed.items || []).find((item: { id?: string; campaignId?: string; dedupeKey?: string }) =>
      item.campaignId === id || item.dedupeKey === `campaign:${id}` || item.id === `campaign:${id}`,
    );
    assert.ok(row);
    assert.equal(row.sendScheduled, true);
  });
});
