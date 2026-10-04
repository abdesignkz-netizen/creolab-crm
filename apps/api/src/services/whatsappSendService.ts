import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PrismaClient } from "@creolab/db";
import type { WASocket } from "@whiskeysockets/baileys";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { assertConversationReachable, requireTenant } from "../lib/access.ts";
import { encryptSecret } from "../lib/secretBox.ts";
import { resolveUploadPath } from "../lib/storage.ts";
import { assertConversationMime, decodeBase64Payload, CONVERSATION_MAX_ATTACHMENTS, CONVERSATION_MAX_FILE_BYTES, storeMessageAttachment, conversationMediaKind } from "./conversationMedia.ts";
import { directWhatsAppTypes, waDigest } from "./whatsappConnectionService.ts";
import { cloudSecrets, cloudRequest, type CloudSettings } from "./whatsappCloudService.ts";
import { enqueueConversationContext } from "./conversationContextQueue.ts";

export async function sendDirectWhatsApp(prisma: PrismaClient, auth: AuthContext, id: string, input: { text?: string; idempotencyKey?: string; attachments?: Array<{ fileName: string; mimeType: string; contentBase64: string }> }) {
  const { tenantId } = requireTenant(auth); await assertConversationReachable(prisma, auth, id);
  const text = String(input.text || "").trim();
  if ((!text && !input.attachments?.length) || text.length > 4096 || (input.attachments?.length || 0) > CONVERSATION_MAX_ATTACHMENTS) throw new ApiError(422, "invalid", "Введите текст до 4096 символов или прикрепите до 5 файлов");
  const files = (input.attachments || []).map(file => {
    const mimeType = assertConversationMime(file.fileName, file.mimeType), buffer = decodeBase64Payload(file.contentBase64);
    if (!buffer.length || buffer.length > CONVERSATION_MAX_FILE_BYTES) throw new ApiError(422, "too_large", "Файл больше 16 МБ");
    return { fileName: file.fileName, mimeType, buffer };
  });
  const fingerprint = waDigest(JSON.stringify({ text, files: files.map(f => [f.fileName, f.mimeType, waDigest(f.buffer.toString("base64"))]) }));
  const key = `whatsapp:${id}:${input.idempotencyKey || randomUUID()}`, scoped = `wa-out:${tenantId}:${waDigest(key)}`;
  const claimed = await prisma.$transaction(async tx => {
    const conversation = await tx.conversation.update({ where: { tenantId_id: { tenantId, id } }, data: { updatedAt: new Date() }, include: { connection: { include: { integration: true } } } });
    const connection = conversation.connection;
    if (conversation.mode !== "human" || !connection || !directWhatsAppTypes.includes(connection.integration.type) || connection.status !== "active" || connection.integration.status !== "active") throw new ApiError(409, "whatsapp_unavailable", "Возьмите диалог и проверьте подключение WhatsApp");
    const existing = await tx.message.findUnique({ where: { connectionScopedId: scoped }, include: { attachments: true } });
    if (existing) {
      const operation = await tx.outboundOperation.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } } });
      if (existing.senderUserId !== auth.user.id || operation?.requestHash !== fingerprint) throw new ApiError(409, "idempotency_conflict", "Ключ отправки уже использован");
      return { existing };
    }
    if (connection.integration.type === "whatsapp_cloud") {
      const last = await tx.message.findFirst({ where: { tenantId, conversationId: id, direction: "inbound", internal: false }, orderBy: { createdAt: "desc" } });
      if (!last || Date.now() - last.createdAt.getTime() >= 86400000) throw new ApiError(409, "whatsapp_window_closed", "Истекли 24 часа после сообщения клиента. Дождитесь нового сообщения клиента.");
    }
    const message = await tx.message.create({ data: { tenantId, conversationId: id, direction: "outbound", senderKind: "staff", senderUserId: auth.user.id, text: text || null, type: files.length ? conversationMediaKind(files[0].mimeType) : "text", operationState: "queued", connectionScopedId: scoped } });
    for (const file of files) await storeMessageAttachment(tx, { tenantId, messageId: message.id, ...file, uploadedById: auth.user.id, sendState: "pending" });
    await tx.outboundOperation.create({ data: { tenantId, conversationId: id, idempotencyKey: key, controlVersion: conversation.controlVersion, state: "queued", requestHash: fingerprint, providerRef: message.id } });
    if (connection.integration.type === "whatsapp_qr") await tx.$executeRaw`INSERT INTO "WhatsAppQrJob" (id, "integrationId", kind, "encryptedPayload") VALUES (${message.id}, ${connection.integrationId}, 'outbound', ${encryptSecret(JSON.stringify({ messageId: message.id }))})`;
    return { message, integration: connection.integration };
  });
  if (claimed.existing) return claimed.existing;
  if (claimed.integration!.type === "whatsapp_cloud") await deliverMessage(prisma, claimed.integration!.id, claimed.message!.id);
  return prisma.message.findUnique({ where: { id: claimed.message!.id }, include: { attachments: true } });
}

