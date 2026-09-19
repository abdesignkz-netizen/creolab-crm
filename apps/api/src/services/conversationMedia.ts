import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import { assertExternalCallbackUrl } from "../lib/externalUrl.ts";
import { resolveUploadPath } from "../lib/storage.ts";

export const CONVERSATION_MAX_FILE_BYTES = 16 * 1024 * 1024;
export const CONVERSATION_MAX_ATTACHMENTS = 5;

const DOC_MIME = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "application/zip",
  "application/octet-stream",
]);

const EXT_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".3gp": "video/3gpp",
  ".webm": "video/webm",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".amr": "audio/amr",
  ".wav": "audio/wav",
  ".txt": "text/plain",
  ".zip": "application/zip",
};

export type ConversationMediaKind = "image" | "video" | "audio" | "document" | "text";

export type HistoryMediaItem = {
  role: string;
  content: string;
  at?: string;
  type?: string;
  mimeType?: string;
  fileName?: string;
  contentBase64?: string;
  fileUrl?: string;
  mediaId?: string;
  jpegThumbnail?: string;
};

export function safeConversationFileName(fileName: string) {
  return String(fileName || "")
    .replace(/[^\w.\-а-яА-ЯёЁ ]+/g, "_")
    .slice(0, 180) || "file.bin";
}

export function decodeBase64Payload(raw: string) {
  const value = String(raw || "").trim();
  const payload = value.includes(",") ? value.split(",")[1] : value;
  const buffer = Buffer.from(payload, "base64");
  if (!buffer.length) throw new ApiError(422, "invalid", "Пустой файл");
  return buffer;
}

export function resolveConversationMime(fileName: string, mimeType?: string | null) {
  const raw = String(mimeType || "").trim().toLowerCase().split(";")[0];
  if (raw && raw !== "application/octet-stream" && raw !== "binary/octet-stream") return raw;
  const ext = path.extname(fileName || "").toLowerCase();
  return EXT_MIME[ext] || raw || "application/octet-stream";
}

export function conversationMediaKind(mimeType?: string | null, hint?: string | null): ConversationMediaKind {
  const mime = String(mimeType || "").toLowerCase();
  const type = String(hint || "").toLowerCase();
  if (mime.startsWith("image/") || type.includes("image") || type.includes("sticker") || type.includes("photo")) {
    return "image";
  }
  if (mime.startsWith("video/") || type.includes("video")) return "video";
  if (mime.startsWith("audio/") || type.includes("audio") || type.includes("ptt") || type.includes("voice")) {
    return "audio";
  }
  if (type.includes("document") || type.includes("file")) return "document";
  if (mime && mime !== "text/plain") return "document";
  return "text";
}

export function mediaPreviewLabel(kind: ConversationMediaKind | string) {
  if (kind === "image") return "Фото";
  if (kind === "video") return "Видео";
  if (kind === "audio") return "Аудио";
  if (kind === "document") return "Файл";
  return "";
}

export function looksLikeMediaPlaceholder(text: string) {
  const value = String(text || "").trim().toLowerCase();
  if (!value) return false;
  return /^\[?(image|photo|video|audio|voice|ptt|document|file|sticker|фото|картинка|изображение|видео|аудио|голос|документ|файл|стикер)\]?$/.test(
    value,
  );
}

export function inferKindFromText(text: string): ConversationMediaKind | null {
  const value = String(text || "").trim().toLowerCase();
  if (!value) return null;
  if (/image|photo|фото|картинка|изображение|sticker|стикер|📷/.test(value) && looksLikeMediaPlaceholder(value)) {
    return "image";
  }
  if (/video|видео|🎥/.test(value) && looksLikeMediaPlaceholder(value)) return "video";
  if (/audio|voice|ptt|аудио|голос/.test(value) && looksLikeMediaPlaceholder(value)) return "audio";
  if (/document|file|документ|файл/.test(value) && looksLikeMediaPlaceholder(value)) return "document";
  return null;
}

