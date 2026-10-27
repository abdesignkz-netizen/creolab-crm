import type { Prisma, PrismaClient } from "@creolab/db";
import { directWaDigest, loadDirectWaDelivery, lockDirectWaConversation, publishDirectWaDelivery, type DirectWaDelivery } from "./directWhatsAppDeliveryState.ts";

type Receipt = "sent" | "failed" | "delivered" | "read";
const ranks: Receipt[] = ["sent", "failed", "delivered", "read"];
const keyFor = (tenantId: string, integrationId: string, providerId: string) => ({ scope: "whatsapp.direct.receipt", actorKey: tenantId, key: `${integrationId}:${directWaDigest(providerId)}` });

export async function applyDirectWaReceipts(tx: Prisma.TransactionClient, tenantId: string, value: DirectWaDelivery) {
  for (const part of value.parts) {
    if (!part.providerMessageId) continue;
    const row = await tx.idempotencyRecord.findUnique({ where: { scope_actorKey_key: keyFor(tenantId, value.integrationId, part.providerMessageId) } });
    const stored = row?.requestHash as Receipt | undefined;
    const receipt = part.receipt && (!stored || ranks.indexOf(part.receipt) > ranks.indexOf(stored)) ? part.receipt : stored;
    if (!receipt || !ranks.includes(receipt)) continue;
    part.receipt = receipt;
    if (receipt === "failed") { part.state = "failed"; part.error = "WhatsApp сообщил, что эта часть не доставлена"; }
    else if (receipt !== "sent") { part.state = "accepted"; part.error = null; }
  }
}

/** Only call after validating Meta's signature, WABA and phone ID. Store early receipts too. */
export async function recordDirectWaReceipt(prisma: PrismaClient, tenantId: string, integrationId: string, providerId: string, status: Receipt) {
  const key = keyFor(tenantId, integrationId, providerId), data = { requestHash: status, resultJson: {}, expiresAt: new Date(Date.now() + 7 * 86_400_000) };
  // A late "sent" or "failed" must not regress delivered/read. CAS also handles concurrent webhooks.
  await prisma.idempotencyRecord.upsert({ where: { scope_actorKey_key: key }, create: { ...key, ...data }, update: {} });
  await prisma.idempotencyRecord.updateMany({ where: { ...key, requestHash: { in: ranks.slice(0, ranks.indexOf(status)) } }, data });
  const messages = await prisma.message.findMany({ where: { tenantId, senderKind: "staff", direction: "outbound", internal: false,
    connectionScopedId: { startsWith: `wa-out-v2:${tenantId}:` },
    OR: [{ providerMessageId: providerId }, { attachments: { some: { providerMessageId: providerId } } }] }, select: { id: true, conversationId: true } });
  for (const message of messages) {
    const campaignId = await prisma.$transaction(async tx => {
      await lockDirectWaConversation(tx, tenantId, message.conversationId);
      const { operation, delivery } = await loadDirectWaDelivery(tx, tenantId, message.conversationId, message.id);
      // Old attempts no longer own this part. Never apply their receipts to a new retry.
      if (delivery.integrationId !== integrationId || !delivery.parts.some(p => p.providerMessageId === providerId)) return;
      await publishDirectWaDelivery(tx, tenantId, operation.id, delivery);
      return delivery.campaign?.id;
    });
    if (campaignId) await (await import("./campaignService.ts")).refreshCampaignAfterDeliveryReview(prisma, tenantId, campaignId);
  }
}
