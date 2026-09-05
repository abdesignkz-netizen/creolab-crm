import dotenv from "dotenv";
import { createPrismaClient } from "@creolab/db";

dotenv.config();

const prisma = await createPrismaClient();
const { processCampaignQueue } = await import("../../api/src/services/campaignService.ts");

async function processOutbox() {
  const due = await prisma.outboxEvent.findMany({
    where: { processedAt: null, availableAt: { lte: new Date() } },
    orderBy: { availableAt: "asc" },
    take: 20,
  });
  for (const event of due) {
    if (event.type === "campaign.run") {
      const payload = (event.payloadJson || {}) as { campaignId?: string };
      if (payload.campaignId) {
        await processCampaignQueue(prisma, payload.campaignId).catch((error: unknown) => console.error("campaign outbox", error));
      }
    }
    await prisma.outboxEvent.update({
      where: { id: event.id },
      data: { processedAt: new Date(), attempts: { increment: 1 } },
    });
  }
  return due.length;
}

async function processScheduled() {
  const due = await prisma.scheduledAction.findMany({
    where: { state: "scheduled", dueAt: { lte: new Date() } },
    take: 20,
  });
  for (const item of due) {
    if (item.type === "client_followup") {
      await prisma.scheduledAction.update({
        where: { id: item.id },
        data: { state: "canceled", cancelReason: "module_disabled" },
      });
      continue;
    }
    if (item.type === "campaign_run") {
      const campaignId = item.parentId;
      await prisma.campaign.updateMany({
        where: { id: campaignId, status: "scheduled" },
        data: { status: "running", startedAt: new Date() },
      });
      await prisma.campaignRecipient.updateMany({
        where: { campaignId, status: "pending" },
        data: { status: "queued" },
      });
      await processCampaignQueue(prisma, campaignId).catch((error: unknown) => console.error("campaign scheduled", error));
      await prisma.scheduledAction.update({ where: { id: item.id }, data: { state: "done" } });
      continue;
    }
    await prisma.scheduledAction.update({
      where: { id: item.id },
      data: { state: "done" },
    });
  }
}

async function resumeRunningCampaigns() {
  const running = await prisma.campaign.findMany({ where: { status: "running" }, take: 5 });
  for (const campaign of running) {
    void processCampaignQueue(prisma, campaign.id).catch((error: unknown) => console.error("campaign resume", error));
  }
}

console.log("CRM worker started. Outbox + scheduled + campaign queue.");

setInterval(() => {
  processOutbox().catch((error) => console.error("outbox", error));
  processScheduled().catch((error) => console.error("scheduled", error));
}, 5000);

await processOutbox();
await resumeRunningCampaigns();
