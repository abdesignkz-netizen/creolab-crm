import { queueControlNotification } from "./controlNotificationService.ts";
import type { PrismaClient, Prisma } from "@creolab/db";
import { setTimeout as delay } from "node:timers/promises";
import { FEATURES, type AiSetupHandoffSummary } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { writeAudit } from "../lib/audit.ts";
import { directWhatsAppTypes } from "./whatsappConnectionService.ts";
import { getEntitlements, requireFeature } from "./entitlementService.ts";
import { canConsume, aiCreditCost } from "./billingResourceService.ts";
import { getEffectiveTenantSettings, getEffectiveLlmConfig } from "./runtimeSettings.ts";
import { decideAutomationPolicy } from "./aiAutomationPolicyService.ts";
import { parseAIAutomationSettings, isWithinAiSchedule } from "./aiAutomationSettings.ts";
import { directHandoffReason, handoffAcknowledgement } from "./aiHandoffPolicy.ts";
import { answerWhatsAppWithLlm, getWhatsAppReplyTimeoutMs, normalizeAiHandoffSummary } from "./llmClient.ts";
import { isVoiceAttachment, transcribeVoiceAttachment, voiceTranscript } from "./voiceTranscriptionService.ts";
import { getTranscriptionConfig } from "./transcriptionConfig.ts";
import { VOICE_CLARIFICATION, VOICE_SERVICE_FAILURE } from "./aiLanguagePolicy.ts";
import { LOCAL_SPEECH_BATCH_MS, SPEECH_CLAIM_TTL_MS } from "./speechLimits.ts";

import { requireIntegrationsAccess, requireConfigurationTenant as requireTenant } from "../lib/access.ts";
import { aiChannelTypes, aiSourceChannel, enqueueChannelDelivery } from "./channelDeliveryService.ts";
import { aiReplyGate, aiReplyPolicyHash } from "./aiReplyDeliveryState.ts";

