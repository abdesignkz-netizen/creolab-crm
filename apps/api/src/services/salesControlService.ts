import type { PrismaClient, Prisma } from "@creolab/db";
import { SALES_GOALS } from "@creolab/contracts";
import type { AuthContext } from "../lib/types.ts";
import { conversationAccessWhere, dealAccessWhere, requireTenant } from "../lib/access.ts";
import { phoneFromContact, displayName } from "./contactLabels.ts";
import { tenantSalesSettings, salesRecord, ensureSalesNextTask, salesFollowUpDueAt } from "./salesProcessService.ts";
import { createStaffNotification } from "./notificationService.ts";
import { parseAIAutomationSettings } from "./aiAutomationSettings.ts";
import { getEffectiveTenantSettings } from "./runtimeSettings.ts";
import { writeActivity } from "./contactService.ts";
import { recordDealStageTransition } from "./dealStageHistory.ts";

const include = {
  stage: true, contact: { include: { methods: true } }, assignee: { include: { user: true } },
  tasks: { where: { status: { in: ["open", "in_progress", "waiting"] } }, orderBy: { dueAt: "asc" as const } },
  invoices: { where: { status: { in: ["ISSUED", "SENT", "PAID", "PARTIALLY_PAID", "OVERDUE"] } } },
  contracts: { where: { status: "SIGNED" } }, payments: { where: { status: "confirmed" } },
  agreements: { where: { status: { in: ["CONFIRMED", "SCHEDULED", "RESCHEDULED", "COMPLETED"] } } },
  conversations: { include: { conversation: { select: { id: true, waitingFor: true, needsAttention: true, attentionReason: true } } } },
  activities: { where: { type: { in: ["deal.created", "sales.qualified", "sales.proposal_sent", "sales.order_agreed", "sales.document_stage", "sales.goal_reached", "task.created", "task.updated", "task.completed"] } }, orderBy: { createdAt: "desc" as const } },
} satisfies Prisma.DealInclude;
type SalesDeal = Prisma.DealGetPayload<{ include: typeof include }>;

function salesFacts(deal: SalesDeal, goal: keyof typeof SALES_GOALS) {
  const amount = Number(deal.offerAmountMinor || 0);
  const paid = deal.payments.filter(p => p.currency === deal.currency).reduce((sum, p) => sum + Number(p.amountMinor), 0);
  const hasPayment = amount > 0 && paid >= amount;
  const meeting = deal.agreements.some(a => ["CALL", "ONLINE_MEETING", "OFFLINE_MEETING"].includes(a.type) && a.scheduledAt);
  // Only actual delivery records or completed sending tasks are a sent proposal.
  const proposal = deal.activities.some(a => a.type === "sales.proposal_sent");
  const order = deal.contracts.length > 0 || deal.activities.some(a => a.type === "sales.order_agreed");
  const qualified = deal.activities.some(a => a.type === "sales.qualified" || a.type === "deal.created" && Boolean(salesRecord(a.metadataJson).sourceMessageId) && Array.isArray(salesRecord(a.metadataJson).evidenceMessageIds) && salesRecord(a.metadataJson).evidenceMessageIds.length > 0)
    || ["need_identified", "proposal_sent", "negotiation", "contract", "invoiced"].includes(deal.stage.systemKey);
  const reached = ({ qualified, meeting, proposal, order, payment: hasPayment })[goal];
  const blockers: string[] = [];
  if (!deal.assigneeMembershipId || !deal.assignee?.active || deal.assignee.user.status !== "active") blockers.push("Не назначен действующий ответственный");
  if (!deal.tasks.length && !hasPayment) blockers.push(deal.nextAction ? "Проверьте следующий шаг: открытых задач нет" : "Не запланирован следующий шаг");
  if (deal.tasks.some(t => t.dueAt && t.dueAt < new Date()) || deal.nextActionAt && deal.nextActionAt < new Date()) blockers.push("Просрочен следующий шаг");
  if (deal.tasks.some(t => ["failed", "unknown"].includes(t.executionStatus))) blockers.push("Не подтверждено выполнение задачи");
  if (deal.conversations.some(c => c.conversation.waitingFor === "MANAGER")) blockers.push("Клиент ждёт сотрудника");
  if (deal.invoices.some(i => i.dueDate && i.dueDate < new Date()) && !hasPayment) blockers.push("Нужно проверить оплату счёта");
  if (deal.outcome === "on_hold") blockers.push("Сделка на паузе");
  return { reached, blockers, hasPayment, closeToSale: !hasPayment && (order || deal.invoices.length > 0), paid, amount };
}

