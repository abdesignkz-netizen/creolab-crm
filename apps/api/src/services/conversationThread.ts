import type { Prisma, PrismaClient } from "@creolab/db";

export async function listThreadConversationIds(
  prisma: PrismaClient | Prisma.TransactionClient,
  tenantId: string,
  conversation: { id: string; contactId?: string | null; sellerLeadId?: string | null; externalThreadId?: string | null },
  phoneNormalized?: string | null,
) {
  const ids = new Set<string>([conversation.id]);
  if (!conversation.contactId) return [...ids];
  const phone = phoneNormalized || conversation.externalThreadId || null;
  const or: Array<{ attentionReason?: string; externalThreadId?: string; sellerLeadId?: string }> = [
    { attentionReason: "seller_lead_rematched" },
  ];
  if (phone) or.push({ externalThreadId: phone });
  if (conversation.sellerLeadId) or.push({ sellerLeadId: conversation.sellerLeadId });
  const siblings = await prisma.conversation.findMany({
    where: {
      tenantId,
      contactId: conversation.contactId,
      id: { not: conversation.id },
      OR: or,
    },
    select: { id: true },
  });
  for (const item of siblings) ids.add(item.id);
  return [...ids];
}

export async function adoptSameContactThreadMessages(
  prisma: PrismaClient,
  tenantId: string,
  target: { id: string; contactId?: string | null; sellerLeadId?: string | null; externalThreadId?: string | null },
  phoneNormalized?: string | null,
) {
  if (!target.sellerLeadId || !target.contactId) return 0;
  const siblingIds = (await listThreadConversationIds(prisma, tenantId, target, phoneNormalized)).filter(
    (id) => id !== target.id,
  );
  if (!siblingIds.length) return 0;
  // Delivery operations retain their original recipient/control binding. Show these
  // messages through the merged thread instead of moving them away from that history.
  const tracked = await prisma.outboundOperation.findMany({ where: { tenantId,
    conversationId: { in: siblingIds }, providerRef: { not: null } }, select: { providerRef: true } });
  const trackedIds = tracked.flatMap(row => row.providerRef ? [row.providerRef] : []);
  const updated = await prisma.message.updateMany({
    where: { tenantId, conversationId: { in: siblingIds }, ...(trackedIds.length ? { id: { notIn: trackedIds } } : {}) },
    data: { conversationId: target.id },
  });
  if (updated.count) {
    await prisma.conversation.update({
      where: { id: target.id },
      data: { messageRevision: { increment: updated.count }, updatedAt: new Date() },
    });
  }
  return updated.count;
}
