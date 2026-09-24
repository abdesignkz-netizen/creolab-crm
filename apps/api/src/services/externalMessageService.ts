import { enqueueConversationContext } from "./conversationContextQueue.ts";
import { createHash } from "node:crypto";
import type { PrismaClient, Prisma } from "@creolab/db";
import { ApiError } from "../errors.ts";
import { storeMessageAttachment } from "./conversationMedia.ts";

export async function recordExternalMessage(prisma: PrismaClient, integrationId: string, input: {
  eventId: string; channel: "email" | "instagram"; externalUserId: string; threadId: string; messageId: string;
  name: string; email?: string; text: string; at: Date; raw: Prisma.InputJsonValue;
  attachments?: Array<{ fileName: string; mimeType: string; buffer: Buffer }>;
}) {
  return prisma.$transaction(async tx => {
    const integration = await tx.integration.update({ where: { id: integrationId }, data: { lastEventAt: new Date(), lastSuccessAt: new Date(), healthStatus: "HEALTHY", lastError: null, lastErrorCode: null }, include: { tenant: true } });
    if (integration.status !== "active" || integration.tenant.status !== "active") throw new ApiError(403, "integration_disabled", "Подключение недоступно");
    const { tenantId } = integration;
    const duplicate = await tx.inboundEvent.findUnique({ where: { integrationId_externalEventKey: { integrationId, externalEventKey: input.eventId } } });
    if (duplicate) return { duplicate: true };
    let connection = await tx.channelConnection.findFirst({ where: { tenantId, integrationId, channelType: input.channel } });
    if (!connection) connection = await tx.channelConnection.create({ data: { tenantId, integrationId, channelType: input.channel, status: "active", capabilitiesJson: input.channel === "email" ? ["receive_messages"] : ["receive_messages", "send_text", "requires_template_outside_window"] } });
    const identity = await tx.externalIdentity.findFirst({ where: { tenantId, connectionId: connection.id, type: input.channel, externalId: input.externalUserId } });
    const contact = identity ? await tx.contact.findFirstOrThrow({ where: { id: identity.contactId, tenantId } }) : await tx.contact.create({ data: { tenantId, name: input.name } });
    if (!identity) {
      await tx.externalIdentity.create({ data: { tenantId, contactId: contact.id, connectionId: connection.id, integrationId, type: input.channel, externalId: input.externalUserId } });
      if (input.email) await tx.contactMethod.create({ data: { tenantId, contactId: contact.id, type: "email", rawValue: input.email, normalizedValue: input.email.toLowerCase(), source: "email", confirmed: false } });
    }
    let conversation = await tx.conversation.findFirst({ where: { tenantId, connectionId: connection.id, externalThreadId: input.threadId, contactId: contact.id } });
    if (!conversation) conversation = await tx.conversation.create({ data: { tenantId, connectionId: connection.id, externalThreadId: input.threadId, contactId: contact.id, mode: "human" } });
    const scopedId = `${input.channel}:${connection.id}:${input.messageId}`;
    const previousMessage = await tx.message.findUnique({ where: { connectionScopedId: scopedId } });
    if (!previousMessage) {
      const message = await tx.message.create({ data: { tenantId, conversationId: conversation.id, direction: "inbound", senderKind: "client", text: input.text, createdAt: input.at, providerMessageId: input.messageId, connectionScopedId: scopedId } });
      await enqueueConversationContext(tx, tenantId, conversation.id, message.id);
      for (const file of input.attachments || []) await storeMessageAttachment(tx, { tenantId, messageId: message.id, ...file });
      await tx.conversation.update({ where: { id: conversation.id }, data: { waitingFor: "MANAGER", needsAttention: true, attentionReason: "client_waiting", messageRevision: { increment: 1 } } });
      await tx.contact.update({ where: { id: contact.id }, data: { lastSeenAt: new Date(), lastInboundMessageAt: input.at } });
    }
    await tx.inboundEvent.create({ data: { tenantId, integrationId, externalEventKey: input.eventId, payloadHash: createHash("sha256").update(JSON.stringify(input.raw)).digest("hex"), rawJson: input.raw, eventType: "MESSAGE_RECEIVED", provider: input.channel, status: "PROCESSED", processedAt: new Date(), test: integration.testMode } });
    return { conversationId: conversation.id };
  });
}
