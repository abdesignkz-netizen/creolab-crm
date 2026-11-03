import type { Prisma, PrismaClient } from '@creolab/db';
import { mobilePushEnabled } from './mobileAppService.ts';
import { EVENT_CATEGORY, inQuietHours } from './notificationPolicy.ts';

/** Reuses Notification + NotificationDelivery + DeviceInstallation; no parallel queue. */
export async function queueNativePush(prisma: PrismaClient | Prisma.TransactionClient,
  notification: { id: string; tenantId: string }, userId: string) {
  if (!mobilePushEnabled()) return;
  const devices = await prisma.deviceInstallation.findMany({ where: { userId, active: true, provider: 'expo', lastSeenAt: { gt: new Date(Date.now() - 30 * 86400000) } }, take: 20 });
  for (const device of devices) await prisma.notificationDelivery.upsert({
    where: { id: `native:${notification.id}:${device.id}` }, update: {},
    create: { id: `native:${notification.id}:${device.id}`, tenantId: notification.tenantId,
      notificationId: notification.id, deviceId: device.id, channel: 'native_push', state: 'created' },
  });
}

async function expoRequest(path: 'send' | 'getReceipts', body: unknown) {
  const response = await fetch(`https://exp.host/--/api/v2/push/${path}`, { method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', ...(process.env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`expo_http_${response.status}`);
  return response.json() as Promise<{ data?: any }>;
}

export async function processNativePush(prisma: PrismaClient) {
  if (!mobilePushEnabled()) return;
  const now = new Date();
  // A crashed send is uncertain. Do not blindly send the same push a second time.
  await prisma.notificationDelivery.updateMany({ where: { channel: 'native_push', state: 'sending', claimedAt: { lt: new Date(Date.now() - 120000) } }, data: { state: 'uncertain', error: 'send_interrupted' } });
  const rows = await prisma.notificationDelivery.findMany({ where: { channel: 'native_push', state: { in: ['created', 'accepted'] },
    OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }, take: 20, orderBy: { createdAt: 'asc' },
    include: { notification: { include: { recipient: { include: { user: true, tenant: true } } } } } });
  for (const row of rows) {
    const notice = row.notification;
    const member = notice.recipient;
    const device = row.deviceId ? await prisma.deviceInstallation.findFirst({ where: { id: row.deviceId, userId: member.userId, active: true, provider: 'expo' } }) : null;
    const skip = async (reason: string) => { await prisma.notificationDelivery.updateMany({ where: { id: row.id, state: row.state }, data: { state: 'skipped', error: reason } }); };
    if (!device || !member.active || member.tenant.status !== 'active' || notice.readAt) { await skip('recipient_unavailable'); continue; }
    if (row.state === 'accepted') {
      if (!row.providerRef || row.createdAt.getTime() < Date.now() - 86400000) { await skip('receipt_expired'); continue; }
      try {
        const result = await expoRequest('getReceipts', { ids: [row.providerRef] });
        const receipt = result.data?.[row.providerRef];
        if (!receipt) { await prisma.notificationDelivery.updateMany({ where: { id: row.id, state: 'accepted' }, data: { nextAttemptAt: new Date(Date.now() + 900000) } }); continue; }
        if (receipt.details?.error === 'DeviceNotRegistered') await prisma.deviceInstallation.updateMany({ where: { id: device.id, token: device.token }, data: { active: false } });
        await prisma.notificationDelivery.updateMany({ where: { id: row.id, state: 'accepted' }, data: { state: receipt.status === 'ok' ? 'delivered' : 'failed', error: receipt.status === 'ok' ? null : 'expo_receipt_error' } });
      } catch { await prisma.notificationDelivery.updateMany({ where: { id: row.id, state: 'accepted' }, data: { nextAttemptAt: new Date(Date.now() + 900000), error: 'receipt_unavailable' } }); }
      continue;
    }
    if (row.createdAt.getTime() < Date.now() - 86400000) { await skip('notification_expired'); continue; }
    const pref = await prisma.notificationPreference.findUnique({ where: { tenantId_membershipId: { tenantId: notice.tenantId, membershipId: member.id } } });
    const category = EVENT_CATEGORY[notice.type];
    if ((pref?.channelsJson as Record<string, boolean> | null)?.native_push === false ||
        (category && (pref?.eventsJson as Record<string, boolean> | null)?.[category] === false)) { await skip('preference_disabled'); continue; }
    if (inQuietHours(pref?.quietHoursJson as { enabled?: boolean; start?: string; end?: string }, member.user.timezone)) {
      await prisma.notificationDelivery.updateMany({ where: { id: row.id, state: 'created' }, data: { nextAttemptAt: new Date(Date.now() + 60000) } }); continue;
    }
    if (!(await prisma.notificationDelivery.updateMany({ where: { id: row.id, state: 'created' }, data: { state: 'sending', claimedAt: now, attempts: { increment: 1 } } })).count) continue;
    try {
      const result = await expoRequest('send', { to: device.token, title: 'BasQar', body: 'Есть новое уведомление. Откройте BasQar, чтобы посмотреть.',
        sound: 'default', channelId: 'basqar', ttl: 3600, data: { notificationId: notice.id, tenantId: notice.tenantId } });
      if (result.data?.details?.error === 'DeviceNotRegistered') await prisma.deviceInstallation.updateMany({ where: { id: device.id, token: device.token }, data: { active: false } });
      const accepted = result.data?.status === 'ok' && typeof result.data.id === 'string';
      await prisma.notificationDelivery.updateMany({ where: { id: row.id, state: 'sending' }, data: {
        state: accepted ? 'accepted' : 'failed', providerRef: accepted ? result.data.id : null,
        nextAttemptAt: accepted ? new Date(Date.now() + 900000) : null, error: accepted ? null : 'expo_rejected',
      } });
    } catch {
      await prisma.notificationDelivery.updateMany({ where: { id: row.id, state: 'sending' }, data: { state: 'uncertain', error: 'expo_result_unknown' } });
    }
  }
}
