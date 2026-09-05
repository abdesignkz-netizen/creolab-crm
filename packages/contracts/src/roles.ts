export const ROLES = {
  platform_admin: "platform_admin",
  owner: "owner",
  sales_lead: "sales_lead",
  manager: "manager",
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export const PERMISSIONS = {
  manageIntegrations: "manage_integrations",
  exportAll: "export_all",
  confirmPayments: "confirm_payments",
  manageMembers: "manage_members",
  manageAi: "manage_ai",
  viewAllConversations: "view_all_conversations",
  takeFromQueue: "take_from_queue",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const ROLE_PERMISSIONS: Record<Exclude<Role, "platform_admin">, Permission[]> = {
  owner: [
    PERMISSIONS.manageIntegrations,
    PERMISSIONS.exportAll,
    PERMISSIONS.confirmPayments,
    PERMISSIONS.manageMembers,
    PERMISSIONS.manageAi,
    PERMISSIONS.viewAllConversations,
    PERMISSIONS.takeFromQueue,
  ],
  sales_lead: [
    PERMISSIONS.confirmPayments,
    PERMISSIONS.viewAllConversations,
    PERMISSIONS.takeFromQueue,
  ],
  manager: [PERMISSIONS.takeFromQueue],
};

export function permissionsForRole(role: Role): Permission[] {
  if (role === ROLES.platform_admin) {
    return Object.values(PERMISSIONS);
  }
  return ROLE_PERMISSIONS[role] || [];
}

export function hasPermission(role: Role, extra: string[], permission: Permission): boolean {
  if (role === ROLES.platform_admin) return true;
  return permissionsForRole(role).includes(permission) || extra.includes(permission);
}

export const CONVERSATION_MODES = ["ai", "human", "paused"] as const;
export type ConversationMode = (typeof CONVERSATION_MODES)[number];

export function sellerModeToCrm(mode: string | null | undefined): ConversationMode {
  const value = String(mode || "AUTO").toUpperCase();
  if (value === "HUMAN") return "human";
  if (value === "PAUSED") return "paused";
  return "ai";
}

export function crmModeToSeller(mode: ConversationMode): "AUTO" | "HUMAN" | "PAUSED" {
  if (mode === "human") return "HUMAN";
  if (mode === "paused") return "PAUSED";
  return "AUTO";
}
