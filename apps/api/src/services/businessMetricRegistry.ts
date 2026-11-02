import { createHash } from "node:crypto";
import { Prisma } from "@creolab/db";
import type { BusinessInsightRule, InsightContent, InsightCoverage, SalesForecast } from "@creolab/contracts";
import type { DomainDb } from "../lib/transaction.ts";
import type { AuthContext } from "../lib/types.ts";
import { parseOpsSettings } from "./dealPipeline.ts";
import { flagsForDeal, PROCESS_OPEN_TASK_STATUSES } from "./dealProcessPolicy.ts";
import { attentionTaskKind } from "./situationPredicates.ts";
import { getCompanySalesForecast } from "./salesForecastService.ts";
import { createProcessClock } from "./processCalendar.ts";
import { OPPORTUNITY_REGISTRY, loadOpportunityEvidence } from "./opportunityRules.ts";

export type InsightKey = { rule: BusinessInsightRule; entityKind: "task" | "inquiry" | "deal" | "company"; entityId: string };
export type InsightEvidence = InsightKey & { active: boolean; available: boolean; fingerprint: string; content: InsightContent; formulaVersion: string };
export const metricKey = (key: { rule: string; entityId: string }) => `${key.rule}:${key.entityId}`;
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  return value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
}
export const evidenceHash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
export const METRIC_REGISTRY = {
  ...OPPORTUNITY_REGISTRY,
  inquiry_unhandled: { entityKind: "inquiry", formulaVersion: "new_inquiry_v1", title: "Обращение ещё не обработано", formula: "Активная нетестовая заявка имеет статус «Новая» и не отмечена как обработанная.", action: "Открыть заявку" },
  task_overdue: { entityKind: "task", formulaVersion: "attention_task_v1", title: "Срок задачи прошёл", formula: "Задача открыта, выполняется или ожидает; её срок раньше времени проверки.", action: "Проверить результат задачи" },
  deal_next_step: { entityKind: "deal", formulaVersion: "deal_next_step_v1", title: "В сделке не запланирован следующий шаг", formula: "В открытой сделке нет действия со сроком и нет открытой задачи со сроком.", action: "Указать следующий шаг" },
  proposal_delayed: { entityKind: "deal", formulaVersion: "linked_proposal_reply_v1", title: "Предложение требует проверки", formula: "Этап «Предложение отправлено» дольше установленного порога, нет будущего шага и входящего ответа в связанных диалогах после начала этапа.", action: "Проверить предложение и переписку" },
  payment_delayed: { entityKind: "deal", formulaVersion: "recorded_invoice_due_v1", title: "Нужно проверить оплату", formula: "В открытой сделке отмечена просрочка оплаты или есть выставленный неоплаченный счёт с истёкшим сроком.", action: "Сверить оплату в сделке" },
  sales_plan_risk: { entityKind: "company", formulaVersion: "median_daily_sales_v1", title: "Есть риск не выполнить план продаж", formula: "Прогноз = сумма выигранных сделок месяца + медианный дневной объём продаж завершённых месяцев × оставшиеся дни. Прогноз ниже плана.", action: "Открыть прогноз продаж" },
} as const;
const unpaid = ["ISSUED", "SENT", "PARTIALLY_PAID", "OVERDUE"];
const iso = (value: Date | null | undefined) => value?.toISOString() || null;
const brief = (value: string | null | undefined, fallback: string) => value?.trim().slice(0, 240) || fallback;

