import assert from "node:assert/strict";
import { after, afterEach, before, it, mock } from "node:test";
import { createPrismaClient, type Prisma } from "@creolab/db";
import { claimScheduledAction, recoverInterruptedScheduledActions } from "./services/scheduledActionLease.ts";
import { authForScheduledTask, processScheduledTask, recoverDueScheduledTaskSends } from "./services/scheduledTaskRunner.ts";
import { processDueScheduledActions } from "./services/backgroundJobs.ts";
import { hashExecutionContent } from "./services/messagingProvider.ts";
import { executeTaskBatch } from "./services/aiCommandExecutionService.ts";
import { WhatsAppSellerBridge } from "@creolab/integrations";
import { encryptSecret } from "./lib/secretBox.ts";
import { createStaffNotification, deliverPendingPush } from "./services/notificationService.ts";
import webpush from "web-push";
import { scheduleConfirmedTaskSend } from "./services/taskExecutionService.ts";

let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
let tenantId = "", userId = "", membershipId = "";
before(async () => {
  assert.equal(process.env.CRM_USE_PGLITE, "1", "Use isolated test databases");
  prisma = await createPrismaClient();
  await (await import("../../../packages/db/src/seed.ts")).seedDatabase();
  const membership = await prisma.membership.findFirstOrThrow({ where: { user: { email: "owner@creolab.example" } } });
  ({ tenantId, userId } = membership); membershipId = membership.id;
});
afterEach(async () => {
  mock.restoreAll();
  await prisma.scheduledAction.deleteMany({ where: { tenantId } });
  await prisma.task.updateMany({ where: { tenantId, title: { startsWith: "Queue test" } }, data: { status: "canceled" } });
});
after(async () => { await prisma?.$disconnect(); });

async function fixture(extra: Partial<Prisma.TaskUncheckedCreateInput> = {}) {
  const task = await prisma.task.create({ data: {
    tenantId, type: "message", title: "Queue test", ownerMembershipId: membershipId,
    executionStatus: "scheduled", commandStatus: "scheduled", dueAt: new Date(Date.now() - 300_000), ...extra,
  } });
  const action = await prisma.scheduledAction.create({ data: {
    tenantId, type: task.targetType === "group" ? "task_batch_run" : "task_run", parentType: "task", parentId: task.id,
    dueAt: task.dueAt!, payloadJson: { confirmedById: userId },
  } });
  return { task, action };
}

async function confirm(taskId: string, confirmedById = userId) {
  const contact = await prisma.contact.create({ data: { tenantId, name: "Queue test client" } });
  const conversation = await prisma.conversation.create({ data: { tenantId, contactId: contact.id, sellerLeadId: `queue-${taskId}` } });
  const text = "Подтверждённый текст";
  await prisma.task.update({ where: { id: taskId }, data: { contactId: contact.id, conversationId: conversation.id, messageDraft: text } });
  return prisma.executionConfirmation.create({ data: {
    tenantId, taskId, confirmedById, contactId: contact.id, conversationId: conversation.id,
    channel: "whatsapp", destination: "77000000000", messageSnapshot: text,
    contentHash: hashExecutionContent({ contactId: contact.id, conversationId: conversation.id, message: text, attachments: [] }),
  } });
}
const getAction = (id: string) => prisma.scheduledAction.findUniqueOrThrow({ where: { id } });

it("overdue jobs have one owner and stay claimed while the handler is still running", async () => {
  const { action } = await fixture();
  const claims = await Promise.all(Array.from({ length: 8 }, () => claimScheduledAction(prisma, action)));
  const leases = claims.filter(lease => lease !== null);
  try {
    assert.equal(leases.length, 1);
    await recoverInterruptedScheduledActions(prisma);
    await recoverDueScheduledTaskSends(prisma);
    const current = await getAction(action.id);
    assert.equal(current.state, "running");
    assert.equal(current.dueAt.getTime(), action.dueAt.getTime(), "Preserve the requested due date");
    assert.equal(await claimScheduledAction(prisma, current), null);
  } finally { for (const lease of leases) await lease.stop(); }
});

