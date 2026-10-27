import { readFile } from "node:fs/promises";
import type { PrismaClient } from "@creolab/db";
import { validateClientPhone } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { resolveUploadPath } from "../lib/storage.ts";
import { requireNotManager } from "../lib/access.ts";
import { authForUserInTenant } from "./authService.ts";
import { sendDirectWhatsApp, deliverCloudMessage } from "./whatsappSendService.ts";
import { getEntitlements } from "./entitlementService.ts";
import { whatsappLid, whatsappPhoneJid } from "./whatsappContactIdentity.ts";

export function campaignSenderId(campaign: { parsedCommandJson?: unknown }) {
  const value = campaign.parsedCommandJson as Record<string, unknown> | null;
  return typeof value?.whatsappIntegrationId === "string" ? value.whatsappIntegrationId : null;
}

export async function campaignSenders(prisma: PrismaClient, tenantId: string) {
  const rows = await prisma.integration.findMany({
    where: { tenantId, status: "active", type: { in: ["whatsapp_qr", "whatsapp_cloud", "whatsapp_seller"] } },
    include: { channelConnections: { where: { tenantId, status: "active" }, select: { id: true } } },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  return rows.filter(row => row.type === "whatsapp_seller" || (row.connectionStatus === "CONNECTED" && row.channelConnections.length)).map(row => {
    const settings = row.schemaJson as Record<string, unknown> | null;
    return { id: row.id, provider: row.type, phone: String(settings?.phone || ""),
      label: [row.name || "WhatsApp", settings?.phone].filter(Boolean).join(" · ") };
  });
}

export async function chooseCampaignSender(prisma: PrismaClient, tenantId: string, requested?: string) {
  const options = await campaignSenders(prisma, tenantId);
  const direct = options.filter(row => row.provider !== "whatsapp_seller");
  const chosen = requested ? options.find(row => row.id === requested) : direct.length === 1 ? direct[0] : null;
  if (requested && !chosen) throw new ApiError(422, "sender_unavailable", "Выбранный WhatsApp не подключён");
  if (!requested && direct.length > 1) throw new ApiError(422, "sender_required", "Выберите номер WhatsApp для рассылки");
  // Legacy campaigns keep their original transport unless the owner selects a direct connection.
  return chosen?.provider !== "whatsapp_seller" ? chosen?.id || null : null;
}

export function directCampaignKey(campaignId: string, recipientId: string) {
  return `campaign:${campaignId}:recipient:${recipientId}`;
}

export function campaignRefFromOperation(key?: string | null) {
  const match = key?.match(/:campaign:([0-9a-f-]{36}):recipient:([0-9a-f-]{36})$/);
  return match ? { campaignId: match[1], recipientId: match[2] } : null;
}

/** Existing direct operations must be reviewed/retried per part, never requeued as whole recipients. */
export async function retryableDirectRecipients(prisma: PrismaClient, tenantId: string, campaignId: string) {
  const [recipients, operations] = await Promise.all([
    prisma.campaignRecipient.findMany({ where: { tenantId, campaignId, status: "failed" }, select: { id: true } }),
    prisma.outboundOperation.findMany({ where: { tenantId, idempotencyKey: { contains: `:campaign:${campaignId}:recipient:` } }, select: { idempotencyKey: true } }),
  ]);
  const attempted = new Set(operations.map(op => campaignRefFromOperation(op.idempotencyKey)?.recipientId));
  return recipients.filter(r => !attempted.has(r.id)).map(r => r.id);
}

export async function campaignDispatchAllowed(prisma: PrismaClient, input: {
  tenantId: string; campaignId: string; recipientId: string; conversationId: string; integrationId: string;
}) {
  const recipient = await prisma.campaignRecipient.findFirst({ where: {
    id: input.recipientId, tenantId: input.tenantId, campaignId: input.campaignId,
    status: "sending", conversationId: input.conversationId,
    campaign: { status: { in: ["running", "paused"] }, tenantId: input.tenantId },
  }, include: { campaign: true } });
  if (!recipient?.campaign.confirmedById || campaignSenderId(recipient.campaign) !== input.integrationId) return false;
  try {
    const auth = await authForUserInTenant(prisma, recipient.campaign.confirmedById, input.tenantId);
    if (auth.activeMembership?.tenantId !== input.tenantId || !auth.activeMembership.active) return false;
    requireNotManager(auth);
  } catch (error) {
    if (error instanceof ApiError && [401, 403].includes(error.status)) return false;
    throw error;
  }
  const access = await getEntitlements(prisma, input.tenantId);
  return Boolean(access.snapshot.grandfathered || access.entitlements.MASS_CAMPAIGNS);
}

export async function queueDirectCampaignRecipient(
  prisma: PrismaClient,
  campaign: { id: string; tenantId: string; confirmedById?: string | null; parsedCommandJson?: unknown },
  recipient: { id: string; contactId: string; phoneNormalized: string | null; phoneRaw: string | null },
  text: string,
  attachments: Array<{ fileName: string; mimeType: string; storageKey: string }>,
) {
  const integrationId = campaignSenderId(campaign);
  if (!integrationId) throw new ApiError(409, "sender_unavailable", "Выбранный WhatsApp не подключён");
  const saved = await prisma.campaignRecipient.findFirstOrThrow({ where: { id: recipient.id, tenantId: campaign.tenantId, campaignId: campaign.id } });
  if (saved.conversationId) {
    const operation = await prisma.outboundOperation.findUnique({ where: { tenantId_idempotencyKey: {
      tenantId: campaign.tenantId, idempotencyKey: `whatsapp:${saved.conversationId}:${directCampaignKey(campaign.id, recipient.id)}`,
    } } });
    if (operation) {
      // A worker restart must neither create another send nor take the conversation
      // back from the AI after an employee has changed its mode.
      if (operation.state === "queued" && operation.providerRef) {
        await deliverCloudMessage(prisma, campaign.tenantId, integrationId, operation.providerRef);
      }
      return;
    }
  }
  const connection = await prisma.channelConnection.findFirst({
    where: { tenantId: campaign.tenantId, integrationId, status: "active",
      integration: { tenantId: campaign.tenantId, status: "active", connectionStatus: "CONNECTED", type: { in: ["whatsapp_qr", "whatsapp_cloud"] } } },
    include: { integration: true },
  });
  if (!connection) throw new ApiError(409, "sender_unavailable", "Выбранный WhatsApp не подключён");
  if (!campaign.confirmedById) throw new ApiError(409, "needs_confirmation", "Сначала подтвердите рассылку");
  const auth = await authForUserInTenant(prisma, campaign.confirmedById, campaign.tenantId, `campaign:${campaign.id}`);
  if (auth.activeMembership?.tenantId !== campaign.tenantId || !auth.activeMembership.active) throw new ApiError(403, "access_changed", "Нет доступа к отправке рассылки");
  requireNotManager(auth, "Нет доступа к отправке рассылки");
  const phone = validateClientPhone(recipient.phoneRaw || `+${recipient.phoneNormalized}`, auth.activeMembership.tenant.defaultRegion);
  if (!phone.ok) throw new ApiError(422, "invalid_phone", "Нет доступного номера");
  const thread = connection.integration.type === "whatsapp_qr" ? `${phone.normalized}@s.whatsapp.net` : phone.normalized;
  const conversation = await prisma.$transaction(async tx => {
    // Serialize creation for this contact, including concurrent campaign workers.
    await tx.$queryRaw`SELECT id FROM "Contact" WHERE id = ${recipient.contactId} AND "tenantId" = ${campaign.tenantId} FOR UPDATE`;
    const current = await tx.campaignRecipient.findFirstOrThrow({ where: { id: recipient.id, tenantId: campaign.tenantId, campaignId: campaign.id } });
    if (current.conversationId) {
      return tx.conversation.findFirstOrThrow({ where: {
        id: current.conversationId, tenantId: campaign.tenantId, connectionId: connection.id, contactId: recipient.contactId,
      } });
    }
    const aliases = [thread];
    if (connection.integration.type === "whatsapp_qr") {
      const identities = await tx.externalIdentity.findMany({ where: { tenantId: campaign.tenantId, connectionId: connection.id, contactId: recipient.contactId, type: "whatsapp" }, select: { externalId: true } });
      const phones = [...new Set(identities.map(i => whatsappPhoneJid(i.externalId)).filter(Boolean))];
      // A LID is an address, not a phone. Reuse it only with an unambiguous,
      // provider-supplied phone mapping on this exact connection and contact.
      if (phones.length === 1 && phones[0] === thread) aliases.push(...identities.map(i => whatsappLid(i.externalId)).filter((id): id is string => Boolean(id)));
    }
    let row = await tx.conversation.findFirst({
      where: { tenantId: campaign.tenantId, connectionId: connection.id, contactId: recipient.contactId, externalThreadId: { in: aliases }, status: "open" },
      orderBy: { updatedAt: "desc" },
    });
    if (!row) row = await tx.conversation.create({ data: {
      tenantId: campaign.tenantId, connectionId: connection.id, contactId: recipient.contactId,
      externalThreadId: thread, mode: "human", assigneeMembershipId: auth.activeMembership!.id,
    } });
    if (row.mode !== "human") row = await tx.conversation.update({ where: { id: row.id },
      data: { mode: "human", controlVersion: { increment: 1 }, needsAttention: false, attentionReason: "taken_by_human" } });
    await tx.campaignRecipient.update({ where: { id: recipient.id }, data: { conversationId: row.id, contactId: recipient.contactId } });
    return row;
  });
  const files = await Promise.all(attachments.map(async file => ({
    fileName: file.fileName, mimeType: file.mimeType, contentBase64: (await readFile(resolveUploadPath(file.storageKey))).toString("base64"),
  })));
  await sendDirectWhatsApp(prisma, auth, conversation.id, {
    text, attachments: files, idempotencyKey: directCampaignKey(campaign.id, recipient.id),
  });
}

/** A queued message is not a successful campaign delivery. Reconcile only actual transport results. */
export async function reconcileDirectCampaign(prisma: PrismaClient, tenantId: string, campaignId: string) {
  const rows = await prisma.campaignRecipient.findMany({ where: { tenantId, campaignId, status: "sending", conversationId: { not: null } } });
  for (const row of rows) {
    const operation = await prisma.outboundOperation.findUnique({ where: { tenantId_idempotencyKey: {
      tenantId, idempotencyKey: `whatsapp:${row.conversationId}:${directCampaignKey(campaignId, row.id)}`,
    } } });
    if (!operation?.providerRef) continue;
    const message = await prisma.message.findFirst({ where: { id: operation.providerRef, tenantId, conversationId: row.conversationId! }, include: { attachments: true } });
    if (!message || ["queued", "sending"].includes(message.operationState)) continue;
    const accepted = message.operationState === "accepted";
    const status = accepted ? "sent" : message.operationState === "canceled" ? "cancelled" : message.operationState === "unknown" ? "unknown" : "failed";
    await prisma.campaignRecipient.updateMany({ where: { id: row.id, tenantId, status: "sending" }, data: {
      status, sentAt: accepted ? new Date() : null, providerMessageId: message.providerMessageId,
      textSendState: message.text ? (message.providerMessageId || accepted ? "sent" : status) : "none",
      filesSendState: message.attachments.length ? (message.attachments.every(file => file.sendState === "sent") ? "sent"
        : message.attachments.some(file => file.sendState === "sent") ? "partial" : status) : "none",
      error: accepted ? null : status === "unknown"
        ? "WhatsApp не подтвердил отправку. Проверьте переписку перед повторной отправкой."
        : status === "cancelled" ? "Отправка отменена" : "Не удалось отправить через выбранный WhatsApp",
    } });
  }
}
