import { assertFileCapacity, consumeResource } from "./billingResourceService.ts";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateClientPhone, taskCreatorSnapshot } from "@creolab/contracts";
import type { Prisma, PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import { fileStorageStatus, resolveUploadPath } from "../lib/storage.ts";
import type { AuthContext } from "../lib/types.ts";
import { requireNotManager } from "../lib/access.ts";
import {
  acceptPersonalizedDraft,
  campaignTaskDedupeKey,
  clientFacingAskFromTask,
  composeRecipientOffer,
  inferCampaignOfferKind,
  looksLikeStaffCommand,
  personalize,
  pickPersonFirstName,
  recipientDraftsFingerprint,
  resolveRecipientSendText,
} from "./campaignPersonalize.ts";
import { extractSpokenMessage } from "./spokenMessage.ts";
import { inquiryRequestText, isGenericCompanyName, loadConversationInterests, pickUsableInterest } from "./contactInterestService.ts";
import { writeActivity } from "./contactService.ts";
import { refineCampaignRecipientDraftsWithLlm } from "./llmClient.ts";
import { hashExecutionContent } from "./messagingProvider.ts";
import { prepareLegacyMessage, deliverLegacyMessage, legacyCampaignKey, recoverLegacyMessage, type LegacyDelivery } from "./legacyMessageDelivery.ts";
import { claimLegacyRecipient, reconcileLegacyCampaign, retryableLegacyRecipients } from "./legacyCampaignDelivery.ts";
import { directWaScope, type DirectWaDelivery } from "./directWhatsAppDeliveryState.ts";
import { parseAndMatchPhoneList, type PhoneListItem } from "./phoneListService.ts";
import { previewContactSegment } from "./segmentService.ts";
import { resolveWhatsAppConversation } from "./sellerLink.ts";
import { getEntitlements } from "./entitlementService.ts";
import { campaignSenderId, campaignSenders, chooseCampaignSender, queueDirectCampaignRecipient, reconcileDirectCampaign, retryableDirectRecipients } from "./campaignDelivery.ts";
import { CONVERSATION_MAX_ATTACHMENTS, assertConversationMime } from "./conversationMedia.ts";

const ALLOWED_MIME = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
  "application/zip",
  "application/octet-stream",
]);

const EXT_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".txt": "text/plain",
  ".zip": "application/zip",
};

const MAX_FILE_BYTES = 15 * 1024 * 1024;

function resolveCampaignMime(fileName: string, mimeType: string) {
  const raw = String(mimeType || "").trim() || "application/octet-stream";
  if (raw !== "application/octet-stream" && raw !== "binary/octet-stream") return raw;
  const ext = path.extname(fileName || "").toLowerCase();
  return EXT_MIME[ext] || raw;
}

function safeFileName(fileName: string) {
  return String(fileName || "")
    .replace(/[^\w.\-а-яА-ЯёЁ ]+/g, "_")
    .slice(0, 180) || "file.bin";
}
const MAX_RECIPIENTS = 5000;
const SEND_CHUNK = 5;
const SEND_DELAY_MS = 400;

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) {
    throw new ApiError(403, "no_tenant", "Нет активной компании");
  }
  requireNotManager(auth, "Постановка задач и автоматизация доступны администратору и директору");
  return auth.activeMembership;
}

export async function ensureMassCampaignAccess(prisma: PrismaClient, tenantId: string) {
  const access = await getEntitlements(prisma, tenantId);
  if (access.snapshot.grandfathered || access.entitlements.MASS_CAMPAIGNS) return access;
  throw new ApiError(403, "feature_required", "Массовые рассылки доступны начиная с тарифа Start. Подключите тариф, чтобы продолжить.", undefined, { feature: "MASS_CAMPAIGNS", billingPath: "/billing" });
}

async function requireCampaignForTenant(prisma: PrismaClient, tenantId: string, id: string) {
  const campaign = await prisma.campaign.findFirst({ where: { id, tenantId } });
  if (!campaign) throw new ApiError(404, "not_found", "Рассылка не найдена");
  return campaign;
}

async function updateCampaignForTenant(
  prisma: PrismaClient,
  tenantId: string,
  id: string,
  data: Prisma.CampaignUpdateManyMutationInput,
) {
  const result = await prisma.campaign.updateMany({ where: { id, tenantId }, data });
  if (result.count === 0) throw new ApiError(404, "not_found", "Рассылка не найдена");
}

export function campaignSendLater(scheduledAt: Date | string | null | undefined, now = new Date()) {
  if (!scheduledAt) return false;
  const due = scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt);
  if (Number.isNaN(due.getTime())) return false;
  return due.getTime() > now.getTime();
}

function contentHash(message: string | null, attachments: unknown[], recipientFingerprint = "") {
  return hashExecutionContent({
    message: recipientFingerprint ? `${message || ""}\n${recipientFingerprint}` : message || "",
    attachments: attachments as Array<{ id: string; checksum?: string | null; fileName: string; sizeBytes: number }>,
  });
}

function campaignHashInput(
  campaign: { messageSnapshot?: string | null; messageDraft?: string | null; personalizeEach?: boolean | null; parsedCommandJson?: unknown },
  recipients: Array<{ id: string; status: string; messageDraft?: string | null }>,
  attachments: unknown[],
) {
  let fingerprint = campaign.personalizeEach ? recipientDraftsFingerprint(recipients) : "";
  if (campaignSenderId(campaign)) fingerprint += `\nsender:${campaignSenderId(campaign)}`;
  return contentHash(campaign.messageSnapshot || campaign.messageDraft || null, attachments, fingerprint);
}

async function campaignAttachments(prisma: PrismaClient, tenantId: string, campaignId: string) {
  return prisma.attachment.findMany({
    where: { tenantId, parentType: "campaign", parentId: campaignId },
    orderBy: { createdAt: "asc" },
  });
}

function statsFromRecipients(rows: Array<{ status: string }>) {
  const count = (status: string) => rows.filter((r) => r.status === status).length;
  return {
    total: rows.length,
    pending: count("pending") + count("queued"),
    sending: count("sending"),
    sent: count("sent") + count("delivered") + count("read") + count("replied"),
    failed: count("failed") + count("unknown"),
    unknown: count("unknown"),
    skipped: count("skipped") + count("cancelled"),
    delivered: count("delivered") + count("read") + count("replied"),
    read: count("read") + count("replied"),
    replied: count("replied"),
  };
}

/** Recalculate a settled campaign after an explicit review/retry. Never restart its queue. */
export async function refreshCampaignAfterDeliveryReview(prisma: PrismaClient, tenantId: string, id: string) {
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Campaign" WHERE id = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const campaign = await tx.campaign.findFirst({ where: { id, tenantId }, include: { recipients: { select: { status: true } } } });
    if (!campaign) return;
    const stats = statsFromRecipients(campaign.recipients);
    const settled = !stats.pending && !stats.sending && ["completed", "partially_completed", "failed"].includes(campaign.status);
    const status = !settled ? campaign.status : (stats.failed || stats.skipped) && stats.sent ? "partially_completed"
      : stats.failed ? "failed" : stats.skipped && !stats.sent ? "cancelled" : "completed";
    await tx.campaign.update({ where: { id, tenantId }, data: { status,
      statsJson: { ...(campaign.statsJson as Record<string, Prisma.InputJsonValue>), ...stats } } });
  });
}

export async function previewPhoneList(prisma: PrismaClient, auth: AuthContext, text: string) {
  const membership = requireTenant(auth);
  return parseAndMatchPhoneList(prisma, membership.tenantId, text, membership.tenant.defaultRegion || "KZ");
}

