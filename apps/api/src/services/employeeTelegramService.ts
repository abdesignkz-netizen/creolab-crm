import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Prisma, PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import { config } from "../config.ts";
import { requireTenant } from "../lib/access.ts";
import type { AuthContext } from "../lib/types.ts";
import { EVENT_CATEGORY, inQuietHours } from "./notificationPolicy.ts";

export const EMPLOYEE_TELEGRAM_WEBHOOK = "/public/telegram/employee-notifications";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export function employeeTelegramConfig() {
  const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const username = (process.env.TELEGRAM_BOT_USERNAME || "").trim().replace(/^@/, "");
  const secret = (process.env.TELEGRAM_WEBHOOK_SECRET || "").trim();
  const base = (process.env.TELEGRAM_WEBHOOK_BASE_URL || config.apiBaseUrl).replace(/\/$/, "");
  const botId = token.split(":")[0];
  let publicHttps = false;
  try { const url = new URL(base); publicHttps = url.protocol === "https:" && !url.search && !url.hash && !url.username && !url.password; } catch { /* incomplete configuration */ }
  const configured = /^\d+:[A-Za-z0-9_-]+$/.test(token) && /^[A-Za-z0-9_]{5,32}$/.test(username)
    && /^[A-Za-z0-9_-]{32,256}$/.test(secret) && publicHttps;
  return { token, username, secret, botId, configured, webhookUrl: `${base}${EMPLOYEE_TELEGRAM_WEBHOOK}` };
}

class TelegramFailure extends Error {
  code: number;
  retryAfter: number;
  constructor(code: number, retryAfter = 0) { super(`telegram_${code}`); this.code = code; this.retryAfter = retryAfter; }
}

async function telegramCall(method: string, body: Record<string, unknown> = {}) {
  const settings = employeeTelegramConfig();
  if (!settings.configured) throw new ApiError(503, "telegram_not_configured", "Бот личных уведомлений ещё не настроен администратором сервиса.");
  // Never expose provider errors or token-bearing request URLs to clients/logs.
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${settings.token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: "error",
    });
  } catch { throw new TelegramFailure(0); }
  const result = await response.json().catch(() => null) as any;
  if (!response.ok || result?.ok !== true) throw new TelegramFailure(Number(result?.error_code) || response.status || 0, Number(result?.parameters?.retry_after) || 0);
  return result.result;
}

export async function ensureEmployeeTelegramWebhook() {
  const settings = employeeTelegramConfig();
  if (!settings.configured) throw new ApiError(503, "telegram_not_configured", "Бот личных уведомлений ещё не настроен администратором сервиса.");
  try {
    const me = await telegramCall("getMe");
    if (!me?.is_bot || String(me.id) !== settings.botId || String(me.username).toLowerCase() !== settings.username.toLowerCase()) {
      throw new ApiError(503, "telegram_bot_mismatch", "Имя бота уведомлений не соответствует токену. Обратитесь к администратору сервиса.");
    }
    const hook = await telegramCall("getWebhookInfo");
    if (hook.url && hook.url !== settings.webhookUrl) {
      throw new ApiError(409, "telegram_bot_in_use", "Этот бот уже используется другим подключением. Для личных уведомлений нужен отдельный бот.");
    }
    await telegramCall("setWebhook", { url: settings.webhookUrl, secret_token: settings.secret, allowed_updates: ["message", "my_chat_member"], drop_pending_updates: false });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "telegram_setup_failed", "Не удалось проверить бота уведомлений. Повторите попытку позже.");
  }
}

async function bindingLock(tx: Prisma.TransactionClient) {
  // Linking is rare. Serialize ownership changes across instances, including two
  // different employees attempting to claim the same private chat simultaneously.
  await tx.$executeRawUnsafe('LOCK TABLE "TelegramBinding" IN SHARE ROW EXCLUSIVE MODE');
}

