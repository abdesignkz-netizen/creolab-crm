import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@creolab/db";
import type { CrmReviewBlock, CrmReviewItem } from "@creolab/contracts";
import type { AuthContext } from "../lib/types.ts";
import { conversationAccessWhere, dealAccessWhere, inquiryAccessWhere, isManager, requireTenant, taskAccessWhere } from "../lib/access.ts";
import { ApiError } from "../errors.ts";
import { writeAudit } from "../lib/audit.ts";
import { deliveredConversationMessage } from "./conversationMessageState.ts";
import { listThreadConversationIds } from "./conversationThread.ts";
import { recordDealStageTransition } from "./dealStageHistory.ts";
import { hasCalendarConnection, hasCalendarHistory } from "./calendarSyncState.ts";
import { loadProcessEffects, processQueues, type ProcessEffects } from "./conversationProcessEffects.ts";

type Tx = Prisma.TransactionClient;
type Kind = "deal" | "agreement" | "task";
type State = Record<string, unknown>;
const obj = (v: unknown): State => v && typeof v === "object" && !Array.isArray(v) ? v as State : {};
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
function canonical(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)]));
  return v;
}
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(canonical(v ?? null))).digest("hex");
// Store scalars only, never ORM relations. Before/after data is server-owned and
// used solely with the explicit restore allowlists below.
const columns = {
  deal: "id tenantId number contactId companyId inquiryId stageId outcome title description offerAmountMinor currency probability paymentStatus fulfillmentStatus assigneeMembershipId nextAction nextActionAt lossReason createdAt updatedAt stageEnteredAt expectedCloseAt closedAt wonAt lostAt wonAmountMinor historicalMissingPhone version",
  agreement: "id tenantId contactId inquiryId dealId conversationId type title summary purpose status scheduledAt scheduledEndAt previousScheduledAt responsibleMembershipId locationName address meetingProvider meetingUrl meetingId meetingPassword phone sourceMessageIdsJson contextSnapshotJson remindersJson confidence detectedBy clarificationNeeded dedupeKey createdAt updatedAt completedAt cancelledAt",
  task: "id tenantId type title description contactId inquiryId conversationId dealId companyId incompleteIntakeId agreementId ownerMembershipId dueAt priority source status dedupeKey targetType parentTaskId segmentSnapshotJson contextSnapshotJson sourceMessageIdsJson purpose briefingText preparationHintsJson executionStatus messageDraft resultCode resultText completionSource confirmedAt sentAt rawCommandText parsedCommandJson commandStatus recurrenceRule completionResult createdAt completedAt",
} as const;
const snapshot = (kind: Kind, row: object) => obj(json(Object.fromEntries(columns[kind].split(" ").map(k => [k, obj(row)[k] ?? null]))));
const recordSchema = z.object({ kind: z.enum(["deal", "agreement", "task"]), id: z.string(), before: z.record(z.string(), z.unknown()).nullable(), after: z.record(z.string(), z.unknown()) });
const processSchema = z.object({
  schema: z.literal(2), entityType: z.literal("process"), conversationId: z.string(), contactId: z.string(), sourceMessageId: z.string(), messageRevision: z.number().int(),
  status: z.enum(["automatic", "accepted", "undone"]), evidenceMessageIds: z.array(z.string()).min(1).max(80), evidenceHash: z.string(),
  records: z.array(recordSchema).min(1).max(100),
  reminders: z.array(z.object({ agreementId: z.string(), before: z.array(z.record(z.string(), z.unknown())).max(100), after: z.array(z.record(z.string(), z.unknown())).max(100) })).max(30),
  outbox: z.array(z.record(z.string(), z.unknown())).max(10),
  linkedTasks: z.array(z.object({ id: z.string(), fingerprint: z.string() })).max(200),
  calendarLinked: z.boolean(),
  stageNames: z.record(z.string(), z.string()),
  memberNames: z.record(z.string(), z.string()).default({}),
  approvalId: z.string().optional(), appliedAt: z.string().datetime().optional(),
}).refine(r => new Set(r.records.map(x => `${x.kind}:${x.id}`)).size === r.records.length && r.records.every(x =>
  x.after.id === x.id && (!x.before || x.before.id === x.id) && (x.kind !== "deal" || x.before !== null)));
