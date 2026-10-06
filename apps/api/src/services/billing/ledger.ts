import { kaspiPayments } from "./kaspiPaymentProvider.ts";
import type { Prisma, PrismaClient } from "@creolab/db";
import { z } from "zod";
import type { AuthContext } from "../../lib/types.ts";
import {
  requireCompanyAdmin,
  requireTenant,
  requirePlatformAdmin,
} from "../../lib/access.ts";
import { writeAudit } from "../../lib/audit.ts";
import { encryptSecret } from "../../lib/secretBox.ts";
import {
  ensurePricingCatalog,
  quoteSubscription,
  quoteRenewal,
  type PricingQuote,
} from "../pricingEngine.ts";
import { loadCurrentTenantPlan } from "../entitlementService.ts";
import { activateSubscription } from "../subscriptionActivationService.ts";
import type { PaymentNotice, PaymentProvider } from "../paymentProvider.ts";
import { freedomPay } from "./freedomPayProvider.ts";
import { billingConfig, billingError } from "./config.ts";
import { issueInvoice, nextNumber, sellerProfile } from "./documents.ts";

export type DB = PrismaClient | Prisma.TransactionClient;
const openPayments = ["PENDING", "PROCESSING"];
export function billingTenant(auth: AuthContext) {
  requireCompanyAdmin(auth);
  return requireTenant(auth).tenantId;
}
export async function lockTenant(db: DB, tenantId: string) {
  await db.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;
}
export async function billingAudit(
  db: DB,
  tenantId: string,
  action: string,
  id: string,
  userId?: string,
  changes: unknown = {},
) {
  await writeAudit(db, {
    tenantId,
    actorUserId: userId,
    action,
    entityType: "billing",
    entityId: id,
    changes,
  });
}
const checkoutSchema = z.object({
  planCode: z.string().min(1).max(100),
  billingPeriod: z.enum(["MONTHLY", "YEARLY"]).default("MONTHLY"),
  addOns: z
    .array(
      z.object({
        code: z.string().max(100),
        qty: z.number().int().min(1).max(1000).optional(),
      }),
    )
    .max(30)
    .default([]),
  renewal: z.boolean().default(false),
});
export async function createCheckout(
  db: PrismaClient,
  auth: AuthContext,
  input: unknown,
) {
  const tenantId = billingTenant(auth),
    v = checkoutSchema.parse(input);
  await ensurePricingCatalog(db);
  return db.$transaction(
    async (tx) => {
      await lockTenant(tx, tenantId);
      const current = await loadCurrentTenantPlan(tx as PrismaClient, tenantId);
      if (v.renewal && current?.plan.code !== v.planCode)
        billingError(
          "renewal_plan",
          "Выберите действующий тариф для продления",
        );
      if (
        current &&
        (
          await tx.tenantPlan.findUnique({
            where: { id: current.id },
            select: { nextPlanJson: true },
          })
        )?.nextPlanJson
      )
        billingError(
          "scheduled_plan_exists",
          "Смена тарифа уже запланирована. Дождитесь её применения.",
          409,
        );
      if (
        current?.plan.code === v.planCode &&
        v.billingPeriod === current.billingPeriod &&
        JSON.stringify(v.addOns) === JSON.stringify(current.itemsJson || [])
      )
        v.renewal = true;
      const quote = v.renewal
        ? await quoteRenewal(
            tx as PrismaClient,
            tenantId,
            v.planCode,
            v.billingPeriod,
          )
        : await quoteSubscription(tx as PrismaClient, v);
      const plan = await tx.plan.findUnique({ where: { code: v.planCode } });
      if (
        !plan ||
        (!v.renewal &&
          (!plan.active ||
            !plan.public ||
            plan.catalogStatus !== "AVAILABLE")) ||
        quote.finalAmountMinor <= 0 ||
        !Number.isSafeInteger(quote.finalAmountMinor)
      )
        billingError(
          "plan_unavailable",
          "Для этого тарифа используйте заявку администратору",
        );
      const pending = await tx.billingOrder.findFirst({
        where: {
          tenantId,
          status: "PENDING_PAYMENT",
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: "desc" },
      });
      if (pending) {
        if (
          pending.planCode === v.planCode &&
          pending.billingPeriod === v.billingPeriod &&
          JSON.stringify(
            (pending.snapshotJson as unknown as PricingQuote["snapshot"])
              .addOns,
          ) === JSON.stringify(quote.snapshot.addOns) &&
          pending.kind === (v.renewal ? "RENEWAL" : pending.kind)
        )
          return pending;
        billingError(
          "checkout_exists",
          "Сначала завершите или отмените текущий заказ",
          409,
        );
      }
      if (
        await tx.billingPayment.count({
          where: { tenantId, status: "PROCESSING" },
        })
      )
        billingError(
          "payment_processing",
          "Предыдущий платёж ещё проверяется",
          409,
        );
      const subscription =
        current ||
        (await tx.tenantPlan.create({
          data: {
            tenantId,
            planId: plan.id,
            status: "pending",
            startsAt: new Date(),
          },
        }));
      // Downgrades take effect at the end of the paid period. No proration in this version.
      const lower = Boolean(
        current?.endsAt &&
        current.endsAt > new Date() &&
        quote.finalAmountMinor / (v.billingPeriod === "YEARLY" ? 12 : 1) <
          (current.amountMinor || 0) /
            (current.billingPeriod === "YEARLY" ? 12 : 1),
      );
      const order = await tx.billingOrder.create({
        data: {
          tenantId,
          subscriptionId: subscription.id,
          planId: plan.id,
          planCode: plan.code,
          orderNumber: await nextNumber(tx, "BSQ"),
          amountMinor: quote.finalAmountMinor,
          currency: "KZT",
          billingPeriod: v.billingPeriod,
          description: `Подписка BasQar — ${plan.name}, ${v.billingPeriod === "YEARLY" ? "12 месяцев" : "1 месяц"}`,
          snapshotJson: quote.snapshot as Prisma.InputJsonValue,
          kind: v.renewal
            ? "RENEWAL"
            : lower
              ? "DOWNGRADE"
              : "NEW_SUBSCRIPTION",
          effectiveAt: lower ? current!.endsAt : null,
          expiresAt: new Date(Date.now() + 7 * 86400_000),
          createdByUserId: auth.user.id,
        },
      });
      await billingAudit(
        tx,
        tenantId,
        "SUBSCRIPTION_CREATED",
        order.id,
        auth.user.id,
        { orderNumber: order.orderNumber, planCode: plan.code },
      );
      return order;
    },
    { timeout: 30_000 },
  );
}
export async function checkoutDetail(
  db: PrismaClient,
  auth: AuthContext,
  id: string,
) {
  const tenantId = billingTenant(auth);
  const order = await db.billingOrder.findFirst({ where: { id, tenantId } });
  if (!order) billingError("not_found", "Заказ не найден", 404);
  const [payments, invoice, buyer, seller, subscription] = await Promise.all([
    db.billingPayment.findMany({
      where: { orderId: id, tenantId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        method: true,
        status: true,
        amountMinor: true,
        currency: true,
        createdAt: true,
        paidAt: true,
        checkoutUrl: true,
        failureReason: true,
      },
    }),
    db.billingInvoice.findFirst({ where: { orderId: id, tenantId } }),
    db.tenantLegalProfile.findUnique({ where: { tenantId } }),
    sellerProfile(db),
    db.tenantPlan.findFirst({
      where: { tenantId },
      orderBy: { startsAt: "desc" },
      select: { endsAt: true, status: true },
    }),
  ]);
  return {
    order,
    payments,
    invoice,
    buyer,
    seller,
    subscription,
    methods: {
      card: freedomPay.configured,
      recurring: freedomPay.configured && billingConfig().recurring,
      kaspi: billingConfig().kaspi,
      bankTransfer: Boolean(seller),
    },
  };
}
export async function createAttempt(
  db: DB,
  orderId: string,
  tenantId: string,
  method: string,
  autoRenew: boolean,
  userId?: string,
  recurring = false,
) {
  const order = await db.billingOrder.findFirst({
    where: { id: orderId, tenantId },
  });
  if (!order) billingError("not_found", "Заказ не найден", 404);
  if (order.status !== "PENDING_PAYMENT" || order.expiresAt <= new Date())
    billingError("order_closed", "Заказ закрыт или срок оплаты истёк", 409);
  const prior = await db.billingPayment.findFirst({
    where: { orderId, status: { in: openPayments } },
  });
  if (prior) {
    if (prior.method !== method)
      billingError(
        "payment_exists",
        "Для заказа уже выбран способ оплаты. Отмените ожидающий платёж перед сменой способа.",
        409,
      );
    return { payment: prior, order, created: false };
  }
  const attempt = await db.billingPayment.count({ where: { orderId } });
  const payment = await db.billingPayment.create({
    data: {
      tenantId,
      orderId,
      subscriptionId: order.subscriptionId,
      amountMinor: order.amountMinor,
      currency: order.currency,
      method,
      provider:
        method === "CARD"
          ? "FREEDOM_PAY"
          : method === "KASPI"
            ? "KASPI"
            : "BANK_TRANSFER",
      status: method === "CARD" ? "PROCESSING" : "PENDING",
      autoRenewRequested: autoRenew,
      recurring,
      idempotencyKey: `${orderId}:${attempt + 1}`,
    },
  });
  await billingAudit(db, tenantId, "PAYMENT_CREATED", payment.id, userId, {
    orderNumber: order.orderNumber,
    amount: payment.amountMinor,
    method,
  });
  return { payment, order, created: true };
}
export async function payOrder(
  db: PrismaClient,
  auth: AuthContext,
  input: unknown,
  provider: PaymentProvider = freedomPay,
) {
  const tenantId = billingTenant(auth);
  const v = z
    .object({
      orderId: z.string(),
      method: z.enum(["CARD", "KASPI", "BANK_TRANSFER"]),
      autoRenew: z.boolean().default(false),
      buyer: z.unknown().optional(),
    })
    .parse(input);
  if (v.method === "CARD" && !provider.configured)
    billingError(
      "provider_not_configured",
      "Оплата картой пока недоступна",
      503,
    );
  if (v.method === "KASPI") kaspiPayments.createPayment();
  if (v.autoRenew && v.method === "CARD" && !billingConfig().recurring)
    billingError("recurring_unavailable", "Автопродление пока недоступно");
  const attempt = await db.$transaction(
    async (tx) => {
      await lockTenant(tx, tenantId);
      const result = await createAttempt(
        tx,
        v.orderId,
        tenantId,
        v.method,
        v.autoRenew && v.method === "CARD",
        auth.user.id,
      );
      if (v.method === "BANK_TRANSFER")
        await issueInvoice(tx, result.order, result.payment.id, v.buyer);
      return result;
    },
    { timeout: 30_000 },
  );
  if (attempt.created && v.method === "CARD") {
    try {
      const result = await provider.createPayment({
        paymentId: attempt.payment.id,
        orderId: v.orderId,
        tenantId,
        amount: attempt.order.amountMinor,
        currency: attempt.order.currency,
        description: attempt.order.description,
        autoRenew: v.autoRenew,
        returnUrl: `${billingConfig().appUrl}/billing/checkout/${v.orderId}?return=1`,
      });
      // The callback may arrive before this response. Never overwrite its final state.
      await db.billingPayment.updateMany({
        where: { id: attempt.payment.id, status: "PROCESSING" },
        data: {
          providerPaymentId: result.providerPaymentId,
          checkoutUrl: result.redirectUrl,
        },
      });
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "provider_uncertain";
      if (code === "provider_declined")
        await failPayment(db, attempt.payment.id, "provider_declined");
      else
        await db.billingPayment.updateMany({
          where: { id: attempt.payment.id, status: "PROCESSING" },
          data: { failureReason: "provider_uncertain" },
        });
      // Uncertain network outcomes remain locked: another attempt could charge twice.
      throw error;
    }
  }
  return checkoutDetail(db, auth, v.orderId);
}
export async function queueBillingEmail(
  db: DB,
  tenantId: string,
  entityId: string,
  subject: string,
  text: string,
) {
  const profile = await db.tenantLegalProfile.findUnique({
    where: { tenantId },
  });
  const owner = profile?.email
    ? null
    : await db.membership.findFirst({
        where: { tenantId, active: true, role: { in: ["owner", "director"] } },
        include: { user: { select: { email: true } } },
        orderBy: { createdAt: "asc" },
      });
  const recipient = profile?.email || owner?.user.email;
  if (recipient)
    await db.outboxEvent.create({
      data: {
        tenantId,
        type: "billing.email",
        entityType: "billing",
        entityId,
        payloadJson: { to: recipient, subject, text },
      },
    });
}
async function activateOrder(
  db: DB,
  order: NonNullable<
    Awaited<ReturnType<PrismaClient["billingOrder"]["findUnique"]>>
  >,
  paymentId: string,
  method: string,
  userId?: string,
) {
  const snapshot = order.snapshotJson as unknown as PricingQuote["snapshot"];
  await activateSubscription(db as PrismaClient, {
    tenantId: order.tenantId,
    planCode: order.planCode,
    billingPeriod: order.billingPeriod,
    approvedSnapshot: snapshot,
    amountMinor: order.amountMinor,
    paymentId,
    paymentMethod: method,
    allowExistingUsage: true,
    source: "billing_payment",
    actorUserId: userId,
    extendFromCurrentEnd: order.kind === "RENEWAL",
  });
}
export async function settlePayment(
  db: DB,
  paymentId: string,
  evidence: {
    amount: number;
    currency: string;
    paidAt: Date;
    reference: string;
    userId?: string;
    recurringProfile?: string;
    providerPaymentId?: string;
  },
) {
  const payment = await db.billingPayment.findUnique({
    where: { id: paymentId },
  });
  if (!payment?.orderId) billingError("not_found", "Платёж не найден", 404);
  await lockTenant(db, payment.tenantId);
  const fresh = await db.billingPayment.findUniqueOrThrow({
    where: { id: payment.id },
  });
  const order = await db.billingOrder.findFirstOrThrow({
    where: { id: payment.orderId, tenantId: payment.tenantId },
  });
  if (
    payment.amountMinor !== evidence.amount ||
    order.amountMinor !== evidence.amount ||
    payment.currency !== evidence.currency ||
    order.currency !== evidence.currency
  )
    billingError(
      "payment_mismatch",
      "Сумма или валюта платежа не совпадает",
      409,
    );
  if (fresh.status === "PAID") return fresh;
  if (
    !openPayments.includes(fresh.status) ||
    order.status !== "PENDING_PAYMENT"
  )
    billingError("payment_closed", "Платёж уже закрыт. Требуется сверка.", 409);
  const deferred = Boolean(order.effectiveAt && order.effectiveAt > new Date());
  if (!deferred)
    await activateOrder(db, order, payment.id, payment.method, evidence.userId);
  else
    await db.tenantPlan.update({
      where: { id: order.subscriptionId! },
      data: { nextPlanJson: { orderId: order.id }, autoRenew: false },
    });
  const subscription = await db.tenantPlan.findFirst({
    where: { tenantId: order.tenantId },
    orderBy: { startsAt: "desc" },
  });
  const updated = await db.billingPayment.update({
    where: { id: payment.id },
    data: {
      status: "PAID",
      paidAt: evidence.paidAt,
      confirmedAt: new Date(),
      confirmedByAdminId: evidence.userId || null,
      externalReference: evidence.reference,
      providerPaymentId: evidence.providerPaymentId || fresh.providerPaymentId,
      providerTransactionId: evidence.providerPaymentId || null,
      subscriptionId: subscription?.id,
      failureReason: null,
    },
  });
  await db.billingOrder.update({
    where: { id: order.id },
    data: {
      status: "PAID",
      paidAt: evidence.paidAt,
      subscriptionId: subscription?.id,
    },
  });
  // Store consent only after a successful card payment; never expose the encrypted profile in API responses.
  const consentAllowed = Boolean(
    payment.autoRenewRequested &&
    evidence.recurringProfile &&
    (!subscription?.cancelledAt ||
      subscription.cancelledAt < payment.createdAt),
  );
  if (subscription && !deferred && !payment.recurring)
    await db.tenantPlan.update({
      where: { id: subscription.id },
      data: {
        autoRenew: consentAllowed,
        recurringProfileEncrypted: consentAllowed
          ? encryptSecret(evidence.recurringProfile!)
          : null,
        renewalConsentAt: consentAllowed ? payment.createdAt : null,
        providerCustomerId: consentAllowed ? payment.tenantId : null,
      },
    });
  // A PDF needs verified legal details. Card customers can supply these later without blocking activation.
  if (!(await db.billingInvoice.findUnique({ where: { orderId: order.id } }))) {
    const buyer = await db.tenantLegalProfile.findUnique({
      where: { tenantId: order.tenantId },
    });
    const { buyerSchema } = await import("./documents.ts");
    if (
      (await sellerProfile(db)) &&
      buyerSchema.safeParse({ ...buyer, bin: buyer?.bin || buyer?.iin }).success
    )
      await issueInvoice(db, order, payment.id);
  }
  await db.billingInvoice.updateMany({
    where: { orderId: order.id },
    data: { status: "PAID", paidAt: evidence.paidAt },
  });
  await billingAudit(
    db,
    order.tenantId,
    "PAYMENT_PAID",
    payment.id,
    evidence.userId,
    {
      orderNumber: order.orderNumber,
      amount: evidence.amount,
      reference: evidence.reference,
    },
  );
  await billingAudit(
    db,
    order.tenantId,
    order.kind === "RENEWAL"
      ? "SUBSCRIPTION_RENEWED"
      : "SUBSCRIPTION_ACTIVATED",
    subscription?.id || order.id,
    evidence.userId,
    { deferred },
  );
  await queueBillingEmail(
    db,
    order.tenantId,
    payment.id,
    "Оплата подписки BasQar подтверждена",
    `${order.description}. Оплата ${order.amountMinor} ₸ подтверждена. ${deferred ? "Тариф изменится после завершения текущего периода." : `Следующая дата оплаты: ${subscription?.endsAt?.toISOString().slice(0, 10) || "—"}.`} Документы: ${billingConfig().appUrl}/billing/checkout/${order.id}`,
  );
  return updated;
}
export async function failPaymentInTransaction(
  tx: DB,
  paymentId: string,
  reason: string,
) {
  const p = await tx.billingPayment.findUniqueOrThrow({
    where: { id: paymentId },
  });
  await lockTenant(tx, p.tenantId);
  const changed = await tx.billingPayment.updateMany({
    where: { id: paymentId, status: { in: openPayments } },
    data: { status: "FAILED", failedAt: new Date(), failureReason: reason },
  });
  if (!changed.count) return;
  await billingAudit(tx, p.tenantId, "PAYMENT_FAILED", p.id, undefined, {
    reason,
  });
  if (p.recurring && p.subscriptionId) {
    const sub = await tx.tenantPlan.findUniqueOrThrow({
      where: { id: p.subscriptionId },
    });
    const order = p.orderId
      ? await tx.billingOrder.findUnique({ where: { id: p.orderId } })
      : null;
    // A late failure for an earlier billing period must not suspend a renewed subscription.
    if (
      !sub.endsAt ||
      order?.renewalKey !== `${sub.id}:${sub.endsAt.toISOString()}`
    )
      return;
    const grace = new Date(
      sub.endsAt.getTime() + billingConfig().graceDays * 86400_000,
    );
    await tx.tenantPlan.update({
      where: { id: sub.id },
      data: { status: "past_due", gracePeriodEndsAt: grace },
    });
    await billingAudit(tx, p.tenantId, "SUBSCRIPTION_PAST_DUE", sub.id);
    await queueBillingEmail(
      tx,
      p.tenantId,
      p.id,
      "Не удалось продлить подписку BasQar",
      `Оплатите подписку до ${grace.toISOString().slice(0, 10)}: ${billingConfig().appUrl}/billing`,
    );
  }
}
export async function failPayment(
  db: PrismaClient,
  paymentId: string,
  reason: string,
) {
  return db.$transaction((tx) =>
    failPaymentInTransaction(tx, paymentId, reason),
  );
}
export async function processPaymentNotice(db: PrismaClient, n: PaymentNotice) {
  await ensurePricingCatalog(db);
  return db.$transaction(
    async (tx) => {
      await lockTenant(tx, n.tenantId);
      const p = await tx.billingPayment.findFirst({
        where: {
          id: n.paymentId,
          tenantId: n.tenantId,
          orderId: n.orderId,
          provider: "FREEDOM_PAY",
          amountMinor: n.amount,
          currency: n.currency,
        },
      });
      if (
        !p ||
        (p.providerPaymentId && p.providerPaymentId !== n.providerPaymentId)
      )
        billingError(
          "webhook_mismatch",
          "Платёж не соответствует уведомлению",
          400,
        );
      const old = await tx.paymentWebhookEvent.findUnique({
        where: {
          provider_eventId: { provider: "FREEDOM_PAY", eventId: n.eventId },
        },
      });
      if (old?.status === "processed") return;
      if (!n.paid)
        await failPaymentInTransaction(tx, p.id, "provider_declined");
      if (n.paid)
        await settlePayment(tx, p.id, {
          amount: n.amount,
          currency: n.currency,
          paidAt: new Date(),
          reference: n.providerPaymentId,
          providerPaymentId: n.providerPaymentId,
          recurringProfile: n.recurringProfile,
        });
      await tx.paymentWebhookEvent.upsert({
        where: {
          provider_eventId: { provider: "FREEDOM_PAY", eventId: n.eventId },
        },
        create: {
          provider: "FREEDOM_PAY",
          eventId: n.eventId,
          eventType: n.paid ? "paid" : "failed",
          paymentId: p.id,
          status: "processed",
          processedAt: new Date(),
          payloadJson: {
            amount: n.amount,
            currency: n.currency,
            orderId: n.orderId,
          },
        },
        update: {
          status: "processed",
          processedAt: new Date(),
          errorCode: null,
        },
      });
    },
    { timeout: 30_000 },
  );
}
export async function manualConfirm(
  db: PrismaClient,
  auth: AuthContext,
  id: string,
  input: unknown,
) {
  requirePlatformAdmin(auth);
  const v = z
    .object({
      amount: z.number().int().positive(),
      paidAt: z.iso.datetime(),
      reference: z.string().trim().min(3).max(200),
      comment: z.string().trim().max(1000).default(""),
    })
    .parse(input);
  if (new Date(v.paidAt) > new Date(Date.now() + 60_000))
    billingError("payment_date", "Дата оплаты не может быть в будущем");
  await ensurePricingCatalog(db);
  return db.$transaction(
    async (tx) => {
      const p = await tx.billingPayment.findUnique({ where: { id } });
      if (!p || !["BANK_TRANSFER", "KASPI"].includes(p.provider))
        billingError(
          "manual_not_allowed",
          "Этот платёж нельзя подтвердить вручную",
          403,
        );
      await lockTenant(tx, p.tenantId);
      const wasPaid =
        (await tx.billingPayment.findUniqueOrThrow({ where: { id } }))
          .status === "PAID";
      const result = await settlePayment(tx, id, {
        amount: v.amount,
        currency: "KZT",
        paidAt: new Date(v.paidAt),
        reference: v.reference,
        userId: auth.user.id,
      });
      if (!wasPaid)
        await billingAudit(
          tx,
          p.tenantId,
          "BANK_PAYMENT_CONFIRMED",
          id,
          auth.user.id,
          { ...v },
        );
      return { id: result.id, status: result.status };
    },
    { timeout: 30_000 },
  );
}
export async function cancelOrder(
  db: PrismaClient,
  auth: AuthContext,
  id: string,
) {
  const tenantId = billingTenant(auth);
  return db.$transaction(async (tx) => {
    await lockTenant(tx, tenantId);
    const order = await tx.billingOrder.findFirst({ where: { id, tenantId } });
    if (!order) billingError("not_found", "Заказ не найден", 404);
    if (order.status !== "PENDING_PAYMENT")
      billingError("order_closed", "Заказ уже закрыт", 409);
    if (
      await tx.billingPayment.count({
        where: { orderId: id, provider: "FREEDOM_PAY", status: "PROCESSING" },
      })
    )
      billingError(
        "payment_processing",
        "Дождитесь результата оплаты картой",
        409,
      );
    await tx.billingPayment.updateMany({
      where: { orderId: id, status: "PENDING" },
      data: { status: "CANCELLED" },
    });
    await tx.billingInvoice.updateMany({
      where: { orderId: id, status: "ISSUED" },
      data: { status: "CANCELLED" },
    });
    await billingAudit(tx, tenantId, "ORDER_CANCELLED", id, auth.user.id);
    return tx.billingOrder.update({
      where: { id },
      data: { status: "CANCELLED" },
    });
  });
}
export async function cancelAutoRenew(db: PrismaClient, auth: AuthContext) {
  const tenantId = billingTenant(auth);
  return db.$transaction(async (tx) => {
    await lockTenant(tx, tenantId);
    const current = await loadCurrentTenantPlan(tx as PrismaClient, tenantId);
    if (!current) billingError("not_found", "Подписка не найдена", 404);
    await tx.tenantPlan.update({
      where: { id: current.id },
      data: {
        autoRenew: false,
        cancelledAt: new Date(),
        recurringProfileEncrypted: null,
      },
    });
    await billingAudit(
      tx,
      tenantId,
      "SUBSCRIPTION_CANCELLED",
      current.id,
      auth.user.id,
      { atPeriodEnd: true },
    );
    return { autoRenew: false };
  });
}
export async function billingHistory(db: PrismaClient, auth: AuthContext) {
  const tenantId = billingTenant(auth);
  const [subscription, orders, payments, invoices] = await Promise.all([
    db.tenantPlan.findFirst({
      where: { tenantId },
      orderBy: { startsAt: "desc" },
      select: {
        id: true,
        planId: true,
        status: true,
        startsAt: true,
        currentPeriodStart: true,
        endsAt: true,
        gracePeriodEndsAt: true,
        autoRenew: true,
        paymentMethod: true,
        amountMinor: true,
        currency: true,
        billingPeriod: true,
        nextPlanJson: true,
      },
    }),
    db.billingOrder.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    db.billingPayment.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        orderId: true,
        method: true,
        status: true,
        amountMinor: true,
        currency: true,
        createdAt: true,
        paidAt: true,
      },
    }),
    db.billingInvoice.findMany({
      where: { tenantId },
      orderBy: { issueDate: "desc" },
      take: 100,
      select: {
        id: true,
        orderId: true,
        invoiceNumber: true,
        amountMinor: true,
        currency: true,
        status: true,
        issueDate: true,
        dueDate: true,
      },
    }),
  ]);
  return { subscription, orders, payments, invoices };
}
export { activateOrder };
