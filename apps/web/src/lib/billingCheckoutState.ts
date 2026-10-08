type CheckoutData = {
  order: { status: string; expiresAt: string };
  payments: { status: string }[];
};

/** Expiry prevents new attempts, but must not hide an unresolved bank payment. */
export function billingCheckoutState(data: CheckoutData | null, returning = false, now = Date.now()) {
  const pending = data?.order.status === "PENDING_PAYMENT";
  const active = data?.payments.some(p => ["PENDING", "PROCESSING"].includes(p.status));
  const processing = data?.payments.some(p => p.status === "PROCESSING");
  const canStartPayment = Boolean(pending && Date.parse(data!.order.expiresAt) > now);
  return {
    canStartPayment,
    showPaymentFlow: canStartPayment || Boolean(pending && processing),
    shouldRefresh: Boolean(pending && (returning || active)),
  };
}
