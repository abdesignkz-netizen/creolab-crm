import type { PrismaClient } from "@creolab/db";
import {
  FEATURE_LABEL,
  FEATURE_LIST,
  FEATURES,
  LIMITS,
  SUBSCRIPTION_STATUSES,
  type Feature,
  type LimitKey,
} from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { requireTenant } from "../lib/access.ts";
import type { AuthContext } from "../lib/types.ts";

const PREVIEW_STATUSES = new Set([
  SUBSCRIPTION_STATUSES.NONE,
  SUBSCRIPTION_STATUSES.PENDING,
  SUBSCRIPTION_STATUSES.CANCELED,
  SUBSCRIPTION_STATUSES.EXPIRED,
  SUBSCRIPTION_STATUSES.SUSPENDED,
]);

const PLAN_FEATURE_ALIASES: Record<Feature, string[]> = {
  IMPORT: ["IMPORT"],
  EXPORT: ["EXPORT"],
  FILE_STORAGE: ["FILE_STORAGE"],
  WHATSAPP: ["whatsapp", "WHATSAPP"],
  AI_MANAGER: ["ai", "aiManager", "AI_MANAGER"],
  TEAM: ["team", "members", "TEAM"],
  MASS_MESSAGING: ["campaigns", "massMessaging", "MASS_MESSAGING"],
  DOCUMENTS: ["documents", "DOCUMENTS"],
  ESF: ["esf", "ESF", "AVR_ESF"],
  ADVANCED_ANALYTICS: ["analytics", "ADVANCED_ANALYTICS"],
  API: ["api", "webhook", "API", "API_ACCESS"],
  MESSAGING: ["messaging", "whatsapp", "MESSAGING"],
  AUTOMATION: ["automation", "AUTOMATION"],
  CHANNELS: ["channels", "integrations", "CHANNELS"],
  CRM_CORE: ["CRM_CORE"],
  CRM_LITE: ["CRM_LITE"],
  CLIENTS: ["CLIENTS"],
  COMPANIES: ["COMPANIES"],
  LEADS: ["LEADS"],
  DEALS: ["DEALS"],
  TASKS: ["TASKS"],
  MULTIPLE_PIPELINES: ["MULTIPLE_PIPELINES"],
  WORKFLOWS: ["WORKFLOWS"],
  AVR_ESF: ["AVR_ESF", "esf", "ESF"],
  API_ACCESS: ["API_ACCESS", "api", "API"],
  MULTI_DEPARTMENT: ["MULTI_DEPARTMENT"],
  ADVANCED_ROLES: ["ADVANCED_ROLES"],
  AI_CONTROL: ["AI_CONTROL"],
  TELEGRAM: ["TELEGRAM"],
  INSTAGRAM: ["INSTAGRAM"],
  TELEPHONY: ["TELEPHONY"],
  PRIORITY_SUPPORT: ["PRIORITY_SUPPORT"],
};

const FEATURE_HINT: Partial<Record<Feature, string>> = {
  AI_MANAGER: "AI Manager подключается отдельным модулем или пакетом CRM + AI.",
  AI_CONTROL: "BasQar Control не подключён.",
  WHATSAPP: "WhatsApp входит в AI Manager или подключается как дополнение.",
  DOCUMENTS: "Документы доступны в CRM Business и выше.",
  ESF: "ИС ЭСФ доступна с документами в CRM Business и выше.",
  ADVANCED_ANALYTICS: "Расширенная аналитика доступна в CRM Business и выше.",
  API: "API доступен в CRM Pro и BasQar Full.",
  MASS_MESSAGING: "Массовые рассылки доступны в CRM Business и выше.",
  WORKFLOWS: "Workflow доступен в CRM Business и выше.",
};

export type SubscriptionSnapshot = {
  organizationStatus: string;
  subscriptionStatus: string;
  previewMode: boolean;
  entitled: boolean;
  grandfathered: boolean;
  planId: string | null;
  planCode: string | null;
  planName: string | null;
  startsAt: string | null;
  expiresAt: string | null;
  tenantPlanId: string | null;
  billingPeriod?: string | null;
  amountMinor?: number | null;
  currency?: string | null;
};

