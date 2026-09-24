import { initializeTenantUsage } from "./billingResourceService.ts";
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@creolab/db";
import { SUBSCRIPTION_STATUSES } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { writeAudit } from "../lib/audit.ts";
import { createStaffNotification } from "./notificationService.ts";
import { loadCurrentTenantPlan } from "./entitlementService.ts";
import { ensurePricingCatalog, loadCatalogItem, quoteSubscription, type QuoteAddonInput, type PricingQuote } from "./pricingEngine.ts";

export type ActivationInput = {
  tenantId: string;
  approvedSnapshot?: PricingQuote["snapshot"];
  planCode?: string | null;
  addOns?: QuoteAddonInput[];
  billingPeriod?: string;
  startDate?: Date | string | null;
  endDate?: Date | string | null;
  actorUserId?: string | null;
  source?: string;
  requestId?: string | null;
  paymentId?: string | null;
  notes?: string | null;
  amountMinor?: number | null;
  force?: boolean;
  extendFromCurrentEnd?: boolean;
};

function asDate(value: Date | string | null | undefined, fallback: Date) {
  if (!value) return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new ApiError(422, "invalid_date", "Некорректная дата подписки");
  return date;
}

export function periodEnd(start: Date, period: string) {
  const end = new Date(start.getTime());
  const day = end.getUTCDate();
  end.setUTCDate(1);
  if (period === "YEARLY") end.setUTCFullYear(end.getUTCFullYear() + 1);
  else end.setUTCMonth(end.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(day, lastDay));
  return end;
}

async function notifyOwners(
  prisma: PrismaClient | Prisma.TransactionClient,
  tenantId: string,
  title: string,
  body: string,
  entityId: string,
) {
  const owners = await prisma.membership.findMany({
    where: { tenantId, active: true, role: { in: ["owner", "director"] } },
    select: { id: true },
    take: 8,
  });
  for (const owner of owners) {
    await createStaffNotification(prisma, {
      tenantId,
      membershipId: owner.id,
      type: "billing.subscription",
      entityType: "subscription",
      entityId,
      title,
      body,
      priority: "high",
      episodeKey: `billing:${entityId}:${title}`,
    });
  }
}

