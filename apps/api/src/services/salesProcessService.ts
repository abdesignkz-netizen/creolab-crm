import { randomUUID } from "node:crypto";
import { parseSalesProcess, taskCreatorSnapshot, type SalesProcessSettings } from "@creolab/contracts";
import type { Prisma, PrismaClient } from "@creolab/db";
import type { AuthContext } from "../lib/types.ts";
import { assertConversationReachable, assertDealVisible, isManager, requireTenant } from "../lib/access.ts";
import { displayName, phoneFromContact } from "./contactLabels.ts";
import { ApiError } from "../errors.ts";
import { writeActivity } from "./contactService.ts";
import { createStaffNotification } from "./notificationService.ts";
import type { ConversationAnalysis } from "./conversationContextTypes.ts";

type Tx = Prisma.TransactionClient;
export const salesRecord = (raw: unknown): Record<string, any> => raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, any> : {};
const json = (raw: unknown) => JSON.parse(JSON.stringify(raw)) as Prisma.InputJsonValue;
export function tenantSalesSettings(raw: unknown) { return parseSalesProcess(salesRecord(salesRecord(raw).aiAutomation).salesProcess); }
type Candidate = { conversationId: string; inquiryId: string | null; contactId: string; sourceMessageId: string;
  messageRevision: number; title: string; nextAction: string; ownerId: string | null; reason: string; evidenceMessageIds: string[] };

async function activeOwner(tx: Tx, tid: string, ids: Array<string | null | undefined>) {
  for (const id of ids.filter(Boolean)) {
    const member = await tx.membership.findFirst({ where: { id: id!, tenantId: tid, active: true, user: { status: "active" } } });
    if (member) return member.id;
  }
  return null;
}

