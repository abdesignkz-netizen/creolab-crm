import { Prisma, type PrismaClient } from "@creolab/db";

export const MoneyDecimal = Prisma.Decimal.clone({ precision: 60 });

type Db = PrismaClient | Prisma.TransactionClient;
type Amount = Prisma.Decimal | string | number | null | undefined;

/** Existing CRM amounts use whole currency units despite the historical Minor
 * suffix. Keep that convention; never silently convert or combine currencies. */
export function moneyValue(value: Amount, currency: string) {
  if (value == null) return { amount: null, exact: null, label: null };
  const decimal = new MoneyDecimal(value).toDecimalPlaces(0);
  const exact = decimal.toFixed(0), number = Number(exact);
  return { amount: Number.isSafeInteger(number) ? number : null, exact,
    label: `${BigInt(exact).toLocaleString("ru-RU")} ${currency === "KZT" ? "₸" : currency}` };
}

export function saleAmount(deal: { outcome?: string; wonAmountMinor?: Amount; offerAmountMinor?: Amount }) {
  return deal.outcome === "won" ? deal.wonAmountMinor ?? deal.offerAmountMinor : deal.offerAmountMinor;
}

/** Match the established statistics exclusion policy, including legacy links
 * populated in only one direction. This scope is shared by all money reports. */
export async function businessDealWhere(db: Db, tenantId: string): Promise<Prisma.DealWhereInput> {
  const excluded = await db.inquiry.findMany({ where: { tenantId, OR: [{ test: true }, { archived: true }] }, select: { id: true, dealId: true } });
  return { tenantId, AND: [
    { OR: [{ inquiryId: null }, { inquiryId: { notIn: excluded.map(row => row.id) } }] },
    { id: { notIn: excluded.flatMap(row => row.dealId ? [row.dealId] : []) } },
  ] };
}

export async function wonSalesTotals(db: Db, where: Prisma.DealWhereInput, period: Prisma.DateTimeFilter | undefined, currency: string) {
  const wonWhere: Prisma.DealWhereInput = { AND: [where, { outcome: "won", ...(period ? { closedAt: period } : {}) }] };
  const [groups, fallback] = await Promise.all([
    db.deal.groupBy({ by: ["currency"], where: wonWhere, _count: { _all: true, wonAmountMinor: true }, _sum: { wonAmountMinor: true }, _max: { wonAmountMinor: true } }),
    db.deal.groupBy({ by: ["currency"], where: { AND: [wonWhere, { wonAmountMinor: null }] }, _count: { offerAmountMinor: true }, _sum: { offerAmountMinor: true }, _max: { offerAmountMinor: true } }),
  ]);
  const byCurrency = groups.map(group => {
    const f = fallback.find(row => row.currency === group.currency);
    const known = group._count.wonAmountMinor + (f?._count.offerAmountMinor || 0), count = group._count._all;
    const sum = new MoneyDecimal(group._sum.wonAmountMinor || 0).plus(f?._sum.offerAmountMinor || 0);
    const maxima = [group._max.wonAmountMinor, f?._max.offerAmountMinor].filter((n): n is Prisma.Decimal => n != null);
    return { currency: group.currency, count, known, missing: count - known, ...moneyValue(known ? sum : null, group.currency),
      avg: moneyValue(known ? sum.div(known) : null, group.currency), max: moneyValue(maxima.length ? MoneyDecimal.max(...maxima) : null, group.currency) };
  }).sort((a, b) => a.currency.localeCompare(b.currency));
  const total = byCurrency.find(row => row.currency === currency) || { currency, count: 0, known: 0, missing: 0,
    ...moneyValue(null, currency), avg: moneyValue(null, currency), max: moneyValue(null, currency) };
  return { count: groups.reduce((sum, row) => sum + row._count._all, 0), total, byCurrency };
}

export function confirmedPaymentsWhere(tenantId: string, dealWhere: Prisma.DealWhereInput, period?: Prisma.DateTimeFilter): Prisma.PaymentRecordWhereInput {
  return { tenantId, status: "confirmed", ...(period ? { confirmedAt: period } : {}), deal: { is: dealWhere } };
}

