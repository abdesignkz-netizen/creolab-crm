import assert from "node:assert/strict";
import { afterEach, it, mock } from "node:test";
import type { PrismaClient } from "@creolab/db";
import webpush from "web-push";
import { processOutbox } from "./services/backgroundJobs.ts";
import { deliverPendingPush } from "./services/notificationService.ts";

afterEach(() => mock.restoreAll());
it("failed outbox work remains pending and does not block the next event", async () => {
  const updates: any[] = [];
  let fail = true;
  const events = [
    { id: "retry", tenantId: "tenant", type: "inquiry.automation", attempts: 0, payloadJson: { tenantId: "tenant", inquiryId: "inquiry" } },
    { id: "next", tenantId: "tenant", type: "inquiry.automation", attempts: 0, payloadJson: {} },
  ];
  const prisma = {
    inquiry: { findFirst: async () => { if (fail) throw new Error("transient DB failure"); return null; } },
    outboxEvent: { findMany: async () => events, update: async (input: any) => { updates.push(input); return input; } },
  } as unknown as PrismaClient;
  mock.method(console, "error", () => {});
  await processOutbox(prisma);
  const retry = updates.find(row => row.where.id === "retry");
  assert.equal(retry.data.processedAt, undefined);
  assert.ok(retry.data.availableAt.getTime() > Date.now());
  assert.equal(retry.data.attempts.increment, 1);
  assert.ok(updates.find(row => row.where.id === "next").data.processedAt instanceof Date);
  updates.length = 0; fail = false;
  await processOutbox(prisma);
  assert.ok(updates.find(row => row.where.id === "retry").data.processedAt instanceof Date);
});

it("uses the actual CommonJS web-push methods without sending a real notification", async () => {
  const previousPublic = process.env.VAPID_PUBLIC_KEY;
  const previousPrivate = process.env.VAPID_PRIVATE_KEY;
  process.env.VAPID_PUBLIC_KEY = "test-public";
  process.env.VAPID_PRIVATE_KEY = "test-private";
  const send = mock.method(webpush, "sendNotification", async () => ({ statusCode: 201, headers: {}, body: "" }));
  mock.method(webpush, "setVapidDetails", () => {});
  const updates: any[] = [];
  const prisma = {
    notification: { findFirst: async () => ({ recipient: { userId: "user" }, title: "Test", body: "Test", deliveries: [{ id: "delivery", channel: "web_push", state: "created" }] }) },
    webPushSubscription: { findMany: async () => [{ endpoint: "https://push.invalid", keysJson: { p256dh: "test", auth: "test" } }] },
    notificationDelivery: { update: async (input: any) => { updates.push(input); } },
  } as unknown as PrismaClient;
  try {
    assert.deepEqual(await deliverPendingPush(prisma, "notification"), { attempted: 1, sent: 1 });
    assert.equal(send.mock.callCount(), 1);
    assert.equal(updates.at(-1).data.state, "delivered");
  } finally {
    if (previousPublic === undefined) delete process.env.VAPID_PUBLIC_KEY; else process.env.VAPID_PUBLIC_KEY = previousPublic;
    if (previousPrivate === undefined) delete process.env.VAPID_PRIVATE_KEY; else process.env.VAPID_PRIVATE_KEY = previousPrivate;
  }
});
