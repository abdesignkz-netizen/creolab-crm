import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { WhatsAppSellerBridge } from "@creolab/integrations";
import { ApiError } from "./errors.ts";
import type { AuthContext } from "./lib/types.ts";
import { encryptSecret } from "./lib/secretBox.ts";
import { resolveUploadPath } from "./lib/storage.ts";
import { addConversationMessage } from "./services/domainService.ts";
import { addCampaignAttachment, removeCampaignAttachment, processCampaignQueue, cancelCampaignRemainder, retryFailedCampaign, startCampaign } from "./services/campaignService.ts";
import { deliverQrMessage } from "./services/whatsappSendService.ts";
import { prepareLegacyMessage, deliverLegacyMessage, legacyCampaignKey, readLegacyDelivery, recoverLegacyMessage } from "./services/legacyMessageDelivery.ts";
import { claimLegacyRecipient, reconcileLegacyCampaign, retryableLegacyRecipients } from "./services/legacyCampaignDelivery.ts";

describe("Legacy manual and campaign delivery evidence", () => {
  let db: Awaited<ReturnType<typeof createPrismaClient>>, auth: AuthContext, tid: string, integrationId: string;
  let textCalls = 0, fileCalls = 0;
  let textSend: () => Promise<unknown>, fileSend: () => Promise<unknown>;
  const nativeFetch = globalThis.fetch;
  before(async () => {
    db = await createPrismaClient();
    const { seedDatabase } = await import("../../../packages/db/src/seed.ts"); await seedDatabase();
    const member = await db.membership.findFirstOrThrow({ where: { role: "owner", tenant: { slug: "creolab" } }, include: { user: true, tenant: true } });
    auth = { user: member.user, activeMembership: member, memberships: [member] } as AuthContext; tid = member.tenantId;
    const existing = await db.integration.findFirst({ where: { tenantId: tid, type: "whatsapp_seller" } });
    const data = { status: "active", connectionStatus: "CONNECTED", schemaJson: { sellerUrl: "https://seller.invalid", secretEnc: encryptSecret("synthetic-only") } };
    integrationId = (existing ? await db.integration.update({ where: { id: existing.id }, data })
      : await db.integration.create({ data: { tenantId: tid, type: "whatsapp_seller", name: "Test", ...data } })).id;
    globalThis.fetch = async () => { throw new Error("External calls forbidden in isolated test"); };
  });
  after(async () => { globalThis.fetch = nativeFetch; await db.$disconnect(); });
  beforeEach(() => {
    textCalls = 0; fileCalls = 0;
    textSend = async () => ({ ok: true, idMessage: `text-${textCalls}` });
    fileSend = async () => ({ ok: true, idMessage: `file-${fileCalls}` });
    mock.method(WhatsAppSellerBridge.prototype, "setMode", async () => ({ ok: true }));
    mock.method(WhatsAppSellerBridge.prototype, "sendText", async () => { textCalls++; return textSend(); });
    mock.method(WhatsAppSellerBridge.prototype, "sendFile", async () => { fileCalls++; return fileSend(); });
  });
  afterEach(() => mock.restoreAll());
  const code = (value: string) => (err: unknown) => err instanceof ApiError && err.code === value;
  const fileInput = (value = "same") => ({ fileName: "test.pdf", mimeType: "application/pdf", contentBase64: Buffer.from(value).toString("base64") });
  async function manual() {
    const contact = await db.contact.create({ data: { tenantId: tid, name: "Test recipient" } });
    const conv = await db.conversation.create({ data: { tenantId: tid, contactId: contact.id, sellerLeadId: randomUUID(), mode: "human" } });
    const input = { text: "Тестовое сообщение", idempotencyKey: randomUUID(), attachments: [fileInput()] };
    return { conv, input, send: () => addConversationMessage(db, auth, conv.id, input) };
  }
  async function campaign(fileCount = 1, recipientCount = 1) {
    const row = await db.campaign.create({ data: { tenantId: tid, title: "Isolated campaign", messageDraft: "Материалы", messageSnapshot: "Материалы",
      createdByMembershipId: auth.activeMembership!.id, createMissingClients: false } });
    const files = [];
    for (let i = 0; i < fileCount; i++) files.push(await addCampaignAttachment(db, auth, row.id, { ...fileInput(`file-${i}`), fileName: `${i}.pdf` }));
    const recipients = [];
    for (let i = 0; i < recipientCount; i++) {
      const f = await manual();
      const recipient = await db.campaignRecipient.create({ data: { tenantId: tid, campaignId: row.id, contactId: f.conv.contactId, status: "queued" } });
      recipients.push({ ...recipient, conv: f.conv });
    }
    await db.campaign.update({ where: { id: row.id }, data: { status: "running", confirmedAt: new Date(), confirmedById: auth.user.id } });
    return { row, files, recipients,
      tick: () => processCampaignQueue(db, row.id),
      recipient: () => db.campaignRecipient.findUniqueOrThrow({ where: { id: recipients[0].id } }),
      operation: () => db.outboundOperation.findUniqueOrThrow({ where: { tenantId_idempotencyKey: { tenantId: tid, idempotencyKey: legacyCampaignKey(row.id, recipients[0].id) } } }) };
  }
  async function expire(operationId: string) {
    const delivery = (await readLegacyDelivery(db, tid, operationId))!;
    delivery.leaseUntil = new Date(0).toISOString();
    await db.idempotencyRecord.update({ where: { scope_actorKey_key: { scope: "legacy.message.delivery", actorKey: tid, key: operationId } }, data: { resultJson: delivery as any } });
  }

  it("returns the exact original message, not the latest message, without repeating delivery", async () => {
    const f = await manual(); const first = await f.send();
    await addConversationMessage(db, auth, f.conv.id, { text: "Another", idempotencyKey: randomUUID() });
    const replay = await f.send(); assert.equal(replay.id, first.id); assert.equal(replay.operationState, "accepted");
    assert.equal(replay.attachments.length, 1); assert.equal(textCalls, 2); assert.equal(fileCalls, 1);
    const op = await db.outboundOperation.findFirstOrThrow({ where: { providerRef: first.id } });
    assert.equal(op.state, "accepted"); assert.ok(op.requestHash);
  });
  it("rejects reusing a key with same-size different file bytes", async () => {
    const f = await manual(); await f.send(); f.input.attachments = [fileInput("evil")];
    await assert.rejects(f.send(), code("idempotency_conflict")); assert.equal(textCalls, 1); assert.equal(fileCalls, 1);
  });
  it("scopes identical caller keys to each conversation", async () => {
    const a = await manual(), b = await manual(); b.input.idempotencyKey = a.input.idempotencyKey;
    assert.notEqual((await a.send()).id, (await b.send()).id); assert.equal(textCalls, 2);
  });
  it("rejects a foreign company and an absent channel without creating false success", async () => {
    const f = await manual(); const other = await db.tenant.create({ data: { name: "Other", slug: randomUUID() } });
    const foreign = await db.conversation.create({ data: { tenantId: other.id, mode: "human", sellerLeadId: randomUUID() } });
    await assert.rejects(addConversationMessage(db, auth, foreign.id, f.input), code("not_found"));
    await db.conversation.update({ where: { id: f.conv.id }, data: { sellerLeadId: null } });
    await assert.rejects(f.send(), code("channel_unavailable")); assert.equal(textCalls, 0);
    assert.equal(await db.message.count({ where: { conversationId: f.conv.id } }), 0);
  });
  it("does not silently truncate a sixth attachment", async () => {
    const f = await manual(); f.input.attachments = Array.from({ length: 6 }, () => fileInput());
    await assert.rejects(f.send(), code("too_many_files")); assert.equal(textCalls, 0);
  });
  it("keeps a lost file response unknown and never retries text or that file", async () => {
    const f = await manual(); fileSend = async () => { throw new Error("timeout after acceptance"); };
    const first = await f.send(); assert.equal(first.operationState, "unknown"); assert.equal(first.attachments[0].sendState, "unknown");
    assert.equal((await f.send()).id, first.id); assert.equal(textCalls, 1); assert.equal(fileCalls, 1);
    const op = await db.outboundOperation.findFirstOrThrow({ where: { providerRef: first.id } });
    assert.equal(op.state, "unknown");
    assert.equal((await readLegacyDelivery(db, tid, op.id))!.parts[0].state, "accepted");
  });
  it("treats a malformed provider response as unknown, not acceptance or retryable failure", async () => {
    const f = await manual(); textSend = async () => ({});
    assert.equal((await f.send()).operationState, "unknown"); await f.send(); assert.equal(textCalls, 1); assert.equal(fileCalls, 0);
  });
  it("serializes simultaneous manual sends using the same key", async () => {
    const f = await manual();
    const messages = await Promise.all([f.send(), f.send()]); assert.equal(messages[0].id, messages[1].id);
    assert.equal(textCalls, 1); assert.equal(fileCalls, 1); assert.equal(await db.message.count({ where: { conversationId: f.conv.id } }), 1);
  });
  it("replays only the known unsent file after a local read failure", async () => {
    const f = await manual();
    const op = await prepareLegacyMessage(db, { tenantId: tid, conversationId: f.conv.id, actorUserId: auth.user.id,
      key: randomUUID(), text: f.input.text, files: [{ fileName: "test.pdf", mimeType: "application/pdf", buffer: Buffer.from("restore-me") }] });
    const file = await db.attachment.findFirstOrThrow({ where: { messageId: op.providerRef } });
    await unlink(resolveUploadPath(file.storageKey));
    assert.equal((await deliverLegacyMessage(db, tid, op.id)).operationState, "partial");
    assert.equal(textCalls, 1); assert.equal(fileCalls, 0);
    await writeFile(resolveUploadPath(file.storageKey), "restore-me");
    assert.equal((await deliverLegacyMessage(db, tid, op.id)).operationState, "accepted");
    assert.equal(textCalls, 1); assert.equal(fileCalls, 1);
  });
  it("recovers an interrupted provider call as unknown instead of sending again", async () => {
    const f = await manual(); let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
    textSend = async () => { entered(); await gate; return { ok: true, idMessage: "accepted" }; };
    const first = f.send(); await Promise.race([started, first.then(() => { throw new Error("Did not reach provider"); })]);
    const op = await db.outboundOperation.findFirstOrThrow({ where: { conversationId: f.conv.id } });
    try { await expire(op.id); await recoverLegacyMessage(db, tid, op.id); }
    finally { release(); }
    await assert.rejects(first, code("delivery_changed"));
    assert.equal((await f.send()).operationState, "unknown"); assert.equal(textCalls, 1); assert.equal(fileCalls, 0);
  });
  it("stops the remaining file after a conversation changes mode", async () => {
    const f = await manual(); textSend = async () => {
      await db.conversation.update({ where: { id: f.conv.id }, data: { mode: "ai", controlVersion: { increment: 1 } } });
      return { ok: true, idMessage: "text" };
    };
    const result = await f.send(); assert.equal(result.operationState, "partial"); assert.equal(fileCalls, 0);
  });
  it("stops remaining parts when membership access is revoked", async () => {
    const f = await manual(); textSend = async () => {
      await db.membership.update({ where: { id: auth.activeMembership!.id }, data: { active: false } }); return { ok: true };
    };
    try { assert.equal((await f.send()).operationState, "partial"); assert.equal(fileCalls, 0); }
    finally { await db.membership.update({ where: { id: auth.activeMembership!.id }, data: { active: true } }); }
  });
  it("does not reroute remaining files to a changed bridge", async () => {
    const f = await manual(); const integration = await db.integration.findUniqueOrThrow({ where: { id: integrationId } });
    textSend = async () => {
      await db.integration.update({ where: { id: integrationId }, data: { schemaJson: { ...(integration.schemaJson as object), instanceId: "different" } } }); return { ok: true };
    };
    try { assert.equal((await f.send()).operationState, "partial"); assert.equal(fileCalls, 0); }
    finally { await db.integration.update({ where: { id: integrationId }, data: { schemaJson: integration.schemaJson as any } }); }
  });
  it("does not guess the outcome of an older untracked manual operation", async () => {
    const f = await manual(); await db.outboundOperation.create({ data: { tenantId: tid, conversationId: f.conv.id, idempotencyKey: f.input.idempotencyKey, controlVersion: 1 } });
    await assert.rejects(f.send(), code("delivery_untracked")); assert.equal(textCalls, 0);
  });

  it("stores separate campaign history and attachment states for each recipient", async () => {
    const f = await campaign(1, 2); await f.tick(); await f.tick(); assert.equal(textCalls, 2); assert.equal(fileCalls, 2);
    for (const recipient of f.recipients) {
      const current = await db.campaignRecipient.findUniqueOrThrow({ where: { id: recipient.id } }); assert.equal(current.status, "sent", current.error || "");
      const messages = await db.message.findMany({ where: { conversationId: recipient.conv.id }, include: { attachments: true } });
      assert.equal(messages.length, 1); assert.equal(messages[0].attachments[0].sendState, "sent");
    }
    assert.equal((await db.attachment.findUniqueOrThrow({ where: { id: f.files[0].id } })).sendState, "pending");
    assert.equal(await db.activity.count({ where: { type: "campaign.sent", contactId: { in: f.recipients.map(r => r.contactId!) } } }), 2);
  });
  it("campaign retry sends only the missing file and preserves the already accepted text", async () => {
    const f = await campaign(2); await unlink(resolveUploadPath(f.files[1].storageKey)); await f.tick();
    assert.equal((await f.recipient()).textSendState, "sent"); assert.equal((await f.recipient()).status, "failed");
    const safe = await retryableLegacyRecipients(db, tid, f.row.id); assert.deepEqual(safe, [f.recipients[0].id]);
    await writeFile(resolveUploadPath(f.files[1].storageKey), "file-1");
    await db.campaign.update({ where: { id: f.row.id }, data: { status: "running" } });
    await db.campaignRecipient.update({ where: { id: safe[0] }, data: { status: "queued" } }); await f.tick();
    assert.equal((await f.recipient()).status, "sent"); assert.equal(textCalls, 1); assert.equal(fileCalls, 2);
  });
  it("resumes the original personalized text after contact information changes", async () => {
    const f = await campaign();
    await db.campaign.update({ where: { id: f.row.id }, data: { messageDraft: "{{firstName}}, материалы", messageSnapshot: "{{firstName}}, материалы" } });
    await unlink(resolveUploadPath(f.files[0].storageKey)); await f.tick();
    const operation = await f.operation(), before = await db.message.findUniqueOrThrow({ where: { id: operation.providerRef! } });
    await db.contact.update({ where: { id: f.recipients[0].contactId! }, data: { name: "Другой вариант имени", firstName: "Другой" } });
    await writeFile(resolveUploadPath(f.files[0].storageKey), "file-0");
    await db.campaign.update({ where: { id: f.row.id }, data: { status: "running" } });
    await db.campaignRecipient.update({ where: { id: f.recipients[0].id }, data: { status: "queued" } }); await f.tick();
    assert.equal((await f.recipient()).status, "sent");
    assert.equal((await db.message.findUniqueOrThrow({ where: { id: before.id } })).text, before.text);
    assert.equal(textCalls, 1); assert.equal(fileCalls, 1);
  });
  it("does not continue an old partial send after the campaign confirmation changes", async () => {
    const f = await campaign(); await unlink(resolveUploadPath(f.files[0].storageKey)); await f.tick();
    await writeFile(resolveUploadPath(f.files[0].storageKey), "file-0");
    await db.campaign.update({ where: { id: f.row.id }, data: { status: "running", confirmedAt: new Date(Date.now() + 1000) } });
    await db.campaignRecipient.update({ where: { id: f.recipients[0].id }, data: { status: "queued" } }); await f.tick();
    assert.equal((await f.recipient()).status, "failed"); assert.equal(textCalls, 1); assert.equal(fileCalls, 0);
  });
  it("campaign timeout is unknown and excluded from retries", async () => {
    const f = await campaign(); fileSend = async () => { throw new Error("timeout"); }; await f.tick();
    assert.equal((await f.recipient()).status, "unknown"); assert.equal((await f.recipient()).textSendState, "sent");
    assert.deepEqual(await retryableLegacyRecipients(db, tid, f.row.id), []);
    await assert.rejects(retryFailedCampaign(db, auth, f.row.id), code("nothing_to_retry")); assert.equal(fileCalls, 1);
  });
  it("blocks blindly retrying failures from older versions without per-part evidence", async () => {
    const f = await campaign(); await db.campaignRecipient.update({ where: { id: f.recipients[0].id }, data: { status: "failed", textSendState: "sent" } });
    assert.deepEqual(await retryableLegacyRecipients(db, tid, f.row.id), []); assert.equal((await f.recipient()).status, "unknown");
    assert.equal(textCalls + fileCalls, 0);
  });
  it("allows retry after a recorded preflight failure before any send", async () => {
    const f = await campaign(); await db.conversation.update({ where: { id: f.recipients[0].conv.id }, data: { sellerLeadId: null } }); await f.tick();
    assert.equal((await f.recipient()).textSendState, "not_sent");
    assert.deepEqual(await retryableLegacyRecipients(db, tid, f.row.id), [f.recipients[0].id]); assert.equal(textCalls, 0);
  });
  it("cancellation between text and files stops the files and does not overwrite cancellation", async () => {
    const f = await campaign(1, 2); textSend = async () => { await cancelCampaignRemainder(db, auth, f.row.id); return { ok: true }; };
    await f.tick(); assert.equal(textCalls, 1); assert.equal(fileCalls, 0);
    assert.equal((await db.campaign.findUniqueOrThrow({ where: { id: f.row.id } })).status, "cancelled");
    await assert.rejects(retryFailedCampaign(db, auth, f.row.id), code("campaign_stopped"));
    await assert.rejects(startCampaign(db, auth, f.row.id), code("campaign_stopped"));
    assert.equal((await f.recipient()).textSendState, "sent");
  });
  it("simultaneous queue workers do not send a recipient twice", async () => {
    const f = await campaign(); await Promise.all([f.tick(), f.tick()]); assert.equal(textCalls, 1); assert.equal(fileCalls, 1);
  });
  it("recovers an expired preflight claim as unsent and an old untracked attempt as unknown", async () => {
    const f = await campaign(0, 2); await claimLegacyRecipient(db, tid, f.row.id, f.recipients[0].id);
    await db.idempotencyRecord.updateMany({ where: { scope: "legacy.campaign.claim", key: f.recipients[0].id }, data: { expiresAt: new Date(0) } });
    await db.campaignRecipient.update({ where: { id: f.recipients[1].id }, data: { status: "sending" } });
    await reconcileLegacyCampaign(db, tid, f.row.id);
    assert.equal((await f.recipient()).textSendState, "not_sent");
    assert.equal((await db.campaignRecipient.findUniqueOrThrow({ where: { id: f.recipients[1].id } })).status, "unknown");
    assert.equal(textCalls, 0);
  });
  it("retains files in message history when their campaign draft attachment is removed", async () => {
    const f = await campaign(); await f.tick();
    await removeCampaignAttachment(db, auth, f.row.id, f.files[0].id);
    assert.equal((await readFile(resolveUploadPath(f.files[0].storageKey))).toString(), "file-0");
    const op = await f.operation(); const message = await db.message.findUniqueOrThrow({ where: { id: op.providerRef! }, include: { attachments: true } });
    assert.equal(message.attachments.length, 1); assert.equal(message.attachments[0].sendState, "sent");
  });
  it("manual QR cancellation after text preserves partial evidence instead of claiming nothing was sent", async () => {
    const f = await manual();
    const integration = await db.integration.create({ data: { tenantId: tid, type: "whatsapp_qr", name: "Local test", status: "active", connectionStatus: "CONNECTED", schemaJson: { phone: "77012345678" } } });
    const connection = await db.channelConnection.create({ data: { tenantId: tid, integrationId: integration.id, channelType: "whatsapp", status: "active" } });
    await db.$executeRaw`INSERT INTO "WhatsAppQrSession" ("integrationId") VALUES (${integration.id})`;
    await db.conversation.update({ where: { id: f.conv.id }, data: { sellerLeadId: null, connectionId: connection.id, externalThreadId: "77015556677@s.whatsapp.net" } });
    const queued = await f.send(); let calls = 0;
    const socket = { user: { id: "77012345678:1@s.whatsapp.net" }, sendMessage: async () => { calls++; await db.conversation.update({ where: { id: f.conv.id }, data: { mode: "ai", controlVersion: { increment: 1 } } }); return { key: { id: "text-accepted" } }; } } as any;
    await deliverQrMessage(db, integration.id, socket, queued!.id, async () => {});
    const message = await db.message.findUniqueOrThrow({ where: { id: queued!.id }, include: { attachments: true } });
    assert.equal(calls, 1); assert.equal(message.operationState, "partial"); assert.equal(message.providerMessageId, "text-accepted");
    assert.equal(message.attachments[0].sendState, "pending");
    assert.equal((await db.outboundOperation.findFirstOrThrow({ where: { providerRef: message.id } })).state, "partial");
  });
});
