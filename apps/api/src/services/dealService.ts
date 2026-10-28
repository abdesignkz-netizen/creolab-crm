import { ensureSalesNextTask, enqueueSalesReconcile } from "./salesProcessService.ts";
import { closeDealStageInterval, recordDealStageTransition } from "./dealStageHistory.ts";
import { queueControlNotification } from "./controlNotificationService.ts";
import { taskTitlePresentation, updateTenantOpsSchema } from "@creolab/contracts";
import type { z } from "zod";
import { randomUUID } from "node:crypto";
import { resolveEsfMeasureUnitCode } from "@creolab/contracts";
import { businessDealWhere, wonSalesTotals, confirmedPaymentTotals, openPipelineTotals, outstandingPaymentTotals, saleAmount, moneyValue, MoneyDecimal } from "./financialMetrics.ts";
import type { PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { assertDealVisible, capabilities, isManager, managerDealWriteFields, requireCompanyAdmin, seesAllCompanyRecords } from "../lib/access.ts";
import { loadDealDocumentSummaries } from "./dealDocumentSummary.ts";
import { canUseFeature } from "./entitlementService.ts";
import {
  LEGACY_STAGE_MAP,
  PAYMENT_STATUSES,
  PIPELINE_STAGES,
  amountNumber,
  formatMoney,
  lostReasonCatalog,
  parseOpsSettings,
  stageDurationLabel,
} from "./dealPipeline.ts";
import { writeAudit } from "../lib/audit.ts";
import { displayName, phoneFromContact } from "./contactLabels.ts";
import { writeActivity } from "./contactService.ts";
import { serializeDealItem, totalsFromItems } from "./dealItemService.ts";
import { lineAmounts, sumLines, toMinorTenge } from "./documentMoney.ts";
import { getTenantDocumentFlags, isDocumentsEnabled, resolveVatRate } from "./legalProfileService.ts";
import { resolvePeriodRange, periodLabel, type PeriodPreset } from "./periodRange.ts";
import { flagsForDeal, PROCESS_OPEN_TASK_STATUSES } from "./dealProcessPolicy.ts";
import { createProcessClock, type ProcessClock } from "./processCalendar.ts";
import { isBuiltInStage, processSettingsRevision, savePipeline } from "./dealPipelineSettings.ts";
export { flagsForDeal } from "./dealProcessPolicy.ts";

type DealTimeMode = "now" | "period";
type DealPeriodBasis = "created" | "activity" | "closed";
type DealFocus =
  | "all"
  | "stalled"
  | "needs_reply"
  | "no_next_action"
  | "proposal_no_reply"
  | "over_sla"
  | "payment_overdue"
  | "overdue_next_action";

function dateRangeFilter(from: Date | null, to: Date | null) {
  if (!from && !to) return undefined;
  return {
    ...(from ? { gte: from } : {}),
    ...(to ? { lt: to } : {}),
  };
}

async function findDealIdsWithActivity(
  prisma: PrismaClient,
  tid: string,
  from: Date | null,
  to: Date | null,
) {
  const range = dateRangeFilter(from, to);
  const ids = new Set<string>();

  const [activities, histories, tasks, agreements, contacts] = await Promise.all([
    prisma.activity.findMany({
      where: {
        tenantId: tid,
        dealId: { not: null },
        ...(range ? { createdAt: range } : {}),
      },
      select: { dealId: true },
      take: 3000,
    }),
    prisma.dealStageHistory.findMany({
      where: {
        tenantId: tid,
        ...(range ? { enteredAt: range } : {}),
      },
      select: { dealId: true },
      take: 3000,
    }),
    prisma.task.findMany({
      where: {
        tenantId: tid,
        dealId: { not: null },
        OR: range
          ? [{ createdAt: range }, { completedAt: range }, { confirmedAt: range }, { sentAt: range }]
          : undefined,
      },
      select: { dealId: true },
      take: 3000,
    }),
    prisma.agreement.findMany({
      where: {
        tenantId: tid,
        dealId: { not: null },
        OR: range
          ? [{ createdAt: range }, { updatedAt: range }, { scheduledAt: range }, { completedAt: range }]
          : undefined,
      },
      select: { dealId: true },
      take: 2000,
    }),
    range
      ? prisma.contact.findMany({
          where: {
            tenantId: tid,
            OR: [
              { lastInboundMessageAt: range },
              { lastOutboundMessageAt: range },
              { lastContactAt: range },
            ],
          },
          select: { id: true },
          take: 2000,
        })
      : Promise.resolve([] as Array<{ id: string }>),
  ]);

  for (const row of activities) if (row.dealId) ids.add(row.dealId);
  for (const row of histories) ids.add(row.dealId);
  for (const row of tasks) if (row.dealId) ids.add(row.dealId);
  for (const row of agreements) if (row.dealId) ids.add(row.dealId);

  if (contacts.length) {
    const byContact = await prisma.deal.findMany({
      where: { tenantId: tid, contactId: { in: contacts.map((c) => c.id) } },
      select: { id: true },
      take: 3000,
    });
    for (const row of byContact) ids.add(row.id);
  }

  return [...ids];
}

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership;
}

export async function ensureDealPipelineStages(prisma: PrismaClient, tenantId: string) {
  const existing = await prisma.dealStage.findMany({ where: { tenantId } });
  const byKey = new Map(existing.map((s) => [s.systemKey, s]));

  for (const def of PIPELINE_STAGES) {
    const row = byKey.get(def.systemKey);
    if (!row) {
      await prisma.dealStage.upsert({
        where: { tenantId_systemKey: { tenantId, systemKey: def.systemKey } },
        update: {},
        create: {
          tenantId,
          systemKey: def.systemKey,
          name: def.name,
          sortOrder: def.sortOrder,
          defaultProbability: def.defaultProbability,
          isTerminal: false,
        },
      });
    }
  }

  // Reading a board must preserve tenant labels and historical stage links.
  return prisma.dealStage.findMany({ where: { tenantId }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }] });
}

