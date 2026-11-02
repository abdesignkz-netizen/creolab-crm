import { createHash } from "node:crypto";
import { dealRiskAction, type DealRisk, type DealRiskCode, type DealRiskSignal } from "@creolab/contracts";
import { flagsForDeal, nextStepForDeal } from "./dealProcessPolicy.ts";
import { LEGACY_STAGE_MAP, type TenantOpsSettings } from "./dealPipeline.ts";
import { createProcessClock } from "./processCalendar.ts";

type Owner = { id: string; active: boolean; user: { name: string; status: string } } | null;
export type DealRiskInput = {
  id: string; version: number; outcome: string; nextAction: string | null; nextActionAt: Date | null;
  stageEnteredAt: Date; paymentStatus: string; stage: { systemKey: string }; assignee: Owner;
  tasks: { id: string; title: string; dueAt: Date | null; status: string; executionStatus: string; owner: Owner; contextSnapshotJson?: unknown }[];
  conversations: { conversation: { id: string; status: string; waitingFor: string; mode: string; messages: {
    id: string; direction: string; senderKind: string; createdAt: Date;
  }[] } }[];
  invoices: { id: string; status: string; dueDate: Date | null }[];
};
const iso = (d?: Date | null) => d?.toISOString() || null;
const activeOwner = (o: Owner) => Boolean(o?.active && o.user.status === "active");

