import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import {
  LEGACY_STAGE_MAP,
  LOST_REASONS,
  PAYMENT_STATUSES,
  PIPELINE_STAGES,
  amountNumber,
  formatMoney,
  parseOpsSettings,
  stageDurationLabel,
} from "./dealPipeline.ts";
import { resolvePeriodRange, periodLabel, type PeriodPreset } from "./periodRange.ts";

type DealTimeMode = "now" | "period";
type DealPeriodBasis = "created" | "activity" | "closed";
type DealFocus = "all" | "stalled" | "needs_reply" | "no_next_action";

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
    if (row) {
      await prisma.dealStage.update({
        where: { id: row.id },
        data: {
          name: def.name,
          sortOrder: def.sortOrder,
          defaultProbability: def.defaultProbability,
          isTerminal: false,
        },
      });
    } else {
      await prisma.dealStage.create({
        data: {
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

  const legacy = byKey.get("qualification");
  const target = await prisma.dealStage.findFirst({
    where: { tenantId, systemKey: "need_identified" },
  });
  if (legacy && target) {
    await prisma.deal.updateMany({
      where: { tenantId, stageId: legacy.id, outcome: "open" },
      data: { stageId: target.id },
    });
  }

  return prisma.dealStage.findMany({ where: { tenantId }, orderBy: { sortOrder: "asc" } });
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
      where: { status: { in: ["open", "waiting"] } },
      orderBy: { dueAt: "asc" as const },
      take: 5,
    },
    inquiry: { select: { id: true, subject: true, source: true, sourceChannel: true } },
  };
}

function flagsForDeal(
  deal: {
    nextAction: string | null;
    nextActionAt: Date | null;
    stageEnteredAt: Date;
    stage: { systemKey: string };
    tasks: Array<{ dueAt: Date | null; status: string }>;
    contact?: {
      lastInboundMessageAt?: Date | null;
      lastOutboundMessageAt?: Date | null;
      lastContactAt?: Date | null;
    } | null;
  },
  ops: ReturnType<typeof parseOpsSettings>,
  now: Date,
) {
  const hasOpenTask = deal.tasks.length > 0;
  const hasFutureTask = deal.tasks.some((t) => t.dueAt && t.dueAt.getTime() >= now.getTime());
  const overdueTask = deal.tasks.some((t) => t.dueAt && t.dueAt < now);
  const needsReply = Boolean(
    deal.contact?.lastInboundMessageAt &&
      (!deal.contact.lastOutboundMessageAt ||
        deal.contact.lastInboundMessageAt > deal.contact.lastOutboundMessageAt),
  );
  const waitingClient = Boolean(deal.nextAction && /жд[её]м|клиент|waiting/i.test(deal.nextAction));
  const noNextAction = !deal.nextAction && !hasOpenTask;
  const daysOnStage = (now.getTime() - deal.stageEnteredAt.getTime()) / 86400000;
  const sla = ops.stageSlaDays[deal.stage.systemKey];
  const overSla = typeof sla === "number" && daysOnStage > sla;
  const lastTouch = deal.contact?.lastContactAt
    ? new Date(deal.contact.lastContactAt).getTime()
    : deal.stageEnteredAt.getTime();
  const stalledBySilence = now.getTime() - lastTouch > ops.stalledDealDays * 86400000;
  const stalled =
    (stalledBySilence && !hasFutureTask && !waitingClient) || overSla || (noNextAction && daysOnStage > 2);

  return {
    needsReply,
    overdueTask,
    noNextAction,
    waitingClient,
    stalled,
    overSla,
    daysOnStage: Math.floor(daysOnStage),
  };
}

function serializeDeal(deal: any, ops: ReturnType<typeof parseOpsSettings>, currency: string, now = new Date()) {
  const amount = amountNumber(deal.offerAmountMinor);
  const flags = flagsForDeal({ ...deal, contact: deal.contact }, ops, now);
  const assigneeName = deal.assignee?.user?.name || deal.assignee?.user?.email || null;
  const probability = deal.probability ?? deal.stage?.defaultProbability ?? 10;
  return {
    id: deal.id,
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
    amountLabel: formatMoney(amount, deal.currency || currency),
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
    wonAmountMinor: amountNumber(deal.wonAmountMinor),
    contact: deal.contact
      ? {
          id: deal.contact.id,
          name:
            deal.contact.name ||
            [deal.contact.firstName, deal.contact.lastName].filter(Boolean).join(" "),
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
    tasks: (deal.tasks || []).map((t: any) => ({
      id: t.id,
      title: t.title,
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
  } = {},
) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const currency = membership.tenant.currency || "KZT";
  const timeZone = membership.tenant.timezone || "Asia/Almaty";
  const tenant = await prisma.tenant.findUnique({ where: { id: tid } });
  const ops = parseOpsSettings(tenant?.settingsJson);
  const stages = await ensureDealPipelineStages(prisma, tid);
  const scope = query.scope === "mine" || query.scope === "unassigned" ? query.scope : "all";
  const timeMode: DealTimeMode = query.timeMode === "period" ? "period" : "now";
  const basis: DealPeriodBasis =
    query.basis === "activity" || query.basis === "closed" ? query.basis : "created";
  const focus: DealFocus =
    query.focus === "stalled" || query.focus === "needs_reply" || query.focus === "no_next_action"
      ? query.focus
      : "all";
  const includeClosed =
    query.includeClosed === "1" ||
    query.includeClosed === "true" ||
    timeMode === "period";
  const now = new Date();

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

  const createdRange = dateRangeFilter(from, to);
  let idFilter: string[] | null = null;

  if (timeMode === "period" && basis === "activity") {
    idFilter = await findDealIdsWithActivity(prisma, tid, from, to);
  }

  const where: Record<string, unknown> = {
    tenantId: tid,
    ...assigneeWhere,
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
    },
  });
  const contactById = new Map(contacts.map((c) => [c.id, c]));

  const serializedAll = deals.map((d) =>
    serializeDeal({ ...d, contact: contactById.get(d.contactId) || d.contact }, ops, currency, now),
  );

  const focusFilter = (d: (typeof serializedAll)[number]) => {
    if (focus === "stalled") return Boolean(d.flags.stalled);
    if (focus === "needs_reply") return Boolean(d.flags.needsReply);
    if (focus === "no_next_action") return Boolean(d.flags.noNextAction);
    return true;
  };

  const forKanban = serializedAll.filter((d) => {
    if (timeMode === "now") return d.outcome === "open" && focusFilter(d);
    if (basis === "closed") return (d.outcome === "won" || d.outcome === "lost") && focusFilter(d);
    return focusFilter(d);
  });

  const columns = stages
    .filter((s) => PIPELINE_STAGES.some((p) => p.systemKey === s.systemKey))
    .map((stage) => {
      const items = forKanban.filter((d) => d.stageId === stage.id);
      let sum = 0;
      let known = 0;
      let weighted = 0;
      for (const item of items) {
        if (item.amount != null) {
          sum += item.amount;
          known += 1;
          weighted += item.weightedAmount || 0;
        }
      }
      return {
        stageId: stage.id,
        systemKey: stage.systemKey,
        name: stage.name,
        sortOrder: stage.sortOrder,
        count: items.length,
        amountSum: known ? sum : null,
        amountLabel: formatMoney(known ? sum : null, currency),
        weightedSum: known ? weighted : null,
        weightedLabel: formatMoney(known ? weighted : null, currency),
        amountKnownCount: known,
        deals: items,
      };
    });

  const openSerialized = forKanban.filter((d) => d.outcome === "open");
  let pipelineSum = 0;
  let pipelineKnown = 0;
  let weightedSum = 0;
  for (const d of openSerialized) {
    if (d.amount != null) {
      pipelineSum += d.amount;
      pipelineKnown += 1;
      weightedSum += d.weightedAmount || 0;
    }
  }

  const expectedList = openSerialized.filter((d) =>
    ["INVOICED", "PARTIALLY_PAID", "OVERDUE"].includes(d.paymentStatus),
  );
  const expectedPayments = expectedList.reduce((acc, d) => acc + (d.amount || 0), 0);

  const wonInView = serializedAll.filter((d) => d.outcome === "won");
  const lostInView = serializedAll.filter((d) => d.outcome === "lost");
  let soldSum = 0;
  let soldKnown = 0;
  for (const d of wonInView) {
    if (d.amount != null) {
      soldSum += d.amount;
      soldKnown += 1;
    }
  }

  const createdInPeriod =
    timeMode === "period" && basis === "created"
      ? serializedAll.length
      : timeMode === "period"
        ? (
            await prisma.deal.count({
              where: {
                tenantId: tid,
                ...assigneeWhere,
                ...(createdRange ? { createdAt: createdRange } : {}),
              },
            })
          )
        : null;

  const closedWonCount =
    timeMode === "period"
      ? basis === "closed"
        ? wonInView.length
        : await prisma.deal.count({
            where: {
              tenantId: tid,
              ...assigneeWhere,
              outcome: "won",
              ...(createdRange ? { closedAt: createdRange } : {}),
            },
          })
      : null;
  const closedLostCount =
    timeMode === "period"
      ? basis === "closed"
        ? lostInView.length
        : await prisma.deal.count({
            where: {
              tenantId: tid,
              ...assigneeWhere,
              outcome: "lost",
              ...(createdRange ? { closedAt: createdRange } : {}),
            },
          })
      : null;

  let periodSold = soldSum;
  let periodSoldKnown = soldKnown;
  if (timeMode === "period" && basis !== "closed") {
    const wonDeals = await prisma.deal.findMany({
      where: {
        tenantId: tid,
        ...assigneeWhere,
        outcome: "won",
        ...(createdRange ? { closedAt: createdRange } : {}),
      },
      select: { offerAmountMinor: true, wonAmountMinor: true },
      take: 2000,
    });
    periodSold = 0;
    periodSoldKnown = 0;
    for (const d of wonDeals) {
      const n = amountNumber(d.wonAmountMinor ?? d.offerAmountMinor);
      if (n != null) {
        periodSold += n;
        periodSoldKnown += 1;
      }
    }
  }

  return {
    asOf: now.toISOString(),
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
            activeDeals: openSerialized.length,
            pipelineAmount: pipelineKnown ? pipelineSum : null,
            pipelineAmountLabel: formatMoney(pipelineKnown ? pipelineSum : null, currency),
            weightedPipeline: pipelineKnown ? weightedSum : null,
            weightedPipelineLabel: formatMoney(pipelineKnown ? weightedSum : null, currency),
            amountKnownCount: pipelineKnown,
            amountKnownOf: openSerialized.length,
            expectedPayments: expectedList.length ? expectedPayments : null,
            expectedPaymentsLabel: formatMoney(expectedList.length ? expectedPayments : null, currency),
            stalledCount: openSerialized.filter((d) => d.flags.stalled).length,
            noNextActionCount: openSerialized.filter((d) => d.flags.noNextAction).length,
            needsReplyCount: openSerialized.filter((d) => d.flags.needsReply).length,
          }
        : {
            mode: "period" as const,
            createdDeals: createdInPeriod,
            wonDeals: closedWonCount,
            lostDeals: closedLostCount,
            soldAmount: periodSoldKnown ? periodSold : null,
            soldAmountLabel: formatMoney(periodSoldKnown ? periodSold : null, currency),
            dealsInView: forKanban.length,
            activityDeals: basis === "activity" ? forKanban.length : null,
          },
    columns,
    onHold:
      timeMode === "now"
        ? deals.filter((d) => d.outcome === "on_hold").map((d) => serializeDeal(d, ops, currency, now))
        : [],
    closed:
      timeMode === "period" && basis === "closed"
        ? forKanban
        : includeClosed && timeMode === "now"
          ? deals
              .filter((d) => d.outcome === "won" || d.outcome === "lost")
              .map((d) => serializeDeal(d, ops, currency, now))
          : [],
    lostReasons: [...LOST_REASONS],
    paymentStatuses: [...PAYMENT_STATUSES],
  };
}

export async function getDeal(prisma: PrismaClient, auth: AuthContext, dealId: string) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const ops = parseOpsSettings((await prisma.tenant.findUnique({ where: { id: tid } }))?.settingsJson);
  const deal = await prisma.deal.findFirst({
    where: { id: dealId, tenantId: tid },
    include: {
      ...dealInclude(),
      stageHistory: { orderBy: { enteredAt: "desc" }, take: 30 },
    },
  });
  if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");
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
    },
  });
  return {
    deal: serializeDeal({ ...deal, contact }, ops, membership.tenant.currency || "KZT"),
    stageHistory: deal.stageHistory,
    payments: deal.payments,
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

  const probability = input.probability as number | undefined;
  if (probability != null && (probability < 0 || probability > 100)) {
    throw new ApiError(422, "invalid", "Вероятность 0–100");
  }
  const paymentStatus = input.paymentStatus as string | undefined;
  if (paymentStatus && !PAYMENT_STATUSES.includes(paymentStatus as (typeof PAYMENT_STATUSES)[number])) {
    throw new ApiError(422, "invalid", "Некорректный статус оплаты");
  }

  await prisma.deal.update({
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
      version: { increment: 1 },
    },
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
  if (deal.outcome !== "open" && deal.outcome !== "on_hold") {
    throw new ApiError(422, "closed", "Закрытую сделку нельзя двигать по воронке");
  }

  let targetKey = input.systemKey || "";
  if (input.stageId) {
    const st = await prisma.dealStage.findFirst({ where: { id: input.stageId, tenantId: tid } });
    if (!st) throw new ApiError(404, "not_found", "Стадия не найдена");
    targetKey = st.systemKey;
  }
  targetKey = LEGACY_STAGE_MAP[targetKey] || targetKey;
  const toStage = await prisma.dealStage.findFirst({ where: { tenantId: tid, systemKey: targetKey } });
  if (!toStage) throw new ApiError(404, "not_found", "Стадия не найдена");
  if (toStage.id === deal.stageId) return getDeal(prisma, auth, dealId);

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.dealStageHistory.updateMany({
      where: { tenantId: tid, dealId, leftAt: null },
      data: { leftAt: now },
    });
    await tx.dealStageHistory.create({
      data: {
        id: randomUUID(),
        tenantId: tid,
        dealId,
        fromStageId: deal.stageId,
        fromSystemKey: deal.stage.systemKey,
        toStageId: toStage.id,
        toSystemKey: toStage.systemKey,
        enteredAt: now,
        changedByType: "user",
        changedById: auth.user.id,
        note: input.note || null,
      },
    });
    await tx.deal.update({
      where: { id: dealId },
      data: {
        stageId: toStage.id,
        stageEnteredAt: now,
        probability: toStage.defaultProbability,
        outcome: "open",
        version: { increment: 1 },
        ...(toStage.systemKey === "proposal_sent" && !deal.nextAction
          ? { nextAction: "Follow-up по КП", nextActionAt: new Date(now.getTime() + 86400000) }
          : {}),
        ...(toStage.systemKey === "invoiced"
          ? { paymentStatus: deal.paymentStatus === "NOT_INVOICED" ? "INVOICED" : deal.paymentStatus }
          : {}),
      },
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
  const now = new Date();
  const wonAmount = input.wonAmountMinor ?? amountNumber(deal.offerAmountMinor);

  await prisma.$transaction(async (tx) => {
    await tx.deal.update({
      where: { id: dealId },
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
  });

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
  const reason = String(input.lossReason || "").trim();
  if (!reason) throw new ApiError(422, "invalid", "Укажите причину потери");
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.deal.update({
      where: { id: dealId },
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
  });

  return getDeal(prisma, auth, dealId);
}

export async function setDealOnHold(prisma: PrismaClient, auth: AuthContext, dealId: string, hold: boolean) {
  const membership = requireTenant(auth);
  const deal = await prisma.deal.findFirst({ where: { id: dealId, tenantId: membership.tenantId } });
  if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");
  if (deal.outcome === "won" || deal.outcome === "lost") {
    throw new ApiError(422, "closed", "Закрытую сделку нельзя отложить");
  }
  await prisma.deal.update({
    where: { id: dealId },
    data: { outcome: hold ? "on_hold" : "open", version: { increment: 1 } },
  });
  return getDeal(prisma, auth, dealId);
}
