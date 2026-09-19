import type { Prisma, PrismaClient } from "@creolab/db";
import { decryptSecret } from "../lib/secretBox.ts";

type CacheEntry<T> = { at: number; value: T };

const cache = new Map<string, CacheEntry<unknown>>();
const TTL_MS = 15_000;

export const DEFAULT_PLATFORM_SETTINGS = {
  ai: {
    enabled: true,
    provider: process.env.OPENAI_API_KEY ? "openai" : process.env.ANYMODEL_API_KEY ? "anymodel" : "",
    model: process.env.ANYMODEL_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
  },
  features: {
    forms: true,
    webhook: true,
    whatsapp: true,
    documents: true,
    ai: true,
    esf: false,
  },
  limits: {
    members: 20,
    aiMonthly: 20000,
  },
};

export type PlatformSettings = typeof DEFAULT_PLATFORM_SETTINGS;

function envLlm() {
  const anyModelKey = String(process.env.ANYMODEL_API_KEY || "").trim();
  const openAiKey = String(process.env.OPENAI_API_KEY || "").trim();
  const apiKey = openAiKey || anyModelKey;
  const useAnyModel = Boolean(anyModelKey) && !openAiKey;
  const baseUrl =
    process.env.ANYMODEL_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    (useAnyModel ? "https://anymodel.org/v1" : "https://api.openai.com/v1");
  const model = process.env.ANYMODEL_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini";
  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/$/, ""),
    model,
    provider: openAiKey ? "openai" : useAnyModel ? "anymodel" : "",
  };
}

