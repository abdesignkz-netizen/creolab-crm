import type { PrismaClient } from "@creolab/db";
import {
  CATALOG_BY_CODE,
  CATALOG_VERSION,
  FEATURE_LIST,
  LIMIT_LIST,
  PRICING_CATALOG,
  PUBLIC_OFFERS,
  type BillingPeriod,
  type CatalogItem,
  type Feature,
  type LimitKey,
} from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { syncPricingCatalog } from "@creolab/db";

export type QuoteAddonInput = { code: string; qty?: number };

export type QuotedLine = {
  code: string;
  name: string;
  kind: string;
  qty: number;
  unitAmountMinor: number;
  amountMinor: number;
  chargeType: string;
  catalogStatus: string;
};

export type PricingQuote = {
  planCode: string | null;
  planName: string | null;
  billingPeriod: BillingPeriod;
  lines: QuotedLine[];
  includedCodes: string[];
  baseAmountMinor: number;
  discountAmountMinor: number;
  finalAmountMinor: number;
  currency: "KZT";
  features: Record<Feature, boolean>;
  limits: Record<string, number>;
  recommendation: { code: string; name: string; saveMinor: number; message: string } | null;
  snapshot: {
    planVersion: number;
    enterpriseTerms?: { sla: string; integrations: string };
    basePriceAtActivation?: number;
    finalPriceAtActivation?: number;
    planCode: string | null;
    billingPeriod: BillingPeriod;
    addOns: Array<{ code: string; qty: number }>;
    features: Record<string, boolean>;
    limits: Record<string, number>;
    lines: QuotedLine[];
    finalAmountMinor: number;
  };
};

type DbPlan = {
  code: string;
  name: string;
  kind: string;
  product: string;
  monthlyPriceMinor: number;
  yearlyPriceMinor: number;
  public: boolean;
  active: boolean;
  catalogStatus: string;
  chargeType: string;
  recommended: boolean;
  sortOrder: number;
  description: string;
  includedJson: unknown;
  featuresJson: unknown;
  limitsJson: unknown;
  version: number;
};

const catalogReady = new WeakMap<PrismaClient, Promise<void>>();

