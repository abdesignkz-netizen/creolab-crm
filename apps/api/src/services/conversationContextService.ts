import type { Prisma, PrismaClient } from "@creolab/db";
import { inferClientInterest } from "./contactInterestService.ts";
import { assertConversationReachable } from "../lib/access.ts";
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
import { listThreadConversationIds } from "./conversationThread.ts";

import { normalizeCompanyTimezone } from "./aiAutomationSettings.ts";
import { validateConversationRefinement } from "./conversationAnalysisValidation.ts";

const ACTIVE_AGREEMENT = ["DETECTED", "NEEDS_CLARIFICATION", "CONFIRMED", "SCHEDULED", "RESCHEDULED"];

function tenantId(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership.tenantId;
}

type SituationAttachment = {
  fileName?: string | null;
  originalFileName?: string | null;
  documentType?: string | null;
  mimeType?: string | null;
};

export type SituationMessage = {
  id?: string;
  text?: string | null;
  senderKind: string;
  direction: string;
  internal?: boolean;
  type?: string | null;
  createdAt?: Date;
  attachments?: SituationAttachment[];
};

function messageHaystack(message: SituationMessage) {
  const files = (message.attachments || [])
    .map((item) => `${item.originalFileName || ""} ${item.fileName || ""} ${item.documentType || ""}`)
    .join(" ");
  return normalizeText(`${message.text || ""} ${message.type || ""} ${files}`);
}

function isOutbound(message: SituationMessage) {
  return message.direction === "outbound" || message.senderKind === "staff" || message.senderKind === "ai";
}

function isInboundClient(message: SituationMessage) {
  return message.direction === "inbound" || message.senderKind === "client";
}

export function isCommercialOfferText(text: string) {
  return /(?:^|[^a-zа-яё0-9])кп(?:[^a-zа-яё0-9]|$)|коммерческ|proposal|\boffer\b|питч[- ]?дек/i.test(text);
}

export function isPriceOfferText(text: string) {
  return /(прайс|стоимост|расценк|смет[ауы]|тариф|цен[аыуе]\s*:|\d[\d\s]{0,12}(тг|тенге|₸|kzt))/.test(text);
}

export function isWaitingManagementText(text: string) {
  return /(руководств|директор|начальств|у руководителя|их руковод|они решают|на согласован|согласу(ем|ют)|передал[аи].{0,40}(руковод|директор|начальн)|направил[аи].{0,40}(руковод|директор)|отправил[аи].{0,40}(руковод|директор)|вынесл[аи].{0,24}(на рассмотрен|руковод)|рассматрива(ет|ют)|ждут решения|решают кого|на рассмотрен)/.test(
    text,
  );
}

export function detectSituationFacts(messages: SituationMessage[]) {
  let proposalSent = false;
  let pricesSent = false;
  let waitingForManagement = false;
  for (const message of messages) {
    if (message.internal) continue;
    const text = messageHaystack(message);
    if (isOutbound(message) && isCommercialOfferText(text)) proposalSent = true;
    if (isOutbound(message) && isPriceOfferText(text)) pricesSent = true;
    if (isInboundClient(message) && isWaitingManagementText(text)) waitingForManagement = true;
  }
  return { proposalSent, pricesSent, waitingForManagement };
}

