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

  it("просмотр диалога, где уже ответили, снимает внимание и цифру в меню", async () => {
    const contact = await prisma.contact.findFirst({ where: { name: { contains: "Александр" } } });
    assert.ok(contact);
    const conversation = await prisma.conversation.create({
      data: {
        tenantId: contact.tenantId,
        contactId: contact.id,
        mode: "human",
        status: "open",
        sellerLeadId: "LEAD-seen-attention",
        needsAttention: true,
        attentionReason: "taken_by_human",
      },
    });
    await prisma.message.create({
      data: {
        tenantId: contact.tenantId,
        conversationId: conversation.id,
        senderKind: "staff",
        direction: "outbound",
        text: "Добрый день! Уточните по оплате.",
      },
    });
    const leftover = await prisma.conversation.create({
      data: {
        tenantId: contact.tenantId,
        contactId: contact.id,
        mode: "ai",
        status: "open",
        attentionReason: "seller_lead_rematched",
        needsAttention: true,
      },
    });
    const beforeBadges = await fetch(`${base}/api/v1/nav-badges`, { headers: { cookie } });
    assert.equal(beforeBadges.status, 200);
    const beforeCount = Number(((await beforeBadges.json()) as { badges: Record<string, number> }).badges["/conversations"] || 0);
    assert.ok(beforeCount >= 1);

    const opened = await fetch(`${base}/api/v1/conversations/${conversation.id}`, { headers: { cookie } });
    assert.equal(opened.status, 200, await opened.text());

    const after = await prisma.conversation.findFirst({ where: { id: conversation.id } });
    const afterLeftover = await prisma.conversation.findFirst({ where: { id: leftover.id } });
    assert.equal(after?.needsAttention, false);
    assert.equal(afterLeftover?.needsAttention, false);

    const list = await fetch(`${base}/api/v1/conversations`, { headers: { cookie } });
    const listBody = await list.json();
    const row = listBody.items.find((item: { id: string }) => item.id === conversation.id);
    assert.equal(row?.unread, false);
    assert.equal(row?.urgent, false);
    assert.equal(row?.needsAttention, false);

    const afterBadges = await fetch(`${base}/api/v1/nav-badges`, { headers: { cookie } });
    const afterCount = Number(((await afterBadges.json()) as { badges: Record<string, number> }).badges["/conversations"] || 0);
    assert.ok(afterCount < beforeCount);
  });

  it("просмотр диалога, где клиент ждёт ответа, сразу снимает точку и цифру", async () => {
    const contact = await prisma.contact.findFirst({ where: { name: { contains: "Александр" } } });
    assert.ok(contact);
    const conversation = await prisma.conversation.create({
      data: {
        tenantId: contact.tenantId,
        contactId: contact.id,
        mode: "ai",
        status: "open",
        sellerLeadId: "LEAD-seen-waiting",
        needsAttention: true,
        attentionReason: "needs_reply",
      },
    });
    await prisma.message.create({
      data: {
        tenantId: contact.tenantId,
        conversationId: conversation.id,
        senderKind: "client",
        direction: "inbound",
        text: "Хочу обсудить разработку презентации",
        createdAt: new Date(Date.now() - 8 * 3600_000),
      },
    });
    const beforeBadges = await fetch(`${base}/api/v1/nav-badges`, { headers: { cookie } });
    const beforeCount = Number(((await beforeBadges.json()) as { badges: Record<string, number> }).badges["/conversations"] || 0);

    const opened = await fetch(`${base}/api/v1/conversations/${conversation.id}`, { headers: { cookie } });
    assert.equal(opened.status, 200, await opened.text());

    const after = await prisma.conversation.findFirst({ where: { id: conversation.id } });
    assert.equal(after?.needsAttention, false);

    const list = await fetch(`${base}/api/v1/conversations`, { headers: { cookie } });
    const row = ((await list.json()) as { items: Array<{ id: string; unread: boolean; urgent: boolean; needsAttention: boolean; needsReply: boolean }> }).items.find(
      (item) => item.id === conversation.id,
    );
    assert.equal(row?.unread, false);
    assert.equal(row?.urgent, false);
    assert.equal(row?.needsAttention, false);
    assert.equal(row?.needsReply, true);

    const afterBadges = await fetch(`${base}/api/v1/nav-badges`, { headers: { cookie } });
    const afterCount = Number(((await afterBadges.json()) as { badges: Record<string, number> }).badges["/conversations"] || 0);
    assert.ok(afterCount < beforeCount);
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

  it("контекст отмечает высланное КП и ожидание руководства клиента", async () => {
    const contact = await prisma.contact.findFirst({ where: { name: { contains: "Александр" } } });
    assert.ok(contact);
    const conversation = await prisma.conversation.create({
      data: {
        tenantId: contact.tenantId,
        contactId: contact.id,
        mode: "human",
        status: "open",
        attentionReason: "needs_reply",
      },
    });
    await prisma.message.create({
      data: {
        tenantId: contact.tenantId,
        conversationId: conversation.id,
        senderKind: "client",
        direction: "inbound",
        text: "Нужна презентация с нуля",
        createdAt: new Date("2026-09-16T00:58:00Z"),
      },
    });
    const offer = await prisma.message.create({
      data: {
        tenantId: contact.tenantId,
        conversationId: conversation.id,
        senderKind: "staff",
        direction: "outbound",
        type: "document",
        text: "КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ",
        createdAt: new Date("2026-09-16T11:00:00Z"),
      },
    });
    await prisma.attachment.create({
      data: {
        tenantId: contact.tenantId,
        parentType: "message",
        parentId: offer.id,
        messageId: offer.id,
        storageKey: `test/${offer.id}.pdf`,
        fileName: "КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ.pdf",
        originalFileName: "КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ.pdf",
        mimeType: "application/pdf",
        sizeBytes: 12,
        status: "stored",
      },
    });
    await prisma.message.create({
      data: {
        tenantId: contact.tenantId,
        conversationId: conversation.id,
        senderKind: "client",
        direction: "inbound",
        text: "Добрый день! Я направила руководству, они решают кого нанять",
        createdAt: new Date("2026-09-17T09:00:00Z"),
      },
    });
    await prisma.message.create({
      data: {
        tenantId: contact.tenantId,
        conversationId: conversation.id,
        senderKind: "staff",
        direction: "outbound",
        text: "Эльвира, добрый день! Хотели уточнить интересно ли наше предложение?",
        createdAt: new Date("2026-09-18T10:58:00Z"),
      },
    });

    const response = await fetch(`${base}/api/v1/conversations/${conversation.id}/analyze-context`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ useLlm: false }),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.match(String(body.analysis?.summaryUpdate || ""), /КП выслано/);
    assert.match(String(body.analysis?.summaryUpdate || ""), /руководства клиента/);
    assert.doesNotMatch(String(body.analysis?.summaryUpdate || ""), /Явных договорённостей пока нет/);
    assert.equal(body.analysis?.waitingFor, "CLIENT");
    assert.equal(body.analysis?.needsReply, false);

    const workspace = await fetch(`${base}/api/v1/conversations/${conversation.id}`, { headers: { cookie } });
    const after = await workspace.json();
    assert.match(String(after.conversation.contextSummary || ""), /КП выслано/);
    assert.match(String(after.conversation.contextSummary || ""), /руководства клиента/);
  });

  it("закрепляет выбранного менеджера в диалоге", async () => {
    const contact = await prisma.contact.findFirst({ where: { name: { contains: "Александр" } } });
    assert.ok(contact);
    const manager = await prisma.membership.findFirst({
      where: { tenantId: contact.tenantId, role: "manager", active: true },
    });
    assert.ok(manager);
    const conversation = await prisma.conversation.create({
      data: {
        tenantId: contact.tenantId,
        contactId: contact.id,
        mode: "human",
        status: "open",
        needsAttention: true,
        attentionReason: "needs_reply",
      },
    });
    const notice = await prisma.notification.create({
      data: {
        tenantId: contact.tenantId,
        episodeKey: `conversation.needs_human:${conversation.id}`,
        recipientMembershipId: manager.id,
        type: "conversation.needs_human",
        entityType: "conversation",
        entityId: conversation.id,
        title: "Нужен человек",
        body: "AI просит менеджера",
        priority: "high",
      },
    });
    const workspace = await fetch(`${base}/api/v1/conversations/${conversation.id}`, { headers: { cookie } });
    const before = await workspace.json();
    assert.equal(before.conversation.attentionReasonLabel, "Клиент написал, AI просит человека ответить");
    assert.equal(before.conversation.assigneeMembershipId, null);
    assert.equal(before.conversation.needsManagerAssign, true);

    const assigned = await fetch(`${base}/api/v1/conversations/${conversation.id}/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ membershipId: manager.id }),
    });
    const body = await assigned.json();
    assert.equal(assigned.status, 200, JSON.stringify(body));
    assert.equal(body.mode, "human");
    assert.equal(body.assigneeMembershipId, manager.id);

    const after = await prisma.conversation.findFirst({ where: { id: conversation.id } });
    assert.equal(after?.assigneeMembershipId, manager.id);
    assert.equal(after?.attentionReason, "taken_by_human");
    assert.equal(after?.needsAttention, false);

    const afterWorkspace = await fetch(`${base}/api/v1/conversations/${conversation.id}`, { headers: { cookie } });
    const afterBody = await afterWorkspace.json();
    assert.equal(afterBody.conversation.needsManagerAssign, false);
    assert.equal(afterBody.conversation.assigneeMembershipId, manager.id);

    const owner = await prisma.membership.findFirst({
      where: { tenantId: contact.tenantId, role: "owner", active: true },
    });
    const selfAssign = await fetch(`${base}/api/v1/conversations/${conversation.id}/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ membershipId: owner?.id }),
    });
    assert.equal(selfAssign.status, 200, await selfAssign.text());
    const leftover = await prisma.notification.findFirst({ where: { id: notice.id } });
    assert.ok(leftover?.readAt, "после закрепления за собой уведомление «нужен менеджер» должно стать прочитанным");
    const unreadSelf = await prisma.notification.count({
      where: {
        tenantId: contact.tenantId,
        entityId: conversation.id,
        type: "conversation.needs_human",
        recipientMembershipId: owner?.id,
        readAt: null,
      },
    });
    assert.equal(unreadSelf, 0);
  });

  it("отправляет фото в диалог и отдаёт его в переписке", async () => {
    const contact = await prisma.contact.findFirst({ where: { name: { contains: "Александр" } } });
    assert.ok(contact);
    const conversation = await prisma.conversation.create({
      data: {
        tenantId: contact.tenantId,
        contactId: contact.id,
        mode: "human",
        status: "open",
      },
    });
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const sent = await fetch(`${base}/api/v1/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie, "Idempotency-Key": "media-send-1" },
      body: JSON.stringify({
        text: "Смотрите фото",
        attachments: [{ fileName: "photo.png", mimeType: "image/png", contentBase64: png }],
      }),
    });
    const created = await sent.json();
    assert.equal(sent.status, 201, JSON.stringify(created));
    assert.equal(created.type, "image");
    assert.equal(created.attachments?.length, 1);

    const workspace = await fetch(`${base}/api/v1/conversations/${conversation.id}`, { headers: { cookie } });
    const body = await workspace.json();
    const message = (body.messages || []).find((item: { id: string }) => item.id === created.id);
    assert.ok(message);
    assert.equal(message.type, "image");
    assert.equal(message.text, "Смотрите фото");
    assert.equal(message.attachments[0].kind, "image");
    assert.match(message.attachments[0].url, /\/attachments\//);

    const file = await fetch(`${base}${message.attachments[0].url}`, { headers: { cookie } });
    assert.equal(file.status, 200);
    assert.match(file.headers.get("content-type") || "", /image\/png/);
    const bytes = Buffer.from(await file.arrayBuffer());
    assert.equal(bytes[0], 0x89);
    assert.equal(bytes[1], 0x50);

    const listed = await fetch(`${base}/api/v1/conversations`, { headers: { cookie } });
    const board = await listed.json();
    const item = board.items.find((row: { id: string }) => row.id === conversation.id);
    assert.equal(item.lastMessagePreview, "Смотрите фото");
  });
  it("каналы фильтруются совместно с поиском, сохраняя изоляцию компаний и историю отключённого канала", async () => {
    const source = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    const integration = await prisma.integration.create({ data: { tenantId: source.tenantId, type: "telegram", name: "Channel test" } });
    const connection = await prisma.channelConnection.create({ data: { tenantId: source.tenantId, integrationId: integration.id, channelType: "telegram", status: "disabled" } });
    const telegram = await prisma.conversation.create({ data: { tenantId: source.tenantId, contactId: source.contactId, connectionId: connection.id, mode: "human", status: "open" } });
    await prisma.message.create({ data: { tenantId: source.tenantId, conversationId: telegram.id, text: "unique-channel-search", senderKind: "client", direction: "inbound" } });
    const other = await prisma.tenant.create({ data: { name: "Other channel tenant", slug: "board-channel-isolation" } });
    const foreignIntegration = await prisma.integration.create({ data: { tenantId: other.id, type: "instagram", name: "Private connection" } });
    const foreignConnection = await prisma.channelConnection.create({ data: { tenantId: other.id, integrationId: foreignIntegration.id, channelType: "instagram", status: "active" } });
    const foreign = await prisma.conversation.create({ data: { tenantId: other.id, connectionId: foreignConnection.id, status: "open" } });
    const board = async (query: string) => (await fetch(`${base}/api/v1/conversations?${query}`, { headers: { cookie } })).json();
    const all = await board("channel=all");
    assert.ok(all.items.some((row: any) => row.id === telegram.id));
    assert.ok(all.items.some((row: any) => row.id === conversationId));
    assert.ok(!all.items.some((row: any) => row.id === foreign.id));
    assert.ok(all.availableChannels.includes("telegram"));
    assert.ok(!all.availableChannels.includes("instagram"));
    const filtered = await board("channel=telegram&filter=human&q=unique-channel-search");
    assert.deepEqual(filtered.items.map((row: any) => row.id), [telegram.id]);
    assert.equal(filtered.items[0].channelType, "telegram");
    assert.equal((await board("channel=whatsapp&q=unique-channel-search")).items.length, 0);
    assert.equal((await board("channel=instagram")).items.length, 0);
    assert.equal((await fetch(`${base}/api/v1/conversations?channel=unknown`, { headers: { cookie } })).status, 400);
  });

});