export async function createCampaign(
  prisma: PrismaClient,
  auth: AuthContext,
  input: {
    title?: string;
    channel?: string;
    source?: string;
    messageDraft?: string;
    messageMode?: string;
    personalizeEach?: boolean;
    createMissingClients?: boolean;
    scheduledAt?: string | null;
    rawCommandText?: string;
    contactIds?: string[];
    phoneListText?: string;
    phones?: string[];
    segment?: Record<string, unknown>;
    whatsappIntegrationId?: string;
  },
) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  await ensureMassCampaignAccess(prisma, tid);
  const senderId = await chooseCampaignSender(prisma, tid, input.whatsappIntegrationId);
  const recipients: Array<{
    contactId?: string | null;
    phoneRaw?: string | null;
    phoneNormalized?: string | null;
    displayName?: string | null;
    status: string;
    skipReason?: string | null;
  }> = [];

  if (input.contactIds?.length) {
    const contacts = await prisma.contact.findMany({
      where: { tenantId: tid, id: { in: input.contactIds.slice(0, MAX_RECIPIENTS) }, archivedAt: null },
      include: { methods: true },
    });
    for (const contact of contacts) {
      const phone = contact.methods
        .filter(method => ["phone", "whatsapp"].includes(method.type) && !/@lid\b/.test(method.rawValue || ""))
        .sort((left, right) => Number(right.primary) - Number(left.primary))
        .flatMap(method => [method.rawValue, method.normalizedValue ? `+${method.normalizedValue.replace(/^\+/, "")}` : null])
        .filter((value): value is string => Boolean(value) && /^[+\d\s()-]+$/.test(value!))
        .map(value => validateClientPhone(value, membership.tenant.defaultRegion || "KZ"))
        .find(result => result.ok);
      recipients.push({
        contactId: contact.id,
        phoneRaw: phone?.ok ? phone.raw : null,
        phoneNormalized: phone?.ok ? phone.normalized : null,
        displayName: contact.name || null,
        status: phone?.ok ? "pending" : "skipped",
        skipReason: phone?.ok ? null : "Нет доступного номера",
      });
    }
  }

  const phoneText = input.phoneListText || (input.phones || []).join("\n");
  let phonePreview: Awaited<ReturnType<typeof parseAndMatchPhoneList>> | null = null;
  if (phoneText?.trim()) {
    phonePreview = await parseAndMatchPhoneList(prisma, tid, phoneText, membership.tenant.defaultRegion || "KZ");
    for (const item of phonePreview.items) {
      if (item.status === "invalid" || item.status === "duplicate") {
        recipients.push({
          phoneRaw: item.raw,
          phoneNormalized: item.phoneNormalized || null,
          displayName: null,
          status: "skipped",
          skipReason: item.reason || item.status,
        });
        continue;
      }
      recipients.push({
        contactId: item.contactId || null,
        phoneRaw: item.phoneRaw || item.raw,
        phoneNormalized: item.phoneNormalized || null,
        displayName: item.displayName || null,
        status: "pending",
      });
    }
  }

  if (input.segment) {
    const segment = await previewContactSegment(prisma, auth, { ...input.segment, limit: MAX_RECIPIENTS });
    for (const client of segment.clients) {
      recipients.push({
        contactId: String(client.id),
        phoneRaw: client.phone ? String(client.phone) : null,
        phoneNormalized: null,
        displayName: client.name ? String(client.name) : null,
        status: client.phone ? "pending" : "skipped",
        skipReason: client.phone ? null : "Нет доступного номера",
      });
    }
  }

  // dedupe pending by contactId or normalized phone
  const seen = new Set<string>();
  const unique = [];
  for (const row of recipients) {
    const key = row.contactId || row.phoneNormalized || `skip:${row.phoneRaw}:${row.skipReason}`;
    if (row.status === "pending" && seen.has(key)) {
      unique.push({ ...row, status: "skipped", skipReason: "Дубликат" });
      continue;
    }
    if (row.status === "pending") seen.add(key);
    unique.push(row);
  }

  if (!unique.length) throw new ApiError(422, "invalid", "Нет получателей для рассылки");
  if (unique.filter((r) => r.status === "pending").length > MAX_RECIPIENTS) {
    throw new ApiError(422, "too_many", `Максимум ${MAX_RECIPIENTS} получателей в одной рассылке`);
  }

  const pendingCount = unique.filter((r) => r.status === "pending").length;
  const title = input.title?.trim() || `Массовая отправка · ${pendingCount}`;

  const campaign = await prisma.campaign.create({
    data: {
      tenantId: tid,
      title,
      channel: input.channel || "whatsapp",
      status: "draft",
      source: input.source || "manual",
      messageDraft: input.messageDraft || null,
      messageMode: input.messageMode || "manual",
      personalizeEach: Boolean(input.personalizeEach),
      createMissingClients: input.createMissingClients !== false,
      scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
      rawCommandText: input.rawCommandText || null,
      parsedCommandJson: senderId ? { whatsappIntegrationId: senderId } : {},
      createdByMembershipId: membership.id,
      segmentSnapshotJson: (input.segment || {}) as Prisma.InputJsonValue,
      statsJson: {
        total: unique.length,
        pending: pendingCount,
        skipped: unique.filter((r) => r.status === "skipped").length,
      } as Prisma.InputJsonValue,
      recipients: {
        create: unique.map((row) => ({
          tenantId: tid,
          contactId: row.contactId || null,
          phoneRaw: row.phoneRaw || null,
          phoneNormalized: row.phoneNormalized || null,
          displayName: row.displayName || null,
          status: row.status,
          skipReason: row.skipReason || null,
        })),
      },
    },
    include: { recipients: true },
  });

  return {
    campaign,
    phonePreview,
    summary: statsFromRecipients(campaign.recipients),
  };
}

export async function listCampaigns(prisma: PrismaClient, auth: AuthContext, query: Record<string, string | undefined> = {}) {
  const membership = requireTenant(auth);
  const requestedPage = Number(query.page);
  const page = Number.isFinite(requestedPage) ? Math.max(1, Math.min(10000, Math.floor(requestedPage))) : 1;
  const take = 25;
  const where = { tenantId: membership.tenantId };
  const [total, rows] = await Promise.all([
    prisma.campaign.count({ where }),
    prisma.campaign.findMany({
      where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * take, take,
      select: {
        id: true, title: true, status: true, createdAt: true, scheduledAt: true, completedAt: true,
        recipients: { select: { status: true } },
      },
    }),
  ]);
  return { total, page, pageSize: take, items: rows.map(({ recipients, ...row }) => ({ ...row, summary: statsFromRecipients(recipients) })) };
}

export async function listCampaignSenders(prisma: PrismaClient, auth: AuthContext) {
  return { items: await campaignSenders(prisma, requireTenant(auth).tenantId) };
}

