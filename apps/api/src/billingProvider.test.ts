import assert from "node:assert/strict";
import { it, after } from "node:test";
import { createHash } from "node:crypto";
import {
  parseFreedomResponse,
  readProviderXml,
} from "./services/billing/freedomXml.ts";
import {
  freedomPay,
  freedomSignature,
} from "./services/billing/freedomPayProvider.ts";
const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
});
it("nested status response signature covers refund fields and rejects tampering", () => {
  // Independent known canonical sequence: pg_amount, pg_refund_payments.pg_refund_payment fields, pg_status.
  const sig = createHash("md5")
    .update("get_status3.php;34990;-10;123;ok;test-secret")
    .digest("hex");
  const xml = `<response><pg_status>ok</pg_status><pg_amount>34990</pg_amount><pg_refund_payments><pg_refund_payment><pg_payment_id>123</pg_payment_id><pg_amount>-10</pg_amount></pg_refund_payment></pg_refund_payments><pg_sig>${sig}</pg_sig></response>`;
  assert(parseFreedomResponse(xml).verify("get_status3.php", "test-secret"));
  assert(
    !parseFreedomResponse(xml.replace("-10", "-20")).verify(
      "get_status3.php",
      "test-secret",
    ),
  );
  for (const bad of [
    "<response><x>one</x><x>two</x></response>",
    "<!DOCTYPE x><response/>",
    "<response><x>&external;</x></response>",
    '<response key="bad"/>',
    "<response><x></response>",
  ])
    assert.throws(() => parseFreedomResponse(bad));
});
it("provider responses are bounded before XML parsing", async () => {
  await assert.rejects(() => readProviderXml(new Response("x".repeat(100001))));
  assert.equal(
    await readProviderXml(new Response("<response/>")),
    "<response/>",
  );
});
it("card creation signs request, verifies response and rejects external redirect", async () => {
  process.env.BILLING_PROVIDER = "freedompay";
  process.env.FREEDOM_PAY_MERCHANT_ID = "fixture";
  process.env.FREEDOM_PAY_SECRET_KEY = "fixture-secret";
  process.env.FREEDOM_PAY_TESTING_MODE = "1";
  let redirect = "https://api.freedompay.kz/pay/fixture",
    badSignature = false;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://api.freedompay.kz/init_payment");
    const params = Object.fromEntries(new URLSearchParams(String(init?.body)));
    assert.equal(
      params.pg_sig,
      freedomSignature("init_payment", params, "fixture-secret"),
    );
    assert.equal(params.pg_amount, "34990.00");
    assert.equal(params.basqar_tenant, "tenant");
    const fields = {
      pg_status: "ok",
      pg_payment_id: "123",
      pg_redirect_url: redirect,
      pg_salt: "test",
    };
    const sig = badSignature
      ? "0".repeat(32)
      : freedomSignature("init_payment", fields, "fixture-secret");
    return new Response(
      "<response>" +
        Object.entries({ ...fields, pg_sig: sig })
          .map(([k, v]) => `<${k}>${v}</${k}>`)
          .join("") +
        "</response>",
    );
  };
  const input = {
    paymentId: "payment",
    orderId: "order",
    tenantId: "tenant",
    amount: 34990,
    currency: "KZT",
    description: "Test",
    returnUrl: "https://bsqr.kz/billing",
    autoRenew: false,
  };
  assert.equal(
    (await freedomPay.createPayment(input)).providerPaymentId,
    "123",
  );
  redirect = "https://attacker.example/pay";
  await assert.rejects(() => freedomPay.createPayment(input));
  redirect = "https://api.freedompay.kz/pay/fixture";
  badSignature = true;
  await assert.rejects(() => freedomPay.createPayment(input));
});
it("unsigned authentication rejection is actionable but unsigned success never is", async () => {
  process.env.BILLING_PROVIDER = "freedompay";
  process.env.FREEDOM_PAY_MERCHANT_ID = "fixture";
  process.env.FREEDOM_PAY_SECRET_KEY = "fixture-secret";
  let body =
    "<response><pg_status>error</pg_status><pg_error_code>1100</pg_error_code><pg_error_description>Incorrect signature</pg_error_description></response>";
  globalThis.fetch = async () => new Response(body);
  await assert.rejects(() => freedomPay.call("init_payment", {}), {
    code: "provider_credentials",
  });
  body = body.replace(
    "<pg_status>error</pg_status>",
    "<pg_status>ok</pg_status>",
  );
  await assert.rejects(() => freedomPay.call("init_payment", {}), {
    code: "provider_signature",
  });
  body =
    "<response><pg_status>error</pg_status><pg_error_code>1100</pg_error_code><pg_payment_id>123</pg_payment_id></response>";
  await assert.rejects(() => freedomPay.call("init_payment", {}), {
    code: "provider_signature",
  });
  body =
    "<response><pg_status>error</pg_status><pg_error_code>1100</pg_error_code><pg_sig>" +
    "0".repeat(32) +
    "</pg_sig></response>";
  await assert.rejects(() => freedomPay.call("init_payment", {}), {
    code: "provider_signature",
  });
});
it("not-found is diagnostic only and restricted to the status endpoint", async () => {
  process.env.BILLING_PROVIDER = "freedompay";
  process.env.FREEDOM_PAY_MERCHANT_ID = "fixture";
  process.env.FREEDOM_PAY_SECRET_KEY = "fixture-secret";
  let body =
    "<response><pg_status>error</pg_status><pg_error_code>11068</pg_error_code></response>";
  globalThis.fetch = async () => new Response(body);
  await assert.rejects(() => freedomPay.getPaymentStatus("", "orphan"), {
    code: "provider_not_found",
  });
  await assert.rejects(() => freedomPay.call("init_payment", {}), {
    code: "provider_signature",
  });
  body = body.replace(
    "</response>",
    "<pg_payment_id>123</pg_payment_id></response>",
  );
  await assert.rejects(() => freedomPay.getPaymentStatus("", "orphan"), {
    code: "provider_signature",
  });
});
