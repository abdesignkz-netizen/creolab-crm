import { FEATURE_LIST, LIMIT_LIST, LEGACY_CATALOG_CODES } from "@creolab/contracts";
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
import { loadPublicCatalog, publicOfferCards, quoteRenewal, quoteSubscription, serializeCatalogItem } from "./pricingEngine.ts";
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
  const price = resolved.plan?.priceSnapshotJson as { baseFeatures?: Record<string, boolean>; baseLimits?: Record<string, number>; enterpriseTerms?: { sla: string; integrations: string }; lines?: Array<{ kind: string; chargeType: string; amountMinor: number }> } | null;
  const priceLines = price?.lines || [];
  const priceBreakdown = { base: priceLines.filter(row => row.kind !== 'addon').reduce((n,row) => n + row.amountMinor,0), addOns: priceLines.filter(row => row.kind === 'addon' && row.chargeType !== 'ONE_TIME').reduce((n,row) => n + row.amountMinor,0), recurring: priceLines.filter(row => row.chargeType !== 'ONE_TIME').reduce((n,row) => n + row.amountMinor,0), oneTime: priceLines.filter(row => row.chargeType === 'ONE_TIME').reduce((n,row) => n + row.amountMinor,0) };
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
    accessBreakdown: {
      basePlan: snapshot.planName, planCode: snapshot.planCode,
      legacy: LEGACY_CATALOG_CODES.includes(snapshot.planCode as never) || snapshot.grandfathered,
      grandfathered: snapshot.grandfathered,
      baseFeatures: price?.baseFeatures || null,
      baseLimits: price?.baseLimits || null,
      subscriptionFeatures: resolved.plan?.featuresSnapshotJson || resolved.plan?.plan.featuresJson,
      subscriptionLimits: resolved.plan?.limitsSnapshotJson || resolved.plan?.plan.limitsJson,
      addOns, overrides: resolved.override,
      effectiveFeatures: resolved.entitlements, effectiveLimits: resolved.limits,
    },
    limits: resolved.limits,
    usage: usage.rows,
    warnings: usageWarnings(usage, remaining),
    daysLeft: remaining,
    addOns,
    priceBreakdown: priceLines.length ? priceBreakdown : null,
    enterpriseTerms: price?.enterpriseTerms || null,
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
  if (body.requestType === "RENEWAL") return quoteRenewal(prisma, requireTenant(auth).tenantId, String(body.planCode || ""), String(body.billingPeriod || "MONTHLY"));
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
  const { entitlements } = await getEntitlements(prisma, membership.tenantId);
  const needed = ["company", ...(entitlements.AI_MANAGER ? ["ai"] : []), ...(entitlements.WHATSAPP ? ["whatsapp"] : []), ...(entitlements.TEAM ? ["team"] : [])];
  const done = needed.every(item => Boolean((steps as Record<string, unknown>)[item]));
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
  if (input.source === "internal_webhook") throw new ApiError(409, "manual_approval_required", "Онлайн-оплата не подключена. Подтвердите заявку через Platform Admin.");
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
  if (!planCode || planCode === "starter") {
    // Retain administrative recovery for pre-catalog installations only.
    const current = await loadCurrentTenantPlan(prisma, tenantId);
    if (current && current.plan.kind !== "legacy") throw new ApiError(422, "plan_required", "Выберите тариф из каталога");
    return activateTenantSubscription(prisma, tenantId, { actorUserId: auth.user.id, source: "platform_admin_legacy" });
  }
  const quote = await quoteSubscription(prisma, { planCode, addOns: Array.isArray(body.addOns) ? body.addOns as Array<{code: string; qty?: number}> : [], billingPeriod: String(body.billingPeriod || "MONTHLY") });
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;
    if (!(await tx.tenant.findUnique({ where: { id: tenantId } }))) throw new ApiError(404, "not_found", "Компания не найдена");
    const request = await tx.subscriptionRequest.create({ data: {
      tenantId, requestedByUserId: auth.user.id, requestType: "NEW_SUBSCRIPTION",
      requestedPlanCode: planCode, requestedAddOnsJson: quote.snapshot.addOns,
      billingPeriod: quote.billingPeriod, baseAmountMinor: quote.baseAmountMinor,
      finalAmountMinor: quote.finalAmountMinor, snapshotJson: { ...quote.snapshot, planName: quote.planName },
    } });
    const { confirmBillingPaymentAndActivate } = await import("./subscriptionRequestService.ts");
    return confirmBillingPaymentAndActivate(tx as PrismaClient, auth, request.id, body);
  }, { timeout: 30000 });
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
): Promise<BillingState> {
  requirePlatformAdmin(auth);
  const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  if (typeof prisma.$transaction === "function") return prisma.$transaction(tx => extendSubscriptionAsPlatformAdmin(tx as PrismaClient, auth, tenantId, input), { timeout: 30000 });
  await prisma.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;
  const current = await loadCurrentTenantPlan(prisma, tenantId);
  if (!current || current.plan.kind === "legacy") {
    const { extendSubscription } = await import("./subscriptionActivationService.ts");
    return extendSubscription(prisma, tenantId, { endDate: body.endDate ? String(body.endDate) : null, actorUserId: auth.user.id, reason: body.reason ? String(body.reason) : null });
  }
  if (current.plan.code === "BASQAR_FREE") throw new ApiError(422, "free_has_no_expiry", "Free не требует продления");
  const snapshot = current.priceSnapshotJson as unknown as import("./pricingEngine.ts").PricingQuote["snapshot"];
  if (!Array.isArray(snapshot.lines)) throw new ApiError(409, "requote_required", "Создайте заявку на продление с подтверждением условий тарифа");
  // Renew the agreed recurring configuration; never charge installation services again.
  const lines = snapshot.lines.filter(line => line.chargeType !== "ONE_TIME");
  const addOns = snapshot.addOns.filter(addon => lines.some(line => line.code === addon.code));
  const finalAmountMinor = lines.reduce((sum, line) => sum + line.amountMinor, 0);
  const baseAmountMinor = lines.filter(line => line.kind !== "addon").reduce((sum, line) => sum + line.amountMinor, 0);
  const renewalSnapshot = { ...snapshot, lines, addOns, finalAmountMinor, finalPriceAtActivation: finalAmountMinor, basePriceAtActivation: baseAmountMinor };
  const request = await prisma.subscriptionRequest.create({ data: {
    tenantId, requestedByUserId: auth.user.id, requestType: "RENEWAL", requestedPlanCode: current.plan.code,
    requestedAddOnsJson: addOns, billingPeriod: current.billingPeriod || "MONTHLY", baseAmountMinor, finalAmountMinor,
    snapshotJson: renewalSnapshot as unknown as Prisma.InputJsonValue,
  } });
  const { confirmBillingPaymentAndActivate } = await import("./subscriptionRequestService.ts");
  return confirmBillingPaymentAndActivate(prisma, auth, request.id, { ...body, comment: body.reason || body.comment });
}

