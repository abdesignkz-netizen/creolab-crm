import type { PrismaClient } from "@creolab/db";
import { LIMITS } from "@creolab/contracts";
import { getEntitlements } from "./entitlementService.ts";

export async function collectTenantUsage(prisma: PrismaClient, tenantId: string) {
  const now = new Date();
  const start = new Date(now);
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  const [
    users,
    whatsapp,
    storage,
    aiEvents,
    entitlements,
    pipelineBoards,
  ] = await Promise.all([
    prisma.membership.count({ where: { tenantId, active: true } }),
    prisma.integration.count({
      where: {
        tenantId,
        type: "whatsapp_seller",
        NOT: { OR: [{ status: "disabled" }, { connectionStatus: "DISCONNECTED" }] },
      },
    }),
    prisma.attachment.aggregate({ where: { tenantId }, _sum: { sizeBytes: true } }),
    prisma.aIUsageEvent.count({
      where: { tenantId, createdAt: { gte: start }, status: "ok" },
    }),
    getEntitlements(prisma, tenantId),
    uniquePipelineCount(prisma, tenantId),
  ]);
  const storageGb = Number(((storage._sum.sizeBytes || 0) / (1024 * 1024 * 1024)).toFixed(2));
  const limits = entitlements.limits;
  return {
    users,
    whatsapp,
    pipelines: pipelineBoards,
    storageGb,
    aiUsage: aiEvents,
    limits,
    rows: [
      { key: LIMITS.USERS, label: "Пользователи", used: users, cap: Number(limits[LIMITS.USERS] || limits.members || 0) },
      { key: LIMITS.WHATSAPP_CONNECTIONS, label: "WhatsApp", used: whatsapp, cap: Number(limits[LIMITS.WHATSAPP_CONNECTIONS] || limits.whatsappActive || 0) },
      { key: LIMITS.AI_USAGE, label: "AI", used: aiEvents, cap: Number(limits[LIMITS.AI_USAGE] || 0), clientMetric: true },
      { key: LIMITS.STORAGE_GB, label: "Хранилище", used: storageGb, cap: Number(limits[LIMITS.STORAGE_GB] || 0), unit: "GB" },
      { key: LIMITS.PIPELINES, label: "Воронки", used: pipelineBoards, cap: Number(limits[LIMITS.PIPELINES] || 0) },
    ],
  };
}

async function uniquePipelineCount(prisma: PrismaClient, tenantId: string) {
  const stages = await prisma.dealStage.count({ where: { tenantId } });
  return stages > 0 ? 1 : 0;
}

export function usageWarnings(usage: Awaited<ReturnType<typeof collectTenantUsage>>, daysLeft: number | null) {
  const warnings: Array<{ code: string; message: string }> = [];
  for (const row of usage.rows) {
    if (!row.cap) continue;
    const ratio = row.used / row.cap;
    if (ratio >= 1) {
      warnings.push({
        code: `${row.key}_exhausted`,
        message: row.key === LIMITS.AI_USAGE
          ? "AI-лимит исчерпан. Подключите дополнительный пакет."
          : `Лимит «${row.label}» исчерпан.`,
      });
    } else if (ratio >= 0.8) {
      warnings.push({
        code: `${row.key}_80`,
        message: row.key === LIMITS.AI_USAGE
          ? "Вы использовали 80% AI-лимита."
          : `Использовано более 80% лимита «${row.label}».`,
      });
    }
  }
  if (daysLeft === 0) warnings.push({ code: "expires_today", message: "Подписка заканчивается сегодня." });
  else if (daysLeft === 3) warnings.push({ code: "expires_3", message: "Осталось 3 дня до окончания подписки." });
  else if (daysLeft !== null && daysLeft <= 7 && daysLeft > 3) {
    warnings.push({ code: "expires_7", message: `Осталось ${daysLeft} дн. до окончания подписки.` });
  }
  return warnings;
}