export async function getCampaign(prisma: PrismaClient, auth: AuthContext, id: string) {
  const membership = requireTenant(auth);
  const campaign = await prisma.campaign.findFirst({
    where: { id, tenantId: membership.tenantId },
    include: { recipients: { orderBy: { createdAt: "asc" } } },
  });
  if (!campaign) throw new ApiError(404, "not_found", "Рассылка не найдена");
  const attachments = await campaignAttachments(prisma, membership.tenantId, id);
  const previews = buildPersonalizationPreviews(campaign.messageDraft, campaign.recipients, campaign.personalizeEach);
  const storage = fileStorageStatus();
  const operations = await prisma.outboundOperation.findMany({ where: { tenantId: membership.tenantId,
    OR: [{ idempotencyKey: { startsWith: `legacy:campaign:${id}:` } }, { idempotencyKey: { contains: `:campaign:${id}:recipient:` } }], providerRef: { not: null } },
    select: { id: true, idempotencyKey: true, providerRef: true, conversationId: true } });
  const records = operations.length ? await prisma.idempotencyRecord.findMany({ where: { scope: { in: ["legacy.message.delivery", directWaScope] },
    actorKey: membership.tenantId, key: { in: operations.map(op => op.id) } }, select: { key: true, resultJson: true } }) : [];
  const deliveries = new Map(records.map(row => [row.key, row.resultJson as unknown as LegacyDelivery | DirectWaDelivery]));
  const byKey = new Map(operations.map(op => [op.idempotencyKey, op]));
  return {
    ...campaign,
    recipients: campaign.recipients.map(row => {
      const op = byKey.get(legacyCampaignKey(id, row.id)) || byKey.get(`whatsapp:${row.conversationId}:campaign:${id}:recipient:${row.id}`);
      const delivery = op && deliveries.get(op.id);
      return { ...row, ...(op && delivery?.messageId === op.providerRef ? {
        deliveryMessageId: op.providerRef, deliveryConversationId: op.conversationId,
        deliveryChecked: delivery.parts.some(part => part.state === "accepted" && Boolean(part.reconciledBy)),
      } : {}) };
    }),
    attachments,
    summary: statsFromRecipients(campaign.recipients),
    personalizationPreviews: previews,
    storageWarning: storage.warning
      ? storage.warning.replace("задач", "задач и рассылок")
      : null,
  };
}

function buildPersonalizationPreviews(
  template: string | null,
  recipients: Array<{ displayName: string | null; status: string; messageDraft?: string | null }>,
  personalizeEach = false,
) {
  const pending = recipients.filter((r) => r.status === "pending");
  if (personalizeEach) {
    return pending.slice(0, 8).map((r) => ({
      label: r.displayName || "Контакт",
      text: r.messageDraft || (template ? personalize(template, { firstName: pickPersonFirstName(r.displayName) }) : ""),
    })).filter((item) => item.text);
  }
  if (!template) return [];
  const samples = pending.slice(0, 2);
  return [
    ...samples.map((r) => ({
      label: r.displayName || "Контакт",
      text: personalize(template, { firstName: pickPersonFirstName(r.displayName) }),
    })),
    { label: "Неизвестный контакт", text: personalize(template, { firstName: null }) },
  ];
}

export async function updateCampaign(
  prisma: PrismaClient,
  auth: AuthContext,
  id: string,
  input: {
    title?: string;
    messageDraft?: string | null;
    messageMode?: string;
    personalizeEach?: boolean;
    createMissingClients?: boolean;
    scheduledAt?: string | null;
    whatsappIntegrationId?: string;
    recipientIdsInclude?: string[];
    recipientIdsExclude?: string[];
    recipientDrafts?: Array<{ id: string; messageDraft: string | null }>;
  },
) {
  const membership = requireTenant(auth);
  const campaign = await prisma.campaign.findFirst({ where: { id, tenantId: membership.tenantId } });
  if (!campaign) throw new ApiError(404, "not_found", "Рассылка не найдена");
  if (["running", "completed", "cancelled"].includes(campaign.status)) {
    throw new ApiError(409, "locked", "Рассылку в этом статусе нельзя менять");
  }
  const senderId = input.whatsappIntegrationId === undefined ? undefined
    : await chooseCampaignSender(prisma, membership.tenantId, input.whatsappIntegrationId);
  if (campaign.startedAt && senderId !== undefined && senderId !== campaignSenderId(campaign)) {
    throw new ApiError(409, "locked", "Номер отправителя нельзя менять после запуска рассылки");
  }

  if (input.recipientIdsExclude?.length) {
    await prisma.campaignRecipient.updateMany({
      where: { campaignId: id, tenantId: membership.tenantId, id: { in: input.recipientIdsExclude } },
      data: { status: "skipped", skipReason: "Исключено пользователем" },
    });
  }
  if (input.recipientIdsInclude?.length) {
    await prisma.campaignRecipient.updateMany({
      where: {
        campaignId: id,
        tenantId: membership.tenantId,
        id: { in: input.recipientIdsInclude },
        status: "skipped",
        skipReason: "Исключено пользователем",
      },
      data: { status: "pending", skipReason: null },
    });
  }
  if (input.recipientDrafts?.length) {
    for (const row of input.recipientDrafts) {
      await prisma.campaignRecipient.updateMany({
        where: { id: row.id, campaignId: id, tenantId: membership.tenantId },
        data: { messageDraft: row.messageDraft },
      });
    }
  }

  const updated = await prisma.campaign.update({
    where: { id },
    data: {
      title: input.title ?? undefined,
      messageDraft: input.messageDraft === undefined ? undefined : input.messageDraft,
      messageMode: input.messageMode ?? undefined,
      personalizeEach: input.personalizeEach ?? undefined,
      createMissingClients: input.createMissingClients ?? undefined,
      scheduledAt: input.scheduledAt === undefined ? undefined : input.scheduledAt ? new Date(input.scheduledAt) : null,
      parsedCommandJson: senderId === undefined ? undefined : { ...(campaign.parsedCommandJson as Record<string, any>), whatsappIntegrationId: senderId },
      status: campaign.confirmedAt ? "draft" : campaign.status,
      confirmedAt: null,
      confirmedById: null,
      contentHash: null,
      messageSnapshot: null,
    },
  });
  return getCampaign(prisma, auth, updated.id);
}

export async function addCampaignAttachment(
  prisma: PrismaClient,
  auth: AuthContext,
  campaignId: string,
  input: { fileName: string; mimeType: string; contentBase64: string; documentType?: string },
) {
  const membership = requireTenant(auth);
  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, tenantId: membership.tenantId } });
  if (!campaign) throw new ApiError(404, "not_found", "Рассылка не найдена");
  const mimeType = resolveCampaignMime(input.fileName, input.mimeType);
  if (!ALLOWED_MIME.has(mimeType) && !mimeType.startsWith("image/")) {
    throw new ApiError(422, "unsupported_type", `Формат ${mimeType} не поддерживается`);
  }
  const buf = Buffer.from(input.contentBase64, "base64");
  if (buf.length > MAX_FILE_BYTES) throw new ApiError(422, "too_large", "Файл больше 15 МБ");
  const safeName = safeFileName(input.fileName);
  const attachmentId = randomUUID();
  const storageKey = path.posix.join(membership.tenantId, "campaigns", campaignId, `${attachmentId}-${safeName}`);
  const abs = resolveUploadPath(storageKey);
  await mkdir(path.dirname(abs), { recursive: true });
  await assertFileCapacity(prisma, membership.tenantId, buf.length);
  await writeFile(abs, buf);
  const checksum = createHash("sha256").update(buf).digest("hex");
  const row = await prisma.attachment.create({
    data: {
      id: attachmentId,
      tenantId: membership.tenantId,
      parentType: "campaign",
      parentId: campaignId,
      storageKey,
      fileName: safeName,
      originalFileName: input.fileName,
      mimeType,
      sizeBytes: buf.length,
      checksum,
      documentType: input.documentType || (mimeType.startsWith("image/") ? "image" : "document"),
      uploadedById: auth.user.id,
      status: "stored",
    },
  }).catch(async error => { await unlink(abs).catch(() => {}); throw error; });
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { confirmedAt: null, confirmedById: null, contentHash: null, status: "draft" },
  });
  return row;
}