export async function employeeTelegramStatus(prisma: PrismaClient, auth: AuthContext) {
  const membership = requireTenant(auth);
  const settings = employeeTelegramConfig();
  const binding = await prisma.telegramBinding.findFirst({ where: { userId: auth.user.id, revokedAt: null, botId: settings.botId }, orderBy: { connectedAt: "desc" } });
  const connected = Boolean(settings.configured && binding?.chatRef);
  const pending = !connected && settings.configured && Boolean(binding?.pendingTokenHash && binding.pendingExpiresAt && binding.pendingExpiresAt > new Date());
  const pref = await prisma.notificationPreference.findUnique({ where: { tenantId_membershipId: { tenantId: membership.tenantId, membershipId: membership.id } } });
  const last = await prisma.notificationDelivery.findFirst({ where: { channel: "telegram", tenantId: membership.tenantId, notification: { recipientMembershipId: membership.id } }, orderBy: { createdAt: "desc" }, select: { state: true, error: true, createdAt: true } });
  return {
    available: settings.configured, botConfigured: settings.configured, connected,
    connectionStatus: connected ? "CONNECTED" : pending ? "PENDING" : settings.configured ? "DISCONNECTED" : "NOT_CONFIGURED",
    healthLabel: connected ? "Подключено" : pending ? "Ожидает подтверждения" : settings.configured ? "Не подключено" : "Требуется настройка",
    botUsername: settings.configured ? settings.username : null,
    expiresAt: pending ? binding?.pendingExpiresAt : null,
    enabled: (pref?.channelsJson as any)?.telegram === true,
    lastDelivery: last,
    note: settings.configured ? null : "Бот личных уведомлений ещё не настроен администратором сервиса.",
  };
}

export async function beginEmployeeTelegramLink(prisma: PrismaClient, auth: AuthContext) {
  const membership = requireTenant(auth);
  const settings = employeeTelegramConfig();
  const companyBot = await prisma.integration.findUnique({ where: { publicKey: `telegram-bot:${settings.botId}` } });
  if (companyBot && companyBot.status !== "disabled") throw new ApiError(409, "telegram_bot_in_use", "Этот бот уже используется другим подключением. Для личных уведомлений нужен отдельный бот.");
  await ensureEmployeeTelegramWebhook();
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  await prisma.$transaction(async tx => {
    await bindingLock(tx);
    const connected = await tx.telegramBinding.findFirst({ where: { userId: auth.user.id, botId: settings.botId, revokedAt: null, chatRef: { not: "" } } });
    if (connected) throw new ApiError(409, "telegram_already_connected", "Telegram уже подключён. Для смены аккаунта сначала отключите его.");
    await tx.telegramBinding.updateMany({ where: { userId: auth.user.id, revokedAt: null }, data: { revokedAt: new Date(), pendingTokenHash: null, pendingExpiresAt: null } });
    await tx.telegramBinding.create({ data: { userId: auth.user.id, botId: settings.botId, chatRef: "", pendingTokenHash: digest(token), pendingExpiresAt: expiresAt } });
    const pref = await tx.notificationPreference.findUnique({ where: { tenantId_membershipId: { tenantId: membership.tenantId, membershipId: membership.id } } });
    const channels = { ...((pref?.channelsJson as Record<string, boolean>) || {}), telegram: true };
    await tx.notificationPreference.upsert({ where: { tenantId_membershipId: { tenantId: membership.tenantId, membershipId: membership.id } }, update: { channelsJson: channels }, create: { tenantId: membership.tenantId, membershipId: membership.id, channelsJson: channels } });
  });
  return { deepLink: `https://t.me/${settings.username}?start=${token}`, expiresAt };
}

export async function disconnectEmployeeTelegram(prisma: PrismaClient, auth: AuthContext) {
  requireTenant(auth);
  await prisma.$transaction(async tx => {
    await bindingLock(tx);
    await tx.telegramBinding.updateMany({ where: { userId: auth.user.id, revokedAt: null }, data: { revokedAt: new Date(), pendingTokenHash: null, pendingExpiresAt: null } });
  });
  return employeeTelegramStatus(prisma, auth);
}

export async function testEmployeeTelegram(prisma: PrismaClient, auth: AuthContext) {
  const membership = requireTenant(auth);
  const status = await employeeTelegramStatus(prisma, auth);
  if (!status.connected || !status.enabled) throw new ApiError(409, "telegram_not_connected", "Подключите Telegram и включите уведомления для этой компании.");
  await ensureEmployeeTelegramWebhook();
  // A deterministic time bucket prevents double-clicks from sending duplicates.
  const { createStaffNotification } = await import("./notificationService.ts");
  const notification = await createStaffNotification(prisma, {
    tenantId: membership.tenantId, membershipId: membership.id, type: "telegram.test",
    entityType: "notification_test", entityId: membership.id,
    title: "Проверка Telegram", body: "Проверочное уведомление из BasQar.",
    episodeKey: `telegram.test:${Math.floor(Date.now() / 60_000)}`,
  });
  return { queued: Boolean(notification), note: "Проверка поставлена в очередь. В тихие часы уведомление придёт позже." };
}

