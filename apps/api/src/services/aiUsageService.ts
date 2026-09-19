import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@creolab/db";
import { requirePlatformAdmin } from "../lib/access.ts";
import type { AuthContext } from "../lib/types.ts";
import { resolvePeriodRange, type PeriodPreset } from "./periodRange.ts";

export const AI_FEATURES = [
  "AI_MANAGER_REPLY",
  "AI_CRM_COMMAND",
  "AI_SUMMARY",
  "AI_REPORT",
  "AI_LEAD_ANALYSIS",
  "AI_FOLLOW_UP",
  "AI_DOCUMENT",
  "AI_CLASSIFICATION",
  "AI_KNOWLEDGE",
  "AI_OTHER",
] as const;

export type AiFeature = (typeof AI_FEATURES)[number];

export type RecordAiUsageInput = {
  tenantId?: string | null;
  integrationId?: string | null;
  conversationId?: string | null;
  userId?: string | null;
  provider: string;
  model: string;
  feature: string;
  providerRequestId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedInputTokens?: number | null;
  reasoningTokens?: number | null;
  totalTokens?: number | null;
  latencyMs?: number | null;
  status: "ok" | "failed";
  errorCode?: string | null;
  at?: Date;
};

const DEFAULT_PRICES: Array<{
  provider: string;
  model: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
}> = [
  { provider: "openai", model: "gpt-4o-mini", inputPerMillion: 0.15, outputPerMillion: 0.6, cachedInputPerMillion: 0.075 },
  { provider: "openai", model: "gpt-4o", inputPerMillion: 2.5, outputPerMillion: 10, cachedInputPerMillion: 1.25 },
  { provider: "openai", model: "gpt-4.1-mini", inputPerMillion: 0.4, outputPerMillion: 1.6 },
  { provider: "anymodel", model: "gpt-4o-mini", inputPerMillion: 0.15, outputPerMillion: 0.6 },
];

function money(value: number) {
  return value.toFixed(8);
}

