import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { encryptSecret } from "./lib/secretBox.ts";

describe("Situation API", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let server: { close: () => void };
  let base = "";
  let cookie = "";
  let tenantId = "";

  async function situation(query = "") {
    const response = await fetch(`${base}/api/v1/situation${query}`, { headers: { cookie } });
    assert.equal(response.status, 200);
    return response.json() as Promise<{
      metrics: { now: number; blocked: number; needsHuman: number; overdue: number; mine: number };
      freshness: { warning: string | null; seller: { configured: boolean; reachable: boolean } };
      items: Array<{
        id: string;
        kind: string;
        entityId: string;
        blocked: boolean;
        nextAction: string;
        links: { taskId?: string };
      }>;
    }>;
  }

  async function resetDemo() {
    const tenant = await prisma.tenant.findFirst({ where: { slug: "demo-agency" } });
    assert.ok(tenant);
    tenantId = tenant.id;
    await prisma.situationSnooze.deleteMany({ where: { tenantId } });
    await prisma.message.deleteMany({ where: { tenantId } });
    await prisma.outboundOperation.deleteMany({ where: { tenantId } });
    await prisma.task.deleteMany({ where: { tenantId } });
    await prisma.inquiry.deleteMany({ where: { tenantId } });
    await prisma.incompleteIntake.deleteMany({ where: { tenantId } });
    await prisma.conversation.deleteMany({ where: { tenantId } });
    await prisma.notification.deleteMany({ where: { tenantId } });
    await prisma.channelConnection.deleteMany({ where: { tenantId, channelType: "whatsapp" } });
    await prisma.integration.deleteMany({ where: { tenantId, type: "whatsapp_seller" } });
  }

  before(async () => {
    process.env.SEED_PASSWORD ||= "ChangeMeLocal1!";
    prisma = await createPrismaClient();
    const { seedDatabase } = await import("../../../packages/db/src/seed.ts");
    await seedDatabase();
    await resetDemo();
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
        email: "owner@demo-agency.example",
        password: process.env.SEED_PASSWORD,
        client: "web",
      }),
    });
    cookie = login.headers.get("set-cookie") || "";
    assert.ok(cookie);
  });

  after(() => {
    server?.close();
  });

  it("заявка создаёт inquiry+task, situation возвращает 1 item", async () => {
    const created = await fetch(`${base}/api/v1/inquiries`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ name: "Ситуация", phone: "+77015550001", subject: "Одна строка" }),
    });
    assert.equal(created.status, 201);
    const inquiry = await created.json();
    const data = await situation();
    const rows = data.items.filter((item) => item.entityId === inquiry.id || item.links.taskId);
    const inquiryRows = data.items.filter((item) => item.kind.startsWith("inquiry_") && item.entityId === inquiry.id);
    const taskRows = data.items.filter((item) => item.kind.startsWith("task_") && item.links.taskId && inquiryRows[0]?.links.taskId === item.entityId);
    assert.equal(inquiryRows.length, 1);
    assert.equal(taskRows.length, 0);
    assert.ok(inquiryRows[0].links.taskId);
    assert.ok(rows.length >= 1);
  });

  it("intake без телефона — needs_phone, blocked, complete_phone", async () => {
    const intake = await prisma.incompleteIntake.create({
      data: {
        tenantId,
        inboundEventId: "sit-intake-1",
        reason: "missing_phone",
        rawFieldsJson: { contact: { name: "Без номера" } },
        status: "pending",
      },
    });
    const data = await situation();
    const row = data.items.find((item) => item.entityId === intake.id);
    assert.ok(row);
    assert.equal(row.kind, "needs_phone");
    assert.equal(row.blocked, true);
    assert.equal(row.nextAction, "complete_phone");
  });

  it("диалог ai без attention отсутствует", async () => {
    const conversation = await prisma.conversation.create({
      data: { tenantId, mode: "ai", status: "open", needsAttention: false },
    });
    const data = await situation();
    assert.equal(data.items.some((item) => item.entityId === conversation.id), false);
  });

  it("диалог human ранжируется выше новой заявки", async () => {
    const inquiry = await prisma.inquiry.findFirst({ where: { tenantId, status: "new" } });
    const conversation = await prisma.conversation.create({
      data: { tenantId, mode: "human", status: "open", needsAttention: true, attentionReason: "taken_by_human" },
    });
    const data = await situation();
    const human = data.items.findIndex((item) => item.entityId === conversation.id);
    const inquiryIdx = data.items.findIndex((item) => item.entityId === inquiry?.id);
    assert.ok(human >= 0);
    assert.ok(inquiryIdx >= 0);
    assert.ok(human < inquiryIdx);
  });

  it("без WhatsApp situation отдаёт заявки и нет warning про бота", async () => {
    const data = await situation();
    assert.equal(data.freshness.seller.configured, false);
    assert.equal(data.freshness.warning, null);
    assert.ok(data.items.some((item) => item.kind.startsWith("inquiry_")));
  });

  it("бот настроен и unreachable — warning есть, заявки на месте", async () => {
    await prisma.integration.create({
      data: {
        tenantId,
        type: "whatsapp_seller",
        name: "dead-bot",
        status: "error",
        schemaJson: {
          sellerUrl: "http://127.0.0.1:1",
          secretEnc: encryptSecret("test-secret"),
          sendOwner: "external_bot",
        },
      },
    });
    const data = await situation();
    assert.equal(data.freshness.seller.configured, true);
    assert.equal(data.freshness.seller.reachable, false);
    assert.match(data.freshness.warning || "", /бот/i);
    assert.ok(data.items.some((item) => item.kind.startsWith("inquiry_")));
  });

  it("2 human + 1 overdue + 1 intake → честные метрики", async () => {
    await resetDemo();
    await prisma.incompleteIntake.create({
      data: { tenantId, inboundEventId: "m-intake", reason: "missing_phone", status: "pending", rawFieldsJson: {} },
    });
    await prisma.conversation.create({ data: { tenantId, mode: "human", status: "open", needsAttention: true } });
    await prisma.conversation.create({ data: { tenantId, mode: "human", status: "open", needsAttention: true } });
    await prisma.task.create({
      data: {
        tenantId,
        type: "call",
        title: "Просроченный звонок",
        status: "open",
        dueAt: new Date(Date.now() - 3600_000),
      },
    });
    const data = await situation();
    assert.equal(data.metrics.now, 4);
    assert.equal(data.metrics.needsHuman, 2);
    assert.equal(data.metrics.overdue, 1);
    assert.equal(data.metrics.blocked, 1);
    assert.equal(data.metrics.now, data.items.length);
  });

  it("задача без срока и не high не в situation, видна в /tasks", async () => {
    const task = await prisma.task.create({
      data: { tenantId, type: "other", title: "Тихая задача", status: "open", priority: "normal" },
    });
    const data = await situation();
    assert.equal(data.items.some((item) => item.entityId === task.id), false);
    const list = await fetch(`${base}/api/v1/tasks`, { headers: { cookie } });
    const body = await list.json();
    assert.ok(body.items.some((item: { id: string }) => item.id === task.id));
  });

  it("просроченная waiting снова в situation", async () => {
    const task = await prisma.task.create({
      data: {
        tenantId,
        type: "call",
        title: "Жду оплаты",
        status: "waiting",
        dueAt: new Date(Date.now() - 7200_000),
      },
    });
    const data = await situation();
    const row = data.items.find((item) => item.entityId === task.id);
    assert.ok(row);
    assert.equal(row.kind, "task_overdue");
  });

  it("done process_inquiry при status=new → 422", async () => {
    const created = await fetch(`${base}/api/v1/inquiries`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ name: "Закрыть нельзя", phone: "+77015550002", subject: "Ещё new" }),
    });
    const inquiry = await created.json();
    const task = await prisma.task.findFirst({
      where: { tenantId, dedupeKey: `inquiry-process:${inquiry.id}` },
    });
    assert.ok(task);
    const done = await fetch(`${base}/api/v1/tasks/${task.id}/complete`, { method: "POST", headers: { cookie } });
    assert.equal(done.status, 422);
  });

  it("take дважды не поднимает controlVersion", async () => {
    const conversation = await prisma.conversation.create({
      data: { tenantId, mode: "ai", status: "open", needsAttention: true, attentionReason: "escalate" },
    });
    const first = await fetch(`${base}/api/v1/conversations/${conversation.id}/take`, { method: "POST", headers: { cookie } });
    const second = await fetch(`${base}/api/v1/conversations/${conversation.id}/take`, { method: "POST", headers: { cookie } });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const a = await first.json();
    const b = await second.json();
    assert.equal(a.controlVersion, b.controlVersion);
  });

  it("бот down: take пишет CRM и appliedOnSeller=false", async () => {
    await prisma.integration.deleteMany({ where: { tenantId, type: "whatsapp_seller" } });
    await prisma.integration.create({
      data: {
        tenantId,
        type: "whatsapp_seller",
        name: "dead-bot-take",
        status: "error",
        schemaJson: {
          sellerUrl: "http://127.0.0.1:1",
          secretEnc: encryptSecret("test-secret"),
          sendOwner: "external_bot",
        },
      },
    });
    const conversation = await prisma.conversation.create({
      data: {
        tenantId,
        mode: "ai",
        status: "open",
        needsAttention: true,
        sellerLeadId: "lead-dead-1",
      },
    });
    const response = await fetch(`${base}/api/v1/conversations/${conversation.id}/take`, {
      method: "POST",
      headers: { cookie },
    });
    assert.ok(response.status === 200 || response.status === 202);
    const body = await response.json();
    assert.equal(body.mode, "human");
    assert.equal(body.appliedOnSeller, false);
    const board = await situation();
    const row = board.items.find((item) => item.entityId === conversation.id);
    assert.ok(row);
    assert.equal(row.kind, "conversation_human");
  });

  it("overview добавляет insights, sources и team, не ломая прежние поля", async () => {
    const response = await fetch(`${base}/api/v1/situation/overview?period=today&scope=all`, {
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    const data = (await response.json()) as {
      brief: string;
      result: { inquiries: number; deltas: { inquiries: number | null; inquiriesPct?: number | null } };
      current: { activeDeals: number; newInquiries?: number; inWorkInquiries?: number };
      pipeline: { stages: Array<{ count: number }>; note: string };
      insights?: unknown[];
      sources?: unknown[];
      team?: unknown[];
      aiManager: { status: string; conversations?: { ai: number; human: number } };
      attention: { items: unknown[] };
    };
    assert.equal(typeof data.brief, "string");
    assert.equal(typeof data.result.inquiries, "number");
    assert.equal(typeof data.current.activeDeals, "number");
    assert.ok(Array.isArray(data.pipeline.stages));
    assert.ok(Array.isArray(data.insights));
    assert.ok(Array.isArray(data.sources));
    assert.ok(Array.isArray(data.team));
    assert.ok(data.aiManager.conversations);
    assert.equal(typeof data.aiManager.conversations.ai, "number");
    assert.equal(typeof data.current.newInquiries, "number");
    assert.equal(typeof data.current.inWorkInquiries, "number");
    assert.ok(Array.isArray(data.attention.items));
  });

  it("цифры «нужно ответить» и «нужен человек» совпадают со страницами, куда ведут ссылки", async () => {
    await resetDemo();
    const waiting = await prisma.contact.create({
      data: {
        tenantId,
        name: "Ждёт ответа",
        lastInboundMessageAt: new Date(),
        lastOutboundMessageAt: new Date(Date.now() - 3600_000),
      },
    });
    await prisma.conversation.create({
      data: {
        tenantId,
        contactId: waiting.id,
        mode: "human",
        status: "open",
        needsAttention: true,
        attentionReason: "seller_lead_rematched",
      },
    });
    await prisma.conversation.create({
      data: {
        tenantId,
        contactId: waiting.id,
        sellerLeadId: "lead-waiting-1",
        mode: "human",
        status: "open",
        needsAttention: true,
      },
    });
    const answered = await prisma.contact.create({
      data: {
        tenantId,
        name: "Уже ответили",
        lastInboundMessageAt: new Date(Date.now() - 3600_000),
        lastOutboundMessageAt: new Date(),
      },
    });
    await prisma.conversation.create({
      data: {
        tenantId,
        contactId: answered.id,
        sellerLeadId: "lead-answered-1",
        mode: "human",
        status: "open",
        needsAttention: false,
      },
    });

    const overviewRes = await fetch(`${base}/api/v1/situation/overview?period=today&scope=all`, { headers: { cookie } });
    assert.equal(overviewRes.status, 200);
    const overview = (await overviewRes.json()) as {
      attention: {
        summary: { needsReply: number; needsHuman: number; overdueTasks: number };
        items: Array<{ group?: string; links?: { contactId?: string }; phone?: string | null }>;
      };
    };

    const contactsRes = await fetch(`${base}/api/v1/contacts?filter=needs_reply`, { headers: { cookie } });
    assert.equal(contactsRes.status, 200);
    const contacts = (await contactsRes.json()) as { total: number; items: Array<{ id: string }> };

    const attentionRes = await fetch(`${base}/api/v1/conversations?filter=attention`, { headers: { cookie } });
    assert.equal(attentionRes.status, 200);
    const attentionDialogs = (await attentionRes.json()) as { items: Array<{ id: string }> };

    const badgesRes = await fetch(`${base}/api/v1/nav-badges`, { headers: { cookie } });
    assert.equal(badgesRes.status, 200);
    const badges = (await badgesRes.json()) as { badges: Record<string, number> };

    assert.equal(overview.attention.summary.needsReply, contacts.total);
    assert.equal(overview.attention.summary.needsReply, badges.badges["/contacts"]);
    assert.ok(contacts.items.some((item) => item.id === waiting.id));
    assert.ok(!contacts.items.some((item) => item.id === answered.id));

    const replyItems = overview.attention.items.filter((item) => item.group === "needs_reply");
    const replyKeys = replyItems.map((item) => item.links?.contactId || item.phone).filter(Boolean);
    assert.equal(new Set(replyKeys).size, replyKeys.length);

    assert.equal(overview.attention.summary.needsHuman, attentionDialogs.items.length);
    assert.equal(overview.attention.summary.needsHuman, badges.badges["/conversations"]);
    assert.equal(overview.attention.summary.overdueTasks, badges.badges["/tasks"]);
  });

  it("поручение без sellerLead — 422", async () => {
    const conversation = await prisma.conversation.create({
      data: { tenantId, mode: "ai", status: "open" },
    });
    const response = await fetch(`${base}/api/v1/conversations/${conversation.id}/instruction`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ text: "не давай скидку" }),
    });
    assert.equal(response.status, 422);
  });
});