export type TenantPlanRow = {
  id: string;
  status: string;
  startsAt: Date;
  endsAt: Date | null;
  billingPeriod?: string | null;
  amountMinor?: number | null;
  currency?: string | null;
  itemsJson?: unknown;
  limitsSnapshotJson?: unknown;
  featuresSnapshotJson?: unknown;
  priceSnapshotJson?: unknown;
  confirmedByUserId?: string | null;
  confirmedAt?: Date | null;
  paymentMethod?: string | null;
  notes?: string | null;
  plan: {
    id: string;
    code: string;
    name: string;
    kind?: string | null;
    featuresJson: unknown;
    limitsJson: unknown;
  };
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function isLegacyPlan(plan: { code?: string | null; kind?: string | null } | null | undefined) {
  const kind = String(plan?.kind || "").toLowerCase();
  const code = String(plan?.code || "");
  return !kind || kind === "legacy" || code === "starter";
}

export async function loadCurrentTenantPlan(prisma: PrismaClient, tenantId: string): Promise<TenantPlanRow | null> {
  return prisma.tenantPlan.findFirst({
    where: { tenantId },
    orderBy: { startsAt: "desc" },
    include: {
      plan: {
        select: { id: true, code: true, name: true, kind: true, featuresJson: true, limitsJson: true },
      },
    },
  });
}

export function snapshotFromPlan(
  organizationStatus: string,
  row: TenantPlanRow | null,
): SubscriptionSnapshot {
  if (!row) {
    return {
      organizationStatus,
      subscriptionStatus: SUBSCRIPTION_STATUSES.ACTIVE,
      previewMode: false,
      entitled: organizationStatus === "active",
      grandfathered: true,
      planId: null,
      planCode: null,
      planName: null,
      startsAt: null,
      expiresAt: null,
      tenantPlanId: null,
    };
  }
  const status = String(row.status || "").toLowerCase() || SUBSCRIPTION_STATUSES.ACTIVE;
  const expired = Boolean(
    row.endsAt &&
      row.endsAt.getTime() < Date.now() &&
      (status === SUBSCRIPTION_STATUSES.ACTIVE || status === SUBSCRIPTION_STATUSES.CANCEL_AT_PERIOD_END),
  );
  const effectiveStatus = expired ? SUBSCRIPTION_STATUSES.EXPIRED : status;
  const previewMode = PREVIEW_STATUSES.has(effectiveStatus as typeof SUBSCRIPTION_STATUSES.NONE);
  const entitled = !previewMode && organizationStatus === "active";
  return {
    organizationStatus,
    subscriptionStatus: effectiveStatus,
    previewMode,
    entitled,
    grandfathered: isLegacyPlan(row.plan) && entitled,
    planId: row.plan.id,
    planCode: row.plan.code,
    planName: row.plan.name,
    startsAt: row.startsAt.toISOString(),
    expiresAt: row.endsAt?.toISOString() || null,
    tenantPlanId: row.id,
    billingPeriod: row.billingPeriod || null,
    amountMinor: row.amountMinor ?? null,
    currency: row.currency || "KZT",
  };
}

export async function getSubscriptionSnapshot(prisma: PrismaClient, tenantId: string): Promise<SubscriptionSnapshot> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { status: true },
  });
  const organizationStatus = tenant?.status || "active";
  const row = await loadCurrentTenantPlan(prisma, tenantId);
  return snapshotFromPlan(organizationStatus, row);
}

function planAllowsFeature(row: TenantPlanRow | null, feature: Feature, entitled: boolean) {
  if (!entitled) return false;
  if (!row || isLegacyPlan(row.plan)) return true;
  const snap = asRecord(row.featuresSnapshotJson);
  const json = Object.keys(snap).length ? snap : asRecord(row.plan.featuresJson);
  const version = Number(asRecord(row.priceSnapshotJson).planVersion || 1);
  if (version < 2 && !(feature in json)) {
    if (feature === FEATURES.IMPORT || feature === FEATURES.EXPORT) return Boolean(json.CRM_CORE);
    if (feature === FEATURES.FILE_STORAGE) return Number(asRecord(row.limitsSnapshotJson).STORAGE_GB ?? asRecord(row.plan.limitsJson).STORAGE_GB ?? 0) > 0;
  }
  for (const key of PLAN_FEATURE_ALIASES[feature] || [feature]) {
    if (key in json) return Boolean(json[key]);
  }
  return false;
}

export async function loadBillingOverride(prisma: PrismaClient, tenantId: string) {
  return prisma.tenantBillingOverride.findUnique({ where: { tenantId } }).catch(() => null);
}

