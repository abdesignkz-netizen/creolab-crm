import assert from "node:assert/strict";
import { before, beforeEach, after, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { authForUserInTenant } from "./services/authService.ts";
import { provisionOrganization } from "./services/organizationProvisioning.ts";
import { getOnboarding, updateOnboarding } from "./services/onboardingService.ts";
import { getBillingState, completeOnboardingStep, skipOnboarding } from "./services/billingService.ts";

describe("First launch assistant", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>, auth: Awaited<ReturnType<typeof authForUserInTenant>>, tenantId: string, ownerId: string;
  const get = () => getOnboarding(prisma, auth);
  const done = (state: Awaited<ReturnType<typeof get>>, id: string) => state.steps.find(s => s.id === id)?.done;
  before(async () => {
    prisma = await createPrismaClient(); await (await import("../../../packages/db/src/seed.ts")).seedDatabase();
    ownerId = (await prisma.user.findFirstOrThrow({ where: { email: "owner@creolab.example" } })).id;
  });
  beforeEach(async () => {
    const tenant = await prisma.$transaction(tx => provisionOrganization(tx, { name: `Onboarding ${Date.now()}`, source: "self_registration", subscriptionStatus: "active" }));
    tenantId = tenant.id;
    await prisma.membership.create({ data: { tenantId, userId: ownerId, role: "owner" } });
    auth = await authForUserInTenant(prisma, ownerId, tenantId, "onboarding-test");
  });
  after(async () => prisma.$disconnect());
  async function connect(type = "whatsapp_qr", status = "CONNECTED") {
    const integration = await prisma.integration.create({ data: { tenantId, name: "Test channel", type, status: status === "CONNECTED" ? "active" : "pending", connectionStatus: status } });
    const channelType = ({ telegram_bot: "telegram", instagram_direct: "instagram", website_chat: "website" } as Record<string, string>)[type] || "whatsapp";
    const connection = await prisma.channelConnection.create({ data: { tenantId, integrationId: integration.id, channelType, status: "active" } });
    return { integration, connection };
  }
  async function message(connectionId: string, overrides: Record<string, any> = {}) {
    const conversation = await prisma.conversation.create({ data: { tenantId, connectionId } });
    const inbound = await prisma.message.create({ data: { tenantId, conversationId: conversation.id, senderKind: "client", direction: "inbound", text: "Test", ...overrides } });
    return { conversation, inbound };
  }
  it("starts free self-registration with onboarding, without changing live AI or channel settings", async () => {
    const state = await get(); assert.equal(state.suggested, true); assert.equal(state.started, false); assert.equal(state.completed, false);
    assert.equal((await getBillingState(prisma, tenantId)).onboarding.status, "not_started");
    const initialAi = await prisma.aIConfiguration.findFirstOrThrow({ where: { tenantId } });
    await updateOnboarding(prisma, auth, { channel: "telegram", replyMode: "manual" });
    assert.equal((await prisma.aIConfiguration.findFirstOrThrow({ where: { tenantId } })).enabled, initialAi.enabled);
    assert.equal(await prisma.integration.count({ where: { tenantId } }), 0);
  });
  it("does not complete steps on visit, skip or refresh; resumes with saved choices", async () => {
    await updateOnboarding(prisma, auth, { channel: "whatsapp", replyMode: "manual" });
    await assert.rejects(completeOnboardingStep(prisma, auth, "whatsapp"), /Сначала сохраните/);
    await assert.rejects(updateOnboarding(prisma, auth, { finish: true }), /первое обращение/);
    await skipOnboarding(prisma, auth);
    const state = await get(); assert.equal(state.deferred, true); assert.equal(state.channel, "whatsapp"); assert.equal(done(state, "channel"), false);
    assert.equal(state.steps.length, 3);
    await updateOnboarding(prisma, auth, { deferred: false }); assert.equal((await get()).deferred, false);
    await assert.rejects(completeOnboardingStep(prisma, auth, "arbitrary"), /Начало работы/);
  });
  it("checks actual connection and new non-historical inbound; disconnect regresses readiness", async () => {
    const { integration, connection } = await connect();
    await message(connection.id, { createdAt: new Date(Date.now() - 60000) });
    await updateOnboarding(prisma, auth, { channel: "whatsapp", replyMode: "manual" });
    assert.equal(done(await get(), "channel"), true); assert.equal(done(await get(), "test"), false);
    await message(connection.id, { historical: true }); assert.equal(done(await get(), "test"), false);
    await message(connection.id, { internal: true }); assert.equal(done(await get(), "test"), false);
    const { conversation, inbound } = await message(connection.id);
    assert.equal((await get()).completed, false, "receiving a message alone does not verify staff replies");
    await prisma.message.create({ data: { tenantId, conversationId: conversation.id, direction: "outbound", senderKind: "staff", operationState: "accepted", text: "Reply", createdAt: new Date(inbound.createdAt.getTime() + 1) } });
    const state = await get(); assert.equal(state.completed, true); assert.equal(state.evidence.conversationId, conversation.id);
    await updateOnboarding(prisma, auth, { finish: true });
    assert.equal((await getBillingState(prisma, tenantId)).onboarding.status, "completed");
    await prisma.integration.update({ where: { id: integration.id }, data: { connectionStatus: "DISCONNECTED" } });
    assert.equal(done(await get(), "channel"), false); assert.equal((await get()).completed, false);
  });
  it("does not mark a disconnected binding as ready even if the integration still reports CONNECTED", async () => {
    for (const [channel, type] of [["whatsapp", "whatsapp_qr"], ["telegram", "telegram_bot"], ["instagram", "instagram_direct"], ["website-chat", "website_chat"]] as const) {
      await updateOnboarding(prisma, auth, { channel, replyMode: "manual" });
      const { connection } = await connect(type);
      assert.equal(done(await get(), "channel"), true, channel);
      await prisma.channelConnection.update({ where: { id: connection.id }, data: { status: "disabled" } });
      assert.equal(done(await get(), "channel"), false, channel);
      await prisma.channelConnection.delete({ where: { id: connection.id } });
      assert.equal(done(await get(), "channel"), false, `${channel}: missing binding`);
    }
  });
  it("verifies a successful staff reply, ignoring AI replies, queued, internal, historical and failed messages", async () => {
    await updateOnboarding(prisma, auth, { channel: "website-chat", replyMode: "manual" });
    const { connection } = await connect("website_chat");
    const { conversation, inbound } = await message(connection.id);
    const reply = await prisma.message.create({ data: { tenantId, conversationId: conversation.id, direction: "outbound", senderKind: "ai", operationState: "accepted", text: "Reply", createdAt: new Date(inbound.createdAt.getTime() + 1) } });
    assert.equal(done(await get(), "test"), false, "staff workflow must verify a staff reply");
    await prisma.message.update({ where: { id: reply.id }, data: { senderKind: "staff", operationState: "queued" } });
    assert.equal(done(await get(), "test"), false);
    await prisma.message.update({ where: { id: reply.id }, data: { operationState: "accepted", internal: true } });
    assert.equal(done(await get(), "test"), false);
    await prisma.message.update({ where: { id: reply.id }, data: { internal: false, historical: true } });
    assert.equal(done(await get(), "test"), false);
    await prisma.message.update({ where: { id: reply.id }, data: { historical: false, receiptState: "failed" } });
    assert.equal(done(await get(), "test"), false);
    await prisma.message.update({ where: { id: reply.id }, data: { receiptState: "unknown" } });
    assert.equal((await get()).completed, true);
    await updateOnboarding(prisma, auth, { finish: true });
    assert.equal((await getBillingState(prisma, tenantId)).onboarding.status, "completed");
  });
  it("does not confuse a pending connection or another company's messages with successful setup", async () => {
    await updateOnboarding(prisma, auth, { channel: "whatsapp", replyMode: "manual" });
    const pending = await connect("whatsapp_qr", "CONNECTING"); await message(pending.connection.id);
    assert.equal(done(await get(), "channel"), false); assert.equal(done(await get(), "test"), false);
    const foreign = await prisma.membership.findFirstOrThrow({ where: { userId: ownerId, tenantId: { not: tenantId } } });
    const integration = await prisma.integration.create({ data: { tenantId: foreign.tenantId, type: "whatsapp_qr", name: "Other company", status: "active", connectionStatus: "CONNECTED" } });
    const connection = await prisma.channelConnection.create({ data: { tenantId: foreign.tenantId, integrationId: integration.id, channelType: "whatsapp", status: "active" } });
    const c = await prisma.conversation.create({ data: { tenantId: foreign.tenantId, connectionId: connection.id } });
    await prisma.message.create({ data: { tenantId: foreign.tenantId, conversationId: c.id, senderKind: "client", direction: "inbound" } });
    assert.equal(done(await get(), "test"), false);
  });
  it("requires published knowledge, saved reply rules and a successful AI send", async () => {
    await updateOnboarding(prisma, auth, { channel: "telegram", replyMode: "ai" });
    const { connection } = await connect("telegram_bot");
    const { conversation, inbound } = await message(connection.id);
    const ai = await prisma.aIConfiguration.findFirstOrThrow({ where: { tenantId } });
    await prisma.aIConfiguration.update({ where: { id: ai.id }, data: { systemPrompt: "Help customers", promptStatus: "draft" } });
    await prisma.knowledgeDocument.create({ data: { tenantId, title: "Business facts", content: "Verified prices", status: "published", sourceType: "manual" } });
    assert.equal(done(await get(), "knowledge"), false);
    await prisma.aIConfiguration.update({ where: { id: ai.id }, data: { promptStatus: "published" } });
    assert.equal(done(await get(), "knowledge"), true); assert.equal(done(await get(), "rules"), false);
    await prisma.auditEvent.create({ data: { tenantId, action: "ai.automation_updated", entityType: "tenant", entityId: tenantId } });
    const reply = await prisma.message.create({ data: { tenantId, conversationId: conversation.id, direction: "outbound", senderKind: "ai", text: "Answer", operationState: "queued", createdAt: new Date(inbound.createdAt.getTime() + 100) } });
    assert.equal(done(await get(), "test"), false);
    await prisma.message.update({ where: { id: reply.id }, data: { operationState: "accepted" } });
    assert.equal((await get()).completed, true);
    await message(connection.id, { createdAt: new Date(inbound.createdAt.getTime() + 200) });
    assert.equal((await get()).completed, true, "a later unanswered conversation does not erase the completed test");
    await prisma.message.update({ where: { id: reply.id }, data: { connectionScopedId: `wa-ai-handoff:${reply.id}` } });
    assert.equal(done(await get(), "test"), false, "handoff acknowledgement is not a knowledge-based reply");
    await prisma.message.update({ where: { id: reply.id }, data: { connectionScopedId: null } });
    await prisma.message.update({ where: { id: reply.id }, data: { receiptState: "failed" } }); assert.equal(done(await get(), "test"), false);
  });
  it("switching channels resets the test instead of reusing another channel's result", async () => {
    await updateOnboarding(prisma, auth, { channel: "whatsapp", replyMode: "manual" });
    const { connection } = await connect();
    const { conversation, inbound } = await message(connection.id);
    await prisma.message.create({ data: { tenantId, conversationId: conversation.id, direction: "outbound", senderKind: "staff", operationState: "accepted", text: "Reply", createdAt: new Date(inbound.createdAt.getTime() + 1) } });
    assert.equal((await get()).completed, true);
    const before = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    await prisma.tenant.update({ where: { id: tenantId }, data: { settingsJson: { ...(before.settingsJson as object), unrelated: { keep: true } } } });
    await updateOnboarding(prisma, auth, { channel: "telegram" });
    const state = await get(); assert.equal(state.evidence.inbound, false); assert.equal(state.completed, false);
    const settings = (await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })).settingsJson as any;
    assert.deepEqual(settings.unrelated, { keep: true });
  });
  it("checks website form inquiries and does not promise AI chat for a form", async () => {
    await updateOnboarding(prisma, auth, { channel: "form", replyMode: "ai" });
    const integration = await prisma.integration.create({ data: { tenantId, type: "form", name: "Website form", status: "active", connectionStatus: "CONNECTED" } });
    assert.equal(done(await get(), "channel"), false, "an integration without an active form cannot receive inquiries");
    const form = await prisma.formDefinition.create({ data: { tenantId, integrationId: integration.id, name: "Inquiry", publicKey: `test-${integration.id}`, fieldsJson: {}, active: true } });
    assert.equal((await get()).replyMode, "manual");
    const contact = await prisma.contact.create({ data: { tenantId, name: "Form customer" } });
    await prisma.inquiry.create({ data: { tenantId, contactId: contact.id, integrationId: integration.id, source: "form" } });
    assert.equal((await get()).completed, true);
    await updateOnboarding(prisma, auth, { finish: true });
    await prisma.formDefinition.update({ where: { id: form.id }, data: { active: false } });
    assert.equal(done(await get(), "channel"), false);
    assert.equal((await get()).completed, false);
  });
  it("rejects fabricated progress, tenant overrides and staff edits", async () => {
    await assert.rejects(updateOnboarding(prisma, auth, { steps: { test: true } }));
    await assert.rejects(updateOnboarding(prisma, auth, { tenantId: "other" }));
    await assert.rejects(updateOnboarding(prisma, auth, { channel: "other" }));
    const staff = { ...auth, activeMembership: { ...auth.activeMembership!, role: "manager" } };
    await assert.rejects(getOnboarding(prisma, staff), /Недостаточно прав/);
    await assert.rejects(updateOnboarding(prisma, staff, { deferred: true }), /Недостаточно прав/);
    await assert.rejects(skipOnboarding(prisma, staff), /Недостаточно прав/);
  });
});
