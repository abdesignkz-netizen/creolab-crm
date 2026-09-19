import { randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "@creolab/db";
import { ROLES, ROLE_LABELS, isCompanyAdminRole } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { writeAudit } from "../lib/audit.ts";
import { cursorPage } from "../lib/hash.ts";
import { requirePlatformAdmin } from "../lib/access.ts";
import type { AuthContext } from "../lib/types.ts";
import { PIPELINE_STAGES } from "./dealPipeline.ts";
import {
  createTenantInvitation,
  revokeInvitation,
  rotateInvitation,
} from "./invitationService.ts";
import { publicConnectionStatus } from "./platformCatalog.ts";
import {
  getEffectiveTenantSettings,
  getPlatformSettings,
  invalidateRuntimeConfig,
  savePlatformSettings,
} from "./runtimeSettings.ts";

const COMPANY_ADMIN_ROLES = [ROLES.owner, ROLES.director];

function slugify(name: string) {
  const translit: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
    к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
    х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  };
  const base = name
    .trim()
    .toLowerCase()
    .split("")
    .map((ch) => translit[ch] ?? ch)
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "company";
}

function asTrimmed(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

function tenantSettingsPatch(current: unknown, patch: Record<string, unknown>) {
  const base = current && typeof current === "object" ? { ...(current as Record<string, unknown>) } : {};
  if ("city" in patch) base.city = asTrimmed(patch.city);
  if ("contactEmail" in patch) base.contactEmail = asTrimmed(patch.contactEmail);
  if ("contactPhone" in patch) base.contactPhone = asTrimmed(patch.contactPhone);
  if (patch.features && typeof patch.features === "object") {
    base.features = { ...(typeof base.features === "object" && base.features ? base.features : {}), ...patch.features };
  }
  if (patch.limits && typeof patch.limits === "object") {
    base.limits = { ...(typeof base.limits === "object" && base.limits ? base.limits : {}), ...patch.limits };
  }
  return base;
}

async function assertRemainingCompanyAdmin(
  prisma: PrismaClient,
  tenantId: string,
  exceptMembershipId: string,
) {
  const remaining = await prisma.membership.count({
    where: {
      tenantId,
      active: true,
      role: { in: [...COMPANY_ADMIN_ROLES] },
      id: { not: exceptMembershipId },
    },
  });
  if (remaining < 1) {
    throw new ApiError(422, "last_admin", "Нельзя убрать последнего администратора или директора компании без замены");
  }
}

function lastSeenMap(sessions: Array<{ userId: string; lastSeenAt: Date | null; createdAt?: Date }>) {
  const map = new Map<string, Date>();
  for (const row of sessions) {
    const at = row.lastSeenAt;
    if (!at) continue;
    const prev = map.get(row.userId);
    if (!prev || at > prev) map.set(row.userId, at);
  }
  return map;
}

export async function platformOverview(prisma: PrismaClient, auth: AuthContext) {
  requirePlatformAdmin(auth);
  const now = new Date();
  const [
    tenantsTotal,
    tenantsActive,
    tenantsSuspended,
    membersActive,
    invitationsPending,
    signupPending,
    integrations,
  ] = await Promise.all([
    prisma.tenant.count(),
    prisma.tenant.count({ where: { status: "active" } }),
    prisma.tenant.count({ where: { status: "suspended" } }),
    prisma.membership.count({ where: { active: true } }),
    prisma.invitation.count({
      where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
    }),
    prisma.serviceSignupRequest.count({ where: { status: "NEW" } }),
    prisma.integration.findMany({
      select: { status: true, connectionStatus: true, healthStatus: true, lastError: true, lastErrorCode: true, lastSuccessAt: true, type: true, schemaJson: true },
    }),
  ]);
  let connected = 0;
  let unhealthy = 0;
  let needsAssignment = 0;
  for (const row of integrations) {
    const lifecycle = publicConnectionStatus(row);
    if (lifecycle === "connected" || lifecycle === "created" || lifecycle === "working") connected += 1;
    if (lifecycle === "error" || lifecycle === "reauth") unhealthy += 1;
    if (lifecycle === "needs_assignment") needsAssignment += 1;
  }
  return {
    tenantsTotal,
    tenantsActive,
    tenantsSuspended,
    membersActive,
    invitationsPending,
    signupPending,
    integrationsConnected: connected,
    integrationsUnhealthy: unhealthy,
    integrationsNeedsAssignment: needsAssignment,
  };
}

export async function listPlatformCompanies(
  prisma: PrismaClient,
  auth: AuthContext,
  query: { q?: string; status?: string; page?: string | number; limit?: string | number },
) {
  requirePlatformAdmin(auth);
  const take = cursorPage(query.limit);
  const page = Math.max(1, Number(query.page || 1) || 1);
  const where: Prisma.TenantWhereInput = {};
  if (query.status) where.status = String(query.status);
  if (query.q) {
    const q = String(query.q).trim();
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { slug: { contains: q, mode: "insensitive" } },
    ];
  }
  const [total, items] = await Promise.all([
    prisma.tenant.count({ where }),
    prisma.tenant.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * take,
      take,
      include: {
        legalProfile: true,
        memberships: {
          where: { active: true },
          include: { user: { select: { id: true, name: true, email: true, phone: true } } },
        },
        integrations: {
          select: { type: true, status: true, connectionStatus: true, healthStatus: true, lastError: true, lastErrorCode: true, lastSuccessAt: true, schemaJson: true },
        },
      },
    }),
  ]);
  return {
    page,
    pageSize: take,
    total,
    items: items.map((tenant) => {
      const settings = tenant.settingsJson && typeof tenant.settingsJson === "object"
        ? (tenant.settingsJson as Record<string, unknown>)
        : {};
      const admin = tenant.memberships.find((item) => isCompanyAdminRole(item.role));
      const connectionSummary = tenant.integrations.map((row) => publicConnectionStatus(row));
      return {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        status: tenant.status,
        timezone: tenant.timezone,
        createdAt: tenant.createdAt,
        bin: tenant.legalProfile?.bin || tenant.legalProfile?.iin || null,
        legalName: tenant.legalProfile?.legalName || null,
        contactEmail: tenant.legalProfile?.email || settings.contactEmail || null,
        contactPhone: tenant.legalProfile?.phone || settings.contactPhone || null,
        city: settings.city || null,
        admin: admin
          ? { name: admin.user.name, email: admin.user.email, role: admin.role, roleLabel: ROLE_LABELS[admin.role as keyof typeof ROLE_LABELS] || admin.role }
          : null,
        memberCount: tenant.memberships.length,
        integrationTypes: tenant.integrations.map((row) => row.type),
        connectionSummary,
        connectionsLabel: connectionSummary.length
          ? [...new Set(connectionSummary.map((item) => item))].join(", ")
          : "нет",
      };
    }),
  };
}

