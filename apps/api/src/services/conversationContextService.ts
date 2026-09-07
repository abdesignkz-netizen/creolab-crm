import type { PrismaClient } from "@creolab/db";
import { inferClientInterest } from "./contactInterestService.ts";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { refineConversationContextWithLlm } from "./llmClient.ts";
import {
  AGREEMENT_TYPE_LABEL,
  type AgreementStatus,
  type AgreementType,
  type Confidence,
  type ConversationAnalysis,
  type SuggestedAgreement,
  type WaitingFor,
  agreementTypeToTaskType,
} from "./conversationContextTypes.ts";

const ACTIVE_AGREEMENT = ["DETECTED", "NEEDS_CLARIFICATION", "CONFIRMED", "SCHEDULED", "RESCHEDULED"];

function tenantId(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership.tenantId;
}

function emptyAnalysis(): ConversationAnalysis {
  return {
    clientIntent: null,
    detectedNeed: null,
    suggestedRequestStatus: null,
    suggestedDealStage: null,
    waitingFor: "NONE",
    needsReply: false,
    agreements: [],
    suggestedTasks: [],
    suggestedNextAction: null,
    humanRequired: false,
    humanReason: null,
    summaryUpdate: null,
    evidenceMessageIds: [],
    confidence: "LOW",
    facts: {},
  };
}

function normalizeText(text: string) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function hasWord(haystack: string, needle: string) {
  return haystack.includes(needle);
}

function isConfirm(text: string) {
  const t = normalizeText(text);
  return /^(да|ок|окей|хорошо|отлично|подходит|удобно|согласен|согласна|договорились|супер|yes|ok)([!.,\s]|$)/.test(t) ||
    hasWord(t, "да, подходит") ||
    hasWord(t, "да, удобно") ||
    hasWord(t, "тогда договорились") ||
    hasWord(t, "отлично, давай");
}

function isCancel(text: string) {
  const t = normalizeText(text);
  return (
    hasWord(t, "отмен") ||
    hasWord(t, "не нужн") ||
    hasWord(t, "пока не") ||
    hasWord(t, "сам напишу") ||
    hasWord(t, "не будем встреча") ||
    hasWord(t, "не получится встрет")
  );
}

function isReschedule(text: string) {
  const t = normalizeText(text);
  return (
    hasWord(t, "перенес") ||
    hasWord(t, "давайте в") ||
    hasWord(t, "давайте на") ||
    hasWord(t, "лучше в") ||
    hasWord(t, "вместо") ||
    hasWord(t, "другой день") ||
    hasWord(t, "в пятниц") ||
    hasWord(t, "в понедельник") ||
    hasWord(t, "в вторник") ||
    hasWord(t, "в среду") ||
    hasWord(t, "в четверг") ||
    hasWord(t, "в субботу") ||
    hasWord(t, "в воскресень")
  );
}

function detectMeetingKind(corpus: string): AgreementType | null {
  if (
    hasWord(corpus, "zoom") ||
    hasWord(corpus, "google meet") ||
    hasWord(corpus, "meet.google") ||
    hasWord(corpus, "teams") ||
    hasWord(corpus, "видеозвон") ||
    hasWord(corpus, "онлайн-встреч") ||
    hasWord(corpus, "онлайн встреч") ||
    hasWord(corpus, "по meet") ||
    hasWord(corpus, "по zoom")
  ) {
    return "ONLINE_MEETING";
  }
  if (
    (hasWord(corpus, "встрет") ||
      hasWord(corpus, "приед") ||
      hasWord(corpus, "заед") ||
      hasWord(corpus, "офис") ||
      hasWord(corpus, "аль-фараби") ||
      hasWord(corpus, "лично")) &&
    !hasWord(corpus, "созвон") &&
    !hasWord(corpus, "позвон")
  ) {
    return "OFFLINE_MEETING";
  }
  if (hasWord(corpus, "созвон") || hasWord(corpus, "позвон") || hasWord(corpus, "набер") || hasWord(corpus, "по телефон") || hasWord(corpus, "call")) {
    return "CALL";
  }
  return null;
}