export function enrichSituationSummary(analysis: ConversationAnalysis, messages: SituationMessage[]) {
  const facts = detectSituationFacts(messages);
  analysis.facts = {
    ...analysis.facts,
    proposalSent: Boolean(analysis.facts.proposalSent || facts.proposalSent),
    pricesSent: Boolean(analysis.facts.pricesSent || facts.pricesSent),
    waitingForManagement: Boolean(analysis.facts.waitingForManagement || facts.waitingForManagement),
  };
  const proposalSent = Boolean(analysis.facts.proposalSent);
  const pricesSent = Boolean(analysis.facts.pricesSent);
  const waitingForManagement = Boolean(analysis.facts.waitingForManagement);

  if (waitingForManagement) {
    const last = [...messages].reverse().find((item) => !item.internal);
    const lastIsClient = last ? isInboundClient(last) : false;
    const lastHolds = lastIsClient && isWaitingManagementText(messageHaystack(last!));
    if (!lastIsClient || lastHolds) {
      analysis.waitingFor = "CLIENT";
      analysis.needsReply = false;
      if (!analysis.suggestedNextAction || analysis.suggestedNextAction === "Ответить клиенту") {
        analysis.suggestedNextAction = "Дождаться решения руководства";
      }
    }
  }
  if (proposalSent && !analysis.suggestedDealStage) analysis.suggestedDealStage = "proposal_sent";

  const existing = String(analysis.summaryUpdate || "").replace(/\s+/g, " ").trim();
  const need = String(analysis.detectedNeed || "")
    .replace(/\s+/g, " ")
    .trim();
  const offerLine = proposalSent ? (pricesSent ? "КП и цены высланы." : "КП выслано.") : pricesSent ? "Цены отправлены." : "";
  const waitLine = waitingForManagement
    ? "Ждём ответа руководства клиента."
    : analysis.waitingFor === "MANAGER"
      ? "Клиент ждёт ответа."
      : analysis.waitingFor === "CLIENT"
        ? "Ждём ответа клиента."
        : "";
  const openAgreements = analysis.agreements.filter((item) => item.status !== "COMPLETED" && item.status !== "CANCELLED");
  const agrLine = openAgreements.length
    ? `Договорённости: ${openAgreements.map((item) => item.title || AGREEMENT_TYPE_LABEL[item.type] || item.type).join(", ")}.`
    : proposalSent || pricesSent
      ? ""
      : "Явных договорённостей пока нет.";

  if (!existing) {
    const visible = messages.filter((item) => !item.internal && (messageHaystack(item) || "").trim());
    if (!visible.length) {
      analysis.summaryUpdate = "В диалоге нет сообщений — потребность и договорённости выделить нельзя.";
      analysis.confidence = "LOW";
      return;
    }
    analysis.summaryUpdate = [
      need ? `Потребность: ${need.replace(/\.$/, "")}.` : "Потребность по тексту пока неясна.",
      offerLine,
      waitLine,
      agrLine,
    ]
      .filter(Boolean)
      .join(" ");
    return;
  }

  const extras: string[] = [];
  if (need && !existing.includes(need.slice(0, Math.min(24, need.length))) && !/потребност/i.test(existing)) {
    extras.unshift(`Потребность: ${need.replace(/\.$/, "")}.`);
  }
  if (offerLine && !/кп высл|кп и цены|цен[аы].{0,16}(высл|отправ)|стоимост.{0,16}(высл|отправ)|коммерческ.{0,24}(высл|отправ|направ)/i.test(existing)) {
    extras.push(offerLine);
  }
  if (waitingForManagement && !/руководств|директор|решен/i.test(existing)) {
    extras.push(waitLine);
  }
  let next = extras.length ? `${extras.join(" ")} ${existing}`.replace(/\s+/g, " ").trim() : existing;
  if (proposalSent || pricesSent) {
    next = next.replace(/\s*Явных договорённостей пока нет\.?/gi, "").trim();
  }
  if (waitingForManagement) {
    next = next.replace(/\s*(Клиент ждёт ответа|Ждём ответа клиента)\.?/gi, "").trim();
    if (!/руководств|директор|решен/i.test(next)) next = `${next} ${waitLine}`.trim();
  }
  analysis.summaryUpdate = next;
}

