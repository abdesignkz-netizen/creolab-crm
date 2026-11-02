import { Prisma } from "@creolab/db";
import type { ExperimentMethod, ExperimentSample, ExperimentResult } from "@creolab/contracts";
import type { DomainDb } from "../lib/transaction.ts";
import { goalTaskScope } from "./businessGoalMetrics.ts";
import { sha256 } from "../lib/hash.ts";

export const EXPERIMENT_METHOD_VERSION = "proposal_first_prepared_calendar_median_v1";
export const EXPERIMENT_LIMITATIONS = [
  "Считаем календарные минуты от создания задачи типа «КП» до первой записи «Подготовка отправки». Это не рабочее время сотрудника и не подтверждение отправки или качества КП.",
  "Сравнение до/после без контрольной группы не доказывает причину изменения. Сезонность, сложность заказов и внешние изменения могут влиять на результат.",
  "Учитываются задачи выбранных сотрудников и записи CRM. Тестовые и архивные клиентские записи исключены. Не зафиксированная в CRM подготовка считается отсутствующей.",
  "Ответственный задачи определяется на дату измерения. Переназначения, изменение сложности заказов и правки вне CRM нужно отмечать как изменение условий; полную историю таких изменений система не восстанавливает.",
  "Исходная выборка сохраняется при подтверждении. Условия и порог после запуска не меняются; для другой методики создайте новую проверку.",
];
export const stableExperimentHash = (value: unknown) => sha256(JSON.stringify(value, (_key, v) => v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));

export async function measureProposalPreparation(db: DomainDb, tenantId: string, memberIds: string[], from: Date, to: Date, now: Date): Promise<ExperimentSample> {
  const asOf = new Date(Math.min(to.getTime(), now.getTime()));
  const rows = now < from ? [] : await db.$queryRaw<Array<{ id: string; createdAt: Date; ownerMembershipId: string; preparedAt: Date | null }>>(Prisma.sql`
    SELECT t.id, t."createdAt", t."ownerMembershipId", p.at AS "preparedAt" FROM "Task" t
    LEFT JOIN LATERAL (SELECT MIN(a."createdAt") AS at FROM "Activity" a
      WHERE a."tenantId" = t."tenantId" AND a.type = 'task.prepared' AND a."metadataJson"->>'taskId' = t.id
        AND a."contactId" = t."contactId" AND a."createdAt" >= t."createdAt" AND a."createdAt" < ${to} AND a."createdAt" <= ${asOf}) p ON true
    WHERE ${goalTaskScope(tenantId)} AND t.type = 'proposal' AND t."parentTaskId" IS NULL AND t."targetType" <> 'group'
      AND t."ownerMembershipId" IN (${Prisma.join(memberIds)})
      AND t."createdAt" >= ${from} AND t."createdAt" < ${to} AND t."createdAt" <= ${asOf}
    ORDER BY t."createdAt", t.id LIMIT 2001`);
  const capped = rows.length > 2000;
  const minutes = rows.flatMap(r => r.preparedAt ? [(r.preparedAt.getTime() - r.createdAt.getTime()) / 60000] : []).sort((a, b) => a - b);
  const middle = Math.floor(minutes.length / 2);
  const median = !minutes.length || capped ? null : minutes.length % 2 ? minutes[middle] : (minutes[middle - 1] + minutes[middle]) / 2;
  return { total: rows.length, prepared: minutes.length, pending: rows.length - minutes.length, capped,
    medianMinutes: median, meanMinutes: !minutes.length || capped ? null : minutes.reduce((a, b) => a + b, 0) / minutes.length,
    from: from.toISOString(), to: to.toISOString(), asOf: asOf.toISOString(), fingerprint: stableExperimentHash(rows),
    byMember: Object.fromEntries(memberIds.map(id => [id, rows.filter(r => r.ownerMembershipId === id).length])) };
}

export function compareExperiment(method: ExperimentMethod, baseline: ExperimentSample, current: ExperimentSample, end: Date, now: Date, changed: string[]): ExperimentResult {
  const reasons = [...changed];
  const distantPeriods = new Date(current.from).getTime() - new Date(baseline.to).getTime() > 14 * 86400000;
  if (distantPeriods) reasons.push("Между периодами больше двух недель. Сезонность и внешние условия снижают сравнимость.");
  const compositionChanged = baseline.total > 0 && current.total > 0 && method.memberIds.some(id =>
    Math.abs((baseline.byMember[id] || 0) / baseline.total - (current.byMember[id] || 0) / current.total) > 0.2 + 1e-9);
  if (compositionChanged) reasons.push("Распределение задач между сотрудниками изменилось больше чем на 20 процентных пунктов.");
  const short = baseline.prepared < method.minimumSample || current.prepared < method.minimumSample;
  if (short) reasons.push(`Нужно не меньше ${method.minimumSample} подготовленных КП в каждом периоде.`);
  if (baseline.pending || current.pending) reasons.push("Есть задачи без подготовки внутри своего периода. Они не исключаются ради улучшения показателя.");
  if (baseline.capped || current.capped) reasons.push("Выборка превышает 2000 задач. Сузьте группу в новой проверке; неполная выборка не оценивается.");
  if (baseline.medianMinutes === 0) reasons.push("Исходная медиана равна нулю; относительное сокращение рассчитать нельзя.");
  const reductionPercent = !baseline.capped && !current.capped && baseline.medianMinutes !== null && baseline.medianMinutes > 0 && current.medianMinutes !== null
    ? (baseline.medianMinutes - current.medianMinutes) / baseline.medianMinutes * 100 : null;
  const status: ExperimentResult["status"] = now < end ? "in_progress"
    : short || baseline.pending > 0 || current.pending > 0 || baseline.capped || current.capped || reductionPercent === null ? "insufficient_data"
    : changed.length || compositionChanged || distantPeriods ? "conditions_changed"
    : reductionPercent + 1e-9 >= method.targetReductionPercent ? "improvement_observed" : "no_improvement";
  const recommendation = ({
    in_progress: "Период ещё идёт. Это промежуточные данные, а не результат проверки.",
    insufficient_data: "Данных недостаточно. Проверьте полноту истории; для нового периода создайте новую проверку с заранее заданными условиями.",
    conditions_changed: "Сравнимость ограничена. Разберите изменения условий и повторите проверку; эффект инициативы не подтверждён.",
    improvement_observed: "Порог сокращения времени достигнут в наблюдаемых данных. Причинная связь с инициативой не доказана; проверьте качество КП и повторяемость результата перед расширением.",
    no_improvement: "Заданный порог сокращения времени не достигнут. Проверьте выполнение инициативы и причины; не меняйте исходный порог задним числом.",
  })[status];
  return { status, baseline, current, reductionPercent, reasons, recommendation, causal: false, at: now.toISOString() };
}