/** Shared data for the page and WhatsApp. Never includes other staff's restricted deals. */
export async function getSalesControl(prisma: PrismaClient, auth: AuthContext) {
  const { tenantId } = requireTenant(auth);
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const settings = tenantSalesSettings(tenant.settingsJson);
  const where = { AND: [dealAccessWhere(auth), { outcome: { in: ["open", "on_hold"] } }] };
  const [deals, count, proposals] = await Promise.all([
    prisma.deal.findMany({ where, include, orderBy: [{ nextActionAt: "asc" }, { id: "asc" }], take: 200 }),
    prisma.deal.count({ where }),
    prisma.activity.findMany({ where: { tenantId, type: "sales.deal_proposed", metadataJson: { path: ["status"], equals: "pending" },
      contact: { conversations: { some: conversationAccessWhere(auth) } } }, include: { contact: { include: { methods: true } } }, orderBy: { createdAt: "desc" }, take: 200 }),
  ]);
  const proposalConversationIds = proposals.map(p => salesRecord(p.metadataJson).conversationId).filter((id): id is string => typeof id === "string");
  const conversations = await prisma.conversation.findMany({ where: { AND: [conversationAccessWhere(auth), { id: { in: proposalConversationIds } }] },
    select: { id: true, contactId: true, messageRevision: true, assigneeMembershipId: true, messages: { where: { direction: "inbound", senderKind: "client", internal: false },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1, select: { id: true, text: true } } } });
  const allowed = new Set(conversations.map(c => c.id));
  const proposalContacts = proposals.filter(p => allowed.has(salesRecord(p.metadataJson).conversationId)).map(p => p.contactId);
  const alternatives = proposalContacts.length ? await prisma.deal.findMany({ where: { AND: [dealAccessWhere(auth), { contactId: { in: proposalContacts }, outcome: { in: ["open", "on_hold"] } }] }, select: { id: true, title: true, contactId: true }, take: 500 }) : [];
  const items = deals.map(deal => {
    const facts = salesFacts(deal, settings.goal);
    return { id: deal.id, title: deal.title, stage: deal.stage.name, outcome: deal.outcome, contactName: displayName(deal.contact), phone: phoneFromContact(deal.contact),
      ownerName: deal.assignee?.user.name || null, goalReached: facts.reached, closeToSale: facts.closeToSale, blockers: facts.blockers,
      nextAction: deal.nextAction || deal.tasks[0]?.title || null, nextActionAt: deal.nextActionAt || deal.tasks[0]?.dueAt || null,
      conversationId: deal.conversations[0]?.conversationId || null,
      history: deal.activities.filter(a => a.actorType === "ai" || a.type.startsWith("sales.") || a.actorType === "system" && a.type === "task.completed").slice(0, 4).map(a => ({ title: a.title, description: a.description,
        createdAt: a.createdAt, reason: salesRecord(a.metadataJson).reason || null, sourceMessageId: salesRecord(a.metadataJson).sourceMessageId || null })),
    };
  });
  const automation = parseAIAutomationSettings(tenant.settingsJson);
  return { settings, timezone: tenant.timezone, goalLabel: SALES_GOALS[settings.goal], automationReady: Boolean(!salesRecord(salesRecord(tenant.settingsJson).runtime).aiPaused && automation.crm?.enabled && automation.analyzeNewRequests !== false && !["MANUAL", "ASSIST"].includes(automation.defaultMode)),
    total: count, proposalsLimited: proposals.length === 200, limited: count > items.length, items,
    summary: { active: count, needsAttention: items.filter(i => i.blockers.length).length, closeToSale: items.filter(i => i.closeToSale).length, goalReached: items.filter(i => i.goalReached).length },
    proposals: proposals.filter(p => allowed.has(salesRecord(p.metadataJson).conversationId)).map(p => { const c = salesRecord(p.metadataJson);
      const thread = conversations.find(v => v.id === c.conversationId)!;
      return { id: p.id, title: c.title, reason: c.reason, nextAction: c.nextAction, contactName: displayName(p.contact), phone: phoneFromContact(p.contact),
        revision: thread.messageRevision, changed: thread.messages[0]?.id !== c.sourceMessageId, latestMessage: thread.messages[0]?.text?.slice(0, 1000) || null, conversationId: c.conversationId, evidenceMessageIds: c.evidenceMessageIds, alternatives: alternatives.filter(d => d.contactId === p.contactId) };
    }),
  };
}

