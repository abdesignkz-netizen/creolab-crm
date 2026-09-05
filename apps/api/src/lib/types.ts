import type { PrismaClient } from "@creolab/db";
import type { Permission, Role } from "@creolab/contracts";

export type AuthContext = {
  user: {
    id: string;
    email: string;
    name: string;
    platformAdmin: boolean;
  };
  memberships: Array<{
    id: string;
    tenantId: string;
    role: Role;
    permissions: string[];
    active: boolean;
    tenant: { id: string; name: string; slug: string; status: string; timezone: string; currency: string; defaultRegion: string };
  }>;
  activeMembership: AuthContext["memberships"][number] | null;
  sessionId: string;
  client: "web" | "mobile";
};

export type AppContext = {
  prisma: PrismaClient;
  auth: AuthContext | null;
};

export function can(auth: AuthContext | null, permission: Permission): boolean {
  if (!auth?.activeMembership && !auth?.user.platformAdmin) return false;
  if (auth.user.platformAdmin) return true;
  const role = auth.activeMembership?.role;
  if (!role) return false;
  if (role === "owner" || role === "sales_lead") {
    if (permission === "view_all_conversations") return true;
  }
  if (role === "owner") return true;
  if (role === "sales_lead" && permission !== "manage_integrations" && permission !== "export_all" && permission !== "manage_members") {
    return true;
  }
  return Boolean(auth.activeMembership?.permissions.includes(permission));
}
