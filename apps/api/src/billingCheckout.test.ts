import assert from "node:assert/strict";
import { before, after, it } from "node:test";
import { randomUUID } from "node:crypto";
import { createPrismaClient } from "@creolab/db";
import { applyBillingMigration } from "../../../packages/db/src/billingMigration.ts";
import type { AuthContext } from "./lib/types.ts";
import { activateSubscription } from "./services/subscriptionActivationService.ts";
import {
  createCheckout,
  payOrder,
  manualConfirm,
  processPaymentNotice,
  billingHistory,
  checkoutDetail,
  cancelAutoRenew,
  cancelOrder,
} from "./services/billing/ledger.ts";
import {
  saveSeller,
  issueInvoice,
  sellerProfile,
  renderBillingInvoice,
} from "./services/billing/documents.ts";
import { processBillingRenewals } from "./services/billing/renewals.ts";
import {
  freedomPay,
  freedomSignature,
  parseFreedomXml,
  verifyFreedomSignature,
} from "./services/billing/freedomPayProvider.ts";
import { getEntitlements } from "./services/entitlementService.ts";
import type {
  PaymentProvider,
  PaymentInput,
  PaymentNotice,
} from "./services/paymentProvider.ts";
import { ApiError } from "./errors.ts";
let db: Awaited<ReturnType<typeof createPrismaClient>>, admin: AuthContext;
const seller = {
  legalName: "Тестовый поставщик",
  bin: "123456789012",
  legalAddress: "Тестовый адрес",
  iban: "KZ123456789012345678",
  bankName: "Тестовый банк",
  bik: "TESTKZKX",
  kbe: "17",
  vatEnabled: false,
  vatRate: 0,
  supportEmail: "billing@example.test",
  supportPhone: "+77000000000",
  invoicePrefix: "BSQ-INV",
};
const buyer = {
  legalName: "Тестовый покупатель",
  bin: "987654321012",
  legalAddress: "Алматы, тестовый адрес",
  email: "buyer@example.test",
  phone: "+77000000001",
};
let createCalls = 0,
  recurringCalls = 0,
  recurringFails = false;
