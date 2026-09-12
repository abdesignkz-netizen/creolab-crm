import type { PrismaClient } from "@creolab/db";
import { createStaffNotification, deliverPendingPush } from "./notificationService.ts";
import { AGREEMENT_TYPE_LABEL, type AgreementType } from "./conversationContextTypes.ts";

const TICK_MS = 5000;
let started = false;

async function claimDueAction(prisma: PrismaClient, id: string, version: number) {
  const claimed = await prisma.scheduledAction.updateMany({
    where: { id, state: "scheduled", version },
    data: { state: "running", version: { increment: 1 } },
  });
  return claimed.count === 1;
}

export async function processOutbox(prisma: PrismaClient) {
  const { processCampaignQueue } = await import("./campaignService.ts");
  const due = await prisma.outboxEvent.findMany({
    where: { processedAt: null, availableAt: { lte: new Date() } },
    orderBy: { availableAt: "asc" },
    take: 20,
  });
  for (const event of due) {
    try {
      if (event.type === "campaign.run") {
        const payload = (event.payloadJson || {}) as { campaignId?: string };
        if (payload.campaignId) await processCampaignQueue(prisma, payload.campaignId);
      } else if (event.type === "inquiry.automation") {
        const payload = (event.payloadJson || {}) as { inquiryId?: string; tenantId?: string };
        const { processInquiryAutomationJob } = await import("./inquiryAutomationQueue.ts");
        await processInquiryAutomationJob(prisma, payload);
      } else if (event.type === "contract.signed") {
        const { processContractSignedEvent } = await import("./invoiceSignedWorkflow.ts");
        await processContractSignedEvent(prisma, event);
      } else if (event.type === "avr.sent" || event.type === "esf.sent") {
        const { processEsfSentOutbox } = await import("./esfStatusSyncService.ts");
        await processEsfSentOutbox(prisma, event);
      }
    } catch (error) {
      console.error(`${event.type} outbox`, error);
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          attempts: { increment: 1 },
          availableAt: new Date(Date.now() + Math.min(300_000, TICK_MS * 2 ** Math.min(event.attempts, 6))),
        },
      });
      continue;
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

async function processAgreementReminder(
  prisma: PrismaClient,
  item: {
    id: string;
    tenantId: string;
    parentId: string;
    type: string;
    payloadJson: unknown;
  },
) {
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

export async function processDueScheduledActions(prisma: PrismaClient) {
  const { processCampaignQueue } = await import("./campaignService.ts");
  const { processScheduledTask, recoverDueScheduledTaskSends } = await import("./scheduledTaskRunner.ts");
  await recoverDueScheduledTaskSends(prisma);
  const due = await prisma.scheduledAction.findMany({
    where: { state: "scheduled", dueAt: { lte: new Date() } },
    take: 20,
  });
  for (const item of due) {
    if (!(await claimDueAction(prisma, item.id, item.version))) continue;

    if (item.type === "client_followup") {
      await prisma.scheduledAction.update({
        where: { id: item.id },
        data: { state: "canceled", cancelReason: "module_disabled" },
      });
      continue;
    }
    if (item.type === "task_run" || item.type === "task_batch_run") {
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
      const started = await prisma.campaign.updateMany({
        where: { id: campaignId, status: "scheduled" },
        data: { status: "running", startedAt: new Date() },
      });
      if (started.count === 0) {
        await prisma.scheduledAction.update({
          where: { id: item.id },
          data: { state: "canceled", cancelReason: "campaign_not_scheduled" },
        });
        continue;
      }
      await prisma.campaignRecipient.updateMany({
        where: { campaignId, status: "pending" },
        data: { status: "queued" },
      });
      await processCampaignQueue(prisma, campaignId).catch((error: unknown) => console.error("campaign scheduled", error));
      await prisma.scheduledAction.update({ where: { id: item.id }, data: { state: "done" } });
      continue;
    }
    if (item.type === "esf_status_poll") {
      const { processEsfStatusPollAction } = await import("./esfStatusSyncService.ts");
      await processEsfStatusPollAction(prisma, item).catch(async (error: unknown) => {
        console.error("esf status poll", error);
        await prisma.scheduledAction.update({
          where: { id: item.id },
          data: { state: "failed", cancelReason: error instanceof Error ? error.message : "error" },
        });
      });
      continue;
    }
    if (item.type.startsWith("agreement_reminder")) {
      await processAgreementReminder(prisma, item).catch(async (error) => {
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

export async function resumeRunningCampaigns(prisma: PrismaClient) {
  const { processCampaignQueue } = await import("./campaignService.ts");
  const running = await prisma.campaign.findMany({ where: { status: "running" }, take: 5 });
  for (const campaign of running) {
    void processCampaignQueue(prisma, campaign.id).catch((error: unknown) => console.error("campaign resume", error));
  }
}

export function startBackgroundJobs(prisma: PrismaClient) {
  if (started || process.env.NODE_ENV === "test") return () => undefined;
  started = true;
  const tick = () => {
    processOutbox(prisma).catch((error) => console.error("outbox", error));
    import("./esfStatusSyncService.ts")
      .then(({ ensureEsfStatusPolls }) => ensureEsfStatusPolls(prisma))
      .catch((error) => console.error("esf polls", error));
    processDueScheduledActions(prisma).catch((error) => console.error("scheduled", error));
    resumeRunningCampaigns(prisma).catch((error) => console.error("campaign resume", error));
  };
  tick();
  const timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    started = false;
  };
}
