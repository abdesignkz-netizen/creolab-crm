import { createHash } from 'node:crypto';
import type { PrismaClient } from '@creolab/db';
import { z } from 'zod';
import type { AuthContext } from '../lib/types.ts';
import { ApiError } from '../errors.ts';
import { writeAudit } from '../lib/audit.ts';

export async function openMobileNotification(prisma: PrismaClient, auth: AuthContext, id: string) {
  const { notificationHref } = await import('./domainService.ts');
  const notice = await prisma.notification.findFirst({ where: { id, recipient: { userId: auth.user.id, active: true, tenant: { status: 'active' } } } });
  if (!notice) throw new ApiError(404, 'not_found', 'Уведомление недоступно для этого аккаунта.');
  const inquiry = notice.entityType === 'inquiry' ? await prisma.inquiry.findFirst({ where: { id: notice.entityId, tenantId: notice.tenantId }, select: { conversationId: true } }) : null;
  return { tenantId: notice.tenantId, href: notificationHref(notice.type, notice.entityType, notice.entityId, inquiry?.conversationId || undefined) };
}

export const mobilePushEnabled = () => process.env.MOBILE_PUSH_ENABLED === '1';
export const mobileTokenSchema = z.string().regex(/^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{10,200}\]$/);
const deviceSchema = z.object({ token: mobileTokenSchema, platform: z.enum(['ios', 'android']) });

export async function registerMobileDevice(prisma: PrismaClient, auth: AuthContext, input: unknown) {
  if (!mobilePushEnabled()) throw new ApiError(503, 'mobile_push_unconfigured', 'Push-уведомления ещё не настроены. Уведомления в BasQar доступны.');
  const data = deviceSchema.parse(input);
  await prisma.$transaction(async tx => {
    // A device may switch accounts; a token must not continue receiving the previous user's alerts.
    // Serialise on token across API processes without a new table or destructive migration.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${data.token}))`;
    await tx.deviceInstallation.deleteMany({ where: { token: data.token, userId: { not: auth.user.id } } });
    await tx.deviceInstallation.upsert({ where: { userId_token: { userId: auth.user.id, token: data.token } },
      create: { userId: auth.user.id, ...data, provider: 'expo', environment: process.env.NODE_ENV === 'production' ? 'production' : 'development' },
      update: { active: true, platform: data.platform, lastSeenAt: new Date() } });
  });
  return { ok: true };
}

export async function unregisterMobileDevice(prisma: PrismaClient, userId: string, input: unknown) {
  const { token } = z.object({ token: mobileTokenSchema }).parse(input);
  await prisma.deviceInstallation.updateMany({ where: { userId, token }, data: { active: false } });
  return { ok: true };
}

/** This initiates a tracked, human-verified deletion. It never deletes company records. */
export async function requestAccountDeletion(prisma: PrismaClient, auth: AuthContext, input: unknown) {
  z.object({ confirm: z.literal(true) }).parse(input);
  const ticket = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`account-deletion:${auth.user.id}`}))`;
    const existing = await tx.supportTicket.findFirst({ where: { createdByUserId: auth.user.id, sourceModule: 'account_deletion', status: { notIn: ['RESOLVED', 'CLOSED'] } }, orderBy: { createdAt: 'desc' } });
    if (existing) return existing;
    const membership = await tx.membership.findFirst({ where: { userId: auth.user.id }, orderBy: { createdAt: 'asc' } });
    if (!membership) throw new ApiError(409, 'company_required', 'Для этого аккаунта не найдена компания. Обратитесь к оператору через контакты в политике конфиденциальности.');
    const created = await tx.supportTicket.create({ data: { tenantId: membership.tenantId, createdByUserId: auth.user.id,
      subject: 'Запрос на удаление аккаунта и персональных данных', sourceRoute: '/account-deletion', sourceModule: 'account_deletion',
      contextJson: { requestKind: 'account_deletion', userId: auth.user.id, requestedAt: new Date().toISOString() },
      messages: { create: { senderUserId: auth.user.id, senderType: 'USER', content: 'Прошу удалить мой аккаунт BasQar и связанные персональные данные. Требуется проверить полномочия владельца и законные сроки хранения документов компании. Запрос не является удалением компании или её документов.' } } } });
    await writeAudit(tx, { actorUserId: auth.user.id, tenantId: membership.tenantId, action: 'account.deletion_requested', entityType: 'support_ticket', entityId: created.id });
    return created;
  });
  return { ok: true, ticketId: ticket.id, message: `Запрос №${ticket.number} зарегистрирован. Администратор сервиса проверит его и сообщит порядок и срок удаления через поддержку BasQar. Аккаунт пока не удалён.` };
}

/** An external OAuth browser does not share WKWebView cookies. Return its result to
 * the app, which replays the callback WITH its original cookie. No session/token
 * is transferred and the existing session-bound OAuth validation is unchanged. */
export async function mobileOAuthReturn(prisma: PrismaClient, provider: 'google' | 'instagram',
  query: Record<string, unknown>, userAgent: string): Promise<string | null> {
  if (userAgent.includes('BasQarNative/1')) return null;
  const state = typeof query.state === 'string' ? query.state : '';
  if (!/^[a-f0-9]{64}$/.test(state)) return null;
  const record = await prisma.idempotencyRecord.findFirst({ where: { scope: `${provider}.oauth`,
    key: createHash('sha256').update(state).digest('hex'), expiresAt: { gt: new Date() } } });
  if ((record?.resultJson as { nativeApp?: boolean } | null)?.nativeApp !== true) return null;
  const url = new URL('basqar://oauth'); url.searchParams.set('provider', provider); url.searchParams.set('state', state);
  for (const key of ['code', 'error']) {
    if (query[key] !== undefined && (typeof query[key] !== 'string' || (query[key] as string).length > 4096)) return null;
    if (query[key]) url.searchParams.set(key, query[key] as string);
  }
  if (!url.searchParams.has('code') && !url.searchParams.has('error')) return null;
  return url.href;
}