async function companyCard(prisma: PrismaClient, tenantId: string) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    include: { legalProfile: true },
  });
  if (!tenant) throw new ApiError(404, "not_found", "Компания не найдена");
  const settings = await getEffectiveTenantSettings(prisma, tenantId);
  const raw = tenant.settingsJson && typeof tenant.settingsJson === "object"
    ? (tenant.settingsJson as Record<string, unknown>)
    : {};
  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    status: tenant.status,
    timezone: tenant.timezone,
    currency: tenant.currency,
    createdAt: tenant.createdAt,
    updatedAt: tenant.updatedAt,
    legalName: tenant.legalProfile?.legalName || null,
    bin: tenant.legalProfile?.bin || null,
    iin: tenant.legalProfile?.iin || null,
    contactEmail: tenant.legalProfile?.email || raw.contactEmail || null,
    contactPhone: tenant.legalProfile?.phone || raw.contactPhone || null,
    city: raw.city || null,
    documentsEnabled: tenant.legalProfile?.documentsEnabled ?? true,
    esfIntegrationEnabled: tenant.legalProfile?.esfIntegrationEnabled ?? false,
    contractSigningEnabled: tenant.legalProfile?.contractSigningEnabled ?? false,
    settings,
    rawSettings: {
      city: raw.city || null,
      contactEmail: raw.contactEmail || null,
      contactPhone: raw.contactPhone || null,
      features: raw.features || {},
      limits: raw.limits || {},
    },
  };
}

export async function getPlatformCompany(prisma: PrismaClient, auth: AuthContext, tenantId: string) {
  requirePlatformAdmin(auth);
  return companyCard(prisma, tenantId);
}