// The legacy exports and event IDs remain compatible with already queued WhatsApp replies.
type Db = PrismaClient | Prisma.TransactionClient;
export function whatsAppAiFailureReason(code: string | null | undefined) {
  const reasons: Record<string, string> = {
    ai_not_configured: "AI_PROMPT_MISSING", ai_model_missing: "AI_MODEL_MISSING", ai_disabled: "AI_DISABLED",
    feature_required: "AI_PLAN_REQUIRED", tenant_inactive: "AI_TENANT_INACTIVE",
    ai_credits_exhausted: "AI_CREDITS_EXHAUSTED", http_401: "AI_PROVIDER_AUTH", http_403: "AI_PROVIDER_AUTH",
    http_429: "AI_PROVIDER_LIMIT", http_400: "AI_PROVIDER_CONFIG", http_404: "AI_PROVIDER_CONFIG",
    ai_invalid_response: "AI_INVALID_RESPONSE", empty_completion: "AI_INVALID_RESPONSE",
    llm_timeout: "AI_PROVIDER_TIMEOUT", llm_network_error: "AI_PROVIDER_NETWORK", llm_output_limit: "AI_PROVIDER_OUTPUT_LIMIT",
    llm_html_response: "AI_PROVIDER_CONFIG", llm_stream_response: "AI_PROVIDER_CONFIG",
    llm_invalid_json: "AI_INVALID_RESPONSE", llm_invalid_envelope: "AI_INVALID_RESPONSE",
    voice_unavailable: "AI_VOICE_UNAVAILABLE", voice_empty: "AI_VOICE_EMPTY", voice_interrupted: "AI_VOICE_UNAVAILABLE",
    voice_unsupported: "AI_VOICE_UNSUPPORTED", voice_too_large: "AI_VOICE_UNSUPPORTED", voice_provider_error: "AI_VOICE_UNAVAILABLE",
    voice_timeout: "AI_VOICE_TIMEOUT", voice_network_error: "AI_VOICE_PROVIDER_UNAVAILABLE", voice_invalid_response: "AI_VOICE_INVALID_RESPONSE",
    voice_service_missing: "AI_VOICE_SERVICE_MISSING", voice_service_config: "AI_VOICE_SERVICE_CONFIG",
    voice_local_missing: "AI_VOICE_LOCAL_MISSING", voice_resources: "AI_VOICE_RESOURCES",
    voice_local_failed: "AI_VOICE_PROVIDER_UNAVAILABLE", voice_too_long: "AI_VOICE_TOO_LONG",
    voice_http_400: "AI_VOICE_CONFIG", voice_http_404: "AI_VOICE_CONFIG", voice_http_405: "AI_VOICE_CONFIG", voice_http_422: "AI_VOICE_CONFIG",
    voice_http_401: "AI_PROVIDER_AUTH", voice_http_403: "AI_PROVIDER_AUTH", voice_http_402: "AI_PROVIDER_LIMIT", voice_http_429: "AI_PROVIDER_LIMIT",
    voice_http_413: "AI_VOICE_UNSUPPORTED", voice_http_415: "AI_VOICE_UNSUPPORTED", voice_http_408: "AI_VOICE_TIMEOUT", voice_http_504: "AI_VOICE_TIMEOUT",
  };
  return reasons[code || ""] || (code?.startsWith("llm_reply_") ? "AI_INVALID_RESPONSE" : code?.startsWith("voice_http_") ? "AI_VOICE_PROVIDER_UNAVAILABLE" : "AI_PROVIDER_UNAVAILABLE");
}
const record = (value: unknown) => value && typeof value === "object" ? value as Record<string, any> : {};
const REPLY_ATTEMPTS = 2;
const RETRY_DELAY_MS = 2000;
const retryableModelErrors = new Set(["llm_timeout", "llm_network_error", "http_408", "http_429", "http_500", "http_502", "http_503", "http_504"]);
const clientAiMode = (value: unknown) => { const setting = record(value).aiAutomation; return typeof setting === "string" ? setting : record(setting).mode; };
export function automaticWhatsAppMode(settingsJson: unknown, integration: { id: string; type: string; automationMode?: string | null }, contact: { doNotContact?: boolean; attributionJson?: unknown; firstSeenAt?: Date }) {
  const decision = decideAutomationPolicy({ settingsJson, interaction: "reply", contactFirstSeenAt: contact.firstSeenAt, sourceChannel: aiSourceChannel(integration.type), sourceType: integration.type,
    integrationId: integration.id, integrationAutomationMode: integration.automationMode,
    doNotContact: Boolean(contact.doNotContact || record(contact.attributionJson).doNotContact), clientAiMode: clientAiMode(contact.attributionJson) });
  return decision.autoStart && !decision.hardBlocked && !record(settingsJson).runtime?.aiPaused;
}
export async function directAiReadiness(prisma: PrismaClient, tenantId: string) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant || tenant.status !== "active") return "tenant_inactive";
  const access = await getEntitlements(prisma, tenantId);
  if (!access.entitlements.AI_MANAGER) return "feature_required";
  const ai = await prisma.aIConfiguration.findFirst({ where: { tenantId } });
  if (!ai || ai.promptStatus !== "published" || !ai.systemPrompt?.trim()) return "ai_not_configured";
  if (!ai.enabled || !(await getEffectiveTenantSettings(prisma, tenantId)).ai.enabled) return "ai_disabled";
  if (!(await getEffectiveLlmConfig(prisma, tenantId)).apiKey) return "ai_model_missing";
  return null;
}

