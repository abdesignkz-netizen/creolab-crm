import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient, Prisma } from "@creolab/db";
import { ApiError } from "../errors.ts";
import { googleRequest } from "./googleConnectionService.ts";
import { CALENDAR_LEASE_SCOPE, calendarEventBody, calendarRecordKey, calendarSourceHash, type CalendarSyncRecord } from "./calendarSyncState.ts";

type Integration = Awaited<ReturnType<PrismaClient["integration"]["findUniqueOrThrow"]>>;
const LEASE_MS = 120_000; // Longer than token refresh + bounded Google requests.
const settingsFor = (i: Integration) => (i.schemaJson || {}) as { resourceId?: string; lastSyncAt?: string; calendarSyncVersion?: number };
const connectionChanged = () => new ApiError(409, "calendar_connection_changed", "Подключение календаря изменилось. Обновите страницу и повторите синхронизацию.");

export function googleAgreementEventId(tenantId: string, agreementId: string) {
  return createHash("sha256").update(`${tenantId}:agreement:${agreementId}`).digest("hex");
}
export async function syncGoogleCalendar(prisma: PrismaClient, requested: Integration) {
  const leaseKey = { scope: CALENDAR_LEASE_SCOPE, actorKey: requested.tenantId, key: requested.id };
  const token = randomUUID();
  // The database claim also covers other API/worker processes. Never hold a
  // database transaction while waiting for Google.
  const integration = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Integration" WHERE id = ${requested.id} AND "tenantId" = ${requested.tenantId} FOR UPDATE`;
    const current = await tx.integration.findFirst({ where: { id: requested.id, tenantId: requested.tenantId,
      type: "calendar", publicKey: { startsWith: "google:calendar:" }, status: "active", credentialId: requested.credentialId, tenant: { status: "active" } } });
    if (!current?.credentialId || settingsFor(current).resourceId !== settingsFor(requested).resourceId) throw connectionChanged();
    const previous = await tx.idempotencyRecord.findUnique({ where: { scope_actorKey_key: leaseKey } });
    if (previous && previous.expiresAt > new Date()) return null;
    const claim = { requestHash: token, resultJson: {}, expiresAt: new Date(Date.now() + LEASE_MS) };
    await tx.idempotencyRecord.upsert({ where: { scope_actorKey_key: leaseKey }, create: { ...leaseKey, ...claim }, update: claim });
    return current; // Read the cursor after taking the claim, not from a stale poll.
  });
  if (!integration) return { running: true };
  const settings = settingsFor(integration), startedAt = new Date();
  const calendar = encodeURIComponent(settings.resourceId || "primary");
  const activeWhere = { id: integration.id, tenantId: integration.tenantId, type: "calendar", status: "active",
    publicKey: integration.publicKey, credentialId: integration.credentialId, tenant: { status: "active" } };
  const assertActive = async () => {
    if (!(await prisma.idempotencyRecord.updateMany({ where: { ...leaseKey, requestHash: token, expiresAt: { gt: new Date() } },
      data: { expiresAt: new Date(Date.now() + LEASE_MS) } })).count) throw connectionChanged();
    const current = await prisma.integration.findFirst({ where: activeWhere });
    if (!current || settingsFor(current).resourceId !== settings.resourceId) throw connectionChanged();
  };
  let cursor: string | undefined, count = 0;
  try {
    while (true) {
      await assertActive();
      // Backfill per-event results once for pre-ledger connections, including
      // canceled records. A legacy cursor alone cannot confirm an event's state.
      const since = settings.calendarSyncVersion === 1 && settings.lastSyncAt ? new Date(settings.lastSyncAt) : null;
      const agreements = await prisma.agreement.findMany({ where: { tenantId: integration.tenantId,
        updatedAt: { ...(since && Number.isFinite(since.getTime()) ? { gte: since } : {}), lte: startedAt },
      }, orderBy: { id: "asc" }, take: 100, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      for (const candidate of agreements) {
        await assertActive();
        const attempt = randomUUID();
        // Serialize the local source snapshot with undo/manual edits. Without
        // this lock a newly connected calendar could export a pre-undo row.
        const snapshot = await prisma.$transaction(async tx => {
          await tx.$queryRaw`SELECT id FROM "Agreement" WHERE id = ${candidate.id} AND "tenantId" = ${integration.tenantId} FOR UPDATE`;
          const agreement = await tx.agreement.findFirst({ where: { id: candidate.id, tenantId: integration.tenantId } });
          if (!agreement || agreement.updatedAt > startedAt) return null;
          const key = calendarRecordKey(integration.tenantId, integration.id, agreement.id);
          const record: CalendarSyncRecord = { sourceHash: calendarSourceHash(agreement), state: "syncing", checkedAt: new Date().toISOString() };
          await tx.idempotencyRecord.upsert({ where: { scope_actorKey_key: key },
            create: { ...key, requestHash: attempt, resultJson: record, expiresAt: new Date("9999-12-31T00:00:00Z") },
            update: { requestHash: attempt, resultJson: record } });
          return { agreement, key, record };
        });
        if (!snapshot) continue;
        const { agreement, key, record } = snapshot;
        const save = (state: CalendarSyncRecord["state"], errorCode?: string) => prisma.idempotencyRecord.updateMany({
          where: { ...key, requestHash: attempt }, data: { resultJson: { ...record, state, checkedAt: new Date().toISOString(), ...(errorCode ? { errorCode } : {}) } } });
        const request = async (path: string, init: RequestInit) => {
          await assertActive();
          return googleRequest(prisma, integration, path, init);
        };
        try {
          const eventId = googleAgreementEventId(integration.tenantId, agreement.id);
          const path = `/calendar/v3/calendars/${calendar}/events/${eventId}`;
          const body = calendarEventBody(agreement);
          if (!body) {
            const response = await request(path, { method: "DELETE" });
            if (!response.ok && ![404, 410].includes(response.status)) throw new ApiError(502, "calendar_delete_failed", `Не удалось удалить событие Google (${response.status})`);
          } else {
            let response = await request(path, { method: "PATCH", body: JSON.stringify(body) });
            if ([404, 410].includes(response.status)) {
              response = await request(`/calendar/v3/calendars/${calendar}/events`, { method: "POST", body: JSON.stringify({ id: eventId, ...body }) });
              if (response.status === 409) response = await request(path, { method: "PATCH", body: JSON.stringify(body) });
            }
            if (!response.ok) throw new ApiError(502, "calendar_sync_failed", `Не удалось синхронизировать событие Google (${response.status})`);
          }
          await assertActive();
          // The hash refers to this attempt's source, not a newer reschedule.
          // A concurrent edit remains pending and is picked up by the next poll.
          await save(body ? "synced" : "removed");
        } catch (error) {
          const code = error instanceof ApiError ? error.code : "calendar_sync_failed";
          await save(["calendar_sync_failed", "calendar_delete_failed", "google_auth_failed", "google_disconnected"].includes(code) && error instanceof ApiError ? "error" : "uncertain", code);
          throw error;
        }
        count++;
      }
      if (agreements.length < 100) break;
      cursor = agreements.at(-1)!.id;
    }
    await assertActive();
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Integration" WHERE id = ${integration.id} AND "tenantId" = ${integration.tenantId} FOR UPDATE`;
      const current = await tx.integration.findFirst({ where: activeWhere });
      if (!current || settingsFor(current).resourceId !== settings.resourceId || !await tx.idempotencyRecord.count({ where: { ...leaseKey, requestHash: token, expiresAt: { gt: new Date() } } })) throw connectionChanged();
      await tx.integration.update({ where: { id: integration.id }, data: { schemaJson: { ...settingsFor(current), lastSyncAt: startedAt.toISOString(), calendarSyncVersion: 1 } as Prisma.InputJsonValue } });
    });
    return { synced: count };
  } finally {
    await prisma.idempotencyRecord.deleteMany({ where: { ...leaseKey, requestHash: token } });
  }
}
