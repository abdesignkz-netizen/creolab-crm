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

export async function initializeTenantUsage(tx: Db, tenantId: string, limits: Record<string, number>) {
  const existing = await tx.tenantUsage.findUnique({ where: { tenantId } });
  if (existing) {
    await tx.tenantUsage.update({ where: { tenantId }, data: { limitsJson: limits } });
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
    tx.integration.count({ where: { tenantId, type: 'whatsapp_seller', NOT: { OR: [{ status: 'disabled' }, { connectionStatus: 'DISCONNECTED' }] } } }),
  ]);
  const databaseBytes = await measureDatabaseBytes(tx, tenantId);
  await tx.tenantUsage.create({ data: { tenantId, limitsJson: limits, period: billingMonth(), databaseBytes,
    fileBytes: BigInt(files._sum.sizeBytes || 0), lastActivityAt: new Date(),
    countersJson: { CLIENTS: clients, ACTIVE_DEALS: deals, USERS: users, MONTHLY_LEADS: leads, WHATSAPP_CONNECTIONS: whatsapp } } });
}

export async function getUsage(prisma: PrismaClient, tenantId: string, code: string): Promise<number> {
  const row = await prisma.tenantUsage.findUnique({ where: { tenantId } });
  if (row) {
    if (code === 'DATABASE_MB') return Number(row.databaseBytes) / 1048576;
    if (code === 'FILE_STORAGE_MB') return Number(row.fileBytes) / 1048576;
    if (code === 'MONTHLY_LEADS' && row.period !== billingMonth()) return 0;
    if (code in (row.countersJson as object)) return Number((row.countersJson as Record<string, number>)[code]);
  }
  if (code === 'CLIENTS') return prisma.contact.count({ where: { tenantId } });
  if (code === 'ACTIVE_DEALS') return prisma.deal.count({ where: { tenantId, outcome: 'open', closedAt: null } });
  if (code === 'MONTHLY_LEADS') return prisma.inquiry.count({ where: { tenantId, receivedAt: { gte: billingMonthStart() } } });
  if (code === 'USERS') return prisma.membership.count({ where: { tenantId, active: true } });
  if (code === 'FILE_STORAGE_MB') return Number((await prisma.attachment.aggregate({ where: { tenantId, NOT: { parentType: { startsWith: 'support' } } }, _sum: { sizeBytes: true } }))._sum.sizeBytes || 0) / 1048576;
  if (code === 'PIPELINES') return (await prisma.dealStage.count({ where: { tenantId } })) ? 1 : 0;
  if (code === 'AI_USAGE') return prisma.aIUsageEvent.count({ where: { tenantId, createdAt: { gte: billingMonthStart() }, status: 'ok' } });
  if (code === 'WHATSAPP_CONNECTIONS') return prisma.integration.count({ where: { tenantId, type: 'whatsapp_seller', NOT: { OR: [{ status: 'disabled' }, { connectionStatus: 'DISCONNECTED' }] } } });
  return 0;
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
    if (change.planCode === 'BUNDLE_CRM_AI') bundle.add(row.tenantId!);
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
export async function reserveAiCall(prisma: PrismaClient, tenantId: string, ttlMs = 120000) {
  const id = randomUUID();
  const reserved = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "tenantId" FROM "TenantUsage" WHERE "tenantId" = ${tenantId} FOR UPDATE`;
    const row = await tx.tenantUsage.findUnique({ where: { tenantId } });
    if (!row) return null; // Legacy contracts retain their existing usage checks.
    const cap = Number((row.limitsJson as Record<string, number>).AI_USAGE ?? 0);
    const counters = row.countersJson as Record<string, any>;
    const reservations = Object.fromEntries(Object.entries(counters.aiReservations || {}).filter(([, until]) => Number(until) > Date.now())) as Record<string, number>;
    const used = await tx.aIUsageEvent.count({ where: { tenantId, createdAt: { gte: billingMonthStart() }, status: 'ok' } });
    if (cap >= 0 && used + Object.keys(reservations).length >= cap) throw new ApiError(403, 'limit_exceeded', 'AI-лимит исчерпан. Подключите дополнительный пакет.');
    reservations[id] = Date.now() + ttlMs;
    await tx.tenantUsage.update({ where: { tenantId }, data: { countersJson: { ...counters, aiReservations: reservations } } });
    return id;
  });
  return async () => {
    if (!reserved) return;
    await prisma.$transaction(async tx => {
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
