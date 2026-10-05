import { randomUUID } from "node:crypto";
import { BILLING_DATA_TABLES, type Prisma, type PrismaClient } from '@creolab/db';
import { ApiError } from '../errors.ts';
import { requirePlatformAdmin } from '../lib/access.ts';
import type { AuthContext } from '../lib/types.ts';
import { writeAudit } from '../lib/audit.ts';
import { getEntitlements } from './entitlementService.ts';

type Db = PrismaClient | Prisma.TransactionClient;
export const FREE_POLICY_KEY = 'billing.freePolicy';
export const DEFAULT_MAX_ACTIVE_FREE_TENANTS = 5000;
export function billingMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty', year: 'numeric', month: '2-digit' }).formatToParts(now);
  return `${parts.find(p => p.type === 'year')!.value}-${parts.find(p => p.type === 'month')!.value}`;
}
export function billingMonthStart(now = new Date()) { return new Date(`${billingMonth(now)}-01T00:00:00+05:00`); }

export async function initializeTenantUsage(tx: Db, tenantId: string, limits: Record<string, number>): Promise<void> {
  if ('$transaction' in tx) return tx.$transaction(db => initializeTenantUsage(db, tenantId, limits));
  await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "tenantId" FROM "TenantUsage" WHERE "tenantId" = ${tenantId} FOR UPDATE`;
  const existing = await tx.tenantUsage.findUnique({ where: { tenantId } });
  if (existing) {
    const counters = existing.countersJson as Record<string, any>;
    const issued = Number(counters.AI_TRIAL_ISSUED || limits.AI_TRIAL || 0);
    await tx.tenantUsage.update({ where: { tenantId }, data: { limitsJson: limits, countersJson: { ...counters, AI_TRIAL_ISSUED: issued } } });
    return;
  }
  // Serialize activation against other activation/override requests for this tenant.
  await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;
  // Older Word template sources predate Attachment records. Account for those
  // existing files when a tenant first adopts resource quotas; never rewrite them.
  const templates = await tx.contractTemplate.findMany({ where: { tenantId, sourceStorageKey: { not: null } }, select: { id: true, sourceStorageKey: true, sourceFileName: true } });
  for (const template of templates) {
    if (!template.sourceStorageKey || await tx.attachment.findFirst({ where: { tenantId, storageKey: template.sourceStorageKey }, select: { id: true } })) continue;
    const { stat } = await import('node:fs/promises');
    const { resolveUploadPath } = await import('../lib/storage.ts');
    const info = await stat(resolveUploadPath(template.sourceStorageKey)).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info?.isFile()) continue;
    await tx.attachment.create({ data: { tenantId, parentType: 'contract_template_source', parentId: template.id,
      storageKey: template.sourceStorageKey, fileName: template.sourceFileName || 'template.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sizeBytes: info.size } });
  }
  const [clients, deals, users, leads, files, whatsapp] = await Promise.all([
    tx.contact.count({ where: { tenantId } }),
    tx.deal.count({ where: { tenantId, outcome: 'open', closedAt: null } }),
    tx.membership.count({ where: { tenantId, active: true } }),
    tx.inquiry.count({ where: { tenantId, receivedAt: { gte: billingMonthStart() } } }),
    tx.attachment.aggregate({ where: { tenantId, NOT: { parentType: { startsWith: 'support' } } }, _sum: { sizeBytes: true } }),
    tx.integration.count({ where: { tenantId, type: { in: ['whatsapp_seller', 'whatsapp_qr', 'whatsapp_cloud'] }, NOT: { OR: [{ status: 'disabled' }, { connectionStatus: 'DISCONNECTED' }] } } }),
  ]);
  const databaseBytes = await measureDatabaseBytes(tx, tenantId);
  await tx.tenantUsage.create({ data: { tenantId, limitsJson: limits, period: billingMonth(), databaseBytes,
    fileBytes: BigInt(files._sum.sizeBytes || 0), lastActivityAt: new Date(),
    countersJson: { CLIENTS: clients, ACTIVE_DEALS: deals, USERS: users, MONTHLY_LEADS: leads, WHATSAPP_CONNECTIONS: whatsapp,
      AI_TRIAL_ISSUED: Number(limits.AI_TRIAL || 0), resourceAnchor: new Date().toISOString() } } });
}

export async function getUsage(prisma: PrismaClient, tenantId: string, code: string): Promise<number> {
  if (code === 'WHATSAPP_CONNECTIONS') return prisma.integration.count({ where: { tenantId, type: { in: ['whatsapp_seller', 'whatsapp_qr', 'whatsapp_cloud'] }, NOT: { OR: [{ status: 'disabled' }, { connectionStatus: 'DISCONNECTED' }] } } });
  const row = await prisma.tenantUsage.findUnique({ where: { tenantId } });
  if (['AI_CREDITS', 'AI_USAGE', 'AUTOMATION_RUNS', 'DOCUMENTS', 'DOCUMENTS_COUNT', 'CAMPAIGN_RECIPIENTS'].includes(code)) {
    const resource = code === 'AI_USAGE' ? 'AI_CREDITS' : code === 'DOCUMENTS' ? 'DOCUMENTS_COUNT' : code;
    return resourceUsed(prisma, tenantId, resource, await resourcePeriod(prisma, tenantId, resource));
  }
  if (row) {
    if (code === 'DATABASE_MB') return Number(row.databaseBytes) / 1048576;
    if (code === 'FILE_STORAGE_MB') return Number(row.fileBytes) / 1048576;
    if (code === 'STORAGE_BYTES') return Number(row.fileBytes);
    if (code === 'MONTHLY_LEADS' && row.period !== billingMonth()) return 0;
    if (code in (row.countersJson as object)) return Number((row.countersJson as Record<string, number>)[code]);

  }
  if (code === 'CLIENTS') return prisma.contact.count({ where: { tenantId } });
  if (code === 'ACTIVE_DEALS') return prisma.deal.count({ where: { tenantId, outcome: 'open', closedAt: null } });
  if (code === 'MONTHLY_LEADS') return prisma.inquiry.count({ where: { tenantId, receivedAt: { gte: billingMonthStart() } } });
  if (code === 'USERS') return prisma.membership.count({ where: { tenantId, active: true } });
  if (code === 'FILE_STORAGE_MB') return Number((await prisma.attachment.aggregate({ where: { tenantId, NOT: { parentType: { startsWith: 'support' } } }, _sum: { sizeBytes: true } }))._sum.sizeBytes || 0) / 1048576;
  if (code === 'PIPELINES') return (await prisma.dealStage.count({ where: { tenantId } })) ? 1 : 0;
  if (code === 'AI_USAGE' || code === 'AI_CREDITS') return prisma.aIUsageEvent.count({ where: { tenantId, createdAt: { gte: billingMonthStart() }, status: 'ok' } });
  return 0;
}

export const AI_CREDIT_COSTS: Readonly<Record<string, number>> = Object.freeze({
  AI_MANAGER_REPLY: 1, AI_CRM_COMMAND: 1, AI_SUMMARY: 1, AI_REPORT: 1,
  AI_LEAD_ANALYSIS: 1, AI_FOLLOW_UP: 1, AI_DOCUMENT: 1, AI_CLASSIFICATION: 1,
  AI_KNOWLEDGE: 1, AI_VOICE_TRANSCRIPTION: 1, AI_OTHER: 1,
});
export function aiCreditCost(feature: string) { return AI_CREDIT_COSTS[feature] ?? AI_CREDIT_COSTS.AI_OTHER; }

export async function resourcePeriod(db: Db, tenantId: string, resource: string, now = new Date()) {
  const row = await db.tenantUsage.findUnique({ where: { tenantId } });
  // Share the anniversary boundary with the database document trigger.
  if (resource === 'AI_CREDITS' && Number((row?.limitsJson as Record<string, number>)?.AI_TRIAL || 0) > 0) return 'lifetime';
  const anchor = (row?.countersJson as Record<string, string>)?.resourceAnchor || null;
  const result = await db.$queryRaw<Array<{period: string}>>`SELECT basqar_resource_period(${anchor}::text, ${now}::timestamptz) AS period`;
  return result[0].period;
}

export async function resourceUsed(db: Db, tenantId: string, resource: string, period: string) {
  const rows = await db.$queryRaw<Array<{used: bigint}>>`SELECT COALESCE(sum(amount),0)::bigint AS used FROM "BillingResourceUsage"
    WHERE "tenantId" = ${tenantId} AND resource = ${resource} AND period = ${period}`;
  let used = Number(rows[0]?.used || 0);
  // Preserve AI already spent before this ledger was introduced, without double counting new events.
  if (resource === 'AI_CREDITS' && period !== 'lifetime') {
    const start = period.length === 7 ? new Date(period + '-01T00:00:00+05:00') : new Date(period);
    const old = await db.$queryRaw<Array<{used: bigint}>>`SELECT count(*)::bigint AS used FROM "AIUsageEvent" e
      WHERE e."tenantId" = ${tenantId} AND e.status = 'ok' AND e."createdAt" >= ${start}
      AND NOT EXISTS (SELECT 1 FROM "BillingResourceUsage" u WHERE u."tenantId" = e."tenantId" AND u.resource = 'AI_CREDITS' AND u."operationId" = 'ai:' || e.id)`;
    used += Number(old[0]?.used || 0);
  }
  return used;
}

/** Lock, check, and record once. Can share the caller's transaction with the operation. */
export async function consumeResource(db: Db, tenantId: string, resource: string, amount = 1, operationId: string = randomUUID(), enforce = true): Promise<{idempotent: boolean}> {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new ApiError(422, 'invalid_amount', 'Некорректный объём');
  const canonicalResource = resource === 'DOCUMENTS' ? 'DOCUMENTS_COUNT' : resource;
  if ('$transaction' in db) return db.$transaction(tx => consumeResource(tx, tenantId, canonicalResource, amount, operationId, enforce));
  await db.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;
  await db.$queryRaw`SELECT "tenantId" FROM "TenantUsage" WHERE "tenantId" = ${tenantId} FOR UPDATE`;
  const existing = await db.$queryRaw<Array<{amount: number}>>`SELECT amount FROM "BillingResourceUsage" WHERE "tenantId" = ${tenantId} AND resource = ${canonicalResource} AND "operationId" = ${operationId}`;
  if (existing.length) return { idempotent: true };
  const period = await resourcePeriod(db, tenantId, canonicalResource);
  const access = await getEntitlements(db as PrismaClient, tenantId);
  const cap = access.limits[canonicalResource] ?? -1;
  if (enforce && !access.snapshot.entitled) throw new ApiError(403, 'subscription_required', 'Подписка не активна', undefined, {billingPath: '/billing'});
  const used = await resourceUsed(db, tenantId, canonicalResource, period);
  if (enforce && !access.snapshot.grandfathered && cap >= 0 && used + amount > cap) {
    throw new ApiError(403, 'limit_exceeded', 'Лимит ресурса исчерпан. Остальные возможности BasQar продолжают работать.', undefined, { limit: resource, used, cap, billingPath: '/billing' });
  }
  await db.$executeRaw`INSERT INTO "BillingResourceUsage" ("tenantId", resource, "operationId", period, amount) VALUES (${tenantId}, ${canonicalResource}, ${operationId}, ${period}, ${amount}) ON CONFLICT DO NOTHING`;
  return { idempotent: false };
}

// A preflight for friendly errors. Atomic resource enforcement is in the database trigger.
export async function canConsume(prisma: PrismaClient, tenantId: string, code: string, amount = 1) {
  if (!Number.isFinite(amount) || amount < 0) throw new ApiError(422, 'invalid_amount', 'Некорректный объём');
  const resolved = await getEntitlements(prisma, tenantId);
  const cap = resolved.limits[code];
  const used = await getUsage(prisma, tenantId, code);
  return { allowed: resolved.snapshot.grandfathered || (resolved.snapshot.entitled && (cap == null || cap < 0 || used + amount <= cap)), used, cap: cap ?? -1 };
}

export async function freeMetrics(prisma: Db) {
  const rows = await prisma.tenantPlan.findMany({ where: { plan: { code: 'BASQAR_FREE' } }, include: { tenant: { include: { usage: true } } } });
  const cutoff = Date.now() - 30 * 86400000;
  const active = rows.filter(row => row.status === 'active' && row.tenant.status === 'active' && (row.tenant.usage?.lastActivityAt || row.tenant.createdAt).getTime() >= cutoff).length;
  const conversions = await prisma.auditEvent.findMany({ where: { action: 'subscription.activated' }, select: { tenantId: true, changesJson: true } });
  const converted = new Set<string>(); const start = new Set<string>(); const bundle = new Set<string>();
  for (const row of conversions) {
    const change = row.changesJson as Record<string, unknown>;
    if (change.fromPlanCode !== 'BASQAR_FREE' || change.planCode === 'BASQAR_FREE') continue;
    converted.add(row.tenantId!);
    if (change.planCode === 'CRM_START') start.add(row.tenantId!);
    if (['BUNDLE_CRM_AI', 'SALES'].includes(String(change.planCode))) bundle.add(row.tenantId!);
  }
  const policy = await prisma.platformSetting.findUnique({ where: { key: FREE_POLICY_KEY } });
  return { total: rows.length, active, inactive: rows.length - active,
    newThisMonth: await prisma.auditEvent.count({ where: { action: 'subscription.free_activated', createdAt: { gte: billingMonthStart() } } }),
    converted: converted.size, freeToStart: start.size, freeToCrmAi: bundle.size,
    maxActiveFreeTenants: Number((policy?.valueJson as Record<string, unknown>)?.maxActiveFreeTenants ?? DEFAULT_MAX_ACTIVE_FREE_TENANTS) };
}

export async function assertFreeCapacity(tx: Db) {
  await tx.platformSetting.upsert({ where: { key: FREE_POLICY_KEY }, update: {}, create: { key: FREE_POLICY_KEY, valueJson: { maxActiveFreeTenants: DEFAULT_MAX_ACTIVE_FREE_TENANTS } } });
  await tx.$queryRaw`SELECT id FROM "PlatformSetting" WHERE key = ${FREE_POLICY_KEY} FOR UPDATE`;
  const metrics = await freeMetrics(tx);
  if (metrics.active >= metrics.maxActiveFreeTenants) throw new ApiError(503, 'free_capacity', 'Сейчас нет свободных мест на Free. Обратитесь в поддержку BasQar.');
}

export async function updateFreePolicy(prisma: PrismaClient, auth: AuthContext, input: unknown) {
  requirePlatformAdmin(auth);
  const value = Number((input as { maxActiveFreeTenants?: number })?.maxActiveFreeTenants);
  if (!Number.isSafeInteger(value) || value < 0) throw new ApiError(422, 'invalid_limit', 'Укажите целое число не меньше нуля');
  await prisma.$transaction(async tx => {
    await tx.platformSetting.upsert({ where: { key: FREE_POLICY_KEY }, update: { valueJson: { maxActiveFreeTenants: value } }, create: { key: FREE_POLICY_KEY, valueJson: { maxActiveFreeTenants: value } } });
    await writeAudit(tx, { actorUserId: auth.user.id, action: 'billing.free_policy_updated', entityType: 'platform_setting', entityId: FREE_POLICY_KEY, changes: { maxActiveFreeTenants: value } });
  });
  return freeMetrics(prisma);
}

let lastReconcile = 0;
let reconciling = false;
export async function reconcileBillingUsage(prisma: PrismaClient) {
  if (reconciling || Date.now() - lastReconcile < 15 * 60_000) return;
  reconciling = true;
  try {
    const rows = await prisma.tenantUsage.findMany({ orderBy: { reconciledAt: 'asc' }, take: 25 });
    for (const row of rows) {
      await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "tenantId" FROM "TenantUsage" WHERE "tenantId" = ${row.tenantId} FOR UPDATE`;
        const bytes = await measureDatabaseBytes(tx, row.tenantId);
        await tx.tenantUsage.update({ where: { tenantId: row.tenantId }, data: { databaseBytes: bytes, reconciledAt: new Date() } });
      }, { timeout: 30000 });
    }
    lastReconcile = Date.now();
  } finally { reconciling = false; }
}