type Review = z.infer<typeof processSchema>;
export function readProcessReview(metadata: unknown): Review | null {
  const result = processSchema.safeParse(obj(metadata).review);
  return result.success ? result.data : null;
}

async function rowFor(tx: Tx, tid: string, kind: Kind, id: string) {
  if (kind === "deal") return tx.deal.findFirst({ where: { tenantId: tid, id } });
  if (kind === "agreement") return tx.agreement.findFirst({ where: { tenantId: tid, id } });
  return tx.task.findFirst({ where: { tenantId: tid, id } });
}
async function remindersFor(tx: Tx, tid: string, agreementId: string) {
  return tx.scheduledAction.findMany({ where: { tenantId: tid, parentType: "agreement", parentId: agreementId }, orderBy: { id: "asc" }, take: 101 });
}
async function linkedTasksFor(tx: Tx, tid: string, records: Review["records"]) {
  const deals = records.filter(r => r.kind === "deal").map(r => r.id), agreements = records.filter(r => r.kind === "agreement").map(r => r.id);
  const tasks = await tx.task.findMany({ where: { tenantId: tid, OR: [{ dealId: { in: deals } }, { agreementId: { in: agreements } }] }, orderBy: { id: "asc" }, take: 201 });
  return tasks.map(t => ({ id: t.id, fingerprint: hash(snapshot("task", t)) }));
}

/** Capture coupled writes in the same transaction as context application. */
export class ProcessReviewCapture {
  private records = new Map<string, { kind: Kind; id: string; before: State | null }>();
  private reminders = new Map<string, State[]>();
  private outbox: State[] = [];
  remember(kind: Kind, id: string, before: object | null) {
    if (!this.records.has(`${kind}:${id}`)) this.records.set(`${kind}:${id}`, { kind, id, before: before ? snapshot(kind, before) : null });
  }
  async beforeAgreement(tx: Tx, tid: string, id: string) {
    if (!this.reminders.has(id)) this.reminders.set(id, (await remindersFor(tx, tid, id)).map(r => obj(json(r))));
  }
  rememberOutbox(row: object | undefined) { if (row) this.outbox.push(obj(json(row))); }
  async save(tx: Tx, tid: string, input: { conversationId: string; contactId: string | null; sourceMessageId: string; messageRevision: number; evidenceMessageIds: string[] }, approval?: { activityId: string; metadata: unknown; actorUserId: string }) {
    if (!input.contactId || !this.records.size) return;
    const records: Review["records"] = [];
    for (const entry of this.records.values()) {
      const row = await rowFor(tx, tid, entry.kind, entry.id);
      if (!row) return; // Legacy/incomplete changes must not acquire an unsafe undo button.
      const after = snapshot(entry.kind, row);
      if (hash(after) !== hash(entry.before)) records.push({ ...entry, after });
    }
    if (!records.length) return;
    const reminders: Review["reminders"] = [];
    for (const entry of records.filter(r => r.kind === "agreement")) reminders.push({ agreementId: entry.id,
      before: this.reminders.get(entry.id) || [], after: (await remindersFor(tx, tid, entry.id)).map(r => obj(json(r))) });
    const conversation = await tx.conversation.findFirst({ where: { tenantId: tid, id: input.conversationId } });
    if (!conversation) return;
    const threads = await listThreadConversationIds(tx, tid, conversation);
    const ids = [...new Set(input.evidenceMessageIds)];
    const evidence = await sourceMessages(tx, tid, threads, ids);
    if (!ids.includes(input.sourceMessageId) || evidence.length !== ids.length) return;
    const stageIds = records.filter(r => r.kind === "deal").flatMap(r => [String(r.before?.stageId), String(r.after.stageId)]);
    const stages = await tx.dealStage.findMany({ where: { tenantId: tid, id: { in: stageIds } } });
    const agreementIds = records.filter(r => r.kind === "agreement").map(r => r.id);
    const calendarLinked = agreementIds.length > 0 && (await hasCalendarConnection(tx, tid) || await hasCalendarHistory(tx, tid, agreementIds));
    const memberIds = [...new Set(records.flatMap(r => [r.before, r.after].flatMap(row => row ? [row.ownerMembershipId, row.responsibleMembershipId].filter((id): id is string => typeof id === "string") : [])))];
    const members = await tx.membership.findMany({ where: { tenantId: tid, id: { in: memberIds } }, include: { user: { select: { name: true } } } });
    const parsed = processSchema.safeParse({ ...input, schema: 2, entityType: "process", status: approval ? "accepted" : "automatic", records, reminders, outbox: this.outbox, linkedTasks: await linkedTasksFor(tx, tid, records), calendarLinked,
      evidenceMessageIds: ids, evidenceHash: hash(evidence), ...(approval ? { approvalId: approval.activityId, appliedAt: new Date().toISOString() } : {}), memberNames: Object.fromEntries(members.map(m => [m.id, m.user.name || "Сотрудник"])), stageNames: Object.fromEntries(stages.map(s => [s.id, s.name])) });
    if (!parsed.success) return;
    if (approval) return tx.activity.update({ where: { id: approval.activityId, tenantId: tid }, data: {
      title: "Подтверждены действия по переписке", metadataJson: json({ ...obj(approval.metadata), review: parsed.data, reviewedBy: approval.actorUserId, reviewedAt: new Date().toISOString() }),
    } });
    return tx.activity.create({ data: { tenantId: tid, contactId: input.contactId, type: "conversation.crm_updated", title: "ИИ обновил договорённости и связанные действия",
      description: records.map(r => `${r.kind === "deal" ? "Сделка" : r.kind === "task" ? "Задача" : "Договорённость"}: ${r.after.title}`).join("\n"), actorType: "ai", metadataJson: json({ review: parsed.data }) } });
  }
}