function detectDeliveryType(corpus: string): AgreementType | null {
  if (
    (hasWord(corpus, "кп") || hasWord(corpus, "коммерческ") || hasWord(corpus, "proposal")) &&
    (hasWord(corpus, "отправ") || hasWord(corpus, "пришлите") || hasWord(corpus, "финальн"))
  ) {
    return "SEND_PROPOSAL";
  }
  if (hasWord(corpus, "договор") || hasWord(corpus, "контракт")) {
    if (hasWord(corpus, "отправ") || hasWord(corpus, "пришл") || hasWord(corpus, "нужен")) return "SEND_CONTRACT";
  }
  if ((hasWord(corpus, "счет") || hasWord(corpus, "счёт") || hasWord(corpus, "инвойс") || hasWord(corpus, "invoice")) && (hasWord(corpus, "отправ") || hasWord(corpus, "пришл"))) {
    return "SEND_INVOICE";
  }
  if ((hasWord(corpus, "презентац") || hasWord(corpus, "документ")) && (hasWord(corpus, "отправ") || hasWord(corpus, "пришл"))) {
    return "SEND_DOCUMENTS";
  }
  if (hasWord(corpus, "оплачу") || hasWord(corpus, "оплатим") || hasWord(corpus, "переведу")) return "PAYMENT_PROMISE";
  if (
    (hasWord(corpus, "напишите") || hasWord(corpus, "вернитесь") || hasWord(corpus, "напиши мне") || hasWord(corpus, "напомните")) &&
    (hasWord(corpus, "понедельник") || hasWord(corpus, "вторник") || hasWord(corpus, "среду") || hasWord(corpus, "пятниц") || hasWord(corpus, "завтра") || hasWord(corpus, "через"))
  ) {
    return "FOLLOW_UP";
  }
  if (hasWord(corpus, "расчет") || hasWord(corpus, "расчёт") || hasWord(corpus, "смету") || hasWord(corpus, "estimate")) {
    return "PREPARE_ESTIMATE";
  }
  return null;
}

function extractUrl(text: string) {
  const m = text.match(/https?:\/\/[^\s]+/i);
  return m?.[0] || null;
}

function extractMeetProvider(corpus: string) {
  if (/zoom/.test(corpus)) return "Zoom";
  if (/meet\.google|google meet|по meet/.test(corpus)) return "Google Meet";
  if (/teams/.test(corpus)) return "Microsoft Teams";
  if (/онлайн|видео/.test(corpus)) return "Online";
  return null;
}

function extractAddress(text: string) {
  const m = text.match(/(?:на|по адресу|адрес[уа]?)\s+([А-Яа-яA-Za-z0-9\-.,\s]{5,60})/i);
  if (m) return m[1].trim().replace(/[.!?]+$/, "");
  const street = text.match(/\b([А-Яа-яA-Za-z\-]+\s+\d+[А-Яа-яA-Za-z]?)\b/);
  if (street && /фараби|абая|достык|саат|назарбаев/i.test(street[1])) return street[1];
  return null;
}

