import { kaspiPayments } from "./kaspiPaymentProvider.ts";
import type { PrismaClient } from "@creolab/db";
import { z } from "zod";
import type { AuthContext } from "../../lib/types.ts";
import { requirePlatformAdmin } from "../../lib/access.ts";
import { billingAudit, lockTenant } from "./ledger.ts";
import { billingError } from "./config.ts";
import { sellerProfile } from "./documents.ts";
export async function adminBilling(
  db: PrismaClient,
  auth: AuthContext,
  query: Record<string, unknown>,
) {
  requirePlatformAdmin(auth);
  const status =
    typeof query.status === "string" && query.status ? query.status : undefined;
  const page = Math.max(1, Math.min(10000, Number(query.page) || 1)),
    take = 50;
  const [payments, total, subscriptions, invoices, plans, seller] =
    await Promise.all([
      db.billingPayment.findMany({
        where: status ? { status } : {},
        orderBy: { createdAt: "desc" },
        take,
        skip: (page - 1) * take,
      }),
      db.billingPayment.count({ where: status ? { status } : {} }),
      db.tenantPlan.findMany({
        orderBy: { startsAt: "desc" },
        take: 100,
        select: {
          id: true,
          tenantId: true,
          planId: true,
          status: true,
          startsAt: true,
          endsAt: true,
          autoRenew: true,
          paymentMethod: true,
          gracePeriodEndsAt: true,
          amountMinor: true,
          billingPeriod: true,
        },
      }),
      db.billingInvoice.findMany({ orderBy: { issueDate: "desc" }, take: 100 }),
      db.plan.findMany({ orderBy: { sortOrder: "asc" } }),
      sellerProfile(db),
    ]);
  const ids = [
    ...new Set(
      [...payments, ...subscriptions, ...invoices].map((x) => x.tenantId),
    ),
  ];
  const [tenants, profiles, orders] = await Promise.all([
    db.tenant.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    }),
    db.tenantLegalProfile.findMany({
      where: { tenantId: { in: ids } },
      select: { tenantId: true, bin: true, iin: true },
    }),
    db.billingOrder.findMany({
      where: {
        id: {
          in: payments
            .map((p) => p.orderId)
            .filter((id): id is string => Boolean(id)),
        },
      },
    }),
  ]);
  return {
    payments: payments.map((p) => ({ ...p, metadataJson: undefined })),
    total,
    page,
    subscriptions,
    invoices,
    plans,
    seller,
    tenants,
    profiles,
    orders,
  };
}
export async function attachKaspiLink(
  db: PrismaClient,
  auth: AuthContext,
  id: string,
  input: unknown,
) {
  requirePlatformAdmin(auth);
  const v = z
      .object({ url: z.url(), reference: z.string().trim().min(3).max(200) })
      .parse(input),
    url = new URL(kaspiPayments.validatePaymentLink(v.url));
  if (
    url.protocol !== "https:" ||
    !(url.hostname === "kaspi.kz" || url.hostname.endsWith(".kaspi.kz")) ||
    url.username ||
    url.password ||
    url.port
  )
    billingError(
      "kaspi_link",
      "Укажите официальную ссылку Kaspi для этого заказа",
    );
  return db.$transaction(async (tx) => {
    const p = await tx.billingPayment.findUniqueOrThrow({ where: { id } });
    await lockTenant(tx, p.tenantId);
    if (p.provider !== "KASPI" || p.status !== "PENDING")
      billingError("payment_closed", "Платёж недоступен", 409);
    if (
      await tx.billingPayment.findFirst({
        where: { id: { not: id }, checkoutUrl: url.href },
      })
    )
      billingError(
        "kaspi_link_reused",
        "Для каждого заказа нужна отдельная ссылка",
        409,
      );
    await tx.billingPayment.update({
      where: { id },
      data: {
        checkoutUrl: url.href,
        externalReference: v.reference,
        providerPaymentId: v.reference,
      },
    });
    await billingAudit(
      tx,
      p.tenantId,
      "KASPI_LINK_ATTACHED",
      id,
      auth.user.id,
      { reference: v.reference },
    );
    return { ok: true };
  });
}
export async function updateBillingPlan(
  db: PrismaClient,
  auth: AuthContext,
  id: string,
  input: unknown,
) {
  requirePlatformAdmin(auth);
  const v = z
    .object({
      name: z.string().trim().min(2).max(150),
      description: z.string().max(1000),
      monthlyPriceMinor: z.number().int().min(0).max(100_000_000),
      yearlyPriceMinor: z.number().int().min(0).max(1_200_000_000),
      active: z.boolean(),
      public: z.boolean(),
      sortOrder: z.number().int().min(0).max(1000),
    })
    .parse(input);
  return db.$transaction(async (tx) => {
    const old = await tx.plan.findUniqueOrThrow({ where: { id } });
    if (
      ["BASQAR_FREE", "starter"].includes(old.code) &&
      (v.monthlyPriceMinor !== 0 || v.yearlyPriceMinor !== 0 || !v.active)
    )
      billingError("free_plan", "Бесплатный тариф должен оставаться доступным");
    const updated = await tx.plan.update({
      where: { id },
      data: { ...v, version: { increment: 1 } },
    });
    await billingAudit(tx, "", "BILLING_PLAN_UPDATED", id, auth.user.id, {
      code: old.code,
      oldPrice: old.monthlyPriceMinor,
      newPrice: v.monthlyPriceMinor,
    });
    return updated;
  });
}

/** Inspect only: card activation still requires the signed result callback. Never return card data. */
export async function inspectProviderPayment(
  db: PrismaClient,
  auth: AuthContext,
  id: string,
) {
  requirePlatformAdmin(auth);
  const { checkProviderPayment } = await import("./paymentCheck.ts");
  return checkProviderPayment(db, id, auth.user.id);
}
