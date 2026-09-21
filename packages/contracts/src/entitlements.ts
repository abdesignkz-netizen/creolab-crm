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
  CRM_CORE: "CRM_CORE",
  CRM_LITE: "CRM_LITE",
  CLIENTS: "CLIENTS",
  COMPANIES: "COMPANIES",
  LEADS: "LEADS",
  DEALS: "DEALS",
  TASKS: "TASKS",
  MULTIPLE_PIPELINES: "MULTIPLE_PIPELINES",
  WORKFLOWS: "WORKFLOWS",
  AVR_ESF: "AVR_ESF",
  API_ACCESS: "API_ACCESS",
  MULTI_DEPARTMENT: "MULTI_DEPARTMENT",
  ADVANCED_ROLES: "ADVANCED_ROLES",
  AI_CONTROL: "AI_CONTROL",
  TELEGRAM: "TELEGRAM",
  INSTAGRAM: "INSTAGRAM",
  TELEPHONY: "TELEPHONY",
  PRIORITY_SUPPORT: "PRIORITY_SUPPORT",
} as const;

export type Feature = (typeof FEATURES)[keyof typeof FEATURES];

export const FEATURE_LIST = Object.values(FEATURES);

export const FEATURE_LABEL: Record<Feature, string> = {
  WHATSAPP: "WhatsApp",
  AI_MANAGER: "AI Manager",
  TEAM: "Команда",
  MASS_MESSAGING: "Массовые рассылки",
  DOCUMENTS: "Документы",
  ESF: "ИС ЭСФ",
  ADVANCED_ANALYTICS: "Расширенная аналитика",
  API: "API",
  MESSAGING: "Сообщения",
  AUTOMATION: "Автоматизации",
  CHANNELS: "Каналы",
  CRM_CORE: "CRM",
  CRM_LITE: "CRM Lite",
  CLIENTS: "Клиенты",
  COMPANIES: "Компании",
  LEADS: "Заявки",
  DEALS: "Сделки",
  TASKS: "Задачи",
  MULTIPLE_PIPELINES: "Несколько воронок",
  WORKFLOWS: "Workflow",
  AVR_ESF: "АВР / ЭСФ",
  API_ACCESS: "API",
  MULTI_DEPARTMENT: "Несколько отделов",
  ADVANCED_ROLES: "Расширенные роли",
  AI_CONTROL: "BasQar Control",
  TELEGRAM: "Telegram",
  INSTAGRAM: "Instagram",
  TELEPHONY: "Телефония",
  PRIORITY_SUPPORT: "Приоритетная поддержка",
};

export const LIMITS = {
  USERS: "USERS",
  PIPELINES: "PIPELINES",
  DEPARTMENTS: "DEPARTMENTS",
  WHATSAPP_CONNECTIONS: "WHATSAPP_CONNECTIONS",
  AI_USAGE: "AI_USAGE",
  STORAGE_GB: "STORAGE_GB",
} as const;

export type LimitKey = (typeof LIMITS)[keyof typeof LIMITS];

export const LIMIT_LIST = Object.values(LIMITS);

export const LIMIT_LABEL: Record<LimitKey, string> = {
  USERS: "Пользователи",
  PIPELINES: "Воронки",
  DEPARTMENTS: "Отделы",
  WHATSAPP_CONNECTIONS: "WhatsApp",
  AI_USAGE: "AI-взаимодействия",
  STORAGE_GB: "Хранилище, ГБ",
};

export const SUBSCRIPTION_STATUSES = {
  NONE: "none",
  PENDING: "pending",
  ACTIVE: "active",
  PAST_DUE: "past_due",
  CANCELED: "canceled",
  CANCEL_AT_PERIOD_END: "cancel_at_period_end",
  EXPIRED: "expired",
  SUSPENDED: "suspended",
} as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[keyof typeof SUBSCRIPTION_STATUSES];

export const ORGANIZATION_STATUSES = {
  ACTIVE: "active",
  SUSPENDED: "suspended",
  BLOCKED: "blocked",
} as const;

export const BILLING_PERIODS = ["MONTHLY", "YEARLY"] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];

export const SUBSCRIPTION_REQUEST_TYPES = [
  "NEW_SUBSCRIPTION",
  "UPGRADE",
  "DOWNGRADE",
  "RENEWAL",
  "ADD_ADDON",
  "REMOVE_ADDON",
  "ENTERPRISE_REQUEST",
] as const;
export type SubscriptionRequestType = (typeof SUBSCRIPTION_REQUEST_TYPES)[number];

export const SUBSCRIPTION_REQUEST_STATUSES = [
  "PENDING",
  "AWAITING_PAYMENT",
  "PAYMENT_REVIEW",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
  "ACTIVATED",
] as const;
export type SubscriptionRequestStatus = (typeof SUBSCRIPTION_REQUEST_STATUSES)[number];

export const BILLING_PAYMENT_STATUSES = ["PENDING", "CONFIRMED", "REJECTED"] as const;
export type BillingPaymentStatus = (typeof BILLING_PAYMENT_STATUSES)[number];

export const CATALOG_STATUSES = ["AVAILABLE", "COMING_SOON", "HIDDEN"] as const;
export type CatalogStatus = (typeof CATALOG_STATUSES)[number];

export const OPEN_REQUEST_STATUSES: SubscriptionRequestStatus[] = [
  "PENDING",
  "AWAITING_PAYMENT",
  "PAYMENT_REVIEW",
  "APPROVED",
];
