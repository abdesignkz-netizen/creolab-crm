import dotenv from "dotenv";
import { createPrismaClient } from "@creolab/db";
import { createStaffNotification, deliverPendingPush } from "../../api/src/services/notificationService.ts";
import { AGREEMENT_TYPE_LABEL, type AgreementType } from "../../api/src/services/conversationContextTypes.ts";

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
    } else if (event.type === "inquiry.automation") {
      const payload = (event.payloadJson || {}) as { inquiryId?: string; tenantId?: string };
      const { processInquiryAutomationJob } = await import("../../api/src/services/inquiryAutomationQueue.ts");
      await processInquiryAutomationJob(prisma, payload).catch((error: unknown) =>
        console.error("inquiry.automation outbox", error),
      );
    }
    await prisma.outboxEvent.update({
      where: { id: event.id },
      data: { processedAt: new Date(), attempts: { increment: 1 } },
    });
  }
  return due.length;
}

function reminderLabel(offsetMinutes: number, type: string, title: string, extras: string[]) {
  const when =
    offsetMinutes >= 1440
      ? `Через ${Math.round(offsetMinutes / 1440)} дн.`
      : offsetMinutes >= 60
        ? `Через ${Math.round(offsetMinutes / 60)} ч.`
        : `Через ${offsetMinutes} мин.`;
  const typeLabel = AGREEMENT_TYPE_LABEL[type as AgreementType] || type;
  return {
    title: `${when} ${typeLabel.toLowerCase()}`,
    body: [title, ...extras].filter(Boolean).join(" · "),
  };
}

async function processAgreementReminder(item: {
  id: string;
  tenantId: string;
  parentId: string;
  type: string;
  payloadJson: unknown;
}) {
  const payload = (item.payloadJson || {}) as {
    offsetMinutes?: number;
    channel?: string;
    agreementId?: string;
  };
  const agreementId = payload.agreementId || item.parentId;
  const agreement = await prisma.agreement.findFirst({
    where: { id: agreementId, tenantId: item.tenantId },
    include: {
      contact: true,
      task: true,
    },
  });
  if (!agreement || ["CANCELLED", "COMPLETED", "MISSED"].includes(agreement.status)) {
    await prisma.scheduledAction.update({
      where: { id: item.id },
      data: { state: "canceled", cancelReason: "agreement_inactive" },
    });
    return;
  }

  const extras: string[] = [];
  if (agreement.type === "ONLINE_MEETING") {
    extras.push(agreement.meetingUrl ? "Открыть ссылку" : "Ссылка не добавлена");
  }
  if (agreement.type === "OFFLINE_MEETING") {
    extras.push([agreement.locationName, agreement.address].filter(Boolean).join(" · ") || "Адрес не указан");
  }
  if (agreement.contact?.name) extras.push(agreement.contact.name);

  const offsetMinutes = payload.offsetMinutes || Number(String(item.type).replace("agreement_reminder_", "")) || 60;
  const copy = reminderLabel(offsetMinutes, agreement.type, agreement.title, extras);

  const membershipId =
    agreement.responsibleMembershipId ||
    agreement.task?.ownerMembershipId ||
    (
      await prisma.membership.findFirst({
        where: { tenantId: item.tenantId, active: true },
        orderBy: { createdAt: "asc" },
      })
    )?.id ||
    null;

  const notification = await createStaffNotification(prisma, {
    tenantId: item.tenantId,
    membershipId,
    type: "agreement.reminder",
    entityType: "agreement",
    entityId: agreement.id,
    title: copy.title,
    body: copy.body,
    priority: offsetMinutes <= 60 ? "high" : "normal",
    episodeKey: `agreement.reminder:${agreement.id}:${offsetMinutes}`,
    channels: ["in_app", "web_push"],
  });

  if (notification) {
    await deliverPendingPush(prisma, notification.id).catch((error) => console.error("push", error));
  }

  await prisma.scheduledAction.update({ where: { id: item.id }, data: { state: "done" } });
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
    if (item.type === "task_run" || item.type === "task_batch_run") {
      const { processScheduledTask } = await import("../../api/src/services/scheduledTaskRunner.ts");
      await processScheduledTask(prisma, item).catch(async (error: unknown) => {
        console.error("scheduled task", error);
        await prisma.scheduledAction.update({
          where: { id: item.id },
          data: { state: "failed", cancelReason: error instanceof Error ? error.message : "error" },
        });
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
    if (item.type.startsWith("agreement_reminder")) {
      await processAgreementReminder(item).catch(async (error) => {
        console.error("agreement reminder", error);
        await prisma.scheduledAction.update({
          where: { id: item.id },
          data: { state: "failed", cancelReason: error instanceof Error ? error.message : "error" },
        });
      });
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

console.log("CRM worker started. Outbox + scheduled + campaign queue + agreement reminders.");

setInterval(() => {
  processOutbox().catch((error) => console.error("outbox", error));
  processScheduled().catch((error) => console.error("scheduled", error));
}, 5000);

await processOutbox();
await resumeRunningCampaigns();
