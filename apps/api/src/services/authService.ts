import argon2 from "argon2";
import { SignJWT, jwtVerify } from "jose";
import type { PrismaClient } from "@creolab/db";
import { loginSchema } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { config } from "../config.ts";
import { randomToken, sha256 } from "../lib/hash.ts";
import type { AuthContext } from "../lib/types.ts";

const accessKey = new TextEncoder().encode(config.jwtAccessSecret);
const refreshKey = new TextEncoder().encode(config.jwtRefreshSecret);

function toAuth(user: {
  id: string;
  email: string;
  name: string;
  platformAdmin: boolean;
  memberships: AuthContext["memberships"];
}, sessionId: string, client: "web" | "mobile", tenantId?: string | null): AuthContext {
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
    memberships: user.memberships.map((item) => ({
      id: item.id,
      tenantId: item.tenantId,
      role: item.role as AuthContext["memberships"][number]["role"],
      permissions: Array.isArray(item.permissions) ? (item.permissions as string[]) : [],
      active: item.active,
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

export async function login(prisma: PrismaClient, input: unknown) {
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
  return {
    user: auth.user,
    memberships: auth.memberships.map((item) => ({
      id: item.id,
      role: item.role,
      tenant: item.tenant,
    })),
    activeTenant: auth.activeMembership
      ? {
          membershipId: auth.activeMembership.id,
          role: auth.activeMembership.role,
          tenant: auth.activeMembership.tenant,
        }
      : null,
  };
}
