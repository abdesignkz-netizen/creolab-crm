import { CALLS_ENABLED } from "../lib/featureFlags.ts";
import type { PrismaClient } from "@creolab/db";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "../errors.ts";
import { resolveUploadPath } from "../lib/storage.ts";
import type { AuthContext } from "../lib/types.ts";
import { writeActivity } from "./contactService.ts";
import { displayName, formatWhen } from "./contactLabels.ts";
import { hashExecutionContent, sendViaProvider } from "./messagingProvider.ts";
import { analyzeTaskResultNextActions, MEETING_RESULTS } from "./taskResultAnalysisService.ts";
import { syncAgreementToCalendar } from "./calendarAdapter.ts";
import { resolveSellerBridge, resolveWhatsAppConversation } from "./sellerLink.ts";

const SENDABLE_TYPES = new Set([
  "proposal",
  "message",
  "send_documents",
  "prepare_estimate",
  "follow_up",
  "process_inquiry",
]);

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
  "application/zip",
  "application/octet-stream",
]);

const DOC_TYPES = new Set(["proposal", "contract", "invoice", "presentation", "document", "image", "other"]);

const CALL_RESULTS = ["reached", "no_answer", "callback_later", "refused", "agreed", "other"] as const;
const PROPOSAL_RESULTS = ["sent", "waiting_reply", "needs_changes", "agreed", "refused"] as const;

function tenantId(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership.tenantId;
}

async function taskInTenant(prisma: PrismaClient, auth: AuthContext, id: string) {
  const tid = tenantId(auth);
  const task = await prisma.task.findFirst({
    where: { id, tenantId: tid },
    include: {
      contact: { include: { methods: true } },
      inquiry: true,
      deal: true,
      agreement: true,
    },
  });
  if (!task) throw new ApiError(404, "not_found", "Задача не найдена");
  return { tid, task };
}

async function listTaskAttachments(prisma: PrismaClient, tid: string, taskId: string) {
  return prisma.attachment.findMany({
    where: { tenantId: tid, parentType: "task", parentId: taskId },
    orderBy: { createdAt: "asc" },
  });
}

async function voidConfirmations(prisma: PrismaClient, tid: string, taskId: string) {
  await prisma.executionConfirmation.updateMany({
    where: { tenantId: tid, taskId, voidedAt: null },
    data: { voidedAt: new Date() },
  });
}

async function invalidateExecution(prisma: PrismaClient, tid: string, taskId: string) {
  await voidConfirmations(prisma, tid, taskId);
  await prisma.task.update({
    where: { id: taskId },
    data: { executionStatus: "prepared", confirmedAt: null },
  });
}

function primaryPhone(methods: Array<{ type: string; rawValue: string; primary: boolean }>) {
  const phones = methods.filter((item) => item.type === "phone");
  return phones.find((item) => item.primary) || phones[0] || null;
}

function rawSuggestedNextActions(taskType: string, resultCode?: string | null) {
  if (taskType === "meeting") {
    if (resultCode === "send_proposal") {
      return [{ type: "proposal", title: "Отправить КП", dueOffsetHours: 4, requiresConfirm: true }];
    }
    if (resultCode === "send_contract") {
      return [{ type: "send_documents", title: "Отправить договор", dueOffsetHours: 4, requiresConfirm: true }];
    }
    if (resultCode === "needs_estimate") {
      return [{ type: "prepare_estimate", title: "Подготовить расчёт", dueOffsetHours: 24 }];
    }
    if (resultCode === "client_thinking") {
      return [{ type: "wait_client", title: "Ждать решения клиента", dueOffsetHours: 72 }];
    }
    if (resultCode === "callback_later") {
      return [{ type: "call", title: "Перезвонить", dueOffsetHours: 24 }];
    }
    if (resultCode === "reschedule") {
      return [{ type: "meeting", title: "Перенести встречу", dueOffsetHours: 4 }];
    }
    if (resultCode === "refused") {
      return [{ type: "other", title: "Зафиксировать отказ (вручную)", dueOffsetHours: null, requiresConfirm: true }];
    }
    return [
      { type: "proposal", title: "Отправить КП", dueOffsetHours: 4, requiresConfirm: true },
      { type: "follow_up", title: "Связаться завтра", dueOffsetHours: 24 },
      { type: "wait_client", title: "Ждать клиента", dueOffsetHours: null },
    ];
  }
  if (taskType === "proposal" || taskType === "send_documents") {
    return [
      { type: "follow_up", title: "Напомнить завтра", dueOffsetHours: 24 },
      { type: "call", title: "Позвонить завтра", dueOffsetHours: 24 },
      { type: "wait_client", title: "Ждать ответа клиента", dueOffsetHours: null },
    ];
  }
  if (taskType === "call") {
    if (resultCode === "no_answer") {
      return [{ type: "call", title: "Перезвонить завтра", dueOffsetHours: 24 }];
    }
    if (resultCode === "reached" || resultCode === "agreed") {
      return [
        { type: "proposal", title: "Отправить КП", dueOffsetHours: 4, requiresConfirm: true },
        { type: "follow_up", title: "Связаться завтра", dueOffsetHours: 24 },
      ];
    }
  }
  return [
    { type: "follow_up", title: "Напомнить завтра", dueOffsetHours: 24 },
    { type: "wait_client", title: "Ждать ответа", dueOffsetHours: null },
  ];
}

