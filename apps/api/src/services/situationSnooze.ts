import type { Prisma, PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import { conversationAccessWhere, inquiryAccessWhere, isManager, requireTenant, taskAccessWhere } from "../lib/access.ts";
import type { AuthContext } from "../lib/types.ts";
import { loadSituationEvidence } from "./situationEvidence.ts";

export type SituationSnoozeScope = "personal" | "company";
type Database = PrismaClient | Prisma.TransactionClient;

// Keep the public situation ID stable. Storage keys isolate personal reminders
// without changing or migrating the existing tenant/item unique constraint.
export function situationSnoozeKey(itemId: string, userId: string, scope: SituationSnoozeScope) {
  return scope === "company" ? "company:" + itemId : "personal:" + userId + ":" + itemId;
}

export async function assertSituationReachable(db: Database, auth: AuthContext, itemId: string) {
  if (/^(deal-|agreement)/.test(itemId)) {
    if (!(await loadSituationEvidence(db, auth, [itemId])).has(itemId)) throw new ApiError(404, "not_found", "Ситуация не найдена");
    return;
  }
  const membership = requireTenant(auth);
  const match = /^([a-z_]+):([^:]+)$/.exec(itemId);
  const notFound = () => new ApiError(404, "not_found", "Ситуация не найдена");
  if (!match) throw notFound();
  const [, kind, id] = match;
  const select = { id: true } as const;
  const assignee = isManager(auth)
    ? { OR: [{ assigneeMembershipId: null }, { assigneeMembershipId: membership.id }] }
    : {};
  let found: { id: string } | null;
  switch (kind) {
    case "needs_phone":
      found = await db.incompleteIntake.findFirst({ where: { id, tenantId: membership.tenantId, ...assignee }, select });
      break;
    case "inquiry_new":
    case "inquiry_accepted":
    case "inquiry_ai_blocked":
    case "missing_next_action":
      found = await db.inquiry.findFirst({ where: { AND: [{ id }, inquiryAccessWhere(auth)] }, select });
      break;
    case "conversation_human":
    case "conversation_paused":
    case "conversation_attention":
      found = await db.conversation.findFirst({ where: { AND: [{ id }, conversationAccessWhere(auth), assignee] }, select });
      break;
    case "task_overdue":
    case "task_due_today":
    case "task_unassigned_hot":
      found = await db.task.findFirst({ where: { AND: [{ id }, taskAccessWhere(auth)] }, select });
      break;
    case "contact_needs_reply":
      found = await db.contact.findFirst({
        where: { id, tenantId: membership.tenantId, archivedAt: null,
          ...(isManager(auth) ? { OR: [{ ownerMembershipId: null }, { ownerMembershipId: membership.id }] } : {}) },
        select,
      });
      break;
    default:
      throw notFound();
  }
  if (!found) throw notFound();
}

export async function visibleSituationSnoozes(db: Database, auth: AuthContext, options: { now?: Date; includeExpired?: boolean; evidenceKeys?: ReadonlyMap<string, string> } = {}) {
  const membership = requireTenant(auth);
  const now = options.now || new Date();
  const rows = await db.situationSnooze.findMany({
    where: { tenantId: membership.tenantId, ...(options.includeExpired ? {} : { until: { gt: now } }),
      OR: [{ byUserId: auth.user.id }, { itemId: { startsWith: "company:" } }] },
  });
  const companyActors = [...new Set(rows.filter(row => row.itemId.startsWith("company:")).map(row => row.byUserId))];
  // Recheck the actor even for legacy rows: the old endpoint accepted arbitrary
  // item IDs, so a stored prefix alone is not proof of company-wide authority.
  const authorized = new Set(companyActors.length ? (await db.membership.findMany({
    where: { tenantId: membership.tenantId, userId: { in: companyActors }, active: true, role: { in: ["owner", "director"] }, user: { status: "active" } },
    select: { userId: true },
  })).map(row => row.userId) : []);
  const personalPrefix = "personal:" + auth.user.id + ":";
  const visible = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    let itemId = row.itemId;
    if (itemId.startsWith("company:")) {
      if (!authorized.has(row.byUserId)) continue;
      itemId = itemId.slice("company:".length);
    } else {
      if (row.byUserId !== auth.user.id) continue;
      if (itemId.startsWith(personalPrefix)) itemId = itemId.slice(personalPrefix.length);
      else if (itemId.startsWith("personal:")) continue;
      // Unscoped legacy reminders are personal to their author, never shared.
    }
    const matches = (candidate: typeof row) => !options.evidenceKeys || !candidate.evidenceKey || candidate.evidenceKey === options.evidenceKeys.get(itemId);
    if (!options.includeExpired && !matches(row)) continue;
    const previous = visible.get(itemId), active = row.until > now && matches(row), priorActive = previous && previous.until > now && matches(previous);
    // An old company snooze must not mask a more recent personal snooze that is
    // still bound to the current facts (and vice versa).
    if (!previous || active && !priorActive || active === Boolean(priorActive) && previous.until < row.until) visible.set(itemId, row);
  }
  return visible;
}
