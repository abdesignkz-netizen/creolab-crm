import type { PrismaClient } from "@creolab/db";
import { crmModeToSeller } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { digitsOnly, displayName, formatPhoneDisplay, formatWhen } from "./contactLabels.ts";
import { WAITING_FOR_LABEL, type WaitingFor } from "./conversationContextTypes.ts";
import { setConversationMode } from "./domainService.ts";
import { resolveSellerBridge, sellerHealthFor } from "./sellerLink.ts";

const LIST_LIMIT = 10;

const HANDOFF_REASON_LABEL: Record<string, string> = {
  CLIENT_REQUESTED_HUMAN: "Клиент попросил менеджера",
  LOW_CONFIDENCE: "AI не уверен",
  CUSTOM_PRICING: "Нужен индивидуальный расчёт",
  TECHNICAL_QUESTION: "Сложный технический вопрос",
  CONTRACT: "Договор",
  PAYMENT: "Оплата",
  COMPLAINT: "Жалоба",
  CONFLICT: "Конфликт",
  AI_ERROR: "Ошибка AI",
  MANUAL_TAKEOVER: "Забрано вручную",
  taken_by_human: "Забрано вручную",
  human_required: "AI не уверен",
  needs_reply: "Клиент ждёт ответа",
  escalate: "Нужно вмешательство",
  paused: "AI на паузе",
  global_ai_pause: "AI Manager на паузе",
  AI_ANALYSIS_FAILED: "Не удалось сформировать ответ",
  AI_OUTBOUND_FAILED: "Не удалось отправить сообщение",
  NO_AUTOMATED_CHANNEL: "Нет канала для ответа AI",
  OTHER: "Другое",
};

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership;
}

function asSettings(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : {};
}

export function getAiRuntimeState(settingsJson: unknown) {
  const settings = asSettings(settingsJson);
  const runtime = asSettings(settings.runtime);
  return {
    aiPaused: Boolean(runtime.aiPaused),
    pausedAt: typeof runtime.pausedAt === "string" ? runtime.pausedAt : null,
    pausedByUserId: typeof runtime.pausedByUserId === "string" ? runtime.pausedByUserId : null,
  };
}

function primaryPhoneFromMethods(
  methods?: Array<{ type: string; rawValue?: string | null; normalizedValue?: string | null; primary?: boolean }> | null,
) {
  if (!methods?.length) return null;
  const phones = methods.filter((item) => item.type === "phone");
  const primary = phones.find((item) => item.primary) || phones[0];
  if (!primary) return null;
  return primary.rawValue || formatPhoneDisplay(primary.normalizedValue) || null;
}

function phoneFromThreadId(value?: string | null) {
  if (!value) return null;
  const digits = digitsOnly(value);
  if (digits.length < 10 || digits.length > 15) return null;
  return formatPhoneDisplay(digits);
}

function resolvePhone(
  contact?: { methods?: Array<{ type: string; rawValue?: string | null; normalizedValue?: string | null; primary?: boolean }> | null } | null,
  inquiry?: { phoneRaw?: string | null; phoneNormalized?: string | null } | null,
  conversation?: { externalThreadId?: string | null } | null,
) {
  return (
    primaryPhoneFromMethods(contact?.methods) ||
    inquiry?.phoneRaw ||
    formatPhoneDisplay(inquiry?.phoneNormalized) ||
    phoneFromThreadId(conversation?.externalThreadId) ||
    null
  );
}

function waitLabel(from: Date | null | undefined, now: Date) {
  if (!from) return null;
  const mins = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60000));
  if (mins < 1) return "сейчас";
  if (mins < 60) return `${mins} мин`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

function reasonLabel(code: string | null | undefined) {
  if (!code) return "Нужно вмешательство";
  return HANDOFF_REASON_LABEL[code] || HANDOFF_REASON_LABEL.OTHER;
}

function budgetText(inquiry: { budgetMin?: number | null; budgetMax?: number | null; currency?: string | null } | null) {
  if (!inquiry) return null;
  const currency = inquiry.currency || "₸";
  if (inquiry.budgetMin != null && inquiry.budgetMax != null) {
    return `${inquiry.budgetMin.toLocaleString("ru-RU")}–${inquiry.budgetMax.toLocaleString("ru-RU")} ${currency}`;
  }
  if (inquiry.budgetMin != null) return `от ${inquiry.budgetMin.toLocaleString("ru-RU")} ${currency}`;
  if (inquiry.budgetMax != null) return `до ${inquiry.budgetMax.toLocaleString("ru-RU")} ${currency}`;
  return null;
}

