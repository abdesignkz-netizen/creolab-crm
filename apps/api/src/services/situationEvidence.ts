import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@creolab/db";
import type { AuthContext } from "../lib/types.ts";
import { conversationAccessWhere, dealAccessWhere, inquiryAccessWhere, isManager, requireTenant, taskAccessWhere } from "../lib/access.ts";
import { needsReply } from "./contactLabels.ts";
import { OPEN_INTAKE_STATUSES } from "./inquiryAttention.ts";
import { WHATSAPP_HOME_ATTENTION_CODES } from "./whatsappChannel.ts";
import { DEAL_PROCESS_SELECT, flagsForDeal, PROCESS_OPEN_TASK_STATUSES } from "./dealProcessPolicy.ts";
import { parseOpsSettings } from "./dealPipeline.ts";
import { createProcessClock } from "./processCalendar.ts";
import { attentionTaskKind, conversationNeedsPriorityAction } from "./situationPredicates.ts";
import type { ControlNoticeCategory } from "@creolab/contracts";
import { STATUS_ONLY_ATTENTION } from "./attentionReasons.ts";

export type SituationDatabase = PrismaClient | Prisma.TransactionClient;
export type SituationEvidence = {
  itemId: string; active: boolean; evidenceKey: string; title: string; ownerMembershipId: string | null;
  noticeCategory?: ControlNoticeCategory;
  links: { contactId?: string | null; inquiryId?: string | null; conversationId?: string | null;
    dealId?: string | null; taskId?: string | null; incompleteIntakeId?: string | null };
};
const kinds = new Set(["needs_phone", "inquiry_new", "inquiry_accepted", "inquiry_ai_blocked", "missing_next_action",
  "conversation_human", "conversation_paused", "conversation_attention", "task_overdue", "task_due_today",
  "task_unassigned_hot", "contact_needs_reply", "deal-next", "deal-sla", "deal-followup", "deal-pay", "agreement", "agreement-overdue"]);
export function parseSituationId(itemId: string) {
  const match = /^([a-z_-]+):([^:]+)$/.exec(itemId);
  return match && kinds.has(match[1]) ? { kind: match[1], id: match[2] } : null;
}

/** Current source facts, independent of list truncation, snoozes and display filters.
 * Inaccessible/deleted sources are absent, never interpreted as a resolved issue. */
