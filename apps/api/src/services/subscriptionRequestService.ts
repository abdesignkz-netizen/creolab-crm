import type { Prisma, PrismaClient } from "@creolab/db";
import {
  OPEN_REQUEST_STATUSES,
  SUBSCRIPTION_REQUEST_TYPES,
  type SubscriptionRequestType,
} from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { writeAudit } from "../lib/audit.ts";
import { requireCompanyAdmin, requirePlatformAdmin, requireTenant } from "../lib/access.ts";
import type { AuthContext } from "../lib/types.ts";
import { quoteSubscription, type QuoteAddonInput } from "./pricingEngine.ts";
import { activateSubscription } from "./subscriptionActivationService.ts";
import { collectTenantUsage } from "./billingUsageService.ts";
import { getBillingState } from "./billingService.ts";
import { getEntitlements } from "./entitlementService.ts";

function asAddOns(value: unknown): QuoteAddonInput[] {
  if (!Array.isArray(value)) return [];
  const items: QuoteAddonInput[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const code = String(rec.code || "").trim();
    if (!code) continue;
    items.push({ code, qty: Number(rec.qty) || 1 });
  }
  return items;
}

function requestType(value: unknown): SubscriptionRequestType {
  const raw = String(value || "NEW_SUBSCRIPTION");
  return (SUBSCRIPTION_REQUEST_TYPES as readonly string[]).includes(raw)
    ? (raw as SubscriptionRequestType)
    : "NEW_SUBSCRIPTION";
}

function inferRequestType(
  raw: unknown,
  planCode: string,
  amountMinor: number,
  current: Awaited<ReturnType<typeof getEntitlements>>,
): SubscriptionRequestType {
  if (raw) return requestType(raw);
  if (planCode === "CRM_ENTERPRISE") return "ENTERPRISE_REQUEST";
  if (!current.snapshot.entitled || current.snapshot.previewMode) return "NEW_SUBSCRIPTION";
  if (current.snapshot.planCode === planCode) return "RENEWAL";
  if (amountMinor < Number(current.snapshot.amountMinor || 0)) return "DOWNGRADE";
  return "UPGRADE";
}

function limitsLower(next: Record<string, number>, current: Record<string, number>, entitled: boolean) {
  if (!entitled) return false;
  return ["USERS", "WHATSAPP_CONNECTIONS", "PIPELINES", "STORAGE_GB"].some(
    (key) => Number(next[key] ?? Infinity) < Number(current[key] ?? 0),
  );
}

function serializeRequest(row: {
  id: string;
  tenantId: string;
  requestType: string;
  requestedPlanCode: string | null;
  billingPeriod: string;
  requestedAddOnsJson: unknown;
  baseAmountMinor: number;
  discountAmountMinor: number;
  finalAmountMinor: number;
  currency: string;
  status: string;
  snapshotJson: unknown;
  adminComment: string | null;
  rejectionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  reviewedAt: Date | null;
  requestedByUserId: string | null;
}) {
  const snapshot = (row.snapshotJson && typeof row.snapshotJson === "object" ? row.snapshotJson : {}) as Record<string, unknown>;
  return {
    id: row.id,
    tenantId: row.tenantId,
    requestType: row.requestType,
    planCode: row.requestedPlanCode,
    planName: snapshot.planName || row.requestedPlanCode,
    billingPeriod: row.billingPeriod,
    addOns: asAddOns(row.requestedAddOnsJson),
    baseAmountMinor: row.baseAmountMinor,
    discountAmountMinor: row.discountAmountMinor,
    finalAmountMinor: row.finalAmountMinor,
    currency: row.currency,
    status: row.status,
    statusLabel: statusLabel(row.status),
    snapshot,
    adminComment: row.adminComment,
    rejectionReason: row.rejectionReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    reviewedAt: row.reviewedAt?.toISOString() || null,
    requestedByUserId: row.requestedByUserId,
  };
}

