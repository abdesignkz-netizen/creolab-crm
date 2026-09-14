import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import argon2 from "argon2";
import type { PrismaClient } from "@creolab/db";
import { ROLES, isCompanyAdminRole } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { capabilities, isManager, requireCompanyAdmin, requireTenant } from "../lib/access.ts";
import { ensureUploadsRoot, resolveUploadPath, uploadsRoot } from "../lib/storage.ts";
import type { AuthContext } from "../lib/types.ts";

const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const PROFILE_FIELDS = ["firstName", "lastName", "middleName", "phone", "city"] as const;
const PREFERENCE_LOCALES = new Set(["ru", "kk", "en"]);
const PREFERENCE_THEMES = new Set(["light", "dark", "system"]);
const PREFERENCE_TIME = new Set(["12", "24"]);

const DEFAULT_EVENTS = {
  new_inquiries: true,
  assignment: true,
  dialogs: true,
  tasks: true,
  deals: true,
  ai_events: true,
  management: true,
};

const DEFAULT_CHANNELS = {
  in_app: true,
  web_push: true,
};

const DEFAULT_QUIET = {
  enabled: false,
  start: "22:00",
  end: "08:00",
};

function composeDisplayName(
  current: string,
  firstName?: string | null,
  lastName?: string | null,
  middleName?: string | null,
) {
  const parts = [lastName, firstName, middleName].map((part) => String(part || "").trim()).filter(Boolean);
  return parts.length ? parts.join(" ") : current;
}

function asTrimmed(value: unknown) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

export function serializeUserPublic(user: {
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
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    platformAdmin: user.platformAdmin,
    ...(user.phone ? { phone: user.phone } : {}),
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null,
    middleName: user.middleName ?? null,
    city: user.city ?? null,
    hasAvatar: Boolean(user.avatarStorageKey),
    locale: user.locale || "ru",
    timezone: user.timezone || null,
    timeFormat: user.timeFormat || "24",
    theme: user.theme || "system",
  };
}

export async function updateProfile(prisma: PrismaClient, auth: AuthContext, input: Record<string, unknown>) {
  const data: Record<string, string | null> = {};
  for (const key of PROFILE_FIELDS) {
    if (key in input) data[key] = asTrimmed(input[key]);
  }
  if ("userId" in input || "id" in input || "email" in input || "platformAdmin" in input || "passwordHash" in input) {
    throw new ApiError(403, "forbidden", "Эти поля нельзя изменить через профиль");
  }
  const current = await prisma.user.findUniqueOrThrow({ where: { id: auth.user.id } });
  const firstName = "firstName" in data ? data.firstName : current.firstName;
  const lastName = "lastName" in data ? data.lastName : current.lastName;
  const middleName = "middleName" in data ? data.middleName : current.middleName;
  const name = composeDisplayName(current.name, firstName, lastName, middleName);
  const user = await prisma.user.update({
    where: { id: auth.user.id },
    data: { ...data, name },
  });
  return { user: serializeUserPublic(user) };
}

export async function updateAppearance(prisma: PrismaClient, auth: AuthContext, input: Record<string, unknown>) {
  const data: { locale?: string; timezone?: string | null; timeFormat?: string; theme?: string } = {};
  if ("locale" in input) {
    const locale = String(input.locale || "ru");
    if (!PREFERENCE_LOCALES.has(locale)) throw new ApiError(422, "invalid", "Некорректный язык");
    data.locale = locale;
  }
  if ("timezone" in input) data.timezone = asTrimmed(input.timezone);
  if ("timeFormat" in input) {
    const timeFormat = String(input.timeFormat || "24");
    if (!PREFERENCE_TIME.has(timeFormat)) throw new ApiError(422, "invalid", "Некорректный формат времени");
    data.timeFormat = timeFormat;
  }
  if ("theme" in input) {
    const theme = String(input.theme || "system");
    if (!PREFERENCE_THEMES.has(theme)) throw new ApiError(422, "invalid", "Некорректная тема");
    data.theme = theme;
  }
  const user = await prisma.user.update({ where: { id: auth.user.id }, data });
  return { user: serializeUserPublic(user) };
}

