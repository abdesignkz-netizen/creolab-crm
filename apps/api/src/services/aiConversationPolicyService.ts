import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@creolab/db";
import { crmModeToSeller } from "@creolab/contracts";
import {
  isWithinConversationHours,
  nextWorkingInstant,
  offHoursBlocksAnalysis,
  parseAIAutomationSettings,
  type AIAutomationSettings,
  type HandoffTriggerKey,
} from "./aiAutomationSettings.ts";
import { composeClientMessageWithLlm } from "./llmClient.ts";
import { sendViaProvider } from "./messagingProvider.ts";
import { resolveSellerBridge } from "./sellerLink.ts";

export const CLIENT_FOLLOWUP_TYPE = "client_followup";

const REFUSAL_RE = /не интересн|не надо|не нужно|отказ|отказываюсь|сам напишу|больше не пишите|стоп|stop\b|unsubscribe/i;
const REASON_PATTERNS: Array<{ code: string; trigger: HandoffTriggerKey; re: RegExp }> = [
  { code: "CLIENT_REQUESTED_HUMAN", trigger: "CLIENT_REQUESTED_HUMAN", re: /менеджер|оператор|живой человек|человека|переведите|свяжите.{0,20}человек|позовите.{0,12}человек|хочу (с )?менеджер|human please|talk to (a )?person/i },
  { code: "COMPLAINT", trigger: "COMPLAINT", re: /жалоб|возмущ|хамств|обман|претензи/i },
  { code: "CONFLICT", trigger: "COMPLAINT", re: /конфликт|суд|адвокат|прокуратур/i },
  { code: "CONTRACT", trigger: "CONTRACT", re: /договор|контракт|оферт/i },
  { code: "PAYMENT", trigger: "PAYMENT", re: /оплат|сч[её]т\b|платеж|каспи|iban/i },
  { code: "CUSTOM_PRICING", trigger: "CUSTOM_PRICING", re: /индивидуальн.{0,12}цен|скидк|нестандартн.{0,16}услов|спеццен/i },
  { code: "TECHNICAL_QUESTION", trigger: "OTHER", re: /интеграц|api|webhook|кастом|нестандартн.{0,12}запрос/i },
];

function asSettings(tenantSettingsJson: unknown): AIAutomationSettings {
  return parseAIAutomationSettings(tenantSettingsJson);
}

function lastNonInternal(messages: Array<{ internal?: boolean; senderKind?: string | null; direction?: string | null; text?: string | null; id?: string; createdAt?: Date }>) {
  return messages.find((item) => !item.internal) || null;
}

export function isInboundClient(message: { senderKind?: string | null; direction?: string | null }) {
  return message.direction === "inbound" || message.senderKind === "client";
}

export function isOutboundAi(message: { senderKind?: string | null; direction?: string | null }) {
  return message.senderKind === "ai" || (message.direction === "outbound" && message.senderKind !== "staff" && message.senderKind !== "user");
}

export function detectHandoffReason(
  text: string,
  analysis?: { humanRequired?: boolean; humanReason?: string | null; confidence?: string | null } | null,
): { code: string; trigger: HandoffTriggerKey } | null {
  const hay = String(text || "");
  for (const row of REASON_PATTERNS) {
    if (row.re.test(hay)) return { code: row.code, trigger: row.trigger };
  }
  const reason = String(analysis?.humanReason || "").trim();
  if (reason === "CLIENT_REQUESTED_HUMAN" || reason === "COMPLAINT" || reason === "CONFLICT" || reason === "CONTRACT" || reason === "PAYMENT" || reason === "CUSTOM_PRICING" || reason === "LOW_CONFIDENCE" || reason === "OTHER" || reason === "TECHNICAL_QUESTION" || reason === "AI_ERROR") {
    const trigger: HandoffTriggerKey =
      reason === "CONFLICT"
        ? "COMPLAINT"
        : reason === "TECHNICAL_QUESTION" || reason === "AI_ERROR"
          ? "OTHER"
          : (reason as HandoffTriggerKey);
    return { code: reason, trigger };
  }
  if (analysis?.confidence === "LOW" || (analysis?.humanRequired && analysis.confidence === "LOW")) {
    return { code: "LOW_CONFIDENCE", trigger: "LOW_CONFIDENCE" };
  }
  if (analysis?.humanRequired) return { code: analysis.humanReason || "OTHER", trigger: "OTHER" };
  return null;
}

export function isClientRefusalText(text: string) {
  return REFUSAL_RE.test(String(text || ""));
}

async function loadTenantSettings(prisma: PrismaClient, tenantId: string) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { settingsJson: true, timezone: true } });
  return {
    settings: asSettings(tenant?.settingsJson),
    timeZone: tenant?.timezone || "Asia/Almaty",
  };
}

