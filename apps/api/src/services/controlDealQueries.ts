import { z } from "zod";
import { Prisma } from "@creolab/db";
import { ApiError } from "../errors.ts";
import { dealAccessWhere, requireTenant } from "../lib/access.ts";
import { phoneFromContact, displayName } from "./contactLabels.ts";
import { controlReadFilters, type ReadContext } from "./controlReadQueries.ts";
import { PROCESS_OPEN_TASK_STATUSES } from "./dealProcessPolicy.ts";
import { deliveredConversationMessage } from "./conversationMessageState.ts";

const activeAgreements = ["CONFIRMED", "SCHEDULED", "RESCHEDULED"];
const issuedInvoices = ["ISSUED", "SENT", "PARTIALLY_PAID", "OVERDUE"];
const contactTasks = ["call", "meeting", "follow_up", "message", "proposal", "send_documents", "wait_client"];
const contactAgreements = ["CALL", "ONLINE_MEETING", "OFFLINE_MEETING", "FOLLOW_UP", "MESSAGE", "CLIENT_CALLBACK", "MANAGER_CALLBACK", "SEND_PROPOSAL", "SEND_DOCUMENTS", "SEND_CONTRACT", "SEND_INVOICE"];
const contactAction = /^(?:позвон|перезвон|звон|созвон|связ|контакт|ответ|напис|встреч|отправ|высл|обсуд|уточн|соглас|follow.?up|call\b|contact\b|message\b|meet\b|хабарлас|қоңырау|кездес|жаз|жібер|талқыла|нақтыла)/i;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const identityInclude = { contact: { include: { methods: true } }, stage: true, assignee: { select: { user: { select: { name: true } } } } } as const;
type IdentifiedDeal = Prisma.DealGetPayload<{ include: typeof identityInclude }>;
const label = (deal: IdentifiedDeal) => ({ id: deal.id, number: deal.number, title: deal.title, stage: deal.stage.name,
  contactId: deal.contactId, contactName: displayName(deal.contact), phone: phoneFromContact(deal.contact), ownerName: deal.assignee?.user.name || null });

function validateParams(ctx: ReadContext, unchanged = false) {
  const allowed = new Set(["scope", "ownerMembershipId", "clientId", "query", ...(unchanged ? ["inactiveDays", "changeBasis"] : ["period", "periodPreset", "dateFrom", "dateTo", "from", "to"])]);
  if (Object.entries(ctx.params).some(([key, value]) => value !== undefined && !allowed.has(key))) {
    throw new ApiError(422, "invalid_filter", "Этот фильтр не поддерживается запросом. Уточните условие.");
  }
}

async function base(ctx: ReadContext) {
  const f = await controlReadFilters(ctx);
  const where: Prisma.DealWhereInput = { AND: [dealAccessWhere(ctx.auth), {
    ...(f.ownerId ? { assigneeMembershipId: f.ownerId } : {}), ...(f.clientId ? { contactId: f.clientId } : {}),
    ...(f.query ? { title: { contains: f.query, mode: "insensitive" } } : {}),
  }] };
  return { where, scope: f.scope, ownerName: f.ownerName };
}
const inPeriod = (date: Date, ctx: ReadContext) => !ctx.period.from || date >= ctx.period.from && date < ctx.period.to!;
const recent = (cutoff: Date, now: Date) => ({ gt: cutoff, lte: now });

