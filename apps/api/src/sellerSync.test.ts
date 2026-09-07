import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { applySellerLeadSync, findExistingWhatsAppConversation, reconcileImportedSellerMessages } from "./services/sellerLink.ts";

function sellerScopedId(leadId: string, item: { role: string; content: string; at?: string }) {
  return `seller:${createHash("sha1").update(`${leadId}|${item.role}|${item.at || ""}|${item.content}`).digest("hex")}`;
}

describe("seller lead sync rematch by phone", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let tenantId = "";

  before(async () => {
    process.env.SEED_PASSWORD ||= "ChangeMeLocal1!";
    prisma = await createPrismaClient();
    const { seedDatabase } = await import("../../../packages/db/src/seed.ts");
    await seedDatabase();
    const tenant = await prisma.tenant.findFirst();
    assert.ok(tenant);
    tenantId = tenant.id;
  });

  after(async () => {
    await prisma.$disconnect();
  });

  it("does not keep another client's WhatsApp history on a recycled LEAD id", async () => {
    const stale = await prisma.contact.create({
      data: {
        tenantId,
        name: "Старый номер",
        methods: {
          create: {
            type: "phone",
            rawValue: "77000990787",
            normalizedValue: "77000990787",
            source: "whatsapp_seller",
            primary: true,
          },
        },
      },
    });
    const conversation = await prisma.conversation.create({
      data: {
        tenantId,
        contactId: stale.id,
        sellerLeadId: "LEAD-0001",
        mode: "ai",
        status: "open",
      },
    });
    const foreign = await prisma.message.create({
      data: {
        tenantId,
        conversationId: conversation.id,
        senderKind: "client",
        direction: "inbound",
        text: "Мне нужны услуги автокрана",
        historical: true,
        connectionScopedId: "seller:test-autocrane",
      },
    });
    const historyItem = {
      role: "user",
      content: "Здравствуйте, хочу презентацию",
      at: "2026-09-07T11:00:00.000Z",
    };
    const stolen = await prisma.message.create({
      data: {
        tenantId,
        conversationId: conversation.id,
        senderKind: "client",
        direction: "inbound",
        text: historyItem.content,
        historical: true,
        connectionScopedId: sellerScopedId("LEAD-0001", historyItem),
      },
    });

    const result = await applySellerLeadSync(prisma, {
      tenantId,
      defaultRegion: "KZ",
      connectionId: null,
      lead: {
        leadId: "LEAD-0001",
        clientPhone: "77074129213",
        clientName: "Новый клиент",
        aiMode: "AUTO",
        conversationHistory: [
          historyItem,
          { role: "assistant", content: "Здравствуйте! Какой формат презентации нужен?", at: "2026-09-07T11:00:01.000Z" },
        ],
      },
    });

    assert.equal(result.skipped, null);
    assert.equal(result.rematched, true);
    assert.notEqual(result.conversationId, conversation.id);
    assert.notEqual(result.contactId, stale.id);

    const oldConv = await prisma.conversation.findFirst({ where: { id: conversation.id } });
    assert.equal(oldConv?.sellerLeadId, null);
    assert.equal(oldConv?.contactId, stale.id);

    const leftover = await prisma.message.findFirst({ where: { id: foreign.id } });
    assert.equal(leftover?.conversationId, conversation.id);

    const moved = await prisma.message.findFirst({ where: { id: stolen.id } });
    const targetMessages = await prisma.message.findMany({
      where: { conversationId: result.conversationId! },
      orderBy: { createdAt: "asc" },
    });
    assert.ok(targetMessages.some((item) => item.text === "Здравствуйте, хочу презентацию"));
    assert.ok(targetMessages.some((item) => item.text?.includes("формат презентации")));
    assert.ok(!targetMessages.some((item) => item.text === "Мне нужны услуги автокрана"));
    if (moved) {
      assert.equal(moved.conversationId, result.conversationId);
      assert.equal(result.moved, 1);
    }

    const newContact = await prisma.contact.findFirst({
      where: { id: result.contactId! },
      include: { methods: true },
    });
    assert.equal(newContact?.methods[0]?.normalizedValue, "77074129213");

    const cleaned = await reconcileImportedSellerMessages(
      prisma,
      tenantId,
      "KZ",
      [
        {
          leadId: "LEAD-0001",
          clientPhone: "77074129213",
          conversationHistory: [
            historyItem,
            { role: "assistant", content: "Здравствуйте! Какой формат презентации нужен?", at: "2026-09-07T11:00:01.000Z" },
          ],
        },
      ],
      new Map([["77074129213", result.conversationId!]]),
    );
    assert.equal(cleaned.removed, 0);
    const gone = await prisma.message.findFirst({ where: { id: foreign.id } });
    assert.ok(gone, "history missing from a limited bridge snapshot must be retained");
    const stillOnStale = await prisma.message.findMany({ where: { conversationId: conversation.id } });
    assert.equal(stillOnStale.some((item) => item.text === "Мне нужны услуги автокрана"), true);
  });

  it("isolates identical phone histories by tenant and maintains contact dates", async () => {
    const other = await prisma.tenant.findFirstOrThrow({ where: { id: { not: tenantId } } });
    const lead = {
      leadId: "LEAD-dates", clientPhone: "77075551234", clientName: "Даты импорта", aiMode: "AUTO",
      conversationHistory: [
        { role: "user", content: "Нужен сайт", at: "2026-08-01T10:00:00Z" },
        { role: "assistant", content: "Уточним задачу", at: "2026-08-01T10:05:00Z" },
        { role: "user", content: "Сколько стоит?", at: "2026-08-02T10:00:00Z" },
      ],
    };
    const first = await applySellerLeadSync(prisma, { tenantId, defaultRegion: "KZ", lead, connectionId: null });
    const second = await applySellerLeadSync(prisma, { tenantId: other.id, defaultRegion: "KZ", lead, connectionId: null });
    assert.notEqual(first.contactId, second.contactId);
    const repeat = await applySellerLeadSync(prisma, { tenantId, defaultRegion: "KZ", lead, connectionId: null });
    assert.equal(repeat.added, 0);
    assert.equal(await prisma.message.count({ where: { conversationId: first.conversationId } }), 3);
    const contact = await prisma.contact.findUniqueOrThrow({ where: { id: first.contactId } });
    assert.equal(contact.firstSeenAt.toISOString(), "2026-08-01T10:00:00.000Z");
    assert.equal(contact.lastContactAt?.toISOString(), "2026-08-02T10:00:00.000Z");
    assert.equal(contact.lastInboundMessageAt?.toISOString(), "2026-08-02T10:00:00.000Z");
    assert.equal(contact.lastOutboundMessageAt?.toISOString(), "2026-08-01T10:05:00.000Z");
    const preserved = await reconcileImportedSellerMessages(prisma, tenantId, "KZ", [], new Map());
    assert.equal(preserved.removed, 0);
    assert.equal(await prisma.message.count({ where: { conversationId: first.conversationId } }), 3);
  });

  it("does not reuse a rematched seller lead belonging to another phone", async () => {
    const stale = await prisma.contact.create({
      data: {
        tenantId,
        name: "Без имени",
        methods: {
          create: {
            type: "phone",
            rawValue: "77005550101",
            normalizedValue: "77005550101",
            source: "whatsapp_seller",
            primary: true,
          },
        },
      },
    });
    const other = await prisma.contact.create({
      data: {
        tenantId,
        name: "Новый владелец лида",
        methods: {
          create: {
            type: "phone",
            rawValue: "77005550202",
            normalizedValue: "77005550202",
            source: "whatsapp_seller",
            primary: true,
          },
        },
      },
    });
    await prisma.conversation.create({
      data: {
        tenantId,
        contactId: stale.id,
        sellerLeadId: null,
        attentionReason: "seller_lead_rematched",
        mode: "ai",
        status: "open",
      },
    });
    const live = await prisma.conversation.create({
      data: {
        tenantId,
        contactId: other.id,
        sellerLeadId: "LEAD-rematch-wrong",
        externalThreadId: "77005550202",
        mode: "ai",
        status: "open",
      },
    });
    await prisma.externalIdentity.create({
      data: {
        tenantId,
        contactId: stale.id,
        type: "seller_lead",
        externalId: "LEAD-rematch-wrong",
        confirmed: true,
      },
    });

    const found = await findExistingWhatsAppConversation(prisma, tenantId, stale.id);
    assert.equal(found, null);

    const byPhone = await findExistingWhatsAppConversation(prisma, tenantId, other.id);
    assert.equal(byPhone?.id, live.id);
  });

  it("creates a new CRM inquiry from a WhatsApp AI lead", async () => {
    const lead = {
      leadId: "LEAD-inquiry-sync",
      clientPhone: "77074120099",
      clientName: "Жаным Тест",
      aiMode: "AUTO",
      conversationHistory: [
        { role: "user", content: "Здравствуйте, хочу презентацию для школы", at: "2026-09-08T00:00:00.000Z" },
        { role: "assistant", content: "Расскажите формат", at: "2026-09-08T00:00:10.000Z" },
      ],
    };
    const first = await applySellerLeadSync(prisma, { tenantId, defaultRegion: "KZ", lead, connectionId: null });
    assert.equal(first.skipped, null);
    assert.equal(first.inquiryCreated, true);
    assert.ok(first.inquiryId);
    const inquiry = await prisma.inquiry.findFirst({ where: { id: first.inquiryId! } });
    assert.equal(inquiry?.source, "whatsapp");
    assert.equal(inquiry?.status, "new");
    assert.equal(inquiry?.conversationId, first.conversationId);
    assert.match(inquiry?.subject || "", /презентац/i);
    const repeat = await applySellerLeadSync(prisma, { tenantId, defaultRegion: "KZ", lead, connectionId: null });
    assert.equal(repeat.inquiryCreated, false);
    assert.equal(repeat.inquiryId, first.inquiryId);
    assert.equal(await prisma.inquiry.count({ where: { conversationId: first.conversationId } }), 1);
  });
});
