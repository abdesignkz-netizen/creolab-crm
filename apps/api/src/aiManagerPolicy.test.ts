import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import {
  DEFAULT_AI_AUTOMATION,
  isWithinAiSchedule,
  isWithinConversationHours,
  mergeAIAutomationIntoSettingsJson,
  offHoursBlocksAnalysis,
  parseAIAutomationSettings,
} from "./services/aiAutomationSettings.ts";
import {
  applyConfiguredHandoff,
  detectHandoffReason,
  isClientRefusalText,
  processClientFollowUp,
  refreshConversationFollowUp,
} from "./services/aiConversationPolicyService.ts";
import { processDueScheduledActions } from "./services/backgroundJobs.ts";

describe("AI manager policy settings", () => {
  it("existing companies keep handoff off, follow-up off and 24/7 hours", () => {
    const settings = parseAIAutomationSettings({});
    assert.equal(settings.defaultMode, DEFAULT_AI_AUTOMATION.defaultMode);
    assert.equal(settings.handoff.triggers.CLIENT_REQUESTED_HUMAN, false);
    assert.equal(settings.followUp.enabled, false);
    assert.equal(settings.conversationHours.mode, "always");
    assert.equal(
      isWithinAiSchedule(new Date("2026-09-20T21:00:00Z"), "Asia/Almaty", settings),
      true,
    );
  });

  it("detects existing handoff reasons from client text", () => {
    assert.equal(detectHandoffReason("Позовите менеджера, пожалуйста")?.code, "CLIENT_REQUESTED_HUMAN");
    assert.equal(detectHandoffReason("Это жалоба на обслуживание")?.trigger, "COMPLAINT");
    assert.equal(detectHandoffReason("Пришлите договор")?.trigger, "CONTRACT");
    assert.equal(detectHandoffReason("Как оплатить счёт?")?.trigger, "PAYMENT");
    assert.equal(detectHandoffReason("Нужна индивидуальная цена")?.trigger, "CUSTOM_PRICING");
    assert.equal(isClientRefusalText("Не интересно, не пишите больше"), true);
  });

  it("schedule hours use company timezone, not server clock", () => {
    const settings = parseAIAutomationSettings({
      aiAutomation: {
        conversationHours: {
          mode: "schedule",
          offHoursBehavior: "accept_no_process",
          days: {
            0: { enabled: false, start: "10:00", end: "18:00" },
            1: { enabled: true, start: "09:00", end: "20:00" },
          },
        },
      },
    });
    // Monday 2026-09-21 10:00 Almaty = 05:00 UTC
    assert.equal(
      isWithinConversationHours(new Date("2026-09-21T05:00:00Z"), "Asia/Almaty", settings.conversationHours),
      true,
    );
    // Monday 08:00 Almaty = 03:00 UTC
    assert.equal(
      isWithinConversationHours(new Date("2026-09-21T03:00:00Z"), "Asia/Almaty", settings.conversationHours),
      false,
    );
    assert.equal(
      isWithinAiSchedule(new Date("2026-09-21T03:00:00Z"), "Asia/Almaty", settings),
      false,
    );
    assert.equal(offHoursBlocksAnalysis(settings), false);
    settings.conversationHours.offHoursBehavior = "no_reply";
    assert.equal(offHoursBlocksAnalysis(settings), true);
  });
});

