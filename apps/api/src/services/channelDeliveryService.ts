import type { PrismaClient, Prisma } from "@creolab/db";
import { encryptSecret } from "../lib/secretBox.ts";
import { ApiError } from "../errors.ts";
import { enqueueConversationContext } from "./conversationContextQueue.ts";
import { randomUUID } from "node:crypto";

// Longer than the bounded credential refresh and provider request together.
const DELIVERY_LEASE_MS = 120_000;

export const aiChannelTypes = ["whatsapp_qr", "whatsapp_cloud", "telegram_bot", "instagram_direct", "website_chat"];
export function aiSourceChannel(type: string) {
  return ({ telegram_bot: "telegram", instagram_direct: "instagram", website_chat: "website_ai" } as Record<string, string>)[type] || "whatsapp";
}
export async function enqueueChannelDelivery(tx: Prisma.TransactionClient, tenantId: string, integration: { id: string; type: string }, messageId: string, policyHash?: string) {
  const { initializeAiReply, enqueueAiReply } = await import("./aiReplyDeliveryState.ts");
  const tracked = await initializeAiReply(tx, tenantId, messageId, policyHash);
  if (tracked) { await enqueueAiReply(tx, tenantId, tracked); return; }
  if (integration.type === "whatsapp_qr") {
    await tx.$executeRaw`INSERT INTO "WhatsAppQrJob" (id, "integrationId", kind, "encryptedPayload") VALUES (${messageId}, ${integration.id}, 'outbound', ${encryptSecret(JSON.stringify({ messageId }))})`;
  } else {
    await tx.outboxEvent.create({ data: { id: `wa-send:${messageId}`, tenantId, type: integration.type === "whatsapp_cloud" ? "whatsapp.cloud_send" : "channel.send", entityType: "message", entityId: messageId, payloadJson: { integrationId: integration.id } } });
  }
}

