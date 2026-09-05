import type { PrismaClient } from "@creolab/db";
import { WhatsAppSellerBridge } from "@creolab/integrations";
import { ApiError } from "../errors.ts";
import { decryptSecret } from "../lib/secretBox.ts";
import type { AuthContext } from "../lib/types.ts";

export type SituationKind =
  | "needs_phone"
  | "inquiry_new"
  | "inquiry_accepted"
  | "conversation_human"
  | "conversation_paused"
  | "conversation_attention"
  | "task_overdue"
  | "task_due_today"
  | "task_unassigned_hot"
  | "contact_needs_reply"
  | "missing_next_action";

export type SituationNextAction =
  | "complete_phone"
  | "accept_inquiry"
  | "open_inquiry"
  | "take_conversation"
  | "reply_human"
  | "return_to_ai"
  | "resume_paused"
  | "complete_task"
  | "assign_owner"
  | "instruct_ai"
  | "open_contact"
  | "create_next_action";

export type SituationItem = {
  id: string;
  kind: SituationKind;
  entityId: string;
  title: string;
  reason: string;
  nextAction: SituationNextAction;
  severity: "critical" | "high" | "normal" | "low";
  ownerMembershipId: string | null;
  dueAt: string | null;
  ageMinutes: number;
  freshness: "live" | "synced" | "stale" | "unknown";
  links: {
    inquiryId?: string;
    conversationId?: string;
    taskId?: string;
    contactId?: string;
    dealId?: string;
    sellerLeadId?: string;
    incompleteIntakeId?: string;
  };
  blocked: boolean;
  snoozedUntil: string | null;
};

export type SituationScope = "all" | "mine" | "unassigned";

const PAUSED_SLA_MINUTES = 120;
const STALE_SYNC_MS = 15 * 60 * 1000;
const CONVERSATION_COMMANDS = new Set<SituationNextAction>([
  "take_conversation",
  "reply_human",
  "return_to_ai",
  "resume_paused",
  "instruct_ai",
]);

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership;
}

function ageMinutes(from: Date, now: Date) {
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60000));
}

function zonedYmd(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  return { year, month, day };
}

