export const FEATURES = {
  WHATSAPP: "WHATSAPP",
  AI_MANAGER: "AI_MANAGER",
  TEAM: "TEAM",
  MASS_MESSAGING: "MASS_MESSAGING",
  DOCUMENTS: "DOCUMENTS",
  ESF: "ESF",
  ADVANCED_ANALYTICS: "ADVANCED_ANALYTICS",
  API: "API",
  MESSAGING: "MESSAGING",
  AUTOMATION: "AUTOMATION",
  CHANNELS: "CHANNELS",
} as const;

export type Feature = (typeof FEATURES)[keyof typeof FEATURES];

export const FEATURE_LIST = Object.values(FEATURES);

export const SUBSCRIPTION_STATUSES = {
  NONE: "none",
  PENDING: "pending",
  ACTIVE: "active",
  PAST_DUE: "past_due",
  CANCELED: "canceled",
  EXPIRED: "expired",
} as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[keyof typeof SUBSCRIPTION_STATUSES];

export const ORGANIZATION_STATUSES = {
  ACTIVE: "active",
  SUSPENDED: "suspended",
  BLOCKED: "blocked",
} as const;