export async function removeCampaignAttachment(prisma: PrismaClient, auth: AuthContext, campaignId: string, attachmentId: string) {
  const membership = requireTenant(auth);
  const att = await prisma.attachment.findFirst({
    where: { id: attachmentId, tenantId: membership.tenantId, parentType: "campaign", parentId: campaignId },
  });
  if (!att) throw new ApiError(404, "not_found", "Файл не найден");
  const abs = resolveUploadPath(att.storageKey);
  await prisma.attachment.delete({ where: { id: attachmentId } });
  // Per-recipient message history may reference the same immutable file.
  if (!await prisma.attachment.count({ where: { storageKey: att.storageKey } })) await unlink(abs).catch(() => {});
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { confirmedAt: null, confirmedById: null, contentHash: null, status: "draft" },
  });
  return { ok: true };
}

export async function prepareCampaign(prisma: PrismaClient, auth: AuthContext, id: string) {
  const data = await getCampaign(prisma, auth, id);
  const senderId = campaignSenderId(data);
  const sender = senderId ? (await campaignSenders(prisma, data.tenantId)).find(row => row.id === senderId) : null;
  if (senderId && !sender) throw new ApiError(409, "sender_unavailable", "Выбранный WhatsApp не подключён");
  if (senderId && data.attachments.length > CONVERSATION_MAX_ATTACHMENTS) throw new ApiError(422, "invalid", "Прикрепите не больше 5 файлов к рассылке");
  if (senderId) {
    for (const file of data.attachments) assertConversationMime(file.fileName, file.mimeType);
    if ([data.messageDraft, ...data.recipients.map(row => row.messageDraft)].some(text => (text?.length || 0) > 4096)) {
      throw new ApiError(422, "invalid", "Сократите сообщение до 4096 символов");
    }
  }
  const pendingForText = data.recipients.filter((r) => r.status === "pending");
  const missingOwnDrafts = pendingForText.filter((r) => !String(r.messageDraft || "").trim()).length;
  const hasSharedDraft = Boolean(String(data.messageDraft || "").trim());
  const hasRecipientDrafts = pendingForText.some((r) => String(r.messageDraft || "").trim());
  if (
    data.messageMode !== "file_only" &&
    !hasSharedDraft &&
    !(data.personalizeEach && hasRecipientDrafts && missingOwnDrafts === 0) &&
    data.attachments.length === 0
  ) {
    throw new ApiError(422, "invalid", data.personalizeEach
      ? "Составьте предложения каждому или укажите общий текст"
      : "Укажите текст или прикрепите файл");
  }
  if (data.messageMode === "file_only" && data.attachments.length === 0) {
    throw new ApiError(422, "invalid", "Для режима «только файл» нужно вложение");
  }
  const pending = data.recipients.filter((r) => r.status === "pending");
  if (!pending.length) throw new ApiError(422, "invalid", "Нет получателей для отправки");

  for (const att of data.attachments) {
    if (!ALLOWED_MIME.has(att.mimeType) && !att.mimeType.startsWith("image/")) {
      throw new ApiError(422, "unsupported_type", `${att.fileName} нельзя отправить через выбранный канал`);
    }
  }

  if (!["scheduled", "running", "completed", "partially_completed", "cancelled", "paused"].includes(data.status)) {
    await prisma.campaign.update({
      where: { id },
      data: { status: "ready" },
    });
  }

  return {
    title: "Проверьте рассылку",
    action: data.messageMode === "file_only" ? "Отправить файл" : "Отправить сообщение" + (data.attachments.length ? " и вложения" : ""),
    recipients: pending.length,
    foundInCrm: pending.filter((r) => r.contactId).length,
    newContacts: pending.filter((r) => !r.contactId).length,
    excluded: data.recipients.filter((r) => r.status === "skipped").length,
    channel: data.channel,
    sender: sender?.label || "WhatsApp · Green API",
    message: data.personalizeEach ? null : data.messageDraft,
    personalizeEach: data.personalizeEach,
    attachments: data.attachments.map((a) => ({
      id: a.id,
      fileName: a.fileName,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      documentType: a.documentType,
    })),
    when: campaignSendLater(data.scheduledAt) ? data.scheduledAt!.toISOString() : "Сейчас",
    personalizationPreviews: data.personalizationPreviews,
    createMissingClients: data.createMissingClients,
    buttons: {
      confirm: campaignSendLater(data.scheduledAt)
        ? `Подтвердить и запланировать ${pending.length} контактам`
        : `Подтвердить и отправить ${pending.length} контактам`,
      back: "Вернуться и изменить",
    },
    recipientsPreview: pending.slice(0, 50).map((r) => ({
      id: r.id,
      name: r.displayName,
      phone: r.phoneRaw,
      contactId: r.contactId,
      status: r.status,
      message: data.personalizeEach
        ? r.messageDraft || (data.messageDraft
          ? personalize(data.messageDraft, { firstName: pickPersonFirstName(r.displayName) })
          : null)
        : undefined,
    })),
    excludedPreview: data.recipients
      .filter((r) => r.status === "skipped")
      .slice(0, 50)
      .map((r) => ({ id: r.id, name: r.displayName, phone: r.phoneRaw, reason: r.skipReason })),
  };
}

async function ensureCampaignScheduleTask(
  prisma: PrismaClient,
  input: {
    campaign: {
      id: string;
      tenantId: string;
      title: string;
      source?: string | null;
      messageDraft?: string | null;
      rawCommandText?: string | null;
      scheduledAt: Date | null;
      recipients: Array<{
        id: string;
        status: string;
        contactId: string | null;
        displayName: string | null;
        messageDraft?: string | null;
      }>;
    };
    ownerMembershipId?: string | null;
    hasFile?: boolean;
  },
) {
  const pending = input.campaign.recipients.filter((row) => row.status === "pending");
  const type = input.hasFile ? "proposal" : "message";
  const dueAt = input.campaign.scheduledAt;
  const dedupeKey = campaignTaskDedupeKey(input.campaign.id);
  const payload = {
    campaignId: input.campaign.id,
    sendViaCampaign: true,
  };
  const shared = {
    title: input.campaign.title || "Массовая отправка",
    description: `Массовая рассылка WhatsApp · ${pending.length} получателям`,
    type,
    dueAt,
    status: "open" as const,
    executionStatus: "scheduled",
    commandStatus: "scheduled",
    source: input.campaign.source === "ai_command" ? "ai_command" : "manual",
    ownerMembershipId: input.ownerMembershipId || null,
    messageDraft: input.campaign.messageDraft || null,
    rawCommandText: input.campaign.rawCommandText || null,
    parsedCommandJson: payload as Prisma.InputJsonValue,
    segmentSnapshotJson: { label: "Массовая рассылка", campaignId: input.campaign.id } as Prisma.InputJsonValue,
    contextSnapshotJson: taskCreatorSnapshot({
      createdByKind: input.campaign.source === "ai_command" ? "ai" : "user",
      createdByMembershipId: input.ownerMembershipId || null,
      executorType: "USER",
    }) as Prisma.InputJsonValue,
    completedAt: null,
    resultCode: null,
    resultText: null,
  };
  const existing = await prisma.task.findFirst({
    where: { tenantId: input.campaign.tenantId, dedupeKey },
  });
  const parent = existing
    ? await prisma.task.update({
        where: { id: existing.id },
        data: shared,
      })
    : await prisma.task.create({
        data: {
          tenantId: input.campaign.tenantId,
          dedupeKey,
          targetType: "group",
          ...shared,
        },
      });

  const keep = new Set<string>();
  for (const recipient of pending.slice(0, 200)) {
    if (!recipient.contactId) continue;
    const childKey = `${dedupeKey}:r:${recipient.id}`;
    keep.add(childKey);
    const childShared = {
      title: recipient.displayName ? `${shared.title} · ${recipient.displayName}` : shared.title,
      description: shared.description,
      type,
      dueAt,
      status: "open" as const,
      executionStatus: "scheduled",
      commandStatus: "scheduled",
      source: shared.source,
      ownerMembershipId: shared.ownerMembershipId,
      messageDraft: recipient.messageDraft || shared.messageDraft,
      parsedCommandJson: { ...payload, recipientId: recipient.id } as Prisma.InputJsonValue,
      contextSnapshotJson: shared.contextSnapshotJson,
    };
    const child = await prisma.task.findFirst({
      where: { tenantId: input.campaign.tenantId, dedupeKey: childKey },
    });
    if (child) {
      await prisma.task.update({ where: { id: child.id }, data: { ...childShared, parentTaskId: parent.id } });
    } else {
      await prisma.task.create({
        data: {
          tenantId: input.campaign.tenantId,
          parentTaskId: parent.id,
          contactId: recipient.contactId,
          targetType: "client",
          dedupeKey: childKey,
          ...childShared,
        },
      });
    }
  }
  const stale = await prisma.task.findMany({
    where: { tenantId: input.campaign.tenantId, parentTaskId: parent.id, dedupeKey: { notIn: [...keep] } },
    select: { id: true },
  });
  if (stale.length) {
    await prisma.task.updateMany({
      where: { id: { in: stale.map((row) => row.id) } },
      data: { status: "canceled", executionStatus: "canceled", completedAt: new Date() },
    });
  }
  return parent;
}