function availableNextActions<T extends { type: string; title: string }>(items: T[]) {
  return items.map(item => !CALLS_ENABLED && item.type === "call"
    ? { ...item, type: "message", title: "Написать клиенту" } : item);
}
function suggestedNextActions(taskType: string, resultCode?: string | null) {
  return availableNextActions(rawSuggestedNextActions(taskType, resultCode));
}

export async function updateTaskDraft(
  prisma: PrismaClient,
  auth: AuthContext,
  id: string,
  input: {
    messageDraft?: string;
    contactId?: string;
    inquiryId?: string;
    conversationId?: string;
    dealId?: string;
    title?: string;
    description?: string;
  },
) {
  const { tid, task } = await taskInTenant(prisma, auth, id);
  if (task.status === "done" || task.status === "canceled") {
    throw new ApiError(409, "invalid_state", "Закрытую задачу нельзя менять");
  }
  const updated = await prisma.task.update({
    where: { id },
    data: {
      messageDraft: input.messageDraft !== undefined ? input.messageDraft : undefined,
      contactId: input.contactId !== undefined ? input.contactId || null : undefined,
      inquiryId: input.inquiryId !== undefined ? input.inquiryId || null : undefined,
      conversationId: input.conversationId !== undefined ? input.conversationId || null : undefined,
      dealId: input.dealId !== undefined ? input.dealId || null : undefined,
      title: input.title,
      description: input.description,
      executionStatus: task.executionStatus === "none" ? "prepared" : "prepared",
      confirmedAt: null,
    },
  });
  await voidConfirmations(prisma, tid, id);
  return updated;
}