it("renews long-running work without overwriting its payload", async () => {
  const { action } = await fixture();
  let heartbeat!: () => void;
  const timer = mock.method(globalThis, "setInterval", (callback: () => void) => { heartbeat = callback; return { unref() {} } as any; });
  const lease = await claimScheduledAction(prisma, action);
  timer.mock.restore(); assert.ok(lease);
  try {
    const first = (await getAction(action.id)).payloadJson as any;
    mock.method(Date, "now", () => first._leaseUntil - 30_000);
    heartbeat(); await lease.stop();
    const renewed = await getAction(action.id);
    assert.equal((renewed.payloadJson as any)._leaseUntil, first._leaseUntil + 60_000);
    assert.equal((renewed.payloadJson as any).confirmedById, userId);
    assert.equal(renewed.state, "running");
  } finally { await lease.stop(); }
});

it("interrupted sends require reconciliation instead of being sent again", async () => {
  const { task, action } = await fixture();
  await prisma.scheduledAction.update({ where: { id: action.id }, data: { state: "running", payloadJson: { _leaseUntil: Date.now() - 1000 } } });
  await recoverInterruptedScheduledActions(prisma);
  await recoverDueScheduledTaskSends(prisma);
  assert.equal((await getAction(action.id)).state, "failed");
  assert.match((await getAction(action.id)).cancelReason!, /Проверьте результат/);
  assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).executionStatus, "failed");
  assert.equal(await prisma.scheduledAction.count({ where: { parentId: task.id } }), 1);
  const notice = await prisma.notification.findFirstOrThrow({ where: { tenantId, episodeKey: `task.send_failed:${action.id}` } });
  assert.equal(notice.entityId, task.id);
  assert.equal(notice.recipientMembershipId, membershipId);
  await recoverInterruptedScheduledActions(prisma);
  assert.equal(await prisma.notification.count({ where: { tenantId, episodeKey: notice.episodeKey } }), 1);
});

it("legacy running sends are not blindly replayed, while status polls and reminders recover", async () => {
  const { action } = await fixture();
  await prisma.scheduledAction.update({ where: { id: action.id }, data: { state: "running" } });
  const safe = await Promise.all(["esf_status_poll", "agreement_reminder_60"].map(type => prisma.scheduledAction.create({ data: {
    tenantId, type, parentType: "test", parentId: "test", dueAt: action.dueAt, state: "running", payloadJson: { _leaseUntil: Date.now() - 1000 },
  } })));
  await recoverInterruptedScheduledActions(prisma);
  assert.equal((await getAction(action.id)).state, "failed");
  for (const row of safe) assert.equal((await getAction(row.id)).state, "scheduled");
});

it("does not manufacture confirmation when a planned message was edited or never confirmed", async () => {
  for (const previouslyConfirmed of [false, true]) {
    const { task, action } = await fixture();
    if (previouslyConfirmed) {
      const confirmation = await confirm(task.id);
      await prisma.executionConfirmation.update({ where: { id: confirmation.id }, data: { voidedAt: new Date() } });
    }
    const before = await prisma.executionConfirmation.count({ where: { taskId: task.id } });
    await assert.rejects(processScheduledTask(prisma, action), /Подтверждение отправки/);
    assert.equal(await prisma.executionConfirmation.count({ where: { taskId: task.id } }), before);
    assert.equal((await getAction(action.id)).state, "failed");
    assert.equal(await prisma.message.count({ where: { conversation: { sellerLeadId: `queue-${task.id}` } } }), 0);
  }
});