export async function cancelConversationFollowUps(
  prisma: PrismaClient,
  tenantId: string,
  conversationId: string,
  reason: string,
) {
  await prisma.scheduledAction.updateMany({
    where: {
      tenantId,
      type: CLIENT_FOLLOWUP_TYPE,
      parentType: "conversation",
      parentId: conversationId,
      state: "scheduled",
    },
    data: { state: "canceled", cancelReason: reason },
  });
}

export async function cancelFollowUpsForContact(
  prisma: PrismaClient,
  tenantId: string,
  contactId: string | null | undefined,
  reason: string,
) {
  if (!contactId) return;
  const conversations = await prisma.conversation.findMany({
    where: { tenantId, contactId },
    select: { id: true },
  });
  for (const conversation of conversations) {
    await cancelConversationFollowUps(prisma, tenantId, conversation.id, reason);
  }
}

async function applyConversationControl(
  prisma: PrismaClient,
  tenantId: string,
  conversation: { id: string; sellerLeadId?: string | null; mode: string },
  mode: "human" | "paused",
  reason: string,
) {
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      mode,
      needsAttention: true,
      attentionReason: reason,
      controlVersion: { increment: 1 },
    },
  });
  await prisma.outboundOperation.updateMany({
    where: { tenantId, conversationId: conversation.id, state: { in: ["queued", "generating"] } },
    data: { state: "canceled", error: "handed_to_human" },
  });
  await cancelConversationFollowUps(prisma, tenantId, conversation.id, "handed_to_human");
  if (conversation.sellerLeadId) {
    try {
      const resolved = await resolveSellerBridge(prisma, tenantId);
      if (resolved.bridge) await resolved.bridge.setMode(conversation.sellerLeadId, crmModeToSeller(mode));
    } catch (error) {
      console.warn("[ai-policy] setMode failed", error instanceof Error ? error.message : error);
    }
  }
}

export async function applyConfiguredHandoff(
  prisma: PrismaClient,
  tenantId: string,
  conversationId: string,
  input: { text?: string; analysis?: { humanRequired?: boolean; humanReason?: string | null; confidence?: string | null } | null },
) {
  const { settings } = await loadTenantSettings(prisma, tenantId);
  const detected = detectHandoffReason(input.text || "", input.analysis);
  if (!detected || !settings.handoff.triggers[detected.trigger]) return null;
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId } });
  if (!conversation || conversation.mode === "human") return null;
  if (settings.handoff.afterMode === "assist" && conversation.mode === "paused") return null;
  const nextMode = settings.handoff.afterMode === "assist" ? "paused" : "human";
  await applyConversationControl(prisma, tenantId, conversation, nextMode, detected.code);
  const inquiry = await prisma.inquiry.findFirst({
    where: { tenantId, conversationId, archived: false },
    orderBy: { receivedAt: "desc" },
  });
  if (inquiry) {
    const fieldMeta =
      inquiry.fieldMetaJson && typeof inquiry.fieldMetaJson === "object"
        ? { ...(inquiry.fieldMetaJson as Record<string, unknown>) }
        : {};
    const automation =
      fieldMeta.automation && typeof fieldMeta.automation === "object"
        ? { ...(fieldMeta.automation as Record<string, unknown>) }
        : {};
    await prisma.inquiry.update({
      where: { id: inquiry.id },
      data: {
        attentionReason: detected.code,
        fieldMetaJson: {
          ...fieldMeta,
          automation: { ...automation, status: nextMode === "human" ? "paused" : "analyzed", handoffReason: detected.code },
        } as Prisma.InputJsonValue,
      },
    });
  }
  return { reason: detected.code, mode: nextMode };
}

