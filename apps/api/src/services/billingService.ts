import type { Prisma, PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import { writeAudit } from "../lib/audit.ts";
import { requirePlatformAdmin, requireTenant } from "../lib/access.ts";
import type { AuthContext } from "../lib/types.ts";
import {
  entitlementsFromSnapshot,
  getEntitlements,
  getSubscriptionSnapshot,
  loadCurrentTenantPlan,
  snapshotFromPlan,
} from "./entitlementService.ts";
import { PREVIEW_DATASET } from "./previewDataset.ts";
import { loadPublicCatalog, publicOfferCards, quoteSubscription, serializeCatalogItem } from "./pricingEngine.ts";
import { activateSubscription } from "./subscriptionActivationService.ts";
import { collectTenantUsage, usageWarnings } from "./billingUsageService.ts";

function onboardingFromSettings(settings: unknown) {
  const raw = settings && typeof settings === "object" ? (settings as Record<string, unknown>) : {};
  const onboarding = raw.onboarding && typeof raw.onboarding === "object"
    ? (raw.onboarding as Record<string, unknown>)
    : {};
  const status = String(onboarding.status || "completed");
  return {
    status,
    deferred: Boolean(onboarding.deferred),
    steps: (onboarding.steps && typeof onboarding.steps === "object" ? onboarding.steps : {}) as Record<string, unknown>,
    needed: status === "not_started" || status === "in_progress",
  };
}

function daysLeft(expiresAt: string | null) {
  if (!expiresAt) return null;
  const end = new Date(expiresAt).getTime();
  if (!Number.isFinite(end)) return null;
  return Math.ceil((end - Date.now()) / (24 * 60 * 60 * 1000));
}

export async function getBillingState(prisma: PrismaClient, tenantId: string) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true, status: true, createdAt: true, settingsJson: true },
  });
  if (!tenant) throw new ApiError(404, "not_found", "Компания не найдена");
  const resolved = await getEntitlements(prisma, tenantId);
  const snapshot = resolved.snapshot;
  const remaining = daysLeft(snapshot.expiresAt);
  const usage = await collectTenantUsage(prisma, tenantId);
  const openRequest = await prisma.subscriptionRequest.findFirst({
    where: { tenantId, status: { in: ["PENDING", "AWAITING_PAYMENT", "PAYMENT_REVIEW", "APPROVED"] } },
    orderBy: { createdAt: "desc" },
  }).catch(() => null);
  const addOns = Array.isArray(resolved.plan?.itemsJson) ? resolved.plan?.itemsJson : [];
  const confirmer = resolved.plan?.confirmedByUserId
    ? await prisma.user.findUnique({
        where: { id: resolved.plan.confirmedByUserId },
        select: { id: true, name: true, email: true },
      }).catch(() => null)
    : null;
  return {
    tenantId: tenant.id,
    companyName: tenant.name,
    createdAt: tenant.createdAt.toISOString(),
    ...snapshot,
    entitlements: resolved.entitlements,
    limits: resolved.limits,
    usage: usage.rows,
    warnings: usageWarnings(usage, remaining),
    daysLeft: remaining,
    addOns,
    paymentMethod: resolved.plan?.paymentMethod || null,
    confirmedAt: resolved.plan?.confirmedAt?.toISOString() || null,
    confirmedBy: confirmer,
    onboarding: onboardingFromSettings(tenant.settingsJson),
    preview: snapshot.previewMode ? PREVIEW_DATASET : null,
    currentRequest: openRequest
      ? {
          id: openRequest.id,
          planCode: openRequest.requestedPlanCode,
          planName: (openRequest.snapshotJson as { planName?: string } | null)?.planName || openRequest.requestedPlanCode,
          billingPeriod: openRequest.billingPeriod,
          finalAmountMinor: openRequest.finalAmountMinor,
          status: openRequest.status,
          statusLabel:
            {
              PENDING: "Черновик",
              AWAITING_PAYMENT: "Ожидает подтверждения оплаты",
              PAYMENT_REVIEW: "Оплата на проверке",
              APPROVED: "Одобрен",
            }[openRequest.status] || openRequest.status,
          addOns: openRequest.requestedAddOnsJson,
          createdAt: openRequest.createdAt.toISOString(),
        }
      : null,
  };
}