function statusLabel(status: string) {
  return (
    {
      PENDING: "Черновик",
      AWAITING_PAYMENT: "Ожидает подтверждения оплаты",
      PAYMENT_REVIEW: "Оплата на проверке",
      APPROVED: "Одобрен",
      REJECTED: "Отклонён",
      CANCELLED: "Отменён",
      ACTIVATED: "Активирован",
    }[status] || status
  );
}

export async function getOpenBillingRequest(prisma: PrismaClient, tenantId: string) {
  return prisma.subscriptionRequest.findFirst({
    where: { tenantId, status: { in: [...OPEN_REQUEST_STATUSES] } },
    orderBy: { createdAt: "desc" },
  });
}

export async function createSubscriptionRequest(
  prisma: PrismaClient,
  auth: AuthContext,
  input: unknown,
) {
  requireCompanyAdmin(auth, "Запрос тарифа доступен администратору компании");
  const membership = requireTenant(auth);
  const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const planCode = String(body.planCode || body.requestedPlanId || "").trim();
  if (!planCode) throw new ApiError(422, "invalid", "Выберите тариф");
  const billingPeriod = body.billingPeriod === "YEARLY" ? "YEARLY" : "MONTHLY";
  const addOns = asAddOns(body.addOns || body.requestedAddOns);
  const quote = await quoteSubscription(prisma, { planCode, addOns, billingPeriod });
  const current = await getEntitlements(prisma, membership.tenantId);
  const type = inferRequestType(body.requestType || body.type, planCode, quote.finalAmountMinor, current);

  if (type === "DOWNGRADE" || limitsLower(quote.limits, current.limits, current.snapshot.entitled)) {
    const issues = await downgradeBlockers(prisma, membership.tenantId, quote.limits);
    if (issues.length) {
      throw new ApiError(
        422,
        "LIMIT_EXCEEDED_AFTER_DOWNGRADE",
        "Сначала уменьшите использование до лимитов нового тарифа.",
        undefined,
        { issues },
      );
    }
  }

  const open = await getOpenBillingRequest(prisma, membership.tenantId);
  const payload = {
    requestType: type,
    requestedPlanCode: quote.planCode,
    billingPeriod,
    requestedAddOnsJson: quote.snapshot.addOns as Prisma.InputJsonValue,
    baseAmountMinor: quote.baseAmountMinor,
    discountAmountMinor: quote.discountAmountMinor,
    finalAmountMinor: quote.finalAmountMinor,
    currency: "KZT",
    status: "AWAITING_PAYMENT" as const,
    snapshotJson: {
      ...quote.snapshot,
      planName: quote.planName,
      recommendation: quote.recommendation,
    } as Prisma.InputJsonValue,
    requestedByUserId: auth.user.id,
    rejectionReason: null,
    adminComment: null,
  };

  const row = open
    ? await prisma.subscriptionRequest.update({ where: { id: open.id }, data: payload })
    : await prisma.subscriptionRequest.create({
        data: { tenantId: membership.tenantId, ...payload },
      });

  await writeAudit(prisma, {
    tenantId: membership.tenantId,
    actorUserId: auth.user.id,
    action: open ? "subscription_request.updated" : "subscription_request.created",
    entityType: "subscription_request",
    entityId: row.id,
    changes: { planCode: quote.planCode, amount: quote.finalAmountMinor, type },
  });
  return serializeRequest(row);
}

export async function cancelSubscriptionRequest(prisma: PrismaClient, auth: AuthContext, id: string) {
  requireCompanyAdmin(auth);
  const membership = requireTenant(auth);
  const row = await prisma.subscriptionRequest.findFirst({ where: { id, tenantId: membership.tenantId } });
  if (!row) throw new ApiError(404, "not_found", "Запрос не найден");
  if (!OPEN_REQUEST_STATUSES.includes(row.status as (typeof OPEN_REQUEST_STATUSES)[number])) {
    throw new ApiError(409, "invalid_state", "Этот запрос нельзя отменить");
  }
  const updated = await prisma.subscriptionRequest.update({
    where: { id: row.id },
    data: { status: "CANCELLED" },
  });
  await writeAudit(prisma, {
    tenantId: membership.tenantId,
    actorUserId: auth.user.id,
    action: "subscription_request.cancelled",
    entityType: "subscription_request",
    entityId: row.id,
  });
  return serializeRequest(updated);
}

