import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { campaignSenderId, chooseCampaignSender, directCampaignKey } from "./services/campaignDelivery.ts";
import { processCampaignQueue } from "./services/campaignService.ts";
import { deliverQrMessage } from "./services/whatsappSendService.ts";

describe("campaign delivery through connected WhatsApp", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
  let base = "", cookie = "", tenantId = "", ownerMembershipId = "", qrId = "", connectionId = "";
  let counter = 100, sends = 0;
  const sentTo: string[] = [];
  const nativeFetch = globalThis.fetch;
  const socket = { user: { id: "77067301301:1@s.whatsapp.net" }, sendMessage: async (to: string) => {
    sends++; sentTo.push(to); return { key: { id: `campaign-test-${sends}` } };
  } } as any;
  async function api(path: string, method = "GET", body?: object) {
    const response = await fetch(`${base}/api/v1${path}`, {
      method, headers: { cookie, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  }
  async function createDraft(input: Record<string, unknown> = {}) {
    const contact = await prisma.contact.create({ data: {
      tenantId, name: `Campaign ${++counter}`, methods: { create: {
        type: "whatsapp", rawValue: `+77019990${counter}`, normalizedValue: `77019990${counter}`, primary: true, source: "test",
      } },
    } });
    const response = await api("/campaigns", "POST", {
      title: "Тест выбранного WhatsApp", messageMode: "manual", messageDraft: "Здравствуйте! Тестовое сообщение.",
      contactIds: [contact.id], ...input,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.campaign;
  }
  async function ready(input: Record<string, unknown> = {}) {
    const campaign = await createDraft(input);
    const confirmed = await api(`/campaigns/${campaign.id}/confirm`, "POST", {});
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    // Isolate one background tick deterministically. A separate test below starts through HTTP.
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: "running" } });
    await prisma.campaignRecipient.updateMany({ where: { campaignId: campaign.id }, data: { status: "queued" } });
    await processCampaignQueue(prisma, campaign.id);
    return campaign;
  }
  async function outbound(id: string) {
    const recipient = await prisma.campaignRecipient.findFirstOrThrow({ where: { campaignId: id } });
    assert.ok(recipient.conversationId, `Expected queued conversation: ${recipient.status}: ${recipient.error}`);
    const operation = await prisma.outboundOperation.findUnique({ where: { tenantId_idempotencyKey: {
      tenantId, idempotencyKey: `whatsapp:${recipient.conversationId}:${directCampaignKey(id, recipient.id)}`,
    } } });
    assert.ok(operation, `Expected queued operation: ${recipient.status}: ${recipient.error}`);
    return { recipient, operation };
  }
  before(async () => {
    globalThis.fetch = (url, init) => {
      if (new URL(String(url)).hostname !== "127.0.0.1") throw new Error("External provider calls forbidden in campaign tests");
      return nativeFetch(url, init);
    };
    prisma = await createPrismaClient();
    const { seedDatabase } = await import("../../../packages/db/src/seed.ts");
    await seedDatabase();
    const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: "creolab" } });
    tenantId = tenant.id;
    ownerMembershipId = (await prisma.membership.findFirstOrThrow({ where: { tenantId, user: { email: "owner@creolab.example" } } })).id;
    const qr = await prisma.integration.create({ data: {
      tenantId, type: "whatsapp_qr", name: "Номер компании", status: "active", connectionStatus: "CONNECTED",
      schemaJson: { phone: "77067301301" },
    } });
    qrId = qr.id;
    await prisma.$executeRaw`INSERT INTO "WhatsAppQrSession" ("integrationId") VALUES (${qrId})`;
    connectionId = (await prisma.channelConnection.create({ data: {
      tenantId, integrationId: qrId, channelType: "whatsapp", status: "active",
    } })).id;
    server = createApp(prisma).listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@creolab.example", password: process.env.SEED_PASSWORD }),
    });
    assert.equal(login.status, 200);
    cookie = login.headers.getSetCookie()[0].split(";")[0];
  });
  after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await prisma.$disconnect();
    globalThis.fetch = nativeFetch;
  });

  it("selects connected QR instead of the legacy Green API and exposes its phone", async () => {
    const result = await api("/campaigns/senders");
    assert.equal(result.status, 200);
    assert.ok(result.body.items.some((row: any) => row.id === qrId && row.phone === "77067301301"));
    assert.equal(await chooseCampaignSender(prisma, tenantId), qrId);
    assert.equal(campaignSenderId(await createDraft()), qrId);
    assert.equal(campaignSenderId({ parsedCommandJson: {} }), null, "Old campaigns retain their original route");
  });

  it("HTTP start queues one durable message; only provider acceptance marks it sent", async () => {
    const campaign = await createDraft();
    assert.equal((await api(`/campaigns/${campaign.id}/confirm`, "POST", {})).status, 200);
    assert.equal((await api(`/campaigns/${campaign.id}/start`, "POST")).status, 200);
    for (let i = 0; i < 100; i++) {
      if (await prisma.campaignRecipient.count({ where: { campaignId: campaign.id, conversationId: { not: null } } })) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    // Let the HTTP-triggered background tick finish before replaying it.
    await new Promise(resolve => setTimeout(resolve, 600));
    const { recipient, operation } = await outbound(campaign.id);
    assert.equal(recipient.status, "sending");
    assert.equal(recipient.sentAt, null);
    assert.equal(sends, 0);
    const message = await prisma.message.findUniqueOrThrow({ where: { id: operation.providerRef! } });
    assert.equal(message.operationState, "queued");
    assert.equal(await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM "WhatsAppQrJob" WHERE id = ${message.id}`.then(rows => Number(rows[0].count)), 1);
    await Promise.all([processCampaignQueue(prisma, campaign.id), processCampaignQueue(prisma, campaign.id)]);
    assert.equal(await prisma.outboundOperation.count({ where: { tenantId, idempotencyKey: operation.idempotencyKey } }), 1);
    await Promise.all([
      deliverQrMessage(prisma, qrId, socket, message.id, async () => {}),
      deliverQrMessage(prisma, qrId, socket, message.id, async () => {}),
    ]);
    assert.equal(sends, 1);
    assert.equal(sentTo[0], `${recipient.phoneNormalized}@s.whatsapp.net`);
    await processCampaignQueue(prisma, campaign.id);
    const finished = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id }, include: { recipients: true } });
    assert.equal(finished.status, "completed");
    assert.equal(finished.recipients[0].status, "sent");
    assert.ok(finished.recipients[0].sentAt);
  });

  it("does not re-take the conversation or send when an employee returns it to AI", async () => {
    const campaign = await ready();
    const { recipient, operation } = await outbound(campaign.id);
    await prisma.conversation.update({ where: { id: recipient.conversationId! }, data: { mode: "ai", controlVersion: { increment: 1 } } });
    const before = sends;
    await processCampaignQueue(prisma, campaign.id);
    assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: recipient.conversationId! } })).mode, "ai");
    await deliverQrMessage(prisma, qrId, socket, operation.providerRef!, async () => {});
    assert.equal(sends, before);
    assert.equal((await outbound(campaign.id)).recipient.status, "cancelled");
    await processCampaignQueue(prisma, campaign.id);
    assert.equal((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status, "cancelled");
  });

  it("concurrent ticks create only one contact and send for a newly imported phone", async () => {
    const campaign = await createDraft({ contactIds: [], phoneListText: "+77015558899", createMissingClients: true });
    assert.equal(campaign.recipients[0].contactId, null);
    assert.equal((await api(`/campaigns/${campaign.id}/confirm`, "POST", {})).status, 200);
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: "running" } });
    await prisma.campaignRecipient.updateMany({ where: { campaignId: campaign.id }, data: { status: "queued" } });
    await Promise.all([processCampaignQueue(prisma, campaign.id), processCampaignQueue(prisma, campaign.id)]);
    assert.equal(await prisma.contactMethod.count({ where: { tenantId, normalizedValue: "77015558899" } }), 1);
    const { recipient, operation } = await outbound(campaign.id);
    assert.equal(await prisma.message.count({ where: { tenantId, conversationId: recipient.conversationId! } }), 1);
    const before = sends;
    await deliverQrMessage(prisma, qrId, socket, operation.providerRef!, async () => {});
    assert.equal(sends, before + 1);
  });

  it("a paused queue resumes without losing recipients; cancellation blocks dispatch", async () => {
    const campaign = await ready();
    const { operation } = await outbound(campaign.id);
    assert.equal((await api(`/campaigns/${campaign.id}/pause`, "POST")).status, 200);
    const before = sends;
    assert.equal(await deliverQrMessage(prisma, qrId, socket, operation.providerRef!, async () => {}), "deferred");
    assert.equal(sends, before);
    assert.equal((await prisma.message.findUniqueOrThrow({ where: { id: operation.providerRef! } })).operationState, "queued");
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: "running" } });
    await deliverQrMessage(prisma, qrId, socket, operation.providerRef!, async () => {});
    assert.equal(sends, before + 1);
    const cancelled = await ready();
    const queued = await outbound(cancelled.id);
    assert.equal((await api(`/campaigns/${cancelled.id}/cancel-remainder`, "POST")).status, 200);
    await deliverQrMessage(prisma, qrId, socket, queued.operation.providerRef!, async () => {});
    assert.equal(sends, before + 1);
    assert.equal((await outbound(cancelled.id)).recipient.status, "cancelled");
  });

  it("does not retry an ambiguous provider result", async () => {
    const campaign = await ready();
    const { operation } = await outbound(campaign.id);
    let attempts = 0;
    const uncertain = { ...socket, sendMessage: async () => { attempts++; throw new Error("connection lost after sending"); } } as any;
    await assert.rejects(() => deliverQrMessage(prisma, qrId, uncertain, operation.providerRef!, async () => {}), /не подтвердил/);
    await processCampaignQueue(prisma, campaign.id);
    await processCampaignQueue(prisma, campaign.id);
    await deliverQrMessage(prisma, qrId, uncertain, operation.providerRef!, async () => {});
    assert.equal(attempts, 1);
    assert.equal((await outbound(campaign.id)).recipient.status, "unknown");
    assert.equal((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status, "failed");
    assert.equal((await api(`/campaigns/${campaign.id}/retry-failed`, "POST")).status, 409);
  });

  it("resumes personalized content after one recipient has already been sent", async () => {
    const campaign = await ready({ phoneListText: "+77014448899", messageDraft: "{{firstName}}, здравствуйте!", personalizeEach: true });
    const recipients = await prisma.campaignRecipient.findMany({ where: { campaignId: campaign.id } });
    assert.equal(recipients.length, 2);
    const messages = await prisma.message.findMany({ where: { conversationId: { in: recipients.map(row => row.conversationId!) } } });
    assert.equal(messages.length, 2);
    const before = sends;
    await deliverQrMessage(prisma, qrId, socket, messages[0].id, async () => {});
    assert.equal((await api(`/campaigns/${campaign.id}/pause`, "POST")).status, 200);
    const resume = await api(`/campaigns/${campaign.id}/start`, "POST");
    assert.equal(resume.status, 200, JSON.stringify(resume.body));
    await new Promise(resolve => setTimeout(resolve, 600));
    await deliverQrMessage(prisma, qrId, socket, messages[1].id, async () => {});
    await processCampaignQueue(prisma, campaign.id);
    assert.equal(sends, before + 2);
    assert.equal((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status, "completed");
  });

  it("checks permissions again at dispatch after a role changes", async () => {
    const campaign = await ready();
    const { operation } = await outbound(campaign.id);
    const membership = await prisma.membership.findUniqueOrThrow({ where: { id: ownerMembershipId } });
    const before = sends;
    try {
      await prisma.membership.update({ where: { id: ownerMembershipId }, data: { role: "manager" } });
      await deliverQrMessage(prisma, qrId, socket, operation.providerRef!, async () => {});
      assert.equal(sends, before);
      assert.equal((await outbound(campaign.id)).recipient.status, "cancelled");
    } finally {
      await prisma.membership.update({ where: { id: ownerMembershipId }, data: { role: membership.role } });
    }
  });

  it("reuses a verified LID conversation instead of creating a second phone thread", async () => {
    const campaign = await createDraft(), recipient = campaign.recipients[0], lid = "12345678901234@lid";
    const original = await prisma.conversation.create({ data: { tenantId, connectionId, contactId: recipient.contactId, externalThreadId: lid, mode: "human" } });
    await prisma.externalIdentity.createMany({ data: [lid, `${recipient.phoneNormalized}@s.whatsapp.net`].map(externalId => ({ tenantId, connectionId, integrationId: qrId, contactId: recipient.contactId, type: "whatsapp", externalId })) });
    assert.equal((await api(`/campaigns/${campaign.id}/confirm`, "POST", {})).status, 200);
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: "running" } });
    await prisma.campaignRecipient.updateMany({ where: { campaignId: campaign.id }, data: { status: "queued" } });
    await processCampaignQueue(prisma, campaign.id);
    const queued = await outbound(campaign.id);
    assert.equal(queued.recipient.conversationId, original.id);
    assert.equal(await prisma.conversation.count({ where: { tenantId, connectionId, contactId: recipient.contactId } }), 1);
    await deliverQrMessage(prisma, qrId, socket, queued.operation.providerRef!, async () => {});
    assert.equal(sentTo.at(-1), lid);
  });

  it("never routes to a different phone on the same contact", async () => {
    const campaign = await createDraft();
    const recipient = campaign.recipients[0];
    const other = await prisma.conversation.create({ data: {
      tenantId, connectionId, contactId: recipient.contactId, externalThreadId: "77019999999@s.whatsapp.net", mode: "ai",
    } });
    assert.equal((await api(`/campaigns/${campaign.id}/confirm`, "POST", {})).status, 200);
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: "running" } });
    await prisma.campaignRecipient.updateMany({ where: { campaignId: campaign.id }, data: { status: "queued" } });
    await processCampaignQueue(prisma, campaign.id);
    const queued = await outbound(campaign.id);
    assert.notEqual(queued.recipient.conversationId, other.id);
    await deliverQrMessage(prisma, qrId, socket, queued.operation.providerRef!, async () => {});
    assert.equal(sentTo.at(-1), `${recipient.phoneNormalized}@s.whatsapp.net`);
  });

  it("fails a disconnected chosen sender without silently using Green API", async () => {
    const campaign = await createDraft();
    assert.equal((await api(`/campaigns/${campaign.id}/confirm`, "POST", {})).status, 200);
    try {
      await prisma.integration.update({ where: { id: qrId }, data: { connectionStatus: "DISCONNECTED" } });
      await prisma.campaign.update({ where: { id: campaign.id }, data: { status: "running" } });
      await prisma.campaignRecipient.updateMany({ where: { campaignId: campaign.id }, data: { status: "queued" } });
      await processCampaignQueue(prisma, campaign.id);
      const recipient = await prisma.campaignRecipient.findFirstOrThrow({ where: { campaignId: campaign.id } });
      assert.equal(recipient.status, "failed");
      assert.match(recipient.error!, /WhatsApp не подключён/);
      assert.equal(recipient.conversationId, null);
    } finally {
      await prisma.integration.update({ where: { id: qrId }, data: { connectionStatus: "CONNECTED" } });
    }
  });

  it("rejects other tenants' senders and requires a choice when two numbers are connected", async () => {
    const foreign = await prisma.tenant.create({ data: { name: "Foreign campaign tenant", slug: "foreign-campaign-delivery" } });
    const foreignIntegration = await prisma.integration.create({ data: {
      tenantId: foreign.id, name: "Foreign", type: "whatsapp_qr", status: "active", connectionStatus: "CONNECTED",
    } });
    await assert.rejects(() => chooseCampaignSender(prisma, tenantId, foreignIntegration.id), /не подключён/);
    const second = await prisma.integration.create({ data: {
      tenantId, name: "Second", type: "whatsapp_qr", status: "active", connectionStatus: "CONNECTED",
    } });
    await prisma.channelConnection.create({ data: { tenantId, integrationId: second.id, channelType: "whatsapp", status: "active" } });
    try {
      await assert.rejects(() => chooseCampaignSender(prisma, tenantId), /Выберите номер/);
      assert.equal(await chooseCampaignSender(prisma, tenantId, second.id), second.id);
      const campaign = await createDraft({ whatsappIntegrationId: qrId });
      assert.equal((await api(`/campaigns/${campaign.id}/confirm`, "POST", {})).status, 200);
      const changed = await api(`/campaigns/${campaign.id}`, "PATCH", { whatsappIntegrationId: second.id });
      assert.equal(changed.status, 200, JSON.stringify(changed.body));
      assert.equal((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).confirmedAt, null);
      assert.equal((await api(`/campaigns/${campaign.id}/start`, "POST")).status, 409);
    } finally {
      await prisma.integration.update({ where: { id: second.id }, data: { status: "disabled" } });
    }
  });

  it("does not bypass the Cloud API 24-hour window or fall back to another transport", async () => {
    const cloud = await prisma.integration.create({ data: {
      tenantId, name: "Cloud", type: "whatsapp_cloud", status: "active", connectionStatus: "CONNECTED",
    } });
    await prisma.channelConnection.create({ data: { tenantId, integrationId: cloud.id, channelType: "whatsapp", status: "active" } });
    try {
      const campaign = await ready({ whatsappIntegrationId: cloud.id });
      const recipient = await prisma.campaignRecipient.findFirstOrThrow({ where: { campaignId: campaign.id } });
      assert.equal(recipient.status, "failed");
      assert.match(recipient.error!, /24 часа/);
      assert.equal(await prisma.message.count({ where: { conversationId: recipient.conversationId! } }), 0);
    } finally {
      await prisma.integration.update({ where: { id: cloud.id }, data: { status: "disabled" } });
    }
  });

  it("keeps accepted text and unsent file distinct when a campaign is cancelled", async () => {
    const campaign = await createDraft();
    const attachment = await api(`/campaigns/${campaign.id}/attachments`, "POST", {
      fileName: "proposal.txt", mimeType: "text/plain", contentBase64: Buffer.from("Test attachment").toString("base64"),
    });
    assert.equal(attachment.status, 201, JSON.stringify(attachment.body));
    assert.equal((await api(`/campaigns/${campaign.id}/confirm`, "POST", {})).status, 200);
    await prisma.campaign.update({ where: { id: campaign.id }, data: { status: "running" } });
    await prisma.campaignRecipient.updateMany({ where: { campaignId: campaign.id }, data: { status: "queued" } });
    await processCampaignQueue(prisma, campaign.id);
    const { operation } = await outbound(campaign.id);
    let calls = 0;
    const interrupt = { ...socket, sendMessage: async () => {
      calls++;
      await api(`/campaigns/${campaign.id}/cancel-remainder`, "POST");
      return { key: { id: "text-sent-before-cancel" } };
    } } as any;
    await deliverQrMessage(prisma, qrId, interrupt, operation.providerRef!, async () => {});
    await deliverQrMessage(prisma, qrId, interrupt, operation.providerRef!, async () => {});
    assert.equal(calls, 1);
    assert.equal((await outbound(campaign.id)).recipient.status, "failed");
    const partial = await prisma.message.findUniqueOrThrow({ where: { id: operation.providerRef! }, include: { attachments: true } });
    assert.equal(partial.operationState, "partial");
    assert.equal(partial.providerMessageId, "text-sent-before-cancel");
    assert.equal(partial.attachments[0].sendState, "pending");
  });
});
