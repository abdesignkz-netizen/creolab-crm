import type { AutopilotConfig } from "@creolab/contracts";
import type { Tx } from "./autopilotSupport.ts";
import { authForUserInTenant } from "./authService.ts";
import { inquiryAccessWhere, conversationAccessWhere } from "../lib/access.ts";

/** No access is granted by routing: every candidate must already see the source. */
export async function eligibleAutopilotMember(db: Tx, tenantId: string, id: string, inquiryId: string, conversationId: string, c: AutopilotConfig, now: Date) {
  if (c.unavailable.some(u => u.membershipId === id && new Date(u.until) > now)) return null;
  await db.$queryRaw`SELECT id FROM "Membership" WHERE "tenantId" = ${tenantId} AND id = ${id} FOR SHARE`;
  const member = await db.membership.findFirst({ where: { tenantId, id, active: true }, include: { user: true } });
  if (!member || member.user.status !== "active" || !["owner", "director", "sales_lead", "manager"].includes(member.role)) return null;
  await db.$queryRaw`SELECT id FROM "User" WHERE id = ${member.userId} FOR SHARE`;
  const auth = await authForUserInTenant(db, member.userId, tenantId);
  if (!await db.inquiry.findFirst({ where: { AND: [inquiryAccessWhere(auth), { id: inquiryId }] }, select: { id: true } }) ||
    !await db.conversation.findFirst({ where: { AND: [conversationAccessWhere(auth), { id: conversationId }] }, select: { id: true } })) return null;
  const pref = await db.notificationPreference.findUnique({ where: { tenantId_membershipId: { tenantId, membershipId: id } } });
  const channels = (pref?.channelsJson || {}) as Record<string, boolean>, events = (pref?.eventsJson || {}) as Record<string, boolean>;
  if (channels.in_app === false || events.tasks === false) return null;
  return member;
}
export async function routeAutopilot(db: Tx, tenantId: string, ruleId: string, c: AutopilotConfig, inquiry: { id: string; conversationId: string | null; assigneeMembershipId: string | null }, now: Date) {
  if (!inquiry.conversationId) return null;
  const ids = inquiry.assigneeMembershipId ? [inquiry.assigneeMembershipId] : c.members;
  const candidates: Array<NonNullable<Awaited<ReturnType<typeof eligibleAutopilotMember>>>> = [];
  for (const id of [...ids].sort()) {
    const member = await eligibleAutopilotMember(db, tenantId, id, inquiry.id, inquiry.conversationId, c, now);
    if (member) candidates.push(member);
  }
  if (!candidates.length) return null;
  const rule = await db.routingRule.findFirstOrThrow({ where: { id: ruleId, tenantId, kind: "autopilot_first_reply" } });
  const ordered = c.members.flatMap(id => candidates.filter(m => m.id === id));
  if (inquiry.assigneeMembershipId) return candidates[0];
  if (c.routing === "least_load") {
    const counts = await db.task.groupBy({ by: ["ownerMembershipId"], where: { tenantId, ownerMembershipId: { in: ordered.map(m => m.id) }, status: { in: ["open", "in_progress", "waiting"] } }, _count: true });
    const load = new Map(counts.map(r => [r.ownerMembershipId, r._count]));
    ordered.sort((a, b) => (load.get(a.id) || 0) - (load.get(b.id) || 0) || a.id.localeCompare(b.id));
    return ordered[0];
  }
  if (c.routing === "round_robin") {
    const next = ordered[rule.cursor % ordered.length];
    await db.routingRule.update({ where: { id: rule.id }, data: { cursor: (rule.cursor + 1) % 1_000_000 } });
    return next;
  }
  return ordered[0];
}
