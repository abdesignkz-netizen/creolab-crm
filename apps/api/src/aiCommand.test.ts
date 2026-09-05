import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";

describe("AI task commands", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let server: { close: () => void };
  let base = "";
  let cookie = "";
  let tenantId = "";

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
    const me = await fetch(`${base}/api/v1/me`, { headers: { cookie } });
    const profile = await me.json();
    tenantId = profile.activeTenant?.tenant?.id || profile.memberships?.[0]?.tenantId;
    if (!tenantId) {
      const tenant = await prisma.tenant.findFirst({ where: { slug: "creolab" } });
      tenantId = tenant?.id || "";
    }
    assert.ok(tenantId);
  });

  after(() => {
    server?.close();
  });

  it("парсит «Отправь КП вчерашним клиентам по презентациям» и делает реальный segment preview", async () => {
    const yesterday = new Date();
    yesterday.setHours(12, 0, 0, 0);
    yesterday.setDate(yesterday.getDate() - 1);

    const contact = await prisma.contact.create({
      data: {
        tenantId,
        name: "Презентация Вчера",
        firstName: "Презентация",
        lastName: "Вчера",
        lastContactAt: yesterday,
      },
    });
    await prisma.inquiry.create({
      data: {
        tenantId,
        contactId: contact.id,
        source: "manual",
        status: "new",
        phoneRaw: "+7 700 111 22 33",
        phoneNormalized: "77001112233",
        phoneSource: "manual",
        subject: "Нужна презентация для инвесторов",
        description: "Презентация pitch deck",
        serviceCategory: "PRESENTATION",
        receivedAt: yesterday,
      },
    });

    const res = await fetch(`${base}/api/v1/tasks/parse-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ text: "Отправь КП вчерашним клиентам по презентациям" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.command.taskType, "proposal");
    assert.equal(body.command.intent, "send_proposal");
    assert.equal(body.command.filters.datePreset, "yesterday");
    assert.ok(body.command.filters.serviceCategories?.includes("PRESENTATION"));
    assert.ok(typeof body.total === "number");
    assert.ok(body.total >= 1);
    assert.ok(Array.isArray(body.clients));
    assert.ok(body.clients.some((item: { id: string }) => item.id === contact.id));
    assert.equal(body.understanding.title, "CRM поняла задачу так");
  });

  it("ambiguous «Александр» при нескольких → needs_clarification", async () => {
    await prisma.contact.create({
      data: {
        tenantId,
        name: "Александр Иванов",
        firstName: "Александр",
        lastName: "Иванов",
      },
    });
    await prisma.contact.create({
      data: {
        tenantId,
        name: "Александр Петров",
        firstName: "Александр",
        lastName: "Петров",
      },
    });

    const res = await fetch(`${base}/api/v1/tasks/parse-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ text: "Напиши Александру и уточни по оплате" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "needs_clarification");
    assert.ok(body.clients.length > 1);
    assert.ok(
      (body.command.ambiguities || []).some(
        (item: string) => /александр/i.test(item) || /нескольк|выберите/i.test(item),
      ),
    );
  });

  it("parse ≠ execute: parse-command не создаёт задачи и не шлёт", async () => {
    const before = await prisma.task.count({ where: { tenantId, source: "ai_command" } });
    const res = await fetch(`${base}/api/v1/tasks/parse-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ text: "Отправь КП вчерашним клиентам по сайтам" }),
    });
    assert.equal(res.status, 200);
    const after = await prisma.task.count({ where: { tenantId, source: "ai_command" } });
    assert.equal(after, before);
  });

  it("prepare_only создаёт черновик и не вызывает отправку", async () => {
    const contact = await prisma.contact.findFirst({ where: { tenantId } });
    assert.ok(contact);

    const parsed = await fetch(`${base}/api/v1/tasks/parse-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ text: "Подготовь КП для клиента, не отправляй" }),
    });
    const parseBody = await parsed.json();

    const created = await fetch(`${base}/api/v1/tasks/from-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        text: "Подготовь КП для клиента, не отправляй",
        parsedCommand: {
          ...parseBody.command,
          taskType: "proposal",
          executionMode: "prepare_only",
          riskLevel: 1,
        },
        clientIds: [contact.id],
        messageDraft: "Черновик КП",
        executionMode: "prepare_only",
      }),
    });
    assert.equal(created.status, 201);
    const body = await created.json();
    assert.equal(body.executionMode, "prepare_only");
    assert.match(body.nextStep || "", /не выполняется/i);
    assert.equal(body.task.commandStatus, "prepared");
    assert.equal(body.task.source, "ai_command");
    assert.ok(body.task.messageDraft);

    const batch = await fetch(`${base}/api/v1/tasks/${body.task.id}/execute-batch`, {
      method: "POST",
      headers: { cookie },
    });
    // single-client tasks are not batchable; ensure no accidental send path
    assert.equal(batch.status, 422);
  });
});
