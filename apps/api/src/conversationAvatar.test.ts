import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { encryptSecret } from "./lib/secretBox.ts";

describe("Conversation profile photos", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let server: any; let base = ""; let cookie = ""; let tenantId = ""; let telegramId = ""; let whatsappId = ""; let connectionId = "";
  let photoAvailable = true; let imageUrl = "https://pps.whatsapp.net/avatar.jpg"; let oversized = false; let providerUnavailable = false; let htmlInstead = false;
  const originalFetch = globalThis.fetch; const providerCalls: string[] = [];
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF2kAAAAASUVORK5CYII=", "base64");
  before(async () => {
    process.env.SEED_PASSWORD ||= "ChangeMeLocal1!";
    prisma = await createPrismaClient();
    await (await import("../../../packages/db/src/seed.ts")).seedDatabase();
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: "creolab" } }); tenantId = tenant.id;
    const contact = await prisma.contact.create({ data: { tenantId, name: "Photo Client", methods: { create: { type: "phone", source: "manual", rawValue: "77011112233", normalizedValue: "77011112233", primary: true } } } });
    const credential = await prisma.credential.create({ data: { tenantId, kind: "telegram_bot", scope: "integration", keyVersion: "v1", encryptedValue: encryptSecret("123456:avatar-test-secret") } });
    const integration = await prisma.integration.create({ data: { tenantId, type: "telegram_bot", name: "Photos", status: "active", credentialId: credential.id } });
    const connection = await prisma.channelConnection.create({ data: { tenantId, integrationId: integration.id, channelType: "telegram", status: "active" } }); connectionId = connection.id;
    telegramId = (await prisma.conversation.create({ data: { tenantId, connectionId, contactId: contact.id, externalThreadId: "100001" } })).id;
    await prisma.integration.updateMany({ where: { tenantId, type: "whatsapp_seller" }, data: { status: "disabled" } });
    await prisma.integration.create({ data: { tenantId, type: "whatsapp_seller", name: "WA Photos", status: "active", schemaJson: { instanceId: "710700001", apiTokenEnc: encryptSecret("avatar-wa-test") } } });
    whatsappId = (await prisma.conversation.create({ data: { tenantId, contactId: contact.id, sellerLeadId: "avatar-test" } })).id;
    await new Promise<void>(resolve => { server = createApp(prisma).listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
    const login = await originalFetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@creolab.example", password: process.env.SEED_PASSWORD, client: "web" }) });
    cookie = login.headers.get("set-cookie") || ""; assert.ok(cookie);
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input); if (url.startsWith(base)) return originalFetch(input, init);
      providerCalls.push(url);
      if (providerUnavailable) throw new Error("provider unavailable with secret URL");
      if (url.includes("getUserProfilePhotos")) {
        assert.equal(JSON.parse(String(init?.body)).limit, 1);
        return Response.json({ ok: true, result: { photos: photoAvailable ? [[{ file_id: "photo-file", width: 160 }]] : [] } });
      }
      if (url.includes("/getFile")) return Response.json({ ok: true, result: { file_path: "photos/profile.jpg", file_size: 100 } });
      if (url.includes("/getAvatar/")) {
        assert.equal(JSON.parse(String(init?.body)).chatId, "77011112233@c.us");
        return Response.json({ urlAvatar: imageUrl });
      }
      if (url.startsWith("https://api.telegram.org/file/") || url.startsWith("https://pps.whatsapp.net/")) return new Response(htmlInstead ? Buffer.from("<html>provider error</html>") : png, { headers: { "Content-Type": "image/png", "Content-Length": String(oversized ? 300000 : png.length) } });
      throw new Error("Unexpected external request");
    }) as typeof fetch;
  });
  after(async () => { globalThis.fetch = originalFetch; server?.close(); await prisma?.$disconnect(); });
  const avatar = (id: string, headers = { cookie }) => fetch(`${base}/api/v1/conversations/${id}/avatar`, { headers });
  async function resetWhatsAppIdentity() {
    const contactId = (await prisma.conversation.findUniqueOrThrow({ where: { id: whatsappId } })).contactId!;
    const integration = await prisma.integration.findFirstOrThrow({ where: { tenantId, type: "whatsapp_seller", status: "active" } });
    await prisma.integration.update({ where: { id: integration.id }, data: { schemaJson: { instanceId: "710700001", apiTokenEnc: encryptSecret(`test-${Date.now()}-${Math.random()}`) } } });
    assert.ok(contactId);
  }
  it("Telegram downloads a real image, caches it, and never returns the bot token", async () => {
    providerCalls.length = 0;
    const response = await avatar(telegramId); assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    assert.equal(providerCalls.length, 3);
    assert.equal((await avatar(telegramId)).status, 200); assert.equal(providerCalls.length, 3);
  });
  it("WhatsApp uses this tenant's Green API connection and downloads the avatar", async () => {
    providerCalls.length = 0;
    const response = await avatar(whatsappId); assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    assert.ok(providerCalls[0].includes("710700001.api.green-api.com/waInstance710700001/getAvatar/"));
    assert.equal(providerCalls.length, 2);
  });
  it("rejects unauthenticated, cross-tenant and inaccessible-manager requests before provider calls", async () => {
    providerCalls.length = 0;
    assert.equal((await avatar(telegramId, { cookie: "" })).status, 401);
    const other = await prisma.tenant.findUniqueOrThrow({ where: { slug: "demo-agency" } });
    const foreign = await prisma.conversation.create({ data: { tenantId: other.id } });
    assert.equal((await avatar(foreign.id)).status, 404);
    const login = await originalFetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "manager@creolab.example", password: process.env.SEED_PASSWORD, client: "web" }) });
    assert.equal(login.status, 200);
    assert.equal((await avatar(telegramId, { cookie: login.headers.get("set-cookie")! })).status, 404);
    assert.equal(providerCalls.length, 0);
  });
  it("private photos and disconnected channels leave initials without breaking the chat", async () => {
    photoAvailable = false;
    await prisma.conversation.update({ where: { id: telegramId }, data: { externalThreadId: "100002" } });
    assert.equal((await avatar(telegramId)).status, 204);
    await prisma.channelConnection.update({ where: { id: connectionId }, data: { status: "disabled" } });
    providerCalls.length = 0; assert.equal((await avatar(telegramId)).status, 204); assert.equal(providerCalls.length, 0);
  });
  it("does not follow an arbitrary provider image URL or download an oversized image", async () => {
    imageUrl = "http://127.0.0.1/internal"; await resetWhatsAppIdentity(); providerCalls.length = 0;
    assert.equal((await avatar(whatsappId)).status, 204); assert.equal(providerCalls.length, 1);
    imageUrl = "https://pps.whatsapp.net/avatar.jpg"; oversized = true; await resetWhatsAppIdentity();
    assert.equal((await avatar(whatsappId)).status, 204);
  });
  it("provider failures and non-image payloads return an empty optional photo, with negative caching", async () => {
    oversized = false; providerUnavailable = true; await resetWhatsAppIdentity(); providerCalls.length = 0;
    assert.equal((await avatar(whatsappId)).status, 204);
    assert.equal((await avatar(whatsappId)).status, 204);
    assert.equal(providerCalls.length, 1);
    providerUnavailable = false; htmlInstead = true; await resetWhatsAppIdentity();
    assert.equal((await avatar(whatsappId)).status, 204);
    htmlInstead = false;
  });
  it("simultaneous requests for the same profile share one provider request", async () => {
    await resetWhatsAppIdentity(); providerCalls.length = 0;
    const responses = await Promise.all([avatar(whatsappId), avatar(whatsappId), avatar(whatsappId)]);
    assert.ok(responses.every(response => response.status === 200));
    assert.equal(providerCalls.filter(url => url.includes("/getAvatar/")).length, 1);
  });

});
