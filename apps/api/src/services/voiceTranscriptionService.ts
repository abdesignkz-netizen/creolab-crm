import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { PrismaClient, Prisma } from "@creolab/db";
import { ApiError } from "../errors.ts";
import { resolveUploadPath } from "../lib/storage.ts";
import { CONVERSATION_MAX_FILE_BYTES, resolveConversationMime } from "./conversationMedia.ts";
import { getTranscriptionConfig } from "./transcriptionConfig.ts";
import { getEntitlements } from "./entitlementService.ts";
import { reserveAiCall, aiCreditCost } from "./billingResourceService.ts";
import { recordAiUsage } from "./aiUsageService.ts";

const AUDIO_EXTENSIONS: Record<string, string> = {
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a",
  "audio/x-m4a": "m4a", "audio/wav": "wav", "audio/x-wav": "wav", "audio/webm": "webm",
  "audio/flac": "flac", "audio/x-flac": "flac",
};
const object = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const voiceTranscript = (value: unknown) => {
  const data = object(value);
  return data.status === "done" && typeof data.text === "string" ? data.text : "";
};
export const isVoiceAttachment = (file: { mimeType: string; fileName: string }) => resolveConversationMime(file.fileName, file.mimeType).startsWith("audio/");
const fail = (code: string) => new ApiError(422, code, "Не удалось распознать голосовое сообщение");

/** Reads only an inbound attachment owned by this conversation. Never downloads a caller-provided URL. */
export async function transcribeVoiceAttachment(input: {
  prisma: PrismaClient; tenantId: string; conversationId: string; attachmentId: string; integrationId: string;
  signal?: AbortSignal;
}) {
  const { prisma, tenantId, conversationId, attachmentId, integrationId } = input;
  const file = await prisma.attachment.findFirst({ where: { id: attachmentId, tenantId,
    message: { tenantId, conversationId, direction: "inbound", internal: false,
      conversation: { tenantId, connection: { integrationId } } } } });
  if (!file) throw fail("voice_unavailable");
  const cached = voiceTranscript(file.transcriptionJson);
  if (cached) return cached;
  const previous = object(file.transcriptionJson);
  if (previous.status === "processing") {
    if (Date.now() - Number(previous.startedAt) < 120000) throw fail("voice_pending");
    // A crashed request has an uncertain provider result. Do not silently bill it again.
    throw fail("voice_interrupted");
  }
  const mime = resolveConversationMime(file.fileName, file.mimeType), extension = AUDIO_EXTENSIONS[mime];
  if (!extension) throw fail("voice_unsupported");
  if (file.sizeBytes <= 0 || file.sizeBytes > CONVERSATION_MAX_FILE_BYTES) throw fail("voice_too_large");
  const access = await getEntitlements(prisma, tenantId);
  if (!access.entitlements.AI_MANAGER) throw fail("feature_required");
  const speech = getTranscriptionConfig();
  if (speech.errorCode) throw fail(speech.errorCode);
  const model = speech.model;
  let bytes: Buffer;
  try {
    const handle = await open(resolveUploadPath(file.storageKey), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > CONVERSATION_MAX_FILE_BYTES) throw fail("voice_too_large");
      bytes = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== stat.size) throw fail("voice_unavailable");
      bytes = bytes.subarray(0, bytesRead);
    } finally { await handle.close(); }
  } catch (error) { throw error instanceof ApiError ? error : fail("voice_unavailable"); }
  input.signal?.throwIfAborted();
  const claim: Prisma.InputJsonValue = { status: "processing", startedAt: Date.now() };
  const claimed = await prisma.attachment.updateMany({ where: { id: attachmentId, tenantId,
    transcriptionJson: { equals: file.transcriptionJson as Prisma.InputJsonValue } }, data: { transcriptionJson: claim } });
  if (!claimed.count) throw fail("voice_pending");
  let release: (() => Promise<void>) | undefined, called = false, text = "", requestId: string | null = null;
  let errorCode = "voice_unavailable";
  const started = Date.now();
  try {
    release = await reserveAiCall(prisma, tenantId, 150000, aiCreditCost("AI_VOICE_TRANSCRIPTION"));
    const form = new FormData();
    form.set("model", model);
    form.set("response_format", "json");
    form.set("file", new Blob([new Uint8Array(bytes)], { type: mime }), `voice.${extension}`);
    // Preserve the speaker's language; neither translate nor send the company prompt to speech recognition.
    const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
    signal.throwIfAborted();
    called = true;
    const response = await fetch(`${speech.baseUrl}/audio/transcriptions`, {
      method: "POST", headers: { Authorization: `Bearer ${speech.apiKey}` }, body: form, signal, redirect: "error",
    });
    requestId = response.headers.get("x-request-id");
    if (!response.ok) {
      await response.body?.cancel();
      // Preserve the HTTP status without storing the provider body (which may
      // contain customer content). A rejected model is not unrecognisable speech.
      throw fail(`voice_http_${response.status}`);
    }
    let data: unknown;
    try { data = await response.json(); }
    catch (error) {
      if (signal.aborted) throw error;
      throw fail("voice_invalid_response");
    }
    if (typeof object(data).text !== "string") throw fail("voice_invalid_response");
    text = (object(data).text as string).trim();
    if (text.length > 12000) { text = ""; throw fail("voice_invalid_response"); }
    if (!text) throw fail("voice_empty");
    await prisma.attachment.updateMany({ where: { id: attachmentId, tenantId, transcriptionJson: { equals: claim } },
      data: { transcriptionJson: { status: "done", text } } });
    return text;
  } catch (error) {
    errorCode = error instanceof ApiError ? (error.code === "limit_exceeded" ? "ai_credits_exhausted" : error.code === "subscription_required" ? "feature_required" : error.code)
      : input.signal?.aborted || error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name) ? "voice_timeout" : "voice_network_error";
    await prisma.attachment.updateMany({ where: { id: attachmentId, tenantId, transcriptionJson: { equals: claim } },
      data: { transcriptionJson: { status: "failed", errorCode } } });
    throw fail(errorCode);
  } finally {
    try {
      if (called) await recordAiUsage(prisma, { tenantId, integrationId, conversationId, provider: speech.provider, model,
        feature: "AI_VOICE_TRANSCRIPTION", providerRequestId: requestId, latencyMs: Date.now() - started,
        status: text ? "ok" : "failed", errorCode: text ? null : errorCode });
    } finally { await release?.(); }
  }
}
