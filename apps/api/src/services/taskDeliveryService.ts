import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import { resolveUploadPath } from "../lib/storage.ts";
import type { AuthContext } from "../lib/types.ts";
import { hashExecutionContent, sendViaProvider, providerDefinitelyDidNotSend } from "./messagingProvider.ts";
import { resolveSellerBridge } from "./sellerLink.ts";
import { writeActivity } from "./contactService.ts";
import { conversationMediaKind } from "./conversationMedia.ts";
import { assertTaskVisible, requireManageTasks } from "../lib/access.ts";
import { writeAudit } from "../lib/audit.ts";
import { readTaskDelivery, saveTaskDelivery, taskDeliveryBusy, taskDeliveryUnknown, taskDeliveryResult,
  TASK_DELIVERY_CHECK, type TaskDelivery } from "./taskDeliveryState.ts";

const LEASE_MS = 5 * 60 * 1000;
const stale = () => new ApiError(409, "stale_confirmation", "Данные или получатель отправки изменились. Необходимо повторное подтверждение.");
const lockedTask = async (tx: Prisma.TransactionClient, tid: string, id: string) => {
  await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${id} AND "tenantId" = ${tid} FOR UPDATE`;
  const task = await tx.task.findFirst({ where: { id, tenantId: tid } });
  if (!task) throw new ApiError(404, "not_found", "Задача не найдена");
  return task;
};

/** The durable intent precedes the remote call. A lost response never becomes an automatic retry. */
export async function deliverTask(prisma: PrismaClient, auth: AuthContext, id: string, retryFilesOnly = false) {
  const tid = auth.activeMembership!.tenantId;
  const claim = randomUUID();
  const acquired = await prisma.$transaction(async tx => {
    const task = await lockedTask(tx, tid, id);
    let delivery = await readTaskDelivery(tx, tid, id);
    if (task.status === "canceled") throw new ApiError(409, "invalid_state", "Отменённую задачу нельзя отправить");
    if (delivery && taskDeliveryBusy(delivery)) throw new ApiError(409, "task_sending", "Отправка уже выполняется. Дождитесь результата.");
    if (delivery && taskDeliveryUnknown(delivery)) {
      for (const part of delivery.parts.filter(p => p.state === "sending")) {
        await tx.message.updateMany({ where: { tenantId: tid, connectionScopedId: `task:${tid}:${id}:${delivery.confirmationId}:${part.id}`, operationState: "sending" }, data: { operationState: "unknown" } });
        if (part.id !== "text") await tx.attachment.updateMany({ where: { id: part.id, tenantId: tid, parentId: id, sendState: "sending" }, data: { sendState: "unknown", sendError: TASK_DELIVERY_CHECK } });
      }
      delivery.parts = delivery.parts.map(p => p.state === "sending" ? { ...p, state: "unknown", error: TASK_DELIVERY_CHECK } : p);
      delivery.claim = null; delivery.leaseUntil = null;
      await saveTaskDelivery(tx, tid, id, delivery);
      await tx.task.update({ where: { id, tenantId: tid }, data: { executionStatus: "unknown", commandStatus: "unknown" } });
      return { cached: delivery };
    }
    if (delivery && taskDeliveryResult(delivery).success && task.status === "done") return { cached: delivery };
    if (task.status === "done") throw new ApiError(409, "invalid_state", "Закрытую задачу нельзя отправить повторно");
    // Older attempts have no durable per-part evidence. Never infer non-delivery from an old error.
    if (!delivery && ["sending", "partial", "failed", "unknown", "sent"].includes(task.executionStatus)) {
      throw new ApiError(409, "task_delivery_unknown", TASK_DELIVERY_CHECK);
    }
    const confirmation = await tx.executionConfirmation.findFirst({ where: { tenantId: tid, taskId: id, voidedAt: null }, orderBy: [{ confirmedAt: "desc" }, { id: "desc" }] });
    if (!confirmation) {
      if (await tx.executionConfirmation.count({ where: { tenantId: tid, taskId: id } })) throw stale();
      throw new ApiError(409, "not_confirmed", "Сначала подтвердите отправку");
    }
    const conversation = task.conversationId ? await tx.conversation.findFirst({ where: { id: task.conversationId, tenantId: tid } }) : null;
    const attachments = await tx.attachment.findMany({ where: { tenantId: tid, parentType: "task", parentId: id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    const contentHash = hashExecutionContent({ contactId: task.contactId, inquiryId: task.inquiryId,
      conversationId: task.conversationId, sellerLeadId: conversation?.sellerLeadId,
      message: (task.messageDraft || task.description || "").trim(), attachments });
    if (!conversation?.sellerLeadId || contentHash !== confirmation.contentHash || confirmation.conversationId !== conversation.id) throw stale();
    if (delivery && (delivery.contentHash !== contentHash || delivery.confirmationId !== confirmation.id)) {
      if (delivery.parts.some(p => p.state === "accepted")) throw stale();
      delivery = null; // Only a known rejection before any acceptance permits a new snapshot.
    }
    if (retryFilesOnly && (!delivery || delivery.parts.find(p => p.id === "text")?.state !== "accepted")) {
      throw new ApiError(409, "text_not_sent", "Сначала отправьте текст сообщения. Повтор файлов доступен только после подтверждённой отправки текста.");
    }
    const complete = Boolean(delivery && taskDeliveryResult(delivery).success);
    const version = conversation.controlVersion + (complete ? 0 : 1);
    delivery ||= { version: 1, confirmationId: confirmation.id, contentHash, conversationId: conversation.id,
      sellerLeadId: conversation.sellerLeadId, claim: null, leaseUntil: null,
      parts: [{ id: "text", state: "pending", attempt: 0 }, ...attachments.map(f => ({ id: f.id,
        fileName: f.originalFileName || f.fileName, state: "pending" as const, attempt: 0 }))] };
    delivery.claim = claim; delivery.leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();
    await saveTaskDelivery(tx, tid, id, delivery);
    await tx.task.update({ where: { id, tenantId: tid }, data: { executionStatus: "sending", commandStatus: "executing" } });
    if (!complete) await tx.conversation.update({ where: { id: conversation.id, tenantId: tid }, data: { mode: "human",
      controlVersion: version, assigneeMembershipId: auth.activeMembership!.id, needsAttention: true, attentionReason: "taken_by_human" } });
    return { task, confirmation, attachments, delivery, version };
  });
  if (acquired.cached) return { ...taskDeliveryResult(acquired.cached), appliedOnSeller: false, sellerError: null };
  const { task, confirmation, attachments, version } = acquired;
  let appliedOnSeller = false;
  let sellerError: string | null = null;
  const withClaim = async <T>(fn: (tx: Prisma.TransactionClient, delivery: TaskDelivery) => Promise<T>) => prisma.$transaction(async tx => {
    await lockedTask(tx, tid, id);
    const delivery = await readTaskDelivery(tx, tid, id);
    if (!delivery || delivery.claim !== claim) throw new ApiError(409, "task_sending", "Состояние отправки изменилось. Проверьте задачу.");
    return fn(tx, delivery);
  });

  if (!taskDeliveryResult(acquired.delivery).success) try {
    const resolved = await resolveSellerBridge(prisma, tid);
    if (!resolved.bridge) throw new ApiError(503, "bridge_unavailable", "WhatsApp не подключён. Сообщение не отправлено.");
    const modeReply = await resolved.bridge.setMode(acquired.delivery.sellerLeadId, "HUMAN") as { ok?: boolean; error?: unknown } | null;
    if (modeReply?.ok === false || modeReply?.error) throw new Error("Handover rejected");
    appliedOnSeller = true;
  } catch {
    sellerError = "Не удалось передать диалог сотруднику. Проверьте подключение WhatsApp и повторите отправку.";
    // No send has started. Failure to hand the conversation over is safe to retry.
    await withClaim(async (tx, delivery) => {
      const next = delivery.parts.find(p => p.state !== "accepted")!;
      next.state = "failed"; next.error = sellerError;
      await saveTaskDelivery(tx, tid, id, delivery);
    });
  }

  if (appliedOnSeller) for (const part of acquired.delivery.parts) {
    if (part.state === "accepted") continue;
    const file = attachments.find(f => f.id === part.id);
    const messageKey = `task:${tid}:${id}:${confirmation.id}:${part.id}`;
    const attempt = await withClaim(async (tx, delivery) => {
      const currentTask = await tx.task.findFirstOrThrow({ where: { id, tenantId: tid } });
      const conversation = await tx.conversation.findFirst({ where: { id: delivery.conversationId, tenantId: tid } });
      const stillConfirmed = await tx.executionConfirmation.count({ where: { id: confirmation.id, tenantId: tid, taskId: id, voidedAt: null } });
      const currentFiles = await tx.attachment.findMany({ where: { tenantId: tid, parentType: "task", parentId: id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
      const membershipActive = await tx.membership.count({ where: { id: auth.activeMembership!.id, tenantId: tid,
        userId: auth.user.id, active: true, tenant: { status: "active" } } });
      const hash = hashExecutionContent({ contactId: currentTask.contactId, inquiryId: currentTask.inquiryId,
        conversationId: currentTask.conversationId, sellerLeadId: conversation?.sellerLeadId,
        message: (currentTask.messageDraft || currentTask.description || "").trim(), attachments: currentFiles });
      const active = membershipActive && !["done", "canceled"].includes(currentTask.status) && stillConfirmed && hash === delivery.contentHash
        && conversation?.mode === "human" && conversation.controlVersion === version;
      const item = delivery.parts.find(p => p.id === part.id)!;
      if (!active) {
        item.state = "failed"; item.error = "Задача или диалог изменились. Оставшаяся отправка остановлена.";
        await saveTaskDelivery(tx, tid, id, delivery);
        return null;
      }
      item.state = "sending"; item.attempt += 1; item.error = null;
      delete item.reconciledBy; delete item.reconciledAt; delete item.reconciliationNote;
      delivery.leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();
      await saveTaskDelivery(tx, tid, id, delivery);
      const message = await tx.message.upsert({ where: { connectionScopedId: messageKey }, create: {
        tenantId: tid, conversationId: delivery.conversationId, connectionScopedId: messageKey, senderKind: "staff", senderUserId: auth.user.id,
        direction: "outbound", text: file ? file.originalFileName || file.fileName : confirmation.messageSnapshot,
        type: file ? conversationMediaKind(file.mimeType) : "text", operationState: "sending",
      }, update: { operationState: "sending" } });
      if (file) await tx.attachment.update({ where: { id: file.id, tenantId: tid }, data: { sendState: "sending", sendError: null, messageId: message.id } });
      return { key: `${messageKey}:${item.attempt}`, messageId: message.id };
    });
    if (!attempt) break;
    let providerMessageId: string | null = null;
    let state: "accepted" | "failed" | "unknown" = "accepted";
    let errorText: string | null = null;
    try {
      const result = await sendViaProvider(prisma, tid, { sellerLeadId: acquired.delivery.sellerLeadId,
        ...(file ? { file: { fileName: file.originalFileName || file.fileName, mimeType: file.mimeType,
          filePath: resolveUploadPath(file.storageKey), checksum: file.checksum, caption: file.documentType === "proposal" ? "Коммерческое предложение" : undefined } }
          : { text: confirmation.messageSnapshot || "" }), idempotencyKey: attempt.key });
      providerMessageId = result.providerMessageId;
    } catch (error) {
      state = providerDefinitelyDidNotSend(error) ? "failed" : "unknown";
      errorText = state === "unknown" ? TASK_DELIVERY_CHECK : error instanceof Error ? error.message : "Отправка не выполнена";
    }
    // If this transaction fails after the provider accepted, the persisted intent
    // remains 'sending'. Recovery presents an unknown outcome, never a new send.
    await withClaim(async (tx, delivery) => {
      const item = delivery.parts.find(p => p.id === part.id)!;
      item.state = state; item.error = errorText; item.providerMessageId = providerMessageId;
      await saveTaskDelivery(tx, tid, id, delivery);
      await tx.message.update({ where: { id: attempt.messageId, tenantId: tid }, data: { operationState: state, providerMessageId } });
      if (file) await tx.attachment.update({ where: { id: file.id, tenantId: tid }, data: {
        sendState: state === "accepted" ? "sent" : state, sendError: errorText, providerMessageId } });
      if (state === "accepted") {
        await tx.conversation.update({ where: { id: delivery.conversationId, tenantId: tid }, data: { messageRevision: { increment: 1 } } });
        if (task.contactId) await tx.contact.updateMany({ where: { id: task.contactId, tenantId: tid }, data: {
          lastOutboundMessageAt: new Date(), lastContactAt: new Date(), lastSeenAt: new Date() } });
      }
    });
    // Keep ordering and stop immediately when any part is unconfirmed.
    if (state !== "accepted") break;
  }

  const result = await withClaim(async (tx, delivery) => {
    delivery.claim = null; delivery.leaseUntil = null;
    await saveTaskDelivery(tx, tid, id, delivery);
    const result = taskDeliveryResult(delivery);
    const changed = await tx.task.updateMany({ where: { id, tenantId: tid, status: { notIn: ["done", "canceled"] } }, data: {
      executionStatus: result.success ? "sent" : result.status, commandStatus: result.success ? "sent" : result.status,
      ...(result.success ? { status: "done", sentAt: new Date(), completedAt: new Date(), completionSource: "system", resultCode: "sent" } : {}),
    } });
    if (changed.count && task.contactId) await writeActivity(tx, { tenantId: tid, contactId: task.contactId, inquiryId: task.inquiryId,
      type: result.success ? "task.sent" : result.needsCheck ? "task.send_unknown" : result.partial ? "task.send_partial" : "task.send_failed",
      title: result.success ? "Отправка завершена" : result.needsCheck ? "Нужно проверить отправку" : "Отправка не завершена",
      description: result.note || confirmation.messageSnapshot?.slice(0, 280), actorType: "user", actorId: auth.user.id,
      metadata: { taskId: id, confirmationId: confirmation.id, textOk: result.textOk, files: result.files.map(f => ({ id: f.id, state: f.state })) } });
    if (result.success && task.parentTaskId) {
      const incomplete = await tx.task.count({ where: { tenantId: tid, parentTaskId: task.parentTaskId, status: { not: "done" } } });
      if (!incomplete) await tx.task.updateMany({ where: { id: task.parentTaskId, tenantId: tid, status: { notIn: ["done", "canceled"] } },
        data: { status: "done", completedAt: new Date(), completionSource: "system" } });
    }
    return result;
  });
  return { ...result, appliedOnSeller, sellerError };
}

/** A company administrator records a checked outcome, not a delivery receipt.
 * This never dispatches anything; a separate explicit send is still required. */
export async function reconcileTaskDelivery(prisma: PrismaClient, auth: AuthContext, id: string,
  input: { partId: string; outcome: "sent" | "not_sent"; note: string }) {
  requireManageTasks(auth);
  const tid = auth.activeMembership!.tenantId;
  const note = String(input.note || "").trim();
  if (!["sent", "not_sent"].includes(input.outcome) || note.length < 8 || note.length > 1000) {
    throw new ApiError(422, "invalid", "Укажите результат сверки и пояснение от 8 до 1000 символов.");
  }
  return prisma.$transaction(async tx => {
    const task = await lockedTask(tx, tid, id); assertTaskVisible(auth, task);
    if (["done", "canceled"].includes(task.status)) throw new ApiError(409, "invalid_state", "Задача уже закрыта");
    const delivery = await readTaskDelivery(tx, tid, id);
    if (!delivery) throw new ApiError(409, "no_delivery_evidence", "Нет сохранённой попытки для сверки. Обратитесь к администратору сервиса.");
    if (taskDeliveryBusy(delivery)) throw new ApiError(409, "task_sending", "Отправка ещё выполняется. Дождитесь результата.");
    const part = delivery.parts.find(p => p.id === input.partId);
    if (!part) throw new ApiError(404, "not_found", "Часть отправки не найдена");
    if (!["unknown", "sending"].includes(part.state)) throw new ApiError(409, "already_reconciled", "Результат уже проверен. Обновите задачу.");
    const previousState = part.state;
    const state = input.outcome === "sent" ? "accepted" : "failed";
    part.state = state; part.error = state === "failed" ? "По результатам сверки отправка не выполнена" : null;
    part.reconciledBy = auth.user.id; part.reconciledAt = new Date().toISOString(); part.reconciliationNote = note;
    delivery.claim = null; delivery.leaseUntil = null;
    await saveTaskDelivery(tx, tid, id, delivery);
    await tx.message.updateMany({ where: { tenantId: tid, connectionScopedId: `task:${tid}:${id}:${delivery.confirmationId}:${part.id}` }, data: { operationState: state } });
    if (part.id !== "text") await tx.attachment.updateMany({ where: { id: part.id, tenantId: tid, parentId: id },
      data: { sendState: state === "accepted" ? "sent" : "failed", sendError: part.error } });
    const result = taskDeliveryResult(delivery);
    await tx.task.update({ where: { id, tenantId: tid }, data: { executionStatus: result.success ? "sent" : result.status,
      commandStatus: result.success ? "sent" : result.status,
      ...(result.success ? { status: "done", sentAt: new Date(), completedAt: new Date(), completionSource: "user", resultCode: "sent" } : {}),
    } });
    if (task.contactId) await writeActivity(tx, { tenantId: tid, contactId: task.contactId, inquiryId: task.inquiryId,
      type: "task.delivery_reconciled", title: "Отправка сверена сотрудником", description: note, actorType: "user", actorId: auth.user.id,
      metadata: { taskId: id, partId: part.id, outcome: input.outcome, confirmationId: delivery.confirmationId } });
    await writeAudit(tx, { tenantId: tid, actorUserId: auth.user.id, action: "task.delivery_reconciled",
      entityType: "task", entityId: id, changes: { partId: part.id, before: previousState, after: state, reason: note,
        fileName: part.fileName || "Сообщение", from: "Отправка не подтверждена",
        to: input.outcome === "sent" ? "Сверено: отправлено" : "Сверено: не отправлено", confirmationId: delivery.confirmationId } });
    if (result.success && task.parentTaskId && !(await tx.task.count({ where: { tenantId: tid, parentTaskId: task.parentTaskId, status: { not: "done" } } }))) {
      await tx.task.updateMany({ where: { id: task.parentTaskId, tenantId: tid, status: { notIn: ["done", "canceled"] } },
        data: { status: "done", completedAt: new Date(), completionSource: "user" } });
    }
    return result;
  });
}
