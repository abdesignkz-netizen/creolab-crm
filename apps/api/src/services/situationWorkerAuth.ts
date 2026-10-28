import { COMPANY_ADMIN_ROLES, type Role } from "@creolab/contracts";
import type { AuthContext } from "../lib/types.ts";
import type { SituationDatabase } from "./situationEvidence.ts";

/** Only an existing active company administrator can authorize company-wide facts.
 * This is not a platform-admin impersonation or a persisted login session. */
export async function situationWorkerAuth(db: SituationDatabase, tenantId: string, membershipId?: string): Promise<AuthContext | null> {
  const member = await db.membership.findFirst({ where: { tenantId, ...(membershipId ? { id: membershipId } : {}),
    active: true, role: { in: [...COMPANY_ADMIN_ROLES] }, user: { status: "active" }, tenant: { status: "active" } },
    include: { tenant: true, user: { select: { id: true, email: true, name: true } } }, orderBy: { id: "asc" } });
  if (!member) return null;
  const activeMembership = { ...member, role: member.role as Role, permissions: Array.isArray(member.permissions) ? member.permissions as string[] : [] };
  return { user: { ...member.user, platformAdmin: false }, activeMembership, memberships: [activeMembership], sessionId: "situation-worker", client: "web" };
}