function dealInclude() {
  return {
    stage: true,
    contact: { include: { methods: true } },
    company: { select: { id: true, name: true } },
    dealContacts: {
      include: { contact: { select: { id: true, name: true, firstName: true, lastName: true } } },
    },
    assignee: { include: { user: { select: { name: true, email: true } } } },
    payments: true,
    tasks: {
      where: { status: { in: PROCESS_OPEN_TASK_STATUSES } },
      orderBy: { dueAt: "asc" as const },
    },
    inquiry: { select: { id: true, subject: true, source: true, sourceChannel: true } },
    items: { orderBy: { sortOrder: "asc" as const } },
  };
}

function serializeDeal(deal: any, ops: ReturnType<typeof parseOpsSettings>, currency: string, now = new Date(), clock?: ProcessClock) {
  const items = Array.isArray(deal.items) ? deal.items.map(serializeDealItem) : [];
  const itemTotals = items.length ? totalsFromItems(items) : null;
  const amountValue = deal.outcome === "won" ? saleAmount(deal) : deal.offerAmountMinor;
  const money = moneyValue(amountValue, deal.currency || currency);
  const amount = money.amount;
  const flags = flagsForDeal({ ...deal, contact: deal.contact }, ops, now, clock);
  const assigneeName = deal.assignee?.user?.name || deal.assignee?.user?.email || null;
  const probability = deal.probability ?? deal.stage?.defaultProbability ?? 10;
  return {
    id: deal.id,
    number: deal.number != null ? `СД-${String(deal.number).padStart(6, "0")}` : null,
    title: deal.title,
    description: deal.description,
    outcome: deal.outcome,
    stageId: deal.stageId,
    stage: deal.stage
      ? {
          id: deal.stage.id,
          name: deal.stage.name,
          systemKey: deal.stage.systemKey,
          sortOrder: deal.stage.sortOrder,
          defaultProbability: deal.stage.defaultProbability,
        }
      : null,
    amount,
    amountLabel: money.label,
    amountExact: money.exact,
    currency: deal.currency || currency,
    probability,
    weightedAmount: amount != null ? Math.round((amount * probability) / 100) : null,
    paymentStatus: deal.paymentStatus || "NOT_INVOICED",
    fulfillmentStatus: deal.fulfillmentStatus || "NOT_STARTED",
    nextAction: deal.nextAction,
    nextActionAt: deal.nextActionAt?.toISOString?.() || deal.nextActionAt || null,
    stageEnteredAt: deal.stageEnteredAt?.toISOString?.() || deal.createdAt?.toISOString?.(),
    stageDurationLabel: stageDurationLabel(new Date(deal.stageEnteredAt || deal.createdAt), now),
    expectedCloseAt: deal.expectedCloseAt?.toISOString?.() || null,
    createdAt: deal.createdAt?.toISOString?.() || null,
    closedAt: deal.closedAt?.toISOString?.() || null,
    wonAt: deal.wonAt?.toISOString?.() || null,
    lostAt: deal.lostAt?.toISOString?.() || null,
    lossReason: deal.lossReason,
    wonAmountMinor: moneyValue(deal.wonAmountMinor, deal.currency || currency).amount,
    wonAmountExact: moneyValue(deal.wonAmountMinor, deal.currency || currency).exact,
    contact: deal.contact
      ? {
          id: deal.contact.id,
          name: displayName(deal.contact),
          phone: phoneFromContact(deal.contact),
        }
      : null,
    company: deal.company
      ? {
          id: deal.company.id,
          name: deal.company.name,
          href: `/companies/${deal.company.id}`,
        }
      : null,
    dealContacts: Array.isArray(deal.dealContacts)
      ? deal.dealContacts.map((dc: any) => ({
          id: dc.id,
          role: dc.role,
          isPrimary: dc.isPrimary,
          contactId: dc.contactId,
          name:
            dc.contact?.name ||
            [dc.contact?.firstName, dc.contact?.lastName].filter(Boolean).join(" ") ||
            null,
        }))
      : [],
    assigneeMembershipId: deal.assigneeMembershipId,
    assigneeName,
    inquiryId: deal.inquiryId,
    inquiry: deal.inquiry || null,
    items,
    itemTotals,
    amountFromItems: Boolean(items.length),
    tasks: (deal.tasks || []).map((t: any) => ({
      id: t.id,
      title: t.title, titlePresentation: taskTitlePresentation(t),
      dueAt: t.dueAt?.toISOString?.() || null,
      status: t.status,
      type: t.type,
    })),
    flags,
    href: `/deals/${deal.id}`,
  };
}

