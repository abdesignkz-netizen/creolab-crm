import type { PrismaClient, Prisma } from "@creolab/db";
import { z } from "zod";
import { SALES_GOALS, dealRiskLabel } from "@creolab/contracts";
import type { AuthContext } from "../lib/types.ts";
import { conversationAccessWhere, dealAccessWhere, isManager, requireTenant } from "../lib/access.ts";
import { phoneFromContact, displayName } from "./contactLabels.ts";
import { tenantSalesSettings, salesRecord, ensureSalesNextTask, salesFollowUpDueAt } from "./salesProcessService.ts";
import { createStaffNotification } from "./notificationService.ts";
import { parseAIAutomationSettings } from "./aiAutomationSettings.ts";
import { getEffectiveTenantSettings } from "./runtimeSettings.ts";
import { writeActivity } from "./contactService.ts";
import { recordDealStageTransition } from "./dealStageHistory.ts";
import { parseOpsSettings } from "./dealPipeline.ts";
import { assessDealRisk } from "./dealRiskPolicy.ts";
import { dealRiskInclude, riskReadContext, riskReplyEvidence } from "./dealRiskService.ts";
import { businessDealWhere, MoneyDecimal } from "./financialMetrics.ts";

const salesInclude = (now: Date) => ({
  ...dealRiskInclude(now),
  contracts: { where: { status: "SIGNED" } }, payments: { where: { status: "confirmed" } },
  agreements: { where: { status: { in: ["CONFIRMED", "SCHEDULED", "RESCHEDULED", "COMPLETED"] } } },
  activities: { where: { type: { in: ["deal.created", "sales.qualified", "sales.proposal_sent", "sales.order_agreed", "sales.document_stage", "sales.goal_reached", "task.created", "task.updated", "task.completed"] } }, orderBy: { createdAt: "desc" as const } },
} satisfies Prisma.DealInclude);
type SalesDeal = Prisma.DealGetPayload<{ include: ReturnType<typeof salesInclude> }>;

function salesFacts(deal: SalesDeal, goal: keyof typeof SALES_GOALS) {
  const amount = new MoneyDecimal(deal.offerAmountMinor || 0);
  const paid = deal.payments.filter(p => p.currency === deal.currency).reduce((sum, p) => sum.plus(p.amountMinor), new MoneyDecimal(0));
  const hasPayment = amount.gt(0) && paid.gte(amount);
  const meeting = deal.agreements.some(a => ["CALL", "ONLINE_MEETING", "OFFLINE_MEETING"].includes(a.type) && a.scheduledAt);
  // Only actual delivery records or completed sending tasks are a sent proposal.
  const proposal = deal.activities.some(a => a.type === "sales.proposal_sent");
  const order = deal.contracts.length > 0 || deal.activities.some(a => a.type === "sales.order_agreed");
  const qualified = deal.activities.some(a => a.type === "sales.qualified" || a.type === "deal.created" && Boolean(salesRecord(a.metadataJson).sourceMessageId) && Array.isArray(salesRecord(a.metadataJson).evidenceMessageIds) && salesRecord(a.metadataJson).evidenceMessageIds.length > 0)
    || ["need_identified", "proposal_sent", "negotiation", "contract", "invoiced"].includes(deal.stage.systemKey);
  const reached = ({ qualified, meeting, proposal, order, payment: hasPayment })[goal];
  return { reached, hasPayment, closeToSale: !hasPayment && (order || deal.invoices.some(i => i.status !== "PAID")) };
}

const salesPageSchema = z.object({
  filter: z.enum(["all", "urgent", "attention", "ready", "goal"]).default("all"),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(200),
});
/** One database snapshot for counts, evidence and page details. A timeout fails
 * the request; it must never silently return a partial company's risk summary. */
export async function getSalesControl(prisma: PrismaClient, auth: AuthContext, query: unknown = {}) {
  requireTenant(auth);
  const page = salesPageSchema.parse(query);
  return prisma.$transaction(tx => readSalesControl(tx, auth, page), { isolationLevel: "RepeatableRead", timeout: 30_000 });
}