export async function controlUnchangedDeals(ctx: ReadContext) {
  validateParams(ctx, true);
  const checked = z.object({ inactiveDays: z.number().int().min(1).max(3650), changeBasis: z.enum(["activity", "stage"]).default("activity") }).safeParse(ctx.params);
  if (!checked.success) throw new ApiError(422, "invalid_filter", "Укажите, сколько дней сделка должна быть без изменений: от 1 до 3650.");
  const { inactiveDays, changeBasis } = checked.data, b = await base(ctx);
  const now = ctx.period.now, cutoff = new Date(now.getTime() - inactiveDays * 86400000), tenantId = requireTenant(ctx.auth).tenantId;
  const changed = recent(cutoff, now);
  // Card updates and linked facts, not a stage SLA or another deal of the same customer.
  const activityWhere: Prisma.DealWhereInput = {
    updatedAt: { lte: cutoff },
    activities: { none: { tenantId, createdAt: changed } },
    tasks: { none: { OR: [{ createdAt: changed }, { completedAt: changed }, { sentAt: changed }] } },
    agreements: { none: { updatedAt: changed } }, invoices: { none: { updatedAt: changed } }, contracts: { none: { updatedAt: changed } },
    payments: { none: { confirmedAt: changed, status: "confirmed" } },
    conversations: { none: { conversation: { messages: { some: { tenantId, createdAt: changed, ...deliveredConversationMessage } } } } },
    inquiry: { isNot: { conversation: { messages: { some: { tenantId, createdAt: changed, ...deliveredConversationMessage } } } } },
  };
  const where: Prisma.DealWhereInput = { AND: [b.where, { outcome: { in: ["open", "on_hold"] }, createdAt: { lte: cutoff }, stageEnteredAt: { lte: cutoff } }, ...(changeBasis === "activity" ? [activityWhere] : [])] };
  const [total, rows] = await ctx.prisma.$transaction([ctx.prisma.deal.count({ where }), ctx.prisma.deal.findMany({ where,
    orderBy: [{ [changeBasis === "stage" ? "stageEnteredAt" : "updatedAt"]: "asc" }, { id: "asc" }], take: 50, include: identityInclude })]);
  return { items: rows.map(row => ({ ...label(row), stageEnteredAt: row.stageEnteredAt })), total, hasMore: total > rows.length,
    scope: b.scope, ownerName: b.ownerName, inactiveDays, changeBasis, cutoff, checkedAt: now };
}

export async function controlLostReasons(ctx: ReadContext) {
  validateParams(ctx);
  const b = await base(ctx), p = ctx.period;
  const groups = await ctx.prisma.deal.groupBy({ by: ["lossReason"], where: { AND: [b.where, { outcome: "lost",
    ...(p.from ? { closedAt: { gte: p.from, lt: p.to! } } : {}) }] }, _count: { _all: true } });
  const grouped = new Map<string, { reason: string | null; count: number }>();
  for (const g of groups) {
    const reason = g.lossReason?.trim().replace(/\s+/g, " ") || null, key = reason?.toLocaleLowerCase("ru-RU") || "";
    const previous = grouped.get(key);
    grouped.set(key, { reason: previous?.reason ?? reason, count: (previous?.count || 0) + g._count._all });
  }
  const total = groups.reduce((n, g) => n + g._count._all, 0);
  const reasons = [...grouped.values()].sort((a, b) => b.count - a.count || (a.reason || "").localeCompare(b.reason || ""))
    .map(row => ({ ...row, share: Math.round(row.count / total * 1000) / 10 }));
  return { items: reasons.slice(0, 30), total, reasonCount: reasons.length, hasMore: reasons.length > 30,
    missingReasonCount: grouped.get("")?.count || 0, scope: b.scope, ownerName: b.ownerName };
}