async function closeCampaignScheduleTask(
  prisma: PrismaClient,
  tenantId: string,
  campaignId: string,
  status: "done" | "canceled",
  resultCode?: string,
) {
  const parent = await prisma.task.findFirst({
    where: { tenantId, dedupeKey: campaignTaskDedupeKey(campaignId) },
    select: { id: true },
  });
  if (!parent) return;
  const data = {
    status,
    executionStatus: status === "done" ? "sent" : "canceled",
    commandStatus: status === "done" ? "done" : "canceled",
    completedAt: new Date(),
    resultCode: resultCode || (status === "done" ? "sent" : "canceled"),
  };
  await prisma.task.update({ where: { id: parent.id }, data });
  await prisma.task.updateMany({
    where: { tenantId, parentTaskId: parent.id, status: { in: ["open", "waiting"] } },
    data,
  });
}

export async function confirmCampaign(
  prisma: PrismaClient,
  auth: AuthContext,
  id: string,
  input: { scheduledAt?: string | null } = {},
) {
  const membership = requireTenant(auth);
  await requireCampaignForTenant(prisma, membership.tenantId, id);
  if (input.scheduledAt !== undefined) {
    await updateCampaignForTenant(prisma, membership.tenantId, id, {
      scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
    });
  }
  const prepared = await prepareCampaign(prisma, auth, id);
  const campaign = await prisma.campaign.findFirst({
    where: { id, tenantId: membership.tenantId },
    include: { recipients: true },
  });
  if (!campaign) throw new ApiError(404, "not_found", "Рассылка не найдена");
  const attachments = await campaignAttachments(prisma, membership.tenantId, id);
  const pending = campaign.recipients.filter((r) => r.status === "pending");
  await ensureMassCampaignAccess(prisma, membership.tenantId);
  const attachmentSnapshots = attachments.map((a) => ({
    id: a.id,
    fileName: a.fileName,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    checksum: a.checksum,
    storageKey: a.storageKey,
    documentType: a.documentType,
  }));
  const recipientSnapshot = pending.map((r) => ({
    id: r.id,
    contactId: r.contactId,
    phoneRaw: r.phoneRaw,
    phoneNormalized: r.phoneNormalized,
    displayName: r.displayName,
    messageDraft: r.messageDraft || null,
  }));
  const hash = campaignHashInput(campaign, pending, attachmentSnapshots);


  const later = campaignSendLater(campaign.scheduledAt);
  const status = later ? "scheduled" : "awaiting_confirmation";

  await prisma.scheduledAction.updateMany({
    where: { tenantId: membership.tenantId, parentType: "campaign", parentId: id, type: "campaign_run", state: "scheduled" },
    data: { state: "canceled", cancelReason: later ? "rescheduled" : "send_now" },
  });

  const updatedCount = await prisma.campaign.updateMany({
    where: { id, tenantId: membership.tenantId },
    data: {
      status,
      confirmedAt: new Date(),
      confirmedById: auth.user.id,
      contentHash: hash,
      messageSnapshot: campaign.messageDraft,
      attachmentSnapshotsJson: attachmentSnapshots,
      recipientSnapshotJson: recipientSnapshot,
    },
  });
  if (updatedCount.count === 0) throw new ApiError(404, "not_found", "Рассылка не найдена");
  const updated = await prisma.campaign.findFirstOrThrow({ where: { id, tenantId: membership.tenantId } });

  let scheduleTask = null;
  if (later && campaign.scheduledAt) {
    await prisma.scheduledAction.create({
      data: {
        tenantId: membership.tenantId,
        type: "campaign_run",
        parentType: "campaign",
        parentId: id,
        dueAt: campaign.scheduledAt,
        state: "scheduled",
        payloadJson: { campaignId: id },
      },
    });
    scheduleTask = await ensureCampaignScheduleTask(prisma, {
      campaign: { ...campaign, scheduledAt: campaign.scheduledAt },
      ownerMembershipId: membership.id,
      hasFile: attachments.length > 0,
    });
  } else {
    await closeCampaignScheduleTask(prisma, membership.tenantId, id, "canceled");
  }

  return { campaign: updated, preview: prepared, task: scheduleTask };
}

export async function startCampaign(prisma: PrismaClient, auth: AuthContext, id: string) {
  const membership = requireTenant(auth);
  await ensureMassCampaignAccess(prisma, membership.tenantId);
  const campaign = await prisma.campaign.findFirst({ where: { id, tenantId: membership.tenantId } });
  if (!campaign) throw new ApiError(404, "not_found", "Рассылка не найдена");
  if (["cancelled", "completed"].includes(campaign.status)) throw new ApiError(409, "campaign_stopped", "Рассылка уже завершена или отменена");
  if (!campaign.confirmedAt || !campaign.contentHash) {
    throw new ApiError(409, "needs_confirmation", "Сначала подтвердите рассылку");
  }
  if (campaignSendLater(campaign.scheduledAt)) {
    throw new ApiError(409, "scheduled", "Рассылка запланирована на будущее");
  }
  const attachments = await campaignAttachments(prisma, membership.tenantId, id);
  const recipients = await prisma.campaignRecipient.findMany({ where: { campaignId: id, tenantId: membership.tenantId } });
  const confirmedRecipientIds = new Set((Array.isArray(campaign.recipientSnapshotJson) ? campaign.recipientSnapshotJson : [])
    .map(row => (row as { id?: string })?.id).filter(Boolean));
  // Delivery status must not invalidate the approved personalized content on resume.
  const hashRecipients = confirmedRecipientIds.size
    ? recipients.filter(row => confirmedRecipientIds.has(row.id)).map(row => ({ ...row, status: "pending" }))
    : recipients;
  const hash = campaignHashInput(campaign, hashRecipients, campaign.attachmentSnapshotsJson as unknown[]);
  if (hash !== campaign.contentHash) {
    throw new ApiError(409, "stale_confirmation", "Параметры рассылки изменились. Проверьте рассылку повторно.");
  }
  // verify attachment checksums still match snapshot
  const snap = (campaign.attachmentSnapshotsJson as Array<{ id: string; checksum?: string }>) || [];
  for (const item of snap) {
    const current = attachments.find((a) => a.id === item.id);
    if (!current || (item.checksum && current.checksum !== item.checksum)) {
      throw new ApiError(409, "stale_confirmation", "Файлы изменились после подтверждения");
    }
  }

  await prisma.$transaction(async tx => {
    const changed = await tx.campaign.updateMany({
      where: { id, tenantId: membership.tenantId, status: { notIn: ["cancelled", "completed"] },
        contentHash: campaign.contentHash, confirmedAt: campaign.confirmedAt },
      data: { status: "running", startedAt: campaign.startedAt || new Date(), pausedAt: null },
    });
    if (!changed.count) throw new ApiError(409, "stale_confirmation", "Рассылка изменилась. Обновите страницу.");
    await tx.campaignRecipient.updateMany({ where: { campaignId: id, tenantId: membership.tenantId, status: "pending" }, data: { status: "queued" } });
  });

  // fire-and-forget processing (also picked up by worker)
  void processCampaignQueue(prisma, id).catch((err) => console.error("campaign", id, err));

  return getCampaign(prisma, auth, id);
}

