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

  it("парсит «скажи что файл готов» как сообщение", async () => {
    const contact = await prisma.contact.create({
      data: {
        tenantId,
        name: "Файл Готов",
        firstName: "Файл",
        lastName: "Готов",
      },
    });
    const res = await fetch(`${base}/api/v1/tasks/parse-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ text: "скажи что файл готов", contactIds: [contact.id] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.command.taskType, "message");
    assert.equal(body.command.intent, "message");
    assert.ok(!body.command.ambiguities?.some((a: string) => /не удалось однозначно/i.test(a)));
    assert.match(String(body.suggestedDraft || ""), /файл готов/i);
  });

  it("parse-command составляет текст из сути задачи, а не шаблон «актуальна ли заявка»", async () => {
    const contact = await prisma.contact.create({
      data: {
        tenantId,
        name: "Айбек Созвон",
        firstName: "Айбек",
        lastName: "Созвон",
        companyName: "Nomad Steel",
      },
    });
    await prisma.inquiry.create({
      data: {
        tenantId,
        contactId: contact.id,
        source: "manual",
        status: "new",
        phoneRaw: "+7 700 222 33 44",
        phoneNormalized: "77002223344",
        phoneSource: "manual",
        subject: "ИИ-менеджер для WhatsApp",
        service: "ИИ-менеджер",
      },
    });
    const res = await fetch(`${base}/api/v1/tasks/parse-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ text: "Уточнить удобное время для созвона", contactIds: [contact.id] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.command.taskType, "message");
    assert.match(String(body.suggestedDraft || ""), /созвон|время/i);
    assert.match(String(body.suggestedDraft || ""), /Айбек/i);
    assert.doesNotMatch(String(body.suggestedDraft || ""), /актуальна ли ещё заявка/i);
    assert.doesNotMatch(String(body.suggestedDraft || ""), /^Уточнить удобное/i);
  });

  it("свободная команда без шаблонного глагола всё равно даёт текст клиенту по смыслу", async () => {
    const contact = await prisma.contact.create({
      data: {
        tenantId,
        name: "Марат Реквизиты",
        firstName: "Марат",
        lastName: "Реквизиты",
      },
    });
    const res = await fetch(`${base}/api/v1/tasks/parse-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ text: "Попроси прислать реквизиты для счёта", contactIds: [contact.id] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.command.taskType, "message");
    assert.match(String(body.suggestedDraft || ""), /реквизит|сч[её]т/i);
    assert.doesNotMatch(String(body.suggestedDraft || ""), /актуальна ли ещё заявка|подскажем следующий шаг/i);
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

  it("from-command сохраняет указанный срок", async () => {
    const contact = await prisma.contact.findFirst({ where: { tenantId } });
    assert.ok(contact);
    const dueAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const created = await fetch(`${base}/api/v1/tasks/from-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        text: "Уточни, актуальна ли заявка",
        parsedCommand: { taskType: "message", executionMode: "execute", riskLevel: 1 },
        clientIds: [contact.id],
        dueAt,
      }),
    });
    assert.equal(created.status, 201);
    const body = await created.json();
    assert.ok(body.task?.dueAt);
    assert.equal(new Date(body.task.dueAt).getTime(), new Date(dueAt).getTime());
  });

  it("будущий срок: подтверждение планирует и не отправляет", async () => {
    const contact = await prisma.contact.create({
      data: { tenantId, name: "Плановая Отправка", firstName: "Плановая", lastName: "Отправка" },
    });
    const conversation = await prisma.conversation.create({
      data: {
        tenantId,
        contactId: contact.id,
        mode: "human",
        status: "open",
        sellerLeadId: "test-lead-scheduled-task",
      },
    });
    const dueAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const created = await fetch(`${base}/api/v1/tasks/from-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        text: "Напиши и уточни по заявке",
        parsedCommand: { taskType: "message", executionMode: "execute", riskLevel: 3 },
        clientIds: [contact.id],
        messageDraft: "Добрый день! Уточняем по заявке.",
        dueAt,
      }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    const taskId = createdBody.task.id as string;
    const messagesBefore = await prisma.message.count({ where: { conversationId: conversation.id } });

    const prepare = await fetch(`${base}/api/v1/tasks/${taskId}/prepare-execution`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(prepare.status, 200);
    const preview = await prepare.json();
    assert.equal(preview.scheduled, true);
    assert.equal(preview.buttons.confirm, "Запланировать отправку");

    const confirm = await fetch(`${base}/api/v1/tasks/${taskId}/confirm-execution`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(confirm.status, 200);

    const execute = await fetch(`${base}/api/v1/tasks/${taskId}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: "{}",
    });
    assert.equal(execute.status, 200);
    const execBody = await execute.json();
    assert.equal(execBody.scheduled, true);
    assert.ok(execBody.scheduledActionId);
    assert.equal(execBody.success, false);

    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
    assert.equal(task.status, "open");
    assert.equal(task.executionStatus, "scheduled");
    assert.equal(task.sentAt, null);

    const action = await prisma.scheduledAction.findFirst({
      where: { parentType: "task", parentId: taskId, state: "scheduled", type: "task_run" },
    });
    assert.ok(action);
    assert.equal(new Date(action.dueAt).getTime(), new Date(dueAt).getTime());
    assert.equal(await prisma.message.count({ where: { conversationId: conversation.id } }), messagesBefore);

    const listed = await fetch(`${base}/api/v1/tasks/${taskId}`, { headers: { cookie } });
    const row = await listed.json();
    assert.equal(row.status, "open");
    assert.equal(row.sendScheduled, true);
  });

  it("правка запланированной задачи меняет текст и срок, но не отправляет", async () => {
    const contact = await prisma.contact.create({
      data: { tenantId, name: "Правка Расписания", firstName: "Правка", lastName: "Расписания" },
    });
    const conversation = await prisma.conversation.create({
      data: {
        tenantId,
        contactId: contact.id,
        mode: "human",
        status: "open",
        sellerLeadId: "test-lead-edit-scheduled-task",
      },
    });
    const dueAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const created = await fetch(`${base}/api/v1/tasks/from-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        text: "Напиши и уточни по заявке",
        parsedCommand: { taskType: "message", executionMode: "execute", riskLevel: 3 },
        clientIds: [contact.id],
        messageDraft: "Старый текст",
        dueAt,
      }),
    });
    assert.equal(created.status, 201);
    const taskId = (await created.json()).task.id as string;
    await fetch(`${base}/api/v1/tasks/${taskId}/prepare-execution`, { method: "POST", headers: { cookie } });
    await fetch(`${base}/api/v1/tasks/${taskId}/confirm-execution`, { method: "POST", headers: { cookie } });
    await fetch(`${base}/api/v1/tasks/${taskId}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: "{}",
    });
    const messagesBefore = await prisma.message.count({ where: { conversationId: conversation.id } });
    const nextDue = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString();
    const patched = await fetch(`${base}/api/v1/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ messageDraft: "Новый текст после правки", dueAt: nextDue }),
    });
    assert.equal(patched.status, 200);
    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
    assert.equal(task.messageDraft, "Новый текст после правки");
    assert.equal(new Date(task.dueAt!).getTime(), new Date(nextDue).getTime());
    assert.equal(task.status, "open");
    assert.equal(task.sentAt, null);
    const action = await prisma.scheduledAction.findFirst({
      where: { parentType: "task", parentId: taskId, state: "scheduled", type: "task_run" },
    });
    assert.ok(action);
    assert.equal(new Date(action.dueAt).getTime(), new Date(nextDue).getTime());
    const confirmation = await prisma.executionConfirmation.findFirst({
      where: { taskId, voidedAt: null },
    });
    assert.equal(confirmation?.messageSnapshot, "Новый текст после правки");
    assert.equal(await prisma.message.count({ where: { conversationId: conversation.id } }), messagesBefore);

    const past = await fetch(`${base}/api/v1/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ dueAt: new Date(Date.now() - 60_000).toISOString() }),
    });
    assert.equal(past.status, 422);
  });

  it("срок через полминуты не отправляет сразу", async () => {
    const contact = await prisma.contact.create({
      data: { tenantId, name: "Скорошная Отправка", firstName: "Скоро", lastName: "Отправка" },
    });
    const conversation = await prisma.conversation.create({
      data: {
        tenantId,
        contactId: contact.id,
        mode: "human",
        status: "open",
        sellerLeadId: "test-lead-soon-scheduled-task",
      },
    });
    const dueAt = new Date(Date.now() + 30_000).toISOString();
    const created = await fetch(`${base}/api/v1/tasks/from-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        text: "Напиши и уточни по заявке",
        parsedCommand: { taskType: "message", executionMode: "execute", riskLevel: 3 },
        clientIds: [contact.id],
        messageDraft: "Добрый день! Уточняем по заявке.",
        dueAt,
      }),
    });
    assert.equal(created.status, 201);
    const taskId = (await created.json()).task.id as string;
    const messagesBefore = await prisma.message.count({ where: { conversationId: conversation.id } });
    await fetch(`${base}/api/v1/tasks/${taskId}/prepare-execution`, { method: "POST", headers: { cookie } });
    await fetch(`${base}/api/v1/tasks/${taskId}/confirm-execution`, { method: "POST", headers: { cookie } });
    const execute = await fetch(`${base}/api/v1/tasks/${taskId}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: "{}",
    });
    assert.equal(execute.status, 200);
    const execBody = await execute.json();
    assert.equal(execBody.scheduled, true);
    assert.equal(execBody.success, false);
    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
    assert.equal(task.status, "open");
    assert.equal(task.sentAt, null);
    assert.equal(await prisma.message.count({ where: { conversationId: conversation.id } }), messagesBefore);
  });

  it("прошедший срок в команде не создаёт задачу", async () => {
    const contact = await prisma.contact.findFirst({ where: { tenantId } });
    assert.ok(contact);
    const created = await fetch(`${base}/api/v1/tasks/from-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        text: "Напиши клиенту",
        parsedCommand: { taskType: "message", executionMode: "execute", riskLevel: 3 },
        clientIds: [contact.id],
        dueAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    });
    assert.equal(created.status, 422);
  });

  it("from-command без черновика пишет про созвон, не про актуальность заявки", async () => {
    const contact = await prisma.contact.create({
      data: { tenantId, name: "Марат Время", firstName: "Марат", lastName: "Время" },
    });
    const created = await fetch(`${base}/api/v1/tasks/from-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        text: "Уточнить удобное время для созвона",
        parsedCommand: { taskType: "message", executionMode: "execute", riskLevel: 3 },
        clientIds: [contact.id],
      }),
    });
    assert.equal(created.status, 201);
    const body = await created.json();
    const draft = String(body.task?.messageDraft || body.messageDraft || "");
    assert.match(draft, /созвон|время/i);
    assert.doesNotMatch(draft, /актуальна ли ещё заявка|по нашему вопросу/i);
    assert.doesNotMatch(draft, /^Уточнить удобное/i);
  });

  it("from-command для группы пишет разный текст под имя клиента", async () => {
    const alia = await prisma.contact.create({
      data: { tenantId, name: "Алия Группа", firstName: "Алия", lastName: "Группа" },
    });
    const marat = await prisma.contact.create({
      data: { tenantId, name: "Марат Группа", firstName: "Марат", lastName: "Группа" },
    });
    const created = await fetch(`${base}/api/v1/tasks/from-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        text: "Уточни по оплате",
        parsedCommand: { taskType: "message", executionMode: "execute", riskLevel: 3 },
        clientIds: [alia.id, marat.id],
        messageDraft: "Уточни по оплате",
      }),
    });
    assert.equal(created.status, 201);
    const body = await created.json();
    const children = (body.task?.childTasks || []) as Array<{ contactId: string; messageDraft?: string | null }>;
    assert.equal(children.length, 2);
    const aliaDraft = String(children.find((row) => row.contactId === alia.id)?.messageDraft || "");
    const maratDraft = String(children.find((row) => row.contactId === marat.id)?.messageDraft || "");
    assert.match(aliaDraft, /Алия/);
    assert.match(maratDraft, /Марат/);
    assert.match(aliaDraft, /оплат/i);
    assert.match(maratDraft, /оплат/i);
    assert.doesNotMatch(aliaDraft, /Уточни по оплате/i);
    assert.notEqual(aliaDraft, maratDraft);
  });

  it("воркер не отправляет уже закрытую запланированную задачу", async () => {
    const task = await prisma.task.create({
      data: {
        tenantId,
        type: "message",
        title: "Закрытая плановая",
        status: "done",
        completedAt: new Date(),
      },
    });
    const action = await prisma.scheduledAction.create({
      data: {
        tenantId,
        type: "task_run",
        parentType: "task",
        parentId: task.id,
        dueAt: new Date(),
        state: "scheduled",
      },
    });
    const { processScheduledTask } = await import("./services/scheduledTaskRunner.ts");
    const result = await processScheduledTask(prisma, action);
    assert.equal(result.skipped, true);
    const updated = await prisma.scheduledAction.findUniqueOrThrow({ where: { id: action.id } });
    assert.equal(updated.state, "canceled");
  });

  it("просроченный срок при запланированной отправке не помечает задачу как просроченную", async () => {
    const contact = await prisma.contact.create({
      data: { tenantId, name: "План Просрочка", firstName: "План", lastName: "Просрочка" },
    });
    const dueAt = new Date(Date.now() - 60_000);
    const task = await prisma.task.create({
      data: {
        tenantId,
        type: "message",
        title: "Плановая просрочка",
        status: "open",
        dueAt,
        executionStatus: "scheduled",
        commandStatus: "scheduled",
        contactId: contact.id,
      },
    });
    await prisma.scheduledAction.create({
      data: {
        tenantId,
        type: "task_run",
        parentType: "task",
        parentId: task.id,
        dueAt,
        state: "scheduled",
      },
    });
    const listed = await fetch(`${base}/api/v1/tasks`, { headers: { cookie } });
    assert.equal(listed.status, 200);
    const body = await listed.json();
    const row = (body.items || []).find((item: { id: string }) => item.id === task.id);
    assert.ok(row);
    assert.equal(row.sendScheduled, true);
    assert.equal(row.overdue, false);
    await prisma.scheduledAction.updateMany({
      where: { parentType: "task", parentId: task.id, state: "scheduled" },
      data: { state: "canceled", cancelReason: "test_cleanup" },
    });
  });

  it("фоновые джобы не трогают отправку с будущим сроком", async () => {
    const task = await prisma.task.create({
      data: {
        tenantId,
        type: "message",
        title: "Будущая плановая",
        status: "open",
        dueAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
        executionStatus: "scheduled",
      },
    });
    const action = await prisma.scheduledAction.create({
      data: {
        tenantId,
        type: "task_run",
        parentType: "task",
        parentId: task.id,
        dueAt: task.dueAt!,
        state: "scheduled",
      },
    });
    const { processDueScheduledActions } = await import("./services/backgroundJobs.ts");
    await processDueScheduledActions(prisma);
    const updated = await prisma.scheduledAction.findUniqueOrThrow({ where: { id: action.id } });
    assert.equal(updated.state, "scheduled");
  });
});