export async function createPlatformCompany(prisma: PrismaClient, auth: AuthContext, input: Record<string, unknown>) {
  requirePlatformAdmin(auth);
  const name = String(input.name || "").trim();
  if (!name) throw new ApiError(422, "invalid", "Укажите название", { name: "Обязательно" });
  const adminEmail = String(input.adminEmail || "").trim().toLowerCase();
  if (!adminEmail || !adminEmail.includes("@")) {
    throw new ApiError(422, "invalid", "Укажите email первого администратора", { adminEmail: "Обязательно" });
  }
  const adminRole = String(input.adminRole || ROLES.owner);
  const bin = asTrimmed(input.bin);
  if (bin) {
    const duplicateBin = await prisma.tenantLegalProfile.findFirst({ where: { bin } });
    if (duplicateBin) {
      throw new ApiError(409, "duplicate_bin", "Организация с таким БИН уже подключена", {
        bin: "Совпадает с существующей организацией сервиса",
      });
    }
  }
  let slug = slugify(name);
  const slugTaken = await prisma.tenant.findUnique({ where: { slug } });
  if (slugTaken) slug = `${slug}-${randomBytes(3).toString("hex")}`;

  const existingUser = await prisma.user.findUnique({ where: { email: adminEmail }, select: { id: true, email: true } });
  const starter = await prisma.plan.findUnique({ where: { code: "starter" } });

  const created = await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: {
        name,
        slug,
        timezone: String(input.timezone || "Asia/Almaty"),
        settingsJson: {
          city: asTrimmed(input.city),
          contactEmail: asTrimmed(input.contactEmail) || adminEmail,
          contactPhone: asTrimmed(input.contactPhone) || asTrimmed(input.adminPhone),
        } as Prisma.InputJsonValue,
      },
    });
    await tx.tenantLegalProfile.create({
      data: {
        tenantId: tenant.id,
        legalName: asTrimmed(input.legalName),
        bin,
        iin: asTrimmed(input.iin),
        email: asTrimmed(input.contactEmail) || adminEmail,
        phone: asTrimmed(input.contactPhone) || asTrimmed(input.adminPhone),
      },
    });
    if (starter) {
      await tx.tenantPlan.create({ data: { tenantId: tenant.id, planId: starter.id, status: "active" } });
    }
    for (const def of PIPELINE_STAGES) {
      await tx.dealStage.create({
        data: {
          tenantId: tenant.id,
          systemKey: def.systemKey,
          name: def.name,
          sortOrder: def.sortOrder,
          defaultProbability: def.defaultProbability,
        },
      });
    }
    await tx.knowledgeVersion.create({
      data: {
        tenantId: tenant.id,
        version: 1,
        status: "published",
        publishedAt: new Date(),
        contentJson: { about: name, services: [] },
      },
    });
    await tx.aIConfiguration.create({
      data: { tenantId: tenant.id, enabled: true, provider: null },
    });
    const invite = await createTenantInvitation(tx, {
      tenantId: tenant.id,
      email: adminEmail,
      role: adminRole,
      name: asTrimmed(input.adminName),
      phone: asTrimmed(input.adminPhone),
      inviterId: auth.user.id,
      actorUserId: auth.user.id,
    });
    await writeAudit(tx, {
      tenantId: tenant.id,
      actorUserId: auth.user.id,
      action: "company.created",
      entityType: "tenant",
      entityId: tenant.id,
      changes: { name, slug, existingUser: Boolean(existingUser) },
    });
    return { tenant, invite };
  });

  return {
    company: await companyCard(prisma, created.tenant.id),
    invitation: {
      id: created.invite.invitation.id,
      email: adminEmail,
      inviteUrl: created.invite.inviteUrl,
      delivery: created.invite.delivery,
      expiresAt: created.invite.invitation.expiresAt,
      existingUser: created.invite.existingUser,
    },
  };
}