/** Pure, shared rules. A read proposes work; it never changes CRM or sends a message. */
export function assessDealRisk(deal: DealRiskInput, ops: TenantOpsSettings, timeZone: string, nextStepHours: number,
  now = new Date(), access?: { taskIds: Set<string>; conversationIds: Set<string>; canCreate: boolean }): DealRisk {
  const clock = createProcessClock(ops.processCalendar, timeZone, now);
  const tasks = deal.tasks.filter(t => ["open", "in_progress", "waiting"].includes(t.status))
    .sort((a, b) => (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity) || a.id.localeCompare(b.id));
  // A completed step starts a new planning cycle. Replaying its old confirmation
  // still returns the old task, while a fresh assessment can propose a new one.
  const closedRiskTasks = deal.tasks.filter(t => ["done", "canceled"].includes(t.status)
    && Boolean((t.contextSnapshotJson as { salesRisk?: { fingerprint?: unknown } } | null)?.salesRisk?.fingerprint))
    .map(t => [t.id, t.status]).sort((a, b) => a[0].localeCompare(b[0]));
  // Contact-level timestamps can belong to another order. Only linked threads
  // supply reply evidence here; a queued/failed outbound is filtered at loading.
  const threads = deal.conversations.map(row => row.conversation).filter(c => c.status === "open");
  const messages = threads.flatMap(c => c.messages).filter(m => m.createdAt <= now);
  const latest = (direction: string) => messages.filter(m => m.direction === direction).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  const process = { ...deal, tasks, contact: { lastInboundMessageAt: latest("inbound")?.createdAt || null, lastOutboundMessageAt: latest("outbound")?.createdAt || null } };
  const flags = flagsForDeal(process, ops, now, clock), next = nextStepForDeal(process);
  const signals: DealRiskSignal[] = [];
  const add = (code: DealRiskCode, urgency: DealRiskSignal["urgency"], source: DealRiskSignal["source"] = "deal", sourceId = deal.id,
    at: Date | null = null, extra: Pick<DealRiskSignal, "thresholdDays" | "elapsedDays"> = {}) => signals.push({ code, urgency, source, sourceId, at: iso(at), ...extra });
  const waiting = threads.find(c => {
    const last = c.messages.filter(m => m.createdAt <= now)[0];
    return (c.waitingFor === "MANAGER" || c.mode === "human") && last?.direction === "inbound" && last.senderKind === "client";
  });
  const uncertain = tasks.find(t => ["failed", "unknown", "partial"].includes(t.executionStatus));
  const overdue = tasks.find(t => t.dueAt && t.dueAt < now);
  if (deal.outcome === "open") {
    if (waiting) add("reply_waiting", "urgent", "conversation", waiting.id, waiting.messages[0]?.createdAt);
    if (uncertain) add("execution_uncertain", "urgent", "task", uncertain.id, uncertain.dueAt);
    if (flags.overdueTask && overdue) add("task_overdue", "urgent", "task", overdue.id, overdue.dueAt);
    if (flags.overdueNextAction) add("step_overdue", "urgent", "deal", deal.id, deal.nextActionAt);
    if (!activeOwner(deal.assignee)) add("owner_missing", "attention");
    if (flags.noNextAction) add(next.issue === "missing_deadline" ? "deadline_missing" : "step_missing", "attention");
    if (flags.proposalWithoutReply) add("proposal_unanswered", "attention", "deal", deal.id, deal.stageEnteredAt,
      { thresholdDays: ops.proposalFollowUpThresholdDays, elapsedDays: flags.controlDaysOnStage });
    if (flags.overSla) add("stage_overdue", "attention", "deal", deal.id, deal.stageEnteredAt,
      { thresholdDays: ops.stageSlaDays[deal.stage.systemKey] ?? ops.stageSlaDays[LEGACY_STAGE_MAP[deal.stage.systemKey]] ?? undefined, elapsedDays: flags.controlDaysOnStage });
    const invoice = deal.invoices.find(i => ["ISSUED", "SENT", "PARTIALLY_PAID", "OVERDUE"].includes(i.status) && i.dueDate && i.dueDate < now);
    if (invoice) add("payment_check", "attention", "invoice", invoice.id, invoice.dueDate);
    else if (flags.paymentOverdue) add("payment_check", "attention");
  } else if (deal.outcome === "on_hold") add("on_hold", "attention");
  // Prefer a concrete blocker to the generic absence of a plan.
  const order: DealRiskCode[] = ["reply_waiting", "execution_uncertain", "task_overdue", "step_overdue", "owner_missing",
    "payment_check", "proposal_unanswered", "deadline_missing", "step_missing", "stage_overdue", "on_hold"];
  signals.sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code));
  const fingerprint = createHash("sha256").update(JSON.stringify({
    dealId: deal.id, version: deal.version, outcome: deal.outcome, nextAction: deal.nextAction, nextActionAt: iso(deal.nextActionAt),
    stage: deal.stage, stageEnteredAt: iso(deal.stageEnteredAt), owner: deal.assignee, ops, nextStepHours, timeZone,
    tasks: tasks.map(t => [t.id, t.title, t.status, iso(t.dueAt), t.executionStatus, t.owner]), closedRiskTasks,
    messages: threads.map(c => [c.id, c.waitingFor, c.mode, c.messages.map(m => m.id)]).sort(),
    signals: signals.map(s => [s.code, s.source, s.sourceId, s.at]),
  })).digest("hex");
  const primary = signals[0];
  let recommendation: DealRisk["recommendation"] = null;
  if (primary) {
    let task = primary.source === "task" ? tasks.find(t => t.id === primary.sourceId) : tasks[0];
    let kind: NonNullable<DealRisk["recommendation"]>["kind"] = "deal";
    if (primary.code === "reply_waiting") kind = "conversation";
    else if (primary.code === "owner_missing" || primary.code === "on_hold") kind = "deal";
    else if (task) kind = "task";
    else if (primary.code === "step_overdue") kind = "deal";
    else if (deal.outcome === "open" && activeOwner(deal.assignee)) kind = "create_task";
    // No hidden task identifiers, titles or owners in a manager's response.
    if (kind === "task" && access && !access.taskIds.has(task!.id)) { kind = "deal"; task = undefined; }
    if (kind === "conversation" && access && !access.conversationIds.has(primary.sourceId)) kind = "deal";
    const owner = kind === "task" ? task?.owner : deal.assignee;
    const existingDue = kind === "task" ? task?.dueAt : deal.nextActionAt;
    const dueAt = kind === "create_task" ? existingDue && existingDue > now ? existingDue : clock.afterHours(now, nextStepHours)
      : kind === "task" || primary.code === "step_overdue" ? existingDue : null;
    const titleFromRecord = kind === "task" || kind === "create_task" && Boolean(deal.nextAction?.trim());
    recommendation = {
      kind, reason: primary.code, title: kind === "task" ? task!.title : kind === "create_task" && titleFromRecord ? deal.nextAction!.trim() : dealRiskAction(primary.code), titleFromRecord,
      href: kind === "task" ? `/tasks?open=${encodeURIComponent(task!.id)}` : kind === "conversation" ? `/conversations/${encodeURIComponent(primary.sourceId)}` : `/deals/${encodeURIComponent(deal.id)}`,
      dueAt: iso(dueAt), deadlineBasis: dueAt ? existingDue?.getTime() === dueAt.getTime() ? "existing" : "suggested" : "none",
      ownerMembershipId: activeOwner(owner || null) ? owner!.id : null, ownerName: activeOwner(owner || null) ? owner!.user.name : null,
      canCreate: kind === "create_task" && Boolean(access?.canCreate),
    };
  }
  return { priority: deal.outcome === "on_hold" ? "on_hold" : signals.some(s => s.urgency === "urgent") ? "urgent" : signals.length ? "attention" : "clear",
    checkedAt: now.toISOString(), timeBasis: clock.mode, fingerprint, recommendation,
    signals: signals.map(s => access && (s.source === "task" && !access.taskIds.has(s.sourceId) || s.source === "conversation" && !access.conversationIds.has(s.sourceId))
      ? { ...s, source: "deal", sourceId: deal.id, at: null } : s) };
}
