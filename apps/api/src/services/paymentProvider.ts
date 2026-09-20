/**
 * Payment provider seam. Online checkout is not implemented.
 * Activation must come from a trusted server-side call (platform admin or signed webhook).
 */
export type PaymentActivation = {
  tenantId: string;
  planCode?: string;
  providerRef?: string;
};

export type PaymentProvider = {
  readonly name: string;
  readonly configured: boolean;
  createCheckout?: (input: {
    tenantId: string;
    planCode: string;
    successUrl: string;
    cancelUrl: string;
  }) => Promise<{ url: string }>;
  parseWebhook?: (rawBody: string, headers: Record<string, string | undefined>) => Promise<PaymentActivation | null>;
};

export const paymentProvider: PaymentProvider = {
  name: "none",
  configured: false,
};
