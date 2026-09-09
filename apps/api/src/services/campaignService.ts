import { createHash, randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateClientPhone } from "@creolab/contracts";
import type { Prisma, PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import { fileStorageStatus, resolveUploadPath } from "../lib/storage.ts";
import type { AuthContext } from "../lib/types.ts";
import {
  acceptPersonalizedDraft,
  campaignTaskDedupeKey,
  clientAskFromStaffTask,
  composeRecipientOffer,
  inferCampaignOfferKind,
  looksLikeStaffCommand,
  personalize,
  pickPersonFirstName,
  recipientDraftsFingerprint,
  resolveRecipientSendText,
} from "./campaignPersonalize.ts";
import { extractSpokenMessage } from "./spokenMessage.ts";
import { inquiryInterest, loadConversationInterests, pickUsableInterest } from "./contactInterestService.ts";
import { writeActivity } from "./contactService.ts";
import { refineCampaignRecipientDraftsWithLlm } from "./llmClient.ts";
import { hashExecutionContent, sendViaProvider } from "./messagingProvider.ts";
import { parseAndMatchPhoneList, type PhoneListItem } from "./phoneListService.ts";
import { previewContactSegment } from "./segmentService.ts";
import { resolveSellerBridge, resolveWhatsAppConversation } from "./sellerLink.ts";

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
const MAX_RECIPIENTS = 500;
const SEND_CHUNK = 5;
const SEND_DELAY_MS = 400;

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership;
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
  campaign: { messageSnapshot?: string | null; messageDraft?: string | null; personalizeEach?: boolean | null },
  recipients: Array<{ id: string; status: string; messageDraft?: string | null }>,
  attachments: unknown[],
) {
  const fingerprint = campaign.personalizeEach ? recipientDraftsFingerprint(recipients) : "";
  return contentHash(campaign.messageSnapshot || campaign.messageDraft, attachments, fingerprint);
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
    failed: count("failed"),
    skipped: count("skipped") + count("cancelled"),
    delivered: count("delivered") + count("read") + count("replied"),
    read: count("read") + count("replied"),
    replied: count("replied"),
  };
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
  },
) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
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
      const phone = contact.methods.find((m) => m.type === "phone" && m.primary) || contact.methods.find((m) => m.type === "phone");
      recipients.push({
        contactId: contact.id,
        phoneRaw: phone?.rawValue || null,
        phoneNormalized: phone?.normalizedValue || null,
        displayName: contact.name || null,
        status: phone ? "pending" : "skipped",
        skipReason: phone ? null : "Нет доступного номера",
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
  return {
    ...campaign,
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
  });
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
  await unlink(abs).catch(() => {});
  await prisma.attachment.delete({ where: { id: attachmentId } });
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { confirmedAt: null, confirmedById: null, contentHash: null, status: "draft" },
  });
  return { ok: true };
}

