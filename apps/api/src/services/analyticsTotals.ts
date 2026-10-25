import type { Prisma, PrismaClient } from "@creolab/db";
import { amountNumber } from "./dealPipeline.ts";

/** Totals are database aggregates over all matching records. Never derive these
 * from the bounded rows used by detailed tables and median/cycle samples. */
export async function analyticsTotals(db: PrismaClient, inquiryWhere: Prisma.InquiryWhereInput,
  dealWhere: Prisma.DealWhereInput, period: Prisma.DateTimeFilter | undefined) {
  const wonWhere = { ...dealWhere, outcome: "won", ...(period ? { closedAt: period } : {}) };
  const [inquiries, created, won, fallback, lost, pipeline, probabilities] = await Promise.all([
    db.inquiry.count({ where: { ...inquiryWhere, ...(period ? { receivedAt: period } : {}) } }),
    db.deal.count({ where: { ...dealWhere, ...(period ? { createdAt: period } : {}) } }),
    db.deal.aggregate({ where: wonWhere, _count: { _all: true, wonAmountMinor: true }, _sum: { wonAmountMinor: true }, _max: { wonAmountMinor: true } }),
    db.deal.aggregate({ where: { ...wonWhere, wonAmountMinor: null }, _count: { offerAmountMinor: true }, _sum: { offerAmountMinor: true }, _max: { offerAmountMinor: true } }),
    db.deal.aggregate({ where: { ...dealWhere, outcome: "lost", ...(period ? { closedAt: period } : {}) }, _count: { _all: true }, _sum: { offerAmountMinor: true } }),
    db.deal.aggregate({ where: { ...dealWhere, outcome: "open" }, _count: { offerAmountMinor: true }, _sum: { offerAmountMinor: true } }),
    db.deal.groupBy({ by: ["probability"], where: { ...dealWhere, outcome: "open", offerAmountMinor: { not: null } }, _sum: { offerAmountMinor: true } }),
  ]);
  const revenue = (amountNumber(won._sum.wonAmountMinor) || 0) + (amountNumber(fallback._sum.offerAmountMinor) || 0);
  const revenueKnown = won._count.wonAmountMinor + fallback._count.offerAmountMinor;
  const maxima = [amountNumber(won._max.wonAmountMinor), amountNumber(fallback._max.offerAmountMinor)].filter((n): n is number => n != null);
  return {
    inquiryCount: inquiries, dealsCreated: created, won: won._count._all, lost: lost._count._all,
    revenue, revenueKnown, avgCheck: revenueKnown ? Math.round(revenue / revenueKnown) : null,
    maxCheck: maxima.length ? Math.max(...maxima) : null,
    lostAmount: amountNumber(lost._sum.offerAmountMinor) || 0,
    pipeline: amountNumber(pipeline._sum.offerAmountMinor) || 0, pipelineKnown: pipeline._count.offerAmountMinor,
    // Round the total estimate once; it is not an actual receipt/payment amount.
    weighted: Math.round(probabilities.reduce((sum, group) => sum + (amountNumber(group._sum.offerAmountMinor) || 0) * group.probability / 100, 0)),
  };
}