export async function updatePlatformCompany(
  prisma: PrismaClient,
  auth: AuthContext,
  tenantId: string,
  input: Record<string, unknown>,
) {
  requirePlatformAdmin(auth);
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, include: { legalProfile: true } });
  if (!tenant) throw new ApiError(404, "not_found", "Компания не найдена");
  if (input.bin) {
    const duplicateBin = await prisma.tenantLegalProfile.findFirst({
      where: { bin: String(input.bin), tenantId: { not: tenantId } },
    });
    if (duplicateBin) {
      throw new ApiError(409, "duplicate_bin", "Организация с таким БИН уже подключена", { bin: "Занят другой компанией" });
    }
  }
  await prisma.$transaction(async (tx) => {
    await tx.tenant.update({
      where: { id: tenantId },
      data: {
        name: input.name ? String(input.name) : undefined,
        timezone: input.timezone ? String(input.timezone) : undefined,
        currency: input.currency ? String(input.currency) : undefined,
        settingsJson: tenantSettingsPatch(tenant.settingsJson, input) as Prisma.InputJsonValue,
      },
    });
    const legalData = {
      legalName: "legalName" in input ? asTrimmed(input.legalName) : undefined,
      bin: "bin" in input ? asTrimmed(input.bin) : undefined,
      iin: "iin" in input ? asTrimmed(input.iin) : undefined,
      email: "contactEmail" in input ? asTrimmed(input.contactEmail) : undefined,
      phone: "contactPhone" in input ? asTrimmed(input.contactPhone) : undefined,
      documentsEnabled: "documentsEnabled" in input ? Boolean(input.documentsEnabled) : undefined,
      esfIntegrationEnabled: "esfIntegrationEnabled" in input ? Boolean(input.esfIntegrationEnabled) : undefined,
      contractSigningEnabled: "contractSigningEnabled" in input ? Boolean(input.contractSigningEnabled) : undefined,
    };
    if (tenant.legalProfile) {
      await tx.tenantLegalProfile.update({ where: { tenantId }, data: legalData });
    } else {
      await tx.tenantLegalProfile.create({
        data: { tenantId, ...legalData },
      });
    }
  });
  invalidateRuntimeConfig(tenantId);
  await writeAudit(prisma, {
    tenantId,
    actorUserId: auth.user.id,
    action: "company.updated",
    entityType: "tenant",
    entityId: tenantId,
    changes: { fields: Object.keys(input) },
  });
  return companyCard(prisma, tenantId);
}

export async function setPlatformCompanyStatus(
  prisma: PrismaClient,
  auth: AuthContext,
  tenantId: string,
  status: "active" | "suspended",
) {
  requirePlatformAdmin(auth);
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new ApiError(404, "not_found", "Компания не найдена");
  await prisma.tenant.update({ where: { id: tenantId }, data: { status } });
  invalidateRuntimeConfig(tenantId);
  await writeAudit(prisma, {
    tenantId,
    actorUserId: auth.user.id,
    action: status === "suspended" ? "company.suspended" : "company.restored",
    entityType: "tenant",
    entityId: tenantId,
    changes: { status },
  });
  return companyCard(prisma, tenantId);
}

export async function listPlatformMembers(
  prisma: PrismaClient,
  auth: AuthContext,
  query: { q?: string; tenantId?: string; page?: string | number; limit?: string | number; status?: string },
) {
  requirePlatformAdmin(auth);
  const take = cursorPage(query.limit);
  const page = Math.max(1, Number(query.page || 1) || 1);
  const where: Prisma.MembershipWhereInput = {};
  if (query.tenantId) where.tenantId = String(query.tenantId);
  if (query.status === "active") where.active = true;
  if (query.status === "suspended") where.active = false;
  if (query.q) {
    const q = String(query.q).trim();
    where.OR = [
      { user: { email: { contains: q, mode: "insensitive" } } },
      { user: { name: { contains: q, mode: "insensitive" } } },
      { user: { firstName: { contains: q, mode: "insensitive" } } },
      { user: { lastName: { contains: q, mode: "insensitive" } } },
    ];
  }
  const [total, items] = await Promise.all([
    prisma.membership.count({ where }),
    prisma.membership.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * take,
      take,
      include: {
        user: { select: { id: true, name: true, email: true, phone: true, firstName: true, lastName: true, status: true } },
        tenant: { select: { id: true, name: true, status: true } },
      },
    }),
  ]);
  const lastSeen = lastSeenMap(
    await prisma.session.findMany({
      where: { userId: { in: items.map((item) => item.userId) } },
      select: { userId: true, lastSeenAt: true },
    }),
  );
  return {
    page,
    pageSize: take,
    total,
    items: items.map((item) => ({
      id: item.id,
      tenantId: item.tenantId,
      tenantName: item.tenant.name,
      tenantStatus: item.tenant.status,
      userId: item.userId,
      name: item.user.name,
      firstName: item.user.firstName,
      lastName: item.user.lastName,
      email: item.user.email,
      phone: item.user.phone,
      role: item.role,
      roleLabel: ROLE_LABELS[item.role as keyof typeof ROLE_LABELS] || item.role,
      active: item.active,
      createdAt: item.createdAt,
      lastSeenAt: lastSeen.get(item.userId) || null,
    })),
  };
}