function num(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export async function ensureDefaultModelPricing(prisma: PrismaClient) {
  const count = await prisma.aIModelPricing.count();
  if (count > 0) return;
  const from = new Date("2024-01-01T00:00:00Z");
  await prisma.aIModelPricing.createMany({
    data: DEFAULT_PRICES.map((row) => ({
      id: randomUUID(),
      provider: row.provider,
      model: row.model,
      pricingVersion: "2024-01",
      inputPerMillion: row.inputPerMillion,
      outputPerMillion: row.outputPerMillion,
      cachedInputPerMillion: row.cachedInputPerMillion ?? null,
      currency: "USD",
      effectiveFrom: from,
    })),
  });
}

export async function resolveModelPricing(
  prisma: PrismaClient,
  provider: string,
  model: string,
  at = new Date(),
) {
  await ensureDefaultModelPricing(prisma);
  const rows = await prisma.aIModelPricing.findMany({
    where: {
      provider,
      model,
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
    orderBy: { effectiveFrom: "desc" },
    take: 1,
  });
  return rows[0] || null;
}

export async function recordAiUsage(prisma: PrismaClient | null | undefined, input: RecordAiUsageInput) {
  if (!prisma) return null;
  try {
    if (input.providerRequestId) {
      const existing = await prisma.aIUsageEvent.findFirst({
        where: { provider: input.provider, providerRequestId: input.providerRequestId },
      });
      if (existing) return existing;
    }
    const pricing = input.status === "ok" ? await resolveModelPricing(prisma, input.provider, input.model, input.at || new Date()) : null;
    const inputTokens = input.inputTokens ?? null;
    const outputTokens = input.outputTokens ?? null;
    const cachedInputTokens = input.cachedInputTokens ?? null;
    const totalTokens =
      input.totalTokens ??
      (inputTokens != null || outputTokens != null ? (inputTokens || 0) + (outputTokens || 0) + (cachedInputTokens || 0) : null);
    let inputCost: string | null = null;
    let outputCost: string | null = null;
    let cachedInputCost: string | null = null;
    let totalCost: string | null = null;
    let pricingMissing = !pricing;
    if (pricing && input.status === "ok") {
      const inPrice = num(pricing.inputPerMillion);
      const outPrice = num(pricing.outputPerMillion);
      const cachedPrice = pricing.cachedInputPerMillion != null ? num(pricing.cachedInputPerMillion) : inPrice;
      inputCost = money(((inputTokens || 0) / 1_000_000) * inPrice);
      outputCost = money(((outputTokens || 0) / 1_000_000) * outPrice);
      cachedInputCost = money(((cachedInputTokens || 0) / 1_000_000) * cachedPrice);
      totalCost = money(num(inputCost) + num(outputCost) + num(cachedInputCost));
      pricingMissing = false;
    }
    return await prisma.aIUsageEvent.create({
      data: {
        tenantId: input.tenantId || null,
        integrationId: input.integrationId || null,
        conversationId: input.conversationId || null,
        userId: input.userId || null,
        provider: input.provider,
        model: input.model,
        feature: input.feature || "AI_OTHER",
        providerRequestId: input.providerRequestId || null,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        reasoningTokens: input.reasoningTokens ?? null,
        totalTokens,
        inputUnitPrice: pricing ? pricing.inputPerMillion : null,
        outputUnitPrice: pricing ? pricing.outputPerMillion : null,
        cachedInputUnitPrice: pricing?.cachedInputPerMillion ?? null,
        inputCost,
        outputCost,
        cachedInputCost,
        totalCost,
        currency: pricing?.currency || "USD",
        pricingVersion: pricing?.pricingVersion || null,
        pricingMissing,
        latencyMs: input.latencyMs ?? null,
        status: input.status,
        errorCode: input.errorCode || null,
      },
    });
  } catch (error) {
    console.warn("[ai-usage] record failed", error instanceof Error ? error.message : error);
    return null;
  }
}

function whereRange(from: Date | null, to: Date | null, extra: Prisma.AIUsageEventWhereInput = {}): Prisma.AIUsageEventWhereInput {
  return {
    ...extra,
    ...(from || to
      ? {
          createdAt: {
            ...(from ? { gte: from } : {}),
            ...(to ? { lt: to } : {}),
          },
        }
      : {}),
  };
}

function sumTokens(rows: Array<{ inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; totalCost: Prisma.Decimal | number | string | null }>) {
  let requests = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let cost = 0;
  for (const row of rows) {
    requests += 1;
    inputTokens += row.inputTokens || 0;
    outputTokens += row.outputTokens || 0;
    totalTokens += row.totalTokens || (row.inputTokens || 0) + (row.outputTokens || 0);
    cost += num(row.totalCost);
  }
  return { requests, inputTokens, outputTokens, totalTokens, cost };
}

export async function listPlatformAiUsage(
  prisma: PrismaClient,
  auth: AuthContext,
  query: Record<string, string | undefined>,
) {
  requirePlatformAdmin(auth);
  const preset = (query.period || "last_7") as PeriodPreset;
  const { from, to } = resolvePeriodRange("Asia/Almaty", preset, query.from, query.to);
  const where = whereRange(from, to, {
    ...(query.tenantId ? { tenantId: query.tenantId } : {}),
    ...(query.provider ? { provider: query.provider } : {}),
    ...(query.model ? { model: query.model } : {}),
    ...(query.feature ? { feature: query.feature } : {}),
  });
  const rows = await prisma.aIUsageEvent.findMany({
    where,
    select: {
      tenantId: true,
      provider: true,
      model: true,
      feature: true,
      inputTokens: true,
      outputTokens: true,
      totalTokens: true,
      totalCost: true,
      createdAt: true,
      pricingMissing: true,
    },
  });
  const totals = sumTokens(rows);
  const byTenant = new Map<string, ReturnType<typeof sumTokens> & { lastAt: Date | null }>();
  const tenantIds = [...new Set(rows.map((row) => row.tenantId).filter((id): id is string => Boolean(id)))];
  const tenants = tenantIds.length
    ? await prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true, slug: true } })
    : [];
  const tenantName = new Map(tenants.map((row) => [row.id, row.name]));
  for (const row of rows) {
    const key = row.tenantId || "unscoped";
    const current = byTenant.get(key) || { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, lastAt: null };
    const add = sumTokens([row]);
    current.requests += add.requests;
    current.inputTokens += add.inputTokens;
    current.outputTokens += add.outputTokens;
    current.totalTokens += add.totalTokens;
    current.cost += add.cost;
    if (!current.lastAt || row.createdAt > current.lastAt) current.lastAt = row.createdAt;
    byTenant.set(key, current);
  }
  const activeTenants = [...byTenant.keys()].filter((key) => key !== "unscoped").length;
  const previous = resolvePeriodRange("Asia/Almaty", preset, query.from, query.to);
  const prevRows = previous.previousFrom
    ? await prisma.aIUsageEvent.findMany({
        where: whereRange(previous.previousFrom, previous.previousTo, { tenantId: query.tenantId || undefined }),
        select: { tenantId: true, totalTokens: true },
      })
    : [];
  const prevByTenant = new Map<string, number>();
  for (const row of prevRows) {
    if (!row.tenantId) continue;
    prevByTenant.set(row.tenantId, (prevByTenant.get(row.tenantId) || 0) + (row.totalTokens || 0));
  }
  const anomalies = [...byTenant.entries()]
    .filter(([tenantId, stats]) => {
      if (tenantId === "unscoped") return false;
      const usual = prevByTenant.get(tenantId) || 0;
      return usual > 0 && stats.totalTokens > usual * 5 && stats.totalTokens > 50_000;
    })
    .map(([tenantId, stats]) => ({
      tenantId,
      name: tenantName.get(tenantId) || tenantId,
      tokens: stats.totalTokens,
      usual: prevByTenant.get(tenantId) || 0,
    }));

  return {
    period: { preset, from, to },
    totals: {
      requests: totals.requests,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      totalTokens: totals.totalTokens,
      cost: totals.cost,
      currency: "USD",
      activeTenants,
      averageCostPerTenant: activeTenants ? totals.cost / activeTenants : 0,
    },
    tenants: [...byTenant.entries()]
      .map(([tenantId, stats]) => ({
        tenantId: tenantId === "unscoped" ? null : tenantId,
        name: tenantId === "unscoped" ? "Без компании" : tenantName.get(tenantId) || tenantId,
        ...stats,
        avgCostPerRequest: stats.requests ? stats.cost / stats.requests : 0,
        lastActivityAt: stats.lastAt,
      }))
      .sort((a, b) => b.cost - a.cost),
    anomalies,
  };
}

