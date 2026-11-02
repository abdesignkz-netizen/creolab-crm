import type { Db, Tx } from "./autopilotSupport.ts";
import { actionHash } from "./aiActionRegistry.ts";

export async function autopilotFacts(db: Db, tenantId: string, inquiryId: string, now: Date, options: { inboundId?: string; since?: Date; lock?: boolean } = {}) {
  if (options.lock) await (db as Tx).$queryRaw`SELECT id FROM "Inquiry" WHERE "tenantId" = ${tenantId} AND id = ${inquiryId} FOR UPDATE`;
  const inquiry = await db.inquiry.findFirst({ where: { id: inquiryId, tenantId }, include: { contact: { select: { name: true } } } });
  if (!inquiry?.conversationId) return null;
  if (options.lock) await (db as Tx).$queryRaw`SELECT id FROM "Conversation" WHERE "tenantId" = ${tenantId} AND id = ${inquiry.conversationId} FOR UPDATE`;
  const conversation = await db.conversation.findFirst({ where: { tenantId, id: inquiry.conversationId } });
  if (!conversation) return null;
  const inbound = await db.message.findFirst({ where: { tenantId, conversationId: conversation.id, direction: "inbound", senderKind: "client", internal: false, historical: false,
    ...(options.inboundId ? { id: options.inboundId } : {}), createdAt: { lte: now, ...(options.since ? { gte: options.since } : {}) } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  if (!inbound) return null;
  const reply = await db.message.findFirst({ where: { tenantId, conversationId: conversation.id, direction: "outbound", senderKind: { in: ["staff", "user", "manager", "ai"] }, internal: false, historical: false,
    createdAt: { gte: inbound.createdAt, lte: now }, operationState: { in: ["accepted", "sent", "delivered", "read"] }, receiptState: { not: "failed" } }, orderBy: { createdAt: "asc" }, select: { id: true } });
  const open = !inquiry.archived && !inquiry.test && !inquiry.closedAt && !inquiry.completedAt && !inquiry.convertedAt &&
    !["lost", "invalid", "spam", "converted", "cancelled", "completed", "closed"].includes(inquiry.status) && conversation.status === "open";
  const manualHash = actionHash({ version: inquiry.version, assignee: inquiry.assigneeMembershipId,
    controlVersion: conversation.controlVersion, conversationAssignee: conversation.assigneeMembershipId, mode: conversation.mode, status: conversation.status });
  return { inquiry, conversation, inbound, replyId: reply?.id || null, open, manualHash };
}