async function conversationGuards(
  prisma: PrismaClient,
  tenantId: string,
  conversationId: string,
  settings: AIAutomationSettings,
) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
    include: {
      messages: { where: { internal: false }, orderBy: { createdAt: "desc" }, take: 30 },
      contact: true,
    },
  });
  if (!conversation) return { ok: false as const, reason: "missing" };
  const last = lastNonInternal(conversation.messages);
  const clientReplied = Boolean(last && isInboundClient(last));
  const refused = conversation.messages.some((item) => isInboundClient(item) && isClientRefusalText(item.text || ""));
  const inquiry = await prisma.inquiry.findFirst({
    where: { tenantId, conversationId, archived: false },
    orderBy: { receivedAt: "desc" },
    select: { status: true, contactId: true },
  });
  const contactId = conversation.contactId || inquiry?.contactId || null;
  const deal = contactId
    ? await prisma.deal.findFirst({
        where: { tenantId, contactId },
        include: { stage: true },
        orderBy: { updatedAt: "desc" },
      })
    : null;
  const dealClosed = Boolean(deal && (deal.outcome === "won" || deal.outcome === "lost" || deal.stage?.isTerminal));
  const inquiryClosed = Boolean(inquiry && ["lost", "cancelled", "converted"].includes(inquiry.status));
  const handed = conversation.mode === "human" || conversation.mode === "paused";
  if (settings.followUp.skipIfClientReplied && clientReplied) return { ok: false as const, reason: "client_replied", conversation, last };
  if (settings.followUp.skipIfHandedToHuman && handed) return { ok: false as const, reason: "handed_to_human", conversation, last };
  if (settings.followUp.skipIfRefused && (refused || inquiryClosed)) return { ok: false as const, reason: "client_refused", conversation, last };
  if (settings.followUp.skipIfDealClosed && dealClosed) return { ok: false as const, reason: "deal_closed", conversation, last };
  if (conversation.mode !== "ai") return { ok: false as const, reason: "not_ai_mode", conversation, last };
  return { ok: true as const, conversation, last, clientReplied };
}

export async function refreshConversationFollowUp(prisma: PrismaClient, tenantId: string, conversationId: string) {
  const { settings, timeZone } = await loadTenantSettings(prisma, tenantId);
  if (!settings.followUp.enabled) {
    await cancelConversationFollowUps(prisma, tenantId, conversationId, "followup_disabled");
    return;
  }
  const guards = await conversationGuards(prisma, tenantId, conversationId, settings);
  if (!guards.ok) {
    await cancelConversationFollowUps(prisma, tenantId, conversationId, guards.reason);
    return;
  }
  const last = guards.last;
  if (!last || isInboundClient(last) || !isOutboundAi(last)) {
    await cancelConversationFollowUps(prisma, tenantId, conversationId, "not_waiting_client");
    return;
  }
  const existing = await prisma.scheduledAction.findFirst({
    where: {
      tenantId,
      type: CLIENT_FOLLOWUP_TYPE,
      parentType: "conversation",
      parentId: conversationId,
      state: "scheduled",
    },
  });
  if (existing) return;
  const delay = settings.followUp.delaysMinutes[0] || 120;
  let dueAt = new Date(Date.now() + delay * 60_000);
  if (settings.followUp.respectWorkingHours) {
    dueAt = nextWorkingInstant(dueAt, timeZone, settings.conversationHours);
  }
  await prisma.scheduledAction.create({
    data: {
      id: randomUUID(),
      tenantId,
      type: CLIENT_FOLLOWUP_TYPE,
      parentType: "conversation",
      parentId: conversationId,
      dueAt,
      state: "scheduled",
      payloadJson: { attempt: 1, lastOutboundMessageId: last.id, lastOutboundAt: last.createdAt },
    },
  });
}

export async function afterConversationActivity(prisma: PrismaClient, tenantId: string, conversationId: string) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
    include: { messages: { where: { internal: false }, orderBy: { createdAt: "desc" }, take: 8 } },
  });
  if (!conversation) return;
  const last = lastNonInternal(conversation.messages);
  const lastText = last && isInboundClient(last) ? String(last.text || "") : "";
  if (lastText) {
    await applyConfiguredHandoff(prisma, tenantId, conversationId, { text: lastText });
  }
  await refreshConversationFollowUp(prisma, tenantId, conversationId);
  await syncConversationHoursMode(prisma, tenantId, conversationId);
}

async function syncConversationHoursMode(prisma: PrismaClient, tenantId: string, conversationId: string) {
  const { settings, timeZone } = await loadTenantSettings(prisma, tenantId);
  if (settings.conversationHours.mode !== "always" && settings.conversationHours.offHoursBehavior === "continue") return;
  if (settings.conversationHours.mode !== "schedule") return;
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId } });
  if (!conversation || conversation.mode !== "ai" || !conversation.sellerLeadId) return;
  const within = isWithinConversationHours(new Date(), timeZone, settings.conversationHours);
  try {
    const resolved = await resolveSellerBridge(prisma, tenantId);
    if (!resolved.bridge) return;
    await resolved.bridge.setMode(conversation.sellerLeadId, within ? "AUTO" : "PAUSED");
  } catch (error) {
    console.warn("[ai-policy] hours setMode failed", error instanceof Error ? error.message : error);
  }
}

