import { config } from "../../config.ts";
import { ApiError } from "../../errors.ts";
export function billingConfig() {
  return {
    merchantId: process.env.FREEDOM_PAY_MERCHANT_ID || "",
    secret: process.env.FREEDOM_PAY_SECRET_KEY || "",
    apiUrl: process.env.FREEDOM_PAY_API_URL || "https://api.freedompay.kz",
    enabled: process.env.BILLING_PROVIDER === "freedompay",
    testing: process.env.FREEDOM_PAY_TESTING_MODE !== "0",
    recurring: process.env.FREEDOM_PAY_RECURRING_ENABLED === "1",
    kaspi: process.env.BILLING_KASPI_MANUAL_ENABLED === "1",
    graceDays: Math.max(
      1,
      Math.min(30, Number(process.env.BILLING_GRACE_PERIOD_DAYS) || 5),
    ),
    currency: "KZT",
    webhookUrl: `${config.apiBaseUrl.replace(/\/$/, "")}/api/v1/billing/providers/freedompay/webhook`,
    appUrl: config.appBaseUrl.replace(/\/$/, ""),
  };
}
export function billingError(
  code: string,
  message: string,
  status = 422,
): never {
  throw new ApiError(status, code, message);
}
// Legacy pricing fields named "Minor" actually contain whole tenge. Never convert existing balances.
export function amountKzt(value: string): number {
  if (!/^\d+(?:\.0{1,2})?$/.test(value))
    billingError("payment_amount", "Некорректная сумма");
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0 || n > 2_000_000_000)
    billingError("payment_amount", "Некорректная сумма");
  return n;
}