export async function getDealBoard(
  prisma: PrismaClient,
  auth: AuthContext,
  query: {
    scope?: string;
    includeClosed?: string;
    timeMode?: string;
    period?: string;
    dateFrom?: string;
    dateTo?: string;
    basis?: string;
    focus?: string;
    outcome?: string;
    stage?: string;
  } = {},
) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const currency = membership.tenant.currency || "KZT";
  const timeZone = membership.tenant.timezone || "Asia/Almaty";
  const tenant = await prisma.tenant.findUnique({ where: { id: tid } });
  const ops = parseOpsSettings(tenant?.settingsJson);
  const stages = await ensureDealPipelineStages(prisma, tid);
  const scope = isManager(auth)
    ? "mine"
    : query.scope === "mine" || query.scope === "unassigned"
      ? query.scope
      : "all";
  const timeMode: DealTimeMode = query.timeMode === "period" ? "period" : "now";
  const basis: DealPeriodBasis =
    query.basis === "activity" || query.basis === "closed" ? query.basis : "created";
  const focus: DealFocus =
    query.focus === "stalled" ||
    query.focus === "needs_reply" ||
    query.focus === "no_next_action" ||
    query.focus === "proposal_no_reply" ||
    query.focus === "over_sla" ||
    query.focus === "payment_overdue" ||
    query.focus === "overdue_next_action"
      ? query.focus
      : "all";
  const includeClosed =
    query.includeClosed === "1" ||
    query.includeClosed === "true" ||
    timeMode === "period";
  const now = new Date();
  const processClock = createProcessClock(ops.processCalendar, tenant?.timezone || timeZone, now);

  const allowed: PeriodPreset[] = [
    "today",
    "yesterday",
    "last_7",
    "last_30",
    "this_month",
    "last_month",
    "this_year",
    "all",
    "custom",
  ];
  const periodPreset = (
    allowed.includes(query.period as PeriodPreset) ? query.period : "today"
  ) as PeriodPreset;

  let from: Date | null = null;
  let to: Date | null = null;
  let periodLabelText = "Сейчас";
  if (timeMode === "period") {
    const range = resolvePeriodRange(timeZone, periodPreset, query.dateFrom, query.dateTo, now);
    from = range.from;
    to = range.to;
    periodLabelText = periodLabel(periodPreset, from, to, timeZone);
  }

  const assigneeWhere =
    scope === "mine"
      ? { assigneeMembershipId: membership.id }
      : scope === "unassigned"
        ? { assigneeMembershipId: null }
        : {};

  const financeWhere = { ...(await businessDealWhere(prisma, tid)), ...assigneeWhere, ...(query.stage ? { stage: { systemKey: query.stage } } : {}) };
  const createdRange = dateRangeFilter(from, to);
  let idFilter: string[] | null = null;

  if (timeMode === "period" && basis === "activity") {
    idFilter = await findDealIdsWithActivity(prisma, tid, from, to);
  }

  const where: Record<string, unknown> = {
    ...financeWhere,
  };

  if (timeMode === "now") {
    where.outcome = { in: ["open", "on_hold"] };
  } else if (basis === "created") {
    if (createdRange) where.createdAt = createdRange;
  } else if (basis === "closed") {
    where.outcome = { in: ["won", "lost"] };
    if (createdRange) where.closedAt = createdRange;
  } else if (basis === "activity") {
    where.id = { in: idFilter?.length ? idFilter : ["__none__"] };
  }

  if (!includeClosed && timeMode === "now") {
    where.outcome = { in: ["open", "on_hold"] };
  }

  if (["open", "on_hold", "won", "lost"].includes(query.outcome || "")) where.outcome = query.outcome;
  if (query.stage) where.stage = { systemKey: query.stage };

  const deals = await prisma.deal.findMany({
    where: where as never,
    include: dealInclude(),
    orderBy: [{ stageEnteredAt: "desc" }, { createdAt: "desc" }],
    take: 500,
  });

  const contactIds = [...new Set(deals.map((d) => d.contactId))];
  const contacts = await prisma.contact.findMany({
    where: { tenantId: tid, id: { in: contactIds } },
    select: {
      id: true,
      name: true,
      firstName: true,
      lastName: true,
      lastInboundMessageAt: true,
      lastOutboundMessageAt: true,
      lastContactAt: true,
      methods: true,
    },
  });
  const contactById = new Map(contacts.map((c) => [c.id, c]));

  const serializedAll = deals.map((d) =>
    serializeDeal({ ...d, offerAmountMinor: d.outcome === "won" ? d.wonAmountMinor ?? d.offerAmountMinor : d.offerAmountMinor, contact: { ...d.contact, ...contactById.get(d.contactId) } }, ops, currency, now, processClock),
  );
  const documentsAllowed = capabilities(auth).documents && await isDocumentsEnabled(prisma, tid) && await canUseFeature(prisma, tid, "DOCUMENTS");
  const documentSummaries = documentsAllowed
    ? await loadDealDocumentSummaries(prisma, tid, deals.map((deal) => deal.id))
    : null;

  const focusFilter = (d: (typeof serializedAll)[number]) => {
    if (focus === "proposal_no_reply") return Boolean(d.flags.proposalWithoutReply);
    if (focus === "stalled") return Boolean(d.flags.stalled);
    if (focus === "needs_reply") return Boolean(d.flags.needsReply);
    if (focus === "no_next_action") return Boolean(d.flags.noNextAction);
    if (focus === "over_sla") return Boolean(d.flags.overSla);
    if (focus === "payment_overdue") return Boolean(d.flags.paymentOverdue);
    if (focus === "overdue_next_action") return Boolean(d.flags.overdueNextAction);
    return true;
  };

  const forKanban = serializedAll.filter((d) => {
    if (timeMode === "now") return d.outcome === "open" && focusFilter(d);
    if (basis === "closed") return (d.outcome === "won" || d.outcome === "lost") && focusFilter(d);
    return focusFilter(d);
  });

  const columns = stages
    .filter((s) => !s.isTerminal && !s.isArchived || forKanban.some(deal => deal.stageId === s.id))
    .map((stage) => {
      const items = forKanban.filter((d) => d.stageId === stage.id);
      let sum = new MoneyDecimal(0);
      let known = 0;
      let weighted = new MoneyDecimal(0);
      for (const item of items) {
        if (item.amountExact != null && item.currency === currency) {
          sum = sum.plus(item.amountExact);
          known += 1;
          weighted = weighted.plus(new MoneyDecimal(item.amountExact).mul(item.probability).div(100));
        }
      }
      return {
        stageId: stage.id,
        systemKey: stage.systemKey,
        name: stage.name,
        canReceiveDeals: !stage.isTerminal && !stage.isArchived,
        sortOrder: stage.sortOrder,
        count: items.length,
        amountSum: moneyValue(known ? sum : null, currency).amount,
        amountLabel: moneyValue(known ? sum : null, currency).label,
        weightedSum: moneyValue(known ? weighted : null, currency).amount,
        weightedLabel: moneyValue(known ? weighted : null, currency).label,
        amountKnownCount: known,
        deals: items,
      };
    });

  const openSerialized = forKanban.filter((d) => d.outcome === "open");
  let pipelineSum = new MoneyDecimal(0);
  let pipelineKnown = 0;
  let weightedSum = new MoneyDecimal(0);
  for (const d of openSerialized) {
    if (d.amountExact != null && d.currency === currency) {
      pipelineSum = pipelineSum.plus(d.amountExact);
      pipelineKnown += 1;
      weightedSum = weightedSum.plus(new MoneyDecimal(d.amountExact).mul(d.probability).div(100));
    }
  }

  // Period totals are based on creation/closure dates, independently of the
  // 500 cards currently rendered and of the chosen card date basis.
  const [createdInPeriod, wonTotals, closedLostCount, fullPipeline, periodPayments, outstanding] = await Promise.all([
    timeMode === "period" ? prisma.deal.count({ where: { ...financeWhere, ...(createdRange ? { createdAt: createdRange } : {}) } }) : null,
    timeMode === "period" ? wonSalesTotals(prisma, financeWhere, createdRange, currency) : null,
    timeMode === "period" ? prisma.deal.count({ where: { ...financeWhere, outcome: "lost", ...(createdRange ? { closedAt: createdRange } : {}) } }) : null,
    timeMode === "now" && focus === "all" ? openPipelineTotals(prisma, financeWhere, currency) : null,
    timeMode === "period" ? confirmedPaymentTotals(prisma, tid, financeWhere, createdRange, currency) : null,
    timeMode === "now" ? outstandingPaymentTotals(prisma, { AND: [financeWhere, ...(focus === "all" ? [] : [{ id: { in: openSerialized.map(d => d.id) } }])] }, currency) : null,
  ]);

  return {
    asOf: now.toISOString(),
    documentsAllowed,
    items: serializedAll.filter(focusFilter).map((deal) => ({ ...deal, documents: documentSummaries?.get(deal.id) ?? null })),
    limit: 500,
    limitReached: deals.length === 500,
    currency,
    timeMode,
    basis: timeMode === "period" ? basis : null,
    focus,
    period: {
      preset: timeMode === "period" ? periodPreset : null,
      label: periodLabelText,
      from: from?.toISOString() || null,
      to: to?.toISOString() || null,
    },
    ops: {
      stalledDealDays: ops.stalledDealDays,
      proposalFollowUpThresholdDays: ops.proposalFollowUpThresholdDays,
      stageSlaDays: ops.stageSlaDays,
    },
    summary:
      timeMode === "now"
        ? {
            mode: "now" as const,
            activeDeals: fullPipeline?.count ?? openSerialized.length,
            pipelineAmount: fullPipeline ? fullPipeline.total.amount : moneyValue(pipelineKnown ? pipelineSum : null, currency).amount,
            pipelineAmountLabel: fullPipeline ? fullPipeline.total.label : moneyValue(pipelineKnown ? pipelineSum : null, currency).label,
            weightedPipeline: fullPipeline ? fullPipeline.total.weighted.amount : moneyValue(pipelineKnown ? weightedSum : null, currency).amount,
            weightedPipelineLabel: fullPipeline ? fullPipeline.total.weighted.label : moneyValue(pipelineKnown ? weightedSum : null, currency).label,
            amountKnownCount: fullPipeline?.total.known ?? pipelineKnown,
            amountKnownOf: fullPipeline?.total.count ?? openSerialized.length,
            pipelineByCurrency: fullPipeline?.byCurrency || [],
            attentionSummaryPartial: deals.length === 500,
            expectedPayments: outstanding!.total.amount,
            expectedPaymentsLabel: outstanding!.total.label,
            expectedPaymentsByCurrency: outstanding!.byCurrency,
            stalledCount: openSerialized.filter((d) => d.flags.stalled).length,
            noNextActionCount: openSerialized.filter((d) => d.flags.noNextAction).length,
            overSlaCount: openSerialized.filter((d) => d.flags.overSla).length,
            needsReplyCount: openSerialized.filter((d) => d.flags.needsReply).length,
          }
        : {
            mode: "period" as const,
            createdDeals: createdInPeriod,
            wonDeals: wonTotals!.count,
            lostDeals: closedLostCount,
            soldAmount: wonTotals!.total.amount,
            soldAmountLabel: wonTotals!.total.label,
            salesByCurrency: wonTotals!.byCurrency,
            receipts: periodPayments!.total.amount,
            receiptsLabel: periodPayments!.total.label,
            receiptsByCurrency: periodPayments!.byCurrency,
            dealsInView: forKanban.length,
            activityDeals: basis === "activity" ? forKanban.length : null,
          },
    columns,
    onHold:
      timeMode === "now"
        ? deals.filter((d) => d.outcome === "on_hold").map((d) => serializeDeal(d, ops, currency, now, processClock))
        : [],
    closed:
      timeMode === "period" && basis === "closed"
        ? forKanban
        : includeClosed && timeMode === "now"
          ? deals
              .filter((d) => d.outcome === "won" || d.outcome === "lost")
              .map((d) => serializeDeal(d, ops, currency, now, processClock))
          : [],
    lostReasons: lostReasonCatalog(ops),
    paymentStatuses: [...PAYMENT_STATUSES],
  };
}