export async function pauseCampaign(prisma: PrismaClient, auth: AuthContext, id: string) {
  const membership = requireTenant(auth);
  await requireCampaignForTenant(prisma, membership.tenantId, id);
  await updateCampaignForTenant(prisma, membership.tenantId, id, { status: "paused", pausedAt: new Date() });
  return getCampaign(prisma, auth, id);
}

export async function cancelCampaignRemainder(prisma: PrismaClient, auth: AuthContext, id: string) {
  const membership = requireTenant(auth);
  await requireCampaignForTenant(prisma, membership.tenantId, id);
  await prisma.$transaction(async tx => {
    await tx.campaign.update({ where: { id, tenantId: membership.tenantId }, data: { status: "cancelled", completedAt: new Date() } });
    await tx.campaignRecipient.updateMany({
      where: { campaignId: id, tenantId: membership.tenantId, status: { in: ["pending", "queued"] } },
      data: { status: "cancelled", skipReason: "Отменено пользователем" },
    });
  });
  await closeCampaignScheduleTask(prisma, membership.tenantId, id, "canceled");
  return getCampaign(prisma, auth, id);
}

export async function retryFailedCampaign(prisma: PrismaClient, auth: AuthContext, id: string) {
  const membership = requireTenant(auth);
  const campaign = await requireCampaignForTenant(prisma, membership.tenantId, id);
  await ensureMassCampaignAccess(prisma, membership.tenantId);
  if (campaign.status === "cancelled") throw new ApiError(409, "campaign_stopped", "Отменённую рассылку нельзя запустить повторно");
  const safeIds = campaignSenderId(campaign) ? await retryableDirectRecipients(prisma, membership.tenantId, id) : await retryableLegacyRecipients(prisma, membership.tenantId, id);
  await prisma.$transaction(async tx => {
    const changed = await tx.campaign.updateMany({ where: { id, tenantId: membership.tenantId, status: { not: "cancelled" },
      contentHash: campaign.contentHash, confirmedById: campaign.confirmedById, confirmedAt: campaign.confirmedAt },
      data: { status: "running", pausedAt: null, completedAt: null } });
    if (!changed.count) throw new ApiError(409, "campaign_stopped", "Рассылка изменилась или отменена. Обновите страницу.");
    const retried = await tx.campaignRecipient.updateMany({
      where: { campaignId: id, tenantId: membership.tenantId, status: "failed", id: { in: safeIds } },
      data: { status: "queued", error: null },
    });
    if (!retried.count) throw new ApiError(409, "nothing_to_retry", "Нет сообщений для безопасной повторной отправки. Проверьте историю рассылки.");
  });
  void processCampaignQueue(prisma, id).catch((err) => console.error("campaign retry", id, err));
  return getCampaign(prisma, auth, id);
}

export async function pauseUnavailableCampaigns(prisma: PrismaClient, tenantId: string) {
  const access = await getEntitlements(prisma, tenantId);
  if (access.entitlements.MASS_CAMPAIGNS) return;
  const reason = 'Отправка остановлена: текущая подписка не включает массовые рассылки. История сохранена.';
  const rows = await prisma.campaign.findMany({where: {tenantId, status: {in: ['scheduled', 'running', 'awaiting_confirmation']}}});
  for (const row of rows) {
    await prisma.campaign.update({where: {id: row.id}, data: {status: 'paused', pausedAt: new Date(), statsJson: {...(row.statsJson as Record<string, any> || {}), billingPauseReason: reason}}});
    await prisma.scheduledAction.updateMany({where: {tenantId, parentType: 'campaign', parentId: row.id, state: {in: ['scheduled', 'running']}}, data: {state: 'canceled', cancelReason: reason}});
    await prisma.campaignRecipient.updateMany({where: {tenantId, campaignId: row.id, status: {in: ['pending', 'queued']}}, data: {error: reason}});
  }
}

export async function processCampaignQueue(prisma: PrismaClient, campaignId: string) {
  const seed = await prisma.campaign.findFirst({ where: { id: campaignId }, select: { tenantId: true, parsedCommandJson: true } });
  if (seed) {
    if (campaignSenderId(seed)) await reconcileDirectCampaign(prisma, seed.tenantId, campaignId);
    else await reconcileLegacyCampaign(prisma, seed.tenantId, campaignId);
    const access = await getEntitlements(prisma, seed.tenantId);
    if (!access.snapshot.grandfathered && !access.entitlements.MASS_CAMPAIGNS) {
      await pauseUnavailableCampaigns(prisma, seed.tenantId);
      return;
    }
  }
  for (;;) {
    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId },
      include: { recipients: true },
    });
    if (!campaign || campaign.status === "paused" || campaign.status === "cancelled") return;
    if (campaign.status === "scheduled" && campaignSendLater(campaign.scheduledAt)) return;
    if (campaign.status !== "running") return;

    const batch = await prisma.campaignRecipient.findMany({
      where: { campaignId, status: campaignSenderId(campaign) ? { in: ["queued", "sending"] } : "queued" },
      take: SEND_CHUNK,
      orderBy: [{ status: "asc" }, { createdAt: "asc" }],
    });
    if (!batch.length) {
      const left = await prisma.campaignRecipient.count({ where: { campaignId, status: { in: ["queued", "sending"] } } });
      if (left) return;
      const all = await prisma.campaignRecipient.findMany({ where: { campaignId } });
      const stats = statsFromRecipients(all);
      const status =
        (stats.failed > 0 || stats.skipped > 0) && stats.sent > 0
          ? "partially_completed"
          : stats.failed > 0 && stats.sent === 0
            ? "failed"
            : stats.sent === 0 && stats.skipped > 0 ? "cancelled" : "completed";
      const finished = await prisma.campaign.updateMany({
        where: { id: campaignId, status: "running" },
        data: { status, completedAt: new Date(), statsJson: stats },
      });
      if (!finished.count) return;
      await closeCampaignScheduleTask(prisma, campaign.tenantId, campaignId, ["failed", "cancelled"].includes(status) ? "canceled" : "done", status);
      return;
    }

    const attachments = await campaignAttachments(prisma, campaign.tenantId, campaignId);
    for (const recipient of batch) {
      const fresh = await prisma.campaign.findFirst({ where: { id: campaignId } });
      if (!fresh || fresh.status === "paused" || fresh.status === "cancelled") return;
      try {
        await ensureMassCampaignAccess(prisma, campaign.tenantId);
        await consumeResource(prisma, campaign.tenantId, "CAMPAIGN_RECIPIENTS", 1, `campaign-recipient:${recipient.id}`);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 403) throw error;
        await prisma.campaign.update({ where: { id: campaignId }, data: {
          status: "paused", statsJson: { ...statsFromRecipients(campaign.recipients), billingPauseReason: error.message },
        } });
        return;
      }
      await sendOneRecipient(prisma, campaign, recipient, attachments);
      await new Promise((r) => setTimeout(r, SEND_DELAY_MS));
    }
    // Direct delivery is durable and asynchronous. The next worker tick reconciles
    // its result; re-entering this loop would spin while QR messages are queued.
    if (campaignSenderId(campaign)) return;
  }
}