/** Runs only after the context engine's tenant, mode, evidence and revision checks. */
export async function considerSalesOpportunity(tx: Tx, tid: string, args: {
  conversationId: string; sourceMessageId: string; messageRevision: number; analysis: ConversationAnalysis;
}) {
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tid } });
  const settings = tenantSalesSettings(tenant.settingsJson), analysis = args.analysis;
  if (settings.mode === "off" || analysis.confidence !== "HIGH" || !analysis.detectedNeed?.trim()) return null;
  const conversation = await tx.conversation.findFirst({ where: { id: args.conversationId, tenantId: tid }, include: { contact: { include: { methods: true } } } });
  if (!conversation?.contactId || !conversation.contact || conversation.contact.archivedAt || salesRecord(conversation.contact.attributionJson).doNotContact) return null;
  const source = await tx.message.findFirst({ where: { id: args.sourceMessageId, tenantId: tid, conversationId: conversation.id, direction: "inbound", senderKind: "client", internal: false } });
  if (!source) return null;
  const interest = analysis.events?.find(e => ["CLIENT_INTEREST_CONFIRMED", "COMMERCIAL_OFFER_REQUESTED", "PRICE_ACCEPTED", "CONTRACT_REQUESTED"].includes(e.type)
    && e.confidence === "HIGH" && e.evidenceMessageIds.includes(source.id));
  if (!interest || analysis.events?.some(e => ["PRICE_REJECTED", "DEAL_LOST"].includes(e.type))) return null;
  if (!interest.evidenceMessageIds.length || await tx.message.count({ where: { id: { in: interest.evidenceMessageIds }, tenantId: tid, conversationId: conversation.id, internal: false } }) !== new Set(interest.evidenceMessageIds).size) return null;
  // One contact lock serializes opportunities arriving from different channels.
  await tx.$queryRaw`SELECT id FROM "Contact" WHERE id = ${conversation.contactId} AND "tenantId" = ${tid} FOR UPDATE`;
  const inquiry = await tx.inquiry.findFirst({ where: { tenantId: tid, conversationId: conversation.id, archived: false }, orderBy: { receivedAt: "desc" } });
  const linked = await tx.deal.findFirst({ where: { tenantId: tid, contactId: conversation.contactId,
    OR: [{ conversations: { some: { conversationId: conversation.id } } }, ...(inquiry?.dealId ? [{ id: inquiry.dealId }] : [])] } });
  // An already linked order is never recreated, including after it was closed.
  if (linked || inquiry && ["lost", "rejected", "spam", "converted"].includes(inquiry.status)) return null;
  const existing = await tx.activity.findFirst({ where: { tenantId: tid, contactId: conversation.contactId, type: "sales.deal_proposed",
    metadataJson: { path: ["conversationId"], equals: conversation.id } }, orderBy: { createdAt: "desc" } });
  if (existing && salesRecord(existing.metadataJson).status !== "pending") return null;
  const open = await tx.deal.count({ where: { tenantId: tid, contactId: conversation.contactId, outcome: { in: ["open", "on_hold"] } } });
  const ownerId = await activeOwner(tx, tid, [conversation.assigneeMembershipId, inquiry?.assigneeMembershipId, conversation.contact.ownerMembershipId, settings.assigneeMembershipId]);
  const candidate: Candidate = { ...args, inquiryId: inquiry?.id || null, contactId: conversation.contactId,
    title: analysis.detectedNeed.trim().slice(0, 250), nextAction: analysis.suggestedNextAction?.trim().slice(0, 500) || "Уточнить требования и согласовать следующий шаг",
    ownerId, reason: open ? "У клиента уже есть сделки: выберите существующую или подтвердите отдельный заказ" : analysis.humanRequired ? analysis.humanReason || "Нужно участие сотрудника" : "Клиент подтвердил интерес; потребность определена",
    evidenceMessageIds: interest.evidenceMessageIds };
  // Do not persist the entire model response; only the bounded, grounded proposal.
  const metadata = json({ conversationId: candidate.conversationId, inquiryId: candidate.inquiryId, contactId: candidate.contactId,
    sourceMessageId: candidate.sourceMessageId, messageRevision: candidate.messageRevision, title: candidate.title,
    nextAction: candidate.nextAction, ownerId, reason: candidate.reason, evidenceMessageIds: candidate.evidenceMessageIds, status: "pending" });
  if (settings.mode === "auto" && !open && !analysis.humanRequired && !existing) return createSalesDeal(tx, tid, candidate, settings);
  const proposal = existing ? await tx.activity.update({ where: { id: existing.id }, data: { title: "Предложена сделка", description: candidate.title, metadataJson: metadata } })
    : await tx.activity.create({ data: { tenantId: tid, contactId: candidate.contactId, inquiryId: candidate.inquiryId, type: "sales.deal_proposed", title: "Предложена сделка", description: candidate.title, actorType: "ai", metadataJson: metadata } });
  if (settings.notifyResponsible && !existing) await createStaffNotification(tx, { tenantId: tid, membershipId: ownerId, type: "sales.proposal", entityType: "conversation", entityId: conversation.id,
    title: "Нужно проверить новую сделку", body: `${displayName(conversation.contact)} ${phoneFromContact(conversation.contact) || ""} — ${candidate.title}. ${candidate.reason}`, episodeKey: `sales-proposal:${proposal.id}` });
  return null;
}