export async function getDeal(prisma: PrismaClient, auth: AuthContext, dealId: string) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const tenant = await prisma.tenant.findUnique({ where: { id: tid } });
  const ops = parseOpsSettings(tenant?.settingsJson);
  const now = new Date();
  const processClock = createProcessClock(ops.processCalendar, tenant?.timezone || "Asia/Almaty", now);
  const deal = await prisma.deal.findFirst({
    where: { id: dealId, tenantId: tid },
    include: {
      ...dealInclude(),
      stageHistory: { orderBy: { enteredAt: "desc" }, take: 30 },
    },
  });
  if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");
  assertDealVisible(auth, deal);
  const contact = await prisma.contact.findFirst({
    where: { id: deal.contactId, tenantId: tid },
    select: {
      id: true,
      name: true,
      firstName: true,
      lastName: true,
      lastInboundMessageAt: true,
      lastOutboundMessageAt: true,
      lastContactAt: true,
      methods: true,
    },
  });
  const receipts = await confirmedPaymentTotals(prisma, tid, { tenantId: tid, id: deal.id }, undefined, deal.currency);
  const agreed = saleAmount(deal);
  const remaining = agreed == null ? null : MoneyDecimal.max(0, new MoneyDecimal(agreed).minus(receipts.total.exact || 0));
  return {
    deal: serializeDeal({ ...deal, contact }, ops, membership.tenant.currency || "KZT", now, processClock),
    stageHistory: deal.stageHistory,
    payments: deal.payments.map(row => ({ ...row, amountLabel: moneyValue(row.amountMinor, row.currency).label })),
    paymentSummary: { ...receipts.total, byCurrency: receipts.byCurrency, remaining: moneyValue(remaining, deal.currency) },
  };
}

