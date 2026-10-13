import { resetRateLimits } from "./lib/rateLimit.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { createStaffNotification } from "./services/notificationService.ts";
import { EMPLOYEE_TELEGRAM_WEBHOOK, processEmployeeTelegramQueue } from "./services/employeeTelegramService.ts";

describe("personal Telegram notifications", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>, server: any, url: string, owner: any, manager: any;
  let cookie = "", managerCookie = "", sendMode = 200, webhookUrl = "", wrongUsername = false;
  const originalFetch = globalThis.fetch;
  const calls: Array<{ method: string; body: any }> = [];
  const secret = "test_staff_webhook_secret_1234567890";
  function configure() {
    process.env.TELEGRAM_BOT_TOKEN = "123456:test_only_notification_token";
    process.env.TELEGRAM_BOT_USERNAME = "basqar_staff_test_bot";
    process.env.TELEGRAM_WEBHOOK_SECRET = secret;
    process.env.TELEGRAM_WEBHOOK_BASE_URL = "https://notifications.example.invalid";
  }
  async function request(path: string, method = "GET", body?: unknown, auth = cookie) {
    const response = await fetch(`${url}${path}`, { method, headers: { cookie: auth, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }
  const status = () => request("/api/v1/telegram/status");
  async function startLink(auth = cookie) {
    const result = await request("/api/v1/telegram/begin-link", "POST", undefined, auth);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return new URL(result.data.deepLink).searchParams.get("start")!;
  }
  async function webhook(text: string, chat = 777, type = "private", header = secret) {
    const response = await fetch(`${url}${EMPLOYEE_TELEGRAM_WEBHOOK}`, { method: "POST", headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": header }, body: JSON.stringify({ update_id: Date.now(), message: { message_id: 1, date: Math.floor(Date.now()/1000), chat: { id: chat, type }, from: { id: chat, is_bot: false }, text } }) });
    return { status: response.status, data: await response.json() };
  }
  async function connect(auth = cookie, chat = 777) {
    const token = await startLink(auth);
    assert.equal((await webhook(`/start ${token}`, chat)).status, 200);
    return token;
  }
  async function notice(overrides: any = {}) {
    return createStaffNotification(prisma, { tenantId: owner.tenantId, membershipId: owner.id, type: "task.assigned", entityType: "task", entityId: randomUUID(), title: "Private customer name", body: "Private customer phone and message", ...overrides });
  }
  const sends = () => calls.filter(call => call.method === "sendMessage");
  const deliveries = () => prisma.notificationDelivery.findMany({ where: { channel: "telegram" } });
  before(async () => {
    prisma = await createPrismaClient();
    await (await import("../../../packages/db/src/seed.ts")).seedDatabase();
    owner = await prisma.membership.findFirstOrThrow({ where: { user: { email: "owner@creolab.example" }, tenant: { slug: "creolab" } } });
    manager = await prisma.membership.findFirstOrThrow({ where: { user: { email: "manager@creolab.example" }, tenantId: owner.tenantId } });
    server = await new Promise<any>(resolve => { const s = createApp(prisma).listen(0, "127.0.0.1", () => resolve(s)); });
    url = `http://127.0.0.1:${server.address().port}`;
    for (const email of ["owner@creolab.example", "manager@creolab.example"]) {
      const result = await fetch(`${url}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: process.env.SEED_PASSWORD }) });
      assert.equal(result.status, 200);
      const value = result.headers.get("set-cookie")!.split(";")[0];
      if (email.startsWith("owner")) cookie = value; else managerCookie = value;
    }
    globalThis.fetch = async (input, init) => {
      const target = String(input);
      if (target.startsWith(url)) return originalFetch(input, init);
      assert.ok(target.startsWith("https://api.telegram.org/bot123456:"), `Unexpected external request`);
      const method = target.split("/").at(-1)!;
      const body = JSON.parse(String(init?.body || "{}")); calls.push({ method, body });
      if (method === "sendMessage" && sendMode === 0) throw new Error("network timeout with token that must not be logged");
      if (method === "sendMessage" && sendMode !== 200) return Response.json({ ok: false, error_code: sendMode, parameters: { retry_after: 120 } }, { status: sendMode });
      const result = method === "getMe" ? { id: 123456, username: wrongUsername ? "other_bot" : "basqar_staff_test_bot", is_bot: true }
        : method === "getWebhookInfo" ? { url: webhookUrl }
        : method === "sendMessage" ? { message_id: 999 } : true;
      if (method === "setWebhook") webhookUrl = body.url;
      return Response.json({ ok: true, result });
    };
  });
  beforeEach(async () => {
    resetRateLimits(); configure(); calls.length = 0; sendMode = 200; webhookUrl = ""; wrongUsername = false;
    await prisma.notificationDelivery.deleteMany({ where: { channel: "telegram" } });
    await prisma.notification.deleteMany({ where: { type: "telegram.test" } });
    await prisma.telegramBinding.deleteMany();
    await prisma.notificationPreference.deleteMany();
    await prisma.membership.update({ where: { id: owner.id }, data: { active: true } });
  });
  after(async () => {
    globalThis.fetch = originalFetch;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.$disconnect();
    for (const key of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_USERNAME", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_WEBHOOK_BASE_URL"]) delete process.env[key];
  });

  it("requires authentication and complete service configuration", async () => {
    assert.equal((await request("/api/v1/telegram/status", "GET", undefined, "")).status, 401);
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    assert.equal((await startUnavailable()).status, 503);
    assert.equal(await prisma.telegramBinding.count(), 0);
    assert.equal((await status()).data.botConfigured, false);
  });
  function startUnavailable() { return request("/api/v1/telegram/begin-link", "POST"); }
  it("verifies the bot identity and refuses to replace a company bot webhook", async () => {
    wrongUsername = true;
    assert.equal((await startUnavailable()).data.code, "telegram_bot_mismatch");
    wrongUsername = false; webhookUrl = "https://other.example/public/integrations/telegram/company";
    assert.equal((await startUnavailable()).data.code, "telegram_bot_in_use");
    assert.equal(calls.some(c => c.method === "setWebhook"), false);
    assert.equal(await prisma.telegramBinding.count(), 0);
  });
  it("links only after a signed private /start and stores a one-use hash", async () => {
    const token = await startLink();
    const binding = await prisma.telegramBinding.findFirstOrThrow();
    assert.notEqual(binding.pendingTokenHash, token); assert.equal(binding.chatRef, "");
    assert.equal((await status()).data.connectionStatus, "PENDING");
    assert.equal((await webhook(`/start ${token}`, 777, "private", "forged")).status, 403);
    await webhook(`/start ${token}`, 777, "group");
    assert.equal((await status()).data.connected, false);
    await webhook(`/start ${token}`);
    assert.equal((await status()).data.connected, true);
    assert.equal((await prisma.telegramBinding.findFirstOrThrow()).pendingTokenHash, null);
    assert.equal((await request("/api/v1/telegram/status", "GET", undefined, managerCookie)).data.connected, false);
    await webhook(`/start ${token}`, 888);
    assert.equal((await prisma.telegramBinding.findFirstOrThrow()).chatRef, "777");
    const hook = calls.find(c => c.method === "setWebhook")!.body;
    assert.equal(hook.secret_token, secret); assert.equal(hook.drop_pending_updates, false);
  });
  it("invalidates older and expired links, and permits ordinary employees to connect", async () => {
    const old = await startLink(managerCookie), current = await startLink(managerCookie);
    await webhook(`/start ${old}`);
    assert.equal((await request("/api/v1/telegram/status", "GET", undefined, managerCookie)).data.connected, false);
    await prisma.telegramBinding.updateMany({ where: { revokedAt: null }, data: { pendingExpiresAt: new Date(0) } });
    await webhook(`/start ${current}`);
    assert.equal((await request("/api/v1/telegram/status", "GET", undefined, managerCookie)).data.connectionStatus, "DISCONNECTED");
    await connect(managerCookie);
    assert.equal((await request("/api/v1/telegram/status", "GET", undefined, managerCookie)).data.connected, true);
  });
  it("does not let another employee take an existing private chat", async () => {
    await connect(); await connect(managerCookie);
    assert.equal((await request("/api/v1/telegram/status", "GET", undefined, managerCookie)).data.connected, false);
    assert.equal(await prisma.telegramBinding.count({ where: { chatRef: "777", revokedAt: null } }), 1);
  });
  it("disconnect invalidates links and queued notices; /stop also disconnects", async () => {
    await connect(); await notice();
    assert.equal((await request("/api/v1/telegram/link", "DELETE")).status, 200);
    await processEmployeeTelegramQueue(prisma); assert.equal(sends().length, 0);
    assert.equal((await deliveries())[0].state, "skipped");
    const pending = await startLink(); await request("/api/v1/telegram/link", "DELETE"); await webhook(`/start ${pending}`);
    assert.equal((await status()).data.connected, false);
    await connect(); await webhook("/stop"); assert.equal((await status()).data.connected, false);
  });
  it("delivers once across repeated events and competing workers without customer content", async () => {
    await connect();
    const entityId = randomUUID(); await Promise.all([notice({ entityId }), notice({ entityId })]);
    await Promise.all([processEmployeeTelegramQueue(prisma), processEmployeeTelegramQueue(prisma)]);
    assert.equal(sends().length, 1); assert.equal((await deliveries()).length, 1);
    assert.equal((await deliveries())[0].state, "delivered");
    assert.doesNotMatch(sends()[0].body.text, /Private customer/);
    assert.match(sends()[0].body.reply_markup.inline_keyboard[0][0].url, /settings\?section=notifications$/);
  });
  it("honors disabled categories and rechecks preferences before delivery", async () => {
    await connect();
    await request("/api/v1/me/notification-preferences", "PATCH", { events: { tasks: false } });
    assert.equal(await notice(), null); assert.equal((await deliveries()).length, 0);
    await request("/api/v1/me/notification-preferences", "PATCH", { events: { tasks: true } });
    await notice(); await request("/api/v1/me/notification-preferences", "PATCH", { channels: { telegram: false } });
    await processEmployeeTelegramQueue(prisma); assert.equal(sends().length, 0);
  });
  it("defers quiet hours and skips messages already read while waiting", async () => {
    await connect();
    const now = new Date(); const time = (n: number) => new Date(now.getTime()+n*60000).toISOString().slice(11,16);
    await prisma.user.update({ where: { id: owner.userId }, data: { timezone: "UTC" } });
    await request("/api/v1/me/notification-preferences", "PATCH", { quietHours: { enabled: true, start: time(-5), end: time(5) } });
    const n = await notice(); await processEmployeeTelegramQueue(prisma);
    assert.equal(sends().length, 0); assert.equal((await deliveries())[0].state, "created");
    assert.equal((await deliveries())[0].attempts, 0);
    await request("/api/v1/me/notification-preferences", "PATCH", { quietHours: { enabled: false } });
    await prisma.notification.update({ where: { id: n!.id }, data: { readAt: new Date() } });
    await prisma.notificationDelivery.updateMany({ where: { channel: "telegram" }, data: { nextAttemptAt: null } });
    await processEmployeeTelegramQueue(prisma); assert.equal((await deliveries())[0].state, "skipped");
    assert.equal((await request("/api/v1/me/notification-preferences", "PATCH", { quietHours: { start: "bad" } })).status, 422);
  });
  it("blocks delivery after staff access is removed and never crosses membership/tenant boundaries", async () => {
    await connect(); await notice();
    assert.equal(await notice({ membershipId: manager.id, tenantId: "another-tenant" }), null);
    await prisma.membership.update({ where: { id: owner.id }, data: { active: false } });
    await processEmployeeTelegramQueue(prisma); assert.equal(sends().length, 0);
  });
  it("retries an explicit rate limit after retry_after, without duplicates", async () => {
    await connect(); await notice(); sendMode = 429;
    await processEmployeeTelegramQueue(prisma); assert.equal((await deliveries())[0].state, "created");
    assert.ok((await deliveries())[0].nextAttemptAt!.getTime() > Date.now() + 110000);
    sendMode = 200; await processEmployeeTelegramQueue(prisma); assert.equal(sends().length, 1);
    await prisma.notificationDelivery.updateMany({ where: { channel: "telegram" }, data: { nextAttemptAt: null } });
    await processEmployeeTelegramQueue(prisma); assert.equal(sends().length, 2); assert.equal((await deliveries())[0].state, "delivered");
  });
  it("reports unknown outcomes without resending and revokes a blocked bot", async () => {
    await connect(); await notice(); sendMode = 0;
    await processEmployeeTelegramQueue(prisma); await processEmployeeTelegramQueue(prisma);
    assert.equal(sends().length, 1); assert.equal((await deliveries())[0].state, "uncertain");
    assert.doesNotMatch((await deliveries())[0].error!, /token/);
    await notice(); sendMode = 403; await processEmployeeTelegramQueue(prisma);
    assert.equal((await status()).data.connected, false);
  });
  it("does not forward old bindings or queued notices to a replacement bot", async () => {
    await connect(); await notice(); process.env.TELEGRAM_BOT_TOKEN = "654321:replacement_test_only";
    assert.equal((await status()).data.connected, false);
    await processEmployeeTelegramQueue(prisma); assert.equal(sends().length, 0);
  });
  it("does not create two owners when employees confirm the same chat concurrently", async () => {
    const a = await startLink(), b = await startLink(managerCookie);
    await Promise.all([webhook(`/start ${a}`), webhook(`/start ${b}`)]);
    assert.equal(await prisma.telegramBinding.count({ where: { chatRef: "777", revokedAt: null } }), 1);
  });
  it("delivers after quiet hours even with the in-app channel disabled", async () => {
    await connect();
    const time = (offset: number) => new Date(Date.now()+offset*60000).toISOString().slice(11,16);
    await prisma.user.update({ where: { id: owner.userId }, data: { timezone: "UTC" } });
    await request("/api/v1/me/notification-preferences", "PATCH", { channels: { in_app: false }, quietHours: { enabled: true, start: time(-5), end: time(5) } });
    await notice(); await processEmployeeTelegramQueue(prisma); assert.equal(sends().length, 0);
    await request("/api/v1/me/notification-preferences", "PATCH", { quietHours: { enabled: false } });
    await prisma.notificationDelivery.updateMany({ where: { channel: "telegram" }, data: { nextAttemptAt: null } });
    await processEmployeeTelegramQueue(prisma); assert.equal(sends().length, 1);
  });
  it("does not replay a send interrupted by an API restart", async () => {
    await connect(); await notice();
    await prisma.notificationDelivery.updateMany({ where: { channel: "telegram" }, data: { state: "sending", claimedAt: new Date(Date.now()-120000) } });
    await processEmployeeTelegramQueue(prisma);
    assert.equal((await deliveries())[0].state, "uncertain"); assert.equal(sends().length, 0);
  });
  it("handles blocking updates and ignores old stop messages after reconnecting", async () => {
    await connect();
    const response = await fetch(`${url}${EMPLOYEE_TELEGRAM_WEBHOOK}`, { method: "POST", headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret }, body: JSON.stringify({ update_id: 52, my_chat_member: { date: Math.floor(Date.now()/1000), chat: { id: 777, type: "private" }, new_chat_member: { status: "kicked" } } }) });
    assert.equal(response.status, 200); assert.equal((await status()).data.connected, false);
    await connect();
    await fetch(`${url}${EMPLOYEE_TELEGRAM_WEBHOOK}`, { method: "POST", headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret }, body: JSON.stringify({ update_id: 51, message: { date: 1, chat: { id: 777, type: "private" }, from: { id: 777 }, text: "/stop" } }) });
    assert.equal((await status()).data.connected, true);
  });
  it("refuses to connect the staff bot as a client-facing company bot", async () => {
    const { connectCompanyTelegram } = await import("./services/telegramCompanyService.ts");
    const { config } = await import("./config.ts");
    const oldBase = config.apiBaseUrl; config.apiBaseUrl = "https://notifications.example.invalid";
    try {
      const member = await prisma.membership.findUniqueOrThrow({ where: { id: owner.id }, include: { user: true, tenant: true } });
      const auth = { user: { ...member.user, platformAdmin: false }, activeMembership: member, memberships: [member] } as any;
      await assert.rejects(() => connectCompanyTelegram(prisma, auth, { token: process.env.TELEGRAM_BOT_TOKEN! }), (err: any) => err.code === "bot_in_use");
      assert.equal(calls.some(call => call.method === "setWebhook"), false);
    } finally { config.apiBaseUrl = oldBase; }
  });
  it("queues a test notification and exposes the actual delivery result", async () => {
    assert.equal((await request("/api/v1/telegram/test", "POST")).status, 409);
    await connect();
    await Promise.all([request("/api/v1/telegram/test", "POST"), request("/api/v1/telegram/test", "POST")]);
    await processEmployeeTelegramQueue(prisma);
    assert.equal(sends().length, 1); assert.equal((await status()).data.lastDelivery.state, "delivered");
  });
});
