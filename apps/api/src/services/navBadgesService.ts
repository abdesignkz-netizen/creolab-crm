import type { PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership;
}

/**
 * Lightweight attention counts for sidebar / mobile nav badges.
 * Keys are route paths used in App shell navigation.
 */
export async function getNavBadges(prisma: PrismaClient, auth: AuthContext) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const now = new Date();
  const closedInquiry = ["lost", "invalid", "spam", "converted"];

  const [
    conversationsAttention,
    conversationsHuman,
    tasksOverdue,
    contactsNeedsReply,
    inquiriesAttention,
    dealsAttention,
    companiesAttention,
    integrationsIssues,
    notificationsUnread,
    incompleteIntakes,
  ] = await Promise.all([
    prisma.conversation.count({
      where: { tenantId: tid, status: "open", needsAttention: true },
    }),
    prisma.conversation.count({
      where: { tenantId: tid, status: "open", mode: "human" },
    }),
    prisma.task.count({
      where: {
        tenantId: tid,
        parentTaskId: null,
        status: { in: ["open", "waiting"] },
        dueAt: { lt: now },
      },
    }),
    prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM "Contact"
      WHERE "tenantId" = ${tid}
        AND "lastInboundMessageAt" IS NOT NULL
        AND (
          "lastOutboundMessageAt" IS NULL
          OR "lastInboundMessageAt" > "lastOutboundMessageAt"
        )
    `.then((rows) => Number(rows[0]?.count || 0)),
    prisma.inquiry.count({
      where: {
        tenantId: tid,
        archived: false,
        status: { notIn: closedInquiry },
        OR: [{ status: "new" }, { needsReply: true }],
      },
    }),
    prisma.deal.count({
      where: {
        tenantId: tid,
        stage: { isTerminal: false },
        tasks: {
          some: {
            status: { in: ["open", "waiting"] },
            dueAt: { lt: now },
          },
        },
      },
    }),
    prisma.company.count({
      where: {
        tenantId: tid,
        archivedAt: null,
        OR: [
          {
            tasks: {
              some: {
                status: { in: ["open", "waiting"] },
                dueAt: { lt: now },
              },
            },
          },
          {
            inquiries: {
              some: {
                archived: false,
                status: { notIn: closedInquiry },
                OR: [{ needsReply: true }, { status: "new" }],
              },
            },
          },
        ],
      },
    }),
    prisma.integration.count({
      where: {
        tenantId: tid,
        OR: [
          { healthStatus: { in: ["ERROR", "DEGRADED", "DOWN"] } },
          { connectionStatus: { in: ["error", "disconnected", "expired"] } },
        ],
      },
    }),
    prisma.notification.count({
      where: {
        tenantId: tid,
        recipientMembershipId: membership.id,
        readAt: null,
        resolvedAt: null,
      },
    }),
    prisma.incompleteIntake.count({
      where: {
        tenantId: tid,
        status: { in: ["pending", "open", "needs_phone"] },
      },
    }),
  ]);

  const conversations = conversationsAttention;
  const tasks = tasksOverdue;
  const inquiries = inquiriesAttention + incompleteIntakes;
  const control = conversationsHuman;
  const situation = conversationsAttention + tasksOverdue + inquiriesAttention + incompleteIntakes;

  return {
    asOf: now.toISOString(),
    badges: {
      "/today": situation,
      "/conversations": conversations,
      "/tasks": tasks,
      "/contacts": contactsNeedsReply,
      "/companies": companiesAttention,
      "/inquiries": inquiries,
      "/deals": dealsAttention,
      "/control": control,
      "/integrations": integrationsIssues,
      "/stats": 0,
      "/settings": notificationsUnread,
    } as Record<string, number>,
  };
}
