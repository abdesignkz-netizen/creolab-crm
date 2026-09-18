import type { PrismaClient } from "@creolab/db";
import { passwordResetCompleteSchema, passwordResetRequestSchema } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { writeAudit } from "../lib/audit.ts";
import { randomToken, sha256 } from "../lib/hash.ts";
import { hashPassword } from "../lib/password.ts";

const RESET_TTL_MS = 30 * 60 * 1000;
const GENERIC_OK = {
  ok: true as const,
  message: "Если аккаунт с таким email существует, инструкция по сбросу пароля отправлена.",
};

export async function requestPasswordReset(prisma: PrismaClient, input: unknown) {
  const parsed = passwordResetRequestSchema.parse(input);
  const email = parsed.email.toLowerCase();
  const token = randomToken(32);
  const tokenHash = sha256(token);
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.status !== "active") return GENERIC_OK;

  await prisma.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + RESET_TTL_MS),
    },
  });
  await writeAudit(prisma, {
    actorUserId: user.id,
    action: "auth.password_reset_requested",
    entityType: "user",
    entityId: user.id,
  }).catch(() => undefined);
  // Never return the raw token. Email delivery is not implemented; do not add public reset UX.
  return GENERIC_OK;
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