export async function updateDeal(
  prisma: PrismaClient,
  auth: AuthContext,
  dealId: string,
  input: Record<string, unknown>,
) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const deal = await prisma.deal.findFirst({ where: { id: dealId, tenantId: tid } });
  if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");
  assertDealVisible(auth, deal);
  if (isManager(auth)) input = managerDealWriteFields(input);

  const itemCount = await prisma.dealItem.count({ where: { tenantId: tid, dealId } });
  if (itemCount > 0 && input.offerAmountMinor !== undefined) {
    throw new ApiError(422, "amount_from_items", "Сумма считается из позиций сделки");
  }
  const probability = input.probability as number | undefined;
  if (probability != null && (probability < 0 || probability > 100)) {
    throw new ApiError(422, "invalid", "Вероятность 0–100");
  }
  const paymentStatus = input.paymentStatus as string | undefined;
  if (paymentStatus && !PAYMENT_STATUSES.includes(paymentStatus as (typeof PAYMENT_STATUSES)[number])) {
    throw new ApiError(422, "invalid", "Некорректный статус оплаты");
  }

  let companyId = deal.companyId;
  if (input.companyId !== undefined) {
    companyId = (input.companyId as string | null) || null;
    if (companyId) {
      const company = await prisma.company.findFirst({ where: { id: companyId, tenantId: tid } });
      if (!company) throw new ApiError(404, "not_found", "Компания не найдена");
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.deal.update({
      where: { id: dealId },
      data: {
        ...(input.title != null ? { title: String(input.title) } : {}),
        ...(input.description !== undefined ? { description: input.description as string | null } : {}),
        ...(input.offerAmountMinor !== undefined
          ? {
              offerAmountMinor:
                input.offerAmountMinor == null ? null : Number(input.offerAmountMinor),
            }
          : {}),
        ...(input.currency ? { currency: String(input.currency) } : {}),
        ...(probability != null ? { probability } : {}),
        ...(paymentStatus ? { paymentStatus } : {}),
        ...(input.fulfillmentStatus ? { fulfillmentStatus: String(input.fulfillmentStatus) } : {}),
        ...(input.nextAction !== undefined ? { nextAction: input.nextAction as string | null } : {}),
        ...(input.nextActionAt !== undefined
          ? { nextActionAt: input.nextActionAt ? new Date(String(input.nextActionAt)) : null }
          : {}),
        ...(input.expectedCloseAt !== undefined
          ? { expectedCloseAt: input.expectedCloseAt ? new Date(String(input.expectedCloseAt)) : null }
          : {}),
        ...(input.assigneeMembershipId !== undefined
          ? { assigneeMembershipId: input.assigneeMembershipId as string | null }
          : {}),
        ...(input.companyId !== undefined ? { companyId } : {}),
        version: { increment: 1 },
      },
    });
    await ensureSalesNextTask(tx, tid, dealId);
    await enqueueSalesReconcile(tx, tid, dealId);
    await writeAudit(tx, {
      tenantId: tid,
      actorUserId: auth.user.id,
      action: "deal.update",
      entityType: "deal",
      entityId: dealId,
      changes: {
        before: {
          offerAmountMinor: deal.offerAmountMinor,
          probability: deal.probability,
          nextAction: deal.nextAction,
          nextActionAt: deal.nextActionAt,
          paymentStatus: deal.paymentStatus,
        },
        after: {
          offerAmountMinor: input.offerAmountMinor !== undefined ? input.offerAmountMinor : deal.offerAmountMinor,
          probability: probability ?? deal.probability,
          nextAction: input.nextAction !== undefined ? input.nextAction : deal.nextAction,
          nextActionAt: input.nextActionAt !== undefined ? input.nextActionAt : deal.nextActionAt,
          paymentStatus: paymentStatus || deal.paymentStatus,
        },
      },
    });
  });

  return getDeal(prisma, auth, dealId);
}