function readCache<T>(key: string): T | null {
  const row = cache.get(key) as CacheEntry<T> | undefined;
  if (!row) return null;
  if (Date.now() - row.at > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return row.value;
}

function writeCache<T>(key: string, value: T) {
  cache.set(key, { at: Date.now(), value });
}

export function invalidateRuntimeConfig(tenantId?: string) {
  if (tenantId) cache.delete(`tenant:${tenantId}`);
  else {
    for (const key of [...cache.keys()]) {
      if (key.startsWith("tenant:")) cache.delete(key);
    }
  }
  cache.delete("platform");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export async function getPlatformSettings(prisma: PrismaClient | Prisma.TransactionClient): Promise<PlatformSettings> {
  const cached = readCache<PlatformSettings>("platform");
  if (cached) return cached;
  const row = await prisma.platformSetting.findUnique({ where: { key: "defaults" } });
  const stored = asRecord(row?.valueJson);
  const storedAi = asRecord(stored.ai);
  const storedFeatures = asRecord(stored.features);
  const storedLimits = asRecord(stored.limits);
  const value: PlatformSettings = {
    ai: {
      enabled: storedAi.enabled === false ? false : DEFAULT_PLATFORM_SETTINGS.ai.enabled,
      provider: String(storedAi.provider || DEFAULT_PLATFORM_SETTINGS.ai.provider),
      model: String(storedAi.model || DEFAULT_PLATFORM_SETTINGS.ai.model),
    },
    features: {
      forms: storedFeatures.forms !== false,
      webhook: storedFeatures.webhook !== false,
      whatsapp: storedFeatures.whatsapp !== false,
      documents: storedFeatures.documents !== false,
      ai: storedFeatures.ai !== false,
      esf: storedFeatures.esf === true,
    },
    limits: {
      members: Number(storedLimits.members || DEFAULT_PLATFORM_SETTINGS.limits.members),
      aiMonthly: Number(storedLimits.aiMonthly || DEFAULT_PLATFORM_SETTINGS.limits.aiMonthly),
    },
  };
  writeCache("platform", value);
  return value;
}

export async function savePlatformSettings(
  prisma: PrismaClient,
  patch: Record<string, unknown>,
) {
  const current = await getPlatformSettings(prisma);
  const next = {
    ai: { ...current.ai, ...asRecord(patch.ai) },
    features: { ...current.features, ...asRecord(patch.features) },
    limits: { ...current.limits, ...asRecord(patch.limits) },
  };
  await prisma.platformSetting.upsert({
    where: { key: "defaults" },
    update: { valueJson: next as Prisma.InputJsonValue },
    create: { key: "defaults", valueJson: next as Prisma.InputJsonValue },
  });
  invalidateRuntimeConfig();
  return next;
}

type Source = "tenant" | "plan" | "platform" | "env";

export type EffectiveTenantSettings = {
  features: Record<string, { value: boolean; source: Source }>;
  limits: Record<string, { value: number; source: Source }>;
  ai: {
    enabled: boolean;
    provider: string;
    model: string;
    hasOwnCredential: boolean;
    source: Source;
  };
};

export async function getEffectiveTenantSettings(
  prisma: PrismaClient | Prisma.TransactionClient,
  tenantId: string,
): Promise<EffectiveTenantSettings> {
  const cacheKey = `tenant:${tenantId}`;
  const cached = readCache<EffectiveTenantSettings>(cacheKey);
  if (cached) return cached;

  const [platform, tenant, planRow, aiRow] = await Promise.all([
    getPlatformSettings(prisma),
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { settingsJson: true } }),
    prisma.tenantPlan.findFirst({
      where: { tenantId, status: "active" },
      include: { plan: true },
      orderBy: { startsAt: "desc" },
    }),
    prisma.aIConfiguration.findFirst({ where: { tenantId } }),
  ]);
  const tenantSettings = asRecord(tenant?.settingsJson);
  const tenantFeatures = asRecord(tenantSettings.features);
  const tenantLimits = asRecord(tenantSettings.limits);
  const planFeatures = asRecord(planRow?.plan.featuresJson);
  const planLimits = asRecord(planRow?.plan.limitsJson);

  function flag(key: keyof PlatformSettings["features"]): { value: boolean; source: Source } {
    if (key in tenantFeatures) return { value: Boolean(tenantFeatures[key]), source: "tenant" };
    if (key in planFeatures) return { value: Boolean(planFeatures[key]), source: "plan" };
    return { value: Boolean(platform.features[key]), source: "platform" };
  }

  function limit(key: keyof PlatformSettings["limits"]): { value: number; source: Source } {
    if (key in tenantLimits && Number.isFinite(Number(tenantLimits[key]))) {
      return { value: Number(tenantLimits[key]), source: "tenant" };
    }
    if (key in planLimits && Number.isFinite(Number(planLimits[key]))) {
      return { value: Number(planLimits[key]), source: "plan" };
    }
    return { value: platform.limits[key], source: "platform" };
  }

  const tenantAi = aiRow
    ? { provider: aiRow.provider || "", model: aiRow.model || "", enabled: aiRow.enabled, credentialId: aiRow.credentialId }
    : null;
  let aiSource: Source = "platform";
  let provider = platform.ai.provider;
  let model = platform.ai.model;
  if (tenantAi?.provider || tenantAi?.model) {
    provider = tenantAi.provider || provider;
    model = tenantAi.model || model;
    aiSource = "tenant";
  } else if (!provider && !model) {
    const env = envLlm();
    provider = env.apiKey ? (process.env.OPENAI_API_KEY ? "openai" : "anymodel") : "";
    model = env.model;
    aiSource = "env";
  }
  const aiEnabled = flag("ai").value && platform.ai.enabled !== false && (tenantAi ? tenantAi.enabled !== false : true);

  const value: EffectiveTenantSettings = {
    features: {
      forms: flag("forms"),
      webhook: flag("webhook"),
      whatsapp: flag("whatsapp"),
      documents: flag("documents"),
      ai: flag("ai"),
      esf: flag("esf"),
    },
    limits: {
      members: limit("members"),
      aiMonthly: limit("aiMonthly"),
    },
    ai: {
      enabled: aiEnabled,
      provider,
      model,
      hasOwnCredential: Boolean(tenantAi?.credentialId),
      source: aiSource,
    },
  };
  writeCache(cacheKey, value);
  return value;
}

export async function getEffectiveLlmConfig(prisma: PrismaClient, tenantId?: string | null) {
  const env = envLlm();
  if (!tenantId) return env;
  const settings = await getEffectiveTenantSettings(prisma, tenantId);
  if (!settings.ai.enabled) return { ...env, apiKey: "", model: settings.ai.model };
  const aiRow = await prisma.aIConfiguration.findFirst({ where: { tenantId } });
  let apiKey = env.apiKey;
  if (aiRow?.credentialId) {
    const cred = await prisma.credential.findFirst({
      where: { id: aiRow.credentialId, tenantId },
    });
    if (cred?.encryptedValue) {
      try {
        apiKey = decryptSecret(cred.encryptedValue);
      } catch {
        apiKey = "";
      }
    }
  }
  return {
    apiKey,
    baseUrl: env.baseUrl,
    model: settings.ai.model || env.model,
    provider: settings.ai.provider || env.provider || (env.baseUrl.includes("anymodel") ? "anymodel" : "openai"),
  };
}