export async function controlProposalsWithoutFollowup(ctx: ReadContext) {
  validateParams(ctx);
  const b = await base(ctx), tenantId = requireTenant(ctx.auth).tenantId;
  const proposalTask = { type: "proposal", executionStatus: "sent", sentAt: { not: null }, status: "done" } satisfies Prisma.TaskWhereInput;
  const where: Prisma.DealWhereInput = { AND: [b.where, { outcome: { in: ["open", "on_hold"] }, OR: [
    { activities: { some: { tenantId, type: "sales.proposal_sent" } } }, { tasks: { some: proposalTask } },
  ] }] };
  const items: Array<ReturnType<typeof label> & { sentAt: Date; evidenceType: string; evidenceId: string }> = [];
  const uncertainItems: Array<ReturnType<typeof label> & { nextAction: string; nextActionAt: Date }> = [];
  let uncertainCount = 0;
  const clients = new Set<string>(); let total = 0, cursor: string | undefined;
  // Scan every candidate page before reporting totals; never use the displayed list as a count.
  for (;;) {
    const rows = await ctx.prisma.deal.findMany({ where, orderBy: { id: "asc" }, take: 100,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), include: { ...identityInclude,
        activities: { where: { tenantId, type: "sales.proposal_sent" }, select: { id: true, metadataJson: true } },
        tasks: { where: proposalTask },
        inquiry: { select: { id: true, conversationId: true } }, conversations: { select: { conversationId: true } },
      } });
    if (!rows.length) break;
    const links = [
      { dealId: { in: rows.map(row => row.id) } },
      { dealId: null, inquiryId: { in: rows.flatMap(row => row.inquiry ? [row.inquiry.id] : []) } },
      { dealId: null, inquiryId: null, conversationId: { in: rows.flatMap(row => [...row.conversations.map(c => c.conversationId), ...(row.inquiry?.conversationId ? [row.inquiry.conversationId] : [])]) } },
      { dealId: null, inquiryId: null, conversationId: null, contactId: { in: rows.map(row => row.contactId) } },
    ];
    const selectLinks = { dealId: true, inquiryId: true, conversationId: true, contactId: true } as const;
    const [plannedTasks, plannedAgreements] = await Promise.all([
      ctx.prisma.task.findMany({ where: { tenantId, OR: links, type: { in: contactTasks }, status: { in: PROCESS_OPEN_TASK_STATUSES }, completedAt: null, sentAt: null, dueAt: { gte: ctx.period.now } }, select: selectLinks }),
      ctx.prisma.agreement.findMany({ where: { tenantId, OR: links, type: { in: contactAgreements }, status: { in: activeAgreements }, cancelledAt: null, completedAt: null, clarificationNeeded: null, scheduledAt: { gte: ctx.period.now } }, select: selectLinks }),
    ]);
    const ids = rows.flatMap(row => row.activities.map(a => object(a.metadataJson).sourceMessageId).filter((id): id is string => typeof id === "string"));
    const messages = ids.length ? await ctx.prisma.message.findMany({ where: { tenantId, id: { in: ids }, direction: "outbound", ...deliveredConversationMessage,
      receiptState: { not: "failed" }, createdAt: { lte: ctx.period.now } }, select: { id: true, createdAt: true, conversation: { select: { contactId: true } } } }) : [];
    const sentTasks = rows.flatMap(row => row.tasks.filter(task => task.executionStatus === "sent" && task.sentAt));
    const deliveries = sentTasks.length ? await ctx.prisma.idempotencyRecord.findMany({ where: { scope: "task.delivery", actorKey: tenantId, key: { in: sentTasks.map(t => t.id) } }, select: { key: true, resultJson: true } }) : [];
    const accepted = new Set(deliveries.filter(row => {
      const parts = object(row.resultJson).parts;
      return Array.isArray(parts) && parts.length > 0 && parts.every(p => object(p).state === "accepted");
    }).map(row => row.key));
    const messageMap = new Map(messages.map(m => [m.id, m]));
    for (const row of rows) {
      const futureStep = Boolean(row.nextAction?.trim() && row.nextActionAt && row.nextActionAt >= ctx.period.now);
      const planned = Boolean(futureStep && contactAction.test(row.nextAction!.trim()))
        || [...plannedTasks, ...plannedAgreements].some(t => t.dealId ? t.dealId === row.id : t.inquiryId ? t.inquiryId === row.inquiry?.id
          : t.conversationId ? t.conversationId === row.inquiry?.conversationId || row.conversations.some(c => c.conversationId === t.conversationId)
          : t.contactId === row.contactId);
      if (planned) continue;
      const proofs = row.activities.flatMap(a => {
        const message = messageMap.get(String(object(a.metadataJson).sourceMessageId || ""));
        return message && message.conversation.contactId === row.contactId && inPeriod(message.createdAt, ctx)
          ? [{ sentAt: message.createdAt, evidenceType: "message", evidenceId: message.id }] : [];
      });
      proofs.push(...row.tasks.filter(t => t.type === "proposal" && t.executionStatus === "sent" && t.status === "done" && t.sentAt && t.sentAt <= ctx.period.now && accepted.has(t.id) && inPeriod(t.sentAt, ctx))
        .map(t => ({ sentAt: t.sentAt!, evidenceType: "task_delivery", evidenceId: t.id })));
      proofs.sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
      if (!proofs.length) continue;
      // A free-form next action may use company-specific wording. Do not assert
      // that contact is missing when its meaning cannot be established.
      if (futureStep) {
        uncertainCount++;
        if (uncertainItems.length < 2) uncertainItems.push({ ...label(row), nextAction: row.nextAction!, nextActionAt: row.nextActionAt! });
        continue;
      }
      total++; clients.add(row.contactId);
      if (items.length < 50) items.push({ ...label(row), ...proofs[0] });
    }
    cursor = rows.at(-1)!.id;
    if (rows.length < 100) break;
  }
  return { items, total, clientCount: clients.size, hasMore: total > items.length, uncertainCount, uncertainItems, scope: b.scope, ownerName: b.ownerName };
}