async function ensureContactForRecipient(
  prisma: PrismaClient,
  campaign: { tenantId: string; createMissingClients: boolean; createdByMembershipId: string | null },
  recipient: { id: string; contactId: string | null; phoneRaw: string | null; phoneNormalized: string | null; displayName: string | null },
  defaultRegion = "KZ",
) {
  if (recipient.contactId) return recipient.contactId;
  if (!campaign.createMissingClients) return null;
  const phoneInput = recipient.phoneRaw || (recipient.phoneNormalized ? `+${recipient.phoneNormalized}` : "");
  if (!phoneInput) return null;
  const phone = validateClientPhone(phoneInput, defaultRegion);
  if (!phone.ok) throw new Error(phone.message);

  return prisma.$transaction(async tx => {
    // Replaying a queue tick must not create a second contact/conversation for a
    // recipient imported by phone, even if another worker already loaded it.
    await tx.$queryRaw`SELECT id FROM "CampaignRecipient" WHERE id = ${recipient.id} AND "tenantId" = ${campaign.tenantId} FOR UPDATE`;
    const current = await tx.campaignRecipient.findFirstOrThrow({ where: { id: recipient.id, tenantId: campaign.tenantId } });
    if (current.contactId) return current.contactId;
    const existing = await tx.contactMethod.findFirst({
      where: { tenantId: campaign.tenantId, type: { in: ["phone", "whatsapp"] }, normalizedValue: phone.normalized },
    });
    if (existing) {
      await tx.campaignRecipient.update({ where: { id: recipient.id }, data: { contactId: existing.contactId } });
      return existing.contactId;
    }

    const created = await tx.contact.create({
      data: {
        tenantId: campaign.tenantId,
        name: recipient.displayName || `Клиент ${phone.raw}`,
        language: "ru",
        lifecycleStatus: "new",
        ownerMembershipId: campaign.createdByMembershipId,
        lastContactAt: new Date(),
        attributionJson: { sourceType: "manual_bulk_import", source: "manual_bulk_import" },
        methods: {
          create: {
            type: "phone",
            rawValue: phone.raw,
            normalizedValue: phone.normalized,
            source: "manual_bulk_import",
            primary: true,
            confirmed: false,
          },
        },
      },
    });
    await writeActivity(tx, {
      tenantId: campaign.tenantId,
      contactId: created.id,
      type: "contact.created",
      title: "Создан клиент",
      description: "Источник: массовый импорт номеров",
      actorType: "system",
      metadata: { source: "manual_bulk_import", campaignId: true },
    });
    await tx.campaignRecipient.update({ where: { id: recipient.id }, data: { contactId: created.id } });
    return created.id;
  });
}

async function sendOneRecipient(
  prisma: PrismaClient,
  campaign: {
    id: string;
    tenantId: string;
    messageSnapshot: string | null;
    messageDraft: string | null;
    personalizeEach?: boolean | null;
    createMissingClients: boolean;
    createdByMembershipId: string | null;
    confirmedById?: string | null;
    parsedCommandJson?: unknown;
    title: string;
  },
  recipient: {
    id: string;
    contactId: string | null;
    phoneRaw: string | null;
    phoneNormalized: string | null;
    displayName: string | null;
    messageDraft?: string | null;
  },
  attachments: Array<{ id: string; fileName: string; mimeType: string; storageKey: string; documentType: string }>,
) {
  const claimed = campaignSenderId(campaign)
    ? (await prisma.campaignRecipient.updateMany({ where: { id: recipient.id, tenantId: campaign.tenantId,
      campaignId: campaign.id, status: { in: ["queued", "sending"] }, campaign: { status: "running" } }, data: { status: "sending" } })).count > 0
    : await claimLegacyRecipient(prisma, campaign.tenantId, campaign.id, recipient.id);
  if (!claimed) return;
  try {
    const contactId = await ensureContactForRecipient(prisma, campaign, recipient);
    if (!contactId) throw new Error("Нет клиента для отправки");

    const contact = await prisma.contact.findFirst({ where: { id: contactId, tenantId: campaign.tenantId } });
    const inquiry = await prisma.inquiry.findFirst({
      where: { tenantId: campaign.tenantId, contactId, archived: false },
      orderBy: { receivedAt: "desc" },
      select: { subject: true, service: true, description: true, companyName: true, aiSummary: true },
    });
    const text = resolveRecipientSendText({
      personalizeEach: campaign.personalizeEach,
      recipientDraft: recipient.messageDraft,
      campaignSnapshot: campaign.messageSnapshot,
      campaignDraft: campaign.messageDraft,
      firstName: pickPersonFirstName(contact?.firstName, contact?.name, recipient.displayName),
      companyName: (!isGenericCompanyName(inquiry?.companyName) && inquiry?.companyName) || contact?.companyName,
      interest: inquiryRequestText(inquiry),
    });

    if (campaignSenderId(campaign)) {
      await queueDirectCampaignRecipient(prisma, campaign, { ...recipient, contactId }, text, attachments);
      await reconcileDirectCampaign(prisma, campaign.tenantId, campaign.id);
      return;
    }

    const previous = await prisma.outboundOperation.findUnique({ where: { tenantId_idempotencyKey: {
      tenantId: campaign.tenantId, idempotencyKey: legacyCampaignKey(campaign.id, recipient.id),
    } } });
    // Continue the immutable recipient snapshot, including its approved text.
    // New contact activity must not silently re-personalize a partial send.
    if (previous) { await deliverLegacyMessage(prisma, campaign.tenantId, previous.id); return; }
    const conversation = await resolveWhatsAppConversation(prisma, {
        tenantId: campaign.tenantId, contactId, defaultRegion: "KZ", contactName: recipient.displayName, healFromBot: true,
      });
    if (!conversation?.sellerLeadId) throw new Error("Нет подключённого WhatsApp-диалога клиента. Проверьте подключение.");
    if (!campaign.confirmedById) throw new Error("Сначала подтвердите рассылку");
    const operation = await prepareLegacyMessage(prisma, { tenantId: campaign.tenantId, conversationId: conversation.id,
      actorUserId: campaign.confirmedById, key: legacyCampaignKey(campaign.id, recipient.id), text,
      sourceAttachmentIds: attachments.map(file => file.id), campaign: { id: campaign.id, recipientId: recipient.id } });
    await deliverLegacyMessage(prisma, campaign.tenantId, operation.id);
  } catch (error) {
    // A direct transport may have accepted a message before its response was lost.
    if (campaignSenderId(campaign)) {
      await reconcileDirectCampaign(prisma, campaign.tenantId, campaign.id);
      const current = await prisma.campaignRecipient.findUnique({ where: { id: recipient.id } });
      if (current?.status !== "sending") return;
      if (current.conversationId && await prisma.outboundOperation.count({ where: {
        tenantId: campaign.tenantId,
        idempotencyKey: `whatsapp:${current.conversationId}:campaign:${campaign.id}:recipient:${recipient.id}`,
      } })) return;
    }
    if (!campaignSenderId(campaign)) {
      const operation = await prisma.outboundOperation.findUnique({ where: { tenantId_idempotencyKey: {
        tenantId: campaign.tenantId, idempotencyKey: legacyCampaignKey(campaign.id, recipient.id),
      } } });
      if (operation) { await recoverLegacyMessage(prisma, campaign.tenantId, operation.id); return; }
    }
    await prisma.campaignRecipient.update({
      where: { id: recipient.id },
      data: {
        status: "failed",
        ...(!campaignSenderId(campaign) ? { textSendState: "not_sent" } : {}),
        error: error instanceof Error && /Green API HTTP 401/.test(error.message)
          ? "Green API отклонил авторизацию (401). Проверьте подключение WhatsApp или выберите подключённый номер через QR."
          : error instanceof Error ? error.message : "Ошибка отправки",
      },
    });
  }
}