export async function listTenantBillingRequests(prisma: PrismaClient, auth: AuthContext) {
  requireTenant(auth);
  const membership = requireTenant(auth);
  const items = await prisma.subscriptionRequest.findMany({
    where: { tenantId: membership.tenantId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return { items: items.map(serializeRequest), current: items.find((row) => OPEN_REQUEST_STATUSES.includes(row.status as never)) || null };
}

async function downgradeBlockers(prisma: PrismaClient, tenantId: string, limits: Record<string, number>) {
  const usage = await collectTenantUsage(prisma, tenantId);
  const issues: Array<{ limit: string; used: number; cap: number; message: string }> = [];
  const checks: Array<[string, number, string]> = [
    ["USERS", usage.users, "пользователей"],
    ["WHATSAPP_CONNECTIONS", usage.whatsapp, "подключений WhatsApp"],
    ["PIPELINES", usage.pipelines, "воронок"],
    ["STORAGE_GB", usage.storageGb, "ГБ хранилища"],
  ];
  for (const [key, used, label] of checks) {
    const cap = Number(limits[key] ?? Infinity);
    if (Number.isFinite(cap) && used > cap) {
      issues.push({
        limit: key,
        used,
        cap,
        message: `В тарифе доступно ${cap} ${label}. Сейчас ${used}.`,
      });
    }
  }
  return issues;
}

export async function listAdminBillingRequests(
  prisma: PrismaClient,
  auth: AuthContext,
  query: Record<string, string | undefined> = {},
) {
  requirePlatformAdmin(auth);
  const status = String(query.status || "");
  const items = await prisma.subscriptionRequest.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: "desc" },
    take: 80,
    include: {
      tenant: { select: { id: true, name: true, slug: true, status: true } },
    },
  });
  const pendingCount = await prisma.subscriptionRequest.count({
    where: { status: { in: [...OPEN_REQUEST_STATUSES] } },
  });
  const tenantIds = [...new Set(items.map((row) => row.tenantId))];
  const owners = tenantIds.length
    ? await prisma.membership.findMany({
        where: { tenantId: { in: tenantIds }, role: "owner", active: true },
        include: { user: { select: { name: true, email: true, phone: true } } },
      })
    : [];
  const ownerByTenant = new Map(owners.map((row) => [row.tenantId, row]));
  return {
    pendingCount,
    items: items.map((row) => {
      const owner = ownerByTenant.get(row.tenantId);
      return {
        ...serializeRequest(row),
        company: row.tenant.name,
        slug: row.tenant.slug,
        ownerName: owner?.user.name || null,
        ownerEmail: owner?.user.email || null,
        ownerPhone: owner?.user.phone || null,
      };
    }),
  };
}

export async function getAdminBillingRequest(prisma: PrismaClient, auth: AuthContext, id: string) {
  requirePlatformAdmin(auth);
  const row = await prisma.subscriptionRequest.findUnique({
    where: { id },
    include: { tenant: true, payments: true },
  });
  if (!row) throw new ApiError(404, "not_found", "Запрос не найден");
  const billing = await getBillingState(prisma, row.tenantId);
  const owner = await prisma.membership.findFirst({
    where: { tenantId: row.tenantId, role: "owner", active: true },
    include: { user: { select: { name: true, email: true, phone: true } } },
  });
  return {
    request: serializeRequest(row),
    company: { id: row.tenant.id, name: row.tenant.name, slug: row.tenant.slug, status: row.tenant.status },
    owner: owner ? { name: owner.user.name, email: owner.user.email, phone: owner.user.phone } : null,
    billing,
    payments: row.payments.map((item) => ({
      id: item.id,
      amountMinor: item.amountMinor,
      status: item.status,
      method: item.method,
      confirmedAt: item.confirmedAt?.toISOString() || null,
    })),
  };
}

