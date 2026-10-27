import { randomUUID } from "node:crypto";
import type { Prisma } from "@creolab/db";
import { taskCreatorSnapshot } from "@creolab/contracts";
import { suggestedTaskSchema } from "./conversationAnalysisValidation.ts";
import { agreementTypeToTaskType } from "./conversationContextTypes.ts";
import type { ProcessInput, ProcessOperation } from "./conversationProcessChanges.ts";
import { processFingerprint as hash, processSnapshot } from "./conversationProcessReview.ts";
import { publishedIntakePolicy } from "./aiIntakeService.ts";

type Tx = Prisma.TransactionClient;
export type SuggestedTaskScope = { contactId: string; conversationId: string; inquiryId: string | null; dealId: string | null; sourceMessageId: string };
const normalized = (text: string) => text.normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Record<string, unknown>;

/** Bound the client workset. Its fingerprints also detect manual work created or edited after inference. */
export async function suggestedTaskContext(tx: Tx, tid: string, scope: SuggestedTaskScope) {
  const rows = await tx.task.findMany({ where: { tenantId: tid, AND: [
    { OR: [{ contactId: scope.contactId }, { conversationId: scope.conversationId },
      ...(scope.inquiryId ? [{ inquiryId: scope.inquiryId }] : []), ...(scope.dealId ? [{ dealId: scope.dealId }] : [])] },
    { OR: [{ status: { in: ["open", "in_progress", "waiting"] } }, { sourceMessageIdsJson: { array_contains: [scope.sourceMessageId] } }] },
  ] }, orderBy: { id: "asc" }, take: 201 });
  return { rows, fingerprints: rows.map(row => ({ id: row.id, fingerprint: hash(processSnapshot("task", row)) })) };
}

/** Freestanding suggestions only create a review plan, even in AUTO mode. Never execute it here. */
export async function prepareSuggestedTasks(tx: Tx, tid: string, input: ProcessInput, planned: ProcessOperation[]) {
  const records: ProcessOperation[] = [], evidence = new Set<string>();
  const { conversation, inquiry, deal, result, settings } = input;
  if (!settings.crm.createTasks || !conversation.contactId || !result.sourceMessageId || result.analysis.confidence !== "HIGH" || !result.analysis.suggestedTasks?.length) return { records, evidence: [] };
  const scope: SuggestedTaskScope = { contactId: conversation.contactId, conversationId: conversation.id, inquiryId: inquiry?.id || null, dealId: deal?.id || null, sourceMessageId: result.sourceMessageId };
  const context = await suggestedTaskContext(tx, tid, scope);
  if (context.rows.length > 200) return { records, evidence: [] };
  const people = new Set(input.evidenceMessages.filter(m => m.direction === "inbound" && m.senderKind === "client" || m.direction === "outbound" && m.senderKind === "staff").map(m => m.id));
  if (!people.has(scope.sourceMessageId)) return { records, evidence: [] };
  const ownerId = conversation.assigneeMembershipId || deal?.assigneeMembershipId || inquiry?.assigneeMembershipId || conversation.contact?.ownerMembershipId;
  const owner = ownerId ? await tx.membership.findFirst({ where: { tenantId: tid, id: ownerId, active: true } }) : null;
  const intake = await publishedIntakePolicy(tx, tid);
  const staffSource = input.evidenceMessages.some(m => m.id === scope.sourceMessageId && m.senderKind === "staff" && m.direction === "outbound");
  const duplicate = (a: { type: string; title: string; dueAt: string | null }, b: { type: string; title: string; dueAt: string | null }) =>
    normalized(a.title) === normalized(b.title) || a.type === b.type && ["meeting", "call"].includes(a.type) && a.dueAt !== null && a.dueAt === b.dueAt;
  const candidates = [...context.rows.map(t => ({ type: t.type, title: t.title, dueAt: t.dueAt?.toISOString() || null })),
    ...planned.filter(r => r.kind === "task").map(r => ({ type: String(r.data.type), title: String(r.data.title), dueAt: r.data.dueAt ? String(r.data.dueAt) : null }))];
  for (const raw of result.analysis.suggestedTasks.slice(0, 20)) {
    const parsed = suggestedTaskSchema.safeParse(raw);
    if (!parsed.success) continue;
    const task = parsed.data;
    // Do not reinterpret a broken/reindexed agreement reference as an independent task.
    if (!normalized(task.title) || task.linkedAgreementIndex != null || task.confidence !== "HIGH" || !task.evidenceMessageIds.includes(scope.sourceMessageId) || !task.evidenceMessageIds.every(id => people.has(id))) continue;
    const dueAt = task.dueAt ? new Date(task.dueAt).toISOString() : null;
    if (dueAt && Date.parse(dueAt) <= Date.now() || task.type === "meeting" && !dueAt) continue;
    if (!staffSource && intake?.roles.includes("booking") && ["meeting", "call"].includes(task.type)) continue;
    // Agreement handling owns these actions, including cancellations and blocked/uncertain bookings.
    if (result.analysis.agreements.some(a => agreementTypeToTaskType(a.type) === task.type && a.evidenceMessageIds.includes(scope.sourceMessageId))) continue;
    const candidate = { type: task.type, title: task.title, dueAt };
    if (candidates.some(other => duplicate(candidate, other)) || context.rows.some(t => t.type === task.type && Array.isArray(t.sourceMessageIdsJson) && t.sourceMessageIdsJson.includes(scope.sourceMessageId))) continue;
    const description = (task.briefingText || task.purpose || result.analysis.summaryUpdate || task.title).slice(0, 2000);
    const needsReview = ["message", "follow_up", "proposal", "send_documents"].includes(task.type);
    const data = { contactId: scope.contactId, conversationId: scope.conversationId, inquiryId: scope.inquiryId, dealId: scope.dealId, type: task.type, title: task.title, dueAt, description,
      ownerMembershipId: owner?.id || null, status: "open", source: "context_engine", targetType: "client",
      purpose: task.purpose || null, briefingText: description, preparationHintsJson: task.preparationHints || [],
      sourceMessageIdsJson: [...new Set(task.evidenceMessageIds)],
      executionStatus: needsReview ? "prepared" : "none", commandStatus: needsReview ? "needs_confirmation" : "none",
      dedupeKey: `task-suggestion:${hash([conversation.id, scope.sourceMessageId, task.type, normalized(task.title)])}`,
      contextSnapshotJson: taskCreatorSnapshot({ existing: { summary: result.analysis.summaryUpdate, sourceMessageId: scope.sourceMessageId, standaloneSuggestion: true,
        aiTaskState: { title: task.title, dueAt, status: "open", ownerMembershipId: owner?.id || null, description } }, createdByKind: "ai", createdByMembershipId: null, executorType: "USER" }),
    };
    records.push({ kind: "task", id: randomUUID(), before: null, data: json(data), eventType: "TASK_SUGGESTED", confidence: "HIGH" });
    candidates.push(candidate);
    task.evidenceMessageIds.forEach(id => evidence.add(id));
    if (records.length === 5) break;
  }
  return { records, evidence: [...evidence], ...(records.length ? { taskContext: { scope, rows: context.fingerprints } } : {}) };
}
