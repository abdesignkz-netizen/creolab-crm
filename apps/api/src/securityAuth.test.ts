import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { sha256, randomToken } from "./lib/hash.ts";
import { redactSensitive } from "./lib/redact.ts";
import { encryptSecret, decryptSecret } from "./lib/secretBox.ts";
import { persistEsfSessionId, revealEsfSessionId } from "./lib/esfSessionSecret.ts";
import { resetRateLimits } from "./lib/rateLimit.ts";

describe("auth security", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let server: { close: (cb?: (err?: Error) => void) => void; address: () => { port: number } | string | null };
  let url = "";
  const password = process.env.SEED_PASSWORD || "ChangeMeLocal1!";

  async function login(email: string, pass = password) {
    const response = await fetch(`${url}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: pass, client: "web" }),
    });
    const setCookie = response.headers.getSetCookie?.()?.[0] || response.headers.get("set-cookie") || "";
    const data = await response.json().catch(() => ({}));
    return { status: response.status, data, setCookie };
  }

  before(async () => {
    process.env.SEED_PASSWORD ||= password;
    process.env.TRUST_PROXY_DEBUG = "1";
    prisma = await createPrismaClient();
    const { seedDatabase } = await import("../../../packages/db/src/seed.ts");
    await seedDatabase();
    const app = createApp(prisma);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve()) as typeof server;
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    url = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await prisma.$disconnect();
  });

  it("redacts secrets in audit-like objects", () => {
    const scrubbed = redactSensitive({
      password: "plain",
      token: "abc",
      pin: "1234",
      sessionId: "esf-session-credential",
      resetToken: "raw-reset",
      nested: { apiKey: "k", name: "ok" },
    }) as Record<string, unknown>;
    assert.equal(scrubbed.password, "[REDACTED]");
    assert.equal(scrubbed.token, "[REDACTED]");
    assert.equal(scrubbed.pin, "[REDACTED]");
    assert.equal(scrubbed.sessionId, "[REDACTED]");
    assert.equal(scrubbed.resetToken, "[REDACTED]");
    assert.equal((scrubbed.nested as Record<string, unknown>).apiKey, "[REDACTED]");
    assert.equal((scrubbed.nested as Record<string, unknown>).name, "ok");
  });

  it("turns Decimal and Date into JSON before they reach the audit log", async () => {
    const { Prisma } = await import("@creolab/db");
    const amount = new Prisma.Decimal("500000");
    const scrubbed = redactSensitive({
      before: { offerAmountMinor: amount },
      after: { offerAmountMinor: amount, nextActionAt: new Date("2026-09-22T01:00:00.000Z") },
      password: "plain",
    }) as {
      before: { offerAmountMinor: unknown };
      after: { offerAmountMinor: unknown; nextActionAt: unknown };
      password: string;
    };
    assert.equal(scrubbed.before.offerAmountMinor, "500000");
    assert.equal(scrubbed.after.offerAmountMinor, "500000");
    assert.equal(scrubbed.after.nextActionAt, "2026-09-22T01:00:00.000Z");
    assert.equal(scrubbed.password, "[REDACTED]");
    const json = JSON.parse(JSON.stringify(scrubbed)) as { before: { offerAmountMinor: string } };
    assert.equal(json.before.offerAmountMinor, "500000");
    assert.equal(JSON.stringify(json).includes("constructor"), false);
  });

  it("encrypts and decrypts integration secrets with AES-GCM", () => {
    const packed = encryptSecret("bridge-secret");
    assert.equal(packed.split(":").length, 3);
    assert.equal(decryptSecret(packed), "bridge-secret");
  });

  it("rejects a wrong password and sets an HttpOnly session cookie on success", async () => {
    const bad = await login("owner@creolab.example", "WrongPass9!");
    assert.equal(bad.status, 401);
    const good = await login("owner@creolab.example");
    assert.equal(good.status, 200);
    assert.match(good.setCookie, /crm_session=/);
    assert.match(good.setCookie, /HttpOnly/i);
    assert.match(good.setCookie, /SameSite=Lax/i);
    assert.match(good.setCookie, /Path=\//i);
    assert.doesNotMatch(good.setCookie, /Secure/i);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "owner@creolab.example" } });
    assert.ok(user.lastLoginAt);
  });

  it("does not create a session for a disabled user", async () => {
    await prisma.user.update({
      where: { email: "manager@creolab.example" },
      data: { status: "disabled" },
    });
    const result = await login("manager@creolab.example");
    assert.equal(result.status, 403);
    const sessions = await prisma.session.count({
      where: { user: { email: "manager@creolab.example" }, revokedAt: null },
    });
    assert.equal(sessions, 0);
    await prisma.user.update({
      where: { email: "manager@creolab.example" },
      data: { status: "active" },
    });
  });

  it("logout invalidates the current session", async () => {
    const good = await login("sales@creolab.example");
    assert.equal(good.status, 200);
    const cookie = good.setCookie.split(";")[0];
    const me = await fetch(`${url}/api/v1/me`, { headers: { cookie } });
    assert.equal(me.status, 200);
    const out = await fetch(`${url}/api/v1/auth/logout`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: "{}",
    });
    assert.equal(out.status, 200);
    const after = await fetch(`${url}/api/v1/me`, { headers: { cookie } });
    assert.equal(after.status, 401);
  });

  it("rate-limits repeated login attempts for one email", async () => {
    const email = `rate-${Date.now()}@creolab.example`;
    await prisma.user.create({
      data: {
        email,
        passwordHash: (await prisma.user.findUniqueOrThrow({ where: { email: "owner@creolab.example" } })).passwordHash,
        name: "Rate",
      },
    });
    let last = 0;
    for (let i = 0; i < 9; i += 1) {
      last = (await login(email, "WrongPass9!")).status;
    }
    assert.equal(last, 429);
  });

  it("resets password with a hashed one-time token and revokes sessions", async () => {
    const unknown = await fetch(`${url}/api/v1/auth/password-reset/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "missing@example.invalid" }),
    });
    assert.equal(unknown.status, 200);
    const unknownBody = await unknown.json();
    const known = await fetch(`${url}/api/v1/auth/password-reset/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@demo-agency.example" }),
    });
    assert.equal(known.status, 200);
    const knownBody = await known.json();
    assert.equal(knownBody.message, unknownBody.message);
    for (const body of [unknownBody, knownBody]) {
      assert.equal("resetToken" in body, false);
      assert.equal("token" in body, false);
      assert.equal("tokenHash" in body, false);
    }

    const demoUser = await prisma.user.findUniqueOrThrow({ where: { email: "owner@demo-agency.example" } });
    const stored = await prisma.passwordResetToken.findMany({ where: { userId: demoUser.id } });
    assert.ok(stored.length >= 1);
    for (const row of stored) {
      assert.match(row.tokenHash, /^[0-9a-f]{64}$/);
      assert.notEqual(row.tokenHash, knownBody.message);
    }

    const session = await login("owner@demo-agency.example");
    const cookie = session.setCookie.split(";")[0];
    const token = "reset-token-value-for-tests-01";
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "owner@demo-agency.example" } });
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });
    const complete = await fetch(`${url}/api/v1/auth/password-reset/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password: "NewSecurePass1" }),
    });
    const completeBody = await complete.json().catch(() => ({}));
    assert.equal(complete.status, 200, JSON.stringify(completeBody));
    assert.equal("resetToken" in completeBody, false);
    assert.equal("token" in completeBody, false);
    const reused = await fetch(`${url}/api/v1/auth/password-reset/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password: "AnotherSecurePass1" }),
    });
    assert.equal(reused.status, 400);
    const consumed = await prisma.passwordResetToken.findFirst({
      where: { tokenHash: sha256(token) },
    });
    assert.ok(consumed?.usedAt);
    const stale = await fetch(`${url}/api/v1/me`, { headers: { cookie } });
    assert.equal(stale.status, 401);
    const again = await login("owner@demo-agency.example", "NewSecurePass1");
    assert.equal(again.status, 200);
  });

  it("rejects an expired password reset token", async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "sales@creolab.example" } });
    const token = "expired-reset-token-for-tests-02";
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    const complete = await fetch(`${url}/api/v1/auth/password-reset/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password: "ExpiredPass1" }),
    });
    assert.equal(complete.status, 400);
    const still = await login("sales@creolab.example");
    assert.equal(still.status, 200);
  });

  it("encrypts ESF sessionId at rest and keeps legacy plaintext readable", () => {
    const packed = persistEsfSessionId("portal-session-token");
    assert.ok(packed);
    assert.notEqual(packed, "portal-session-token");
    assert.equal(revealEsfSessionId(packed), "portal-session-token");
    assert.equal(revealEsfSessionId("legacy-plaintext-session"), "legacy-plaintext-session");
  });

  it("does not let spoofed X-Forwarded-For bypass the IP rate limiter", async () => {
    resetRateLimits();
    let last = 0;
    for (let i = 0; i < 6; i += 1) {
      const response = await fetch(`${url}/api/v1/auth/password-reset/request`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": `203.0.113.${i + 1}`,
        },
        body: JSON.stringify({ email: `xff-${i}@example.invalid` }),
      });
      last = response.status;
    }
    assert.equal(last, 429);
  });

  it("issues 256-bit reset tokens from crypto.randomBytes, never Math.random", () => {
    const first = randomToken(32);
    const second = randomToken(32);
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.match(second, /^[0-9a-f]{64}$/);
    assert.notEqual(first, second);
  });

  it("sets baseline security headers and does not expose x-powered-by", async () => {
    const response = await fetch(`${url}/health`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    assert.equal(response.headers.get("x-powered-by"), null);
    assert.equal(response.headers.get("strict-transport-security"), null);
  });

  it("rejects an expired session cookie", async () => {
    const good = await login("sales@creolab.example");
    assert.equal(good.status, 200);
    const cookie = good.setCookie.split(";")[0];
    const token = cookie.replace(/^crm_session=/, "");
    await prisma.session.updateMany({
      where: { secretHash: sha256(token) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const me = await fetch(`${url}/api/v1/me`, { headers: { cookie } });
    assert.equal(me.status, 401);
  });

  it("exposes proxy IP diagnostics only when opted in and ignores spoofed X-Forwarded-For", async () => {
    const spoofed = "198.51.100.77";
    const response = await fetch(`${url}/api/v1/debug/client-ip`, {
      headers: { "x-forwarded-for": spoofed },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.ip);
    assert.notEqual(body.ip, spoofed);
    assert.equal(String(body.ip).includes(spoofed), false);
    assert.equal(body.trustProxy, false);
  });

  it("rewrites legacy plaintext ESF sessionId to AES-GCM and will not reuse an expired session", async () => {
    const { getEsfConnectionRow, getUsableEsfSession } = await import("./services/esfConnectionService.ts");
    const { readEsfConfig } = await import("./integrations/esf/EsfConfig.ts");
    const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: "creolab" } });
    await prisma.esfConnection.deleteMany({ where: { tenantId: tenant.id, environment: "test" } });
    await prisma.esfConnection.create({
      data: {
        tenantId: tenant.id,
        environment: "test",
        status: "CONNECTED",
        sessionId: "legacy-plain-esf-session",
        sessionExpiresAt: new Date(Date.now() - 60_000),
      },
    });
    const revealed = await getEsfConnectionRow(prisma, tenant.id, "test");
    assert.equal(revealed?.sessionId, "legacy-plain-esf-session");
    const stored = await prisma.esfConnection.findFirstOrThrow({
      where: { tenantId: tenant.id, environment: "test" },
    });
    assert.notEqual(stored.sessionId, "legacy-plain-esf-session");
    assert.equal(revealEsfSessionId(stored.sessionId), "legacy-plain-esf-session");
    const usable = await getUsableEsfSession(prisma, tenant.id, {
      ...readEsfConfig(),
      provider: "mock",
      esfEnv: "test",
    } as ReturnType<typeof readEsfConfig>);
    assert.equal(usable, null);
    const after = await prisma.esfConnection.findFirstOrThrow({
      where: { tenantId: tenant.id, environment: "test" },
    });
    assert.equal(after.sessionId, null);
  });

  it("applies the additive auth security SQL idempotently", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const sql = await readFile(
      resolve(process.cwd(), "packages/db/prisma/migrations/20260918_auth_security_additive.sql"),
      "utf8",
    );
    for (const statement of sql.split(";").map((item) => item.trim()).filter(Boolean)) {
      await prisma.$executeRawUnsafe(statement);
    }
    const rows = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'PasswordResetToken') AS exists`,
    );
    assert.equal(rows[0]?.exists, true);
  });
});
