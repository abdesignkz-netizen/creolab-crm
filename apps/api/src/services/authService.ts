import { SignJWT, jwtVerify } from "jose";
import type { PrismaClient } from "@creolab/db";
import { loginSchema, ROLE_LABELS, type Role } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { config } from "../config.ts";
import { writeAudit } from "../lib/audit.ts";
import { randomToken, sha256 } from "../lib/hash.ts";
import { verifyPassword } from "../lib/password.ts";
import { capabilities } from "../lib/access.ts";
import type { AuthContext } from "../lib/types.ts";

const accessKey = new TextEncoder().encode(config.jwtAccessSecret);
const refreshKey = new TextEncoder().encode(config.jwtRefreshSecret);

function deviceLabelFromUa(ua?: string | null) {
  const value = String(ua || "");
  if (!value) return null;
  const browser = /Edg\//.test(value)
    ? "Edge"
    : /Chrome\//.test(value)
      ? "Chrome"
      : /Firefox\//.test(value)
        ? "Firefox"
        : /Safari\//.test(value)
          ? "Safari"
          : null;
  const os = /iPhone/.test(value)
    ? "iPhone"
    : /Android/.test(value)
      ? "Android"
      : /Mac OS X/.test(value)
        ? "macOS"
        : /Windows/.test(value)
          ? "Windows"
          : /Linux/.test(value)
            ? "Linux"
            : null;
  if (!browser && !os) return null;
  return [browser, os].filter(Boolean).join(" · ");
}

function tenantChoices(memberships: AuthContext["memberships"]) {
  return memberships
    .filter((item) => item.active && item.tenant.status === "active")
    .map((item) => ({
      tenantId: item.tenantId,
      name: item.tenant.name,
      role: item.role,
    }));
}

function denyTenant(code: string, message: string, memberships: AuthContext["memberships"]): never {
  throw new ApiError(403, code, message, undefined, { memberships: tenantChoices(memberships) });
}

function toAuth(
  user: {
    id: string;
    email: string;
    name: string;
    platformAdmin: boolean;
    phone?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    middleName?: string | null;
    city?: string | null;
    avatarStorageKey?: string | null;
    locale?: string;
    timezone?: string | null;
    timeFormat?: string;
    theme?: string;
    memberships: AuthContext["memberships"];
  },
  sessionId: string,
  client: "web" | "mobile",
  tenantId?: string | null,
): AuthContext {
  const requested = String(tenantId || "").trim();
  let active: AuthContext["activeMembership"] = null;
  if (requested) {
    const membership = user.memberships.find((item) => item.tenantId === requested);
    if (!membership) {
      denyTenant("unknown_tenant", "Нет доступа к компании", user.memberships);
    }
    if (!membership.active) {
      denyTenant("membership_suspended", "Участие в компании приостановлено", user.memberships);
    }
    if (membership.tenant.status !== "active") {
      denyTenant("tenant_suspended", "Доступ компании приостановлен", user.memberships);
    }
    active = membership;
  } else {
    active =
      user.memberships.find((item) => item.active && item.tenant.status === "active") ||
      user.memberships.find((item) => item.active) ||
      null;
  }
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      platformAdmin: user.platformAdmin,
      phone: user.phone ?? null,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
      middleName: user.middleName ?? null,
      city: user.city ?? null,
      avatarStorageKey: user.avatarStorageKey ?? null,
      locale: user.locale || "ru",
      timezone: user.timezone ?? null,
      timeFormat: user.timeFormat || "24",
      theme: user.theme || "system",
    },
    memberships: user.memberships,
    activeMembership: active,
    sessionId,
    client,
  };
}

