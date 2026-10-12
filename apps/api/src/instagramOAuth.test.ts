import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { before, after, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { config } from "./config.ts";
import { encryptSecret, decryptSecret } from "./lib/secretBox.ts";
import { refreshInstagramCredential } from "./services/instagramOAuthService.ts";
import { sendInstagramText } from "./services/metaConnectionService.ts";

describe("Instagram login and shared webhook", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>, server: ReturnType<ReturnType<typeof createApp>["listen"]>;
  let base = "", cookie = "", tenantId = "", integrationId = "", providerCalls = 0, accountId = "178410001", subscribed = 0, lastSendHost = "";
  let granted = ["instagram_business_basic", "instagram_business_manage_messages"];
  const nativeFetch = globalThis.fetch, oldAppBase = config.appBaseUrl, oldApiBase = config.apiBaseUrl;
  const envNames = ["INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET", "INSTAGRAM_VERIFY_TOKEN"];
  const original = Object.fromEntries(envNames.map(key => [key, process.env[key]]));
  const secret = "test-only-instagram-app-secret", accessToken = "test-only-long-token";
  before(async () => {
    process.env.INSTAGRAM_APP_ID = "777000"; process.env.INSTAGRAM_APP_SECRET = secret; process.env.INSTAGRAM_VERIFY_TOKEN = "test-verify-token";
    config.appBaseUrl = "https://crm.example.test"; config.apiBaseUrl = "https://api.example.test";
    globalThis.fetch = async (url, init) => {
      const u = new URL(String(url)); if(u.hostname === "127.0.0.1") return nativeFetch(url, init);
      assert.ok(["api.instagram.com", "graph.instagram.com"].includes(u.hostname)); providerCalls++;
      const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
      if(u.pathname === "/oauth/access_token") { assert.ok(init?.body instanceof URLSearchParams); assert.equal(init.body.get("redirect_uri"), "https://crm.example.test/api/v1/integrations/instagram/callback"); return json({ access_token: "test-short", user_id: accountId, permissions: granted }); }
      if(u.pathname === "/access_token") { assert.equal(u.searchParams.get("grant_type"), "ig_exchange_token"); return json({ access_token: accessToken, expires_in: 5184000 }); }
      if(u.pathname.endsWith("/me")) return json({ id: "APP_SCOPED_ID", user_id: accountId, username: "test_company" });
      if(u.pathname.endsWith("/subscribed_apps")) { assert.equal(init?.method, "POST"); subscribed++; return json({ success: true }); }
      if(u.pathname.endsWith("/messages")) { lastSendHost = u.host; return json({ message_id: "test-sent" }); }
      if(u.pathname === "/refresh_access_token") return json({ access_token: "test-refreshed", expires_in: 5184000 });
      throw new Error("Unexpected provider endpoint");
    };
    prisma = await createPrismaClient(); const { seedDatabase } = await import("../../../packages/db/src/seed.ts"); await seedDatabase();
    tenantId = (await prisma.membership.findFirstOrThrow({ where: { user: { email: "owner@creolab.example" } } })).tenantId;
    server = createApp(prisma).listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address(); if(!address || typeof address === "string") throw new Error("port"); base = `http://127.0.0.1:${address.port}`;
    const login = await nativeFetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@creolab.example", password: process.env.SEED_PASSWORD }) }); assert.equal(login.status, 200); cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  });
  after(async () => { globalThis.fetch = nativeFetch; config.appBaseUrl = oldAppBase; config.apiBaseUrl = oldApiBase; for(const [key,value] of Object.entries(original)) { if(value === undefined) delete process.env[key]; else process.env[key] = value; } if(server) await new Promise<void>(resolve => server.close(() => resolve())); await prisma?.$disconnect(); });
  const call = (path: string, method = "GET", body?: unknown, headers: Record<string,string> = {}) => nativeFetch(`${base}${path}`, { method, redirect: "manual", headers: { cookie, "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  async function begin() { const response = await call("/api/v1/integrations/instagram/connect", "POST"); assert.equal(response.status, 200); const { url } = await response.json(); const parsed = new URL(url); assert.equal(parsed.hostname, "www.instagram.com"); assert.equal(parsed.searchParams.get("scope"), granted.includes("instagram_business_manage_messages") ? granted.join(",") : "instagram_business_basic,instagram_business_manage_messages"); assert.ok(!url.includes(secret)); return parsed.searchParams.get("state")!; }
  const finish = (state: string, headers: Record<string,string> = {}) => call(`/api/v1/integrations/instagram/callback?state=${state}&code=test-code`, "GET", undefined, headers);
  it("keeps OAuth state bound to the session and does not expose tokens", async () => {
    const state = await begin(), calls = providerCalls;
    assert.match((await finish(state, { cookie: "" })).headers.get("location") || "", /instagram=failed/); assert.equal(providerCalls, calls);
    const response = await finish(state); assert.match(response.headers.get("location") || "", /instagram=connected/); assert.equal(subscribed, 1);
    const row = await prisma.integration.findUniqueOrThrow({ where: { publicKey: `instagram_direct:${accountId}` } }); integrationId = row.id; assert.equal(row.tenantId, tenantId); assert.equal(row.status, "active");
    const credential = await prisma.credential.findUniqueOrThrow({ where: { id: row.credentialId! } }); assert.ok(!credential.encryptedValue.includes(accessToken));
    const list = await (await call("/api/v1/integrations/meta")).text(); assert.ok(!list.includes(secret)); assert.ok(!list.includes(accessToken)); assert.ok(!list.includes(state));
    const previousCalls = providerCalls; assert.match((await finish(state)).headers.get("location") || "", /instagram=failed/); assert.equal(providerCalls, previousCalls);
    await sendInstagramText(prisma, row, "112233", "Здравствуйте!"); assert.equal(lastSendHost, "graph.instagram.com");
  });
  it("rejects expired consent, missing scope, and an account owned by another tenant", async () => {
    const expired = await begin(); await prisma.idempotencyRecord.updateMany({ where: { scope: "instagram.oauth" }, data: { expiresAt: new Date(0) } }); const beforeCalls = providerCalls;
    assert.match((await finish(expired)).headers.get("location") || "", /instagram=failed/); assert.equal(providerCalls, beforeCalls);
    granted = ["instagram_business_basic"]; const state = await begin(); const count = subscribed; assert.match((await finish(state)).headers.get("location") || "", /instagram=failed/); assert.equal(subscribed, count); granted.push("instagram_business_manage_messages");
    const other = await prisma.tenant.findFirstOrThrow({ where: { id: { not: tenantId } } }); accountId = "178419999";
    await prisma.integration.create({ data: { tenantId: other.id, type: "instagram_direct", name: "Other", publicKey: `instagram_direct:${accountId}` } });
    assert.match((await finish(await begin())).headers.get("location") || "", /instagram=failed/); assert.equal(subscribed, count); accountId = "178410001";
  });
  it("verifies the shared webhook and routes signed deliveries only to the matching account", async () => {
    assert.equal((await call("/public/integrations/instagram?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=test")).status, 403);
    assert.equal(await (await call("/public/integrations/instagram?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=test")).text(), "test");
    const body = { object: "instagram", entry: [{ id: accountId, messaging: [{ sender: { id: "112233" }, recipient: { id: accountId }, timestamp: Date.now(), message: { mid: "oauth-mid-1", text: "Добрый день" } }] }, { id: "178400000", messaging: [{ sender: { id: "111" }, recipient: { id: "178400000" }, message: { mid: "foreign-event", text: "FOREIGN" } }] }] };
    const count = await prisma.message.count(); assert.equal((await call("/public/integrations/instagram", "POST", body, { "x-hub-signature-256": "sha256="+"0".repeat(64) })).status, 401); assert.equal(await prisma.message.count(), count);
    const signature = `sha256=${createHmac("sha256", secret).update(JSON.stringify(body)).digest("hex")}`;
    assert.equal((await call("/public/integrations/instagram", "POST", body, { "x-hub-signature-256": signature })).status, 200);
    assert.equal((await call("/public/integrations/instagram", "POST", body, { "x-hub-signature-256": signature })).status, 200);
    assert.equal(await prisma.message.count(), count + 1); assert.equal(await prisma.message.count({ where: { text: "FOREIGN" } }), 0);
  });
  it("refreshes expiring access without exposing or overwriting a new credential", async () => {
    const row = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } });
    const old = await prisma.credential.findUniqueOrThrow({ where: { id: row.credentialId! } });
    const value = JSON.parse(decryptSecret(old.encryptedValue));
    const credential = await prisma.credential.update({ where: { id: old.id }, data: { encryptedValue: encryptSecret(JSON.stringify({ ...value, expiresAt: Date.now() + 86400000 })) } });
    await refreshInstagramCredential(prisma, credential);
    const refreshed = await prisma.credential.findUniqueOrThrow({ where: { id: old.id } }); assert.equal(JSON.parse(decryptSecret(refreshed.encryptedValue)).accessToken, "test-refreshed");
    await prisma.credential.update({ where: { id: old.id }, data: { encryptedValue: encryptSecret(JSON.stringify({ ...value, accessToken: "new-consent-token" })) } });
    await refreshInstagramCredential(prisma, credential);
    const newest = await prisma.credential.findUniqueOrThrow({ where: { id: old.id } }); assert.equal(JSON.parse(decryptSecret(newest.encryptedValue)).accessToken, "new-consent-token");
  });
});
