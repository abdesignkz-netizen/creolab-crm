import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { hashPassword } from "./lib/password.ts";
import { resetRateLimits } from "./lib/rateLimit.ts";
import { peekPasswordResetCode, clearPasswordResetTestState } from "./services/passwordResetService.ts";

describe("password reset via email code", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let server: { close: (cb?: (err?: Error) => void) => void; address: () => { port: number } | string | null };
  let url = "";
  let creolabId = "";

  async function login(email: string, password: string) {
    const response = await fetch(`${url}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, client: "web" }),
    });
    const data = await response.json().catch(() => ({}));
    let cookie = response.headers.getSetCookie?.()?.[0]?.split(";")[0] || "";
    if (!cookie) cookie = (response.headers.get("set-cookie") || "").split(";")[0];
    return { status: response.status, data, cookie };
  }

  async function post(path: string, body: unknown) {
    const response = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, data, setCookie: response.headers.get("set-cookie") || "" };
  }

  async function createUser(email: string, password: string) {
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await hashPassword(password),
        name: "Reset Person",
        memberships: { create: { tenantId: creolabId, role: "manager" } },
      },
      include: { memberships: true },
    });
    return user;
  }

  before(async () => {
    process.env.SEED_PASSWORD ||= "ChangeMeLocal1!";
    prisma = await createPrismaClient();
    const { seedDatabase } = await import("../../../packages/db/src/seed.ts");
    await seedDatabase();
    creolabId = (await prisma.tenant.findFirstOrThrow({ where: { slug: "creolab" } })).id;
    const app = createApp(prisma);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve()) as typeof server;
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    url = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect();
  });

  beforeEach(() => {
    resetRateLimits();
    clearPasswordResetTestState();
  });

  it("does not enumerate unknown emails and does not send a code", async () => {
    const unknown = await post("/api/v1/auth/password-reset/request", { email: "missing@example.invalid" });
    assert.equal(unknown.status, 200);
    assert.equal(
      unknown.data.message,
      "Если аккаунт с таким email существует, мы отправили код для восстановления пароля.",
    );
    assert.equal("code" in unknown.data, false);
    assert.equal("resetToken" in unknown.data, false);
    assert.equal("token" in unknown.data, false);
    assert.equal("userId" in unknown.data, false);
    assert.equal(peekPasswordResetCode("missing@example.invalid"), null);
    const stored = await prisma.passwordResetToken.findMany({
      where: { user: { email: "missing@example.invalid" } },
    });
    assert.equal(stored.length, 0);
  });

  it("returns the same public message for a known email and never puts the code in HTTP", async () => {
    const email = `reset-known-${Date.now()}@example.test`;
    await createUser(email, "OldPass12!");
    const known = await post("/api/v1/auth/password-reset/request", { email });
    const unknown = await post("/api/v1/auth/password-reset/request", { email: "also-missing@example.invalid" });
    assert.equal(known.status, 200);
    assert.equal(unknown.status, 200);
    assert.equal(known.data.message, unknown.data.message);
    assert.equal("code" in known.data, false);
    assert.equal("resetToken" in known.data, false);
    const code = peekPasswordResetCode(email);
    assert.match(String(code), /^\d{6}$/);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const rows = await prisma.passwordResetToken.findMany({ where: { userId: user.id, usedAt: null } });
    assert.equal(rows.length, 1);
    assert.match(rows[0].tokenHash, /^[0-9a-f]{64}$/);
    assert.notEqual(rows[0].tokenHash, code);
    assert.equal(rows[0].purpose, "code");
  });

  it("completes reset with a verified code, revokes sessions, and keeps memberships", async () => {
    const email = `reset-ok-${Date.now()}@example.test`;
    const user = await createUser(email, "OldPass12!");
    const membershipsBefore = user.memberships.map((item) => ({ tenantId: item.tenantId, role: item.role }));
    const session = await login(email, "OldPass12!");
    assert.equal(session.status, 200);
    await post("/api/v1/auth/password-reset/request", { email });
    const code = peekPasswordResetCode(email);
    const verified = await post("/api/v1/auth/password-reset/verify", { email, code });
    assert.equal(verified.status, 200, JSON.stringify(verified.data));
    assert.ok(verified.data.resetToken);
    assert.equal("userId" in verified.data, false);
    assert.equal(verified.setCookie.includes("crm_session"), false);

    const sixDigitComplete = await post("/api/v1/auth/password-reset/complete", {
      token: code,
      password: "NewSecurePass1",
    });
    assert.notEqual(sixDigitComplete.status, 200);

    const completed = await post("/api/v1/auth/password-reset/complete", {
      token: verified.data.resetToken,
      password: "NewSecurePass1",
      passwordConfirm: "NewSecurePass1",
    });
    assert.equal(completed.status, 200, JSON.stringify(completed.data));
    assert.equal(completed.data.ok, true);
    assert.equal("resetToken" in completed.data, false);

    const reusedCode = await post("/api/v1/auth/password-reset/verify", { email, code });
    assert.equal(reusedCode.status, 400);
    const reusedToken = await post("/api/v1/auth/password-reset/complete", {
      token: verified.data.resetToken,
      password: "AnotherSecure1",
    });
    assert.equal(reusedToken.status, 400);

    const stale = await fetch(`${url}/api/v1/me`, { headers: { cookie: session.cookie } });
    assert.equal(stale.status, 401);
    const oldLogin = await login(email, "OldPass12!");
    assert.equal(oldLogin.status, 401);
    const nextLogin = await login(email, "NewSecurePass1");
    assert.equal(nextLogin.status, 200);
    const me = await fetch(`${url}/api/v1/me`, { headers: { cookie: nextLogin.cookie } });
    const meBody = await me.json();
    const membershipsAfter = (meBody.user?.memberships || meBody.memberships || []).map((item: { tenant?: { id?: string }; tenantId?: string; role: string }) => ({
      tenantId: item.tenantId || item.tenant?.id,
      role: item.role,
    }));
    assert.deepEqual(
      membershipsAfter.map((item: { tenantId: string; role: string }) => item.tenantId).sort(),
      membershipsBefore.map((item) => item.tenantId).sort(),
    );
    const leftover = await prisma.passwordResetToken.findMany({
      where: { userId: user.id, usedAt: null },
    });
    assert.equal(leftover.length, 0);
  });

  it("locks a challenge after too many wrong codes", async () => {
    const email = `reset-wrong-${Date.now()}@example.test`;
    const user = await createUser(email, "OldPass12!");
    await post("/api/v1/auth/password-reset/request", { email });
    const code = peekPasswordResetCode(email);
    let last = { status: 0, data: {} as Record<string, unknown> };
    for (let i = 0; i < 5; i += 1) {
      last = await post("/api/v1/auth/password-reset/verify", { email, code: "000000" });
    }
    assert.equal(last.status, 400);
    assert.equal(last.data.code, "too_many_attempts");
    const row = await prisma.passwordResetToken.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(row?.usedAt);
    assert.ok((row?.attempts || 0) >= 5);
    const correct = await post("/api/v1/auth/password-reset/verify", { email, code });
    assert.equal(correct.status, 400);
  });

  it("rejects an expired reset code", async () => {
    const email = `reset-expired-${Date.now()}@example.test`;
    const user = await createUser(email, "OldPass12!");
    await post("/api/v1/auth/password-reset/request", { email });
    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null, purpose: "code" },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await post("/api/v1/auth/password-reset/verify", {
      email,
      code: peekPasswordResetCode(email),
    });
    assert.equal(expired.status, 400);
    assert.equal(expired.data.code, "expired_code");
    assert.match(String(expired.data.message), /истёк/i);
  });

  it("invalidates the previous code after a cooldown-respecting resend", async () => {
    const email = `reset-resend-${Date.now()}@example.test`;
    const user = await createUser(email, "OldPass12!");
    await post("/api/v1/auth/password-reset/request", { email });
    const codeA = peekPasswordResetCode(email);
    const immediate = await post("/api/v1/auth/password-reset/resend", { email });
    assert.equal(immediate.status, 200);
    assert.equal(peekPasswordResetCode(email), codeA);
    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { createdAt: new Date(Date.now() - 61_000) },
    });
    const resent = await post("/api/v1/auth/password-reset/resend", { email });
    assert.equal(resent.status, 200);
    const codeB = peekPasswordResetCode(email);
    assert.match(String(codeB), /^\d{6}$/);
    assert.notEqual(codeB, codeA);
    const old = await post("/api/v1/auth/password-reset/verify", { email, code: codeA });
    assert.equal(old.status, 400);
    const next = await post("/api/v1/auth/password-reset/verify", { email, code: codeB });
    assert.equal(next.status, 200, JSON.stringify(next.data));
    assert.ok(next.data.resetToken);
  });
});