export async function setDirectWhatsAppAi(prisma: PrismaClient, auth: AuthContext, id: string, enabled: boolean) {
  requireIntegrationsAccess(auth); const { tenantId } = requireTenant(auth);
  const row = await prisma.integration.findFirst({ where: { id, tenantId, type: { in: aiChannelTypes } } });
  if (!row) throw new ApiError(404, "not_found", "Подключение не найдено");
  if (enabled && row.status !== "active") throw new ApiError(409, "whatsapp_unavailable", "Сначала подключите канал");
  if (enabled) {
    await requireFeature(prisma, auth, FEATURES.AI_MANAGER);
    const reason = await directAiReadiness(prisma, row.tenantId);
    // Save the customer's opt-in while service administration finishes setup.
    // Readiness is still enforced before generation and immediately before delivery.
    if (reason && !["ai_not_configured", "ai_disabled", "ai_model_missing"].includes(reason)) {
      throw new ApiError(409, reason, "Подключение ИИ недоступно");
    }
  }
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Integration" WHERE id = ${id} AND "tenantId" = ${row.tenantId} FOR UPDATE`;
    const connections = await tx.channelConnection.updateMany({ where: { tenantId: row.tenantId, integrationId: id }, data: { autoReply: enabled } });
    if (!connections.count && row.type === "instagram_direct") await tx.channelConnection.create({ data: { tenantId: row.tenantId, integrationId: id, channelType: "instagram", status: row.status, autoReply: enabled, capabilitiesJson: ["receive_messages", "send_text", "ai_replies"] } });
    if (!enabled) {
      await tx.conversation.updateMany({ where: { tenantId: row.tenantId, connection: { integrationId: id }, mode: "ai" }, data: { mode: "human", controlVersion: { increment: 1 }, needsAttention: true, attentionReason: "taken_by_human" } });
      await tx.outboundOperation.updateMany({ where: { tenantId: row.tenantId, conversation: { connection: { integrationId: id } }, idempotencyKey: { startsWith: "wa-ai:" }, state: { in: ["generating", "queued"] } }, data: { state: "canceled" } });
    }
    const auditChannel = directWhatsAppTypes.includes(row.type) ? "whatsapp" : "channel";
    await writeAudit(tx, { tenantId: row.tenantId, actorUserId: auth.user.id, action: `integration.${auditChannel}_ai_${enabled ? "enabled" : "disabled"}`, entityType: "integration", entityId: id });
  });
  return { aiEnabled: enabled };
}