function isSameZonedDay(date: Date, now: Date, timeZone: string) {
  const a = zonedYmd(date, timeZone);
  const b = zonedYmd(now, timeZone);
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

function itemFreshness(args: {
  sellerLeadId?: string | null;
  configured: boolean;
  reachable: boolean;
  lastSyncAt: Date | null;
}): SituationItem["freshness"] {
  if (!args.sellerLeadId) return "unknown";
  if (!args.configured) return "unknown";
  if (!args.reachable) return "stale";
  if (!args.lastSyncAt) return "unknown";
  if (Date.now() - args.lastSyncAt.getTime() > STALE_SYNC_MS) return "stale";
  if (Date.now() - args.lastSyncAt.getTime() < 2 * 60 * 1000) return "live";
  return "synced";
}

function rankOf(item: SituationItem) {
  if (item.blocked) return 1;
  if (item.kind === "conversation_human" || item.kind === "contact_needs_reply") return 2;
  if (item.kind === "conversation_attention") return 3;
  if (item.kind === "conversation_paused" && item.ageMinutes >= PAUSED_SLA_MINUTES) return 4;
  if (item.kind === "task_overdue") return 5;
  if (item.kind === "inquiry_new" || item.kind === "missing_next_action") return 6;
  if (item.kind === "task_due_today" || item.kind === "inquiry_accepted" || item.kind === "conversation_paused") {
    return 7;
  }
  if (item.kind === "task_unassigned_hot") return 8;
  return 9;
}

function processInquiryKey(inquiryId: string) {
  return `inquiry-process:${inquiryId}`;
}

async function tenantSellerFreshness(prisma: PrismaClient, tenantId: string) {
  const integration = await prisma.integration.findFirst({
    where: { tenantId, type: "whatsapp_seller" },
  });
  const schema = (integration?.schemaJson || {}) as { sellerUrl?: string; secretEnc?: string };
  const sellerUrl = String(schema.sellerUrl || "").trim();
  const secret = schema.secretEnc ? decryptSecret(schema.secretEnc) : "";
  const configured = Boolean(sellerUrl && secret);
  const conversationCount = await prisma.conversation.count({
    where: { tenantId, sellerLeadId: { not: null } },
  });
  const lastSyncAt = integration?.lastEventAt || null;
  if (!configured) {
    return {
      configured: false,
      reachable: false,
      lastSyncAt,
      leadCountOnBot: null as number | null,
      conversationCount,
      storePathKind: null as string | null,
      warning: null as string | null,
    };
  }
  try {
    const health = await new WhatsAppSellerBridge(sellerUrl, secret).health();
    const leadCountOnBot = typeof health.leadCount === "number" ? health.leadCount : null;
    const storePathKind = health.storePathKind || null;
    let warning: string | null = null;
    if (!lastSyncAt) warning = "Ждём первый автоматический синк диалогов";
    else if (leadCountOnBot !== null && leadCountOnBot > 0 && conversationCount === 0) {
      warning = "На боте есть лиды, в CRM нет диалогов — синк ещё не подтянул";
    } else if (Date.now() - lastSyncAt.getTime() > STALE_SYNC_MS && conversationCount > 0) {
      warning = "Синк устарел — обновится автоматически";
    }
    return {
      configured: true,
      reachable: true,
      lastSyncAt,
      leadCountOnBot,
      conversationCount,
      storePathKind,
      warning,
    };
  } catch {
    return {
      configured: true,
      reachable: false,
      lastSyncAt,
      leadCountOnBot: null,
      conversationCount,
      storePathKind: null,
      warning: "Картина неполная: бот не отвечает",
    };
  }
}

export async function getSituation(
  prisma: PrismaClient,
  auth: AuthContext,
  query: { scope?: string; includeSnoozed?: string | boolean } = {},
) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const timeZone = membership.tenant.timezone || "Asia/Almaty";
  const now = new Date();
  const scope = (query.scope === "mine" || query.scope === "unassigned" ? query.scope : "all") as SituationScope;
  const includeSnoozed = query.includeSnoozed === true || query.includeSnoozed === "true";

  const [intakes, inquiries, conversations, tasks, snoozes, seller, contacts] = await Promise.all([
    prisma.incompleteIntake.findMany({
      where: { tenantId: tid, status: "pending" },
      include: { contact: true },
    }),
    prisma.inquiry.findMany({
      where: { tenantId: tid, archived: false, test: false, status: { in: ["new", "accepted", "in_progress", "waiting_client", "waiting_manager"] } },
      include: { contact: true },
    }),
    prisma.conversation.findMany({
      where: { tenantId: tid, status: "open" },
      include: { contact: true },
    }),
    prisma.task.findMany({
      where: { tenantId: tid, status: { in: ["open", "waiting"] } },
    }),
    prisma.situationSnooze.findMany({ where: { tenantId: tid } }),
    tenantSellerFreshness(prisma, tid),
    prisma.contact.findMany({
      where: { tenantId: tid, archivedAt: null },
      take: 200,
    }),
  ]);

  const snoozeByItem = new Map(snoozes.map((row) => [row.itemId, row]));
  const inquiryIds = new Set(inquiries.map((item) => item.id));
  const intakeIds = new Set(intakes.map((item) => item.id));
  const conversationOnBoard = new Set<string>();
  const items: SituationItem[] = [];

  for (const intake of intakes) {
    const raw = (intake.rawFieldsJson || {}) as { contact?: { name?: string } };
    const title = intake.contact?.name || raw.contact?.name || "Обращение без телефона";
    const task = tasks.find((row) => row.incompleteIntakeId === intake.id || row.dedupeKey === `intake-phone:${intake.id}`);
    items.push({
      id: `needs_phone:${intake.id}`,
      kind: "needs_phone",
      entityId: intake.id,
      title,
      reason: "Нет телефона — нельзя принять заявку и написать клиенту",
      nextAction: "complete_phone",
      severity: "critical",
      ownerMembershipId: intake.assigneeMembershipId,
      dueAt: null,
      ageMinutes: ageMinutes(intake.receivedAt, now),
      freshness: "unknown",
      links: {
        incompleteIntakeId: intake.id,
        contactId: intake.contactId || undefined,
        conversationId: intake.conversationId || undefined,
        taskId: task?.id,
      },
      blocked: true,
      snoozedUntil: null,
    });
  }

  for (const inquiry of inquiries) {
    if (!["new", "accepted"].includes(inquiry.status)) continue;
    const task = tasks.find((row) => row.dedupeKey === processInquiryKey(inquiry.id) || (row.type === "process_inquiry" && row.inquiryId === inquiry.id));
    const kind: SituationKind = inquiry.status === "accepted" ? "inquiry_accepted" : "inquiry_new";
    items.push({
      id: `${kind}:${inquiry.id}`,
      kind,
      entityId: inquiry.id,
      title: inquiry.subject || inquiry.contact?.name || "Заявка",
      reason: kind === "inquiry_new" ? "Новая заявка, ещё не принята" : "Принята, нет следующего шага",
      nextAction: kind === "inquiry_new" ? "accept_inquiry" : "open_inquiry",
      severity: kind === "inquiry_new" ? "high" : "normal",
      ownerMembershipId: inquiry.assigneeMembershipId,
      dueAt: task?.dueAt ? task.dueAt.toISOString() : null,
      ageMinutes: ageMinutes(inquiry.receivedAt, now),
      freshness: "unknown",
      links: {
        inquiryId: inquiry.id,
        taskId: task?.id,
        contactId: inquiry.contactId,
        conversationId: inquiry.conversationId || undefined,
        dealId: inquiry.dealId || undefined,
      },
      blocked: false,
      snoozedUntil: null,
    });
  }

  for (const conversation of conversations) {
    const attention = conversation.needsAttention && conversation.mode === "ai";
    if (conversation.mode === "ai" && !attention) continue;
    const kind: SituationKind =
      conversation.mode === "human"
        ? "conversation_human"
        : conversation.mode === "paused"
          ? "conversation_paused"
          : "conversation_attention";
    conversationOnBoard.add(conversation.id);
    const task = tasks.find((row) => row.conversationId === conversation.id && row.status !== "done");
    const nextAction: SituationNextAction =
      kind === "conversation_human" ? "reply_human" : kind === "conversation_paused" ? "resume_paused" : "take_conversation";
    items.push({
      id: `${kind}:${conversation.id}`,
      kind,
      entityId: conversation.id,
      title: conversation.contact?.name || (conversation.sellerLeadId ? "Диалог WhatsApp" : "Диалог"),
      reason:
        kind === "conversation_human"
          ? "Клиент ждёт ответ менеджера"
          : kind === "conversation_paused"
            ? "Диалог на паузе"
            : conversation.attentionReason || "ИИ эскалировал — нужен человек",
      nextAction,
      severity: kind === "conversation_human" ? "high" : kind === "conversation_attention" ? "high" : "normal",
      ownerMembershipId: conversation.assigneeMembershipId,
      dueAt: task?.dueAt ? task.dueAt.toISOString() : null,
      ageMinutes: ageMinutes(conversation.updatedAt, now),
      freshness: itemFreshness({
        sellerLeadId: conversation.sellerLeadId,
        configured: seller.configured,
        reachable: seller.reachable,
        lastSyncAt: seller.lastSyncAt,
      }),
      links: {
        conversationId: conversation.id,
        contactId: conversation.contactId || undefined,
        sellerLeadId: conversation.sellerLeadId || undefined,
        taskId: task?.id,
      },
      blocked: false,
      snoozedUntil: null,
    });
  }

  for (const task of tasks) {
    if (task.inquiryId && inquiryIds.has(task.inquiryId) && (task.dedupeKey === processInquiryKey(task.inquiryId) || task.type === "process_inquiry")) {
      continue;
    }
    if (task.incompleteIntakeId && intakeIds.has(task.incompleteIntakeId)) continue;
    if (task.dedupeKey?.startsWith("intake-phone:")) {
      const intakeId = task.dedupeKey.slice("intake-phone:".length);
      if (intakeIds.has(intakeId)) continue;
    }
    if (task.conversationId && conversationOnBoard.has(task.conversationId)) continue;

    const overdue = Boolean(task.dueAt && task.dueAt.getTime() < now.getTime());
    const dueToday = Boolean(task.dueAt && !overdue && isSameZonedDay(task.dueAt, now, timeZone));
    const waitingQuiet = task.status === "waiting" && !overdue;
    if (waitingQuiet) continue;
    const unassignedHot = !task.dueAt && task.priority === "high" && !task.ownerMembershipId && task.status === "open";
    if (!overdue && !dueToday && !unassignedHot) continue;

    const kind: SituationKind = overdue ? "task_overdue" : dueToday ? "task_due_today" : "task_unassigned_hot";
    items.push({
      id: `${kind}:${task.id}`,
      kind,
      entityId: task.id,
      title: task.title,
      reason: overdue ? "Срок прошёл" : dueToday ? "Срок сегодня" : "Высокий приоритет без ответственного",
      nextAction: unassignedHot ? "assign_owner" : "complete_task",
      severity: overdue || unassignedHot ? "high" : "normal",
      ownerMembershipId: task.ownerMembershipId,
      dueAt: task.dueAt ? task.dueAt.toISOString() : null,
      ageMinutes: ageMinutes(task.dueAt || task.createdAt, now),
      freshness: "unknown",
      links: {
        taskId: task.id,
        inquiryId: task.inquiryId || undefined,
        conversationId: task.conversationId || undefined,
        contactId: task.contactId || undefined,
        dealId: task.dealId || undefined,
      },
      blocked: false,
      snoozedUntil: null,
    });
  }

  const contactIdsOnBoard = new Set(items.map((item) => item.links.contactId).filter(Boolean));
  for (const contact of contacts) {
    const inbound = contact.lastInboundMessageAt;
    const outbound = contact.lastOutboundMessageAt;
    const waiting = Boolean(inbound && (!outbound || inbound.getTime() > outbound.getTime()));
    if (waiting && !contactIdsOnBoard.has(contact.id) && !items.some((item) => item.links.contactId === contact.id && item.kind.startsWith("conversation_"))) {
      items.push({
        id: `contact_needs_reply:${contact.id}`,
        kind: "contact_needs_reply",
        entityId: contact.id,
        title: contact.name || contact.firstName || "Клиент ждёт ответа",
        reason: `Клиент ждёт ${ageMinutes(inbound!, now)} мин`,
        nextAction: "open_contact",
        severity: "high",
        ownerMembershipId: contact.ownerMembershipId,
        dueAt: null,
        ageMinutes: ageMinutes(inbound!, now),
        freshness: "unknown",
        links: { contactId: contact.id },
        blocked: false,
        snoozedUntil: null,
      });
    }
  }

  for (const inquiry of inquiries) {
    if (!["accepted", "in_progress", "waiting_manager"].includes(inquiry.status)) continue;
    const hasTask = tasks.some(
      (task) =>
        (task.inquiryId === inquiry.id || task.contactId === inquiry.contactId) &&
        (task.status === "open" || task.status === "waiting"),
    );
    if (hasTask || inquiry.nextStep) continue;
    if (items.some((item) => item.entityId === inquiry.id || item.links.inquiryId === inquiry.id)) continue;
    items.push({
      id: `missing_next_action:${inquiry.id}`,
      kind: "missing_next_action",
      entityId: inquiry.id,
      title: inquiry.subject || inquiry.contact?.name || "Заявка без шага",
      reason: "Нет следующего действия",
      nextAction: "create_next_action",
      severity: "normal",
      ownerMembershipId: inquiry.assigneeMembershipId,
      dueAt: null,
      ageMinutes: ageMinutes(inquiry.receivedAt, now),
      freshness: "unknown",
      links: { inquiryId: inquiry.id, contactId: inquiry.contactId },
      blocked: false,
      snoozedUntil: null,
    });
  }

  const visible: SituationItem[] = [];
  for (const item of items) {
    const snooze = snoozeByItem.get(item.id);
    const active = Boolean(snooze && snooze.until.getTime() > now.getTime());
    if (active) {
      item.snoozedUntil = snooze!.until.toISOString();
      if (!includeSnoozed) continue;
    }
    if (scope === "mine" && item.ownerMembershipId !== membership.id) continue;
    if (scope === "unassigned" && item.ownerMembershipId) continue;
    visible.push(item);
  }

  visible.sort((a, b) => {
    const rank = rankOf(a) - rankOf(b);
    if (rank !== 0) return rank;
    return b.ageMinutes - a.ageMinutes;
  });

  const metrics = {
    now: visible.length,
    blocked: visible.filter((item) => item.blocked).length,
    needsHuman: visible.filter((item) => item.kind.startsWith("conversation_")).length,
    overdue: visible.filter((item) => item.kind === "task_overdue").length,
    mine: visible.filter((item) => item.ownerMembershipId === membership.id).length,
  };

  return {
    asOf: now.toISOString(),
    viewer: { membershipId: membership.id },
    freshness: {
      seller: {
        configured: seller.configured,
        reachable: seller.reachable,
        lastSyncAt: seller.lastSyncAt ? seller.lastSyncAt.toISOString() : null,
        leadCountOnBot: seller.leadCountOnBot,
        conversationCount: seller.conversationCount,
        storePathKind: seller.storePathKind,
      },
      warning: seller.warning,
    },
    metrics,
    items: visible,
  };
}