async function measureDatabaseBytes(tx: Db, tenantId: string) {
  // Static, audited table names only; tenant id remains a bound parameter.
  const union = BILLING_DATA_TABLES.map(table => `SELECT COALESCE(sum(octet_length(to_jsonb(t)::text)),0)::bigint AS bytes FROM "${table}" t WHERE "tenantId" = $1`).join(' UNION ALL ');
  const result = await tx.$queryRawUnsafe<Array<{bytes: bigint}>>(`SELECT sum(bytes)::bigint AS bytes FROM (${union}) totals`, tenantId);
  return BigInt(result[0]?.bytes || 0);
}

export async function assertFileCapacity(db: Db, tenantId: string, bytes: number) {
  const prisma = db as PrismaClient;
  const access = await getEntitlements(prisma, tenantId);
  if (access.snapshot.grandfathered) return;
  if (!access.entitlements.FILE_STORAGE) throw new ApiError(403, 'feature_required', 'Пользовательские файлы доступны начиная с CRM Start.', undefined, { feature: 'FILE_STORAGE', billingPath: '/billing' });
  const quota = await canConsume(prisma, tenantId, 'FILE_STORAGE_MB', bytes / 1048576);
  if (!quota.allowed) throw new ApiError(403, 'limit_exceeded', 'Недостаточно места для файла. Подключите дополнительное хранилище.', undefined, { limit: 'FILE_STORAGE_MB', ...quota, billingPath: '/billing' });
}

