import { Prisma } from "@creolab/db";
import type { GoalMetric, GoalSample } from "@creolab/contracts";
import type { DomainDb } from "../lib/transaction.ts";
import { businessDealSql, moneyValue } from "./financialMetrics.ts";
import { parseOpsSettings } from "./dealPipeline.ts";
type BusinessGoal = Prisma.BusinessGoalGetPayload<Record<string, never>>;

export function goalTarget(goal: BusinessGoal, settings: unknown): number | null {
  return goal.metric === "sales_won" ? parseOpsSettings(settings).salesPlans.find(p => p.month === goal.salesMonth && p.currency === goal.currency)?.amount ?? null
    : goal.target === null ? null : Number(goal.target);
}
export function goalProgress(metric: GoalMetric, sample: GoalSample, target: number | null, baseline: number | null) {
  if (sample.status !== "ready" || sample.value === null || target === null || sample.unanswered > 0 || (metric === "sales_won" && target <= 0)) return { progress: null, reached: null };
  const current = sample.value, reached = metric === "sales_won" ? current >= target : current <= target;
  const ratio = metric === "sales_won" ? current / target : baseline === null ? null : baseline <= target ? (reached ? 1 : 0) : (baseline - current) / (baseline - target);
  // Rounding must not display 100% before the unrounded target is reached.
  return { reached, progress: ratio === null ? null : Math.min(reached ? 100 : 99.9, Math.round(Math.max(0, Math.min(1, ratio)) * 1000) / 10) };
}
/** Fixed Task alias t. Keep linked initiatives and measured tasks in the same
 * business scope, including both directions of legacy inquiry/deal links. */
