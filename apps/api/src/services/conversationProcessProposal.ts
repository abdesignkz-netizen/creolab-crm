import { z } from "zod";
import type { Prisma } from "@creolab/db";
import type { CrmReviewBlock, CrmReviewItem } from "@creolab/contracts";
import type { AuthContext } from "../lib/types.ts";
import { conversationAccessWhere, dealAccessWhere, inquiryAccessWhere, isManager, requireTenant } from "../lib/access.ts";
import { ApiError } from "../errors.ts";
import { writeAudit } from "../lib/audit.ts";
import { deliveredConversationMessage } from "./conversationMessageState.ts";
import { listThreadConversationIds } from "./conversationThread.ts";
import { resolveContextDeal } from "./conversationContextService.ts";
import { parseAIAutomationSettings } from "./aiAutomationSettings.ts";
import { decideAutomationPolicy } from "./aiAutomationPolicyService.ts";
import { getEffectiveTenantSettings } from "./runtimeSettings.ts";
import { publishedIntakePolicy } from "./aiIntakeService.ts";
import { hasCalendarConnection, hasCalendarHistory } from "./calendarSyncState.ts";
import { applyContextProcess, defaultReminders, prepareContextProcess, type ProcessInput } from "./conversationProcessChanges.ts";
import { ProcessReviewCapture, formatProcessEntries, loadProcessReviewRecords, processFingerprint as hash, processLinkedTasks, processReminders, processSnapshot, processSources } from "./conversationProcessReview.ts";
import { prepareSuggestedTasks, suggestedTaskContext } from "./conversationSuggestedTasks.ts";

type Tx = Prisma.TransactionClient;
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const operation = z.object({ kind: z.enum(["deal", "agreement", "task"]), id: z.string(), before: z.record(z.string(), z.unknown()).nullable(), data: z.record(z.string(), z.unknown()), eventType: z.string(), confidence: z.enum(["HIGH", "MEDIUM", "LOW"]) });
const schema = z.object({
  schema: z.literal(3), entityType: z.literal("process"), status: z.enum(["pending", "dismissed", "superseded"]),
  conversationId: z.string(), contactId: z.string(), sourceMessageId: z.string(), messageRevision: z.number().int(),
  evidenceMessageIds: z.array(z.string()).min(1).max(80), evidenceHash: z.string(), environmentHash: z.string(),
  records: z.array(operation).min(1).max(100),
  reminders: z.array(z.object({ agreementId: z.string(), rows: z.array(z.record(z.string(), z.unknown())).max(100) })).max(30),
  linkedTasks: z.array(z.object({ id: z.string(), fingerprint: z.string() })).max(200),
  taskContext: z.object({
    scope: z.object({ contactId: z.string(), conversationId: z.string(), inquiryId: z.string().nullable(), dealId: z.string().nullable(), sourceMessageId: z.string() }),
    rows: z.array(z.object({ id: z.string(), fingerprint: z.string() })).max(200),
  }).optional(),
  stages: z.array(z.record(z.string(), z.unknown())).max(10),
  stageNames: z.record(z.string(), z.string()), memberNames: z.record(z.string(), z.string()), calendarSync: z.boolean(),
}).refine(r => new Set(r.records.map(x => `${x.kind}:${x.id}`)).size === r.records.length
  && r.records.every(x => x.kind !== "deal" || x.before !== null)
  && (!r.taskContext || r.taskContext.scope.contactId === r.contactId && r.taskContext.scope.conversationId === r.conversationId && r.taskContext.scope.sourceMessageId === r.sourceMessageId));
type Proposal = z.infer<typeof schema>;
export function readProcessProposal(metadata: unknown): Proposal | null {
  const result = schema.safeParse(object(metadata).review);
  return result.success ? result.data : null;
}
const projections = (p: Pick<Proposal, "records">, tid: string) => p.records.map(r => ({ kind: r.kind, id: r.id, before: r.before, after: { ...r.before, ...r.data, id: r.id, tenantId: tid } }));

