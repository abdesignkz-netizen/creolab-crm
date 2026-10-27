import type { PrismaClient } from "@creolab/db";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { ApiError } from "../errors.ts";
import { missingFileMessage } from "../lib/storage.ts";
import { resolveSellerBridge } from "./sellerLink.ts";

export function providerDefinitelyDidNotSend(error: unknown) {
  return error instanceof ApiError && ["feature_required", "bridge_unavailable", "bridge_changed", "file_missing", "file_empty", "file_changed", "bridge_rejected", "dispatch_canceled"].includes(error.code);
}

export function bridgeTargetKey(resolved: Awaited<ReturnType<typeof resolveSellerBridge>>) {
  return JSON.stringify([resolved.integration?.id || null, resolved.url, resolved.instanceId]);
}

function mapBridgeError(error: unknown, kind: "text" | "file"): never {
  const raw = error instanceof Error ? error.message : String(error || "unknown");
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError" || /aborted|timeout/i.test(raw)) {
    throw new ApiError(
      504,
      "bridge_timeout",
      kind === "file"
        ? "WhatsApp не подтвердил отправку файла. Проверьте переписку перед повтором."
        : "WhatsApp не подтвердил отправку сообщения. Проверьте переписку перед повтором.",
    );
  }
  if (error instanceof ApiError) throw error;
  // A remote 5xx, a broken response or a network error can follow acceptance.
  // Do not expose provider internals or claim that nothing was sent.
  throw new ApiError(502, "bridge_error", "WhatsApp не подтвердил отправку. Проверьте переписку перед повтором.");
}

function acceptedMessageId(value: unknown): string | null {
  if (!value || typeof value !== "object") throw new ApiError(502, "bridge_invalid_response", "WhatsApp не подтвердил отправку.");
  const reply = value as { ok?: boolean; idMessage?: string; error?: string };
  const messageId = typeof reply.idMessage === "string" ? reply.idMessage.trim() : null;
  if (reply.ok === false || reply.error || (reply.ok !== true && !messageId)) {
    throw new ApiError(502, "bridge_invalid_response", "WhatsApp не подтвердил отправку.");
  }
  return messageId || null;
}

export async function sendViaProvider(
  prisma: PrismaClient,
  tenantId: string,
  input: {
    sellerLeadId: string;
    text?: string;
    file?: {
      fileName: string;
      mimeType: string;
      contentBase64?: string;
      filePath?: string;
      checksum?: string | null;
      caption?: string;
    };
    idempotencyKey: string;
    expectedBridge?: string;
    beforeSend?: () => Promise<void>;
  },
) {
  const { canUseFeature } = await import("./entitlementService.ts");
  if (!(await canUseFeature(prisma, tenantId, "WHATSAPP"))) throw new ApiError(403, "feature_required", "WhatsApp не подключён к тарифу", undefined, { feature: "WHATSAPP", billingPath: "/billing" });
  const resolved = await resolveSellerBridge(prisma, tenantId);
  if (input.expectedBridge && input.expectedBridge !== bridgeTargetKey(resolved)) {
    throw new ApiError(409, "bridge_changed", "Подключение WhatsApp изменилось. Отправка остановлена.");
  }
  if (!resolved.bridge) {
    throw new ApiError(503, "bridge_unavailable", "WhatsApp seller-bot не подключён. Отправка невозможна.");
  }
  if (input.text) {
    await input.beforeSend?.();
    try {
      const result = await resolved.bridge.sendText(input.sellerLeadId, input.text, input.idempotencyKey);
      return { kind: "text" as const, providerMessageId: acceptedMessageId(result) };
    } catch (error) {
      mapBridgeError(error, "text");
    }
  }
  if (input.file) {
    let contentBase64 = input.file.contentBase64;
    if (!contentBase64 && input.file.filePath) {
      try {
        await access(input.file.filePath, fsConstants.R_OK);
        contentBase64 = (await readFile(input.file.filePath)).toString("base64");
      } catch {
        throw new ApiError(422, "file_missing", missingFileMessage());
      }
    }
    if (!contentBase64) throw new ApiError(422, "file_empty", "Файл пустой");
    if (input.file.checksum && createHash("sha256").update(Buffer.from(contentBase64, "base64")).digest("hex") !== input.file.checksum) {
      throw new ApiError(422, "file_changed", "Файл изменился после подтверждения. Отправка этого файла остановлена.");
    }
    await input.beforeSend?.();
    try {
      const result = await resolved.bridge.sendFile(input.sellerLeadId, {
        fileName: input.file.fileName,
        mimeType: input.file.mimeType,
        caption: input.file.caption,
        contentBase64,
        idempotencyKey: input.idempotencyKey,
      });
      return { kind: "file" as const, providerMessageId: acceptedMessageId(result) };
    } catch (error) {
      mapBridgeError(error, "file");
    }
  }
  throw new ApiError(422, "invalid", "Нечего отправлять");
}

export function hashExecutionContent(parts: {
  contactId?: string | null;
  inquiryId?: string | null;
  conversationId?: string | null;
  sellerLeadId?: string | null;
  message?: string | null;
  attachments: Array<{ id: string; checksum?: string | null; fileName: string; sizeBytes: number;
    originalFileName?: string | null; mimeType?: string; documentType?: string | null }>;
}) {
  const payload = JSON.stringify({
    contactId: parts.contactId || null,
    inquiryId: parts.inquiryId || null,
    conversationId: parts.conversationId || null,
    sellerLeadId: parts.sellerLeadId || null,
    message: parts.message || "",
    attachments: [...parts.attachments].sort((a, b) => a.id.localeCompare(b.id)).map((item) => ({
      id: item.id,
      checksum: item.checksum || null,
      fileName: item.fileName,
      sizeBytes: item.sizeBytes,
      originalFileName: item.originalFileName || item.fileName,
      mimeType: item.mimeType || null,
      documentType: item.documentType || null,
    })),
  });
  return createHash("sha256").update(payload).digest("hex");
}