export async function listCompanyMembers(prisma: PrismaClient, auth: AuthContext, tenantId: string) {
  requirePlatformAdmin(auth);
  const [members, invitations] = await Promise.all([
    listPlatformMembers(prisma, auth, { tenantId, limit: 100 }),
    prisma.invitation.findMany({
      where: { tenantId },
      orderBy: { expiresAt: "desc" },
    }),
  ]);
  return {
    members: members.items,
    invitations: invitations.map((item) => ({
      id: item.id,
      email: item.email,
      name: item.name,
      role: item.role,
      roleLabel: ROLE_LABELS[item.role as keyof typeof ROLE_LABELS] || item.role,
      expiresAt: item.expiresAt,
      acceptedAt: item.acceptedAt,
      revokedAt: item.revokedAt,
      status: item.acceptedAt ? "accepted" : item.revokedAt ? "revoked" : item.expiresAt < new Date() ? "expired" : "pending",
    })),
  };
}

export async function invitePlatformMember(
  prisma: PrismaClient,
  auth: AuthContext,
  tenantId: string,
  input: Record<string, unknown>,
) {
  requirePlatformAdmin(auth);
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new ApiError(404, "not_found", "Компания не найдена");
  const result = await createTenantInvitation(prisma, {
    tenantId,
    email: String(input.email || ""),
    role: String(input.role || ROLES.manager),
    name: asTrimmed(input.name),
    phone: asTrimmed(input.phone),
    inviterId: auth.user.id,
    actorUserId: auth.user.id,
  });
  return {
    id: result.invitation.id,
    email: result.invitation.email,
    inviteUrl: result.inviteUrl,
    delivery: result.delivery,
    expiresAt: result.invitation.expiresAt,
    existingUser: result.existingUser,
  };
}

export async function repeatPlatformInvitation(prisma: PrismaClient, auth: AuthContext, invitationId: string) {
  requirePlatformAdmin(auth);
  const invitation = await prisma.invitation.findUnique({ where: { id: invitationId } });
  if (!invitation) throw new ApiError(404, "not_found", "Приглашение не найдено");
  const result = await rotateInvitation(prisma, invitationId, auth.user.id);
  return {
    id: result.invitation.id,
    inviteUrl: result.inviteUrl,
    delivery: result.delivery,
    expiresAt: result.invitation.expiresAt,
  };
}

export async function revokePlatformInvitation(prisma: PrismaClient, auth: AuthContext, invitationId: string) {
  requirePlatformAdmin(auth);
  await revokeInvitation(prisma, invitationId, auth.user.id);
  return { ok: true };
}

export async function updatePlatformMembership(
  prisma: PrismaClient,
  auth: AuthContext,
  membershipId: string,
  input: Record<string, unknown>,
) {
  requirePlatformAdmin(auth);
  const target = await prisma.membership.findUnique({ where: { id: membershipId } });
  if (!target) throw new ApiError(404, "not_found", "Участник не найден");
  if ("role" in input) {
    const role = String(input.role || "");
    if (role === ROLES.platform_admin) {
      throw new ApiError(403, "forbidden", "Нельзя назначить администратора сервиса");
    }
    if (![ROLES.owner, ROLES.director, ROLES.sales_lead, ROLES.manager].includes(role as typeof ROLES.owner)) {
      throw new ApiError(422, "invalid", "Некорректная роль");
    }
  }
  const nextRole = "role" in input ? String(input.role) : target.role;
  const nextActive = "active" in input ? Boolean(input.active) : target.active;
  const wasAdmin = isCompanyAdminRole(target.role) && target.active;
  const staysAdmin = isCompanyAdminRole(nextRole) && nextActive;
  if (wasAdmin && !staysAdmin) await assertRemainingCompanyAdmin(prisma, target.tenantId, target.id);
  const updated = await prisma.membership.update({
    where: { id: target.id },
    data: {
      role: "role" in input ? nextRole : undefined,
      active: "active" in input ? nextActive : undefined,
      jobTitle: "jobTitle" in input ? asTrimmed(input.jobTitle) : undefined,
      permissions: nextRole === ROLES.manager ? [] : undefined,
    },
  });
  await writeAudit(prisma, {
    tenantId: target.tenantId,
    actorUserId: auth.user.id,
    action: "role" in input ? "member.role_changed" : "active" in input ? (nextActive ? "member.restored" : "member.suspended") : "member.updated",
    entityType: "membership",
    entityId: target.id,
    changes: { role: updated.role, active: updated.active },
  });
  return { id: updated.id, role: updated.role, active: updated.active, jobTitle: updated.jobTitle };
}

