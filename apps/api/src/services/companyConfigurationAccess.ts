import { createHash } from "node:crypto";
import type { PrismaClient } from "@creolab/db";
import type { AuthContext } from "../lib/types.ts";
import { requirePlatformAdmin } from "../lib/access.ts";
import { ApiError } from "../errors.ts";

export const CONFIGURATION_HEADER = "x-basqar-configuration-tenant";

// Explicit method/path allowlist. This scope never grants access to messages, payments,
// personal accounts, document signing or arbitrary future endpoints under integrations.
const routes: Array<[string, RegExp]> = [
  ["GET", /^\/api\/v1\/settings\/ai-(manager|automation)$/],
  ["PATCH", /^\/api\/v1\/settings\/ai-(manager|automation)$/],
  ["POST", /^\/api\/v1\/settings\/ai-manager\/(publish|restore|reload|preview|review)$/],
  ["GET", /^\/api\/v1\/integrations\/(catalog|setup|events|whatsapp|website-chat|channels\/ai|meta|google|tiktok|esf|whatsapp-seller\/health)$/],
  ["PUT", /^\/api\/v1\/integrations\/website-chat$/],
  ["POST", /^\/api\/v1\/integrations\/(whatsapp\/(qr|cloud)|(?:telegram|meta|google|instagram|tiktok)\/connect|whatsapp-seller\/(connect|disconnect|sync|rotate-secret)|esf\/(auth-ticket|connect|disconnect))$/],
  ["GET", /^\/api\/v1\/integrations\/(whatsapp\/[^/]+\/qr|google\/[^/]+\/questions)$/],
  ["POST", /^\/api\/v1\/integrations\/(whatsapp\/[^/]+\/(activate|disconnect|ai)|channels\/[^/]+\/ai|telegram\/[^/]+\/(disconnect|check)|meta\/[^/]+\/(activate|disconnect)|tiktok\/[^/]+\/(disconnect|check)|google\/[^/]+\/(disconnect|sync)|[^/]+\/(health-check|test-mode|rotate-secret))$/],
  ["PATCH", /^\/api\/v1\/integrations\/google\/[^/]+\/mapping$/],
];

export function configurationRouteAllowed(method: string, path: string) {
  return routes.some(([verb, pattern]) => method === verb && pattern.test(path));
}

export async function scopeCompanyConfiguration(prisma: PrismaClient, auth: AuthContext, tenantId: string): Promise<AuthContext> {
  requirePlatformAdmin(auth);
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: {
    id: true, name: true, slug: true, status: true, timezone: true, currency: true, defaultRegion: true,
  } });
  if (!tenant) throw new ApiError(404, "not_found", "Компания не найдена");
  if (tenant.status !== "active") throw new ApiError(403, "tenant_suspended", "Сначала восстановите доступ компании");
  return { ...auth, activeMembership: null, configurationTenant: { tenantId: tenant.id, tenant } };
}

/** Recover ONLY server-recorded scope bound to this exact actor and session after OAuth. */
export async function configurationOAuthAuth(prisma: PrismaClient, auth: AuthContext, provider: "google" | "instagram", state: string) {
  if (!/^[a-f0-9]{64}$/.test(state)) return auth;
  const record = await prisma.idempotencyRecord.findUnique({ where: { scope_actorKey_key: {
    scope: `${provider}.oauth`, actorKey: auth.sessionId, key: createHash("sha256").update(state).digest("hex"),
  } } });
  const saved = record?.resultJson as { tenantId?: string; platformConfiguration?: boolean } | null;
  if (!saved?.platformConfiguration) return auth;
  // Expiry is checked by finish*Connection before any token exchange. Keep the
  // authenticated return destination even for an expired flow.
  if (!record || record.requestHash !== auth.user.id || !saved.tenantId) throw new ApiError(400, "oauth_state", "Подтверждение истекло. Начните подключение заново.");
  return scopeCompanyConfiguration(prisma, auth, saved.tenantId);
}

export function configurationReturnPath(auth: AuthContext) {
  return auth.configurationTenant
    ? `/admin/companies/${encodeURIComponent(auth.configurationTenant.tenantId)}?tab=integrations`
    : "/integrations";
}