const sourceMessages = (tx: Tx, tid: string, threads: string[], ids: string[]) => tx.message.findMany({ where: {
  tenantId: tid, conversationId: { in: threads }, id: { in: ids }, ...deliveredConversationMessage,
}, select: { id: true, conversationId: true, text: true, createdAt: true, senderKind: true, direction: true }, orderBy: { id: "asc" } });

type ScopedRecords = { rows: Map<string, object>; visibleInquiryIds: Set<string> };
type LoadedReview = ScopedRecords & {
  conversation: { contactId: string | null; messageRevision: number } | null;
  evidence: Awaited<ReturnType<typeof sourceMessages>>;
  visibleThreads: Set<string>;
  latestMessageId?: string;
  timezone: string;
  effects: ProcessEffects;
};

/** One bounded batch per entity type for the history list. Never reused by undo. */
export async function loadProcessReviewRecords(tx: Tx, auth: AuthContext, reviews: Array<Pick<Review, "records">>): Promise<ScopedRecords> {
  const membership = requireTenant(auth), manager = isManager(auth);
  const ids = (kind: Kind) => [...new Set(reviews.flatMap(r => r.records.filter(x => x.kind === kind).map(x => x.id)))];
  const [deals, agreements, tasks] = await Promise.all([
    tx.deal.findMany({ where: { AND: [dealAccessWhere(auth), { id: { in: ids("deal") } }] } }),
    tx.agreement.findMany({ where: { tenantId: membership.tenantId, id: { in: ids("agreement") }, ...(manager ? { responsibleMembershipId: membership.id } : {}) } }),
    tx.task.findMany({ where: { AND: [taskAccessWhere(auth), { id: { in: ids("task") } }] } }),
  ]);
  const rows = new Map<string, object>([
    ...deals.map(r => [`deal:${r.id}`, r] as const), ...agreements.map(r => [`agreement:${r.id}`, r] as const), ...tasks.map(r => [`task:${r.id}`, r] as const),
  ]);
  const inquiryIds = [...new Set([...rows.values()].map(r => obj(r).inquiryId).filter((id): id is string => typeof id === "string"))];
  const inquiries = manager && inquiryIds.length ? await tx.inquiry.findMany({ where: { AND: [inquiryAccessWhere(auth), { id: { in: inquiryIds } }] }, select: { id: true } }) : [];
  return { rows, visibleInquiryIds: new Set(inquiries.map(r => r.id)) };
}

