import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Prisma, PrismaClient } from "@creolab/db";
import type { WASocket } from "@whiskeysockets/baileys";
import type { AuthContext } from "../lib/types.ts";
import { ApiError } from "../errors.ts";
import { requireTenant, assertConversationReachable } from "../lib/access.ts";
import { encryptSecret } from "../lib/secretBox.ts";
import { resolveUploadPath } from "../lib/storage.ts";
import { writeAudit } from "../lib/audit.ts";
import { writeActivity } from "./contactService.ts";
import { phoneFromContact } from "./contactLabels.ts";
import { assertConversationMime, decodeBase64Payload, storeMessageAttachment, CONVERSATION_MAX_FILE_BYTES, conversationMediaKind } from "./conversationMedia.ts";
import { cloudRequest, cloudSecrets, type CloudSettings } from "./whatsappCloudService.ts";
import { directWaBinding, directWaBusy, directWaChanged, directWaContentHash, directWaCredentialHash, directWaDigest,
  directWaDispatchBlock, directWaLease, directWaRevision, directWaRecipientHash, loadDirectWaDelivery, lockDirectWaConversation,
  publishDirectWaDelivery, readDirectWaDelivery, saveDirectWaDelivery, type DirectWaDelivery } from "./directWhatsAppDeliveryState.ts";

type Input = { text?: string; idempotencyKey?: string; attachments?: Array<{ fileName: string; mimeType: string; contentBase64: string }> };
const blocked = (reason: string) => new ApiError(409, reason === "window_closed" ? "whatsapp_window_closed" : "delivery_retry_blocked",
  reason === "window_closed" ? "Истекли 24 часа после сообщения клиента. Дождитесь нового сообщения клиента." : "Отправка остановлена. Обновите результат и проверьте подключение и доступ.", undefined, { reason });

async function enqueue(tx: Prisma.TransactionClient, tenantId: string, value: DirectWaDelivery) {
  if (value.channel === "whatsapp_qr") {
    // Each retry owns its job. A delayed worker can only remove its own old job.
    const id = value.generation ? `${value.messageId}:${value.queueToken}` : value.messageId;
    await tx.$executeRaw`INSERT INTO "WhatsAppQrJob" (id, "integrationId", kind, "encryptedPayload") VALUES (${id}, ${value.integrationId}, 'outbound', ${encryptSecret(JSON.stringify({ messageId: value.messageId, deliveryToken: value.queueToken }))})`;
  } else await tx.outboxEvent.create({ data: { tenantId, type: "whatsapp.cloud_send", entityType: "message", entityId: value.messageId,
    payloadJson: { integrationId: value.integrationId, deliveryToken: value.queueToken } } });
}

