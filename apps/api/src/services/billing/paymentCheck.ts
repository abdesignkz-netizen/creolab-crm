import type { PrismaClient } from "@creolab/db";
import { z } from "zod";
import type { AuthContext } from "../../lib/types.ts";
import { requirePlatformAdmin } from "../../lib/access.ts";
import {
  billingTenant,
  billingAudit,
  lockTenant,
  failPaymentInTransaction,
} from "./ledger.ts";
import { freedomPay } from "./freedomPayProvider.ts";
import { amountKzt, billingError } from "./config.ts";

/** Verified terminal failures release checkout; activation still requires the signed callback. */
export async function checkProviderPayment(
  db: PrismaClient,
  id: string,
  userId: string,
) {
  const p = await db.billingPayment.findUniqueOrThrow({ where: { id } });
  if (p.provider !== "FREEDOM_PAY")
    billingError("provider_unsupported", "Проверка доступна для Freedom Pay");
  let result: Record<string, string>;
  try {
    result = await freedomPay.getPaymentStatus(p.providerPaymentId || "", p.id);
  } catch (error) {
    if (!(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "provider_not_found"
    ))
      throw error;
    // Not found in the CURRENT merchant is never proof that an old merchant did not charge.
    await billingAudit(db, p.tenantId, "PAYMENT_STATUS_CHECKED", p.id, userId, {
      providerStatus: "not_found",
    });
    return {
      status: "not_found",
      localStatus: (
        await db.billingPayment.findUniqueOrThrow({ where: { id } })
      ).status,
      requiresCallback: false,
      checkedAt: new Date(),
    };
  }
  if (
    !result.pg_payment_id ||
    (p.providerPaymentId && result.pg_payment_id !== p.providerPaymentId) ||
    result.pg_order_id !== p.id ||
    amountKzt(result.pg_amount) !== p.amountMinor ||
    result.pg_currency !== p.currency
  )
    billingError(
      "provider_mismatch",
      "Ответ банка не соответствует платежу",
      409,
    );
  const status = [
    "success",
    "failed",
    "pending",
    "incomplete",
    "refunded",
    "revoked",
  ].includes(String(result.pg_payment_status))
    ? String(result.pg_payment_status)
    : "unknown";
  await billingAudit(db, p.tenantId, "PAYMENT_STATUS_CHECKED", p.id, userId, {
    providerStatus: status,
  });
  // getPaymentStatus verifies the provider signature before returning fields.
  // A failed or expired attempt cannot keep an unpaid order locked forever
  // just because its failure callback was lost. Never treat pending, success,
  // refunds or a not-found response in a different merchant as a failure.
  if (status === "failed" || status === "incomplete") {
    await db.$transaction(async (tx) => {
      await lockTenant(tx, p.tenantId);
      const current = await tx.billingPayment.findUniqueOrThrow({
        where: { id },
      });
      if (
        current.providerPaymentId &&
        current.providerPaymentId !== result.pg_payment_id
      )
        billingError(
          "provider_mismatch",
          "Ответ банка не соответствует платежу",
          409,
        );
      await failPaymentInTransaction(tx, id, `provider_status_${status}`);
    });
  }
  const current = await db.billingPayment.findUniqueOrThrow({ where: { id } });
  return {
    status,
    localStatus: current.status,
    requiresCallback: status === "success" && current.status !== "PAID",
    checkedAt: new Date(),
  };
}

export async function checkOrderPayment(
  db: PrismaClient,
  auth: AuthContext,
  orderId: string,
) {
  const tenantId = billingTenant(auth);
  const order = await db.billingOrder.findFirst({
    where: { id: orderId, tenantId },
  });
  if (!order) billingError("not_found", "Заказ не найден", 404);
  if (order.status === "PAID") return { status: "paid" };
  const payment = await db.billingPayment.findFirst({
    where: { orderId, tenantId, status: { in: ["PROCESSING", "PENDING"] } },
    orderBy: { createdAt: "desc" },
  });
  if (!payment) return { status: "no_attempt" };
  if (payment.provider !== "FREEDOM_PAY") return { status: "manual_pending" };
  const result = await checkProviderPayment(db, payment.id, auth.user.id);
  return {
    ...result,
    status: result.localStatus === "PAID" ? "paid" : result.status,
  };
}

/** Only an administrator who reconciled ALL merchant accounts can release a legacy orphan. */
export async function releaseUncreatedPayment(
  db: PrismaClient,
  auth: AuthContext,
  id: string,
  input: unknown,
) {
  requirePlatformAdmin(auth);
  const v = z
    .object({
      noChargeConfirmed: z.literal(true),
      reason: z.string().trim().min(10).max(1000),
    })
    .parse(input);
  const eligible = (p: {
    provider: string;
    method: string;
    status: string;
    providerPaymentId: string | null;
    checkoutUrl: string | null;
    recurring: boolean;
    createdAt: Date;
  }) =>
    p.provider === "FREEDOM_PAY" &&
    p.method === "CARD" &&
    p.status === "PROCESSING" &&
    !p.providerPaymentId &&
    !p.checkoutUrl &&
    !p.recurring &&
    Date.now() - p.createdAt.getTime() >= 300_000;
  const before = await db.billingPayment.findUniqueOrThrow({ where: { id } });
  if (!eligible(before))
    billingError(
      "payment_not_recoverable",
      "Эту попытку нельзя разблокировать: проверьте статус в банке",
      409,
    );
  if ((await checkProviderPayment(db, id, auth.user.id)).status !== "not_found")
    billingError(
      "payment_not_recoverable",
      "Банк нашёл платёж. Дождитесь его окончательного статуса",
      409,
    );
  return db.$transaction(async (tx) => {
    await lockTenant(tx, before.tenantId);
    const current = await tx.billingPayment.findUniqueOrThrow({
      where: { id },
    });
    if (!eligible(current))
      billingError(
        "payment_not_recoverable",
        "Статус платежа изменился. Обновите страницу",
        409,
      );
    await failPaymentInTransaction(tx, id, "admin_verified_not_created");
    await billingAudit(
      tx,
      current.tenantId,
      "PAYMENT_UNCREATED_RELEASED",
      id,
      auth.user.id,
      { reason: v.reason, noChargeConfirmed: true },
    );
    return { released: true };
  });
}