export async function changeDealStage(
  prisma: PrismaClient,
  auth: AuthContext,
  dealId: string,
  input: { stageId?: string; systemKey?: string; note?: string },
) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  await ensureDealPipelineStages(prisma, tid);

  const deal = await prisma.deal.findFirst({
    where: { id: dealId, tenantId: tid },
    include: { stage: true },
  });
  if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");
  assertDealVisible(auth, deal);
  if (deal.outcome !== "open" && deal.outcome !== "on_hold") {
    throw new ApiError(422, "closed", "Закрытую сделку нельзя двигать по воронке");
  }

  let targetKey = input.systemKey || "";
  if (input.stageId) {
    const st = await prisma.dealStage.findFirst({ where: { id: input.stageId, tenantId: tid } });
    if (!st) throw new ApiError(404, "not_found", "Стадия не найдена");
    targetKey = st.systemKey;
  }
  // Keep an existing legacy/custom stage. Aliases only resolve missing keys.
  const toStage = await prisma.dealStage.findFirst({ where: { tenantId: tid, systemKey: targetKey } })
    || (LEGACY_STAGE_MAP[targetKey] ? await prisma.dealStage.findFirst({ where: { tenantId: tid, systemKey: LEGACY_STAGE_MAP[targetKey] } }) : null);
  if (!toStage) throw new ApiError(404, "not_found", "Стадия не найдена");
  if (toStage.id === deal.stageId) return getDeal(prisma, auth, dealId);

  const now = new Date();
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tid } });
  const processClock = createProcessClock(parseOpsSettings(tenant.settingsJson).processCalendar, tenant.timezone, now);
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "DealStage" WHERE id = ${toStage.id} AND "tenantId" = ${tid} FOR SHARE`;
    const currentStage = await tx.dealStage.findUniqueOrThrow({ where: { id: toStage.id } });
    if (currentStage.isArchived || currentStage.isTerminal) throw new ApiError(422, "stage_unavailable", "Этот этап недоступен для новых переходов. Выберите активный этап.");
    const moved = await tx.deal.updateMany({
      where: { id: dealId, tenantId: tid, version: deal.version, stageId: deal.stageId, outcome: deal.outcome },
      data: {
        stageId: toStage.id,
        stageEnteredAt: now,
        probability: currentStage.defaultProbability,
        outcome: "open",
        version: { increment: 1 },
        ...(toStage.systemKey === "proposal_sent" && !deal.nextAction?.trim()
          ? { nextAction: "Связаться после предложения", nextActionAt: deal.nextActionAt || processClock.afterDays(now, 1) }
          : {}),
        ...(toStage.systemKey === "invoiced"
          ? { paymentStatus: deal.paymentStatus === "NOT_INVOICED" ? "INVOICED" : deal.paymentStatus }
          : {}),
      },
    });
    if (!moved.count) throw new ApiError(409, "conflict", "Сделка изменилась. Обновите страницу и повторите действие.");
    await recordDealStageTransition(tx, {
      tenantId: tid, dealId, fromStageId: deal.stageId, fromSystemKey: deal.stage.systemKey,
      toStageId: toStage.id, toSystemKey: toStage.systemKey, enteredAt: now,
      changedByType: "user", changedById: auth.user.id, note: input.note || null,
    });
    await tx.activity.create({
      data: {
        tenantId: tid,
        contactId: deal.contactId,
        dealId,
        inquiryId: deal.inquiryId,
        type: "deal.stage_changed",
        title: `Сделка: ${deal.stage.name} → ${toStage.name}`,
        description: input.note || null,
        actorType: "user",
        actorId: auth.user.id,
        metadataJson: { from: deal.stage.systemKey, to: toStage.systemKey },
      },
    });
    await ensureSalesNextTask(tx, tid, dealId);
    await queueControlNotification(tx, { tenantId: tid, type: "deal.stage_changed", entityId: dealId, episodeKey: `deal.stage_changed:${dealId}:${deal.version + 1}` });
    await writeAudit(tx, {
      tenantId: tid,
      actorUserId: auth.user.id,
      action: "deal.stage_changed",
      entityType: "deal",
      entityId: dealId,
      changes: { from: deal.stage.name, to: toStage.name, fromKey: deal.stage.systemKey, toKey: toStage.systemKey },
    });
  });

  return getDeal(prisma, auth, dealId);
}

export async function markDealWon(
  prisma: PrismaClient,
  auth: AuthContext,
  dealId: string,
  input: { wonAmountMinor?: number | null } = {},
) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const deal = await prisma.deal.findFirst({ where: { id: dealId, tenantId: tid } });
  if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");
  assertDealVisible(auth, deal);
  const now = new Date();
  const wonAmount = input.wonAmountMinor ?? amountNumber(deal.offerAmountMinor);

  await prisma.$transaction(async (tx) => {
    const closed = await tx.deal.updateMany({
      where: { id: dealId, tenantId: tid, version: deal.version, stageId: deal.stageId, outcome: deal.outcome },
      data: {
        outcome: "won",
        probability: 100,
        closedAt: now,
        wonAt: now,
        wonAmountMinor: wonAmount,
        lostAt: null,
        lossReason: null,
        version: { increment: 1 },
      },
    });
    if (!closed.count) throw new ApiError(409, "conflict", "Сделка изменилась. Обновите страницу и повторите действие.");
    await closeDealStageInterval(tx, tid, dealId, now);
    await tx.activity.create({
      data: {
        tenantId: tid,
        contactId: deal.contactId,
        dealId,
        inquiryId: deal.inquiryId,
        type: "deal.won",
        title: "Сделка выиграна",
        description: wonAmount != null ? formatMoney(wonAmount, deal.currency) || undefined : undefined,
        actorType: "user",
        actorId: auth.user.id,
        metadataJson: { wonAmountMinor: wonAmount },
      },
    });
    await writeAudit(tx, {
      tenantId: tid,
      actorUserId: auth.user.id,
      action: "deal.won",
      entityType: "deal",
      entityId: dealId,
      changes: { wonAmountMinor: wonAmount, wonAt: now.toISOString() },
    });
  });

  if (deal.contactId) {
    const { cancelFollowUpsForContact } = await import("./aiConversationPolicyService.ts");
    await cancelFollowUpsForContact(prisma, tid, deal.contactId, "deal_closed");
  }

  return getDeal(prisma, auth, dealId);
}

export async function markDealLost(
  prisma: PrismaClient,
  auth: AuthContext,
  dealId: string,
  input: { lossReason: string; note?: string },
) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const deal = await prisma.deal.findFirst({ where: { id: dealId, tenantId: tid } });
  if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");
  assertDealVisible(auth, deal);
  const reason = String(input.lossReason || "").trim();
  if (!reason) throw new ApiError(422, "invalid", "Укажите причину потери");
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    const closed = await tx.deal.updateMany({
      where: { id: dealId, tenantId: tid, version: deal.version, stageId: deal.stageId, outcome: deal.outcome },
      data: {
        outcome: "lost",
        probability: 0,
        closedAt: now,
        lostAt: now,
        lossReason: reason,
        wonAt: null,
        version: { increment: 1 },
      },
    });
    if (!closed.count) throw new ApiError(409, "conflict", "Сделка изменилась. Обновите страницу и повторите действие.");
    await closeDealStageInterval(tx, tid, dealId, now);
    await tx.activity.create({
      data: {
        tenantId: tid,
        contactId: deal.contactId,
        dealId,
        inquiryId: deal.inquiryId,
        type: "deal.lost",
        title: "Сделка потеряна",
        description: input.note || reason,
        actorType: "user",
        actorId: auth.user.id,
        metadataJson: { lossReason: reason },
      },
    });
    await writeAudit(tx, {
      tenantId: tid,
      actorUserId: auth.user.id,
      action: "deal.lost",
      entityType: "deal",
      entityId: dealId,
      changes: { lossReason: reason, lostAt: now.toISOString(), lostBy: auth.user.id },
    });
  });

  if (deal.contactId) {
    const { cancelFollowUpsForContact } = await import("./aiConversationPolicyService.ts");
    await cancelFollowUpsForContact(prisma, tid, deal.contactId, "deal_closed");
  }

  return getDeal(prisma, auth, dealId);
}

export async function setDealOnHold(prisma: PrismaClient, auth: AuthContext, dealId: string, hold: boolean) {
  const membership = requireTenant(auth);
  const deal = await prisma.deal.findFirst({ where: { id: dealId, tenantId: membership.tenantId } });
  if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");
  assertDealVisible(auth, deal);
  if (deal.outcome === "won" || deal.outcome === "lost") {
    throw new ApiError(422, "closed", "Закрытую сделку нельзя отложить");
  }
  await prisma.deal.update({
    where: { id: dealId },
    data: { outcome: hold ? "on_hold" : "open", version: { increment: 1 } },
  });
  return getDeal(prisma, auth, dealId);
}

export async function createDeal(
  prisma: PrismaClient,
  auth: AuthContext,
  input: {
    title: string;
    contactId: string;
    companyId?: string | null;
    description?: string | null;
    currency?: string;
    offerAmountMinor?: number | null;
    items?: Array<{
      name: string;
      description?: string | null;
      quantity: number;
      unit?: string;
      unitPrice: number;
      vatRate?: number;
      sortOrder?: number;
      catalogItemId?: string | null;
      catalogTruId?: string | null;
    }>;
  },
) {
  const membership = requireTenant(auth);
  if (isManager(auth)) throw new ApiError(403, "forbidden", "Сделку можно создать из своей заявки");
  const tid = membership.tenantId;
  await ensureDealPipelineStages(prisma, tid);

  const contact = await prisma.contact.findFirst({ where: { id: input.contactId, tenantId: tid } });
  if (!contact) throw new ApiError(404, "not_found", "Клиент не найден");

  const companyId = input.companyId || null;
  if (companyId) {
    const company = await prisma.company.findFirst({ where: { id: companyId, tenantId: tid } });
    if (!company) throw new ApiError(404, "not_found", "Компания не найдена");
  }

  const stage = await prisma.dealStage.findFirst({ where: { tenantId: tid, systemKey: "new" } });
  if (!stage) throw new ApiError(500, "misconfigured", "Воронка не настроена");

  const flags = await getTenantDocumentFlags(prisma, tid);
  const preparedItems = (input.items || []).map((item, index) => {
    const vatRate = resolveVatRate(flags, item.vatRate);
    return {
      name: item.name.trim(),
      description: item.description?.trim() || null,
      quantity: item.quantity,
      unit: resolveEsfMeasureUnitCode(item.unit),
      unitPrice: item.unitPrice,
      vatRate,
      ...lineAmounts(item.quantity, item.unitPrice, vatRate),
      sortOrder: item.sortOrder ?? index,
      catalogItemId: item.catalogItemId || null,
      catalogTruId: item.catalogTruId?.trim() || null,
    };
  });
  const totals = preparedItems.length ? sumLines(preparedItems) : null;
  const offerAmountMinor =
    totals != null ? toMinorTenge(totals.totalAmount) : input.offerAmountMinor ?? null;

  const now = new Date();
  const dealId = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Contact" WHERE id = ${contact.id} AND "tenantId" = ${tid} FOR UPDATE`;
    const deal = await tx.deal.create({
      data: {
        tenantId: tid,
        contactId: contact.id,
        companyId,
        inquiryId: null,
        stageId: stage.id,
        title: input.title.trim(),
        description: input.description?.trim() || null,
        currency: input.currency || membership.tenant.currency || "KZT",
        offerAmountMinor,
        assigneeMembershipId: membership.id,
        probability: stage.defaultProbability ?? 10,
        paymentStatus: "NOT_INVOICED",
        stageEnteredAt: now,
      },
    });
    if (preparedItems.length) {
      await tx.dealItem.createMany({
        data: preparedItems.map((item) => ({ tenantId: tid, dealId: deal.id, ...item })),
      });
    }
    await tx.dealStageHistory.create({
      data: {
        tenantId: tid,
        dealId: deal.id,
        fromStageId: null,
        fromSystemKey: null,
        toStageId: stage.id,
        toSystemKey: stage.systemKey,
        enteredAt: now,
        changedByType: "user",
        changedById: auth.user.id,
        note: "Создана вручную",
      },
    });
    await writeActivity(tx, {
      tenantId: tid,
      contactId: contact.id,
      companyId,
      dealId: deal.id,
      type: "deal.created",
      title: "Создана сделка",
      description: deal.title,
      actorType: "user",
      actorId: auth.user.id,
      metadata: { dealId: deal.id, source: "manual" },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: tid,
        actorUserId: auth.user.id,
        action: "deal.create",
        entityType: "deal",
        entityId: deal.id,
        changesJson: { source: "manual", itemCount: preparedItems.length },
      },
    });
    await ensureSalesNextTask(tx, tid, deal.id);
    await enqueueSalesReconcile(tx, tid, deal.id);
    return deal.id;
  });

  return getDeal(prisma, auth, dealId);
}