export async function sendDirectWhatsAppManual(prisma: PrismaClient, auth: AuthContext, conversationId: string, input: Input) {
  const { tenantId } = requireTenant(auth); await assertConversationReachable(prisma, auth, conversationId);
  const text = String(input.text || "").trim();
  if ((!text && !input.attachments?.length) || text.length > 4096 || (input.attachments?.length || 0) > 5) throw new ApiError(422, "invalid", "Введите текст до 4096 символов или прикрепите до 5 файлов");
  const files = (input.attachments || []).map(file => {
    const mimeType = assertConversationMime(file.fileName, file.mimeType), buffer = decodeBase64Payload(file.contentBase64);
    if (!buffer.length || buffer.length > CONVERSATION_MAX_FILE_BYTES) throw new ApiError(422, "too_large", "Файл должен быть непустым и не больше 16 МБ");
    return { fileName: file.fileName, mimeType, buffer };
  });
  const key = `whatsapp:${conversationId}:${input.idempotencyKey || randomUUID()}`, hash = directWaDigest(key);
  const fingerprint = directWaDigest(JSON.stringify({ text, files: files.map(f => [f.fileName, f.mimeType, directWaDigest(f.buffer.toString("base64"))]) }));
  const value = await prisma.$transaction(async tx => {
    await lockDirectWaConversation(tx, tenantId, conversationId);
    const conv = await tx.conversation.findFirstOrThrow({ where: { id: conversationId, tenantId }, include: { connection: { include: { integration: true } }, contact: { include: { methods: true } } } });
    const existing = await tx.message.findFirst({ where: { tenantId, conversationId, connectionScopedId: { in: [`wa-out:${tenantId}:${hash}`, `wa-out-v2:${tenantId}:${hash}`] } }, include: { attachments: true } });
    if (existing) {
      const op = await tx.outboundOperation.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: key } } });
      if (existing.senderUserId !== auth.user.id || op?.requestHash !== fingerprint) throw new ApiError(409, "idempotency_conflict", "Ключ отправки уже использован");
      return { existing };
    }
    const connection = conv.connection, row = connection?.integration;
    if (!connection || !row || !["whatsapp_qr", "whatsapp_cloud"].includes(row.type) || connection.status !== "active" || row.status !== "active" || conv.mode !== "human" || conv.status !== "open") throw blocked("connection_changed");
    const target = conv.externalThreadId || "";
    if (!(row.type === "whatsapp_qr" ? /^\d+@(s\.whatsapp\.net|lid)$/ : /^\d+$/).test(target)) throw blocked("conversation_changed");
    if (row.type === "whatsapp_cloud") {
      const last = await tx.message.findFirst({ where: { tenantId, conversationId, direction: "inbound", internal: false }, orderBy: { createdAt: "desc" } });
      if (!last || Date.now() - last.createdAt.getTime() >= 86_400_000) throw blocked("window_closed");
    }
    const credential = row.type === "whatsapp_cloud" ? await tx.credential.findFirst({ where: { id: row.credentialId || "", tenantId, kind: "whatsapp_cloud" } }) : null;
    if (row.type === "whatsapp_cloud" && !credential) throw blocked("connection_changed");
    const message = await tx.message.create({ data: { tenantId, conversationId, direction: "outbound", senderKind: "staff", senderUserId: auth.user.id,
      text: text || null, type: files.length ? conversationMediaKind(files[0].mimeType) : "text", operationState: "queued", connectionScopedId: `wa-out-v2:${tenantId}:${hash}` } });
    const attachments = [];
    for (const file of files) attachments.push(await storeMessageAttachment(tx, { tenantId, messageId: message.id, ...file, uploadedById: auth.user.id, sendState: "pending" }));
    const op = await tx.outboundOperation.create({ data: { tenantId, conversationId, idempotencyKey: key, controlVersion: conv.controlVersion, state: "queued", requestHash: fingerprint, providerRef: message.id } });
    const phone = phoneFromContact(conv.contact, { externalThreadId: target }), settings = (row.schemaJson || {}) as CloudSettings;
    const delivery: DirectWaDelivery = { version: 1, messageId: message.id, actorUserId: auth.user.id, contactId: conv.contactId,
      channel: row.type as DirectWaDelivery["channel"], connectionId: connection.id, integrationId: row.id, connectionRef: connection.externalRef,
      bindingHash: directWaBinding(row), credentialHash: credential ? directWaCredentialHash(credential) : null,
      target, recipient: [conv.contact?.name || "Клиент WhatsApp", phone || (target.endsWith("@lid") ? "Номер скрыт WhatsApp" : target)].join(" · "),
      senderPhone: String(settings.phone || connection.externalRef || "").replace(/\D/g, ""), contentHash: directWaContentHash(message.text, attachments), messageRevision: conv.messageRevision,
      queueToken: randomUUID(), generation: 0, queued: true, claim: null, leaseUntil: 0,
      parts: [...(text ? [{ id: "text", state: "pending" as const, attempt: 0 }] : []), ...attachments.map(f => ({ id: f.id, state: "pending" as const, attempt: 0 }))] };
    const { campaignRefFromOperation } = await import("./campaignDelivery.ts"), ref = campaignRefFromOperation(key);
    if (ref) {
      const campaign = await tx.campaign.findFirstOrThrow({ where: { id: ref.campaignId, tenantId } });
      const recipient = await tx.campaignRecipient.findFirstOrThrow({ where: { id: ref.recipientId, tenantId, campaignId: campaign.id, conversationId, contactId: conv.contactId } });
      delivery.campaign = { id: campaign.id, recipientId: ref.recipientId, recipientHash: directWaRecipientHash(recipient), confirmedAt: campaign.confirmedAt?.toISOString() || null, contentHash: campaign.contentHash };
    }
    const stop = await directWaDispatchBlock(tx, tenantId, op, delivery); if (stop) throw blocked(stop);
    await saveDirectWaDelivery(tx, tenantId, op.id, delivery); await enqueue(tx, tenantId, delivery);
    return { delivery };
  }, { timeout: 30_000 });
  if (value.existing) return value.existing;
  const delivery = value.delivery!;
  if (delivery.channel === "whatsapp_cloud") await dispatchDirectWhatsApp(prisma, delivery.integrationId, delivery.messageId, { deliveryToken: delivery.queueToken });
  return prisma.message.findFirstOrThrow({ where: { id: delivery.messageId, tenantId }, include: { attachments: true } });
}

