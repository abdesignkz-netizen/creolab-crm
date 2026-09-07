import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { applySellerLeadSync, reconcileImportedSellerMessages } from "./services/sellerLink.ts";

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
    assert.ok(cleaned.removed >= 1);
    const gone = await prisma.message.findFirst({ where: { id: foreign.id } });
    assert.equal(gone, null);
    const stillOnStale = await prisma.message.findMany({ where: { conversationId: conversation.id } });
    assert.equal(stillOnStale.some((item) => item.text === "Мне нужны услуги автокрана"), false);
  });
});