export async function controlExpectedPayments(ctx: ReadContext) {
  validateParams(ctx);
  if (!ctx.access.canReadFinancialData) throw new ApiError(403, "forbidden", "Нет доступа к финансовым данным.");
  const b = await base(ctx), p = ctx.period;
  const dueRange = p.from ? { gte: p.from, lt: p.to! } : { not: null };
  const invoiceWhere = { status: { in: issuedInvoices }, dueDate: dueRange, totalAmount: { gt: 0 } } satisfies Prisma.InvoiceWhereInput;
  const promiseWhere = { type: "PAYMENT_PROMISE", status: { in: activeAgreements }, scheduledAt: dueRange,
    completedAt: null, cancelledAt: null, clarificationNeeded: null } satisfies Prisma.AgreementWhereInput;
  const where: Prisma.DealWhereInput = { AND: [b.where, { outcome: { in: ["open", "on_hold", "won"] }, paymentStatus: { notIn: ["PAID", "CANCELLED", "NOT_REQUIRED"] },
    OR: [{ invoices: { some: invoiceWhere } }, { agreements: { some: promiseWhere } }] }] };
  type Source = { id: string; type: "invoice" | "promise"; title: string; dueAt: Date };
  const items: Array<ReturnType<typeof label> & { dueAt: Date; sources: Source[]; sourceCount: number; needsReconciliation: boolean }> = [];
  let total = 0, reconciliationCount = 0, cursor: string | undefined;
  for (;;) {
    const rows = await ctx.prisma.deal.findMany({ where, orderBy: { id: "asc" }, take: 100, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { ...identityInclude, invoices: { where: invoiceWhere, orderBy: { dueDate: "asc" } }, agreements: { where: promiseWhere, orderBy: { scheduledAt: "asc" } },
        payments: { where: { status: "confirmed", confirmedAt: { lte: p.now } }, select: { amountMinor: true, currency: true } } } });
    if (!rows.length) break;
    for (const row of rows) {
      const paid = row.payments.filter(payment => payment.currency === row.currency).reduce((sum, payment) => sum.plus(payment.amountMinor), new Prisma.Decimal(0));
      const amount = row.wonAmountMinor ?? row.offerAmountMinor;
      if (amount && amount.gt(0) && paid.gte(amount)) continue;
      const sources: Source[] = [
        ...row.invoices.map(i => ({ id: i.id, type: "invoice" as const, title: i.number, dueAt: i.dueDate! })),
        ...row.agreements.map(a => ({ id: a.id, type: "promise" as const, title: a.title, dueAt: a.scheduledAt! })),
      ].sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
      if (!sources.length) continue;
      // Payments are linked to a deal, not a specific invoice/promise. Do not invent allocation or a forecast amount.
      const needsReconciliation = row.payments.length > 0 || row.invoices.some(i => i.status === "PARTIALLY_PAID");
      total++; if (needsReconciliation) reconciliationCount++;
      items.push({ ...label(row), dueAt: sources[0].dueAt, sources: sources.slice(0, 2), sourceCount: sources.length, needsReconciliation });
      items.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || a.id.localeCompare(b.id));
      if (items.length > 50) items.pop();
    }
    cursor = rows.at(-1)!.id;
    if (rows.length < 100) break;
  }
  return { items, total, hasMore: total > items.length, reconciliationCount, scope: b.scope, ownerName: b.ownerName };
}