async function loadOpenConversations(prisma: PrismaClient, tenantId: string) {
  return prisma.conversation.findMany({
    where: { tenantId, status: "open" },
    include: {
      contact: {
        include: {
          methods: true,
          companyContacts: { include: { company: true }, take: 1 },
        },
      },
      assignee: { include: { user: true } },
      inquiries: {
        where: { archived: false },
        orderBy: { receivedAt: "desc" },
        take: 1,
        include: { deal: { include: { stage: true } } },
      },
      messages: {
        where: { internal: false },
        orderBy: { createdAt: "desc" },
        take: 5,
      },
    },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
}

function mapConversationCard(
  item: Awaited<ReturnType<typeof loadOpenConversations>>[number],
  now: Date,
  timeZone: string,
) {
  const inquiry = item.inquiries[0] || null;
  const company = item.contact?.companyContacts?.[0]?.company || null;
  const lastMessage = item.messages[0] || null;
  const waitFrom =
    item.waitingFor === "MANAGER" || item.needsAttention
      ? lastMessage?.createdAt || item.updatedAt
      : lastMessage?.createdAt || item.updatedAt;
  const recentMessages = [...item.messages].reverse().map((m) => ({
    id: m.id,
    at: m.createdAt.toISOString(),
    atLabel: formatWhen(m.createdAt, timeZone),
    actor:
      m.senderKind === "client" || m.direction === "inbound"
        ? "Клиент"
        : m.senderKind === "ai"
          ? "AI"
          : "Менеджер",
    text: (m.text || "").slice(0, 280),
  }));

  return {
    id: item.id,
    contactId: item.contactId,
    contactName: item.contact ? displayName(item.contact) : "Клиент",
    phone: resolvePhone(item.contact, inquiry, item),
    companyName: company?.name || inquiry?.companyName || null,
    topic: inquiry?.subject || inquiry?.service || inquiry?.serviceCategory || "Диалог WhatsApp",
    budgetLabel: budgetText(inquiry),
    stageLabel: inquiry?.deal?.stage?.name || null,
    dealId: inquiry?.dealId || inquiry?.deal?.id || null,
    inquiryId: inquiry?.id || null,
    mode: item.mode,
    modeLabel: item.mode === "human" ? "HUMAN" : item.mode === "paused" ? "PAUSED" : "AI ведёт",
    waitingFor: item.waitingFor,
    waitingForLabel: WAITING_FOR_LABEL[(item.waitingFor as WaitingFor) || "NONE"] || item.waitingFor,
    needsAttention: item.needsAttention,
    attentionReason: item.attentionReason,
    reasonLabel: reasonLabel(item.attentionReason),
    summary: item.contextSummary?.slice(0, 400) || null,
    assigneeName: item.assignee?.user?.name || null,
    assigneeMembershipId: item.assigneeMembershipId,
    waitLabel: waitLabel(waitFrom, now),
    waitMinutes: waitFrom ? Math.max(0, Math.floor((now.getTime() - waitFrom.getTime()) / 60000)) : 0,
    activityLabel: waitLabel(lastMessage?.createdAt || item.updatedAt, now),
    updatedAt: item.updatedAt.toISOString(),
    sellerLeadId: item.sellerLeadId,
    recentMessages,
  };
}

export async function getManagementOverview(prisma: PrismaClient, auth: AuthContext) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const timeZone = membership.tenant.timezone || "Asia/Almaty";
  const now = new Date();

  const [tenant, seller, conversations, pendingTasks, recentAudit] = await Promise.all([
    prisma.tenant.findFirst({ where: { id: tid }, select: { settingsJson: true } }),
    sellerHealthFor(prisma, auth),
    loadOpenConversations(prisma, tid),
    prisma.task.findMany({
      where: {
        tenantId: tid,
        parentTaskId: null,
        status: { in: ["open", "waiting"] },
        OR: [
          { executionStatus: { in: ["prepared", "confirmed", "awaiting_confirm"] } },
          { commandStatus: { in: ["needs_confirmation", "prepared"] } },
        ],
      },
      include: {
        contact: { include: { methods: true } },
        inquiry: true,
        deal: true,
      },
      orderBy: { createdAt: "desc" },
      take: LIST_LIMIT,
    }),
    prisma.auditEvent.findMany({
      where: {
        tenantId: tid,
        action: {
          in: [
            "conversation.take",
            "conversation.pause",
            "conversation.return_to_ai",
            "ai_manager.pause",
            "ai_manager.resume",
          ],
        },
      },
      orderBy: { createdAt: "desc" },
      take: 15,
    }),
  ]);

  const runtime = getAiRuntimeState(tenant?.settingsJson);
  const cards = conversations.map((c) => mapConversationCard(c, now, timeZone));

  const actorIds = [...new Set(recentAudit.map((row) => row.actorUserId).filter(Boolean))] as string[];
  const actors = actorIds.length
    ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })
    : [];
  const actorById = new Map(actors.map((u) => [u.id, u.name]));

  const aiConversations = cards.filter((c) => c.mode === "ai" && !c.needsAttention);
  const humanConversations = cards.filter((c) => c.mode === "human");
  const waitingClient = cards.filter((c) => c.waitingFor === "CLIENT");
  const interventions = cards
    .filter(
      (c) =>
        (c.needsAttention && c.mode !== "human") ||
        c.waitingFor === "MANAGER" ||
        (c.mode === "ai" && c.needsAttention),
    )
    .sort((a, b) => b.waitMinutes - a.waitMinutes);
  const waitingForManager = cards
    .filter((c) => c.waitingFor === "MANAGER" || (c.needsAttention && c.mode === "ai"))
    .sort((a, b) => b.waitMinutes - a.waitMinutes);

  const problems: Array<{
    id: string;
    title: string;
    detail: string;
    conversationId?: string;
    href?: string;
  }> = [];

  if (!seller.configured) {
    problems.push({
      id: "seller-not-configured",
      title: "Один из каналов AI недоступен",
      detail: "WhatsApp AI Manager не подключён.",
      href: "/integrations",
    });
  } else if (!seller.reachable) {
    problems.push({
      id: "seller-unreachable",
      title: "AI Manager временно недоступен",
      detail: seller.note || "Мост к AI Manager не отвечает.",
      href: "/integrations",
    });
  }

  for (const c of cards) {
    if (c.attentionReason === "AI_ANALYSIS_FAILED" || c.attentionReason === "AI_OUTBOUND_FAILED") {
      problems.push({
        id: `conv-problem-${c.id}`,
        title: reasonLabel(c.attentionReason),
        detail: c.summary || c.topic,
        conversationId: c.id,
        href: `/conversations/${c.id}`,
      });
    }
  }

  const pendingApprovals = pendingTasks.map((task) => ({
    id: task.id,
    title: task.title,
    actionLabel:
      task.type === "proposal"
        ? "Отправить КП"
        : task.type === "send_documents"
          ? "Отправить документы"
          : "Подтвердить отправку",
    contactName: task.contact ? displayName(task.contact) : null,
    phone: resolvePhone(task.contact, task.inquiry),
    companyName: task.inquiry?.companyName || null,
    topic: task.inquiry?.subject || task.inquiry?.service || null,
    channel: "WhatsApp",
    executionStatus: task.executionStatus,
    commandStatus: task.commandStatus,
    href: `/tasks?open=${task.id}`,
  }));

  const aiStatusLabel = !seller.configured
    ? "Не подключён"
    : !seller.reachable
      ? "Временно недоступен"
      : runtime.aiPaused
        ? "На паузе"
        : "Активен";

  return {
    ai: {
      status: aiStatusLabel,
      statusTone: !seller.reachable || !seller.configured ? "warn" : runtime.aiPaused ? "warn" : "ok",
      paused: runtime.aiPaused,
      pausedAt: runtime.pausedAt,
      configured: seller.configured,
      reachable: seller.reachable,
      aiControlled: aiConversations.length,
      humanControlled: humanConversations.length,
      waitingClient: waitingClient.length,
      needsIntervention: interventions.length,
      pendingApprovals: pendingApprovals.length,
      problems: problems.length,
      updatedAt: now.toISOString(),
      updatedAtLabel: formatWhen(now, timeZone),
      note:
        !seller.configured || !seller.reachable
          ? "Техническая диагностика — в Интеграциях."
          : runtime.aiPaused
            ? "Автоматические ответы AI приостановлены. Входящие сообщения и заявки продолжают сохраняться."
            : "AI Manager работает нормально.",
    },
    interventions: interventions.slice(0, LIST_LIMIT),
    waitingForManager: waitingForManager.slice(0, LIST_LIMIT),
    pendingApprovals,
    aiConversations: aiConversations.slice(0, LIST_LIMIT),
    humanConversations: humanConversations.slice(0, LIST_LIMIT),
    problems: problems.slice(0, LIST_LIMIT),
    audit: recentAudit.map((row) => {
      const actorName = (row.actorUserId && actorById.get(row.actorUserId)) || "Система";
      return {
        id: row.id,
        at: row.createdAt.toISOString(),
        atLabel: formatWhen(row.createdAt, timeZone),
        action: row.action,
        actorName,
        entityId: row.entityId,
        text: auditText(row.action, actorName),
      };
    }),
    limits: { list: LIST_LIMIT },
  };
}

