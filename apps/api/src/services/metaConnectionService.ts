import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { PrismaClient, Prisma } from "@creolab/db";
import { verifyHmacSha256 } from "@creolab/integrations";
import { config } from "../config.ts";
import { ApiError } from "../errors.ts";
import { requireIntegrationsAccess, requireTenant, assertConversationReachable } from "../lib/access.ts";
import type { AuthContext } from "../lib/types.ts";
import { safeEqual } from "../lib/hash.ts";
import { encryptSecret, decryptSecret, encryptionKeyVersion } from "../lib/secretBox.ts";
import { writeAudit } from "../lib/audit.ts";
import { recordExternalMessage } from "./externalMessageService.ts";
import { processTrustedIntegrationLead } from "./inquiryService.ts";

export const metaConnectSchema = z.object({ kind: z.enum(["instagram_direct", "meta_lead_forms"]), appId: z.string().regex(/^\d{1,30}$/), pageId: z.string().regex(/^\d{1,30}$/), accessToken: z.string().trim().min(20).max(4096), appSecret: z.string().trim().min(16).max(256), apiVersion: z.string().regex(/^v\d{2}\.0$/).default("v25.0") });
type MetaSecrets = { accessToken: string; appSecret: string };
type Integration = Awaited<ReturnType<PrismaClient["integration"]["findUniqueOrThrow"]>>;
type MetaSettings = { appId: string; pageId: string; accountId: string; apiVersion: string; callbackUrl: string; label: string };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
async function credentials(prisma: PrismaClient, row: Integration): Promise<MetaSecrets> {
  const credential = row.credentialId ? await prisma.credential.findFirst({ where: { id: row.credentialId, tenantId: row.tenantId, kind: "meta" } }) : null;
  if (!credential) throw new ApiError(409, "meta_disconnected", "Подключите Meta заново");
  return JSON.parse(decryptSecret(credential.encryptedValue));
}
async function metaRequest<T>(secrets: MetaSecrets, version: string, path: string, init: RequestInit = {}): Promise<T> {
  if (!/^v\d{2}\.0$/.test(version) || !path.startsWith("/")) throw new Error("Invalid Graph path");
  try {
    const response = await fetch(`https://graph.facebook.com/${version}${path}`, { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${secrets.accessToken}` }, signal: AbortSignal.timeout(20000), redirect: "error" });
    const data = await response.json() as T & { error?: { code?: number } };
    if (!response.ok || data.error) throw new ApiError(502, "meta_request_failed", `Meta отклонила запрос (${data.error?.code || response.status}). Проверьте токен и разрешения приложения.`);
    return data;
  } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(502, "meta_unavailable", "Meta не ответила. Проверьте результат операции перед повтором."); }
}
export async function connectMeta(prisma: PrismaClient, auth: AuthContext, input: z.infer<typeof metaConnectSchema>) {
  requireIntegrationsAccess(auth); const { tenantId } = requireTenant(auth);
  if (new URL(config.apiBaseUrl).protocol !== "https:") throw new ApiError(422, "https_required", "Для Meta нужен публичный HTTPS-адрес CRM");
  const secrets = { accessToken: input.accessToken, appSecret: input.appSecret };
  const debug = await metaRequest<{ data: { app_id?: string; is_valid?: boolean } }>({ ...secrets, accessToken: `${input.appId}|${input.appSecret}` }, input.apiVersion, `/debug_token?input_token=${encodeURIComponent(input.accessToken)}`);
  if (!debug.data?.is_valid || debug.data.app_id !== input.appId) throw new ApiError(422, "meta_app_mismatch", "Токен должен принадлежать указанному приложению Meta");
  const me = await metaRequest<{ id: string; name?: string; instagram_business_account?: { id: string } }>(secrets, input.apiVersion, "/me?fields=id,name,instagram_business_account");
  if (me.id !== input.pageId) throw new ApiError(422, "page_token_required", "Нужен Page Access Token выбранной страницы Facebook");
  if (input.kind === "instagram_direct" && !me.instagram_business_account?.id) throw new ApiError(422, "instagram_professional_required", "К странице не привязан профессиональный аккаунт Instagram");
  const accountId = input.kind === "instagram_direct" ? me.instagram_business_account!.id : me.id;
  const publicKey = `${input.kind}:${accountId}`;
  const previous = await prisma.integration.findUnique({ where: { publicKey } });
  if (previous && previous.tenantId !== tenantId) throw new ApiError(409, "account_in_use", "Аккаунт уже подключён к другой компании");
  // Meta has one callback per app/object. Prevent a second setup from replacing
  // an existing company's callback; different objects may share the same app.
  const peers = await prisma.integration.findMany({ where: { type: input.kind, status: { not: "disabled" }, ...(previous ? { id: { not: previous.id } } : {}) } });
  if (peers.some(peer => (peer.schemaJson as MetaSettings).appId === input.appId)) throw new ApiError(409, "meta_callback_in_use", "Это приложение уже принимает такой канал для другого аккаунта. Используйте отдельное приложение Meta.");
  if (previous?.status === "active") {
    const settings = previous.schemaJson as MetaSettings;
    if (settings.appId !== input.appId) throw new ApiError(409, "meta_app_changed", "Для смены приложения сначала отключите текущее подключение");
    if (!previous.credentialId) throw new ApiError(409, "meta_disconnected", "Сначала отключите текущее подключение");
    await prisma.$transaction(async tx => {
      await tx.credential.update({ where: { id: previous.credentialId! }, data: { encryptedValue: encryptSecret(JSON.stringify(secrets)), keyVersion: encryptionKeyVersion(), rotatedAt: new Date() } });
      await tx.integration.update({ where: { id: previous.id }, data: { schemaJson: { ...settings, apiVersion: input.apiVersion }, lastError: null } });
      await writeAudit(tx, { tenantId, actorUserId: auth.user.id, action: "integration.meta_access_updated", entityType: "integration", entityId: previous.id });
    });
    return { id: previous.id, callbackUrl: settings.callbackUrl, verifyToken: null, connected: true, note: "Доступ обновлён. Действующий приём сообщений сохранён." };
  }
  const id = previous?.id || randomUUID(), verifyToken = randomBytes(32).toString("hex");
  const callbackUrl = `${config.apiBaseUrl.replace(/\/$/, "")}/public/integrations/meta/${id}`;
  if (input.kind === "meta_lead_forms") await metaRequest(secrets, input.apiVersion, `/${input.pageId}/leadgen_forms?fields=id,name&limit=1`);
  await prisma.$transaction(async tx => {
    const data = { encryptedValue: encryptSecret(JSON.stringify(secrets)), keyVersion: encryptionKeyVersion(), rotatedAt: new Date() };
    const credential = previous?.credentialId ? await tx.credential.update({ where: { id: previous.credentialId }, data }) : await tx.credential.create({ data: { ...data, tenantId, kind: "meta", scope: "integration" } });
    const integrationData = { name: input.kind === "instagram_direct" ? "Instagram Direct" : "Meta Lead Forms", credentialId: credential.id, status: "pending", connectionStatus: "PENDING", healthStatus: "UNKNOWN", publicKey, secretHash: digest(verifyToken), schemaJson: { appId: input.appId, pageId: input.pageId, accountId, apiVersion: input.apiVersion, callbackUrl, label: me.name || accountId }, testMode: false };
    if (previous) await tx.integration.update({ where: { id }, data: integrationData });
    else await tx.integration.create({ data: { id, tenantId, type: input.kind, ...integrationData } });
    await writeAudit(tx, { tenantId, actorUserId: auth.user.id, action: `integration.${input.kind}_configured`, entityType: "integration", entityId: id });
  });
  return { id, callbackUrl, verifyToken, connected: false, note: "Укажите Callback URL и Verify Token в приложении Meta, затем нажмите «Проверить и включить» в CRM." };
}
export async function verifyMetaWebhook(prisma: PrismaClient, id: string, mode: string, token: string, challenge: string) {
  const row = await prisma.integration.findUnique({ where: { id }, include: { tenant: true } });
  if (!row || !["instagram_direct", "meta_lead_forms"].includes(row.type) || row.status === "disabled" || row.tenant.status !== "active" || mode !== "subscribe" || !row.secretHash || !safeEqual(digest(token), row.secretHash)) throw new ApiError(403, "invalid_verification", "Проверка отклонена");
  await prisma.integration.update({ where: { id }, data: { schemaJson: { ...(row.schemaJson as object), webhookVerifiedAt: new Date().toISOString() } } });
  return challenge;
}
export async function activateMeta(prisma: PrismaClient, auth: AuthContext, id: string) {
  requireIntegrationsAccess(auth); const { tenantId } = requireTenant(auth);
  const row = await prisma.integration.findFirst({ where: { id, tenantId, type: { in: ["instagram_direct", "meta_lead_forms"] }, status: { not: "disabled" } } });
  if (!row) throw new ApiError(404, "not_found", "Подключение не найдено");
  const settings = row.schemaJson as MetaSettings & { webhookVerifiedAt?: string };
  if (!settings.webhookVerifiedAt) throw new ApiError(409, "webhook_unverified", "Сначала подтвердите Callback URL в приложении Meta");
  const secrets = await credentials(prisma, row);
  const subscriptions = await metaRequest<{ data: Array<{ id: string; subscribed_fields?: string[] }> }>(secrets, settings.apiVersion, `/${settings.pageId}/subscribed_apps?fields=id,subscribed_fields`);
  const fields = new Set(subscriptions.data.find(app => app.id === settings.appId)?.subscribed_fields || []);
  const peers = await prisma.integration.findMany({ where: { tenantId, type: { in: ["instagram_direct", "meta_lead_forms"] }, status: { not: "disabled" } } });
  for (const peer of peers) {
    const peerSettings = peer.schemaJson as MetaSettings;
    if (peerSettings.appId === settings.appId && peerSettings.pageId === settings.pageId) fields.add(peer.type === "meta_lead_forms" ? "leadgen" : "messages");
  }
  await metaRequest(secrets, settings.apiVersion, `/${settings.pageId}/subscribed_apps`, { method: "POST", body: JSON.stringify({ subscribed_fields: [...fields] }) });
  await prisma.channelConnection.updateMany({ where: { integrationId: id, tenantId }, data: { status: "active" } });
  await prisma.integration.update({ where: { id }, data: { status: "active", connectionStatus: "CONNECTED", healthStatus: "NO_EVENTS_YET", lastError: null, lastSuccessAt: new Date() } });
  return { connected: true, note: "Подписка Meta включена. Проверьте доставку реального обращения; для внешних пользователей Meta может требовать одобрение приложения." };
}
export async function disconnectMeta(prisma: PrismaClient, auth: AuthContext, id: string) {
  requireIntegrationsAccess(auth); const { tenantId } = requireTenant(auth);
  const row = await prisma.integration.findFirst({ where: { id, tenantId, type: { in: ["instagram_direct", "meta_lead_forms"] } } });
  if (!row) throw new ApiError(404, "not_found", "Подключение не найдено");
  // Do not remove the page-level app subscription: the same app may also deliver the other Meta channel.
  await prisma.$transaction(async tx => {
    await tx.integration.update({ where: { id }, data: { status: "disabled", connectionStatus: "DISCONNECTED", credentialId: null, secretHash: null } });
    await tx.channelConnection.updateMany({ where: { integrationId: id, tenantId }, data: { status: "disabled" } });
    if (row.credentialId) await tx.credential.deleteMany({ where: { id: row.credentialId, tenantId } });
    await writeAudit(tx, { tenantId, actorUserId: auth.user.id, action: `integration.${row.type}_disconnected`, entityType: "integration", entityId: id });
  });
  return { disconnected: true };
}
export async function listMetaConnections(prisma: PrismaClient, auth: AuthContext) {
  requireIntegrationsAccess(auth); const { tenantId } = requireTenant(auth);
  const rows = await prisma.integration.findMany({ where: { tenantId, type: { in: ["instagram_direct", "meta_lead_forms"] } } });
  return { items: rows.map(row => ({ id: row.id, kind: row.type, connected: row.status === "active", status: row.connectionStatus, lastError: row.lastError, settings: row.schemaJson })) };
}
export async function receiveMetaWebhook(prisma: PrismaClient, id: string, raw: Buffer, signature: string) {
  const row = await prisma.integration.findUnique({ where: { id }, include: { tenant: true } });
  if (!row || !["instagram_direct", "meta_lead_forms"].includes(row.type)) throw new ApiError(404, "not_found", "Подключение не найдено");
  if (row.status !== "active" || row.tenant.status !== "active") throw new ApiError(403, "integration_disabled", "Подключение недоступно");
  const secrets = await credentials(prisma, row);
  if (!/^sha256=[a-fA-F0-9]{64}$/.test(signature) || !verifyHmacSha256(raw, secrets.appSecret, signature)) throw new ApiError(401, "invalid_signature", "Подпись Meta отклонена");
  const body = z.object({ object: z.string(), entry: z.array(z.object({ id: z.string(), messaging: z.array(z.object({ sender: z.object({ id: z.string() }), recipient: z.object({ id: z.string() }), timestamp: z.number().optional(), message: z.object({ mid: z.string(), text: z.string().optional(), is_echo: z.boolean().optional(), attachments: z.array(z.object({ type: z.string() })).optional() }).optional() })).optional(), changes: z.array(z.object({ field: z.string(), value: z.object({ leadgen_id: z.string().optional(), page_id: z.string().optional(), form_id: z.string().optional() }) })).optional() })).max(100) }).parse(JSON.parse(raw.toString("utf8")));
  const settings = row.schemaJson as MetaSettings;
  for (const entry of body.entry) {
    if (entry.id !== settings.accountId && entry.id !== settings.pageId) continue;
    if (row.type === "instagram_direct" && body.object === "instagram") {
      for (const event of entry.messaging || []) {
        if (!event.message || event.message.is_echo || event.recipient.id !== settings.accountId || event.sender.id === settings.accountId) continue;
        const text = [event.message.text, ...(event.message.attachments || []).map(file => `[Вложение Instagram: ${file.type}. Откройте оригинал в Instagram.]`)].filter(Boolean).join("\n") || "[Сообщение Instagram]";
        await recordExternalMessage(prisma, id, { eventId: `ig:${digest(event.message.mid)}`, channel: "instagram", externalUserId: event.sender.id, threadId: event.sender.id, messageId: event.message.mid, name: `Клиент Instagram ${event.sender.id}`, text, at: new Date(event.timestamp || Date.now()), raw: event as Prisma.InputJsonValue });
      }
    } else if (row.type === "meta_lead_forms" && body.object === "page") {
      for (const change of entry.changes || []) {
        if (change.field !== "leadgen" || !change.value.leadgen_id || change.value.page_id && change.value.page_id !== settings.pageId) continue;
        const leadId = change.value.leadgen_id;
        if (!/^\d+$/.test(leadId)) throw new ApiError(422, "invalid_lead_id", "Некорректный идентификатор Meta");
        const eventId = `meta-lead:${leadId}`;
        if (await prisma.inboundEvent.findUnique({ where: { integrationId_externalEventKey: { integrationId: id, externalEventKey: eventId } } })) continue;
        const lead = await metaRequest<{ id: string; created_time?: string; field_data?: Array<{ name: string; values: string[] }>; form_id?: string; ad_id?: string }>(secrets, settings.apiVersion, `/${leadId}?fields=id,created_time,field_data,form_id,ad_id`);
        if (lead.id !== leadId || change.value.form_id && lead.form_id !== change.value.form_id) throw new ApiError(422, "lead_mismatch", "Meta вернула другую заявку");
        const fields = Object.fromEntries((lead.field_data || []).map(f => [f.name, f.values.join(", ")]));
        await processTrustedIntegrationLead(prisma, row, { event_id: eventId, event_type: "inquiry.created", occurred_at: lead.created_time,
          contact: { name: fields.full_name || [fields.first_name, fields.last_name].filter(Boolean).join(" "), methods: [{ type: "phone", value: fields.phone_number || fields.phone || "" }, { type: "email", value: fields.email || "" }] },
          inquiry: { subject: "Заявка Meta Lead Forms", message: Object.entries(fields).map(([k,v]) => `${k}: ${v}`).join("\n"), custom_fields: fields }, attribution: { source: "meta_lead_forms", form_id: lead.form_id, ad_id: lead.ad_id } });
      }
    }
  }
  return { ok: true };
}

export async function sendInstagramReply(prisma: PrismaClient, auth: AuthContext, id: string, input: { text?: string; attachments?: unknown[]; idempotencyKey?: string }) {
  const { tenantId } = requireTenant(auth); await assertConversationReachable(prisma, auth, id);
  const text = String(input.text || "").trim();
  if (!text || text.length > 1000 || input.attachments?.length) throw new ApiError(422, "instagram_text_only", "Для Instagram доступны текстовые ответы до 1000 символов. Вложения отправляйте из Instagram.");
  const key = `instagram:${id}:${input.idempotencyKey || randomUUID()}`, scoped = `instagram-out:${tenantId}:${digest(key)}`;
  const claimed = await prisma.$transaction(async tx => {
    const conversation = await tx.conversation.update({ where: { tenantId_id: { tenantId, id } }, data: { updatedAt: new Date() }, include: { connection: { include: { integration: true } } } });
    if (conversation.mode !== "human" || conversation.connection?.channelType !== "instagram" || conversation.connection.integration.status !== "active") throw new ApiError(409, "instagram_unavailable", "Возьмите диалог и проверьте подключение Instagram");
    const existing = await tx.message.findUnique({ where: { connectionScopedId: scoped } });
    if (existing) { if (existing.text !== text || existing.senderUserId !== auth.user.id) throw new ApiError(409, "idempotency_conflict", "Ключ отправки уже использован"); return { existing }; }
    const last = await tx.message.findFirst({ where: { conversationId: id, tenantId, direction: "inbound", internal: false }, orderBy: { createdAt: "desc" } });
    if (!last || Date.now() - last.createdAt.getTime() > 86400000) throw new ApiError(409, "instagram_window_closed", "Истекли 24 часа после сообщения клиента. Дождитесь нового сообщения или ответьте из Instagram.");
    const message = await tx.message.create({ data: { tenantId, conversationId: id, direction: "outbound", senderKind: "staff", senderUserId: auth.user.id, text, operationState: "queued", connectionScopedId: scoped } });
    const operation = await tx.outboundOperation.create({ data: { tenantId, conversationId: id, idempotencyKey: key, controlVersion: conversation.controlVersion, state: "sending" } });
    return { message, operation, messageRevision: conversation.messageRevision, integration: conversation.connection.integration, recipientId: conversation.externalThreadId };
  });
  if (claimed.existing) return claimed.existing;
  try {
    const row = claimed.integration!, settings = row.schemaJson as MetaSettings;
    const result = await metaRequest<{ message_id: string }>(await credentials(prisma,row), settings.apiVersion, `/${settings.accountId}/messages`, { method: "POST", body: JSON.stringify({ recipient: { id: claimed.recipientId }, message: { text } }) });
    if (!result.message_id) throw new ApiError(502,"instagram_send_unknown","Meta не подтвердила отправку сообщения");
    await prisma.$transaction(async tx => {
      await tx.message.update({ where: { id: claimed.message!.id }, data: { operationState: "accepted", providerMessageId: result.message_id } });
      await tx.outboundOperation.update({ where: { id: claimed.operation!.id }, data: { state: "accepted", providerRef: result.message_id } });
      await tx.conversation.updateMany({ where: { id, messageRevision: claimed.messageRevision }, data: { waitingFor: "CLIENT", needsAttention: false, attentionReason: null } });
      await tx.conversation.update({ where: { id }, data: { messageRevision: { increment: 1 } } });
    });
  } catch (error) {
    await prisma.message.update({ where: { id: claimed.message!.id }, data: { operationState: "unknown" } });
    await prisma.outboundOperation.update({ where: { id: claimed.operation!.id }, data: { state: "unknown", error: "Отправка Instagram не подтверждена" } });throw error;
  }
  return prisma.message.findUnique({ where: { id: claimed.message!.id } });
}
