import { billingConfig, billingError } from "./config.ts";
/** Controlled merchant flow. No invented Kaspi API or shared QR without an order reference. */
export class KaspiPaymentProvider {
  readonly name = "KASPI";
  get configured() {
    return billingConfig().kaspi;
  }
  createPayment() {
    if (!this.configured)
      billingError("kaspi_unavailable", "Оплата Kaspi пока недоступна", 503);
    return {
      status: "PENDING" as const,
      confirmation: "PLATFORM_ADMIN" as const,
    };
  }
  validatePaymentLink(value: string) {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !(url.hostname === "kaspi.kz" || url.hostname.endsWith(".kaspi.kz")) ||
      url.username ||
      url.password ||
      url.port ||
      url.hash
    )
      billingError(
        "kaspi_link",
        "Укажите официальную ссылку Kaspi для этого заказа",
      );
    return url.href;
  }
}
export const kaspiPayments = new KaspiPaymentProvider();
