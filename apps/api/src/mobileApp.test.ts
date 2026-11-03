import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { createPrismaClient } from '@creolab/db';
import { createApp } from './app.ts';
import { resetRateLimits } from './lib/rateLimit.ts';
import { createStaffNotification } from './services/notificationService.ts';
import { processNativePush } from './services/nativePushService.ts';

describe('mobile release integration', () => {
  let db: Awaited<ReturnType<typeof createPrismaClient>>, server: any, base: string, owner: any, manager: any;
  let ownerCookie = '', managerCookie = '', mode = 'ok';
  const nativeFetch = globalThis.fetch;
  const calls: Array<{ path: string; body: any }> = [];
  const token = 'ExpoPushToken[test_device_0123456789]';
  async function request(path: string, method = 'GET', body?: unknown, cookie = ownerCookie, userAgent?: string) {
    const response = await nativeFetch(`${base}${path}`, { method, headers: { cookie, 'Content-Type': 'application/json', ...(userAgent ? { 'user-agent': userAgent } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual' });
    return { response, data: response.headers.get('content-type')?.includes('json') ? await response.json() : null };
  }
  before(async () => {
    db = await createPrismaClient(); await (await import('../../../packages/db/src/seed.ts')).seedDatabase();
    owner = await db.membership.findFirstOrThrow({ where: { user: { email: 'owner@creolab.example' }, tenant: { slug: 'creolab' } } });
    manager = await db.membership.findFirstOrThrow({ where: { user: { email: 'manager@creolab.example' }, tenantId: owner.tenantId } });
    server = await new Promise<any>(resolve => { const app = createApp(db).listen(0, '127.0.0.1', () => resolve(app)); });
    base = `http://127.0.0.1:${server.address().port}`;
    for (const email of ['owner@creolab.example', 'manager@creolab.example']) {
      const { response } = await request('/api/v1/auth/login', 'POST', { email, password: process.env.SEED_PASSWORD }, '');
      assert.equal(response.status, 200);
      const cookie = response.headers.get('set-cookie')!.split(';')[0];
      if (email.startsWith('owner')) ownerCookie = cookie; else managerCookie = cookie;
    }
    globalThis.fetch = async (input, init) => {
      const path = String(input);
      if (path.startsWith(base)) return nativeFetch(input, init);
      assert.ok(path.startsWith('https://exp.host/--/api/v2/push/'), 'Unexpected external request');
      const body = JSON.parse(String(init?.body)); calls.push({ path, body });
      if (mode === 'timeout') throw new Error('network failed');
      if (mode === 'unregistered') return Response.json({ data: { status: 'error', details: { error: 'DeviceNotRegistered' } } });
      return Response.json({ data: path.endsWith('getReceipts') ? { receipt: { status: 'ok' } } : { status: 'ok', id: 'receipt' } });
    };
  });
  beforeEach(async () => {
    resetRateLimits(); process.env.MOBILE_PUSH_ENABLED = '1'; mode = 'ok'; calls.length = 0;
    await db.notificationDelivery.deleteMany({ where: { channel: 'native_push' } });
    await db.deviceInstallation.deleteMany();
    await db.notificationPreference.deleteMany({ where: { membershipId: owner.id } });
  });
  after(async () => { globalThis.fetch = nativeFetch; delete process.env.MOBILE_PUSH_ENABLED;
    if (server) await new Promise<void>(resolve => server.close(() => resolve())); if (db) await db.$disconnect(); });
  async function register(cookie = ownerCookie) { const result = await request('/api/v1/me/mobile-devices', 'POST', { platform: 'ios', token }, cookie); assert.equal(result.response.status, 200, JSON.stringify(result.data)); }
  async function notice(options = {}) { return createStaffNotification(db, { tenantId: owner.tenantId, membershipId: owner.id, type: 'task.assigned', entityType: 'task', entityId: randomUUID(), title: 'Secret customer name', body: 'Private message +77000000000', ...options }); }
  it('requires authentication, validates tokens, and does not expose push secrets in config', async () => {
    assert.equal((await request('/api/v1/me/mobile-devices', 'POST', { token, platform: 'ios' }, '')).response.status, 401);
    assert.equal((await request('/api/v1/me/mobile-devices', 'POST', { token: 'https://attacker.example', platform: 'ios' })).response.status, 422);
    delete process.env.MOBILE_PUSH_ENABLED;
    const { data } = await request('/api/v1/mobile/config', 'GET', undefined, '');
    assert.deepEqual(data, { protocolVersion: 1, pushConfigured: false, accountMode: 'existing' });
    assert.equal((await request('/api/v1/me/mobile-devices', 'POST', { token, platform: 'ios' })).response.status, 503);
  });
  it('rebinds a device on account change and cannot disable another user device', async () => {
    await register(); await register(managerCookie);
    assert.equal(await db.deviceInstallation.count({ where: { token } }), 1);
    const device = await db.deviceInstallation.findFirstOrThrow({ where: { token } }); assert.equal(device.userId, manager.userId);
    await request('/api/v1/me/mobile-devices', 'DELETE', { token });
    assert.equal((await db.deviceInstallation.findUniqueOrThrow({ where: { id: device.id } })).active, true);
  });
  it('uses the existing queue exactly once, with generic content, and distinguishes acceptance from delivery', async () => {
    await register(); const item = await notice();
    assert.ok(item); assert.equal(await db.notificationDelivery.count({ where: { notificationId: item!.id, channel: 'native_push' } }), 1);
    await Promise.all([processNativePush(db), processNativePush(db)]);
    assert.equal(calls.length, 1); assert.ok(!JSON.stringify(calls).includes('Secret customer'));
    const delivery = await db.notificationDelivery.findFirstOrThrow({ where: { notificationId: item!.id, channel: 'native_push' } });
    assert.equal(delivery.state, 'accepted');
    await db.notificationDelivery.update({ where: { id: delivery.id }, data: { nextAttemptAt: new Date(0) } });
    await processNativePush(db);
    assert.equal((await db.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).state, 'delivered');
  });
  it('does not send internal-only or disabled-category notifications and respects quiet hours', async () => {
    await register(); await notice({ internalOnly: true }); assert.equal(await db.notificationDelivery.count({ where: { channel: 'native_push' } }), 0);
    await db.notificationPreference.create({ data: { tenantId: owner.tenantId, membershipId: owner.id, eventsJson: { tasks: false } } });
    await notice(); assert.equal(await db.notificationDelivery.count({ where: { channel: 'native_push' } }), 0);
    await db.notificationPreference.update({ where: { tenantId_membershipId: { tenantId: owner.tenantId, membershipId: owner.id } }, data: { eventsJson: {}, quietHoursJson: { enabled: true, start: '00:00', end: '23:59' } } });
    await notice(); await processNativePush(db); assert.equal(calls.length, 0);
  });
  it('keeps uncertain sends from being resent and removes invalid tokens', async () => {
    await register(); await notice(); mode = 'timeout'; await processNativePush(db); await processNativePush(db);
    assert.equal(calls.length, 1); assert.equal((await db.notificationDelivery.findFirstOrThrow({ where: { channel: 'native_push' } })).state, 'uncertain');
    await notice(); mode = 'unregistered'; await processNativePush(db);
    assert.equal((await db.deviceInstallation.findFirstOrThrow({ where: { token } })).active, false);
  });
  it('returns native OAuth to the original app without consuming state or transferring session credentials', async () => {
    const state = 'b'.repeat(64), key = createHash('sha256').update(state).digest('hex');
    const record = await db.idempotencyRecord.create({ data: { scope: 'google.oauth', actorKey: 'test-session', key, requestHash: owner.userId,
      resultJson: { nativeApp: true, tenantId: owner.tenantId }, expiresAt: new Date(Date.now() + 60000) } });
    const result = await request(`/api/v1/integrations/google/callback?state=${state}&code=test-code`, 'GET', undefined, '', 'Safari');
    assert.equal(result.response.status, 302);
    assert.equal(result.response.headers.get('location'), `basqar://oauth?provider=google&state=${state}&code=test-code`);
    assert.equal(result.response.headers.get('set-cookie'), null);
    assert.ok(await db.idempotencyRecord.findUnique({ where: { id: record.id } }));
    const app = await request(`/api/v1/integrations/google/callback?state=${state}&code=test-code`, 'GET', undefined, '', 'BasQarNative/1');
    assert.ok(!app.response.headers.get('location')?.startsWith('basqar:'), 'App callback must still require its original session');
  });
  it('creates one visible account-deletion request and never deletes company records', async () => {
    const before = await db.tenant.count();
    assert.equal((await request('/api/v1/me/account-deletion-request', 'POST', { confirm: false })).response.status, 422);
    const [a, b] = await Promise.all([request('/api/v1/me/account-deletion-request', 'POST', { confirm: true }), request('/api/v1/me/account-deletion-request', 'POST', { confirm: true })]);
    assert.equal(a.response.status, 200, JSON.stringify(a.data)); assert.equal(a.data.ticketId, b.data.ticketId);
    const ticket = await db.supportTicket.findUniqueOrThrow({ where: { id: a.data.ticketId }, include: { messages: true } });
    assert.equal(ticket.createdByUserId, owner.userId); assert.equal(ticket.sourceModule, 'account_deletion'); assert.equal(ticket.messages[0].senderType, 'USER');
    assert.equal(await db.tenant.count(), before); assert.ok(await db.user.findUnique({ where: { id: owner.userId } }));
  });
  it('opens notification destinations only for their active recipient, including after account switching', async () => {
    const item = await notice(); assert.ok(item);
    const path = `/api/v1/me/mobile-notifications/${item!.id}`;
    const own = await request(path);
    assert.equal(own.response.status, 200);
    assert.equal(own.data.tenantId, owner.tenantId);
    assert.ok(own.data.href.startsWith('/tasks'));
    assert.equal((await request(path, 'GET', undefined, managerCookie)).response.status, 404);
    assert.equal((await request(path, 'GET', undefined, '')).response.status, 401);
    await db.membership.update({ where: { id: owner.id }, data: { active: false } });
    try { assert.notEqual((await request(path)).response.status, 200); }
    finally { await db.membership.update({ where: { id: owner.id }, data: { active: true } }); }
  });
  it('revokes this device on logout', async () => {
    await register(); const result = await request('/api/v1/auth/logout', 'POST', { mobileDeviceToken: token });
    assert.equal(result.response.status, 200); assert.equal((await db.deviceInstallation.findFirstOrThrow({ where: { token } })).active, false);
  });
});
