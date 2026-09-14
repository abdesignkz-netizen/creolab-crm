import type { PrismaClient } from "@creolab/db";
import type { Permission, Role } from "@creolab/contracts";
import { can as canAccess } from "./access.ts";

export type AuthContext = {
  user: {
    id: string;
    email: string;
    name: string;
    platformAdmin: boolean;
    phone?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    middleName?: string | null;
    city?: string | null;
    avatarStorageKey?: string | null;
    locale?: string;
    timezone?: string | null;
    timeFormat?: string;
    theme?: string;
  };
  memberships: Array<{
    id: string;
    tenantId: string;
    role: Role;
    permissions: string[];
    active: boolean;
    jobTitle?: string | null;
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
  return canAccess(auth, permission);
}