export async function deliverQrMessage(prisma: PrismaClient, integrationId: string, socket: WASocket, messageId: string, checkLease: () => Promise<void>) {
  return deliverMessage(prisma, integrationId, messageId, socket, checkLease);
}
export async function deliverCloudMessage(prisma: PrismaClient, tenantId: string, integrationId: string, messageId: string) {
  if (!await prisma.integration.findFirst({ where: { id: integrationId, tenantId, type: "whatsapp_cloud" }, select: { id: true } })) return;
  return deliverMessage(prisma, integrationId, messageId);
}
async function deliverMessage(prisma: PrismaClient, integrationId: string, messageId: string, socket?: WASocket, checkLease?: () => Promise<void>) {
  const message = await prisma.message.findFirst({ where: { id: messageId, operationState: "queued", conversation: { connection: { integrationId } } }, include: { attachments: true, conversation: { include: { connection: { include: { integration: true } } } } } });
  if (!message) return;
  const conversation = message.conversation, row = conversation.connection!.integration, recipient = conversation.externalThreadId || "";
  const validRecipient = socket ? /^\d+@(s\.whatsapp\.net|lid)$/.test(recipient) : /^\d+$/.test(recipient);
  const ai = message.senderKind === "ai";
  const operation = await prisma.outboundOperation.findFirst({ where: { tenantId: row.tenantId, providerRef: message.id } });
  const cancel = async () => {
    await prisma.message.updateMany({ where: { id: messageId, operationState: { in: ["queued", "sending"] } }, data: { operationState: "canceled" } });
    if (operation) await prisma.outboundOperation.updateMany({ where: { id: operation.id }, data: { state: "canceled" } });
  };
  async function dispatchAllowed() {
    if (!operation) return false;
    const current = await prisma.outboundOperation.findFirst({ where: { id: operation.id, tenantId: row.tenantId,
      state: { in: ["queued", "sending"] }, conversation: { id: conversation.id, status: "open", mode: ai ? "ai" : "human",
        controlVersion: operation.controlVersion, tenant: { status: "active" },
        connection: { status: "active", integrationId, integration: { status: "active" } } } }, select: { id: true } });
    if (!current) return false;
    if (!ai) return true;
    const { directAiSendAllowed } = await import("./whatsappAiService.ts");
    return directAiSendAllowed(prisma, row.tenantId, conversation.id, operation.controlVersion, Number(operation.requestHash));
  }
  // Only one caller can dispatch this message, including concurrent outbox workers.
  const claimed = await prisma.message.updateMany({ where: { id: messageId, operationState: "queued" }, data: { operationState: "sending" } });
  if (!claimed.count) return;
  try {
    if (!await dispatchAllowed()) { await cancel(); return; }
    if (!validRecipient || row.status !== "active" || conversation.connection!.status !== "active" || conversation.mode !== (ai ? "ai" : "human")) throw new ApiError(409, "whatsapp_unavailable", "Подключение WhatsApp недоступно");
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
      await tx.conversation.updateMany({ where: { id: conversation.id, messageRevision: conversation.messageRevision, controlVersion: conversation.controlVersion }, data: { waitingFor: "CLIENT", needsAttention: false, attentionReason: null } });
      await tx.conversation.update({ where: { id: conversation.id }, data: { messageRevision: { increment: 1 } } });
      await enqueueConversationContext(tx, row.tenantId, conversation.id, messageId);
      // An inbound message can arrive while the provider is accepting this send.
      // Refresh its queued reply after the outbound revision increment.
      const { enqueueWhatsAppAi } = await import("./whatsappAiService.ts");
      await enqueueWhatsAppAi(tx, row.tenantId, conversation.id);
    });
  } catch {
    await prisma.message.update({ where: { id: messageId }, data: { operationState: "unknown" } });
    await prisma.outboundOperation.updateMany({ where: { tenantId: row.tenantId, providerRef: messageId }, data: { state: "unknown" } });
    throw new ApiError(502, "whatsapp_send_unknown", "WhatsApp не подтвердил отправку. Проверьте переписку перед повторной отправкой.");
  }
}
