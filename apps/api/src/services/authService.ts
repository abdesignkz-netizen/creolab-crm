import argon2 from "argon2";
import { SignJWT, jwtVerify } from "jose";
import type { PrismaClient } from "@creolab/db";
import { loginSchema, ROLE_LABELS, type Role } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { config } from "../config.ts";
import { randomToken, sha256 } from "../lib/hash.ts";
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
  const active =
    user.memberships.find((item) => item.active && item.tenantId === tenantId) ||
    user.memberships.find((item) => item.active) ||
    null;
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

export async function login(
  prisma: PrismaClient,
  input: unknown,
  meta: { userAgent?: string; ip?: string } = {},
) {
  const parsed = loginSchema.parse(input);
  const user = await prisma.user.findUnique({ where: { email: parsed.email.toLowerCase() } });
  if (!user || !(await argon2.verify(user.passwordHash, parsed.password))) {
    throw new ApiError(401, "invalid_credentials", "Неверный email или пароль");
  }
  const sessionToken = randomToken();
  const refreshToken = parsed.client === "mobile" ? randomToken() : null;
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      type: parsed.client,
      secretHash: sha256(sessionToken),
      refreshHash: refreshToken ? sha256(refreshToken) : null,
      expiresAt: new Date(Date.now() + (parsed.client === "mobile" ? 15 : 60 * 12) * 60 * 1000),
      refreshExpiresAt: refreshToken ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : null,
      deviceLabel: deviceLabelFromUa(meta.userAgent),
      userAgent: meta.userAgent || null,
      ip: meta.ip || null,
      lastSeenAt: new Date(),
    },
  });
  const loaded = await loadUser(prisma, user.id);
  const auth = toAuth(loaded, session.id, parsed.client);
  let accessToken: string | undefined;
  if (parsed.client === "mobile") {
    accessToken = await new SignJWT({ sid: session.id, sub: user.id })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("15m")
      .sign(accessKey);
  }
  return {
    auth,
    sessionToken,
    refreshToken,
    accessToken,
    cookieName: "crm_session",
  };
}

export async function logout(prisma: PrismaClient, sessionId: string, all = false, userId?: string) {
  if (all && userId) {
    await prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return;
  }
  await prisma.session.update({
    where: { id: sessionId },
    data: { revokedAt: new Date() },
  });
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
    if (!session) throw new Error("no session");
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
