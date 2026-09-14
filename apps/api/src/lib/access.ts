import {
  PERMISSIONS,
  ROLE_LABELS,
  ROLES,
  hasPermission,
  isCompanyAdminRole,
  isManagerRole,
  permissionsForRole,
  type Permission,
  type Role,
} from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "./types.ts";

export { isCompanyAdminRole, isManagerRole, ROLE_LABELS, ROLES };

export function roleOf(auth: AuthContext | null) {
  return auth?.activeMembership?.role || null;
}

export function isPlatformAdmin(auth: AuthContext | null) {
  return Boolean(auth?.user.platformAdmin);
}

export function requirePlatformAdmin(auth: AuthContext, message = "Доступно только администратору сервиса") {
  if (!isPlatformAdmin(auth)) throw new ApiError(403, "forbidden", message);
}

export function isCompanyAdmin(auth: AuthContext | null) {
  return isCompanyAdminRole(roleOf(auth));
}

export function isManager(auth: AuthContext | null) {
  return isManagerRole(roleOf(auth));
}

export function seesAllCompanyRecords(auth: AuthContext | null) {
  if (!auth?.activeMembership) return false;
  return !isManager(auth);
}

export function effectivePermissions(auth: AuthContext | null): Permission[] {
  if (!auth) return [];
  const membership = auth.activeMembership;
  if (!membership) return [];
  const extra = Array.isArray(membership.permissions) ? membership.permissions : [];
  const fromRole = permissionsForRole(membership.role);
  if (membership.role === ROLES.manager) return fromRole;
  return [...new Set([...fromRole, ...extra.filter((item): item is Permission => extra.includes(item))])] as Permission[];
}

export function can(auth: AuthContext | null, permission: Permission): boolean {
  if (!auth) return false;
  const membership = auth.activeMembership;
  if (!membership) return false;
  const role = membership.role;
  if (role === ROLES.owner || role === ROLES.director) return true;
  if (role === ROLES.sales_lead) {
    return (
      permission !== PERMISSIONS.manageIntegrations &&
      permission !== PERMISSIONS.exportAll &&
      permission !== PERMISSIONS.manageMembers
    );
  }
  if (role === ROLES.manager) {
    return permissionsForRole(ROLES.manager).includes(permission);
  }
  const extra = Array.isArray(membership.permissions) ? membership.permissions : [];
  return hasPermission(role, extra, permission);
}

export function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  if (!auth.activeMembership.active) {
    throw new ApiError(403, "membership_suspended", "Участие в компании приостановлено");
  }
  if (auth.activeMembership.tenant.status !== "active") {
    throw new ApiError(403, "tenant_suspended", "Доступ компании приостановлен");
  }
  return auth.activeMembership;
}

export function requirePermission(auth: AuthContext, permission: Permission, message = "Недостаточно прав") {
  requireTenant(auth);
  if (!can(auth, permission)) throw new ApiError(403, "forbidden", message);
}

export function requireCompanyAdmin(auth: AuthContext, message = "Недостаточно прав для управления компанией") {
  requireTenant(auth);
  if (!isCompanyAdmin(auth)) throw new ApiError(403, "forbidden", message);
}

export function requireDocumentsAccess(auth: AuthContext) {
  requirePermission(auth, PERMISSIONS.manageDocuments, "Недостаточно прав для документов");
}

export function requireAnalyticsAccess(auth: AuthContext) {
  requireTenant(auth);
  if (isManager(auth)) throw new ApiError(403, "forbidden", "Статистика доступна администратору и директору");
}

export function requireAiSettingsAccess(auth: AuthContext) {
  requirePermission(auth, PERMISSIONS.manageAi, "Недостаточно прав для настроек AI-менеджера");
}

export function capabilities(auth: AuthContext | null) {
  const admin = isCompanyAdmin(auth);
  const manager = isManager(auth);
  const salesLead = roleOf(auth) === ROLES.sales_lead;
  return {
    role: roleOf(auth),
    roleLabel: roleOf(auth) ? ROLE_LABELS[roleOf(auth) as Role] : "",
    platformAdmin: isPlatformAdmin(auth),
    companyAdmin: admin,
    manager,
    documents: can(auth, PERMISSIONS.manageDocuments),
    analytics: !manager && Boolean(auth?.activeMembership),
    aiSettings: can(auth, PERMISSIONS.manageAi),
    integrations: can(auth, PERMISSIONS.manageIntegrations) || admin,
    members: can(auth, PERMISSIONS.manageMembers),
    confirmPayments: can(auth, PERMISSIONS.confirmPayments),
    manageTasks: admin || salesLead,
    exportAll: can(auth, PERMISSIONS.exportAll),
  };
}