export async function retryDirectWhatsAppManual(prisma: PrismaClient, tenantId: string, conversationId: string, messageId: string, revision: string, reviewerId: string) {
  const value = await prisma.$transaction(async tx => {
    await lockDirectWaConversation(tx, tenantId, conversationId);
    const { operation, delivery } = await loadDirectWaDelivery(tx, tenantId, conversationId, messageId);
    if (directWaRevision(operation, delivery) !== revision) throw directWaChanged();
    if (directWaBusy(delivery, operation.state)) throw blocked("busy");
    if (delivery.parts.some(p => ["sending", "unknown"].includes(p.state))) throw blocked("unknown");
    if (delivery.parts.every(p => p.state === "accepted")) throw blocked("complete");
    delivery.reviewerId = reviewerId;
    const stop = await directWaDispatchBlock(tx, tenantId, operation, delivery, "retry"); if (stop) throw blocked(stop);
    delivery.queued = true; delivery.claim = null; delivery.leaseUntil = 0; delivery.canceled = false; delivery.queueToken = randomUUID(); delivery.generation++;
    await publishDirectWaDelivery(tx, tenantId, operation.id, delivery); await enqueue(tx, tenantId, delivery);
    const changes = { conversationId, channel: delivery.channel, campaignId: delivery.campaign?.id || null, partIds: delivery.parts.filter(p => p.state !== "accepted").map(p => p.id) };
    await writeAudit(tx, { tenantId, actorUserId: reviewerId, action: "message.delivery_retry", entityType: "message", entityId: messageId, changes });
    if (delivery.contactId && await tx.contact.count({ where: { tenantId, id: delivery.contactId } })) await writeActivity(tx, { tenantId, contactId: delivery.contactId, type: "message.delivery_retry", title: "Повтор неотправленных частей WhatsApp", actorType: "user", actorId: reviewerId, metadata: changes });
    return delivery;
  });
  if (value.channel === "whatsapp_cloud") await dispatchDirectWhatsApp(prisma, value.integrationId, messageId, { deliveryToken: value.queueToken });
}