export async function prepareCampaign(prisma: PrismaClient, auth: AuthContext, id: string) {
  const data = await getCampaign(prisma, auth, id);
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
  if (input.scheduledAt !== undefined) {
    await prisma.campaign.update({
      where: { id },
      data: { scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null },
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

  const updated = await prisma.campaign.update({
    where: { id },
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
      campaign: { ...campaign, scheduledAt: campaign.scheduledAt, status: "scheduled" },
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
  const campaign = await prisma.campaign.findFirst({ where: { id, tenantId: membership.tenantId } });
  if (!campaign) throw new ApiError(404, "not_found", "Рассылка не найдена");
  if (!campaign.confirmedAt || !campaign.contentHash) {
    throw new ApiError(409, "needs_confirmation", "Сначала подтвердите рассылку");
  }
  if (campaignSendLater(campaign.scheduledAt)) {
    throw new ApiError(409, "scheduled", "Рассылка запланирована на будущее");
  }
  const attachments = await campaignAttachments(prisma, membership.tenantId, id);
  const recipients = await prisma.campaignRecipient.findMany({ where: { campaignId: id, tenantId: membership.tenantId } });
  const hash = campaignHashInput(campaign, recipients, campaign.attachmentSnapshotsJson as unknown[]);
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

  await prisma.campaign.update({
    where: { id },
    data: { status: "running", startedAt: new Date(), pausedAt: null },
  });
  await prisma.campaignRecipient.updateMany({
    where: { campaignId: id, tenantId: membership.tenantId, status: "pending" },
    data: { status: "queued" },
  });

  // fire-and-forget processing (also picked up by worker)
  void processCampaignQueue(prisma, id).catch((err) => console.error("campaign", id, err));

  return getCampaign(prisma, auth, id);
}

export async function pauseCampaign(prisma: PrismaClient, auth: AuthContext, id: string) {
  const membership = requireTenant(auth);
  const campaign = await prisma.campaign.findFirst({ where: { id, tenantId: membership.tenantId } });
  if (!campaign) throw new ApiError(404, "not_found", "Рассылка не найдена");
  await prisma.campaign.update({ where: { id }, data: { status: "paused", pausedAt: new Date() } });
  return getCampaign(prisma, auth, id);
}

export async function cancelCampaignRemainder(prisma: PrismaClient, auth: AuthContext, id: string) {
  const membership = requireTenant(auth);
  await prisma.campaignRecipient.updateMany({
    where: { campaignId: id, tenantId: membership.tenantId, status: { in: ["pending", "queued"] } },
    data: { status: "cancelled", skipReason: "Отменено пользователем" },
  });
  await prisma.campaign.update({ where: { id }, data: { status: "cancelled", completedAt: new Date() } });
  await closeCampaignScheduleTask(prisma, membership.tenantId, id, "canceled");
  return getCampaign(prisma, auth, id);
}

export async function retryFailedCampaign(prisma: PrismaClient, auth: AuthContext, id: string) {
  const membership = requireTenant(auth);
  await prisma.campaignRecipient.updateMany({
    where: { campaignId: id, tenantId: membership.tenantId, status: "failed" },
    data: { status: "queued", error: null },
  });
  await prisma.campaign.update({ where: { id }, data: { status: "running", pausedAt: null, completedAt: null } });
  void processCampaignQueue(prisma, id).catch((err) => console.error("campaign retry", id, err));
  return getCampaign(prisma, auth, id);
}

export async function processCampaignQueue(prisma: PrismaClient, campaignId: string) {
  for (;;) {
    const campaign = await prisma.campaign.findFirst({
      where: { id: campaignId },
      include: { recipients: true },
    });
    if (!campaign || campaign.status === "paused" || campaign.status === "cancelled") return;
    if (campaign.status === "scheduled" && campaignSendLater(campaign.scheduledAt)) return;
    if (campaign.status !== "running") return;

    const batch = await prisma.campaignRecipient.findMany({
      where: { campaignId, status: "queued" },
      take: SEND_CHUNK,
      orderBy: { createdAt: "asc" },
    });
    if (!batch.length) {
      const left = await prisma.campaignRecipient.count({ where: { campaignId, status: { in: ["queued", "sending"] } } });
      if (left) return;
      const all = await prisma.campaignRecipient.findMany({ where: { campaignId } });
      const stats = statsFromRecipients(all);
      const status =
        stats.failed > 0 && stats.sent > 0
          ? "partially_completed"
          : stats.failed > 0 && stats.sent === 0
            ? "failed"
            : "completed";
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { status, completedAt: new Date(), statsJson: stats },
      });
      await closeCampaignScheduleTask(prisma, campaign.tenantId, campaignId, status === "failed" ? "canceled" : "done", status);
      return;
    }

    const attachments = await campaignAttachments(prisma, campaign.tenantId, campaignId);
    for (const recipient of batch) {
      const fresh = await prisma.campaign.findFirst({ where: { id: campaignId } });
      if (!fresh || fresh.status === "paused" || fresh.status === "cancelled") return;
      await sendOneRecipient(prisma, campaign, recipient, attachments);
      await new Promise((r) => setTimeout(r, SEND_DELAY_MS));
    }
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

  const existing = await prisma.contactMethod.findFirst({
    where: { tenantId: campaign.tenantId, type: "phone", normalizedValue: phone.normalized },
  });
  if (existing) {
    await prisma.campaignRecipient.update({ where: { id: recipient.id }, data: { contactId: existing.contactId } });
    return existing.contactId;
  }

  const created = await prisma.contact.create({
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
  await writeActivity(prisma, {
    tenantId: campaign.tenantId,
    contactId: created.id,
    type: "contact.created",
    title: "Создан клиент",
    description: "Источник: массовый импорт номеров",
    actorType: "system",
    metadata: { source: "manual_bulk_import", campaignId: true },
  });
  await prisma.campaignRecipient.update({ where: { id: recipient.id }, data: { contactId: created.id } });
  return created.id;
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
  await prisma.campaignRecipient.update({ where: { id: recipient.id }, data: { status: "sending" } });
  try {
    const contactId = await ensureContactForRecipient(prisma, campaign, recipient);
    if (!contactId) throw new Error("Нет клиента для отправки");

    const conversation = await resolveWhatsAppConversation(prisma, {
      tenantId: campaign.tenantId,
      contactId,
      defaultRegion: "KZ",
      contactName: recipient.displayName,
      healFromBot: true,
    });
    if (!conversation?.sellerLeadId) {
      throw new Error("Нет WhatsApp-диалога (sellerLead). Сначала синхронизируйте лиды или напишите клиенту через бота.");
    }

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { mode: "human", needsAttention: true, attentionReason: "taken_by_human" },
    });
    try {
      const resolved = await resolveSellerBridge(prisma, campaign.tenantId);
      if (resolved.bridge) await resolved.bridge.setMode(conversation.sellerLeadId, "HUMAN");
    } catch {
      // send still proceeds; bot may stay on AI until next sync
    }

    const contact = await prisma.contact.findFirst({ where: { id: contactId, tenantId: campaign.tenantId } });
    const inquiry = await prisma.inquiry.findFirst({
      where: { tenantId: campaign.tenantId, contactId, archived: false },
      orderBy: { receivedAt: "desc" },
      select: { subject: true, service: true },
    });
    const text = resolveRecipientSendText({
      personalizeEach: campaign.personalizeEach,
      recipientDraft: recipient.messageDraft,
      campaignSnapshot: campaign.messageSnapshot,
      campaignDraft: campaign.messageDraft,
      firstName: pickPersonFirstName(contact?.firstName, contact?.name, recipient.displayName),
      companyName: contact?.companyName,
      interest: inquiryInterest(inquiry)?.text || null,
    });

    if (text) {
      await sendViaProvider(prisma, campaign.tenantId, {
        sellerLeadId: conversation.sellerLeadId,
        text,
        idempotencyKey: `campaign:${campaign.id}:recipient:${recipient.id}:text`,
      });
      await prisma.campaignRecipient.update({ where: { id: recipient.id }, data: { textSendState: "sent" } });
    }

    let filesOk = true;
    for (const file of attachments) {
      try {
        const result = await sendViaProvider(prisma, campaign.tenantId, {
          sellerLeadId: conversation.sellerLeadId,
          file: {
            fileName: file.fileName,
            mimeType: file.mimeType,
            filePath: resolveUploadPath(file.storageKey),
            caption: file.documentType === "proposal" ? text || undefined : undefined,
          },
          idempotencyKey: `campaign:${campaign.id}:recipient:${recipient.id}:file:${file.id}`,
        });
        await prisma.attachment.update({
          where: { id: file.id },
          data: { sendState: "sent", providerMessageId: result.providerMessageId },
        });
      } catch (err) {
        filesOk = false;
        await prisma.attachment.update({
          where: { id: file.id },
          data: { sendState: "failed", sendError: err instanceof Error ? err.message : "Ошибка" },
        });
      }
    }

    if (attachments.length && !filesOk) {
      await prisma.campaignRecipient.update({
        where: { id: recipient.id },
        data: { status: "failed", filesSendState: "failed", error: "Не все вложения отправлены", conversationId: conversation.id },
      });
      return;
    }

    await prisma.campaignRecipient.update({
      where: { id: recipient.id },
      data: {
        status: "sent",
        filesSendState: attachments.length ? "sent" : "none",
        sentAt: new Date(),
        conversationId: conversation.id,
        contactId,
      },
    });

    await writeActivity(prisma, {
      tenantId: campaign.tenantId,
      contactId,
      type: "campaign.sent",
      title: "Получено массовое сообщение",
      description: `Campaign: «${campaign.title}»`,
      actorType: "system",
      metadata: { campaignId: campaign.id, recipientId: recipient.id },
    });
  } catch (error) {
    await prisma.campaignRecipient.update({
      where: { id: recipient.id },
      data: {
        status: "failed",
        error: error instanceof Error ? error.message : "Ошибка отправки",
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
            select: { subject: true, service: true },
          },
        },
      })
    : [];
  const contactMap = new Map(contacts.map((row) => [row.id, row]));
  const conversationInterests = await loadConversationInterests(prisma, tenantId, contactIds);
  return recipients.map((recipient) => {
    const contact = recipient.contactId ? contactMap.get(recipient.contactId) : undefined;
    const inquiry = contact?.inquiries[0];
    const service = String(inquiry?.service || "").trim();
    const subject = String(inquiry?.subject || "").trim();
    const conversation = recipient.contactId ? conversationInterests.get(recipient.contactId) : undefined;
    return {
      id: recipient.id,
      firstName: pickPersonFirstName(contact?.firstName, contact?.name, recipient.displayName),
      companyName: contact?.companyName || null,
      interest: pickUsableInterest(conversation?.text, service, subject, inquiryInterest(inquiry)?.text),
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
  const clientAsk = clientAskFromStaffTask(taskText);
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
  const ask = clientAskFromStaffTask(goal);
  if (ask) {
    return { messageDraft: `{{firstName}}, добрый день! ${ask}${fileBit}`.replace(/\s{2,}/g, " ").trim(), mode: "ai" as const };
  }
  const base =
    kind === "proposal"
      ? `{{firstName}}, добрый день! По запросу {{service}} направляем коммерческое предложение.${fileBit} Если актуально, напишите — уточним детали.`
      : kind === "documents"
        ? `{{firstName}}, добрый день! Направляем документы.${fileBit} Если нужно что-то ещё — напишите.`
        : kind === "follow_up"
          ? "{{firstName}}, добрый день! Хотели уточнить, актуальна ли ещё ваша задача." +
            fileBit +
            " Можем подсказать по следующим шагам."
          : `{{firstName}}, добрый день! ${goal.replace(/\s+/g, " ").trim()}${fileBit}`;
  return { messageDraft: base.replace(/\s{2,}/g, " ").trim(), mode: "ai" as const };
}

export type { PhoneListItem };