export async function getBillingForAuth(prisma: PrismaClient, auth: AuthContext) {
  if (!auth.activeMembership) return null;
  return getBillingState(prisma, auth.activeMembership.tenantId);
}

export async function listPublicPlans(prisma: PrismaClient, period: string = "MONTHLY") {
  const billingPeriod = period === "YEARLY" ? "YEARLY" : "MONTHLY";
  const items = await loadPublicCatalog(prisma);
  const serialized = items.map((item) => serializeCatalogItem(item, billingPeriod));
  return {
    billingPeriod,
    items: serialized,
    plans: serialized.filter((item) => item.kind === "plan"),
    bundles: serialized.filter((item) => item.kind === "bundle"),
    addOns: serialized.filter((item) => item.kind === "addon"),
    offers: publicOfferCards(items, billingPeriod),
  };
}

export async function quotePublic(prisma: PrismaClient, auth: AuthContext, input: unknown) {
  requireTenant(auth);
  const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return quoteSubscription(prisma, {
    planCode: body.planCode ? String(body.planCode) : null,
    addOns: Array.isArray(body.addOns) ? (body.addOns as Array<{ code: string; qty?: number }>) : [],
    billingPeriod: String(body.billingPeriod || "MONTHLY"),
  });
}

export async function skipOnboarding(prisma: PrismaClient, auth: AuthContext) {
  const membership = requireTenant(auth);
  const tenant = await prisma.tenant.findUnique({ where: { id: membership.tenantId } });
  if (!tenant) throw new ApiError(404, "not_found", "Компания не найдена");
  const current = tenant.settingsJson && typeof tenant.settingsJson === "object"
    ? { ...(tenant.settingsJson as Record<string, unknown>) }
    : {};
  const onboarding = {
    ...(typeof current.onboarding === "object" && current.onboarding ? current.onboarding : {}),
    status: "deferred",
    deferred: true,
  };
  await prisma.tenant.update({
    where: { id: membership.tenantId },
    data: { settingsJson: { ...current, onboarding } as Prisma.InputJsonValue },
  });
  return getBillingState(prisma, membership.tenantId);
}

export async function completeOnboardingStep(prisma: PrismaClient, auth: AuthContext, step: string) {
  const membership = requireTenant(auth);
  const key = String(step || "").trim();
  if (!key) throw new ApiError(422, "invalid", "Укажите шаг");
  const tenant = await prisma.tenant.findUnique({ where: { id: membership.tenantId } });
  if (!tenant) throw new ApiError(404, "not_found", "Компания не найдена");
  const current = tenant.settingsJson && typeof tenant.settingsJson === "object"
    ? { ...(tenant.settingsJson as Record<string, unknown>) }
    : {};
  const prev = typeof current.onboarding === "object" && current.onboarding
    ? (current.onboarding as Record<string, unknown>)
    : {};
  const steps = { ...(typeof prev.steps === "object" && prev.steps ? prev.steps : {}), [key]: true };
  const done = ["company", "ai", "whatsapp", "team"].every((item) => Boolean((steps as Record<string, unknown>)[item]));
  const onboarding = {
    ...prev,
    steps,
    status: done ? "completed" : "in_progress",
    deferred: false,
  };
  await prisma.tenant.update({
    where: { id: membership.tenantId },
    data: { settingsJson: { ...current, onboarding } as Prisma.InputJsonValue },
  });
  return getBillingState(prisma, membership.tenantId);
}

