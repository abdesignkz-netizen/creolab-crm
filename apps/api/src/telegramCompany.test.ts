import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { config } from "./config.ts";

describe("company Telegram integration", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
  let base = "", cookie = "", integrationId = "", secret = "", conversationId = "";
  const token = "123456789:abcdefghijklmnopqrstuvwxyz123456789";
  const nativeFetch = globalThis.fetch;
  const oldApiBase = config.apiBaseUrl;
  let webhookUrl = "", sendCount = 0, failSend = false;
  const providerCalls: string[] = [];
  before(async () => {
    config.apiBaseUrl = "https://crm.example.test";
    globalThis.fetch = async (url, init) => {
      const address = String(url);
      if (!address.startsWith("https://api.telegram.org/")) return nativeFetch(url, init);
      const method = address.split("/").at(-1)!;
      providerCalls.push(method);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      let result: unknown;
      if (method === "getMe") result = { id: 123456789, is_bot: true, username: "creolab_test_bot" };
      else if (method === "getWebhookInfo") result = { url: webhookUrl, pending_update_count: 0 };
      else if (method === "setWebhook") { webhookUrl = body.url; secret = body.secret_token; result = true; }
      else if (method === "deleteWebhook") { webhookUrl = ""; result = true; }
      else if (method === "getFile") result = { file_path: "photos/photo.jpg", file_size: 4 };
      else if (method === "photo.jpg") return new Response(new Uint8Array([255,216,255,217]));
      else if (method === "sendMessage" || method === "sendDocument") {
        sendCount++;
        if (failSend) throw new Error(`request failed at ${address}`);
        result = { message_id: 1000 + sendCount };
      } else throw new Error(`Unexpected Telegram method: ${method}`);
      return new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
    };
    process.env.SEED_PASSWORD ||= "ChangeMeLocal1!";
    prisma = await createPrismaClient();
    const { seedDatabase } = await import("../../../packages/db/src/seed.ts");
    await seedDatabase();
    server = createApp(prisma).listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("no port");
    base = `http://127.0.0.1:${address.port}`;
    const login = await nativeFetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@creolab.example", password: process.env.SEED_PASSWORD }) });
    assert.equal(login.status, 200); cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  });
  after(async () => {
    globalThis.fetch = nativeFetch; config.apiBaseUrl = oldApiBase;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (prisma) await prisma.$disconnect();
  });
  const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) => nativeFetch(`${base}${path}`, { method: "POST", headers: { cookie, "content-type": "application/json", ...(body && typeof body === "object" && "idempotencyKey" in body ? { "idempotency-key": String(body.idempotencyKey) } : {}), ...headers }, body: JSON.stringify(body) });
  const update = (id: number, extra: Record<string, unknown> = {}) => ({ update_id: id, message: { message_id: id, date: Math.floor(Date.now()/1000), chat: { id: 555123, type: "private" }, from: { id: 555123, first_name: "Клиент", is_bot: false }, text: "Добрый день", ...extra } });
  const receive = (id: number, extra: Record<string, unknown> = {}) => post(`/public/integrations/telegram/${integrationId}`, update(id, extra), { "x-telegram-bot-api-secret-token": secret });

  it("connects a dedicated bot and never returns or stores a plaintext token", async () => {
    const res = await post("/api/v1/integrations/telegram/connect", { token });
    const body = await res.json(); assert.equal(res.status, 200, JSON.stringify(body)); integrationId = body.id;
    assert.equal(body.connected, true); assert.ok(secret.length >= 32); assert.ok(!JSON.stringify(body).includes(token));
    const row = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } });
    const credential = await prisma.credential.findUniqueOrThrow({ where: { id: row.credentialId! } });
    assert.notEqual(credential.encryptedValue, token); assert.notEqual(row.secretHash, secret);
    assert.equal(row.status, "active");
    assert.ok(!JSON.stringify(row.schemaJson).includes(token));
    const catalog = await (await nativeFetch(`${base}/api/v1/integrations/catalog`, { headers: { cookie } })).json();
    assert.equal(catalog.messaging.find((x: { catalogType: string }) => x.catalogType === "TELEGRAM").connected, true);
  });
  it("rejects forged deliveries before creating any customer records", async () => {
    const count = await prisma.contact.count();
    const res = await post(`/public/integrations/telegram/${integrationId}`, update(1), { "x-telegram-bot-api-secret-token": "wrong" });
    assert.equal(res.status, 401); assert.equal(await prisma.contact.count(), count);
  });
  it("imports a message without inventing a phone or creating an inquiry; duplicate deliveries are harmless", async () => {
    const inquiryCount = await prisma.inquiry.count();
    const first = await receive(2); assert.equal(first.status, 200); conversationId = (await first.json()).conversationId;
    const replies = await Promise.all([receive(2), receive(2)]); assert.ok(replies.every(r => r.status === 200));
    const messages = await prisma.message.findMany({ where: { conversationId } }); assert.equal(messages.length, 1);
    const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId }, include: { contact: { include: { methods: true } } } });
    assert.equal(conv.mode, "human"); assert.equal(conv.waitingFor, "MANAGER"); assert.equal(conv.contact!.methods.length, 0);
    assert.equal(await prisma.inquiry.count(), inquiryCount);
    const parallel = await Promise.all([receive(3), receive(4)]); assert.ok(parallel.every(r => r.status === 200));
    assert.equal(await prisma.conversation.count({ where: { connectionId: conv.connectionId, externalThreadId: "555123" } }), 1);
  });
  it("imports private attachments and ignores group traffic", async () => {
    assert.equal((await receive(5, { text: undefined, photo: [{ file_id: "photo-file", file_size: 4 }] })).status, 200);
    const files = await prisma.attachment.findMany({ where: { message: { conversationId } } }); assert.equal(files.length, 1); assert.equal(files[0].mimeType, "image/jpeg");
    const count = await prisma.message.count({ where: { conversationId } });
    const group = await receive(6, { chat: { id: -888, type: "group" } }); assert.equal((await group.json()).ignored, true);
    assert.equal(await prisma.message.count({ where: { conversationId } }), count);
  });
  it("sends CRM replies through Telegram and protects repeated clicks", async () => {
    const sends = sendCount;
    const path = `/api/v1/conversations/${conversationId}/messages`;
    const payload = { text: "Здравствуйте", idempotencyKey: "telegram-reply-0001" };
    const res = await post(path, payload); const body = await res.json(); assert.equal(res.status, 201, JSON.stringify(body));
    assert.equal(body.operationState, "accepted"); assert.equal(sendCount, sends + 1);
    const duplicate = await post(path, payload); assert.equal(duplicate.status, 201); assert.equal((await duplicate.json()).id, body.id); assert.equal(sendCount, sends + 1);
    const failedKey = "telegram-failed-0001"; failSend = true;
    const failed = await post(path, { text: "Ошибка доставки", idempotencyKey: failedKey }); assert.equal(failed.status, 502);
    const errorBody = await failed.text(); assert.ok(!errorBody.includes(token)); failSend = false;
    const retry = await post(path, { text: "Ошибка доставки", idempotencyKey: failedKey }); assert.equal((await retry.json()).operationState, "unknown"); assert.equal(sendCount, sends + 2);
  });
  it("tenant and permission checks protect connection management", async () => {
    const other = await prisma.tenant.findFirstOrThrow({ where: { integrations: { none: { id: integrationId } } } });
    const otherIntegration = await prisma.integration.create({ data: { tenantId: other.id, type: "telegram_bot", name: "Другой бот" } });
    const callCount = providerCalls.length;
    assert.equal((await post(`/api/v1/integrations/telegram/${otherIntegration.id}/disconnect`)).status, 404);
    assert.equal((await post(`/api/v1/integrations/telegram/${otherIntegration.id}/check`)).status, 404);
    assert.equal(providerCalls.length, callCount);
    assert.equal((await post("/api/v1/integrations/telegram/connect", { token }, { cookie: "" })).status, 401);
  });
  it("refuses to take over a bot already used elsewhere", async () => {
    const current = webhookUrl; webhookUrl = "https://other.example.test/receive";
    const count = providerCalls.filter(x => x === "setWebhook").length;
    assert.equal((await post("/api/v1/integrations/telegram/connect", { token })).status, 409);
    assert.equal(providerCalls.filter(x => x === "setWebhook").length, count); webhookUrl = current;
  });
  it("disconnect retains history, stops new deliveries and outbound sends", async () => {
    const count = await prisma.message.count({ where: { conversationId } });
    assert.equal((await post(`/api/v1/integrations/telegram/${integrationId}/disconnect`)).status, 200);
    assert.equal((await receive(20)).status, 401);
    const sends = sendCount;
    assert.equal((await post(`/api/v1/conversations/${conversationId}/messages`, { text: "Не отправлять", idempotencyKey: "disconnected-01" })).status, 409);
    assert.equal(sendCount, sends); assert.equal(await prisma.message.count({ where: { conversationId } }), count);
  });
});