async function loadUser(prisma: PrismaClient, userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      memberships: {
        include: {
          tenant: true,
        },
      },
    },
  });
  if (!user || user.status !== "active") {
    throw new ApiError(401, "unauthorized", "Сессия недействительна");
  }
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    platformAdmin: user.platformAdmin,
    phone: user.phone,
    firstName: user.firstName,
    lastName: user.lastName,
    middleName: user.middleName,
    city: user.city,
    avatarStorageKey: user.avatarStorageKey,
    locale: user.locale,
    timezone: user.timezone,
    timeFormat: user.timeFormat,
    theme: user.theme,
    memberships: user.memberships.map((item) => ({
      id: item.id,
      tenantId: item.tenantId,
      role: item.role as AuthContext["memberships"][number]["role"],
      permissions: Array.isArray(item.permissions) ? (item.permissions as string[]) : [],
      active: item.active,
      jobTitle: item.jobTitle,
      tenant: {
        id: item.tenant.id,
        name: item.tenant.name,
        slug: item.tenant.slug,
        status: item.tenant.status,
        timezone: item.tenant.timezone,
        currency: item.tenant.currency,
        defaultRegion: item.tenant.defaultRegion,
      },
    })),
  };
}

export async function issueSession(
  prisma: PrismaClient,
  userId: string,
  client: "web" | "mobile" = "web",
  meta: { userAgent?: string; ip?: string } = {},
) {
  const sessionToken = randomToken();
  const refreshToken = client === "mobile" ? randomToken() : null;
  const session = await prisma.session.create({
    data: {
      userId,
      type: client,
      secretHash: sha256(sessionToken),
      refreshHash: refreshToken ? sha256(refreshToken) : null,
      expiresAt: new Date(Date.now() + (client === "mobile" ? 15 : 60 * 12) * 60 * 1000),
      refreshExpiresAt: refreshToken ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : null,
      deviceLabel: deviceLabelFromUa(meta.userAgent),
      userAgent: meta.userAgent || null,
      ip: meta.ip || null,
      lastSeenAt: new Date(),
    },
  });
  await prisma.user.update({
    where: { id: userId },
    data: { lastLoginAt: new Date() },
  }).catch(() => undefined);
  await writeAudit(prisma, {
    actorUserId: userId,
    action: "auth.login",
    entityType: "session",
    entityId: session.id,
    changes: { client },
  }).catch(() => undefined);
  const loaded = await loadUser(prisma, userId);
  const auth = toAuth(loaded, session.id, client);
  let accessToken: string | undefined;
  if (client === "mobile") {
    accessToken = await new SignJWT({ sid: session.id, sub: userId })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("15m")
      .sign(accessKey);
  }
  return {
    auth,
    sessionToken,
    refreshToken,
    accessToken,
    cookieName: "crm_session" as const,
  };
}

export async function login(
  prisma: PrismaClient,
  input: unknown,
  meta: { userAgent?: string; ip?: string } = {},
) {
  const parsed = loginSchema.parse(input);
  const user = await prisma.user.findUnique({ where: { email: parsed.email.toLowerCase() } });
  if (!user || !(await verifyPassword(user.passwordHash, parsed.password))) {
    await writeAudit(prisma, {
      action: "auth.login_failed",
      entityType: "user",
      changes: { email: parsed.email.toLowerCase() },
    }).catch(() => undefined);
    throw new ApiError(401, "invalid_credentials", "Неверный email или пароль");
  }
  if (user.status !== "active") {
    throw new ApiError(403, "account_disabled", "Учётная запись отключена");
  }
  return issueSession(prisma, user.id, parsed.client, meta);
}

export async function loginPlatformAdmin(
  prisma: PrismaClient,
  input: unknown,
  meta: { userAgent?: string; ip?: string } = {},
) {
  const result = await login(prisma, input, meta);
  if (!result.auth.user.platformAdmin) {
    await logout(prisma, result.auth.sessionId);
    throw new ApiError(403, "forbidden", "Эта страница только для администратора сервиса");
  }
  return result;
}

export async function logout(prisma: PrismaClient, sessionId: string, all = false, userId?: string) {
  if (all && userId) {
    await prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await writeAudit(prisma, {
      actorUserId: userId,
      action: "auth.logout_all",
      entityType: "session",
      entityId: sessionId,
    }).catch(() => undefined);
    return;
  }
  await prisma.session.update({
    where: { id: sessionId },
    data: { revokedAt: new Date() },
  });
  await writeAudit(prisma, {
    actorUserId: userId || null,
    action: "auth.logout",
    entityType: "session",
    entityId: sessionId,
  }).catch(() => undefined);
}