export async function dispatchDirectWhatsApp(prisma: PrismaClient, integrationId: string, messageId: string,
  options: { deliveryToken?: string; socket?: WASocket; checkLease?: () => Promise<void> } = {}) {
  const message = await prisma.message.findFirst({ where: { id: messageId, connectionScopedId: { startsWith: "wa-out-v2:" } } });
  if (!message) return;
  const tenantId = message.tenantId, claim = randomUUID();
  const prepared = await prisma.$transaction(async tx => {
    await lockDirectWaConversation(tx, tenantId, message.conversationId);
    const { operation, delivery } = await loadDirectWaDelivery(tx, tenantId, message.conversationId, messageId);
    // The original sender owns the job even after the conversation changes connection.
    // Claim it to record the cancellation instead of leaving it queued forever.
    if (delivery.integrationId !== integrationId) return;
    if ((delivery.channel === "whatsapp_qr") !== Boolean(options.socket)) return;
    // Old jobs and retries of the original HTTP request can never claim a newer retry.
    if (!delivery.queued || delivery.claim
      || (options.deliveryToken ? options.deliveryToken !== delivery.queueToken : delivery.generation !== 0)) return;
    if (operation.state !== "queued") {
      if (["canceled", "failed"].includes(operation.state)) {
        delivery.queued = false; delivery.canceled = operation.state === "canceled";
        await publishDirectWaDelivery(tx, tenantId, operation.id, delivery);
      }
      return;
    }
    if (delivery.campaign && await tx.campaign.count({ where: { id: delivery.campaign.id, tenantId, status: "paused" } })) return "deferred" as const;
    delivery.queued = false; delivery.claim = claim; delivery.leaseUntil = directWaLease();
    await publishDirectWaDelivery(tx, tenantId, operation.id, delivery);
    return { operation, delivery };
  });
  if (!prepared || prepared === "deferred") return prepared;
  const { operation, delivery } = prepared;
  const withClaim = <T>(fn: (tx: Prisma.TransactionClient, current: DirectWaDelivery) => Promise<T>) => prisma.$transaction(async tx => {
    await lockDirectWaConversation(tx, tenantId, operation.conversationId);
    const current = await readDirectWaDelivery(tx, tenantId, operation.id);
    if (!current || current.claim !== claim || current.leaseUntil <= Date.now()) throw directWaChanged();
    return fn(tx, current);
  });
  const guardSocket = async () => {
    if (delivery.channel !== "whatsapp_qr") return;
    if (!options.socket || !options.checkLease) throw blocked("connection_changed");
    await options.checkLease();
    const phone = options.socket.user?.id?.split("@")[0].split(":")[0];
    if (!phone || !delivery.senderPhone || phone !== delivery.senderPhone) throw blocked("connection_changed");
  };
  try {
    for (const part of delivery.parts) {
      if (part.state === "accepted") continue;
      await guardSocket();
      await withClaim(async (tx, current) => { const stop = await directWaDispatchBlock(tx, tenantId, operation, current); if (stop) throw blocked(stop); });
      const { message: stored } = await loadDirectWaDelivery(prisma, tenantId, operation.conversationId, messageId);
      const row = await prisma.integration.findFirstOrThrow({ where: { id: integrationId, tenantId } }), settings = row.schemaJson as CloudSettings;
      const secrets = delivery.channel === "whatsapp_cloud" ? await cloudSecrets(prisma, row) : null;
      let qrBody: Parameters<WASocket["sendMessage"]>[1] = { text: stored.text || "" };
      let cloudBody: object = { type: "text", text: { body: stored.text } };
      if (part.id !== "text") {
        const file = stored.attachments.find(f => f.id === part.id); let bytes: Buffer;
        try {
          if (!file) throw new Error("missing"); bytes = await readFile(resolveUploadPath(file.storageKey));
          if (bytes.length !== file.sizeBytes || bytes.length > CONVERSATION_MAX_FILE_BYTES || directWaDigest(bytes) !== file.checksum) throw new Error("changed");
        } catch { throw new ApiError(409, "attachment_changed", "Исходный файл отсутствует или изменился. Прикрепите исходный файл новым сообщением."); }
        qrBody = { document: bytes, fileName: file!.originalFileName || file!.fileName, mimetype: file!.mimeType };
        if (secrets) {
          const form = new FormData(); form.set("messaging_product", "whatsapp"); form.set("file", new Blob([new Uint8Array(bytes)], { type: file!.mimeType }), file!.originalFileName || file!.fileName);
          const upload = await cloudRequest<{ id?: string }>(secrets, settings.apiVersion, `/${settings.phoneNumberId}/media`, { method: "POST", body: form });
          if (typeof upload.id !== "string" || !upload.id) throw new ApiError(502, "whatsapp_upload_failed", "WhatsApp не принял файл. Сообщение с файлом не отправлено.");
          const kind = conversationMediaKind(file!.mimeType), type = ["image", "video", "audio"].includes(kind) ? kind : "document";
          cloudBody = { type, [type]: { id: upload.id, ...(type === "document" ? { filename: file!.originalFileName || file!.fileName } : {}) } };
        }
      }
      // Uploading media is preparation, not a client message. Recheck window/access afterwards.
      await guardSocket();
      await withClaim(async (tx, current) => {
        const stop = await directWaDispatchBlock(tx, tenantId, operation, current); if (stop) throw blocked(stop);
        const item = current.parts.find(p => p.id === part.id)!;
        if (!["pending", "failed"].includes(item.state)) throw directWaChanged();
        item.state = "sending"; item.attempt++; item.providerMessageId = null; item.error = null;
        delete item.receipt; delete item.reconciledBy; delete item.reconciledAt; delete item.reconciliationNote;
        current.leaseUntil = directWaLease(); await publishDirectWaDelivery(tx, tenantId, operation.id, current);
      });
      let providerId: string | undefined;
      try {
        if (options.socket) providerId = (await options.socket.sendMessage(delivery.target, qrBody))?.key.id || undefined;
        else {
          const reply = await cloudRequest<{ messages?: Array<{ id?: string }> }>(secrets!, settings.apiVersion, `/${settings.phoneNumberId}/messages`, { method: "POST", body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: delivery.target, ...cloudBody }) });
          providerId = reply.messages?.[0]?.id;
        }
        if (typeof providerId !== "string" || !providerId.trim()) throw new Error("No acknowledgement");
      } catch {
        await withClaim(async (tx, current) => { const item = current.parts.find(p => p.id === part.id)!; item.state = "unknown"; item.error = "WhatsApp не подтвердил результат отправки"; await publishDirectWaDelivery(tx, tenantId, operation.id, current); });
        throw new ApiError(502, "whatsapp_send_unknown", "WhatsApp не подтвердил отправку. Проверьте результат перед повтором.");
      }
      await withClaim(async (tx, current) => {
        Object.assign(current.parts.find(p => p.id === part.id)!, { state: "accepted", providerMessageId: providerId, error: null });
        await publishDirectWaDelivery(tx, tenantId, operation.id, current);
      });
    }
  } catch (error) {
    // A changed policy stops the remaining parts, but does not make accepted parts unknown.
    if (!(error instanceof ApiError && ["delivery_retry_blocked", "whatsapp_window_closed"].includes(error.code))) throw error;
    await withClaim(async (tx, current) => { current.canceled = true; await saveDirectWaDelivery(tx, tenantId, operation.id, current); });
  } finally {
    await prisma.$transaction(async tx => {
      await lockDirectWaConversation(tx, tenantId, operation.conversationId);
      const current = await readDirectWaDelivery(tx, tenantId, operation.id);
      if (!current || current.claim !== claim) return;
      for (const item of current.parts) if (item.state === "sending") { item.state = "unknown"; item.error = "WhatsApp не подтвердил результат отправки"; }
      current.claim = null; current.leaseUntil = 0; current.queued = false;
      await publishDirectWaDelivery(tx, tenantId, operation.id, current);
    });
    if (delivery.campaign) await (await import("./campaignService.ts")).refreshCampaignAfterDeliveryReview(prisma, tenantId, delivery.campaign.id);
  }
}