/** Forecast amounts and risk come from the shared decimal-based calculator, never from a model. */
export function planEvidence(f: SalesForecast, tenantId: string): InsightEvidence {
  const rule = "sales_plan_risk", spec = METRIC_REGISTRY[rule];
  const active = f.status === "ready" && ["below_range", "at_risk"].includes(f.target.status);
  const content: InsightContent = {
    title: spec.title, subject: `План на ${f.month}`, severity: "attention", formula: spec.formula,
    explanation: "При сохранении исторического темпа прогноз продаж ниже установленного плана.",
    limitation: "Это оценка выигранных сделок, а не поступлений денег и не обещание результата. Валюты не складываются и не конвертируются.",
    facts: [
      { label: "Выиграно с начала месяца", value: f.actual.label || "Нет данных" },
      { label: "План", value: f.target.amount.label || "Не задан" },
      { label: "Прогноз", value: f.estimate.label || "Недостаточно данных" },
      { label: "Диапазон оценки", value: f.range.low.label && f.range.high.label ? `${f.range.low.label} — ${f.range.high.label}` : "Недостаточно данных" },
      { label: "Основание", value: `${f.evidence.months} полных месяцев, ${f.evidence.sales} продаж` },
      { label: "Продажи в других валютах", value: `${f.evidence.otherCurrencySales}; в прогноз не включены` },
    ], sources: [{ label: "Продажи и план", href: "/stats?tab=sales" }], next: { label: spec.action, href: "/control?view=sales" },
    period: { from: f.from, to: f.asOf, timezone: f.timeZone, currency: f.currency },
  };
  // A date boundary changes the remaining horizon. Minute-by-minute elapsed time
  // does not erase an employee's acknowledgement while source facts are unchanged.
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: f.timeZone }).format(new Date(f.asOf));
  return { rule, entityKind: "company", entityId: tenantId, active, available: f.status === "ready", formulaVersion: spec.formulaVersion,
    fingerprint: evidenceHash({ rule, version: spec.formulaVersion, active, day, month: f.month, currency: f.currency, timezone: f.timeZone,
      history: f.history, actual: f.actual, evidence: f.evidence, target: f.target.amount, status: f.status }), content };
}

