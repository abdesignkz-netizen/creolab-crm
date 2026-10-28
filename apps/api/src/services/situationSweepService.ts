import type { Prisma, PrismaClient } from "@creolab/db";
import { situationWorkerAuth } from "./situationWorkerAuth.ts";
import { loadSituationEvidence } from "./situationEvidence.ts";
import { observeSituationEvidence } from "./situationEpisodeService.ts";
import { queueSituationNotices, SITUATION_SOURCE_KINDS } from "./situationNoticeService.ts";
import { logServerError } from "../lib/redact.ts";
import { OPEN_INTAKE_STATUSES } from "./inquiryAttention.ts";

const INTERVAL_MS = 60_000;
/** Persisted keyset cursors visit every source; a full first page cannot starve
 * the tail. Known episodes are also rotated so closed sources are reconciled. */
export async function sweepSituationTenant(db: PrismaClient, tenantId: string, options: { now?: Date; pageSize?: number } = {}) {
  const now = options.now || new Date(), take = Math.min(100, Math.max(1, options.pageSize || 50));
  return db.$transaction(async tx => {
    const [lock] = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtextextended(${tenantId}, 610282026)) AS locked`;
    if (!lock?.locked) return false;
    const auth = await situationWorkerAuth(tx, tenantId); if (!auth) return false;
    const state = await tx.situationSweepState.upsert({ where: { tenantId }, update: {}, create: { tenantId, nextRunAt: now } });
    if (state.nextRunAt > now) return false;
    const cursors = { ...state.cursorsJson as Record<string, string> };
    const page = (key: string) => ({ where: { tenantId, ...(cursors[key] ? { id: { gt: cursors[key] } } : {}) }, orderBy: { id: "asc" as const }, take, select: { id: true } });
    const pages = await Promise.all([
      tx.task.findMany({ ...page("task"), where: { ...page("task").where, status: { in: ["open", "in_progress", "waiting"] } } }),
      tx.inquiry.findMany({ ...page("inquiry"), where: { ...page("inquiry").where, archived: false, test: false, status: { notIn: ["lost", "invalid", "spam", "converted", "cancelled"] } } }),
      tx.conversation.findMany({ ...page("conversation"), where: { ...page("conversation").where, status: "open" } }),
      tx.contact.findMany({ ...page("contact"), where: { ...page("contact").where, archivedAt: null, lastInboundMessageAt: { not: null },
        OR: [{ lastOutboundMessageAt: null }, { lastInboundMessageAt: { gt: tx.contact.fields.lastOutboundMessageAt } }] } }),
      tx.incompleteIntake.findMany({ ...page("intake"), where: { ...page("intake").where, status: { in: [...OPEN_INTAKE_STATUSES] } } }),
      tx.deal.findMany({ ...page("deal"), where: { ...page("deal").where, outcome: "open" } }),
      tx.agreement.findMany({ ...page("agreement"), where: { ...page("agreement").where, status: { in: ["DETECTED", "NEEDS_CLARIFICATION", "CONFIRMED", "SCHEDULED", "RESCHEDULED"] } } }),
    ]);
    const ids: string[] = [];
    Object.entries(SITUATION_SOURCE_KINDS).forEach(([key, kinds], i) => {
      const rows = pages[i]; cursors[key] = rows.length === take ? rows[rows.length - 1].id : "";
      for (const row of rows) for (const kind of kinds) ids.push(`${kind}:${row.id}`);
    });
    const known = await tx.situationEpisode.findMany({ where: { tenantId, state: { not: "resolved" } }, orderBy: [{ checkedAt: "asc" }, { id: "asc" }], take });
    ids.push(...known.map(row => row.itemId));
    const uniqueIds = [...new Set(ids)], facts = await loadSituationEvidence(tx, auth, uniqueIds, now);
    const previous = new Map((await tx.situationEpisode.findMany({ where: { tenantId, itemId: { in: uniqueIds } } })).map(row => [row.itemId, row]));
    const episodes = new Map();
    for (const fact of facts.values()) {
      const row = await observeSituationEvidence(tx, tenantId, fact, previous.get(fact.itemId) || null);
      if (row) episodes.set(fact.itemId, row);
    }
    await tx.situationEpisode.updateMany({ where: { tenantId, itemId: { in: uniqueIds } }, data: { checkedAt: now } });
    await queueSituationNotices(tx, tenantId, facts, episodes, now);
    await tx.situationSweepState.update({ where: { tenantId }, data: { cursorsJson: cursors as Prisma.InputJsonObject,
      nextRunAt: new Date(now.getTime() + INTERVAL_MS), lastCompletedAt: now } });
    return true;
  }, { timeout: 30_000 });
}

export async function sweepSituations(db: PrismaClient, now = new Date()) {
  const missing = await db.tenant.findMany({ where: { status: "active", situationSweep: null }, select: { id: true }, take: 100, orderBy: { id: "asc" } });
  if (missing.length) await db.situationSweepState.createMany({ data: missing.map(row => ({ tenantId: row.id, nextRunAt: now })), skipDuplicates: true });
  const due = await db.situationSweepState.findMany({ where: { nextRunAt: { lte: now }, tenant: { status: "active" } }, orderBy: [{ nextRunAt: "asc" }, { tenantId: "asc" }], take: 3 });
  for (const row of due) {
    try {
      if (!await sweepSituationTenant(db, row.tenantId, { now })) {
        // A company without an active owner must not starve other companies.
        await db.situationSweepState.updateMany({ where: { tenantId: row.tenantId, nextRunAt: { lte: now } }, data: { nextRunAt: new Date(now.getTime() + INTERVAL_MS) } });
      }
    } catch (error) {
      logServerError(error, "background:situation sweep");
      await db.situationSweepState.updateMany({ where: { tenantId: row.tenantId, nextRunAt: { lte: now } }, data: { nextRunAt: new Date(now.getTime() + INTERVAL_MS) } });
    }
  }
}
