import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { config } from "./config.ts";
import { parseTikTokJson } from "./services/tiktokConnectionService.ts";

describe("TikTok company leads", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>, server: ReturnType<ReturnType<typeof createApp>["listen"]>;
  let base = "", cookie = "", integrationId = "", callback = "", subscriptions = 0, failSubscribeResponse = true;
  const unsubscribed: string[] = [];
  const nativeFetch = globalThis.fetch, oldBase = config.apiBaseUrl;
  const input = { appId: "123456789012345678", advertiserId: "723456789012345678", pageId: "823456789012345678", accessToken: "test-tiktok-access-token-123456", appSecret: "test-tiktok-app-secret-123456" };
  before(async () => {
    config.apiBaseUrl = "https://crm.example.test";
    globalThis.fetch = async (url, init) => {
      const u = new URL(String(url)); if (u.hostname !== "business-api.tiktok.com") return nativeFetch(url, init);
      const reply = (data: unknown) => new Response(JSON.stringify({ code: 0, data }), { headers: { "content-type": "application/json" } });
      if (u.pathname.endsWith("/lead/field/get/")) return reply({ fields: ["name", "phone_number"], meta_data: { page_id: input.pageId, page_name: "Заявки TikTok" } });
      if (u.pathname.endsWith("/subscription/get/")) return reply({ subscriptions: [
        { callback_url: "https://another-crm.test/hook", subscription_id: "foreign" },
        ...(subscriptions ? [{ callback_url: callback, subscription_id: "our-subscription" }] : []),
      ], page_info: { total_page: 1 } });
      if (u.pathname.endsWith("/subscription/subscribe/")) {
        const body = JSON.parse(String(init?.body)); callback = body.callback_url; subscriptions++;
        assert.equal(body.subscription_detail.advertiser_id, input.advertiserId);
        assert.equal(body.subscription_detail.page_id, input.pageId);
        if (failSubscribeResponse) { failSubscribeResponse = false; throw new Error("Connection lost after provider accepted subscription"); }
        return reply({ subscription_id: "our-subscription" });
      }
      if (u.pathname.endsWith("/subscription/unsubscribe/")) { unsubscribed.push(JSON.parse(String(init?.body)).subscription_id); return reply({}); }
      throw new Error(`Unexpected TikTok path ${u.pathname}`);
    };
    process.env.SEED_PASSWORD ||= "ChangeMeLocal1!"; prisma = await createPrismaClient();
    const { seedDatabase } = await import("../../../packages/db/src/seed.ts"); await seedDatabase();
    await new Promise<void>(resolve => { server = createApp(prisma).listen(0, "127.0.0.1", resolve); });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("port"); base = `http://127.0.0.1:${address.port}`;
    const login = await nativeFetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@creolab.example", password: process.env.SEED_PASSWORD }) });
    assert.equal(login.status, 200); cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  });
  after(async () => { globalThis.fetch = nativeFetch; config.apiBaseUrl = oldBase; if (server) await new Promise<void>(resolve => server.close(() => resolve())); if (prisma) await prisma.$disconnect(); });
  const post = (path: string, body: unknown = {}, session = cookie) => nativeFetch(`${base}${path}`, { method: "POST", headers: { cookie: session, "content-type": "application/json" }, body: JSON.stringify(body) });
  const hookPath = () => new URL(callback).pathname;
  const event = (id: string, advertiser = input.advertiserId, phone = "+77019992345") => ({ object: 1, entry: [{ id, advertiser_id: advertiser, page_id: input.pageId, lead_source: "INSTANT_FORM", create_time: Math.floor(Date.now() / 1000), changes: [{ field: "name", value: "Покупатель TikTok" }, { field: "phone_number", value: phone }] }] });
  it("preserves long numeric IDs exactly", () => {
    assert.deepEqual(parseTikTokJson('{"id":123456789012345678,"advertiser_id":723456789012345678,"object":1}'), { id: "123456789012345678", advertiser_id: input.advertiserId, object: 1 });
  });
  it("rejects unauthenticated setup and keeps secrets out of the connection list", async () => {
    assert.equal((await post("/api/v1/integrations/tiktok/connect", input, "")).status, 401);
    const response = await post("/api/v1/integrations/tiktok/connect", input); assert.equal(response.status, 502);
    const list = await nativeFetch(`${base}/api/v1/integrations/tiktok`, { headers: { cookie } }); const data = await list.json(); integrationId = data.items[0].id;
    assert.equal(data.items[0].connected, false);
    const serialized = JSON.stringify(data); assert.ok(!serialized.includes(input.accessToken)); assert.ok(!serialized.includes(input.appSecret)); assert.ok(!serialized.includes(callback));
  });
  it("recovers an uncertain subscription without creating a second one", async () => {
    const response = await post(`/api/v1/integrations/tiktok/${integrationId}/check`); assert.equal(response.status, 200, await response.text());
    assert.equal(subscriptions, 1); assert.equal((await post("/api/v1/integrations/tiktok/connect", input)).status, 409);
  });
  it("rejects a wrong delivery key and ignores another advertiser", async () => {
    assert.equal((await post(`/public/integrations/tiktok/${integrationId}/${"a".repeat(64)}`, event("1"))).status, 401);
    assert.equal((await post(hookPath(), event("2", "99999"))).status, 200);
    assert.equal(await prisma.inboundEvent.count({ where: { integrationId } }), 0);
  });
  it("imports concurrent redeliveries once, including IDs sent as JSON numbers", async () => {
    const raw = JSON.stringify(event("923456789012345678")).replaceAll('"723456789012345678"', "723456789012345678").replaceAll('"823456789012345678"', "823456789012345678");
    const results = await Promise.all([1, 2].map(() => nativeFetch(`${base}${hookPath()}`, { method: "POST", headers: { "content-type": "application/json" }, body: raw })));
    for (const result of results) assert.equal(result.status, 200, await result.text());
    assert.equal(await prisma.inquiry.count({ where: { integrationId } }), 1); assert.equal(await prisma.inboundEvent.count({ where: { integrationId } }), 1);
  });
  it("preserves incomplete leads when the form has no phone", async () => {
    const response = await post(hookPath(), event("923456789012345679", input.advertiserId, "")); assert.equal(response.status, 200, await response.text());
    assert.equal(await prisma.inboundEvent.count({ where: { integrationId } }), 2);
    assert.equal(await prisma.incompleteIntake.count({ where: { integrationId } }), 1);
  });
  it("unsubscribes only CRM's subscription and preserves lead history", async () => {
    const count = await prisma.inquiry.count({ where: { integrationId } });
    assert.equal((await post(`/api/v1/integrations/tiktok/${integrationId}/disconnect`)).status, 200);
    assert.deepEqual(unsubscribed, ["our-subscription"]);
    assert.equal((await post(hookPath(), event("3"))).status, 401);
    assert.equal(await prisma.inquiry.count({ where: { integrationId } }), count);
  });
});
