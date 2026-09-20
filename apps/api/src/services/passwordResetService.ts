import { randomInt } from "node:crypto";
import type { PrismaClient } from "@creolab/db";
import {
  passwordResetCompleteSchema,
  passwordResetRequestSchema,
  passwordResetVerifySchema,
} from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { writeAudit } from "../lib/audit.ts";
import { hmacSha256Hex, randomToken, safeEqual, sha256 } from "../lib/hash.ts";
import { hashPassword } from "../lib/password.ts";
import { passwordResetEmail, sendMail } from "../lib/email.ts";
import { config } from "../config.ts";

const RESET_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const PURPOSE_CODE = "code";
const PURPOSE_CONTINUATION = "continuation";

const GENERIC_OK = {
  ok: true as const,
  message: "Если аккаунт с таким email существует, мы отправили код для восстановления пароля.",
};

const issuedCodes = new Map<string, string>();

function normalizeEmail(value: string) {
  return String(value || "").trim().toLowerCase();
}

function sixDigitCode() {
  return String(randomInt(100000, 1000000));
}

function codeHash(email: string, code: string) {
  return hmacSha256Hex(config.sessionSecret, `password-reset:${email}:${code}`);
}

function rememberIssuedCode(email: string, code: string) {
  if (config.nodeEnv === "production") return;
  issuedCodes.set(email, code);
}

/** Test-only. Never expose over HTTP — that would enumerate accounts. */
export function peekPasswordResetCode(email: string) {
  if (config.nodeEnv === "production") return null;
  return issuedCodes.get(normalizeEmail(email)) || null;
}

export function clearPasswordResetTestState() {
  issuedCodes.clear();
}

async function issueResetCode(prisma: PrismaClient, userId: string, email: string) {
  const recent = await prisma.passwordResetToken.findFirst({
    where: {
      userId,
      usedAt: null,
      purpose: PURPOSE_CODE,
      createdAt: { gt: new Date(Date.now() - RESEND_COOLDOWN_MS) },
    },
    orderBy: { createdAt: "desc" },
  });
  if (recent) return GENERIC_OK;

  const code = sixDigitCode();
  const now = new Date();
  await prisma.$transaction([
    prisma.passwordResetToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: now },
    }),
    prisma.passwordResetToken.create({
      data: {
        userId,
        tokenHash: codeHash(email, code),
        purpose: PURPOSE_CODE,
        attempts: 0,
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
      },
    }),
  ]);
  rememberIssuedCode(email, code);
  await writeAudit(prisma, {
    actorUserId: userId,
    action: "auth.password_reset_requested",
    entityType: "user",
    entityId: userId,
  }).catch(() => undefined);
  await sendMail(passwordResetEmail(email, code));
  return GENERIC_OK;
}

export async function requestPasswordReset(prisma: PrismaClient, input: unknown) {
  const parsed = passwordResetRequestSchema.parse(input);
  const email = normalizeEmail(parsed.email);
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.status !== "active") return GENERIC_OK;
  return issueResetCode(prisma, user.id, email);
}

export async function resendPasswordReset(prisma: PrismaClient, input: unknown) {
  return requestPasswordReset(prisma, input);
}

export async function verifyPasswordReset(prisma: PrismaClient, input: unknown) {
  const parsed = passwordResetVerifySchema.parse(input);
  const email = normalizeEmail(parsed.email);
  const submittedHash = codeHash(email, parsed.code);
  safeEqual(submittedHash, codeHash(`${email}!`, "000000"));

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.status !== "active") {
    throw new ApiError(400, "invalid_code", "Неверный или истёкший код.");
  }

  const row = await prisma.passwordResetToken.findFirst({
    where: { userId: user.id, usedAt: null, purpose: PURPOSE_CODE },
    orderBy: { createdAt: "desc" },
  });
  if (!row) {
    throw new ApiError(400, "invalid_code", "Неверный или истёкший код.");
  }
  if (row.expiresAt.getTime() < Date.now()) {
    await prisma.passwordResetToken.update({
      where: { id: row.id },
      data: { usedAt: new Date() },
    });
    throw new ApiError(400, "expired_code", "Код истёк. Запросите новый.");
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    await prisma.passwordResetToken.update({
      where: { id: row.id },
      data: { usedAt: new Date() },
    });
    throw new ApiError(400, "too_many_attempts", "Слишком много попыток. Запросите новый код.");
  }
  if (!safeEqual(row.tokenHash, submittedHash)) {
    const nextAttempts = row.attempts + 1;
    const locked = nextAttempts >= MAX_ATTEMPTS;
    await prisma.passwordResetToken.update({
      where: { id: row.id },
      data: {
        attempts: nextAttempts,
        usedAt: locked ? new Date() : null,
      },
    });
    if (locked) {
      throw new ApiError(400, "too_many_attempts", "Слишком много попыток. Запросите новый код.");
    }
    throw new ApiError(400, "invalid_code", "Неверный или истёкший код.");
  }

  const resetToken = randomToken(32);
  const now = new Date();
  await prisma.$transaction([
    prisma.passwordResetToken.update({
      where: { id: row.id },
      data: { usedAt: now },
    }),
    prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(resetToken),
        purpose: PURPOSE_CONTINUATION,
        attempts: 0,
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
      },
    }),
  ]);
  await writeAudit(prisma, {
    actorUserId: user.id,
    action: "auth.password_reset_verified",
    entityType: "user",
    entityId: user.id,
  }).catch(() => undefined);
  return { ok: true as const, resetToken };
}

export async function completePasswordReset(prisma: PrismaClient, input: unknown) {
  const parsed = passwordResetCompleteSchema.parse(input);
  const row = await prisma.passwordResetToken.findFirst({
    where: { tokenHash: sha256(parsed.token), usedAt: null },
  });
  if (!row || row.expiresAt < new Date()) {
    throw new ApiError(400, "invalid_token", "Ссылка для сброса недействительна или истекла");
  }
  const passwordHash = await hashPassword(parsed.password);
  const now = new Date();
  await prisma.$transaction([
    prisma.user.update({ where: { id: row.userId }, data: { passwordHash } }),
    prisma.passwordResetToken.update({ where: { id: row.id }, data: { usedAt: now } }),
    prisma.passwordResetToken.updateMany({
      where: { userId: row.userId, usedAt: null },
      data: { usedAt: now },
    }),
    prisma.session.updateMany({
      where: { userId: row.userId, revokedAt: null },
      data: { revokedAt: now },
    }),
  ]);
  await writeAudit(prisma, {
    actorUserId: row.userId,
    action: "auth.password_reset_completed",
    entityType: "user",
    entityId: row.userId,
  }).catch(() => undefined);
  return { ok: true };
}