it("does not borrow the owner's authority when the confirming employee has lost access", async () => {
  assert.ok(await authForScheduledTask(prisma, tenantId, userId));
  await assert.rejects(authForScheduledTask(prisma, tenantId, "departed-employee"), /больше не имеет доступа/);
  await assert.rejects(authForScheduledTask(prisma, tenantId), /больше не имеет доступа/);
  const { task, action } = await fixture();
  await confirm(task.id, "departed-employee");
  await assert.rejects(processScheduledTask(prisma, { ...action, payloadJson: { confirmedById: "departed-employee" } }), /больше не имеет доступа/);
  assert.equal((await getAction(action.id)).state, "failed");
});

it("recovers a missing queue entry only once across overlapping workers, excluding batch children", async () => {
  const { task, action } = await fixture();
  await prisma.scheduledAction.delete({ where: { id: action.id } });
  const child = await prisma.task.create({ data: { tenantId, type: "message", title: "Queue test child", parentTaskId: task.id,
    executionStatus: "scheduled", commandStatus: "scheduled", dueAt: task.dueAt } });
  await Promise.all([recoverDueScheduledTaskSends(prisma), recoverDueScheduledTaskSends(prisma)]);
  assert.equal(await prisma.scheduledAction.count({ where: { parentId: task.id } }), 1);
  assert.equal(await prisma.scheduledAction.count({ where: { parentId: child.id } }), 0);
});

it("concurrent scheduling requests leave only one active queue entry", async () => {
  const { task } = await fixture({ dueAt: new Date(Date.now() + 3600_000) });
  await confirm(task.id);
  const auth = await authForScheduledTask(prisma, tenantId, userId);
  await Promise.all(Array.from({ length: 6 }, () => scheduleConfirmedTaskSend(prisma, auth, task.id)));
  assert.equal(await prisma.scheduledAction.count({ where: { parentId: task.id, state: "scheduled" } }), 1);
});

it("an unsuccessful send is recorded as failed, not completed or automatically retried", async () => {
  const { task, action } = await fixture();
  await confirm(task.id);
  // No provider is configured in the isolated test database.
  const result = await processScheduledTask(prisma, action);
  assert.equal("success" in result && result.success, false);
  assert.equal((await getAction(action.id)).state, "failed");
  await recoverDueScheduledTaskSends(prisma);
  assert.equal((await getAction(action.id)).state, "failed");
  assert.equal(await prisma.notification.count({ where: { tenantId, entityId: task.id, type: "task.send_failed" } }), 1);
});

it("scheduled batch execution preserves revoked confirmations instead of confirming on behalf of the user", async () => {
  const { task } = await fixture({ targetType: "group" });
  const child = await prisma.task.create({ data: { tenantId, type: "message", title: "Queue test child", parentTaskId: task.id, ownerMembershipId: membershipId } });
  const confirmation = await confirm(child.id);
  await prisma.executionConfirmation.update({ where: { id: confirmation.id }, data: { voidedAt: new Date() } });
  const auth = await authForScheduledTask(prisma, tenantId, userId);
  const result = await executeTaskBatch(prisma, auth, task.id, { runScheduled: true });
  assert.equal(result.failed, 1);
  assert.equal(await prisma.executionConfirmation.count({ where: { taskId: child.id } }), 1);
  assert.equal(await prisma.message.count({ where: { conversation: { sellerLeadId: `queue-${child.id}` } } }), 0);
});

it("one invalid scheduled action cannot prevent the next action from being processed", async () => {
  const { action: invalid } = await fixture();
  const { action: next } = await fixture({ status: "done" });
  mock.method(console, "error", () => {});
  await processDueScheduledActions(prisma);
  assert.equal((await getAction(invalid.id)).state, "failed");
  assert.equal((await getAction(next.id)).state, "canceled");
});

