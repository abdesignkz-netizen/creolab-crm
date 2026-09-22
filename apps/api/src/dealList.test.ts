import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { seedDatabase } from "../../../packages/db/src/seed.ts";
import { getDealBoard, ensureDealPipelineStages } from "./services/dealService.ts";
import { loadDealDocumentSummaries } from "./services/dealDocumentSummary.ts";
import type { AuthContext } from "./lib/types.ts";

describe("Deal list references and document delivery", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let auth: AuthContext;
  let tenantId: string;
  let dealId: string;
  let holdId: string;
  let draftId: string;
  let contractId: string;
  let versionId: string;
  before(async () => {
    prisma = await createPrismaClient();
    await seedDatabase();
    const member = await prisma.membership.findFirstOrThrow({ where: { role: "owner" }, include: { tenant: true, user: true } });
    tenantId = member.tenantId;
    auth = { user: member.user, activeMembership: member, memberships: [member], sessionId: "test", client: "web" } as AuthContext;
    const stages = await ensureDealPipelineStages(prisma, tenantId);
    const contact = await prisma.contact.create({ data: { tenantId, name: "List fixture", methods: { create: { type: "phone", source: "manual", rawValue: "+7 701 222 3344", normalizedValue: "77012223344" } } } });
    const base = { tenantId, contactId: contact.id, stageId: stages[0].id, title: "List fixture", assigneeMembershipId: member.id };
    const rows = await Promise.all([prisma.deal.create({ data: base }), prisma.deal.create({ data: { ...base, outcome: "on_hold" } })]);
    assert.notEqual(rows[0].number, rows[1].number);
    dealId = rows[0].id; holdId = rows[1].id;
    const amounts = { amountWithoutVat: 100, vatAmount: 0, totalAmount: 100 };
    const contract = await prisma.contract.create({ data: { tenantId, dealId, number: "LIST-DOG", status: "PENDING_SIGNATURE", ...amounts } });
    contractId = contract.id;
    const version = await prisma.contractVersion.create({ data: { tenantId, contractId, version: 1, sha256: "test", fileId: null } });
    versionId = version.id;
    await prisma.signatureRequest.create({ data: { tenantId, contractId, contractVersionId: versionId, signerType: "BUYER", order: 2, status: "PENDING" } });
    await prisma.invoice.create({ data: { tenantId, dealId, number: "LIST-INV", status: "ISSUED", ...amounts } });
    await prisma.electronicDocument.create({ data: { tenantId, dealId, type: "AVR", number: "LIST-AVR-OLD", status: "ACCEPTED", sentAt: new Date(), createdAt: new Date("2026-01-01"), ...amounts } });
    const draft = await prisma.electronicDocument.create({ data: { tenantId, dealId, type: "AVR", number: "LIST-AVR-NEW", status: "DRAFT", createdAt: new Date("2026-02-01"), ...amounts } });
    draftId = draft.id;
    await prisma.electronicDocument.create({ data: { tenantId, dealId, type: "ESF", number: "LIST-ESF", status: "SENDING", ...amounts } });
  });

  it("keeps numbers stable and unique across updates and repeated additive patches", async () => {
    const before = await prisma.deal.findUniqueOrThrow({ where: { id: dealId } });
    await prisma.deal.update({ where: { id: dealId }, data: { title: "Renamed order" } });
    await prisma.$executeRawUnsafe('ALTER TABLE "Deal" ADD COLUMN IF NOT EXISTS "number" SERIAL');
    assert.equal((await prisma.deal.findUniqueOrThrow({ where: { id: dealId } })).number, before.number);
    const numbers = await prisma.deal.findMany({ select: { number: true } });
    assert.equal(new Set(numbers.map((row) => row.number)).size, numbers.length);
  });

  it("does not treat a link, issued invoice, or in-flight transmission as a sent document", async () => {
    const docs = (await loadDealDocumentSummaries(prisma, tenantId, [dealId])).get(dealId)!;
    assert.equal(docs.CONTRACT?.delivery, "unknown");
    assert.equal(docs.INVOICE?.delivery, "unknown");
    assert.equal(docs.AVR?.id, draftId);
    assert.equal(docs.AVR?.count, 2);
    assert.equal(docs.AVR?.delivery, "not_sent");
    assert.equal(docs.ESF?.delivery, "sending");
  });

  it("uses evidence for the current contract version and electronic document delivery", async () => {
    await prisma.signatureRequest.updateMany({ where: { contractId }, data: { openedAt: new Date() } });
    await prisma.electronicDocument.updateMany({ where: { dealId, type: "ESF" }, data: { status: "SENT", sentAt: new Date() } });
    let docs = (await loadDealDocumentSummaries(prisma, tenantId, [dealId])).get(dealId)!;
    assert.equal(docs.CONTRACT?.delivery, "sent");
    assert.equal(docs.ESF?.delivery, "sent");
    await prisma.contractVersion.create({ data: { tenantId, contractId, version: 2, sha256: "new", fileId: null } });
    docs = (await loadDealDocumentSummaries(prisma, tenantId, [dealId])).get(dealId)!;
    assert.equal(docs.CONTRACT?.delivery, "unknown");
  });

  it("lists paused deals once, includes references and phone, and isolates document summaries by tenant", async () => {
    const board = await getDealBoard(prisma, auth);
    assert.equal(board.items.filter((deal) => deal.id === holdId).length, 1);
    const deal = board.items.find((row) => row.id === dealId)!;
    assert.match(deal.number || "", /^СД-\d{6,}$/);
    assert.ok(deal.contact?.phone);
    assert.equal(deal.documents?.CONTRACT?.id, contractId);
    const foreign = (await loadDealDocumentSummaries(prisma, "different-tenant", [dealId])).get(dealId)!;
    assert.deepEqual(foreign, { CONTRACT: null, INVOICE: null, AVR: null, ESF: null });
    const managerAuth = { ...auth, activeMembership: { ...auth.activeMembership!, role: "manager" } } as AuthContext;
    const managerBoard = await getDealBoard(prisma, managerAuth);
    assert.ok(managerBoard.items.length);
    assert.ok(managerBoard.items.every((row) => row.documents === null));
    await prisma.tenantLegalProfile.upsert({ where: { tenantId }, create: { tenantId, documentsEnabled: false }, update: { documentsEnabled: false } });
    const disabledBoard = await getDealBoard(prisma, auth);
    assert.equal(disabledBoard.documentsAllowed, false);
    assert.ok(disabledBoard.items.every((row) => row.documents === null));
    await prisma.tenantLegalProfile.update({ where: { tenantId }, data: { documentsEnabled: true } });
  });
});