/** Shared by the review panel and the existing contact history. */
export async function processReviewVisible(tx: Tx, auth: AuthContext, review: Review, loaded?: ScopedRecords) {
  const tid = requireTenant(auth).tenantId;
  const me = auth.activeMembership!.id;
  for (const record of review.records) {
    if (record.after.tenantId !== tid || record.before && record.before.tenantId !== tid) return false;
    const row = loaded ? loaded.rows.get(`${record.kind}:${record.id}`) : await rowFor(tx, tid, record.kind, record.id);
    if (!row || obj(row).contactId !== review.contactId) return false;
    if (record.kind === "agreement" && obj(row).conversationId !== review.conversationId) return false;
    if (isManager(auth)) {
      if (!loaded && record.kind === "deal" && !await tx.deal.findFirst({ where: { AND: [dealAccessWhere(auth), { id: record.id }] }, select: { id: true } })) return false;
      if (!loaded && record.kind === "task" && !await tx.task.findFirst({ where: { AND: [taskAccessWhere(auth), { id: record.id }] }, select: { id: true } })) return false;
      if (record.kind === "agreement" && obj(row).responsibleMembershipId !== me) return false;
      if (obj(row).inquiryId && (loaded ? !loaded.visibleInquiryIds.has(String(obj(row).inquiryId)) : !await tx.inquiry.findFirst({ where: { AND: [inquiryAccessWhere(auth), { id: String(obj(row).inquiryId) }] }, select: { id: true } }))) return false;
    }
  }
  return true;
}