async function readSalesControl(prisma: Prisma.TransactionClient, auth: AuthContext, page: z.infer<typeof salesPageSchema>) {
  const { tenantId } = requireTenant(auth);
  const now = new Date();
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const settings = tenantSalesSettings(tenant.settingsJson);
  const where = { AND: [dealAccessWhere(auth), await businessDealWhere(prisma, tenantId), { outcome: { in: ["open", "on_hold"] } }] };
  const [proposals, members] = await Promise.all([
    prisma.activity.findMany({ where: { tenantId, type: "sales.deal_proposed", metadataJson: { path: ["status"], equals: "pending" },
      contact: { conversations: { some: conversationAccessWhere(auth) } } }, include: { contact: { include: { methods: true } } }, orderBy: { createdAt: "desc" }, take: 200 }),
    prisma.membership.findMany({ where: { tenantId, active: true, user: { status: "active" } }, select: { id: true, user: { select: { name: true } } }, orderBy: { createdAt: "asc" } }),
  ]);
  const proposalConversationIds = proposals.map(p => salesRecord(p.metadataJson).conversationId).filter((id): id is string => typeof id === "string");
  const conversations = await prisma.conversation.findMany({ where: { AND: [conversationAccessWhere(auth), { id: { in: proposalConversationIds } }] },
    select: { id: true, contactId: true, messageRevision: true, assigneeMembershipId: true, messages: { where: { direction: "inbound", senderKind: "client", internal: false },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1, select: { id: true, text: true } } } });
  const allowed = new Set(conversations.map(c => c.id));
  const proposalContacts = proposals.filter(p => allowed.has(salesRecord(p.metadataJson).conversationId)).map(p => p.contactId);
  const alternatives = proposalContacts.length ? await prisma.deal.findMany({ where: { AND: [dealAccessWhere(auth), { contactId: { in: proposalContacts }, outcome: { in: ["open", "on_hold"] } }] }, select: { id: true, title: true, contactId: true }, take: 500 }) : [];
  const ops = parseOpsSettings(tenant.settingsJson);
  async function describeDeals(deals: SalesDeal[]) {
    const historyTaskIds = deals.flatMap(d => d.activities.map(a => salesRecord(a.metadataJson).taskId)).filter((id): id is string => typeof id === "string");
    const riskContext = await riskReadContext(prisma, auth, deals, now, historyTaskIds);
    return deals.map(deal => {
    const facts = salesFacts(deal, settings.goal);
    const risk = assessDealRisk(riskContext.withMessages(deal), ops, tenant.timezone, settings.nextStepHours, now, riskContext.access);
    const task = deal.tasks.find(t => ["open", "in_progress", "waiting"].includes(t.status) && riskContext.access.taskIds.has(t.id));
    return { id: deal.id, title: deal.title, stage: deal.stage.name, outcome: deal.outcome, contactName: displayName(deal.contact), phone: phoneFromContact(deal.contact),
      ownerName: deal.assignee?.user.name || null, goalReached: facts.reached, closeToSale: facts.closeToSale, blockers: risk.signals.map(s => dealRiskLabel(s.code)), risk,
      nextAction: deal.nextAction || task?.title || null, nextActionAt: deal.nextActionAt || task?.dueAt || null,
      conversationId: deal.conversations.find(c => riskContext.access.conversationIds.has(c.conversationId))?.conversationId || null,
      history: deal.activities.filter(a => {
        const meta = salesRecord(a.metadataJson);
        if (a.type.startsWith("task.") && meta.taskId && !riskContext.access.taskIds.has(meta.taskId)) return false;
        return a.actorType === "ai" || a.type.startsWith("sales.") || a.actorType === "system" && a.type === "task.completed"
          || a.type === "task.created" && Boolean(meta.fingerprint);
      }).slice(0, 4).map(a => ({ title: a.title, description: a.description,
        createdAt: a.createdAt, reason: salesRecord(a.metadataJson).fingerprint ? dealRiskLabel(salesRecord(a.metadataJson).reason) : salesRecord(a.metadataJson).reason || null,
        sourceMessageId: salesRecord(a.metadataJson).sourceMessageId || null })),
    };
    });
  }
  const summary = { active: 0, urgent: 0, needsAttention: 0, closeToSale: 0, goalReached: 0 };
  const ranked: Array<{ id: string; priority: number; at: number }> = [];
  const priority = { urgent: 0, attention: 1, on_hold: 2, clear: 3 };
  let after: string | undefined;
  // Full coverage in bounded batches, retaining only ranking keys between them.
  // No 200-row cutoff in aggregates or in filtered pagination.
  for (;;) {
    const deals = await prisma.deal.findMany({ where: { AND: [where, ...(after ? [{ id: { gt: after } }] : [])] },
      include: salesInclude(now), orderBy: { id: "asc" }, take: 200 });
    for (const item of await describeDeals(deals)) {
      summary.active++;
      if (item.risk.priority === "urgent") summary.urgent++;
      if (item.blockers.length) summary.needsAttention++;
      if (item.closeToSale) summary.closeToSale++;
      if (item.goalReached) summary.goalReached++;
      if (page.filter === "all" || page.filter === "urgent" && item.risk.priority === "urgent"
        || page.filter === "attention" && item.blockers.length || page.filter === "ready" && item.closeToSale || page.filter === "goal" && item.goalReached) {
        ranked.push({ id: item.id, priority: priority[item.risk.priority], at: Math.min(...item.risk.signals.flatMap(s => s.at ? [Date.parse(s.at)] : [])) });
      }
    }
    if (deals.length < 200) break;
    after = deals.at(-1)!.id;
  }
  ranked.sort((a, b) => a.priority - b.priority || a.at - b.at || a.id.localeCompare(b.id));
  const ids = ranked.slice(page.offset, page.offset + page.limit).map(row => row.id);
  const details = ids.length ? await describeDeals(await prisma.deal.findMany({ where: { AND: [where, { id: { in: ids } }] }, include: salesInclude(now) })) : [];
  const byId = new Map(details.map(item => [item.id, item]));
  const items = ids.map(id => byId.get(id)!);
  const automation = parseAIAutomationSettings(tenant.settingsJson);
  return { settings, timezone: tenant.timezone, goalLabel: SALES_GOALS[settings.goal], automationReady: Boolean(!salesRecord(salesRecord(tenant.settingsJson).runtime).aiPaused && automation.crm?.enabled && automation.analyzeNewRequests !== false && !["MANUAL", "ASSIST"].includes(automation.defaultMode)),
    checkedAt: now.toISOString(), riskAssignees: !isManager(auth) ? members.map(m => ({ id: m.id, name: m.user.name })) : [],
    total: summary.active, proposalsLimited: proposals.length === 200, limited: ranked.length > items.length, items, summary, filter: page.filter,
    coverage: { total: summary.active, checked: summary.active, complete: true, checkedAt: now.toISOString() },
    pagination: { offset: page.offset, limit: page.limit, total: ranked.length, hasMore: page.offset + items.length < ranked.length },
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
    const deal = await tx.deal.findFirst({ where: { id: dealId, tenantId, outcome: "open" }, include: salesInclude(new Date()) });
    if (!deal) return;
    const facts = salesFacts(deal, settings.goal);
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
    if (settings.notifyResponsible) {
      const now = new Date(), fresh = await tx.deal.findUniqueOrThrow({ where: { id: dealId }, include: salesInclude(now) });
      const withMessages = await riskReplyEvidence(tx, tenantId, [fresh], now);
      const risk = assessDealRisk(withMessages(fresh), parseOpsSettings(tenant.settingsJson), tenant.timezone, settings.nextStepHours, now);
      const blockers = risk.signals.map(s => dealRiskLabel(s.code));
      if (blockers.length) await createStaffNotification(tx, { tenantId, membershipId: fresh.assigneeMembershipId, type: "sales.attention", entityType: "deal", entityId: dealId,
        title: "Сделке нужно внимание", body: `${displayName(fresh.contact)} ${phoneFromContact(fresh.contact) || ""} — ${fresh.title}: ${blockers.join("; ")}`, episodeKey: `sales-attention:${dealId}:${fresh.nextActionAt?.toISOString() || "none"}:${fresh.assigneeMembershipId || "none"}:${blockers.join("|")}` });
    }
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