export async function addTaskAttachment(
  prisma: PrismaClient,
  auth: AuthContext,
  id: string,
  input: {
    fileName: string;
    mimeType: string;
    contentBase64: string;
    documentType?: string;
  },
) {
  const { tid, task } = await taskInTenant(prisma, auth, id);
  if (task.status === "done" || task.status === "canceled") {
    throw new ApiError(409, "invalid_state", "Нельзя прикреплять к закрытой задаче");
  }
  const mimeType = input.mimeType || "application/octet-stream";
  if (!ALLOWED_MIME.has(mimeType) && !mimeType.startsWith("image/")) {
    throw new ApiError(422, "invalid", "Формат файла не поддерживается");
  }
  const documentType = DOC_TYPES.has(String(input.documentType || "")) ? String(input.documentType) : "document";
  const buffer = Buffer.from(input.contentBase64, "base64");
  if (!buffer.length) throw new ApiError(422, "invalid", "Пустой файл");
  if (buffer.length > 25 * 1024 * 1024) throw new ApiError(422, "invalid", "Файл больше 25 МБ");

  const safeName = input.fileName.replace(/[^\w.\-а-яА-ЯёЁ ]+/g, "_").slice(0, 180) || "file.bin";
  const attachmentId = randomUUID();
  const storageKey = path.posix.join(tid, id, `${attachmentId}-${safeName}`);
  const abs = resolveUploadPath(storageKey);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, buffer);
  const checksum = createHash("sha256").update(buffer).digest("hex");

  const attachment = await prisma.attachment.create({
    data: {
      id: attachmentId,
      tenantId: tid,
      parentType: "task",
      parentId: id,
      storageKey,
      fileName: safeName,
      originalFileName: input.fileName,
      mimeType,
      sizeBytes: buffer.length,
      checksum,
      documentType,
      uploadedById: auth.user.id,
      status: "stored",
      sendState: "pending",
    },
  });
  await invalidateExecution(prisma, tid, id);
  if (task.contactId) {
    await writeActivity(prisma, {
      tenantId: tid,
      contactId: task.contactId,
      inquiryId: task.inquiryId,
      type: "task.attachment_added",
      title: "Прикреплён файл",
      description: safeName,
      actorType: "user",
      actorId: auth.user.id,
      metadata: { taskId: id, attachmentId, documentType },
    });
  }

  // Group parent: fan-out file to open child tasks so batch send has the same KP.
  if (task.targetType === "group" && !task.parentTaskId) {
    const children = await prisma.task.findMany({
      where: { tenantId: tid, parentTaskId: id, status: { in: ["open", "waiting"] } },
      select: { id: true },
    });
    for (const child of children) {
      await copyParentAttachmentToChild(prisma, tid, auth.user.id, attachment, child.id);
    }
  }

  return attachment;
}

/** Copy parent attachment bytes + row onto a child task (skip if same checksum already present). */
async function copyParentAttachmentToChild(
  prisma: PrismaClient,
  tid: string,
  uploadedById: string | null | undefined,
  parentAtt: {
    id: string;
    storageKey: string;
    fileName: string;
    originalFileName: string | null;
    mimeType: string;
    sizeBytes: number;
    checksum: string | null;
    documentType: string | null;
  },
  childTaskId: string,
): Promise<{ created: boolean }> {
  if (parentAtt.checksum) {
    const existing = await prisma.attachment.findFirst({
      where: {
        tenantId: tid,
        parentType: "task",
        parentId: childTaskId,
        checksum: parentAtt.checksum,
      },
    });
    if (existing) return { created: false };
  }

  const src = resolveUploadPath(parentAtt.storageKey);
  const attachmentId = randomUUID();
  const safeName = parentAtt.fileName || "file.bin";
  const storageKey = path.posix.join(tid, childTaskId, `${attachmentId}-${safeName}`);
  const abs = resolveUploadPath(storageKey);
  await mkdir(path.dirname(abs), { recursive: true });
  try {
    await copyFile(src, abs);
  } catch {
    return { created: false };
  }

  await prisma.attachment.create({
    data: {
      id: attachmentId,
      tenantId: tid,
      parentType: "task",
      parentId: childTaskId,
      storageKey,
      fileName: safeName,
      originalFileName: parentAtt.originalFileName || parentAtt.fileName,
      mimeType: parentAtt.mimeType,
      sizeBytes: parentAtt.sizeBytes,
      checksum: parentAtt.checksum,
      documentType: parentAtt.documentType || "document",
      uploadedById: uploadedById || null,
      status: "stored",
      sendState: "pending",
    },
  });
  return { created: true };
}

/** Ensure every open child has the parent's attachments (idempotent by checksum). */
export async function syncGroupAttachmentsToChildren(
  prisma: PrismaClient,
  auth: AuthContext,
  parentTaskId: string,
) {
  const tid = tenantId(auth);
  const parent = await prisma.task.findFirst({
    where: { id: parentTaskId, tenantId: tid },
  });
  if (!parent || parent.targetType !== "group" || parent.parentTaskId) {
    return { copied: 0 };
  }
  const parentAtts = await listTaskAttachments(prisma, tid, parentTaskId);
  if (!parentAtts.length) return { copied: 0 };

  const children = await prisma.task.findMany({
    where: { tenantId: tid, parentTaskId, status: { in: ["open", "waiting"] } },
    select: { id: true },
  });

  let copied = 0;
  for (const child of children) {
    for (const att of parentAtts) {
      const result = await copyParentAttachmentToChild(prisma, tid, auth.user.id, att, child.id);
      if (result.created) copied += 1;
    }
    await invalidateExecution(prisma, tid, child.id);
  }
  return { copied };
}