export async function getTenantAiUsage(
  prisma: PrismaClient,
  auth: AuthContext,
  tenantId: string,
  query: Record<string, string | undefined>,
) {
  requirePlatformAdmin(auth);
  const preset = (query.period || "last_30") as PeriodPreset;
  const { from, to } = resolvePeriodRange("Asia/Almaty", preset, query.from, query.to);
  const where = whereRange(from, to, { tenantId });
  const rows = await prisma.aIUsageEvent.findMany({
    where,
    select: {
      provider: true,
      model: true,
      feature: true,
      inputTokens: true,
      outputTokens: true,
      totalTokens: true,
      totalCost: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
  const totals = sumTokens(rows);
  const group = (key: (row: (typeof rows)[number]) => string) => {
    const map = new Map<string, ReturnType<typeof sumTokens>>();
    for (const row of rows) {
      const current = map.get(key(row)) || { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 };
      const add = sumTokens([row]);
      current.requests += add.requests;
      current.inputTokens += add.inputTokens;
      current.outputTokens += add.outputTokens;
      current.totalTokens += add.totalTokens;
      current.cost += add.cost;
      map.set(key(row), current);
    }
    return [...map.entries()].map(([name, stats]) => ({ name, ...stats })).sort((a, b) => b.cost - a.cost);
  };
  const byDay = new Map<string, ReturnType<typeof sumTokens>>();
  for (const row of rows) {
    const day = row.createdAt.toISOString().slice(0, 10);
    const current = byDay.get(day) || { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 };
    const add = sumTokens([row]);
    current.requests += add.requests;
    current.inputTokens += add.inputTokens;
    current.outputTokens += add.outputTokens;
    current.totalTokens += add.totalTokens;
    current.cost += add.cost;
    byDay.set(day, current);
  }
  const config = await prisma.aIConfiguration.findFirst({ where: { tenantId }, select: { limitsJson: true } });
  const limits = (config?.limitsJson || {}) as { monthlyAiSoftLimit?: number; monthlyAiHardLimit?: number };
  return {
    tenantId,
    period: { preset, from, to },
    totals,
    byFeature: group((row) => row.feature),
    byProvider: group((row) => row.provider),
    byModel: group((row) => `${row.provider}:${row.model}`),
    byDay: [...byDay.entries()].map(([day, stats]) => ({ day, ...stats })),
    limits: {
      monthlyAiSoftLimit: limits.monthlyAiSoftLimit ?? null,
      monthlyAiHardLimit: limits.monthlyAiHardLimit ?? null,
    },
  };
}
