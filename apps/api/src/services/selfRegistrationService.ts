import { randomInt } from "node:crypto";
import type { PrismaClient } from "@creolab/db";
import {
  ROLES,
  selfRegisterSchema,
  verifyRegistrationSchema,
  resendRegistrationSchema,
  SUBSCRIPTION_STATUSES,
} from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { config } from "../config.ts";
import { writeAudit } from "../lib/audit.ts";
import { hmacSha256Hex, safeEqual } from "../lib/hash.ts";
import { hashPassword } from "../lib/password.ts";
import { sendMail, verificationEmail } from "../lib/email.ts";
import { issueSession } from "./authService.ts";
import { provisionOrganization } from "./organizationProvisioning.ts";

const CODE_TTL_MS = 15 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_RESENDS = 5;

function normalizeEmail(value: string) {
  return String(value || "").trim().toLowerCase();
}

function splitName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return {
    name: name.trim(),
    firstName: parts[0] || name.trim(),
    lastName: parts.slice(1).join(" ") || null,
  };
}

function codeHash(email: string, code: string) {
  return hmacSha256Hex(config.sessionSecret, `signup:${email}:${code}`);
}

function sixDigitCode() {
  return String(randomInt(100000, 1000000));
}

function publicRegisterResult(
  email: string,
  expiresAt: Date,
  extras: { verificationCode?: string } = {},
) {
  return {
    ok: true as const,
    email,
    expiresAt: expiresAt.toISOString(),
    message: "Мы отправили код подтверждения на указанный email.",
    ...extras,
  };
}

async function upsertSignupLead(
  prisma: PrismaClient,
  input: { email: string; companyName: string; name: string; ip?: string; userAgent?: string },
) {
  const existing = await prisma.serviceSignupRequest.findFirst({
    where: { email: input.email, status: { in: ["NEW", "REGISTERED"] } },
    orderBy: { createdAt: "desc" },
  });
  if (existing?.status === "REGISTERED") return existing;
  if (existing) {
    return prisma.serviceSignupRequest.update({
      where: { id: existing.id },
      data: { companyName: input.companyName, name: input.name },
    });
  }
  return prisma.serviceSignupRequest.create({
    data: {
      email: input.email,
      companyName: input.companyName,
      name: input.name,
      sourceIp: (input.ip || "").slice(0, 80) || null,
      userAgent: (input.userAgent || "").slice(0, 400) || null,
    },
  });
}