async function assess(tx: Tx, auth: AuthContext, review: Review, createdAt: Date, loaded?: LoadedReview) {
  const tid = requireTenant(auth).tenantId;
  if (!await processReviewVisible(tx, auth, review, loaded)) return null;
  const conversation = loaded ? loaded.conversation : await tx.conversation.findFirst({ where: { tenantId: tid, id: review.conversationId } });
  if (!conversation || conversation.contactId !== review.contactId) return null;
  const threads = loaded ? [] : await listThreadConversationIds(tx, tid, { ...conversation, id: review.conversationId });
  const evidence = loaded ? loaded.evidence.filter(m => review.evidenceMessageIds.includes(m.id)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : await sourceMessages(tx, tid, threads, review.evidenceMessageIds);
  if (loaded ? evidence.some(m => !loaded.visibleThreads.has(m.conversationId))
    : await tx.conversation.count({ where: { AND: [conversationAccessWhere(auth), { id: { in: [...new Set(evidence.map(e => e.conversationId))] } }] } }) !== new Set(evidence.map(e => e.conversationId)).size) return null;
  let blockedReason: CrmReviewBlock = null;
  // Coupled task scheduling follows the existing manager restrictions.
  if (isManager(auth)) blockedReason = "permissions";
  const latestId = loaded ? loaded.latestMessageId : (await tx.message.findFirst({ where: { tenantId: tid, conversationId: { in: threads }, ...deliveredConversationMessage }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }))?.id;
  if (!blockedReason && (conversation.messageRevision !== review.messageRevision || latestId !== review.sourceMessageId || hash(evidence) !== review.evidenceHash)) blockedReason = "conversation_changed";
  if (blockedReason || review.status === "undone") return { evidence, blockedReason };
  const ids = (kind: Kind) => review.records.filter(r => r.kind === kind).map(r => r.id);
  const agreementIds = ids("agreement"), taskIds = ids("task"), dealIds = ids("deal");
  for (const record of review.records) {
    const current = loaded ? loaded.rows.get(`${record.kind}:${record.id}`) : await rowFor(tx, tid, record.kind, record.id);
    if (!blockedReason && (!current || hash(snapshot(record.kind, current)) !== hash(record.after))) blockedReason = "changed";
  }
  if (!blockedReason && hash(await linkedTasksFor(tx, tid, review.records)) !== hash(review.linkedTasks)) blockedReason = "related_activity";
  const memberIds = [...new Set(review.records.flatMap(r => [r.before, r.after].flatMap(s => s ? [s.ownerMembershipId, s.responsibleMembershipId, s.assigneeMembershipId].filter((id): id is string => typeof id === "string") : [])))];
  if (!blockedReason && memberIds.length && await tx.membership.count({ where: { tenantId: tid, id: { in: memberIds }, active: true } }) !== memberIds.length) blockedReason = "related_activity";
  const inquiryIds = [...new Set(review.records.flatMap(r => [r.before?.inquiryId, r.after.inquiryId].filter((id): id is string => typeof id === "string")))];
  if (!blockedReason && inquiryIds.length && await tx.inquiry.count({ where: { tenantId: tid, id: { in: inquiryIds }, contactId: review.contactId, archived: false } }) !== inquiryIds.length) blockedReason = "related_activity";
  // Tasks have no version column. The normal audit also protects same-value
  // saves and edits that were later changed back.
  const manual = await tx.auditEvent.findMany({ where: { tenantId: tid, actorUserId: { not: null }, createdAt: { gte: review.appliedAt ? new Date(review.appliedAt) : createdAt }, OR: review.records.map(r => ({ entityType: r.kind, entityId: r.id })) }, select: { action: true, changesJson: true }, take: 101 });
  if (!blockedReason && (manual.length > 100 || manual.some(a => !review.approvalId || a.action !== "conversation.crm_reviewed" || obj(a.changesJson).proposalId !== review.approvalId))) blockedReason = "changed";
  for (const group of review.reminders) {
    const current = (await remindersFor(tx, tid, group.agreementId)).map(r => obj(json(r)));
    if (!blockedReason && hash(current) !== hash(group.after)) blockedReason = "effects_started";
    if (!blockedReason && group.after.some(a => !["scheduled", "canceled"].includes(String(a.state)))) blockedReason = "effects_started";
    if (!blockedReason && group.before.some(a => !["scheduled", "canceled"].includes(String(a.state)))) blockedReason = "effects_started";
  }
  for (const event of review.outbox) {
    const current = await tx.outboxEvent.findFirst({ where: { tenantId: tid, id: String(event.id) } });
    if (!blockedReason && (!current || hash(json(current)) !== hash(event) || current.processedAt || current.attempts)) blockedReason = "effects_started";
  }
  if (!blockedReason && agreementIds.length && (review.calendarLinked || await hasCalendarConnection(tx, tid) || await hasCalendarHistory(tx, tid, agreementIds))) blockedReason = "calendar";
  // Already queued/sent notices require a separate, explicit reconciliation;
  // changing a local record must never pretend to recall an external message.
  if (!blockedReason && agreementIds.length && await tx.notification.count({ where: { tenantId: tid, entityType: "agreement", entityId: { in: agreementIds } } })) blockedReason = "effects_started";
  const confirmationKeys = agreementIds.map(id => createHash("sha256").update(`agreement-confirmation:${id}:${review.sourceMessageId}`).digest("hex"));
  if (!blockedReason && confirmationKeys.length && await tx.controlNotificationItem.count({ where: { rule: { tenantId: tid }, eventKey: { in: confirmationKeys } } })) blockedReason = "effects_started";
  if (!blockedReason && taskIds.length && (await tx.executionConfirmation.count({ where: { tenantId: tid, taskId: { in: taskIds } } }) ||
    await tx.task.count({ where: { tenantId: tid, parentTaskId: { in: taskIds } } }) ||
    await tx.attachment.count({ where: { tenantId: tid, parentType: "task", parentId: { in: taskIds } } }) ||
    await tx.scheduledAction.count({ where: { tenantId: tid, parentType: "task", parentId: { in: taskIds } } }))) blockedReason = "related_activity";
  if (!blockedReason && agreementIds.length && await tx.task.count({ where: { tenantId: tid, agreementId: { in: agreementIds }, id: { notIn: taskIds } } })) blockedReason = "related_activity";
  if (!blockedReason && dealIds.length && (await tx.dealItem.count({ where: { tenantId: tid, dealId: { in: dealIds } } }) ||
    await tx.paymentRecord.count({ where: { tenantId: tid, dealId: { in: dealIds } } }) ||
    await tx.invoice.count({ where: { tenantId: tid, dealId: { in: dealIds } } }) ||
    await tx.contract.count({ where: { tenantId: tid, dealId: { in: dealIds } } }) ||
    await tx.electronicDocument.count({ where: { tenantId: tid, dealId: { in: dealIds } } }))) blockedReason = "related_activity";
  for (const record of review.records.filter(r => r.kind === "deal")) {
    const stages = await tx.dealStage.findMany({ where: { tenantId: tid, id: { in: [String(record.before!.stageId), String(record.after.stageId)] } } });
    if (!blockedReason && (stages.length !== new Set([record.before!.stageId, record.after.stageId]).size || stages.some(s => s.isTerminal || s.isArchived) || record.after.outcome !== "open")) blockedReason = "related_activity";
  }
  return { evidence, blockedReason };
}

const displayKeys: Record<Kind, Record<string, string>> = {
  deal: { stageId: "Стадия сделки", offerAmountMinor: "Сумма сделки", probability: "Вероятность, %", nextAction: "Следующий шаг", nextActionAt: "Срок следующего шага" },
  agreement: { title: "Название", status: "Статус договорённости", scheduledAt: "Начало", scheduledEndAt: "Окончание", summary: "Описание", purpose: "Цель", locationName: "Место", address: "Адрес", phone: "Телефон", meetingUrl: "Ссылка на встречу", clarificationNeeded: "Нужно уточнить", responsibleMembershipId: "Ответственный" },
  task: { title: "Название", status: "Статус задачи", dueAt: "Срок", description: "Описание", purpose: "Цель", preparationHintsJson: "Подготовка", ownerMembershipId: "Исполнитель" },
};
const stateLabels: Record<string, string> = { open: "К выполнению", done: "Завершена", canceled: "Отменена", waiting: "Ожидание", in_progress: "В работе", DETECTED: "Выявлена", NEEDS_CLARIFICATION: "Нужно уточнить", CONFIRMED: "Подтверждена", SCHEDULED: "Запланирована", RESCHEDULED: "Перенесена", CANCELLED: "Отменена", COMPLETED: "Завершена", MISSED: "Пропущена" };
export function formatProcessEntries(records: Review["records"], stageNames: Record<string, string>, memberNames: Record<string, string>, timezone: string) {
  const display = (key: string, value: unknown, row: State) => value == null ? key === "dueAt" ? "Без срока" : null : key === "preparationHintsJson" ? Array.isArray(value) && value.length ? value.join("\n") : null : key === "stageId" ? stageNames[String(value)] || "Стадия"
    : key.endsWith("MembershipId") ? memberNames[String(value)] || "Сотрудник" : key === "status" ? stateLabels[String(value)] || String(value) : key.endsWith("At") ? new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: timezone }).format(new Date(String(value)))
    : key === "offerAmountMinor" ? `${value} ${row.currency}` : String(value);
  return records.map(r => ({ entityType: r.kind, entityId: r.id, title: String(r.after.title), created: !r.before,
    fields: Object.entries(displayKeys[r.kind]).filter(([key]) => r.before ? hash(r.before[key]) !== hash(r.after[key]) : key === "preparationHintsJson" ? Array.isArray(r.after[key]) && r.after[key].length > 0 : r.after[key] != null || key.endsWith("MembershipId") || key === "dueAt").map(([key, label]) => ({ label, status: key === "status" || key === "dueAt" && !r.after[key], before: r.before ? display(key, r.before[key], r.before) : null, after: display(key, r.after[key], r.after) })) }));
}
export async function processReviewItem(tx: Tx, auth: AuthContext, activity: { id: string; createdAt: Date }, review: Review, loaded?: LoadedReview): Promise<CrmReviewItem | null> {
  const state = await assess(tx, auth, review, activity.createdAt, loaded);
  if (!state) return null;
  const timezone = loaded ? loaded.timezone : (await tx.tenant.findUniqueOrThrow({ where: { id: requireTenant(auth).tenantId }, select: { timezone: true } })).timezone;
  const agreementIds = review.records.filter(r => r.kind === "agreement").map(r => r.id);
  const outboxIds = review.outbox.map(e => String(e.id));
  const effects = loaded?.effects || await loadProcessEffects(tx, requireTenant(auth).tenantId, agreementIds, outboxIds);
  const queues = processQueues(effects, agreementIds, outboxIds);
  return { id: activity.id, entityType: "process", entityId: review.conversationId, status: review.status, confidence: "HIGH", createdAt: activity.createdAt.toISOString(), fields: [],
    evidence: state.evidence.map(({ conversationId: _, ...m }) => ({ ...m, createdAt: m.createdAt.toISOString() })),
    canAccept: false, canDismiss: false, canUndo: review.status !== "undone" && !state.blockedReason, blockedReason: review.status !== "undone" ? state.blockedReason : null,
    process: { reminders: queues.find(q => q.kind === "reminders")?.queued || 0, queues,
      entries: formatProcessEntries(review.records, review.stageNames, review.memberNames, timezone),
      calendarEffects: effects.calendar.filter(e => agreementIds.includes(e.agreementId)) } };

}

