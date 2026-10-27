import { createHash, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@creolab/db";
import type { MessageDeliveryPart, MessageRetryBlock } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { encryptSecret, decryptSecret } from "../lib/secretBox.ts";
import { phoneFromContact } from "./contactLabels.ts";
import { enqueueConversationContext } from "./conversationContextQueue.ts";

type Db = PrismaClient | Prisma.TransactionClient;
export const aiReplyScope = "ai.reply.delivery";
export const aiReplyChannels = ["whatsapp_qr", "whatsapp_cloud", "telegram_bot", "instagram_direct"] as const;
export type AiReplyDelivery = {
  version: 1; messageId: string; operationId: string; conversationId: string; contactId: string | null;
  integrationId: string; connectionId: string; channel: typeof aiReplyChannels[number]; binding: string; credentialHash: string | null;
  target: string; recipient: string; senderPhone: string; sourceMessageId: string; handoff: boolean;
  controlVersion: number; messageRevision: number; text: string; textHash: string; policyHash: string;
  queueToken: string; generation: number; reviewerId?: string; queued: boolean; claim: string | null; leaseUntil: number;
  intent: boolean; state: MessageDeliveryPart["state"]; providerMessageId: string | null; receipt?: "sent" | "failed" | "delivered" | "read";
  canceled?: boolean; completed?: boolean; attentionRevision?: number;
  checkedBy?: string; checkedAt?: string; note?: string;
};
export const aiReplyHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const aiReplyChanged = () => new ApiError(409, "delivery_changed", "Результат отправки изменился. Обновите проверку.");
export const aiReplyBusy = (v: AiReplyDelivery) => v.queued || Boolean(v.claim && v.leaseUntil > Date.now());
export const aiReplyRevision = (v: AiReplyDelivery) => aiReplyHash(JSON.stringify(v));
export const lockAiReply = (tx: Prisma.TransactionClient, tenantId: string, conversationId: string) => tx.$queryRaw`SELECT id FROM "Conversation" WHERE id = ${conversationId} AND "tenantId" = ${tenantId} FOR UPDATE`;
const key = (tenantId: string, messageId: string) => ({ scope: aiReplyScope, actorKey: tenantId, key: messageId });
export async function readAiReply(db: Db, tenantId: string, messageId: string) {
  const row = await db.idempotencyRecord.findUnique({ where: { scope_actorKey_key: key(tenantId, messageId) } });
  const value = row?.resultJson as unknown as AiReplyDelivery | undefined;
  return value?.version === 1 ? value : null;
}
export async function saveAiReply(db: Db, tenantId: string, value: AiReplyDelivery) {
  const data = { requestHash: value.operationId, resultJson: value as unknown as Prisma.InputJsonValue, expiresAt: new Date("9999-01-01") };
  await db.idempotencyRecord.upsert({ where: { scope_actorKey_key: key(tenantId, value.messageId) }, create: { ...key(tenantId, value.messageId), ...data }, update: data });
}
export async function aiReplyPolicyHash(db: Db, tenantId: string) {
  const [tenant, configs, knowledge] = await Promise.all([
    db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settingsJson: true } }),
    db.aIConfiguration.findMany({ where: { tenantId }, orderBy: { id: "asc" }, select: { id: true, scope: true, connectionId: true, enabled: true, systemPrompt: true, promptStatus: true, publishedVersionId: true } }),
    db.knowledgeDocument.findMany({ where: { tenantId, status: "published" }, orderBy: { id: "asc" }, select: { id: true, updatedAt: true } }),
  ]);
  const settings = tenant.settingsJson as Record<string, unknown> | null;
  return aiReplyHash(JSON.stringify([settings?.aiAutomation, configs, knowledge]));
}
function binding(integration: { type: string; publicKey: string | null; credentialId: string | null; schemaJson: unknown }) {
  const s = (integration.schemaJson || {}) as Record<string, unknown>;
  return aiReplyHash(JSON.stringify([integration.type, integration.publicKey, integration.credentialId,
    s.phone, s.appId, s.wabaId, s.phoneNumberId, s.accountId, s.pageId, s.apiVersion]));
}
export async function initializeAiReply(tx: Prisma.TransactionClient, tenantId: string, messageId: string, policyHash?: string) {
  const message = await tx.message.findFirstOrThrow({ where: { id: messageId, tenantId }, include: { attachments: true, conversation: { include: { contact: { include: { methods: true } }, connection: { include: { integration: true } } } } } });
  const conv = message.conversation, connection = conv.connection, row = connection?.integration;
  if (message.senderKind !== "ai" || !row || !aiReplyChannels.includes(row.type as AiReplyDelivery["channel"])) return null;
  // Voice replies keep their existing attachment-aware delivery path.
  if (message.attachments.length || !message.text) return null;
  const existing = await readAiReply(tx, tenantId, messageId); if (existing) return existing;
  const ops = await tx.outboundOperation.findMany({ where: { tenantId, conversationId: conv.id, providerRef: messageId }, take: 2 });
  const op = ops.length === 1 ? ops[0] : null;
  if (!op || op.state !== "queued" || !op.idempotencyKey.startsWith("wa-ai")) throw aiReplyChanged();
  const sourceMessageId = op.idempotencyKey.split(":")[2];
  if (!await tx.message.count({ where: { id: sourceMessageId, tenantId, conversationId: conv.id, direction: "inbound", internal: false } })) throw aiReplyChanged();
  const credential = row.credentialId ? await tx.credential.findFirst({ where: { id: row.credentialId, tenantId } }) : null;
  const target = conv.externalThreadId || "", phone = phoneFromContact(conv.contact, { externalThreadId: target });
  const value: AiReplyDelivery = { version: 1, messageId, operationId: op.id, conversationId: conv.id, contactId: conv.contactId,
    integrationId: row.id, connectionId: connection!.id, channel: row.type as AiReplyDelivery["channel"], binding: binding(row),
    // Instagram refreshes short-lived tokens itself; account and credential identity stay bound.
    credentialHash: credential && row.type !== "instagram_direct" ? aiReplyHash(credential.encryptedValue) : null,
    target, recipient: [conv.contact?.name || "Клиент", phone || (target.endsWith("@lid") ? "Номер скрыт WhatsApp" : `${row.type === "telegram_bot" ? "Telegram" : row.type === "instagram_direct" ? "Instagram" : "WhatsApp"}: ${target}`)].join(" · "),
    senderPhone: String((row.schemaJson as any)?.phone || "").replace(/\D/g, ""), sourceMessageId, handoff: op.idempotencyKey.startsWith("wa-ai-handoff:"),
    controlVersion: op.controlVersion, messageRevision: Number(op.requestHash), text: message.text, textHash: aiReplyHash(message.text), policyHash: policyHash || await aiReplyPolicyHash(tx, tenantId),
    queueToken: randomUUID(), generation: 0, queued: true, claim: null, leaseUntil: 0, intent: false, state: "pending", providerMessageId: null };
  if (!Number.isInteger(value.messageRevision)) throw aiReplyChanged();
  await saveAiReply(tx, tenantId, value); return value;
}
export async function enqueueAiReply(tx: Prisma.TransactionClient, tenantId: string, v: AiReplyDelivery) {
  const payload = { messageId: v.messageId, integrationId: v.integrationId, deliveryToken: v.queueToken };
  if (v.channel === "whatsapp_qr") {
    const id = v.generation ? `${v.messageId}:${v.queueToken}` : v.messageId;
    await tx.$executeRaw`INSERT INTO "WhatsAppQrJob" (id, "integrationId", kind, "encryptedPayload") VALUES (${id}, ${v.integrationId}, 'outbound', ${encryptSecret(JSON.stringify(payload))})`;
  } else await tx.outboxEvent.create({ data: { id: v.generation ? `wa-send:${v.messageId}:${v.queueToken}` : `wa-send:${v.messageId}`, tenantId,
    type: v.channel === "whatsapp_cloud" ? "whatsapp.cloud_send" : "channel.send", entityType: "message", entityId: v.messageId, payloadJson: payload } });
}
export async function aiReplyGate(db: Db, tenantId: string, conversationId: string, excludeId?: string) {
  const rows = await db.message.findMany({ where: { tenantId, conversationId, senderKind: "ai", direction: "outbound", internal: false,
    operationState: { in: ["unknown", "sending"] }, ...(excludeId ? { id: { not: excludeId } } : {}) }, orderBy: { operationState: "desc" }, select: { id: true, operationState: true } });
  if (!rows.length) return null;
  // Do not retroactively lock old conversations whose replies have no reconciliation snapshot.
  const tracked = await trackedAiReplyIds(db, tenantId, rows.map(row => row.id));
  return rows.find(row => tracked.has(row.id))?.operationState || null;
}
export async function aiReplyBlock(db: Db, tenantId: string, v: AiReplyDelivery): Promise<MessageRetryBlock> {
  const message = await db.message.findFirst({ where: { id: v.messageId, tenantId, conversationId: v.conversationId, senderKind: "ai", direction: "outbound", internal: false }, include: { attachments: true } });
  const conv = await db.conversation.findFirst({ where: { id: v.conversationId, tenantId }, include: { connection: { include: { integration: true } } } });
  if (!message || message.attachments.length || aiReplyHash(message.text || "") !== v.textHash || !conv || conv.status !== "open"
    || conv.controlVersion !== v.controlVersion || conv.messageRevision !== v.messageRevision + (v.completed ? 1 : 0) || conv.contactId !== v.contactId
    || conv.connectionId !== v.connectionId || conv.externalThreadId !== v.target) return "conversation_changed";
  const row = conv.connection?.integration;
  if (!row || row.tenantId !== tenantId || row.id !== v.integrationId || row.status !== "active" || conv.connection?.status !== "active" || binding(row) !== v.binding) return "connection_changed";
  if (v.credentialHash) {
    const credential = await db.credential.findFirst({ where: { id: row.credentialId || "", tenantId } });
    if (!credential || aiReplyHash(credential.encryptedValue) !== v.credentialHash) return "connection_changed";
  }
  if (v.reviewerId && !await db.membership.count({ where: { tenantId, userId: v.reviewerId, active: true, role: { not: "manager" }, tenant: { status: "active" } } })) return "permissions";
  const last = await db.message.findFirst({ where: { tenantId, conversationId: conv.id, direction: "inbound", internal: false }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  if (!last || (conv.lastInboundMessageId || last.id) !== v.sourceMessageId) return "conversation_changed";
  if (["whatsapp_cloud", "instagram_direct"].includes(v.channel) && Date.now() - last.createdAt.getTime() >= 86_400_000) return "window_closed";
  if (await aiReplyPolicyHash(db, tenantId) !== v.policyHash) return "policy_changed";
  const { directAiSendAllowed } = await import("./whatsappAiService.ts");
  if (!await directAiSendAllowed(db as PrismaClient, tenantId, conv.id, v.controlVersion, v.messageRevision + (v.completed ? 1 : 0), v.handoff ? v.sourceMessageId : undefined, v.messageId)) return "policy_changed";
  return null;
}

export async function publishAiReply(tx: Prisma.TransactionClient, tenantId: string, v: AiReplyDelivery, continueAi = false) {
  if (v.channel === "whatsapp_cloud" && v.providerMessageId) {
    const receipt = await tx.idempotencyRecord.findUnique({ where: { scope_actorKey_key: { scope: "whatsapp.direct.receipt", actorKey: tenantId, key: `${v.integrationId}:${aiReplyHash(v.providerMessageId)}` } } });
    const ranks = ["sent", "failed", "delivered", "read"];
    if (receipt && ranks.includes(receipt.requestHash) && ranks.indexOf(receipt.requestHash) >= ranks.indexOf(v.receipt || "")) {
      v.receipt = receipt.requestHash as AiReplyDelivery["receipt"];
      if (v.receipt === "failed") v.state = "failed";
      if (["delivered", "read"].includes(v.receipt || "")) v.state = "accepted";
    }
  }
  const state = v.claim ? "sending" : v.queued ? "queued" : v.canceled && !v.intent ? "canceled" : v.state === "pending" ? "failed" : v.state;
  const receiptState = v.state === "accepted" ? v.checkedBy ? "reconciled" : ["read", "delivered"].includes(v.receipt || "") ? v.receipt! : "sent" : v.receipt === "failed" ? "failed" : "unknown";
  await tx.message.update({ where: { id: v.messageId, tenantId }, data: { operationState: state, receiptState, providerMessageId: v.providerMessageId } });
  await tx.outboundOperation.update({ where: { id: v.operationId, tenantId }, data: { state, error: ["unknown", "failed"].includes(state) ? "Отправка ответа ИИ не подтверждена" : null } });
  const match = { id: v.conversationId, tenantId, status: "open", controlVersion: v.controlVersion, connectionId: v.connectionId, contactId: v.contactId, externalThreadId: v.target };
  const completedNow = state === "accepted" && !v.completed;
  if (completedNow) {
    if (!v.handoff) await tx.conversation.updateMany({ where: { ...match, mode: "ai", messageRevision: v.messageRevision }, data: { waitingFor: "CLIENT", needsAttention: false, attentionReason: null } });
    await tx.conversation.update({ where: { id: v.conversationId, tenantId }, data: { messageRevision: { increment: 1 } } });
    await enqueueConversationContext(tx, tenantId, v.conversationId, v.messageId); v.completed = true;
  }
  if (["unknown", "failed"].includes(state) && !v.handoff) {
    const revision = v.messageRevision + (v.completed ? 1 : 0);
    const latest = await tx.message.findFirst({ where: { tenantId, conversationId: v.conversationId, direction: "outbound", internal: false }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    if (latest?.id === v.messageId && (await tx.conversation.updateMany({ where: { ...match, mode: "ai", messageRevision: revision }, data: {
      needsAttention: true, waitingFor: "MANAGER", attentionReason: state === "unknown" ? "AI_DELIVERY_UNKNOWN" : "AI_DELIVERY_NOT_SENT" } })).count) v.attentionRevision = revision;
  } else if (state === "accepted" && v.attentionRevision !== undefined && !v.handoff) {
    await tx.conversation.updateMany({ where: { ...match, mode: "ai", messageRevision: v.attentionRevision, attentionReason: { in: ["AI_DELIVERY_UNKNOWN", "AI_DELIVERY_NOT_SENT"] } },
      data: { needsAttention: false, waitingFor: "CLIENT", attentionReason: null } }); delete v.attentionRevision;
  }
  await saveAiReply(tx, tenantId, v);
  if (completedNow && continueAi) await (await import("./whatsappAiService.ts")).enqueueWhatsAppAi(tx, tenantId, v.conversationId);
}
/** Recovery records uncertainty and fences the worker. It never invokes a provider. */
export async function recoverAiReplyDeliveries(prisma: PrismaClient, options: { integrationId?: string; force?: boolean } = {}) {
  const rows = await prisma.idempotencyRecord.findMany({ where: { scope: aiReplyScope, AND: [
    { resultJson: { path: ["leaseUntil"], gt: 0, ...(!options.force ? { lte: Date.now() } : {}) } },
    ...(options.integrationId ? [{ resultJson: { path: ["integrationId"], equals: options.integrationId } }] : []),
  ] }, take: options.integrationId ? undefined : 50, orderBy: { createdAt: "asc" } });
  for (const row of rows) await prisma.$transaction(async tx => {
    const previous = row.resultJson as unknown as AiReplyDelivery;
    await lockAiReply(tx, row.actorKey, previous.conversationId);
    const v = await readAiReply(tx, row.actorKey, row.key);
    if (!v?.claim || (!options.force && v.leaseUntil > Date.now())) return;
    if (v.state === "sending") v.state = "unknown";
    v.claim = null; v.queued = false; v.leaseUntil = 0; await publishAiReply(tx, row.actorKey, v);
  });
}
export async function restoreUnstartedAiQrJobs(prisma: PrismaClient, integrationId: string) {
  const jobs = await prisma.$queryRaw<Array<{ id: string; encryptedPayload: string }>>`SELECT id, "encryptedPayload" FROM "WhatsAppQrJob" WHERE "integrationId" = ${integrationId} AND kind = 'outbound' AND state = 'sending'`;
  for (const job of jobs) {
    const payload = JSON.parse(decryptSecret(job.encryptedPayload));
    const message = await prisma.message.findFirst({ where: { id: payload.messageId, senderKind: "ai" }, select: { tenantId: true, conversationId: true } });
    if (!message) continue;
    await prisma.$transaction(async tx => {
      await lockAiReply(tx, message.tenantId, message.conversationId); const v = await readAiReply(tx, message.tenantId, payload.messageId);
      if (!v || v.integrationId !== integrationId || !v.queued || v.claim || payload.deliveryToken !== v.queueToken) return;
      await tx.$executeRaw`UPDATE "WhatsAppQrJob" SET state = 'queued' WHERE id = ${job.id} AND state = 'sending'`;
    });
  }
}
export async function trackedAiReplyIds(prisma: Db, tenantId: string, ids: string[]) {
  return new Set((await prisma.idempotencyRecord.findMany({ where: { scope: aiReplyScope, actorKey: tenantId, key: { in: ids } }, select: { key: true } })).map(row => row.key));
}
