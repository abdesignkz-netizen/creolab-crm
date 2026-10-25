import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, beforeEach, after, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { authForUserInTenant } from "./services/authService.ts";
import { updateControlCompany, upsertControlAccess, executeWebControl, confirmWebControl, listControlHistory } from "./services/aiControlService.ts";
import { sendControlWebMessage, controlWebHistory } from "./services/controlWebService.ts";

describe("Control inside the platform", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let auth: Awaited<ReturnType<typeof authForUserInTenant>>, tenantId: string;
  const send = (text: string, requestId = randomUUID()) => sendControlWebMessage(prisma, auth, { text, requestId });
  const previousFetch = globalThis.fetch;
  before(async () => {
    prisma = await createPrismaClient(); const { seedDatabase } = await import("../../../packages/db/src/seed.ts"); await seedDatabase();
    const member = await prisma.membership.findFirstOrThrow({ where: { user: { email: "owner@creolab.example" } } });
    tenantId = member.tenantId; auth = await authForUserInTenant(prisma, member.userId, tenantId, "control-web-test");
    globalThis.fetch = async () => { throw new Error("No external services allowed"); };
  });
  beforeEach(async () => {
    await prisma.auditEvent.deleteMany({ where: { tenantId, action: "control.chat" } });
    await prisma.controlIdentity.deleteMany({ where: { tenantId, provider: "CRM_CHAT" } });
    await prisma.controlConfirmation.deleteMany({ where: { tenantId, source: "CRM_CHAT" } });
    await updateControlCompany(prisma, auth, { enabled: true });
    await upsertControlAccess(prisma, auth, auth.user.id, { enabled: true, allowedSources: ["CRM_CHAT"], canCreateTasks: true, canReadFinancialData: true, canReadTeamData: true, canModifyDeals: true, allowedActions: [] });
  });
  after(async () => { globalThis.fetch = previousFetch; await prisma.$disconnect(); });
  it("works without a WhatsApp identity or connected sender", async () => {
    const history = await send("Какие есть задачи на сегодня?");
    assert.equal(history.items.length, 1); assert.match(history.items[0].reply, /На сегодня осталось/);
    assert.equal(history.items[0].source, "CRM_CHAT");
  });
  it("returns the sales report directly and rechecks financial access", async () => {
    const history = await send("Что мешает завершить сделки?");
    assert.match(history.items.at(-1)!.reply, /Продажи под контролем/);
    assert.match(history.items.at(-1)!.reply, /Нужно участие/);
    assert.deepEqual(history.items.at(-1)!.actions, ["GET_SALES_CONTROL"]);
    const identity = await prisma.controlIdentity.findFirstOrThrow({ where: { tenantId, userId: auth.user.id, provider: "CRM_CHAT" } });
    await upsertControlAccess(prisma, auth, auth.user.id, { canReadFinancialData: false });
    await assert.rejects(executeWebControl(prisma, auth, identity.id, "GET_SALES_CONTROL", {}, randomUUID()), /Нет права на финансовые данные/);
    assert.equal((await controlWebHistory(prisma, auth)).items.length, 0);
  });
  it("limits a close-to-purchase request to matching deals", async () => {
    const stage = await prisma.dealStage.findFirstOrThrow({ where: { tenantId, isTerminal: false } });
    const contact = await prisma.contact.create({ data: { tenantId, name: "Sales filtering" } });
    const draft = await prisma.deal.create({ data: { tenantId, stageId: stage.id, contactId: contact.id, title: "Only a new inquiry", outcome: "open" } });
    const ready = await prisma.deal.create({ data: { tenantId, stageId: stage.id, contactId: contact.id, title: "Signed and awaiting payment", outcome: "open" } });
    await prisma.contract.create({ data: { tenantId, dealId: ready.id, number: randomUUID(), status: "SIGNED", amountWithoutVat: 1000, vatAmount: 0, totalAmount: 1000 } });
    const history = await send("Какие клиенты близки к покупке?");
    assert.match(history.items.at(-1)!.reply, /Близки к покупке/);
    const identity = await prisma.controlIdentity.findFirstOrThrow({ where: { tenantId, userId: auth.user.id, provider: "CRM_CHAT" } });
    const result = await executeWebControl(prisma, auth, identity.id, "GET_SALES_CONTROL", { filter: "ready" }, randomUUID()) as any;
    assert.ok(result.data.items.some((d: any) => d.id === ready.id));
    assert.ok(!result.data.items.some((d: any) => d.id === draft.id));
    assert.ok(result.data.items.every((d: any) => d.closeToSale));
  });
  it("previews, confirms once and persists task creation history", async () => {
    const title = `Web task ${randomUUID()}`, requestId = randomUUID();
    const history = await send(`Создай задачу ${title} завтра в 12:00`, requestId);
    assert.ok(history.pending); assert.equal(await prisma.task.count({ where: { tenantId, title } }), 0);
    const duplicate = await send(`Создай задачу ${title} завтра в 12:00`, requestId);
    assert.equal(duplicate.pending!.id, history.pending.id); assert.equal(duplicate.items.length, 1);
    const token = `Подтвердить ${history.pending.id.slice(-6)}`, confirmationRequestId = randomUUID();
    const done = await send(token, confirmationRequestId); assert.equal(done.pending, null); assert.match(done.items.at(-1)!.reply, /Готово/);
    await send(token, confirmationRequestId);
    assert.equal(await prisma.task.count({ where: { tenantId, title } }), 1);
    const task = await prisma.task.findFirstOrThrow({ where: { tenantId, title } });
    assert.equal(task.source, "control");
    assert.equal(await prisma.auditEvent.count({ where: { tenantId, action: "task.created", entityId: task.id, actorUserId: auth.user.id } }), 1);
    const audit = await listControlHistory(prisma, auth);
    assert.ok(audit.items.some(item => item.action === "CREATE_TASK" && item.status === "OK" && item.title === title && item.source === "CRM_CHAT"));
    assert.equal(audit.items.some(item => item.action === "CHAT"), false);
    await assert.rejects(send("Продажи", requestId), /другой команды/);
  });
  it("links a natural selected-client task and its timeline after confirmation", async () => {
    const contact = await prisma.contact.create({ data: { tenantId, name: "Selected client " + randomUUID() } });
    await send("Найди клиента " + contact.name);
    await send("1");
    const preview = await send("Создай задачу связаться с этим клиентом завтра в 11:00");
    assert.ok(preview.pending);
    assert.match(preview.items.at(-1)!.reply, new RegExp(contact.name!));
    const pending = await prisma.controlConfirmation.findUniqueOrThrow({ where: { id: preview.pending.id } });
    assert.equal((pending.paramsJson as any).clientId, contact.id);
    assert.equal(await prisma.task.count({ where: { tenantId, contactId: contact.id } }), 0);
    await send("Подтвердить " + preview.pending.id.slice(-6));
    const task = await prisma.task.findFirstOrThrow({ where: { tenantId, contactId: contact.id } });
    assert.equal(task.title, "связаться");
    assert.equal(task.source, "control");
    const activity = await prisma.activity.findFirstOrThrow({ where: { tenantId, contactId: contact.id, type: "task.created" } });
    assert.equal((activity.metadataJson as any).taskId, task.id);
    assert.equal(activity.actorId, auth.user.id);
  });
  it("asks for a client before previewing an explicit contextual task with no selection", async () => {
    const count = await prisma.task.count({ where: { tenantId } });
    const history = await send("Создай задачу связаться с этим клиентом завтра в 11:00");
    assert.equal(history.pending, null);
    assert.match(history.items.at(-1)!.reply, /Найди клиента/);
    assert.equal(await prisma.task.count({ where: { tenantId } }), count);
  });
  it("records linked tasks in the customer timeline, with the actual author", async () => {
    await send("Задачи");
    const identity = await prisma.controlIdentity.findFirstOrThrow({ where: { tenantId, userId: auth.user.id, provider: "CRM_CHAT" } });
    const contact = await prisma.contact.create({ data: { tenantId, name: "Control timeline" } });
    const preview = await executeWebControl(prisma, auth, identity.id, "CREATE_TASK", { title: "Связаться с клиентом", clientId: contact.id }, randomUUID()) as any;
    const done = await confirmWebControl(prisma, auth, preview.confirmationId) as any;
    const activities = await prisma.activity.findMany({ where: { tenantId, contactId: contact.id, type: "task.created" } });
    assert.equal(activities.length, 1); assert.equal(activities[0].actorId, auth.user.id); assert.equal((activities[0].metadataJson as any).taskId, done.data.id);
  });
  it("rechecks access when confirming and does not enable a new source implicitly", async () => {
    const title = `Denied ${randomUUID()}`, history = await send(`Создай задачу ${title}`);
    await upsertControlAccess(prisma, auth, auth.user.id, { canCreateTasks: false });
    const denied = await send(`Подтвердить ${history.pending!.id.slice(-6)}`);
    assert.match(denied.items.at(-1)!.reply, /Нет команды для подтверждения/);
    await assert.rejects(confirmWebControl(prisma, auth, history.pending!.id), /Нет права/);
    assert.equal(await prisma.task.count({ where: { tenantId, title } }), 0);
    await upsertControlAccess(prisma, auth, auth.user.id, { allowedSources: ["WHATSAPP"] });
    await assert.rejects(send("Задачи"), /Control в платформе/);
    await assert.rejects(controlWebHistory(prisma, auth), /Control в платформе/);
  });
  it("keeps each staff member's history and confirmations private", async () => {
    const title = `Private ${randomUUID()}`, own = await send(`Создай задачу ${title}`);
    const colleague = await prisma.membership.findFirstOrThrow({ where: { tenantId, active: true, userId: { not: auth.user.id } } });
    await upsertControlAccess(prisma, auth, colleague.userId, { enabled: true, allowedSources: ["CRM_CHAT"], canCreateTasks: true });
    const other = await authForUserInTenant(prisma, colleague.userId, tenantId, "control-colleague");
    assert.equal((await controlWebHistory(prisma, other)).items.length, 0);
    await sendControlWebMessage(prisma, other, { text: "Задачи", requestId: randomUUID() });
    await assert.rejects(confirmWebControl(prisma, other, own.pending!.id), /другому пользователю/);
    assert.equal(await prisma.task.count({ where: { tenantId, title } }), 0);
  });
  it("stops presenting interrupted requests as processing and never replays them", async () => {
    const requestId = randomUUID(), text = "Задачи";
    await send(text, requestId);
    const entry = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId, action: "control.chat", correlationId: requestId } });
    await prisma.auditEvent.update({ where: { id: entry.id }, data: { createdAt: new Date(Date.now() - 240000), changesJson: { ...(entry.changesJson as object), reply: "", state: "processing" } } });
    const history = await send(text, requestId);
    assert.equal(history.items[0].state, "interrupted");
    assert.match(history.items[0].reply, /историю/);
    assert.equal(await prisma.auditEvent.count({ where: { tenantId, action: "control.chat", correlationId: requestId } }), 1);
  });
  it("replaces a previous write preview without requiring Menu", async () => {
    const first = await send("Создай задачу первая встреча"), second = await send("Создай задачу вторая встреча");
    assert.notEqual(first.pending!.id, second.pending!.id);
    assert.equal((await prisma.controlConfirmation.findUniqueOrThrow({ where: { id: first.pending!.id } })).status, "canceled");
    const answer = await send("Покажи задачи на сегодня");
    assert.equal(answer.pending!.id, second.pending!.id);
    assert.match(answer.items.at(-1)!.reply, /На сегодня осталось/);
  });
});