it("overlapping background ticks send a confirmed message once and preserve its history", async () => {
  const { task, action } = await fixture();
  const confirmation = await confirm(task.id);
  const existing = await prisma.integration.findFirst({ where: { tenantId, type: "whatsapp_seller" } });
  const data = { status: "active", connectionStatus: "CONNECTED", schemaJson: { sellerUrl: "https://queue-test.invalid", secretEnc: encryptSecret("test-only") } };
  const integration = existing
    ? await prisma.integration.update({ where: { id: existing.id }, data })
    : await prisma.integration.create({ data: { tenantId, type: "whatsapp_seller", name: "Queue test", ...data } });
  let release!: () => void, entered!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  mock.method(WhatsAppSellerBridge.prototype, "setMode", async () => ({}));
  const send = mock.method(WhatsAppSellerBridge.prototype, "sendText", async () => { entered(); await pending; return {}; });
  const first = processDueScheduledActions(prisma);
  try {
    await Promise.race([started, first.then(() => { throw new Error("Provider was not invoked"); })]);
    await processDueScheduledActions(prisma);
    assert.equal(send.mock.callCount(), 1);
    assert.equal((await getAction(action.id)).state, "running");
    release(); await first;
    assert.equal((await getAction(action.id)).state, "done");
    assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status, "done");
    assert.equal(await prisma.executionConfirmation.count({ where: { taskId: task.id } }), 1);
    assert.equal(await prisma.message.count({ where: { conversationId: confirmation.conversationId, senderKind: "staff" } }), 1);
    await processDueScheduledActions(prisma);
    assert.equal(send.mock.callCount(), 1);
  } finally {
    release(); await first;
    if (existing) await prisma.integration.update({ where: { id: existing.id }, data: { status: existing.status, connectionStatus: existing.connectionStatus, schemaJson: existing.schemaJson! } });
    else await prisma.integration.delete({ where: { id: integration.id } });
  }
});

it("concurrent reminder writers create a single delivery for each notification channel", async () => {
  const notices = await Promise.all(Array.from({ length: 8 }, () => createStaffNotification(prisma, {
    tenantId, membershipId, type: "agreement.reminder", entityType: "agreement", entityId: "queue-test-meeting",
    title: "Встреча", body: "Через час", episodeKey: "queue-test-reminder", channels: ["in_app", "web_push"],
  })));
  assert.ok(notices[0]);
  assert.equal(new Set(notices.map(n => n?.id)).size, 1);
  for (const channel of ["in_app", "web_push"]) {
    assert.equal(await prisma.notificationDelivery.count({ where: { notificationId: notices[0].id, channel } }), 1);
  }
});

it("concurrent push workers deliver a notification once", async () => {
  const previousPublic = process.env.VAPID_PUBLIC_KEY, previousPrivate = process.env.VAPID_PRIVATE_KEY;
  process.env.VAPID_PUBLIC_KEY = "test-public"; process.env.VAPID_PRIVATE_KEY = "test-private";
  const notice = await createStaffNotification(prisma, {
    tenantId, membershipId, type: "agreement.reminder", entityType: "agreement", entityId: "queue-test-push",
    title: "Встреча", body: "Через час", episodeKey: "queue-test-push", channels: ["web_push"],
  });
  assert.ok(notice);
  const sub = await prisma.webPushSubscription.create({ data: { userId, environment: "test", endpoint: "https://push.invalid/queue-test", keysJson: { p256dh: "test", auth: "test" } } });
  mock.method(webpush, "setVapidDetails", () => {});
  const send = mock.method(webpush, "sendNotification", async () => ({ statusCode: 201, headers: {}, body: "" }));
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => deliverPendingPush(prisma, notice.id)));
    assert.equal(send.mock.callCount(), 1);
    assert.equal(results.reduce((total, result) => total + result.sent, 0), 1);
  } finally {
    await prisma.webPushSubscription.delete({ where: { id: sub.id } });
    if (previousPublic === undefined) delete process.env.VAPID_PUBLIC_KEY; else process.env.VAPID_PUBLIC_KEY = previousPublic;
    if (previousPrivate === undefined) delete process.env.VAPID_PRIVATE_KEY; else process.env.VAPID_PRIVATE_KEY = previousPrivate;
  }
});