export function assertConversationMime(fileName: string, mimeType: string) {
  const mime = resolveConversationMime(fileName, mimeType);
  if (mime === "image/svg+xml" || mime === "text/html") {
    throw new ApiError(422, "invalid", "Этот формат нельзя прикрепить к диалогу");
  }
  if (mime.startsWith("image/") || mime.startsWith("video/") || mime.startsWith("audio/") || DOC_MIME.has(mime)) {
    return mime;
  }
  throw new ApiError(422, "invalid", "Формат файла не поддерживается");
}

export function attachmentView(
  conversationId: string,
  attachment: {
    id: string;
    fileName: string;
    originalFileName?: string | null;
    mimeType: string;
    sizeBytes: number;
    documentType?: string | null;
  },
) {
  const kind = conversationMediaKind(attachment.mimeType, attachment.documentType);
  return {
    id: attachment.id,
    fileName: attachment.originalFileName || attachment.fileName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    kind,
    url: `/api/v1/conversations/${conversationId}/attachments/${attachment.id}`,
  };
}

export function messagePreviewText(
  message: { text?: string | null; type?: string | null } | null | undefined,
) {
  if (!message) return "Нет сообщений";
  const text = String(message.text || "").trim();
  const kind =
    conversationMediaKind(null, message.type) !== "text"
      ? conversationMediaKind(null, message.type)
      : inferKindFromText(text);
  if (text && !looksLikeMediaPlaceholder(text)) return text.slice(0, 160);
  if (kind && kind !== "text") return mediaPreviewLabel(kind);
  return text.slice(0, 160) || "Нет сообщений";
}

export async function storeMessageAttachment(
  prisma: PrismaClient,
  input: {
    tenantId: string;
    messageId: string;
    fileName: string;
    mimeType: string;
    buffer: Buffer;
    uploadedById?: string | null;
    sendState?: string;
    providerMessageId?: string | null;
  },
) {
  if (input.buffer.length > CONVERSATION_MAX_FILE_BYTES) {
    throw new ApiError(422, "too_large", "Файл больше 16 МБ");
  }
  const mimeType = assertConversationMime(input.fileName, input.mimeType);
  const kind = conversationMediaKind(mimeType);
  const safeName = safeConversationFileName(input.fileName);
  const attachmentId = randomUUID();
  const storageKey = path.posix.join(
    input.tenantId,
    "conversations",
    input.messageId,
    `${attachmentId}-${safeName}`,
  );
  const abs = resolveUploadPath(storageKey);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, input.buffer);
  return prisma.attachment.create({
    data: {
      id: attachmentId,
      tenantId: input.tenantId,
      parentType: "message",
      parentId: input.messageId,
      messageId: input.messageId,
      storageKey,
      fileName: safeName,
      originalFileName: input.fileName,
      mimeType,
      sizeBytes: input.buffer.length,
      checksum: createHash("sha256").update(input.buffer).digest("hex"),
      documentType: kind === "text" ? "document" : kind,
      uploadedById: input.uploadedById || undefined,
      status: "stored",
      sendState: input.sendState || "stored",
      providerMessageId: input.providerMessageId || undefined,
    },
  });
}

