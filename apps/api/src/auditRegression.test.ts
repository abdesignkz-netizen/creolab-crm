import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { seedDatabase } from "../../../packages/db/src/seed.ts";
import { getAnalyticsDashboard, getAnalyticsTrend, getAnalyticsDrilldown } from "./services/analyticsService.ts";
import { getDealBoard, ensureDealPipelineStages, flagsForDeal } from "./services/dealService.ts";
import { listContactsBoard } from "./services/contactService.ts";
import { getConversationWorkspace, getConversationMessages, listConversationsBoard, markConversationRead } from "./services/conversationService.ts";
import { DEFAULT_OPS_SETTINGS } from "./services/dealPipeline.ts";
import { listInquiries } from "./services/inquiryService.ts";
import { resolvePeriodRange } from "./services/periodRange.ts";
import type { AuthContext } from "./lib/types.ts";

describe("CRM audit regressions", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let auth: AuthContext;
  let tenantId: string;
  let fixtureContact: string;
  let wonId: string;
  let stageId: string;
  before(async () => {
    prisma = await createPrismaClient();
    await seedDatabase();
    const member = await prisma.membership.findFirstOrThrow({ where: { role: "owner" }, include: { tenant: true, user: true } });
    tenantId = member.tenantId;
    auth = { user: member.user, activeMembership: member, memberships: [member], sessionId: "test", client: "web" } as AuthContext;
    await ensureDealPipelineStages(prisma, tenantId);
    stageId = (await prisma.dealStage.findFirstOrThrow({ where: { tenantId, systemKey: "proposal_sent" } })).id;
    for (const [source, amount] of [["audit-source-a", 123000], ["audit-source-b", 990000]] as const) {
      const contact = await prisma.contact.create({ data: { tenantId, name: source, firstSeenAt: new Date("2026-09-02T10:00:00Z"), methods: { create: { type: "phone", source: "manual", rawValue: "+7 701 123 45 67", normalizedValue: "77011234567" } } } });
      const inquiry = await prisma.inquiry.create({ data: { tenantId, contactId: contact.id, source, sourceType: source, serviceCategory: "audit", receivedAt: new Date("2026-09-02T10:00:00Z") } });
      const deal = await prisma.deal.create({ data: { tenantId, contactId: contact.id, inquiryId: inquiry.id, stageId, title: source, outcome: "won", offerAmountMinor: amount + 5000, wonAmountMinor: amount, createdAt: new Date("2026-09-02T10:00:00Z"), closedAt: new Date("2026-09-03T10:00:00Z") } });
      if (source.endsWith("a")) { fixtureContact = contact.id; wonId = deal.id; }
    }
  });

  it("source filter agrees across inquiries, clients, revenue, trend and drilldown", async () => {
    const query = { period: "custom", dateFrom: "2026-09-01", dateTo: "2026-09-07", source: "audit-source-a", compare: "none" };
    const dashboard = await getAnalyticsDashboard(prisma, auth, query);
    assert.equal(dashboard.overview.inquiries, 1);
    assert.equal(dashboard.overview.clients, 1);
    assert.equal(dashboard.overview.dealsCreated, 1);
    assert.equal(dashboard.overview.won, 1);
    assert.equal(dashboard.overview.revenue, 123000);
    const trend = await getAnalyticsTrend(prisma, auth, { ...query, metric: "revenue" });
    assert.equal(trend.points.reduce((sum, point) => sum + (point.value || 0), 0), 123000);
    const clients = await getAnalyticsDrilldown(prisma, auth, { ...query, entity: "clients" });
    assert.equal(clients.total, 1);
  });

  it("conversion without inquiries is missing data, not zero percent", async () => {
    const trend = await getAnalyticsTrend(prisma, auth, { period: "custom", dateFrom: "2026-09-01", dateTo: "2026-09-07", source: "audit-source-a", metric: "conversion" });
    assert.ok(trend.points.some(point => point.inquiries === 0 && point.value === null));
    assert.ok(trend.points.some(point => point.inquiries === 1 && point.value === 0));
  });

  it("sales deep link filters the outcome, period and stage while preserving the phone", async () => {
    const board = await getDealBoard(prisma, auth, { timeMode: "period", period: "custom", dateFrom: "2026-09-01", dateTo: "2026-09-07", basis: "closed", outcome: "won", stage: "proposal_sent" });
    const deal = board.columns.flatMap(column => column.deals).find(deal => deal.id === wonId);
    assert.ok(deal);
    assert.equal(deal.amount, 123000);
    assert.ok(deal.contact?.phone, "phone disappeared during board serialization");
    assert.ok(board.columns.flatMap(column => column.deals).every(deal => deal.outcome === "won"));
    const contacts = await listContactsBoard(prisma, auth, { period: "custom", dateFrom: "2026-09-03", dateTo: "2026-09-07" });
    assert.ok(!contacts.items.some(contact => contact.id === fixtureContact));
  });

  it("a planned call does not mean the team is waiting for the client", () => {
    const deal = { nextAction: "Позвонить клиенту", nextActionAt: null, stageEnteredAt: new Date(), stage: { systemKey: "proposal_sent" }, tasks: [] };
    assert.equal(flagsForDeal(deal, DEFAULT_OPS_SETTINGS, new Date()).waitingClient, false);
    assert.equal(flagsForDeal({ ...deal, nextAction: "Ждём решение клиента" }, DEFAULT_OPS_SETTINGS, new Date()).waitingClient, true);
  });

  it("text search and inquiry counters honor the same source, owner and test selection", async () => {
    const contact = await prisma.contact.create({ data: { tenantId, name: "Проверка текстового поиска" } });
    await prisma.inquiry.createMany({ data: [
      { tenantId, contactId: contact.id, subject: "Уникальная презентация", source: "audit-search", sourceChannel: "manual", assigneeMembershipId: auth.activeMembership!.id, phoneNormalized: "77011110000", test: false },
      { tenantId, contactId: contact.id, subject: "Другой запрос", source: "audit-search", sourceChannel: "manual", assigneeMembershipId: auth.activeMembership!.id, phoneNormalized: "77012220000", test: false },
      { tenantId, contactId: contact.id, subject: "Уникальная презентация", source: "audit-search", sourceChannel: "manual", assigneeMembershipId: auth.activeMembership!.id, test: true },
    ] });
    const search = await listInquiries(prisma, auth, { q: "Уникальная", source: "audit-search", scope: "mine", test: "false" });
    assert.equal(search.items.length, 1);
    assert.equal(search.total, 1);
    assert.equal(search.counts.all, 1);
    assert.equal(search.counts.new, 1);
    assert.equal(search.counts.needs_reply, 1);
    const empty = await listInquiries(prisma, auth, { q: "Совсемнесуществующийзапрос" });
    assert.equal(empty.total, 0);
  });

  it("inquiry pages expose every match once and sanitize invalid limits", async () => {
    await prisma.inquiry.createMany({ data: Array.from({ length: 105 }, (_, i) => ({ tenantId, contactId: fixtureContact, source: "audit-pages", subject: `Страница ${i}`, receivedAt: new Date("2026-09-01T10:00:00Z") })) });
    const first = await listInquiries(prisma, auth, { source: "audit-pages", limit: "80" });
    const second = await listInquiries(prisma, auth, { source: "audit-pages", limit: "80", offset: "80" });
    assert.equal(first.total, 105);
    assert.equal(first.items.length, 80);
    assert.equal(first.hasMore, true);
    assert.equal(second.items.length, 25);
    assert.equal(second.hasMore, false);
    assert.equal(new Set([...first.items, ...second.items].map(i => i.id)).size, 105);
    const invalid = await listInquiries(prisma, auth, { source: "audit-pages", limit: "NaN", offset: "-10" });
    assert.equal(invalid.limit, 50);
    assert.equal(invalid.offset, 0);
  });

  it("contact filters search beyond the first 120 and show actual related counts", async () => {
    await prisma.contact.createMany({ data: Array.from({ length: 125 }, (_, i) => ({ tenantId, name: `Пагинация клиента ${i}`, lastSeenAt: new Date("2026-09-05T10:00:00Z") })) });
    const oldest = await prisma.contact.create({ data: { tenantId, name: "Пагинация клиента старый", lastSeenAt: new Date("2025-01-01"), lastInboundMessageAt: new Date(), lastOutboundMessageAt: null } });
    await prisma.inquiry.createMany({ data: Array.from({ length: 12 }, (_, i) => ({ tenantId, contactId: oldest.id, source: "manual", subject: `Запрос ${i}` })) });
    const filtered = await listContactsBoard(prisma, auth, { q: "Пагинация клиента", filter: "needs_reply" });
    assert.equal(filtered.total, 1);
    assert.equal(filtered.items[0].id, oldest.id);
    assert.equal(filtered.items[0].inquiryCount, 12);
    const first = await listContactsBoard(prisma, auth, { q: "Пагинация клиента", limit: "100" });
    const second = await listContactsBoard(prisma, auth, { q: "Пагинация клиента", limit: "100", offset: "100" });
    assert.equal(first.metrics.total, 126);
    assert.equal(first.hasMore, true);
    assert.equal(second.items.length, 26);
    assert.equal(new Set([...first.items, ...second.items].map(c => c.id)).size, 126);
  });

  it("custom periods reject reversed and impossible dates", () => {
    assert.throws(() => resolvePeriodRange("Asia/Almaty", "custom", "2026-09-08", "2026-09-01"), /Дата С/);
    assert.throws(() => resolvePeriodRange("Asia/Almaty", "custom", "2026-02-30", "2026-03-01"), /Некорректные/);
    assert.throws(() => resolvePeriodRange("Asia/Almaty", "custom", "2026-13-01", "2026-13-02"), /Некорректные/);
    const range = resolvePeriodRange("Asia/Almaty", "custom", "2026-09-08", "2026-09-08");
    assert.equal(range.to!.getTime() - range.from!.getTime(), 86400000);
  });

  it("long conversation exposes latest messages and pageable history; reading does not mean answering", async () => {
    const contact = await prisma.contact.create({ data: { tenantId, name: "История диалога", lastOutboundMessageAt: new Date() } });
    const conversation = await prisma.conversation.create({ data: { tenantId, contactId: contact.id, mode: "human" } });
    const start = Date.now() - 600000;
    for (let i = 0; i < 130; i++) await prisma.message.create({ data: { tenantId, conversationId: conversation.id, direction: "inbound", senderKind: "client", text: i === 129 ? "Нужен сайт для компании" : `Сообщение ${i}`, createdAt: new Date(start + i * 1000) } });
    let workspace = await getConversationWorkspace(prisma, auth, conversation.id);
    assert.equal(workspace.messages.length, 120);
    assert.equal(workspace.messages.at(-1)?.text, "Нужен сайт для компании");
    assert.ok(workspace.conversation.topic.includes("сайт"));
    assert.equal(workspace.conversation.needsReply, true, "another conversation's outbound must not suppress this reply");
    const earlier = await getConversationMessages(prisma, auth, conversation.id, workspace.messages[0].id);
    assert.equal(earlier.messages.length, 10);
    assert.equal(earlier.messages[0].text, "Сообщение 0");
    assert.equal(earlier.hasEarlierMessages, false);
    await markConversationRead(prisma, auth, conversation.id, workspace.messages.at(-1)!.id);
    let board = await listConversationsBoard(prisma, auth);
    assert.equal(board.items.find(item => item.id === conversation.id)?.unread, false);
    assert.equal(board.items.find(item => item.id === conversation.id)?.needsReply, true);
    await prisma.message.create({ data: { tenantId, conversationId: conversation.id, direction: "inbound", senderKind: "client", text: "Есть новости?" } });
    board = await listConversationsBoard(prisma, auth, { filter: "unread" });
    assert.ok(board.items.some(item => item.id === conversation.id));
    const other = await prisma.conversation.create({ data: { tenantId, contactId: contact.id } });
    await assert.rejects(() => getConversationMessages(prisma, auth, other.id, workspace.messages[0].id));
  });
});
