import type { PrismaClient } from "@creolab/db";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { resolveSellerBridge } from "./sellerLink.ts";

function mapBridgeError(error: unknown, kind: "text" | "file"): never {
  const raw = error instanceof Error ? error.message : String(error || "unknown");
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError" || /aborted|timeout/i.test(raw)) {
    throw new ApiError(
      504,
      "bridge_timeout",
      kind === "file"
        ? "Таймаут отправки файла в WhatsApp. Текст мог уйти — нажмите «Повторить отправку файла»."
        : "Таймаут отправки сообщения в WhatsApp. Повторите попытку.",
    );
  }
  if (/ENOENT|no such file|не найден/i.test(raw)) {
    throw new ApiError(422, "file_missing", "Файл не найден на сервере. Прикрепите КП заново и повторите отправку.");
  }
  if (error instanceof ApiError) throw error;
  throw new ApiError(502, "bridge_error", raw || "Ошибка WhatsApp-моста");
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
      caption?: string;
    };
    idempotencyKey: string;
  },
) {
  const resolved = await resolveSellerBridge(prisma, tenantId);
  if (!resolved.bridge) {
    throw new ApiError(503, "bridge_unavailable", "WhatsApp seller-bot не подключён. Отправка невозможна.");
  }
  if (input.text) {
    try {
      await resolved.bridge.sendText(input.sellerLeadId, input.text, input.idempotencyKey);
    } catch (error) {
      mapBridgeError(error, "text");
    }
    return { kind: "text" as const, providerMessageId: null as string | null };
  }
  if (input.file) {
    let contentBase64 = input.file.contentBase64;
    if (!contentBase64 && input.file.filePath) {
      try {
        await access(input.file.filePath, fsConstants.R_OK);
      } catch {
        throw new ApiError(
          422,
          "file_missing",
          "Файл не найден на сервере. Прикрепите КП заново и повторите отправку.",
        );
      }
      contentBase64 = (await readFile(input.file.filePath)).toString("base64");
    }
    if (!contentBase64) throw new ApiError(422, "invalid", "Файл пустой");
    try {
      const result = await resolved.bridge.sendFile(input.sellerLeadId, {
        fileName: input.file.fileName,
        mimeType: input.file.mimeType,
        caption: input.file.caption,
        contentBase64,
        idempotencyKey: input.idempotencyKey,
      });
      return { kind: "file" as const, providerMessageId: result.idMessage || null };
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
  message?: string | null;
  attachments: Array<{ id: string; checksum?: string | null; fileName: string; sizeBytes: number }>;
}) {
  const payload = JSON.stringify({
    contactId: parts.contactId || null,
    inquiryId: parts.inquiryId || null,
    conversationId: parts.conversationId || null,
    message: parts.message || "",
    attachments: parts.attachments.map((item) => ({
      id: item.id,
      checksum: item.checksum || null,
      fileName: item.fileName,
      sizeBytes: item.sizeBytes,
    })),
  });
  return createHash("sha256").update(payload).digest("hex");
}
