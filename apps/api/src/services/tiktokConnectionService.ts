import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { PrismaClient, Prisma } from "@creolab/db";
import { config } from "../config.ts";
import { ApiError } from "../errors.ts";
import { requireIntegrationsAccess, requireTenant } from "../lib/access.ts";
import type { AuthContext } from "../lib/types.ts";
import { safeEqual } from "../lib/hash.ts";
import { encryptSecret, decryptSecret, encryptionKeyVersion } from "../lib/secretBox.ts";
import { writeAudit } from "../lib/audit.ts";
import { processTrustedIntegrationLead } from "./inquiryService.ts";

const idSchema = z.string().regex(/^\d{1,30}$/);
export const tiktokConnectSchema = z.object({ appId: idSchema, advertiserId: idSchema, pageId: idSchema,
  accessToken: z.string().trim().min(20).max(4096), appSecret: z.string().trim().min(16).max(256) });
type Secrets = { appId: string; appSecret: string; accessToken: string; deliveryKey: string; callbackUrl: string };
type Settings = { advertiserId: string; pageId: string; label: string; subscriptionId?: string; checkingAt?: string };
type Integration = Awaited<ReturnType<PrismaClient["integration"]["findUniqueOrThrow"]>>;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

// TikTok documents numeric IDs in webhook payloads. Preserve their original digits
// using the JSON source context available in the project's Node >=22.18 runtime.
export function parseTikTokJson(raw: string): unknown {
  try {
    return JSON.parse(raw, ((key: string, value: unknown, context?: { source: string }) => {
      if (typeof value === "number" && (key === "id" || key.endsWith("_id"))) {
        if (context?.source && /^\d+$/.test(context.source)) return context.source;
        if (!Number.isSafeInteger(value)) throw new Error("Unsafe identifier");
        return String(value);
      }
      return value;
    }) as Parameters<typeof JSON.parse>[1]);
  } catch { throw new ApiError(422, "invalid_tiktok_json", "Некорректное событие TikTok"); }
}
async function requestTikTok<T>(secrets: Secrets, path: string, body?: object): Promise<T> {
  try {
    const response = await fetch(`https://business-api.tiktok.com/open_api/v1.3/${path}`, {
      method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", "Access-Token": secrets.accessToken },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000), redirect: "error",
    });
    const result = parseTikTokJson(await response.text()) as { code: number; data: T };
    if (!response.ok || result.code !== 0) throw new ApiError(502, "tiktok_request_failed", `TikTok отклонил запрос (${result.code ?? response.status}). Проверьте доступ приложения к заявкам и рекламному аккаунту.`);
    return result.data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // Never log the provider URL: subscription/get requires the app secret in its query.
    throw new ApiError(502, "tiktok_unavailable", "TikTok не подтвердил операцию. Нажмите «Проверить подключение» для проверки подписки.");
  }
}
async function secretsFor(prisma: PrismaClient, row: Integration): Promise<Secrets> {
  const credential = row.credentialId ? await prisma.credential.findFirst({ where: { id: row.credentialId, tenantId: row.tenantId, kind: "tiktok_leads" } }) : null;
  if (!credential) throw new ApiError(409, "tiktok_disconnected", "Доступ TikTok не настроен");
  return JSON.parse(decryptSecret(credential.encryptedValue));
}
async function ownedSubscriptions(secrets: Secrets) {
  const found: string[] = [];
  for (let page = 1; ; page++) {
    const query = new URLSearchParams({ app_id: secrets.appId, secret: secrets.appSecret, subscribe_entity: "LEAD", page: String(page), page_size: "100" });
    const data = await requestTikTok<{ subscriptions?: Array<{ callback_url: string; subscription_id: string }>; page_info?: { total_page: number } }>(secrets, `subscription/get/?${query}`);
    for (const subscription of data.subscriptions || []) if (subscription.callback_url === secrets.callbackUrl) found.push(subscription.subscription_id);
    if (page >= (data.page_info?.total_page || 1)) return found;
    if (page >= 1000) throw new ApiError(502, "tiktok_pagination", "Не удалось проверить все подписки TikTok");
  }
}
export async function connectTikTok(prisma: PrismaClient, auth: AuthContext, input: z.infer<typeof tiktokConnectSchema>) {
  requireIntegrationsAccess(auth); const { tenantId } = requireTenant(auth);
  if (new URL(config.apiBaseUrl).protocol !== "https:") throw new ApiError(422, "https_required", "Для TikTok нужен публичный HTTPS-адрес CRM");
  const publicKey = `tiktok:${input.advertiserId}:${input.pageId}`;
  const previous = await prisma.integration.findUnique({ where: { publicKey } });
  if (previous && previous.tenantId !== tenantId) throw new ApiError(409, "account_in_use", "Форма уже подключена к другой компании");
  if (previous && previous.status !== "disabled") throw new ApiError(409, "tiktok_exists", "Подключение уже настроено. Используйте проверку или сначала отключите его.");
  const id = previous?.id || randomUUID(), deliveryKey = randomBytes(32).toString("hex");
  // Business API LEAD subscriptions do not document the signature header of
  // TikTok for Developers. Authenticate this separate API with a secret callback URL.
  const secrets: Secrets = { ...input, deliveryKey, callbackUrl: `${config.apiBaseUrl.replace(/\/$/, "")}/public/integrations/tiktok/${id}/${deliveryKey}` };
  const fields = await requestTikTok<{ fields: string[]; meta_data: { page_id: string; page_name?: string } }>(secrets,
    `lead/field/get/?${new URLSearchParams({ lead_source: "INSTANT_FORM", advertiser_id: input.advertiserId, page_id: input.pageId })}`);
  if (fields.meta_data?.page_id !== input.pageId || !Array.isArray(fields.fields)) throw new ApiError(422, "tiktok_form_unavailable", "TikTok не подтвердил доступ к выбранной форме");
  await prisma.$transaction(async tx => {
    const credential = await tx.credential.create({ data: { tenantId, kind: "tiktok_leads", scope: "integration", encryptedValue: encryptSecret(JSON.stringify(secrets)), keyVersion: encryptionKeyVersion() } });
    const data = { credentialId: credential.id, name: "TikTok Leads", status: "pending", connectionStatus: "PENDING", healthStatus: "UNKNOWN", secretHash: digest(deliveryKey), lastError: null,
      schemaJson: { advertiserId: input.advertiserId, pageId: input.pageId, label: fields.meta_data.page_name || input.pageId }, testMode: false };
    if (previous) await tx.integration.update({ where: { id }, data });
    else await tx.integration.create({ data: { id, tenantId, publicKey, type: "tiktok_leads", ...data } });
    await writeAudit(tx, { tenantId, actorUserId: auth.user.id, action: "integration.tiktok_configured", entityType: "integration", entityId: id });
  });
  return checkTikTok(prisma, auth, id);
}
async function claimOperation(prisma: PrismaClient, row: Integration) {
  const settings = row.schemaJson as Settings;
  if (row.connectionStatus === "CHECKING" && Date.now() - new Date(settings.checkingAt || 0).getTime() < 300000) throw new ApiError(409, "tiktok_busy", "Проверка уже выполняется. Повторите позже.");
  const claimed = await prisma.integration.updateMany({ where: { id: row.id, status: row.status, connectionStatus: row.connectionStatus, schemaJson: { equals: row.schemaJson as Prisma.InputJsonValue } }, data: { connectionStatus: "CHECKING", schemaJson: { ...settings, checkingAt: new Date().toISOString() } } });
  if (!claimed.count) throw new ApiError(409, "tiktok_busy", "Подключение изменилось. Повторите позже.");
}
export async function checkTikTok(prisma: PrismaClient, auth: AuthContext, id: string) {
  requireIntegrationsAccess(auth); const { tenantId } = requireTenant(auth);
  const row = await prisma.integration.findFirst({ where: { id, tenantId, type: "tiktok_leads", status: { not: "disabled" } } });
  if (!row) throw new ApiError(404, "not_found", "Подключение не найдено");
  await claimOperation(prisma, row);
  try {
    const secrets = await secretsFor(prisma, row), settings = row.schemaJson as Settings;
    const existing = await ownedSubscriptions(secrets);
    const subscriptionId = existing[0] || (await requestTikTok<{ subscription_id: string }>(secrets, "subscription/subscribe/", {
      app_id: secrets.appId, secret: secrets.appSecret, subscribe_entity: "LEAD", callback_url: secrets.callbackUrl,
      subscription_detail: { access_token: secrets.accessToken, advertiser_id: settings.advertiserId, page_id: settings.pageId, lead_source: "INSTANT_FORM" },
    })).subscription_id;
    if (!subscriptionId) throw new ApiError(502, "tiktok_unconfirmed", "TikTok не вернул номер подписки. Повторите проверку.");
    await prisma.integration.updateMany({ where: { id, credentialId: row.credentialId, status: { not: "disabled" } }, data: { status: "active", connectionStatus: "CONNECTED", healthStatus: row.lastEventAt ? "HEALTHY" : "NO_EVENTS_YET", lastError: null, lastSuccessAt: new Date(), schemaJson: { ...settings, subscriptionId } } });
    return { id, connected: true };
  } catch (error) {
    await prisma.integration.updateMany({ where: { id, status: { not: "disabled" } }, data: { connectionStatus: row.status === "active" ? "CONNECTED" : "PENDING", healthStatus: "ERROR", lastError: error instanceof ApiError ? error.message : "Не удалось проверить подписку TikTok" } });
    throw error;
  }
}
export async function disconnectTikTok(prisma: PrismaClient, auth: AuthContext, id: string) {
  requireIntegrationsAccess(auth); const { tenantId } = requireTenant(auth);
  const row = await prisma.integration.findFirst({ where: { id, tenantId, type: "tiktok_leads" } });
  if (!row) throw new ApiError(404, "not_found", "Подключение не найдено");
  if (row.status === "disabled") return { disconnected: true };
  await claimOperation(prisma, row);
  try {
  const secrets = await secretsFor(prisma, row);
  for (const subscriptionId of await ownedSubscriptions(secrets)) await requestTikTok(secrets, "subscription/unsubscribe/", { app_id: secrets.appId, secret: secrets.appSecret, subscription_id: subscriptionId });
  await prisma.$transaction(async tx => {
    await tx.integration.update({ where: { id }, data: { status: "disabled", connectionStatus: "DISCONNECTED", credentialId: null, secretHash: null } });
    if (row.credentialId) await tx.credential.deleteMany({ where: { id: row.credentialId, tenantId } });
    await writeAudit(tx, { tenantId, actorUserId: auth.user.id, action: "integration.tiktok_disconnected", entityType: "integration", entityId: id });
  });
  return { disconnected: true };
  } catch (error) {
    await prisma.integration.updateMany({ where: { id, status: { not: "disabled" } }, data: { connectionStatus: row.status === "active" ? "CONNECTED" : "PENDING", lastError: "TikTok не подтвердил отключение. Повторите действие." } });
    throw error;
  }
}
export async function listTikTokConnections(prisma: PrismaClient, auth: AuthContext) {
  requireIntegrationsAccess(auth); const { tenantId } = requireTenant(auth);
  const rows = await prisma.integration.findMany({ where: { tenantId, type: "tiktok_leads" }, orderBy: { name: "asc" } });
  return { items: rows.map(row => ({ id: row.id, connected: row.status === "active", status: row.connectionStatus, lastError: row.lastError, settings: row.schemaJson })) };
}
export async function receiveTikTok(prisma: PrismaClient, id: string, key: string, raw: Buffer) {
  const row = await prisma.integration.findUnique({ where: { id }, include: { tenant: true } });
  if (!row || row.type !== "tiktok_leads" || !row.secretHash || !/^[a-f0-9]{64}$/.test(key) || !safeEqual(digest(key), row.secretHash)) throw new ApiError(401, "invalid_tiktok_key", "Событие TikTok отклонено");
  if (row.status !== "active" || row.tenant.status !== "active") throw new ApiError(403, "integration_disabled", "Подключение недоступно");
  const body = z.object({ object: z.number(), entry: z.array(z.object({ id: idSchema, advertiser_id: idSchema, page_id: idSchema, lead_source: z.string().optional(), create_time: z.number().int().min(0).max(253402300799), changes: z.array(z.object({ field: z.string().max(200), value: z.unknown() })).max(300) })).max(100) }).parse(parseTikTokJson(raw.toString("utf8")));
  if (body.object !== 1) return { ok: true };
  const settings = row.schemaJson as Settings;
  for (const entry of body.entry) {
    if (entry.advertiser_id !== settings.advertiserId || entry.page_id !== settings.pageId || entry.lead_source && entry.lead_source !== "INSTANT_FORM") continue;
    const fields = Object.fromEntries(entry.changes.map(change => [change.field, typeof change.value === "string" ? change.value : JSON.stringify(change.value ?? "")]));
    await processTrustedIntegrationLead(prisma, row, { event_id: `tiktok:${entry.id}`, event_type: "inquiry.created", occurred_at: new Date(entry.create_time * 1000).toISOString(),
      contact: { name: fields.name || fields.full_name || "", methods: [{ type: "phone", value: fields.phone_number || fields.phone || "" }, { type: "email", value: fields.email || "" }] },
      inquiry: { subject: "Заявка TikTok Leads", message: Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n"), custom_fields: fields },
      attribution: { source: "tiktok_leads", advertiser_id: entry.advertiser_id, form_id: entry.page_id } });
  }
  return { ok: true };
}
