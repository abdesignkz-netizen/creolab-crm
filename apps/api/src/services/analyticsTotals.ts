import type { Prisma, PrismaClient } from "@creolab/db";
import { moneyValue, wonSalesTotals, confirmedPaymentTotals, openPipelineTotals } from "./financialMetrics.ts";

/** Totals are database aggregates over all matching records. Detail limits must
 * never limit these values; receipts and won sales have different date bases. */
export async function analyticsTotals(db: PrismaClient, inquiryWhere: Prisma.InquiryWhereInput,
  dealWhere: Prisma.DealWhereInput, period: Prisma.DateTimeFilter | undefined, tenantId: string, currency: string) {
  const [inquiries, created, sales, receipts, lost, lostMoney, pipeline] = await Promise.all([
    db.inquiry.count({ where: { ...inquiryWhere, ...(period ? { receivedAt: period } : {}) } }),
    db.deal.count({ where: { ...dealWhere, ...(period ? { createdAt: period } : {}) } }),
    wonSalesTotals(db, dealWhere, period, currency),
    confirmedPaymentTotals(db, tenantId, dealWhere, period, currency),
    db.deal.count({ where: { ...dealWhere, outcome: "lost", ...(period ? { closedAt: period } : {}) } }),
    db.deal.aggregate({ where: { ...dealWhere, currency, outcome: "lost", ...(period ? { closedAt: period } : {}) }, _sum: { offerAmountMinor: true }, _count: { offerAmountMinor: true } }),
    openPipelineTotals(db, dealWhere, currency),
  ]);
  return {
    inquiryCount: inquiries, dealsCreated: created, won: sales.count, lost,
    revenue: sales.total.amount, revenueKnown: sales.total.known, avgCheck: sales.total.avg.amount, maxCheck: sales.total.max.amount,
    lostAmount: moneyValue(lostMoney._count.offerAmountMinor ? lostMoney._sum.offerAmountMinor : null, currency).amount,
    lostAmountLabel: moneyValue(lostMoney._count.offerAmountMinor ? lostMoney._sum.offerAmountMinor : null, currency).label,
    pipeline: pipeline.total.amount, pipelineKnown: pipeline.total.known, weighted: pipeline.total.weighted.amount,
    financial: { currency, sales, receipts, pipeline, salesDateBasis: "closedAt", receiptsDateBasis: "confirmedAt", amountsConverted: false },
  };
}
