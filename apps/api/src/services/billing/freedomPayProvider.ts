import { parseFreedomResponse, readProviderXml } from "./freedomXml.ts";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  PaymentProvider,
  PaymentInput,
  PaymentNotice,
} from "../paymentProvider.ts";
import { billingConfig, billingError, amountKzt } from "./config.ts";

type Fields = Record<string, string>;
export function freedomSignature(
  script: string,
  fields: Fields,
  secret: string,
) {
  return createHash("md5")
    .update(
      [
        script,
        ...Object.keys(fields)
          .filter((k) => k !== "pg_sig")
          .sort()
          .map((k) => fields[k]),
        secret,
      ].join(";"),
    )
    .digest("hex");
}
export function verifyFreedomSignature(
  script: string,
  fields: Fields,
  secret: string,
) {
  const actual = fields.pg_sig || "";
  return Boolean(
    secret &&
    /^[a-f\d]{32}$/i.test(actual) &&
    timingSafeEqual(
      Buffer.from(actual.toLowerCase()),
      Buffer.from(freedomSignature(script, fields, secret)),
    ),
  );
}
function escapeXml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
export function parseFreedomXml(xml: string): Fields {
  return parseFreedomResponse(xml).fields;
}
export class FreedomPayProvider implements PaymentProvider {
  readonly name = "FREEDOM_PAY";
  get configured() {
    const c = billingConfig();
    try {
      const url = new URL(c.apiUrl);
      return Boolean(
        c.enabled &&
        c.merchantId &&
        c.secret &&
        url.protocol === "https:" &&
        url.hostname === "api.freedompay.kz" &&
        !url.username &&
        !url.password &&
        !url.port,
      );
    } catch {
      return false;
    }
  }
  async call(script: string, input: Fields) {
    if (!this.configured)
      billingError(
        "provider_not_configured",
        "Оплата картой пока недоступна",
        503,
      );
    const c = billingConfig();
    const base = new URL(c.apiUrl);
    if (
      base.protocol !== "https:" ||
      base.hostname !== "api.freedompay.kz" ||
      base.username ||
      base.password ||
      base.port
    )
      billingError(
        "provider_config",
        "Некорректный адрес платёжного сервиса",
        503,
      );
    const fields = {
      ...input,
      pg_merchant_id: c.merchantId,
      pg_salt: randomBytes(16).toString("hex"),
    };
    const res = await fetch(new URL(`/${script}`, base), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...fields,
        pg_sig: freedomSignature(script, fields, c.secret),
      }),
    });
    if (!res.ok)
      billingError(
        "provider_unavailable",
        "Платёжный сервис временно недоступен",
        502,
      );
    const parsed = parseFreedomResponse(await readProviderXml(res));
    const out = parsed.fields;
    // Authentication failures can be unsigned: the gateway cannot authenticate
    // the merchant. This is a rejection only, never proof of a payment or status.
    if (
      out.pg_status === "error" &&
      ["1100", "9998"].includes(out.pg_error_code) &&
      !out.pg_sig &&
      !out.pg_payment_id &&
      !out.pg_redirect_url
    )
      billingError(
        "provider_credentials",
        "Freedom Pay не принял настройки магазина. Администратору нужно проверить ID мерчанта и ключ приёма платежей.",
        503,
      );
    // The gateway can fail internally before signing a response. Keep this
    // distinct from a bad signature, but never treat it as a verified decline.
    if (
      out.pg_status === "error" &&
      out.pg_error_code === "0" &&
      !out.pg_sig &&
      !out.pg_payment_id &&
      !out.pg_redirect_url
    )
      billingError(
        "provider_internal",
        "Внутренняя ошибка Freedom Pay. Администратору нужно проверить настройки магазина и состояние платежа.",
        502,
      );
    // A narrowly classified diagnostic, not authorization to settle or retry.
    if (
      script === "get_status3.php" &&
      out.pg_status === "error" &&
      out.pg_error_code === "11068" &&
      !out.pg_sig &&
      !out.pg_payment_id &&
      !out.pg_redirect_url
    )
      billingError(
        "provider_not_found",
        "Платёж не найден в текущем магазине Freedom Pay",
        404,
      );
    if (!parsed.verify(script, c.secret))
      billingError(
        "provider_signature",
        "Не удалось проверить ответ платёжного сервиса",
        502,
      );
    if (
      script === "get_status3.php" &&
      out.pg_status === "error" &&
      out.pg_error_code === "11068" &&
      !out.pg_payment_id &&
      !out.pg_redirect_url
    )
      billingError(
        "provider_not_found",
        "Платёж не найден в текущем магазине Freedom Pay",
        404,
      );
    if (out.pg_status !== "ok")
      billingError(
        "provider_declined",
        "Платёжный сервис отклонил запрос",
        422,
      );
    return out;
  }
  fields(i: PaymentInput): Fields {
    const c = billingConfig();
    return {
      pg_order_id: i.paymentId,
      pg_amount: `${i.amount}.00`,
      pg_currency: i.currency,
      pg_description: i.description,
      pg_result_url: c.webhookUrl,
      pg_request_method: "POST",
      pg_testing_mode: c.testing ? "1" : "0",
      pg_auto_clearing: "1",
      basqar_tenant: i.tenantId,
      basqar_order: i.orderId,
      basqar_merchant: c.merchantId,
    };
  }
  async createPayment(i: PaymentInput) {
    const c = billingConfig();
    if (i.autoRenew && !c.recurring)
      billingError("recurring_unavailable", "Автопродление пока недоступно");
    const out = await this.call("init_payment", {
      ...this.fields(i),
      pg_payment_method: "bankcard",
      pg_success_url: i.returnUrl,
      pg_failure_url: i.returnUrl,
      pg_success_url_method: "GET",
      pg_failure_url_method: "GET",
      pg_lifetime: "3600",
      ...(i.autoRenew
        ? {
            pg_recurring_start: "1",
            pg_recurring_lifetime: "365",
            pg_user_id: i.tenantId,
          }
        : {}),
    });
    const url = new URL(out.pg_redirect_url || "https://invalid.invalid");
    if (
      url.protocol !== "https:" ||
      !(
        url.hostname === "freedompay.kz" ||
        url.hostname.endsWith(".freedompay.kz")
      ) ||
      url.username ||
      url.password ||
      !out.pg_payment_id
    )
      billingError(
        "provider_response",
        "Не удалось получить страницу оплаты",
        502,
      );
    return { providerPaymentId: out.pg_payment_id, redirectUrl: url.href };
  }
  async createRecurringPayment(i: PaymentInput, profile: string) {
    if (!billingConfig().recurring)
      billingError("recurring_unavailable", "Автопродление пока недоступно");
    const out = await this.call("make_recurring_payment", {
      ...this.fields(i),
      pg_recurring_profile: profile,
    });
    if (!out.pg_payment_id)
      billingError("provider_response", "Не получен номер платежа", 502);
    return { providerPaymentId: out.pg_payment_id };
  }
  getPaymentStatus(paymentId: string, merchantReference?: string) {
    return this.call(
      "get_status3.php",
      paymentId
        ? { pg_payment_id: paymentId }
        : { pg_order_id: merchantReference || "" },
    );
  }
  cancelPayment(paymentId: string) {
    return this.call("cancel", { pg_payment_id: paymentId });
  }
  refundPayment(paymentId: string, amount: number) {
    return this.call("revoke", {
      pg_payment_id: paymentId,
      pg_refund_amount: `${amountKzt(String(amount))}.00`,
    });
  }
  handleWebhook(fields: Fields): PaymentNotice {
    const c = billingConfig();
    if (
      !this.configured ||
      !verifyFreedomSignature("webhook", fields, c.secret)
    )
      billingError("webhook_signature", "Недействительная подпись", 401);
    if (
      fields.basqar_merchant !== c.merchantId ||
      (fields.pg_merchant_id && fields.pg_merchant_id !== c.merchantId) ||
      fields.pg_testing_mode !== (c.testing ? "1" : "0")
    )
      billingError("webhook_merchant", "Несоответствие настроек платежа", 400);
    if (
      !["0", "1"].includes(fields.pg_result) ||
      !fields.pg_order_id ||
      !fields.pg_payment_id ||
      !fields.basqar_tenant ||
      !fields.basqar_order
    )
      billingError("webhook_fields", "Неполное уведомление", 400);
    return {
      eventId: createHash("sha256")
        .update(
          [fields.pg_payment_id, fields.pg_order_id, fields.pg_result].join(
            ":",
          ),
        )
        .digest("hex"),
      paymentId: fields.pg_order_id,
      providerPaymentId: fields.pg_payment_id,
      tenantId: fields.basqar_tenant,
      orderId: fields.basqar_order,
      amount: amountKzt(fields.pg_amount),
      currency: fields.pg_currency,
      paid: fields.pg_result === "1",
      recurringProfile: fields.pg_recurring_profile,
    };
  }
  acknowledgement() {
    const fields: Fields = {
      pg_status: "ok",
      pg_description: "Accepted",
      pg_salt: randomBytes(16).toString("hex"),
    };
    fields.pg_sig = freedomSignature("webhook", fields, billingConfig().secret);
    return `<?xml version="1.0" encoding="utf-8"?><response>${Object.entries(
      fields,
    )
      .map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`)
      .join("")}</response>`;
  }
}
export const freedomPay = new FreedomPayProvider();