// New rows receive random ids during preparation; they are not a meaningful
// change. Execution timestamps are assigned only when the proposal is applied.
function proposalFingerprint(p: Proposal) {
  const names = new Map(p.records.filter(r => !r.before).map((r, i) => [r.id, `new:${r.kind}:${i}`]));
  const records = p.records.map(r => ({ ...r, id: names.get(r.id) || r.id, data: Object.fromEntries(Object.entries(r.data)
    .filter(([k]) => !["stageEnteredAt", "completedAt", "cancelledAt"].includes(k)).map(([k, v]) => [k, k === "dedupeKey" && r.kind === "task" && r.data.agreementId
      ? `task-agr:${names.get(String(r.data.agreementId)) || r.data.agreementId}` : typeof v === "string" ? names.get(v) || v : v])) }));
  return hash({ ...p, status: "pending", records });
}

async function supersedePending(tx: Tx, tid: string, conversationId: string) {
  const pending = await tx.activity.findMany({ where: { tenantId: tid, type: "conversation.crm_proposed", AND: [
    { metadataJson: { path: ["review", "conversationId"], equals: conversationId } }, { metadataJson: { path: ["review", "schema"], equals: 3 } }, { metadataJson: { path: ["review", "status"], equals: "pending" } },
  ] } });
  for (const old of pending) {
    const previous = readProcessProposal(old.metadataJson);
    if (previous) await tx.activity.update({ where: { id: old.id }, data: { metadataJson: json({ ...object(old.metadataJson), review: { ...previous, status: "superseded" } }) } });
  }
}

/** Only current server settings determine whether a stored proposal may apply. */
async function environment(tx: Tx, tid: string, conversationId: string) {
  const [tenant, conversation] = await Promise.all([
    tx.tenant.findUniqueOrThrow({ where: { id: tid } }),
    tx.conversation.findFirst({ where: { tenantId: tid, id: conversationId }, include: {
      contact: true, connection: { include: { integration: true } },
      inquiries: { where: { tenantId: tid, archived: false }, orderBy: { receivedAt: "desc" }, take: 1 },
    } }),
  ]);
  if (!conversation?.contactId || !conversation.contact || conversation.contact.archivedAt) return null;
  const inquiry = conversation.inquiries[0];
  const integration = conversation.connection?.integration || (inquiry?.integrationId ? await tx.integration.findFirst({ where: { tenantId: tid, id: inquiry.integrationId } }) : null);
  const settings = parseAIAutomationSettings(tenant.settingsJson);
  const policy = decideAutomationPolicy({ settingsJson: tenant.settingsJson, interaction: "crm", sourceChannel: conversation.connection?.channelType || inquiry?.sourceChannel,
    source: inquiry?.source, serviceCategory: inquiry?.serviceCategory, integrationId: integration?.id, integrationAutomationMode: integration?.automationMode,
    clientAiMode: object(conversation.contact.attributionJson).aiAutomation as string | null,
    requestOverrideMode: object(inquiry?.fieldMetaJson).automationOverride as string | null });
  const [runtime, intakePolicy, deal, calendarSync] = await Promise.all([
    getEffectiveTenantSettings(tx, tid), publishedIntakePolicy(tx, tid), resolveContextDeal(tx, tid, conversationId, conversation.contactId, inquiry?.dealId),
    hasCalendarConnection(tx, tid),
  ]);
  const allowed = tenant.status === "active" && runtime.ai.enabled && settings.analyzeNewRequests && settings.crm.enabled && policy.analyze
    && integration?.status !== "disabled" && integration?.connectionStatus !== "DISCONNECTED";
  const signature = hash({ allowed, crm: settings.crm, policy, intakePolicy, calendarSync,
    conversation: { contactId: conversation.contactId, assigneeMembershipId: conversation.assigneeMembershipId, mode: conversation.mode, controlVersion: conversation.controlVersion, connectionId: conversation.connectionId },
    contactOwner: conversation.contact.ownerMembershipId, inquiry: inquiry ? { id: inquiry.id, contactId: inquiry.contactId, dealId: inquiry.dealId, assigneeMembershipId: inquiry.assigneeMembershipId, archived: inquiry.archived, status: inquiry.status } : null,
    dealId: deal?.id || null, integration: integration ? { id: integration.id, status: integration.status, connectionStatus: integration.connectionStatus } : null,
  });
  return { tenant, conversation, inquiry, settings, deal, allowed, signature, calendarSync };
}

