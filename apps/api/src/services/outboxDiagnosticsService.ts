import { z } from "zod";
import type { PrismaClient } from "@creolab/db";
import type { AuthContext } from "../lib/types.ts";
import { isCompanyAdminRole, requireCompanyAdmin, requireTenant } from "../lib/access.ts";
import { ApiError } from "../errors.ts";
import { canRetryOutbox, OUTBOX_MAX_ATTEMPTS } from "./outboxFailurePolicy.ts";

const labels: Record<string, string> = {
  "ai.action_run": "Подтверждённый план действий",
  "conversation.context": "Анализ переписки", "inquiry.automation": "Обработка заявки", "sales.reconcile": "Сопровождение сделки",
  "contract.signed": "Счёт после подписания договора", "avr.sent": "Проверка статуса АВР", "esf.sent": "Проверка статуса ЭСФ",
  "billing.email": "Письмо об оплате", "whatsapp.ai_reply": "Ответ ИИ", "channel.ai_reply": "Ответ ИИ",
  "whatsapp.cloud_send": "Доставка сообщения", "channel.send": "Доставка сообщения", "campaign.run": "Рассылка",
};
const explanations: Record<string, string> = {
  unknown_event_type: "Тип задания не поддерживается. Требуется проверка администратором сервиса.",
  invalid_payload: "В задании не хватает корректных данных. Требуется проверка администратором сервиса.",
  request_rejected: "Действие отклонено. Проверьте доступ и настройки.",
  prerequisite_pending: "Не завершилась предыдущая обработка.",
  mail_not_configured: "Не подключена отправка служебных писем.",
  mail_rejected: "Почтовый сервис отклонил письмо.",
  mail_rate_limited: "Почтовый сервис временно ограничил отправку.",
};
const pageSchema = z.object({ offset: z.coerce.number().int().min(0).max(1_000_000).default(0), limit: z.coerce.number().int().min(1).max(100).default(25) });
const retrySchema = z.object({ requestId: z.string().uuid(), confirmed: z.literal(true), failedAt: z.string().datetime() }).strict();

export async function listOutboxFailures(prisma: PrismaClient, auth: AuthContext, query: unknown = {}) {
  requireCompanyAdmin(auth);
  const { tenantId } = requireTenant(auth), { offset, limit } = pageSchema.parse(query);
  const where = { tenantId, processedAt: null, failedAt: { not: null } };
  const [rows, total, retrying] = await Promise.all([
    prisma.outboxEvent.findMany({ where, orderBy: [{ failedAt: "desc" }, { id: "asc" }], skip: offset, take: limit }),
    prisma.outboxEvent.count({ where }),
    prisma.outboxEvent.count({ where: { tenantId, processedAt: null, failedAt: null, failureKind: "retryable" } }),
  ]);
  return { total, retrying, offset, limit, maxAttempts: OUTBOX_MAX_ATTEMPTS, items: rows.map(row => ({
    id: row.id, label: labels[row.type] || "Неизвестное задание", failedAt: row.failedAt!.toISOString(),
    attempts: row.attempts, retryAttempts: row.retryAttempts, failureKind: row.failureKind,
    explanation: row.failureKind === "uncertain" ? "Результат внешней отправки неизвестен. Проверьте доставку в диалоге или у провайдера; автоматический повтор остановлен."
      : explanations[row.errorCode || ""] || "Не удалось завершить обработку за отведённое число попыток.",
    canRetry: canRetryOutbox(row),
  })) };
}

/** Reset only a reviewed, exhausted internal job. Never replay external sends. */
export async function retryOutboxFailure(prisma: PrismaClient, auth: AuthContext, id: string, body: unknown) {
  requireCompanyAdmin(auth);
  const { tenantId, id: membershipId } = requireTenant(auth), input = retrySchema.parse(body);
  return prisma.$transaction(async tx => {
    // Serialize this actor's retries (including a reused key targeting two jobs)
    // and recheck membership after the lock, before touching a queued operation.
    await tx.$queryRaw`SELECT id FROM "Membership" WHERE id = ${membershipId} AND "tenantId" = ${tenantId} AND "userId" = ${auth.user.id} FOR UPDATE`;
    const member = await tx.membership.findFirst({ where: { id: membershipId, tenantId, userId: auth.user.id, active: true, user: { status: "active" }, tenant: { status: "active" } } });
    if (!member || !isCompanyAdminRole(member.role)) throw new ApiError(403, "forbidden", "Недостаточно прав для повтора");
    await tx.$queryRaw`SELECT id FROM "OutboxEvent" WHERE id = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const row = await tx.outboxEvent.findFirst({ where: { id, tenantId } });
    if (!row) throw new ApiError(404, "not_found", "Задание не найдено");
    const key = { scope: "outbox.retry", actorKey: `${tenantId}:${auth.user.id}`, key: input.requestId };
    const requestHash = `${id}:${input.failedAt}`;
    const prior = await tx.idempotencyRecord.findUnique({ where: { scope_actorKey_key: key } });
    if (prior) {
      if (prior.requestHash !== requestHash) throw new ApiError(409, "idempotency_conflict", "Этот запрос уже использован для другого повтора");
      return { id, queued: true, reused: true };
    }
    if (row.processedAt || !canRetryOutbox(row) || row.failedAt?.toISOString() !== input.failedAt) {
      throw new ApiError(409, "retry_unavailable", "Повтор недоступен или состояние изменилось. Обновите список.");
    }
    await tx.auditEvent.create({ data: { tenantId, actorUserId: auth.user.id, action: "outbox.retry", entityType: "outbox", entityId: id,
      changesJson: { type: row.type, failureKind: row.failureKind, errorCode: row.errorCode, attempts: row.attempts, failedAt: input.failedAt }, correlationId: input.requestId } });
    await tx.outboxEvent.update({ where: { id }, data: { failedAt: null, failureKind: null, errorCode: null, retryAttempts: 0, availableAt: new Date() } });
    await tx.idempotencyRecord.create({ data: { ...key, requestHash, resultJson: { id, queued: true }, expiresAt: new Date(Date.now() + 30 * 86400000) } });
    return { id, queued: true, reused: false };
  });
}
