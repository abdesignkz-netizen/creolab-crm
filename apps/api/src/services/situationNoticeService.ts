import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@creolab/db";
import type { ControlNoticeCategory, ControlNoticeInput } from "@creolab/contracts";
import { loadSituationEvidence, type SituationDatabase, type SituationEvidence } from "./situationEvidence.ts";
import { lockSituationEpisodes, observeSituationEvidence } from "./situationEpisodeService.ts";
import { situationWorkerAuth } from "./situationWorkerAuth.ts";
import { visibleSituationSnoozes } from "./situationSnooze.ts";

type Episode = NonNullable<Awaited<ReturnType<PrismaClient["situationEpisode"]["findFirst"]>>>;
type Rule = NonNullable<Awaited<ReturnType<PrismaClient["controlNotificationRule"]["findFirst"]>>>;
type Item = NonNullable<Awaited<ReturnType<PrismaClient["controlNotificationItem"]["findFirst"]>>>;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export const SITUATION_SOURCE_KINDS = {
  task: ["task_overdue", "task_due_today", "task_unassigned_hot"],
  inquiry: ["inquiry_new", "inquiry_ai_blocked", "inquiry_accepted", "missing_next_action"],
  conversation: ["conversation_human", "conversation_paused", "conversation_attention"],
  contact: ["contact_needs_reply"], intake: ["needs_phone"],
  deal: ["deal-next", "deal-sla", "deal-followup", "deal-pay"], agreement: ["agreement", "agreement-overdue"],
} as const;
const eventSources: Record<string, keyof typeof SITUATION_SOURCE_KINDS> = {
  "inquiry.created": "inquiry", "inquiry.available": "inquiry", "inquiry.needs_human": "inquiry", needs_phone: "intake",
  "conversation.needs_human": "conversation", "ai.needs_human": "conversation",
  "task.due": "task", "task.reminder": "task",
};
export function situationNoticePolicy(itemId: string): { category: ControlNoticeCategory; urgent: boolean } {
  const kind = itemId.split(":")[0];
  const category = kind.startsWith("task_") || kind.startsWith("agreement") ? "tasks"
    : kind.startsWith("deal-") || kind === "missing_next_action" ? "deals"
    : kind === "inquiry_ai_blocked" || kind === "conversation_human" || kind === "conversation_attention" ? "ai_events"
    : kind.startsWith("conversation_") || kind === "contact_needs_reply" ? "dialogs" : "new_inquiries";
  return { category, urgent: ["task_overdue", "agreement-overdue", "inquiry_ai_blocked", "conversation_human", "conversation_attention", "deal-pay"].includes(kind) };
}

async function contactsCoveredByDialogs(db: SituationDatabase, auth: NonNullable<Awaited<ReturnType<typeof situationWorkerAuth>>>, facts: Map<string, SituationEvidence>, now: Date) {
  const contactIds = [...facts.values()].filter(fact => fact.active && fact.itemId.startsWith("contact_needs_reply:")).map(fact => fact.links.contactId!);
  if (!contactIds.length) return new Set<string>();
  const conversations = await db.conversation.findMany({ where: { tenantId: auth.activeMembership!.tenantId, contactId: { in: contactIds }, status: "open" }, select: { id: true } });
  const dialogFacts = await loadSituationEvidence(db, auth, conversations.flatMap(row => SITUATION_SOURCE_KINDS.conversation.map(kind => `${kind}:${row.id}`)), now);
  return new Set([...dialogFacts.values()].filter(fact => fact.active).map(fact => fact.links.contactId!));
}

/** Once per real occurrence (or explicit reminder), independently of UI refreshes,
 * staff recipients, worker restarts and settings-version changes. */
