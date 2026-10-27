import { createHash } from "node:crypto";
import type { Prisma } from "@creolab/db";
import type { CrmCalendarEffect } from "@creolab/contracts";

type Db = Prisma.TransactionClient;
type Agreement = Prisma.AgreementGetPayload<{}>;
export const CALENDAR_SYNC_SCOPE = "google.calendar.event";
export const CALENDAR_LEASE_SCOPE = "google.calendar.lease";
export const calendarConnectionsWhere = (tenantId: string): Prisma.IntegrationWhereInput => ({ tenantId,
  OR: [{ type: "calendar", publicKey: { startsWith: "google:calendar:" } }, { type: "google_calendar" }],
});

// Disconnection does not remove previously exported events. Keep reconciliation
// required for those connections too; a global server token is never a company connection.
export async function hasCalendarConnection(db: Db, tenantId: string) {
  return Boolean(await db.integration.count({ where: calendarConnectionsWhere(tenantId) }));
}
export async function hasCalendarHistory(db: Db, tenantId: string, agreementIds: string[]) {
  return agreementIds.length > 0 && Boolean(await db.idempotencyRecord.count({ where: {
    scope: CALENDAR_SYNC_SCOPE, actorKey: tenantId, OR: agreementIds.map(id => ({ key: { endsWith: `:${id}` } })),
  } }));
}

export function calendarEventBody(agreement: Agreement) {
  if (!agreement.scheduledAt || agreement.status === "CANCELLED") return null;
  const startsAt = agreement.scheduledAt;
  const endsAt = agreement.scheduledEndAt && agreement.scheduledEndAt > startsAt
    ? agreement.scheduledEndAt : new Date(startsAt.getTime() + 3_600_000);
  return { status: "confirmed", summary: agreement.title,
    description: [agreement.summary, agreement.meetingUrl].filter(Boolean).join("\n"),
    location: [agreement.locationName, agreement.address].filter(Boolean).join(" · "),
    start: { dateTime: startsAt.toISOString() }, end: { dateTime: endsAt.toISOString() },
    extendedProperties: { private: { creolabAgreementId: agreement.id, creolabTenantId: agreement.tenantId } } };
}
export const calendarSourceHash = (agreement: Agreement) => createHash("sha256").update(JSON.stringify(calendarEventBody(agreement))).digest("hex");
export const calendarRecordKey = (tenantId: string, integrationId: string, agreementId: string) => ({
  scope: CALENDAR_SYNC_SCOPE, actorKey: tenantId, key: `${integrationId}:${agreementId}`,
});
export type CalendarSyncRecord = {
  sourceHash: string;
  state: "syncing" | "synced" | "removed" | "error" | "uncertain";
  checkedAt: string;
  errorCode?: string;
};
export function readCalendarSyncRecord(value: unknown): CalendarSyncRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as CalendarSyncRecord;
  return typeof row.sourceHash === "string" && typeof row.checkedAt === "string" && Number.isFinite(Date.parse(row.checkedAt))
    && ["syncing", "synced", "removed", "error", "uncertain"].includes(row.state) ? row : null;
}

/** Only safe, tenant-scoped state is returned, never credentials or provider errors. */
export async function calendarEffects(db: Db, tenantId: string, agreementIds: string[]): Promise<CrmCalendarEffect[]> {
  if (!agreementIds.length) return [];
  const [connections, agreements] = await Promise.all([
    db.integration.findMany({ where: calendarConnectionsWhere(tenantId), orderBy: { id: "asc" } }),
    db.agreement.findMany({ where: { tenantId, id: { in: agreementIds } }, orderBy: { id: "asc" } }),
  ]);
  if (!agreements.length) return [];
  const records = await db.idempotencyRecord.findMany({ where: { scope: CALENDAR_SYNC_SCOPE, actorKey: tenantId,
    OR: agreements.map(a => ({ key: { endsWith: `:${a.id}` } })),
  } });
  const byKey = new Map(records.map(r => [r.key, readCalendarSyncRecord(r.resultJson)]));
  const current = connections.flatMap(c => agreements.map(a => {
    const saved = byKey.get(calendarRecordKey(tenantId, c.id, a.id).key);
    const settings = c.schemaJson as { lastSyncAt?: string } | null;
    const removal = !calendarEventBody(a);
    let state: CrmCalendarEffect["state"] = removal ? "removal_pending" : "pending";
    if (c.status !== "active" || !c.credentialId) state = "disconnected";
    else if (saved?.state === "syncing" && Date.now() - Date.parse(saved.checkedAt) > 120_000) state = "uncertain";
    else if (saved?.state === "uncertain") state = "uncertain";
    else if (saved?.sourceHash === calendarSourceHash(a)) state = saved.state;
    else if (!saved && settings?.lastSyncAt && a.updatedAt <= new Date(settings.lastSyncAt)) state = "unverified";
    return { agreementId: a.id, integrationId: c.id, title: a.title, calendar: c.name || "Google Calendar", state,
      checkedAt: saved?.checkedAt || null };
  }));
  // Retain visible evidence after the connection row itself was removed.
  const historical = records.flatMap(r => {
    const a = agreements.find(a => r.key.endsWith(`:${a.id}`));
    const saved = readCalendarSyncRecord(r.resultJson);
    if (!a || !saved) return [];
    const integrationId = r.key.slice(0, -(a.id.length + 1));
    if (connections.some(c => c.id === integrationId)) return [];
    return [{ agreementId: a.id, integrationId, title: a.title, calendar: "Google Calendar", state: "disconnected" as const, checkedAt: saved.checkedAt }];
  });
  return [...current, ...historical];
}