export async function confirmedPaymentTotals(db: Db, tenantId: string, dealWhere: Prisma.DealWhereInput, period: Prisma.DateTimeFilter | undefined, currency: string) {
  const groups = await db.paymentRecord.groupBy({ by: ["currency"], where: confirmedPaymentsWhere(tenantId, dealWhere, period), _count: { _all: true }, _sum: { amountMinor: true } });
  const byCurrency = groups.map(row => ({ currency: row.currency, count: row._count._all, ...moneyValue(row._sum.amountMinor || 0, row.currency) }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
  return { count: groups.reduce((sum, row) => sum + row._count._all, 0), byCurrency,
    total: byCurrency.find(row => row.currency === currency) || { currency, count: 0, ...moneyValue(0, currency) } };
}

export async function openPipelineTotals(db: Db, where: Prisma.DealWhereInput, currency: string) {
  const groups = await db.deal.groupBy({ by: ["currency", "probability"], where: { AND: [where, { outcome: "open" }] },
    _count: { _all: true, offerAmountMinor: true }, _sum: { offerAmountMinor: true } });
  const map = new Map<string, { count: number; known: number; sum: Prisma.Decimal; weighted: Prisma.Decimal }>();
  for (const row of groups) {
    const value = map.get(row.currency) || { count: 0, known: 0, sum: new MoneyDecimal(0), weighted: new MoneyDecimal(0) };
    value.count += row._count._all; value.known += row._count.offerAmountMinor;
    value.sum = value.sum.plus(row._sum.offerAmountMinor || 0);
    value.weighted = value.weighted.plus(new MoneyDecimal(row._sum.offerAmountMinor || 0).mul(row.probability).div(100));
    map.set(row.currency, value);
  }
  const byCurrency = [...map].map(([currency, row]) => ({ currency, count: row.count, known: row.known, missing: row.count - row.known,
    ...moneyValue(row.known ? row.sum : null, currency), weighted: moneyValue(row.known ? row.weighted : null, currency) }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
  return { count: groups.reduce((sum, row) => sum + row._count._all, 0), byCurrency,
    total: byCurrency.find(row => row.currency === currency) || { currency, count: 0, known: 0, missing: 0,
      ...moneyValue(null, currency), weighted: moneyValue(null, currency) } };
}

/** Remaining receivables on invoiced open deals, after same-currency confirmed
 * payments. An advance in another currency is shown separately, not converted. */
export async function outstandingPaymentTotals(db: Db, where: Prisma.DealWhereInput, currency: string) {
  const totals = new Map<string, { sum: Prisma.Decimal; count: number; known: number }>();
  let cursor: string | undefined;
  for (;;) {
    const rows: Array<{ id: string; currency: string; offerAmountMinor: Prisma.Decimal | null; payments: Array<{ currency: string; amountMinor: Prisma.Decimal }> }> = await db.deal.findMany({
      where: { AND: [where, { outcome: "open", paymentStatus: { in: ["INVOICED", "PARTIALLY_PAID", "OVERDUE"] } }, ...(cursor ? [{ id: { gt: cursor } }] : [])] },
      orderBy: { id: "asc" }, take: 500,
      select: { id: true, currency: true, offerAmountMinor: true, payments: { where: { status: "confirmed" }, select: { amountMinor: true, currency: true } } },
    });
    for (const row of rows) {
      const total = totals.get(row.currency) || { sum: new MoneyDecimal(0), count: 0, known: 0 };
      total.count++;
      if (row.offerAmountMinor != null) {
        const paid = row.payments.filter(p => p.currency === row.currency).reduce((sum, p) => sum.plus(p.amountMinor), new MoneyDecimal(0));
        total.sum = total.sum.plus(MoneyDecimal.max(0, new MoneyDecimal(row.offerAmountMinor).minus(paid)));
        total.known++;
      }
      totals.set(row.currency, total);
    }
    if (rows.length < 500) break;
    cursor = rows[rows.length - 1].id;
  }
  const byCurrency = [...totals].map(([currency, row]) => ({ currency, count: row.count, known: row.known, missing: row.count - row.known,
    ...moneyValue(row.known ? row.sum : null, currency) })).sort((a, b) => a.currency.localeCompare(b.currency));
  return { byCurrency, total: byCurrency.find(row => row.currency === currency) || { currency, count: 0, known: 0, missing: 0, ...moneyValue(null, currency) } };
}