async function loadRecipientOfferFacts(
  prisma: PrismaClient,
  tenantId: string,
  recipients: Array<{ id: string; contactId: string | null; displayName: string | null }>,
) {
  const contactIds = recipients.map((row) => row.contactId).filter((id): id is string => Boolean(id));
  const contacts = contactIds.length
    ? await prisma.contact.findMany({
        where: { tenantId, id: { in: contactIds } },
        select: {
          id: true,
          name: true,
          firstName: true,
          companyName: true,
          inquiries: {
            where: { archived: false },
            orderBy: { receivedAt: "desc" },
            take: 1,
            select: { subject: true, service: true, description: true, companyName: true, aiSummary: true },
          },
        },
      })
    : [];
  const contactMap = new Map(contacts.map((row) => [row.id, row]));
  const conversationInterests = await loadConversationInterests(prisma, tenantId, contactIds);
  return recipients.map((recipient) => {
    const contact = recipient.contactId ? contactMap.get(recipient.contactId) : undefined;
    const inquiry = contact?.inquiries[0];
    const conversation = recipient.contactId ? conversationInterests.get(recipient.contactId) : undefined;
    const inquiryCompany = String(inquiry?.companyName || "").trim();
    return {
      id: recipient.id,
      firstName: pickPersonFirstName(contact?.firstName, contact?.name, recipient.displayName),
      companyName:
        (inquiryCompany && !isGenericCompanyName(inquiryCompany) ? inquiryCompany : null) ||
        (contact?.companyName && !isGenericCompanyName(contact.companyName) ? contact.companyName : null),
      interest: pickUsableInterest(conversation?.text, inquiryRequestText(inquiry)),
    };
  });
}

export async function personalizeCampaignRecipients(
  prisma: PrismaClient,
  auth: AuthContext,
  id: string,
  input: { useLlm?: boolean } = {},
) {
  const membership = requireTenant(auth);
  const campaign = await prisma.campaign.findFirst({
    where: { id, tenantId: membership.tenantId },
    include: { recipients: { orderBy: { createdAt: "asc" } } },
  });
  if (!campaign) throw new ApiError(404, "not_found", "Рассылка не найдена");
  if (["running", "completed", "cancelled"].includes(campaign.status)) {
    throw new ApiError(409, "locked", "Рассылку в этом статусе нельзя менять");
  }

  const pending = campaign.recipients.filter((row) => row.status === "pending");
  if (!pending.length) throw new ApiError(422, "invalid", "Нет получателей для персонализации");

  const attachments = await campaignAttachments(prisma, membership.tenantId, id);
  const hasFile = attachments.length > 0;
  const sharedRaw = String(campaign.messageDraft || "").trim();
  const commandFromDraft = looksLikeStaffCommand(sharedRaw);
  const taskText =
    [campaign.rawCommandText, commandFromDraft ? sharedRaw : ""]
      .map((value) => String(value || "").trim())
      .filter((value, index, all) => value && all.indexOf(value) === index)
      .join("\n") || String(campaign.title || "").trim();
  const sharedDraft = commandFromDraft ? "" : sharedRaw;
  const facts = await loadRecipientOfferFacts(prisma, membership.tenantId, pending);
  const kind = inferCampaignOfferKind(taskText, sharedDraft);
  const clientAsk = clientFacingAskFromTask(taskText);
  let drafts = facts.map((fact) => ({
    id: fact.id,
    text: composeRecipientOffer({
      taskText,
      sharedDraft,
      firstName: fact.firstName,
      companyName: fact.companyName,
      interest: fact.interest,
      hasFile,
    }),
  }));

  if (input.useLlm !== false) {
    const refined = await refineCampaignRecipientDraftsWithLlm({
      taskText,
      clientAsk,
      kind,
      hasFile,
      prisma,
      tenantId: membership.tenantId,
      recipients: drafts.map((row) => {
        const fact = facts.find((item) => item.id === row.id);
        return {
          id: row.id,
          firstName: fact?.firstName || null,
          companyName: fact?.companyName || null,
          interest: fact?.interest || null,
          draft: row.text,
        };
      }),
    });
    if (refined?.length) {
      const byId = new Map(refined.map((row) => [row.id, row.text]));
      drafts = drafts.map((row) => {
        const next = byId.get(row.id);
        if (!next) return row;
        const fact = facts.find((item) => item.id === row.id);
        if (!acceptPersonalizedDraft({ taskText, firstName: fact?.firstName, draft: next })) return row;
        return { id: row.id, text: next };
      });
    }
  }

  for (const row of drafts) {
    await prisma.campaignRecipient.update({
      where: { id: row.id },
      data: { messageDraft: row.text },
    });
  }

  await prisma.campaign.update({
    where: { id },
    data: {
      personalizeEach: true,
      confirmedAt: null,
      confirmedById: null,
      contentHash: null,
      messageSnapshot: null,
      status: campaign.confirmedAt ? "draft" : campaign.status,
      parsedCommandJson: {
        ...(typeof campaign.parsedCommandJson === "object" && campaign.parsedCommandJson
          ? (campaign.parsedCommandJson as object)
          : {}),
        personalizeEach: true,
        offerKind: kind,
        personalizedAt: new Date().toISOString(),
        personalizedCount: drafts.length,
      } as Prisma.InputJsonValue,
    },
  });

  return getCampaign(prisma, auth, id);
}

export async function draftCampaignMessage(goal: string, hasFile: boolean) {
  const kind = inferCampaignOfferKind(goal);
  const spoken = extractSpokenMessage(goal);
  const fileBit = hasFile ? " Во вложении — материалы." : "";
  if (spoken) {
    return { messageDraft: `{{firstName}}, добрый день! ${spoken}${fileBit}`.replace(/\s{2,}/g, " ").trim(), mode: "ai" as const };
  }
  const ask = clientFacingAskFromTask(goal);
  if (ask) {
    return { messageDraft: `{{firstName}}, добрый день! ${ask}${fileBit}`.replace(/\s{2,}/g, " ").trim(), mode: "ai" as const };
  }
  const base =
    kind === "proposal"
      ? `{{firstName}}, добрый день! По запросу {{service}} направляем коммерческое предложение.${fileBit} Если актуально, напишите — уточним детали.`
      : kind === "documents"
        ? `{{firstName}}, добрый день! Направляем документы.${fileBit} Если нужно что-то ещё — напишите.`
        : kind === "follow_up"
          ? `{{firstName}}, добрый день! Хотели уточнить, актуальна ли ещё ваша заявка.${fileBit}`
          : `{{firstName}}, добрый день! ${goal.replace(/\s+/g, " ").trim()}${fileBit}`;
  return { messageDraft: base.replace(/\s{2,}/g, " ").trim(), mode: "ai" as const };
}

export type { PhoneListItem };
