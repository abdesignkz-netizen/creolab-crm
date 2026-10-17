import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@creolab/db";
import { verifyHmacSha256 } from "@creolab/integrations";
import { config } from "../config.ts";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { requireIntegrationsAccess, requireConfigurationTenant as requireTenant } from "../lib/access.ts";
import { encryptSecret, decryptSecret, encryptionKeyVersion } from "../lib/secretBox.ts";
import { safeEqual } from "../lib/hash.ts";
import { writeAudit } from "../lib/audit.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const scopes = ["instagram_business_basic", "instagram_business_manage_messages"];
const version = () => /^v\d{2}\.0$/.test(process.env.INSTAGRAM_API_VERSION || "") ? process.env.INSTAGRAM_API_VERSION! : "v25.0";
export const instagramOAuthConfigured = () => Boolean(process.env.INSTAGRAM_APP_ID && process.env.INSTAGRAM_APP_SECRET && process.env.INSTAGRAM_VERIFY_TOKEN);
const callbackUrl = () => `${config.appBaseUrl.replace(/\/$/, "")}/api/v1/integrations/instagram/callback`;
const webhookUrl = () => `${config.apiBaseUrl.replace(/\/$/, "")}/public/integrations/instagram`;
function configured() { if (!instagramOAuthConfigured()) throw new ApiError(503, "instagram_not_configured", "Подключение через Instagram ещё готовится. Обратитесь в поддержку BasQar."); }
/** Never return provider bodies or URLs: token exchanges contain secrets. */
async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20000), redirect: "error" });
    const data = await response.json() as T & { error?: unknown };
    if (!response.ok || data.error) throw new Error("provider");
    return data;
  } catch { throw new ApiError(502, "instagram_auth_failed", "Instagram не подтвердил доступ. Проверьте разрешения и повторите подключение."); }
}
export async function beginInstagramConnection(prisma: PrismaClient, auth: AuthContext) {
  requireIntegrationsAccess(auth); const { tenantId } = requireTenant(auth); configured();
  if (new URL(config.appBaseUrl).protocol !== "https:" || new URL(config.apiBaseUrl).protocol !== "https:") throw new ApiError(422, "https_required", "Для Instagram нужен публичный HTTPS-адрес BasQar");
  const state = randomBytes(32).toString("hex");
  await prisma.idempotencyRecord.create({ data: { scope: "instagram.oauth", actorKey: auth.sessionId, key: digest(state), requestHash: auth.user.id, resultJson: { tenantId, platformConfiguration: Boolean(auth.configurationTenant), redirectUri: callbackUrl(), appId: process.env.INSTAGRAM_APP_ID! }, expiresAt: new Date(Date.now() + 600000) } });
  const params = new URLSearchParams({ client_id: process.env.INSTAGRAM_APP_ID!, redirect_uri: callbackUrl(), response_type: "code", scope: scopes.join(","), state, enable_fb_login: "0", force_authentication: "1" });
  return { url: `https://www.instagram.com/oauth/authorize?${params}` };
}
export async function finishInstagramConnection(prisma: PrismaClient, auth: AuthContext, input: { state: string; code: string; error?: string }) {
  requireIntegrationsAccess(auth); const { tenantId } = requireTenant(auth); configured();
  if (!/^[a-f0-9]{64}$/.test(input.state)) throw new ApiError(400, "oauth_state", "Начните подключение Instagram заново");
  const saved = await prisma.idempotencyRecord.findUnique({ where: { scope_actorKey_key: { scope: "instagram.oauth", actorKey: auth.sessionId, key: digest(input.state) } } });
  const context = saved?.resultJson as { tenantId?: string; redirectUri?: string; appId?: string } | undefined;
  if (!saved || saved.expiresAt < new Date() || saved.requestHash !== auth.user.id || context?.tenantId !== tenantId || context.appId !== process.env.INSTAGRAM_APP_ID) throw new ApiError(400, "oauth_state", "Подтверждение истекло или принадлежит другой сессии. Начните подключение заново.");
  if (!(await prisma.idempotencyRecord.deleteMany({ where: { id: saved.id } })).count) throw new ApiError(409, "oauth_replayed", "Подтверждение уже использовано");
  if (input.error || !input.code || input.code.length > 4096) throw new ApiError(400, "oauth_declined", "Доступ Instagram не предоставлен");
  type ShortToken = { access_token?: string; user_id?: string; permissions?: string[] };
  const exchanged = await request<ShortToken & { data?: ShortToken[] }>("https://api.instagram.com/oauth/access_token", { method: "POST", body: new URLSearchParams({ client_id: process.env.INSTAGRAM_APP_ID!, client_secret: process.env.INSTAGRAM_APP_SECRET!, grant_type: "authorization_code", redirect_uri: context.redirectUri!, code: input.code }) });
  // Accept a single token, whether returned directly or in a data envelope; never guess between accounts.
  const short = exchanged.data === undefined ? exchanged : !exchanged.access_token && Array.isArray(exchanged.data) && exchanged.data.length === 1 ? exchanged.data[0] : null;
  if (!short || typeof short.access_token !== "string" || !short.access_token) throw new ApiError(502, "instagram_token_invalid", "Instagram не предоставил однозначный доступ к аккаунту");
  if (short.permissions !== undefined && (!Array.isArray(short.permissions) || scopes.some(scope => !short.permissions!.includes(scope)))) throw new ApiError(403, "instagram_scope_missing", "Разрешите доступ к профилю и сообщениям Instagram");
  const token = await request<{ access_token: string; expires_in: number }>(`https://graph.instagram.com/access_token?${new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: process.env.INSTAGRAM_APP_SECRET!, access_token: short.access_token })}`);
  if (!token.access_token || !Number.isFinite(token.expires_in) || token.expires_in <= 86400) throw new ApiError(502, "instagram_token_invalid", "Instagram не предоставил постоянный доступ");
  const headers = { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json" };
  const profile = await request<{ user_id: string; username: string }>(`https://graph.instagram.com/${version()}/me?fields=user_id,username`, { headers });
  const accountId = String(profile.user_id || "");
  if (!/^\d{1,30}$/.test(accountId) || !profile.username) throw new ApiError(422, "instagram_professional_required", "Выберите профессиональный аккаунт Instagram: бизнес или автор");
  const publicKey = `instagram_direct:${accountId}`;
  const previous = await prisma.integration.findUnique({ where: { publicKey } });
  if (previous && previous.tenantId !== tenantId) throw new ApiError(409, "account_in_use", "Этот Instagram уже подключён к другой компании");
  if (previous?.status === "active" && (previous.schemaJson as { loginMode?: string }).loginMode !== "instagram") throw new ApiError(409, "instagram_legacy_connected", "Аккаунт уже работает через Facebook. Сначала отключите прежнее подключение, чтобы сменить способ входа.");
  const subscribed = await request<{ success: boolean }>(`https://graph.instagram.com/${version()}/${accountId}/subscribed_apps`, { method: "POST", headers, body: JSON.stringify({ subscribed_fields: "messages" }) });
  if (subscribed.success !== true) throw new ApiError(502, "instagram_subscription_failed", "Instagram не подтвердил приём сообщений");
  return prisma.$transaction(async tx => {
    // Serialise reconnects within a company and recheck ownership after provider I/O.
    await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;
    const existing = await tx.integration.findUnique({ where: { publicKey } });
    if (existing && existing.tenantId !== tenantId) throw new ApiError(409, "account_in_use", "Этот Instagram уже подключён к другой компании");
    const credential = await tx.credential.create({ data: { tenantId, scope: "integration", kind: "meta", keyVersion: encryptionKeyVersion(), encryptedValue: encryptSecret(JSON.stringify({ accessToken: token.access_token, appSecret: process.env.INSTAGRAM_APP_SECRET!, loginMode: "instagram", expiresAt: Date.now() + token.expires_in * 1000 })) } });
    const data = { name: `Instagram @${profile.username}`, status: "active", connectionStatus: "CONNECTED", healthStatus: "NO_EVENTS_YET", lastError: null, credentialId: credential.id, secretHash: null, testMode: false,
      schemaJson: { appId: process.env.INSTAGRAM_APP_ID!, accountId, pageId: accountId, label: `@${profile.username}`, apiVersion: version(), callbackUrl: webhookUrl(), loginMode: "instagram", webhookVerifiedAt: new Date().toISOString() } };
    const row = existing ? await tx.integration.update({ where: { id: existing.id }, data }) : await tx.integration.create({ data: { tenantId, type: "instagram_direct", publicKey, ...data } });
    const connection = await tx.channelConnection.findFirst({ where: { tenantId, integrationId: row.id } });
    if (connection) await tx.channelConnection.update({ where: { id: connection.id }, data: { status: "active" } });
    else await tx.channelConnection.create({ data: { tenantId, integrationId: row.id, channelType: "instagram", status: "active", capabilitiesJson: ["receive_messages", "send_text", "ai_replies"] } });
    if (existing?.credentialId) await tx.credential.deleteMany({ where: { id: existing.credentialId, tenantId } });
    await writeAudit(tx, { tenantId, actorUserId: auth.user.id, action: "integration.instagram_connected", entityType: "integration", entityId: row.id });
    return { id: row.id };
  });
}
export function verifyInstagramWebhook(mode: string, token: string, challenge: string) {
  configured();
  if (mode !== "subscribe" || !safeEqual(token, process.env.INSTAGRAM_VERIFY_TOKEN!)) throw new ApiError(403, "invalid_verification", "Проверка отклонена");
  return challenge;
}
export async function receiveInstagramWebhook(prisma: PrismaClient, raw: Buffer, signature: string) {
  configured();
  if (!/^sha256=[a-fA-F0-9]{64}$/.test(signature) || !verifyHmacSha256(raw, process.env.INSTAGRAM_APP_SECRET!, signature)) throw new ApiError(401, "invalid_signature", "Подпись Instagram отклонена");
  let body: { object?: string; entry?: Array<{ id?: string }> };
  try { body = JSON.parse(raw.toString("utf8")); } catch { throw new ApiError(400, "invalid_json", "Некорректное событие"); }
  if (body.object !== "instagram" || !Array.isArray(body.entry) || body.entry.length > 100) return { ok: true };
  const ids = [...new Set(body.entry.map(entry => String(entry.id || "")).filter(id => /^\d{1,30}$/.test(id)))];
  const rows = await prisma.integration.findMany({ where: { type: "instagram_direct", publicKey: { in: ids.map(id => `instagram_direct:${id}`) }, status: "active", tenant: { status: "active" } } });
  const { receiveMetaWebhook } = await import("./metaConnectionService.ts");
  for (const row of rows) {
    const settings = row.schemaJson as { loginMode?: string; appId?: string };
    if (settings.loginMode === "instagram" && settings.appId === process.env.INSTAGRAM_APP_ID) await receiveMetaWebhook(prisma, row.id, raw, signature);
  }
  return { ok: true };
}
export async function refreshInstagramCredential(prisma: PrismaClient, credential: { id: string; encryptedValue: string }) {
  const value = JSON.parse(decryptSecret(credential.encryptedValue));
  if (value.loginMode !== "instagram" || value.expiresAt > Date.now() + 14 * 86400000) return value;
  const result = await request<{ access_token: string; expires_in: number }>(`https://graph.instagram.com/refresh_access_token?${new URLSearchParams({ grant_type: "ig_refresh_token", access_token: value.accessToken })}`);
  if (!result.access_token || !Number.isFinite(result.expires_in) || result.expires_in <= 86400) throw new ApiError(502, "instagram_refresh_failed", "Обновите подключение Instagram");
  const next = { ...value, accessToken: result.access_token, expiresAt: Date.now() + result.expires_in * 1000 };
  // A reconnect may have replaced this credential while refresh was in flight.
  await prisma.credential.updateMany({ where: { id: credential.id, encryptedValue: credential.encryptedValue }, data: { encryptedValue: encryptSecret(JSON.stringify(next)), rotatedAt: new Date() } });
  return next;
}
let nextRefresh = 0;
export async function refreshInstagramConnections(prisma: PrismaClient) {
  if (Date.now() < nextRefresh) return; nextRefresh = Date.now() + 3600000;
  const rows = await prisma.integration.findMany({ where: { type: "instagram_direct", status: "active", tenant: { status: "active" } } });
  for (const row of rows) {
    if ((row.schemaJson as { loginMode?: string }).loginMode !== "instagram" || !row.credentialId) continue;
    const credential = await prisma.credential.findFirst({ where: { id: row.credentialId, tenantId: row.tenantId, kind: "meta" } });
    if (!credential) continue;
    try { await refreshInstagramCredential(prisma, credential); }
    catch { await prisma.integration.updateMany({ where: { id: row.id, credentialId: credential.id, status: "active" }, data: { healthStatus: "ERROR", lastError: "Не удалось продлить доступ Instagram. Подключите аккаунт заново." } }); }
  }
}
