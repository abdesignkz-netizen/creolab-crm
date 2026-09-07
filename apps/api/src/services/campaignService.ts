import { createHash, randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateClientPhone } from "@creolab/contracts";
import type { Prisma, PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import { fileStorageStatus, resolveUploadPath } from "../lib/storage.ts";
import type { AuthContext } from "../lib/types.ts";
import { writeActivity } from "./contactService.ts";
import { hashExecutionContent, sendViaProvider } from "./messagingProvider.ts";
import { parseAndMatchPhoneList, type PhoneListItem } from "./phoneListService.ts";
import { previewContactSegment } from "./segmentService.ts";
import { resolveSellerBridge } from "./sellerLink.ts";

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

function personalize(template: string, vars: { firstName?: string | null; companyName?: string | null; service?: string | null; managerName?: string | null }) {
  let text = template;
  const firstName = String(vars.firstName || "").trim();
  if (/\{\{\s*firstName\s*\}\}/i.test(text)) {
    text = text.replace(/\{\{\s*firstName\s*\}\}\s*,?\s*/gi, firstName ? `${firstName}, ` : "");
  }
  text = text
    .replace(/\{\{\s*companyName\s*\}\}/gi, vars.companyName || "")
    .replace(/\{\{\s*service\s*\}\}/gi, vars.service || "")
    .replace(/\{\{\s*managerName\s*\}\}/gi, vars.managerName || "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (/^,?\s*добрый день/i.test(text)) text = text.replace(/^,?\s*/, "");
  if (!text) text = "Добрый день!";
  return text;
}

function contentHash(message: string | null, attachments: unknown[]) {
  return hashExecutionContent({ message: message || "", attachments });
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
  const previews = buildPersonalizationPreviews(campaign.messageDraft, campaign.recipients);
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

function buildPersonalizationPreviews(template: string | null, recipients: Array<{ displayName: string | null; status: string }>) {
  if (!template) return [];
  const samples = recipients.filter((r) => r.status === "pending").slice(0, 2);
  const list = [
    ...samples.map((r) => ({
      label: r.displayName || "Контакт",
      text: personalize(template, { firstName: (r.displayName || "").split(/\s+/)[0] || null }),
    })),
    { label: "Неизвестный контакт", text: personalize(template, { firstName: null }) },
  ];
  return list;
}

export async function updateCampaign(
  prisma: PrismaClient,
  auth: AuthContext,
  id: string,
  input: {
    title?: string;
    messageDraft?: string | null;
    messageMode?: string;
    createMissingClients?: boolean;
    scheduledAt?: string | null;
    recipientIdsInclude?: string[];
    recipientIdsExclude?: string[];
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

  const updated = await prisma.campaign.update({
    where: { id },
    data: {
      title: input.title ?? undefined,
      messageDraft: input.messageDraft === undefined ? undefined : input.messageDraft,
      messageMode: input.messageMode ?? undefined,
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
  if (data.messageMode !== "file_only" && !String(data.messageDraft || "").trim() && data.attachments.length === 0) {
    throw new ApiError(422, "invalid", "Укажите текст или прикрепите файл");
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

  await prisma.campaign.update({
    where: { id },
    data: { status: "ready" },
  });

  return {
    title: "Проверьте рассылку",
    action: data.messageMode === "file_only" ? "Отправить файл" : "Отправить сообщение" + (data.attachments.length ? " и вложения" : ""),
    recipients: pending.length,
    foundInCrm: pending.filter((r) => r.contactId).length,
    newContacts: pending.filter((r) => !r.contactId).length,
    excluded: data.recipients.filter((r) => r.status === "skipped").length,
    channel: data.channel,
    message: data.messageDraft,
    attachments: data.attachments.map((a) => ({
      id: a.id,
      fileName: a.fileName,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      documentType: a.documentType,
    })),
    when: data.scheduledAt ? data.scheduledAt.toISOString() : "Сейчас",
    personalizationPreviews: data.personalizationPreviews,
    createMissingClients: data.createMissingClients,
    buttons: {
      confirm: `Подтвердить и отправить ${pending.length} контактам`,
      back: "Вернуться и изменить",
    },
    recipientsPreview: pending.slice(0, 50).map((r) => ({
      id: r.id,
      name: r.displayName,
      phone: r.phoneRaw,
      contactId: r.contactId,
      status: r.status,
    })),
    excludedPreview: data.recipients
      .filter((r) => r.status === "skipped")
      .slice(0, 50)
      .map((r) => ({ id: r.id, name: r.displayName, phone: r.phoneRaw, reason: r.skipReason })),
  };
}

export async function confirmCampaign(prisma: PrismaClient, auth: AuthContext, id: string) {
  const membership = requireTenant(auth);
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
  }));
  const hash = contentHash(campaign.messageDraft, attachmentSnapshots);
  const status = campaign.scheduledAt && campaign.scheduledAt.getTime() > Date.now() ? "scheduled" : "awaiting_confirmation";

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

  if (status === "scheduled") {
    await prisma.scheduledAction.create({
      data: {
        tenantId: membership.tenantId,
        type: "campaign_run",
        parentType: "campaign",
        parentId: id,
        dueAt: campaign.scheduledAt!,
        state: "scheduled",
        payloadJson: { campaignId: id },
      },
    });
  }

  return { campaign: updated, preview: prepared };
}

export async function startCampaign(prisma: PrismaClient, auth: AuthContext, id: string) {
  const membership = requireTenant(auth);
  const campaign = await prisma.campaign.findFirst({ where: { id, tenantId: membership.tenantId } });
  if (!campaign) throw new ApiError(404, "not_found", "Рассылка не найдена");
  if (!campaign.confirmedAt || !campaign.contentHash) {
    throw new ApiError(409, "needs_confirmation", "Сначала подтвердите рассылку");
  }
  if (campaign.scheduledAt && campaign.scheduledAt.getTime() > Date.now()) {
    throw new ApiError(409, "scheduled", "Рассылка запланирована на будущее");
  }
  const attachments = await campaignAttachments(prisma, membership.tenantId, id);
  const hash = contentHash(campaign.messageSnapshot || campaign.messageDraft, campaign.attachmentSnapshotsJson as unknown[]);
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
    if (campaign.status !== "running") {
      await prisma.campaign.update({ where: { id: campaignId }, data: { status: "running", startedAt: campaign.startedAt || new Date() } });
    }

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
  },
  attachments: Array<{ id: string; fileName: string; mimeType: string; storageKey: string; documentType: string }>,
) {
  await prisma.campaignRecipient.update({ where: { id: recipient.id }, data: { status: "sending" } });
  try {
    const contactId = await ensureContactForRecipient(prisma, campaign, recipient);
    if (!contactId) throw new Error("Нет клиента для отправки");

    let conversation = await prisma.conversation.findFirst({
      where: { tenantId: campaign.tenantId, contactId, sellerLeadId: { not: null } },
      orderBy: { updatedAt: "desc" },
    });
    if (!conversation?.sellerLeadId) {
      // try any conversation
      conversation = await prisma.conversation.findFirst({
        where: { tenantId: campaign.tenantId, contactId },
        orderBy: { updatedAt: "desc" },
      });
    }
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
    const template = campaign.messageSnapshot || campaign.messageDraft || "";
    const text = template
      ? personalize(template, {
          firstName: (contact?.firstName || contact?.name || recipient.displayName || "").split(/\s+/)[0] || null,
          companyName: contact?.companyName,
        })
      : "";

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

export async function draftCampaignMessage(goal: string, hasFile: boolean) {
  const base = hasFile
    ? "{{firstName}}, добрый день! Направляем информацию. Во вложении — материалы. Если задача актуальна, напишите — уточним детали."
    : "{{firstName}}, добрый день! Хотели уточнить, актуальна ли ещё ваша задача. Можем подсказать по следующим шагам.";
  // keep business meaning fixed; no invented discounts/prices
  void goal;
  return { messageDraft: base, mode: "ai" as const };
}

export type { PhoneListItem };
