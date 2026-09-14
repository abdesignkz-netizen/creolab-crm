import argon2 from "argon2";
import type { Prisma, PrismaClient } from "@creolab/db";
import { ROLES, isCompanyAdminRole } from "@creolab/contracts";
import { config } from "../config.ts";
import { ApiError } from "../errors.ts";
import { writeAudit } from "../lib/audit.ts";
import { randomToken, sha256 } from "../lib/hash.ts";
import type { AuthContext } from "../lib/types.ts";
import { getEffectiveTenantSettings } from "./runtimeSettings.ts";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVITE_ROLES = new Set([ROLES.owner, ROLES.director, ROLES.sales_lead, ROLES.manager]);

export function inviteUrl(token: string) {
  return `${config.appBaseUrl.replace(/\/$/, "")}/invite/${token}`;
}

export function assertInviteRole(role: string) {
  if (role === ROLES.platform_admin) {
    throw new ApiError(403, "forbidden", "Нельзя назначить администратора сервиса через приглашение");
  }
  if (!INVITE_ROLES.has(role as typeof ROLES.owner)) {
    throw new ApiError(422, "invalid", "Некорректная роль");
  }
}

function normalizeEmail(value: string) {
  return String(value || "").trim().toLowerCase();
}

export async function createTenantInvitation(
  prisma: PrismaClient | Prisma.TransactionClient,
  input: {
    tenantId: string;
    email: string;
    role: string;
    name?: string | null;
    phone?: string | null;
    inviterId?: string | null;
    actorUserId?: string | null;
  },
) {
  assertInviteRole(input.role);
  const email = normalizeEmail(input.email);
  if (!email || !email.includes("@")) {
    throw new ApiError(422, "invalid", "Укажите email", { email: "Обязательно" });
  }
  const settings = await getEffectiveTenantSettings(prisma as PrismaClient, input.tenantId);
  const memberLimit = settings.limits.members.value;
  const [activeCount, pendingCount] = await Promise.all([
    prisma.membership.count({ where: { tenantId: input.tenantId, active: true } }),
    prisma.invitation.count({
      where: { tenantId: input.tenantId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    }),
  ]);
  if (activeCount + pendingCount >= memberLimit) {
    throw new ApiError(422, "limit", `Достигнут лимит участников (${memberLimit})`);
  }
  const existingMembership = await prisma.membership.findFirst({
    where: { tenantId: input.tenantId, user: { email } },
  });
  if (existingMembership) {
    throw new ApiError(409, "already_member", "Этот пользователь уже участвует в компании", {
      email: "Участник уже есть",
    });
  }
  const token = randomToken();
  const invitation = await prisma.invitation.create({
    data: {
      tenantId: input.tenantId,
      email,
      role: input.role,
      name: input.name?.trim() || null,
      phone: input.phone?.trim() || null,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      inviterId: input.inviterId || null,
    },
  });
  await writeAudit(prisma, {
    tenantId: input.tenantId,
    actorUserId: input.actorUserId || input.inviterId || null,
    action: "member.invited",
    entityType: "invitation",
    entityId: invitation.id,
    changes: { email, role: input.role, delivery: "link_created" },
  });
  return {
    invitation,
    token,
    inviteUrl: inviteUrl(token),
    delivery: "link_created" as const,
    existingUser: Boolean(await prisma.user.findUnique({ where: { email }, select: { id: true } })),
  };
}

export async function rotateInvitation(
  prisma: PrismaClient,
  invitationId: string,
  actorUserId: string,
) {
  const invitation = await prisma.invitation.findUnique({ where: { id: invitationId } });
  if (!invitation) throw new ApiError(404, "not_found", "Приглашение не найдено");
  if (invitation.acceptedAt) throw new ApiError(422, "accepted", "Приглашение уже принято");
  const token = randomToken();
  const updated = await prisma.invitation.update({
    where: { id: invitation.id },
    data: {
      tokenHash: sha256(token),
      revokedAt: null,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    },
  });
  await writeAudit(prisma, {
    tenantId: invitation.tenantId,
    actorUserId,
    action: "member.invite_resent",
    entityType: "invitation",
    entityId: invitation.id,
    changes: { email: invitation.email, delivery: "link_created" },
  });
  return {
    invitation: updated,
    token,
    inviteUrl: inviteUrl(token),
    delivery: "link_created" as const,
  };
}

export async function revokeInvitation(prisma: PrismaClient, invitationId: string, actorUserId: string) {
  const invitation = await prisma.invitation.findUnique({ where: { id: invitationId } });
  if (!invitation) throw new ApiError(404, "not_found", "Приглашение не найдено");
  if (invitation.acceptedAt) throw new ApiError(422, "accepted", "Приглашение уже принято");
  const updated = await prisma.invitation.update({
    where: { id: invitation.id },
    data: { revokedAt: new Date() },
  });
  await writeAudit(prisma, {
    tenantId: invitation.tenantId,
    actorUserId,
    action: "member.invite_revoked",
    entityType: "invitation",
    entityId: invitation.id,
    changes: { email: invitation.email },
  });
  return updated;
}

export async function previewInvitation(prisma: PrismaClient, token: string) {
  const invitation = await prisma.invitation.findFirst({
    where: { tokenHash: sha256(token) },
    include: { tenant: { select: { id: true, name: true, status: true } } },
  });
  if (!invitation || invitation.revokedAt || invitation.acceptedAt || invitation.expiresAt.getTime() < Date.now()) {
    throw new ApiError(404, "not_found", "Ссылка приглашения недействительна или истекла");
  }
  const existingUser = await prisma.user.findUnique({ where: { email: invitation.email }, select: { id: true } });
  return {
    email: invitation.email,
    role: invitation.role,
    name: invitation.name,
    tenantName: invitation.tenant.name,
    tenantStatus: invitation.tenant.status,
    expiresAt: invitation.expiresAt,
    existingUser: Boolean(existingUser),
    requiresLogin: Boolean(existingUser),
    requiresPassword: !existingUser,
  };
}

export async function acceptInvitation(
  prisma: PrismaClient,
  token: string,
  input: { password?: string; name?: string; auth?: AuthContext | null },
) {
  const invitation = await prisma.invitation.findFirst({
    where: { tokenHash: sha256(token) },
    include: { tenant: true },
  });
  if (!invitation || invitation.revokedAt) {
    throw new ApiError(404, "not_found", "Ссылка приглашения недействительна или истекла");
  }
  if (invitation.acceptedAt) throw new ApiError(409, "accepted", "Приглашение уже использовано");
  if (invitation.expiresAt.getTime() < Date.now()) {
    throw new ApiError(410, "expired", "Срок приглашения истёк");
  }
  if (invitation.tenant.status !== "active") {
    throw new ApiError(403, "tenant_suspended", "Доступ компании приостановлен");
  }

  const existing = await prisma.user.findUnique({ where: { email: invitation.email } });
  let userId: string;
  if (existing) {
    if (!input.auth?.user.id) {
      throw new ApiError(409, "login_required", "Войдите в существующий аккаунт, чтобы принять приглашение");
    }
    if (input.auth.user.email.toLowerCase() !== invitation.email) {
      throw new ApiError(403, "email_mismatch", "Войдите в аккаунт с email из приглашения");
    }
    userId = existing.id;
  } else {
    const password = String(input.password || "");
    if (password.length < 8) {
      throw new ApiError(422, "invalid", "Задайте пароль не короче 8 символов", { password: "Минимум 8 символов" });
    }
    const name =
      String(input.name || invitation.name || "").trim() || invitation.email.split("@")[0] || "Сотрудник";
    const created = await prisma.user.create({
      data: {
        email: invitation.email,
        passwordHash: await argon2.hash(password),
        name,
        phone: invitation.phone,
        platformAdmin: false,
      },
    });
    userId = created.id;
  }

  const membership = await prisma.$transaction(async (tx) => {
    const locked = await tx.invitation.findUnique({ where: { id: invitation.id } });
    if (!locked || locked.acceptedAt || locked.revokedAt) {
      throw new ApiError(409, "accepted", "Приглашение уже использовано");
    }
    const already = await tx.membership.findUnique({
      where: { tenantId_userId: { tenantId: invitation.tenantId, userId } },
    });
    const row =
      already ||
      (await tx.membership.create({
        data: {
          tenantId: invitation.tenantId,
          userId,
          role: invitation.role,
          active: true,
        },
      }));
    if (already && !already.active) {
      await tx.membership.update({ where: { id: already.id }, data: { active: true, role: invitation.role } });
    }
    await tx.invitation.update({
      where: { id: invitation.id },
      data: { acceptedAt: new Date() },
    });
    return row;
  });

  await writeAudit(prisma, {
    tenantId: invitation.tenantId,
    actorUserId: userId,
    action: "member.invite_accepted",
    entityType: "membership",
    entityId: membership.id,
    changes: { email: invitation.email, role: invitation.role, existingUser: Boolean(existing) },
  });

  return {
    tenantId: invitation.tenantId,
    membershipId: membership.id,
    role: membership.role,
    companyAdmin: isCompanyAdminRole(membership.role),
  };
}
