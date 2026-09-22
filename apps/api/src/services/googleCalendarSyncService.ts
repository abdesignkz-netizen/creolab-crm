import { createHash } from "node:crypto";
import type { PrismaClient, Prisma } from "@creolab/db";
import { ApiError } from "../errors.ts";
import { googleRequest } from "./googleConnectionService.ts";

export function googleAgreementEventId(tenantId: string, agreementId: string) {
  return createHash("sha256").update(`${tenantId}:agreement:${agreementId}`).digest("hex");
}
export async function syncGoogleCalendar(prisma: PrismaClient, integration: Awaited<ReturnType<PrismaClient["integration"]["findUniqueOrThrow"]>>) {
  const settings = integration.schemaJson as { resourceId?: string; lastSyncAt?: string };
  const startedAt = new Date();
  const calendar = encodeURIComponent(settings.resourceId || "primary");
  let cursor: string | undefined, count = 0;
  while (true) {
    const agreements = await prisma.agreement.findMany({ where: { tenantId: integration.tenantId,
      ...(settings.lastSyncAt ? { updatedAt: { gte: new Date(settings.lastSyncAt), lte: startedAt } } : { updatedAt: { lte: startedAt } }),
    }, orderBy: { id: "asc" }, take: 100, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    for (const agreement of agreements) {
      const eventId = googleAgreementEventId(integration.tenantId, agreement.id);
      const path = `/calendar/v3/calendars/${calendar}/events/${eventId}`;
      const removed = !agreement.scheduledAt || agreement.status === "CANCELLED";
      if (removed) {
        const response = await googleRequest(prisma, integration, path, { method: "DELETE" });
        if (!response.ok && ![404,410].includes(response.status)) throw new ApiError(502, "calendar_delete_failed", `Не удалось удалить событие Google (${response.status})`);
      } else {
        const startsAt = agreement.scheduledAt!;
        const endsAt = agreement.scheduledEndAt && agreement.scheduledEndAt > startsAt ? agreement.scheduledEndAt : new Date(startsAt.getTime() + 3600000);
        const body = { status: "confirmed", summary: agreement.title, description: [agreement.summary, agreement.meetingUrl].filter(Boolean).join("\n"), location: [agreement.locationName, agreement.address].filter(Boolean).join(" · "),
          start: { dateTime: startsAt.toISOString() }, end: { dateTime: endsAt.toISOString() }, extendedProperties: { private: { creolabAgreementId: agreement.id, creolabTenantId: integration.tenantId } } };
        let response = await googleRequest(prisma, integration, path, { method: "PATCH", body: JSON.stringify(body) });
        if ([404,410].includes(response.status)) {
          response = await googleRequest(prisma, integration, `/calendar/v3/calendars/${calendar}/events`, { method: "POST", body: JSON.stringify({ id: eventId, ...body }) });
          // A concurrent sync already inserted the deterministic ID; update the same event.
          if (response.status === 409) response = await googleRequest(prisma, integration, path, { method: "PATCH", body: JSON.stringify(body) });
        }
        if (!response.ok) throw new ApiError(502, "calendar_sync_failed", `Не удалось синхронизировать событие Google (${response.status})`);
      }
      count++;
    }
    if (agreements.length < 100) break;
    cursor = agreements.at(-1)!.id;
  }
  await prisma.integration.updateMany({ where: { id: integration.id, status: "active", credentialId: integration.credentialId }, data: { schemaJson: { ...settings, lastSyncAt: startedAt.toISOString() } as Prisma.InputJsonValue } });
  return { synced: count };
}