/** Loads small entity batches and bounded relation facts. No message text, prompts or credentials. */
export async function loadBusinessEvidence(db: DomainDb, auth: AuthContext, keys: InsightKey[], now: Date) {
  if (keys.length > 250) throw new Error("Business insight batch exceeds limit");
  const tenantId = auth.activeMembership!.tenantId;
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true, currency: true, settingsJson: true } });
  const timezone = tenant.timezone || "Asia/Almaty", ops = parseOpsSettings(tenant.settingsJson);
  const ids = (kind: InsightKey["entityKind"]) => [...new Set(keys.filter(k => k.entityKind === kind && !k.rule.startsWith("opportunity_")).map(k => k.entityId))];
  const dealIds = ids("deal");
  // Match financialMetrics' exclusion policy, including legacy one-direction links,
  // while reading only IDs requested in this batch.
  const excluded = dealIds.length ? await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT d.id FROM "Deal" d WHERE d."tenantId" = ${tenantId} AND d.id IN (${Prisma.join(dealIds)})
    AND EXISTS (SELECT 1 FROM "Inquiry" i WHERE i."tenantId" = d."tenantId" AND (i.id = d."inquiryId" OR i."dealId" = d.id) AND (i.test OR i.archived))`) : [];
  const allowedDealIds = dealIds.filter(id => !excluded.some(row => row.id === id));
  const [tasks, inquiries, deals, replies] = await Promise.all([
    ids("task").length ? db.task.findMany({ where: { tenantId, id: { in: ids("task") } }, select: { id: true, title: true, status: true, dueAt: true, priority: true, ownerMembershipId: true, executionStatus: true, commandStatus: true,
      inquiry: { select: { test: true, archived: true } } } }) : [],
    ids("inquiry").length ? db.inquiry.findMany({ where: { tenantId, id: { in: ids("inquiry") } }, select: { id: true, subject: true, status: true, archived: true, test: true, receivedAt: true, firstContactAt: true, closedAt: true, assigneeMembershipId: true } }) : [],
    allowedDealIds.length ? db.deal.findMany({ where: { tenantId, id: { in: allowedDealIds } }, select: { id: true, title: true, outcome: true, nextAction: true, nextActionAt: true, stageEnteredAt: true, paymentStatus: true,
      stage: { select: { systemKey: true } },
      // A maximum non-null deadline is sufficient for existence and future-plan
      // predicates; it cannot falsely infer absence from a truncated task list.
      tasks: { where: { status: { in: PROCESS_OPEN_TASK_STATUSES } }, orderBy: [{ dueAt: { sort: "desc", nulls: "last" } }, { id: "asc" }], take: 1, select: { dueAt: true, status: true } },
      invoices: { where: { status: { in: unpaid }, dueDate: { lt: now } }, orderBy: [{ dueDate: "asc" }, { id: "asc" }], take: 1, select: { id: true, number: true, dueDate: true, status: true } },
    } }) : [],
    allowedDealIds.length ? db.$queryRaw<Array<{ dealId: string; at: Date | null }>>(Prisma.sql`
      SELECT dc."dealId", MAX(m."createdAt") AS at FROM "DealConversation" dc
      JOIN "Message" m ON m."tenantId" = dc."tenantId" AND m."conversationId" = dc."conversationId"
      WHERE dc."tenantId" = ${tenantId} AND dc."dealId" IN (${Prisma.join(allowedDealIds)})
        AND m.direction = 'inbound' AND m."senderKind" = 'client' AND NOT m.internal AND m."createdAt" <= ${now}
      GROUP BY dc."dealId"`) : [],
  ]);
  const opportunityKeys = keys.filter(k => k.rule.startsWith("opportunity_"));
  const evidence = opportunityKeys.length ? await loadOpportunityEvidence(db, tenantId, opportunityKeys, timezone, now) : new Map<string, InsightEvidence>();
  let forecast: InsightCoverage["forecast"] = null;
  if (keys.some(k => k.rule === "sales_plan_risk" && k.entityId === tenantId)) {
    // Refresh tenant settings in the supplied auth as well (currency/timezone may have changed).
    const currentAuth = { ...auth, activeMembership: { ...auth.activeMembership!, tenant: { ...auth.activeMembership!.tenant, ...tenant } } };
    const f = await getCompanySalesForecast(db, currentAuth, now), fact = planEvidence(f, tenantId);
    evidence.set(metricKey(fact), fact);
    forecast = { checkedAt: now.toISOString(), status: f.status, months: f.evidence.months, sales: f.evidence.sales, otherCurrencySales: f.evidence.otherCurrencySales, targetStatus: f.target.status, timezone: f.timeZone, currency: f.currency };
  }
  for (const key of keys) {
    if (key.rule.startsWith("opportunity_")) continue;
    const spec = METRIC_REGISTRY[key.rule];
    if (!spec || spec.entityKind !== key.entityKind || key.entityKind === "company") continue;
    let active = false, available = true, basis: unknown = null;
    const href = key.entityKind === "task" ? `/tasks?open=${encodeURIComponent(key.entityId)}` : `/${key.entityKind === "inquiry" ? "requests" : "deals"}/${encodeURIComponent(key.entityId)}`;
    const content: InsightContent = { title: spec.title, subject: "", explanation: "", formula: spec.formula, severity: "attention",
      limitation: "Вывод основан на записях BasQar. Действия вне системы могут быть не отражены.", facts: [], sources: [{ label: spec.action, href }], next: { label: spec.action, href },
      period: { from: null, to: now.toISOString(), timezone, currency: null } };
    if (key.entityKind === "task") {
      const row = tasks.find(t => t.id === key.entityId); if (!row) continue;
      available = !row.inquiry?.test && !row.inquiry?.archived;
      active = attentionTaskKind(row, now, timezone) === "task_overdue";
      content.subject = brief(row.title, "Задача"); content.severity = "urgent";
      content.explanation = "Срок прошёл, а завершение задачи не зарегистрировано.";
      const statusNames: Record<string, string> = { open: "К выполнению", in_progress: "В работе", waiting: "Ожидание", done: "Завершена", canceled: "Отменена" };
      content.facts = [{ label: "Срок", value: iso(row.dueAt) || "Не задан" }, { label: "Состояние", value: statusNames[row.status] || "Нужно проверить" }];
      content.period.from = iso(row.dueAt); basis = row;
    } else if (key.entityKind === "inquiry") {
      const row = inquiries.find(i => i.id === key.entityId); if (!row) continue;
      available = !row.test && !row.archived;
      active = row.status === "new" && !row.firstContactAt && !row.closedAt;
      content.subject = brief(row.subject, "Заявка"); content.explanation = "В заявке пока не зарегистрирована первичная обработка. Проверьте, кто примет её в работу.";
      content.facts = [{ label: "Поступила", value: row.receivedAt.toISOString() }, { label: "Обработка", value: "Статус «Новая», первый контакт не зарегистрирован" }];
      content.period.from = row.receivedAt.toISOString(); basis = row;
    } else {
      const row = deals.find(d => d.id === key.entityId); if (!row) continue;
      const reply = replies.find(r => r.dealId === row.id)?.at || null;
      const flags = flagsForDeal({ ...row, contact: { lastInboundMessageAt: reply } }, ops, now, createProcessClock(ops.processCalendar, timezone, now));
      content.subject = brief(row.title, "Сделка"); content.period.from = row.stageEnteredAt.toISOString();
      if (key.rule === "deal_next_step") {
        active = row.outcome === "open" && flags.noNextAction;
        content.explanation = flags.nextActionIssue === "missing_deadline" ? "Следующее действие есть, но срок не указан." : "Не указано следующее действие со сроком и нет запланированной задачи.";
        content.facts = [{ label: "Следующий шаг", value: brief(row.nextAction, "Не указан") }, { label: "Срок шага", value: iso(row.nextActionAt) || "Не задан" }, { label: "Открытая задача со сроком", value: row.tasks[0]?.dueAt ? "Есть" : "Нет" }];
        basis = { outcome: row.outcome, title: row.title, nextAction: row.nextAction, nextActionAt: row.nextActionAt, tasks: row.tasks };
      } else if (key.rule === "proposal_delayed") {
        active = row.outcome === "open" && flags.proposalWithoutReply;
        content.explanation = "После начала этапа в связанных диалогах не зафиксирован ответ клиента. Проверьте, действительно ли предложение отправлено и нужен ли контакт.";
        content.limitation = "Это отсутствие ответа в связанных диалогах, а не доказательство отказа клиента. Факт отправки предложения проверяет сотрудник.";
        content.facts = [{ label: "Начало этапа", value: row.stageEnteredAt.toISOString() }, { label: `Порог ожидания, ${flags.timeBasis === "business" ? "рабочие" : "календарные"} дни`, value: String(ops.proposalFollowUpThresholdDays) }, { label: "Последний ответ в связанных диалогах", value: iso(reply) || "Не зарегистрирован" }];
        basis = { row: { ...row, invoices: undefined }, reply, ops };
      } else {
        active = row.outcome === "open" && (row.paymentStatus === "OVERDUE" || row.invoices.length > 0);
        const invoice = row.invoices[0];
        content.explanation = invoice ? "У неоплаченного по данным BasQar счёта прошёл срок оплаты." : "В сделке установлен статус просроченной оплаты.";
        content.limitation = "Проверьте фактические поступления. Статус счёта сам по себе не подтверждает долг или отсутствие банковского платежа.";
        content.facts = [{ label: "Основание", value: invoice ? `Счёт ${brief(invoice.number, "без номера")}` : "Статус оплаты: просрочено" }, { label: "Срок оплаты", value: iso(invoice?.dueDate) || "Не указан" }];
        basis = { title: row.title, outcome: row.outcome, paymentStatus: row.paymentStatus, invoice };
      }
    }
    evidence.set(metricKey(key), { ...key, active, available, content, formulaVersion: spec.formulaVersion,
      fingerprint: evidenceHash({ rule: key.rule, version: spec.formulaVersion, active, available, timezone, basis }) });
  }
  return { evidence, forecast, timezone, currency: tenant.currency };
}