export async function refreshMobile(prisma: PrismaClient, refreshToken: string) {
  const session = await prisma.session.findFirst({
    where: { refreshHash: sha256(refreshToken), revokedAt: null, type: "mobile" },
  });
  if (!session || !session.refreshExpiresAt || session.refreshExpiresAt < new Date()) {
    throw new ApiError(401, "unauthorized", "Refresh истёк");
  }
  const nextRefresh = randomToken();
  await prisma.session.update({
    where: { id: session.id },
    data: {
      refreshHash: sha256(nextRefresh),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    },
  });
  const accessToken = await new SignJWT({ sid: session.id, sub: session.userId })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("15m")
    .sign(accessKey);
  return { accessToken, refreshToken: nextRefresh };
}

export async function authFromSessionToken(prisma: PrismaClient, token: string, tenantId?: string | null) {
  const session = await prisma.session.findFirst({
    where: { secretHash: sha256(token), revokedAt: null },
  });
  if (!session || session.expiresAt < new Date()) {
    throw new ApiError(401, "unauthorized", "Нужно войти");
  }
  const loaded = await loadUser(prisma, session.userId);
  const now = new Date();
  if (!session.lastSeenAt || now.getTime() - session.lastSeenAt.getTime() > 60_000) {
    await prisma.session.update({
      where: { id: session.id },
      data: { lastSeenAt: now },
    }).catch(() => undefined);
  }
  return toAuth(loaded, session.id, session.type as "web" | "mobile", tenantId);
}

export async function authFromAccessToken(prisma: PrismaClient, token: string, tenantId?: string | null) {
  try {
    const { payload } = await jwtVerify(token, accessKey);
    const session = await prisma.session.findFirst({
      where: { id: String(payload.sid), userId: String(payload.sub), revokedAt: null },
    });
    if (!session || session.expiresAt < new Date()) throw new Error("no session");
    const loaded = await loadUser(prisma, session.userId);
    return toAuth(loaded, session.id, "mobile", tenantId);
  } catch {
    throw new ApiError(401, "unauthorized", "Нужно войти");
  }
}

export function publicAuth(auth: AuthContext) {
  const caps = capabilities(auth);
  return {
    user: {
      id: auth.user.id,
      email: auth.user.email,
      name: auth.user.name,
      platformAdmin: auth.user.platformAdmin,
      ...(auth.user.phone ? { phone: auth.user.phone } : {}),
      firstName: auth.user.firstName ?? null,
      lastName: auth.user.lastName ?? null,
      middleName: auth.user.middleName ?? null,
      city: auth.user.city ?? null,
      hasAvatar: Boolean(auth.user.avatarStorageKey),
      locale: auth.user.locale || "ru",
      timezone: auth.user.timezone ?? null,
      timeFormat: auth.user.timeFormat || "24",
      theme: auth.user.theme || "system",
    },
    memberships: auth.memberships.map((item) => ({
      id: item.id,
      role: item.role,
      roleLabel: ROLE_LABELS[item.role as Role] || item.role,
      jobTitle: item.jobTitle ?? null,
      tenant: item.tenant,
    })),
    activeTenant: auth.activeMembership
      ? {
          membershipId: auth.activeMembership.id,
          role: auth.activeMembership.role,
          roleLabel: ROLE_LABELS[auth.activeMembership.role as Role] || auth.activeMembership.role,
          jobTitle: auth.activeMembership.jobTitle ?? null,
          tenant: auth.activeMembership.tenant,
        }
      : null,
    capabilities: caps,
  };
}

export async function publicAuthWithBilling(prisma: PrismaClient, auth: AuthContext) {
  const { getBillingForAuth } = await import("./billingService.ts");
  return {
    ...publicAuth(auth),
    billing: await getBillingForAuth(prisma, auth),
  };
}