export async function changePassword(
  prisma: PrismaClient,
  auth: AuthContext,
  input: { currentPassword?: string; newPassword?: string; confirmPassword?: string },
) {
  const currentPassword = String(input.currentPassword || "");
  const newPassword = String(input.newPassword || "");
  const confirmPassword = String(input.confirmPassword || "");
  if (newPassword.length < 10) throw new ApiError(422, "invalid", "Новый пароль должен быть не короче 10 символов");
  if (newPassword !== confirmPassword) throw new ApiError(422, "invalid", "Пароли не совпадают", { confirmPassword: "Пароли не совпадают" });
  const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.user.id } });
  const ok = await argon2.verify(user.passwordHash, currentPassword);
  if (!ok) throw new ApiError(422, "invalid", "Неверный текущий пароль", { currentPassword: "Неверный текущий пароль" });
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await argon2.hash(newPassword) },
  });
  await prisma.session.updateMany({
    where: { userId: user.id, revokedAt: null, id: { not: auth.sessionId } },
    data: { revokedAt: new Date() },
  });
  return { ok: true };
}

function sessionTitle(row: { deviceLabel: string | null; userAgent: string | null }) {
  if (row.deviceLabel) return row.deviceLabel;
  if (row.userAgent) return row.userAgent.slice(0, 80);
  return "Сессия";
}