function auditText(action: string, actor: string) {
  if (action === "conversation.take") return `${actor} забрал диалог у AI`;
  if (action === "conversation.return_to_ai") return `${actor} передал диалог обратно AI`;
  if (action === "conversation.pause") return `${actor} поставил диалог на паузу`;
  if (action === "ai_manager.pause") return `${actor} приостановил AI Manager`;
  if (action === "ai_manager.resume") return `${actor} возобновил AI Manager`;
  return action;
}

export async function setAiManagerRuntimePause(prisma: PrismaClient, auth: AuthContext, paused: boolean) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const tenant = await prisma.tenant.findFirst({ where: { id: tid } });
  if (!tenant) throw new ApiError(404, "not_found", "Компания не найдена");

  const settings = asSettings(tenant.settingsJson);
  const runtime = {
    ...asSettings(settings.runtime),
    aiPaused: Boolean(paused),
    pausedAt: paused ? new Date().toISOString() : null,
    pausedByUserId: paused ? auth.user.id : null,
  };
  await prisma.tenant.update({
    where: { id: tid },
    data: { settingsJson: { ...settings, runtime } },
  });

  const aiConversations = await prisma.conversation.findMany({
    where: {
      tenantId: tid,
      status: "open",
      ...(paused
        ? { mode: "ai" }
        : { mode: "paused", attentionReason: "global_ai_pause" }),
    },
    select: { id: true, sellerLeadId: true, mode: true },
  });

  const resolved = await resolveSellerBridge(prisma, tid);
  let sellerSynced = 0;
  let sellerErrors = 0;

  for (const conversation of aiConversations) {
    if (paused) {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          mode: "paused",
          attentionReason: "global_ai_pause",
          needsAttention: false,
          controlVersion: { increment: 1 },
        },
      });
    } else {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          mode: "ai",
          attentionReason: null,
          needsAttention: false,
          controlVersion: { increment: 1 },
        },
      });
    }
    if (conversation.sellerLeadId && resolved.bridge) {
      try {
        await resolved.bridge.setMode(conversation.sellerLeadId, crmModeToSeller(paused ? "paused" : "ai"));
        sellerSynced += 1;
      } catch {
        sellerErrors += 1;
      }
    }
  }

  await prisma.auditEvent.create({
    data: {
      tenantId: tid,
      actorUserId: auth.user.id,
      action: paused ? "ai_manager.pause" : "ai_manager.resume",
      entityType: "tenant",
      entityId: tid,
      changesJson: {
        paused,
        conversationsTouched: aiConversations.length,
        sellerSynced,
        sellerErrors,
      },
    },
  });

  return {
    paused,
    conversationsTouched: aiConversations.length,
    sellerSynced,
    sellerErrors,
    note: paused
      ? "AI Manager приостановлен. Входящие сообщения и заявки продолжают поступать."
      : "AI Manager возобновлён. Автоответы снова по постоянным настройкам.",
  };
}

export async function claimAllAiConversations(prisma: PrismaClient, auth: AuthContext) {
  const membership = requireTenant(auth);
  const items = await prisma.conversation.findMany({
    where: { tenantId: membership.tenantId, status: "open", mode: "ai" },
    select: { id: true },
    take: 200,
  });
  let taken = 0;
  const errors: string[] = [];
  for (const item of items) {
    try {
      await setConversationMode(prisma, auth, item.id, "human");
      taken += 1;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "ошибка");
    }
  }
  return {
    total: items.length,
    taken,
    failed: errors.length,
    note: `Забрано у AI: ${taken} из ${items.length}.`,
  };
}