async function createSalesDeal(tx: Tx, tid: string, c: Candidate, settings: SalesProcessSettings, actorId?: string) {
  const stage = await tx.dealStage.upsert({ where: { tenantId_systemKey: { tenantId: tid, systemKey: "new" } },
    update: {}, create: { tenantId: tid, systemKey: "new", name: "Новая", sortOrder: 1, defaultProbability: 10 } });
  const inquiry = c.inquiryId ? await tx.inquiry.findFirst({ where: { id: c.inquiryId, tenantId: tid, contactId: c.contactId } }) : null;
  const ownerId = await activeOwner(tx, tid, [c.ownerId, settings.assigneeMembershipId]);
  const dueAt = new Date(Date.now() + settings.nextStepHours * 3600000);
  const deal = await tx.deal.create({ data: { tenantId: tid, contactId: c.contactId, companyId: inquiry?.companyId,
    inquiryId: inquiry?.id, title: c.title, description: c.reason, stageId: stage.id, assigneeMembershipId: ownerId,
    nextAction: c.nextAction, nextActionAt: dueAt, currency: (await tx.tenant.findUniqueOrThrow({ where: { id: tid } })).currency,
  } });
  await linkSalesDeal(tx, tid, c, deal.id);
  await tx.dealStageHistory.create({ data: { tenantId: tid, dealId: deal.id, toStageId: stage.id, toSystemKey: stage.systemKey,
    changedByType: actorId ? "user" : "sales_automation", changedById: actorId, note: c.reason } });
  await writeActivity(tx, { tenantId: tid, contactId: c.contactId, inquiryId: inquiry?.id, dealId: deal.id,
    type: "deal.created", title: actorId ? "Сделка создана по предложению ИИ" : "ИИ создал сделку", description: c.title,
    actorType: actorId ? "user" : "ai", actorId, metadata: { reason: c.reason, sourceMessageId: c.sourceMessageId, conversationId: c.conversationId, evidenceMessageIds: c.evidenceMessageIds } });
  await tx.auditEvent.create({ data: { tenantId: tid, actorUserId: actorId, action: "sales.deal_created", entityType: "deal", entityId: deal.id,
    correlationId: c.sourceMessageId, changesJson: json({ reason: c.reason, conversationId: c.conversationId, evidenceMessageIds: c.evidenceMessageIds }) } });
  const client = await tx.contact.findUniqueOrThrow({ where: { id: c.contactId }, include: { methods: true } });
  if (settings.notifyResponsible) await createStaffNotification(tx, { tenantId: tid, membershipId: ownerId, type: "deal.updated", entityType: "deal", entityId: deal.id,
    title: "Создана сделка", body: `${displayName(client)} ${phoneFromContact(client) || ""} — ${c.title}. Следующий шаг: ${c.nextAction}`, episodeKey: `sales-created:${deal.id}` });
  return deal;
}

async function linkSalesDeal(tx: Tx, tid: string, c: Candidate, dealId: string) {
  await tx.dealConversation.upsert({ where: { tenantId_dealId_conversationId: { tenantId: tid, dealId, conversationId: c.conversationId } }, update: {}, create: { tenantId: tid, dealId, conversationId: c.conversationId } });
  if (c.inquiryId) {
    const inquiry = await tx.inquiry.findFirst({ where: { id: c.inquiryId, tenantId: tid, contactId: c.contactId } });
    // InquiryDeal is one-to-one; retain other order requests through DealConversation and activity.
    const already = await tx.inquiry.findFirst({ where: { tenantId: tid, dealId } });
    if (inquiry && !inquiry.dealId && !already) {
      await tx.inquiry.update({ where: { id: inquiry.id }, data: { dealId, status: "converted", convertedAt: new Date(), nextStep: "Вести сделку", version: { increment: 1 } } });
      await tx.inquiryStatusHistory.create({ data: { tenantId: tid, inquiryId: inquiry.id, fromStatus: inquiry.status, toStatus: "converted", changedByType: "sales_automation", note: "Связана со сделкой" } });
    }
    await tx.task.updateMany({ where: { tenantId: tid, inquiryId: c.inquiryId, dealId: null, status: { in: ["open", "in_progress", "waiting"] } }, data: { dealId } });
  }
}