export async function removeTaskAttachment(prisma: PrismaClient, auth: AuthContext, taskId: string, attachmentId: string) {
  const { tid } = await taskInTenant(prisma, auth, taskId);
  const attachment = await prisma.attachment.findFirst({
    where: { id: attachmentId, tenantId: tid, parentType: "task", parentId: taskId },
  });
  if (!attachment) throw new ApiError(404, "not_found", "Файл не найден");
  await prisma.attachment.delete({ where: { id: attachmentId } });
  const abs = resolveUploadPath(attachment.storageKey);
  await unlink(abs).catch(() => {});
  await invalidateExecution(prisma, tid, taskId);
  return { ok: true };
}

export async function prepareTaskExecution(prisma: PrismaClient, auth: AuthContext, id: string) {
  const { tid, task } = await taskInTenant(prisma, auth, id);
  if (!SENDABLE_TYPES.has(task.type)) {
    throw new ApiError(422, "invalid", "Этот тип задачи не отправляется через канал");
  }
  if (!task.contactId) throw new ApiError(422, "invalid", "Выберите клиента");

  const contact = await prisma.contact.findFirst({
    where: { id: task.contactId, tenantId: tid },
    include: {
      methods: true,
      inquiries: { where: { archived: false, status: { in: ["new", "accepted", "qualification", "qualified", "in_progress", "waiting_client", "waiting_manager"] } }, take: 5 },
      conversations: { orderBy: { updatedAt: "desc" }, take: 5 },
    },
  });
  if (!contact) throw new ApiError(422, "invalid", "Клиент не найден");

  if (!task.inquiryId && contact.inquiries.length > 1) {
    throw new ApiError(422, "ambiguous", "Несколько активных заявок. Выберите одну.", undefined, {
      candidates: contact.inquiries.map((item) => ({
        id: item.id,
        title: item.subject || item.service || "Заявка",
        status: item.status,
      })),
    });
  }

  const conversation = await resolveWhatsAppConversation(prisma, {
    tenantId: tid,
    contactId: contact.id,
    preferredConversationId: task.conversationId,
    defaultRegion: auth.activeMembership?.tenant.defaultRegion || "KZ",
    contactName: displayName(contact),
    healFromBot: true,
  });
  if (!conversation?.sellerLeadId) {
    throw new ApiError(422, "invalid", "Нет WhatsApp-диалога с sellerLead. Синхронизируйте бота или выберите диалог.");
  }

  const phone = primaryPhone(contact.methods);
  const message = (task.messageDraft || task.description || "").trim();
  if (!message) throw new ApiError(422, "invalid", "Напишите текст сообщения");

  const attachments = await listTaskAttachments(prisma, tid, id);
  const inquiry = task.inquiryId
    ? await prisma.inquiry.findFirst({ where: { id: task.inquiryId, tenantId: tid } })
    : contact.inquiries[0] || null;

  await prisma.task.update({
    where: { id },
    data: {
      executionStatus: "prepared",
      conversationId: conversation.id,
      inquiryId: inquiry?.id || task.inquiryId,
    },
  });

  if (task.contactId) {
    await writeActivity(prisma, {
      tenantId: tid,
      contactId: task.contactId,
      inquiryId: inquiry?.id || task.inquiryId,
      type: "task.prepared",
      title: "Подготовка отправки",
      description: message.slice(0, 280),
      actorType: "user",
      actorId: auth.user.id,
      metadata: { taskId: id },
    });
  }

  const timeZone = auth.activeMembership?.tenant.timezone || "Asia/Almaty";
  return {
    taskId: id,
    actionLabel:
      task.type === "proposal"
        ? "Отправить коммерческое предложение"
        : task.type === "send_documents"
          ? "Отправить документы"
          : "Отправить сообщение",
    client: {
      id: contact.id,
      name: displayName(contact),
      phone: phone?.rawValue || null,
    },
    request: inquiry
      ? { id: inquiry.id, title: inquiry.subject || inquiry.service || "Заявка", status: inquiry.status }
      : null,
    channel: "WhatsApp",
    destination: phone?.rawValue || conversation.sellerLeadId,
    conversationId: conversation.id,
    sellerLeadId: conversation.sellerLeadId,
    message,
    attachments: attachments.map((item) => ({
      id: item.id,
      fileName: item.originalFileName || item.fileName,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      sizeLabel: `${(item.sizeBytes / (1024 * 1024)).toFixed(1)} MB`,
      documentType: item.documentType,
      sendState: item.sendState,
    })),
    preparedAtLabel: formatWhen(new Date(), timeZone),
    buttons: {
      back: "Вернуться и изменить",
      confirm: "Подтвердить и отправить",
    },
  };
}

