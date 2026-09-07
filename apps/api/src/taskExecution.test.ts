import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";

describe("Task execution", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let server: { close: () => void };
  let base = "";
  let cookie = "";
  let contactId = "";
  let conversationId = "";
  let inquiryId = "";
  let taskId = "";

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

    const contacts = await fetch(`${base}/api/v1/contacts?limit=5`, { headers: { cookie } });
    const board = await contacts.json();
    contactId = board.items?.[0]?.id;
    assert.ok(contactId);

    const overview = await fetch(`${base}/api/v1/contacts/${contactId}/overview`, { headers: { cookie } });
    const card = await overview.json();
    inquiryId = card.requests?.[0]?.id || card.currentRequest?.id;
    assert.ok(inquiryId);

    const contact = await prisma.contact.findFirst({ where: { id: contactId } });
    assert.ok(contact);
    const conversation = await prisma.conversation.create({
      data: {
        tenantId: contact.tenantId,
        contactId,
        mode: "human",
        status: "open",
        sellerLeadId: "test-lead-execution",
      },
    });
    conversationId = conversation.id;
  });

  after(() => {
    server?.close();
  });

  it("создаёт задачу, прикрепляет файл, готовит и подтверждает; правка инвалидирует confirm", async () => {
    const created = await fetch(`${base}/api/v1/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        type: "proposal",
        title: "Отправить КП — тест",
        targetType: "client",
        contactId,
        inquiryId,
        conversationId,
        priority: "normal",
      }),
    });
    assert.equal(created.status, 201);
    const task = await created.json();
    taskId = task.id;

    const draft = await fetch(`${base}/api/v1/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ messageDraft: "Александр, добрый день! Во вложении КП." }),
    });
    assert.equal(draft.status, 200);

    const pdf = Buffer.from("%PDF-1.4 test proposal").toString("base64");
    const attach = await fetch(`${base}/api/v1/tasks/${taskId}/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        fileName: "KP_CREOLAB.pdf",
        mimeType: "application/pdf",
        contentBase64: pdf,
        documentType: "proposal",
      }),
    });
    assert.equal(attach.status, 201);

    const prepare = await fetch(`${base}/api/v1/tasks/${taskId}/prepare-execution`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(prepare.status, 200);
    const preview = await prepare.json();
    assert.equal(preview.client.id, contactId);
    assert.ok(preview.message.includes("КП"));
    assert.equal(preview.attachments.length, 1);
    assert.equal(preview.buttons.confirm, "Подтвердить и отправить");
    assert.equal(preview.buttons.back, "Вернуться и изменить");

    const confirm = await fetch(`${base}/api/v1/tasks/${taskId}/confirm-execution`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(confirm.status, 200);
    const confirmed = await confirm.json();
    assert.ok(confirmed.confirmation?.id);

    const edit = await fetch(`${base}/api/v1/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ messageDraft: "Текст изменился" }),
    });
    assert.equal(edit.status, 200);

    const executeStale = await fetch(`${base}/api/v1/tasks/${taskId}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: "{}",
    });
    assert.equal(executeStale.status, 409);
    const staleBody = await executeStale.json();
    assert.equal(staleBody.code, "stale_confirmation");
  });

  it("ручное завершение звонка предлагает следующий шаг", async () => {
    const contact = await prisma.contact.findUniqueOrThrow({ where: { id: contactId } });
    const task = await prisma.task.create({ data: { tenantId: contact.tenantId, contactId, type: "call", title: "Ранее созданный звонок", targetType: "client" } });
    const done = await fetch(`${base}/api/v1/tasks/${task.id}/complete-result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ resultCode: "no_answer" }),
    });
    assert.equal(done.status, 200);
    const body = await done.json();
    assert.equal(body.task.status, "done");
    assert.ok(body.suggestedNextActions.some((item: { type: string }) => ["message", "follow_up"].includes(item.type)));
    assert.ok(body.suggestedNextActions.every((item: { type: string }) => item.type !== "call"), "disabled call types must not be offered");
  });

  it("готовит отправку, если у задачи устаревший диалог без sellerLead", async () => {
    const contact = await prisma.contact.findUniqueOrThrow({ where: { id: contactId } });
    const stale = await prisma.conversation.create({
      data: {
        tenantId: contact.tenantId,
        contactId,
        mode: "human",
        status: "open",
        sellerLeadId: null,
        attentionReason: "seller_lead_rematched",
      },
    });
    const task = await prisma.task.create({
      data: {
        tenantId: contact.tenantId,
        type: "message",
        title: "Отправить сообщение — stale dialog",
        targetType: "client",
        contactId,
        inquiryId,
        conversationId: stale.id,
        messageDraft: "Проверка отправки после rematch",
      },
    });
    const prepare = await fetch(`${base}/api/v1/tasks/${task.id}/prepare-execution`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(prepare.status, 200);
    const preview = await prepare.json();
    assert.equal(preview.conversationId, conversationId);
    assert.equal(preview.sellerLeadId, "test-lead-execution");
  });

  it("готовит отправку через WhatsApp-диалог контакта с тем же номером", async () => {
    const seed = await prisma.contact.findUniqueOrThrow({ where: { id: contactId } });
    const phone = "77008881234";
    const target = await prisma.contact.create({
      data: {
        tenantId: seed.tenantId,
        name: "Без имени",
        methods: {
          create: {
            type: "phone",
            rawValue: phone,
            normalizedValue: phone,
            source: "manual",
            primary: true,
          },
        },
      },
    });
    const sibling = await prisma.contact.create({
      data: {
        tenantId: seed.tenantId,
        name: "Тот же номер",
        methods: {
          create: {
            type: "phone",
            rawValue: phone,
            normalizedValue: phone,
            source: "whatsapp_seller",
            primary: true,
          },
        },
      },
    });
    const stale = await prisma.conversation.create({
      data: {
        tenantId: seed.tenantId,
        contactId: target.id,
        mode: "human",
        status: "open",
        sellerLeadId: null,
      },
    });
    await prisma.conversation.create({
      data: {
        tenantId: seed.tenantId,
        contactId: sibling.id,
        mode: "ai",
        status: "open",
        sellerLeadId: "sibling-lead-execution",
        externalThreadId: phone,
      },
    });
    const task = await prisma.task.create({
      data: {
        tenantId: seed.tenantId,
        type: "message",
        title: "Отправить сообщение — sibling",
        targetType: "client",
        contactId: target.id,
        conversationId: stale.id,
        messageDraft: "Проверка отправки по номеру",
      },
    });
    const prepare = await fetch(`${base}/api/v1/tasks/${task.id}/prepare-execution`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(prepare.status, 200);
    const preview = await prepare.json();
    assert.equal(preview.sellerLeadId, "sibling-lead-execution");
    assert.equal(preview.client.id, target.id);
  });
});