/** One managed next-step task; manual edits and explicit completion are preserved. */
export async function ensureSalesNextTask(tx: Tx, tid: string, dealId: string, conversationId?: string, aiPlanChanged = false) {
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tid } });
  const settings = tenantSalesSettings(tenant.settingsJson);
  if (settings.mode === "off" || !settings.ensureNextStep || salesRecord(salesRecord(tenant.settingsJson).runtime).aiPaused) return;
  await tx.$queryRaw`SELECT id FROM "Deal" WHERE id = ${dealId} AND "tenantId" = ${tid} FOR UPDATE`;
  const deal = await tx.deal.findFirst({ where: { id: dealId, tenantId: tid, outcome: "open" } });
  if (!deal) return;
  const key = `sales-next:${dealId}`;
  let managed = await tx.task.findFirst({ where: { tenantId: tid, dedupeKey: key } });
  const changes: Array<{ id: string; before: typeof managed }> = [];
  const other = await tx.task.findFirst({ where: { tenantId: tid, dealId, status: { in: ["open", "in_progress", "waiting"] }, OR: [{ dedupeKey: null }, { dedupeKey: { not: key } }] }, orderBy: { dueAt: "asc" } });
  if (other) return;
  const title = deal.nextAction || "Согласовать следующий шаг с клиентом";
  const dueAt = deal.nextActionAt || managed?.dueAt || new Date(Date.now() + settings.nextStepHours * 3600000);
  const old = salesRecord(managed?.contextSnapshotJson).salesManaged;
  // A new, explicitly changed step may follow a completed task; never reopen the old one.
  if (managed?.status === "done" && old && deal.nextAction && (deal.nextAction !== old.title || deal.nextActionAt && deal.nextActionAt.toISOString() !== old.dueAt)) {
    changes.push({ id: managed.id, before: managed });
    await tx.task.update({ where: { id: managed.id }, data: { dedupeKey: `${key}:done:${managed.id}` } });
    managed = null;
  }
  if (managed && (managed.status !== "open" || managed.title !== old?.title || managed.dueAt?.toISOString() !== old?.dueAt || managed.ownerMembershipId !== old?.ownerId)) return;
  if (managed && salesRecord(managed.contextSnapshotJson).manualEditId) return;
  if (managed && managed.title === title && managed.dueAt?.getTime() === dueAt.getTime() && managed.ownerMembershipId === deal.assigneeMembershipId) return;
  const data = { title, dueAt, ownerMembershipId: deal.assigneeMembershipId,
    contextSnapshotJson: json(taskCreatorSnapshot({ createdByKind: "ai", executorType: "USER", existing: { ...salesRecord(managed?.contextSnapshotJson), salesManaged: { title, dueAt: dueAt.toISOString(), ownerId: deal.assigneeMembershipId, manualPlan: Boolean(old?.manualPlan || old && !aiPlanChanged && (title !== old.title || dueAt.toISOString() !== old.dueAt)) } } })) };
  const task = managed ? await tx.task.update({ where: { id: managed.id }, data }) : await tx.task.create({ data: {
    ...data, tenantId: tid, contactId: deal.contactId, dealId, inquiryId: deal.inquiryId, conversationId, type: "follow_up", source: "sales_automation", targetType: "client", dedupeKey: key,
  } });
  await writeActivity(tx, { tenantId: tid, contactId: deal.contactId, dealId, type: managed ? "task.updated" : "task.created",
    title: managed ? "Обновлён следующий шаг" : "Создан следующий шаг", description: title, actorType: "ai", metadata: { taskId: task.id, dueAt: dueAt.toISOString(), reason: "Правило сопровождения сделки" } });
  changes.push({ id: task.id, before: managed });
  return changes;
}