export async function confirmTaskExecution(prisma: PrismaClient, auth: AuthContext, id: string) {
  const preview = await prepareTaskExecution(prisma, auth, id);
  const { tid, task } = await taskInTenant(prisma, auth, id);
  const attachments = await listTaskAttachments(prisma, tid, id);
  const contentHash = hashExecutionContent({
    contactId: preview.client.id,
    inquiryId: preview.request?.id,
    conversationId: preview.conversationId,
    message: preview.message,
    attachments,
  });

  await voidConfirmations(prisma, tid, id);
  const confirmation = await prisma.executionConfirmation.create({
    data: {
      tenantId: tid,
      taskId: id,
      contactId: preview.client.id,
      inquiryId: preview.request?.id || null,
      dealId: task.dealId,
      conversationId: preview.conversationId,
      channel: "whatsapp",
      destination: preview.destination,
      messageSnapshot: preview.message,
      attachmentSnapshotsJson: preview.attachments,
      contentHash,
      confirmedById: auth.user.id,
    },
  });

  await prisma.task.update({
    where: { id },
    data: { executionStatus: "confirmed", confirmedAt: new Date() },
  });

  if (preview.client.id) {
    await writeActivity(prisma, {
      tenantId: tid,
      contactId: preview.client.id,
      inquiryId: preview.request?.id,
      type: "task.confirmed",
      title: "Отправка подтверждена",
      actorType: "user",
      actorId: auth.user.id,
      metadata: { taskId: id, confirmationId: confirmation.id },
    });
  }

  return { confirmation, preview };
}