export function entitlementsFromSnapshot(snap: SubscriptionSnapshot, row: TenantPlanRow | null, override?: { featuresJson?: unknown } | null) {
  const map = {} as Record<Feature, boolean>;
  const extra = asRecord(override?.featuresJson);
  for (const feature of FEATURE_LIST) {
    map[feature] = snap.entitled && (typeof extra[feature] === "boolean" ? Boolean(extra[feature]) : planAllowsFeature(row, feature, snap.entitled));
  }
  return map;
}

export function limitsFromPlan(row: TenantPlanRow | null, override?: { limitsJson?: unknown } | null): Record<string, number> {
  const base = emptyLimits();
  if (!row) {
    base[LIMITS.USERS] = 99;
    base.members = 99;
    base[LIMITS.WHATSAPP_CONNECTIONS] = 99;
    base.whatsappActive = 99;
    base[LIMITS.AI_USAGE] = 999999;
    base[LIMITS.PIPELINES] = 99;
    base[LIMITS.DEPARTMENTS] = 99;
    base[LIMITS.STORAGE_GB] = 999;
    return applyLimitOverride(base, override);
  }
  if (isLegacyPlan(row.plan)) {
    const json = asRecord(row.plan.limitsJson);
    base[LIMITS.USERS] = Number(json.members || json.USERS || 20);
    base.members = base[LIMITS.USERS];
    base[LIMITS.WHATSAPP_CONNECTIONS] = Number(json.whatsappActive || json.WHATSAPP_CONNECTIONS || 20);
    base.whatsappActive = base[LIMITS.WHATSAPP_CONNECTIONS];
    base[LIMITS.AI_USAGE] = Number(json.AI_USAGE || 999999);
    base[LIMITS.PIPELINES] = Number(json.PIPELINES || 99);
    base[LIMITS.DEPARTMENTS] = Number(json.DEPARTMENTS || 99);
    base[LIMITS.STORAGE_GB] = Number(json.STORAGE_GB || 999);
    return applyLimitOverride(base, override);
  }
  const snapshot = asRecord(row.limitsSnapshotJson);
  const json = Object.keys(snapshot).length ? snapshot : asRecord(row.plan.limitsJson);
  for (const [key, value] of Object.entries(json)) {
    const n = Number(value);
    if (Number.isFinite(n)) base[key] = n;
  }
  if (base.members == null && base[LIMITS.USERS] != null) base.members = base[LIMITS.USERS];
  if (base.whatsappActive == null && base[LIMITS.WHATSAPP_CONNECTIONS] != null) {
    base.whatsappActive = base[LIMITS.WHATSAPP_CONNECTIONS];
  }
  return applyLimitOverride(base, override);
}

function emptyLimits(): Record<string, number> {
  return {
    [LIMITS.USERS]: 0,
    [LIMITS.PIPELINES]: 0,
    [LIMITS.DEPARTMENTS]: 0,
    [LIMITS.WHATSAPP_CONNECTIONS]: 0,
    [LIMITS.AI_USAGE]: 0,
    [LIMITS.STORAGE_GB]: 0,
  };
}

function applyLimitOverride(base: Record<string, number>, override?: { limitsJson?: unknown } | null) {
  const extra = asRecord(override?.limitsJson);
  for (const [key, value] of Object.entries(extra)) {
    const n = Number(value);
    if (Number.isFinite(n)) base[key] = n;
  }
  if (extra.USERS != null) base.members = base.USERS;
  if (extra.WHATSAPP_CONNECTIONS != null) base.whatsappActive = base.WHATSAPP_CONNECTIONS;
  if (extra.FILE_STORAGE_MB != null) base.STORAGE_GB = base.FILE_STORAGE_MB < 0 ? -1 : base.FILE_STORAGE_MB / 1024;
  return base;
}

export async function getEntitlements(prisma: PrismaClient, tenantId: string) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { status: true } });
  const organizationStatus = tenant?.status || "active";
  const [row, override] = await Promise.all([
    loadCurrentTenantPlan(prisma, tenantId),
    loadBillingOverride(prisma, tenantId),
  ]);
  const snapshot = snapshotFromPlan(organizationStatus, row);
  return {
    snapshot,
    entitlements: entitlementsFromSnapshot(snapshot, row, override),
    limits: snapshot.entitled || snapshot.grandfathered ? limitsFromPlan(row, override) : emptyLimits(),
    plan: row,
    override,
  };
}