export async function enqueueWhatsAppAi(tx: Db, tenantId: string, conversationId: string, sourceMessageId?: string) {
  const conversation = await tx.conversation.findFirst({ where: { id: conversationId, tenantId, mode: "ai", status: "open" }, include: { connection: { include: { integration: true } } } });
  if (!conversation?.connection?.autoReply || !aiChannelTypes.includes(conversation.connection.integration.type)) return;
  if (conversation.waitingFor === "CLIENT") return;
  const unresolved = await aiReplyGate(tx, tenantId, conversationId);
  if (unresolved) {
    if (unresolved === "unknown") await tx.conversation.updateMany({ where: { id: conversationId, tenantId, mode: "ai", controlVersion: conversation.controlVersion, messageRevision: conversation.messageRevision },
      data: { needsAttention: true, waitingFor: "MANAGER", attentionReason: "AI_DELIVERY_UNKNOWN" } });
    return;
  }
  // Provider timestamps may have only second precision; retain the actual received message.
  const sourceId = sourceMessageId || conversation.lastInboundMessageId;
  const last = await tx.message.findFirst({ where: { tenantId, conversationId, ...(sourceId ? { id: sourceId } : {}), internal: false, operationState: { notIn: ["failed", "canceled"] } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  if (!last || last.direction !== "inbound") return;
  const id = `wa-ai:${conversationId}:${last.id}:${conversation.controlVersion}:${conversation.messageRevision}`;
  await tx.outboxEvent.upsert({ where: { id }, update: {}, create: { id, tenantId, type: directWhatsAppTypes.includes(conversation.connection.integration.type) ? "whatsapp.ai_reply" : "channel.ai_reply", entityType: "conversation", entityId: conversationId,
    payloadJson: { messageId: last.id, controlVersion: conversation.controlVersion, messageRevision: conversation.messageRevision }, availableAt: new Date(Date.now() + 1500) } });
}

async function handoff(prisma: PrismaClient, tenantId: string, conversationId: string, version: number, revision: number, reason: string, mode = "human", summary?: AiSetupHandoffSummary, sourceMessageId?: string, acknowledgement = "") {
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Conversation" WHERE id = ${conversationId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const current = await tx.conversation.findFirst({ where: { id: conversationId, tenantId, mode: "ai", controlVersion: version, messageRevision: revision }, include: { connection: { include: { integration: true } } } });
    if (!current) return;
    const context = summary && sourceMessageId ? { ...summary, sourceMessageId, createdAt: new Date().toISOString(), controlVersion: version + 1 } : {};
    await tx.conversation.update({ where: { id: current.id }, data: { mode, controlVersion: { increment: 1 }, needsAttention: true, waitingFor: "MANAGER", attentionReason: reason, aiHandoffSummaryJson: context as Prisma.InputJsonValue } });
    await queueControlNotification(tx, { tenantId, type: "ai.needs_human", entityId: conversationId, episodeKey: `ai.needs_human:${conversationId}:${version + 1}`, priority: "high" });
    if (acknowledgement && sourceMessageId && summary && current.connection) {
      const key = `wa-ai-handoff:${conversationId}:${sourceMessageId}:${version + 1}`;
      const message = await tx.message.create({ data: { tenantId, conversationId, direction: "outbound", senderKind: "ai", text: acknowledgement, operationState: "queued", connectionScopedId: key } });
      await tx.outboundOperation.create({ data: { tenantId, conversationId, idempotencyKey: key, controlVersion: version + 1, requestHash: String(revision), state: "queued", providerRef: message.id } });
      await enqueueChannelDelivery(tx, tenantId, current.connection.integration, message.id);
    }
  });
}

/** Check immediately before dispatch as well as before generation; credits are charged by the LLM, not twice. */
export async function directAiSendAllowed(prisma: PrismaClient, tenantId: string, conversationId: string, version: number, revision: number, handoffSourceMessageId?: string, deliveryMessageId?: string) {
  if (await aiReplyGate(prisma, tenantId, conversationId, deliveryMessageId)) return false;
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId }, include: { tenant: true, contact: true, connection: { include: { integration: true } } } });
  if (!conversation || conversation.status !== "open" || conversation.controlVersion !== version || conversation.messageRevision !== revision) return false;
  if (handoffSourceMessageId) {
    const summary = record(conversation.aiHandoffSummaryJson);
    if (!["human", "paused"].includes(conversation.mode) || conversation.waitingFor !== "MANAGER" || summary.controlVersion !== version || summary.sourceMessageId !== handoffSourceMessageId) return false;
  } else if (conversation.mode !== "ai") return false;
  const channel = conversation.connection;
  if (!channel?.autoReply || channel.status !== "active" || channel.integration.status !== "active" || !aiChannelTypes.includes(channel.integration.type) || record(conversation.contact?.attributionJson).doNotContact) return false;
  const settings = parseAIAutomationSettings(conversation.tenant.settingsJson);
  const clientMode = String(clientAiMode(conversation.contact?.attributionJson) || "").toUpperCase();
  if (["OFF", "HUMAN", "MANUAL", "ASSIST"].includes(clientMode) || !settings.analyzeNewRequests || record(conversation.tenant.settingsJson).runtime?.aiPaused) return false;
  const policy = decideAutomationPolicy({ settingsJson: conversation.tenant.settingsJson, interaction: "reply", contactFirstSeenAt: conversation.contact?.firstSeenAt, sourceChannel: aiSourceChannel(channel.integration.type), sourceType: channel.integration.type, integrationId: channel.integrationId, integrationAutomationMode: channel.integration.automationMode, clientAiMode: clientMode });
  if (policy.mode === "MANUAL" || policy.mode === "ASSIST") return false;
  if (!isWithinAiSchedule(new Date(), conversation.tenant.timezone, settings)) return false;
  if (await directAiReadiness(prisma, tenantId)) return false;
  const last = await prisma.message.findFirst({ where: { tenantId, conversationId, direction: "inbound", internal: false }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  return Boolean(last && (!["whatsapp_cloud", "instagram_direct"].includes(channel.integration.type) || Date.now() - last.createdAt.getTime() < 86400000));
}

export async function processWhatsAppAiReply(prisma: PrismaClient, event: { id: string; tenantId: string; entityId: string; payloadJson: unknown }, generate = answerWhatsAppWithLlm) {
  const payload = record(event.payloadJson), { tenantId, entityId: conversationId } = event;
  const version = Number(payload.controlVersion), revision = Number(payload.messageRevision);
  if (!Number.isInteger(version) || !Number.isInteger(revision) || typeof payload.messageId !== "string") return;
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId }, include: { connection: { include: { integration: true } }, tenant: true } });
  if (!conversation || conversation.mode !== "ai" || conversation.controlVersion !== version || conversation.messageRevision !== revision) return;
  const unresolved = await aiReplyGate(prisma, tenantId, conversationId);
  if (unresolved) {
    if (unresolved === "sending") throw new ApiError(409, "ai_delivery_pending", "Предыдущий ответ ещё отправляется");
    await prisma.conversation.updateMany({ where: { id: conversationId, tenantId, mode: "ai", controlVersion: version, messageRevision: revision }, data: { needsAttention: true, waitingFor: "MANAGER", attentionReason: "AI_DELIVERY_UNKNOWN" } });
    return;
  }
  const policyHash = await aiReplyPolicyHash(prisma, tenantId);
  const settings = parseAIAutomationSettings(conversation.tenant.settingsJson);
  if (!isWithinAiSchedule(new Date(), conversation.tenant.timezone, settings)) {
    // The durable outbox retries after the configured quiet period, never a socket callback.
    throw new ApiError(409, "ai_outside_hours", "ИИ ожидает рабочего времени");
  }
  const readiness = await directAiReadiness(prisma, tenantId);
  if (readiness) { await handoff(prisma, tenantId, conversationId, version, revision, whatsAppAiFailureReason(readiness)); return; }
  if (!await directAiSendAllowed(prisma, tenantId, conversationId, version, revision)) { await handoff(prisma, tenantId, conversationId, version, revision, "AI_CHANNEL_RESTRICTED"); return; }
  const history = await prisma.message.findMany({ where: { tenantId, conversationId, internal: false, operationState: { notIn: ["queued", "sending", "failed", "canceled", "unknown"] } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 30, include: { attachments: { select: { id: true, mimeType: true, fileName: true, transcriptionJson: true } } } });
  const latest = history.find(message => message.id === payload.messageId);
  if (!latest || latest.direction !== "inbound") return;
  const detected = directHandoffReason(latest.text || "", settings)
    || (conversation.connection?.integration.type === "instagram_direct" && /^\[(?:Вложение Instagram:|Сообщение Instagram\])/.test(latest.text || "") ? "AI_STAFF_ACTION" : null)
    || (latest.attachments.length && !latest.text?.trim() && !latest.attachments.some(isVoiceAttachment) ? "AI_STAFF_ACTION" : null);
  if (detected) {
    await handoff(prisma, tenantId, conversationId, version, revision, detected, settings.handoff.afterMode === "assist" ? "paused" : "human", normalizeAiHandoffSummary(null, latest.text || ""), latest.id,
      handoffAcknowledgement(detected, [...history].reverse().map(message => ({ role: message.direction === "inbound" ? "user" : "assistant", content: message.text || "" })))); return;
  }
  if (!(await canConsume(prisma, tenantId, "AI_CREDITS", 1)).allowed) { await handoff(prisma, tenantId, conversationId, version, revision, "AI_CREDITS_EXHAUSTED"); return; }
  const claim = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Conversation" WHERE id = ${conversationId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const current = await tx.conversation.findFirst({ where: { id: conversationId, tenantId, mode: "ai", controlVersion: version, messageRevision: revision } });
    if (!current) return null;
    const existing = await tx.outboundOperation.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: event.id } } });
    if (existing) {
      if (existing.state === "generating") {
        const claimTtl = Math.max(SPEECH_CLAIM_TTL_MS, LOCAL_SPEECH_BATCH_MS + REPLY_ATTEMPTS * getWhatsAppReplyTimeoutMs() + 60000);
        if (Date.now() - existing.createdAt.getTime() < claimTtl) throw new ApiError(409, "ai_generating", "ИИ готовит ответ");
        await tx.outboundOperation.update({ where: { id: existing.id }, data: { state: "failed", error: "generation_interrupted" } });
        await tx.conversation.update({ where: { id: conversationId }, data: { mode: "human", controlVersion: { increment: 1 }, needsAttention: true, attentionReason: "AI_ERROR" } });
      }
      return null;
    }
    return tx.outboundOperation.create({ data: { tenantId, conversationId, idempotencyKey: event.id, controlVersion: version, requestHash: String(revision), state: "generating" } });
  });
  if (!claim) return;
  const cancel = async () => { await prisma.outboundOperation.updateMany({ where: { id: claim.id, state: "generating" }, data: { state: "canceled" } }); };
  const messageContent = (message: typeof latest) => [(message.text || "").slice(0, 6000), ...message.attachments.map(file => {
    const transcript = voiceTranscript(file.transcriptionJson);
    return transcript ? `[Расшифровка голосового сообщения]: ${transcript}` : "[К сообщению приложен файл, содержимое недоступно.]";
  })].filter(Boolean).join("\n");
  // Include a burst of voice notes followed by text, not just the final message.
  const lastReply = history.findIndex(message => message.direction === "outbound");
  const pending = history.slice(0, lastReply < 0 ? history.length : lastReply).filter(message => message.direction === "inbound");
  if (!pending.some(message => message.id === latest.id)) pending.push(latest);
  const voices = pending.flatMap(message => message.attachments.filter(file => isVoiceAttachment(file) && !voiceTranscript(file.transcriptionJson)
    // An earlier failed recording must not block a new text message or voice note.
    && (message.id === latest.id || !["failed", "done"].includes(record(file.transcriptionJson).status))));
  const voiceDeadline = voices.length ? AbortSignal.timeout(getTranscriptionConfig().engine === "local" ? LOCAL_SPEECH_BATCH_MS : 55000) : undefined;
  let transcribing = false;
  let answer: Awaited<ReturnType<typeof answerWhatsAppWithLlm>> = null;
  let failureReason = "AI_PROVIDER_UNAVAILABLE";
  let voiceFailure: string | null = null;
  try {
    if (voices.length > 5) throw new ApiError(422, "voice_unsupported", "Слишком много голосовых сообщений");
    if (voices.length && !(await canConsume(prisma, tenantId, "AI_CREDITS", voices.length * aiCreditCost("AI_VOICE_TRANSCRIPTION") + aiCreditCost("AI_MANAGER_REPLY"))).allowed) {
      throw new ApiError(403, "ai_credits_exhausted", "Недостаточно AI-кредитов");
    }
    transcribing = voices.length > 0;
    for (const file of voices.reverse()) {
      if (!await directAiSendAllowed(prisma, tenantId, conversationId, version, revision)) { await cancel(); return; }
      const text = await transcribeVoiceAttachment({ prisma, tenantId, conversationId, integrationId: conversation.connection!.integrationId, attachmentId: file.id, signal: voiceDeadline });
      file.transcriptionJson = { status: "done", text };
    }
    transcribing = false;
    if (!await directAiSendAllowed(prisma, tenantId, conversationId, version, revision)) { await cancel(); return; }
    for (const message of pending) {
      if (message.id !== latest.id && !message.attachments.some(isVoiceAttachment)) continue;
      const text = messageContent(message), reason = directHandoffReason(text, settings);
      if (reason) {
        await cancel();
        await handoff(prisma, tenantId, conversationId, version, revision, reason, settings.handoff.afterMode === "assist" ? "paused" : "human", normalizeAiHandoffSummary(null, text), latest.id,
          handoffAcknowledgement(reason, [{ role: "user", content: text }])); return;
      }
    }
    for (let attempt = 0; attempt < REPLY_ATTEMPTS; attempt++) {
      if (attempt) {
        // Keep the same claim: overlapping outbox ticks must not generate or send twice.
        // Recheck after the delay so a takeover or newer message stops the retry.
        await delay(RETRY_DELAY_MS);
        if (!await directAiSendAllowed(prisma, tenantId, conversationId, version, revision)
          || !await prisma.outboundOperation.count({ where: { id: claim.id, state: "generating" } })) { await cancel(); return; }
      }
      try {
        answer = await generate({ prisma, tenantId, integrationId: conversation.connection!.integrationId, conversationId, maxReplyChars: conversation.connection!.integration.type === "instagram_direct" ? 1000 : 4000,
          history: [...[...history].reverse().filter(message => message.id !== latest.id), latest].map(message => ({ role: message.direction === "inbound" ? "user" : "assistant", content: messageContent(message).slice(0, 18000) })) });
        break;
      } catch (error) {
        if (attempt + 1 === REPLY_ATTEMPTS || !(error instanceof ApiError) || !retryableModelErrors.has(error.code)) throw error;
      }
    }
  } catch (error) {
    if (error instanceof ApiError && error.code === "voice_pending") {
      // A newer revision can overlap an earlier transcription. Retry using its durable cache.
      await prisma.outboundOperation.deleteMany({ where: { id: claim.id, state: "generating" } });
      throw new ApiError(409, "ai_generating", "ИИ распознаёт голосовое сообщение");
    }
    const speechTimedOut = transcribing && Boolean(voiceDeadline?.aborted);
    failureReason = speechTimedOut ? "AI_VOICE_TIMEOUT" : whatsAppAiFailureReason(error instanceof ApiError ? error.code : null);
    if (error instanceof ApiError && error.code.startsWith("voice_") || speechTimedOut) {
      // A speech failure asks for clarification through the normal, idempotent
      // delivery path. It must not disable AI for the next customer message.
      voiceFailure = failureReason;
      // Infrastructure failures say nothing about the intelligibility of the speech.
      const unclear = error instanceof ApiError && ["voice_empty", "voice_unsupported", "voice_too_long", "voice_too_large"].includes(error.code);
      answer = { reply: unclear ? VOICE_CLARIFICATION : VOICE_SERVICE_FAILURE, handoff: false };
      // Preflight failures (e.g. missing speech configuration) happen before a
      // transcription claim. Mark those too, so they cannot block later text.
      for (const file of voices) {
        if (record(file.transcriptionJson).status) continue;
        await prisma.attachment.updateMany({ where: { id: file.id, tenantId,
          transcriptionJson: { equals: file.transcriptionJson as Prisma.InputJsonValue } },
          data: { transcriptionJson: { status: "failed", errorCode: error instanceof ApiError ? error.code : "voice_timeout" } } });
      }
    }
  }
  if (answer && !answer.handoff && answer.reply.length > (conversation.connection!.integration.type === "instagram_direct" ? 1000 : 4000)) {
    answer = null; failureReason = "AI_INVALID_RESPONSE";
  }
  if (!answer || answer.handoff) {
    await prisma.outboundOperation.updateMany({ where: { id: claim.id, state: "generating" }, data: { state: "failed", error: answer?.handoff ? "needs_human" : failureReason } });
    await handoff(prisma, tenantId, conversationId, version, revision, answer?.handoff ? (({ knowledge_missing: "AI_KNOWLEDGE_MISSING", human_requested: "CLIENT_REQUESTED_HUMAN", staff_action: "AI_STAFF_ACTION" } as Record<string, string>)[String(answer.reason)] || "LOW_CONFIDENCE") : failureReason, answer?.handoff && settings.handoff.afterMode === "assist" ? "paused" : "human", answer?.handoff ? normalizeAiHandoffSummary(answer.handoffSummary, messageContent(latest)) : undefined, latest.id, answer?.handoff ? handoffAcknowledgement(answer.reason, [...history].reverse().map(message => ({ role: message.direction === "inbound" ? "user" : "assistant", content: messageContent(message) }))) : ""); return;
  }
  if (!await directAiSendAllowed(prisma, tenantId, conversationId, version, revision)) {
    await prisma.outboundOperation.updateMany({ where: { id: claim.id, state: "generating" }, data: { state: "canceled" } }); return;
  }
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Conversation" WHERE id = ${conversationId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const current = await tx.conversation.findFirst({ where: { id: conversationId, tenantId, mode: "ai", controlVersion: version, messageRevision: revision } });
    const operation = await tx.outboundOperation.updateMany({ where: { id: claim.id, state: "generating" }, data: { state: current ? "queued" : "canceled", ...(voiceFailure ? { error: voiceFailure } : {}) } });
    if (!current || !operation.count) return;
    const message = await tx.message.create({ data: { tenantId, conversationId, direction: "outbound", senderKind: "ai", text: answer!.reply, operationState: "queued", connectionScopedId: event.id } });
    await tx.outboundOperation.update({ where: { id: claim.id }, data: { providerRef: message.id } });
    await enqueueChannelDelivery(tx, tenantId, conversation.connection!.integration, message.id, policyHash);
  });
}
