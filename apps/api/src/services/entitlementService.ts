import type { PrismaClient } from "@creolab/db";
import {
  FEATURES,
  FEATURE_LIST,
  SUBSCRIPTION_STATUSES,
  type Feature,
} from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { requireTenant } from "../lib/access.ts";
import type { AuthContext } from "../lib/types.ts";

const PREVIEW_STATUSES = new Set([
  SUBSCRIPTION_STATUSES.NONE,
  SUBSCRIPTION_STATUSES.PENDING,
  SUBSCRIPTION_STATUSES.CANCELED,
  SUBSCRIPTION_STATUSES.EXPIRED,
]);

const PLAN_FEATURE_ALIASES: Record<Feature, string[]> = {
  WHATSAPP: ["whatsapp", "WHATSAPP"],
  AI_MANAGER: ["ai", "aiManager", "AI_MANAGER"],
  TEAM: ["team", "members", "TEAM"],
  MASS_MESSAGING: ["campaigns", "massMessaging", "MASS_MESSAGING"],
  DOCUMENTS: ["documents", "DOCUMENTS"],
  ESF: ["esf", "ESF"],
  ADVANCED_ANALYTICS: ["analytics", "ADVANCED_ANALYTICS"],
  API: ["api", "webhook", "API"],
  MESSAGING: ["messaging", "whatsapp", "MESSAGING"],
  AUTOMATION: ["automation", "AUTOMATION"],
  CHANNELS: ["channels", "integrations", "CHANNELS"],
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
};

type TenantPlanRow = {
  id: string;
  status: string;
  startsAt: Date;
  endsAt: Date | null;
  plan: { id: string; code: string; name: string; featuresJson: unknown };
};

export async function loadCurrentTenantPlan(prisma: PrismaClient, tenantId: string): Promise<TenantPlanRow | null> {
  return prisma.tenantPlan.findFirst({
    where: { tenantId },
    orderBy: { startsAt: "desc" },
    include: { plan: { select: { id: true, code: true, name: true, featuresJson: true } } },
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
  const previewMode = PREVIEW_STATUSES.has(status as typeof SUBSCRIPTION_STATUSES.NONE);
  const entitled = !previewMode && organizationStatus === "active";
  return {
    organizationStatus,
    subscriptionStatus: status,
    previewMode,
    entitled,
    grandfathered: false,
    planId: row.plan.id,
    planCode: row.plan.code,
    planName: row.plan.name,
    startsAt: row.startsAt.toISOString(),
    expiresAt: row.endsAt?.toISOString() || null,
    tenantPlanId: row.id,
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

function planAllowsFeature(row: TenantPlanRow | null, feature: Feature) {
  const json = row?.plan.featuresJson;
  if (!json || typeof json !== "object" || Array.isArray(json)) return true;
  const record = json as Record<string, unknown>;
  for (const key of PLAN_FEATURE_ALIASES[feature] || [feature]) {
    if (key in record) return Boolean(record[key]);
  }
  return true;
}

export async function canUseFeature(prisma: PrismaClient, tenantId: string, feature: Feature) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { status: true },
  });
  if (!tenant || tenant.status !== "active") return false;
  const row = await loadCurrentTenantPlan(prisma, tenantId);
  const snap = snapshotFromPlan(tenant.status, row);
  if (!snap.entitled) return false;
  return planAllowsFeature(row, feature);
}

export function entitlementsFromSnapshot(snap: SubscriptionSnapshot, row: TenantPlanRow | null) {
  const map = {} as Record<Feature, boolean>;
  for (const feature of FEATURE_LIST) {
    map[feature] = snap.entitled && planAllowsFeature(row, feature);
  }
  return map;
}

export async function getEntitlements(prisma: PrismaClient, tenantId: string) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { status: true } });
  const organizationStatus = tenant?.status || "active";
  const row = await loadCurrentTenantPlan(prisma, tenantId);
  const snapshot = snapshotFromPlan(organizationStatus, row);
  return { snapshot, entitlements: entitlementsFromSnapshot(snapshot, row), plan: row };
}

export async function requireFeature(prisma: PrismaClient, auth: AuthContext, feature: Feature) {
  const membership = requireTenant(auth);
  const allowed = await canUseFeature(prisma, membership.tenantId, feature);
  if (allowed) return membership;
  throw new ApiError(
    403,
    "feature_required",
    "Эта функция доступна после активации тарифа BasQar.",
    undefined,
    { feature, billingPath: "/billing" },
  );
}

type FeatureRule = { methods?: string[]; pattern: RegExp; feature: Feature };

const PAID_RULES: FeatureRule[] = [
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
  { pattern: /^\/api\/v1\/integrations\/[^/]+\/(health-check|test-mode|rotate-secret)$/, feature: FEATURES.CHANNELS },
  { pattern: /^\/api\/v1\/telegram\/begin-link$/, feature: FEATURES.CHANNELS },
  { pattern: /^\/api\/v1\/contracts\/[^/]+\/send-for-sign$/, feature: FEATURES.DOCUMENTS },
  { pattern: /^\/api\/v1\/documents\/from-command$/, feature: FEATURES.DOCUMENTS },
  { pattern: /^\/api\/v1\/electronic-documents\/[^/]+\/esf-send/, feature: FEATURES.ESF },
  { pattern: /^\/api\/v1\/tasks\/[^/]+\/(execute|execute-batch|prepare-execution|confirm-execution)$/, feature: FEATURES.AUTOMATION },
];

export function matchPaidFeature(method: string, path: string): Feature | null {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return null;
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
    return null;
  }
  for (const rule of PAID_RULES) {
    if (rule.methods && !rule.methods.includes(m)) continue;
    if (rule.pattern.test(pathOnly)) return rule.feature;
  }
  return null;
}

export { FEATURES };