/** Parse relative/absolute datetime in tenant timezone. Returns ISO or null. */
export function parseScheduleHint(
  text: string,
  now: Date,
  timeZone: string,
): { datePart: boolean; timePart: boolean; at: Date | null; label: string | null } {
  const t = normalizeText(text);
  const timeMatch = t.match(/(?:^|[^\d])(?:в|к)\s*(\d{1,2})(?:[:.](\d{2}))?(?:[^\d]|$)/) || t.match(/(\d{1,2})[:.](\d{2})/);
  const hour = timeMatch ? Number(timeMatch[1]) : null;
  const minute = timeMatch ? Number(timeMatch[2] || "0") : null;
  const timePart = hour != null && hour >= 0 && hour <= 23;

  let dayOffset: number | null = null;
  if (hasWord(t, "сегодня")) dayOffset = 0;
  else if (hasWord(t, "завтра")) dayOffset = 1;
  else if (hasWord(t, "послезавтра")) dayOffset = 2;

  const weekdays = ["воскресень", "понедельник", "вторник", "сред", "четверг", "пятниц", "суббот"];
  if (dayOffset == null) {
    for (let i = 0; i < weekdays.length; i += 1) {
      if (hasWord(t, weekdays[i])) {
        const parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).formatToParts(now);
        const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
        const current = map[parts.find((p) => p.type === "weekday")?.value || ""] ?? now.getDay();
        let delta = (i - current + 7) % 7;
        if (delta === 0) delta = 7;
        dayOffset = delta;
        break;
      }
    }
  }

  const dm = t.match(/\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b/);
  let ymd: { y: number; m: number; d: number } | null = null;
  if (dm) {
    const d = Number(dm[1]);
    const m = Number(dm[2]);
    let y = dm[3] ? Number(dm[3]) : Number(new Intl.DateTimeFormat("en", { timeZone, year: "numeric" }).format(now));
    if (y < 100) y += 2000;
    ymd = { y, m, d };
  }

  const datePart = dayOffset != null || ymd != null;
  if (!datePart && !timePart) return { datePart: false, timePart: false, at: null, label: null };

  const baseParts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  let y = Number(baseParts.find((p) => p.type === "year")?.value);
  let m = Number(baseParts.find((p) => p.type === "month")?.value);
  let d = Number(baseParts.find((p) => p.type === "day")?.value);
  if (ymd) {
    y = ymd.y;
    m = ymd.m;
    d = ymd.d;
  } else if (dayOffset != null) {
    const utc = new Date(Date.UTC(y, m - 1, d + dayOffset));
    y = utc.getUTCFullYear();
    m = utc.getUTCMonth() + 1;
    d = utc.getUTCDate();
  }

  const hh = timePart ? hour! : 12;
  const mm = timePart ? minute! : 0;
  // Approximate local→UTC via offset probe
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm, 0));
  const asLocal = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(guess);
  const get = (type: string) => Number(asLocal.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  const at = new Date(guess.getTime() - (asUtc - guess.getTime()));

  const label = [
    datePart ? `${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}.${y}` : null,
    timePart ? `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}` : "время не указано",
  ]
    .filter(Boolean)
    .join(" · ");

  return { datePart, timePart, at: datePart ? at : null, label };
}

function windowMessages<T extends { text?: string | null; id: string }>(messages: T[], max = 24) {
  return messages.filter((m) => (m.text || "").trim()).slice(-max);
}

