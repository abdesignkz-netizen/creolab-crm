import type { PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { createContact } from "./contactService.ts";
import { createTask } from "./domainService.ts";
import { confirmTaskExecution, executeTask, prepareTaskExecution, syncGroupAttachmentsToChildren, updateTaskDraft } from "./taskExecutionService.ts";
import { TASK_TYPE_LABEL } from "./contactLabels.ts";
import { searchContactsForPicker } from "./segmentService.ts";

function tenantId(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership.tenantId;
}

export async function createTaskFromCommand(
  prisma: PrismaClient,
  auth: AuthContext,
  input: {
    text: string;
    parsedCommand: Record<string, unknown>;
    clientIds?: string[];
    phone?: string;
    phones?: string[];
    contactName?: string;
    contactNames?: string[];
    messageDraft?: string;
    executionMode?: "execute" | "prepare_only";
    ownerMembershipId?: string;
    dueAt?: string;
  },
) {
  let clientIds = [...new Set(input.clientIds || [])].slice(0, 30);
  const phones = [...new Set([...(input.phones || []), ...(input.phone ? [input.phone] : [])].map((p) => p.trim()).filter(Boolean))].slice(
    0,
    30,
  );

  async function resolvePhone(phone: string, name?: string) {
    const found = await searchContactsForPicker(prisma, auth, phone);
    if (found.clients.length === 1) return String(found.clients[0].id);
    if (found.clients.length > 1) {
      throw new ApiError(422, "ambiguous_phone", `По номеру ${phone} найдено несколько клиентов — выберите в списке`);
    }
    try {
      const created = await createContact(prisma, auth, {
        name: name?.trim() || `Клиент ${phone}`,
        phone,
        source: "ai_command",
      });
      return created.id;
    } catch (error) {
      if (error instanceof ApiError && error.code === "duplicate_phone") {
        const details = error.details as { phone?: string } | undefined;
        if (details?.phone) return String(details.phone);
      }
      throw error;
    }
  }

  if (phones.length) {
    for (let i = 0; i < phones.length; i += 1) {
      const id = await resolvePhone(phones[i], input.contactNames?.[i] || (i === 0 ? input.contactName : undefined));
      if (!clientIds.includes(id)) clientIds.push(id);
    }
    clientIds = [...new Set(clientIds)].slice(0, 30);
  }

  if (!clientIds.length) throw new ApiError(422, "invalid", "Выберите хотя бы одного клиента");

  const taskType = String(input.parsedCommand.taskType || "other");
  const executionMode = input.executionMode || (input.parsedCommand.executionMode === "prepare_only" ? "prepare_only" : "execute");
  const actionLabel = TASK_TYPE_LABEL[taskType] || String(input.parsedCommand.actionLabel || taskType);
  const understanding = String(input.parsedCommand.understandingLabel || actionLabel);
  const title =
    clientIds.length === 1 ? `${actionLabel}` : `${actionLabel} — ${clientIds.length} клиентов`;

  const defaultMessage =
    input.messageDraft ||
    (taskType === "proposal"
      ? "Добрый день! Во вложении коммерческое предложение. Готовы обсудить детали."
      : taskType === "message"
        ? "Добрый день! Хотел уточнить по нашему вопросу."
        : undefined);

  const created = await createTask(prisma, auth, {
    type: taskType === "send_documents" ? "send_documents" : taskType,
    title,
    description: input.text,
    targetType: clientIds.length === 1 ? "client" : "group",
    contactId: clientIds.length === 1 ? clientIds[0] : undefined,
    clientIds: clientIds.length > 1 ? clientIds : undefined,
    ownerMembershipId: input.ownerMembershipId,
    dueAt: input.dueAt,
    priority: "normal",
    segmentSnapshot: {
      ...(typeof input.parsedCommand.filters === "object" && input.parsedCommand.filters
        ? (input.parsedCommand.filters as object)
        : {}),
      label: understanding,
      rawCommandText: input.text,
      selectedCount: clientIds.length,
    },
  });

  const parentId = created.id;
  const draft = defaultMessage || null;

  await prisma.task.update({
    where: { id: parentId },
    data: {
      rawCommandText: input.text,
      parsedCommandJson: input.parsedCommand as object,
      commandStatus: executionMode === "prepare_only" ? "prepared" : "prepared",
      messageDraft: draft,
      source: "ai_command",
      executionStatus: draft ? "prepared" : "none",
    },
  });

  const children = await prisma.task.findMany({
    where: { tenantId: tenantId(auth), parentTaskId: parentId },
  });

  if (draft) {
    if (children.length) {
      await prisma.task.updateMany({
        where: { parentTaskId: parentId },
        data: { messageDraft: draft, executionStatus: "prepared", source: "ai_command", commandStatus: "prepared" },
      });
    } else if (created.contactId) {
      await updateTaskDraft(prisma, auth, parentId, { messageDraft: draft });
    }
  }

  const full = await prisma.task.findFirst({
    where: { id: parentId },
    include: { childTasks: { include: { contact: true } }, contact: true },
  });

  return {
    task: full,
    executionMode,
    childCount: children.length || (created.contactId ? 1 : 0),
    messageDraft: draft,
    nextStep:
      executionMode === "prepare_only"
        ? "Черновик подготовлен. Внешняя отправка не выполняется."
        : taskType === "call" || taskType === "follow_up"
          ? "Групповая/одиночная задача создана. Отметьте результат по каждому клиенту."
          : "Добавьте файл при необходимости, затем подготовьте и подтвердите отправку.",
  };
}

export async function executeTaskBatch(prisma: PrismaClient, auth: AuthContext, parentId: string) {
  const tid = tenantId(auth);
  const parent = await prisma.task.findFirst({
    where: { id: parentId, tenantId: tid },
    include: { childTasks: true },
  });
  if (!parent) throw new ApiError(404, "not_found", "Задача не найдена");
  if (parent.targetType !== "group") {
    throw new ApiError(422, "invalid", "Batch только для групповых задач");
  }

  const children = parent.childTasks.filter((item) => item.status === "open" || item.status === "waiting");
  if (children.length > 30) {
    throw new ApiError(422, "too_many", "Слишком много получателей для batch. Создайте Campaign (следующая волна).");
  }

  await prisma.task.update({ where: { id: parentId }, data: { commandStatus: "executing", executionStatus: "sending" } });

  await syncGroupAttachmentsToChildren(prisma, auth, parentId);

  const results: Array<{ taskId: string; contactId: string | null; success: boolean; error?: string }> = [];

  for (const child of children) {
    try {
      if (parent.messageDraft && !child.messageDraft) {
        await updateTaskDraft(prisma, auth, child.id, { messageDraft: parent.messageDraft });
      }
      await prepareTaskExecution(prisma, auth, child.id);
      await confirmTaskExecution(prisma, auth, child.id);
      const exec = await executeTask(prisma, auth, child.id);
      results.push({ taskId: child.id, contactId: child.contactId, success: Boolean(exec.success) });
    } catch (error) {
      results.push({
        taskId: child.id,
        contactId: child.contactId,
        success: false,
        error: error instanceof Error ? error.message : "Ошибка",
      });
    }
  }

  const ok = results.filter((item) => item.success).length;
  const fail = results.length - ok;
  const status =
    fail === 0 && ok > 0 ? "completed" : ok > 0 && fail > 0 ? "partially_completed" : fail > 0 ? "failed" : "prepared";

  await prisma.task.update({
    where: { id: parentId },
    data: {
      commandStatus: status,
      executionStatus: fail === 0 && ok > 0 ? "sent" : fail > 0 ? "failed" : parent.executionStatus,
      status: fail === 0 && ok === children.length ? "done" : "open",
      completedAt: fail === 0 && ok === children.length ? new Date() : null,
      completionSource: "system",
    },
  });

  return {
    parentId,
    total: results.length,
    success: ok,
    failed: fail,
    results,
    nextActions:
      ok > 0
        ? [
            { type: "follow_up", title: "Напомнить неответившим завтра", dueOffsetHours: 24 },
            { type: "wait_client", title: "Ждать ответа", dueOffsetHours: null },
          ]
        : [],
  };
}