export async function canUseFeature(prisma: PrismaClient, tenantId: string, feature: Feature) {
  const resolved = await getEntitlements(prisma, tenantId);
  return Boolean(resolved.entitlements[feature]);
}

export async function hasFeature(prisma: PrismaClient, tenantId: string, feature: Feature) {
  return canUseFeature(prisma, tenantId, feature);
}

export async function getLimit(prisma: PrismaClient, tenantId: string, limit: LimitKey | string) {
  const resolved = await getEntitlements(prisma, tenantId);
  return Number(resolved.limits[limit] || 0);
}

export async function requireFeature(prisma: PrismaClient, auth: AuthContext, feature: Feature) {
  const membership = requireTenant(auth);
  const allowed = await canUseFeature(prisma, membership.tenantId, feature);
  if (allowed) return membership;
  throw new ApiError(
    403,
    "feature_required",
    FEATURE_HINT[feature] || `${FEATURE_LABEL[feature] || "Эта функция"} доступна после подключения тарифа.`,
    undefined,
    { feature, billingPath: "/billing", label: FEATURE_LABEL[feature] },
  );
}

export async function requireAnyFeature(prisma: PrismaClient, auth: AuthContext, features: Feature[]) {
  const membership = requireTenant(auth);
  const access = await getEntitlements(prisma, membership.tenantId);
  if (features.some(feature => access.entitlements[feature])) return membership;
  throw new ApiError(403, "feature_required", "Для AI-команд подключите AI Manager или BasQar Control.", undefined, { feature: features[0], billingPath: "/billing" });
}

export function matchAlternativeFeatures(method: string, path: string): Feature[] {
  return method.toUpperCase() === "POST" && /^\/api\/v1\/(tasks|campaigns)\/(parse|from-command|parse-command)/.test(path)
    ? [FEATURES.AI_MANAGER, FEATURES.AI_CONTROL] : [];
}

export async function requireLimitAvailable(
  prisma: PrismaClient,
  tenantId: string,
  limit: LimitKey,
  used: number,
  message: string,
) {
  const resolved = await getEntitlements(prisma, tenantId);
  if (resolved.snapshot.grandfathered) return resolved;
  const cap = Number(resolved.limits[limit] || 0);
  if (cap >= 0 && used >= cap) {
    throw new ApiError(403, "limit_exceeded", message, undefined, {
      limit,
      used,
      cap,
      billingPath: "/billing",
    });
  }
  return resolved;
}

type FeatureRule = { methods?: string[]; pattern: RegExp; feature: Feature };

