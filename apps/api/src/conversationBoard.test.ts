import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";

describe("Conversations board", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let server: { close: () => void };
  let base = "";
  let cookie = "";
  let conversationId = "";

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

    const contact = await prisma.contact.findFirst({ where: { name: { contains: "Александр" } } });
    assert.ok(contact);
    const conversation = await prisma.conversation.create({
      data: {
        tenantId: contact.tenantId,
        contactId: contact.id,
        mode: "ai",
        status: "open",
        sellerLeadId: "LEAD-board-test",
        needsAttention: true,
      },
    });
    conversationId = conversation.id;
    await prisma.message.create({
      data: {
        tenantId: contact.tenantId,
        conversationId,
        senderKind: "client",
        direction: "inbound",
        text: "Нужен корпоративный сайт, бюджет около 400 тысяч",
      },
    });
    await prisma.contact.update({
      where: { id: contact.id },
      data: { lastInboundMessageAt: new Date(), lastContactAt: new Date() },
    });
  });

  after(() => {
    server?.close();
  });

  it("список не показывает LEAD как заголовок и отдаёт бизнес-контекст", async () => {
    const response = await fetch(`${base}/api/v1/conversations`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(Array.isArray(body.items));
    const item = body.items.find((row: { id: string }) => row.id === conversationId);
    assert.ok(item);
    assert.notEqual(item.title, "LEAD-board-test");
    assert.ok(item.title.includes("Александр") || item.phone);
    assert.ok(item.lastMessagePreview.includes("сайт") || item.lastMessagePreview.includes("400"));
    assert.ok(item.sourceLine.includes("WhatsApp"));
    assert.ok("needsReply" in item);
    assert.ok("modeLabel" in item);
    assert.ok(item.topic);
  });

  it("пустой живой WhatsApp-чат показывает сообщения со старого диалога того же номера", async () => {
    const contact = await prisma.contact.findFirst({ where: { name: { contains: "Александр" } } });
    assert.ok(contact);
    const leftover = await prisma.conversation.create({
      data: {
        tenantId: contact.tenantId,
        contactId: contact.id,
        mode: "ai",
        status: "open",
        sellerLeadId: null,
        externalThreadId: "77000001122",
        attentionReason: "seller_lead_rematched",
      },
    });
    await prisma.message.create({
      data: {
        tenantId: contact.tenantId,
        conversationId: leftover.id,
        senderKind: "staff",
        direction: "outbound",
        text: "свяжемся с вами завтра",
      },
    });
    const live = await prisma.conversation.create({
      data: {
        tenantId: contact.tenantId,
        contactId: contact.id,
        mode: "human",
        status: "open",
        sellerLeadId: "LEAD-empty-live",
        externalThreadId: "77000001122",
        attentionReason: "human",
      },
    });

    const list = await fetch(`${base}/api/v1/conversations`, { headers: { cookie } });
    const listBody = await list.json();
    assert.ok(listBody.items.some((row: { id: string }) => row.id === live.id));
    assert.ok(!listBody.items.some((row: { id: string }) => row.id === leftover.id));
    const liveRow = listBody.items.find((row: { id: string }) => row.id === live.id);
    assert.match(liveRow.lastMessagePreview, /свяжемся с вами завтра/);

    const workspace = await fetch(`${base}/api/v1/conversations/${live.id}`, { headers: { cookie } });
    assert.equal(workspace.status, 200);
    const body = await workspace.json();
    assert.ok(body.messages.some((item: { text: string }) => item.text === "свяжемся с вами завтра"));
    assert.equal(await prisma.message.count({ where: { conversationId: live.id, text: "свяжемся с вами завтра" } }), 1);
  });

  it("workspace отдаёт переписку и контекст клиента без сырых LEAD в заголовке", async () => {
    const response = await fetch(`${base}/api/v1/conversations/${conversationId}`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.conversation);
    assert.ok(body.client);
    assert.notEqual(body.client.name, "LEAD-board-test");
    assert.ok(Array.isArray(body.messages));
    assert.ok(body.control);
    assert.ok(body.conversation.sourceLine.includes("WhatsApp"));
  });

  it("просмотр диалога снимает пометку «новое» с заявки и уведомления", async () => {
    const contact = await prisma.contact.findFirst({ where: { name: { contains: "Александр" } } });
    assert.ok(contact);
    const membership = await prisma.membership.findFirst({ where: { tenantId: contact.tenantId, active: true } });
    assert.ok(membership);
    const conversation = await prisma.conversation.create({
      data: {
        tenantId: contact.tenantId,
        contactId: contact.id,
        mode: "ai",
        status: "open",
        sellerLeadId: "LEAD-seen-new",
      },
    });
    const message = await prisma.message.create({
      data: {
        tenantId: contact.tenantId,
        conversationId: conversation.id,
        senderKind: "client",
        direction: "inbound",
        text: "Хочу обсудить разработку презентации",
      },
    });
    const inquiry = await prisma.inquiry.create({
      data: {
        tenantId: contact.tenantId,
        contactId: contact.id,
        conversationId: conversation.id,
        source: "whatsapp",
        status: "new",
        subject: "Заявка из WhatsApp",
        description: "Хочу обсудить разработку презентации",
      },
    });
    const notice = await prisma.notification.create({
      data: {
        tenantId: contact.tenantId,
        episodeKey: `inquiry.created:${inquiry.id}`,
        recipientMembershipId: membership.id,
        type: "inquiry.created",
        entityType: "inquiry",
        entityId: inquiry.id,
        title: "Новая заявка",
        body: "Хочу обсудить разработку презентации",
        priority: "normal",
      },
    });

    const before = await fetch(`${base}/api/v1/conversations`, { headers: { cookie } });
    const beforeBody = await before.json();
    const beforeRow = beforeBody.items.find((row: { id: string }) => row.id === conversation.id);
    assert.equal(beforeRow?.unread, true);
    assert.equal(beforeRow?.businessStatus, "Новая");

    const read = await fetch(`${base}/api/v1/conversations/${conversation.id}/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ messageId: message.id }),
    });
    assert.equal(read.status, 200, await read.text());

    const after = await fetch(`${base}/api/v1/conversations`, { headers: { cookie } });
    const afterBody = await after.json();
    const afterRow = afterBody.items.find((row: { id: string }) => row.id === conversation.id);
    assert.equal(afterRow?.unread, false);
    assert.equal(afterRow?.businessStatus, "В работе");

    const updatedInquiry = await prisma.inquiry.findFirst({ where: { id: inquiry.id } });
    assert.equal(updatedInquiry?.status, "in_progress");
    const updatedNotice = await prisma.notification.findFirst({ where: { id: notice.id } });
    assert.ok(updatedNotice?.readAt);
  });

  it("открытие диалога снимает «новое» с уведомления по старому id и заявке", async () => {
    const contact = await prisma.contact.findFirst({ where: { name: { contains: "Александр" } } });
    assert.ok(contact);
    const membership = await prisma.membership.findFirst({ where: { tenantId: contact.tenantId, active: true } });
    assert.ok(membership);
    const leftover = await prisma.conversation.create({
      data: {
        tenantId: contact.tenantId,
        contactId: contact.id,
        mode: "ai",
        status: "open",
        sellerLeadId: "LEAD-notice-old",
        attentionReason: "seller_lead_rematched",
      },
    });
    const live = await prisma.conversation.create({
      data: {
        tenantId: contact.tenantId,
        contactId: contact.id,
        mode: "human",
        status: "open",
        sellerLeadId: "LEAD-notice-live",
      },
    });
    const message = await prisma.message.create({
      data: {
        tenantId: contact.tenantId,
        conversationId: live.id,
        senderKind: "client",
        direction: "inbound",
        text: "Готовы обсудить презентацию",
      },
    });
    const inquiry = await prisma.inquiry.create({
      data: {
        tenantId: contact.tenantId,
        contactId: contact.id,
        conversationId: leftover.id,
        source: "whatsapp",
        status: "in_progress",
        subject: "Заявка из WhatsApp",
      },
    });
    const dialogNotice = await prisma.notification.create({
      data: {
        tenantId: contact.tenantId,
        episodeKey: `conversation.needs_human:${leftover.id}`,
        recipientMembershipId: membership.id,
        type: "conversation.needs_human",
        entityType: "conversation",
        entityId: leftover.id,
        title: "Диалог у менеджера",
        body: "Нужен ответ человеку",
        priority: "high",
      },
    });
    const inquiryNotice = await prisma.notification.create({
      data: {
        tenantId: contact.tenantId,
        episodeKey: `inquiry.created:${inquiry.id}`,
        recipientMembershipId: membership.id,
        type: "inquiry.created",
        entityType: "inquiry",
        entityId: inquiry.id,
        title: "Новая заявка",
        body: "Заявка из WhatsApp",
        priority: "normal",
      },
    });

    const listed = await fetch(`${base}/api/v1/notifications`, { headers: { cookie } });
    assert.equal(listed.status, 200);
    const listedBody = await listed.json();
    const listedInquiry = listedBody.items.find((row: { id: string }) => row.id === inquiryNotice.id);
    assert.ok(listedInquiry?.href === `/conversations/${leftover.id}` || listedInquiry?.href === `/requests/${inquiry.id}`);

    const opened = await fetch(`${base}/api/v1/conversations/${live.id}`, { headers: { cookie } });
    assert.equal(opened.status, 200, await opened.text());
    const read = await fetch(`${base}/api/v1/conversations/${live.id}/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ messageId: "missing-message" }),
    });
    assert.equal(read.status, 200, await read.text());

    const afterDialog = await prisma.notification.findFirst({ where: { id: dialogNotice.id } });
    const afterInquiry = await prisma.notification.findFirst({ where: { id: inquiryNotice.id } });
    assert.ok(afterDialog?.readAt, "уведомление по старому диалогу должно стать прочитанным");
    assert.ok(afterInquiry?.readAt, "уведомление по заявке диалога должно стать прочитанным");
    assert.ok(message.id);
  });

  it("кнопка понять контекст пишет краткое резюме по переписке", async () => {
    const response = await fetch(`${base}/api/v1/conversations/${conversationId}/analyze-context`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: "{}",
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.dryRun, false);
    assert.ok(body.analysis?.summaryUpdate);
    assert.match(body.analysis.summaryUpdate, /сайт|потребност/i);
    const workspace = await fetch(`${base}/api/v1/conversations/${conversationId}`, { headers: { cookie } });
    const after = await workspace.json();
    assert.ok(after.conversation.contextSummary);
    assert.match(after.conversation.contextSummary, /сайт|потребност/i);
  });
});