export async function reviewSalesProposal(prisma: PrismaClient, auth: AuthContext, id: string, input: { decision: "create" | "link" | "dismiss"; dealId?: string; revision: number; confirmedLatest?: boolean }) {
  const { tenantId: tid } = requireTenant(auth);
  return prisma.$transaction(async tx => {
    const proposal = await tx.activity.findFirst({ where: { id, tenantId: tid, type: "sales.deal_proposed" } });
    if (!proposal) throw new ApiError(404, "not_found", "Предложение не найдено");
    let c = salesRecord(proposal.metadataJson) as Candidate & { status: string };
    await assertConversationReachable(tx, auth, c.conversationId);
    await tx.$queryRaw`SELECT id FROM "Conversation" WHERE id = ${c.conversationId} AND "tenantId" = ${tid} FOR UPDATE`;
    const conversation = await tx.conversation.findUniqueOrThrow({ where: { id: c.conversationId } });
    if (isManager(auth) && conversation.assigneeMembershipId !== auth.activeMembership!.id) throw new ApiError(403, "forbidden", "Сначала возьмите диалог в работу");
    await tx.$queryRaw`SELECT id FROM "Contact" WHERE id = ${proposal.contactId} AND "tenantId" = ${tid} FOR UPDATE`;
    const fresh = await tx.activity.findUniqueOrThrow({ where: { id } });
    const data = salesRecord(fresh.metadataJson);
    c = data as Candidate & { status: string };
    if (data.status !== "pending") return { status: data.status, dealId: fresh.dealId };
    if (input.decision !== "dismiss" && conversation.messageRevision !== input.revision) throw new ApiError(409, "sales_changed", "Переписка изменилась. Обновите анализ диалога и проверьте предложение снова.");
    const lastClient = await tx.message.findFirst({ where: { tenantId: tid, conversationId: c.conversationId, direction: "inbound", senderKind: "client", internal: false }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    if (input.decision !== "dismiss" && lastClient?.id !== c.sourceMessageId && !input.confirmedLatest) throw new ApiError(409, "sales_review_required", "Клиент написал новое сообщение. Проверьте переписку и подтвердите актуальность предложения.");
    const settings = tenantSalesSettings((await tx.tenant.findUniqueOrThrow({ where: { id: tid } })).settingsJson);
    if (settings.mode === "off" && input.decision !== "dismiss") throw new ApiError(409, "sales_disabled", "Сопровождение продаж отключено");
    let dealId: string | null = null;
    if (input.decision === "link") {
      const deal = await tx.deal.findFirst({ where: { id: input.dealId || "", tenantId: tid, contactId: proposal.contactId, outcome: { in: ["open", "on_hold"] } } });
      if (!deal) throw new ApiError(422, "invalid", "Выберите активную сделку этого клиента");
      assertDealVisible(auth, deal); dealId = deal.id;
      await linkSalesDeal(tx, tid, c, dealId);
      await writeActivity(tx, { tenantId: tid, contactId: c.contactId, dealId, type: "sales.qualified", title: "Подтверждён интерес клиента", description: c.title,
        actorType: "user", actorId: auth.user.id, metadata: { reason: c.reason, sourceMessageId: c.sourceMessageId, evidenceMessageIds: c.evidenceMessageIds, conversationId: c.conversationId } });
    } else if (input.decision === "create") {
      const linked = await tx.dealConversation.findFirst({ where: { tenantId: tid, conversationId: c.conversationId } });
      if (linked) throw new ApiError(409, "sales_changed", "Диалог уже связан со сделкой. Обновите страницу.");
      c.ownerId = await activeOwner(tx, tid, [conversation.assigneeMembershipId, c.ownerId, settings.assigneeMembershipId]);
      dealId = (await createSalesDeal(tx, tid, c, settings, auth.user.id)).id;
    }
    if (dealId) { await ensureSalesNextTask(tx, tid, dealId, c.conversationId); await enqueueSalesReconcile(tx, tid, dealId); }
    await tx.activity.update({ where: { id }, data: { dealId, actorId: auth.user.id, metadataJson: json({ ...data, status: input.decision, reviewedBy: auth.user.id }) } });
    await tx.auditEvent.create({ data: { tenantId: tid, actorUserId: auth.user.id, action: "sales.proposal_reviewed", entityType: "activity", entityId: id, changesJson: { decision: input.decision, dealId } } });
    return { status: input.decision, dealId };
  });
}

export async function enqueueSalesReconcile(tx: Tx | PrismaClient, tid: string, dealId: string) {
  if (tenantSalesSettings((await tx.tenant.findUniqueOrThrow({ where: { id: tid } })).settingsJson).mode === "off") return;
  return tx.outboxEvent.create({ data: { id: randomUUID(), tenantId: tid, type: "sales.reconcile", entityType: "deal", entityId: dealId, payloadJson: {} } });
}