export async function revokeMembershipSessions(
  prisma: PrismaClient,
  auth: AuthContext,
  membershipId: string,
) {
  requirePlatformAdmin(auth);
  const target = await prisma.membership.findUnique({ where: { id: membershipId } });
  if (!target) throw new ApiError(404, "not_found", "Участник не найден");
  const result = await prisma.session.updateMany({
    where: { userId: target.userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await writeAudit(prisma, {
    tenantId: target.tenantId,
    actorUserId: auth.user.id,
    action: "member.sessions_revoked",
    entityType: "user",
    entityId: target.userId,
    changes: { count: result.count, note: "Сессии пользователя завершены во всех компаниях" },
  });
  return { ok: true, count: result.count };
}

export async function listPlatformAudit(
  prisma: PrismaClient,
  auth: AuthContext,
  query: { tenantId?: string; q?: string; page?: string | number; limit?: string | number },
) {
  requirePlatformAdmin(auth);
  const take = cursorPage(query.limit);
  const page = Math.max(1, Number(query.page || 1) || 1);
  const where: Prisma.AuditEventWhereInput = {
    action: {
      in: [
        "company.created",
        "company.updated",
        "company.suspended",
        "company.restored",
        "member.invited",
        "member.invite_resent",
        "member.invite_revoked",
        "member.invite_accepted",
        "member.role_changed",
        "member.suspended",
        "member.restored",
        "member.updated",
        "member.sessions_revoked",
        "integration.connected",
        "integration.updated",
        "integration.disabled",
        "integration.enabled",
        "integration.secret_rotated",
        "integration.whatsapp.connect",
        "integration.whatsapp.secret_replaced",
        "settings.ai_updated",
        "settings.platform_updated",
      ],
    },
  };
  if (query.tenantId) where.tenantId = String(query.tenantId);
  if (query.q) {
    where.OR = [
      { action: { contains: String(query.q), mode: "insensitive" } },
      { entityType: { contains: String(query.q), mode: "insensitive" } },
    ];
  }
  const [total, items] = await Promise.all([
    prisma.auditEvent.count({ where }),
    prisma.auditEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * take,
      take,
    }),
  ]);
  const actorIds = [...new Set(items.map((item) => item.actorUserId).filter(Boolean))] as string[];
  const tenantIds = [...new Set(items.map((item) => item.tenantId).filter(Boolean))] as string[];
  const [actors, tenants] = await Promise.all([
    actorIds.length
      ? prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, email: true } })
      : [],
    tenantIds.length
      ? prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } })
      : [],
  ]);
  const actorMap = new Map(actors.map((item) => [item.id, item]));
  const tenantMap = new Map(tenants.map((item) => [item.id, item]));
  return {
    page,
    pageSize: take,
    total,
    items: items.map((item) => ({
      id: item.id,
      action: item.action,
      entityType: item.entityType,
      entityId: item.entityId,
      createdAt: item.createdAt,
      tenantId: item.tenantId,
      tenantName: item.tenantId ? tenantMap.get(item.tenantId)?.name || null : null,
      actor: item.actorUserId ? actorMap.get(item.actorUserId) || null : null,
      result: item.changesJson,
    })),
  };
}

export async function getPlatformServiceSettings(prisma: PrismaClient, auth: AuthContext) {
  requirePlatformAdmin(auth);
  return getPlatformSettings(prisma);
}

export async function updatePlatformServiceSettings(
  prisma: PrismaClient,
  auth: AuthContext,
  input: Record<string, unknown>,
) {
  requirePlatformAdmin(auth);
  const saved = await savePlatformSettings(prisma, input);
  await writeAudit(prisma, {
    actorUserId: auth.user.id,
    action: "settings.platform_updated",
    entityType: "platform_setting",
    entityId: "defaults",
    changes: { keys: Object.keys(input) },
  });
  return saved;
}