function fillFallbackSummary(analysis: ConversationAnalysis, messages: SituationMessage[]) {
  enrichSituationSummary(analysis, messages);
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
  timeZone = normalizeCompanyTimezone(timeZone);
  const localParts = (date: Date) => {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date);
    const get = (key: string) => Number(parts.find(p => p.type === key)?.value);
    return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), min: get("minute"), sec: get("second") };
  };
  const base = localParts(now);
  const time = t.match(/(?:^|[^\d])(\d{1,2}):(\d{2})(?!\d)/)
    || t.match(/(?:^|\s)(?:в|к)\s+(\d{1,2})(?:[.]([0-5]\d))?(?![\d/]|\s*(?:сент|окт|нояб|дек|янв|фев|март|апрел|мая|июн|июл|авг))/);
  const hour = time ? Number(time[1]) : -1;
  const minute = time ? Number(time[2] || 0) : -1;
  const approximate = /примерно|около|после обеда|утром|вечером/.test(t);
  const timePart = Boolean(time && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && !approximate);
  let offset: number | null = null;
  if (t.includes("послезавтра")) offset = 2;
  else if (t.includes("завтра")) offset = 1;
  else if (t.includes("сегодня")) offset = 0;
  const relative = t.match(/через\s+(\d+|один|два|две|три|четыре|пять|неделю)\s*(?:дн|день|сут|$)/);
  if (relative) offset = ({ один: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, неделю: 7 } as Record<string, number>)[relative[1]] ?? Number(relative[1]);
  const weekdays = ["воскресень", "понедельник", "вторник", "среду", "четверг", "пятниц", "суббот"];
  if (offset == null) {
    const weekday = weekdays.findIndex(day => t.includes(day));
    if (weekday >= 0) {
      const current = new Date(Date.UTC(base.y, base.m - 1, base.d)).getUTCDay();
      offset = (weekday - current + 7) % 7;
      if (offset === 0 && (!timePart || hour * 60 + minute <= base.h * 60 + base.min || /следующ/.test(t))) offset = 7;
    }
  }
  const months = ["январ", "феврал", "март", "апрел", "мая", "июн", "июл", "август", "сентябр", "октябр", "ноябр", "декабр"];
  const named = t.match(/(?:^|[^\d])(\d{1,2})\s+(январ\S*|феврал\S*|март\S*|апрел\S*|мая|июн\S*|июл\S*|август\S*|сентябр\S*|октябр\S*|ноябр\S*|декабр\S*)(?:\s+(\d{4}))?/);
  const numeric = t.match(/(?:^|[^\d:])(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?![\d:])/);
  // A dotted time following «в» is not a calendar date.
  const dm = named || (numeric && !new RegExp(`(?:в|к)\\s+${numeric[1]}[.]${numeric[2]}`).test(t) ? numeric : null);
  let y = base.y, m = base.m, d = base.d;
  if (dm) {
    d = Number(dm[1]); m = named ? months.findIndex(month => dm[2].startsWith(month)) + 1 : Number(dm[2]);
    y = dm[3] ? Number(dm[3]) : base.y;
    if (y < 100) y += 2000;
  } else if (offset != null) {
    const date = new Date(Date.UTC(y, m - 1, d + offset));
    y = date.getUTCFullYear(); m = date.getUTCMonth() + 1; d = date.getUTCDate();
  }
  const validDate = new Date(Date.UTC(y, m - 1, d));
  const datePart = Boolean((dm || offset != null) && validDate.getUTCFullYear() === y && validDate.getUTCMonth() === m - 1 && validDate.getUTCDate() === d);
  const label = datePart ? `${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}.${y} · ${timePart ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` : "время не указано"}` : null;
  if (!datePart || !timePart) return { datePart, timePart, at: null, label };
  const target = Date.UTC(y, m - 1, d, hour, minute);
  let instant = target;
  for (let i = 0; i < 3; i++) {
    const local = localParts(new Date(instant));
    instant += target - Date.UTC(local.y, local.m - 1, local.d, local.h, local.min, local.sec);
  }
  const check = localParts(new Date(instant));
  const valid = check.y === y && check.m === m && check.d === d && check.h === hour && check.min === minute;
  return { datePart, timePart, at: valid ? new Date(instant) : null, label };

}

function windowMessages<T extends { text?: string | null; type?: string | null; attachments?: SituationAttachment[] }>(
  messages: T[],
  max = 40,
) {
  return messages
    .filter((m) => (m.text || "").trim() || (m.attachments && m.attachments.length) || (m.type && m.type !== "text"))
    .slice(-max);
}

export function ruleAnalyze(input: {
  messages: Array<
    SituationMessage & {
      id: string;
      createdAt: Date;
    }
  >;
  existingAgreements: Array<{ id: string; type: string; status: string; scheduledAt: Date | null }>;
  inquiryStatus?: string | null;
  dealStageKey?: string | null;
  contactName?: string | null;
  now: Date;
  timeZone: string;
}): ConversationAnalysis {
  const analysis = emptyAnalysis();
  const situation = detectSituationFacts(input.messages);
  analysis.facts.proposalSent = situation.proposalSent;
  analysis.facts.pricesSent = situation.pricesSent;
  analysis.facts.waitingForManagement = situation.waitingForManagement;
  const msgs = windowMessages(input.messages);
  if (msgs.length === 0) {
    const interest = inferClientInterest(input.messages);
    analysis.detectedNeed = interest?.text || null;
    analysis.facts.service = interest?.text || null;
    fillFallbackSummary(analysis, input.messages);
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
    if (isWaitingManagementText(messageHaystack(lastInbound))) {
      analysis.waitingFor = "CLIENT";
      analysis.needsReply = false;
      analysis.suggestedNextAction = "Дождаться решения руководства";
    } else {
      analysis.waitingFor = "MANAGER";
      analysis.needsReply = true;
    }
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

  if (situation.waitingForManagement) {
    const lastInboundHold = Boolean(lastInbound && isWaitingManagementText(messageHaystack(lastInbound)));
    const lastIsOutbound = Boolean(last && isOutbound(last));
    if (lastIsOutbound || lastInboundHold || analysis.waitingFor !== "MANAGER") {
      analysis.waitingFor = "CLIENT";
      analysis.needsReply = false;
      if (!analysis.suggestedNextAction || analysis.suggestedNextAction === "Ответить клиенту") {
        analysis.suggestedNextAction = "Дождаться решения руководства";
      }
    }
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
    situation.proposalSent ||
    ((hasWord(corpus, "кп") || hasWord(corpus, "коммерческ") || hasWord(corpus, "proposal")) &&
      (hasWord(corpus, "отправ") || hasWord(corpus, "выслал") || hasWord(corpus, "прислал") || hasWord(corpus, "вот кп")))
  ) {
    analysis.suggestedDealStage = "proposal_sent";
  } else if (hasWord(corpus, "условия") || hasWord(corpus, "дорого") || hasWord(corpus, "скидк") || hasWord(corpus, "торг") || hasWord(corpus, "переговор")) {
    analysis.suggestedDealStage = "negotiation";
  }

  // Never auto-suggest WON/LOST here — apply layer blocks them anyway.

  const meetingKind = detectMeetingKind(lastText) || ((isConfirm(lastText) || parseScheduleHint(lastText, last.createdAt, input.timeZone).datePart) ? detectMeetingKind(msgs.at(-2)?.text?.toLowerCase() || "") || (parseScheduleHint(lastText, last.createdAt, input.timeZone).datePart ? input.existingAgreements.find(a => ["CALL", "ONLINE_MEETING", "OFFLINE_MEETING"].includes(a.type))?.type as AgreementType || null : null) : null);
  const deliveryType = detectDeliveryType(lastText);
  const scheduleSource = parseScheduleHint(lastText, last.createdAt, input.timeZone).datePart
    ? last : isConfirm(lastText) ? msgs.at(-2) || last : last;
  const schedule = parseScheduleHint(scheduleSource.text || "", scheduleSource.createdAt, input.timeZone);
  const confirm = isConfirm(lastText) || (isInboundClient(last) && /давайте|встречаемся|приезжайте/.test(lastText));
  const cancel = isCancel(lastText);
  const reschedule = /перенес|лучше|вместо|другой день/.test(lastText);

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
          ? "Офис компании"
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
      createTask: (status === "CONFIRMED" || action === "reschedule") && confidence !== "LOW",
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

  if (deliveryType && !meetingKind && !(deliveryType === "SEND_PROPOSAL" && situation.proposalSent)) {
    const schedule = parseScheduleHint(lastText, last.createdAt, input.timeZone);
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

  if (analysis.agreements.length === 0 && analysis.needsReply && !situation.waitingForManagement) {
    analysis.suggestedNextAction = "Ответить клиенту";
    analysis.confidence = "MEDIUM";
  }

  fillFallbackSummary(analysis, input.messages);
  if (analysis.suggestedDealStage === "proposal_sent" && !(isOutbound(last) && isCommercialOfferText(lastText))) analysis.suggestedDealStage = null;
  return analysis;
}

export async function analyzeConversationContext(
  prisma: PrismaClient,
  auth: AuthContext,
  conversationId: string,
  options: { useLlm?: boolean; sourceMessageId?: string } = {},
): Promise<{ analysis: ConversationAnalysis; conversationId: string; messageCount: number; llmUsed: boolean; sourceMessageId: string | null; sourceMessageAt: Date | null; messageRevision: number; snapshot: { deal: { id: string; version: number; updatedAt: Date } | null; inquiry: { id: string; status: string; nextStep: string | null; aiSummary: string | null; needsReply: boolean } | null; contactSummary: string | null; agreements: Array<{ id: string; updatedAt: Date }> } }> {
  const tid = tenantId(auth);
  await assertConversationReachable(prisma, auth, conversationId);
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tid } });
  const timeZone = normalizeCompanyTimezone(tenant.timezone);

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId: tid },
    include: {
      contact: { include: { methods: { where: { type: "phone" }, take: 5 } } },
      inquiries: { where: { archived: false }, orderBy: { receivedAt: "desc" }, take: 1 },
    },
  });
  if (!conversation) throw new ApiError(404, "not_found", "Диалог не найден");

  const phone =
    conversation.contact?.methods.find((item) => item.primary)?.normalizedValue ||
    conversation.contact?.methods[0]?.normalizedValue ||
    conversation.externalThreadId;
  const threadIds = await listThreadConversationIds(prisma, tid, conversation, phone);
  const source = options.sourceMessageId ? await prisma.message.findFirst({ where: { tenantId: tid, conversationId: { in: threadIds }, id: options.sourceMessageId, internal: false } }) : null;
  if (options.sourceMessageId && !source) throw new ApiError(404, "not_found", "Сообщение не найдено");
  const messages = await prisma.message.findMany({
    where: { tenantId: tid, conversationId: { in: threadIds }, ...(source ? { OR: [{ createdAt: { lt: source.createdAt } }, { createdAt: source.createdAt, id: { lte: source.id } }] } : {}), internal: false, operationState: { notIn: ["queued", "failed", "unknown"] } },
    include: { attachments: { orderBy: { createdAt: "asc" } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 80,
  });

  messages.reverse();
  const contactId = conversation.contactId;
  const inquiry =
    conversation.inquiries[0] ||
    (contactId
      ? await prisma.inquiry.findFirst({
          where: { tenantId: tid, contactId, archived: false },
          orderBy: { receivedAt: "desc" },
        })
      : null);
  const deal = await resolveContextDeal(prisma, tid, conversationId, contactId, inquiry?.dealId);

  const existingAgreements = await prisma.agreement.findMany({
    where: {
      tenantId: tid,
      conversationId,
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
    messages,
    existingAgreements,
    inquiryStatus: inquiry?.status,
    dealStageKey: deal?.stage?.systemKey,
    contactName: conversation.contact?.name || conversation.contact?.firstName || null,
    now: messages.at(-1)?.createdAt || new Date(),
    timeZone,
  });

  analysis.events = extractPriceEvents(messages, deal?.currency || tenant.currency);
  let llmUsed = false;
  if (options.useLlm !== false) {
    const llm = await refineConversationContextWithLlm({
      messages: messages.slice(-20).map((m) => ({
        role: m.senderKind === "client" || m.direction === "inbound" ? "client" : m.senderKind === "ai" ? "ai" : "staff",
        text: [m.text, ...(m.attachments || []).map((file) => `[файл: ${file.originalFileName || file.fileName}]`)]
          .filter(Boolean)
          .join(" "),
        at: m.createdAt.toISOString(),
        id: m.id,
      })),
      draft: analysis,
      timeZone,
      referenceAt: messages.at(-1)?.createdAt.toISOString() || new Date().toISOString(),
      currency: deal?.currency || tenant.currency,
      inquiryStatus: inquiry?.status || null,
      dealStage: deal?.stage?.systemKey || null,
      openTaskTitles: activeTasks.map((t) => t.title),
      existingAgreements: existingAgreements.map((a) => ({
        id: a.id,
        type: a.type,
        status: a.status,
        scheduledAt: a.scheduledAt?.toISOString() || null,
      })),
      prisma,
      tenantId: tid,
    });
    const validated = llm && validateConversationRefinement(llm, messages.map(m => m.id));
    if (validated) {
      llmUsed = true;
      analysis = mergeAnalysis(analysis, validated);
    }
  }
  analysis.events ??= extractPriceEvents(messages, deal?.currency || tenant.currency);
  for (const agreement of analysis.agreements) {
    const scheduled = ["CONFIRMED", "SCHEDULED", "RESCHEDULED"].includes(agreement.status) && Boolean(agreement.scheduledAt);
    const type = agreement.type === "CALL" ? scheduled ? "CALL_SCHEDULED" : "CALL_PROPOSED"
      : ["ONLINE_MEETING", "OFFLINE_MEETING"].includes(agreement.type) ? scheduled ? "MEETING_SCHEDULED" : "MEETING_PROPOSED"
      : agreement.type === "PAYMENT_PROMISE" ? "PAYMENT_PROMISED" : agreement.type === "FOLLOW_UP" ? "FOLLOW_UP_REQUIRED" : null;
    if (type && !analysis.events.some(event => event.type === type)) analysis.events.push({ type, confidence: agreement.confidence, evidenceMessageIds: agreement.evidenceMessageIds });
  }
  const suggestedStage = analysis.suggestedDealStage;
  fillFallbackSummary(analysis, messages);
  analysis.suggestedDealStage = suggestedStage;

  return { analysis, conversationId, messageCount: messages.length, llmUsed, sourceMessageId: messages.at(-1)?.id || null, sourceMessageAt: messages.at(-1)?.createdAt || null, messageRevision: conversation.messageRevision, snapshot: {
    deal: deal ? { id: deal.id, version: deal.version, updatedAt: deal.updatedAt } : null,
    inquiry: inquiry ? { id: inquiry.id, status: inquiry.status, nextStep: inquiry.nextStep, aiSummary: inquiry.aiSummary, needsReply: inquiry.needsReply } : null,
    contactSummary: conversation.contact?.summary || null,
    agreements: existingAgreements.map(a => ({ id: a.id, updatedAt: a.updatedAt })),
  } };
}

function mergeAnalysis(base: ConversationAnalysis, llm: Partial<ConversationAnalysis>): ConversationAnalysis {
  const llmFacts = llm.facts || {};
  return {
    ...base,
    ...llm,
    facts: {
      ...base.facts,
      ...llmFacts,
      proposalSent: Boolean(base.facts.proposalSent || llmFacts.proposalSent),
      pricesSent: Boolean(base.facts.pricesSent || llmFacts.pricesSent),
      waitingForManagement: Boolean(base.facts.waitingForManagement || llmFacts.waitingForManagement),
    },
    agreements: llm.agreements ?? base.agreements,
    suggestedTasks: llm.suggestedTasks ?? base.suggestedTasks,
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

/** Prefer explicit links. Never guess which of several open deals a conversation concerns. */
export async function resolveContextDeal(prisma: PrismaClient | Prisma.TransactionClient, tid: string, conversationId: string, contactId: string | null, inquiryDealId?: string | null) {
  if (!contactId) return null;
  const linked = await prisma.deal.findMany({ where: { tenantId: tid, contactId, outcome: "open",
    OR: [{ conversations: { some: { tenantId: tid, conversationId } } }, ...(inquiryDealId ? [{ id: inquiryDealId }] : [])],
  }, include: { stage: true }, take: 2 });
  if (linked.length) return linked.length === 1 ? linked[0] : null;
  const open = await prisma.deal.findMany({ where: { tenantId: tid, contactId, outcome: "open" }, include: { stage: true }, take: 2 });
  return open.length === 1 ? open[0] : null;
}

/** Conservative offline fallback. Semantic understanding is supplied by the existing LLM analyst. */
export function extractPriceEvents(messages: SituationMessage[], currency: string): NonNullable<ConversationAnalysis["events"]> {
  const visible = messages.filter(m => !m.internal && m.text);
  const last = visible.at(-1);
  if (!last?.id || !isInboundClient(last)) return [];
  const text = normalizeText(last.text || "");
  const rejected = /дорог|неинтерес|не интерес|не устраива|не соглас|подума|отказ|не подходит/.test(text);
  const accepted = !rejected && !/[?]|если|возможн|предполож|устраивало бы|согласился бы/.test(text) && !/бюджет|предоплат|аванс|ежемесяч|в месяц/.test(text) && /устраива|соглас(?:ен|на|ны)|фиксируем|бер[её]м|подходит/.test(text);
  const amounts = (value: string) => [...value.matchAll(/(\d{1,3}(?:[ \u00a0]\d{3})+|\d+)(?:[,.](\d{1,2}))?\s*(тыс(?:яч[аиу]?)?\.?|[кk](?![a-zа-я])|млн\.?)?\s*(₸|тенге|тг|kzt|usd|eur|\$|€)?/gi)]
    .filter(m => m[3] || m[4] || Number(m[1].replace(/\s/g, "")) >= 1000)
    .map(m => ({ amount: Number(m[1].replace(/\s/g, "") + (m[2] ? "." + m[2] : "")) * (m[3] ? /млн/i.test(m[3]) ? 1e6 : 1000 : 1),
      currency: /usd|\$/i.test(m[4] || "") ? "USD" : /eur|€/i.test(m[4] || "") ? "EUR" : m[4] ? "KZT" : currency }));
  let found = amounts(text);
  const evidence = [last.id];
  if (!found.length && accepted && /^(да[,! ]*)?соглас(?:ен|на|ны)[.! ]*$/.test(text)) {
    const previous = visible.at(-2);
    if (previous?.id && isOutbound(previous) && !/бюджет|предоплат|аванс|ежемесяч|в месяц/i.test(previous.text || "") && /предлож|стоимост|пакет|цена|offer|price/i.test(previous.text || "")) {
      found = amounts(previous.text || ""); evidence.unshift(previous.id);
    }
  }
  if (found.length !== 1) return [];
  return [{ type: rejected ? "PRICE_REJECTED" : accepted ? "PRICE_ACCEPTED" : "PRICE_DISCLOSED", ...found[0],
    confidence: "HIGH", evidenceMessageIds: evidence }];
}
