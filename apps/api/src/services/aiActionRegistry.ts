import type { Prisma } from "@creolab/db";
import type { ActionInput, ControlAction } from "@creolab/contracts";
import type { DomainDb } from "../lib/transaction.ts";
import type { AuthContext } from "../lib/types.ts";
import { assertTaskVisible, requireManageTasks, requireTenant } from "../lib/access.ts";
import { sha256 } from "../lib/hash.ts";
import { ApiError } from "../errors.ts";
import { createTask, assignTask } from "./domainService.ts";
import { saveTaskDraftOnly } from "./taskExecutionService.ts";
import { assertTaskDeliveryEditable } from "./taskDeliveryState.ts";
import { createStaffNotification } from "./notificationService.ts";
import { authForUserInTenant } from "./authService.ts";
import { previewOpportunityTask, executeOpportunityTask } from "./opportunityAction.ts";

// Deliberately closed: no send, payment, deletion, role or arbitrary tool adapter.
export const AI_ACTION_REGISTRY: Record<ActionInput["kind"], { label: string; permission: ControlAction }> = {
  "opportunity.task": { label: "Создать задачу по возможности", permission: "CREATE_TASK" },
  "task.create": { label: "Создать задачу", permission: "CREATE_TASK" },
  "task.assign": { label: "Назначить сотрудника", permission: "ASSIGN_TASK" },
  "task.draft": { label: "Сохранить черновик ответа", permission: "UPDATE_TASK" },
  "staff.notify": { label: "Уведомить сотрудника в BasQar", permission: "ASSIGN_TASK" },
};
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function stable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  return value;
}
export const actionHash = (value: unknown) => sha256(JSON.stringify(stable(value)));
export type ActionSnapshot = {
  taskId?: string; taskHash?: string; memberId?: string; memberHash?: string;
  contactId?: string; contactHash?: string;
};
export async function actionMember(db: DomainDb, tenantId: string, id: string) {
  const member = await db.membership.findFirst({ where: { id, tenantId, active: true }, include: { user: true } });
  if (!member || member.user.status !== "active") throw new ApiError(409, "action_member_changed", "Сотрудник недоступен. Выберите действующего сотрудника и подготовьте новый план.");
  return { member, hash: actionHash({ id: member.id, userId: member.userId, name: member.user.name, role: member.role, permissions: member.permissions }) };
}
async function actionContact(db: DomainDb, tenantId: string, id: string) {
  const contact = await db.contact.findFirst({ where: { id, tenantId, archivedAt: null } });
  if (!contact) throw new ApiError(404, "not_found", "Клиент не найден");
  return { contact, hash: actionHash(contact) };
}
export async function actionTask(db: DomainDb, auth: AuthContext, id: string) {
  const tenantId = requireTenant(auth).tenantId;
  const task = await db.task.findFirst({ where: { id, tenantId } });
  assertTaskVisible(auth, task);
  if (!task) throw new ApiError(404, "not_found", "Задача не найдена");
  if (task.status !== "open" || task.parentTaskId || task.targetType === "group" || task.confirmedAt || task.sentAt
    || !["none", "prepared"].includes(task.executionStatus) || !["none", "draft", "prepared"].includes(task.commandStatus)) {
    throw new ApiError(409, "action_task_state", "Задача уже закрыта, подтверждена или выполняется. Проверьте её в карточке задачи.");
  }
  await assertTaskDeliveryEditable(db, tenantId, id);
  if (await db.scheduledAction.count({ where: { tenantId, parentType: "task", parentId: id, state: { in: ["scheduled", "running", "processing"] } } })) {
    throw new ApiError(409, "action_task_state", "Для задачи уже запланировано выполнение. Сначала проверьте его в карточке задачи.");
  }
  return task;
}
export async function previewAction(db: DomainDb, auth: AuthContext, input: ActionInput, prior: ActionInput[]) {
  requireManageTasks(auth);
  if (input.kind === "opportunity.task") return previewOpportunityTask(db, auth, input);
  const member = requireTenant(auth), snapshot: ActionSnapshot = {};
  let detail = "", taskTitle = "", previousDraft = "", ownerId: string | null = member.id;
  if ("target" in input) {
    if ("taskId" in input.target) {
      const task = await actionTask(db, auth, input.target.taskId);
      snapshot.taskId = task.id; snapshot.taskHash = actionHash(task); taskTitle = task.title; ownerId = task.ownerMembershipId;
      previousDraft = task.messageDraft || "";
    } else {
      const source = prior.find(s => s.key === (input.target as { fromStep: string }).fromStep);
      if (!source || source.kind !== "task.create") throw new ApiError(422, "invalid", "Не найден предыдущий шаг создания задачи");
      taskTitle = source.title; ownerId = source.ownerMembershipId || member.id;
    }
    for (const prev of prior) if (prev.kind === "task.assign" && actionHash(prev.target) === actionHash(input.target)) ownerId = prev.membershipId;
  }
  const recipient = input.kind === "task.create" ? input.ownerMembershipId || member.id : "membershipId" in input ? input.membershipId : undefined;
  let memberName = "";
  if (recipient) {
    const result = await actionMember(db, member.tenantId, recipient);
    snapshot.memberId = recipient; snapshot.memberHash = result.hash; memberName = result.member.user.name;
    if (input.kind === "staff.notify") {
      const recipientAuth = await authForUserInTenant(db, result.member.userId, member.tenantId);
      assertTaskVisible(recipientAuth, { ownerMembershipId: ownerId });
      const pref = await db.notificationPreference.findUnique({ where: { tenantId_membershipId: { tenantId: member.tenantId, membershipId: recipient } } });
      if (object(pref?.channelsJson).in_app === false || object(pref?.eventsJson).tasks === false) throw new ApiError(409, "action_notifications_disabled", "У сотрудника отключены уведомления в BasQar.");
    }
  }
  if (input.kind === "task.create") {
    let contactLabel = "Без привязки к клиенту";
    if (input.contactId) {
      const result = await actionContact(db, member.tenantId, input.contactId);
      snapshot.contactId = input.contactId; snapshot.contactHash = result.hash; contactLabel = result.contact.name || "Клиент";
    }
    const due = input.dueAt ? new Date(input.dueAt).toLocaleString("ru-RU", { timeZone: member.tenant.timezone }) : "без срока";
    const types = { note: "Внутренняя задача", message: "Написать клиенту", proposal: "Подготовить предложение", follow_up: "Связаться повторно", meeting: "Встреча", send_documents: "Подготовить отправку документов" };
    detail = `${input.title}\n${types[input.type]} · ${contactLabel}\nОтветственный: ${memberName} · ${due}${input.description ? `\n${input.description}` : ""}`;
  } else if (input.kind === "task.assign") detail = `${taskTitle}\nОтветственный: ${memberName}`;
  else if (input.kind === "task.draft") detail = `${taskTitle}\n${previousDraft ? "Заменить текущий черновик новым текстом:\n" : ""}${input.text}`;
  else detail = `${taskTitle}\nКому: ${memberName}\n${input.text}`;
  return { snapshot, detail, label: AI_ACTION_REGISTRY[input.kind].label };
}
export async function recheckActionSnapshot(db: DomainDb, auth: AuthContext, snapshot: ActionSnapshot) {
  const tid = requireTenant(auth).tenantId;
  if (snapshot.memberId) {
    await db.$queryRaw`SELECT id FROM "Membership" WHERE "tenantId" = ${tid} AND id = ${snapshot.memberId} FOR SHARE`;
    await db.$queryRaw`SELECT u.id FROM "User" u JOIN "Membership" m ON m."userId" = u.id WHERE m."tenantId" = ${tid} AND m.id = ${snapshot.memberId} FOR SHARE OF u`;
    const current = await actionMember(db, tid, snapshot.memberId);
    if (current.hash !== snapshot.memberHash) throw new ApiError(409, "action_member_changed", "Данные или права сотрудника изменились. Подготовьте новый план.");
  }
  if (snapshot.contactId) {
    await db.$queryRaw`SELECT id FROM "Contact" WHERE "tenantId" = ${tid} AND id = ${snapshot.contactId} FOR SHARE`;
    if ((await actionContact(db, tid, snapshot.contactId)).hash !== snapshot.contactHash) throw new ApiError(409, "action_contact_changed", "Карточка клиента изменилась. Подготовьте новый план.");
  }
}
export async function executeAction(db: Prisma.TransactionClient, auth: AuthContext, input: ActionInput, taskId: string | null, runId: string) {
  if (input.kind === "opportunity.task") {
    const result = await executeOpportunityTask(db, auth, input, runId);
    const task = await db.task.findFirstOrThrow({ where: { id: result.taskId, tenantId: auth.activeMembership!.tenantId } });
    if (task.type !== "note" || task.source !== "control" || task.dedupeKey !== `opportunity:${input.insightId}` || task.ownerMembershipId !== input.ownerMembershipId || task.sentAt || task.confirmedAt) {
      throw new ApiError(409, "action_postcondition", "Не удалось подтвердить создание задачи. Изменения отменены.");
    }
    return { ...result, taskHash: actionHash(task) };
  }
  let id = taskId, notificationId: string | undefined, summary: string;
  if (input.kind === "task.create") {
    const task = await createTask(db, auth, { title: input.title, type: input.type, description: input.description,
      contactId: input.contactId, dueAt: input.dueAt, ownerMembershipId: input.ownerMembershipId, executorKind: "user", source: "control" });
    id = task.id; summary = "Задача создана";
  } else if (input.kind === "task.assign") {
    await assignTask(db, auth, id!, { membershipId: input.membershipId, executorKind: "user" }, { internalOnly: true });
    summary = "Ответственный назначен";
  } else if (input.kind === "task.draft") {
    await saveTaskDraftOnly(db, auth, id!, input.text); summary = "Черновик сохранён в задаче. Клиенту не отправлен";
  } else {
    const member = await actionMember(db, auth.activeMembership!.tenantId, input.membershipId);
    const recipientAuth = await authForUserInTenant(db, member.member.userId, auth.activeMembership!.tenantId);
    const task = await actionTask(db, auth, id!); assertTaskVisible(recipientAuth, task);
    const notice = await createStaffNotification(db, { tenantId: task.tenantId, membershipId: input.membershipId,
      type: "action.task_notice", entityType: "task", entityId: task.id, title: task.title, body: input.text,
      episodeKey: `action:${runId}:${input.key}`, channels: ["in_app"], internalOnly: true });
    if (!notice || !await db.notificationDelivery.findFirst({ where: { notificationId: notice.id, channel: "in_app", state: "delivered" } })) throw new ApiError(409, "action_notifications_disabled", "У сотрудника отключены уведомления в BasQar.");
    notificationId = notice.id; summary = "Уведомление добавлено в BasQar";
  }
  const task = await db.task.findFirstOrThrow({ where: { id: id!, tenantId: auth.activeMembership!.tenantId } });
  // Postconditions are checked before committing the effect and its ledger entry.
  if (input.kind === "task.assign" && task.ownerMembershipId !== input.membershipId
    || input.kind === "task.draft" && (task.messageDraft !== input.text || task.confirmedAt || task.sentAt)
    || input.kind === "task.create" && (task.title !== input.title || task.source !== "control")) {
    throw new ApiError(409, "action_postcondition", "Не удалось подтвердить результат шага. Изменения этого шага отменены.");
  }
  return { taskId: task.id, taskHash: actionHash(task), summary, ...(notificationId ? { notificationId } : {}) };
}