export async function fetchRemoteMedia(fileUrl: string) {
  const parsed = assertExternalCallbackUrl(fileUrl, "fileUrl");
  const response = await fetch(parsed.toString(), { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`media_http_${response.status}`);
  const mimeType = resolveConversationMime(
    parsed.pathname,
    response.headers.get("content-type") || "",
  );
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error("empty_media");
  if (buffer.length > CONVERSATION_MAX_FILE_BYTES) throw new Error("media_too_large");
  const fileName = path.basename(parsed.pathname) || "file.bin";
  return { buffer, mimeType, fileName };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function pickString(...values: unknown[]) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function mapProviderType(typeMessage: string) {
  const value = typeMessage.toLowerCase();
  if (value.includes("image") || value.includes("sticker") || value.includes("photo")) return "image";
  if (value.includes("video")) return "video";
  if (value.includes("audio") || value.includes("ptt") || value.includes("voice")) return "audio";
  if (value.includes("document") || value.includes("file")) return "document";
  return "";
}

export function normalizeHistoryMediaItem(raw: unknown): HistoryMediaItem | null {
  const item = asRecord(raw);
  if (!item) return null;
  const nested = asRecord(item.messageData) || item;
  const file =
    asRecord(nested.imageMessageData) ||
    asRecord(nested.videoMessageData) ||
    asRecord(nested.audioMessageData) ||
    asRecord(nested.documentMessageData) ||
    asRecord(nested.fileMessageData) ||
    asRecord(nested.stickerMessageData) ||
    asRecord(item.file) ||
    {};
  const typeMessage = pickString(nested.typeMessage, item.type, item.mediaType, item.kind);
  const role = pickString(item.role) || (item.fromMe ? "assistant" : "user");
  const content = pickString(
    file.caption,
    asRecord(nested.extendedTextMessageData)?.text,
    item.content,
    item.text,
    item.caption,
  );
  const at = pickString(item.at, item.timestamp, item.occurred_at, item.occurredAt) || undefined;
  return {
    role,
    content,
    at,
    type: mapProviderType(typeMessage) || pickString(item.type) || undefined,
    mimeType: pickString(file.mimeType, item.mimeType, item.mimetype) || undefined,
    fileName: pickString(file.fileName, item.fileName, item.filename) || undefined,
    contentBase64: pickString(item.contentBase64, item.mediaBase64, item.base64) || undefined,
    fileUrl: pickString(file.downloadUrl, item.fileUrl, item.downloadUrl, item.url, item.mediaUrl) || undefined,
    mediaId: pickString(item.mediaId, item.idMessage, item.providerMessageId) || undefined,
    jpegThumbnail: pickString(file.jpegThumbnail, item.jpegThumbnail, item.thumbnail) || undefined,
  };
}

export function historyMediaFingerprint(item: HistoryMediaItem) {
  if (!item.type && !item.fileName && !item.fileUrl && !item.contentBase64 && !item.mediaId && !item.jpegThumbnail) {
    return "";
  }
  const thumb = item.contentBase64 || item.jpegThumbnail || "";
  return [item.type || "", item.fileName || "", item.mediaId || item.fileUrl || "", thumb.slice(0, 48)].join("|");
}

export async function attachHistoryMedia(
  prisma: PrismaClient,
  tenantId: string,
  messageId: string,
  item: HistoryMediaItem,
) {
  try {
    if (item.contentBase64) {
      await storeMessageAttachment(prisma, {
        tenantId,
        messageId,
        fileName: item.fileName || defaultMediaName(item),
        mimeType: item.mimeType || "",
        buffer: decodeBase64Payload(item.contentBase64),
        sendState: "inbound",
      });
      return true;
    }
    if (item.fileUrl) {
      const remote = await fetchRemoteMedia(item.fileUrl);
      await storeMessageAttachment(prisma, {
        tenantId,
        messageId,
        fileName: item.fileName || remote.fileName,
        mimeType: item.mimeType || remote.mimeType,
        buffer: remote.buffer,
        sendState: "inbound",
      });
      return true;
    }
    if (item.jpegThumbnail) {
      await storeMessageAttachment(prisma, {
        tenantId,
        messageId,
        fileName: item.fileName || "photo.jpg",
        mimeType: "image/jpeg",
        buffer: decodeBase64Payload(item.jpegThumbnail),
        sendState: "inbound",
      });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function defaultMediaName(item: HistoryMediaItem) {
  const kind = conversationMediaKind(item.mimeType, item.type);
  if (kind === "image") return "photo.jpg";
  if (kind === "video") return "video.mp4";
  if (kind === "audio") return "audio.ogg";
  return "file.bin";
}

export function historyMessageType(item: HistoryMediaItem) {
  const fromMime = conversationMediaKind(item.mimeType, item.type);
  if (fromMime !== "text") return fromMime;
  return inferKindFromText(item.content) || "text";
}

export function historyMessageText(item: HistoryMediaItem) {
  const text = String(item.content || "").trim();
  if (text && !looksLikeMediaPlaceholder(text)) return text;
  const kind = historyMessageType(item);
  if (kind !== "text") return text || mediaPreviewLabel(kind);
  return text;
}