export async function startSelfRegistration(
  prisma: PrismaClient,
  input: unknown,
  meta: { ip?: string; userAgent?: string } = {},
) {
  const parsed = selfRegisterSchema.parse(input);
  const email = normalizeEmail(parsed.email);
  const companyName = parsed.companyName.replace(/\s+/g, " ").trim();
  const names = splitName(parsed.name);

  const existingUser = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existingUser) {
    throw new ApiError(
      409,
      "account_exists",
      "Аккаунт с таким email уже есть. Войдите или восстановите пароль.",
      undefined,
      { login: true, reset: true },
    );
  }

  const pendingOpen = await prisma.pendingRegistration.findFirst({
    where: { email, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (pendingOpen && Date.now() - pendingOpen.lastSentAt.getTime() < RESEND_COOLDOWN_MS) {
    throw new ApiError(429, "rate_limited", "Код уже отправлен. Подождите минуту, прежде чем запросить новый.");
  }

  const code = sixDigitCode();
  const passwordHash = await hashPassword(parsed.password);
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  await prisma.$transaction(async (tx) => {
    await tx.pendingRegistration.updateMany({
      where: { email, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    await tx.pendingRegistration.create({
      data: {
        email,
        name: names.name,
        companyName,
        passwordHash,
        codeHash: codeHash(email, code),
        expiresAt,
        lastSentAt: new Date(),
        sourceIp: (meta.ip || "").slice(0, 80) || null,
        userAgent: (meta.userAgent || "").slice(0, 400) || null,
      },
    });
  });
  await upsertSignupLead(prisma, {
    email,
    companyName,
    name: names.name,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  await sendMail(verificationEmail(email, code));
  await writeAudit(prisma, {
    action: "auth.register_started",
    entityType: "PendingRegistration",
    changes: { email, companyName },
  }).catch(() => undefined);
  return publicRegisterResult(
    email,
    expiresAt,
    config.nodeEnv === "production" ? {} : { verificationCode: code },
  );
}

export async function resendRegistrationCode(
  prisma: PrismaClient,
  input: unknown,
  meta: { ip?: string } = {},
) {
  const parsed = resendRegistrationSchema.parse(input);
  const email = normalizeEmail(parsed.email);
  const pending = await prisma.pendingRegistration.findFirst({
    where: { email, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (!pending) {
    return { ok: true as const, email, message: "Если регистрация начата, новый код отправлен." };
  }
  if (pending.resendCount >= MAX_RESENDS) {
    throw new ApiError(429, "rate_limited", "Слишком много повторных отправок. Начните регистрацию заново.");
  }
  if (Date.now() - pending.lastSentAt.getTime() < RESEND_COOLDOWN_MS) {
    throw new ApiError(429, "rate_limited", "Подождите минуту, прежде чем запросить код повторно.");
  }
  const code = sixDigitCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  await prisma.pendingRegistration.update({
    where: { id: pending.id },
    data: {
      codeHash: codeHash(email, code),
      expiresAt,
      lastSentAt: new Date(),
      attempts: 0,
      resendCount: pending.resendCount + 1,
      sourceIp: (meta.ip || "").slice(0, 80) || pending.sourceIp,
    },
  });
  await sendMail(verificationEmail(email, code));
  return publicRegisterResult(
    email,
    expiresAt,
    config.nodeEnv === "production" ? {} : { verificationCode: code },
  );
}

export async function verifySelfRegistration(
  prisma: PrismaClient,
  input: unknown,
  meta: { ip?: string; userAgent?: string } = {},
) {
  const parsed = verifyRegistrationSchema.parse(input);
  const email = normalizeEmail(parsed.email);
  const pending = await prisma.pendingRegistration.findFirst({
    where: { email, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (!pending) {
    throw new ApiError(400, "invalid_code", "Код недействителен. Начните регистрацию заново.");
  }
  if (pending.expiresAt.getTime() < Date.now()) {
    throw new ApiError(400, "expired_code", "Срок действия кода истёк. Запросите новый.");
  }
  if (pending.attempts >= MAX_ATTEMPTS) {
    throw new ApiError(429, "rate_limited", "Слишком много попыток. Запросите новый код.");
  }
  const expected = pending.codeHash;
  const actual = codeHash(email, parsed.code);
  if (!safeEqual(expected, actual)) {
    await prisma.pendingRegistration.update({
      where: { id: pending.id },
      data: { attempts: { increment: 1 } },
    });
    throw new ApiError(400, "invalid_code", "Неверный код подтверждения.");
  }

  const existingUser = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existingUser) {
    throw new ApiError(
      409,
      "account_exists",
      "Аккаунт с таким email уже есть. Войдите или восстановите пароль.",
      undefined,
      { login: true, reset: true },
    );
  }

  const names = splitName(pending.name);
  const created = await prisma.$transaction(async (tx) => {
    const locked = await tx.pendingRegistration.findUnique({ where: { id: pending.id } });
    if (!locked || locked.consumedAt) {
      throw new ApiError(409, "consumed", "Регистрация уже подтверждена. Войдите в аккаунт.");
    }
    const user = await tx.user.create({
      data: {
        email,
        passwordHash: pending.passwordHash,
        name: names.name,
        firstName: names.firstName,
        lastName: names.lastName,
        emailVerifiedAt: new Date(),
        platformAdmin: false,
        status: "active",
      },
    });
    const tenant = await provisionOrganization(tx, {
      name: pending.companyName,
      contactEmail: email,
      subscriptionStatus: SUBSCRIPTION_STATUSES.NONE,
      aiEnabled: false,
      source: "self_registration",
    });
    const membership = await tx.membership.create({
      data: {
        tenantId: tenant.id,
        userId: user.id,
        role: ROLES.owner,
        active: true,
      },
    });
    await tx.pendingRegistration.update({
      where: { id: pending.id },
      data: { consumedAt: new Date() },
    });
    await tx.serviceSignupRequest.updateMany({
      where: { email, status: "NEW" },
      data: {
        status: "REGISTERED",
        userId: user.id,
        tenantId: tenant.id,
        convertedAt: new Date(),
        processedAt: new Date(),
        name: names.name,
        companyName: pending.companyName,
      },
    });
    await writeAudit(tx, {
      tenantId: tenant.id,
      actorUserId: user.id,
      action: "auth.register_completed",
      entityType: "tenant",
      entityId: tenant.id,
      changes: { email, membershipId: membership.id, role: ROLES.owner },
    });
    return { user, tenant, membership };
  });

  return issueSession(prisma, created.user.id, "web", meta);
}