export async function getTenantOps(prisma: PrismaClient, auth: AuthContext) {
  requireCompanyAdmin(auth);
  const membership = requireTenant(auth);
  const tenant = await prisma.tenant.findUnique({ where: { id: membership.tenantId } });
  const ops = parseOpsSettings(tenant?.settingsJson);
  const stages = await ensureDealPipelineStages(prisma, membership.tenantId);
  const counts = await prisma.deal.groupBy({ by: ["stageId"], where: { tenantId: membership.tenantId, outcome: { in: ["open", "on_hold"] } }, _count: { _all: true } });
  return {
    ...ops,
    timeZone: tenant?.timezone || "Asia/Almaty",
    currency: tenant?.currency || "KZT",
    lostReasons: lostReasonCatalog(ops),
    lostReasonsCustom: ops.lostReasons.length > 0,
    revision: processSettingsRevision(tenant?.settingsJson, tenant?.timezone || "Asia/Almaty", stages),
    stages: stages.filter(stage => !stage.isTerminal).map((stage) => ({
      id: stage.id,
      systemKey: stage.systemKey,
      name: stage.name,
      defaultProbability: stage.defaultProbability,
      isArchived: stage.isArchived,
      isBuiltIn: isBuiltInStage(stage.systemKey),
      openDealCount: counts.find(row => row.stageId === stage.id)?._count._all || 0,
      slaDays: ops.stageSlaDays[stage.systemKey] ?? null,
    })),
  };
}