export async function activateTenantSubscription(
  prisma: PrismaClient,
  tenantId: string,
  input: {
    planCode?: string;
    actorUserId?: string | null;
    source?: string;
    addOns?: Array<{ code: string; qty?: number }>;
    billingPeriod?: string;
    startDate?: string;
    endDate?: string;
    notes?: string;
  } = {},
) {
  return activateSubscription(prisma, {
    tenantId,
    planCode: input.planCode || "starter",
    addOns: input.addOns,
    billingPeriod: input.billingPeriod,
    startDate: input.startDate,
    endDate: input.endDate,
    actorUserId: input.actorUserId || null,
    source: input.source || "trusted",
    notes: input.notes || null,
  });
}

export async function activateSubscriptionAsPlatformAdmin(
  prisma: PrismaClient,
  auth: AuthContext,
  tenantId: string,
  input: unknown = {},
) {
  requirePlatformAdmin(auth);
  const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const planCode = body.planCode ? String(body.planCode) : undefined;
  return activateTenantSubscription(prisma, tenantId, {
    planCode,
    actorUserId: auth.user.id,
    source: String(body.source || "platform_admin"),
    addOns: Array.isArray(body.addOns) ? (body.addOns as Array<{ code: string; qty?: number }>) : undefined,
    billingPeriod: body.billingPeriod ? String(body.billingPeriod) : undefined,
    startDate: body.startDate ? String(body.startDate) : undefined,
    endDate: body.endDate ? String(body.endDate) : undefined,
    notes: body.reason ? String(body.reason) : body.notes ? String(body.notes) : undefined,
  });
}

export async function suspendSubscriptionAsPlatformAdmin(
  prisma: PrismaClient,
  auth: AuthContext,
  tenantId: string,
  input: unknown = {},
) {
  requirePlatformAdmin(auth);
  const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const { suspendSubscription } = await import("./subscriptionActivationService.ts");
  return suspendSubscription(prisma, tenantId, auth.user.id, body.reason ? String(body.reason) : null);
}

export async function reactivateSubscriptionAsPlatformAdmin(
  prisma: PrismaClient,
  auth: AuthContext,
  tenantId: string,
  input: unknown = {},
) {
  requirePlatformAdmin(auth);
  const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const { reactivateSubscription } = await import("./subscriptionActivationService.ts");
  return reactivateSubscription(prisma, tenantId, auth.user.id, body.reason ? String(body.reason) : null);
}

export async function extendSubscriptionAsPlatformAdmin(
  prisma: PrismaClient,
  auth: AuthContext,
  tenantId: string,
  input: unknown = {},
) {
  requirePlatformAdmin(auth);
  const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const { extendSubscription } = await import("./subscriptionActivationService.ts");
  return extendSubscription(prisma, tenantId, {
    endDate: body.endDate ? String(body.endDate) : null,
    actorUserId: auth.user.id,
    reason: body.reason ? String(body.reason) : null,
  });
}

export async function upsertBillingOverride(
  prisma: PrismaClient,
  auth: AuthContext,
  tenantId: string,
  input: unknown,
) {
  requirePlatformAdmin(auth);
  const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const data = {
    featuresJson: (body.features && typeof body.features === "object" ? body.features : {}) as Prisma.InputJsonValue,
    limitsJson: (body.limits && typeof body.limits === "object" ? body.limits : {}) as Prisma.InputJsonValue,
    customPriceMinor: body.customPriceMinor != null ? Number(body.customPriceMinor) : null,
    reason: String(body.reason || "").trim() || null,
    updatedByUserId: auth.user.id,
  };
  const row = await prisma.tenantBillingOverride.upsert({
    where: { tenantId },
    update: data,
    create: { tenantId, ...data, createdByUserId: auth.user.id },
  });
  await writeAudit(prisma, {
    tenantId,
    actorUserId: auth.user.id,
    action: "admin_override.added",
    entityType: "billing_override",
    entityId: row.id,
    changes: data,
  });
  return getBillingState(prisma, tenantId);
}

export { getSubscriptionSnapshot, loadCurrentTenantPlan, entitlementsFromSnapshot, snapshotFromPlan };
