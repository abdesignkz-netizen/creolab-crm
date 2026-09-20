import type { Prisma, PrismaClient } from "@creolab/db";
import { SUBSCRIPTION_STATUSES } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { writeAudit } from "../lib/audit.ts";
import { requirePlatformAdmin, requireTenant } from "../lib/access.ts";
import type { AuthContext } from "../lib/types.ts";
import {
  entitlementsFromSnapshot,
  getSubscriptionSnapshot,
  loadCurrentTenantPlan,
  snapshotFromPlan,
} from "./entitlementService.ts";
import { PREVIEW_DATASET } from "./previewDataset.ts";

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

export async function getBillingState(prisma: PrismaClient, tenantId: string) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true, status: true, createdAt: true, settingsJson: true },
  });
  if (!tenant) throw new ApiError(404, "not_found", "Компания не найдена");
  const row = await loadCurrentTenantPlan(prisma, tenantId);
  const snapshot = snapshotFromPlan(tenant.status, row);
  return {
    tenantId: tenant.id,
    companyName: tenant.name,
    createdAt: tenant.createdAt.toISOString(),
    ...snapshot,
    entitlements: entitlementsFromSnapshot(snapshot, row),
    onboarding: onboardingFromSettings(tenant.settingsJson),
    preview: snapshot.previewMode ? PREVIEW_DATASET : null,
  };
}

export async function getBillingForAuth(prisma: PrismaClient, auth: AuthContext) {
  if (!auth.activeMembership) return null;
  return getBillingState(prisma, auth.activeMembership.tenantId);
}

export async function listPublicPlans(prisma: PrismaClient) {
  const plans = await prisma.plan.findMany({ orderBy: { name: "asc" } });
  return {
    items: plans.map((plan) => ({
      id: plan.id,
      code: plan.code,
      name: plan.name,
      features: plan.featuresJson,
      limits: plan.limitsJson,
      billingPeriod: "month",
      price: null,
      isActive: true,
    })),
  };
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
  input: { planCode?: string; actorUserId?: string | null; source?: string } = {},
) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) throw new ApiError(404, "not_found", "Компания не найдена");
  const planCode = input.planCode || "starter";
  const plan = await prisma.plan.findUnique({ where: { code: planCode } });
  if (!plan) throw new ApiError(404, "not_found", "Тариф не найден");
  const current = await loadCurrentTenantPlan(prisma, tenantId);
  const now = new Date();
  if (current) {
    await prisma.tenantPlan.update({
      where: { id: current.id },
      data: { status: SUBSCRIPTION_STATUSES.ACTIVE, planId: plan.id, startsAt: now, endsAt: null },
    });
  } else {
    await prisma.tenantPlan.create({
      data: { tenantId, planId: plan.id, status: SUBSCRIPTION_STATUSES.ACTIVE, startsAt: now },
    });
  }
  const settings = tenant.settingsJson && typeof tenant.settingsJson === "object"
    ? { ...(tenant.settingsJson as Record<string, unknown>) }
    : {};
  const prevOnboarding = typeof settings.onboarding === "object" && settings.onboarding
    ? (settings.onboarding as Record<string, unknown>)
    : {};
  if (prevOnboarding.status === "not_started" || !prevOnboarding.status) {
    settings.onboarding = { ...prevOnboarding, status: "in_progress", deferred: false };
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { settingsJson: settings as Prisma.InputJsonValue },
    });
  }
  await writeAudit(prisma, {
    tenantId,
    actorUserId: input.actorUserId || null,
    action: "subscription.activated",
    entityType: "tenant",
    entityId: tenantId,
    changes: { planCode, source: input.source || "trusted" },
  });
  return getBillingState(prisma, tenantId);
}

export async function activateSubscriptionAsPlatformAdmin(
  prisma: PrismaClient,
  auth: AuthContext,
  tenantId: string,
  planCode?: string,
) {
  requirePlatformAdmin(auth);
  return activateTenantSubscription(prisma, tenantId, {
    planCode,
    actorUserId: auth.user.id,
    source: "platform_admin",
  });
}

export { getSubscriptionSnapshot };
