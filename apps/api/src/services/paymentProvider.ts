/** Provider adapters only move money. Subscription activation belongs to the billing ledger. */
export type PaymentInput = {
  paymentId: string; orderId: string; tenantId: string; amount: number; currency: string;
  description: string; returnUrl: string; autoRenew: boolean;
};
export type ProviderResult = { providerPaymentId: string; redirectUrl?: string };
export type PaymentNotice = {
  eventId: string; paymentId: string; tenantId: string; orderId: string;
  providerPaymentId: string; amount: number; currency: string; paid: boolean;
  recurringProfile?: string;
};
export interface PaymentProvider {
  readonly name: string;
  readonly configured: boolean;
  createPayment(input: PaymentInput): Promise<ProviderResult>;
  createRecurringPayment(input: PaymentInput, profile: string): Promise<ProviderResult>;
  getPaymentStatus(paymentId: string, merchantReference?: string): Promise<Record<string, unknown>>;
  cancelPayment(paymentId: string): Promise<Record<string, unknown>>;
  refundPayment(paymentId: string, amount: number): Promise<Record<string, unknown>>;
  handleWebhook(fields: Record<string, string>): PaymentNotice;
}
