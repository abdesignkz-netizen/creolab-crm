import assert from "node:assert/strict";
import { randomBytes, createHash, createHmac, randomUUID } from "node:crypto";
import { before, after, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { config } from "./config.ts";
import { encryptSecret } from "./lib/secretBox.ts";
import { invalidateRuntimeConfig } from "./services/runtimeSettings.ts";
import { processWhatsAppAiReply } from "./services/whatsappAiService.ts";
import { deliverChannelMessage } from "./services/channelDeliveryService.ts";
import { resetRateLimits } from "./lib/rateLimit.ts";

describe("AI manager across messaging channels", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>, server: ReturnType<ReturnType<typeof createApp>["listen"]>;
  let base = "", cookie = "", tenantId = "", telegram = "", instagram = "", website = "", widgetKey = "";
  let sends = 0, failSend = false;
  const token = randomBytes(32).toString("hex"), nativeFetch = globalThis.fetch;
  const oldKey = process.env.OPENAI_API_KEY, oldBase = config.apiBaseUrl;
  const origin = "https://shop.example.test";
  before(async () => {
    process.env.OPENAI_API_KEY = "channel-test-only"; config.apiBaseUrl = "https://crm.example.test";
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith("http://127.0.0.1:")) return nativeFetch(url, init);
      if (String(url).startsWith("https://api.telegram.org/") || String(url).startsWith("https://graph.facebook.com/")) {
        sends++; if (failSend) throw new Error("network ambiguous");
        return new Response(JSON.stringify(String(url).includes("telegram.org") ? { ok: true, result: { message_id: sends } } : { message_id: `ig-${sends}` }));
      }
      throw new Error("Unexpected external request in isolated test");
    };
    prisma = await createPrismaClient(); const { seedDatabase } = await import("../../../packages/db/src/seed.ts"); await seedDatabase();
    tenantId = (await prisma.membership.findFirstOrThrow({ where: { user: { email: "owner@creolab.example" } } })).tenantId;
    await prisma.tenant.update({ where: { id: tenantId }, data: { settingsJson: { aiAutomation: { defaultMode: "AUTO" } } } });
    await prisma.aIConfiguration.updateMany({ where: { tenantId }, data: { enabled: true, promptStatus: "published", systemPrompt: "Помощник компании. Консультации." } }); invalidateRuntimeConfig();
    for (const type of ["telegram_bot", "instagram_direct"]) {
      const credential = await prisma.credential.create({ data: { tenantId, kind: type === "telegram_bot" ? type : "meta", scope: "integration", keyVersion: "test", encryptedValue: encryptSecret(type === "telegram_bot" ? "100000000:channel-test-token" : JSON.stringify({ accessToken: "test-token", appSecret: "test-meta-secret" })) } });
      const row = await prisma.integration.create({ data: { tenantId, type, name: type, status: "active", connectionStatus: "CONNECTED", credentialId: credential.id, secretHash: createHash("sha256").update("telegram-webhook").digest("hex"), schemaJson: type === "telegram_bot" ? {} : { accountId: "12345", pageId: "98765", apiVersion: "v25.0" } } });
      await prisma.channelConnection.create({ data: { tenantId, integrationId: row.id, channelType: type === "telegram_bot" ? "telegram" : "instagram", status: "active" } });
      if(type === "telegram_bot") telegram = row.id; else instagram = row.id;
    }
    server = createApp(prisma).listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address(); if(!address || typeof address === "string") throw new Error("port"); base = `http://127.0.0.1:${address.port}`;
    const login = await nativeFetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@creolab.example", password: process.env.SEED_PASSWORD }) }); assert.equal(login.status, 200); cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  });
  after(async () => { globalThis.fetch = nativeFetch; config.apiBaseUrl = oldBase; if(oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey; invalidateRuntimeConfig(); if(server) await new Promise<void>(resolve => server.close(() => resolve())); await prisma?.$disconnect(); });
  const call = (path: string, method = "GET", body?: unknown, headers: Record<string,string> = {}) => nativeFetch(`${base}${path}`, { method, headers: { cookie, "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const publicCall = (path: string, method = "GET", body?: unknown, from = origin, bearer = token) => call(`/public/chat/${widgetKey}${path}`, method, body, { cookie: "", Origin: from, Authorization: `Bearer ${bearer}` });
  let messageSeq = 1;
  async function inbound(type: "telegram" | "instagram", sender: string, text = "Здравствуйте, расскажите об услугах") {
    const seq = messageSeq++;
    if(type === "telegram") {
      const response = await call(`/public/integrations/telegram/${telegram}`, "POST", { update_id: seq, message: { message_id: seq, date: Math.floor(Date.now()/1000), chat: { id: Number(sender), type: "private" }, from: { id: Number(sender), first_name: "Покупатель" }, text } }, { "x-telegram-bot-api-secret-token": "telegram-webhook" }); assert.equal(response.status, 200, await response.clone().text()); return (await response.json()).conversationId as string;
    }
    const body = { object: "instagram", entry: [{ id: "12345", messaging: [{ sender: { id: sender }, recipient: { id: "12345" }, timestamp: Date.now(), message: { mid: `mid-${seq}`, text } }] }] };
    const signature = createHmac("sha256", "test-meta-secret").update(JSON.stringify(body)).digest("hex");
    const response = await call(`/public/integrations/meta/${instagram}`, "POST", body, { "x-hub-signature-256": `sha256=${signature}` }); assert.equal(response.status, 200, await response.text());
    return (await prisma.conversation.findFirstOrThrow({ where: { tenantId, externalThreadId: sender, connection: { integrationId: instagram } } })).id;
  }
  const event = (id: string) => prisma.outboxEvent.findFirstOrThrow({ where: { tenantId, entityId: id, type: "channel.ai_reply" }, orderBy: { availableAt: "desc" } });
  async function generate(id: string, reply = "Здравствуйте! Чем можем помочь?") { const job = await event(id); await processWhatsAppAiReply(prisma, job, async input => { assert.equal(input.tenantId, tenantId); return { reply, handoff: false }; }); return prisma.message.findFirstOrThrow({ where: { conversationId: id, senderKind: "ai" }, orderBy: { createdAt: "desc" } }); }

  it("requires per-channel opt-in and does not take existing human conversations", async () => {
    const old = await inbound("telegram", "1001"); assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: old } })).mode, "human");
    assert.equal((await call(`/api/v1/integrations/channels/${telegram}/ai`, "POST", { enabled: true })).status, 200);
    assert.equal((await call(`/api/v1/integrations/channels/${instagram}/ai`, "POST", { enabled: true })).status, 200);
    await inbound("telegram", "1001"); assert.equal(await prisma.outboxEvent.count({ where: { entityId: old, type: "channel.ai_reply" } }), 0);
    const id = await inbound("telegram", "1002"); assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id } })).mode, "ai");
    const message = await generate(id); const count = sends;
    await Promise.all([deliverChannelMessage(prisma, tenantId, message.id), deliverChannelMessage(prisma, tenantId, message.id)]);
    assert.equal(sends, count + 1); assert.equal((await prisma.message.findUniqueOrThrow({ where: { id: message.id } })).operationState, "accepted");
    const workspace = await (await call(`/api/v1/conversations/${id}`)).json(); assert.equal(workspace.conversation.aiAvailable, true);
  });
  it("Instagram uses AI, respects its reply length and 24-hour window", async () => {
    const id = await inbound("instagram", "2001"); const message = await generate(id); const count = sends;
    await deliverChannelMessage(prisma, tenantId, message.id); assert.equal(sends, count + 1);
    const long = await inbound("instagram", "2002"); await processWhatsAppAiReply(prisma, await event(long), async input => { assert.equal(input.maxReplyChars, 1000); return { reply: "а".repeat(1001), handoff: false }; });
    assert.equal(await prisma.message.count({ where: { conversationId: long, senderKind: "ai", operationState: "queued" } }), 0);
    assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: long } })).mode, "human");
    const late = await inbound("instagram", "2003"); const queued = await generate(late);
    await prisma.message.updateMany({ where: { conversationId: late, direction: "inbound" }, data: { createdAt: new Date(Date.now() - 25*3600000) } });
    await deliverChannelMessage(prisma, tenantId, queued.id); assert.equal(sends, count + 1); assert.equal((await prisma.message.findUniqueOrThrow({ where: { id: queued.id } })).operationState, "canceled");
  });
  it("a staff takeover cancels prepared replies; uncertain sends are not retried", async () => {
    const id = await inbound("telegram", "1003"), message = await generate(id), count = sends;
    await prisma.conversation.update({ where: { id }, data: { mode: "human", controlVersion: { increment: 1 } } });
    await deliverChannelMessage(prisma, tenantId, message.id); assert.equal(sends, count);
    const uncertain = await inbound("telegram", "1004"), pending = await generate(uncertain); failSend = true;
    await assert.rejects(() => deliverChannelMessage(prisma, tenantId, pending.id)); failSend = false;
    await deliverChannelMessage(prisma, tenantId, pending.id); assert.equal(sends, count + 1); assert.equal((await prisma.message.findUniqueOrThrow({ where: { id: pending.id } })).operationState, "unknown");
  });
  it("respects the audience, quiet hours and contact opt-out across channels", async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { settingsJson: { aiAutomation: { defaultMode: "AUTO", replyAudience: { audience: "new", since: new Date(Date.now() + 60000).toISOString() } } } } });
    for (const [type, sender] of [["telegram", "1010"], ["instagram", "2010"]] as const) assert.equal((await prisma.conversation.findUniqueOrThrow({ where: { id: await inbound(type, sender) } })).mode, "human");
    await prisma.tenant.update({ where: { id: tenantId }, data: { settingsJson: { aiAutomation: { defaultMode: "AUTO" } } } });
    const id = await inbound("telegram", "1011"), prepared = await generate(id), count = sends;
    const conv = await prisma.conversation.findUniqueOrThrow({ where: { id } });
    await prisma.contact.update({ where: { id: conv.contactId! }, data: { attributionJson: { doNotContact: true } } });
    await deliverChannelMessage(prisma, tenantId, prepared.id); assert.equal(sends, count);
    const quiet = await inbound("instagram", "2011");
    await prisma.tenant.update({ where: { id: tenantId }, data: { settingsJson: { aiAutomation: { defaultMode: "AUTO", conversationHours: { mode: "schedule", days: Object.fromEntries([0,1,2,3,4,5,6].map(day => [day, { enabled: false, start: "09:00", end: "18:00" }])), offHoursBehavior: "no_reply" } } } } });
    const quietEvent = await event(quiet);
    await assert.rejects(() => processWhatsAppAiReply(prisma, quietEvent), (error: any) => error.code === "ai_outside_hours");
  });
  it("creates a widget, rejects foreign origins and protects CRM mutation routes", async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { settingsJson: { aiAutomation: { defaultMode: "AUTO" } } } });
    const body = { enabled: true, title: "Компания", greeting: "Здравствуйте!", color: "#0065ca", origins: [origin] };
    const response = await call("/api/v1/integrations/website-chat", "PUT", body); assert.equal(response.status, 200, await response.clone().text()); const item = (await response.json()).item; website = item.id; widgetKey = item.publicKey;
    assert.match(item.snippet, /data-basqar=/);
    assert.equal((await publicCall("/config", "GET", undefined, "https://attacker.example.test")).status, 403);
    const preflight = await publicCall("/session", "OPTIONS"); assert.equal(preflight.status, 204); assert.equal(preflight.headers.get("access-control-allow-origin"), origin); assert.equal(preflight.headers.get("access-control-allow-credentials"), null);
    assert.equal((await call(`/api/v1/integrations/channels/${website}/ai`, "POST", { enabled: true }, { Origin: origin })).status, 403);
    assert.equal((await call(`/api/v1/integrations/channels/${website}/ai`, "POST", { enabled: true })).status, 200);
    assert.equal((await call("/api/v1/integrations/website-chat", "PUT", { ...body, origins: ["https://shop.example.test/path"] })).status, 422);
  });
  it("website sessions are idempotent, tenant-scoped and store only a token digest", async () => {
    resetRateLimits();
    const count = await prisma.conversation.count();
    const results = await Promise.all([publicCall("/session", "POST", {}), publicCall("/session", "POST", {})]); assert.ok(results.every(r => r.status === 200)); assert.equal(await prisma.conversation.count(), count + 1);
    const stored = await prisma.idempotencyRecord.findFirstOrThrow({ where: { scope: "website.session", actorKey: website } }); assert.ok(!JSON.stringify(stored).includes(token));
    assert.equal((await publicCall("/messages", "GET", undefined, origin, randomBytes(32).toString("hex"))).status, 401);
    const another = await prisma.tenant.findFirstOrThrow({ where: { id: { not: tenantId } } });
    const foreign = await prisma.integration.create({ data: { tenantId: another.id, type: "website_chat", name: "Foreign", status: "active", publicKey: randomUUID(), schemaJson: { origins: [origin] } } });
    assert.equal((await call(`/public/chat/${foreign.publicKey}/messages`, "GET", undefined, { Origin: origin, Authorization: `Bearer ${token}` })).status, 401);
    assert.equal((await call(`/api/v1/integrations/channels/${foreign.id}/ai`, "POST", { enabled: true })).status, 404);
  });
  it("website AI replies reach only the visitor; internal notes and queued messages stay private", async () => {
    const payload = { text: "Какие услуги есть?", idempotencyKey: randomUUID() };
    const first = await publicCall("/messages", "POST", payload); assert.equal(first.status, 200, await first.clone().text());
    assert.equal((await publicCall("/messages", "POST", payload)).status, 200);
    assert.equal((await publicCall("/messages", "POST", { ...payload, text: "Другое сообщение" })).status, 409);
    const session = await prisma.idempotencyRecord.findFirstOrThrow({ where: { scope: "website.session", actorKey: website } }); const id = (session.resultJson as { conversationId: string }).conversationId;
    assert.equal(await prisma.message.count({ where: { conversationId: id, direction: "inbound" } }), 1);
    await prisma.message.create({ data: { tenantId, conversationId: id, direction: "internal", senderKind: "staff", internal: true, text: "PRIVATE STAFF NOTE" } });
    const message = await generate(id, "Консультируем по услугам компании.");
    assert.ok(!(await (await publicCall("/messages")).text()).includes("Консультируем"));
    await deliverChannelMessage(prisma, tenantId, message.id);
    const visible = await (await publicCall("/messages")).text(); assert.ok(visible.includes("Консультируем")); assert.ok(!visible.includes("PRIVATE")); assert.ok(!visible.includes("tenantId"));
    await prisma.conversation.update({ where: { id }, data: { mode: "human", controlVersion: { increment: 1 } } });
    const reply = await call(`/api/v1/conversations/${id}/messages`, "POST", { text: "Здравствуйте, я менеджер", idempotencyKey: randomUUID() }); assert.equal(reply.status, 201, await reply.clone().text());
    assert.ok((await (await publicCall("/messages")).text()).includes("я менеджер"));
  });
  it("disabled widget and expired sessions cannot read or write", async () => {
    await prisma.idempotencyRecord.updateMany({ where: { scope: "website.session", actorKey: website }, data: { expiresAt: new Date(0) } });
    assert.equal((await publicCall("/messages")).status, 401);
    assert.equal((await publicCall("/session", "POST", {})).status, 401);
    await prisma.integration.update({ where: { id: website }, data: { status: "disabled" } });
    assert.equal((await publicCall("/messages")).status, 404);
  });
});
