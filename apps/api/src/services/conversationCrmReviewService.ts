import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@creolab/db";
import type { CrmReviewBlock, CrmReviewEntity, CrmReviewItem, CrmReviewList } from "@creolab/contracts";
import { CRM_COMMERCIAL_FIELDS, crmMoneySchema, readCrmCommercial } from "@creolab/contracts";
import { groundCommercialFacts } from "./conversationCommercialFacts.ts";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { writeAudit } from "../lib/audit.ts";
import { assertConversationReachable, conversationAccessWhere, inquiryAccessWhere, isManager, requireTenant } from "../lib/access.ts";
import { deliveredConversationMessage } from "./conversationMessageState.ts";
import { listThreadConversationIds } from "./conversationThread.ts";
import { crmReviewFingerprint, type CrmReviewSnapshot } from "./crmReviewState.ts";
import type { ConversationAnalysis } from "./conversationContextTypes.ts";

type Tx = Prisma.TransactionClient;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const value = z.union([z.string().max(4000), z.boolean(), crmMoneySchema, z.null()]);
const commercialField = (key: string) => (CRM_COMMERCIAL_FIELDS as readonly string[]).includes(key);
const reviewSchema = z.object({
  schema: z.literal(1), conversationId: z.string(), contactId: z.string(), sourceMessageId: z.string(), messageRevision: z.number().int(),
  entityType: z.enum(["contact", "inquiry"]), entityId: z.string(),
  status: z.enum(["pending", "accepted", "automatic", "dismissed", "superseded", "undone"]),
  confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
  fields: z.array(z.object({ key: z.enum(["summary", "aiSummary", "nextStep", "status", "needsReply", ...CRM_COMMERCIAL_FIELDS]), before: z.union([z.string().max(20_000), z.boolean(), crmMoneySchema, z.null()]), after: value })).min(1).max(4),
  beforeFingerprint: z.string(), afterFingerprint: z.string().optional(),
  evidenceMessageIds: z.array(z.string()).min(1).max(80), evidenceHash: z.string(),
  quotes: z.array(z.object({ messageId: z.string(), quote: z.string().min(3).max(2000) })).min(1).max(4).optional(),
}).refine(r => r.fields.every(f => {
  if (r.entityType === "contact") return f.key === "summary" && (typeof f.before === "string" || f.before === null) && (typeof f.after === "string" || f.after === null);
  if (commercialField(f.key)) {
    if (r.fields.length !== 1 || !r.quotes?.length || !r.quotes.every(q => r.evidenceMessageIds.includes(q.messageId))) return false;
    if (["objection", "refusalReason"].includes(f.key)) return [f.before, f.after].every(v => v === null || (typeof v === "string" && v.length <= 2000));
    return [f.before, f.after].every(v => v === null || (typeof v === "object" && (f.key === "customerBudget" || (v.min !== null && v.min === v.max))));
  }
  if (f.key === "needsReply") return typeof f.before === "boolean" && typeof f.after === "boolean";
  if (f.key === "status") return [f.before, f.after].every(v => typeof v === "string" && ["new", "qualification", "qualified", "accepted", "in_progress", "waiting_client", "waiting_manager"].includes(v));
  return ["aiSummary", "nextStep"].includes(f.key) && [f.before, f.after].every(v => v === null || typeof v === "string");
}) && new Set(r.fields.map(f => f.key)).size === r.fields.length);
type Review = z.infer<typeof reviewSchema>;
const readReview = (metadata: unknown): Review | null => {
  const parsed = reviewSchema.safeParse(object(metadata).review);
  return parsed.success ? parsed.data : null;
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Evidence = { id: string; text: string | null; createdAt: Date; senderKind: string; direction: string };
const evidenceHash = (rows: Evidence[]) => hash([...rows].sort((a, b) => a.id.localeCompare(b.id)).map(m => [m.id, m.text, m.createdAt.toISOString(), m.senderKind, m.direction]));
function changeDescription(fields: Review["fields"]) {
  const labels = { summary: "Сводка о клиенте", aiSummary: "Сводка по заявке", nextStep: "Следующий шаг", status: "Статус заявки", needsReply: "Нужен ответ", customerBudget: "Бюджет клиента", proposedPrice: "Предложенная цена", agreedPrice: "Согласованная цена", objection: "Возражение клиента", refusalReason: "Причина отказа клиента" };
  const statuses: Record<string, string> = { new: "Новая", qualification: "Квалификация", qualified: "Квалифицирована", accepted: "Принята", in_progress: "В работе", waiting_client: "Ждём клиента", waiting_manager: "Ждём менеджера" };
  const display = (key: string, raw: z.infer<typeof value>) => raw === null ? "Не заполнено" : typeof raw === "boolean" ? raw ? "Да" : "Нет" : typeof raw === "object"
    ? `${raw.min === raw.max ? raw.min : raw.min === null ? `до ${raw.max}` : raw.max === null ? `от ${raw.min}` : `${raw.min}–${raw.max}`} ${raw.currency}` : key === "status" ? statuses[raw] || raw : raw;
  return fields.map(f => `${labels[f.key]}: «${display(f.key, f.before)}» → «${display(f.key, f.after)}»`).join("\n");
}
async function evidenceFor(tx: Tx, tid: string, conversationId: string, ids?: string[], take = 1) {
  const conversation = await tx.conversation.findFirst({ where: { id: conversationId, tenantId: tid } });
  if (!conversation || ids?.length === 0) return [];
  const threads = await listThreadConversationIds(tx, tid, conversation);
  return tx.message.findMany({ where: { tenantId: tid, conversationId: { in: threads }, ...(ids ? { id: { in: ids } } : {}), ...deliveredConversationMessage },
    select: { id: true, conversationId: true, text: true, createdAt: true, senderKind: true, direction: true },
    orderBy: [{ createdAt: ids ? "asc" : "desc" }, { id: ids ? "asc" : "desc" }], ...(ids ? {} : { take }) });
}

/** Only called within the context transaction while its conversation row is locked. */
export async function proposeConversationCrmChanges(tx: Tx, tid: string, conversationId: string, input: {
  analysis: ConversationAnalysis; sourceMessageId: string; messageRevision: number; snapshot?: CrmReviewSnapshot;
  updateContact: boolean; updateInquiry: boolean;
  commercialFingerprint?: string;
}) {
  const { analysis, snapshot } = input;
  if (!snapshot) return;
  const ids = [...new Set(analysis.evidenceMessageIds)];
  const evidence = await evidenceFor(tx, tid, conversationId, ids);
  const genericGrounded = analysis.confidence !== "LOW" && ids.includes(input.sourceMessageId) && evidence.length === ids.length;
  const conversation = await tx.conversation.findFirst({ where: { id: conversationId, tenantId: tid } });
  if (!conversation?.contactId) return;
  const candidates: Array<{ entityType: CrmReviewEntity; entityId: string; beforeFingerprint: string; fields: Review["fields"]; quotes?: Review["quotes"]; confidence?: Review["confidence"] }> = [];
  const text = (raw: string | null) => raw?.trim() && raw.trim().length <= 4000 ? raw.trim() : null;
  if (genericGrounded && input.updateContact && snapshot.contact?.id === conversation.contactId) {
    const summary = text(analysis.summaryUpdate);
    const current = await tx.contact.findFirst({ where: { id: snapshot.contact.id, tenantId: tid, archivedAt: null } });
    if (current && summary && summary !== snapshot.contact.summary && summary !== current.summary) candidates.push({ entityType: "contact", entityId: snapshot.contact.id,
      beforeFingerprint: snapshot.contact.fingerprint, fields: [{ key: "summary", before: snapshot.contact.summary, after: summary }] });
  }
  if (input.updateInquiry && snapshot.inquiry) {
    const inquiry = await tx.inquiry.findFirst({ where: { id: snapshot.inquiry.id, tenantId: tid, contactId: conversation.contactId, conversationId, archived: false } });
    const fields: Review["fields"] = [];
    for (const [key, raw] of [["aiSummary", analysis.summaryUpdate], ["nextStep", analysis.suggestedNextAction]] as const) {
      const after = text(raw);
      if (genericGrounded && after && after !== snapshot.inquiry[key] && after !== inquiry?.[key]) fields.push({ key, before: snapshot.inquiry[key], after });
    }
    // Review fields separately: a manager may confirm a next step while a
    // client summary requires broader rights. Never bundle those permissions.
    if (inquiry) for (const field of fields) candidates.push({ entityType: "inquiry", entityId: inquiry.id, beforeFingerprint: snapshot.inquiry.fingerprint, fields: [field] });
    if (inquiry && snapshot.inquiry.commercial && snapshot.inquiry.currency === inquiry.currency) {
      // Ground independently against delivered, tenant-scoped messages inside the
      // transaction. Never trust the model's amount, quote, speaker or IDs alone.
      // Include intervening messages, not just model-selected IDs: a bare "yes"
      // must never accept a conveniently selected, older offer.
      const sources = (await evidenceFor(tx, tid, conversationId, undefined, 80)).reverse();
      const current = readCrmCommercial(inquiry);
      const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
      for (const fact of groundCommercialFacts(analysis.commercialFacts, sources, inquiry.currency)) {
        if (fact.evidence.every(e => e.messageId !== input.sourceMessageId)) continue;
        if (typeof fact.value === "object" && fact.field === "customerBudget" && fact.value.currency !== inquiry.currency) continue;
        // Do not turn an unsupported legacy value into "empty" and then lose it
        // on undo. Such records need ordinary manual correction first.
        if (fact.field === "customerBudget" && !current.customerBudget && (inquiry.budgetMin !== null || inquiry.budgetMax !== null)) continue;
        if (fact.field !== "customerBudget" && current[fact.field] === null && object(object(inquiry.normalizedJson).crmCommercial)[fact.field] != null) continue;
        const before = snapshot.inquiry.commercial[fact.field];
        if (same(before, fact.value) || same(current[fact.field], fact.value)) continue;
        candidates.push({ entityType: "inquiry", entityId: inquiry.id, beforeFingerprint: input.commercialFingerprint || snapshot.inquiry.fingerprint,
          fields: [{ key: fact.field, before, after: fact.value }], quotes: fact.evidence, confidence: fact.confidence });
      }
    }
  }
  for (const candidate of candidates) {
    // Re-analysis of the same source/card cannot resurrect a dismissed proposal
    // or replace content under a button that a colleague is already reviewing.
    const fieldKey = candidate.fields.map(f => f.key).join(",");
    const key = hash([conversationId, input.sourceMessageId, candidate.entityType, candidate.entityId, candidate.beforeFingerprint, fieldKey]);
    const existing = await tx.activity.findFirst({ where: { tenantId: tid, type: "conversation.crm_proposed", metadataJson: { path: ["proposalKey"], equals: key } } });
    if (existing) continue;
    const pending = await tx.activity.findMany({ where: { tenantId: tid, type: "conversation.crm_proposed", AND: [
      { metadataJson: { path: ["review", "conversationId"], equals: conversationId } },
      { metadataJson: { path: ["review", "entityId"], equals: candidate.entityId } },
      { metadataJson: { path: ["fieldKey"], equals: fieldKey } },
      { metadataJson: { path: ["review", "status"], equals: "pending" } },
    ] } });
    for (const old of pending) {
      const review = readReview(old.metadataJson);
      if (review) await tx.activity.update({ where: { id: old.id }, data: { metadataJson: json({ ...object(old.metadataJson), review: { ...review, status: "superseded" } }) } });
    }
    const candidateIds = candidate.quotes?.map(q => q.messageId) || ids;
    const candidateEvidence = candidate.quotes ? await evidenceFor(tx, tid, conversationId, candidateIds) : evidence;
    const review: Review = { schema: 1, ...candidate, conversationId, contactId: conversation.contactId,
      sourceMessageId: input.sourceMessageId, messageRevision: input.messageRevision, status: "pending", confidence: candidate.confidence || analysis.confidence,
      evidenceMessageIds: candidateIds, evidenceHash: evidenceHash(candidateEvidence) };
    if (!reviewSchema.safeParse(review).success) continue;
    await tx.activity.create({ data: { tenantId: tid, contactId: conversation.contactId,
      inquiryId: candidate.entityType === "inquiry" ? candidate.entityId : null,
      type: "conversation.crm_proposed", title: "Предложено обновление CRM", description: changeDescription(candidate.fields), actorType: "ai", metadataJson: json({ proposalKey: key, fieldKey, review }) } });
  }
}

/** Attach reversible metadata to the existing AI activity, without a second journal. */
export async function automaticCrmReview(tx: Tx, tid: string, input: {
  conversationId: string; contactId: string; sourceMessageId: string; messageRevision: number;
  entityType: string; entityId: string; before: unknown; after: unknown; confidence: string; evidenceMessageIds: string[];
}): Promise<Review | null> {
  if (input.entityType !== "contact" && input.entityType !== "inquiry") return null;
  const entityType = input.entityType;
  const keys = entityType === "contact" ? ["summary"] as const : ["aiSummary", "nextStep", "status", "needsReply"] as const;
  const before = object(input.before), after = object(input.after);
  const fields = keys.filter(key => key in before && key in after && before[key] !== after[key]).map(key => ({ key, before: before[key], after: after[key] }));
  if (!fields.length) return null;
  const row = entityType === "contact" ? await tx.contact.findFirst({ where: { id: input.entityId, tenantId: tid } })
    : await tx.inquiry.findFirst({ where: { id: input.entityId, tenantId: tid } });
  const ids = [...new Set(input.evidenceMessageIds)];
  const evidence = await evidenceFor(tx, tid, input.conversationId, ids);
  if (!row || !ids.includes(input.sourceMessageId) || evidence.length !== ids.length) return null;
  const parsed = reviewSchema.safeParse({ ...input, schema: 1, status: "automatic", fields,
    evidenceMessageIds: ids, evidenceHash: evidenceHash(evidence), beforeFingerprint: "", afterFingerprint: crmReviewFingerprint(entityType, row) });
  return parsed.success ? parsed.data : null;
}

async function targetRow(tx: Tx, tid: string, review: Review, auth: AuthContext) {
  if (review.entityType === "contact") return review.entityId === review.contactId ? tx.contact.findFirst({ where: { id: review.entityId, tenantId: tid, archivedAt: null } }) : null;
  return tx.inquiry.findFirst({ where: { AND: [inquiryAccessWhere(auth), { id: review.entityId, tenantId: tid,
    contactId: review.contactId, conversationId: review.conversationId, archived: false }] } });
}
function canEdit(auth: AuthContext, review: Review, row: object) {
  if (!isManager(auth)) return true;
  // Same field/ownership limits as editing the normal client/request card.
  return review.entityType === "inquiry" && object(row).assigneeMembershipId === requireTenant(auth).id
    && review.fields.every(f => ["nextStep", "needsReply", "status", "customerBudget", "objection", "refusalReason"].includes(f.key));
}
async function assess(tx: Tx, auth: AuthContext, review: Review) {
  const tid = requireTenant(auth).tenantId;
  const conversation = await tx.conversation.findFirst({ where: { id: review.conversationId, tenantId: tid } });
  const row = await targetRow(tx, tid, review, auth);
  const evidence = await evidenceFor(tx, tid, review.conversationId, review.evidenceMessageIds);
  const latest = await evidenceFor(tx, tid, review.conversationId);
  const sourceThreads = [...new Set(evidence.map(m => m.conversationId))];
  const visibleThreads = await tx.conversation.findMany({ where: { AND: [conversationAccessWhere(auth), { id: { in: sourceThreads } }] }, select: { id: true } });
  return assessLoaded(auth, review, row, conversation, evidence, new Set(visibleThreads.map(t => t.id)), latest[0]?.id);
}
function assessLoaded(auth: AuthContext, review: Review, row: object | null, conversation: { contactId: string | null; messageRevision: number } | null,
  evidence: Array<Evidence & { conversationId: string }>, visibleThreads: Set<string>, latestMessageId?: string) {
  if (!row || conversation?.contactId !== review.contactId || evidence.some(m => !visibleThreads.has(m.conversationId))) return null;
  let blockedReason: CrmReviewBlock = null;
  if (!canEdit(auth, review, row)) blockedReason = "permissions";
  else if (conversation.messageRevision !== review.messageRevision || latestMessageId !== review.sourceMessageId || evidenceHash(evidence) !== review.evidenceHash || evidence.length !== review.evidenceMessageIds.length) blockedReason = "conversation_changed";
  else if (crmReviewFingerprint(review.entityType, row) !== (review.status === "pending" ? review.beforeFingerprint : review.afterFingerprint)) blockedReason = "changed";
  return { row, evidence, blockedReason, editable: canEdit(auth, review, row) };
}

export async function listConversationCrmReview(prisma: PrismaClient, auth: AuthContext, conversationId: string): Promise<CrmReviewList> {
  const tid = requireTenant(auth).tenantId;
  return prisma.$transaction(async tx => {
    await assertConversationReachable(tx, auth, conversationId);
    const rows = await tx.activity.findMany({ where: { tenantId: tid, type: { in: ["conversation.crm_proposed", "conversation.crm_updated"] },
      metadataJson: { path: ["review", "conversationId"], equals: conversationId } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 51 });
    const reviews = rows.slice(0, 50).map(activity => ({ activity, review: readReview(activity.metadataJson) })).filter(item => item.review !== null);
    const [conversation, contacts, inquiries, evidence, latest] = await Promise.all([
      tx.conversation.findFirst({ where: { tenantId: tid, id: conversationId } }),
      tx.contact.findMany({ where: { tenantId: tid, id: { in: reviews.filter(r => r.review!.entityType === "contact" && r.review!.entityId === r.review!.contactId).map(r => r.review!.entityId) }, archivedAt: null } }),
      tx.inquiry.findMany({ where: { AND: [inquiryAccessWhere(auth), { id: { in: reviews.filter(r => r.review!.entityType === "inquiry").map(r => r.review!.entityId) }, conversationId, archived: false }] } }),
      evidenceFor(tx, tid, conversationId, [...new Set(reviews.flatMap(r => r.review!.evidenceMessageIds))]),
      evidenceFor(tx, tid, conversationId),
    ]);
    const visible = await tx.conversation.findMany({ where: { AND: [conversationAccessWhere(auth), { id: { in: [...new Set(evidence.map(m => m.conversationId))] } }] }, select: { id: true } });
    const visibleThreads = new Set(visible.map(t => t.id));
    const items: CrmReviewItem[] = [];
    for (const { activity, review: parsed } of reviews) {
      const review = parsed!;
      const row = review.entityType === "contact" ? contacts.find(c => c.id === review.entityId) : inquiries.find(i => i.id === review.entityId && i.contactId === review.contactId);
      const state = assessLoaded(auth, review, row || null, conversation, evidence.filter(m => review.evidenceMessageIds.includes(m.id)), visibleThreads, latest[0]?.id);
      if (!state) continue; // Do not disclose another employee's inaccessible record or evidence.
      const actionable = review.status === "pending" || review.status === "accepted" || review.status === "automatic";
      items.push({ id: activity.id, entityType: review.entityType, entityId: review.entityId, status: review.status, confidence: review.confidence,
        fields: review.fields, createdAt: activity.createdAt.toISOString(),
        evidence: state.evidence.map(({ conversationId: _, ...m }) => ({ ...m, createdAt: m.createdAt.toISOString(), ...(review.quotes?.find(q => q.messageId === m.id) ? { quote: review.quotes.find(q => q.messageId === m.id)!.quote } : {}) })),
        canAccept: review.status === "pending" && !state.blockedReason, canDismiss: review.status === "pending" && state.editable,
        canUndo: ["accepted", "automatic"].includes(review.status) && !state.blockedReason,
        blockedReason: actionable ? state.blockedReason : null });
    }
    const currentInquiry = await tx.inquiry.findFirst({ where: { AND: [inquiryAccessWhere(auth), { tenantId: tid, conversationId, contactId: conversation?.contactId || "", archived: false }] }, orderBy: { receivedAt: "desc" } });
    return { items, hasMore: rows.length > 50, commercial: currentInquiry ? readCrmCommercial(currentInquiry) : null };
  }, { timeout: 15000 });
}

async function updateTarget(tx: Tx, tid: string, review: Review, row: object, undo: boolean, actorUserId: string) {
  const data: Record<string, unknown> = Object.fromEntries(review.fields.map(f => [f.key, undo ? f.before : f.after]));
  const version = Number(object(row).version);
  // The target row is locked and fingerprint-checked. Increment rather than restore
  // versions; undo is a new change, never a rewrite of the original history.
  if (review.entityType === "contact") return tx.contact.update({ where: { id: review.entityId, tenantId: tid, version },
    data: { summary: data.summary as string | null, version: { increment: 1 } } });
  for (const field of review.fields.filter(f => commercialField(f.key))) {
    const nextValue = undo ? field.before : field.after;
    delete data[field.key];
    if (field.key === "customerBudget") {
      const money = nextValue === null ? null : crmMoneySchema.parse(nextValue);
      if (money && money.currency !== object(row).currency) throw new ApiError(409, "crm_review_changed", "Валюта заявки изменилась. Повторите анализ.");
      data.budgetMin = money?.min ?? null; data.budgetMax = money?.max ?? null;
    } else {
      const normalized = object(object(row).normalizedJson);
      const commercial = { ...object(normalized.crmCommercial) };
      if (nextValue === null) delete commercial[field.key]; else commercial[field.key] = nextValue;
      data.normalizedJson = json({ ...normalized, crmCommercial: commercial });
    }
  }
  const next = await tx.inquiry.update({ where: { id: review.entityId, tenantId: tid, version }, data: { ...data, version: { increment: 1 } } });
  if (typeof data.status === "string" && data.status !== object(row).status) await tx.inquiryStatusHistory.create({ data: {
    tenantId: tid, inquiryId: review.entityId, fromStatus: String(object(row).status), toStatus: data.status,
    changedByType: "user", changedById: actorUserId, note: undo ? "Отменено изменение ИИ" : "Подтверждено изменение ИИ",
  } });
  return next;
}

export async function reviewConversationCrmChange(prisma: PrismaClient, auth: AuthContext, conversationId: string, id: string, decision: "accept" | "dismiss" | "undo") {
  const tid = requireTenant(auth).tenantId;
  z.enum(["accept", "dismiss", "undo"]).parse(decision);
  return prisma.$transaction(async tx => {
    await assertConversationReachable(tx, auth, conversationId);
    await tx.$queryRaw`SELECT id FROM "Conversation" WHERE id = ${conversationId} AND "tenantId" = ${tid} FOR UPDATE`;
    // Recheck visibility after the lock: reassignment may have happened while waiting.
    await assertConversationReachable(tx, auth, conversationId);
    const activity = await tx.activity.findFirst({ where: { id, tenantId: tid, type: { in: ["conversation.crm_proposed", "conversation.crm_updated"] } } });
    const review = readReview(activity?.metadataJson);
    if (!activity || !review || review.conversationId !== conversationId) throw new ApiError(404, "not_found", "Изменение не найдено");
    if (review.entityType === "contact") await tx.$queryRaw`SELECT id FROM "Contact" WHERE id = ${review.entityId} AND "tenantId" = ${tid} FOR UPDATE`;
    else await tx.$queryRaw`SELECT id FROM "Inquiry" WHERE id = ${review.entityId} AND "tenantId" = ${tid} FOR UPDATE`;
    const state = await assess(tx, auth, review);
    if (!state) throw new ApiError(404, "not_found", "Изменение не найдено");
    if (!state.editable) throw new ApiError(403, "forbidden", "Недостаточно прав для изменения этих полей");
    if ((decision === "accept" && review.status === "accepted") || (decision === "dismiss" && review.status === "dismissed") || (decision === "undo" && review.status === "undone")) return { status: review.status };
    if (decision === "undo" ? !["accepted", "automatic"].includes(review.status) : review.status !== "pending") throw new ApiError(409, "crm_review_closed", "Это предложение уже рассмотрено. Обновите список.");
    if (decision !== "dismiss" && state.blockedReason) throw new ApiError(409, "crm_review_changed", "Карточка или переписка изменилась. Запустите анализ заново; свежие данные сохранены.");
    let afterFingerprint = review.afterFingerprint;
    if (decision !== "dismiss") {
      const updated = await updateTarget(tx, tid, review, state.row, decision === "undo", auth.user.id);
      if (decision === "accept") afterFingerprint = crmReviewFingerprint(review.entityType, updated);
      if (decision === "accept") {
        // Keep other fields from this exact analysis reviewable after accepting
        // one field. Their displayed values do not change. Never rebase a stale
        // proposal, an overlapping field, or anything after an unrelated edit.
        const siblings = await tx.activity.findMany({ where: { tenantId: tid, type: "conversation.crm_proposed", id: { not: id }, AND: [
          { metadataJson: { path: ["review", "conversationId"], equals: conversationId } },
          { metadataJson: { path: ["review", "entityId"], equals: review.entityId } },
          { metadataJson: { path: ["review", "sourceMessageId"], equals: review.sourceMessageId } },
          { metadataJson: { path: ["review", "status"], equals: "pending" } },
        ] } });
        for (const sibling of siblings) {
          const other = readReview(sibling.metadataJson);
          if (other && other.beforeFingerprint === review.beforeFingerprint && other.fields.every(f => !review.fields.some(changed => changed.key === f.key))) {
            await tx.activity.update({ where: { id: sibling.id }, data: { metadataJson: json({ ...object(sibling.metadataJson), review: { ...other, beforeFingerprint: afterFingerprint } }) } });
          }
        }
      }
    }
    const status = decision === "accept" ? "accepted" : decision === "dismiss" ? "dismissed" : "undone";
    const updatedReview = { ...review, status, afterFingerprint };
    await tx.activity.update({ where: { id }, data: { metadataJson: json({ ...object(activity.metadataJson), review: updatedReview, reviewedBy: auth.user.id, reviewedAt: new Date().toISOString() }) } });
    const action = decision === "undo" ? "conversation.crm_undone" : "conversation.crm_reviewed";
    const metadata = { proposalId: id, decision, conversationId, sourceMessageId: review.sourceMessageId, evidenceMessageIds: review.evidenceMessageIds,
      fields: review.fields.map(f => ({ ...f, before: decision === "undo" ? f.after : f.before, after: decision === "undo" ? f.before : f.after })) };
    await writeAudit(tx, { tenantId: tid, actorUserId: auth.user.id, action, entityType: review.entityType,
      entityId: review.entityId, correlationId: review.sourceMessageId, changes: metadata });
    await tx.activity.create({ data: { tenantId: tid, contactId: review.contactId, inquiryId: review.entityType === "inquiry" ? review.entityId : null,
      type: action, title: decision === "undo" ? "Отменено изменение ИИ" : decision === "accept" ? "Подтверждено изменение ИИ" : "Отклонено предложение ИИ",
      description: changeDescription(metadata.fields), actorType: "user", actorId: auth.user.id, metadataJson: json(metadata) } });
    return { status };
  }, { timeout: 15000 });
}