export async function queueSituationNotices(db: SituationDatabase, tenantId: string, facts: Map<string, SituationEvidence>, episodes: Map<string, Episode>, now = new Date(), urgentOverride = false) {
  if (!episodes.size) return;
  const rules = await db.controlNotificationRule.findMany({ where: { tenantId, enabled: true } });
  for (const rule of rules) {
    const auth = await situationWorkerAuth(db, tenantId, rule.membershipId); if (!auth) continue;
    const reminders = await visibleSituationSnoozes(db, auth, { now, includeExpired: true, evidenceKeys: new Map([...facts].map(([id, fact]) => [id, fact.evidenceKey])) });
    const prefs = rule.settingsJson as unknown as ControlNoticeInput;
    if (!prefs.recipientConfirmed) continue;
    const covered = await contactsCoveredByDialogs(db, auth, facts, now);
    for (const [itemId, episode] of episodes) {
      const fact = facts.get(itemId); if (!fact?.active || episode.state === "resolved") continue;
      if (itemId.startsWith("contact_needs_reply:") && covered.has(fact.links.contactId!)) continue;
      // Accepted inquiries already have their own card for the same missing step.
      if (itemId.startsWith("missing_next_action:") && facts.get(itemId.replace("missing_next_action:", "inquiry_accepted:"))?.active) continue;
      const policy = situationNoticePolicy(itemId), category = fact.noticeCategory || policy.category, urgent = policy.urgent, mode = prefs.events?.[category];
      if (!mode || mode === "off") continue;
      const reminder = reminders.get(itemId);
      const applies = reminder && (!reminder.evidenceKey || reminder.evidenceKey === fact.evidenceKey);
      if (applies && reminder.until > now) continue;
      // A new incoming fact can invalidate a snooze. Its reminder key still stays
      // stable: polling/new messages must not repeatedly notify about one issue.
      const reminderKey = reminder && reminder.createdAt >= episode.firstSeenAt ? `${reminder.id}:${reminder.until.toISOString()}` : "initial";
      const eventKey = hash(`situation:${episode.id}:${episode.occurrence}:${reminderKey}`);
      await db.controlNotificationItem.upsert({ where: { ruleId_eventKey: { ruleId: rule.id, eventKey } }, update: {},
        create: { ruleId: rule.id, version: rule.version, eventKey, category, mode, urgent: urgent || urgentOverride,
          episodeId: episode.id, episodeOccurrence: episode.occurrence, createdAt: now } });
    }
  }
}

/** Existing domain events use the same episodes as the background sweep, rather
 * than enqueueing a second, unrelated notification about the same situation. */
export async function queueSituationEvent(db: SituationDatabase, input: { tenantId: string; type: string; entityId: string; priority?: string }) {
  const source = eventSources[input.type]; if (!source) return false;
  const run = async (tx: Prisma.TransactionClient) => {
    await lockSituationEpisodes(tx, input.tenantId);
    const auth = await situationWorkerAuth(tx, input.tenantId); if (!auth) return;
    const facts = await loadSituationEvidence(tx, auth, SITUATION_SOURCE_KINDS[source].map(kind => `${kind}:${input.entityId}`));
    const episodes = new Map<string, Episode>();
    for (const fact of facts.values()) {
      const episode = await observeSituationEvidence(tx, input.tenantId, fact);
      if (episode) episodes.set(fact.itemId, episode);
    }
    await queueSituationNotices(tx, input.tenantId, facts, episodes, new Date(), ["high", "urgent"].includes(input.priority || ""));
  };
  if ("$transaction" in db) await db.$transaction(run, { timeout: 30_000 }); else await run(db);
  return true;
}

/** Re-read source facts for the actual recipient. Reading/opening an in-app
 * notification is not evidence that a business situation was resolved. */
export async function retainRelevantSituationNotices(db: SituationDatabase, rule: Rule, items: Item[], now: Date) {
  const linked = items.filter(item => item.episodeId && !item.suppressedAt);
  if (!linked.length) return items.filter(item => !item.suppressedAt);
  const auth = await situationWorkerAuth(db, rule.tenantId, rule.membershipId);
  const episodes = await db.situationEpisode.findMany({ where: { tenantId: rule.tenantId, id: { in: linked.map(item => item.episodeId!) } } });
  const byId = new Map(episodes.map(row => [row.id, row]));
  const facts = auth ? await loadSituationEvidence(db, auth, episodes.map(row => row.itemId), now) : new Map<string, SituationEvidence>();
  const reminders = auth ? await visibleSituationSnoozes(db, auth, { now, evidenceKeys: new Map([...facts].map(([id, fact]) => [id, fact.evidenceKey])) }) : new Map();
  const covered = auth ? await contactsCoveredByDialogs(db, auth, facts, now) : new Set<string>();
  const rejected = new Map<string, string[]>();
  for (const item of linked) {
    const episode = byId.get(item.episodeId!), fact = episode && facts.get(episode.itemId), reminder = episode && reminders.get(episode.itemId);
    const reason = !fact ? "source_unavailable" : !fact.active || episode!.state === "resolved" ? "situation_resolved"
      : episode!.occurrence !== item.episodeOccurrence ? "situation_reopened"
      : reminder && (!reminder.evidenceKey || reminder.evidenceKey === fact.evidenceKey) ? "situation_snoozed"
      : fact.itemId.startsWith("contact_needs_reply:") && covered.has(fact.links.contactId!) ? "covered_by_dialogue" : null;
    if (reason) rejected.set(reason, [...(rejected.get(reason) || []), item.id]);
  }
  const removed = new Set([...rejected.values()].flat());
  for (const [reason, ids] of rejected) await db.controlNotificationItem.updateMany({
    where: { ruleId: rule.id, id: { in: ids }, suppressedAt: null }, data: { suppressedAt: now, suppressionReason: reason },
  });
  return items.filter(item => !item.suppressedAt && !removed.has(item.id));
}