export async function ensurePricingCatalog(prisma: PrismaClient) {
  let ready = catalogReady.get(prisma);
  if (!ready) {
    ready = (typeof prisma.$transaction === "function" ? prisma.$transaction(tx => syncPricingCatalog(tx), { timeout: 30000 }) : syncPricingCatalog(prisma)).catch(error => {
      catalogReady.delete(prisma); throw error;
    });
    catalogReady.set(prisma, ready);
  }
  await ready;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function catalogFallback(code: string): CatalogItem | null {
  return CATALOG_BY_CODE[code] || null;
}

function fromDb(row: DbPlan): CatalogItem {
  const fallback = catalogFallback(row.code);
  return {
    version: row.version,
    code: row.code,
    name: row.name,
    product: (row.product || fallback?.product || "CRM") as CatalogItem["product"],
    kind: (row.kind || fallback?.kind || "plan") as CatalogItem["kind"],
    monthlyPriceMinor: row.monthlyPriceMinor ?? fallback?.monthlyPriceMinor ?? 0,
    yearlyPriceMinor: row.yearlyPriceMinor ?? fallback?.yearlyPriceMinor ?? 0,
    public: row.public,
    active: row.active,
    catalogStatus: (row.catalogStatus || "AVAILABLE") as CatalogItem["catalogStatus"],
    chargeType: (row.chargeType || "RECURRING") as CatalogItem["chargeType"],
    recommended: row.recommended,
    sortOrder: row.sortOrder,
    description: row.description || fallback?.description || "",
    features: { ...(fallback?.features || {}), ...asRecord(row.featuresJson) } as CatalogItem["features"],
    limits: { ...(fallback?.limits || {}), ...asRecord(row.limitsJson) } as CatalogItem["limits"],
    included: Array.isArray(row.includedJson)
      ? (row.includedJson as Array<{ code: string; qty: number }>)
      : fallback?.included,
    limitDelta: fallback?.limitDelta || row.kind === "addon",
  };
}

export async function loadCatalogItem(prisma: PrismaClient, code: string): Promise<CatalogItem | null> {
  await ensurePricingCatalog(prisma);
  const row = await prisma.plan.findUnique({ where: { code } });
  if (row) return fromDb(row as unknown as DbPlan);
  return catalogFallback(code);
}

export async function loadPublicCatalog(prisma: PrismaClient) {
  await ensurePricingCatalog(prisma);
  const rows = await prisma.plan.findMany({ orderBy: { sortOrder: "asc" } });
  const items = rows
    .map((row) => fromDb(row as unknown as DbPlan))
    .filter((item) => item.active && item.public && item.catalogStatus !== "HIDDEN" && item.kind !== "legacy");
  if (items.length) return items;
  return PRICING_CATALOG.filter((item) => item.public && item.catalogStatus !== "HIDDEN");
}

function emptyFeatures(): Record<Feature, boolean> {
  const map = {} as Record<Feature, boolean>;
  for (const feature of FEATURE_LIST) map[feature] = false;
  return map;
}

function emptyLimits(): Record<string, number> {
  const map: Record<string, number> = {};
  for (const key of LIMIT_LIST) map[key] = 0;
  return map;
}

export function mergeEntitlementState(
  base: CatalogItem | null,
  addons: Array<{ item: CatalogItem; qty: number }>,
) {
  const features = emptyFeatures();
  const limits = emptyLimits();
  const applyAbs = (item: CatalogItem) => {
    for (const [key, on] of Object.entries(item.features || {})) {
      if (on) features[key as Feature] = true;
    }
    for (const [key, value] of Object.entries(item.limits || {})) {
      const n = Number(value);
      if (!Number.isFinite(n)) continue;
      limits[key] = n;
    }
  };
  const applyDelta = (item: CatalogItem, qty: number) => {
    for (const [key, on] of Object.entries(item.features || {})) {
      if (on) features[key as Feature] = true;
    }
    for (const [key, value] of Object.entries(item.limits || {})) {
      const n = Number(value);
      if (!Number.isFinite(n)) continue;
      limits[key] = limits[key] === -1 || n === -1 ? -1 : (limits[key] || 0) + n * qty;
    }
  };
  if (base) applyAbs(base);
  for (const row of addons) applyDelta(row.item, row.qty);
  if (features.AVR_ESF) features.ESF = true;
  if (features.ESF) features.AVR_ESF = true;
  if (features.API_ACCESS) features.API = true;
  if (features.API) features.API_ACCESS = true;
  if (features.WHATSAPP) features.MESSAGING = true;
  return { features, limits };
}

function unitPrice(item: CatalogItem, period: BillingPeriod) {
  if (item.chargeType === "ONE_TIME") return item.monthlyPriceMinor;
  return period === "YEARLY" ? item.yearlyPriceMinor : item.monthlyPriceMinor;
}

function includedSet(item: CatalogItem | null) {
  return new Set((item?.included || []).map((row) => row.code));
}

export async function quoteSubscription(
  prisma: PrismaClient,
  input: {
    planCode?: string | null;
    addOns?: QuoteAddonInput[];
    billingPeriod?: string;
  },
): Promise<PricingQuote> {
  const billingPeriod: BillingPeriod = input.billingPeriod === "YEARLY" ? "YEARLY" : "MONTHLY";
  const planCode = String(input.planCode || "").trim() || null;
  const plan = planCode ? await loadCatalogItem(prisma, planCode) : null;
  if (planCode && !plan) throw new ApiError(404, "not_found", "Тариф не найден");
  if (plan && !["plan", "bundle"].includes(plan.kind)) throw new ApiError(422, "invalid_plan", "Выберите базовый тариф, а не дополнение");
  if (plan && (!plan.active || plan.catalogStatus === "HIDDEN")) {
    throw new ApiError(422, "unavailable", "Этот тариф недоступен");
  }
  if (plan && plan.catalogStatus === "COMING_SOON") {
    throw new ApiError(422, "coming_soon", `${plan.name} пока в подготовке`);
  }

  if (planCode === "BASQAR_FREE" && input.addOns?.length) throw new ApiError(422, "upgrade_required", "Для дополнений перейдите на CRM Start.");
  if (input.addOns?.some(row => !Number.isSafeInteger(row.qty ?? 1) || (row.qty ?? 1) < 1 || (row.qty ?? 1) > 99)) throw new ApiError(422, "invalid_quantity", "Количество должно быть целым от 1 до 99");
  if (new Set((input.addOns || []).map(row => row.code)).size !== (input.addOns || []).length) throw new ApiError(422, "duplicate_addon", "Дополнение указано дважды");
  const included = includedSet(plan);
  const addOnInputs = (input.addOns || [])
    .map((row) => ({ code: String(row.code || "").trim(), qty: Math.max(1, Math.min(99, Number(row.qty) || 1)) }))
    .filter((row) => row.code && !included.has(row.code));

  const addonRows: Array<{ item: CatalogItem; qty: number }> = [];
  for (const row of addOnInputs) {
    const item = await loadCatalogItem(prisma, row.code);
    if (!item || item.kind !== "addon") throw new ApiError(422, "invalid", `Дополнение ${row.code} не найдено`);
    if (!item.active || item.catalogStatus === "HIDDEN") throw new ApiError(422, "unavailable", `${item.name} недоступно`);
    if (item.catalogStatus === "COMING_SOON") throw new ApiError(422, "coming_soon", `${item.name} пока в подготовке`);
    addonRows.push({ item, qty: item.chargeType === "ONE_TIME" ? 1 : row.qty });
  }

  const aiTiers = addonRows.filter(row => /^ADDON_AI_(START|BUSINESS|PRO)$/.test(row.item.code));
  if (aiTiers.length > 1 || aiTiers.some(row => row.qty !== 1) || (plan?.features.AI_MANAGER && aiTiers.length)) throw new ApiError(422, "invalid_ai_tier", "Выберите один уровень AI Manager");
  if (addonRows.some(row => row.item.code === "ADDON_AI_PACK") && !plan?.features.AI_MANAGER && !aiTiers.length) throw new ApiError(422, "ai_required", "Сначала подключите AI Manager");
  const lines: QuotedLine[] = [];
  if (plan) {
    const amount = unitPrice(plan, billingPeriod);
    lines.push({
      code: plan.code,
      name: plan.name,
      kind: plan.kind,
      qty: 1,
      unitAmountMinor: amount,
      amountMinor: amount,
      chargeType: plan.chargeType,
      catalogStatus: plan.catalogStatus,
    });
  }
  for (const row of addonRows) {
    const unit = unitPrice(row.item, billingPeriod);
    lines.push({
      code: row.item.code,
      name: row.item.name,
      kind: row.item.kind,
      qty: row.qty,
      unitAmountMinor: unit,
      amountMinor: unit * row.qty,
      chargeType: row.item.chargeType,
      catalogStatus: row.item.catalogStatus,
    });
  }

  const merged = mergeEntitlementState(plan, addonRows);
  const finalAmountMinor = lines.reduce((sum, line) => sum + line.amountMinor, 0);
  const baseAmountMinor = plan ? unitPrice(plan, billingPeriod) : 0;
  const full = await loadCatalogItem(prisma, "BUNDLE_FULL");
  let recommendation: PricingQuote["recommendation"] = null;
  if (full && !lines.some(line => line.chargeType === "ONE_TIME") && plan?.code !== "BUNDLE_FULL" && plan?.code !== "CRM_ENTERPRISE") {
    const fullPrice = unitPrice(full, billingPeriod);
    if (finalAmountMinor > fullPrice &&
        Object.entries(merged.features).every(([key, value]) => !value || full.features[key as Feature]) &&
        Object.entries(merged.limits).every(([key, value]) => Number(full.limits[key as LimitKey] ?? 0) === -1 || (value >= 0 && Number(full.limits[key as LimitKey] ?? 0) >= value))) {
      recommendation = {
        code: full.code,
        name: full.name,
        saveMinor: finalAmountMinor - fullPrice,
        message: `${full.name} — ${fullPrice.toLocaleString("ru-RU")} ₸. Экономия ${ (finalAmountMinor - fullPrice).toLocaleString("ru-RU") } ₸ / ${billingPeriod === "YEARLY" ? "год" : "месяц"}.`,
      };
    }
  }

  return {
    planCode: plan?.code || null,
    planName: plan?.name || null,
    billingPeriod,
    lines,
    includedCodes: [...included],
    baseAmountMinor,
    discountAmountMinor: 0,
    finalAmountMinor,
    currency: "KZT",
    features: merged.features,
    limits: merged.limits,
    recommendation,
    snapshot: {
      planVersion: plan?.version || CATALOG_VERSION,
      basePriceAtActivation: baseAmountMinor,
      finalPriceAtActivation: finalAmountMinor,
      planCode: plan?.code || null,
      billingPeriod,
      addOns: addonRows.map((row) => ({ code: row.item.code, qty: row.qty })),
      features: merged.features,
      limits: merged.limits,
      lines,
      finalAmountMinor,
    },
  };
}

export function serializeCatalogItem(item: CatalogItem, period: BillingPeriod) {
  return {
    id: item.code,
    code: item.code,
    name: item.name,
    product: item.product,
    kind: item.kind,
    description: item.description,
    features: item.features,
    limits: item.limits,
    billingPeriod: period === "YEARLY" ? "year" : "month",
    price: item.code === "CRM_ENTERPRISE" ? null : unitPrice(item, period),
    monthlyPriceMinor: item.monthlyPriceMinor,
    yearlyPriceMinor: item.yearlyPriceMinor,
    chargeType: item.chargeType,
    catalogStatus: item.catalogStatus,
    recommended: Boolean(item.recommended),
    included: item.included || [],
    isActive: item.active,
  };
}

export function publicOfferCards(items: CatalogItem[], period: BillingPeriod) {
  const byCode = Object.fromEntries(items.map((item) => [item.code, item]));
  return PUBLIC_OFFERS.map((offer) => {
    const item = byCode[offer.code] || catalogFallback(offer.code);
    if (!item) return null;
    return {
      ...serializeCatalogItem(item, period),
      group: offer.group,
      title: offer.title,
      subtitle: item.monthlyPriceMinor ? undefined : offer.subtitle,
      recommended: Boolean(("recommended" in offer && offer.recommended) || item.recommended),
    };
  }).filter(Boolean);
}
