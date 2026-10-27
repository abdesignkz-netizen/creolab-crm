import { createHash, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import { resolveUploadPath } from "../lib/storage.ts";
import { conversationMediaKind, storeMessageAttachment } from "./conversationMedia.ts";
import { bridgeTargetKey, providerDefinitelyDidNotSend, sendViaProvider } from "./messagingProvider.ts";
import { resolveSellerBridge } from "./sellerLink.ts";
import { enqueueConversationContext } from "./conversationContextQueue.ts";
import { writeActivity } from "./contactService.ts";
import { writeAudit } from "../lib/audit.ts";
import { phoneFromContact } from "./contactLabels.ts";

type Db = PrismaClient | Prisma.TransactionClient;
type Part = { id: string; state: "pending" | "sending" | "accepted" | "failed" | "unknown"; attempt: number;
  providerMessageId?: string | null; error?: string | null;
  reconciledBy?: string; reconciledAt?: string; reconciliationNote?: string };
export type LegacyDelivery = { version: 1; messageId: string; sellerLeadId: string; bridge: string;
  contactId?: string | null; recipient?: string;
  actorUserId: string; claim: string | null; leaseUntil: string | null; parts: Part[]; reviewRequiresRetry?: boolean;
  campaign?: { id: string; recipientId: string; confirmedAt: string; contentHash: string | null } };
export const LEGACY_SEND_CHECK = "Неизвестный результат отправки";
const LEASE_MS = 5 * 60_000;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const legacyCampaignKey = (campaignId: string, recipientId: string) => `legacy:campaign:${campaignId}:${recipientId}`;
export const legacyManualKey = (conversationId: string, key: string) => `legacy:message:${conversationId}:${digest(key)}`;
const recordKey = (tenantId: string, operationId: string) => ({ scope: "legacy.message.delivery", actorKey: tenantId, key: operationId });
export const legacyDeliveryBusy = (delivery: LegacyDelivery) => Boolean(delivery.claim && delivery.leaseUntil && new Date(delivery.leaseUntil).getTime() > Date.now());
export const legacyDeliveryRevision = (operation: { id: string; state: string; controlVersion: number }, delivery: LegacyDelivery) =>
  digest(JSON.stringify([operation.id, operation.state, operation.controlVersion, delivery]));
export async function readLegacyDelivery(db: Db, tenantId: string, operationId: string): Promise<LegacyDelivery | null> {
  const row = await db.idempotencyRecord.findUnique({ where: { scope_actorKey_key: recordKey(tenantId, operationId) } });
  return row ? row.resultJson as unknown as LegacyDelivery : null;
}
async function save(db: Db, tenantId: string, operationId: string, delivery: LegacyDelivery) {
  const key = recordKey(tenantId, operationId);
  const data = { requestHash: operationId, resultJson: delivery as unknown as Prisma.InputJsonValue, expiresAt: new Date("9999-01-01T00:00:00Z") };
  await db.idempotencyRecord.upsert({ where: { scope_actorKey_key: key }, create: { ...key, ...data }, update: data });
}
const stateOf = (parts: Part[]) => parts.every(p => p.state === "accepted") ? "accepted"
  : parts.some(p => p.state === "unknown") ? "unknown"
  : parts.some(p => p.state === "sending") ? "sending"
  : parts.some(p => p.state === "failed") ? "failed" : "queued";
async function lockConversation(db: Prisma.TransactionClient, tenantId: string, id: string) {
  await db.$queryRaw`SELECT id FROM "Conversation" WHERE id = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
  return db.conversation.findFirstOrThrow({ where: { id, tenantId } });
}

/** Store one immutable message and independent attachment states per recipient.
 * The conversation lock also serializes concurrent requests with the same key. */
export async function prepareLegacyMessage(prisma: PrismaClient, input: {
  tenantId: string; conversationId: string; actorUserId: string; key: string; text: string;
  files?: Array<{ fileName: string; mimeType: string; buffer: Buffer }>;
  sourceAttachmentIds?: string[]; campaign?: { id: string; recipientId: string };
}) {
  const resolved = await resolveSellerBridge(prisma, input.tenantId);
  return prisma.$transaction(async tx => {
    const conv = await lockConversation(tx, input.tenantId, input.conversationId);
    const sources = input.campaign ? await tx.attachment.findMany({ where: {
      tenantId: input.tenantId, parentType: "campaign", parentId: input.campaign.id, id: { in: input.sourceAttachmentIds || [] },
    }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }) : [];
    if (sources.length !== (input.sourceAttachmentIds || []).length) throw new ApiError(409, "content_changed", "Вложения изменились. Проверьте рассылку.");
    const files = input.files || [];
    const hash = digest(JSON.stringify({ user: input.actorUserId, text: input.text, sellerLeadId: conv.sellerLeadId,
      files: files.map(f => [f.fileName, f.mimeType, digest(f.buffer)]),
      sources: sources.map(f => [f.id, f.originalFileName || f.fileName, f.mimeType, f.checksum, f.sizeBytes]) }));
    const existing = await tx.outboundOperation.findUnique({ where: { tenantId_idempotencyKey: { tenantId: input.tenantId, idempotencyKey: input.key } } });
    if (existing) {
      if (existing.conversationId !== conv.id || existing.requestHash !== hash) throw new ApiError(409, "idempotency_conflict", "Этот запрос уже использован для другого сообщения. Обновите диалог.");
      return existing;
    }
    if (!conv.sellerLeadId || conv.connectionId) throw new ApiError(409, "channel_unavailable", "Нет подключения для отправки в этот диалог.");
    if (conv.mode !== "human" && !input.campaign) throw new ApiError(409, "mode_locked", "Сначала возьмите диалог, затем отвечайте");
    if (!input.text && !files.length && !sources.length) throw new ApiError(422, "invalid", "Введите текст или прикрепите файл");
    let campaignBinding: LegacyDelivery["campaign"];
    if (input.campaign) {
      const allowed = await tx.campaignRecipient.findFirst({ where: { id: input.campaign.recipientId, tenantId: input.tenantId,
        campaignId: input.campaign.id, status: "sending", campaign: { status: "running", confirmedById: input.actorUserId } }, include: { campaign: true } });
      if (!allowed?.campaign.confirmedAt) throw new ApiError(409, "campaign_stopped", "Рассылка остановлена");
      campaignBinding = { ...input.campaign, confirmedAt: allowed.campaign.confirmedAt.toISOString(), contentHash: allowed.campaign.contentHash };
      await tx.conversation.update({ where: { id: conv.id }, data: { mode: "human", controlVersion: { increment: 1 }, attentionReason: "taken_by_human" } });
    }
    const message = await tx.message.create({ data: { tenantId: input.tenantId, conversationId: conv.id,
      connectionScopedId: `${input.tenantId}:${input.key}`, senderKind: "staff", senderUserId: input.actorUserId,
      direction: "outbound", text: input.text || null, type: conversationMediaKind(files[0]?.mimeType || sources[0]?.mimeType), operationState: "queued" } });
    const attachments = [];
    for (const file of files) attachments.push(await storeMessageAttachment(tx, { tenantId: input.tenantId, messageId: message.id,
      ...file, uploadedById: input.actorUserId, sendState: "pending" }));
    for (const file of sources) attachments.push(await tx.attachment.create({ data: { tenantId: input.tenantId,
      parentType: "message", parentId: message.id, messageId: message.id, storageKey: file.storageKey,
      fileName: file.fileName, originalFileName: file.originalFileName, mimeType: file.mimeType, sizeBytes: file.sizeBytes,
      checksum: file.checksum, documentType: file.documentType, sendState: "pending", status: "stored", uploadedById: input.actorUserId } }));
    const operation = await tx.outboundOperation.create({ data: { tenantId: input.tenantId, conversationId: conv.id,
      idempotencyKey: input.key, providerRef: message.id, requestHash: hash, state: "queued", controlVersion: conv.controlVersion + (input.campaign ? 1 : 0) } });
    const contact = conv.contactId ? await tx.contact.findFirst({ where: { id: conv.contactId, tenantId: input.tenantId }, include: { methods: true } }) : null;
    const delivery: LegacyDelivery = { version: 1, messageId: message.id, actorUserId: input.actorUserId,
      contactId: conv.contactId, recipient: [contact?.name, phoneFromContact(contact, { externalThreadId: conv.externalThreadId })].filter(Boolean).join(" · ") || "Клиент этого диалога",
      sellerLeadId: conv.sellerLeadId, bridge: bridgeTargetKey(resolved), claim: null, leaseUntil: null,
      ...(campaignBinding ? { campaign: campaignBinding } : {}),
      parts: [...(input.text ? [{ id: "text", state: "pending" as const, attempt: 0 }] : []),
        ...attachments.map(f => ({ id: f.id, state: "pending" as const, attempt: 0 }))] };
    await save(tx, input.tenantId, operation.id, delivery);
    if (input.campaign) await tx.campaignRecipient.update({ where: { id: input.campaign.recipientId }, data: { conversationId: conv.id } });
    return operation;
  }, { timeout: 30_000 });
}

export async function publishLegacyDelivery(db: Prisma.TransactionClient, tenantId: string, operationId: string, delivery: LegacyDelivery) {
  const rawState = stateOf(delivery.parts);
  // A review must not quietly resume a campaign whose remaining parts are pending.
  const state = delivery.reviewRequiresRetry && rawState === "queued" ? "failed" : rawState;
  const partial = state !== "accepted" && delivery.parts.some(p => p.state === "accepted");
  const error = delivery.parts.find(p => p.error)?.error || null;
  await save(db, tenantId, operationId, delivery);
  await db.outboundOperation.update({ where: { id: operationId, tenantId }, data: { state, error } });
  await db.message.update({ where: { id: delivery.messageId, tenantId }, data: {
    operationState: partial && state === "failed" ? "partial" : state,
    providerMessageId: delivery.parts.find(p => p.id === "text")?.providerMessageId || null } });
  if (state === "accepted" && delivery.parts.some(p => p.reconciledBy && p.state === "accepted")) {
    await db.message.updateMany({ where: { id: delivery.messageId, tenantId, receiptState: { in: ["unknown", "sent", "reconciled"] } },
      data: { receiptState: "reconciled" } });
  }
  if (state === "accepted") {
    const operation = await db.outboundOperation.findFirstOrThrow({ where: { id: operationId, tenantId } });
    await enqueueConversationContext(db, tenantId, operation.conversationId, delivery.messageId);
  }
  for (const part of delivery.parts.filter(p => p.id !== "text")) await db.attachment.updateMany({ where: { id: part.id, tenantId, messageId: delivery.messageId },
    data: { sendState: part.state === "accepted" ? "sent" : part.state, sendError: part.error || null, providerMessageId: part.providerMessageId || null } });
  if (delivery.campaign) {
    const text = delivery.parts.filter(p => p.id === "text"), files = delivery.parts.filter(p => p.id !== "text");
    const partState = (parts: Part[]) => !parts.length ? "none" : stateOf(parts) === "accepted" ? "sent" : stateOf(parts);
    await db.campaignRecipient.updateMany({ where: { id: delivery.campaign.recipientId, tenantId, campaignId: delivery.campaign.id }, data: {
      status: state === "accepted" ? "sent" : state === "queued" ? "sending" : state,
      textSendState: partState(text), filesSendState: partState(files), error,
      providerMessageId: delivery.parts.find(p => p.providerMessageId)?.providerMessageId || null } });
    if (state === "accepted") await db.campaignRecipient.updateMany({ where: {
      id: delivery.campaign.recipientId, tenantId, campaignId: delivery.campaign.id, sentAt: null,
    }, data: { sentAt: new Date() } });
  }
}

/** Recovery is read/reconciliation only: an expired intent never triggers a send. */
export async function recoverLegacyMessage(prisma: PrismaClient, tenantId: string, operationId: string) {
  const operation = await prisma.outboundOperation.findFirst({ where: { id: operationId, tenantId } });
  if (!operation) return null;
  return prisma.$transaction(async tx => {
    await lockConversation(tx, tenantId, operation.conversationId);
    const delivery = await readLegacyDelivery(tx, tenantId, operationId);
    if (!delivery || legacyDeliveryBusy(delivery)) return delivery;
    for (const p of delivery.parts) if (p.state === "sending") { p.state = "unknown"; p.error = LEGACY_SEND_CHECK; }
    delivery.claim = null; delivery.leaseUntil = null;
    await publishLegacyDelivery(tx, tenantId, operationId, delivery);
    return delivery;
  });
}

/** Replays only known unsent parts. Persist intent before each external call. */
export async function deliverLegacyMessage(prisma: PrismaClient, tenantId: string, operationId: string,
  retry?: { revision: string; actorUserId: string }) {
  const operation = await prisma.outboundOperation.findFirstOrThrow({ where: { id: operationId, tenantId } });
  const claim = randomUUID();
  const delivery = await prisma.$transaction(async tx => {
    const conversation = await lockConversation(tx, tenantId, operation.conversationId);
    const state = await readLegacyDelivery(tx, tenantId, operationId);
    if (!state) throw new ApiError(409, "delivery_untracked", LEGACY_SEND_CHECK);
    if (retry) {
      const current = await tx.outboundOperation.findFirstOrThrow({ where: { id: operationId, tenantId } });
      if (legacyDeliveryRevision(current, state) !== retry.revision) throw new ApiError(409, "delivery_changed", "Результат отправки изменился. Обновите проверку.");
      const reviewer = await tx.membership.findFirst({ where: { tenantId, userId: retry.actorUserId, active: true,
        role: { not: "manager" }, tenant: { status: "active" } } });
      if (!reviewer) throw new ApiError(403, "forbidden", "Нет прав на повтор отправки.");
      if (conversation.status !== "open" || conversation.mode !== "human" || conversation.controlVersion !== current.controlVersion
        || conversation.sellerLeadId !== state.sellerLeadId || conversation.connectionId
        || (state.contactId !== undefined && conversation.contactId !== state.contactId)) {
        throw new ApiError(409, "delivery_changed", "Диалог или получатель изменился. Обновите результат отправки.");
      }
    }
    if (legacyDeliveryBusy(state)) return null;
    for (const p of state.parts) if (p.state === "sending") { p.state = "unknown"; p.error = LEGACY_SEND_CHECK; }
    if (state.parts.some(p => p.state === "unknown") || state.parts.every(p => p.state === "accepted")) {
      state.claim = null; state.leaseUntil = null; await publishLegacyDelivery(tx, tenantId, operationId, state); return null;
    }
    if (retry && state.campaign) {
      const resumed = await tx.campaignRecipient.updateMany({ where: { id: state.campaign.recipientId, tenantId,
        campaignId: state.campaign.id, status: { in: ["failed", "unknown"] }, campaign: {
          status: { in: ["running", "completed", "partially_completed", "failed"] }, confirmedById: state.actorUserId,
          confirmedAt: new Date(state.campaign.confirmedAt), contentHash: state.campaign.contentHash,
        } }, data: { status: "sending", error: null } });
      if (!resumed.count) throw new ApiError(409, "campaign_stopped", "Состояние рассылки изменилось. Обновите проверку.");
    }
    state.reviewRequiresRetry = false;
    state.claim = claim; state.leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();
    if (retry) await writeAudit(tx, { tenantId, actorUserId: retry.actorUserId, action: "message.delivery_retry",
      entityType: "message", entityId: state.messageId, changes: { conversationId: operation.conversationId,
        campaignId: state.campaign?.id || null, partIds: state.parts.filter(p => p.state !== "accepted").map(p => p.id) } });
    await save(tx, tenantId, operationId, state); return state;
  });
  const result = () => prisma.message.findFirstOrThrow({ where: { id: operation.providerRef!, tenantId }, include: { attachments: true } });
  if (!delivery) return result();
  const withClaim = <T>(fn: (tx: Prisma.TransactionClient, state: LegacyDelivery) => Promise<T>) => prisma.$transaction(async tx => {
    await lockConversation(tx, tenantId, operation.conversationId);
    const state = await readLegacyDelivery(tx, tenantId, operationId);
    if (!state || state.claim !== claim) throw new ApiError(409, "delivery_changed", LEGACY_SEND_CHECK);
    return fn(tx, state);
  });
  const allowedNow = async (tx: Prisma.TransactionClient, state: LegacyDelivery) => {
    const conv = await tx.conversation.findFirstOrThrow({ where: { id: operation.conversationId, tenantId } });
    const member = await tx.membership.findFirst({ where: { tenantId, userId: state.actorUserId, active: true, tenant: { status: "active" } } });
    const reviewerAllowed = !retry || await tx.membership.count({ where: { tenantId, userId: retry.actorUserId,
      active: true, role: { not: "manager" }, tenant: { status: "active" } } });
    const campaign = state.campaign ? await tx.campaignRecipient.findFirst({ where: { id: state.campaign.recipientId, tenantId,
      campaignId: state.campaign.id, status: "sending", campaign: { status: retry ? { in: ["running", "completed", "partially_completed", "failed"] } : "running", confirmedById: state.actorUserId,
        confirmedAt: new Date(state.campaign.confirmedAt), contentHash: state.campaign.contentHash } } }) : null;
    return Boolean(member && reviewerAllowed && (!state.campaign || (campaign && member.role !== "manager")) && conv.status === "open"
      && conv.mode === "human" && conv.controlVersion === operation.controlVersion && conv.sellerLeadId === state.sellerLeadId && !conv.connectionId
      && (state.contactId === undefined || conv.contactId === state.contactId)
      && (member.role !== "manager" || conv.assigneeMembershipId === member.id));
  };
  let handoffError: string | null = null;
  try {
    const resolved = await resolveSellerBridge(prisma, tenantId);
    if (!resolved.bridge || bridgeTargetKey(resolved) !== delivery.bridge) throw new Error("Bridge changed");
    if (!await withClaim(allowedNow)) throw new Error("Dispatch canceled");
    const reply = await resolved.bridge.setMode(delivery.sellerLeadId, "HUMAN") as { ok?: boolean; error?: unknown } | null;
    if (reply?.ok === false || reply?.error) throw new Error("Handover rejected");
  } catch { handoffError = "Не удалось передать диалог сотруднику. Проверьте подключение WhatsApp и повторите отправку."; }
  for (const part of delivery.parts) {
    if (part.state === "accepted") continue;
    const attempt = await withClaim(async (tx, state) => {
      const allowed = await allowedNow(tx, state);
      const item = state.parts.find(p => p.id === part.id)!;
      if (!allowed || handoffError) {
        item.state = "failed"; item.error = handoffError || "Отправка остановлена: изменились диалог, права доступа или состояние рассылки.";
        await publishLegacyDelivery(tx, tenantId, operationId, state); return null;
      }
      item.state = "sending"; item.attempt++; item.error = null;
      delete item.reconciledBy; delete item.reconciledAt; delete item.reconciliationNote;
      state.leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();
      await publishLegacyDelivery(tx, tenantId, operationId, state);
      return { attempt: item.attempt, message: await tx.message.findFirstOrThrow({ where: { id: state.messageId, tenantId } }),
        file: part.id === "text" ? null : await tx.attachment.findFirstOrThrow({ where: { id: part.id, tenantId, messageId: state.messageId } }) };
    });
    if (!attempt) break;
    let state: Part["state"] = "accepted", error: string | null = null, providerMessageId: string | null = null;
    try {
      const reply = await sendViaProvider(prisma, tenantId, { sellerLeadId: delivery.sellerLeadId, expectedBridge: delivery.bridge,
        idempotencyKey: `${operation.idempotencyKey}:${part.id}:${attempt.attempt}`,
        beforeSend: async () => {
          if (!await withClaim(allowedNow)) throw new ApiError(409, "dispatch_canceled", "Отправка остановлена: изменились диалог, права доступа или состояние рассылки.");
        },
        ...(attempt.file ? { file: { fileName: attempt.file.originalFileName || attempt.file.fileName, mimeType: attempt.file.mimeType,
          filePath: resolveUploadPath(attempt.file.storageKey), checksum: attempt.file.checksum } } : { text: attempt.message.text || "" }) });
      providerMessageId = reply.providerMessageId;
    } catch (err) { state = providerDefinitelyDidNotSend(err) ? "failed" : "unknown";
      error = state === "unknown" ? LEGACY_SEND_CHECK : err instanceof Error ? err.message : "Не отправлено"; }
    await withClaim(async (tx, delivery) => {
      Object.assign(delivery.parts.find(p => p.id === part.id)!, { state, error, providerMessageId });
      await publishLegacyDelivery(tx, tenantId, operationId, delivery);
      if (state === "accepted") {
        await tx.conversation.update({ where: { id: operation.conversationId, tenantId }, data: { messageRevision: { increment: 1 } } });
      }
    });
    if (state !== "accepted") break;
  }
  await withClaim(async (tx, delivery) => {
    delivery.claim = null; delivery.leaseUntil = null;
    await publishLegacyDelivery(tx, tenantId, operationId, delivery);
    if (delivery.campaign && stateOf(delivery.parts) === "accepted") {
      const conv = await tx.conversation.findFirstOrThrow({ where: { id: operation.conversationId, tenantId } });
      if (conv.contactId) await writeActivity(tx, { tenantId, contactId: conv.contactId, type: "campaign.sent",
        title: "Сообщение рассылки отправлено", actorType: "system", metadata: { campaignId: delivery.campaign.id, recipientId: delivery.campaign.recipientId } });
    }
  });
  return result();
}