function ruleAnalyze(input: {
  messages: Array<{ id: string; text?: string | null; senderKind: string; direction: string; createdAt: Date }>;
  existingAgreements: Array<{ id: string; type: string; status: string; scheduledAt: Date | null }>;
  inquiryStatus?: string | null;
  dealStageKey?: string | null;
  contactName?: string | null;
  now: Date;
  timeZone: string;
}): ConversationAnalysis {
  const analysis = emptyAnalysis();
  const msgs = windowMessages(input.messages);
  if (msgs.length < 2) {
    const interest = inferClientInterest(input.messages);
    analysis.detectedNeed = interest?.text || null;
    analysis.facts.service = interest?.text || null;
    return analysis;
  }

  const corpus = msgs.map((m) => normalizeText(m.text || "")).join("\n");
  const last = msgs[msgs.length - 1];
  const lastText = normalizeText(last.text || "");
  const recentCorpus = msgs
    .slice(-8)
    .map((m) => normalizeText(m.text || ""))
    .join("\n");
  const evidenceIds = msgs.slice(-8).map((m) => m.id);

  const lastInbound = [...msgs].reverse().find((m) => m.direction === "inbound" || m.senderKind === "client");
  const lastOutbound = [...msgs].reverse().find((m) => m.direction === "outbound");

  if (lastInbound && (!lastOutbound || lastInbound.createdAt >= lastOutbound.createdAt)) {
    analysis.waitingFor = "MANAGER";
    analysis.needsReply = true;
  } else if (
    lastOutbound &&
    (hasWord(normalizeText(lastOutbound.text || ""), "ждём") ||
      hasWord(normalizeText(lastOutbound.text || ""), "ждем") ||
      hasWord(normalizeText(lastOutbound.text || ""), "напишите") ||
      hasWord(normalizeText(lastOutbound.text || ""), "дайте знать") ||
      hasWord(normalizeText(lastOutbound.text || ""), "ожида"))
  ) {
    analysis.waitingFor = "CLIENT";
    analysis.needsReply = false;
  } else if (lastOutbound) {
    analysis.waitingFor = "CLIENT";
  }

  const interest = inferClientInterest(input.messages);
  analysis.detectedNeed = interest?.text || null;
  analysis.facts.service = interest?.text || null;

  if (!input.inquiryStatus || input.inquiryStatus === "new") {
    if (msgs.length >= 3) analysis.suggestedRequestStatus = "qualification";
  }
  if (input.inquiryStatus === "qualification" || analysis.suggestedRequestStatus === "qualification") {
    if (hasWord(corpus, "понял") || hasWord(corpus, "задача ясна") || hasWord(corpus, "бюджет") || hasWord(corpus, "срок") || hasWord(corpus, "корпоративн")) {
      analysis.suggestedRequestStatus = "qualified";
    }
  }
  if (
    (hasWord(corpus, "кп") || hasWord(corpus, "коммерческ") || hasWord(corpus, "proposal")) &&
    (hasWord(corpus, "отправ") || hasWord(corpus, "выслал") || hasWord(corpus, "прислал") || hasWord(corpus, "вот кп"))
  ) {
    analysis.suggestedDealStage = "proposal_sent";
  } else if (hasWord(corpus, "условия") || hasWord(corpus, "дорого") || hasWord(corpus, "скидк") || hasWord(corpus, "торг") || hasWord(corpus, "переговор")) {
    analysis.suggestedDealStage = "negotiation";
  }

  // Never auto-suggest WON/LOST here — apply layer blocks them anyway.

  const meetingKind = detectMeetingKind(recentCorpus) || detectMeetingKind(corpus);
  const deliveryType = detectDeliveryType(recentCorpus);
  const schedule = parseScheduleHint(recentCorpus, input.now, input.timeZone);
  const confirm = isConfirm(lastText);
  const cancel = isCancel(lastText) || isCancel(recentCorpus);
  const reschedule = isReschedule(recentCorpus);

  const activeMeeting = input.existingAgreements.find(
    (a) =>
      ACTIVE_AGREEMENT.includes(a.status) &&
      (a.type === "CALL" || a.type === "ONLINE_MEETING" || a.type === "OFFLINE_MEETING"),
  );
  const activeSameDelivery = deliveryType
    ? input.existingAgreements.find((a) => ACTIVE_AGREEMENT.includes(a.status) && a.type === deliveryType)
    : null;

  if (cancel && activeMeeting) {
    analysis.agreements.push({
      action: "cancel",
      existingAgreementId: activeMeeting.id,
      type: activeMeeting.type as AgreementType,
      title: AGREEMENT_TYPE_LABEL[activeMeeting.type as AgreementType] || activeMeeting.type,
      status: "CANCELLED",
      confidence: confirm || /не нужн|отмен/.test(lastText) ? "HIGH" : "MEDIUM",
      createTask: false,
      evidenceMessageIds: evidenceIds,
    });
    analysis.waitingFor = "CLIENT";
    analysis.confidence = "HIGH";
    analysis.evidenceMessageIds = evidenceIds;
    analysis.summaryUpdate = "Клиент отменил договорённость о встрече/звонке.";
    return analysis;
  }

  if (meetingKind) {
    const url = extractUrl(recentCorpus);
    const provider = meetingKind === "ONLINE_MEETING" ? extractMeetProvider(recentCorpus) : null;
    const address = meetingKind === "OFFLINE_MEETING" ? extractAddress(recentCorpus) : null;
    const locationName =
      meetingKind === "OFFLINE_MEETING"
        ? /\b(к вам|ваш офис|у вас)\b/.test(recentCorpus)
          ? "Офис CREOLAB"
          : /\b(к нам|наш офис|у нас)\b/.test(recentCorpus)
            ? "Офис клиента"
            : address
              ? "Место встречи"
              : null
        : null;

    let status: AgreementStatus = "DETECTED";
    let confidence: Confidence = "MEDIUM";
    const missing: string[] = [];
    if (!schedule.datePart) missing.push("дата");
    if (!schedule.timePart) missing.push("время");
    if (meetingKind === "OFFLINE_MEETING" && !address && !locationName) missing.push("место");
    if (meetingKind === "ONLINE_MEETING" && !url) {
      // link missing is a preparation issue, not always clarification of the agreement itself
    }

    if (confirm && schedule.datePart && schedule.timePart) {
      status = "CONFIRMED";
      confidence = "HIGH";
    } else if (confirm && schedule.datePart && !schedule.timePart) {
      status = "NEEDS_CLARIFICATION";
      confidence = "MEDIUM";
    } else if (schedule.datePart && schedule.timePart && /давайте|предлагаю|тогда|удобно/.test(recentCorpus)) {
      status = confirm ? "CONFIRMED" : "DETECTED";
      confidence = confirm ? "HIGH" : "MEDIUM";
    } else if (!schedule.datePart && !schedule.timePart) {
      status = "NEEDS_CLARIFICATION";
      confidence = "LOW";
    } else {
      status = missing.length ? "NEEDS_CLARIFICATION" : "DETECTED";
      confidence = missing.length ? "MEDIUM" : "MEDIUM";
    }

    if (confidence === "LOW" && !confirm) {
      // soft suggestion — do not auto-create task
    }

    const name = input.contactName || "клиентом";
    const typeLabel = AGREEMENT_TYPE_LABEL[meetingKind];
    const title = `${typeLabel} с ${name}${schedule.label ? ` · ${schedule.label}` : ""}`;
    const clarificationNeeded = missing.length ? `Не указаны: ${missing.join(", ")}` : meetingKind === "ONLINE_MEETING" && !url ? "Ссылка на встречу не добавлена" : null;

    const action: SuggestedAgreement["action"] =
      activeMeeting && (reschedule || activeMeeting.type !== meetingKind)
        ? reschedule
          ? "reschedule"
          : "update"
        : activeMeeting
          ? "update"
          : "create";

    analysis.agreements.push({
      action,
      existingAgreementId: activeMeeting?.id || null,
      type: meetingKind,
      title,
      summary: clarificationNeeded || `Договорились о: ${typeLabel}`,
      purpose: analysis.detectedNeed ? `Обсудить: ${analysis.detectedNeed.slice(0, 120)}` : "Обсудить детали проекта",
      status: action === "reschedule" ? "RESCHEDULED" : status,
      scheduledAt: schedule.at?.toISOString() || null,
      locationName,
      address,
      meetingProvider: provider,
      meetingUrl: url,
      clarificationNeeded,
      confidence,
      createTask: (status === "CONFIRMED" || status === "SCHEDULED" || status === "RESCHEDULED") && confidence !== "LOW",
      taskType: agreementTypeToTaskType(meetingKind),
      evidenceMessageIds: evidenceIds,
    });

    analysis.facts.meetingDate = schedule.datePart ? schedule.label : null;
    analysis.facts.meetingTime = schedule.timePart ? schedule.label : null;
    analysis.confidence = confidence;
    analysis.suggestedNextAction = typeLabel;
    analysis.clientIntent = `Договориться о: ${typeLabel}`;
    analysis.summaryUpdate = `${typeLabel}${schedule.label ? ` на ${schedule.label}` : ""}${status === "CONFIRMED" ? " — подтверждено" : clarificationNeeded ? ` — ${clarificationNeeded}` : ""}`;
    analysis.evidenceMessageIds = evidenceIds;

    if (analysis.agreements[0].createTask) {
      analysis.suggestedTasks.push({
        type: agreementTypeToTaskType(meetingKind),
        title,
        dueAt: schedule.at?.toISOString() || null,
        purpose: analysis.agreements[0].purpose || null,
        briefingText: analysis.summaryUpdate,
        preparationHints:
          meetingKind === "ONLINE_MEETING" && !url
            ? ["Добавить ссылку на встречу", "Открыть карточку клиента", "Просмотреть заявку"]
            : ["Открыть карточку клиента", "Просмотреть заявку / сделку"],
        linkedAgreementIndex: 0,
        evidenceMessageIds: evidenceIds,
        confidence,
      });
    }
  }

  if (deliveryType && !meetingKind) {
    const schedule = parseScheduleHint(recentCorpus, input.now, input.timeZone);
    const confirmLike = confirm || /\b(отправьте|пришлите|нужно|надо)\b/.test(lastText);
    const confidence: Confidence = confirmLike && (schedule.datePart || /сегодня|завтра|до обеда/.test(recentCorpus)) ? "HIGH" : "MEDIUM";
    const status: AgreementStatus = confidence === "HIGH" ? "CONFIRMED" : schedule.datePart ? "DETECTED" : "NEEDS_CLARIFICATION";
    const title = `${AGREEMENT_TYPE_LABEL[deliveryType]}${schedule.label ? ` · ${schedule.label}` : ""}`;

    analysis.agreements.push({
      action: activeSameDelivery ? "update" : "create",
      existingAgreementId: activeSameDelivery?.id || null,
      type: deliveryType,
      title,
      summary: `Клиент/диалог: ${deliveryType}`,
      purpose: AGREEMENT_TYPE_LABEL[deliveryType],
      status,
      scheduledAt: schedule.at?.toISOString() || null,
      confidence,
      createTask: status === "CONFIRMED" || (status === "DETECTED" && confidence === "HIGH"),
      taskType: agreementTypeToTaskType(deliveryType),
      evidenceMessageIds: evidenceIds,
      clarificationNeeded: !schedule.datePart && deliveryType !== "PAYMENT_PROMISE" ? "Срок не указан точно" : null,
    });
    analysis.confidence = confidence;
    analysis.suggestedNextAction = AGREEMENT_TYPE_LABEL[deliveryType];
    analysis.evidenceMessageIds = evidenceIds;
    if (analysis.agreements[0].createTask) {
      analysis.suggestedTasks.push({
        type: agreementTypeToTaskType(deliveryType),
        title,
        dueAt: schedule.at?.toISOString() || null,
        purpose: AGREEMENT_TYPE_LABEL[deliveryType],
        briefingText: analysis.agreements[0].summary || null,
        preparationHints: ["AI рекомендует: подготовить файл перед отправкой"],
        linkedAgreementIndex: 0,
        evidenceMessageIds: evidenceIds,
        confidence,
      });
    }
  }

  if (analysis.agreements.length === 0 && analysis.needsReply) {
    analysis.suggestedNextAction = "Ответить клиенту";
    analysis.confidence = "MEDIUM";
  }

  return analysis;
}