export async function listSessions(prisma: PrismaClient, auth: AuthContext) {
  const items = await prisma.session.findMany({
    where: { userId: auth.user.id, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: [{ lastSeenAt: "desc" }, { expiresAt: "desc" }],
    take: 30,
  });
  return {
    items: items.map((item) => ({
      id: item.id,
      current: item.id === auth.sessionId,
      title: sessionTitle(item),
      deviceLabel: item.deviceLabel,
      userAgent: item.userAgent,
      ip: item.ip,
      lastSeenAt: item.lastSeenAt?.toISOString() || null,
      createdAt: null as string | null,
      expiresAt: item.expiresAt.toISOString(),
    })),
  };
}

export async function revokeSession(prisma: PrismaClient, auth: AuthContext, sessionId: string) {
  const session = await prisma.session.findFirst({ where: { id: sessionId, userId: auth.user.id } });
  if (!session) throw new ApiError(404, "not_found", "Сессия не найдена");
  await prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
  return { ok: true, current: session.id === auth.sessionId };
}

export async function revokeOtherSessions(prisma: PrismaClient, auth: AuthContext) {
  await prisma.session.updateMany({
    where: { userId: auth.user.id, revokedAt: null, id: { not: auth.sessionId } },
    data: { revokedAt: new Date() },
  });
  return { ok: true };
}

export async function saveAvatar(prisma: PrismaClient, auth: AuthContext, input: { contentBase64?: string; mimeType?: string }) {
  const mime = String(input.mimeType || "").toLowerCase();
  const ext = AVATAR_TYPES[mime];
  if (!ext) throw new ApiError(422, "invalid", "Допустимы JPEG, PNG или WebP");
  const raw = String(input.contentBase64 || "").replace(/^data:[^;]+;base64,/, "");
  let buffer: Buffer;
  try {
    buffer = Buffer.from(raw, "base64");
  } catch {
    throw new ApiError(422, "invalid", "Некорректный файл");
  }
  if (!buffer.length) throw new ApiError(422, "invalid", "Файл пуст");
  if (buffer.length > AVATAR_MAX_BYTES) throw new ApiError(422, "invalid", "Файл больше 2 МБ");
  await ensureUploadsRoot();
  const dir = path.join(uploadsRoot(), "avatars");
  await mkdir(dir, { recursive: true });
  const storageKey = `avatars/${auth.user.id}.${ext}`;
  await writeFile(resolveUploadPath(storageKey), buffer);
  const user = await prisma.user.update({
    where: { id: auth.user.id },
    data: { avatarStorageKey: storageKey },
  });
  return { user: serializeUserPublic(user) };
}

export async function avatarFilePath(prisma: PrismaClient, auth: AuthContext) {
  const user = await prisma.user.findUnique({ where: { id: auth.user.id }, select: { avatarStorageKey: true } });
  if (!user?.avatarStorageKey) throw new ApiError(404, "not_found", "Аватар не загружен");
  return resolveUploadPath(user.avatarStorageKey);
}

export async function getNotificationPreferences(prisma: PrismaClient, auth: AuthContext) {
  const membership = requireTenant(auth);
  const row = await prisma.notificationPreference.findUnique({
    where: { tenantId_membershipId: { tenantId: membership.tenantId, membershipId: membership.id } },
  });
  const events = { ...DEFAULT_EVENTS, ...((row?.eventsJson as Record<string, boolean> | undefined) || {}) };
  if (isManager(auth)) events.management = false;
  return {
    events,
    channels: { ...DEFAULT_CHANNELS, ...((row?.channelsJson as Record<string, boolean> | undefined) || {}) },
    quietHours: { ...DEFAULT_QUIET, ...((row?.quietHoursJson as Record<string, unknown> | undefined) || {}) },
    preview: row?.preview || "minimal",
  };
}

export async function updateNotificationPreferences(
  prisma: PrismaClient,
  auth: AuthContext,
  input: Record<string, unknown>,
) {
  const membership = requireTenant(auth);
  const current = await getNotificationPreferences(prisma, auth);
  const events = { ...current.events, ...((input.events as Record<string, boolean> | undefined) || {}) };
  if (isManager(auth)) events.management = false;
  const channelsIn = (input.channels as Record<string, boolean> | undefined) || {};
  const channels = {
    in_app: channelsIn.in_app ?? current.channels.in_app,
    web_push: channelsIn.web_push ?? current.channels.web_push,
  };
  const quietIn = (input.quietHours as Record<string, unknown> | undefined) || {};
  const quietHours = {
    enabled: Boolean(quietIn.enabled ?? current.quietHours.enabled),
    start: String(quietIn.start || current.quietHours.start || "22:00"),
    end: String(quietIn.end || current.quietHours.end || "08:00"),
  };
  const row = await prisma.notificationPreference.upsert({
    where: { tenantId_membershipId: { tenantId: membership.tenantId, membershipId: membership.id } },
    update: { eventsJson: events, channelsJson: channels, quietHoursJson: quietHours },
    create: {
      tenantId: membership.tenantId,
      membershipId: membership.id,
      eventsJson: events,
      channelsJson: channels,
      quietHoursJson: quietHours,
    },
  });
  return getNotificationPreferences(prisma, auth).then((prefs) => ({ ...prefs, id: row.id }));
}

export async function listCompanyMembers(prisma: PrismaClient, auth: AuthContext) {
  requireCompanyAdmin(auth);
  const membership = requireTenant(auth);
  const items = await prisma.membership.findMany({
    where: { tenantId: membership.tenantId },
    include: { user: true },
    orderBy: { createdAt: "asc" },
  });
  return {
    items: items.map((item) => ({
      id: item.id,
      userId: item.userId,
      name: item.user.name,
      email: item.user.email,
      role: item.role,
      jobTitle: item.jobTitle,
      active: item.active,
      isMe: item.id === membership.id,
    })),
    capabilities: capabilities(auth),
  };
}

export async function updateCompanyMember(
  prisma: PrismaClient,
  auth: AuthContext,
  membershipId: string,
  input: Record<string, unknown>,
) {
  requireCompanyAdmin(auth);
  const actor = requireTenant(auth);
  if (isManager(auth)) throw new ApiError(403, "forbidden", "Недостаточно прав");
  const target = await prisma.membership.findFirst({
    where: { id: membershipId, tenantId: actor.tenantId },
  });
  if (!target) throw new ApiError(404, "not_found", "Сотрудник не найден");
  if ("userId" in input || "tenantId" in input || "permissions" in input || "id" in input) {
    throw new ApiError(403, "forbidden", "Эти поля нельзя изменить этим запросом");
  }
  const data: { role?: string; jobTitle?: string | null; active?: boolean; permissions?: object } = {};
  if ("jobTitle" in input) data.jobTitle = asTrimmed(input.jobTitle);
  if ("active" in input) data.active = Boolean(input.active);
  if ("role" in input) {
    const role = String(input.role || "");
    if (![ROLES.owner, ROLES.director, ROLES.sales_lead, ROLES.manager].includes(role as typeof ROLES.owner)) {
      throw new ApiError(422, "invalid", "Некорректная роль");
    }
    if (role === ROLES.platform_admin) throw new ApiError(403, "forbidden", "Нельзя назначить администратора платформы");
    data.role = role;
    if (role === ROLES.manager) data.permissions = [];
  }
  if ("active" in input && data.active === false) {
    data.active = false;
  }
  const nextRole = data.role ?? target.role;
  const nextActive = data.active ?? target.active;
  const wasAdmin = isCompanyAdminRole(target.role) && target.active;
  const staysAdmin = isCompanyAdminRole(nextRole) && nextActive;
  if (wasAdmin && !staysAdmin) {
    const remaining = await prisma.membership.count({
      where: {
        tenantId: actor.tenantId,
        active: true,
        role: { in: [ROLES.owner, ROLES.director] },
        id: { not: target.id },
      },
    });
    if (remaining < 1) throw new ApiError(422, "last_admin", "Нельзя убрать последнего администратора или директора компании");
  }
  const updated = await prisma.membership.update({ where: { id: target.id }, data });
  return {
    id: updated.id,
    role: updated.role,
    jobTitle: updated.jobTitle,
    active: updated.active,
  };
}