export async function upsertBillingOverride(
  prisma: PrismaClient,
  auth: AuthContext,
  tenantId: string,
  input: unknown,
): Promise<BillingState> {
  requirePlatformAdmin(auth);
  const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  if (Object.entries((body.features || {}) as Record<string, unknown>).some(([key, value]) => !FEATURE_LIST.includes(key as never) || typeof value !== "boolean")) throw new ApiError(422, "invalid_feature", "Неизвестная функция или некорректное значение");
  if (Object.keys((body.limits || {}) as object).some(key => !LIMIT_LIST.includes(key as never))) throw new ApiError(422, "invalid_limit", "Неизвестный лимит");
  for (const value of Object.values((body.limits || {}) as object)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < -1) throw new ApiError(422, "invalid_limit", "Некорректный лимит");
  }
  if (body.customPriceMinor != null && (!Number.isSafeInteger(body.customPriceMinor) || Number(body.customPriceMinor) < 0)) throw new ApiError(422, "invalid_price", "Некорректная цена");
  const data = {
    featuresJson: (body.features && typeof body.features === "object" ? body.features : {}) as Prisma.InputJsonValue,
    limitsJson: (body.limits && typeof body.limits === "object" ? body.limits : {}) as Prisma.InputJsonValue,
    customPriceMinor: body.customPriceMinor != null ? Number(body.customPriceMinor) : null,
    reason: String(body.reason || "").trim() || null,
    updatedByUserId: auth.user.id,
  };
  if (typeof prisma.$transaction === "function") return prisma.$transaction(tx => upsertBillingOverride(tx as PrismaClient, auth, tenantId, input), { timeout: 30000 });
  await prisma.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;
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
  const { initializeTenantUsage } = await import("./billingResourceService.ts");
  const effective = await getEntitlements(prisma, tenantId);
  if (!effective.snapshot.grandfathered) await initializeTenantUsage(prisma, tenantId, effective.limits);
  return getBillingState(prisma, tenantId);
}

export { getSubscriptionSnapshot, loadCurrentTenantPlan, entitlementsFromSnapshot, snapshotFromPlan };

export type BillingState = Awaited<ReturnType<typeof getBillingState>>;
