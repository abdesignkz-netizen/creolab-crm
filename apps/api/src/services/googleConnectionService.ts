import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient, Prisma } from "@creolab/db";
import { z } from "zod";
import { ApiError } from "../errors.ts";
import { config } from "../config.ts";
import { requireIntegrationsAccess, requireTenant } from "../lib/access.ts";
import type { AuthContext } from "../lib/types.ts";
import { encryptSecret, decryptSecret, encryptionKeyVersion } from "../lib/secretBox.ts";
import { writeAudit } from "../lib/audit.ts";

export const googleKinds = ["calendar", "google_forms", "email"] as const;
export type GoogleKind = typeof googleKinds[number];
const scopes: Record<GoogleKind, string[]> = {
  calendar: ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.calendarlist.readonly"],
  google_forms: ["https://www.googleapis.com/auth/forms.body.readonly", "https://www.googleapis.com/auth/forms.responses.readonly"],
  email: ["https://www.googleapis.com/auth/gmail.readonly"],
};
const names = { calendar: "Google Calendar", google_forms: "Google Forms", email: "Gmail" };
export const googleConnectSchema = z.object({ kind: z.enum(googleKinds), resourceId: z.string().trim().max(250).optional() });
type Tokens = { access_token: string; refresh_token?: string; expiresAt: number; scope?: string };
export function googleOAuthConfigured() { return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET); }
// OAuth returns a browser carrying a host-only session cookie, unlike server webhooks.
function callbackUrl() { return `${config.appBaseUrl.replace(/\/$/, "")}/api/v1/integrations/google/callback`; }
function assertConfigured() { if (!googleOAuthConfigured()) throw new ApiError(503, "google_not_configured", "Администратору сервиса нужно настроить Google OAuth (GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET)"); }
async function tokenRequest(body: Record<string, string>) {
  assertConfigured();
  try {
    const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...body, client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET! }), signal: AbortSignal.timeout(15000), redirect: "error" });
    const data = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
    if (!response.ok || !data.access_token) throw new ApiError(502, "google_auth_failed", "Google отклонил авторизацию. Подключите аккаунт заново.");
    return { access_token: data.access_token, refresh_token: data.refresh_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000, scope: data.scope };
  } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(502, "google_unavailable", "Google не ответил. Повторите подключение позже."); }
}
export async function beginGoogleConnection(prisma: PrismaClient, auth: AuthContext, input: z.infer<typeof googleConnectSchema>) {
  requireIntegrationsAccess(auth); const { tenantId } = requireTenant(auth); assertConfigured();
  if (input.kind === "google_forms" && !/^[A-Za-z0-9_-]{10,250}$/.test(input.resourceId || "")) throw new ApiError(422, "form_id_required", "Укажите ID формы Google из адреса редактора формы");
  const state = randomBytes(32).toString("hex");
  const redirectUri = callbackUrl();
  await prisma.idempotencyRecord.create({ data: { scope: "google.oauth", actorKey: auth.sessionId, key: createHash("sha256").update(state).digest("hex"), requestHash: auth.user.id, resultJson: { tenantId, kind: input.kind, resourceId: input.resourceId || "primary", redirectUri }, expiresAt: new Date(Date.now() + 600000) } });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID!, redirect_uri: redirectUri, response_type: "code", scope: scopes[input.kind].join(" "), access_type: "offline", prompt: "consent", state }).toString();
  return { url: url.toString() };
}
export async function finishGoogleConnection(prisma: PrismaClient, auth: AuthContext, input: { state: string; code: string; error?: string }) {
  requireIntegrationsAccess(auth); const { tenantId } = requireTenant(auth);
  if (!/^[a-f0-9]{64}$/.test(input.state)) throw new ApiError(400, "oauth_state", "Недействительное подтверждение Google");
  const key = createHash("sha256").update(input.state).digest("hex");
  const record = await prisma.idempotencyRecord.findUnique({ where: { scope_actorKey_key: { scope: "google.oauth", actorKey: auth.sessionId, key } } });
  const saved = record?.resultJson as { tenantId: string; kind: GoogleKind; resourceId: string; redirectUri?: string } | undefined;
  if (!record || record.expiresAt < new Date() || record.requestHash !== auth.user.id || saved?.tenantId !== tenantId) throw new ApiError(400, "oauth_state", "Подтверждение истекло или принадлежит другой сессии. Начните подключение заново.");
  const consumed = await prisma.idempotencyRecord.deleteMany({ where: { id: record.id } });
  if (!consumed.count) throw new ApiError(409, "oauth_replayed", "Подтверждение уже использовано");
  if (input.error || !input.code) throw new ApiError(400, "oauth_declined", "Доступ Google не предоставлен");
  // Retain the URI used at authorization even if a deployment changes the primary domain.
  // Older in-flight records used API_BASE_URL (keep it unchanged during the transition).
  const redirectUri = saved.redirectUri || `${config.apiBaseUrl.replace(/\/$/, "")}/api/v1/integrations/google/callback`;
  const tokens = await tokenRequest({ grant_type: "authorization_code", code: input.code, redirect_uri: redirectUri });
  if (tokens.scope && scopes[saved.kind].some(scope => !tokens.scope!.split(" ").includes(scope))) throw new ApiError(403, "google_scope_missing", "Предоставьте все запрошенные разрешения для подключения");
  if (!tokens.refresh_token) throw new ApiError(422, "google_offline_missing", "Google не предоставил постоянный доступ. Отзовите прежний доступ приложения в Google и подключите снова.");
  // Validate resource access before publishing the connection.
  const resourcePath = saved.kind === "calendar" ? `/calendar/v3/users/me/calendarList/${encodeURIComponent(saved.resourceId)}` : saved.kind === "google_forms" ? `/v1/forms/${encodeURIComponent(saved.resourceId)}` : "/gmail/v1/users/me/profile";
  const origin = saved.kind === "google_forms" ? "https://forms.googleapis.com" : "https://www.googleapis.com";
  const response = await fetch(`${origin}${resourcePath}`, { headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(15000), redirect: "error" });
  if (!response.ok) throw new ApiError(422, "google_resource_unavailable", "Выбранная форма, календарь или почтовый ящик недоступны этому аккаунту");
  const resource = await response.json() as { id?: string; summary?: string; emailAddress?: string; accessRole?: string; info?: { title?: string } };
  if (saved.kind === "calendar" && !["owner", "writer"].includes(resource.accessRole || "")) throw new ApiError(403, "calendar_readonly", "Нужен календарь с правом изменения событий");
  const resourceId = saved.kind === "calendar" ? resource.id || saved.resourceId : saved.kind === "email" ? resource.emailAddress?.toLowerCase() : saved.resourceId;
  if (!resourceId) throw new ApiError(422, "google_resource_unavailable", "Google не подтвердил идентификатор аккаунта");
  const keyId = `google:${saved.kind}:${tenantId}:${createHash("sha256").update(resourceId).digest("hex")}`;
  const result = await prisma.$transaction(async tx => {
    const existing = await tx.integration.findUnique({ where: { publicKey: keyId } });
    const data = { encryptedValue: encryptSecret(JSON.stringify(tokens)), keyVersion: encryptionKeyVersion(), rotatedAt: new Date() };
    // A fresh credential prevents an in-flight sync from using a newly selected account.
    const credential = await tx.credential.create({ data: { ...data, tenantId, scope: "integration", kind: `google_${saved.kind}` } });
    const schemaJson = { ...(existing?.schemaJson as object || {}), resourceId, resourceLabel: resource.summary || resource.emailAddress || resource.info?.title || resourceId, connectedAt: (existing?.schemaJson as { connectedAt?: string } | undefined)?.connectedAt || new Date().toISOString() };
    const integrationData = { name: names[saved.kind], credentialId: credential.id, status: "active", connectionStatus: "CONNECTED", healthStatus: "NO_EVENTS_YET", lastError: null, schemaJson, testMode: false };
    const integration = existing ? await tx.integration.update({ where: { id: existing.id }, data: integrationData }) : await tx.integration.create({ data: { tenantId, type: saved.kind, publicKey: keyId, ...integrationData } });
    const replaced = await tx.integration.findMany({ where: { tenantId, type: saved.kind, publicKey: { startsWith: "google:" }, id: { not: integration.id }, status: { not: "disabled" } } });
    for (const old of replaced) {
      await tx.integration.update({ where: { id: old.id }, data: { status: "disabled", connectionStatus: "DISCONNECTED", credentialId: null } });
      await tx.channelConnection.updateMany({ where: { tenantId, integrationId: old.id }, data: { status: "disabled" } });
      if (old.credentialId) await tx.credential.deleteMany({ where: { id: old.credentialId, tenantId } });
    }
    if (existing?.credentialId) await tx.credential.deleteMany({ where: { id: existing.credentialId, tenantId } });
    await tx.channelConnection.updateMany({ where: { tenantId, integrationId: integration.id }, data: { status: "active" } });
    await writeAudit(tx, { tenantId, actorUserId: auth.user.id, action: `integration.${saved.kind}_connected`, entityType: "integration", entityId: integration.id });
    return integration;
  });
  return { id: result.id, kind: saved.kind };
}

