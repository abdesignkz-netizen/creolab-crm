import type { Prisma, PrismaClient } from "@creolab/db";
import { LEGACY_STAGE_MAP, slaStatusForDays, type TenantOpsSettings } from "./dealPipeline.ts";
import { createProcessClock, type ProcessClock } from "./processCalendar.ts";

export const PROCESS_OPEN_TASK_STATUSES = ["open", "in_progress", "waiting"];

/** All surfaces must load the same facts; never limit tasks before evaluation. */
export const DEAL_PROCESS_SELECT = {
  outcome: true, nextAction: true, nextActionAt: true, stageEnteredAt: true, paymentStatus: true,
  stage: { select: { systemKey: true } },
  tasks: { where: { status: { in: PROCESS_OPEN_TASK_STATUSES } }, select: { dueAt: true, status: true } },
  contact: { select: { lastInboundMessageAt: true, lastOutboundMessageAt: true, lastContactAt: true } },
} satisfies Prisma.DealSelect;

/** Bound relation queries as well as the number of deals. Prisma's composite
 * relation filters become too large when thousands of rows are joined at once. */
export async function loadProcessDeals(prisma: PrismaClient, tenantId: string, where: Prisma.DealWhereInput, take: number) {
  const select = { id: true, assigneeMembershipId: true, ...DEAL_PROCESS_SELECT } as const;
  const result: Prisma.DealGetPayload<{ select: typeof select }>[] = [];
  let cursor: string | undefined;
  while (result.length < take) {
    const size = Math.min(200, take - result.length);
    const page = await prisma.deal.findMany({ where: { ...where, tenantId }, select, orderBy: { id: "asc" }, take: size,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    result.push(...page);
    if (page.length < size) break;
    cursor = page.at(-1)!.id;
  }
  return result;
}

type DealProcessInput = {
  outcome?: string;
  nextAction: string | null;
  nextActionAt: Date | null;
  stageEnteredAt: Date;
  paymentStatus?: string | null;
  stage: { systemKey: string };
  tasks: Array<{ dueAt: Date | null; status: string }>;
  contact?: { lastInboundMessageAt?: Date | null; lastOutboundMessageAt?: Date | null; lastContactAt?: Date | null } | null;
};
const valid = (value: Date | null | undefined): value is Date => value instanceof Date && Number.isFinite(value.getTime());

export function nextStepForDeal(deal: Pick<DealProcessInput, "nextAction" | "nextActionAt" | "tasks">) {
  const action = Boolean(deal.nextAction?.trim());
  const tasks = deal.tasks.filter(task => PROCESS_OPEN_TASK_STATUSES.includes(task.status));
  const datedTasks = tasks.filter(task => valid(task.dueAt));
  const datedAction = action && valid(deal.nextActionAt);
  return { datedTasks, datedAction, issue: datedAction || datedTasks.length ? null
    : action || tasks.length ? "missing_deadline" as const : "missing_action" as const };
}

export function flagsForDeal(deal: DealProcessInput, ops: TenantOpsSettings, now: Date,
  clock: ProcessClock = createProcessClock(ops.processCalendar, "Asia/Almaty", now)) {
  const active = !deal.outcome || deal.outcome === "open";
  const next = nextStepForDeal(deal);
  const future = (value: Date | null) => valid(value) && value >= now;
  const hasFuturePlan = (next.datedAction && future(deal.nextActionAt)) || next.datedTasks.some(task => future(task.dueAt));
  const overdueTask = active && next.datedTasks.some(task => task.dueAt! < now);
  const overdueNextAction = active && next.datedAction && deal.nextActionAt! < now;
  const noNextAction = active && next.issue !== null;
  const waitingClient = active && Boolean(deal.nextAction && /жд[её]м|ожидаем|ожидаю|waiting/i.test(deal.nextAction));
  const stageKey = LEGACY_STAGE_MAP[deal.stage.systemKey] || deal.stage.systemKey;
  const controlDaysOnStage = clock.elapsedDays(deal.stageEnteredAt);
  const stageSla = Object.hasOwn(ops.stageSlaDays, deal.stage.systemKey)
    ? ops.stageSlaDays[deal.stage.systemKey] : ops.stageSlaDays[stageKey];
  const slaStatus = active ? slaStatusForDays(controlDaysOnStage, stageSla) : "OK";
  const overSla = slaStatus === "OVERDUE";
  const lastTouch = new Date(Math.max(deal.stageEnteredAt.getTime(), ...[
    deal.contact?.lastContactAt, deal.contact?.lastInboundMessageAt, deal.contact?.lastOutboundMessageAt,
  ].filter(valid).map(date => date.getTime())));
  const silence = active && !hasFuturePlan && clock.elapsedDays(lastTouch) > ops.silenceReturnDays;
  const idle = active && !hasFuturePlan && controlDaysOnStage > ops.stalledDealDays;
  const needsReply = active && Boolean(valid(deal.contact?.lastInboundMessageAt) &&
    (!valid(deal.contact?.lastOutboundMessageAt) || deal.contact.lastInboundMessageAt > deal.contact.lastOutboundMessageAt));
  const repliedSinceProposal = valid(deal.contact?.lastInboundMessageAt) && deal.contact.lastInboundMessageAt >= deal.stageEnteredAt;
  const proposalWithoutReply = active && stageKey === "proposal_sent" && !repliedSinceProposal && !hasFuturePlan
    && controlDaysOnStage > ops.proposalFollowUpThresholdDays;
  const stalled = active && (silence || idle || overSla || overdueNextAction || overdueTask);
  const reasons = [
    ...(overSla ? ["Просрочен срок этапа"] : []),
    ...(overdueNextAction ? ["Просрочено следующее действие"] : []),
    ...(overdueTask ? ["Просрочена связанная задача"] : []),
    ...(noNextAction ? [next.issue === "missing_deadline" ? "Не указан срок следующего шага" : "Нет следующего действия"] : []),
    ...(proposalWithoutReply ? ["Предложение осталось без ответа"] : []),
    ...(silence ? ["Превышен срок без контакта с клиентом"] : []),
    ...(idle ? ["Превышен срок без продвижения по сделке"] : []),
  ];
  return { proposalWithoutReply, needsReply, overdueTask, noNextAction, waitingClient, stalled, overSla, slaStatus,
    overdueNextAction, paymentOverdue: deal.paymentStatus === "OVERDUE",
    daysOnStage: Math.max(0, Math.floor((now.getTime() - deal.stageEnteredAt.getTime()) / 86_400_000)),
    controlDaysOnStage, timeBasis: clock.mode, nextActionIssue: active ? next.issue : null, reasons };
}