export async function executeTask(
  prisma: PrismaClient,
  auth: AuthContext,
  id: string,
  options: { retryFailedFilesOnly?: boolean } = {},
) {
  const { tid, task } = await taskInTenant(prisma, auth, id);
  const confirmation = await prisma.executionConfirmation.findFirst({
    where: { tenantId: tid, taskId: id, voidedAt: null },
    orderBy: { confirmedAt: "desc" },
  });
  if (!confirmation) {
    const voided = await prisma.executionConfirmation.findFirst({
      where: { tenantId: tid, taskId: id, voidedAt: { not: null } },
      orderBy: { confirmedAt: "desc" },
    });
    if (voided) {
      throw new ApiError(409, "stale_confirmation", "Данные отправки изменились. Необходимо повторное подтверждение.");
    }
    throw new ApiError(409, "not_confirmed", "Сначала подтвердите отправку");
  }

  const attachments = await listTaskAttachments(prisma, tid, id);
  const contentHash = hashExecutionContent({
    contactId: confirmation.contactId,
    inquiryId: confirmation.inquiryId,
    conversationId: confirmation.conversationId,
    message: confirmation.messageSnapshot,
    attachments,
  });
  if (contentHash !== confirmation.contentHash) {
    await invalidateExecution(prisma, tid, id);
    throw new ApiError(409, "stale_confirmation", "Данные отправки изменились. Необходимо повторное подтверждение.");
  }

  let conversation = confirmation.conversationId
    ? await prisma.conversation.findFirst({ where: { id: confirmation.conversationId, tenantId: tid } })
    : null;
  if (!conversation?.sellerLeadId && confirmation.contactId) {
    conversation = await resolveWhatsAppConversation(prisma, {
      tenantId: tid,
      contactId: confirmation.contactId,
      preferredConversationId: confirmation.conversationId,
      defaultRegion: auth.activeMembership?.tenant.defaultRegion || "KZ",
      healFromBot: true,
    });
  }
  if (!conversation?.sellerLeadId) {
    throw new ApiError(422, "invalid", "Диалог WhatsApp недоступен");
  }

  // Staff send must take the dialog from AI on both CRM and the seller bot.
  let appliedOnSeller = false;
  let sellerError: string | null = null;
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      mode: "human",
      assigneeMembershipId: auth.activeMembership?.id || conversation.assigneeMembershipId,
      needsAttention: true,
      attentionReason: "taken_by_human",
    },
  });
  try {
    const resolved = await resolveSellerBridge(prisma, tid);
    if (resolved.bridge) {
      await resolved.bridge.setMode(conversation.sellerLeadId, "HUMAN");
      appliedOnSeller = true;
    } else {
      sellerError = "WhatsApp-бот не подключён — режим HUMAN только в CRM";
    }
  } catch (error) {
    sellerError = error instanceof Error ? error.message : "Не удалось перевести бота в HUMAN";
  }

  await prisma.task.update({ where: { id }, data: { executionStatus: "sending" } });

  let textOk = options.retryFailedFilesOnly ? true : false;
  let textError: string | null = null;
  if (!options.retryFailedFilesOnly) {
    try {
      await sendViaProvider(prisma, tid, {
        sellerLeadId: conversation.sellerLeadId,
        text: confirmation.messageSnapshot || "",
        idempotencyKey: `task-text:${id}:${confirmation.id}`,
      });
      textOk = true;
      await prisma.message.create({
        data: {
          tenantId: tid,
          conversationId: conversation.id,
          senderKind: "staff",
          senderUserId: auth.user.id,
          direction: "outbound",
          text: confirmation.messageSnapshot || "",
          operationState: "accepted",
        },
      });
    } catch (error) {
      textError = error instanceof Error ? error.message : "Ошибка отправки текста";
      textOk = false;
    }
  }

  const fileResults: Array<{ id: string; fileName: string; ok: boolean; error?: string }> = [];
  const filesToSend = options.retryFailedFilesOnly
    ? attachments.filter((item) => item.sendState !== "sent")
    : attachments;

  for (const file of filesToSend) {
    try {
      const abs = resolveUploadPath(file.storageKey);
      const result = await sendViaProvider(prisma, tid, {
        sellerLeadId: conversation.sellerLeadId,
        file: {
          fileName: file.originalFileName || file.fileName,
          mimeType: file.mimeType,
          filePath: abs,
          caption: file.documentType === "proposal" ? "Коммерческое предложение" : undefined,
        },
        idempotencyKey: `task-file:${id}:${file.id}`,
      });
      await prisma.attachment.update({
        where: { id: file.id },
        data: { sendState: "sent", sendError: null, providerMessageId: result.providerMessageId },
      });
      fileResults.push({ id: file.id, fileName: file.fileName, ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Ошибка отправки файла";
      await prisma.attachment.update({
        where: { id: file.id },
        data: { sendState: "failed", sendError: message },
      });
      fileResults.push({ id: file.id, fileName: file.fileName, ok: false, error: message });
    }
  }

  const allFilesSent =
    attachments.length === 0 ||
    (await listTaskAttachments(prisma, tid, id)).every((item) => item.sendState === "sent");
  const success = textOk && allFilesSent;
  const partial = Boolean(textOk && !allFilesSent);

  if (success) {
    await prisma.task.update({
      where: { id },
      data: {
        status: "done",
        executionStatus: "sent",
        sentAt: new Date(),
        completedAt: new Date(),
        completionSource: "system",
        resultCode: task.type === "proposal" ? "sent" : "sent",
      },
    });
    if (task.contactId) {
      await writeActivity(prisma, {
        tenantId: tid,
        contactId: task.contactId,
        inquiryId: task.inquiryId,
        type: "task.sent",
        title: "Сообщение отправлено",
        description: confirmation.messageSnapshot?.slice(0, 280),
        actorType: "system",
        actorId: auth.user.id,
        metadata: { taskId: id, files: fileResults },
      });
      await prisma.contact.update({
        where: { id: task.contactId },
        data: { lastOutboundMessageAt: new Date(), lastContactAt: new Date(), lastSeenAt: new Date() },
      });
    }
  } else {
    await prisma.task.update({
      where: { id },
      data: { executionStatus: partial ? "partial" : "failed", status: "open" },
    });
    if (task.contactId) {
      await writeActivity(prisma, {
        tenantId: tid,
        contactId: task.contactId,
        inquiryId: task.inquiryId,
        type: partial ? "task.send_partial" : "task.send_failed",
        title: partial ? "Текст ушёл, файл не отправлен" : "Отправка не завершена",
        description: [
          textOk ? "Сообщение отправлено ✓" : `Сообщение не отправлено ✕ ${textError || ""}`,
          ...fileResults.map((f) => (f.ok ? `${f.fileName} ✓` : `${f.fileName} ✕ ${f.error || ""}`)),
        ].join("\n"),
        actorType: "system",
        actorId: auth.user.id,
        metadata: { taskId: id, textOk, partial, fileResults },
      });
    }
  }

  // Auto-complete parent progress if child
  if (success && task.parentTaskId) {
    const openChildren = await prisma.task.count({
      where: { tenantId: tid, parentTaskId: task.parentTaskId, status: { in: ["open", "waiting"] } },
    });
    if (openChildren === 0) {
      await prisma.task.updateMany({
        where: { id: task.parentTaskId, tenantId: tid },
        data: { status: "done", completedAt: new Date(), completionSource: "system" },
      });
    }
  }

  return {
    success,
    partial,
    textOk,
    textError,
    files: fileResults,
    allFilesSent,
    retryFilesAvailable: !allFilesSent && textOk,
    nextActions: success ? suggestedNextActions(task.type, "sent") : [],
    status: success ? "done" : partial ? "partial" : "failed",
    note: partial
      ? "Текст в WhatsApp ушёл, файл — нет. Задача остаётся открытой: нажмите «Повторить отправку файла»."
      : null,
    appliedOnSeller,
    sellerError,
  };
}

export async function completeTaskWithResult(
  prisma: PrismaClient,
  auth: AuthContext,
  id: string,
  input: {
    resultCode: string;
    resultText?: string;
    nextAction?: { type: string; title: string; dueAt?: string } | null;
    skipNext?: boolean;
    confirmAiSuggestion?: boolean;
  },
) {
  const { tid, task } = await taskInTenant(prisma, auth, id);
  if (task.status === "canceled") throw new ApiError(409, "invalid_state", "Отменённую задачу нельзя закрыть");
  if (task.type === "process_inquiry" && task.inquiryId) {
    const inquiry = await prisma.inquiry.findFirst({ where: { id: task.inquiryId, tenantId: tid } });
    if (inquiry?.status === "new") {
      throw new ApiError(422, "inquiry_open", "Сначала примите или отклоните заявку, затем закройте задачу");
    }
  }

  const updated = await prisma.task.update({
    where: { id },
    data: {
      status: "done",
      completedAt: new Date(),
      completionSource: "user",
      resultCode: input.resultCode,
      resultText: input.resultText || null,
      completionResult: input.resultCode,
      executionStatus: task.executionStatus === "sent" ? "sent" : task.executionStatus,
    },
  });

  if (task.agreementId) {
    await prisma.agreement.update({
      where: { id: task.agreementId },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    const agr = await prisma.agreement.findFirst({ where: { id: task.agreementId } });
    if (agr) await syncAgreementToCalendar(agr).catch(() => null);
  }

  if (task.contactId) {
    await writeActivity(prisma, {
      tenantId: tid,
      contactId: task.contactId,
      inquiryId: task.inquiryId,
      dealId: task.dealId,
      type: "task.completed",
      title: "Задача завершена",
      description: input.resultText || input.resultCode,
      actorType: "user",
      actorId: auth.user.id,
      metadata: { taskId: id, resultCode: input.resultCode },
    });
  }

  const analyzed = await analyzeTaskResultNextActions({
    taskType: task.type,
    resultCode: input.resultCode,
    resultText: input.resultText,
    contactName: task.contact ? displayName(task.contact) : null,
    inquiryTitle: task.inquiry?.subject || task.inquiry?.service || null,
  });

  let createdNext = null;
  // Explicit nextAction from UI (manager confirmed) — create immediately
  if (input.nextAction && !input.skipNext) {
    const needsHitl = ["proposal", "send_documents"].includes(input.nextAction.type);
    createdNext = await prisma.task.create({
      data: {
        tenantId: tid,
        type: input.nextAction.type,
        title: input.nextAction.title,
        contactId: task.contactId,
        inquiryId: task.inquiryId,
        conversationId: task.conversationId,
        dealId: task.dealId,
        dueAt: input.nextAction.dueAt ? new Date(input.nextAction.dueAt) : null,
        ownerMembershipId: task.ownerMembershipId || auth.activeMembership?.id,
        source: "system",
        targetType: task.contactId ? "client" : "none",
        priority: "normal",
        purpose: "Следующий шаг после результата",
        executionStatus: needsHitl ? "prepared" : "none",
        commandStatus: needsHitl ? "needs_confirmation" : "none",
      },
    });
    if (task.contactId) {
      await writeActivity(prisma, {
        tenantId: tid,
        contactId: task.contactId,
        inquiryId: task.inquiryId,
        dealId: task.dealId,
        type: "task.next_action_created",
        title: "Создано следующее действие",
        description: createdNext.title,
        actorType: "user",
        actorId: auth.user.id,
        metadata: { taskId: createdNext.id, fromTaskId: id, confirmed: true },
      });
    }
  }

  const fallback = suggestedNextActions(task.type, input.resultCode);
  const suggestedNextActionsMerged = availableNextActions(analyzed.suggestions.length
    ? analyzed.suggestions.map((s) => ({
        type: s.type,
        title: s.title,
        dueOffsetHours: s.dueOffsetHours ?? null,
        dueAt: s.dueAt || null,
        purpose: s.purpose,
        requiresConfirm: s.requiresConfirm,
        reason: s.reason,
        suggestedDealStage: s.suggestedDealStage,
      }))
    : fallback);

  return {
    task: updated,
    nextTask: createdNext,
    suggestedNextActions: suggestedNextActionsMerged,
    aiSuggestion: {
      source: analyzed.source,
      note: "AI предлагает следующий шаг. Подтвердите, чтобы создать задачу.",
      items: suggestedNextActionsMerged,
    },
  };
}

export async function createNextActionFromSuggestion(
  prisma: PrismaClient,
  auth: AuthContext,
  id: string,
  input: { type: string; title: string; dueOffsetHours?: number | null },
) {
  const { tid, task } = await taskInTenant(prisma, auth, id);
  const dueAt =
    input.dueOffsetHours != null ? new Date(Date.now() + input.dueOffsetHours * 3600_000) : null;
  const next = await prisma.task.create({
    data: {
      tenantId: tid,
      type: input.type,
      title: input.title,
      contactId: task.contactId,
      inquiryId: task.inquiryId,
      conversationId: task.conversationId,
      dealId: task.dealId,
      dueAt,
      ownerMembershipId: task.ownerMembershipId || auth.activeMembership?.id,
      source: "system",
      targetType: task.contactId ? "client" : "none",
      executionStatus: ["proposal", "send_documents"].includes(input.type) ? "prepared" : "none",
      commandStatus: ["proposal", "send_documents"].includes(input.type) ? "needs_confirmation" : "none",
      purpose: "Подтверждённый следующий шаг",
    },
  });
  if (task.contactId) {
    await writeActivity(prisma, {
      tenantId: tid,
      contactId: task.contactId,
      inquiryId: task.inquiryId,
      type: "task.next_action_created",
      title: "Создано следующее действие",
      description: next.title,
      actorType: "user",
      actorId: auth.user.id,
      metadata: { taskId: next.id, fromTaskId: id },
    });
  }
  return next;
}

export { CALL_RESULTS, PROPOSAL_RESULTS, SENDABLE_TYPES, MEETING_RESULTS };