export async function analyzeConversationContext(
  prisma: PrismaClient,
  auth: AuthContext,
  conversationId: string,
  options: { useLlm?: boolean } = {},
): Promise<{ analysis: ConversationAnalysis; conversationId: string; messageCount: number }> {
  const tid = tenantId(auth);
  const membership = auth.activeMembership!;
  const timeZone = membership.tenant.timezone || "Asia/Almaty";

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId: tid },
    include: {
      contact: true,
      messages: { orderBy: { createdAt: "asc" }, take: 80 },
      inquiries: { where: { archived: false }, orderBy: { receivedAt: "desc" }, take: 1 },
    },
  });
  if (!conversation) throw new ApiError(404, "not_found", "Диалог не найден");

  const contactId = conversation.contactId;
  const inquiry =
    conversation.inquiries[0] ||
    (contactId
      ? await prisma.inquiry.findFirst({
          where: { tenantId: tid, contactId, archived: false },
          orderBy: { receivedAt: "desc" },
        })
      : null);
  const deal = contactId
    ? await prisma.deal.findFirst({
        where: { tenantId: tid, contactId, outcome: "open" },
        include: { stage: true },
        orderBy: { updatedAt: "desc" },
      })
    : null;

  const existingAgreements = await prisma.agreement.findMany({
    where: {
      tenantId: tid,
      OR: [{ conversationId }, ...(contactId ? [{ contactId }] : [])],
      status: { in: ACTIVE_AGREEMENT },
    },
    orderBy: { updatedAt: "desc" },
    take: 20,
  });

  const activeTasks = await prisma.task.findMany({
    where: {
      tenantId: tid,
      status: { in: ["open", "waiting"] },
      OR: [{ conversationId }, ...(contactId ? [{ contactId }] : [])],
    },
    take: 20,
  });

  let analysis = ruleAnalyze({
    messages: conversation.messages,
    existingAgreements,
    inquiryStatus: inquiry?.status,
    dealStageKey: deal?.stage?.systemKey,
    contactName: conversation.contact?.name || conversation.contact?.firstName || null,
    now: new Date(),
    timeZone,
  });

  if (options.useLlm !== false) {
    const llm = await refineConversationContextWithLlm({
      messages: conversation.messages.slice(-20).map((m) => ({
        role: m.senderKind === "client" || m.direction === "inbound" ? "client" : m.senderKind === "ai" ? "ai" : "staff",
        text: m.text || "",
        at: m.createdAt.toISOString(),
        id: m.id,
      })),
      draft: analysis,
      inquiryStatus: inquiry?.status || null,
      dealStage: deal?.stage?.systemKey || null,
      openTaskTitles: activeTasks.map((t) => t.title),
      existingAgreements: existingAgreements.map((a) => ({
        id: a.id,
        type: a.type,
        status: a.status,
        scheduledAt: a.scheduledAt?.toISOString() || null,
      })),
    });
    if (llm) analysis = mergeAnalysis(analysis, llm);
  }

  return { analysis, conversationId, messageCount: conversation.messages.length };
}

function mergeAnalysis(base: ConversationAnalysis, llm: Partial<ConversationAnalysis>): ConversationAnalysis {
  return {
    ...base,
    ...llm,
    facts: { ...base.facts, ...(llm.facts || {}) },
    agreements: llm.agreements?.length ? llm.agreements : base.agreements,
    suggestedTasks: llm.suggestedTasks?.length ? llm.suggestedTasks : base.suggestedTasks,
    evidenceMessageIds: llm.evidenceMessageIds?.length ? llm.evidenceMessageIds : base.evidenceMessageIds,
  };
}

export async function listAgreementsForConversation(prisma: PrismaClient, auth: AuthContext, conversationId: string) {
  const tid = tenantId(auth);
  return prisma.agreement.findMany({
    where: { tenantId: tid, conversationId },
    include: { task: true },
    orderBy: [{ scheduledAt: "asc" }, { updatedAt: "desc" }],
    take: 30,
  });
}
