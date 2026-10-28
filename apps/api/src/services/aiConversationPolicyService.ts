import { deliveredConversationMessage } from "./conversationMessageState.ts";
import type { Prisma, PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import { aiChannelTypes } from "./aiChannels.ts";
import { crmModeToSeller } from "@creolab/contracts";
import {
  isWithinConversationHours,
  nextWorkingInstant,
  offHoursBlocksAnalysis,
  parseAIAutomationSettings,
  replyAudienceAllows,
  type AIAutomationSettings,
} from "./aiAutomationSettings.ts";
import { composeClientMessageWithLlm } from "./llmClient.ts";
import { bridgeTargetKey, providerDefinitelyDidNotSend, sendViaProvider } from "./messagingProvider.ts";
import { claimFollowUp, followUpScheduleId, lockFollowUpConversation, FOLLOWUP_UNKNOWN } from "./clientFollowUpDelivery.ts";
import { enqueueConversationContext } from "./conversationContextQueue.ts";
import { resolveSellerBridge } from "./sellerLink.ts";
import { decideAutomationPolicy } from "./aiAutomationPolicyService.ts";

import { detectHandoffReason, isClientRefusalText } from "./aiHandoffPolicy.ts";

export const CLIENT_FOLLOWUP_TYPE = "client_followup";
export { detectHandoffReason, isClientRefusalText } from "./aiHandoffPolicy.ts";

function asSettings(tenantSettingsJson: unknown): AIAutomationSettings {
  return parseAIAutomationSettings(tenantSettingsJson);
}

function lastNonInternal<T extends { internal?: boolean }>(messages: T[]) {
  return messages.find((item) => !item.internal) || null;
}

export function isInboundClient(message: { senderKind?: string | null; direction?: string | null }) {
  return message.direction === "inbound" || message.senderKind === "client";
}

export function isOutboundAi(message: { senderKind?: string | null; direction?: string | null }) {
  return message.senderKind === "ai" || (message.direction === "outbound" && message.senderKind !== "staff" && message.senderKind !== "user");
}

async function loadTenantSettings(prisma: PrismaClient, tenantId: string) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { settingsJson: true, timezone: true } });
  return {
    settings: asSettings(tenant?.settingsJson),
    timeZone: tenant?.timezone || "Asia/Almaty",
    paused: Boolean((tenant?.settingsJson as { runtime?: { aiPaused?: boolean } } | null)?.runtime?.aiPaused),
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
      state: { in: ["scheduled", "running"] },
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
  if (!settings.analyzeNewRequests) return null;
  const detected = detectHandoffReason(input.text || "", input.analysis);
  if (!detected || !settings.handoff.triggers[detected.trigger]) return null;
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId }, include: { connection: { include: { integration: true } } } });
  // The channel reply worker owns the atomic handoff + customer acknowledgment. Background
  // CRM analysis must not win the race and cancel that reply before it is queued.
  if (conversation?.connection?.autoReply && aiChannelTypes.includes(conversation.connection.integration.type)) return null;
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
  paused = false,
) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
    include: {
      messages: { where: deliveredConversationMessage, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 30 },
      contact: true,
      connection: { include: { integration: true } },
    },
  });
  if (!conversation) return { ok: false as const, reason: "missing" };
  const attr = conversation.contact?.attributionJson as Record<string, any> | null;
  const clientMode = typeof attr?.aiAutomation === "string" ? attr.aiAutomation : attr?.aiAutomation?.mode;
  if (paused || !settings.analyzeNewRequests || !settings.followUp.enabled || !replyAudienceAllows(settings.replyAudience, conversation.contact?.firstSeenAt)
    || attr?.doNotContact || ["OFF", "HUMAN", "MANUAL", "ASSIST"].includes(String(clientMode || "").toUpperCase())) {
    return { ok: false as const, reason: "ai_policy_restricted", conversation, last: null };
  }
  const last = lastNonInternal(conversation.messages);
  if (conversation.status !== "open" || conversation.waitingFor === "MANAGER" || last?.senderKind === "staff" || last?.senderKind === "user") {
    return { ok: false as const, reason: "handed_to_human", conversation, last };
  }
  const integration = conversation.connection?.integration || (conversation.sellerLeadId
    ? await prisma.integration.findFirst({ where: { tenantId, type: "whatsapp_seller" } }) : null);
  const policy = decideAutomationPolicy({
    settingsJson: { aiAutomation: settings }, interaction: "reply", contactFirstSeenAt: conversation.contact?.firstSeenAt,
    sourceChannel: "whatsapp", sourceType: integration?.type, integrationId: integration?.id,
    integrationAutomationMode: integration?.automationMode, clientAiMode: clientMode,
  });
  if (policy.mode === "MANUAL" || policy.mode === "ASSIST" || integration?.status === "disabled" || conversation.connection?.status === "disabled") {
    return { ok: false as const, reason: "ai_policy_restricted", conversation, last };
  }
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
  const { canUseFeature } = await import("./entitlementService.ts");
  if (!(await canUseFeature(prisma, tenantId, "AI_MANAGER"))) {
    await cancelConversationFollowUps(prisma, tenantId, conversationId, "feature_required");
    return;
  }
  const { settings, timeZone, paused } = await loadTenantSettings(prisma, tenantId);
  if (!settings.analyzeNewRequests || !settings.followUp.enabled) {
    await cancelConversationFollowUps(prisma, tenantId, conversationId, "followup_disabled");
    return;
  }
  const guards = await conversationGuards(prisma, tenantId, conversationId, settings, paused);
  if (!guards.ok) {
    await cancelConversationFollowUps(prisma, tenantId, conversationId, guards.reason);
    return;
  }
  const last = guards.last;
  if (!last || isInboundClient(last) || !isOutboundAi(last)) {
    await cancelConversationFollowUps(prisma, tenantId, conversationId, "not_waiting_client");
    return;
  }
  // Follow-up results already own their next step and attempt count. A context
  // refresh must never turn the last reminder into a fresh first attempt.
  if (last.connectionScopedId?.startsWith("followup-out:")) return;
  const delay = settings.followUp.delaysMinutes[0] || 120;
  let dueAt = new Date(Math.max(Date.now(), last.createdAt.getTime() + delay * 60_000));
  if (settings.followUp.respectWorkingHours) {
    dueAt = nextWorkingInstant(dueAt, timeZone, settings.conversationHours);
  }
  await prisma.$transaction(async tx => {
    await lockFollowUpConversation(tx, tenantId, conversationId);
    const latest = await tx.message.findFirst({ where: { tenantId, conversationId, ...deliveredConversationMessage }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    if (latest?.id !== last.id) return;
    // Include failed/unknown and older randomly named jobs: a new job must not
    // bypass their delivery evidence or reset the maximum number of attempts.
    const existing = await tx.scheduledAction.findFirst({ where: { tenantId, type: CLIENT_FOLLOWUP_TYPE, parentType: "conversation", parentId: conversationId,
      OR: [{ state: { in: ["scheduled", "running"] } }, { payloadJson: { path: ["lastOutboundMessageId"], equals: last.id } }] } });
    if (existing) return;
    await tx.scheduledAction.upsert({ where: { id: followUpScheduleId(last.id) }, update: {}, create: {
      id: followUpScheduleId(last.id), tenantId, type: CLIENT_FOLLOWUP_TYPE, parentType: "conversation", parentId: conversationId,
      dueAt, state: "scheduled", payloadJson: { attempt: 1, lastOutboundMessageId: last.id, lastOutboundAt: last.createdAt.toISOString() },
    } });
  });
}

export async function afterConversationActivity(prisma: PrismaClient, tenantId: string, conversationId: string) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
    include: { messages: { where: deliveredConversationMessage, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 8 } },
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
  input: { id: string; tenantId: string; parentId: string; payloadJson: unknown },
) {
  // Never trust a stale worker payload or reopen a finished/canceled job.
  const item = await prisma.scheduledAction.findFirst({ where: { id: input.id, tenantId: input.tenantId,
    parentId: input.parentId, parentType: "conversation", type: CLIENT_FOLLOWUP_TYPE } });
  if (!item || !["scheduled", "running"].includes(item.state)) return { skipped: "not_pending" };
  let operationId: string | undefined;
  const stop = async (reason: string, state = "canceled", dueAt?: Date) => {
    await prisma.$transaction(async tx => {
      await lockFollowUpConversation(tx, item.tenantId, item.parentId);
      if (operationId) {
        const changed = await tx.outboundOperation.updateMany({ where: { id: operationId, state: "generating" },
          data: { state: dueAt ? "deferred" : state, error: reason } });
        if (!changed.count) return;
      }
      await tx.scheduledAction.updateMany({ where: { id: item.id, tenantId: item.tenantId, state: { in: ["scheduled", "running"] } },
        data: { state: dueAt ? "scheduled" : state, cancelReason: dueAt ? null : reason, ...(dueAt ? { dueAt, version: { increment: 1 } } : {}) } });
    });
    return { skipped: reason };
  };
  const tenant = await prisma.tenant.findUnique({ where: { id: item.tenantId }, select: { status: true } });
  if (tenant?.status !== "active") return stop("tenant_suspended");
  const { canUseFeature } = await import("./entitlementService.ts");
  if (!(await canUseFeature(prisma, item.tenantId, "AI_MANAGER"))) return stop("feature_required");
  const { settings, timeZone, paused } = await loadTenantSettings(prisma, item.tenantId);
  if (!settings.analyzeNewRequests || !settings.followUp.enabled) return stop("followup_disabled");
  const payload = item.payloadJson as { attempt?: number; lastOutboundMessageId?: string };
  const attempt = Number(payload?.attempt);
  const guards = await conversationGuards(prisma, item.tenantId, item.parentId, settings, paused);
  if (!guards.ok) return stop(guards.reason);
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > settings.followUp.maxAttempts) return stop("attempt_limit");
  if (!guards.last || isInboundClient(guards.last) || !isOutboundAi(guards.last)
    || guards.last.id !== payload.lastOutboundMessageId) return stop("conversation_changed");
  const conversation = guards.conversation;
  if (!conversation.sellerLeadId || (conversation.connectionId &&
    (conversation.connection?.integration.type !== "whatsapp_seller" || conversation.connection.status !== "active"))) return stop("no_channel");
  if (settings.followUp.respectWorkingHours) {
    const when = nextWorkingInstant(new Date(), timeZone, settings.conversationHours);
    if (when.getTime() > Date.now() + 30_000) return stop("outside_hours", "scheduled", when);
  }
  const operation = await claimFollowUp(prisma, item, conversation.controlVersion);
  if (!operation) return { skipped: "already_claimed" };
  operationId = operation.id;
  const resolved = await resolveSellerBridge(prisma, item.tenantId);
  if (conversation.connection && conversation.connection.integrationId !== resolved.integration?.id) return stop("bridge_changed", "failed");
  const bridge = bridgeTargetKey(resolved);
  let text: string | null;
  try {
    const { consumeResource } = await import("./billingResourceService.ts");
    await consumeResource(prisma, item.tenantId, "AUTOMATION_RUNS", 1, `follow-up:${item.id}`);
    text = await composeClientMessageWithLlm({
      instruction: "Клиент перестал отвечать. Напиши естественное продолжение последнего разговора: напомни суть, без шаблона «напоминаем о себе», без продажи с нуля. 1–3 предложения.",
      firstName: conversation.contact?.firstName || conversation.contact?.name || null,
      companyName: conversation.contact?.companyName || null,
      lastClientMessage: conversation.messages.find(isInboundClient)?.text || null,
      history: [...conversation.messages].reverse().map(row => ({ role: isInboundClient(row) ? "user" : "assistant", content: String(row.text || "") })),
      prisma, tenantId: item.tenantId, feature: "AI_FOLLOW_UP",
    });
  } catch { return stop("Не удалось подготовить автоматическое сообщение. Отправка не выполнялась.", "failed"); }
  const current = await loadTenantSettings(prisma, item.tenantId);
  const again = await conversationGuards(prisma, item.tenantId, item.parentId, current.settings, current.paused);
  if (!again.ok) return stop(again.reason);
  if (again.conversation.controlVersion !== conversation.controlVersion || again.conversation.sellerLeadId !== conversation.sellerLeadId
    || again.conversation.connectionId !== conversation.connectionId
    || again.last?.id !== guards.last.id || attempt > current.settings.followUp.maxAttempts) return stop("conversation_changed");
  if (!(await canUseFeature(prisma, item.tenantId, "AI_MANAGER"))) return stop("feature_required");
  if (current.settings.followUp.respectWorkingHours) {
    const when = nextWorkingInstant(new Date(), current.timeZone, current.settings.conversationHours);
    if (when.getTime() > Date.now() + 30_000) return stop("outside_hours", "scheduled", when);
  }
  if (!text) return stop("empty_draft");
  const message = await prisma.$transaction(async tx => {
    await lockFollowUpConversation(tx, item.tenantId, item.parentId);
    const active = await tx.conversation.count({ where: { id: conversation.id, tenantId: item.tenantId, status: "open", mode: "ai",
      controlVersion: conversation.controlVersion, sellerLeadId: conversation.sellerLeadId, connectionId: conversation.connectionId,
      ...(conversation.connectionId ? { connection: { status: "active", integrationId: resolved.integration!.id } } : {}),
      tenant: { status: "active" } } });
    const last = await tx.message.findFirst({ where: { tenantId: item.tenantId, conversationId: conversation.id, ...deliveredConversationMessage }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    const pending = await tx.scheduledAction.count({ where: { id: item.id, tenantId: item.tenantId, state: "running" } });
    if (!active || !pending || last?.id !== guards.last!.id) return null;
    const intent = await tx.outboundOperation.updateMany({ where: { id: operation.id, state: "generating" }, data: { state: "sending" } });
    if (!intent.count) return null;
    const saved = await tx.message.create({ data: { tenantId: item.tenantId, conversationId: conversation.id,
      connectionScopedId: `followup-out:${item.id}`, senderKind: "ai", direction: "outbound", text, operationState: "sending" } });
    await tx.outboundOperation.update({ where: { id: operation.id }, data: { providerRef: saved.id } });
    return saved;
  });
  if (!message) return stop("conversation_changed");
  let state = "accepted", error: string | null = null, providerMessageId: string | null = null;
  try {
    const result = await sendViaProvider(prisma, item.tenantId, { sellerLeadId: conversation.sellerLeadId, text,
      idempotencyKey: operation.idempotencyKey, expectedBridge: bridge, beforeSend: async () => {
        // Connection/entitlement lookup can take time. Check again at the last
        // local boundary, before entering the provider's send method.
        const latestSettings = await loadTenantSettings(prisma, item.tenantId);
        const latest = await conversationGuards(prisma, item.tenantId, conversation.id, latestSettings.settings, latestSettings.paused);
        const active = await prisma.scheduledAction.count({ where: { id: item.id, tenantId: item.tenantId, state: "running", tenant: { status: "active" } } });
        const owned = await prisma.outboundOperation.count({ where: { id: operation.id, tenantId: item.tenantId, state: "sending" } });
        const withinHours = !latestSettings.settings.followUp.respectWorkingHours
          || nextWorkingInstant(new Date(), latestSettings.timeZone, latestSettings.settings.conversationHours).getTime() <= Date.now() + 30_000;
        if (!latest.ok || !active || !owned || !withinHours || latest.last?.id !== guards.last!.id
          || latest.conversation.controlVersion !== conversation.controlVersion || latest.conversation.sellerLeadId !== conversation.sellerLeadId
          || latest.conversation.connectionId !== conversation.connectionId
          || (latest.conversation.connection && (latest.conversation.connection.status !== "active" || latest.conversation.connection.integrationId !== resolved.integration?.id))
          || attempt > latestSettings.settings.followUp.maxAttempts) {
          throw new ApiError(409, "dispatch_canceled", "Автоматическое сообщение остановлено: изменились диалог или правила отправки.");
        }
      } });
    providerMessageId = result.providerMessageId;
  } catch (err) {
    state = err instanceof ApiError && err.code === "dispatch_canceled" ? "canceled" : providerDefinitelyDidNotSend(err) ? "failed" : "unknown";
    error = state === "unknown" ? FOLLOWUP_UNKNOWN : err instanceof Error ? err.message : "Не отправлено";
  }
  const settled = await prisma.$transaction(async tx => {
    await lockFollowUpConversation(tx, item.tenantId, item.parentId);
    const changed = await tx.outboundOperation.updateMany({ where: { id: operation.id, state: "sending" }, data: { state, error } });
    if (!changed.count) return false; // Recovery fenced a late response.
    const last = await tx.message.findFirst({ where: { tenantId: item.tenantId, conversationId: conversation.id, ...deliveredConversationMessage }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    await tx.message.update({ where: { id: message.id }, data: { operationState: state, providerMessageId } });
    const action = await tx.scheduledAction.updateMany({ where: { id: item.id, state: "running" },
      data: { state: state === "accepted" ? "done" : state === "canceled" ? "canceled" : "failed", cancelReason: error } });
    if (state !== "accepted") {
      if (state === "unknown") await tx.conversation.updateMany({ where: { id: conversation.id, tenantId: item.tenantId, controlVersion: conversation.controlVersion },
        data: { needsAttention: true, attentionReason: "AI_DELIVERY_UNKNOWN" } });
      return true;
    }
    await tx.conversation.update({ where: { id: conversation.id }, data: { messageRevision: { increment: 1 } } });
    await enqueueConversationContext(tx, item.tenantId, conversation.id, message.id);
    const active = await tx.conversation.count({ where: { id: conversation.id, tenantId: item.tenantId, mode: "ai", status: "open",
      controlVersion: conversation.controlVersion, tenant: { status: "active" } } });
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: item.tenantId } });
    const settings = asSettings(tenant.settingsJson);
    if (!action.count || !active || last?.id !== guards.last!.id || !settings.followUp.enabled || !settings.analyzeNewRequests
      || (tenant.settingsJson as any)?.runtime?.aiPaused) return true;
    await tx.conversation.update({ where: { id: conversation.id }, data: { waitingFor: "CLIENT" } });
    const nextAttempt = attempt + 1;
    if (nextAttempt <= settings.followUp.maxAttempts) {
      const delay = settings.followUp.delaysMinutes[nextAttempt - 1] || settings.followUp.delaysMinutes.at(-1) || 1440;
      let dueAt = new Date(Date.now() + delay * 60_000);
      if (settings.followUp.respectWorkingHours) dueAt = nextWorkingInstant(dueAt, tenant.timezone || "Asia/Almaty", settings.conversationHours);
      await tx.scheduledAction.upsert({ where: { id: followUpScheduleId(message.id) }, update: {}, create: {
        id: followUpScheduleId(message.id), tenantId: item.tenantId, type: CLIENT_FOLLOWUP_TYPE, parentType: "conversation", parentId: conversation.id,
        dueAt, state: "scheduled", payloadJson: { attempt: nextAttempt, lastOutboundMessageId: message.id },
      } });
    }
    return true;
  });
  return settled && state === "accepted" ? { sent: true as const, attempt } : { skipped: state === "accepted" ? "delivery_changed" : state };
}

export { offHoursBlocksAnalysis };