/** One durable claim per message. An ambiguous provider response is never retried blindly. */
export async function deliverChannelMessage(prisma: PrismaClient, tenantId: string, messageId: string, deliveryToken?: string) {
  if (await (await import("./aiReplyDeliveryState.ts")).readAiReply(prisma, tenantId, messageId)) return (await import("./aiReplyDelivery.ts")).dispatchAiReply(prisma, tenantId, messageId, { deliveryToken });
  const message = await prisma.message.findFirst({ where: { id: messageId, tenantId, operationState: { in: ["queued", "sending"] } }, include: { conversation: { include: { connection: { include: { integration: true } } } } } });
  if (!message) return;
  const conversation = message.conversation, integration = conversation.connection?.integration;
  if (!integration || !["telegram_bot", "instagram_direct", "website_chat"].includes(integration.type)) return;
  const operation = await prisma.outboundOperation.findFirst({ where: { tenantId, conversationId: conversation.id, providerRef: messageId } });
  const leaseKey = { scope: "channel.delivery", actorKey: tenantId, key: messageId };
  const claimId = randomUUID();
  const lockConversation = (tx: Prisma.TransactionClient) => tx.$queryRaw`SELECT id FROM "Conversation" WHERE id = ${conversation.id} AND "tenantId" = ${tenantId} FOR UPDATE`;
  const ownsClaim = async (tx: Prisma.TransactionClient) => Boolean(await tx.idempotencyRecord.count({ where: { ...leaseKey, requestHash: claimId } }));
  const releaseClaim = (tx: Prisma.TransactionClient) => tx.idempotencyRecord.deleteMany({ where: { ...leaseKey, requestHash: claimId } });
  const claimed = await prisma.$transaction(async tx => {
    await lockConversation(tx);
    const current = await tx.message.findUniqueOrThrow({ where: { id: messageId } });
    if (!["queued", "sending"].includes(current.operationState)) return false;
    if (current.operationState === "sending") {
      const lease = await tx.idempotencyRecord.findUnique({ where: { scope_actorKey_key: leaseKey } });
      if (lease && lease.expiresAt > new Date()) {
        // Keep the outbox event pending if another worker is still sending.
        throw new ApiError(409, "channel_sending", "Сообщение ещё отправляется.");
      }
      if (integration.type !== "website_chat") {
        // A crashed process may have reached the external provider. Never resend blindly.
        await tx.message.update({ where: { id: messageId }, data: { operationState: "unknown" } });
        if (operation) await tx.outboundOperation.updateMany({ where: { id: operation.id, state: { in: ["queued", "sending"] } }, data: { state: "unknown", error: "Сервер перезапустился до подтверждения отправки" } });
        await tx.conversation.updateMany({ where: { id: conversation.id, controlVersion: conversation.controlVersion }, data: { needsAttention: true, attentionReason: "AI_DELIVERY_UNKNOWN" } });
        await tx.idempotencyRecord.deleteMany({ where: leaseKey });
        return false;
      }
      // Website delivery is a database publication: nothing was sent outside this transaction.
      if (operation) await tx.outboundOperation.updateMany({ where: { id: operation.id, state: "sending" }, data: { state: "queued" } });
    }
    if (!operation || !(await tx.outboundOperation.updateMany({ where: { id: operation.id, state: "queued" }, data: { state: "sending", error: null } })).count) {
      await tx.message.update({ where: { id: messageId }, data: { operationState: "canceled" } });
      return false;
    }
    await tx.message.update({ where: { id: messageId }, data: { operationState: "sending" } });
    const lease = { requestHash: claimId, resultJson: {}, expiresAt: new Date(Date.now() + DELIVERY_LEASE_MS) };
    await tx.idempotencyRecord.upsert({ where: { scope_actorKey_key: leaseKey }, create: { ...leaseKey, ...lease }, update: lease });
    return true;
  });
  if (!claimed) return;
  const summary = conversation.aiHandoffSummaryJson as { sourceMessageId?: string } | null;
  const handoffSource = message.senderKind === "ai" && operation && summary?.sourceMessageId && operation.idempotencyKey === `wa-ai-handoff:${conversation.id}:${summary.sourceMessageId}:${operation.controlVersion}` ? summary.sourceMessageId : undefined;
  const cancel = () => prisma.$transaction(async tx => {
    await lockConversation(tx);
    if (!await ownsClaim(tx)) throw new ApiError(409, "channel_sending", "Состояние отправки изменилось. Повторите проверку.");
    await tx.message.updateMany({ where: { tenantId, id: messageId, operationState: "sending" }, data: { operationState: "canceled" } });
    if (operation) await tx.outboundOperation.updateMany({ where: { id: operation.id, state: "sending" }, data: { state: "canceled" } });
    await releaseClaim(tx);
  });
  const allowed = async () => {
    if (!operation) return false;
    if (!await prisma.conversation.count({ where: { tenantId, id: conversation.id, status: "open", controlVersion: operation.controlVersion,
      mode: handoffSource ? { in: ["human", "paused"] } : message.senderKind === "ai" ? "ai" : "human",
      tenant: { status: "active" }, connection: { status: "active", integration: { id: integration.id, status: "active" } } } })) return false;
    if (message.senderKind !== "ai") return true;
    const { directAiSendAllowed } = await import("./whatsappAiService.ts");
    return directAiSendAllowed(prisma, tenantId, conversation.id, operation.controlVersion, Number(operation.requestHash), handoffSource, messageId);
  };
  try {
    if (!await allowed()) { await cancel(); return; }
    let providerMessageId: string;
    if (integration.type === "telegram_bot") {
      const { sendTelegramText } = await import("./telegramCompanyService.ts");
      if (!await allowed()) { await cancel(); return; }
      providerMessageId = await sendTelegramText(prisma, integration, conversation.externalThreadId || "", message.text || "");
    } else if (integration.type === "instagram_direct") {
      const { sendInstagramText } = await import("./metaConnectionService.ts");
      if (!await allowed()) { await cancel(); return; }
      providerMessageId = await sendInstagramText(prisma, integration, conversation.externalThreadId || "", message.text || "");
    } else providerMessageId = message.id; // The website visitor reads accepted messages through their scoped session.
    await prisma.$transaction(async tx => {
      await lockConversation(tx);
      if (!await ownsClaim(tx)) throw new ApiError(409, "channel_sending", "Состояние отправки изменилось. Повторите проверку.");
      if (integration.type === "website_chat") {
        // Publishing to a visitor is a database operation, so serialize it with staff takeover.
        const current = await tx.conversation.count({ where: { id: conversation.id, tenantId, status: "open", controlVersion: operation!.controlVersion,
          messageRevision: conversation.messageRevision, mode: handoffSource ? { in: ["human", "paused"] } : "ai",
          connection: { status: "active", autoReply: true, integration: { id: integration.id, status: "active" } } } });
        if (!current) {
          await tx.message.updateMany({ where: { id: messageId, operationState: "sending" }, data: { operationState: "canceled" } });
          await tx.outboundOperation.updateMany({ where: { id: operation!.id, state: "sending" }, data: { state: "canceled" } });
          await releaseClaim(tx);
          return;
        }
      }
      await tx.message.update({ where: { id: messageId }, data: { operationState: "accepted", providerMessageId } });
      await tx.outboundOperation.update({ where: { id: operation!.id }, data: { state: "accepted", error: null } });
      if (!handoffSource) await tx.conversation.updateMany({ where: { id: conversation.id, controlVersion: conversation.controlVersion, messageRevision: conversation.messageRevision }, data: { waitingFor: "CLIENT", needsAttention: false, attentionReason: null } });
      await tx.conversation.update({ where: { id: conversation.id }, data: { messageRevision: { increment: 1 } } });
      await enqueueConversationContext(tx, tenantId, conversation.id, messageId);
      const { enqueueWhatsAppAi } = await import("./whatsappAiService.ts");
      await enqueueWhatsAppAi(tx, tenantId, conversation.id);
      await releaseClaim(tx);
    });
  } catch {
    await prisma.$transaction(async tx => {
      await lockConversation(tx);
      if (!await ownsClaim(tx)) return;
      const state = integration.type === "website_chat" ? "queued" : "unknown";
      await tx.message.updateMany({ where: { id: messageId, tenantId, operationState: "sending" }, data: { operationState: state } });
      if (operation) await tx.outboundOperation.updateMany({ where: { id: operation.id, state: "sending" }, data: { state, error: "Отправка каналом не подтверждена" } });
      if (state === "unknown") await tx.conversation.updateMany({ where: { id: conversation.id, tenantId, controlVersion: conversation.controlVersion }, data: { needsAttention: true, attentionReason: "AI_DELIVERY_UNKNOWN" } });
      await releaseClaim(tx);
    });
    if (integration.type === "website_chat") throw new ApiError(503, "channel_send_retry", "Ответ пока не опубликован. Отправка будет повторена автоматически.");
    throw new ApiError(502, "channel_send_unknown", "Канал не подтвердил отправку. Проверьте переписку перед повторной отправкой.");
  }
}