describe("AI manager policy runtime", { concurrency: false }, () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let server: { close: () => void };
  let base = "";
  let cookie = "";
  let tenantId = "";
  let otherCookie = "";
  let otherTenantId = "";

  async function json(path: string, init: RequestInit = {}, useCookie = cookie) {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", cookie: useCookie, ...(init.headers || {}) },
    });
    const body = await response.json().catch(() => ({}));
    return { response, body };
  }

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
    const login = await json("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "owner@creolab.example", password: process.env.SEED_PASSWORD, client: "web" }),
    }, "");
    cookie = login.response.headers.get("set-cookie") || "";
    const me = await json("/api/v1/me");
    tenantId = me.body.activeTenant?.tenant?.id || me.body.memberships?.[0]?.tenantId;
    const otherLogin = await json("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "owner@demo-agency.example", password: process.env.SEED_PASSWORD, client: "web" }),
    }, "");
    otherCookie = otherLogin.response.headers.get("set-cookie") || "";
    const otherMe = await json("/api/v1/me", {}, otherCookie);
    otherTenantId = otherMe.body.activeTenant?.tenant?.id || otherMe.body.memberships?.[0]?.tenantId;
    assert.ok(tenantId && otherTenantId && tenantId !== otherTenantId);
  });

  after(() => {
    server?.close();
  });

  it("saves handoff/follow-up/hours per company and does not touch the other tenant", async () => {
    const saved = await json("/api/v1/settings/ai-automation", {
      method: "PATCH",
      body: JSON.stringify({
        handoff: { afterMode: "human", triggers: { CLIENT_REQUESTED_HUMAN: true } },
        followUp: { enabled: true, delaysMinutes: [120, 1440, 4320], maxAttempts: 3 },
        conversationHours: { mode: "schedule", offHoursBehavior: "no_reply" },
        timezone: "Asia/Almaty",
      }),
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.body.handoff.triggers.CLIENT_REQUESTED_HUMAN, true);
    assert.equal(saved.body.followUp.enabled, true);
    assert.equal(saved.body.conversationHours.mode, "schedule");

    const other = await json("/api/v1/settings/ai-automation", {}, otherCookie);
    assert.equal(other.response.status, 200);
    assert.equal(other.body.handoff.triggers.CLIENT_REQUESTED_HUMAN, false);
    assert.equal(other.body.followUp.enabled, false);
    assert.equal(other.body.conversationHours.mode, "always");
  });

  it("hands conversation to a person when the configured reason fires", async () => {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const current = parseAIAutomationSettings(tenant.settingsJson);
    current.handoff.triggers.CLIENT_REQUESTED_HUMAN = true;
    current.handoff.afterMode = "human";
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { settingsJson: mergeAIAutomationIntoSettingsJson(tenant.settingsJson, current) as never },
    });
    const contact = await prisma.contact.create({
      data: { tenantId, name: "Асхат Handoff" },
    });
    const conversation = await prisma.conversation.create({
      data: { tenantId, contactId: contact.id, mode: "ai", status: "open" },
    });
    await prisma.message.create({
      data: {
        tenantId,
        conversationId: conversation.id,
        senderKind: "client",
        direction: "inbound",
        text: "Позовите менеджера, хочу с человеком",
      },
    });
    const result = await applyConfiguredHandoff(prisma, tenantId, conversation.id, {
      text: "Позовите менеджера, хочу с человеком",
    });
    assert.equal(result?.reason, "CLIENT_REQUESTED_HUMAN");
    assert.equal(result?.mode, "human");
    const updated = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    assert.equal(updated.mode, "human");
    assert.equal(updated.attentionReason, "CLIENT_REQUESTED_HUMAN");
  });

  it("does not change conversation mode when handoff triggers stay off", async () => {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const current = parseAIAutomationSettings(tenant.settingsJson);
    current.handoff.triggers.CLIENT_REQUESTED_HUMAN = false;
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { settingsJson: mergeAIAutomationIntoSettingsJson(tenant.settingsJson, current) as never },
    });
    const contact = await prisma.contact.create({ data: { tenantId, name: "Без передачи" } });
    const conversation = await prisma.conversation.create({
      data: { tenantId, contactId: contact.id, mode: "ai", status: "open" },
    });
    const result = await applyConfiguredHandoff(prisma, tenantId, conversation.id, {
      text: "Позовите менеджера, хочу с человеком",
    });
    assert.equal(result, null);
    const updated = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    assert.equal(updated.mode, "ai");
  });

  it("switches to assist (paused) after handoff when that option is chosen", async () => {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const current = parseAIAutomationSettings(tenant.settingsJson);
    current.handoff.triggers.CLIENT_REQUESTED_HUMAN = true;
    current.handoff.afterMode = "assist";
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { settingsJson: mergeAIAutomationIntoSettingsJson(tenant.settingsJson, current) as never },
    });
    const contact = await prisma.contact.create({ data: { tenantId, name: "Assist" } });
    const conversation = await prisma.conversation.create({
      data: { tenantId, contactId: contact.id, mode: "ai", status: "open" },
    });
    const result = await applyConfiguredHandoff(prisma, tenantId, conversation.id, {
      text: "Переведите на человека",
    });
    assert.equal(result?.mode, "paused");
    const updated = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    assert.equal(updated.mode, "paused");
    assert.equal(updated.needsAttention, true);
  });

  it("skips follow-up when the client replies before the job runs", async () => {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const current = parseAIAutomationSettings(tenant.settingsJson);
    current.followUp.enabled = true;
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { settingsJson: mergeAIAutomationIntoSettingsJson(tenant.settingsJson, current) as never },
    });
    const contact = await prisma.contact.create({ data: { tenantId, name: "Клиент Followup" } });
    const conversation = await prisma.conversation.create({
      data: { tenantId, contactId: contact.id, mode: "ai", status: "open" },
    });
    await prisma.message.create({
      data: {
        tenantId,
        conversationId: conversation.id,
        senderKind: "ai",
        direction: "outbound",
        text: "Вчера обсуждали WhatsApp. Удалось посмотреть?",
        createdAt: new Date(Date.now() - 60_000),
      },
    });
    await refreshConversationFollowUp(prisma, tenantId, conversation.id);
    let action = await prisma.scheduledAction.findFirst({
      where: { tenantId, parentId: conversation.id, type: "client_followup", state: "scheduled" },
    });
    assert.ok(action);
    await prisma.message.create({
      data: {
        tenantId,
        conversationId: conversation.id,
        senderKind: "client",
        direction: "inbound",
        text: "Да, видел",
      },
    });
    const processed = await processClientFollowUp(prisma, action);
    assert.equal(processed.skipped, "client_replied");
    action = await prisma.scheduledAction.findUniqueOrThrow({ where: { id: action.id } });
    assert.equal(action.state, "canceled");
    assert.equal(action.cancelReason, "client_replied");
  });

  it("does not send follow-up after human takeover or closed deal", async () => {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const current = parseAIAutomationSettings(tenant.settingsJson);
    current.followUp.enabled = true;
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { settingsJson: mergeAIAutomationIntoSettingsJson(tenant.settingsJson, current) as never },
    });
    const contact = await prisma.contact.create({ data: { tenantId, name: "Сделка закрыта" } });
    const conversation = await prisma.conversation.create({
      data: { tenantId, contactId: contact.id, mode: "human", status: "open", attentionReason: "CLIENT_REQUESTED_HUMAN" },
    });
    await prisma.message.create({
      data: {
        tenantId,
        conversationId: conversation.id,
        senderKind: "ai",
        direction: "outbound",
        text: "Напомню завтра",
      },
    });
    const action = await prisma.scheduledAction.create({
      data: {
        tenantId,
        type: "client_followup",
        parentType: "conversation",
        parentId: conversation.id,
        dueAt: new Date(Date.now() - 1000),
        state: "scheduled",
        payloadJson: { attempt: 1 },
      },
    });
    const handed = await processClientFollowUp(prisma, action);
    assert.equal(handed.skipped, "handed_to_human");

    const openConversation = await prisma.conversation.create({
      data: { tenantId, contactId: contact.id, mode: "ai", status: "open" },
    });
    await prisma.message.create({
      data: {
        tenantId,
        conversationId: openConversation.id,
        senderKind: "ai",
        direction: "outbound",
        text: "Жду ответ",
      },
    });
    const stages = await prisma.dealStage.findMany({ where: { tenantId }, take: 1 });
    assert.ok(stages[0], "seed pipeline");
    await prisma.deal.create({
      data: {
        tenantId,
        contactId: contact.id,
        title: "Закрытая",
        stageId: stages[0].id,
        outcome: "lost",
      },
    });
    const closedAction = await prisma.scheduledAction.create({
      data: {
        tenantId,
        type: "client_followup",
        parentType: "conversation",
        parentId: openConversation.id,
        dueAt: new Date(Date.now() - 1000),
        state: "scheduled",
        payloadJson: { attempt: 1 },
      },
    });
    const closed = await processClientFollowUp(prisma, closedAction);
    assert.equal(closed.skipped, "deal_closed");
  });

  it("keeps a due follow-up in the database across a simulated restart", async () => {
    const contact = await prisma.contact.create({ data: { tenantId, name: "Restart" } });
    const conversation = await prisma.conversation.create({
      data: { tenantId, contactId: contact.id, mode: "ai", status: "open" },
    });
    await prisma.message.create({
      data: {
        tenantId,
        conversationId: conversation.id,
        senderKind: "client",
        direction: "inbound",
        text: "Ок",
      },
    });
    const action = await prisma.scheduledAction.create({
      data: {
        tenantId,
        type: "client_followup",
        parentType: "conversation",
        parentId: conversation.id,
        dueAt: new Date(Date.now() - 5000),
        state: "scheduled",
        payloadJson: { attempt: 1 },
      },
    });
    const persisted = await prisma.scheduledAction.findUniqueOrThrow({ where: { id: action.id } });
    assert.equal(persisted.state, "scheduled");
    await processDueScheduledActions(prisma);
    const updated = await prisma.scheduledAction.findUniqueOrThrow({ where: { id: action.id } });
    assert.notEqual(updated.state, "scheduled");
    assert.ok(["canceled", "done", "failed", "running"].includes(updated.state));
  });

  it("does not leak company A settings into company B JSON", async () => {
    const b = await prisma.tenant.findUniqueOrThrow({ where: { id: otherTenantId } });
    const bSettings = parseAIAutomationSettings(b.settingsJson);
    assert.equal(bSettings.followUp.enabled, false);
    assert.equal(bSettings.conversationHours.mode, "always");
  });
});
