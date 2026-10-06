import { type PrismaClient, Prisma } from "@creolab/db";
import { decryptSecret } from "../../lib/secretBox.ts";
import {
  quoteRenewal,
  ensurePricingCatalog,
  type PricingQuote,
} from "../pricingEngine.ts";
import { freedomPay } from "./freedomPayProvider.ts";
import type { PaymentProvider } from "../paymentProvider.ts";
import { billingConfig } from "./config.ts";
import {
  lockTenant,
  createAttempt,
  failPayment,
  billingAudit,
  queueBillingEmail,
  activateOrder,
} from "./ledger.ts";
import { nextNumber } from "./documents.ts";

/** Keyset pagination prevents unresolved payments from starving later tenants. */
async function* pages<T extends { id: string }>(
  read: (cursor?: string) => Promise<T[]>,
) {
  let cursor: string | undefined;
  for (;;) {
    const rows = await read(cursor);
    if (!rows.length) return;
    for (const row of rows) yield row;
    cursor = rows.at(-1)!.id;
  }
}

/** One durable order per subscription period; external requests never execute inside a DB transaction. */
export async function processBillingRenewals(
  db: PrismaClient,
  now = new Date(),
  provider: PaymentProvider = freedomPay,
) {
  let expiredSubscriptions = 0;
  await ensurePricingCatalog(db);
  const due = pages((cursor) =>
    db.tenantPlan.findMany({
      where: {
        autoRenew: true,
        status: "active",
        endsAt: {
          lte: new Date(now.getTime() + 86400_000),
          gt: new Date(now.getTime() - billingConfig().graceDays * 86400_000),
        },
        recurringProfileEncrypted: { not: null },
      },
      take: 30,
      orderBy: { id: "asc" },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),
  );
  if (provider.configured && billingConfig().recurring)
    for await (const row of due) {
      const claimed = await db.$transaction(
        async (tx) => {
          await lockTenant(tx, row.tenantId);
          const sub = await tx.tenantPlan.findUniqueOrThrow({
            where: { id: row.id },
            include: { plan: true },
          });
          if (
            !sub.autoRenew ||
            !sub.recurringProfileEncrypted ||
            !sub.endsAt ||
            sub.status !== "active" ||
            sub.endsAt > new Date(now.getTime() + 86400_000)
          )
            return null;
          const renewalKey = `${sub.id}:${sub.endsAt.toISOString()}`;
          if (await tx.billingOrder.findUnique({ where: { renewalKey } }))
            return null;
          if (
            await tx.billingOrder.count({
              where: { tenantId: sub.tenantId, status: "PENDING_PAYMENT" },
            })
          )
            return null;
          const quote = await quoteRenewal(
            tx as PrismaClient,
            sub.tenantId,
            sub.plan.code,
            sub.billingPeriod,
          );
          if (quote.finalAmountMinor <= 0) return null;
          const order = await tx.billingOrder.create({
            data: {
              tenantId: sub.tenantId,
              subscriptionId: sub.id,
              planId: sub.planId,
              planCode: sub.plan.code,
              orderNumber: await nextNumber(tx, "BSQ"),
              amountMinor: quote.finalAmountMinor,
              currency: "KZT",
              billingPeriod: sub.billingPeriod,
              description: `Подписка BasQar — ${sub.plan.name}, продление`,
              kind: "RENEWAL",
              renewalKey,
              snapshotJson: quote.snapshot as Prisma.InputJsonValue,
              expiresAt: new Date(
                sub.endsAt.getTime() + billingConfig().graceDays * 86400_000,
              ),
            },
          });
          const attempt = await createAttempt(
            tx,
            order.id,
            sub.tenantId,
            "CARD",
            true,
            undefined,
            true,
          );
          return { ...attempt, profile: sub.recurringProfileEncrypted };
        },
        { timeout: 30_000 },
      );
      if (!claimed) continue;
      try {
        const result = await provider.createRecurringPayment(
          {
            paymentId: claimed.payment.id,
            orderId: claimed.order.id,
            tenantId: claimed.order.tenantId,
            amount: claimed.order.amountMinor,
            currency: "KZT",
            description: claimed.order.description,
            returnUrl: `${billingConfig().appUrl}/billing`,
            autoRenew: true,
          },
          decryptSecret(claimed.profile),
        );
        await db.billingPayment.updateMany({
          where: { id: claimed.payment.id, status: "PROCESSING" },
          data: { providerPaymentId: result.providerPaymentId },
        });
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "provider_declined"
        )
          await failPayment(db, claimed.payment.id, "provider_declined");
        else
          await db.billingPayment.updateMany({
            where: { id: claimed.payment.id, status: "PROCESSING" },
            data: { failureReason: "provider_uncertain" },
          });
      }
    }
  const ending = pages((cursor) =>
    db.tenantPlan.findMany({
      where: {
        OR: [
          {
            status: {
              in: [
                "active",
                "past_due",
                "grace_period",
                "cancel_at_period_end",
                "trial",
              ],
            },
            endsAt: { lte: now },
          },
          { status: "trial", trialEndsAt: { lte: now } },
        ],
      },
      take: 100,
      orderBy: { id: "asc" },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),
  );
  for await (const old of ending)
    await db.$transaction(
      async (tx) => {
        await lockTenant(tx, old.tenantId);
        const s = await tx.tenantPlan.findUniqueOrThrow({
          where: { id: old.id },
        });
        const boundary = s.status === "trial" ? s.trialEndsAt : s.endsAt;
        if (!boundary || boundary > now) return;
        const next = s.nextPlanJson as { orderId?: string } | null;
        if (next?.orderId) {
          const order = await tx.billingOrder.findFirst({
            where: {
              id: next.orderId,
              tenantId: s.tenantId,
              status: "PAID",
              effectiveAt: { lte: now },
            },
          });
          const payment =
            order &&
            (await tx.billingPayment.findFirst({
              where: { orderId: order.id, status: "PAID" },
            }));
          if (order && payment) {
            await activateOrder(tx, order, payment.id, payment.method);
            await tx.tenantPlan.update({
              where: { id: s.id },
              data: { nextPlanJson: Prisma.JsonNull },
            });
            return;
          }
        }
        if (
          ![
            "active",
            "past_due",
            "grace_period",
            "cancel_at_period_end",
            "trial",
          ].includes(s.status)
        )
          return;
        const renewing =
          s.autoRenew || ["past_due", "grace_period"].includes(s.status);
        const grace =
          s.gracePeriodEndsAt ||
          new Date(boundary.getTime() + billingConfig().graceDays * 86400_000);
        const status = renewing
          ? grace > now
            ? "grace_period"
            : "suspended"
          : "expired";
        if (status === s.status) return;
        await tx.tenantPlan.update({
          where: { id: s.id },
          data: { status, gracePeriodEndsAt: renewing ? grace : null },
        });
        if (status === "expired") {
          expiredSubscriptions++;
          const { writeAudit } = await import("../../lib/audit.ts");
          await writeAudit(tx, {
            tenantId: s.tenantId,
            action: "subscription.expired",
            entityType: "tenant_plan",
            entityId: s.id,
            changes: { endsAt: s.endsAt },
          });
        }
        await billingAudit(
          tx,
          s.tenantId,
          status === "suspended"
            ? "SUBSCRIPTION_SUSPENDED"
            : status === "grace_period"
              ? "SUBSCRIPTION_GRACE_PERIOD"
              : "SUBSCRIPTION_EXPIRED",
          s.id,
        );
        await queueBillingEmail(
          tx,
          s.tenantId,
          s.id,
          "Подписка BasQar требует оплаты",
          `Статус подписки: ${status}. Данные компании сохранены. Оплатить: ${billingConfig().appUrl}/billing`,
        );
      },
      { timeout: 30_000 },
    );
  const expired = pages((cursor) =>
    db.billingOrder.findMany({
      where: { status: "PENDING_PAYMENT", expiresAt: { lte: now } },
      take: 100,
      orderBy: { id: "asc" },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),
  );
  for await (const o of expired)
    await db.$transaction(async (tx) => {
      await lockTenant(tx, o.tenantId);
      if (
        await tx.billingPayment.count({
          where: { orderId: o.id, status: "PROCESSING" },
        })
      )
        return; // unresolved provider requests need reconciliation, never another charge
      const changed = await tx.billingOrder.updateMany({
        where: { id: o.id, status: "PENDING_PAYMENT", expiresAt: { lte: now } },
        data: { status: "EXPIRED" },
      });
      if (changed.count) {
        await tx.billingPayment.updateMany({
          where: { orderId: o.id, status: "PENDING" },
          data: { status: "CANCELLED" },
        });
        await tx.billingInvoice.updateMany({
          where: { orderId: o.id, status: "ISSUED" },
          data: { status: "EXPIRED" },
        });
      }
    });
  return { expired: expiredSubscriptions };
}