export async function handleEmployeeTelegramWebhook(prisma: PrismaClient, secret: string, update: any) {
  const settings = employeeTelegramConfig();
  if (!settings.configured || !timingSafeEqual(Buffer.from(digest(secret)), Buffer.from(digest(settings.secret)))) throw new ApiError(403, "telegram_webhook_forbidden", "Доступ запрещён");
  const message = update?.message;
  const member = update?.my_chat_member;
  const chat = message?.chat || member?.chat;
  if (chat?.type !== "private" || !Number.isSafeInteger(chat.id) || chat.id <= 0) return { ok: true };
  const chatRef = String(chat.id);
  const blocked = member?.new_chat_member?.status === "kicked";
  if (blocked || /^\/stop(?:@\w+)?\s*$/i.test(message?.text || "")) {
    if (message && (message.from?.is_bot || message.from?.id !== chat.id)) return { ok: true };
    const eventAt = Number(message?.date || member?.date || 0) * 1000;
    await prisma.$transaction(async tx => {
      await bindingLock(tx);
      await tx.telegramBinding.updateMany({ where: { botId: settings.botId, chatRef, revokedAt: null, connectedAt: { lte: new Date(eventAt + 999) } }, data: { revokedAt: new Date(), pendingTokenHash: null, pendingExpiresAt: null } });
    });
    return blocked ? { ok: true } : { method: "sendMessage", chat_id: chat.id, text: "Личные уведомления BasQar отключены. Подключить их снова можно в настройках BasQar." };
  }
  if (!message || message.from?.is_bot || message.from?.id !== chat.id) return { ok: true };
  const start = String(message.text || "").match(/^\/start(?:@\w+)? ([A-Za-z0-9_-]{32})\s*$/);
  if (!start) return { method: "sendMessage", chat_id: chat.id, text: "Откройте BasQar → Настройки → Уведомления → Подключить Telegram. Для отключения отправьте /stop." };
  const linked = await prisma.$transaction(async tx => {
    await bindingLock(tx);
    const pending = await tx.telegramBinding.findFirst({ where: { pendingTokenHash: digest(start[1]), botId: settings.botId, revokedAt: null, pendingExpiresAt: { gt: new Date() }, user: { status: "active", memberships: { some: { active: true, tenant: { status: "active" } } } } } });
    if (!pending) return false;
    const other = await tx.telegramBinding.findFirst({ where: { botId: settings.botId, chatRef, revokedAt: null, userId: { not: pending.userId } } });
    if (other) return false;
    await tx.telegramBinding.update({ where: { id: pending.id }, data: { chatRef, connectedAt: new Date(), pendingTokenHash: null, pendingExpiresAt: null } });
    return true;
  });
  return { method: "sendMessage", chat_id: chat.id, text: linked
    ? "Telegram подключён к BasQar. Здесь будут личные уведомления о работе. Категории и тихие часы — в настройках BasQar. Отключить: /stop."
    : "Ссылка недействительна или этот Telegram уже подключён к другому аккаунту. Создайте новую ссылку в настройках BasQar." };
}

export async function queueEmployeeTelegram(prisma: PrismaClient | Prisma.TransactionClient, notification: { id: string; tenantId: string }, userId: string) {
  const settings = employeeTelegramConfig();
  if (!settings.configured) return;
  const binding = await prisma.telegramBinding.findFirst({ where: { userId, botId: settings.botId, revokedAt: null, chatRef: { not: "" } } });
  if (!binding) return;
  await prisma.notificationDelivery.upsert({ where: { id: `telegram:${notification.id}` }, update: {}, create: {
    id: `telegram:${notification.id}`, tenantId: notification.tenantId, notificationId: notification.id,
    channel: "telegram", deviceId: binding.id, state: "created",
  } });
}

