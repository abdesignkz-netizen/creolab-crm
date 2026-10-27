import type { PrismaClient } from "@creolab/db";
import { legacyCampaignKey, legacyDeliveryBusy, readLegacyDelivery, recoverLegacyMessage, LEGACY_SEND_CHECK } from "./legacyMessageDelivery.ts";

const claimKey = (tenantId: string, recipientId: string) => ({ scope: "legacy.campaign.claim", actorKey: tenantId, key: recipientId });

export async function claimLegacyRecipient(prisma: PrismaClient, tenantId: string, campaignId: string, id: string) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "CampaignRecipient" WHERE id = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const claimed = await tx.campaignRecipient.updateMany({ where: { id, tenantId, campaignId, status: "queued", campaign: { status: "running" } }, data: { status: "sending" } });
    if (!claimed.count) return false;
    const key = claimKey(tenantId, id);
    const data = { requestHash: campaignId, resultJson: {}, expiresAt: new Date(Date.now() + 5 * 60_000) };
    await tx.idempotencyRecord.upsert({ where: { scope_actorKey_key: key }, create: { ...key, ...data }, update: data });
    return true;
  });
}

export async function reconcileLegacyCampaign(prisma: PrismaClient, tenantId: string, campaignId: string) {
  const rows = await prisma.campaignRecipient.findMany({ where: { tenantId, campaignId, status: "sending" } });
  for (const row of rows) {
    const operation = await prisma.outboundOperation.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: legacyCampaignKey(campaignId, row.id) } } });
    if (operation) {
      const delivery = await recoverLegacyMessage(prisma, tenantId, operation.id);
      // A crash before the next intent is safe to resume. A lost remote response is not.
      if (delivery && !legacyDeliveryBusy(delivery) && delivery.parts.some(p => p.state === "pending")
        && delivery.parts.every(p => ["pending", "accepted"].includes(p.state))) {
        await prisma.campaignRecipient.updateMany({ where: { id: row.id, tenantId, status: "sending" }, data: { status: "queued" } });
      }
      continue;
    }
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "CampaignRecipient" WHERE id = ${row.id} AND "tenantId" = ${tenantId} FOR UPDATE`;
      const claim = await tx.idempotencyRecord.findUnique({ where: { scope_actorKey_key: claimKey(tenantId, row.id) } });
      if (claim && claim.expiresAt.getTime() > Date.now()) return;
      // Recheck under the recipient lock. Creation may have finished during the read.
      if (await tx.outboundOperation.count({ where: { tenantId, idempotencyKey: legacyCampaignKey(campaignId, row.id) } })) return;
      await tx.campaignRecipient.updateMany({ where: { id: row.id, tenantId, status: "sending" }, data: claim
        ? { status: "failed", textSendState: "not_sent", error: "Подготовка отправки прервана. Можно повторить." }
        : { status: "unknown", error: LEGACY_SEND_CHECK } });
    });
  }
}

export async function retryableLegacyRecipients(prisma: PrismaClient, tenantId: string, campaignId: string) {
  const rows = await prisma.campaignRecipient.findMany({ where: { tenantId, campaignId, status: "failed" } });
  const safe: string[] = [];
  for (const row of rows) {
    const operation = await prisma.outboundOperation.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: legacyCampaignKey(campaignId, row.id) } } });
    const delivery = operation ? await readLegacyDelivery(prisma, tenantId, operation.id) : null;
    if (delivery && !legacyDeliveryBusy(delivery) && (delivery.parts.some(p => p.state === "failed") || delivery.reviewRequiresRetry)
      && delivery.parts.every(p => !["unknown", "sending"].includes(p.state))) safe.push(row.id);
    else if (!operation && row.textSendState === "not_sent") safe.push(row.id);
    else if (!delivery || !legacyDeliveryBusy(delivery)) await prisma.campaignRecipient.updateMany({ where: { id: row.id, tenantId, status: "failed" }, data: { status: "unknown", error: LEGACY_SEND_CHECK } });
  }
  return safe;
}