export function inquiryAccessWhere(auth: AuthContext) {
  const membership = requireTenant(auth);
  if (seesAllCompanyRecords(auth)) return { tenantId: membership.tenantId };
  return {
    tenantId: membership.tenantId,
    OR: [{ assigneeMembershipId: null }, { assigneeMembershipId: membership.id }],
  };
}

export function dealAccessWhere(auth: AuthContext) {
  const membership = requireTenant(auth);
  if (seesAllCompanyRecords(auth)) return { tenantId: membership.tenantId };
  return { tenantId: membership.tenantId, assigneeMembershipId: membership.id };
}

export function taskAccessWhere(auth: AuthContext) {
  const membership = requireTenant(auth);
  if (seesAllCompanyRecords(auth)) return { tenantId: membership.tenantId };
  return { tenantId: membership.tenantId, ownerMembershipId: membership.id };
}

export function conversationAccessWhere(auth: AuthContext) {
  const membership = requireTenant(auth);
  if (seesAllCompanyRecords(auth)) return { tenantId: membership.tenantId };
  return {
    tenantId: membership.tenantId,
    OR: [
      { assigneeMembershipId: membership.id },
      {
        inquiries: {
          some: { OR: [{ assigneeMembershipId: null }, { assigneeMembershipId: membership.id }] },
        },
      },
      { contact: { deals: { some: { assigneeMembershipId: membership.id } } } },
      { contact: { ownerMembershipId: membership.id } },
    ],
  };
}

export function requireNotManager(auth: AuthContext, message = "Недостаточно прав") {
  requireTenant(auth);
  if (isManager(auth)) throw new ApiError(403, "forbidden", message);
}

export function requireManageTasks(auth: AuthContext) {
  requireNotManager(auth, "Недостаточно прав для постановки и распределения задач");
}

export function requireIntegrationsAccess(auth: AuthContext) {
  requirePermission(auth, PERMISSIONS.manageIntegrations, "Настройки интеграций доступны администратору и директору");
}

export function requireCompanyOps(auth: AuthContext) {
  requireNotManager(auth, "Этот раздел доступен администратору и директору");
}

export function andWhere<T extends Record<string, unknown>>(base: T, extra: T | Record<string, unknown>): T {
  return { AND: [base, extra] } as T;
}

export async function assertConversationReachable(
  prisma: { conversation: { findFirst: (args: unknown) => Promise<{ id: string } | null> } },
  auth: AuthContext,
  conversationId: string,
) {
  const found = await prisma.conversation.findFirst({
    where: { AND: [{ id: conversationId }, conversationAccessWhere(auth)] },
    select: { id: true },
  });
  if (!found) throw new ApiError(404, "not_found", "Диалог не найден");
}

export function assertInquiryVisible(
  auth: AuthContext,
  inquiry: { assigneeMembershipId: string | null } | null,
) {
  if (!inquiry) throw new ApiError(404, "not_found", "Заявка не найдена");
  if (seesAllCompanyRecords(auth)) return;
  const me = requireTenant(auth).id;
  if (inquiry.assigneeMembershipId && inquiry.assigneeMembershipId !== me) {
    throw new ApiError(404, "not_found", "Заявка не найдена");
  }
}

export function assertDealVisible(auth: AuthContext, deal: { assigneeMembershipId: string | null } | null) {
  if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");
  if (seesAllCompanyRecords(auth)) return;
  if (deal.assigneeMembershipId !== requireTenant(auth).id) {
    throw new ApiError(404, "not_found", "Сделка не найдена");
  }
}

export function assertTaskVisible(auth: AuthContext, task: { ownerMembershipId: string | null } | null) {
  if (!task) throw new ApiError(404, "not_found", "Задача не найдена");
  if (seesAllCompanyRecords(auth)) return;
  if (task.ownerMembershipId !== requireTenant(auth).id) {
    throw new ApiError(404, "not_found", "Задача не найдена");
  }
}

export function managerDealWriteFields(input: Record<string, unknown>) {
  const allowed = [
    "title",
    "description",
    "nextAction",
    "nextActionAt",
    "expectedCloseAt",
    "probability",
    "companyId",
    "fulfillmentStatus",
  ];
  const next: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in input) next[key] = input[key];
  }
  return next;
}

export function managerInquiryWriteFields(input: Record<string, unknown>) {
  const allowed = [
    "nextStep",
    "needsReply",
    "description",
    "subject",
    "service",
    "city",
    "desiredDeadline",
    "budgetMin",
    "budgetMax",
  ];
  const next: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in input) next[key] = input[key];
  }
  return next;
}
