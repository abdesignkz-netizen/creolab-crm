import type { Prisma, PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import { decryptSecret } from "../lib/secretBox.ts";

// Provider errors never include the request URL: Telegram embeds the bot token in it.
export async function telegramCall<T>(token: string, method: string, body: Record<string, unknown> | FormData = {}): Promise<T> {
  try {
    const multipart = body instanceof FormData;
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", headers: multipart ? undefined : { "Content-Type": "application/json" },
      body: multipart ? body : JSON.stringify(body), signal: AbortSignal.timeout(20000), redirect: "error",
    });
    const result = await response.json() as { ok: boolean; result: T; error_code?: number };
    if (!response.ok || result.ok !== true) throw new ApiError(502, "telegram_provider", `Telegram отклонил запрос (${result.error_code || response.status}). Проверьте токен и права бота.`, undefined, { definitelyNotSent: response.status < 500 && result.ok === false && [400, 401, 403, 404, 413, 429].includes(result.error_code || 0) });
    return result.result;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "telegram_unavailable", "Telegram не ответил. Результат отправки может быть неизвестен; проверьте диалог перед повтором.");
  }
}

export async function tokenFor(prisma: PrismaClient | Prisma.TransactionClient, tenantId: string, credentialId: string | null) {
  const credential = credentialId ? await prisma.credential.findFirst({ where: { id: credentialId, tenantId, kind: "telegram_bot" } }) : null;
  if (!credential) throw new ApiError(409, "telegram_disconnected", "Подключите Telegram-бота компании");
  return decryptSecret(credential.encryptedValue);
}