export async function proposeProcessChanges(tx: Tx, tid: string, input: Pick<ProcessInput, "result" | "evidenceMessages">, conversationId: string, options: { tasksOnly?: boolean } = {}) {
  const sourceMessageId = input.result.sourceMessageId;
  if (!sourceMessageId) return;
  const proposalKey = hash(["process", conversationId, sourceMessageId]);
  const previous = await tx.activity.findMany({ where: { tenantId: tid, type: "conversation.crm_proposed", metadataJson: { path: ["proposalKey"], equals: proposalKey } }, orderBy: { createdAt: "desc" } });
  // A dismissed/applied/undone decision must never be revived by re-analysis.
  if (previous.some(a => !["pending", "superseded"].includes(String(object(object(a.metadataJson).review).status)))) return;
  const env = await environment(tx, tid, conversationId);
  if (!env?.allowed) return;
  // Monetary facts are reviewed separately. Approval here never changes price/payment state.
  const processInput = { ...input, ...env, allowAmount: false };
  const plan = options.tasksOnly ? { records: [], scheduled: [] } : await prepareContextProcess(tx, tid, processInput);
  const tasks = await prepareSuggestedTasks(tx, tid, processInput, plan.records);
  const records = [...plan.records, ...tasks.records];
  const ids = [...new Set([...input.result.analysis.evidenceMessageIds, ...plan.scheduled.flatMap(a => a.evidenceMessageIds), ...tasks.evidence])];
  const threads = await listThreadConversationIds(tx, tid, env.conversation);
  const evidence = await processSources(tx, tid, threads, ids);
  const latest = await tx.message.findFirst({ where: { tenantId: tid, conversationId: { in: threads }, ...deliveredConversationMessage }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  if (env.conversation.messageRevision !== input.result.messageRevision || latest?.id !== sourceMessageId || !input.evidenceMessages.some(m => m.id === sourceMessageId)) return;
  if (!records.length || !ids.includes(sourceMessageId) || evidence.length !== ids.length) {
    await supersedePending(tx, tid, conversationId);
    return;
  }
  const reminders = [];
  for (const r of records.filter(r => r.kind === "agreement" && r.before)) reminders.push({ agreementId: r.id, rows: await processReminders(tx, tid, r.id) });
  const stageIds = records.filter(r => r.kind === "deal").flatMap(r => [String(r.before?.stageId), String(r.data.stageId || r.before?.stageId)]);
  const stages = await tx.dealStage.findMany({ where: { tenantId: tid, id: { in: stageIds } }, orderBy: { id: "asc" } });
  const memberIds = [...new Set(records.flatMap(r => [r.data.ownerMembershipId, r.data.responsibleMembershipId, r.before?.ownerMembershipId, r.before?.responsibleMembershipId].filter((id): id is string => typeof id === "string")))];
  const members = await tx.membership.findMany({ where: { tenantId: tid, id: { in: memberIds } }, include: { user: { select: { name: true } } } });
  const parsed = schema.safeParse(json({ schema: 3, entityType: "process", status: "pending", conversationId, contactId: env.conversation.contactId,
    sourceMessageId, messageRevision: input.result.messageRevision, evidenceMessageIds: ids, evidenceHash: hash(evidence), environmentHash: env.signature,
    records, reminders, linkedTasks: await processLinkedTasks(tx, tid, projections({ records }, tid)), stages, taskContext: tasks.taskContext,
    stageNames: Object.fromEntries(stages.map(s => [s.id, s.name])), memberNames: Object.fromEntries(members.map(m => [m.id, m.user.name || "Сотрудник"])), calendarSync: env.calendarSync,
  }));
  if (!parsed.success) return;
  if (previous.some(a => { const old = readProcessProposal(a.metadataJson); return old?.status === "pending" && proposalFingerprint(old) === proposalFingerprint(parsed.data); })) return;
  await supersedePending(tx, tid, conversationId);
  await tx.activity.create({ data: { tenantId: tid, contactId: env.conversation.contactId!, type: "conversation.crm_proposed", title: "Предложены действия по переписке",
    description: records.map(r => String(r.data.title || r.before?.title || "Сделка")).join("\n"), actorType: "ai", metadataJson: json({ proposalKey, review: parsed.data }) } });
}

type ReadContext = {
  env: Awaited<ReturnType<typeof environment>>;
  evidence: Awaited<ReturnType<typeof processSources>>;
  visibleThreads: Set<string>; latestId?: string;
  rows: Awaited<ReturnType<typeof loadProcessReviewRecords>>;
  visibleDeals: Set<string>; visibleInquiries: Set<string>;
};
export async function loadProcessProposals(tx: Tx, auth: AuthContext, proposals: Proposal[], conversationId: string): Promise<ReadContext> {
  const tid = requireTenant(auth).tenantId, env = await environment(tx, tid, conversationId);
  const threads = env ? await listThreadConversationIds(tx, tid, env.conversation) : [];
  const [evidence, visible, latest, rows, deals, inquiries] = await Promise.all([
    processSources(tx, tid, threads, [...new Set(proposals.flatMap(p => p.evidenceMessageIds))]),
    tx.conversation.findMany({ where: { AND: [conversationAccessWhere(auth), { id: { in: threads } }] }, select: { id: true } }),
    tx.message.findFirst({ where: { tenantId: tid, conversationId: { in: threads }, ...deliveredConversationMessage }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }),
    loadProcessReviewRecords(tx, auth, proposals.map(p => ({ records: projections(p, tid) }))),
    tx.deal.findMany({ where: { AND: [dealAccessWhere(auth), { id: { in: proposals.flatMap(p => p.records.map(r => String(r.data.dealId || ""))) } }] }, select: { id: true } }),
    tx.inquiry.findMany({ where: { AND: [inquiryAccessWhere(auth), { id: { in: proposals.flatMap(p => p.records.map(r => String(r.data.inquiryId || ""))) } }] }, select: { id: true } }),
  ]);
  return { env, evidence, visibleThreads: new Set(visible.map(c => c.id)), latestId: latest?.id, rows, visibleDeals: new Set(deals.map(d => d.id)), visibleInquiries: new Set(inquiries.map(i => i.id)) };
}

export async function processProposalVisible(tx: Tx, auth: AuthContext, p: Proposal, loaded?: ReadContext) {
  const tid = requireTenant(auth).tenantId;
  const state = loaded || await loadProcessProposals(tx, auth, [p], p.conversationId);
  if (!state.env || state.env.conversation.contactId !== p.contactId || !state.visibleThreads.has(p.conversationId)) return false;
  if (state.evidence.some(m => p.evidenceMessageIds.includes(m.id) && !state.visibleThreads.has(m.conversationId))) return false;
  for (const r of p.records) {
    if (r.before?.tenantId && r.before.tenantId !== tid) return false;
    if (isManager(auth) && (r.data.dealId && !state.visibleDeals.has(String(r.data.dealId)) || r.data.inquiryId && !state.visibleInquiries.has(String(r.data.inquiryId)))) return false;
    if (r.before) {
      const row = state.rows.rows.get(`${r.kind}:${r.id}`);
      if (!row || object(row).contactId !== p.contactId) return false;
      if (isManager(auth) && object(row).inquiryId && !state.rows.visibleInquiryIds.has(String(object(row).inquiryId))) return false;
    } else if (isManager(auth)) {
      const owner = r.data.ownerMembershipId || r.data.responsibleMembershipId;
      if (owner !== auth.activeMembership!.id) return false;
    }
  }
  return true;
}

async function assess(tx: Tx, auth: AuthContext, p: Proposal, state: ReadContext): Promise<CrmReviewBlock> {
  const tid = requireTenant(auth).tenantId;
  if (isManager(auth)) return "permissions";
  if (p.status !== "pending") return null;
  const evidence = state.evidence.filter(m => p.evidenceMessageIds.includes(m.id));
  if (state.env!.conversation.messageRevision !== p.messageRevision || state.latestId !== p.sourceMessageId || hash(evidence) !== p.evidenceHash) return "conversation_changed";
  if (!state.env!.allowed || state.env!.signature !== p.environmentHash) return "settings_changed";
  for (const r of p.records) {
    const row = state.rows.rows.get(`${r.kind}:${r.id}`);
    if (r.before ? !row || hash(processSnapshot(r.kind, row)) !== hash(processSnapshot(r.kind, r.before)) : Boolean(row)) return "changed";
    if (!r.before && r.data.dedupeKey && (r.kind === "agreement" ? await tx.agreement.count({ where: { tenantId: tid, dedupeKey: String(r.data.dedupeKey) } }) : await tx.task.count({ where: { tenantId: tid, dedupeKey: String(r.data.dedupeKey) } }))) return "changed";
    if (r.kind === "agreement" && !["COMPLETED", "CANCELLED"].includes(String(r.data.status)) && r.data.scheduledAt && Date.parse(String(r.data.scheduledAt)) <= Date.now()) return "expired";
    if (r.kind === "task" && !["done", "canceled"].includes(String(r.data.status)) && r.data.dueAt && Date.parse(String(r.data.dueAt)) <= Date.now()) return "expired";
  }
  if (p.taskContext && hash((await suggestedTaskContext(tx, tid, p.taskContext.scope)).fingerprints) !== hash(p.taskContext.rows)) return "related_activity";
  if (hash(await processLinkedTasks(tx, tid, projections(p, tid))) !== hash(p.linkedTasks)) return "related_activity";
  const agreementIds = p.records.filter(r => r.kind === "agreement").map(r => r.id), taskIds = p.records.filter(r => r.kind === "task").map(r => r.id);
  const ownerIds = [...new Set(p.records.flatMap(r => [r.data.ownerMembershipId, r.data.responsibleMembershipId].filter((id): id is string => typeof id === "string")))];
  if (await tx.membership.count({ where: { tenantId: tid, id: { in: ownerIds }, active: true } }) !== ownerIds.length) return "related_activity";
  if (agreementIds.length && await tx.task.count({ where: { tenantId: tid, agreementId: { in: agreementIds }, id: { notIn: taskIds } } })) return "related_activity";
  if (taskIds.length && (await tx.executionConfirmation.count({ where: { tenantId: tid, taskId: { in: taskIds } } }) || await tx.attachment.count({ where: { tenantId: tid, parentType: "task", parentId: { in: taskIds } } }) || await tx.task.count({ where: { tenantId: tid, parentTaskId: { in: taskIds } } }) || await tx.scheduledAction.count({ where: { tenantId: tid, parentType: "task", parentId: { in: taskIds } } }))) return "related_activity";
  const existingAgreementIds = p.records.filter(r => r.kind === "agreement" && r.before).map(r => r.id);
  if (existingAgreementIds.length && (p.calendarSync || await hasCalendarHistory(tx, tid, existingAgreementIds))) return "calendar";
  for (const group of p.reminders) {
    if (group.rows.some(r => !["scheduled", "canceled"].includes(String(r.state))) || hash(await processReminders(tx, tid, group.agreementId)) !== hash(group.rows)) return "effects_started";
  }
  const stages = await tx.dealStage.findMany({ where: { tenantId: tid, id: { in: p.stages.map(s => String(s.id)) } }, orderBy: { id: "asc" } });
  if (hash(stages) !== hash(p.stages)) return "changed";
  return null;
}

export async function processProposalItem(tx: Tx, auth: AuthContext, activity: { id: string; createdAt: Date }, p: Proposal, state: ReadContext): Promise<CrmReviewItem | null> {
  if (!await processProposalVisible(tx, auth, p, state)) return null;
  const blockedReason = await assess(tx, auth, p, state);
  return { id: activity.id, entityType: "process", entityId: p.conversationId, status: p.status, confidence: "HIGH", createdAt: activity.createdAt.toISOString(), fields: [],
    evidence: state.evidence.filter(m => p.evidenceMessageIds.includes(m.id)).map(({ conversationId: _, ...m }) => ({ ...m, createdAt: m.createdAt.toISOString() })),
    canAccept: p.status === "pending" && !blockedReason, canDismiss: p.status === "pending" && !isManager(auth), canUndo: false, blockedReason: p.status === "pending" ? blockedReason : null,
    process: { entries: formatProcessEntries(projections(p, requireTenant(auth).tenantId), p.stageNames, p.memberNames, state.env!.tenant.timezone), calendarSync: p.calendarSync && p.records.some(r => r.kind === "agreement"),
      reminders: p.records.filter(r => r.kind === "agreement" && !["CANCELLED", "COMPLETED"].includes(String(r.data.status))).reduce((n, r) => n + defaultReminders(String(r.data.type)).filter(rem => Date.parse(String(r.data.scheduledAt)) - rem.offsetMinutes * 60000 > Date.now()).length, 0) } };
}

/** Existing endpoint already holds the conversation lock; no client values enter this plan. */
export async function decideProcessProposal(tx: Tx, auth: AuthContext, activity: { id: string; metadataJson: unknown }, p: Proposal, decision: string) {
  const tid = requireTenant(auth).tenantId;
  if (!await processProposalVisible(tx, auth, p)) throw new ApiError(404, "not_found", "Предложение не найдено");
  if (isManager(auth)) throw new ApiError(403, "forbidden", "Подтверждение связанных действий доступно руководителю");
  if (decision === "dismiss" && p.status === "dismissed") return { status: "dismissed" };
  if (p.status !== "pending" || !["accept", "dismiss"].includes(decision)) throw new ApiError(409, "crm_review_closed", "Предложение уже рассмотрено");
  if (decision === "accept") {
    await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tid} FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM "Contact" WHERE id = ${p.contactId} AND "tenantId" = ${tid} FOR UPDATE`;
    const inquiryIds = [...new Set(p.records.map(r => String(r.data.inquiryId || r.before?.inquiryId || "")).filter(Boolean))].sort();
    for (const id of inquiryIds) await tx.$queryRaw`SELECT id FROM "Inquiry" WHERE id = ${id} AND "tenantId" = ${tid} FOR UPDATE`;
    for (const stage of p.stages) await tx.$queryRaw`SELECT id FROM "DealStage" WHERE id = ${String(stage.id)} AND "tenantId" = ${tid} FOR SHARE`;
    for (const r of [...p.records].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`))) {
      if (r.kind === "deal") await tx.$queryRaw`SELECT id FROM "Deal" WHERE id = ${r.id} AND "tenantId" = ${tid} FOR UPDATE`;
      if (r.kind === "agreement") await tx.$queryRaw`SELECT id FROM "Agreement" WHERE id = ${r.id} AND "tenantId" = ${tid} FOR UPDATE`;
      if (r.kind === "task") await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${r.id} AND "tenantId" = ${tid} FOR UPDATE`;
    }
    for (const group of p.reminders) await tx.$queryRaw`SELECT id FROM "ScheduledAction" WHERE "tenantId" = ${tid} AND "parentType" = 'agreement' AND "parentId" = ${group.agreementId} ORDER BY id FOR UPDATE`;
    for (const task of p.taskContext?.rows || []) await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${task.id} AND "tenantId" = ${tid} FOR UPDATE`;
    const state = await loadProcessProposals(tx, auth, [p], p.conversationId);
    if (!await processProposalVisible(tx, auth, p, state)) throw new ApiError(404, "not_found", "Предложение не найдено");
    if (await assess(tx, auth, p, state)) throw new ApiError(409, "crm_review_changed", "Предложение устарело. Проверьте причину и повторите анализ.");
    const capture = new ProcessReviewCapture(), changes: Array<{ record: Proposal["records"][number]; after: object }> = [];
    await applyContextProcess(tx, tid, { records: p.records, notifications: [] }, { capture, sourceMessageId: p.sourceMessageId, actorUserId: auth.user.id, notify: false, onChange: (record, after) => changes.push({ record, after }) });
    for (const { record, after } of changes) await writeAudit(tx, { tenantId: tid, actorUserId: auth.user.id, action: "conversation.crm_reviewed", entityType: record.kind, entityId: record.id,
      correlationId: p.sourceMessageId, changes: { proposalId: activity.id, conversationId: p.conversationId, before: record.before, after } });
    const saved = await capture.save(tx, tid, p, { activityId: activity.id, metadata: activity.metadataJson, actorUserId: auth.user.id });
    if (!saved) throw new ApiError(409, "crm_review_changed", "Не удалось зафиксировать изменения и историю. Повторите анализ.");
  } else {
    await tx.activity.update({ where: { id: activity.id, tenantId: tid }, data: { metadataJson: json({ ...object(activity.metadataJson), review: { ...p, status: "dismissed" }, reviewedBy: auth.user.id, reviewedAt: new Date().toISOString() }) } });
    await writeAudit(tx, { tenantId: tid, actorUserId: auth.user.id, action: "conversation.crm_reviewed", entityType: "conversation", entityId: p.conversationId,
      correlationId: p.sourceMessageId, changes: { proposalId: activity.id, decision: "dismiss", processRecords: p.records.map(r => ({ kind: r.kind, id: r.id })) } });
  }
  await tx.activity.create({ data: { tenantId: tid, contactId: p.contactId, type: "conversation.crm_reviewed", title: decision === "accept" ? "Подтверждены связанные действия ИИ" : "Отклонены связанные действия ИИ", actorType: "user", actorId: auth.user.id,
    metadataJson: json({ proposalId: activity.id, decision, conversationId: p.conversationId, evidenceMessageIds: p.evidenceMessageIds, processRecords: p.records.map(r => ({ kind: r.kind, id: r.id })) }) } });
  return { status: decision === "accept" ? "accepted" : "dismissed" };
}