export async function processClientFollowUp(
  prisma: PrismaClient,
  item: { id: string; tenantId: string; parentId: string; payloadJson: unknown },
) {
  const { settings, timeZone } = await loadTenantSettings(prisma, item.tenantId);
  if (!settings.followUp.enabled) {
    await prisma.scheduledAction.update({
      where: { id: item.id },
      data: { state: "canceled", cancelReason: "followup_disabled" },
    });
    return { skipped: "followup_disabled" as const };
  }
  const payload = (item.payloadJson && typeof item.payloadJson === "object" ? item.payloadJson : {}) as {
    attempt?: number;
    lastOutboundMessageId?: string;
  };
  const attempt = Math.max(1, Number(payload.attempt) || 1);
  const guards = await conversationGuards(prisma, item.tenantId, item.parentId, settings);
  if (!guards.ok) {
    await prisma.scheduledAction.update({
      where: { id: item.id },
      data: { state: "canceled", cancelReason: guards.reason },
    });
    return { skipped: guards.reason };
  }
  if (settings.followUp.respectWorkingHours && settings.conversationHours.mode === "schedule") {
    const when = nextWorkingInstant(new Date(), timeZone, settings.conversationHours);
    if (when.getTime() > Date.now() + 30_000) {
      await prisma.scheduledAction.update({
        where: { id: item.id },
        data: { state: "scheduled", dueAt: when, version: { increment: 1 } },
      });
      return { skipped: "outside_hours" as const };
    }
  }

  const conversation = guards.conversation;
  if (!conversation.sellerLeadId) {
    await prisma.scheduledAction.update({
      where: { id: item.id },
      data: { state: "canceled", cancelReason: "no_channel" },
    });
    return { skipped: "no_channel" as const };
  }

  const history = [...conversation.messages].reverse().map((row) => ({
    role: isInboundClient(row) ? "user" : "assistant",
    content: String(row.text || ""),
  }));
  const lastClient = conversation.messages.find((row) => isInboundClient(row));
  const text = await composeClientMessageWithLlm({
    instruction:
      "Клиент перестал отвечать. Напиши естественное продолжение последнего разговора: напомни суть, без шаблона «напоминаем о себе», без продажи с нуля. 1–3 предложения.",
    firstName: conversation.contact?.firstName || conversation.contact?.name || null,
    companyName: conversation.contact?.companyName || null,
    lastClientMessage: lastClient?.text || null,
    history,
    prisma,
    tenantId: item.tenantId,
    feature: "AI_FOLLOW_UP",
  });
  const guardsAgain = await conversationGuards(prisma, item.tenantId, item.parentId, settings);
  if (!guardsAgain.ok) {
    await prisma.scheduledAction.update({
      where: { id: item.id },
      data: { state: "canceled", cancelReason: guardsAgain.reason },
    });
    return { skipped: guardsAgain.reason };
  }
  if (!text) {
    await prisma.scheduledAction.update({
      where: { id: item.id },
      data: { state: "canceled", cancelReason: "empty_draft" },
    });
    return { skipped: "empty_draft" as const };
  }

  const message = await prisma.message.create({
    data: {
      tenantId: item.tenantId,
      conversationId: conversation.id,
      senderKind: "ai",
      direction: "outbound",
      text,
      operationState: "queued",
    },
  });
  try {
    await sendViaProvider(prisma, item.tenantId, {
      sellerLeadId: conversation.sellerLeadId,
      text,
      idempotencyKey: `followup:${item.id}:${attempt}`,
    });
    await prisma.message.update({ where: { id: message.id }, data: { operationState: "sent" } });
  } catch (error) {
    await prisma.message.update({
      where: { id: message.id },
      data: { operationState: "failed" },
    });
    await prisma.scheduledAction.update({
      where: { id: item.id },
      data: { state: "failed", cancelReason: error instanceof Error ? error.message : "send_failed" },
    });
    return { skipped: "send_failed" as const };
  }

  await prisma.scheduledAction.update({ where: { id: item.id }, data: { state: "done" } });
  const nextAttempt = attempt + 1;
  if (nextAttempt <= settings.followUp.maxAttempts) {
    const delay = settings.followUp.delaysMinutes[nextAttempt - 1] || settings.followUp.delaysMinutes.at(-1) || 1440;
    let dueAt = new Date(Date.now() + delay * 60_000);
    if (settings.followUp.respectWorkingHours) {
      dueAt = nextWorkingInstant(dueAt, timeZone, settings.conversationHours);
    }
    await prisma.scheduledAction.create({
      data: {
        id: randomUUID(),
        tenantId: item.tenantId,
        type: CLIENT_FOLLOWUP_TYPE,
        parentType: "conversation",
        parentId: conversation.id,
        dueAt,
        state: "scheduled",
        payloadJson: { attempt: nextAttempt, lastOutboundMessageId: message.id },
      },
    });
  }
  return { sent: true as const, attempt };
}

export { offHoursBlocksAnalysis };