// Reserve one in-flight AI call under the quota row lock, without holding a DB
// transaction during an external HTTP request. Expired reservations recover crashes.
export async function reserveAiCall(prisma: PrismaClient, tenantId: string, ttlMs = 120000, amount = 1) {
  const id = randomUUID();
  const reserved = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;
    const access = await getEntitlements(tx as PrismaClient, tenantId);
    if (access.snapshot.grandfathered) return null;
    if (!await tx.tenantUsage.findUnique({ where: { tenantId } })) await initializeTenantUsage(tx, tenantId, access.limits);
    await tx.$queryRaw`SELECT "tenantId" FROM "TenantUsage" WHERE "tenantId" = ${tenantId} FOR UPDATE`;
    const row = (await tx.tenantUsage.findUnique({ where: { tenantId } }))!;
    if (!access.snapshot.entitled) throw new ApiError(403, 'subscription_required', 'Подписка не активна');
    const rowLimits = row.limitsJson as Record<string, number>;
    const cap = Number(rowLimits.AI_USAGE ?? rowLimits.AI_CREDITS ?? access.limits.AI_CREDITS ?? access.limits.AI_USAGE ?? 0);
    const counters = row.countersJson as Record<string, any>;
    const reservations = Object.fromEntries(Object.entries(counters.aiReservations || {}).filter(([, entry]) =>
      (typeof entry === 'number' ? entry : Number((entry as {until: number}).until)) > Date.now())) as Record<string, any>;
    const period = await resourcePeriod(tx, tenantId, 'AI_CREDITS');
    const used = await resourceUsed(tx, tenantId, 'AI_CREDITS', period);
    const reservedAmount = Object.values(reservations).reduce((sum: number, entry: any) => sum + (typeof entry === 'number' ? 1 : entry.amount), 0);
    if (!access.snapshot.grandfathered && cap >= 0 && used + reservedAmount + amount > cap) throw new ApiError(403, 'limit_exceeded', 'AI-кредиты закончились. CRM, документы и ручные задачи продолжают работать.', undefined, {limit: 'AI_CREDITS', used, cap, billingPath: '/billing'});
    reservations[id] = {until: Date.now() + ttlMs, amount};
    await tx.tenantUsage.update({ where: { tenantId }, data: { countersJson: { ...counters, aiReservations: reservations } } });
    return id;
  });
  return async () => {
    if (!reserved) return;
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "tenantId" FROM "TenantUsage" WHERE "tenantId" = ${tenantId} FOR UPDATE`;
      const row = await tx.tenantUsage.findUnique({ where: { tenantId } });
      if (!row) return;
      const counters = row.countersJson as Record<string, any>;
      const reservations = { ...counters.aiReservations };
      delete reservations[id];
      await tx.tenantUsage.update({ where: { tenantId }, data: { countersJson: { ...counters, aiReservations: reservations } } });
    });
  };
}