export async function loadSituationEvidence(db: SituationDatabase, auth: AuthContext, itemIds: string[], now = new Date()) {
  const membership = requireTenant(auth), tenantId = membership.tenantId;
  const entries = itemIds.flatMap(itemId => { const parsed = parseSituationId(itemId); return parsed ? [{ itemId, ...parsed }] : []; });
  const ids = (test: (kind: string) => boolean) => entries.filter(e => test(e.kind)).map(e => e.id);
  const tasksIds = ids(k => k.startsWith("task_")), inquiryIds = ids(k => k.startsWith("inquiry_") || k === "missing_next_action");
  const conversationIds = ids(k => k.startsWith("conversation_")), contactIds = ids(k => k === "contact_needs_reply");
  const intakeIds = ids(k => k === "needs_phone"), dealIds = ids(k => k.startsWith("deal-")), agreementIds = ids(k => k.startsWith("agreement"));
  const assignee = isManager(auth) ? { OR: [{ assigneeMembershipId: null }, { assigneeMembershipId: membership.id }] } : {};
  const [tasks, inquiries, conversations, contacts, intakes, deals, agreements, tenant] = await Promise.all([
    tasksIds.length ? db.task.findMany({ where: { AND: [taskAccessWhere(auth), { id: { in: tasksIds } }] } }) : [],
    inquiryIds.length ? db.inquiry.findMany({ where: { AND: [inquiryAccessWhere(auth), { id: { in: inquiryIds } }] },
      include: { contact: { select: { lastInboundMessageAt: true, lastOutboundMessageAt: true } } } }) : [],
    conversationIds.length ? db.conversation.findMany({ where: { AND: [conversationAccessWhere(auth), assignee, { id: { in: conversationIds } }] },
      include: { contact: { select: { lastInboundMessageAt: true, lastOutboundMessageAt: true } },
        messages: { where: { internal: false }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 } } }) : [],
    contactIds.length ? db.contact.findMany({ where: { tenantId, id: { in: contactIds }, archivedAt: null,
      ...(isManager(auth) ? { OR: [{ ownerMembershipId: null }, { ownerMembershipId: membership.id }] } : {}) } }) : [],
    intakeIds.length ? db.incompleteIntake.findMany({ where: { tenantId, id: { in: intakeIds }, ...assignee } }) : [],
    dealIds.length ? db.deal.findMany({ where: { AND: [dealAccessWhere(auth), { id: { in: dealIds } }] },
      select: { id: true, title: true, contactId: true, assigneeMembershipId: true, stageId: true, ...DEAL_PROCESS_SELECT } }) : [],
    agreementIds.length && !isManager(auth) ? db.agreement.findMany({ where: { tenantId, id: { in: agreementIds } },
      include: { task: { select: { id: true } } } }) : [],
    dealIds.length ? db.tenant.findUnique({ where: { id: tenantId }, select: { settingsJson: true, timezone: true } }) : null,
  ]);
  const relatedTasks = inquiries.length ? await db.task.findMany({ where: { tenantId, status: { in: PROCESS_OPEN_TASK_STATUSES },
    OR: [{ inquiryId: { in: inquiryIds } }, { contactId: { in: inquiries.map(row => row.contactId) } }] },
    select: { inquiryId: true, contactId: true } }) : [];
  const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map(row => [row.id, row]));
  const taskMap = byId(tasks), inquiryMap = byId(inquiries), conversationMap = byId(conversations), contactMap = byId(contacts);
  const intakeMap = byId(intakes), dealMap = byId(deals), agreementMap = byId(agreements);
  const ops = parseOpsSettings(tenant?.settingsJson), zone = tenant?.timezone || membership.tenant.timezone || "Asia/Almaty";
  const clock = createProcessClock(ops.processCalendar, zone, now);
  const result = new Map<string, SituationEvidence>();
  const put = (itemId: string, active: boolean, title: string, ownerMembershipId: string | null,
    links: SituationEvidence["links"], basis: unknown) => {
    result.set(itemId, { itemId, active, title, ownerMembershipId, links,
      evidenceKey: createHash("sha256").update(JSON.stringify(basis)).digest("hex") });
  };
  for (const { itemId, kind, id } of entries) {
    if (kind.startsWith("task_")) {
      const row = taskMap.get(id); if (!row) continue;
      put(itemId, attentionTaskKind(row, now, zone) === kind, row.title, row.ownerMembershipId,
        { taskId: id, contactId: row.contactId, inquiryId: row.inquiryId, dealId: row.dealId, conversationId: row.conversationId },
        [row.status, row.dueAt, row.priority, row.completedAt]);
    } else if (kind.startsWith("inquiry_") || kind === "missing_next_action") {
      const row = inquiryMap.get(id); if (!row) continue;
      const open = !row.archived && !row.test && !["lost", "invalid", "spam", "converted", "cancelled"].includes(row.status);
      const blocked = (WHATSAPP_HOME_ATTENTION_CODES as readonly string[]).includes(row.attentionReason || "");
      const next = Boolean(row.nextStep?.trim() || relatedTasks.some(task => task.inquiryId === id || task.contactId === row.contactId));
      const active = kind === "inquiry_new" ? row.status === "new" && !blocked : kind === "inquiry_accepted" ? row.status === "accepted" && !blocked && !next
        : kind === "inquiry_ai_blocked" ? blocked : ["in_progress", "waiting_manager"].includes(row.status) && !next && !blocked;
      put(itemId, open && active, row.subject || "Заявка", row.assigneeMembershipId,
        { inquiryId: id, contactId: row.contactId, conversationId: row.conversationId, dealId: row.dealId },
        [row.status, row.nextStep, row.attentionReason, row.contact?.lastInboundMessageAt, next]);
    } else if (kind.startsWith("conversation_")) {
      const row = conversationMap.get(id); if (!row) continue;
      const last = row.messages[0], waiting = row.contact ? needsReply(row.contact) : last?.direction === "inbound" && last?.senderKind === "client";
      const expected = row.mode === "human" ? "conversation_human" : row.mode === "paused" ? "conversation_paused" : "conversation_attention";
      put(itemId, row.status === "open" && kind === expected && conversationNeedsPriorityAction(row, Boolean(waiting), now), "Диалог требует внимания",
        row.assigneeMembershipId, { conversationId: id, contactId: row.contactId },
        [row.mode, row.attentionReason, row.needsAttention, row.contact?.lastInboundMessageAt || last?.id, waiting]);
      result.get(itemId)!.noticeCategory = row.needsAttention && row.attentionReason && !STATUS_ONLY_ATTENTION.has(row.attentionReason) ? "ai_events" : "dialogs";
    } else if (kind === "contact_needs_reply") {
      const row = contactMap.get(id); if (!row) continue;
      put(itemId, needsReply(row), row.name || "Клиент ждёт ответа", row.ownerMembershipId, { contactId: id },
        [row.lastInboundMessageAt, row.lastOutboundMessageAt]);
    } else if (kind === "needs_phone") {
      const row = intakeMap.get(id); if (!row) continue;
      put(itemId, (OPEN_INTAKE_STATUSES as readonly string[]).includes(row.status), "Обращение без телефона", row.assigneeMembershipId,
        { incompleteIntakeId: id, contactId: row.contactId }, [row.status, row.receivedAt]);
    } else if (kind.startsWith("deal-")) {
      const row = dealMap.get(id); if (!row) continue;
      const flags = flagsForDeal(row, ops, now, clock);
      const active = kind === "deal-next" ? flags.noNextAction : kind === "deal-sla" ? flags.overSla : kind === "deal-followup" ? flags.overdueNextAction : flags.paymentOverdue;
      put(itemId, Boolean(active) && row.outcome === "open", row.title, row.assigneeMembershipId, { dealId: id, contactId: row.contactId },
        [row.outcome, row.stageId, row.stageEnteredAt, row.nextAction, row.nextActionAt, row.paymentStatus,
          row.tasks.map(t => `${t.status}:${t.dueAt?.toISOString() || ""}`).sort(), row.contact?.lastInboundMessageAt]);
    } else if (kind.startsWith("agreement")) {
      const row = agreementMap.get(id); if (!row) continue;
      const active = ["DETECTED", "NEEDS_CLARIFICATION", "CONFIRMED", "SCHEDULED", "RESCHEDULED"].includes(row.status) &&
        (kind === "agreement" ? row.status === "NEEDS_CLARIFICATION" || Boolean(row.clarificationNeeded) || row.type === "ONLINE_MEETING" && !row.meetingUrl
          : Boolean(row.scheduledAt && row.scheduledAt < now && ["CONFIRMED", "SCHEDULED", "RESCHEDULED"].includes(row.status)));
      put(itemId, active, row.title, row.responsibleMembershipId,
        { contactId: row.contactId, inquiryId: row.inquiryId, dealId: row.dealId, conversationId: row.conversationId, taskId: row.task?.id },
        [row.status, row.scheduledAt, row.clarificationNeeded, row.meetingUrl]);
    }
  }
  return result;
}
