// Benchmark snapshot only: original queue consumer from the recorded HEAD.
import type { PrismaClient } from "@creolab/db";
import { claimOutboxEvent } from "../../apps/api/src/services/outboxLease.ts";
import { logServerError } from "../../apps/api/src/lib/redact.ts";
const TICK_MS = 5000;
export async function processOutbox(prisma: PrismaClient) {
  const { processCampaignQueue } = await import("../../apps/api/src/services/campaignService.ts");
  const due = await prisma.outboxEvent.findMany({
    where: { processedAt: null, availableAt: { lte: new Date() } },
    orderBy: { availableAt: "asc" },
    take: 20,
  });
  let processed = 0;
  for (const event of due) {
    const lease = await claimOutboxEvent(prisma, event.id);
    if (!lease) continue;
    processed += 1;
    try {
      if (event.type === "billing.email") {
        const { sendMail } = await import("../../apps/api/src/lib/email.ts");
        const payload = event.payloadJson as {to:string;subject:string;text:string};
        const result = await sendMail({...payload, idempotencyKey:`billing/${event.id}`});
        if (!result.delivered) throw new Error("Billing email not delivered");
      } else if (["whatsapp.ai_reply", "channel.ai_reply"].includes(event.type)) {
        const { processWhatsAppAiReply } = await import("../../apps/api/src/services/whatsappAiService.ts");
        await processWhatsAppAiReply(prisma, event);
      } else if (event.type === "whatsapp.cloud_send") {
        const { deliverCloudMessage } = await import("../../apps/api/src/services/whatsappSendService.ts");
        const integrationId = (event.payloadJson as { integrationId?: string }).integrationId;
        if (integrationId) await deliverCloudMessage(prisma, event.tenantId, integrationId, event.entityId);
      } else if (event.type === "channel.send") {
        const { deliverChannelMessage } = await import("../../apps/api/src/services/channelDeliveryService.ts");
        await deliverChannelMessage(prisma, event.tenantId, event.entityId);
      } else if (event.type === "campaign.run") {
        const payload = (event.payloadJson || {}) as { campaignId?: string };
        if (payload.campaignId) await processCampaignQueue(prisma, payload.campaignId);
      } else if (event.type === "conversation.context") {
        const { processConversationContextJob } = await import("../../apps/api/src/services/conversationContextQueue.ts");
        await processConversationContextJob(prisma, event.tenantId, event.entityId, { sourceMessageId: (event.payloadJson as { messageId?: string }).messageId });
      } else if (event.type === "inquiry.automation") {
        const payload = (event.payloadJson || {}) as { inquiryId?: string; tenantId?: string };
        const { processInquiryAutomationJob } = await import("../../apps/api/src/services/inquiryAutomationQueue.ts");
        await processInquiryAutomationJob(prisma, payload);
      } else if (event.type === "sales.reconcile") {
        const { reconcileSalesDeal } = await import("../../apps/api/src/services/salesControlService.ts");
        await reconcileSalesDeal(prisma, event.tenantId, event.entityId);
      } else if (event.type === "contract.signed") {
        const { processContractSignedEvent } = await import("../../apps/api/src/services/invoiceSignedWorkflow.ts");
        await processContractSignedEvent(prisma, event);
        const dealId = (event.payloadJson as { dealId?: string }).dealId;
        if (dealId) await (await import("../../apps/api/src/services/salesControlService.ts")).reconcileSalesDeal(prisma, event.tenantId, dealId);
      } else if (event.type === "avr.sent" || event.type === "esf.sent") {
        const { processEsfSentOutbox } = await import("../../apps/api/src/services/esfStatusSyncService.ts");
        await processEsfSentOutbox(prisma, event);
      }
    } catch (error) {
      logServerError(error, "background:outbox");
      await lease.finish({
        attempts: { increment: 1 },
        availableAt: new Date(Date.now() + Math.min(300_000, TICK_MS * 2 ** Math.min(event.attempts, 6))),
      });
      continue;
    }
    await lease.finish({ processedAt: new Date(), attempts: { increment: 1 } });
  }
  return processed;
}