const PAID_RULES: FeatureRule[] = [
  { methods: ["POST", "PATCH"], pattern: /^\/api\/v1\/contacts(?:\/[^/]+)?$/, feature: FEATURES.CLIENTS },
  { methods: ["POST", "PATCH"], pattern: /^\/api\/v1\/companies(?:\/[^/]+)?$/, feature: FEATURES.COMPANIES },
  { methods: ["POST", "PATCH"], pattern: /^\/api\/v1\/inquiries(?:\/[^/]+)?$/, feature: FEATURES.LEADS },
  { methods: ["POST", "PATCH"], pattern: /^\/api\/v1\/deals(?:\/[^/]+)?$/, feature: FEATURES.DEALS },

  { pattern: /^\/api\/v1\/contacts\/import$/, feature: FEATURES.IMPORT },
  { pattern: /^\/api\/v1\/settings\/legal-profile\/marks\//, feature: FEATURES.FILE_STORAGE },
  { pattern: /^\/api\/v1\/(documents|contracts|invoices|electronic-documents)(\/|$)/, feature: FEATURES.DOCUMENTS },
  { pattern: /^\/api\/v1\/deals\/[^/]+\/(contract|invoice|avr)/, feature: FEATURES.DOCUMENTS },
  { pattern: /^\/api\/v1\/(tasks|campaigns)\/[^/]+\/attachments$/, feature: FEATURES.FILE_STORAGE },
  { pattern: /^\/api\/v1\/ai-manager\//, feature: FEATURES.AI_MANAGER },
  { pattern: /^\/api\/v1\/integrations\/whatsapp-seller\/(connect|rotate-secret|disconnect|sync)$/, feature: FEATURES.WHATSAPP },
  { pattern: /^\/api\/v1\/integrations\/esf\//, feature: FEATURES.ESF },
  { pattern: /^\/api\/v1\/electronic-documents\/[^/]+\/esf-/, feature: FEATURES.ESF },
  { pattern: /^\/api\/v1\/deals\/[^/]+\/esf-sync$/, feature: FEATURES.ESF },
  { pattern: /^\/api\/v1\/conversations\/[^/]+\/messages$/, feature: FEATURES.MESSAGING },
  { pattern: /^\/api\/v1\/contacts\/[^/]+\/whatsapp-chat$/, feature: FEATURES.MESSAGING },
  { pattern: /^\/api\/v1\/inquiries\/[^/]+\/ai\//, feature: FEATURES.AI_MANAGER },
  { pattern: /^\/api\/v1\/conversations\/[^/]+\/(return-to-ai|analyze-context|instruction)$/, feature: FEATURES.AI_MANAGER },
  { pattern: /^\/api\/v1\/ai\/sandbox$/, feature: FEATURES.AI_MANAGER },
  { pattern: /^\/api\/v1\/settings\/ai-automation$/, feature: FEATURES.AI_MANAGER },
  { pattern: /^\/api\/v1\/management\/(ai-pause|claim-all-ai)$/, feature: FEATURES.AI_MANAGER },
  { pattern: /^\/api\/v1\/situation\/ask$/, feature: FEATURES.AI_MANAGER },
  { pattern: /^\/api\/v1\/campaigns/, feature: FEATURES.MASS_MESSAGING },
  { pattern: /^\/api\/v1\/integrations\/[^/]+\/(test-mode|rotate-secret)$/, feature: FEATURES.CHANNELS },
  { pattern: /^\/api\/v1\/telegram\/begin-link$/, feature: FEATURES.CHANNELS },
  { pattern: /^\/api\/v1\/contracts\/[^/]+\/send-for-sign$/, feature: FEATURES.DOCUMENTS },
  { pattern: /^\/api\/v1\/documents\/from-command$/, feature: FEATURES.DOCUMENTS },
  { pattern: /^\/api\/v1\/electronic-documents\/[^/]+\/esf-send/, feature: FEATURES.ESF },
  { pattern: /^\/api\/v1\/tasks\/[^/]+\/(execute|execute-batch|prepare-execution|confirm-execution)$/, feature: FEATURES.AUTOMATION },
  { methods: ["PATCH"], pattern: /^\/api\/v1\/workspace\/control$/, feature: FEATURES.AI_CONTROL },
  { pattern: /^\/api\/v1\/workspace\/control\/access/, feature: FEATURES.AI_CONTROL },
  { pattern: /^\/api\/v1\/workspace\/control\/identities/, feature: FEATURES.AI_CONTROL },
];

export function matchPaidFeatures(method: string, path: string): Feature[] {
  const m = method.toUpperCase();
  if ((m === "GET" || m === "HEAD") && /^\/api\/v1\/contacts\/export(?:\?|$)/.test(path)) return [FEATURES.EXPORT];
  if ((m === "GET" || m === "HEAD") && /^\/api\/v1\/analytics\/(trend|drilldown)(?:\?|$)/.test(path)) return [FEATURES.ADVANCED_ANALYTICS];
  if (m === "GET" || m === "HEAD" || m === "OPTIONS" || m === "DELETE") return [];
  const pathOnly = String(path || "").split("?")[0];
  if (
    pathOnly.startsWith("/api/v1/auth") ||
    pathOnly.startsWith("/api/v1/me") ||
    pathOnly.startsWith("/api/v1/admin") ||
    pathOnly.startsWith("/api/v1/support") ||
    pathOnly.startsWith("/api/v1/billing") ||
    pathOnly.startsWith("/api/v1/internal") ||
    pathOnly.startsWith("/api/v1/invitations")
  ) {
    return [];
  }
  return [...new Set(PAID_RULES.filter(rule => (!rule.methods || rule.methods.includes(m)) && rule.pattern.test(pathOnly)).map(rule => rule.feature))];
}

export function matchPaidFeature(method: string, path: string): Feature | null {
  return matchPaidFeatures(method, path)[0] || null;
}

export { FEATURES };

export const resolveEffectiveEntitlements = getEntitlements;

export { getUsage, canConsume } from "./billingResourceService.ts";