async function lockRecords(tx: Tx, tid: string, review: Review) {
  for (const r of [...review.records].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`))) {
    if (r.kind === "deal") await tx.$queryRaw`SELECT id FROM "Deal" WHERE id = ${r.id} AND "tenantId" = ${tid} FOR UPDATE`;
    if (r.kind === "agreement") await tx.$queryRaw`SELECT id FROM "Agreement" WHERE id = ${r.id} AND "tenantId" = ${tid} FOR UPDATE`;
    if (r.kind === "task") await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${r.id} AND "tenantId" = ${tid} FOR UPDATE`;
  }
  for (const task of review.linkedTasks) if (!review.records.some(r => r.kind === "task" && r.id === task.id)) await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${task.id} AND "tenantId" = ${tid} FOR UPDATE`;
  for (const g of review.reminders) await tx.$queryRaw`SELECT id FROM "ScheduledAction" WHERE "tenantId" = ${tid} AND "parentType" = 'agreement' AND "parentId" = ${g.agreementId} ORDER BY id FOR UPDATE`;
  for (const e of review.outbox) await tx.$queryRaw`SELECT id FROM "OutboxEvent" WHERE id = ${String(e.id)} AND "tenantId" = ${tid} FOR UPDATE`;
}
function restoreData(kind: Kind, before: State) {
  const keys = kind === "deal" ? "offerAmountMinor stageId probability nextAction nextActionAt".split(" ")
    : columns[kind].split(" ").filter(k => !["id", "tenantId", "createdAt", "updatedAt"].includes(k));
  return Object.fromEntries(keys.map(k => [k, k.endsWith("At") && before[k] != null ? new Date(String(before[k])) : before[k]]));
}
/** Called by the existing decision endpoint with the conversation already locked. */
export async function undoProcessReview(tx: Tx, auth: AuthContext, activity: { id: string; createdAt: Date; metadataJson: unknown }, review: Review, decision: string) {
  const tid = requireTenant(auth).tenantId;
  await lockRecords(tx, tid, review);
  const state = await assess(tx, auth, review, activity.createdAt);
  if (!state) throw new ApiError(404, "not_found", "Изменение не найдено");
  if (isManager(auth)) throw new ApiError(403, "forbidden", "Отмена связанных действий доступна руководителю");
  if (decision === "accept" && review.status === "accepted") return { status: "accepted" };
  if (decision !== "undo") throw new ApiError(409, "crm_review_closed", "Это автоматическое изменение можно только отменить");
  if (review.status === "undone") return { status: "undone" };
  if (state.blockedReason) throw new ApiError(409, "crm_review_changed", "Связанные записи или действия изменились. Обновите список и проверьте причину перед отменой.");
  const now = new Date();
  // New objects stay in history as cancelled, never disappear. Free a task's
  // unique key only when undo restores that key to an earlier task.
  for (const r of review.records.filter(r => r.kind === "task" && !r.before)) {
    const conflict = review.records.some(other => other.kind === "task" && other.before?.dedupeKey && other.before.dedupeKey === r.after.dedupeKey);
    await tx.task.update({ where: { id: r.id, tenantId: tid }, data: { status: "canceled", completedAt: now, ...(conflict ? { dedupeKey: null } : {}) } });
  }
  for (const r of review.records) {
    if (r.kind === "task" && r.before) await tx.task.update({ where: { id: r.id, tenantId: tid }, data: restoreData("task", r.before) as Prisma.TaskUncheckedUpdateInput });
    if (r.kind === "agreement") await tx.agreement.update({ where: { id: r.id, tenantId: tid }, data: r.before ? restoreData("agreement", r.before) as Prisma.AgreementUncheckedUpdateInput : { status: "CANCELLED", cancelledAt: now } });
    if (r.kind === "deal") {
      const changedStage = r.before!.stageId !== r.after.stageId;
      await tx.deal.update({ where: { id: r.id, tenantId: tid, version: Number(r.after.version) }, data: { ...restoreData("deal", r.before!), version: { increment: 1 }, ...(changedStage ? { stageEnteredAt: now } : {}) } as Prisma.DealUncheckedUpdateInput });
      if (changedStage) {
        const from = await tx.dealStage.findUniqueOrThrow({ where: { id: String(r.after.stageId) } }), to = await tx.dealStage.findUniqueOrThrow({ where: { id: String(r.before!.stageId) } });
        await recordDealStageTransition(tx, { tenantId: tid, dealId: r.id, fromStageId: from.id, fromSystemKey: from.systemKey, toStageId: to.id, toSystemKey: to.systemKey, enteredAt: now, changedByType: "user", changedById: auth.user.id, note: "Отменено изменение ИИ по переписке" });
      }
    }
    await writeAudit(tx, { tenantId: tid, actorUserId: auth.user.id, action: "conversation.crm_undone", entityType: r.kind, entityId: r.id, correlationId: review.sourceMessageId,
      changes: { proposalId: activity.id, conversationId: review.conversationId, before: r.after, after: await rowFor(tx, tid, r.kind, r.id) } });
  }
  for (const g of review.reminders) {
    for (const after of g.after) {
      const before = g.before.find(b => b.id === after.id);
      if (hash(before) === hash(after)) continue;
      const dueAt = before ? new Date(String(before.dueAt)) : null;
      const restore = before?.state === "scheduled" && dueAt && dueAt > now;
      await tx.scheduledAction.update({ where: { id: String(after.id), tenantId: tid, version: Number(after.version) }, data: {
        state: restore ? "scheduled" : "canceled", cancelReason: restore ? null : "crm_review_undone", version: { increment: 1 },
        ...(before ? { dueAt: dueAt!, payloadJson: json(before.payloadJson) } : {}),
      } });
    }
  }
  for (const e of review.outbox) await tx.outboxEvent.update({ where: { id: String(e.id), tenantId: tid }, data: { processedAt: now, payloadJson: json({ ...obj(e.payloadJson), canceledByCrmReview: activity.id }) } });
  await tx.activity.update({ where: { id: activity.id }, data: { metadataJson: json({ ...obj(activity.metadataJson), review: { ...review, status: "undone" }, reviewedBy: auth.user.id, reviewedAt: now.toISOString() }) } });
  await tx.activity.create({ data: { tenantId: tid, contactId: review.contactId, type: "conversation.crm_undone", title: "Отменены связанные изменения ИИ", description: "Прежние записи восстановлены; новые задачи и договорённости отменены. История сохранена.", actorType: "user", actorId: auth.user.id,
    metadataJson: json({ proposalId: activity.id, conversationId: review.conversationId, evidenceMessageIds: review.evidenceMessageIds, processRecords: review.records.map(r => ({ kind: r.kind, id: r.id })) }) } });
  return { status: "undone" };
}

// Shared with pending proposals; decision handlers always re-read under locks.
export { hash as processFingerprint, snapshot as processSnapshot, rowFor as processRow, sourceMessages as processSources, remindersFor as processReminders, linkedTasksFor as processLinkedTasks };