export async function rejectBillingRequest(
  prisma: PrismaClient,
  auth: AuthContext,
  id: string,
  input: unknown,
) {
  requirePlatformAdmin(auth);
  const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const row = await prisma.subscriptionRequest.findUnique({ where: { id } });
  if (!row) throw new ApiError(404, "not_found", "Запрос не найден");
  if (row.status === "ACTIVATED") throw new ApiError(409, "invalid_state", "Запрос уже активирован");
  const updated = await prisma.subscriptionRequest.update({
    where: { id },
    data: {
      status: "REJECTED",
      reviewedAt: new Date(),
      reviewedByAdminId: auth.user.id,
      rejectionReason: String(body.reason || body.rejectionReason || "").trim() || "Отклонено администратором",
    },
  });
  await writeAudit(prisma, {
    tenantId: row.tenantId,
    actorUserId: auth.user.id,
    action: "subscription_request.rejected",
    entityType: "subscription_request",
    entityId: row.id,
    changes: { reason: updated.rejectionReason },
  });
  return serializeRequest(updated);
}

export async function confirmBillingPaymentAndActivate(
  prisma: PrismaClient,
  auth: AuthContext,
  id: string,
  input: unknown,
) {
  requirePlatformAdmin(auth);
  const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const existing = await prisma.subscriptionRequest.findUnique({ where: { id }, include: { payments: true } });
  if (!existing) throw new ApiError(404, "not_found", "Запрос не найден");
  if (existing.status === "ACTIVATED") {
    return getBillingState(prisma, existing.tenantId);
  }
  if (!OPEN_REQUEST_STATUSES.includes(existing.status as (typeof OPEN_REQUEST_STATUSES)[number])) {
    throw new ApiError(409, "invalid_state", "Этот запрос нельзя активировать");
  }

  const addOns = asAddOns(existing.requestedAddOnsJson);
  const billingPeriod = existing.billingPeriod === "YEARLY" ? "YEARLY" : "MONTHLY";
  const confirmed = existing.payments.find((item) => item.status === "CONFIRMED");
  const payment =
    confirmed ||
    (await prisma.billingPayment.create({
      data: {
        tenantId: existing.tenantId,
        subscriptionRequestId: existing.id,
        amountMinor: existing.finalAmountMinor,
        currency: existing.currency,
        method: "MANUAL",
        status: "CONFIRMED",
        confirmedByAdminId: auth.user.id,
        confirmedAt: new Date(),
        externalReference: String(body.externalReference || "").trim() || null,
      },
    }));

  const claimed = await prisma.subscriptionRequest.updateMany({
    where: { id: existing.id, status: { not: "ACTIVATED" } },
    data: {
      status: "PAYMENT_REVIEW",
      paymentId: payment.id,
      reviewedByAdminId: auth.user.id,
      reviewedAt: new Date(),
      adminComment: String(body.comment || body.adminComment || "").trim() || null,
    },
  });
  if (!claimed.count) return getBillingState(prisma, existing.tenantId);

  const billing = await activateSubscription(prisma, {
    tenantId: existing.tenantId,
    planCode: existing.requestedPlanCode,
    addOns,
    billingPeriod,
    startDate: body.startDate ? String(body.startDate) : null,
    endDate: body.endDate ? String(body.endDate) : null,
    actorUserId: auth.user.id,
    source: "platform_admin_payment",
    requestId: existing.id,
    paymentId: payment.id,
    amountMinor: existing.finalAmountMinor,
    notes: String(body.comment || "").trim() || null,
    extendFromCurrentEnd: existing.requestType === "RENEWAL",
  });
  await prisma.subscriptionRequest.updateMany({
    where: { id: existing.id, status: { not: "ACTIVATED" } },
    data: {
      status: "ACTIVATED",
      activatedSubscriptionId: billing.tenantPlanId,
      reviewedAt: new Date(),
      reviewedByAdminId: auth.user.id,
    },
  });
  await writeAudit(prisma, {
    tenantId: existing.tenantId,
    actorUserId: auth.user.id,
    action: "payment.confirmed",
    entityType: "billing_payment",
    entityId: payment.id,
    changes: { requestId: existing.id, amountMinor: existing.finalAmountMinor },
  });
  return billing;
}
