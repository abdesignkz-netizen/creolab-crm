import type { PrismaClient, Prisma } from "@creolab/db";
import { FEATURES } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { writeAudit } from "../lib/audit.ts";
import { encryptSecret } from "../lib/secretBox.ts";
import { directWhatsAppTypes, ownedWhatsApp } from "./whatsappConnectionService.ts";
import { getEntitlements, requireFeature } from "./entitlementService.ts";
import { canConsume, aiCreditCost } from "./billingResourceService.ts";
import { getEffectiveTenantSettings, getEffectiveLlmConfig } from "./runtimeSettings.ts";
import { decideAutomationPolicy } from "./aiAutomationPolicyService.ts";
import { parseAIAutomationSettings, isWithinAiSchedule } from "./aiAutomationSettings.ts";
import { detectHandoffReason, isClientRefusalText } from "./aiConversationPolicyService.ts";
import { answerWhatsAppWithLlm } from "./llmClient.ts";
import { isVoiceAttachment, transcribeVoiceAttachment, voiceTranscript } from "./voiceTranscriptionService.ts";
import { getTranscriptionConfig } from "./transcriptionConfig.ts";

type Db = PrismaClient | Prisma.TransactionClient;
export function whatsAppAiFailureReason(code: string | null | undefined) {
  const reasons: Record<string, string> = {
    ai_not_configured: "AI_PROMPT_MISSING", ai_model_missing: "AI_MODEL_MISSING", ai_disabled: "AI_DISABLED",
    feature_required: "AI_PLAN_REQUIRED", tenant_inactive: "AI_TENANT_INACTIVE",
    ai_credits_exhausted: "AI_CREDITS_EXHAUSTED", http_401: "AI_PROVIDER_AUTH", http_403: "AI_PROVIDER_AUTH",
    http_429: "AI_PROVIDER_LIMIT", http_400: "AI_PROVIDER_CONFIG", http_404: "AI_PROVIDER_CONFIG",
    ai_invalid_response: "AI_INVALID_RESPONSE", empty_completion: "AI_INVALID_RESPONSE",
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
  return reasons[code || ""] || (code?.startsWith("voice_http_") ? "AI_VOICE_PROVIDER_UNAVAILABLE" : "AI_PROVIDER_UNAVAILABLE");
}
const record = (value: unknown) => value && typeof value === "object" ? value as Record<string, any> : {};
const clientAiMode = (value: unknown) => { const setting = record(value).aiAutomation; return typeof setting === "string" ? setting : record(setting).mode; };
export function automaticWhatsAppMode(settingsJson: unknown, integration: { id: string; type: string; automationMode?: string | null }, contact: { doNotContact?: boolean; attributionJson?: unknown }) {
  const decision = decideAutomationPolicy({ settingsJson, sourceChannel: "whatsapp", sourceType: integration.type,
    integrationId: integration.id, integrationAutomationMode: integration.automationMode,
    doNotContact: Boolean(record(contact.attributionJson).doNotContact), clientAiMode: clientAiMode(contact.attributionJson) });
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
  const row = await ownedWhatsApp(prisma, auth, id);
  if (enabled && row.status !== "active") throw new ApiError(409, "whatsapp_unavailable", "Сначала подключите WhatsApp");
  if (enabled) {
    await requireFeature(prisma, auth, FEATURES.AI_MANAGER);
    const reason = await directAiReadiness(prisma, row.tenantId);
    // Save the customer's opt-in while service administration finishes setup.
    // Readiness is still enforced before generation and immediately before delivery.
    if (reason && !["ai_not_configured", "ai_disabled", "ai_model_missing"].includes(reason)) {
      throw new ApiError(409, reason, "Подключение WhatsApp недоступно");
    }
  }
  await prisma.$transaction(async tx => {
    await tx.channelConnection.updateMany({ where: { tenantId: row.tenantId, integrationId: id }, data: { autoReply: enabled } });
    if (!enabled) {
      await tx.conversation.updateMany({ where: { tenantId: row.tenantId, connection: { integrationId: id }, mode: "ai" }, data: { mode: "human", controlVersion: { increment: 1 }, needsAttention: true, attentionReason: "taken_by_human" } });
      await tx.outboundOperation.updateMany({ where: { tenantId: row.tenantId, conversation: { connection: { integrationId: id } }, idempotencyKey: { startsWith: "wa-ai:" }, state: { in: ["generating", "queued"] } }, data: { state: "canceled" } });
    }
    await writeAudit(tx, { tenantId: row.tenantId, actorUserId: auth.user.id, action: enabled ? "integration.whatsapp_ai_enabled" : "integration.whatsapp_ai_disabled", entityType: "integration", entityId: id });
  });
  return { aiEnabled: enabled };
}

export async function enqueueWhatsAppAi(tx: Db, tenantId: string, conversationId: string, sourceMessageId?: string) {
  const conversation = await tx.conversation.findFirst({ where: { id: conversationId, tenantId, mode: "ai", status: "open" }, include: { connection: { include: { integration: true } } } });
  if (!conversation?.connection?.autoReply || !directWhatsAppTypes.includes(conversation.connection.integration.type)) return;
  if (conversation.waitingFor === "CLIENT") return;
  // Provider timestamps may have only second precision; retain the actual received message.
  const sourceId = sourceMessageId || conversation.lastInboundMessageId;
  const last = await tx.message.findFirst({ where: { tenantId, conversationId, ...(sourceId ? { id: sourceId } : {}), internal: false, operationState: { notIn: ["failed", "canceled"] } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  if (!last || last.direction !== "inbound") return;
  const id = `wa-ai:${conversationId}:${last.id}:${conversation.controlVersion}:${conversation.messageRevision}`;
  await tx.outboxEvent.upsert({ where: { id }, update: {}, create: { id, tenantId, type: "whatsapp.ai_reply", entityType: "conversation", entityId: conversationId,
    payloadJson: { messageId: last.id, controlVersion: conversation.controlVersion, messageRevision: conversation.messageRevision }, availableAt: new Date(Date.now() + 1500) } });
}

async function handoff(prisma: PrismaClient, tenantId: string, conversationId: string, version: number, revision: number, reason: string, mode = "human") {
  await prisma.conversation.updateMany({ where: { id: conversationId, tenantId, mode: "ai", controlVersion: version, messageRevision: revision }, data: { mode, controlVersion: { increment: 1 }, needsAttention: true, waitingFor: "MANAGER", attentionReason: reason } });
}

/** Check immediately before dispatch as well as before generation; credits are charged by the LLM, not twice. */
export async function directAiSendAllowed(prisma: PrismaClient, tenantId: string, conversationId: string, version: number, revision: number) {
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId }, include: { tenant: true, contact: true, connection: { include: { integration: true } } } });
  if (!conversation || conversation.mode !== "ai" || conversation.status !== "open" || conversation.controlVersion !== version || conversation.messageRevision !== revision) return false;
  const channel = conversation.connection;
  if (!channel?.autoReply || channel.status !== "active" || channel.integration.status !== "active" || !directWhatsAppTypes.includes(channel.integration.type) || record(conversation.contact?.attributionJson).doNotContact) return false;
  const settings = parseAIAutomationSettings(conversation.tenant.settingsJson);
  const clientMode = String(clientAiMode(conversation.contact?.attributionJson) || "").toUpperCase();
  if (["OFF", "HUMAN", "MANUAL", "ASSIST"].includes(clientMode) || !settings.analyzeNewRequests || record(conversation.tenant.settingsJson).runtime?.aiPaused) return false;
  const policy = decideAutomationPolicy({ settingsJson: conversation.tenant.settingsJson, sourceChannel: "whatsapp", sourceType: channel.integration.type, integrationId: channel.integrationId, integrationAutomationMode: channel.integration.automationMode, clientAiMode: clientMode });
  if (policy.mode === "MANUAL" || policy.mode === "ASSIST") return false;
  if (!isWithinAiSchedule(new Date(), conversation.tenant.timezone, settings)) return false;
  if (await directAiReadiness(prisma, tenantId)) return false;
  const last = await prisma.message.findFirst({ where: { tenantId, conversationId, direction: "inbound", internal: false }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  return Boolean(last && (channel.integration.type !== "whatsapp_cloud" || Date.now() - last.createdAt.getTime() < 86400000));
}

export async function processWhatsAppAiReply(prisma: PrismaClient, event: { id: string; tenantId: string; entityId: string; payloadJson: unknown }, generate = answerWhatsAppWithLlm) {
  const payload = record(event.payloadJson), { tenantId, entityId: conversationId } = event;
  const version = Number(payload.controlVersion), revision = Number(payload.messageRevision);
  if (!Number.isInteger(version) || !Number.isInteger(revision) || typeof payload.messageId !== "string") return;
  const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, tenantId }, include: { connection: { include: { integration: true } }, tenant: true } });
  if (!conversation || conversation.mode !== "ai" || conversation.controlVersion !== version || conversation.messageRevision !== revision) return;
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
  const detected = detectHandoffReason(latest.text || "");
  if (isClientRefusalText(latest.text || "") || /адаммен|оператормен|менеджермен|адамға|менеджерге|talk to.*human|speak to.*human/i.test(latest.text || "") || detected && (detected.code === "CLIENT_REQUESTED_HUMAN" || settings.handoff.triggers[detected.trigger]) || latest.attachments.length && !latest.text?.trim() && !latest.attachments.some(isVoiceAttachment)) {
    await handoff(prisma, tenantId, conversationId, version, revision, detected?.code || "CLIENT_REQUESTED_HUMAN", settings.handoff.afterMode === "assist" ? "paused" : "human"); return;
  }
  if (!(await canConsume(prisma, tenantId, "AI_CREDITS", 1)).allowed) { await handoff(prisma, tenantId, conversationId, version, revision, "AI_CREDITS_EXHAUSTED"); return; }
  const claim = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Conversation" WHERE id = ${conversationId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const current = await tx.conversation.findFirst({ where: { id: conversationId, tenantId, mode: "ai", controlVersion: version, messageRevision: revision } });
    if (!current) return null;
    const existing = await tx.outboundOperation.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: event.id } } });
    if (existing) {
      if (existing.state === "generating") {
        if (Date.now() - existing.createdAt.getTime() < 120000) throw new ApiError(409, "ai_generating", "ИИ готовит ответ");
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
  const voices = pending.flatMap(message => message.attachments.filter(file => isVoiceAttachment(file) && !voiceTranscript(file.transcriptionJson)));
  const voiceDeadline = AbortSignal.timeout(getTranscriptionConfig().engine === "local" ? 75000 : 55000);
  let answer: Awaited<ReturnType<typeof answerWhatsAppWithLlm>> = null;
  let failureReason = "AI_PROVIDER_UNAVAILABLE";
  try {
    if (voices.length > 5) throw new ApiError(422, "voice_unsupported", "Слишком много голосовых сообщений");
    if (voices.length && !(await canConsume(prisma, tenantId, "AI_CREDITS", voices.length * aiCreditCost("AI_VOICE_TRANSCRIPTION") + aiCreditCost("AI_MANAGER_REPLY"))).allowed) {
      throw new ApiError(403, "ai_credits_exhausted", "Недостаточно AI-кредитов");
    }
    for (const file of voices.reverse()) {
      if (!await directAiSendAllowed(prisma, tenantId, conversationId, version, revision)) { await cancel(); return; }
      const text = await transcribeVoiceAttachment({ prisma, tenantId, conversationId, integrationId: conversation.connection!.integrationId, attachmentId: file.id, signal: voiceDeadline });
      file.transcriptionJson = { status: "done", text };
    }
    if (!await directAiSendAllowed(prisma, tenantId, conversationId, version, revision)) { await cancel(); return; }
    for (const message of pending) {
      if (message.id !== latest.id && !message.attachments.some(isVoiceAttachment)) continue;
      const text = messageContent(message), reason = detectHandoffReason(text);
      if (isClientRefusalText(text) || /адаммен|оператормен|менеджермен|адамға|менеджерге|talk to.*human|speak to.*human/i.test(text) || reason && (reason.code === "CLIENT_REQUESTED_HUMAN" || settings.handoff.triggers[reason.trigger])) {
        await cancel();
        await handoff(prisma, tenantId, conversationId, version, revision, reason?.code || "CLIENT_REQUESTED_HUMAN", settings.handoff.afterMode === "assist" ? "paused" : "human"); return;
      }
    }
    answer = await generate({ prisma, tenantId, integrationId: conversation.connection!.integrationId, conversationId,
      history: [...[...history].reverse().filter(message => message.id !== latest.id), latest].map(message => ({ role: message.direction === "inbound" ? "user" : "assistant", content: messageContent(message).slice(0, 18000) })) });
  } catch (error) {
    if (error instanceof ApiError && error.code === "voice_pending") {
      // A newer revision can overlap an earlier transcription. Retry using its durable cache.
      await prisma.outboundOperation.deleteMany({ where: { id: claim.id, state: "generating" } });
      throw new ApiError(409, "ai_generating", "ИИ распознаёт голосовое сообщение");
    }
    failureReason = voiceDeadline.aborted ? "AI_VOICE_TIMEOUT" : whatsAppAiFailureReason(error instanceof ApiError ? error.code : null);
  }
  if (!answer || answer.handoff) {
    await prisma.outboundOperation.updateMany({ where: { id: claim.id, state: "generating" }, data: { state: "failed", error: answer?.handoff ? "needs_human" : failureReason } });
    await handoff(prisma, tenantId, conversationId, version, revision, answer?.handoff ? "LOW_CONFIDENCE" : failureReason, answer?.handoff && settings.handoff.afterMode === "assist" ? "paused" : "human"); return;
  }
  if (!await directAiSendAllowed(prisma, tenantId, conversationId, version, revision)) {
    await prisma.outboundOperation.updateMany({ where: { id: claim.id, state: "generating" }, data: { state: "canceled" } }); return;
  }
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Conversation" WHERE id = ${conversationId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const current = await tx.conversation.findFirst({ where: { id: conversationId, tenantId, mode: "ai", controlVersion: version, messageRevision: revision } });
    const operation = await tx.outboundOperation.updateMany({ where: { id: claim.id, state: "generating" }, data: { state: current ? "queued" : "canceled" } });
    if (!current || !operation.count) return;
    const message = await tx.message.create({ data: { tenantId, conversationId, direction: "outbound", senderKind: "ai", text: answer!.reply, operationState: "queued", connectionScopedId: event.id } });
    await tx.outboundOperation.update({ where: { id: claim.id }, data: { providerRef: message.id } });
    if (conversation.connection!.integration.type === "whatsapp_qr") await tx.$executeRaw`INSERT INTO "WhatsAppQrJob" (id, "integrationId", kind, "encryptedPayload") VALUES (${message.id}, ${conversation.connection!.integrationId}, 'outbound', ${encryptSecret(JSON.stringify({ messageId: message.id }))})`;
    else await tx.outboxEvent.create({ data: { id: `wa-send:${message.id}`, tenantId, type: "whatsapp.cloud_send", entityType: "message", entityId: message.id, payloadJson: { integrationId: conversation.connection!.integrationId } } });
  });
}
