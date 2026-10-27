import { readFile } from "node:fs/promises";
import type { PrismaClient } from "@creolab/db";
import type { WASocket } from "@whiskeysockets/baileys";
import { ApiError } from "../errors.ts";
import { resolveUploadPath } from "../lib/storage.ts";
import { conversationMediaKind } from "./conversationMedia.ts";
import { cloudSecrets, cloudRequest, type CloudSettings } from "./whatsappCloudService.ts";
import { enqueueConversationContext } from "./conversationContextQueue.ts";
import { readAiReply } from "./aiReplyDeliveryState.ts";
import { dispatchAiReply } from "./aiReplyDelivery.ts";

export { sendDirectWhatsAppManual as sendDirectWhatsApp } from "./directWhatsAppManualDelivery.ts";
import { dispatchDirectWhatsApp } from "./directWhatsAppManualDelivery.ts";

export async function deliverQrMessage(prisma: PrismaClient, integrationId: string, socket: WASocket, messageId: string, checkLease: () => Promise<void>, deliveryToken?: string) {
  return deliverMessage(prisma, integrationId, messageId, socket, checkLease, deliveryToken);
}
export async function deliverCloudMessage(prisma: PrismaClient, tenantId: string, integrationId: string, messageId: string, deliveryToken?: string) {
  if (!await prisma.integration.findFirst({ where: { id: integrationId, tenantId, type: "whatsapp_cloud" }, select: { id: true } })) return;
  return deliverMessage(prisma, integrationId, messageId, undefined, undefined, deliveryToken);
}
async function deliverMessage(prisma: PrismaClient, integrationId: string, messageId: string, socket?: WASocket, checkLease?: () => Promise<void>, deliveryToken?: string) {
  const aiMessage = await prisma.message.findFirst({ where: { id: messageId, senderKind: "ai" }, select: { tenantId: true } });
  if (aiMessage && await readAiReply(prisma, aiMessage.tenantId, messageId)) return dispatchAiReply(prisma, aiMessage.tenantId, messageId, { integrationId, socket, checkLease, deliveryToken });
  const tracked = await prisma.message.findFirst({ where: { id: messageId, connectionScopedId: { startsWith: "wa-out-v2:" } }, select: { id: true } });
  if (tracked) return dispatchDirectWhatsApp(prisma, integrationId, messageId, { socket, checkLease, deliveryToken });
  const message = await prisma.message.findFirst({ where: { id: messageId, operationState: "queued", conversation: { connection: { integrationId } } }, include: { attachments: true, conversation: { include: { connection: { include: { integration: true } } } } } });
  if (!message) return;
  const conversation = message.conversation, row = conversation.connection!.integration, recipient = conversation.externalThreadId || "";
  const validRecipient = socket ? /^\d+@(s\.whatsapp\.net|lid)$/.test(recipient) : /^\d+$/.test(recipient);
  const ai = message.senderKind === "ai";
  const senderUserId = message.senderUserId;
  const operation = await prisma.outboundOperation.findFirst({ where: { tenantId: row.tenantId, providerRef: message.id } });
  const { campaignRefFromOperation, reconcileDirectCampaign, campaignDispatchAllowed } = await import("./campaignDelivery.ts");
  const campaignRef = campaignRefFromOperation(operation?.idempotencyKey);
  if (campaignRef && await prisma.campaign.count({ where: { id: campaignRef.campaignId, tenantId: row.tenantId, status: "paused" } })) return "deferred";
  const reconcileCampaign = async () => {
    if (campaignRef) await reconcileDirectCampaign(prisma, row.tenantId, campaignRef.campaignId)
      .catch(() => console.error("Campaign delivery reconciliation deferred", campaignRef.campaignId));
  };
  const summary = conversation.aiHandoffSummaryJson as Record<string, unknown> | null;
  const handoffSource = ai && operation && typeof summary?.sourceMessageId === "string"
    && operation.idempotencyKey === `wa-ai-handoff:${conversation.id}:${summary.sourceMessageId}:${operation.controlVersion}`
    ? summary.sourceMessageId : undefined;
  const expectedMode = handoffSource ? { in: ["human", "paused"] } : ai ? "ai" : "human";
  const cancel = async () => {
    const partiallySent = await prisma.message.count({ where: { id: messageId,
      OR: [{ providerMessageId: { not: null } }, { attachments: { some: { sendState: "sent" } } }] } });
    const state = partiallySent ? "unknown" : "canceled";
    await prisma.message.updateMany({ where: { id: messageId, operationState: { in: ["queued", "sending"] } }, data: { operationState: state } });
    if (operation) await prisma.outboundOperation.updateMany({ where: { id: operation.id }, data: { state } });
    await reconcileCampaign();
  };
  async function dispatchAllowed() {
    if (!operation) return false;
    if (campaignRef) {
      if (!await campaignDispatchAllowed(prisma, { ...campaignRef, tenantId: row.tenantId, conversationId: conversation.id, integrationId })) return false;
    }
    const current = await prisma.outboundOperation.findFirst({ where: { id: operation.id, tenantId: row.tenantId,
      state: { in: ["queued", "sending"] }, conversation: { id: conversation.id, status: "open", mode: expectedMode,
        controlVersion: operation.controlVersion, tenant: { status: "active" },
        connection: { status: "active", integrationId, integration: { status: "active" } } } }, select: { id: true } });
    if (!current) return false;
    if (!ai) return Boolean(senderUserId && await prisma.membership.count({ where: {
      tenantId: row.tenantId, userId: senderUserId, active: true,
      OR: [{ role: { not: "manager" } }, { id: conversation.assigneeMembershipId || "" }],
    } }));
    const { directAiSendAllowed } = await import("./whatsappAiService.ts");
    return directAiSendAllowed(prisma, row.tenantId, conversation.id, operation.controlVersion, Number(operation.requestHash), handoffSource, messageId);
  }
  // Only one caller can dispatch this message, including concurrent outbox workers.
  const claimed = await prisma.message.updateMany({ where: { id: messageId, operationState: "queued" }, data: { operationState: "sending" } });
  if (!claimed.count) return;
  try {
    if (!await dispatchAllowed()) { await cancel(); return; }
    if (!validRecipient || row.status !== "active" || conversation.connection!.status !== "active" || (handoffSource ? !["human", "paused"].includes(conversation.mode) : conversation.mode !== (ai ? "ai" : "human"))) throw new ApiError(409, "whatsapp_unavailable", "Подключение WhatsApp недоступно");
    const claimedOperation = await prisma.outboundOperation.updateMany({ where: { id: operation!.id, state: "queued" }, data: { state: "sending" } });
    if (!claimedOperation.count) { await cancel(); return; }
    const settings = row.schemaJson as CloudSettings, secrets = socket ? null : await cloudSecrets(prisma, row);
    async function cloudSend(content: object) {
      const active = await prisma.integration.findFirst({ where: { id: integrationId, status: "active", tenant: { status: "active" } }, select: { id: true } });
      if (!active) throw new Error("Disconnected");
      const result = await cloudRequest<{ messages?: Array<{ id: string }> }>(secrets!, settings.apiVersion, `/${settings.phoneNumberId}/messages`, { method: "POST", body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: recipient, ...content }) });
      if (!result.messages?.[0]?.id) throw new Error("Provider did not confirm delivery");
      return result.messages[0].id;
    }
    let providerMessageId: string | undefined;
    if (message.text) {
      await checkLease?.();
      if (!await dispatchAllowed()) { await cancel(); return; }
      providerMessageId = socket ? (await socket.sendMessage(recipient, { text: message.text }))?.key.id || undefined : await cloudSend({ type: "text", text: { body: message.text } });
      if (!providerMessageId) throw new Error("Provider did not confirm delivery");
      await prisma.message.update({ where: { id: messageId }, data: { providerMessageId } });
    }
    for (const file of message.attachments) {
      await checkLease?.();
      const buffer = await readFile(resolveUploadPath(file.storageKey));
      if (!await dispatchAllowed()) { await cancel(); return; }
      let sentId: string | undefined;
      if (socket) sentId = (await socket.sendMessage(recipient, { document: buffer, fileName: file.fileName, mimetype: file.mimeType }))?.key.id || undefined;
      else {
        const form = new FormData(); form.set("messaging_product", "whatsapp"); form.set("file", new Blob([new Uint8Array(buffer)], { type: file.mimeType }), file.fileName);
        const upload = await cloudRequest<{ id: string }>(secrets!, settings.apiVersion, `/${settings.phoneNumberId}/media`, { method: "POST", body: form });
        const kind = conversationMediaKind(file.mimeType);
        const type = ["image", "video", "audio"].includes(kind) ? kind : "document";
        if (!await dispatchAllowed()) { await cancel(); return; }
        sentId = await cloudSend({ type, [type]: { id: upload.id, ...(type === "document" ? { filename: file.fileName } : {}) } });
      }
      if (!sentId) throw new Error("Provider did not confirm delivery");
      providerMessageId ||= sentId;
      await prisma.attachment.update({ where: { id: file.id }, data: { sendState: "sent", providerMessageId: sentId } });
    }
    await prisma.$transaction(async tx => {
      await tx.message.update({ where: { id: messageId }, data: { operationState: "accepted", providerMessageId } });
      await tx.outboundOperation.updateMany({ where: { tenantId: row.tenantId, providerRef: messageId }, data: { state: "accepted" } });
      if (!handoffSource) await tx.conversation.updateMany({ where: { id: conversation.id, messageRevision: conversation.messageRevision, controlVersion: conversation.controlVersion }, data: { waitingFor: "CLIENT", needsAttention: false, attentionReason: null } });
      await tx.conversation.update({ where: { id: conversation.id }, data: { messageRevision: { increment: 1 } } });
      await enqueueConversationContext(tx, row.tenantId, conversation.id, messageId);
      // An inbound message can arrive while the provider is accepting this send.
      // Refresh its queued reply after the outbound revision increment.
      const { enqueueWhatsAppAi } = await import("./whatsappAiService.ts");
      await enqueueWhatsAppAi(tx, row.tenantId, conversation.id);
    });
    await reconcileCampaign();
  } catch {
    await prisma.message.update({ where: { id: messageId }, data: { operationState: "unknown" } });
    await prisma.outboundOperation.updateMany({ where: { tenantId: row.tenantId, providerRef: messageId }, data: { state: "unknown" } });
    await reconcileCampaign();
    throw new ApiError(502, "whatsapp_send_unknown", "WhatsApp не подтвердил отправку. Проверьте переписку перед повторной отправкой.");
  }
}
