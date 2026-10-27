import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@creolab/db";
import type { WASocket } from "@whiskeysockets/baileys";
import { ApiError } from "../errors.ts";
import { cloudRequest, cloudSecrets, type CloudSettings } from "./whatsappCloudService.ts";
import { aiReplyBlock, aiReplyChanged, lockAiReply, publishAiReply, readAiReply, recoverAiReplyDeliveries } from "./aiReplyDeliveryState.ts";

/** Sends the saved AI text once. Explicit retries use a new queue token and never call the model. */
export async function dispatchAiReply(prisma: PrismaClient, tenantId: string, messageId: string, options: {
  integrationId?: string; deliveryToken?: string; socket?: WASocket; checkLease?: () => Promise<void>;
} = {}) {
  const found = await readAiReply(prisma, tenantId, messageId); if (!found) return;
  await recoverAiReplyDeliveries(prisma, { integrationId: found.integrationId });
  const claim = randomUUID();
  const value = await prisma.$transaction(async tx => {
    await lockAiReply(tx, tenantId, found.conversationId); const v = await readAiReply(tx, tenantId, messageId);
    if (!v || (options.integrationId && options.integrationId !== v.integrationId) || (v.channel === "whatsapp_qr") !== Boolean(options.socket)) return;
    if (v.claim) throw new ApiError(409, "channel_sending", "Сообщение ещё отправляется.");
    if (!v.queued || (options.deliveryToken ? options.deliveryToken !== v.queueToken : v.generation !== 0)) return;
    if (v.state === "accepted") { v.queued = false; await publishAiReply(tx, tenantId, v); return; }
    const op = await tx.outboundOperation.findFirst({ where: { id: v.operationId, tenantId } });
    if (op?.state !== "queued") { v.queued = false; v.canceled = true; await publishAiReply(tx, tenantId, v); return; }
    v.queued = false; v.claim = claim; v.leaseUntil = Date.now() + 300_000;
    await publishAiReply(tx, tenantId, v); return v;
  });
  if (!value) return;
  const owns = async (tx: Prisma.TransactionClient) => {
    await lockAiReply(tx, tenantId, value.conversationId); const v = await readAiReply(tx, tenantId, messageId);
    if (!v || v.claim !== claim || v.leaseUntil <= Date.now()) throw aiReplyChanged(); return v;
  };
  const guard = async () => {
    await options.checkLease?.();
    if (options.socket && (!value.senderPhone || options.socket.user?.id?.split(":")[0].split("@")[0] !== value.senderPhone)) throw new ApiError(409, "delivery_retry_blocked", "Подключён другой номер WhatsApp");
    const stop = await aiReplyBlock(prisma, tenantId, value);
    if (stop) throw new ApiError(409, "delivery_retry_blocked", "Ответ уже не соответствует текущему диалогу или настройкам ИИ", undefined, { reason: stop });
    await prisma.$transaction(owns);
  };
  try {
    await guard();
    const integration = await prisma.integration.findFirstOrThrow({ where: { id: value.integrationId, tenantId } });
    // Preparation failures are known unsent. The durable intent is written immediately before the provider call.
    const markIntent = async () => {
      await guard(); await prisma.$transaction(async tx => {
        const v = await owns(tx);
        if (v.state === "accepted") throw new ApiError(409, "delivery_confirmed", "Доставка уже подтверждена");
        if (!await tx.outboundOperation.count({ where: { id: v.operationId, tenantId, conversationId: v.conversationId, providerRef: messageId, controlVersion: v.controlVersion, state: "sending" } })) {
          throw new ApiError(409, "delivery_retry_blocked", "Отправка ответа отменена");
        }
        const stop = await aiReplyBlock(tx, tenantId, v);
        if (stop) throw new ApiError(409, "delivery_retry_blocked", "Ответ уже не актуален", undefined, { reason: stop });
        v.state = "sending"; v.intent = true; v.providerMessageId = null;
        delete v.receipt; delete v.checkedBy; delete v.checkedAt; delete v.note;
        await publishAiReply(tx, tenantId, v);
      });
    };
    let providerMessageId: string | undefined;
    if (options.socket) {
      if (!/^\d+@(s\.whatsapp\.net|lid)$/.test(value.target)) throw new ApiError(409, "delivery_retry_blocked", "Получатель WhatsApp изменился");
      await markIntent(); providerMessageId = (await options.socket.sendMessage(value.target, { text: value.text }))?.key.id || undefined;
    } else if (value.channel === "whatsapp_cloud") {
      if (!/^\d+$/.test(value.target)) throw new ApiError(409, "delivery_retry_blocked", "Получатель WhatsApp изменился");
      const secrets = await cloudSecrets(prisma, integration), settings = integration.schemaJson as CloudSettings;
      await markIntent();
      const reply = await cloudRequest<{ messages?: Array<{ id?: string }> }>(secrets, settings.apiVersion, `/${settings.phoneNumberId}/messages`, {
        method: "POST", body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: value.target, type: "text", text: { body: value.text } }) });
      providerMessageId = reply.messages?.[0]?.id;
    } else if (value.channel === "telegram_bot") {
      const { telegramCall, tokenFor } = await import("./telegramTransport.ts");
      const token = await tokenFor(prisma, tenantId, integration.credentialId);
      if (!/^\d+$/.test(value.target) || !value.text || value.text.length > 4096) throw new ApiError(422, "invalid", "Некорректный ответ Telegram");
      await markIntent(); const reply = await telegramCall<{ message_id: number }>(token, "sendMessage", { chat_id: value.target, text: value.text });
      if (Number.isSafeInteger(reply.message_id) && reply.message_id > 0) providerMessageId = String(reply.message_id);
    } else {
      const { sendInstagramText } = await import("./metaConnectionService.ts");
      providerMessageId = await sendInstagramText(prisma, integration, value.target, value.text, markIntent);
    }
    if (typeof providerMessageId !== "string" || !providerMessageId.trim()) throw new Error("Missing acknowledgement");
    await prisma.$transaction(async tx => {
      const v = await owns(tx); v.state = "accepted"; v.providerMessageId = providerMessageId!;
      v.claim = null; v.leaseUntil = 0; await publishAiReply(tx, tenantId, v, true);
    });
  } catch (error) {
    const ambiguous = await prisma.$transaction(async tx => {
      await lockAiReply(tx, tenantId, value.conversationId); const v = await readAiReply(tx, tenantId, messageId);
      if (!v || v.claim !== claim) return true;
      if (v.state === "accepted") { v.claim = null; v.leaseUntil = 0; v.queued = false; await publishAiReply(tx, tenantId, v); return false; }
      const rejected = error instanceof ApiError && (error.details as { definitelyNotSent?: boolean } | undefined)?.definitelyNotSent === true;
      v.state = v.state === "sending" && !rejected ? "unknown" : "failed";
      v.canceled = !v.intent && error instanceof ApiError && error.code === "delivery_retry_blocked";
      v.claim = null; v.leaseUntil = 0; v.queued = false; await publishAiReply(tx, tenantId, v);
      return v.state === "unknown";
    });
    if (error instanceof ApiError && ["delivery_retry_blocked", "delivery_confirmed"].includes(error.code)) return;
    throw new ApiError(502, value.channel.startsWith("whatsapp") ? "whatsapp_send_unknown" : "channel_send_unknown",
      ambiguous ? "Канал не подтвердил отправку ответа ИИ. Проверьте результат перед повтором." : "Ответ ИИ не отправлен. Проверьте подключение и повторите отправку отдельно.");
  }
}

/** Called only after the signed Cloud webhook has stored its receipt. */
export async function applyAiReplyReceipt(prisma: PrismaClient, tenantId: string, integrationId: string, providerMessageId: string) {
  const messages = await prisma.message.findMany({ where: { tenantId, senderKind: "ai", direction: "outbound", providerMessageId }, select: { id: true, conversationId: true } });
  const tracked: string[] = [];
  for (const message of messages) await prisma.$transaction(async tx => {
    await lockAiReply(tx, tenantId, message.conversationId); const v = await readAiReply(tx, tenantId, message.id);
    if (!v || v.integrationId !== integrationId || v.providerMessageId !== providerMessageId) return;
    await publishAiReply(tx, tenantId, v); tracked.push(message.id);
  });
  return tracked;
}
