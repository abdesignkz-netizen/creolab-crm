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
  query: { scope?: string; includeClosed?: string } = {},
) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const currency = membership.tenant.currency || "KZT";
  const tenant = await prisma.tenant.findUnique({ where: { id: tid } });
  const ops = parseOpsSettings(tenant?.settingsJson);
  const stages = await ensureDealPipelineStages(prisma, tid);
  const scope = query.scope === "mine" || query.scope === "unassigned" ? query.scope : "all";
  const includeClosed = query.includeClosed === "1" || query.includeClosed === "true";
  const now = new Date();

  const assigneeWhere =
    scope === "mine"
      ? { assigneeMembershipId: membership.id }
      : scope === "unassigned"
        ? { assigneeMembershipId: null }
        : {};

  const deals = await prisma.deal.findMany({
    where: {
      tenantId: tid,
      ...assigneeWhere,
      ...(includeClosed ? {} : { outcome: { in: ["open", "on_hold"] } }),
    },
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

  const columns = stages
    .filter((s) => PIPELINE_STAGES.some((p) => p.systemKey === s.systemKey))
    .map((stage) => {
      const items = deals
        .filter((d) => d.stageId === stage.id && d.outcome === "open")
        .map((d) =>
          serializeDeal({ ...d, contact: contactById.get(d.contactId) || d.contact }, ops, currency, now),
        );
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

  const openSerialized = columns.flatMap((c) => c.deals);
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

  return {
    asOf: now.toISOString(),
    currency,
    ops: {
      stalledDealDays: ops.stalledDealDays,
      proposalFollowUpThresholdDays: ops.proposalFollowUpThresholdDays,
      stageSlaDays: ops.stageSlaDays,
    },
    summary: {
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
    },
    columns,
    onHold: deals.filter((d) => d.outcome === "on_hold").map((d) => serializeDeal(d, ops, currency, now)),
    closed: includeClosed
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