export async function processEmployeeTelegramQueue(prisma: PrismaClient) {
  if (!employeeTelegramConfig().configured) return;
  // sendMessage has no idempotency key. Never resend a request whose result is
  // unknown after a crash/timeout; make that condition visible in the UI.
  await prisma.notificationDelivery.updateMany({ where: { channel: "telegram", state: "sending", claimedAt: { lt: new Date(Date.now() - 60_000) } }, data: { state: "uncertain", error: "telegram_delivery_unknown" } });
  const due = await prisma.notificationDelivery.findMany({ where: { channel: "telegram", state: "created", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] }, orderBy: { createdAt: "asc" }, take: 20 });
  for (const item of due) {
    const claim = await prisma.notificationDelivery.updateMany({ where: { id: item.id, state: "created", attempts: item.attempts }, data: { state: "sending", claimedAt: new Date(), attempts: { increment: 1 } } });
    if (!claim.count) continue;
    const notice = await prisma.notification.findUnique({ where: { id: item.notificationId }, include: { recipient: { include: { user: true } }, tenant: true } });
    const binding = item.deviceId ? await prisma.telegramBinding.findUnique({ where: { id: item.deviceId } }) : null;
    const pref = notice ? await prisma.notificationPreference.findUnique({ where: { tenantId_membershipId: { tenantId: item.tenantId, membershipId: notice.recipientMembershipId } } }) : null;
    const category = notice ? EVENT_CATEGORY[notice.type] : null;
    const skip = !notice || notice.tenantId !== item.tenantId || !notice.recipient.active || notice.recipient.user.status !== "active" || notice.tenant.status !== "active"
      || !binding || binding.revokedAt || !binding.chatRef || binding.botId !== employeeTelegramConfig().botId || binding.userId !== notice.recipient.userId
      || (pref?.channelsJson as any)?.telegram !== true || (category && (pref?.eventsJson as any)?.[category] === false)
      || (category === "management" && notice.recipient.role === "manager") || notice.readAt || notice.resolvedAt;
    if (skip) {
      await prisma.notificationDelivery.update({ where: { id: item.id }, data: { state: "skipped", error: "telegram_recipient_unavailable" } }); continue;
    }
    if (inQuietHours(pref?.quietHoursJson as any, notice.recipient.user.timezone)) {
      await prisma.notificationDelivery.update({ where: { id: item.id }, data: { state: "created", nextAttemptAt: new Date(Date.now() + 60_000), attempts: item.attempts, claimedAt: null } }); continue;
    }
    try {
      // Minimal preview: no customer messages, phone numbers, or contact names in Telegram.
      const result = await telegramCall("sendMessage", { chat_id: binding.chatRef,
        text: `BasQar · ${notice.tenant.name}\n${({ new_inquiries: "Новая заявка", assignment: "Новое назначение", dialogs: "Обновление диалога", tasks: "Задача или напоминание", deals: "Обновление сделки", ai_events: "ИИ требуется помощь", management: "Требуется внимание администратора" } as Record<string, string>)[category || ""] || (notice.type === "telegram.test" ? "Проверочное уведомление" : "Новое рабочее уведомление")}\nОткройте BasQar, чтобы посмотреть подробности.`,
        reply_markup: { inline_keyboard: [[{ text: "Открыть BasQar", url: `${config.appBaseUrl}/settings?section=notifications` }]] },
      });
      if (!Number.isSafeInteger(result?.message_id)) throw new TelegramFailure(0);
      await prisma.notificationDelivery.update({ where: { id: item.id }, data: { state: "delivered", providerRef: String(result.message_id), error: null } });
    } catch (error) {
      const code = error instanceof TelegramFailure ? error.code : 0;
      const retry = code === 429 && item.attempts < 4;
      if (code === 403) await prisma.telegramBinding.updateMany({ where: { id: binding.id, revokedAt: null }, data: { revokedAt: new Date(), pendingTokenHash: null, pendingExpiresAt: null } });
      await prisma.notificationDelivery.update({ where: { id: item.id }, data: {
        state: retry ? "created" : code === 0 || code >= 500 ? "uncertain" : "failed",
        error: `telegram_${code || "delivery_unknown"}`,
        nextAttemptAt: retry ? new Date(Date.now() + Math.max(30, Math.min(86400, (error as TelegramFailure).retryAfter)) * 1000) : null,
      } });
    }
  }
}