/** Reconcile from persisted document/payment facts, never from a model's claim. */
export async function reconcileSalesDeal(prisma: PrismaClient, tenantId: string, dealId: string) {
  if (!(await getEffectiveTenantSettings(prisma, tenantId)).ai.enabled) return;
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Deal" WHERE id = ${dealId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const settings = tenantSalesSettings(tenant.settingsJson);
    if (settings.mode === "off" || tenant.status !== "active" || salesRecord(salesRecord(tenant.settingsJson).runtime).aiPaused) return;
    const deal = await tx.deal.findFirst({ where: { id: dealId, tenantId, outcome: "open" }, include });
    if (!deal) return;
    let facts = salesFacts(deal, settings.goal);
    let aiPlanChanged = false;
    const targetKey = deal.invoices.length ? "invoiced" : deal.contracts.length ? "contract" : null;
    if (settings.syncDocuments && targetKey) {
      const target = await tx.dealStage.findFirst({ where: { tenantId, systemKey: targetKey, isTerminal: false, isArchived: false } });
      if (target && target.sortOrder > deal.stage.sortOrder) {
        const enteredAt = new Date();
        await tx.deal.update({ where: { id: deal.id }, data: { stageId: target.id, stageEnteredAt: enteredAt, probability: target.defaultProbability, version: { increment: 1 } } });
        const managed = deal.tasks.find(t => t.dedupeKey === `sales-next:${deal.id}`);
        const prior = salesRecord(managed?.contextSnapshotJson).salesManaged;
        // Only replace a system-managed next step. A human's plan remains authoritative.
        if (!deal.nextAction?.trim() || managed?.status === "open" && prior && !prior.manualPlan && managed.title === prior.title && deal.nextAction === prior.title && managed.dueAt?.toISOString() === prior.dueAt && managed.ownerMembershipId === prior.ownerId) {
          const nextAction = targetKey === "invoiced" ? "Проверить поступление оплаты по счёту" : "Подготовить и согласовать счёт";
          const nextActionAt = !deal.nextAction?.trim() && deal.nextActionAt || targetKey === "invoiced" && deal.invoices[0]?.dueDate || salesFollowUpDueAt(tenant, settings.nextStepHours);
          await tx.deal.update({ where: { id: deal.id }, data: { nextAction, nextActionAt } });
          aiPlanChanged = true;
        }
        const reason = targetKey === "invoiced" ? "В системе выставлен счёт" : "В системе подтверждено подписание договора";
        await recordDealStageTransition(tx, { tenantId, dealId, fromStageId: deal.stageId, toStageId: target.id, fromSystemKey: deal.stage.systemKey, toSystemKey: targetKey, enteredAt, changedByType: "sales_automation", note: reason });
        await writeActivity(tx, { tenantId, contactId: deal.contactId, dealId, type: "sales.document_stage", title: `Этап: ${target.name}`, description: reason, actorType: "system", metadata: { reason, invoiceId: deal.invoices[0]?.id, contractId: deal.contracts[0]?.id } });
      }
    }
    // Reaching a goal is distinct from closing the sale; a person still closes it.
    const goalKey = `sales-goal:${dealId}:${settings.goal}`;
    if (facts.reached && !await tx.activity.count({ where: { tenantId, dealId, type: "sales.goal_reached", metadataJson: { path: ["goal"], equals: settings.goal } } })) {
      await writeActivity(tx, { tenantId, contactId: deal.contactId, dealId, type: "sales.goal_reached", title: "Цель сопровождения достигнута", description: SALES_GOALS[settings.goal], actorType: "system", metadata: { goal: settings.goal, reason: "Подтверждено данными сделки" } });
      if (settings.notifyResponsible) await createStaffNotification(tx, { tenantId, membershipId: deal.assigneeMembershipId, type: "deal.updated", entityType: "deal", entityId: dealId, title: "Цель сделки достигнута", body: `${displayName(deal.contact)} ${phoneFromContact(deal.contact) || ""} — ${deal.title}: ${SALES_GOALS[settings.goal]}`, episodeKey: goalKey });
    }
    if (facts.hasPayment) {
      const task = deal.tasks.find(t => t.dedupeKey === `sales-next:${dealId}` && t.status === "open");
      const previous = salesRecord(task?.contextSnapshotJson).salesManaged;
      if (task && previous && !previous.manualPlan && task.title === "Проверить поступление оплаты по счёту" && task.title === previous.title && task.dueAt?.toISOString() === previous.dueAt && task.ownerMembershipId === previous.ownerId) {
        await tx.task.update({ where: { id: task.id }, data: { status: "done", completedAt: new Date() } });
        if (deal.nextAction === task.title) await tx.deal.update({ where: { id: dealId }, data: { nextAction: "Проверить результат и завершить сделку", nextActionAt: null, version: { increment: 1 } } });
        await writeActivity(tx, { tenantId, contactId: deal.contactId, dealId, type: "task.completed", title: "Оплата проверена", actorType: "system", metadata: { taskId: task.id, reason: "Подтверждённые поступления покрывают сумму сделки" } });
      }
    } else await ensureSalesNextTask(tx, tenantId, dealId, undefined, aiPlanChanged);
    facts = salesFacts(await tx.deal.findUniqueOrThrow({ where: { id: dealId }, include }), settings.goal);
    if (settings.notifyResponsible && facts.blockers.length) await createStaffNotification(tx, { tenantId, membershipId: deal.assigneeMembershipId, type: "sales.attention", entityType: "deal", entityId: dealId,
      title: "Сделке нужно внимание", body: `${displayName(deal.contact)} ${phoneFromContact(deal.contact) || ""} — ${deal.title}: ${facts.blockers.join("; ")}`, episodeKey: `sales-attention:${dealId}:${deal.nextActionAt?.toISOString() || "none"}:${deal.assigneeMembershipId || "none"}:${facts.blockers.join("|")}` });
  });
}

