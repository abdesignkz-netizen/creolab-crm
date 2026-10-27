import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@creolab/db";
import type { MessageDeliveryPart, MessageRetryBlock } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { decryptSecret } from "../lib/secretBox.ts";
import { enqueueConversationContext } from "./conversationContextQueue.ts";
import { getEntitlements } from "./entitlementService.ts";

export type DirectWaDb = PrismaClient | Prisma.TransactionClient;
export type DirectWaPart = { id: string; state: MessageDeliveryPart["state"]; attempt: number;
  providerMessageId?: string | null; error?: string | null; receipt?: "sent" | "delivered" | "read" | "failed";
  reconciledBy?: string; reconciledAt?: string; reconciliationNote?: string };
export type DirectWaDelivery = { version: 1; messageId: string; actorUserId: string; contactId: string | null;
  channel: "whatsapp_qr" | "whatsapp_cloud"; connectionId: string; integrationId: string; connectionRef: string | null;
  bindingHash: string; credentialHash: string | null; target: string; recipient: string; senderPhone: string;
  contentHash: string; messageRevision: number; completed?: boolean; failureAttentionRevision?: number;
  queueToken: string; generation: number; queued: boolean; reviewerId?: string;
  claim: string | null; leaseUntil: number; canceled?: boolean; parts: DirectWaPart[];
  campaign?: { id: string; recipientId: string; recipientHash: string; confirmedAt: string | null; contentHash: string | null } };
