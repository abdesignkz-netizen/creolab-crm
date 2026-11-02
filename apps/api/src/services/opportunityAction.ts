import type { Prisma } from "@creolab/db";
import type { ActionInput } from "@creolab/contracts";
import type { DomainDb } from "../lib/transaction.ts";
import type { AuthContext } from "../lib/types.ts";
import { ApiError } from "../errors.ts";
import { requireTenant } from "../lib/access.ts";
import { authorizeBusinessInsights, businessInsightView } from "./businessInsightService.ts";
import { loadBusinessEvidence, metricKey, type InsightKey } from "./businessMetricRegistry.ts";
import { createTask } from "./domainService.ts";
import { actionMember, actionHash, type ActionSnapshot } from "./aiActionRegistry.ts";

type Input = Extract<ActionInput, { kind: "opportunity.task" }>;
/** Runs under the action actor lock. Source locks are held through the task write.
 * All plans for overlapping reasons share this same tenant/source lock order. */
export async function validateOpportunityTask(db: DomainDb, auth: AuthContext, input: Input) {
  const { tenantId } = await authorizeBusinessInsights(db as Prisma.TransactionClient, auth), now = new Date();
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId}, 411012026))`;
  const row = await db.businessInsight.findFirst({ where: { tenantId, id: input.insightId, isCurrent: true, rule: { in: ["opportunity_deal", "opportunity_inquiry"] } } });
  if (!row) throw new ApiError(404, "not_found", "Возможность не найдена.");
  if (row.entityKind === "deal") {
    await db.$queryRaw`SELECT id FROM "Deal" WHERE "tenantId" = ${tenantId} AND id = ${row.entityId} FOR UPDATE`;
    await db.$queryRaw`SELECT i.id FROM "Inquiry" i JOIN "Deal" d ON d."tenantId" = i."tenantId" AND (d."inquiryId" = i.id OR i."dealId" = d.id) WHERE d."tenantId" = ${tenantId} AND d.id = ${row.entityId} ORDER BY i.id FOR UPDATE OF i`;
  } else await db.$queryRaw`SELECT id FROM "Inquiry" WHERE "tenantId" = ${tenantId} AND id = ${row.entityId} FOR UPDATE`;
  if (row.actionRunId || row.outcomeEventId) throw new ApiError(409, "opportunity_action_exists", "По этой возможности задача уже создана. Проверьте её результат в истории возможности.");
  const key = { rule: row.rule, entityKind: row.entityKind, entityId: row.entityId } as InsightKey;
  const { evidence } = await loadBusinessEvidence(db, auth, [key], now), fact = evidence.get(metricKey(key));
  if (!fact?.available || !fact.active || businessInsightView(row, fact, now).stale || !["open", "acknowledged"].includes(row.state)
    || row.version !== input.version || row.fingerprint !== input.fingerprint) {
    throw new ApiError(409, "insight_stale", "Данные возможности изменились. Проверьте её заново перед созданием задачи.");
  }
  if (fact.content.opportunity?.existingTask) throw new ApiError(409, "opportunity_task_exists", "Есть открытая задача по этой заявке или сделке. Проверьте её и укажите срок вместо создания дубликата.");
  const due = new Date(input.dueAt);
  if (due <= now || due.getTime() > now.getTime() + 366 * 86400000) throw new ApiError(422, "opportunity_due", "Укажите будущий срок задачи в пределах года.");
  const entity = row.entityKind === "deal" ? await db.deal.findFirstOrThrow({ where: { tenantId, id: row.entityId }, select: { contactId: true, companyId: true } })
    : await db.inquiry.findFirstOrThrow({ where: { tenantId, id: row.entityId }, select: { contactId: true, companyId: true } });
  await db.$queryRaw`SELECT id FROM "Contact" WHERE "tenantId" = ${tenantId} AND id = ${entity.contactId} FOR SHARE`;
  const contact = await db.contact.findFirst({ where: { tenantId, id: entity.contactId, archivedAt: null } });
  if (!contact) throw new ApiError(409, "action_contact_changed", "Клиент недоступен. Обновите возможность.");
  return { row, fact, contact, entity };
}

export async function previewOpportunityTask(db: DomainDb, auth: AuthContext, input: Input) {
  const { fact, contact } = await validateOpportunityTask(db, auth, input);
  const tenant = requireTenant(auth), { member, hash } = await actionMember(db, tenant.tenantId, input.ownerMembershipId);
  const snapshot: ActionSnapshot = { memberId: member.id, memberHash: hash, contactId: contact.id, contactHash: actionHash(contact) };
  return { snapshot, label: "Создать задачу по возможности", detail: `${fact.content.opportunity!.taskTitle}\nВнутренняя задача сотруднику\nОтветственный: ${member.user.name}\nСрок: ${new Date(input.dueAt).toLocaleString("ru-RU", { timeZone: tenant.tenant.timezone })}\n${fact.content.explanation}\nРезультат появится в карточке клиента и истории действий.` };
}

/** Uses the same transactional Task + Activity writer as other Control actions.
 * The outcome is task.created; it is not a sale, delivery or payment receipt. */
export async function executeOpportunityTask(db: Prisma.TransactionClient, auth: AuthContext, input: Input, runId: string) {
  const { row, fact, contact, entity } = await validateOpportunityTask(db, auth, input), tenantId = row.tenantId;
  const inquiry = row.entityKind === "inquiry" ? { id: row.entityId } : await db.inquiry.findFirst({ where: { tenantId, contactId: contact.id,
    OR: [{ dealId: row.entityId }, { id: (await db.deal.findUniqueOrThrow({ where: { id: row.entityId }, select: { inquiryId: true } })).inquiryId || "" }] }, orderBy: { id: "asc" }, select: { id: true } });
  const task = await createTask(db, auth, { type: "note", title: fact.content.opportunity!.taskTitle,
    description: `${fact.content.explanation}\nОжидаемый результат: проверить обращение или сделку, выполнить согласованный следующий шаг и записать результат в CRM.`,
    contactId: contact.id, ...(entity.companyId ? { companyId: entity.companyId } : {}),
    ...(row.entityKind === "deal" ? { dealId: row.entityId } : {}), ...(inquiry ? { inquiryId: inquiry.id } : {}),
    targetType: "none", executorKind: "user", ownerMembershipId: input.ownerMembershipId, dueAt: input.dueAt, source: "control" });
  await db.task.update({ where: { id: task.id }, data: { dedupeKey: `opportunity:${row.id}` } });
  const activity = await db.activity.findFirstOrThrow({ where: { tenantId, contactId: contact.id, type: "task.created", metadataJson: { path: ["taskId"], equals: task.id } } });
  const updated = await db.businessInsight.update({ where: { id: row.id }, data: { actionRunId: runId, outcomeEventId: activity.id, version: { increment: 1 } } });
  await db.businessInsightEvent.create({ data: { tenantId, insightId: row.id, type: "action_task_created", userId: auth.user.id, version: updated.version } });
  return { taskId: task.id, outcomeEventId: activity.id, summary: "Задача создана и записана в историю клиента. Результат работы по ней нужно отметить в CRM." };
}
