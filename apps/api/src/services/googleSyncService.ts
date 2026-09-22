import type { PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import { requireIntegrationsAccess, requireTenant } from "../lib/access.ts";
import type { AuthContext } from "../lib/types.ts";
import { googleKinds } from "./googleConnectionService.ts";
import { syncGoogleCalendar } from "./googleCalendarSyncService.ts";

const running = new Set<string>();
export async function syncGoogleConnection(prisma: PrismaClient, auth: AuthContext, id: string) {
  requireIntegrationsAccess(auth); const { tenantId } = requireTenant(auth);
  const integration = await prisma.integration.findFirst({ where: { id, tenantId, status: "active", type: { in: [...googleKinds] }, publicKey: { startsWith: "google:" } } });
  if (!integration) throw new ApiError(404, "not_found", "Активное подключение не найдено");
  return runGoogleSync(prisma, integration);
}
async function runGoogleSync(prisma: PrismaClient, integration: Awaited<ReturnType<PrismaClient["integration"]["findUniqueOrThrow"]>>) {
  if (running.has(integration.id)) return { running: true };
  running.add(integration.id);
  try {
    let result: unknown;
    if (integration.type === "calendar") result = await syncGoogleCalendar(prisma, integration);
    else { const { syncGoogleIntake } = await import("./googleIntakeService.ts"); result = await syncGoogleIntake(prisma, integration); }
    await prisma.integration.updateMany({ where: { id: integration.id, status: "active", credentialId: integration.credentialId }, data: { healthStatus: "HEALTHY", lastSuccessAt: new Date(), lastError: null, lastErrorCode: null } });
    return result;
  } catch (error) {
    await prisma.integration.updateMany({ where: { id: integration.id, status: "active", credentialId: integration.credentialId }, data: { healthStatus: "ERROR", lastError: error instanceof ApiError ? error.message : "Не удалось синхронизировать Google", lastErrorAt: new Date() } });
    throw error;
  } finally { running.delete(integration.id); }
}
let lastPollAt = 0;
export async function pollGoogleConnections(prisma: PrismaClient) {
  if (Date.now() - lastPollAt < 60000) return;
  lastPollAt = Date.now();
  const rows = await prisma.integration.findMany({ where: { type: { in: [...googleKinds] }, publicKey: { startsWith: "google:" }, status: "active", tenant: { status: "active" } } });
  for (const row of rows) await runGoogleSync(prisma, row).catch(() => undefined);
}