export async function activateSubscription(prisma: PrismaClient, input: ActivationInput): Promise<import("./billingService.ts").BillingState> {
  if (typeof prisma.$transaction === "function") {
    await ensurePricingCatalog(prisma);
    return prisma.$transaction(tx => activateSubscription(tx as PrismaClient, input), { timeout: 30000 });
  }
  await prisma.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${input.tenantId} FOR UPDATE`;
  const tenant = await prisma.tenant.findUnique({ where: { id: input.tenantId } });
  if (!tenant) throw new ApiError(404, "not_found", "Компания не найдена");
  const planCode = String(input.planCode || "starter").trim();
  const catalog = input.approvedSnapshot ? { code: planCode } : await loadCatalogItem(prisma, planCode);
  if (!catalog && planCode !== "starter") throw new ApiError(404, "not_found", "Тариф не найден");
  const period = input.billingPeriod === "YEARLY" ? "YEARLY" : "MONTHLY";
  const quote =
    planCode === "starter"
      ? null
      : input.approvedSnapshot
        ? { snapshot: input.approvedSnapshot, features: input.approvedSnapshot.features, limits: input.approvedSnapshot.limits, finalAmountMinor: input.approvedSnapshot.finalAmountMinor }
        : await quoteSubscription(prisma, { planCode, addOns: input.addOns, billingPeriod: period });

  const plan = await prisma.plan.findUnique({ where: { code: planCode } });
  if (!plan) throw new ApiError(404, "not_found", "Тариф не найден");

  if (quote && !(await prisma.tenantUsage.findUnique({ where: { tenantId: input.tenantId } }))) {
    // Measure historical data before a downgrade check. Any failure rolls back
    // this initialization together with payment and activation.
    await initializeTenantUsage(prisma, input.tenantId, {});
  }
  // Hold the same row lock used by resource writers until the new limits commit.
  await prisma.$queryRaw`SELECT "tenantId" FROM "TenantUsage" WHERE "tenantId" = ${input.tenantId} FOR UPDATE`;
  if (quote) {
    const override = await prisma.tenantBillingOverride.findUnique({ where: { tenantId: input.tenantId } });
    const effectiveLimits = { ...quote.limits, ...(override?.limitsJson as Record<string, number> || {}) };
    const { downgradeBlockers } = await import("./subscriptionRequestService.ts");
    const issues = await downgradeBlockers(prisma, input.tenantId, effectiveLimits);
    if (issues.length) throw new ApiError(422, "LIMIT_EXCEEDED_AFTER_DOWNGRADE", "Использование превышает лимиты выбранной конфигурации", undefined, { issues });
  }
  const now = new Date();
  const current = await loadCurrentTenantPlan(prisma, input.tenantId);
  const startBase =
    input.extendFromCurrentEnd && current?.endsAt && current.endsAt.getTime() > now.getTime()
      ? current.endsAt
      : now;
  const startsAt = asDate(input.startDate, input.extendFromCurrentEnd ? current?.startsAt || now : now);
  const endsAt =
    ["starter", "BASQAR_FREE"].includes(planCode) && !input.endDate
      ? null
      : input.endDate
        ? asDate(input.endDate, periodEnd(startBase, period))
        : periodEnd(startBase, period);
  if (endsAt && (endsAt <= startsAt || startsAt > now)) throw new ApiError(422, "invalid_dates", "Начало не может быть в будущем, окончание должно быть позже начала");
  const amountMinor = input.amountMinor ?? quote?.finalAmountMinor ?? 0;
  const itemsJson = quote?.snapshot.addOns || [];
  const featuresJson = quote?.features || plan.featuresJson;
  const limitsJson = quote?.limits || plan.limitsJson;

  const result = await (async (tx: PrismaClient) => {
    let row;
    if (current) {
      row = await tx.tenantPlan.update({
        where: { id: current.id },
        data: {
          planId: plan.id,
          status: SUBSCRIPTION_STATUSES.ACTIVE,
          startsAt,
          endsAt,
          billingPeriod: period,
          amountMinor,
          currency: "KZT",
          itemsJson: itemsJson as Prisma.InputJsonValue,
          priceSnapshotJson: (quote?.snapshot || {}) as Prisma.InputJsonValue,
          limitsSnapshotJson: limitsJson as Prisma.InputJsonValue,
          featuresSnapshotJson: featuresJson as Prisma.InputJsonValue,
          paymentMethod: planCode === "BASQAR_FREE" ? "FREE" : "MANUAL",
          confirmedByUserId: input.actorUserId || null,
          confirmedAt: now,
          requestId: input.requestId || null,
          notes: input.notes || null,
        },
      });
    } else {
      row = await tx.tenantPlan.create({
        data: {
          tenantId: input.tenantId,
          planId: plan.id,
          status: SUBSCRIPTION_STATUSES.ACTIVE,
          startsAt,
          endsAt,
          billingPeriod: period,
          amountMinor,
          currency: "KZT",
          itemsJson: itemsJson as Prisma.InputJsonValue,
          priceSnapshotJson: (quote?.snapshot || {}) as Prisma.InputJsonValue,
          limitsSnapshotJson: limitsJson as Prisma.InputJsonValue,
          featuresSnapshotJson: featuresJson as Prisma.InputJsonValue,
          paymentMethod: planCode === "BASQAR_FREE" ? "FREE" : "MANUAL",
          confirmedByUserId: input.actorUserId || null,
          confirmedAt: now,
          requestId: input.requestId || null,
          notes: input.notes || null,
        },
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
      await tx.tenant.update({
        where: { id: input.tenantId },
        data: { settingsJson: settings as Prisma.InputJsonValue },
      });
    }

    await writeAudit(tx, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId || null,
      action: "subscription.activated",
      entityType: "tenant_plan",
      entityId: row.id,
      changes: {
        planCode,
        fromPlanCode: current?.plan.code || null,
        source: input.source || "trusted",
        billingPeriod: period,
        amountMinor,
        startsAt,
        endsAt,
        requestId: input.requestId || null,
        paymentId: input.paymentId || null,
      },
    });
    const { getEntitlements } = await import("./entitlementService.ts");
    const effective = await getEntitlements(tx, input.tenantId);
    if (quote) await initializeTenantUsage(tx, input.tenantId, effective.limits);
    return row;
  })(prisma);

  await notifyOwners(
    prisma,
    input.tenantId,
    `Тариф ${plan.name} подключён`,
    `Подписка активна${endsAt ? ` до ${endsAt.toLocaleDateString("ru-RU")}` : "."}`,
    result.id,
  );

  const { getBillingState } = await import("./billingService.ts");
  return getBillingState(prisma, input.tenantId);
}

export async function expireDueSubscriptions(prisma: PrismaClient) {
  const due = await prisma.tenantPlan.findMany({
    where: {
      status: { in: [SUBSCRIPTION_STATUSES.ACTIVE, SUBSCRIPTION_STATUSES.CANCEL_AT_PERIOD_END] },
      endsAt: { lte: new Date() },
    },
    take: 40,
  });
  for (const row of due) {
    await prisma.tenantPlan.update({
      where: { id: row.id },
      data: { status: SUBSCRIPTION_STATUSES.EXPIRED },
    });
    await writeAudit(prisma, {
      tenantId: row.tenantId,
      action: "subscription.expired",
      entityType: "tenant_plan",
      entityId: row.id,
      changes: { endsAt: row.endsAt },
    });
  }
  return { expired: due.length };
}

export function newId() {
  return randomUUID();
}

export async function suspendSubscription(
  prisma: PrismaClient,
  tenantId: string,
  actorUserId: string | null,
  reason?: string | null,
) {
  const current = await loadCurrentTenantPlan(prisma, tenantId);
  if (!current) throw new ApiError(404, "not_found", "Подписка не найдена");
  await prisma.tenantPlan.update({
    where: { id: current.id },
    data: { status: SUBSCRIPTION_STATUSES.SUSPENDED, notes: reason || current.notes },
  });
  await writeAudit(prisma, {
    tenantId,
    actorUserId,
    action: "subscription.suspended",
    entityType: "tenant_plan",
    entityId: current.id,
    changes: { reason: reason || null, from: current.status },
  });
  const { getBillingState } = await import("./billingService.ts");
  return getBillingState(prisma, tenantId);
}

export async function reactivateSubscription(
  prisma: PrismaClient,
  tenantId: string,
  actorUserId: string | null,
  reason?: string | null,
) {
  const current = await loadCurrentTenantPlan(prisma, tenantId);
  if (!current) throw new ApiError(404, "not_found", "Подписка не найдена");
  const expired = Boolean(current.endsAt && current.endsAt.getTime() < Date.now());
  await prisma.tenantPlan.update({
    where: { id: current.id },
    data: {
      status: expired ? SUBSCRIPTION_STATUSES.EXPIRED : SUBSCRIPTION_STATUSES.ACTIVE,
      notes: reason || current.notes,
    },
  });
  await writeAudit(prisma, {
    tenantId,
    actorUserId,
    action: "subscription.reactivated",
    entityType: "tenant_plan",
    entityId: current.id,
    changes: { reason: reason || null, from: current.status },
  });
  const { getBillingState } = await import("./billingService.ts");
  return getBillingState(prisma, tenantId);
}

export async function extendSubscription(
  prisma: PrismaClient,
  tenantId: string,
  input: { endDate?: Date | string | null; actorUserId?: string | null; reason?: string | null },
) {
  const current = await loadCurrentTenantPlan(prisma, tenantId);
  if (!current) throw new ApiError(404, "not_found", "Подписка не найдена");
  const base = current.endsAt && current.endsAt.getTime() > Date.now() ? current.endsAt : new Date();
  const endsAt = input.endDate ? asDate(input.endDate, periodEnd(base, current.billingPeriod || "MONTHLY")) : periodEnd(base, current.billingPeriod || "MONTHLY");
  await prisma.tenantPlan.update({
    where: { id: current.id },
    data: { endsAt, status: SUBSCRIPTION_STATUSES.ACTIVE, notes: input.reason || current.notes },
  });
  await writeAudit(prisma, {
    tenantId,
    actorUserId: input.actorUserId || null,
    action: "subscription.extended",
    entityType: "tenant_plan",
    entityId: current.id,
    changes: { endsAt, reason: input.reason || null },
  });
  const { getBillingState } = await import("./billingService.ts");
  return getBillingState(prisma, tenantId);
}
