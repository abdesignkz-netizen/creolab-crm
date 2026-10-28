import type { Prisma, PrismaClient } from "@creolab/db";
import { taskCreatorSnapshot } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { isCompanyAdmin, isManager, requireCompanyAdmin, requireManageTasks, requireTenant, taskAccessWhere } from "../lib/access.ts";
import { writeAudit } from "../lib/audit.ts";
import type { AuthContext } from "../lib/types.ts";
import { writeActivity } from "./contactService.ts";
import { loadSituationEvidence, type SituationDatabase, type SituationEvidence } from "./situationEvidence.ts";

type Episode = NonNullable<Awaited<ReturnType<PrismaClient["situationEpisode"]["findFirst"]>>>;
const notFound = () => new ApiError(404, "not_found", "Ситуация не найдена или больше недоступна");
export async function lockSituationEpisodes(tx: Prisma.TransactionClient, tenantId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId}, 610282026))`;
}
async function event(tx: Prisma.TransactionClient, row: Episode, kind: string, actorUserId: string | null = null, details: Prisma.InputJsonObject = {}) {
  await tx.situationEpisodeEvent.create({ data: { tenantId: row.tenantId, episodeId: row.id, version: row.version,
    kind, actorUserId, detailsJson: { occurrence: row.occurrence, ...details } } });
}
export async function observeSituationEvidence(tx: Prisma.TransactionClient, tenantId: string, fact: SituationEvidence, previous?: Episode | null, title?: string) {
  const old = previous === undefined ? await tx.situationEpisode.findUnique({ where: { tenantId_itemId: { tenantId, itemId: fact.itemId } } }) : previous;
  const now = new Date();
  if (!old) {
    if (!fact.active) return null;
    const row = await tx.situationEpisode.create({ data: { tenantId, itemId: fact.itemId, title: title || fact.title, evidenceKey: fact.evidenceKey } });
    await event(tx, row, "detected");
    return row;
  }
  const reopened = old.state === "resolved" && fact.active, resolved = old.state !== "resolved" && !fact.active;
  const changed = old.state !== "resolved" && fact.active && old.evidenceKey !== fact.evidenceKey;
  if (!reopened && !resolved && !changed) return old;
  const row = await tx.situationEpisode.update({ where: { id: old.id }, data: {
    evidenceKey: fact.evidenceKey, checkedAt: now, updatedAt: now, version: { increment: 1 },
    ...(title ? { title } : {}),
    ...(resolved ? { state: "resolved", resolvedAt: now } : {}),
    ...(reopened ? { state: "open", occurrence: { increment: 1 }, resolvedAt: null, assignedMembershipId: null, taskId: null } : {}),
  } });
  await event(tx, row, reopened ? "reopened" : resolved ? "resolved" : "facts_changed");
  return row;
}

/** Observe real source facts, never infer resolution from a missing/filtered card.
 * Recheck a bounded oldest-first batch of previously seen issues on each refresh. */
export async function syncSituationEpisodes(prisma: PrismaClient, auth: AuthContext, items: Array<{ id: string; title: string }>, reconcile = true) {
  const { tenantId } = requireTenant(auth);
  return prisma.$transaction(async tx => {
    await lockSituationEpisodes(tx, tenantId);
    const known = reconcile ? await tx.situationEpisode.findMany({ where: { tenantId, state: { not: "resolved" } }, orderBy: { checkedAt: "asc" }, take: 50 }) : [];
    const ids = [...new Set([...items.map(item => item.id), ...known.map(row => row.itemId)])];
    if (!ids.length) return new Map<string, Episode>();
    const facts = await loadSituationEvidence(tx, auth, ids);
    const existing = new Map((await tx.situationEpisode.findMany({ where: { tenantId, itemId: { in: ids } } })).map(row => [row.itemId, row]));
    const titles = new Map(items.map(item => [item.id, item.title]));
    const result = new Map<string, Episode>();
    for (const fact of facts.values()) {
      const row = await observeSituationEvidence(tx, tenantId, fact, existing.get(fact.itemId) || null, titles.get(fact.itemId));
      if (row) result.set(fact.itemId, row);
    }
    // Rotate inaccessible/deleted candidates too; they must not starve the next
    // batch, and absence still never changes their resolution state.
    await tx.situationEpisode.updateMany({ where: { tenantId, itemId: { in: ids } }, data: { checkedAt: new Date() } });
    return result;
  }, { timeout: 30_000 });
}

async function current(tx: Prisma.TransactionClient, auth: AuthContext, itemId: string) {
  const { tenantId } = requireTenant(auth);
  await lockSituationEpisodes(tx, tenantId);
  const fact = (await loadSituationEvidence(tx, auth, [itemId])).get(itemId);
  if (!fact) throw notFound();
  const row = await observeSituationEvidence(tx, tenantId, fact);
  if (!row) throw notFound();
  return { row, fact };
}
async function details(db: SituationDatabase, auth: AuthContext, row: Episode, fact: SituationEvidence) {
  const { tenantId } = requireTenant(auth);
  const events = await db.situationEpisodeEvent.findMany({ where: { tenantId, episodeId: row.id }, orderBy: { version: "desc" }, take: 100 });
  const members = await db.membership.findMany({ where: { tenantId, active: true, ...(isCompanyAdmin(auth) ? {} : { id: auth.activeMembership!.id }) },
    include: { user: { select: { id: true, name: true } } }, orderBy: { id: "asc" } });
  // Only offer assignment to employees who already have access to the source.
  const choices = [];
  for (const member of members) {
    const candidate = { ...auth, activeMembership: { ...member, permissions: member.permissions as string[],
      tenant: auth.activeMembership!.tenant }, user: { ...auth.user, id: member.userId, name: member.user.name, platformAdmin: false } } as AuthContext;
    if ((await loadSituationEvidence(db, candidate, [row.itemId])).has(row.itemId)) choices.push({ id: member.id, name: member.user.name });
  }
  const taskId = row.taskId || fact.links.taskId;
  const task = taskId ? await db.task.findFirst({ where: { AND: [taskAccessWhere(auth), { id: taskId }] }, select: { id: true, title: true, status: true, dueAt: true } }) : null;
  const related = Object.entries(fact.links).filter(([key, value]) => key !== "taskId" && Boolean(value)).map(([key, value]) => ({ [key]: value }));
  const availableTasks = !isManager(auth) && related.length ? await db.task.findMany({
    where: { AND: [taskAccessWhere(auth), { OR: related, status: { in: ["open", "in_progress", "waiting"] } }] },
    orderBy: { createdAt: "desc" }, take: 50, select: { id: true, title: true, dueAt: true },
  }) : [];
  const actors = await db.user.findMany({ where: { id: { in: [...new Set(events.flatMap(e => e.actorUserId ? [e.actorUserId] : []))] } }, select: { id: true, name: true } });
  const actorNames = new Map(actors.map(actor => [actor.id, actor.name]));
  const notices = isCompanyAdmin(auth) ? await db.controlNotificationItem.findMany({ where: { episodeId: row.id,
    rule: { tenantId, membershipId: auth.activeMembership!.id } }, orderBy: { createdAt: "desc" }, take: 20,
    select: { id: true, mode: true, createdAt: true, episodeOccurrence: true, suppressionReason: true,
      batch: { select: { state: true, error: true, finishedAt: true } } } }) : [];
  return { ...row, active: fact.active, source: fact.links, task, availableTasks, members: choices, canManage: !isManager(auth), canSnoozeCompany: isCompanyAdmin(auth),
    notices,
    events: events.map(e => ({ ...e, actorName: e.actorUserId ? actorNames.get(e.actorUserId) || "Сотрудник" : "Система" })) };
}
export async function situationEpisodeDetails(prisma: PrismaClient, auth: AuthContext, itemId: string) {
  const data = await prisma.$transaction(tx => current(tx, auth, itemId));
  return details(prisma, auth, data.row, data.fact);
}
export async function situationEpisodeHistory(prisma: PrismaClient, auth: AuthContext) {
  const { tenantId } = requireTenant(auth);
  // The fixed limit is explicit in the UI. It never drives resolution decisions.
  const rows = await prisma.situationEpisode.findMany({ where: { tenantId }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], take: 100 });
  const facts = await loadSituationEvidence(prisma, auth, rows.map(row => row.itemId));
  return { limit: 100, items: rows.filter(row => facts.has(row.itemId)) };
}

export type EpisodeAction = { itemId: string; version: number } & (
  { action: "assign"; membershipId: string } | { action: "check" } |
  { action: "create_task"; title: string; dueAt: string; membershipId: string } |
  { action: "link_task"; taskId: string }
);
export async function actOnSituationEpisode(prisma: PrismaClient, auth: AuthContext, input: EpisodeAction) {
  const { tenantId } = requireTenant(auth);
  const result = await prisma.$transaction(async tx => {
    const { row, fact } = await current(tx, auth, input.itemId);
    // Checking is read-only with respect to the business record; observation may
    // already have recorded a verified resolution or new facts.
    if (input.action === "check") return { row, fact, stillActive: fact.active };
    if (row.version !== input.version) throw new ApiError(409, "situation_changed", "Ситуация изменилась. Обновите её перед действием.");
    if (!fact.active) throw new ApiError(409, "situation_resolved", "Причина уже устранена. Обновите список.");
    let assigned = row.assignedMembershipId, taskId = row.taskId;
    let kind: string, extra: Prisma.InputJsonObject = {};
    if (input.action === "assign" || input.action === "create_task") {
      if (input.membershipId !== auth.activeMembership!.id) requireCompanyAdmin(auth);
      const member = await tx.membership.findFirst({ where: { tenantId, id: input.membershipId, active: true } });
      if (!member) throw new ApiError(422, "invalid", "Сотрудник недоступен");
      const candidate = { ...auth, activeMembership: { ...member, permissions: member.permissions as string[], tenant: auth.activeMembership!.tenant },
        user: { ...auth.user, id: member.userId, platformAdmin: false } } as AuthContext;
      if (!(await loadSituationEvidence(tx, candidate, [input.itemId])).has(input.itemId))
        throw new ApiError(422, "source_access", "Сначала предоставьте сотруднику доступ к этой заявке, задаче или диалогу.");
      assigned = member.id;
    }
    if (input.action === "assign") {
      if (assigned === row.assignedMembershipId) return { row, fact };
      kind = "assigned";
      extra = { membershipId: assigned };
    } else {
      requireManageTasks(auth);
      if (input.action === "create_task") {
        if (row.taskId || fact.links.taskId) throw new ApiError(409, "task_exists", "У ситуации уже есть задача. Откройте её или выберите другую существующую.");
        const dueAt = new Date(input.dueAt);
        if (!Number.isFinite(dueAt.getTime()) || dueAt <= new Date()) throw new ApiError(422, "invalid", "Укажите срок задачи в будущем");
        const { taskId: _sourceTaskId, ...links } = fact.links;
        const task = await tx.task.create({ data: { tenantId, type: "manual", title: input.title, dueAt,
          ...links, ownerMembershipId: assigned, source: "situation", status: "open",
          targetType: fact.links.contactId ? "client" : "none", dedupeKey: `situation:${row.id}:${row.occurrence}`,
          contextSnapshotJson: { ...taskCreatorSnapshot({ createdByKind: "user", createdByMembershipId: auth.activeMembership!.id, executorType: "USER" }),
            situationEpisodeId: row.id, situationOccurrence: row.occurrence } } as Prisma.TaskUncheckedCreateInput });
        taskId = task.id;
        await writeAudit(tx, { tenantId, actorUserId: auth.user.id, action: "task.created", entityType: "task", entityId: task.id,
          changes: { source: "situation", episodeId: row.id, title: task.title, dueAt: input.dueAt } });
        if (task.contactId) await writeActivity(tx, { tenantId, contactId: task.contactId, inquiryId: task.inquiryId, dealId: task.dealId,
          type: "task.created", title: "Создана задача из ситуации", description: task.title, actorType: "user", actorId: auth.user.id,
          metadata: { taskId, situationEpisodeId: row.id } });
        kind = "task_created";
      } else {
        const task = await tx.task.findFirst({ where: { AND: [taskAccessWhere(auth), { id: input.taskId }] } });
        if (!task) throw new ApiError(422, "invalid", "Задача недоступна");
        const links = fact.links;
        if (!(links.taskId === task.id || links.inquiryId && links.inquiryId === task.inquiryId || links.dealId && links.dealId === task.dealId ||
          links.conversationId && links.conversationId === task.conversationId || links.contactId && links.contactId === task.contactId ||
          links.incompleteIntakeId && links.incompleteIntakeId === task.incompleteIntakeId))
          throw new ApiError(422, "unrelated_task", "Выберите задачу, связанную с этим клиентом или обращением");
        taskId = task.id; kind = "task_linked";
        if (taskId === row.taskId) return { row, fact };
      }
      extra = { taskId, membershipId: assigned };
    }
    const updated = await tx.situationEpisode.update({ where: { id: row.id }, data: { state: "in_progress", assignedMembershipId: assigned,
      taskId, updatedAt: new Date(), version: { increment: 1 } } });
    await event(tx, updated, kind, auth.user.id, extra);
    await writeAudit(tx, { tenantId, actorUserId: auth.user.id, action: `situation.${kind}`, entityType: "situation", entityId: row.itemId, changes: extra });
    return { row: updated, fact };
  }, { timeout: 30_000 });
  return { ...(await details(prisma, auth, result.row, result.fact)), stillActive: result.stillActive };
}

export async function recordSituationSnooze(tx: Prisma.TransactionClient, auth: AuthContext, itemId: string, until: Date, scope: string, reason?: string, version?: number) {
  const { row, fact } = await current(tx, auth, itemId);
  if (version !== undefined && version !== row.version) throw new ApiError(409, "situation_changed", "Ситуация изменилась. Обновите её перед отложением.");
  if (!fact.active) throw new ApiError(409, "situation_resolved", "Причина уже устранена. Обновите список.");
  const updated = await tx.situationEpisode.update({ where: { id: row.id }, data: { version: { increment: 1 }, updatedAt: new Date() } });
  await event(tx, updated, "snoozed", auth.user.id, { until: until.toISOString(), scope, reason: reason || null });
  return fact.evidenceKey;
}