export async function googleRequest(prisma: PrismaClient, integration: { tenantId: string; credentialId: string | null; type: string }, path: string, init: RequestInit = {}) {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid Google API path");
  const credential = integration.credentialId ? await prisma.credential.findFirst({ where: { id: integration.credentialId, tenantId: integration.tenantId, kind: `google_${integration.type}` } }) : null;
  if (!credential) throw new ApiError(409, "google_disconnected", "Подключите Google-аккаунт заново");
  let tokens = JSON.parse(decryptSecret(credential.encryptedValue)) as Tokens;
  if (tokens.expiresAt < Date.now() + 60000) {
    if (!tokens.refresh_token) throw new ApiError(409, "google_expired", "Доступ Google истёк. Подключите аккаунт заново.");
    const refreshed = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    tokens = { ...tokens, ...refreshed, refresh_token: refreshed.refresh_token || tokens.refresh_token };
    await prisma.credential.update({ where: { id: credential.id }, data: { encryptedValue: encryptSecret(JSON.stringify(tokens)), rotatedAt: new Date() } });
  }
  const origin = integration.type === "google_forms" ? "https://forms.googleapis.com" : "https://www.googleapis.com";
  try { return await fetch(`${origin}${path}`, { ...init, headers: { "Content-Type": "application/json", ...init.headers, Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(20000), redirect: "error" }); }
  catch { throw new ApiError(502, "google_unavailable", "Google не ответил. Синхронизация будет повторена."); }
}
export async function listGoogleConnections(prisma: PrismaClient, auth: AuthContext) {
  requireIntegrationsAccess(auth); const { tenantId } = requireTenant(auth);
  const rows = await prisma.integration.findMany({ where: { tenantId, type: { in: [...googleKinds] }, publicKey: { startsWith: "google:" } } });
  return { configured: googleOAuthConfigured(), callbackUrl: callbackUrl(), items: googleKinds.map(kind => {
    const row = rows.find(r => r.type === kind && r.status === "active") || rows.find(r => r.type === kind);
    return { kind, title: names[kind], id: row?.id || null, connected: row?.status === "active", healthStatus: row?.healthStatus || "UNKNOWN", lastError: row?.lastError || null, resource: (row?.schemaJson as { resourceLabel?: string } | undefined)?.resourceLabel || null };
  }) };
}
export async function disconnectGoogleConnection(prisma: PrismaClient, auth: AuthContext, id: string) {
  requireIntegrationsAccess(auth); const { tenantId } = requireTenant(auth);
  const row = await prisma.integration.findFirst({ where: { id, tenantId, type: { in: [...googleKinds] } } });
  if (!row) throw new ApiError(404, "not_found", "Подключение не найдено");
  await prisma.$transaction(async tx => {
    await tx.integration.update({ where: { id }, data: { status: "disabled", connectionStatus: "DISCONNECTED", credentialId: null } });
    await tx.channelConnection.updateMany({ where: { tenantId, integrationId: id }, data: { status: "disabled" } });
    if (row.credentialId) await tx.credential.deleteMany({ where: { id: row.credentialId, tenantId } });
    await writeAudit(tx, { tenantId, actorUserId: auth.user.id, action: `integration.${row.type}_disconnected`, entityType: "integration", entityId: id });
  });
  return { disconnected: true };
}
