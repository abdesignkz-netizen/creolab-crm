import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "@creolab/db";
import { FEATURES } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { config } from "../config.ts";
import { assertConversationReachable, requireIntegrationsAccess, requireConfigurationTenant as requireTenant } from "../lib/access.ts";
import type { AuthContext } from "../lib/types.ts";
import { writeAudit } from "../lib/audit.ts";
import { requireFeature, getEntitlements } from "./entitlementService.ts";
import { automaticWhatsAppMode, directAiReadiness, enqueueWhatsAppAi } from "./whatsappAiService.ts";
import { enqueueConversationContext } from "./conversationContextQueue.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const websiteChatSchema = z.object({
  enabled: z.boolean(), title: z.string().trim().min(1).max(60), greeting: z.string().trim().min(1).max(500),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  origins: z.array(z.string().trim().url().max(300)).min(1).max(10).transform(values => [...new Set(values.map(value => {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) throw new ApiError(422, "invalid_origin", "Укажите HTTPS-адрес сайта без пути, например https://company.kz");
    return url.origin;
  }))]),
});
type Settings = z.infer<typeof websiteChatSchema>;
const settingsOf = (value: unknown) => value as Settings;
export async function getWebsiteChat(prisma: PrismaClient, auth: AuthContext) {
  requireIntegrationsAccess(auth); const { tenantId } = requireTenant(auth);
  const row = await prisma.integration.findFirst({ where: { tenantId, type: "website_chat" }, include: { channelConnections: true } });
  return { item: row ? { id: row.id, publicKey: row.publicKey, connected: row.status === "active", aiEnabled: row.channelConnections.some(c => c.autoReply), settings: row.schemaJson,
    snippet: `<script src="${config.apiBaseUrl.replace(/\/$/, "")}/public/chat/widget.js" data-basqar="${row.publicKey}" defer></script>` } : null };
}
export async function saveWebsiteChat(prisma: PrismaClient, auth: AuthContext, input: Settings) {
  requireIntegrationsAccess(auth); const { tenantId } = requireTenant(auth); await requireFeature(prisma, auth, FEATURES.CHANNELS);
  await prisma.$transaction(async tx => {
    // One widget per company; lock the tenant to serialize first-time setup.
    await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;
    const existing = await tx.integration.findFirst({ where: { tenantId, type: "website_chat" } });
    const data = { name: "Чат на сайте", status: input.enabled ? "active" : "disabled", connectionStatus: input.enabled ? "CONNECTED" : "DISCONNECTED", schemaJson: input, testMode: false };
    const row = existing ? await tx.integration.update({ where: { id: existing.id }, data }) : await tx.integration.create({ data: { tenantId, type: "website_chat", publicKey: randomUUID(), ...data } });
    const connection = await tx.channelConnection.findFirst({ where: { tenantId, integrationId: row.id } });
    if (connection) await tx.channelConnection.update({ where: { id: connection.id }, data: { status: data.status } });
    else await tx.channelConnection.create({ data: { tenantId, integrationId: row.id, channelType: "website", status: data.status, capabilitiesJson: ["receive_messages", "send_text", "ai_replies"] } });
    await writeAudit(tx, { tenantId, actorUserId: auth.user.id, action: "integration.website_chat_configured", entityType: "integration", entityId: row.id });
  });
  return getWebsiteChat(prisma, auth);
}
export async function websiteChatOrigin(prisma: PrismaClient, publicKey: string, origin: string) {
  if (!z.string().uuid().safeParse(publicKey).success) throw new ApiError(404, "not_found", "Чат недоступен");
  const row = await prisma.integration.findFirst({ where: { publicKey, type: "website_chat", status: "active", tenant: { status: "active" } }, include: { tenant: true } });
  if (!row) throw new ApiError(404, "not_found", "Чат недоступен");
  if (!origin || !settingsOf(row.schemaJson).origins?.includes(origin)) throw new ApiError(403, "chat_origin", "Чат не подключён к этому сайту");
  return row;
}
export function publicChatSettings(row: { schemaJson: unknown }) {
  const { title, greeting, color } = settingsOf(row.schemaJson); return { title, greeting, color };
}
const tokenHash = (token: string) => {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new ApiError(401, "chat_session", "Откройте чат заново");
  return digest(token);
};
/** Browser-generated 256-bit bearer; only its digest is persisted. No CRM cookie authorizes visitor access. */
export async function openWebsiteChatSession(prisma: PrismaClient, publicKey: string, origin: string, token: string) {
  const row = await websiteChatOrigin(prisma, publicKey, origin), key = tokenHash(token);
  if (!(await getEntitlements(prisma, row.tenantId)).entitlements.CHANNELS) throw new ApiError(403, "chat_unavailable", "Чат временно недоступен");
  const aiReady = !await directAiReadiness(prisma, row.tenantId);
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Integration" WHERE id = ${row.id} FOR UPDATE`;
    const current = await tx.integration.findFirst({ where: { id: row.id, status: "active" } });
    if (!current || !settingsOf(current.schemaJson).origins.includes(origin)) throw new ApiError(403, "chat_unavailable", "Чат недоступен");
    const existing = await tx.idempotencyRecord.findUnique({ where: { scope_actorKey_key: { scope: "website.session", actorKey: row.id, key } } });
    if (existing) {
      if (existing.expiresAt < new Date() || existing.requestHash !== digest(origin)) throw new ApiError(401, "chat_session", "Сессия чата истекла");
      return;
    }
    const connection = await tx.channelConnection.findFirstOrThrow({ where: { tenantId: row.tenantId, integrationId: row.id, status: "active" } });
    const contact = await tx.contact.create({ data: { tenantId: row.tenantId, name: "Посетитель сайта", attributionJson: { source: "website_chat", site: origin } } });
    const conversation = await tx.conversation.create({ data: { tenantId: row.tenantId, contactId: contact.id, connectionId: connection.id, externalThreadId: randomUUID(), mode: aiReady && connection.autoReply && automaticWhatsAppMode(row.tenant.settingsJson, row, contact) ? "ai" : "human", needsAttention: false, waitingFor: "CLIENT" } });
    await tx.idempotencyRecord.create({ data: { scope: "website.session", actorKey: row.id, key, requestHash: digest(origin), resultJson: { conversationId: conversation.id, tenantId: row.tenantId }, expiresAt: new Date(Date.now() + 7 * 86400000) } });
  });
  return { ok: true };
}
async function session(prisma: PrismaClient, publicKey: string, origin: string, token: string) {
  const row = await websiteChatOrigin(prisma, publicKey, origin), key = tokenHash(token);
  const saved = await prisma.idempotencyRecord.findUnique({ where: { scope_actorKey_key: { scope: "website.session", actorKey: row.id, key } } });
  if (!saved || saved.expiresAt < new Date() || saved.requestHash !== digest(origin)) throw new ApiError(401, "chat_session", "Сессия чата истекла");
  const data = saved.resultJson as { conversationId: string; tenantId: string };
  const conversation = await prisma.conversation.findFirst({ where: { id: data.conversationId, tenantId: row.tenantId, connection: { integrationId: row.id, status: "active" } } });
  if (!conversation || data.tenantId !== row.tenantId) throw new ApiError(401, "chat_session", "Сессия чата недоступна");
  return { row, conversation };
}
export async function readWebsiteChat(prisma: PrismaClient, publicKey: string, origin: string, token: string) {
  const { row, conversation } = await session(prisma, publicKey, origin, token);
  const items = await prisma.message.findMany({ where: { tenantId: row.tenantId, conversationId: conversation.id, internal: false, direction: { in: ["inbound", "outbound"] }, operationState: { notIn: ["queued", "sending", "failed", "canceled", "unknown"] } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100, select: { id: true, text: true, direction: true, createdAt: true } });
  return { items: items.reverse(), status: conversation.status === "closed" ? "closed" : conversation.mode === "ai" ? "ai" : "staff" };
}
export async function receiveWebsiteChat(prisma: PrismaClient, publicKey: string, origin: string, token: string, input: unknown) {
  const { text, idempotencyKey } = z.object({ text: z.string().trim().min(1).max(4000), idempotencyKey: z.string().uuid() }).parse(input);
  const { row, conversation } = await session(prisma, publicKey, origin, token);
  if (!(await getEntitlements(prisma, row.tenantId)).entitlements.CHANNELS) throw new ApiError(403, "chat_unavailable", "Чат временно недоступен");
  await prisma.$transaction(async tx => {
    const current = await tx.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });
    if (current.status !== "open") throw new ApiError(409, "chat_closed", "Диалог завершён. Начните новый чат.");
    const scoped = `website:${conversation.id}:${idempotencyKey}`;
    const previous = await tx.message.findUnique({ where: { connectionScopedId: scoped } });
    if (previous) { if (previous.text !== text) throw new ApiError(409, "idempotency_conflict", "Ключ сообщения уже использован"); return; }
    const message = await tx.message.create({ data: { tenantId: row.tenantId, conversationId: conversation.id, direction: "inbound", senderKind: "client", text, connectionScopedId: scoped } });
    await tx.conversation.update({ where: { id: conversation.id }, data: { lastInboundMessageId: message.id, messageRevision: { increment: 1 }, waitingFor: "MANAGER", needsAttention: true, attentionReason: "client_waiting" } });
    await tx.contact.update({ where: { id: conversation.contactId! }, data: { lastSeenAt: new Date(), lastInboundMessageAt: new Date() } });
    await tx.integration.update({ where: { id: row.id }, data: { lastEventAt: new Date(), lastSuccessAt: new Date(), healthStatus: "HEALTHY" } });
    await enqueueConversationContext(tx, row.tenantId, conversation.id, message.id);
    await enqueueWhatsAppAi(tx, row.tenantId, conversation.id, message.id);
  });
  return readWebsiteChat(prisma, publicKey, origin, token);
}
export async function sendWebsiteReply(prisma: PrismaClient, auth: AuthContext, id: string, input: { text?: string; idempotencyKey?: string; attachments?: unknown[] }) {
  const { tenantId } = requireTenant(auth); await assertConversationReachable(prisma, auth, id);
  const text = String(input.text || "").trim();
  if (!text || text.length > 4000 || input.attachments?.length) throw new ApiError(422, "website_text_only", "В чате сайта доступны текстовые сообщения до 4000 символов");
  return prisma.$transaction(async tx => {
    const conversation = await tx.conversation.update({ where: { tenantId_id: { tenantId, id } }, data: { updatedAt: new Date() }, include: { connection: { include: { integration: true } } } });
    if (conversation.mode !== "human" || conversation.status !== "open" || conversation.connection?.channelType !== "website" || conversation.connection.status !== "active" || conversation.connection.integration.status !== "active") throw new ApiError(409, "website_unavailable", "Возьмите диалог и проверьте подключение чата");
    const scoped = `website-out:${id}:${input.idempotencyKey || randomUUID()}`;
    const previous = await tx.message.findUnique({ where: { connectionScopedId: scoped } });
    if (previous) { if (previous.text !== text || previous.senderUserId !== auth.user.id) throw new ApiError(409, "idempotency_conflict", "Ключ сообщения уже использован"); return previous; }
    const message = await tx.message.create({ data: { tenantId, conversationId: id, senderKind: "staff", senderUserId: auth.user.id, direction: "outbound", text, operationState: "accepted", connectionScopedId: scoped } });
    await tx.conversation.update({ where: { id }, data: { messageRevision: { increment: 1 }, waitingFor: "CLIENT", needsAttention: false, attentionReason: null } });
    await enqueueConversationContext(tx, tenantId, id, message.id); return message;
  });
}