export function goalTaskScope(tenantId: string) {
  return Prisma.sql`t."tenantId" = ${tenantId}
    AND NOT EXISTS (SELECT 1 FROM "Contact" c WHERE c."tenantId" = t."tenantId" AND c.id = t."contactId" AND c."archivedAt" IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM "Inquiry" i WHERE i."tenantId" = t."tenantId" AND (i.id = t."inquiryId" OR i."dealId" = t."dealId") AND (i.test OR i.archived))
    AND NOT EXISTS (SELECT 1 FROM "Deal" d JOIN "Inquiry" i ON i.id = d."inquiryId" AND i."tenantId" = d."tenantId" WHERE d.id = t."dealId" AND d."tenantId" = t."tenantId" AND (i.test OR i.archived))`;
}
const definitions: Record<GoalMetric, { formula: string; limitation: string }> = {
  sales_won: { formula: "Сумма выигранных сделок с датой закрытия в месяце плана: сумма продажи, а при её отсутствии — сумма предложения. Только выбранная валюта; тестовые и архивные заявки исключены.",
    limitation: "Выигранная сделка не означает поступление денег. Данные вне CRM не учитываются. План задаётся в настройках продаж." },
  overdue_tasks: { formula: "Количество незавершённых задач компании со сроком раньше времени проверки. Учитываются открытые, выполняемые и ожидающие задачи, включая созданные до начала цели.",
    limitation: "Снимок на момент проверки. Тестовые и архивные клиентские записи исключены. Историческое состояние задачи по сегодняшнему статусу не восстанавливается." },
  first_response_minutes: { formula: "Среднее время от первого входящего сообщения клиента в каждом диалоге за период до первого принятого каналом ответа сотрудника или ИИ после него, внутри того же периода.",
    limitation: "Календарные минуты по времени записанных сообщений, включая ночь и выходные. Импорт истории, внутренние сообщения, неуспешные отправки и тестовые заявки исключены. Диалоги без ответа показаны отдельно и не позволяют считать цель достигнутой." },
};
export function emptyGoalSample(metric: GoalMetric, status: GoalSample["status"]): GoalSample {
  return { value: null, exact: null, status, samples: 0, unanswered: 0, excluded: 0, ...definitions[metric] };
}
/** Aggregate source facts, never a truncated list or an LLM estimate. */
export async function measureGoalFacts(db: DomainDb, goal: BusinessGoal, now: Date): Promise<GoalSample> {
  const metric = goal.metric as GoalMetric, base = emptyGoalSample(metric, "ready");
  if (now < goal.periodStart) return { ...base, status: "not_started" };
  const cutoff = new Date(Math.min(now.getTime(), goal.periodEnd.getTime()));
  if (metric === "overdue_tasks") {
    if (now >= goal.periodEnd) return { ...base, status: "ended_snapshot" };
    const [r] = await db.$queryRaw<Array<{ total: number; overdue: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE t."dueAt" < ${now})::int AS overdue
      FROM "Task" t WHERE ${goalTaskScope(goal.tenantId)} AND t.status IN ('open','in_progress','waiting') AND t."createdAt" <= ${now}`);
    return { ...base, value: r.overdue, exact: String(r.overdue), samples: r.total };
  }
  if (metric === "sales_won") {
    const scope = businessDealSql(goal.tenantId);
    const [r] = await db.$queryRaw<Array<{ count: number; missing: number; negative: number; amount: Prisma.Decimal | null; undated: number; other: number }>>(Prisma.sql`
      SELECT COUNT(*) FILTER (WHERE d.currency = ${goal.currency} AND d."closedAt" >= ${goal.periodStart} AND d."closedAt" < ${goal.periodEnd} AND d."closedAt" <= ${cutoff})::int AS count,
        COUNT(*) FILTER (WHERE d.currency = ${goal.currency} AND d."closedAt" >= ${goal.periodStart} AND d."closedAt" < ${goal.periodEnd} AND d."closedAt" <= ${cutoff} AND COALESCE(d."wonAmountMinor", d."offerAmountMinor") IS NULL)::int AS missing,
        COUNT(*) FILTER (WHERE d.currency = ${goal.currency} AND d."closedAt" >= ${goal.periodStart} AND d."closedAt" < ${goal.periodEnd} AND d."closedAt" <= ${cutoff} AND COALESCE(d."wonAmountMinor", d."offerAmountMinor") < 0)::int AS negative,
        SUM(COALESCE(d."wonAmountMinor", d."offerAmountMinor")) FILTER (WHERE d.currency = ${goal.currency} AND d."closedAt" >= ${goal.periodStart} AND d."closedAt" < ${goal.periodEnd} AND d."closedAt" <= ${cutoff}) AS amount,
        COUNT(*) FILTER (WHERE d.currency = ${goal.currency} AND d."closedAt" IS NULL)::int AS undated,
        COUNT(*) FILTER (WHERE d.currency <> ${goal.currency} AND d."closedAt" >= ${goal.periodStart} AND d."closedAt" < ${goal.periodEnd} AND d."closedAt" <= ${cutoff})::int AS other
      FROM "Deal" d WHERE ${scope} AND d.outcome = 'won'`);
    const money = moneyValue(r.amount || 0, goal.currency!);
    const incomplete = r.missing > 0 || r.negative > 0 || r.undated > 0 || money.amount === null;
    return { ...base, status: incomplete ? "incomplete" : "ready", value: incomplete ? null : money.amount, exact: incomplete ? null : money.exact,
      samples: r.count, excluded: r.other, limitation: `${base.limitation} В другой валюте: ${r.other}; без суммы: ${r.missing}; с отрицательной суммой: ${r.negative}; без даты закрытия: ${r.undated}.` };
  }
  const [r] = await db.$queryRaw<Array<{ total: number; answered: number; average: number | null }>>(Prisma.sql`
    WITH incoming AS (
      SELECT m."conversationId", MIN(m."createdAt") AS at FROM "Message" m
      JOIN "Conversation" c ON c.id = m."conversationId" AND c."tenantId" = m."tenantId"
      WHERE m."tenantId" = ${goal.tenantId} AND m.direction = 'inbound' AND m."senderKind" = 'client' AND NOT m.internal AND NOT m.historical
        AND m."createdAt" >= ${goal.periodStart} AND m."createdAt" < ${goal.periodEnd} AND m."createdAt" <= ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM "Contact" p WHERE p.id = c."contactId" AND p."tenantId" = c."tenantId" AND p."archivedAt" IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM "Inquiry" i WHERE i."tenantId" = c."tenantId" AND i."conversationId" = c.id AND (i.test OR i.archived))
      GROUP BY m."conversationId"
    ), responses AS (
      SELECT i.at, o.at AS reply FROM incoming i LEFT JOIN LATERAL (
        SELECT MIN(m."createdAt") AS at FROM "Message" m WHERE m."tenantId" = ${goal.tenantId} AND m."conversationId" = i."conversationId"
          AND m.direction = 'outbound' AND m."senderKind" IN ('staff','user','manager','ai') AND NOT m.internal AND NOT m.historical
          AND m."operationState" IN ('accepted','sent','delivered','read') AND m."receiptState" <> 'failed'
          AND m."createdAt" >= i.at AND m."createdAt" <= ${cutoff} AND m."createdAt" < ${goal.periodEnd}
      ) o ON true
    ) SELECT COUNT(*)::int AS total, COUNT(reply)::int AS answered, AVG(EXTRACT(EPOCH FROM (reply - at)) / 60)::float8 AS average FROM responses`);
  const value = r.average;
  return { ...base, status: value === null ? "no_data" : "ready", value, exact: value === null ? null : String(value), samples: r.answered, unanswered: r.total - r.answered };
}