const fake: PaymentProvider = {
  name: "FREEDOM_PAY",
  configured: true,
  async createPayment(i) {
    createCalls++;
    return {
      providerPaymentId: "fp-" + i.paymentId,
      redirectUrl: "https://api.freedompay.kz/pay/test",
    };
  },
  async createRecurringPayment(i) {
    recurringCalls++;
    if (recurringFails)
      throw new ApiError(422, "provider_declined", "declined");
    return { providerPaymentId: "fp-" + i.paymentId };
  },
  async getPaymentStatus() {
    return {};
  },
  async cancelPayment() {
    return {};
  },
  async refundPayment() {
    return {};
  },
  handleWebhook: (fields) => freedomPay.handleWebhook(fields),
};
async function tenant() {
  const id = randomUUID();
  const tenant = await db.tenant.create({
    data: { name: "Billing test", slug: id },
  });
  const user = await db.user.create({
    data: {
      email: `${id}@example.test`,
      name: "Owner",
      passwordHash: "unused",
    },
  });
  const m = await db.membership.create({
    data: { tenantId: tenant.id, userId: user.id, role: "owner", active: true },
  });
  const auth = {
    user,
    memberships: [],
    activeMembership: { ...m, permissions: [], tenant },
    sessionId: "test",
    client: "web",
  } as unknown as AuthContext;
  await activateSubscription(db, {
    tenantId: tenant.id,
    planCode: "BASQAR_FREE",
    actorUserId: user.id,
  });
  return auth;
}
async function order(auth: AuthContext) {
  return createCheckout(db, auth, {
    planCode: "CONTROL",
    billingPeriod: "MONTHLY",
  });
}
function notice(p: any, overrides: Partial<PaymentNotice> = {}): PaymentNotice {
  return {
    eventId: "event-" + p.id,
    paymentId: p.id,
    tenantId: p.tenantId,
    orderId: p.orderId,
    providerPaymentId: "fp-" + p.id,
    amount: p.amountMinor,
    currency: "KZT",
    paid: true,
    ...overrides,
  };
}
before(async () => {
  process.env.BILLING_KASPI_MANUAL_ENABLED = "1";
  process.env.FREEDOM_PAY_RECURRING_ENABLED = "1";
  db = await createPrismaClient();
  admin = await tenant();
  admin.user.platformAdmin = true;
  await saveSeller(db, admin, seller);
});
after(async () => {
  await db.$disconnect();
});
it("versioned migration is repeatable and preserves existing subscription and legacy payment", async () => {
  const a = await tenant(),
    tid = a.activeMembership!.tenantId;
  const p = await db.billingPayment.create({
    data: {
      tenantId: tid,
      amountMinor: 123,
      method: "MANUAL",
      status: "CONFIRMED",
    },
  });
  await applyBillingMigration(db);
  assert.equal(
    (await db.billingPayment.findUniqueOrThrow({ where: { id: p.id } }))
      .amountMinor,
    123,
  );
  assert.equal(
    (await getEntitlements(db, tid)).snapshot.planCode,
    "BASQAR_FREE",
  );
});
it("subscription seller defaults to KNP 851 while keeping an explicitly configured code", async () => {
  await saveSeller(db, admin, { ...seller, knp: "" });
  assert.equal((await sellerProfile(db))!.knp, "851");
  await db.platformSetting.update({ where: { key: "billing.seller" }, data: { valueJson: seller } });
  assert.equal((await sellerProfile(db))!.knp, "851");
  await saveSeller(db, admin, { ...seller, knp: "859" });
  assert.equal((await sellerProfile(db))!.knp, "859");
  await saveSeller(db, admin, seller);
});
it("invoice keeps the issued seller, signer and order snapshots after settings change", async () => {
  const a = await tenant(), o = await order(a);
  await saveSeller(db, admin, { ...seller, signerName: "Подписант А.Б.", signerPosition: "Исполнитель", knp: "859" });
  try {
    const checkout = await payOrder(db, a, { orderId: o.id, method: "BANK_TRANSFER", buyer });
    const original = await db.billingInvoice.findUniqueOrThrow({ where: { id: checkout.invoice!.id } });
    assert.deepEqual((original.sellerJson as any).orderBasis, { number: o.orderNumber, date: o.createdAt.toISOString() });
    await saveSeller(db, admin, { ...seller, legalName: "Новый поставщик", signerName: "Другой подписант" });
    const repeat = await issueInvoice(db, o, "another-payment", { ...buyer, legalName: "Другой покупатель" });
    assert.equal(repeat.id, original.id);
    assert.deepEqual(repeat.sellerJson, original.sellerJson);
    assert.deepEqual(repeat.buyerJson, original.buyerJson);
    assert.equal((repeat.sellerJson as any).signerName, "Подписант А.Б.");
  } finally { await saveSeller(db, admin, seller); }
});
it("bank invoice prefill, PDF, atomic manual confirmation and duplicate confirmation", async () => {
  const a = await tenant(),
    o = await order(a);
  const d = await payOrder(db, a, {
    orderId: o.id,
    method: "BANK_TRANSFER",
    buyer,
  });
  assert.match(d.invoice!.invoiceNumber, /^BSQ-INV-\d{4}-\d{6}$/);
  assert.equal((d.invoice!.sellerJson as any).knp, "851");
  const pdf = await renderBillingInvoice(d.invoice!);
  assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
  assert(pdf.length > 1000);
  const p = d.payments[0];
  const input = {
    amount: o.amountMinor,
    paidAt: new Date().toISOString(),
    reference: "bank-123",
  };
  await manualConfirm(db, admin, p.id, input);
  const before = await db.tenantPlan.findUniqueOrThrow({
    where: { id: o.subscriptionId! },
  });
  await manualConfirm(db, admin, p.id, input);
  const after = await db.tenantPlan.findUniqueOrThrow({
    where: { id: o.subscriptionId! },
  });
  assert.equal(after.endsAt!.getTime(), before.endsAt!.getTime());
  assert.equal(after.status, "active");
  assert.equal(
    (await db.billingOrder.findUniqueOrThrow({ where: { id: o.id } })).status,
    "PAID",
  );
  assert.equal(
    (await db.billingInvoice.findUniqueOrThrow({ where: { orderId: o.id } }))
      .status,
    "PAID",
  );
  assert.equal(await db.billingPayment.count({ where: { orderId: o.id } }), 1);
});
it("wrong amount rolls back all subscription/payment/invoice changes", async () => {
  const a = await tenant(),
    o = await order(a);
  const d = await payOrder(db, a, {
    orderId: o.id,
    method: "BANK_TRANSFER",
    buyer,
  });
  await assert.rejects(() =>
    manualConfirm(db, admin, d.payments[0].id, {
      amount: o.amountMinor + 1,
      paidAt: new Date().toISOString(),
      reference: "bank-wrong",
    }),
  );
  assert.equal(
    (await checkoutDetail(db, a, o.id)).order.status,
    "PENDING_PAYMENT",
  );
  assert.equal(
    (await getEntitlements(db, a.activeMembership!.tenantId)).snapshot.planCode,
    "BASQAR_FREE",
  );
});
it("successful card webhook is idempotent and never trusts return URL", async () => {
  const a = await tenant(),
    o = await order(a);
  const count = createCalls;
  const d = await payOrder(
    db,
    a,
    { orderId: o.id, method: "CARD", autoRenew: true },
    fake,
  );
  await payOrder(db, a, { orderId: o.id, method: "CARD" }, fake);
  assert.equal(createCalls, count + 1);
  assert.equal(d.order.status, "PENDING_PAYMENT");
  const p = await db.billingPayment.findUniqueOrThrow({
    where: { id: d.payments[0].id },
  });
  await processPaymentNotice(
    db,
    notice(p, { recurringProfile: "profile-secret" }),
  );
  const initial = await db.tenantPlan.findUniqueOrThrow({
    where: { id: o.subscriptionId! },
  });
  await processPaymentNotice(db, notice(p, { eventId: "different-retry-id" }));
  const sub = await db.tenantPlan.findUniqueOrThrow({
    where: { id: o.subscriptionId! },
  });
  assert.equal(sub.endsAt!.getTime(), initial.endsAt!.getTime());
  assert.equal(sub.autoRenew, true);
  assert.notEqual(sub.recurringProfileEncrypted, "profile-secret");
  const history = JSON.stringify(await billingHistory(db, a));
  assert(!history.includes("profile-secret"));
  assert(!history.includes("recurringProfileEncrypted"));
  assert.equal(
    await db.auditEvent.count({
      where: { entityId: p.id, action: "PAYMENT_PAID" },
    }),
    1,
  );
});
it("invalid signature, merchant, amount and tenant notifications are rejected", async () => {
  process.env.BILLING_PROVIDER = "freedompay";
  process.env.FREEDOM_PAY_MERCHANT_ID = "test-merchant";
  process.env.FREEDOM_PAY_SECRET_KEY = "test-secret";
  const a = await tenant(),
    o = await order(a),
    d = await payOrder(db, a, { orderId: o.id, method: "CARD" }, fake);
  const p = await db.billingPayment.findUniqueOrThrow({
    where: { id: d.payments[0].id },
  });
  assert.throws(() => freedomPay.handleWebhook({ pg_sig: "bad" }));
  const fields = {
    pg_order_id: p.id,
    pg_payment_id: "fp-" + p.id,
    pg_amount: String(p.amountMinor),
    pg_currency: "KZT",
    pg_result: "1",
    pg_testing_mode: "1",
    basqar_tenant: p.tenantId,
    basqar_order: o.id,
    basqar_merchant: "test-merchant",
    pg_salt: "test",
  };
  const sig = freedomSignature("webhook", fields, "test-secret");
  assert(
    verifyFreedomSignature(
      "webhook",
      { ...fields, pg_sig: sig },
      "test-secret",
    ),
  );
  assert.equal(
    freedomPay.handleWebhook({ ...fields, pg_sig: sig }).amount,
    p.amountMinor,
  );
  await assert.rejects(() =>
    processPaymentNotice(db, notice(p, { amount: p.amountMinor + 1 })),
  );
  await assert.rejects(() =>
    processPaymentNotice(
      db,
      notice(p, { tenantId: admin.activeMembership!.tenantId }),
    ),
  );
  assert.equal(
    (await checkoutDetail(db, a, o.id)).order.status,
    "PENDING_PAYMENT",
  );
});
it("tenant isolation and owner/admin permissions", async () => {
  const a = await tenant(),
    b = await tenant(),
    o = await order(a);
  await assert.rejects(() => checkoutDetail(db, b, o.id));
  await assert.rejects(() =>
    payOrder(db, b, { orderId: o.id, method: "KASPI" }),
  );
  const manager = {
    ...a,
    activeMembership: { ...a.activeMembership!, role: "manager" },
  } as AuthContext;
  await assert.rejects(() => billingHistory(db, manager));
  await assert.rejects(() =>
    createCheckout(db, manager, { planCode: "CONTROL" }),
  );
  const d = await payOrder(db, a, { orderId: o.id, method: "KASPI" });
  await assert.rejects(() =>
    manualConfirm(db, a, d.payments[0].id, {
      amount: o.amountMinor,
      paidAt: new Date().toISOString(),
      reference: "unauthorized",
    }),
  );
});
it("Kaspi uses the same order and settlement path", async () => {
  const a = await tenant(),
    o = await order(a),
    d = await payOrder(db, a, { orderId: o.id, method: "KASPI" });
  assert.equal(d.payments[0].status, "PENDING");
  await manualConfirm(db, admin, d.payments[0].id, {
    amount: o.amountMinor,
    paidAt: new Date().toISOString(),
    reference: "kaspi-123",
  });
  assert.equal((await checkoutDetail(db, a, o.id)).order.status, "PAID");
});
it("failed card remains unpaid and can be retried; card cannot be manually confirmed", async () => {
  const a = await tenant(),
    o = await order(a),
    d = await payOrder(db, a, { orderId: o.id, method: "CARD" }, fake),
    p = await db.billingPayment.findUniqueOrThrow({
      where: { id: d.payments[0].id },
    });
  await assert.rejects(() =>
    manualConfirm(db, admin, p.id, {
      amount: o.amountMinor,
      paidAt: new Date().toISOString(),
      reference: "manual-forgery",
    }),
  );
  await processPaymentNotice(db, notice(p, { paid: false }));
  assert.equal(
    (await db.billingPayment.findUniqueOrThrow({ where: { id: p.id } })).status,
    "FAILED",
  );
  assert.equal(
    (await checkoutDetail(db, a, o.id)).order.status,
    "PENDING_PAYMENT",
  );
  const retry = await payOrder(db, a, { orderId: o.id, method: "CARD" }, fake);
  assert.equal(retry.payments.length, 2);
});
it("recurring succeeds once per period and consent can be cancelled", async () => {
  const a = await tenant(),
    o = await order(a),
    d = await payOrder(
      db,
      a,
      { orderId: o.id, method: "CARD", autoRenew: true },
      fake,
    ),
    p = await db.billingPayment.findUniqueOrThrow({
      where: { id: d.payments[0].id },
    });
  await processPaymentNotice(
    db,
    notice(p, { recurringProfile: "repeat-profile" }),
  );
  const end = new Date(Date.now() + 3600_000);
  await db.tenantPlan.update({
    where: { id: o.subscriptionId! },
    data: { endsAt: end },
  });
  const count = recurringCalls;
  await processBillingRenewals(db, new Date(), fake);
  await processBillingRenewals(db, new Date(), fake);
  assert.equal(recurringCalls, count + 1);
  const renewal = await db.billingPayment.findFirstOrThrow({
    where: { tenantId: p.tenantId, recurring: true },
  });
  await processPaymentNotice(db, notice(renewal));
  const sub = await db.tenantPlan.findUniqueOrThrow({
    where: { id: o.subscriptionId! },
  });
  assert(sub.endsAt! > end);
  assert.equal(sub.autoRenew, true);
  await cancelAutoRenew(db, a);
  assert.equal(
    (await db.tenantPlan.findUniqueOrThrow({ where: { id: sub.id } }))
      .autoRenew,
    false,
  );
});
it("failed renewal enters grace then suspends without deleting data and recovers on payment", async () => {
  const a = await tenant(),
    o = await order(a),
    d = await payOrder(
      db,
      a,
      { orderId: o.id, method: "CARD", autoRenew: true },
      fake,
    ),
    p = await db.billingPayment.findUniqueOrThrow({
      where: { id: d.payments[0].id },
    });
  await processPaymentNotice(
    db,
    notice(p, { recurringProfile: "failed-profile" }),
  );
  const end = new Date(Date.now() - 60_000);
  await db.tenantPlan.update({
    where: { id: o.subscriptionId! },
    data: { endsAt: end },
  });
  recurringFails = true;
  await processBillingRenewals(db, new Date(), fake);
  recurringFails = false;
  let sub = await db.tenantPlan.findUniqueOrThrow({
    where: { id: o.subscriptionId! },
  });
  assert.equal(sub.status, "grace_period");
  assert.equal((await getEntitlements(db, p.tenantId)).snapshot.entitled, true);
  await processBillingRenewals(db, new Date(Date.now() + 6 * 86400_000), fake);
  sub = await db.tenantPlan.findUniqueOrThrow({
    where: { id: o.subscriptionId! },
  });
  assert.equal(sub.status, "suspended");
  assert.equal(
    (await getEntitlements(db, p.tenantId)).snapshot.entitled,
    false,
  );
  assert(await db.tenant.findUnique({ where: { id: p.tenantId } }));
  const fresh = await createCheckout(db, a, {
    planCode: "CONTROL",
    renewal: true,
  });
  const manual = await payOrder(db, a, { orderId: fresh.id, method: "KASPI" });
  await manualConfirm(db, admin, manual.payments[0].id, {
    amount: fresh.amountMinor,
    paidAt: new Date().toISOString(),
    reference: "recovery",
  });
  assert.equal((await getEntitlements(db, p.tenantId)).snapshot.entitled, true);
});
it("cancelled invoice is not payable and XML parser rejects entities/duplicate fields", async () => {
  const a = await tenant(),
    o = await order(a),
    d = await payOrder(db, a, {
      orderId: o.id,
      method: "BANK_TRANSFER",
      buyer,
    });
  await cancelOrder(db, a, o.id);
  await assert.rejects(() =>
    manualConfirm(db, admin, d.payments[0].id, {
      amount: o.amountMinor,
      paidAt: new Date().toISOString(),
      reference: "cancelled",
    }),
  );
  assert.throws(() => parseFreedomXml("<!DOCTYPE response><response/>"));
  assert.throws(() =>
    parseFreedomXml(
      "<response><pg_status>ok</pg_status><pg_status>bad</pg_status></response>",
    ),
  );
});
it("concurrent checkout, attempts and callbacks produce one charge and activation", async () => {
  const a = await tenant();
  const orders = await Promise.all([order(a), order(a)]);
  assert.equal(orders[0].id, orders[1].id);
  const count = createCalls;
  const details = await Promise.all([
    payOrder(db, a, { orderId: orders[0].id, method: "CARD" }, fake),
    payOrder(db, a, { orderId: orders[0].id, method: "CARD" }, fake),
  ]);
  assert.equal(createCalls, count + 1);
  const p = await db.billingPayment.findUniqueOrThrow({
    where: { id: details[0].payments[0].id },
  });
  await Promise.all([
    processPaymentNotice(db, notice(p)),
    processPaymentNotice(db, notice(p)),
  ]);
  assert.equal(
    await db.auditEvent.count({
      where: { entityId: p.id, action: "PAYMENT_PAID" },
    }),
    1,
  );
});
it("cancelling renewal consent during initial card payment survives its delayed callback", async () => {
  const a = await tenant(),
    o = await order(a),
    d = await payOrder(
      db,
      a,
      { orderId: o.id, method: "CARD", autoRenew: true },
      fake,
    );
  await cancelAutoRenew(db, a);
  const p = await db.billingPayment.findUniqueOrThrow({
    where: { id: d.payments[0].id },
  });
  await processPaymentNotice(
    db,
    notice(p, { recurringProfile: "must-not-be-stored" }),
  );
  const s = await db.tenantPlan.findUniqueOrThrow({
    where: { id: o.subscriptionId! },
  });
  assert.equal(s.autoRenew, false);
  assert.equal(s.recurringProfileEncrypted, null);
});
it("paid downgrade retains current plan until next period then applies snapshot", async () => {
  const a = await tenant();
  await activateSubscription(db, {
    tenantId: a.activeMembership!.tenantId,
    planCode: "SALES",
    actorUserId: a.user.id,
  });
  const o = await order(a);
  assert.equal(o.kind, "DOWNGRADE");
  const d = await payOrder(db, a, { orderId: o.id, method: "KASPI" });
  await manualConfirm(db, admin, d.payments[0].id, {
    amount: o.amountMinor,
    paidAt: new Date().toISOString(),
    reference: "downgrade",
  });
  assert.equal(
    (await getEntitlements(db, o.tenantId)).snapshot.planCode,
    "SALES",
  );
  const past = new Date(Date.now() - 1000);
  await db.tenantPlan.update({
    where: { id: o.subscriptionId! },
    data: { endsAt: past },
  });
  await db.billingOrder.update({
    where: { id: o.id },
    data: { effectiveAt: past },
  });
  await processBillingRenewals(db, new Date(), fake);
  assert.equal(
    (await getEntitlements(db, o.tenantId)).snapshot.planCode,
    "CONTROL",
  );
  assert.equal(
    (
      await db.tenantPlan.findUniqueOrThrow({
        where: { id: o.subscriptionId! },
      })
    ).nextPlanJson,
    null,
  );
});
it("database failure during activation rolls payment and subscription back together", async () => {
  const a = await tenant(),
    o = await order(a),
    d = await payOrder(db, a, { orderId: o.id, method: "CARD" }, fake),
    p = await db.billingPayment.findUniqueOrThrow({
      where: { id: d.payments[0].id },
    });
  await db.$executeRawUnsafe(
    `CREATE FUNCTION billing_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test fault'; END; $$`,
  );
  await db.$executeRawUnsafe(
    `CREATE TRIGGER billing_test_failure BEFORE INSERT ON "AuditEvent" FOR EACH ROW WHEN (NEW.action = 'PAYMENT_PAID') EXECUTE FUNCTION billing_test_failure()`,
  );
  try {
    await assert.rejects(() => processPaymentNotice(db, notice(p)));
  } finally {
    await db.$executeRawUnsafe(
      'DROP TRIGGER billing_test_failure ON "AuditEvent"',
    );
    await db.$executeRawUnsafe("DROP FUNCTION billing_test_failure()");
  }
  assert.equal(
    (await checkoutDetail(db, a, o.id)).order.status,
    "PENDING_PAYMENT",
  );
  assert.equal(
    (await getEntitlements(db, o.tenantId)).snapshot.planCode,
    "BASQAR_FREE",
  );
  await processPaymentNotice(db, notice(p));
  assert.equal((await checkoutDetail(db, a, o.id)).order.status, "PAID");
});
it("rejected merchant settings release a new checkout; uncertain outcomes stay locked", async () => {
  const a = await tenant(),
    o = await order(a);
  const rejected = {
    ...fake,
    async createPayment(): Promise<never> {
      throw new ApiError(503, "provider_credentials", "Merchant rejected");
    },
  };
  await assert.rejects(
    () => payOrder(db, a, { orderId: o.id, method: "CARD" }, rejected),
    { code: "provider_credentials" },
  );
  const detail = await checkoutDetail(db, a, o.id);
  assert.equal(detail.order.status, "PENDING_PAYMENT");
  assert.equal(detail.payments[0].status, "FAILED");
  assert.equal(detail.payments[0].failureReason, "provider_credentials");
  // A bank invoice remains available after an explicit authentication rejection.
  const bank = await payOrder(db, a, {
    orderId: o.id,
    method: "BANK_TRANSFER",
    buyer,
  });
  assert(bank.invoice);
  const b = await tenant(),
    other = await order(b);
  let calls = 0;
  const uncertain = {
    ...fake,
    async createPayment(): Promise<never> {
      calls++;
      throw new ApiError(502, "provider_signature", "Unverified response");
    },
  };
  await assert.rejects(() =>
    payOrder(db, b, { orderId: other.id, method: "CARD" }, uncertain),
  );
  const pending = await payOrder(
    db,
    b,
    { orderId: other.id, method: "CARD" },
    uncertain,
  );
  assert.equal(calls, 1);
  assert.equal(pending.payments[0].status, "PROCESSING");
  assert.equal(pending.payments[0].failureReason, "provider_signature");
  await assert.rejects(() => cancelOrder(db, b, other.id));
});
it("an unsigned gateway internal error keeps the checkout locked without creating another charge", async () => {
  const a = await tenant(),
    o = await order(a),
    originalFetch = globalThis.fetch;
  const settings = {
    BILLING_PROVIDER: "freedompay",
    FREEDOM_PAY_MERCHANT_ID: "fixture",
    FREEDOM_PAY_SECRET_KEY: "fixture-secret",
  };
  const previous = Object.fromEntries(
    Object.keys(settings).map((key) => [key, process.env[key]]),
  );
  let calls = 0;
  Object.assign(process.env, settings);
  globalThis.fetch = async () => {
    calls++;
    return new Response(
      "<response><pg_status>error</pg_status><pg_error_code>0</pg_error_code><pg_error_description>Internal gateway error</pg_error_description></response>",
    );
  };
  try {
    await assert.rejects(
      () => payOrder(db, a, { orderId: o.id, method: "CARD" }),
      { code: "provider_internal" },
    );
    const pending = await payOrder(db, a, { orderId: o.id, method: "CARD" });
    assert.equal(calls, 1);
    assert.equal(pending.order.status, "PENDING_PAYMENT");
    assert.equal(pending.payments.length, 1);
    assert.equal(pending.payments[0].status, "PROCESSING");
    assert.equal(pending.payments[0].failureReason, "provider_internal");
    await assert.rejects(() => cancelOrder(db, a, o.id));
    await assert.rejects(
      () => payOrder(db, a, { orderId: o.id, method: "BANK_TRANSFER", buyer }),
      { code: "payment_exists" },
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
it("real status checks preserve uncertain payments; admin recovery requires reconciliation and no provider payment", async () => {
  const { checkOrderPayment, releaseUncreatedPayment } =
    await import("./services/billing/paymentCheck.ts");
  const original = freedomPay.getPaymentStatus;
  const a = await tenant(),
    o = await order(a),
    other = await tenant();
  const p = await db.billingPayment.create({
    data: {
      tenantId: o.tenantId,
      orderId: o.id,
      amountMinor: o.amountMinor,
      currency: o.currency,
      method: "CARD",
      provider: "FREEDOM_PAY",
      status: "PROCESSING",
      createdAt: new Date(Date.now() - 600_000),
    },
  });
  let checks = 0;
  freedomPay.getPaymentStatus = async (_id, ref) => {
    checks++;
    assert.equal(ref, p.id);
    throw new ApiError(404, "provider_not_found", "Not found");
  };
  try {
    await assert.rejects(() => checkOrderPayment(db, other, o.id), {
      code: "not_found",
    });
    assert.equal(checks, 0);
    assert.equal((await checkOrderPayment(db, a, o.id)).status, "not_found");
    assert.equal(
      (await db.billingPayment.findUniqueOrThrow({ where: { id: p.id } }))
        .status,
      "PROCESSING",
    );
    await assert.rejects(() =>
      releaseUncreatedPayment(db, a, p.id, {
        noChargeConfirmed: true,
        reason: "Reconciled all merchant accounts",
      }),
    );
    await assert.rejects(() =>
      releaseUncreatedPayment(db, admin, p.id, {
        reason: "Reconciled all merchant accounts",
      }),
    );
    freedomPay.getPaymentStatus = async () => ({
      pg_payment_id: "bank-123",
      pg_order_id: p.id,
      pg_amount: String(p.amountMinor),
      pg_currency: p.currency,
      pg_payment_status: "success",
    });
    assert.equal((await checkOrderPayment(db, a, o.id)).status, "success");
    assert.equal(
      (await checkoutDetail(db, a, o.id)).order.status,
      "PENDING_PAYMENT",
    );
    await assert.rejects(
      () =>
        releaseUncreatedPayment(db, admin, p.id, {
          noChargeConfirmed: true,
          reason: "Reconciled all merchant accounts",
        }),
      { code: "payment_not_recoverable" },
    );
    freedomPay.getPaymentStatus = async () => ({
      pg_payment_id: "bank-123",
      pg_order_id: "wrong",
      pg_amount: String(p.amountMinor),
      pg_currency: p.currency,
      pg_payment_status: "success",
    });
    await assert.rejects(() => checkOrderPayment(db, a, o.id), {
      code: "provider_mismatch",
    });
    freedomPay.getPaymentStatus = async () => {
      throw new ApiError(404, "provider_not_found", "Not found");
    };
    await releaseUncreatedPayment(db, admin, p.id, {
      noChargeConfirmed: true,
      reason: "Checked old and new merchants, no payment received",
    });
    assert.equal(
      (await db.billingPayment.findUniqueOrThrow({ where: { id: p.id } }))
        .status,
      "FAILED",
    );
    await assert.rejects(
      () =>
        releaseUncreatedPayment(db, admin, p.id, {
          noChargeConfirmed: true,
          reason: "Checked all merchants again",
        }),
      { code: "payment_not_recoverable" },
    );
    const retry = await payOrder(
      db,
      a,
      { orderId: o.id, method: "CARD" },
      fake,
    );
    assert.equal(
      retry.payments.filter((x: any) => x.status === "PROCESSING").length,
      1,
    );
  } finally {
    freedomPay.getPaymentStatus = original;
  }
});
it("a callback arriving during recovery wins; the successful payment cannot be released", async () => {
  const { releaseUncreatedPayment } =
    await import("./services/billing/paymentCheck.ts");
  const original = freedomPay.getPaymentStatus;
  const a = await tenant(),
    o = await order(a);
  const p = await db.billingPayment.create({
    data: {
      tenantId: o.tenantId,
      orderId: o.id,
      amountMinor: o.amountMinor,
      currency: o.currency,
      method: "CARD",
      provider: "FREEDOM_PAY",
      status: "PROCESSING",
      createdAt: new Date(Date.now() - 600_000),
    },
  });
  freedomPay.getPaymentStatus = async () => {
    await processPaymentNotice(db, notice(p));
    throw new ApiError(404, "provider_not_found", "Not found");
  };
  try {
    await assert.rejects(
      () =>
        releaseUncreatedPayment(db, admin, p.id, {
          noChargeConfirmed: true,
          reason: "Checked all merchant accounts",
        }),
      { code: "payment_not_recoverable" },
    );
    assert.equal((await checkoutDetail(db, a, o.id)).order.status, "PAID");
  } finally {
    freedomPay.getPaymentStatus = original;
  }
});
it("cancellation reconciles declined and expired attempts, but keeps uncertain or successful payments locked", async () => {
  const original = freedomPay.getPaymentStatus;
  try {
    for (const status of ["failed", "incomplete", "pending", "success", "unknown", "refunded", "revoked", "not_found", "bad_signature", "wrong_amount", "wrong_order"]) {
      const a = await tenant(), o = await order(a);
      const d = await payOrder(db, a, { orderId: o.id, method: "CARD" }, fake);
      const p = await db.billingPayment.findUniqueOrThrow({ where: { id: d.payments[0].id } });
      freedomPay.getPaymentStatus = async () => {
        if (status === "not_found") throw new ApiError(404, "provider_not_found", "Not found");
        if (status === "bad_signature") throw new ApiError(502, "provider_signature", "Invalid signature");
        return {
          pg_payment_id: p.providerPaymentId!,
          pg_order_id: status === "wrong_order" ? "wrong-order" : p.id,
          pg_amount: String(p.amountMinor + (status === "wrong_amount" ? 1 : 0)),
          pg_currency: p.currency,
          pg_payment_status: status.startsWith("wrong_") ? "failed" : status,
        };
      };
      if (["failed", "incomplete"].includes(status)) {
        assert.equal((await cancelOrder(db, a, o.id)).status, "CANCELLED");
        assert.equal((await db.billingPayment.findUniqueOrThrow({ where: { id: p.id } })).status, "FAILED");
      } else {
        await assert.rejects(() => cancelOrder(db, a, o.id));
        assert.equal((await checkoutDetail(db, a, o.id)).order.status, "PENDING_PAYMENT", status);
        assert.equal((await db.billingPayment.findUniqueOrThrow({ where: { id: p.id } })).status, "PROCESSING", status);
      }
    }
  } finally { freedomPay.getPaymentStatus = original; }
});
it("cancellation checks ownership before querying provider and cannot overwrite a racing paid callback", async () => {
  const original = freedomPay.getPaymentStatus;
  const a = await tenant(), b = await tenant(), o = await order(a);
  const d = await payOrder(db, a, { orderId: o.id, method: "CARD" }, fake);
  const p = await db.billingPayment.findUniqueOrThrow({ where: { id: d.payments[0].id } });
  let calls = 0;
  freedomPay.getPaymentStatus = async () => {
    calls++;
    await processPaymentNotice(db, notice(p));
    return { pg_payment_id: p.providerPaymentId!, pg_order_id: p.id, pg_amount: String(p.amountMinor), pg_currency: p.currency, pg_payment_status: "failed" };
  };
  try {
    await assert.rejects(() => cancelOrder(db, b, o.id), { code: "not_found" });
    assert.equal(calls, 0);
    await assert.rejects(() => cancelOrder(db, a, o.id), { code: "order_closed" });
    assert.equal((await checkoutDetail(db, a, o.id)).order.status, "PAID");
    assert.equal((await db.billingPayment.findUniqueOrThrow({ where: { id: p.id } })).status, "PAID");
  } finally { freedomPay.getPaymentStatus = original; }
});
