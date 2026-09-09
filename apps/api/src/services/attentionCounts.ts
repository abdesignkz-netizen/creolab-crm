import type { Prisma, PrismaClient } from "@creolab/db";

export function isRematchedLeftover(conversation: { sellerLeadId?: string | null; attentionReason?: string | null }) {
  return !conversation.sellerLeadId && conversation.attentionReason === "seller_lead_rematched";
}

export function excludeRematchedLeftovers<
  T extends { contactId?: string | null; sellerLeadId?: string | null; attentionReason?: string | null },
>(rows: T[]) {
  const liveContactIds = new Set(
    rows.filter((item) => item.sellerLeadId && item.contactId).map((item) => item.contactId as string),
  );
  return rows.filter((item) => !isRematchedLeftover(item) || !item.contactId || !liveContactIds.has(item.contactId));
}

export async function countVisibleConversations(prisma: PrismaClient, where: Prisma.ConversationWhereInput) {
  const rows = await prisma.conversation.findMany({
    where,
    select: { id: true, contactId: true, sellerLeadId: true, attentionReason: true },
  });
  return excludeRematchedLeftovers(rows).length;
}

export function overdueTasksWhere(tenantId: string, now: Date): Prisma.TaskWhereInput {
  return {
    tenantId,
    parentTaskId: null,
    status: { in: ["open", "waiting"] },
    dueAt: { lt: now },
  };
}

export function conversationsAttentionWhere(tenantId: string): Prisma.ConversationWhereInput {
  return { tenantId, status: "open", needsAttention: true };
}

export function conversationsHumanWhere(tenantId: string): Prisma.ConversationWhereInput {
  return { tenantId, status: "open", mode: "human" };
}

/** Same rule as Клиенты → «Нужен ответ»: last inbound is newer than last outbound. */
export async function countContactsNeedsReply(prisma: PrismaClient, tenantId: string) {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM "Contact"
    WHERE "tenantId" = ${tenantId}
      AND "archivedAt" IS NULL
      AND "lastInboundMessageAt" IS NOT NULL
      AND (
        "lastOutboundMessageAt" IS NULL
        OR "lastInboundMessageAt" > "lastOutboundMessageAt"
      )
  `;
  return Number(rows[0]?.count || 0);
}

/** Same rule as Клиенты → «Новые» and the nav badge. */
export async function countContactsNew(prisma: PrismaClient, tenantId: string) {
  return prisma.contact.count({
    where: { tenantId, archivedAt: null, lifecycleStatus: "new" },
  });
}
