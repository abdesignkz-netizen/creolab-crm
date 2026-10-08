import assert from "node:assert/strict";
import { before, after, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { seedDatabase } from "../../../packages/db/src/seed.ts";
import { freedomSignature } from "./services/billing/freedomPayProvider.ts";
import type { Server } from "node:http";
let db: Awaited<ReturnType<typeof createPrismaClient>>,
  server: Server,
  url: string,
  owner: string,
  admin: string,
  manager: string,
  tenantId: string;
async function request(
  path: string,
  cookie = "",
  body?: unknown,
  method = body ? "POST" : "GET",
) {
  const r = await fetch(url + path, {
    method,
    headers: { cookie, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: r.status,
    body: await r.json().catch(() => ({})),
    headers: r.headers,
  };
}
async function login(email: string) {
  const r = await request("/api/v1/auth/login", "", {
    email,
    password: "ChangeMeLocal1!",
    client: "web",
  });
  assert.equal(r.status, 200);
  return r.headers.getSetCookie()[0].split(";")[0];
}
before(async () => {
  process.env.BILLING_KASPI_MANUAL_ENABLED = "1";
  process.env.BILLING_PROVIDER = "freedompay";
  process.env.FREEDOM_PAY_MERCHANT_ID = "fixture";
  process.env.FREEDOM_PAY_SECRET_KEY = "fixture-key";
  db = await createPrismaClient();
  await seedDatabase();
  server = await new Promise<Server>((resolve) => {
    const s = createApp(db).listen(0, "127.0.0.1", () => resolve(s));
  });
  const addr = server.address();
  assert(addr && typeof addr !== "string");
  url = `http://127.0.0.1:${addr.port}`;
  owner = await login("owner@creolab.example");
  admin = await login("platform@creolab.example");
  tenantId = (await db.tenant.findFirstOrThrow({ where: { slug: "creolab" } }))
    .id;
});
after(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
});
it("checkout endpoint ignores frontend prices and requires authentication", async () => {
  assert.equal(
    (await request("/api/v1/billing/checkout", "", { planCode: "CONTROL" }))
      .status,
    401,
  );
  const r = await request("/api/v1/billing/checkout", owner, {
    planCode: "CONTROL",
    amountMinor: 1,
    status: "PAID",
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert(r.body.amountMinor > 1);
  assert.equal(r.body.status, "PENDING_PAYMENT");
  assert.equal(
    (await request("/api/v1/billing/orders/" + r.body.id, owner)).headers.get(
      "cache-control",
    ),
    "no-store",
  );
});
it("signed callback confirms once; replay uses same payment and invalid callbacks are redacted", async () => {
  const order = await db.billingOrder.findFirstOrThrow({
    where: { tenantId, status: "PENDING_PAYMENT" },
  });
  const p = await db.billingPayment.create({
    data: {
      tenantId,
      orderId: order.id,
      subscriptionId: order.subscriptionId,
      amountMinor: order.amountMinor,
      currency: "KZT",
      provider: "FREEDOM_PAY",
      method: "CARD",
      status: "PROCESSING",
      providerPaymentId: "http-fixture",
    },
  });
  const f: Record<string, string> = {
    pg_order_id: p.id,
    pg_payment_id: "http-fixture",
    pg_amount: String(p.amountMinor),
    pg_currency: "KZT",
    pg_result: "1",
    pg_testing_mode: "1",
    basqar_tenant: tenantId,
    basqar_order: order.id,
    basqar_merchant: "fixture",
    pg_salt: "x",
  };
  const send = async (fields: Record<string, string>) =>
    fetch(url + "/api/v1/billing/providers/freedompay/webhook", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });
  assert.equal(
    (await send({ ...f, pg_sig: "invalid", pg_card_pan: "DO-NOT-STORE" }))
      .status,
    401,
  );
  assert(
    !JSON.stringify(await db.paymentWebhookEvent.findMany()).includes(
      "DO-NOT-STORE",
    ),
  );
  const fields = {
    ...f,
    pg_sig: freedomSignature("webhook", f, "fixture-key"),
  };
  const good = await send(fields);
  assert.equal(good.status, 200, await good.clone().text());
  assert.match(await good.text(), /<pg_status>ok<\/pg_status>/);
  const sub = await db.tenantPlan.findUniqueOrThrow({
    where: { id: order.subscriptionId! },
  });
  assert.equal((await send(fields)).status, 200);
  assert.equal(
    (
      await db.tenantPlan.findUniqueOrThrow({ where: { id: sub.id } })
    ).endsAt!.getTime(),
    sub.endsAt!.getTime(),
  );
});
it("customer cannot use admin confirmation and outsider cannot obtain invoice PDF", async () => {
  assert.equal(
    (
      await request("/api/v1/admin/billing/payments/nope/confirm", owner, {
        amount: 1,
        paidAt: new Date().toISOString(),
        reference: "test",
      })
    ).status,
    403,
  );
  assert.equal(
    (await request("/api/v1/billing/invoices/nope/pdf", owner)).status,
    404,
  );
  assert.equal(
    (await request("/api/v1/admin/billing/ledger", admin)).status,
    200,
  );
});
it("duplicate callback fields fail before processing and success query never changes state", async () => {
  const f = new URLSearchParams([
    ["pg_result", "1"],
    ["pg_result", "0"],
  ]);
  const r = await fetch(url + "/api/v1/billing/providers/freedompay/webhook", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: f,
  });
  assert.equal(r.status, 400);
  const r2 = await request("/api/v1/billing/checkout", owner, {
    planCode: "SALES",
  });
  assert.equal(r2.status, 201);
  const detail = await request(
    `/api/v1/billing/orders/${r2.body.id}?success=1`,
    owner,
  );
  assert.equal(detail.body.order.status, "PENDING_PAYMENT");
});
it("checkout check calls provider, enforces tenant ownership and does not mark a payment paid", async () => {
  const { freedomPay } =
    await import("./services/billing/freedomPayProvider.ts");
  const original = freedomPay.getPaymentStatus;
  const o = await db.billingOrder.create({
    data: {
      tenantId,
      orderNumber: "BSQ-CHECK-HTTP",
      planId: (await db.plan.findFirstOrThrow({ where: { code: "CONTROL" } }))
        .id,
      snapshotJson: {},
      description: "Check fixture",
      planCode: "CONTROL",
      amountMinor: 34990,
      currency: "KZT",
      billingPeriod: "MONTHLY",
      status: "PENDING_PAYMENT",
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
  const p = await db.billingPayment.create({
    data: {
      tenantId,
      orderId: o.id,
      amountMinor: o.amountMinor,
      currency: o.currency,
      status: "PROCESSING",
      method: "CARD",
      provider: "FREEDOM_PAY",
    },
  });
  let calls = 0;
  freedomPay.getPaymentStatus = async (_id, ref) => {
    calls++;
    assert.equal(ref, p.id);
    return {
      pg_payment_id: "fixture-http",
      pg_order_id: p.id,
      pg_amount: String(p.amountMinor),
      pg_currency: p.currency,
      pg_payment_status: "pending",
    };
  };
  try {
    assert.equal(
      (await request(`/api/v1/billing/orders/${o.id}/check`, "", {}, "POST"))
        .status,
      401,
    );
    const checked = await request(
      `/api/v1/billing/orders/${o.id}/check`,
      owner,
      {},
      "POST",
    );
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    assert.equal(checked.body.status, "pending");
    assert.equal(calls, 1);
    assert.equal(
      (await db.billingPayment.findUniqueOrThrow({ where: { id: p.id } }))
        .status,
      "PROCESSING",
    );
    assert.equal(
      (
        await request(`/api/v1/admin/billing/payments/${p.id}/release`, owner, {
          noChargeConfirmed: true,
          reason: "No charge confirmed by user",
        })
      ).status,
      403,
    );
  } finally {
    freedomPay.getPaymentStatus = original;
  }
});
it("seller image uploads accept a bounded PNG only for platform admins and stay out of checkout polling", async () => {
  const { createCanvas } = await import("@napi-rs/canvas");
  const { randomFillSync } = await import("node:crypto");
  const canvas = createCanvas(128, 128), ctx = canvas.getContext("2d");
  const pixels = ctx.createImageData(128, 128);
  randomFillSync(pixels.data);
  ctx.putImageData(pixels, 0, 0);
  const signatureDataUrl = canvas.toDataURL("image/png");
  assert(signatureDataUrl.length > 32 * 1024);
  const details = {
    legalName: "Тестовый поставщик", bin: "123456789012", legalAddress: "Алматы, тестовый адрес",
    iban: "KZ123456789012345678", bankName: "Тестовый банк", bik: "TESTKZKX", kbe: "17",
    vatEnabled: false, vatRate: 0, supportEmail: "billing@example.test", supportPhone: "+77000000000",
    invoicePrefix: "BSQ-INV", signerName: "Тестов А.Б.", signatureDataUrl,
  };
  const path = "/api/v1/admin/billing/seller";
  assert.equal((await request(path, "", details, "PUT")).status, 401);
  assert.equal((await request(path, owner, details, "PUT")).status, 403);
  const saved = await request(path, admin, details, "PUT");
  assert.equal(saved.status, 200);
  assert.equal(saved.body.signatureDataUrl, signatureDataUrl);
  const order = await db.billingOrder.findFirstOrThrow({ where: { tenantId } });
  const checkout = await request("/api/v1/billing/orders/" + order.id, owner);
  assert.equal(checkout.status, 200);
  assert.equal(checkout.body.seller.legalName, details.legalName);
  assert.equal(checkout.body.seller.signatureDataUrl, undefined);
  assert.equal((await request(path, admin, { ...details, signatureDataUrl: "data:image/svg+xml,<svg/>" }, "PUT")).status, 422);
});

it("invoice signing endpoint is restricted to platform administrators", async () => {
  const path = "/api/v1/admin/billing/invoices/unknown/complete-signing";
  assert.equal((await request(path, "", undefined, "POST")).status, 401);
  assert.equal((await request(path, owner, undefined, "POST")).status, 403);
  assert.equal((await request(path, admin, undefined, "POST")).status, 404);
});
