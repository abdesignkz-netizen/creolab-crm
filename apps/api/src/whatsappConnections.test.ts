import assert from "node:assert/strict";
import { createHmac, createCipheriv, createHash, randomBytes } from "node:crypto";
import { getMediaKeys, proto } from "@whiskeysockets/baileys";
import { EventEmitter } from "node:events";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { config } from "./config.ts";
import { startWhatsAppQrRuntime, claimQrLease, databaseQrAuth, downloadQrMedia } from "./services/whatsappQrRuntime.ts";
import { getUsage, consumeResource } from "./services/billingResourceService.ts";
import { activateSubscription } from "./services/subscriptionActivationService.ts";
import { processWhatsAppAiReply, enqueueWhatsAppAi } from "./services/whatsappAiService.ts";
import { deliverCloudMessage } from "./services/whatsappSendService.ts";
import { invalidateRuntimeConfig } from "./services/runtimeSettings.ts";
import { recordExternalMessage } from "./services/externalMessageService.ts";
import { transcribeVoiceAttachment, voiceTranscript } from "./services/voiceTranscriptionService.ts";
import { attentionReasonLabel } from "./services/attentionReasons.ts";
import { getTranscriptionConfig, getTranscriptionStatus } from "./services/transcriptionConfig.ts";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { resolveUploadPath } from "./lib/storage.ts";
import { storeMessageAttachment } from "./services/conversationMedia.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("WhatsApp provider connections", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>, server: ReturnType<ReturnType<typeof createApp>["listen"]>;
  let base = "", cookie = "", cloudId = "", qrId = "", cloudConversation = "", qrConversation = "", tenantId = "";
  let runtime: ReturnType<typeof startWhatsAppQrRuntime> | undefined;
  const nativeFetch = globalThis.fetch, oldBase = config.apiBaseUrl;
  const appSecret = "test-whatsapp-app-secret-123456", accessToken = "test-whatsapp-access-token-123456";
  let sends = 0, qrSends = 0, logoutCount = 0, failQrSend = false;
  let mediaResponse = Buffer.alloc(0);
  let llmCalls = 0, llmStatus = 200, llmInput: any, llmAuthorization: string | null;
  let llmReason: string | undefined;
  let llmReply = "Сәлеметсіз бе! Компаниямыздың қызметтері туралы айтып беремін.";
  let voiceCalls = 0, voiceStatus = 200, voiceText = "Сәлеметсіз бе! Қызметтеріңіз туралы айтып беріңізші.";
  let voiceBody: string | undefined;
  let onTranscribe: (() => Promise<void>) | undefined;
  let onCloudSend: (() => Promise<void>) | undefined;
  const oldLlmKey = process.env.OPENAI_API_KEY, oldLlmUrl = process.env.OPENAI_BASE_URL;
  const oldAnyModelKey = process.env.ANYMODEL_API_KEY;
  const speechEnvNames = ["TRANSCRIPTION_ENGINE", "TRANSCRIPTION_PYTHON", "TRANSCRIPTION_MODEL_PATH", "TRANSCRIPTION_API_KEY", "TRANSCRIPTION_BASE_URL", "TRANSCRIPTION_MODEL", "ANYMODEL_BASE_URL"];
  const oldSpeechEnv = Object.fromEntries(speechEnvNames.map(key => [key, process.env[key]]));
  const speechKey = "speech-test-key-separate-from-chat";
  const authSnapshots: any[] = [];
  const sockets: Array<{ ev: EventEmitter; end: (error?: Error) => void }> = [];
  const fakeSocket = (options: any) => {
    authSnapshots.push(options.auth.creds);
    const ev = new EventEmitter();
    const socket = { ev, user: { id: "77010000001:1@s.whatsapp.net" }, end() {}, logout: async () => { logoutCount++; }, sendMessage: async () => { qrSends++; if (failQrSend) throw new Error("uncertain network result"); return { key: { id: `qr-sent-${qrSends}` } }; }, updateMediaMessage: async () => {} };
    sockets.push(socket); return socket as any;
  };
  before(async () => {
    config.apiBaseUrl = "https://bsqr.example.test";
    process.env.TRANSCRIPTION_ENGINE = "http";
    process.env.TRANSCRIPTION_API_KEY = speechKey;
    process.env.TRANSCRIPTION_BASE_URL = "https://speech.example.test/v1";
    process.env.TRANSCRIPTION_MODEL = "whisper-1";
    globalThis.fetch = async (url, init) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith("/audio/transcriptions")) {
        assert.equal(u.hostname, "speech.example.test", "Speech must never go to the company's chat endpoint");
        assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${speechKey}`);
        voiceCalls++;
        assert.ok(init?.body instanceof FormData);
        assert.equal(init.body.get("model"), "whisper-1");
        assert.equal(init.body.get("response_format"), "json");
        assert.equal(init.body.get("language"), null);
        const file = init.body.get("file") as File;
        assert.equal(file.name, "voice.ogg"); assert.equal(file.type, "audio/ogg");
        assert.ok(file.size > 0); assert.ok(init.signal); assert.equal(init.redirect, "error");
        const hook = onTranscribe; onTranscribe = undefined; await hook?.();
        if (voiceStatus === 0) throw new DOMException("Timed out", "TimeoutError");
        return new Response(voiceBody ?? JSON.stringify(voiceStatus === 200 ? { text: voiceText } : { error: "PRIVATE-VOICE-PROVIDER-ERROR" }), { status: voiceStatus, headers: { "x-request-id": `voice-${voiceCalls}` } });
      }
      if (u.hostname === "llm.example.test") { llmAuthorization = new Headers(init?.headers).get("authorization"); llmCalls++; llmInput = JSON.parse(String(init?.body)); if (llmStatus !== 200) return new Response(JSON.stringify({ error: { message: "PRIVATE-PROVIDER-ERROR" } }), { status: llmStatus }); return new Response(JSON.stringify({ id: `ai-request-${llmCalls}`, choices: [{ message: { content: JSON.stringify({ reply: llmReply, handoff: llmReason === "unclear_message", reason: llmReason }) } }], usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } }), { headers: { "content-type": "application/json" } }); }
      if (u.hostname === "mmg.whatsapp.net") { assert.equal(init?.redirect, "error"); assert.ok(init?.signal); return new Response(new Uint8Array(mediaResponse)); }
      if (u.hostname !== "graph.facebook.com") return nativeFetch(url, init);
      const reply = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
      if (u.pathname.endsWith("/debug_token")) return reply({ data: { app_id: "50001", is_valid: true } });
      if (u.pathname.endsWith("/phone_numbers")) return reply({ data: [{ id: "10001", display_phone_number: "+77010000002", platform_type: "CLOUD_API" }] });
      if (u.pathname.endsWith("/subscribed_apps")) return reply({ success: true });
      if (u.pathname.endsWith("/messages")) { sends++; const hook = onCloudSend; onCloudSend = undefined; await hook?.(); return reply({ messages: [{ id: `cloud-sent-${sends}` }] }); }
      throw new Error(`Unexpected request ${u.pathname}`);
    };
    prisma = await createPrismaClient();
    const { seedDatabase } = await import("../../../packages/db/src/seed.ts"); await seedDatabase();
    await new Promise<void>(resolve => { server = createApp(prisma).listen(0, "127.0.0.1", resolve); });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("port"); base = `http://127.0.0.1:${address.port}`;
    const login = await nativeFetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@creolab.example", password: process.env.SEED_PASSWORD }) });
    assert.equal(login.status, 200); cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    const member = await prisma.membership.findFirstOrThrow({ where: { user: { email: "owner@creolab.example" } } }); tenantId = member.tenantId;
  });
  after(async () => { await runtime?.stop(); globalThis.fetch = nativeFetch; config.apiBaseUrl = oldBase; if (oldLlmKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldLlmKey; if (oldLlmUrl === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = oldLlmUrl; if (oldAnyModelKey === undefined) delete process.env.ANYMODEL_API_KEY; else process.env.ANYMODEL_API_KEY = oldAnyModelKey; invalidateRuntimeConfig(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); await prisma?.$disconnect(); });
  after(() => { for (const [key, value] of Object.entries(oldSpeechEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) => nativeFetch(`${base}${path}`, { method: "POST", headers: { cookie, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const get = (path: string) => nativeFetch(`${base}${path}`, { headers: { cookie } });
  const connectInput = { appId: "50001", wabaId: "20001", phoneNumberId: "10001", accessToken, appSecret };
  const inbound = (mid: string, numberId = "10001", at = Date.now()) => ({ object: "whatsapp_business_account", entry: [{ id: "20001", changes: [{ field: "messages", value: { metadata: { phone_number_id: numberId }, contacts: [{ wa_id: "77012223344", profile: { name: "Cloud customer" } }], messages: [{ id: mid, from: "77012223344", timestamp: String(Math.floor(at / 1000)), type: "text", text: { body: "Добрый день" } }] } }] }] });
  const webhook = (body: unknown, secret = appSecret) => post(`/public/integrations/whatsapp-cloud/${cloudId}`, body, { "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(JSON.stringify(body)).digest("hex")}` });
  async function until(check: () => Promise<boolean>) { for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error("condition timed out"); }

  it("checks the WABA number and requires a verified webhook before activation", async () => {
    assert.equal((await post("/api/v1/integrations/whatsapp/cloud", { ...connectInput, phoneNumberId: "9999" })).status, 422);
    const response = await post("/api/v1/integrations/whatsapp/cloud", connectInput), body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); cloudId = body.id;
    assert.ok(body.verifyToken); assert.equal(body.connected, false);
    assert.equal((await post(`/api/v1/integrations/whatsapp/${cloudId}/activate`)).status, 409);
    assert.equal((await nativeFetch(`${base}/public/integrations/whatsapp-cloud/${cloudId}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=test`)).status, 403);
    const verified = await nativeFetch(`${base}/public/integrations/whatsapp-cloud/${cloudId}?hub.mode=subscribe&hub.verify_token=${body.verifyToken}&hub.challenge=test`); assert.equal(await verified.text(), "test");
    assert.equal((await post(`/api/v1/integrations/whatsapp/${cloudId}/activate`)).status, 200);
    const listing = await (await get("/api/v1/integrations/whatsapp")).text(); assert.ok(!listing.includes(accessToken)); assert.ok(!listing.includes(appSecret)); assert.ok(!listing.includes(body.verifyToken));
  });
  it("rejects forged webhooks and unrelated phone numbers; receives once", async () => {
    assert.equal((await webhook(inbound("forged"), "bad")).status, 401);
    assert.equal((await webhook(inbound("foreign", "9999"))).status, 200);
    assert.equal(await prisma.inboundEvent.count({ where: { integrationId: cloudId } }), 0);
    for (let i = 0; i < 2; i++) { const response = await webhook(inbound("cloud-1")); assert.equal(response.status, 200, await response.text()); }
    const conv = await prisma.conversation.findFirstOrThrow({ where: { connection: { integrationId: cloudId } } }); cloudConversation = conv.id;
    assert.equal(await prisma.message.count({ where: { conversationId: conv.id } }), 1);
    assert.equal(conv.mode, "human");
  });
  it("routes cloud replies with idempotency and enforces the 24-hour window", async () => {
    const path = `/api/v1/conversations/${cloudConversation}/messages`, headers = { "idempotency-key": "cloud-test" };
    const response = await post(path, { text: "Здравствуйте" }, headers); assert.equal(response.status, 201, await response.text());
    assert.equal((await post(path, { text: "Здравствуйте" }, headers)).status, 201); assert.equal(sends, 1);
    assert.equal((await post(path, { text: "Другой текст" }, headers)).status, 409);
    await prisma.message.updateMany({ where: { conversationId: cloudConversation, direction: "inbound" }, data: { createdAt: new Date(Date.now() - 86400001) } });
    assert.equal((await post(path, { text: "Поздний ответ" }, { "idempotency-key": "late" })).status, 409); assert.equal(sends, 1);
  });
  it("creates a QR session without Green API and keeps authentication encrypted", async () => {
    const response = await post("/api/v1/integrations/whatsapp/qr"), body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); qrId = body.id;
    assert.equal(await claimQrLease(prisma, qrId, "test-owner"), true); assert.equal(await claimQrLease(prisma, qrId, "other-owner"), false);
    const auth = await databaseQrAuth(prisma, qrId, "test-owner"); await auth.state.keys.set({ "lid-mapping": { test: "sensitive-value" } }); await auth.saveCreds();
    const restored = await databaseQrAuth(prisma, qrId, "test-owner"); assert.deepEqual(await restored.state.keys.get("lid-mapping", ["test"]), { test: "sensitive-value" });
    const keys = await prisma.$queryRaw<Array<{ encryptedValue: string }>>`SELECT "encryptedValue" FROM "WhatsAppQrKey" WHERE "integrationId" = ${qrId}`; assert.ok(keys.length); assert.ok(keys.every(row => !row.encryptedValue.includes("sensitive-value")));
    await assert.rejects(() => databaseQrAuth(prisma, qrId, "other-owner").then(auth => auth.saveCreds()));
    await prisma.$executeRaw`UPDATE "WhatsAppQrSession" SET owner = NULL, "leaseUntil" = NULL WHERE "integrationId" = ${qrId}`;
    runtime = startWhatsAppQrRuntime(prisma, fakeSocket); await until(async () => sockets.length > 0);
    sockets[0].ev.emit("connection.update", { qr: "private-pairing-code" });
    await until(async () => (await prisma.integration.findUniqueOrThrow({ where: { id: qrId } })).connectionStatus === "QR_READY");
    const qrResponse = await get(`/api/v1/integrations/whatsapp/${qrId}/qr`), qrBody = await qrResponse.json(); assert.match(qrBody.qr, /^data:image\/png;base64,/); assert.equal(qrResponse.headers.get("cache-control"), "no-store");
    assert.ok(!(await (await get("/api/v1/integrations/whatsapp")).text()).includes("private-pairing-code"));
    sockets[0].ev.emit("connection.update", { connection: "open" });
    await until(async () => (await prisma.integration.findUniqueOrThrow({ where: { id: qrId } })).status === "active");
    assert.equal((await (await get(`/api/v1/integrations/whatsapp/${qrId}/qr`)).json()).qr, null);
  });
  it("receives QR messages, filters groups, sends through the QR session and includes both providers in WhatsApp filter", async () => {
    const message = { key: { id: "qr-in-1", remoteJid: "77019998877@s.whatsapp.net", fromMe: false }, messageTimestamp: Math.floor(Date.now() / 1000), pushName: "QR customer", message: { conversation: "Здравствуйте" } };
    sockets[0].ev.emit("messages.upsert", { type: "notify", messages: [message, message, { ...message, key: { ...message.key, remoteJid: "123@g.us" } }] });
    await until(async () => (await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) as n FROM "WhatsAppQrJob" WHERE "integrationId" = ${qrId}`)[0].n > 0n);
    await runtime!.tick();
    const conv = await prisma.conversation.findFirstOrThrow({ where: { connection: { integrationId: qrId } } }); qrConversation = conv.id;
    assert.equal(await prisma.message.count({ where: { conversationId: conv.id, direction: "inbound" } }), 1);
    const response = await post(`/api/v1/conversations/${conv.id}/messages`, { text: "Ответ QR" }, { "idempotency-key": "qr-reply" }); assert.equal(response.status, 201, await response.text());
    await runtime!.tick(); assert.equal(qrSends, 1); assert.equal(sends, 1);
    const board = await (await get("/api/v1/conversations?channel=whatsapp")).json();
    assert.ok(JSON.stringify(board).includes(qrConversation)); assert.ok(JSON.stringify(board).includes(cloudConversation));
  });
  it("restores the QR identity after a runtime restart and never repeats an uncertain send", async () => {
    await runtime!.stop();
    runtime = startWhatsAppQrRuntime(prisma, fakeSocket); await until(async () => sockets.length === 2);
    assert.deepEqual(authSnapshots[1].signedIdentityKey, authSnapshots[0].signedIdentityKey);
    sockets[1].ev.emit("connection.update", { connection: "open" });
    await until(async () => (await prisma.integration.findUniqueOrThrow({ where: { id: qrId } })).connectionStatus === "CONNECTED");
    failQrSend = true;
    const path = `/api/v1/conversations/${qrConversation}/messages`, headers = { "idempotency-key": "uncertain-qr" };
    const response = await post(path, { text: "Проверка отправки" }, headers); assert.equal(response.status, 201); const message = await response.json();
    await runtime!.tick(); assert.equal(qrSends, 2);
    assert.equal((await prisma.message.findUniqueOrThrow({ where: { id: message.id } })).operationState, "unknown");
    assert.equal((await post(path, { text: "Проверка отправки" }, headers)).status, 201);
    await runtime!.tick(); assert.equal(qrSends, 2); failQrSend = false;
  });
  it("keeps the AI opt-in while setup is pending and reuses saved admin configuration when ready", async () => {
    const ai = await prisma.aIConfiguration.findFirstOrThrow({ where: { tenantId } });
    const original = { enabled: ai.enabled, promptStatus: ai.promptStatus, systemPrompt: ai.systemPrompt, credentialId: ai.credentialId };
    const knowledge = await prisma.knowledgeDocument.findMany({ where: { tenantId } });
    try {
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANYMODEL_API_KEY;
      await prisma.aIConfiguration.update({ where: { id: ai.id }, data: { enabled: true, promptStatus: "published", systemPrompt: "EXISTING-ADMIN-PROMPT", credentialId: null } });
      invalidateRuntimeConfig();
      const read = async () => (await (await get("/api/v1/integrations/whatsapp")).json()).items;
      assert.ok((await read()).every((item: any) => item.aiUnavailableReason === "ai_model_missing"));
      for (const id of [cloudId, qrId]) assert.equal((await post(`/api/v1/integrations/whatsapp/${id}/ai`, { enabled: true })).status, 200);
      assert.ok((await read()).every((item: any) => item.aiEnabled && !item.aiAvailable));
      const saved = await prisma.aIConfiguration.findUniqueOrThrow({ where: { id: ai.id } });
      assert.equal(saved.systemPrompt, "EXISTING-ADMIN-PROMPT");
      assert.deepEqual(await prisma.knowledgeDocument.findMany({ where: { tenantId } }), knowledge);
      // A new customer's opt-in must not produce a reply before setup is complete.
      await prisma.tenant.update({ where: { id: tenantId }, data: { settingsJson: { aiAutomation: { defaultMode: "AUTO" } } } });
      const event = inbound("pending-setup-inbound");
      event.entry[0].changes[0].value.contacts[0].wa_id = "77018889900";
      event.entry[0].changes[0].value.messages[0].from = "77018889900";
      assert.equal((await webhook(event)).status, 200);
      const message = await prisma.message.findFirstOrThrow({ where: { tenantId, providerMessageId: "pending-setup-inbound" }, include: { conversation: true } });
      assert.equal(message.conversation.mode, "human");
      assert.equal(await prisma.outboxEvent.count({ where: { entityId: message.conversationId, type: "whatsapp.ai_reply" } }), 0);
      assert.equal(llmCalls, 0);
      for (const [data, reason] of [
        [{ promptStatus: "draft" }, "ai_not_configured"],
        [{ promptStatus: "published", enabled: false }, "ai_disabled"],
      ] as const) {
        await prisma.aIConfiguration.update({ where: { id: ai.id }, data }); invalidateRuntimeConfig();
        assert.ok((await read()).every((item: any) => item.aiUnavailableReason === reason));
        assert.equal((await post(`/api/v1/integrations/whatsapp/${cloudId}/ai`, { enabled: true })).status, 200);
      }
      assert.equal((await prisma.aIConfiguration.findUniqueOrThrow({ where: { id: ai.id } })).enabled, false);
      process.env.OPENAI_API_KEY = "mock-key-not-real";
      await prisma.aIConfiguration.update({ where: { id: ai.id }, data: { enabled: true } }); invalidateRuntimeConfig();
      assert.ok((await read()).every((item: any) => item.aiEnabled && item.aiAvailable && !item.aiUnavailableReason));
      assert.equal((await prisma.aIConfiguration.findUniqueOrThrow({ where: { id: ai.id } })).systemPrompt, "EXISTING-ADMIN-PROMPT");
    } finally {
      await prisma.aIConfiguration.update({ where: { id: ai.id }, data: original });
      for (const id of [cloudId, qrId]) await post(`/api/v1/integrations/whatsapp/${id}/ai`, { enabled: false });
      invalidateRuntimeConfig();
    }
  });
  it("enables AI for both providers and uses published tenant context and the existing usage ledger", async () => {
    process.env.OPENAI_API_KEY = "mock-key-not-real"; process.env.OPENAI_BASE_URL = "https://llm.example.test/v1";
    const ai = await prisma.aIConfiguration.findFirst({ where: { tenantId } });
    const data = { enabled: true, promptStatus: "published", systemPrompt: "PUBLIC-COMPANY-PROMPT", draftPrompt: "PRIVATE-DRAFT" };
    if (ai) await prisma.aIConfiguration.update({ where: { id: ai.id }, data }); else await prisma.aIConfiguration.create({ data: { tenantId, ...data } });
    await prisma.knowledgeDocument.create({ data: { tenantId, title: "Services", content: "PUBLIC-KNOWLEDGE", status: "published" } });
    await prisma.knowledgeDocument.create({ data: { tenantId, title: "Draft", content: "PRIVATE-KNOWLEDGE", status: "draft" } });
    await prisma.tenant.update({ where: { id: tenantId }, data: { settingsJson: { aiAutomation: { defaultMode: "AUTO" } } } }); invalidateRuntimeConfig();
    for (const id of [cloudId, qrId]) { const response = await post(`/api/v1/integrations/whatsapp/${id}/ai`, { enabled: true }); assert.equal(response.status, 200, await response.text()); }
    const listing = await (await get("/api/v1/integrations/whatsapp")).json(); assert.ok(listing.items.every((item: any) => item.aiEnabled && item.aiAvailable));
    await webhook(inbound("ai-cloud-in"));
    await prisma.message.create({ data: { tenantId, conversationId: cloudConversation, senderKind: "staff", direction: "internal", internal: true, text: "PRIVATE-INTERNAL-NOTE" } });
    const response = await post(`/api/v1/conversations/${cloudConversation}/return-to-ai`); assert.equal(response.status, 200, await response.text());
    const event = await prisma.outboxEvent.findFirstOrThrow({ where: { entityId: cloudConversation, type: "whatsapp.ai_reply" }, orderBy: { availableAt: "desc" } });
    await processWhatsAppAiReply(prisma, event);
    assert.equal(llmCalls, 1); const prompt = JSON.stringify(llmInput); assert.match(prompt, /PUBLIC-COMPANY-PROMPT/); assert.match(prompt, /PUBLIC-KNOWLEDGE/); assert.doesNotMatch(prompt, /PRIVATE-DRAFT|PRIVATE-KNOWLEDGE|PRIVATE-INTERNAL-NOTE/);
    const usage = await prisma.aIUsageEvent.findFirstOrThrow({ where: { tenantId, conversationId: cloudConversation, feature: "AI_MANAGER_REPLY" } }); assert.equal(usage.integrationId, cloudId); assert.equal(usage.status, "ok");
    const message = await prisma.message.findUniqueOrThrow({ where: { connectionScopedId: event.id } }); assert.equal(message.senderKind, "ai"); assert.equal(message.senderUserId, null);
    const beforeSends = sends; await Promise.all([deliverCloudMessage(prisma, tenantId, cloudId, message.id), deliverCloudMessage(prisma, tenantId, cloudId, message.id)]); assert.equal(sends, beforeSends + 1);
    await processWhatsAppAiReply(prisma, event); assert.equal(llmCalls, 1);
    sockets[1].ev.emit("messages.upsert", { type: "notify", messages: [{ key: { id: "qr-ai-new", remoteJid: "77017776655@s.whatsapp.net" }, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: "Сәлеметсіз бе" } }] });
    await until(async () => (await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) as n FROM "WhatsAppQrJob" WHERE "integrationId" = ${qrId} AND kind = 'inbound'`)[0].n > 0n); await runtime!.tick();
    const qrEvent = await prisma.outboxEvent.findFirstOrThrow({ where: { tenantId, type: "whatsapp.ai_reply", entityId: { not: cloudConversation } }, orderBy: { availableAt: "desc" } });
    const qrConv = await prisma.conversation.findUniqueOrThrow({ where: { id: qrEvent.entityId } }); assert.equal(qrConv.mode, "ai");
    await processWhatsAppAiReply(prisma, qrEvent); const beforeQrSends = qrSends; await runtime!.tick(); assert.equal(qrSends, beforeQrSends + 1);
  });
  it("cancels an AI answer when a staff member takes over during generation", async () => {
    await webhook(inbound("ai-takeover-in"));
    const event = await prisma.outboxEvent.findFirstOrThrow({ where: { entityId: cloudConversation, type: "whatsapp.ai_reply" }, orderBy: { availableAt: "desc" } });
    let release: () => void = () => {}, entered: () => void = () => {};
    const started = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
    let generated = 0;
    const running = processWhatsAppAiReply(prisma, event, async () => { generated++; entered(); await wait; return { reply: "must not send", handoff: false }; });
    await started;
    await assert.rejects(() => processWhatsAppAiReply(prisma, event, async () => { generated++; return null; }), /ИИ готовит ответ/);
    const taken = await post(`/api/v1/conversations/${cloudConversation}/take`); assert.equal(taken.status, 200, await taken.text());
    release(); await running; assert.equal(generated, 1);
    assert.equal(await prisma.message.count({ where: { connectionScopedId: event.id } }), 0);
    assert.equal((await prisma.outboundOperation.findUniqueOrThrow({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: event.id } } })).state, "canceled");
  });
  it("rechecks the AI switch at dispatch and hands off explicit requests for a human", async () => {
    await webhook(inbound("ai-disable-in"));
    assert.equal((await post(`/api/v1/conversations/${cloudConversation}/return-to-ai`)).status, 200);
    let event = await prisma.outboxEvent.findFirstOrThrow({ where: { entityId: cloudConversation, type: "whatsapp.ai_reply" }, orderBy: { availableAt: "desc" } });
    await processWhatsAppAiReply(prisma, event, async () => ({ reply: "must be canceled", handoff: false }));
    const message = await prisma.message.findUniqueOrThrow({ where: { connectionScopedId: event.id } });
    assert.equal((await post(`/api/v1/integrations/whatsapp/${cloudId}/ai`, { enabled: false })).status, 200);
    const beforeSends = sends; await deliverCloudMessage(prisma, tenantId, cloudId, message.id); assert.equal(sends, beforeSends);
    assert.equal((await prisma.message.findUniqueOrThrow({ where: { id: message.id } })).operationState, "canceled");
    assert.equal((await post(`/api/v1/conversations/${cloudConversation}/return-to-ai`)).status, 409);
    await post(`/api/v1/integrations/whatsapp/${cloudId}/ai`, { enabled: true });
    const body = inbound("ai-human-request"); body.entry[0].changes[0].value.messages[0].text.body = "Менеджермен сөйлескім келеді"; await webhook(body);
    await post(`/api/v1/conversations/${cloudConversation}/return-to-ai`);
    event = await prisma.outboxEvent.findFirstOrThrow({ where: { entityId: cloudConversation, type: "whatsapp.ai_reply" }, orderBy: { availableAt: "desc" } });
    await processWhatsAppAiReply(prisma, event, async () => { assert.fail("Must not call AI on handoff"); });
    assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: cloudConversation } })).mode, "human");
  });
  it("supersedes a draft on new input and preserves input received during delivery", async () => {
    await webhook(inbound("ai-revision-first"));
    assert.equal((await post(`/api/v1/conversations/${cloudConversation}/return-to-ai`)).status, 200);
    const latestEvent = () => prisma.outboxEvent.findFirstOrThrow({ where: { entityId: cloudConversation, type: "whatsapp.ai_reply" }, orderBy: { availableAt: "desc" } });
    const first = await latestEvent();
    await processWhatsAppAiReply(prisma, first, async () => { await webhook(inbound("ai-revision-second")); return { reply: "obsolete answer", handoff: false }; });
    assert.equal(await prisma.message.count({ where: { connectionScopedId: first.id } }), 0);
    const second = await latestEvent(); assert.notEqual(first.id, second.id);
    await processWhatsAppAiReply(prisma, second, async () => ({ reply: "current answer", handoff: false }));
    const message = await prisma.message.findUniqueOrThrow({ where: { connectionScopedId: second.id } });
    onCloudSend = async () => { await webhook(inbound("ai-during-delivery")); };
    await deliverCloudMessage(prisma, tenantId, cloudId, message.id);
    const next = await latestEvent(), conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: cloudConversation } });
    assert.equal((next.payloadJson as any).messageRevision, conversation.messageRevision);
    assert.equal(conversation.waitingFor, "MANAGER");
    await processWhatsAppAiReply(prisma, next, async () => ({ reply: "answer to newest question", handoff: false }));
    const newest = await prisma.message.findUniqueOrThrow({ where: { connectionScopedId: next.id } });
    await deliverCloudMessage(prisma, tenantId, cloudId, newest.id);
    const count = await prisma.outboxEvent.count({ where: { entityId: cloudConversation, type: "whatsapp.ai_reply" } });
    await enqueueWhatsAppAi(prisma, tenantId, cloudConversation);
    assert.equal(await prisma.outboxEvent.count({ where: { entityId: cloudConversation, type: "whatsapp.ai_reply" } }), count);
  });
  it("respects quiet hours, AI pause and Meta's reply window before generation or dispatch", async () => {
    await webhook(inbound("ai-schedule"));
    let event = await prisma.outboxEvent.findFirstOrThrow({ where: { entityId: cloudConversation, type: "whatsapp.ai_reply" }, orderBy: { availableAt: "desc" } });
    const days = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(day => [day, { enabled: false, start: "09:00", end: "18:00" }]));
    await prisma.tenant.update({ where: { id: tenantId }, data: { settingsJson: { aiAutomation: { defaultMode: "AUTO", conversationHours: { mode: "schedule", days, offHoursBehavior: "no_reply" } } } } });
    await assert.rejects(() => processWhatsAppAiReply(prisma, event, async () => { assert.fail("No generation outside hours"); }), /рабочего времени/);
    await prisma.tenant.update({ where: { id: tenantId }, data: { settingsJson: { aiAutomation: { defaultMode: "AUTO" }, runtime: { aiPaused: true } } } });
    await processWhatsAppAiReply(prisma, event, async () => { assert.fail("No generation while paused"); });
    await prisma.tenant.update({ where: { id: tenantId }, data: { settingsJson: { aiAutomation: { defaultMode: "AUTO" } } } });
    await post(`/api/v1/conversations/${cloudConversation}/return-to-ai`);
    event = await prisma.outboxEvent.findFirstOrThrow({ where: { entityId: cloudConversation, type: "whatsapp.ai_reply" }, orderBy: { availableAt: "desc" } });
    await processWhatsAppAiReply(prisma, event, async () => ({ reply: "window must still be open", handoff: false }));
    const message = await prisma.message.findUniqueOrThrow({ where: { connectionScopedId: event.id } });
    await prisma.message.updateMany({ where: { conversationId: cloudConversation, direction: "inbound" }, data: { createdAt: new Date(Date.now() - 86400001) } });
    const beforeSends = sends; await deliverCloudMessage(prisma, tenantId, cloudId, message.id); assert.equal(sends, beforeSends);
    assert.equal((await prisma.message.findUniqueOrThrow({ where: { id: message.id } })).operationState, "canceled");
  });
  it("cancels queued staff replies after control changes even if the conversation returns to human mode", async () => {
    const reply = await post(`/api/v1/conversations/${qrConversation}/messages`, { text: "obsolete staff reply" }, { "idempotency-key": "staff-control-change" });
    assert.equal(reply.status, 201); const message = await reply.json();
    assert.equal((await post(`/api/v1/conversations/${qrConversation}/return-to-ai`)).status, 200);
    assert.equal((await post(`/api/v1/conversations/${qrConversation}/take`)).status, 200);
    const beforeSends = qrSends; await runtime!.tick();
    assert.equal(qrSends, beforeSends);
    assert.equal((await prisma.message.findUniqueOrThrow({ where: { id: message.id } })).operationState, "canceled");
  });
  it("surfaces a failed Meta delivery after sent and does not downgrade a delivered receipt", async () => {
    await webhook(inbound("ai-delivery-failure"));
    await post(`/api/v1/conversations/${cloudConversation}/return-to-ai`);
    const event = await prisma.outboxEvent.findFirstOrThrow({ where: { entityId: cloudConversation, type: "whatsapp.ai_reply" }, orderBy: { availableAt: "desc" } });
    await processWhatsAppAiReply(prisma, event, async () => ({ reply: "test delivery receipt", handoff: false }));
    const message = await prisma.message.findUniqueOrThrow({ where: { connectionScopedId: event.id } });
    await deliverCloudMessage(prisma, tenantId, cloudId, message.id);
    const sent = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    const receipt = (status: string) => webhook({ object: "whatsapp_business_account", entry: [{ id: "20001", changes: [{ field: "messages", value: { metadata: { phone_number_id: "10001" }, statuses: [{ id: sent.providerMessageId, status, timestamp: String(Math.floor(Date.now() / 1000)) }] } }] }] });
    assert.equal((await receipt("sent")).status, 200);
    assert.equal((await receipt("failed")).status, 200);
    const failed = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    assert.equal(failed.operationState, "failed"); assert.equal(failed.receiptState, "failed");
    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: cloudConversation } });
    assert.equal(conversation.needsAttention, true); assert.equal(conversation.mode, "human");
    await prisma.message.update({ where: { id: message.id }, data: { receiptState: "delivered", operationState: "accepted" } });
    await receipt("failed");
    assert.equal((await prisma.message.findUniqueOrThrow({ where: { id: message.id } })).receiptState, "delivered");
  });
  it("never generates replies without the plan entitlement or after Free credits run out", async () => {
    const beforeVoice = voiceCalls;
    for (const [planCode, used] of [["CRM_START", 0], ["BASQAR_FREE", 100], ["BASQAR_FREE", 99]] as const) {
      const company = await prisma.tenant.create({ data: { name: planCode, slug: `wa-ai-${planCode.toLowerCase()}-${used}`, status: "active", settingsJson: { aiAutomation: { defaultMode: "AUTO" } } } });
      await activateSubscription(prisma, { tenantId: company.id, planCode });
      const integration = await prisma.integration.create({ data: { tenantId: company.id, name: "Test QR", type: "whatsapp_qr", status: "active" } });
      const channel = await prisma.channelConnection.create({ data: { tenantId: company.id, integrationId: integration.id, channelType: "whatsapp", status: "active", autoReply: true } });
      const contact = await prisma.contact.create({ data: { tenantId: company.id, name: "Customer" } });
      const conversation = await prisma.conversation.create({ data: { tenantId: company.id, contactId: contact.id, connectionId: channel.id, mode: "ai", waitingFor: "MANAGER" } });
      const message = await prisma.message.create({ data: { tenantId: company.id, conversationId: conversation.id, direction: "inbound", senderKind: "client", text: "Здравствуйте" } });
      const ai = await prisma.aIConfiguration.findFirst({ where: { tenantId: company.id } });
      const data = { enabled: true, promptStatus: "published", systemPrompt: "Test company instructions" };
      if (ai) await prisma.aIConfiguration.update({ where: { id: ai.id }, data }); else await prisma.aIConfiguration.create({ data: { tenantId: company.id, ...data } });
      await storeMessageAttachment(prisma, { tenantId: company.id, messageId: message.id, fileName: "voice.ogg", mimeType: "audio/ogg", buffer: Buffer.from("OggS-voice-fixture") });
      if (planCode === "BASQAR_FREE") await consumeResource(prisma, company.id, "AI_CREDITS", used, "exhaust-trial");
      await enqueueWhatsAppAi(prisma, company.id, conversation.id, message.id);
      const event = await prisma.outboxEvent.findFirstOrThrow({ where: { entityId: conversation.id, type: "whatsapp.ai_reply" } });
      await processWhatsAppAiReply(prisma, event, async () => { assert.fail(`Must not generate for ${planCode}`); });
      assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).mode, "human");
      assert.equal(await prisma.message.count({ where: { conversationId: conversation.id, direction: "outbound" } }), 0);
      assert.equal(voiceCalls, beforeVoice);
    }
  });
  let voiceSequence = 0;
  it("answers a presentation discussion in QR and Cloud with conflict handoff enabled", async () => {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    await prisma.tenant.update({ where: { id: tenantId }, data: { settingsJson: {
      aiAutomation: { defaultMode: "AUTO", handoff: { afterMode: "assist", triggers: { COMPLAINT: true } } },
    } } });
    try {
      for (const integrationId of [qrId, cloudId]) {
        await post(`/api/v1/integrations/whatsapp/${integrationId}/ai`, { enabled: true });
        const id = `presentation-discussion-${integrationId}`;
        const recipient = integrationId === qrId ? "123456789012345@lid" : "77015550012";
        const text = "Здравствуйте, хочу обсудить разработку презентации";
        const result = await recordExternalMessage(prisma, integrationId, {
          eventId: id, channel: "whatsapp", externalUserId: recipient, threadId: recipient,
          messageId: id, name: "Presentation client", text, at: new Date(), raw: {},
        });
        const event = await prisma.outboxEvent.findFirstOrThrow({ where: { entityId: result.conversationId, type: "whatsapp.ai_reply" } });
        let generated = 0;
        const generate = async (input: any) => {
          generated++;
          assert.equal(input.history.at(-1).content, text);
          return { reply: "Здравствуйте! Какая тема и объём презентации?", handoff: false };
        };
        await processWhatsAppAiReply(prisma, event, generate);
        await processWhatsAppAiReply(prisma, event, generate);
        assert.equal(generated, 1);
        assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: event.entityId } })).mode, "ai");
        const reply = await prisma.message.findUniqueOrThrow({ where: { connectionScopedId: event.id } });
        assert.equal(reply.senderKind, "ai");
        assert.equal(reply.text, "Здравствуйте! Какая тема и объём презентации?");
        if (integrationId === qrId) {
          await until(async () => {
            await runtime!.tick();
            return (await prisma.message.findUniqueOrThrow({ where: { id: reply.id } })).operationState === "accepted";
          });
        } else {
          await deliverCloudMessage(prisma, tenantId, integrationId, reply.id);
          assert.equal((await prisma.message.findUniqueOrThrow({ where: { id: reply.id } })).operationState, "accepted");
        }
      }
    } finally {
      await prisma.tenant.update({ where: { id: tenantId }, data: { settingsJson: tenant.settingsJson as never } });
    }
  });
  async function voiceEvent(integrationId: string, options: { text?: string; mime?: string } = {}) {
    const id = `voice-test-${++voiceSequence}`;
    await post(`/api/v1/integrations/whatsapp/${integrationId}/ai`, { enabled: true });
    const result = await recordExternalMessage(prisma, integrationId, { eventId: id, channel: "whatsapp", externalUserId: id, threadId: id,
      messageId: id, name: "Voice test", text: options.text || "", at: new Date(), raw: {},
      attachments: [{ fileName: "whatsapp-voice", mimeType: options.mime || "audio/ogg; codecs=opus", buffer: Buffer.from("OggS-voice-fixture") }] });
    const event = await prisma.outboxEvent.findFirstOrThrow({ where: { tenantId, entityId: result.conversationId, type: "whatsapp.ai_reply" } });
    const file = await prisma.attachment.findFirstOrThrow({ where: { tenantId, message: { conversationId: event.entityId } } });
    return { event, file };
  }
  it("keeps speech credentials, endpoint and model independent of all reply configuration", () => {
    const independent = getTranscriptionConfig({ TRANSCRIPTION_ENGINE: "http", TRANSCRIPTION_API_KEY: "speech-only", TRANSCRIPTION_BASE_URL: "https://speech.example.test/v1", TRANSCRIPTION_MODEL: "speech-model" });
    assert.equal(independent.baseUrl, "https://speech.example.test/v1"); assert.equal(independent.model, "speech-model");
    assert.equal(independent.apiKey, "speech-only"); assert.equal(independent.errorCode, null);
    const local = getTranscriptionConfig({ OPENAI_API_KEY: "chat-only", ANYMODEL_API_KEY: "other-chat", TRANSCRIPTION_API_KEY: "old-external-key", TRANSCRIPTION_BASE_URL: "https://api.openai.com/v1" });
    assert.equal(local.engine, "local"); assert.equal(local.apiKey, ""); assert.equal(local.baseUrl, "");
    assert.equal(local.provider, "local");
    assert.equal(getTranscriptionConfig({ TRANSCRIPTION_ENGINE: "http" }).errorCode, "voice_service_config");
    for (const baseUrl of ["not a url", "http://speech.example.test/v1", "https://user:password@speech.example.test/v1", "https://speech.example.test/v1?key=secret", "https://speech.example.test/v1#secret"]) {
      assert.equal(getTranscriptionConfig({ TRANSCRIPTION_ENGINE: "http", TRANSCRIPTION_API_KEY: "speech-only", TRANSCRIPTION_MODEL: "speech-model", TRANSCRIPTION_BASE_URL: baseUrl }).errorCode, "voice_service_config");
    }
    assert.doesNotMatch(JSON.stringify(getTranscriptionStatus()), /speech-test-key|apiKey|baseUrl/);
  });
  it("transcribes separately then feeds text to AnyModel or OpenAI with their own reply credentials", async () => {
    const ai = await prisma.aIConfiguration.findFirstOrThrow({ where: { tenantId } });
    const original = { provider: ai.provider, model: ai.model, credentialId: ai.credentialId };
    const anyKey = process.env.ANYMODEL_API_KEY, anyUrl = process.env.ANYMODEL_BASE_URL;
    try {
      process.env.ANYMODEL_API_KEY = "anymodel-reply-only";
      process.env.ANYMODEL_BASE_URL = "https://llm.example.test/anymodel/v1";
      for (const [provider, model, key] of [["anymodel", "cx/gpt-5.6-sol", "anymodel-reply-only"], ["openai", "gpt-4o-mini", "mock-key-not-real"]]) {
        await prisma.aIConfiguration.update({ where: { id: ai.id }, data: { provider, model, credentialId: null } }); invalidateRuntimeConfig();
        const { event, file } = await voiceEvent(qrId);
        const beforeSpeech = voiceCalls;
        await processWhatsAppAiReply(prisma, event);
        assert.equal(voiceCalls, beforeSpeech + 1);
        assert.equal(llmInput.model, model); assert.equal(llmAuthorization, `Bearer ${key}`);
        const input = JSON.stringify(llmInput);
        assert.ok(input.includes(voiceText)); assert.match(input, /только на русском или казахском/); assert.match(input, /PUBLIC-COMPANY-PROMPT/); assert.match(input, /PUBLIC-KNOWLEDGE/);
        assert.doesNotMatch(input, /input_audio|data:audio|speech-test-key|OggS-voice-fixture/);
        const speechUsage = await prisma.aIUsageEvent.findFirstOrThrow({ where: { conversationId: event.entityId, feature: "AI_VOICE_TRANSCRIPTION" } });
        const replyUsage = await prisma.aIUsageEvent.findFirstOrThrow({ where: { conversationId: event.entityId, feature: "AI_MANAGER_REPLY" } });
        assert.equal(speechUsage.provider, "openai-compatible"); assert.equal(speechUsage.model, "whisper-1");
        assert.equal(replyUsage.provider, provider); assert.equal(replyUsage.model, model);
        assert.equal(await transcribeVoiceAttachment({ prisma, tenantId, conversationId: event.entityId, integrationId: qrId, attachmentId: file.id }), voiceText);
        assert.equal(voiceCalls, beforeSpeech + 1);
      }
    } finally {
      await prisma.aIConfiguration.update({ where: { id: ai.id }, data: original }); invalidateRuntimeConfig();
      if (anyKey === undefined) delete process.env.ANYMODEL_API_KEY; else process.env.ANYMODEL_API_KEY = anyKey;
      if (anyUrl === undefined) delete process.env.ANYMODEL_BASE_URL; else process.env.ANYMODEL_BASE_URL = anyUrl;
    }
  });
  it("does not send a Polish reply or feed a Polish transcript to AI", async () => {
    const originalReply = llmReply, originalVoice = voiceText;
    try {
      llmReply = "Nie jestem pewien, czy dobrze zrozumiałem wiadomość głosową.";
      const first = await voiceEvent(qrId);
      await processWhatsAppAiReply(prisma, first.event);
      assert.equal(await prisma.message.count({ where: { conversationId: first.event.entityId, direction: "outbound" } }), 1);
      assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: first.event.entityId } })).mode, "ai");
      assert.doesNotMatch((await prisma.message.findFirstOrThrow({ where: { conversationId: first.event.entityId, direction: "outbound" } })).text || "", /Nie jestem/);
      llmReply = originalReply;
      voiceText = "Potrzebuję strony internetowej dla mojej firmy.";
      const second = await voiceEvent(cloudId);
      const beforeReplies = llmCalls;
      await processWhatsAppAiReply(prisma, second.event);
      assert.equal(llmCalls, beforeReplies);
      assert.deepEqual((await prisma.attachment.findUniqueOrThrow({ where: { id: second.file.id } })).transcriptionJson, { status: "failed", errorCode: "voice_unsupported" });
      // Historical bad transcripts must not bypass validation or incur another recognition charge.
      await prisma.attachment.update({ where: { id: second.file.id }, data: { transcriptionJson: { status: "done", text: voiceText } } });
      const beforeSpeech = voiceCalls;
      await assert.rejects(() => transcribeVoiceAttachment({ prisma, tenantId, conversationId: second.event.entityId, integrationId: cloudId, attachmentId: second.file.id }), (error: any) => error.code === "voice_unsupported");
      assert.equal(voiceCalls, beforeSpeech);
    } finally { llmReply = originalReply; voiceText = originalVoice; }
  });
  it("clarifies an unclear transcript instead of pausing for low confidence", async () => {
    try {
      llmReason = "unclear_message";
      const { event } = await voiceEvent(qrId);
      await processWhatsAppAiReply(prisma, event);
      assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: event.entityId } })).mode, "ai");
      const reply = await prisma.message.findFirstOrThrow({ where: { connectionScopedId: event.id } });
      assert.match(reply.text || "", /Дауыстық хабарламаны түсіне алмадым/);
      assert.match(reply.text || "", /Не удалось разобрать голосовое/);
    } finally { llmReason = undefined; }
  });
  it("continues after failed Kazakh voice without return-to-ai and preserves takeover during failure", async () => {
    const oldBody = voiceBody;
    try {
      voiceBody = JSON.stringify({ text: "" });
      const { event } = await voiceEvent(qrId);
      await processWhatsAppAiReply(prisma, event);
      const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: event.entityId } });
      assert.equal(conversation.mode, "ai");
      const beforeSpeech = voiceCalls;
      voiceBody = undefined;
      await recordExternalMessage(prisma, qrId, { eventId: `clarify-${voiceSequence}`, channel: "whatsapp", externalUserId: conversation.externalThreadId!, threadId: conversation.externalThreadId!,
        messageId: `clarify-${voiceSequence}`, name: "Voice test", text: "Маған сайт керек. Бағасы қанша?", at: new Date(Date.now() + 1000), raw: {} });
      const next = await prisma.outboxEvent.findFirstOrThrow({ where: { entityId: event.entityId, type: "whatsapp.ai_reply", id: { not: event.id } } });
      await processWhatsAppAiReply(prisma, next);
      assert.equal(voiceCalls, beforeSpeech, "Old failed audio must not block or rebill the new text");
      assert.ok(JSON.stringify(llmInput).includes("Маған сайт керек"));
      assert.equal(await prisma.message.count({ where: { connectionScopedId: next.id } }), 1);
      assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: event.entityId } })).mode, "ai");
      const another = await voiceEvent(cloudId);
      voiceBody = JSON.stringify({ text: "" });
      onTranscribe = async () => { await prisma.conversation.update({ where: { id: another.event.entityId }, data: { mode: "human", controlVersion: { increment: 1 } } }); };
      await processWhatsAppAiReply(prisma, another.event);
      assert.equal(await prisma.message.count({ where: { connectionScopedId: another.event.id } }), 0);
    } finally { voiceBody = oldBody; onTranscribe = undefined; }
  });
  it("feeds local transcripts to the reply model for QR and Meta without any speech HTTP request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "basqar-local-speech-"));
    const old = Object.fromEntries(speechEnvNames.map(key => [key, process.env[key]]));
    const python = join(dir, "worker");
    try {
      for (const name of ["model.bin", "config.json", "tokenizer.json"]) await writeFile(join(dir, name), "fixture");
      await writeFile(join(dir, "basqar-profile.json"), JSON.stringify({ profile: "tiny" }));
      await writeFile(python, `#!/bin/sh\ncat >/dev/null\nprintf '{"text":"Хочу узнать стоимость услуг"}'\n`, { mode: 0o700 });
      process.env.TRANSCRIPTION_ENGINE = "local";
      process.env.TRANSCRIPTION_PYTHON = python; process.env.TRANSCRIPTION_MODEL_PATH = dir;
      delete process.env.TRANSCRIPTION_API_KEY;
      assert.equal(getTranscriptionStatus().model, "faster-whisper-tiny-int8");
      assert.equal(getTranscriptionStatus().requiredAvailableMiB, 768);
      await writeFile(join(dir, "basqar-profile.json"), JSON.stringify({ profile: "kaz-rus-turbo" }));
      assert.equal(getTranscriptionStatus().model, "whisper-turbo-kaz-rus-v1-int8");
      assert.equal(getTranscriptionStatus().requiredAvailableMiB, 4096);
      await writeFile(join(dir, "basqar-profile.json"), JSON.stringify({ profile: "kaz-rus-turbo-q5" }));
      assert.equal(getTranscriptionStatus().errorCode, "voice_service_config");
      await writeFile(join(dir, "speech-runner"), "fixture");
      assert.equal(getTranscriptionStatus().model, "whisper-turbo-kaz-rus-v1-q5");
      assert.equal(getTranscriptionStatus().requiredAvailableMiB, 1408);
      assert.equal(getTranscriptionStatus().configured, true);
      await writeFile(join(dir, "basqar-profile.json"), JSON.stringify({ profile: "tiny" }));
      const beforeSpeech = voiceCalls;
      for (const integrationId of [qrId, cloudId]) {
        const { event, file } = await voiceEvent(integrationId);
        await processWhatsAppAiReply(prisma, event);
        assert.equal(voiceCalls, beforeSpeech, "Local audio must never be sent to an external speech service");
        assert.match(JSON.stringify(llmInput), /Хочу узнать стоимость услуг/);
        assert.match(JSON.stringify(llmInput), /PUBLIC-COMPANY-PROMPT/);
        assert.doesNotMatch(JSON.stringify(llmInput), /OggS|input_audio|data:audio/);
        const usage = await prisma.aIUsageEvent.findFirstOrThrow({ where: { conversationId: event.entityId, feature: "AI_VOICE_TRANSCRIPTION" } });
        assert.equal(usage.provider, "local"); assert.equal(usage.model, "faster-whisper-tiny-int8"); assert.equal(usage.status, "ok");
        assert.equal(await transcribeVoiceAttachment({ prisma, tenantId, conversationId: event.entityId, integrationId, attachmentId: file.id }), "Хочу узнать стоимость услуг");
      }
      const { event, file } = await voiceEvent(qrId);
      await writeFile(python, `#!/bin/sh\nprintf '{"error":"voice_pending"}'\n`);
      await assert.rejects(() => processWhatsAppAiReply(prisma, event), (error: any) => error.code === "ai_generating");
      assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: event.entityId } })).mode, "ai");
      await writeFile(python, `#!/bin/sh\nprintf '{"error":"voice_resources"}'\n`);
      await processWhatsAppAiReply(prisma, event);
      assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: event.entityId } })).mode, "ai");
      assert.equal((await prisma.outboundOperation.findFirstOrThrow({ where: { idempotencyKey: event.id } })).error, "AI_VOICE_RESOURCES");
      assert.deepEqual((await prisma.attachment.findUniqueOrThrow({ where: { id: file.id } })).transcriptionJson, { status: "failed", errorCode: "voice_resources" });
    } finally {
      for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("does not fall back to chat credentials when the separate speech key is missing", async () => {
    const { event } = await voiceEvent(cloudId);
    const beforeSpeech = voiceCalls, beforeReply = llmCalls;
    try {
      delete process.env.TRANSCRIPTION_API_KEY;
      await processWhatsAppAiReply(prisma, event);
      assert.equal(voiceCalls, beforeSpeech); assert.equal(llmCalls, beforeReply);
      assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: event.entityId } })).mode, "ai");
      assert.equal((await prisma.outboundOperation.findFirstOrThrow({ where: { idempotencyKey: event.id } })).error, "AI_VOICE_SERVICE_MISSING");
    } finally { process.env.TRANSCRIPTION_API_KEY = speechKey; }
    const next = await voiceEvent(cloudId);
    await processWhatsAppAiReply(prisma, next.event);
    assert.equal(await prisma.message.count({ where: { connectionScopedId: next.event.id } }), 1);
  });
  it("restores protobuf media bytes after the durable QR queue and processes a real-shaped voice event", async () => {
    const mediaKey = randomBytes(32), keys = await getMediaKeys(mediaKey, "audio");
    const plain = Buffer.from("OggS-protobuf-voice-fixture");
    const cipher = createCipheriv("aes-256-cbc", keys.cipherKey, keys.iv);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    const mac = createHmac("sha256", keys.macKey).update(Buffer.concat([keys.iv, ciphertext])).digest().subarray(0, 10);
    mediaResponse = Buffer.concat([ciphertext, mac]);
    const message = proto.WebMessageInfo.fromObject({ key: { id: "qr-protobuf-voice", remoteJid: "77018887766@s.whatsapp.net" },
      messageTimestamp: Math.floor(Date.now() / 1000), message: { audioMessage: {
        url: "https://mmg.whatsapp.net/voice", directPath: "/voice", mediaKey,
        fileSha256: createHash("sha256").update(plain).digest(), fileEncSha256: createHash("sha256").update(mediaResponse).digest(),
        fileLength: plain.length, mimetype: "audio/ogg; codecs=opus", ptt: true,
      } } });
    // Actual Baileys protobuf objects encode binary fields as base64, unlike plain-object fixtures.
    assert.equal(typeof JSON.parse(JSON.stringify(message)).message.audioMessage.fileSha256, "string");
    sockets[1].ev.emit("messages.upsert", { type: "notify", messages: [message] });
    await until(async () => (await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) as n FROM "WhatsAppQrJob" WHERE "integrationId" = ${qrId} AND kind = 'inbound'`)[0].n > 0n);
    // A timer tick may already be processing this durable job. tick() then
    // returns immediately; wait for the stored result rather than that call.
    await until(async () => {
      await runtime!.tick();
      return Boolean(await prisma.message.findFirst({ where: { tenantId, providerMessageId: "qr-protobuf-voice" } }));
    });
    const stored = await prisma.message.findFirstOrThrow({ where: { tenantId, providerMessageId: "qr-protobuf-voice" }, include: { attachments: true } });
    assert.equal(stored.text, ""); assert.equal(stored.attachments.length, 1);
    assert.equal(stored.attachments[0].mimeType, "audio/ogg");
    assert.equal(stored.attachments[0].checksum, createHash("sha256").update(plain).digest("hex"));
    const event = await prisma.outboxEvent.findFirstOrThrow({ where: { entityId: stored.conversationId, type: "whatsapp.ai_reply" } });
    const before = voiceCalls;
    await processWhatsAppAiReply(prisma, event);
    assert.equal(voiceCalls, before + 1);
    assert.ok(JSON.stringify(llmInput).includes(voiceText));
    assert.equal(await prisma.message.count({ where: { connectionScopedId: event.id } }), 1);
  });
  it("shows a paused conversation consistently and resumes it while the number's AI remains enabled", async () => {
    const { event } = await voiceEvent(qrId);
    assert.equal((await post(`/api/v1/conversations/${event.entityId}/pause`)).status, 200);
    const workspace = await (await get(`/api/v1/conversations/${event.entityId}`)).json();
    assert.equal(workspace.conversation.mode, "paused");
    assert.equal(workspace.conversation.modeLabel, "AI на паузе");
    assert.equal(workspace.conversation.aiAvailable, true);
    const channel = await prisma.channelConnection.findFirstOrThrow({ where: { integrationId: qrId } }); assert.equal(channel.autoReply, true);
    assert.equal((await post(`/api/v1/conversations/${event.entityId}/return-to-ai`)).status, 200);
    const resumed = await prisma.conversation.findUniqueOrThrow({ where: { id: event.entityId } }); assert.equal(resumed.mode, "ai");
    const replyEvent = await prisma.outboxEvent.findFirstOrThrow({ where: { entityId: event.entityId, type: "whatsapp.ai_reply", id: { not: event.id } } });
    await processWhatsAppAiReply(prisma, replyEvent);
    assert.equal(await prisma.message.count({ where: { connectionScopedId: replyEvent.id } }), 1);
  });
  it("transcribes QR and Meta voice notes with company context, caches once and preserves the original", async () => {
    for (const integrationId of [qrId, cloudId]) {
      const { event, file } = await voiceEvent(integrationId);
      const beforeVoice = voiceCalls, beforeLlm = llmCalls;
      const beforeCredits = await getUsage(prisma, tenantId, "AI_CREDITS");
      await processWhatsAppAiReply(prisma, event);
      assert.equal(voiceCalls, beforeVoice + 1); assert.equal(llmCalls, beforeLlm + 1);
      assert.equal(await getUsage(prisma, tenantId, "AI_CREDITS"), beforeCredits + 2);
      const prompt = JSON.stringify(llmInput);
      assert.ok(prompt.includes(voiceText)); assert.match(prompt, /PUBLIC-COMPANY-PROMPT/); assert.match(prompt, /PUBLIC-KNOWLEDGE/);
      assert.doesNotMatch(prompt, /содержимое недоступно|PRIVATE-DRAFT|PRIVATE-INTERNAL-NOTE/);
      const saved = await prisma.attachment.findUniqueOrThrow({ where: { id: file.id } });
      assert.equal(voiceTranscript(saved.transcriptionJson), voiceText); assert.equal(saved.storageKey, file.storageKey);
      const source = await prisma.message.findUniqueOrThrow({ where: { id: file.messageId! } }); assert.equal(source.text, "");
      const usage = await prisma.aIUsageEvent.findMany({ where: { tenantId, conversationId: event.entityId } });
      assert.deepEqual(usage.map(row => row.feature).sort(), ["AI_MANAGER_REPLY", "AI_VOICE_TRANSCRIPTION"]);
      assert.ok(usage.every(row => row.status === "ok" && row.integrationId === integrationId));
      assert.equal(usage.find(row => row.feature === "AI_VOICE_TRANSCRIPTION")!.pricingMissing, true);
      await processWhatsAppAiReply(prisma, event);
      assert.equal(await transcribeVoiceAttachment({ prisma, tenantId, conversationId: event.entityId, integrationId, attachmentId: file.id }), voiceText);
      assert.equal(voiceCalls, beforeVoice + 1); assert.equal(llmCalls, beforeLlm + 1);
      const outgoing = await prisma.message.findUniqueOrThrow({ where: { connectionScopedId: event.id } });
      assert.equal(outgoing.senderKind, "ai"); assert.equal(outgoing.operationState, "queued");
      if (integrationId === cloudId) assert.equal(await prisma.outboxEvent.count({ where: { entityId: outgoing.id, type: "whatsapp.cloud_send" } }), 1);
      else assert.equal((await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) as n FROM "WhatsAppQrJob" WHERE id = ${outgoing.id}`)[0].n, 1n);
    }
  });
  it("respects human requests but asks for clarification without pausing AI on speech failures", async () => {
    const originalText = voiceText;
    try {
      voiceText = "Менеджермен сөйлескім келеді";
      const { event } = await voiceEvent(qrId);
      await processWhatsAppAiReply(prisma, event, async () => { assert.fail("Must hand off a spoken request for a human"); });
      assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: event.entityId } })).attentionReason, "CLIENT_REQUESTED_HUMAN");
      for (const [status, text, reason, code] of [
        [200, "", "AI_VOICE_EMPTY", "voice_empty"],
        [500, "", "AI_VOICE_PROVIDER_UNAVAILABLE", "voice_http_500"],
        [0, "", "AI_VOICE_TIMEOUT", "voice_timeout"],
        [400, "", "AI_VOICE_CONFIG", "voice_http_400"],
        [404, "", "AI_VOICE_CONFIG", "voice_http_404"],
        [413, "", "AI_VOICE_UNSUPPORTED", "voice_http_413"],
        [401, "", "AI_PROVIDER_AUTH", "voice_http_401"],
        [429, "", "AI_PROVIDER_LIMIT", "voice_http_429"],
      ] as const) {
        voiceStatus = status; voiceText = text;
        const { event, file } = await voiceEvent(cloudId);
        await processWhatsAppAiReply(prisma, event, async () => { assert.fail("Never invent an answer to unrecognised speech"); });
        const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: event.entityId } });
        assert.equal(conversation.mode, "ai");
        assert.equal((await prisma.outboundOperation.findFirstOrThrow({ where: { conversationId: event.entityId, idempotencyKey: event.id } })).error, reason);
        const saved = await prisma.attachment.findUniqueOrThrow({ where: { id: file.id } });
        assert.doesNotMatch(JSON.stringify(saved.transcriptionJson), /PRIVATE-VOICE/);
        const usage = await prisma.aIUsageEvent.findFirstOrThrow({ where: { conversationId: event.entityId, feature: "AI_VOICE_TRANSCRIPTION" } }); assert.equal(usage.status, "failed");
        assert.equal(usage.errorCode, code);
        assert.equal((saved.transcriptionJson as any).errorCode, code);
        assert.equal(await prisma.message.count({ where: { connectionScopedId: event.id } }), 1);
        const customerReply = await prisma.message.findUniqueOrThrow({ where: { connectionScopedId: event.id } });
        if (status === 0 || status === 500) {
          assert.match(customerReply.text!, /технического сбоя/);
          assert.doesNotMatch(customerReply.text!, /Не удалось разобрать/);
        } else if (code === "voice_empty") assert.match(customerReply.text!, /Не удалось разобрать/);
        await processWhatsAppAiReply(prisma, event);
        assert.equal(await prisma.message.count({ where: { connectionScopedId: event.id } }), 1);
      }
      for (const reason of ["AI_VOICE_UNAVAILABLE", "AI_VOICE_UNSUPPORTED", "AI_VOICE_EMPTY", "AI_VOICE_CONFIG", "AI_VOICE_TIMEOUT", "AI_VOICE_PROVIDER_UNAVAILABLE", "AI_VOICE_INVALID_RESPONSE"]) {
        const ru = attentionReasonLabel(reason, undefined, "ru");
        assert.notEqual(attentionReasonLabel(reason, undefined, "kk"), ru); assert.notEqual(attentionReasonLabel(reason, undefined, "en"), ru);
      }
    } finally { voiceText = originalText; voiceStatus = 200; }
  });
  it("distinguishes invalid provider responses and retries a stored voice after the service recovers", async () => {
    try {
      for (const body of ["<html>PRIVATE provider error</html>", JSON.stringify({ error: "PRIVATE invalid response" }), JSON.stringify({ text: "x".repeat(12001) })]) {
        voiceBody = body;
        const { event, file } = await voiceEvent(qrId);
        await processWhatsAppAiReply(prisma, event, async () => { assert.fail("Invalid transcription must not generate a reply"); });
        assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: event.entityId } })).mode, "ai");
        assert.deepEqual((await prisma.attachment.findUniqueOrThrow({ where: { id: file.id } })).transcriptionJson, { status: "failed", errorCode: "voice_invalid_response" });
        voiceBody = undefined;
        // Stored audio remains available for an explicit retry after service repair.
        assert.equal(await transcribeVoiceAttachment({ prisma, tenantId, conversationId: event.entityId, integrationId: qrId, attachmentId: file.id }), voiceText);
        assert.equal(voiceTranscript((await prisma.attachment.findUniqueOrThrow({ where: { id: file.id } })).transcriptionJson), voiceText);
      }
    } finally { voiceBody = undefined; }
  });
  it("blocks foreign attachments, unsafe paths, missing files, oversized and unsupported audio before provider calls", async () => {
    const { event, file } = await voiceEvent(qrId);
    const input = { prisma, tenantId, conversationId: event.entityId, integrationId: qrId, attachmentId: file.id };
    const before = voiceCalls;
    await assert.rejects(() => transcribeVoiceAttachment({ ...input, tenantId: "other-tenant" }));
    await assert.rejects(() => transcribeVoiceAttachment({ ...input, conversationId: cloudConversation }));
    await assert.rejects(() => transcribeVoiceAttachment({ ...input, integrationId: cloudId }));
    await prisma.attachment.update({ where: { id: file.id }, data: { storageKey: "../../.env" } });
    await assert.rejects(() => transcribeVoiceAttachment(input));
    await prisma.attachment.update({ where: { id: file.id }, data: { storageKey: file.storageKey, sizeBytes: 17 * 1024 * 1024 } });
    await assert.rejects(() => transcribeVoiceAttachment(input), (error: any) => error.code === "voice_too_large");
    await prisma.attachment.update({ where: { id: file.id }, data: { sizeBytes: file.sizeBytes, mimeType: "audio/amr" } });
    await processWhatsAppAiReply(prisma, event, async () => { assert.fail("Unsupported voice must not reach the reply model"); });
    assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: event.entityId } })).mode, "ai");
    await prisma.attachment.update({ where: { id: file.id }, data: { mimeType: file.mimeType } });
    await writeFile(resolveUploadPath(file.storageKey), Buffer.alloc(17 * 1024 * 1024));
    await assert.rejects(() => transcribeVoiceAttachment(input), (error: any) => error.code === "voice_too_large");
    await unlink(resolveUploadPath(file.storageKey));
    await assert.rejects(() => transcribeVoiceAttachment(input), (error: any) => error.code === "voice_unavailable");
    assert.equal(voiceCalls, before);
  });
  it("does not duplicate transcription across workers and stops answering after takeover during recognition", async () => {
    const { event, file } = await voiceEvent(qrId);
    let release: () => void = () => {}, entered: () => void = () => {};
    const started = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
    onTranscribe = async () => { entered(); await wait; };
    const before = voiceCalls;
    const running = processWhatsAppAiReply(prisma, event, async () => { assert.fail("Staff already took over"); });
    await started;
    try {
      // CPU recognition can legitimately take longer than the old two-minute
      // stale-claim threshold. A duplicate worker must not pause it or bill twice.
      await prisma.outboundOperation.updateMany({ where: { idempotencyKey: event.id }, data: { createdAt: new Date(Date.now() - 180000) } });
      const held = await prisma.attachment.findUniqueOrThrow({ where: { id: file.id } });
      const claim = held.transcriptionJson as Record<string, any>;
      await prisma.attachment.update({ where: { id: file.id }, data: { transcriptionJson: { ...claim, startedAt: Date.now() - 180000 } } });
      await assert.rejects(() => processWhatsAppAiReply(prisma, event), /ИИ готовит ответ/);
      await assert.rejects(() => transcribeVoiceAttachment({ prisma, tenantId, conversationId: event.entityId, integrationId: qrId, attachmentId: file.id }), (error: any) => error.code === "voice_pending");
      await prisma.attachment.update({ where: { id: file.id }, data: { transcriptionJson: held.transcriptionJson! } });
      assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: event.entityId } })).mode, "ai");
      assert.equal((await post(`/api/v1/conversations/${event.entityId}/take`)).status, 200);
    } finally { release(); await running; }
    assert.equal(voiceCalls, before + 1);
    assert.equal(await prisma.message.count({ where: { connectionScopedId: event.id } }), 0);
    assert.equal((await prisma.outboundOperation.findUniqueOrThrow({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: event.id } } })).state, "canceled");
  });
  it("includes an earlier voice note when text arrives during recognition without recognising it twice", async () => {
    const { event, file } = await voiceEvent(cloudId);
    const source = await prisma.message.findUniqueOrThrow({ where: { id: file.messageId! } });
    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: event.entityId } });
    const before = voiceCalls;
    let nextEvent: typeof event | undefined;
    onTranscribe = async () => {
      await recordExternalMessage(prisma, cloudId, { eventId: `voice-burst-${voiceSequence}`, channel: "whatsapp", externalUserId: conversation.externalThreadId!, threadId: conversation.externalThreadId!,
        messageId: `voice-burst-${voiceSequence}`, name: "Voice test", text: "И ещё один вопрос", at: new Date(source.createdAt.getTime() + 1000), raw: {} });
      nextEvent = await prisma.outboxEvent.findFirstOrThrow({ where: { entityId: event.entityId, type: "whatsapp.ai_reply", id: { not: event.id } } });
      await assert.rejects(() => processWhatsAppAiReply(prisma, nextEvent!), /распознаёт/);
    };
    await processWhatsAppAiReply(prisma, event, async () => { assert.fail("The incoming text superseded this reply"); });
    assert.ok(nextEvent);
    await processWhatsAppAiReply(prisma, nextEvent);
    assert.equal(voiceCalls, before + 1);
    const prompt = JSON.stringify(llmInput); assert.ok(prompt.includes(voiceText)); assert.match(prompt, /И ещё один вопрос/);
    assert.equal(await prisma.message.count({ where: { connectionScopedId: event.id } }), 0);
    assert.equal(await prisma.message.count({ where: { connectionScopedId: nextEvent.id } }), 1);
  });
  it("reports model failures safely for direct channels without sending a customer message", async () => {
    const channel = await prisma.channelConnection.findFirstOrThrow({ where: { integrationId: qrId } });
    const contact = await prisma.contact.create({ data: { tenantId, name: "Model error test" } });
    try {
      for (const [status, reason] of [[401, "AI_PROVIDER_AUTH"], [429, "AI_PROVIDER_LIMIT"], [400, "AI_PROVIDER_CONFIG"]] as const) {
        llmStatus = status;
        const conversation = await prisma.conversation.create({ data: { tenantId, contactId: contact.id, connectionId: channel.id, mode: "ai", waitingFor: "MANAGER" } });
        const message = await prisma.message.create({ data: { tenantId, conversationId: conversation.id, direction: "inbound", senderKind: "client", text: "Здравствуйте" } });
        await enqueueWhatsAppAi(prisma, tenantId, conversation.id, message.id);
        const event = await prisma.outboxEvent.findFirstOrThrow({ where: { entityId: conversation.id, type: "whatsapp.ai_reply" } });
        await processWhatsAppAiReply(prisma, event);
        const result = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
        assert.equal(result.mode, "human"); assert.equal(result.attentionReason, reason);
        assert.equal(await prisma.message.count({ where: { conversationId: result.id, direction: "outbound" } }), 0);
        const operation = await prisma.outboundOperation.findUniqueOrThrow({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: event.id } } });
        assert.equal(operation.state, "failed");
        assert.doesNotMatch(JSON.stringify(operation), /PRIVATE-PROVIDER-ERROR/);
      }
    } finally { llmStatus = 200; }
  });
  it("lets only platform admins test a model and lists QR and Meta readiness without exposing keys", async () => {
    const path = `/api/v1/admin/tenants/${tenantId}/ai-manager/test`;
    assert.equal((await post(path)).status, 403);
    const login = await nativeFetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "platform@creolab.example", password: process.env.SEED_PASSWORD }) });
    assert.equal(login.status, 200);
    const adminCookie = (login.headers.get("set-cookie") || "").split(";")[0];
    assert.equal((await get("/api/v1/admin/settings")).status, 403);
    const serviceSettings = await nativeFetch(`${base}/api/v1/admin/settings`, { headers: { cookie: adminCookie } });
    assert.equal(serviceSettings.status, 200);
    const serviceBody = await serviceSettings.json();
    assert.deepEqual(serviceBody.transcription, { engine: "http", model: "whisper-1", provider: "openai-compatible", configured: true, errorCode: null });
    assert.doesNotMatch(JSON.stringify(serviceBody), /speech-test-key|speech.example.test|apiKey/);
    const saveSettings = await nativeFetch(`${base}/api/v1/admin/settings`, { method: "PATCH", headers: { cookie: adminCookie, "content-type": "application/json" },
      body: JSON.stringify({ transcription: { apiKey: "must-not-save", model: "must-not-change" } }) });
    assert.equal(saveSettings.status, 200);
    assert.deepEqual((await saveSettings.json()).transcription, serviceBody.transcription);
    assert.doesNotMatch(JSON.stringify(await prisma.platformSetting.findUnique({ where: { key: "defaults" } })), /must-not-save|must-not-change/);
    const listing = await nativeFetch(`${base}/api/v1/admin/tenants/${tenantId}/ai-manager`, { headers: { cookie: adminCookie } });
    const data = await listing.json(); assert.equal(listing.status, 200);
    assert.ok(data.connections.some((item: any) => item.type === "whatsapp_qr"));
    assert.ok(data.connections.some((item: any) => item.type === "whatsapp_cloud"));
    assert.equal(data.runtime.hasCredential, true);
    assert.doesNotMatch(JSON.stringify(data), /mock-key-not-real|test-whatsapp-access-token/);
    const beforeSends = sends + qrSends;
    const beforeMessages = await prisma.message.count({ where: { tenantId } });
    const result = await post(path, {}, { cookie: adminCookie });
    assert.equal(result.status, 200); assert.equal((await result.json()).ok, true);
    try {
      llmStatus = 401;
      const failed = await post(path, {}, { cookie: adminCookie });
      const failure = await failed.json(); assert.equal(failure.ok, false); assert.equal(failure.reason, "AI_PROVIDER_AUTH");
      assert.doesNotMatch(JSON.stringify(failure), /PRIVATE-PROVIDER-ERROR/);
    } finally { llmStatus = 200; }
    assert.equal(sends + qrSends, beforeSends);
    assert.equal(await prisma.message.count({ where: { tenantId } }), beforeMessages);
  });
  it("denies access to another company's QR and disconnects without deleting conversation history", async () => {
    const other = await prisma.tenant.create({ data: { name: "Other company", slug: "other-company-wa", status: "active" } });
    const foreign = await prisma.integration.create({ data: { tenantId: other.id, name: "QR", type: "whatsapp_qr", status: "pending" } });
    assert.equal((await get(`/api/v1/integrations/whatsapp/${foreign.id}/qr`)).status, 404);
    assert.equal((await post(`/api/v1/integrations/whatsapp/${foreign.id}/disconnect`)).status, 404);
    assert.equal((await post(`/api/v1/integrations/whatsapp/${foreign.id}/ai`, { enabled: true })).status, 404);
    const before = await getUsage(prisma, tenantId, "WHATSAPP_CONNECTIONS"); assert.ok(before >= 2);
    assert.equal((await post(`/api/v1/integrations/whatsapp/${qrId}/disconnect`)).status, 200);
    // A background tick may already be in progress; wait for the durable
    // disconnect job instead of assuming this tick invocation ran it.
    await until(async () => { await runtime!.tick(); return logoutCount === 1; });
    assert.equal(logoutCount, 1);
    assert.equal((await get(`/api/v1/integrations/whatsapp/${qrId}/qr`)).status, 404);
    assert.ok(await prisma.message.count({ where: { conversationId: qrConversation } }));
    assert.equal(await getUsage(prisma, tenantId, "WHATSAPP_CONNECTIONS"), before - 1);
    assert.equal((await post(`/api/v1/integrations/whatsapp/${cloudId}/disconnect`)).status, 200);
    assert.equal((await webhook(inbound("after-disconnect"))).status, 403);
    assert.equal(await getUsage(prisma, tenantId, "WHATSAPP_CONNECTIONS"), before - 2);
  });
  it("applies one atomic number quota across Green API, QR and Cloud API", async () => {
    const tenant = await prisma.tenant.create({ data: { name: "Quota test", slug: "whatsapp-quota", status: "active" } });
    await prisma.tenantUsage.create({ data: { tenantId: tenant.id, period: "2026-10", limitsJson: { WHATSAPP_CONNECTIONS: 1 }, countersJson: {} } });
    const green = await prisma.integration.create({ data: { tenantId: tenant.id, type: "whatsapp_seller", name: "Green", status: "active", connectionStatus: "CONNECTED" } });
    for (const type of ["whatsapp_qr", "whatsapp_cloud"]) await assert.rejects(() => prisma.integration.create({ data: { tenantId: tenant.id, type, name: type, status: "pending", connectionStatus: "PENDING" } }), /BASQAR_LIMIT/);
    await prisma.integration.update({ where: { id: green.id }, data: { status: "disabled", connectionStatus: "DISCONNECTED" } });
    const attempts = await Promise.allSettled(["whatsapp_qr", "whatsapp_cloud"].map(type => prisma.integration.create({ data: { tenantId: tenant.id, type, name: type, status: "pending", connectionStatus: "PENDING" } })));
    assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(await getUsage(prisma, tenant.id, "WHATSAPP_CONNECTIONS"), 1);
  });
  it("validates encrypted QR media and rejects arbitrary URLs before fetching", async () => {
    const mediaKey = randomBytes(32), keys = await getMediaKeys(mediaKey, "image"), plain = Buffer.from("test media content");
    const cipher = createCipheriv("aes-256-cbc", keys.cipherKey, keys.iv);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    const mac = createHmac("sha256", keys.macKey).update(Buffer.concat([keys.iv, encrypted])).digest().subarray(0, 10);
    mediaResponse = Buffer.concat([encrypted, mac]);
    const media = { url: "https://mmg.whatsapp.net/image", mediaKey, fileSha256: createHash("sha256").update(plain).digest(), fileEncSha256: createHash("sha256").update(mediaResponse).digest() };
    assert.deepEqual(await downloadQrMedia(media, "image"), plain);
    mediaResponse[0] ^= 1;
    await assert.rejects(() => downloadQrMedia(media, "image"), /hash/);
    for (const url of ["http://127.0.0.1/image", "https://mmg.whatsapp.net.evil.test/image", "https://user:pass@mmg.whatsapp.net/image"]) await assert.rejects(() => downloadQrMedia({ ...media, url }, "image"), /host/);
    await assert.rejects(() => downloadQrMedia({ ...media, directPath: "//127.0.0.1/image" }, "image"), /path/);
  });
});