export function isConversationCommand(item: SituationItem) {
  return item.kind.startsWith("conversation_") || CONVERSATION_COMMANDS.has(item.nextAction);
}

export async function snoozeSituation(
  prisma: PrismaClient,
  auth: AuthContext,
  input: { itemId: string; until: string; reason?: string },
) {
  const membership = requireTenant(auth);
  const itemId = String(input.itemId || "").trim();
  const until = new Date(input.until);
  if (!itemId || Number.isNaN(until.getTime())) {
    throw new ApiError(422, "invalid", "Укажите строку ситуации и срок");
  }
  const kind = itemId.split(":")[0] as SituationKind;
  const maxMs = kind === "needs_phone" || kind === "inquiry_new" ? 7 * 86400000 : 30 * 86400000;
  if (until.getTime() - Date.now() > maxMs) {
    throw new ApiError(422, "snooze_forbidden", "Нельзя скрыть эту строку навсегда");
  }
  if (until.getTime() <= Date.now()) {
    throw new ApiError(422, "invalid", "Срок отложения должен быть в будущем");
  }
  const row = await prisma.situationSnooze.upsert({
    where: { tenantId_itemId: { tenantId: membership.tenantId, itemId } },
    update: { until, reason: input.reason || null, byUserId: auth.user.id },
    create: {
      tenantId: membership.tenantId,
      itemId,
      until,
      byUserId: auth.user.id,
      reason: input.reason || null,
    },
  });
  return row;
}