export const directWaScope = "whatsapp.direct.delivery";
export const directWaDigest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const directWaLease = () => Date.now() + 300_000;
export const directWaBusy = (value: DirectWaDelivery, state: string) => Boolean(value.claim && value.leaseUntil > Date.now()) || (value.queued && state === "queued");
export const directWaChanged = () => new ApiError(409, "delivery_changed", "Результат отправки изменился. Обновите проверку.");
export const directWaRevision = (op: { id: string; state: string; controlVersion: number }, value: DirectWaDelivery) => directWaDigest(JSON.stringify([op.id, op.state, op.controlVersion, value]));
export const directWaCredentialHash = (value: { id: string; encryptedValue: string }) => directWaDigest(JSON.stringify([value.id, value.encryptedValue]));
export function directWaBinding(value: { type: string; publicKey: string | null; schemaJson: unknown }) {
  const settings = (value.schemaJson || {}) as Record<string, unknown>;
  return directWaDigest(JSON.stringify([value.type, value.publicKey, settings.phone,
    ...(value.type === "whatsapp_cloud" ? [settings.appId, settings.wabaId, settings.phoneNumberId, settings.apiVersion] : [])]));
}
export const directWaContentHash = (text: string | null, files: Array<{ id: string; storageKey: string; originalFileName: string | null; fileName: string; mimeType: string; checksum: string | null; sizeBytes: number }>) =>
  directWaDigest(JSON.stringify([text || "", files.map(f => [f.id, f.storageKey, f.originalFileName || f.fileName, f.mimeType, f.checksum, f.sizeBytes]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]));
export const directWaRecipientHash = (row: { contactId: string | null; phoneNormalized: string | null; phoneRaw: string | null; messageDraft: string | null }) =>
  directWaDigest(JSON.stringify([row.contactId, row.phoneNormalized, row.phoneRaw, row.messageDraft]));
export async function lockDirectWaConversation(tx: Prisma.TransactionClient, tenantId: string, id: string) {
  await tx.$queryRaw`SELECT id FROM "Conversation" WHERE id = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
}
export async function readDirectWaDelivery(db: DirectWaDb, tenantId: string, operationId: string) {
  const row = await db.idempotencyRecord.findUnique({ where: { scope_actorKey_key: { scope: directWaScope, actorKey: tenantId, key: operationId } } });
  const value = row?.resultJson as unknown as DirectWaDelivery | undefined;
  return value?.version === 1 ? value : null;
}
export async function saveDirectWaDelivery(db: DirectWaDb, tenantId: string, operationId: string, value: DirectWaDelivery) {
  const key = { scope: directWaScope, actorKey: tenantId, key: operationId }, data = { requestHash: operationId, resultJson: value as unknown as Prisma.InputJsonValue, expiresAt: new Date("9999-01-01") };
  await db.idempotencyRecord.upsert({ where: { scope_actorKey_key: key }, create: { ...key, ...data }, update: data });
}
export async function loadDirectWaDelivery(db: DirectWaDb, tenantId: string, conversationId: string, messageId: string) {
  const message = await db.message.findFirst({ where: { id: messageId, tenantId, conversationId, internal: false, direction: "outbound", senderKind: "staff" }, include: { attachments: true } });
  if (!message) throw new ApiError(404, "not_found", "Сообщение не найдено");
  const ops = await db.outboundOperation.findMany({ where: { tenantId, conversationId, providerRef: messageId }, take: 2 });
  const operation = ops.length === 1 && ops[0].idempotencyKey.startsWith("whatsapp:") ? ops[0] : null;
  const delivery = operation ? await readDirectWaDelivery(db, tenantId, operation.id) : null;
  if (!operation || !delivery || delivery.messageId !== messageId) throw new ApiError(409, "delivery_untracked", "Нет подробной истории частей этой отправки. Проверьте результат в WhatsApp.");
  return { message, operation, delivery };
}

/** Original target, content, access and Cloud reply window are checked before every part. */
export async function directWaDispatchBlock(db: DirectWaDb, tenantId: string, operation: { conversationId: string; controlVersion: number }, value: DirectWaDelivery, phase: "dispatch" | "retry" = "dispatch"): Promise<MessageRetryBlock> {
  const conv = await db.conversation.findFirst({ where: { id: operation.conversationId, tenantId }, include: { connection: { include: { integration: true } } } });
  if (!conv || conv.mode !== "human" || conv.status !== "open" || conv.controlVersion !== operation.controlVersion
    || conv.contactId !== value.contactId || conv.connectionId !== value.connectionId || conv.externalThreadId !== value.target) return "conversation_changed";
  const member = await db.membership.findFirst({ where: { tenantId, userId: value.actorUserId, active: true, tenant: { status: "active" } } });
  if (!member || (member.role === "manager" && (value.campaign || conv.assigneeMembershipId !== member.id))) return "access_changed";
  if (value.reviewerId && !await db.membership.count({ where: { tenantId, userId: value.reviewerId, active: true, role: { not: "manager" }, tenant: { status: "active" } } })) return "permissions";
  const connection = conv.connection, row = connection?.integration;
  if (!connection || connection.tenantId !== tenantId || connection.channelType !== "whatsapp" || connection.status !== "active"
    || connection.externalRef !== value.connectionRef || row?.tenantId !== tenantId || row.id !== value.integrationId
    || row.type !== value.channel || row.status !== "active" || directWaBinding(row) !== value.bindingHash) return "connection_changed";
  if (value.channel === "whatsapp_cloud") {
    const credential = await db.credential.findFirst({ where: { id: row.credentialId || "", tenantId, kind: "whatsapp_cloud" } });
    if (!credential || directWaCredentialHash(credential) !== value.credentialHash) return "connection_changed";
    const last = await db.message.findFirst({ where: { tenantId, conversationId: conv.id, direction: "inbound", internal: false }, orderBy: { createdAt: "desc" } });
    if (!last || Date.now() - last.createdAt.getTime() >= 86_400_000) return "window_closed";
  }
  const message = await db.message.findFirst({ where: { id: value.messageId, tenantId, conversationId: conv.id, direction: "outbound", senderKind: "staff", senderUserId: value.actorUserId, internal: false }, include: { attachments: true } });
  if (!message || directWaContentHash(message.text, message.attachments) !== value.contentHash) return "conversation_changed";
  const access = await getEntitlements(db as PrismaClient, tenantId);
  if (!access.entitlements.WHATSAPP) return "plan";
  if (value.campaign) {
    const recipient = await db.campaignRecipient.findFirst({ where: { id: value.campaign.recipientId, tenantId, campaignId: value.campaign.id, conversationId: conv.id }, include: { campaign: true } });
    const campaign = recipient?.campaign, settings = campaign?.parsedCommandJson as Record<string, unknown> | null;
    if (!campaign || !["running", ...(value.generation > 0 || phase === "retry" ? ["completed", "partially_completed", "failed"] : ["paused"])].includes(campaign.status)) return "campaign_stopped";
    if (phase === "retry" && campaign.status === "paused") return "campaign_stopped";
    if (!recipient || recipient.contactId !== value.contactId || directWaRecipientHash(recipient) !== value.campaign.recipientHash
      || !(phase === "retry" ? ["failed", "unknown"] : ["sending"]).includes(recipient.status)
      || campaign.confirmedById !== value.actorUserId || campaign.confirmedAt?.toISOString() !== value.campaign.confirmedAt
      || campaign.contentHash !== value.campaign.contentHash || settings?.whatsappIntegrationId !== value.integrationId) return "campaign_changed";
    if (!access.snapshot.grandfathered && !access.entitlements.MASS_CAMPAIGNS) return "plan";
  }
  return null;
}

/** Facts are persisted per part. A receipt for text must never mark a file as delivered. */
export async function publishDirectWaDelivery(tx: Prisma.TransactionClient, tenantId: string, operationId: string, value: DirectWaDelivery) {
  const op = await tx.outboundOperation.findFirstOrThrow({ where: { id: operationId, tenantId } });
  if (value.channel === "whatsapp_cloud") {
    const { applyDirectWaReceipts } = await import("./directWhatsAppReceipts.ts");
    await applyDirectWaReceipts(tx, tenantId, value);
  }
  const complete = value.parts.every(p => p.state === "accepted"), unknown = value.parts.some(p => ["sending", "unknown"].includes(p.state));
  const state = value.claim ? "sending" : value.queued ? "queued" : unknown ? "unknown" : complete ? "accepted"
    : value.parts.some(p => p.state === "accepted") ? "partial" : value.canceled && value.parts.every(p => !p.attempt) ? "canceled" : "failed";
  const error = state === "unknown" ? "WhatsApp не подтвердил результат отправки" : ["partial", "failed"].includes(state) ? "Не все части сообщения отправлены" : state === "canceled" ? "Отправка отменена" : null;
  await tx.outboundOperation.update({ where: { id: operationId, tenantId }, data: { state, error } });
  const receiptState = complete && value.parts.every(p => p.receipt === "read") ? "read"
    : complete && value.parts.every(p => ["read", "delivered"].includes(p.receipt || "")) ? "delivered"
    : complete && value.parts.some(p => p.reconciledBy) ? "reconciled" : complete ? "sent"
    : value.parts.some(p => p.receipt === "failed") ? "failed" : "unknown";
  await tx.message.update({ where: { id: value.messageId, tenantId }, data: { operationState: state, receiptState, providerMessageId: value.parts.find(p => p.providerMessageId)?.providerMessageId || null } });
  for (const part of value.parts.filter(p => p.id !== "text")) await tx.attachment.updateMany({ where: { id: part.id, tenantId, messageId: value.messageId }, data: {
    sendState: part.state === "accepted" ? "sent" : part.state, sendError: part.error || null, providerMessageId: part.providerMessageId || null } });
  if (state === "accepted" && !value.completed) {
    await tx.conversation.updateMany({ where: { id: op.conversationId, tenantId, status: "open", mode: "human", controlVersion: op.controlVersion,
      contactId: value.contactId, connectionId: value.connectionId, externalThreadId: value.target, messageRevision: value.messageRevision }, data: { waitingFor: "CLIENT", needsAttention: false, attentionReason: null } });
    await tx.conversation.update({ where: { id: op.conversationId, tenantId }, data: { messageRevision: { increment: 1 } } });
    await enqueueConversationContext(tx, tenantId, op.conversationId, value.messageId);
    value.completed = true;
  }
  if (!value.claim && !value.queued && (value.parts.some(p => p.receipt === "failed") || value.failureAttentionRevision !== undefined)) {
    const latest = await tx.message.findFirst({ where: { tenantId, conversationId: op.conversationId, direction: "outbound", internal: false }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    const match = { id: op.conversationId, tenantId, status: "open" as const, mode: "human" as const, controlVersion: op.controlVersion,
      contactId: value.contactId, connectionId: value.connectionId, externalThreadId: value.target };
    if (latest?.id === value.messageId && value.parts.some(p => p.receipt === "failed")) {
      // Do not replace the reason for a newer incoming message with this older failure.
      const revision = value.messageRevision + (value.completed ? 1 : 0);
      const marked = await tx.conversation.updateMany({ where: { ...match, messageRevision: revision },
        data: { needsAttention: true, waitingFor: "MANAGER", attentionReason: "outbound_delivery_failed" } });
      if (marked.count) value.failureAttentionRevision = revision;
    } else if (state === "accepted" && value.failureAttentionRevision !== undefined) {
      // Clear only the attention marker owned by this failed send, never a later request.
      if (latest?.id === value.messageId) await tx.conversation.updateMany({ where: { ...match, messageRevision: value.failureAttentionRevision,
        needsAttention: true, waitingFor: "MANAGER", attentionReason: "outbound_delivery_failed" },
        data: { needsAttention: false, waitingFor: "CLIENT", attentionReason: null } });
      delete value.failureAttentionRevision;
    }
  }
  if (value.campaign) {
    const accepted = state === "accepted", status = ["queued", "sending"].includes(state) ? "sending" : accepted ? "sent" : state === "unknown" ? "unknown" : state === "canceled" ? "cancelled" : "failed";
    const text = value.parts.find(p => p.id === "text"), files = value.parts.filter(p => p.id !== "text");
    const recipient = await tx.campaignRecipient.findFirst({ where: { id: value.campaign.recipientId, tenantId, campaignId: value.campaign.id } });
    if (recipient && directWaRecipientHash(recipient) === value.campaign.recipientHash) await tx.campaignRecipient.updateMany({ where: { id: value.campaign.recipientId, tenantId, campaignId: value.campaign.id, conversationId: op.conversationId,
      status: { in: ["sending", "sent", "failed", "unknown"] } }, data: { status, sentAt: accepted ? recipient.sentAt || new Date() : null, error,
      providerMessageId: value.parts.find(p => p.providerMessageId)?.providerMessageId || null,
      textSendState: text ? text.state === "accepted" ? "sent" : text.state : "none",
      filesSendState: !files.length ? "none" : files.every(p => p.state === "accepted") ? "sent" : files.some(p => p.state === "unknown") ? "unknown" : files.some(p => p.state === "accepted") ? "partial" : state } });
  }
  await saveDirectWaDelivery(tx, tenantId, operationId, value);
}

/** Recovery never sends. Fencing the claim also discards late acknowledgements from an old worker. */
export async function recoverDirectWaDeliveries(prisma: PrismaClient, options: { now?: number; integrationId?: string; force?: boolean } = {}) {
  // A handoff can cancel the operation while its provider call is still in flight.
  // Recover the durable lease, not just operations still labelled "sending".
  const records = await prisma.idempotencyRecord.findMany({ where: { scope: directWaScope, AND: [
    { resultJson: { path: ["leaseUntil"], gt: 0, ...(!options.force ? { lte: options.now ?? Date.now() } : {}) } },
    ...(options.integrationId ? [{ resultJson: { path: ["integrationId"], equals: options.integrationId } }] : []),
  ] }, orderBy: { createdAt: "asc" }, take: options.integrationId ? undefined : 50, select: { key: true, actorKey: true } });
  for (const record of records) await prisma.$transaction(async tx => {
    const op = await tx.outboundOperation.findFirst({ where: { id: record.key, tenantId: record.actorKey } });
    if (!op) return;
    await lockDirectWaConversation(tx, op.tenantId, op.conversationId);
    const value = await readDirectWaDelivery(tx, op.tenantId, op.id);
    if (!value?.claim || (!options.force && value.leaseUntil > (options.now ?? Date.now()))) return;
    for (const part of value.parts) if (part.state === "sending") { part.state = "unknown"; part.error = "WhatsApp не подтвердил результат отправки"; }
    value.claim = null; value.leaseUntil = 0; value.queued = false;
    await publishDirectWaDelivery(tx, op.tenantId, op.id, value);
  });
}

/** A crash after claiming a QR job but before claiming the message is still safely queued. */
export async function restoreUnstartedDirectWaQrJobs(prisma: PrismaClient, integrationId: string) {
  const jobs = await prisma.$queryRaw<Array<{ id: string; encryptedPayload: string }>>`SELECT id, "encryptedPayload" FROM "WhatsAppQrJob" WHERE "integrationId" = ${integrationId} AND kind = 'outbound' AND state = 'sending'`;
  for (const job of jobs) {
    const payload = JSON.parse(decryptSecret(job.encryptedPayload)) as { messageId?: string; deliveryToken?: string };
    if (!payload.messageId || !payload.deliveryToken) continue;
    const message = await prisma.message.findFirst({ where: { id: payload.messageId, operationState: "queued", connectionScopedId: { startsWith: "wa-out-v2:" } } });
    if (!message) continue;
    await prisma.$transaction(async tx => {
      await lockDirectWaConversation(tx, message.tenantId, message.conversationId);
      const { operation, delivery } = await loadDirectWaDelivery(tx, message.tenantId, message.conversationId, message.id);
      if (delivery.integrationId !== integrationId || operation.state !== "queued" || !delivery.queued || delivery.claim || delivery.queueToken !== payload.deliveryToken) return;
      await tx.$executeRaw`UPDATE "WhatsAppQrJob" SET state = 'queued' WHERE id = ${job.id} AND state = 'sending'`;
    });
  }
}