export async function updateTenantOps(
  prisma: PrismaClient,
  auth: AuthContext,
  input: z.infer<typeof updateTenantOpsSchema>,
) {
  requireCompanyAdmin(auth);
  const membership = requireTenant(auth);
  const parsed = updateTenantOpsSchema.safeParse(input);
  if (!parsed.success) throw new ApiError(422, "invalid", input?.salesPlans ? "Проверьте месяц, валюту и сумму плана. Обновите настройки перед сохранением." : "Проверьте сроки и рабочий календарь.");
  input = parsed.data;
  if (input.pipeline) await ensureDealPipelineStages(prisma, membership.tenantId);
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${membership.tenantId} FOR UPDATE`;
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: membership.tenantId } });
    await tx.$queryRaw`SELECT id FROM "DealStage" WHERE "tenantId" = ${membership.tenantId} ORDER BY id FOR UPDATE`;
    const stages = await tx.dealStage.findMany({ where: { tenantId: membership.tenantId } });
    if (input.revision && input.revision !== processSettingsRevision(tenant.settingsJson, tenant.timezone, stages)) {
      throw new ApiError(409, "settings_changed", "Правила уже изменены в другой вкладке. Загрузите актуальные настройки и повторите изменение.");
    }
    const current = tenant?.settingsJson && typeof tenant.settingsJson === "object"
      ? { ...(tenant.settingsJson as Record<string, unknown>) }
      : {};
    const ops = parseOpsSettings(current);
    if (input.pipeline) await savePipeline(tx, membership.tenantId, input.pipeline, stages, ops);
    if (typeof input.stalledDealDays === "number") ops.stalledDealDays = Math.max(1, Math.min(90, input.stalledDealDays));
    if (typeof input.proposalFollowUpThresholdDays === "number") {
      ops.proposalFollowUpThresholdDays = Math.max(1, Math.min(90, input.proposalFollowUpThresholdDays));
    }
    if (typeof input.silenceReturnDays === "number") ops.silenceReturnDays = Math.max(1, Math.min(180, input.silenceReturnDays));
    if (input.salesPlanMinor === null) ops.salesPlanMinor = null;
    if (typeof input.salesPlanMinor === "number") ops.salesPlanMinor = Math.max(0, Math.round(input.salesPlanMinor));
    if (input.salesPlans) ops.salesPlans = [...input.salesPlans].sort((a, b) => a.month.localeCompare(b.month) || a.currency.localeCompare(b.currency));
    if (Array.isArray(input.lostReasons)) {
      ops.lostReasons = input.lostReasons.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 40);
    }
    if (input.stageSlaDays && typeof input.stageSlaDays === "object") {
      const stages = await tx.dealStage.findMany({ where: { tenantId: membership.tenantId }, select: { systemKey: true } });
      const keys = new Set([...stages.map(stage => stage.systemKey), ...PIPELINE_STAGES.map(stage => stage.systemKey)]);
      if (Object.keys(input.stageSlaDays).some(key => !keys.has(key))) throw new ApiError(422, "invalid", "Неизвестный этап воронки.");
      ops.stageSlaDays = { ...ops.stageSlaDays, ...input.stageSlaDays };
    }
    if (input.processCalendar) ops.processCalendar = input.processCalendar;
    await tx.tenant.update({
      where: { id: membership.tenantId },
      data: { settingsJson: { ...current, ops } as never },
    });
    await writeAudit(tx, {
      tenantId: membership.tenantId,
      actorUserId: auth.user.id,
      action: "settings.ops_updated",
      entityType: "tenant",
      entityId: membership.tenantId,
      changes: { ops, ...(input.pipeline ? { pipeline: input.pipeline, previousPipeline: stages.map(({ id, systemKey, name, sortOrder, defaultProbability, isArchived }) => ({ id, systemKey, name, sortOrder, defaultProbability, isArchived })) } : {}) },
    });
  });
  return getTenantOps(prisma, auth);
}
