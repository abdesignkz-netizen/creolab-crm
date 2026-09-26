import { getUsage, resourcePeriod } from './billingResourceService.ts';
import type { PrismaClient } from '@creolab/db';
import { getEntitlements } from './entitlementService.ts';

export async function collectTenantUsage(prisma: PrismaClient, tenantId: string) {
  const access = await getEntitlements(prisma, tenantId);
  const limits = access.limits;
  const keys = ['CLIENTS', 'ACTIVE_DEALS', 'MONTHLY_LEADS', 'DATABASE_MB', 'FILE_STORAGE_MB', 'USERS', 'WHATSAPP_CONNECTIONS', 'AI_CREDITS', 'AUTOMATION_RUNS', 'DOCUMENTS_COUNT', 'CAMPAIGN_RECIPIENTS', 'PIPELINES'];
  const values = await Promise.all(keys.map(key => getUsage(prisma, tenantId, key)));
  const used = Object.fromEntries(keys.map((key, i) => [key, values[i]]));
  const trial = Number(limits.AI_TRIAL || 0) > 0;
  const period = await resourcePeriod(prisma, tenantId, 'DOCUMENTS_COUNT');
  const rows: Array<{key: string; label: string; used: number; cap: number; unit?: string; measured?: boolean; clientMetric?: boolean}> = [
    {key: 'AI_CREDITS', label: trial ? 'AI-кредиты · пробный пакет один раз' : 'AI-кредиты', used: used.AI_CREDITS, cap: limits.AI_CREDITS ?? limits.AI_USAGE ?? 0, clientMetric: true},
    {key: 'AUTOMATION_RUNS', label: 'Запуски автоматизации', used: used.AUTOMATION_RUNS, cap: limits.AUTOMATION_RUNS ?? -1},
    {key: 'DOCUMENTS_COUNT', label: 'Документы', used: used.DOCUMENTS_COUNT, cap: limits.DOCUMENTS_COUNT ?? -1},
    {key: 'FILE_STORAGE_MB', label: 'Хранилище', used: Math.ceil(used.FILE_STORAGE_MB * 100) / 100, cap: limits.FILE_STORAGE_MB ?? -1, unit: 'МБ'},
    {key: 'USERS', label: 'Пользователи', used: used.USERS, cap: limits.USERS ?? -1},
    {key: 'WHATSAPP_CONNECTIONS', label: 'WhatsApp', used: used.WHATSAPP_CONNECTIONS, cap: limits.WHATSAPP_CONNECTIONS ?? -1},
  ];
  if (access.entitlements.MASS_CAMPAIGNS) rows.push({key: 'CAMPAIGN_RECIPIENTS', label: 'Рассылки · получатели', used: used.CAMPAIGN_RECIPIENTS, cap: limits.CAMPAIGN_RECIPIENTS ?? -1});
  return {planCode: access.snapshot.planCode, clients: used.CLIENTS, activeDeals: used.ACTIVE_DEALS,
    monthlyLeads: used.MONTHLY_LEADS, databaseMb: used.DATABASE_MB, fileMb: used.FILE_STORAGE_MB,
    users: used.USERS, whatsapp: used.WHATSAPP_CONNECTIONS, pipelines: used.PIPELINES,
    storageGb: used.FILE_STORAGE_MB / 1024, aiUsage: used.AI_CREDITS, limits, rows, period,
    massCampaignsEnabled: access.entitlements.MASS_CAMPAIGNS, aiTrial: trial};
}

export function usageWarnings(usage: Awaited<ReturnType<typeof collectTenantUsage>>, daysLeft: number | null) {
  const warnings: Array<{code: string; message: string}> = [];
  for (const row of usage.rows) {
    // Filling a seat or connecting WhatsApp is normal, not an alarm.
    if (row.cap <= 0 || ['USERS', 'WHATSAPP_CONNECTIONS'].includes(row.key)) continue;
    if (row.used / row.cap >= 0.8) warnings.push({code: `${row.key}_${row.used >= row.cap ? 'exhausted' : '80'}`,
      message: `${row.label}: использовано ${row.used} из ${row.cap}. ${row.used >= row.cap ? 'Остальные ресурсы и ручная работа доступны.' : `Осталось ${Math.max(0, row.cap - row.used)}.`}`});
  }
  if (daysLeft !== null && daysLeft >= 0 && daysLeft <= 7) warnings.push({code: 'expires_soon', message: `До окончания подписки: ${daysLeft} дн.`});
  return warnings;
}