// A persisted cursor makes the bounded sweep fair across restarts and large tenants.
export async function sweepSalesProcesses(prisma: PrismaClient) {
  const key = { scope: "sales.sweep", actorKey: "system", key: "cursor" };
  const cursor = await prisma.idempotencyRecord.findUnique({ where: { scope_actorKey_key: key } });
  const after = String(salesRecord(cursor?.resultJson).after || "");
  const deals = await prisma.deal.findMany({ where: { id: { gt: after }, outcome: "open", tenant: { status: "active", settingsJson: { path: ["aiAutomation", "salesProcess", "mode"], not: "off" } } }, select: { id: true, tenantId: true }, orderBy: { id: "asc" }, take: 50 });
  for (const deal of deals) {
    try { await reconcileSalesDeal(prisma, deal.tenantId, deal.id); }
    catch (error) { console.error("sales_reconcile_failed", deal.id, error instanceof Error ? error.message : "unknown"); }
  }
  await prisma.idempotencyRecord.upsert({ where: { scope_actorKey_key: key }, create: { ...key, requestHash: "sweep", resultJson: { after: deals.length === 50 ? deals.at(-1)!.id : "" }, expiresAt: new Date(Date.now() + 86400000) }, update: { resultJson: { after: deals.length === 50 ? deals.at(-1)!.id : "" }, expiresAt: new Date(Date.now() + 86400000) } });
}
