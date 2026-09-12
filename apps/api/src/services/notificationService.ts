import type { Prisma, PrismaClient } from "@creolab/db";
import { randomUUID } from "node:crypto";

/** Shared in-app notification writer used by API and worker. */
export async function createStaffNotification(
  prisma: PrismaClient | Prisma.TransactionClient,
  args: {
    tenantId: string;
    membershipId: string | null | undefined;
    type: string;
    entityType: string;
    entityId: string;
    title: string;
    body: string;
    priority?: string;
    episodeKey?: string;
    channels?: Array<"in_app" | "web_push" | "email">;
  },
) {
  if (!args.membershipId) return null;
  const episodeKey = args.episodeKey || `${args.type}:${args.entityId}`;
  const notification = await prisma.notification.upsert({
    where: {
      tenantId_episodeKey_recipientMembershipId: {
        tenantId: args.tenantId,
        episodeKey,
        recipientMembershipId: args.membershipId,
      },
    },
    update: { title: args.title, body: args.body, priority: args.priority || "normal" },
    create: {
      tenantId: args.tenantId,
      episodeKey,
      recipientMembershipId: args.membershipId,
      type: args.type,
      priority: args.priority || "normal",
      entityType: args.entityType,
      entityId: args.entityId,
      title: args.title,
      body: args.body,
    },
  });

  const channels = args.channels || ["in_app"];
  for (const channel of channels) {
    const existing = await prisma.notificationDelivery.findFirst({
      where: { notificationId: notification.id, channel },
    });
    if (existing) continue;
    await prisma.notificationDelivery.create({
      data: {
        id: randomUUID(),
        tenantId: args.tenantId,
        notificationId: notification.id,
        channel,
        state: channel === "in_app" ? "delivered" : "created",
      },
    });
  }
  return notification;
}

/** Mark in-app notices for the opened conversation or inquiry so they do not stay «новое». */
export async function markRelatedStaffNotifications(
  prisma: PrismaClient | Prisma.TransactionClient,
  args: {
    tenantId: string;
    membershipId: string;
    conversationIds?: string[];
    inquiryIds?: string[];
  },
) {
  const conversationIds = [...new Set((args.conversationIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  const inquiryIds = [...new Set((args.inquiryIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (!conversationIds.length && !inquiryIds.length) return 0;

  const or: Prisma.NotificationWhereInput[] = [];
  if (conversationIds.length) {
    or.push({ entityType: "conversation", entityId: { in: conversationIds } });
    or.push({ type: { startsWith: "conversation." }, entityId: { in: conversationIds } });
    or.push({
      episodeKey: {
        in: conversationIds.flatMap((id) => [`conversation.needs_human:${id}`, `conversation:${id}`]),
      },
    });
  }
  if (inquiryIds.length) {
    or.push({ entityType: "inquiry", entityId: { in: inquiryIds } });
    or.push({ type: { startsWith: "inquiry." }, entityId: { in: inquiryIds } });
    or.push({
      episodeKey: { in: inquiryIds.flatMap((id) => [`inquiry.created:${id}`, `inquiry:${id}`]) },
    });
  }

  const result = await prisma.notification.updateMany({
    where: {
      tenantId: args.tenantId,
      recipientMembershipId: args.membershipId,
      readAt: null,
      OR: or,
    },
    data: { readAt: new Date(), resolvedAt: new Date() },
  });
  return result.count;
}

export async function deliverPendingPush(
  prisma: PrismaClient,
  notificationId: string,
): Promise<{ attempted: number; sent: number }> {
  const notification = await prisma.notification.findFirst({
    where: { id: notificationId },
    include: { recipient: { include: { user: true } }, deliveries: true },
  });
  if (!notification) return { attempted: 0, sent: 0 };

  const pushDelivery = notification.deliveries.find((d) => d.channel === "web_push" && d.state === "created");
  if (!pushDelivery) return { attempted: 0, sent: 0 };

  const subs = await prisma.webPushSubscription.findMany({
    where: { userId: notification.recipient.userId, state: "active" },
    take: 10,
  });
  if (!subs.length) {
    await prisma.notificationDelivery.update({
      where: { id: pushDelivery.id },
      data: { state: "skipped", error: "no_subscription" },
    });
    return { attempted: 0, sent: 0 };
  }

  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  if (!vapidPublic || !vapidPrivate) {
    await prisma.notificationDelivery.update({
      where: { id: pushDelivery.id },
      data: { state: "skipped", error: "vapid_not_configured", attempts: { increment: 1 } },
    });
    return { attempted: 0, sent: 0 };
  }

  let sent = 0;
  for (const sub of subs) {
    try {
      // web-push is CommonJS: its methods are on the default export.
      const webpush = await import("web-push").then((module) => module.default).catch(() => null);
      if (!webpush) {
        await prisma.notificationDelivery.update({
          where: { id: pushDelivery.id },
          data: { state: "skipped", error: "web_push_package_missing", attempts: { increment: 1 } },
        });
        return { attempted: 0, sent: 0 };
      }
      webpush.setVapidDetails("mailto:crm@creolab.kz", vapidPublic, vapidPrivate);
      const keys = (sub.keysJson || {}) as { p256dh?: string; auth?: string };
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: keys.p256dh || "", auth: keys.auth || "" },
        },
        JSON.stringify({
          title: notification.title,
          body: notification.body,
          entityType: notification.entityType,
          entityId: notification.entityId,
        }),
      );
      sent += 1;
    } catch (error) {
      await prisma.notificationDelivery.update({
        where: { id: pushDelivery.id },
        data: {
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
          attempts: { increment: 1 },
        },
      });
      return { attempted: subs.length, sent };
    }
  }

  await prisma.notificationDelivery.update({
    where: { id: pushDelivery.id },
    data: { state: sent ? "delivered" : "failed", attempts: { increment: 1 } },
  });
  return { attempted: subs.length, sent };
}
