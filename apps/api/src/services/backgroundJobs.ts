import { processControlChat } from "./controlChatDelivery.ts";
import { processEmployeeTelegramQueue } from "./employeeTelegramService.ts";
import { processControlNotifications } from "./controlNotificationService.ts";
import { logServerError } from "../lib/redact.ts";
import { claimOutboxEvent } from "./outboxLease.ts";
import { OUTBOX_MAX_ATTEMPTS, OutboxFailure, outboxFailureUpdate, validateOutboxEvent } from "./outboxFailurePolicy.ts";
import { claimScheduledAction, recoverInterruptedScheduledActions } from "./scheduledActionLease.ts";
import { lockFollowUpConversation, recoverInterruptedFollowUp, recoverAbandonedFollowUps } from "./clientFollowUpDelivery.ts";
import { recoverTelegramDeliveries } from "./telegramDeliveryState.ts";
import { recoverDirectWaDeliveries } from "./directWhatsAppDeliveryState.ts";
import { recoverAiReplyDeliveries } from "./aiReplyDeliveryState.ts";
import type { PrismaClient } from "@creolab/db";
import { createStaffNotification, deliverPendingPush } from "./notificationService.ts";
import { AGREEMENT_TYPE_LABEL, type AgreementType } from "./conversationContextTypes.ts";
import { OUTBOX_FAST_POLL_MS, runOutboxLane, type OutboxLane } from "./outboxScheduling.ts";
import { createBackgroundTaskGroup } from "./backgroundTaskGroup.ts";

const TICK_MS = 5000;
let started = false;

export async function processOutbox(prisma: PrismaClient, options: { lane?: OutboxLane } = {}): Promise<number> {
  if (!options.lane) {
    const results = await Promise.allSettled((["reply", "delivery", "background"] as const).map(lane => processOutbox(prisma, { lane })));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
    return results.reduce((total, result) => total + (result.status === "fulfilled" ? result.value : 0), 0);
  }
  const lane = options.lane;
  return runOutboxLane(prisma, lane, async candidate => {
    const lease = await claimOutboxEvent(prisma, candidate.id);
    if (!lease) return false;
    const event = lease.event;
    const startedAt = Date.now();
    let outcome = "handled";
    try {
      validateOutboxEvent(event);
      if (event.retryAttempts > OUTBOX_MAX_ATTEMPTS) throw new OutboxFailure("retryable", "retry_limit");
      if (event.type === "billing.email") {
        const { sendMail } = await import("../lib/email.ts");
        const payload = event.payloadJson as {to:string;subject:string;text:string};
        const result = await sendMail({...payload, idempotencyKey:`billing/${event.id}`});
        if (!result.delivered) throw new OutboxFailure(result.failureKind, result.errorCode);
      } else if (["whatsapp.ai_reply", "channel.ai_reply"].includes(event.type)) {
        const { processWhatsAppAiReply } = await import("./whatsappAiService.ts");
        await processWhatsAppAiReply(prisma, event);
      } else if (event.type === "whatsapp.cloud_send") {
        const { deliverCloudMessage } = await import("./whatsappSendService.ts");
        const { integrationId, deliveryToken } = event.payloadJson as { integrationId?: string; deliveryToken?: string };
        if (integrationId && await deliverCloudMessage(prisma, event.tenantId, integrationId, event.entityId, deliveryToken) === "deferred") {
          outcome = "deferred";
          await lease.finish({ availableAt: new Date(Date.now() + 30_000), retryAttempts: { decrement: 1 } });
          return true;
        }
      } else if (event.type === "channel.send") {
        const { deliverChannelMessage } = await import("./channelDeliveryService.ts");
        await deliverChannelMessage(prisma, event.tenantId, event.entityId, (event.payloadJson as { deliveryToken?: string })?.deliveryToken);
      } else if (event.type === "campaign.run") {
        const { processCampaignQueue } = await import("./campaignService.ts");
        const payload = (event.payloadJson || {}) as { campaignId?: string };
        if (payload.campaignId) await processCampaignQueue(prisma, payload.campaignId);
      } else if (event.type === "conversation.context") {
        const { processConversationContextJob } = await import("./conversationContextQueue.ts");
        await processConversationContextJob(prisma, event.tenantId, event.entityId, { sourceMessageId: (event.payloadJson as { messageId?: string }).messageId });
      } else if (event.type === "inquiry.automation") {
        const payload = (event.payloadJson || {}) as { inquiryId?: string; tenantId?: string };
        const { processInquiryAutomationJob } = await import("./inquiryAutomationQueue.ts");
        await processInquiryAutomationJob(prisma, payload);
      } else if (event.type === "ai.action_run") {
        const { processActionRun } = await import("./aiActionService.ts");
        await processActionRun(prisma, event.tenantId, event.entityId);
      } else if (event.type === "sales.reconcile") {
        const { reconcileSalesDeal } = await import("./salesControlService.ts");
        await reconcileSalesDeal(prisma, event.tenantId, event.entityId);
      } else if (event.type === "contract.signed") {
        const { processContractSignedEvent } = await import("./invoiceSignedWorkflow.ts");
        await processContractSignedEvent(prisma, event);
        const dealId = (event.payloadJson as { dealId?: string }).dealId;
        if (dealId) await (await import("./salesControlService.ts")).reconcileSalesDeal(prisma, event.tenantId, dealId);
      } else if (event.type === "avr.sent" || event.type === "esf.sent") {
        const { processEsfSentOutbox } = await import("./esfStatusSyncService.ts");
        await processEsfSentOutbox(prisma, event);
      } else throw new OutboxFailure("permanent", "unknown_event_type");
    } catch (error) {
      const update = outboxFailureUpdate(event, error);
      outcome = String(update.failureKind);
      if (event.type === "ai.action_run" && update.failedAt) {
        const { failActionRunQueue } = await import("./aiActionService.ts");
        await failActionRunQueue(prisma, event.tenantId, event.entityId);
      }
      logServerError(error, "background:outbox");
      await lease.finish(update);
      return true;
    } finally {
      if (lane !== "background" && process.env.NODE_ENV !== "test") console.info("outbox_timing", {
        eventId: event.id, tenantId: event.tenantId, type: event.type, lane, outcome,
        queueWaitMs: Math.max(0, startedAt - candidate.availableAt.getTime()), processingMs: Date.now() - startedAt,
        attempt: event.attempts + 1,
      });
    }
    await lease.finish({ processedAt: new Date(), attempts: { increment: 1 }, failureKind: null, errorCode: null });
    return true;
  });
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
    await deliverPendingPush(prisma, notification.id).catch((error) => logServerError(error, "background:push"));
  }

  await prisma.scheduledAction.update({ where: { id: item.id }, data: { state: "done" } });
}

export async function processDueScheduledActions(prisma: PrismaClient) {
  const { processCampaignQueue } = await import("./campaignService.ts");
  const { processScheduledTask, recoverDueScheduledTaskSends } = await import("./scheduledTaskRunner.ts");
  await recoverInterruptedScheduledActions(prisma);
  await recoverAbandonedFollowUps(prisma);
  await recoverTelegramDeliveries(prisma);
  await recoverDirectWaDeliveries(prisma);
  await recoverAiReplyDeliveries(prisma);
  await recoverDueScheduledTaskSends(prisma);
  const due = await prisma.scheduledAction.findMany({
    where: { state: "scheduled", dueAt: { lte: new Date() } },
    orderBy: { dueAt: "asc" },
    take: 20,
  });
  for (const item of due) {
    const lease = await claimScheduledAction(prisma, item);
    if (!lease) continue;
    try {

      const tenant = await prisma.tenant.findUnique({ where: { id: item.tenantId }, select: { status: true } });
      if (!tenant || tenant.status !== "active") {
        await prisma.scheduledAction.update({
          where: { id: item.id },
          data: { state: "canceled", cancelReason: "tenant_suspended" },
        });
        continue;
      }

      if (item.type === "autopilot_check") {
        const { processAutopilotCheck, failAutopilotCheck } = await import("./autopilotService.ts");
        await processAutopilotCheck(prisma, item).catch(async error => {
          logServerError(error, "background:autopilot");
          await failAutopilotCheck(prisma, item);
        });
        continue;
      }
      if (item.type === "client_followup") {
        const { processClientFollowUp } = await import("./aiConversationPolicyService.ts");
        await processClientFollowUp(prisma, item).catch(async (error: unknown) => {
          logServerError(error, "background:client followup");
          await prisma.$transaction(async tx => {
            await lockFollowUpConversation(tx, item.tenantId, item.parentId);
            await tx.scheduledAction.updateMany({ where: { id: item.id, tenantId: item.tenantId, state: "running" },
              data: { state: "failed", cancelReason: "Выполнение автоматического сообщения прервалось." } });
            await recoverInterruptedFollowUp(tx, item);
          });
        });
        continue;
      }
      if (item.type === "task_run" || item.type === "task_batch_run") {
        await processScheduledTask(prisma, item).catch(async (error: unknown) => {
          logServerError(error, "background:scheduled task");
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
        await processCampaignQueue(prisma, campaignId).catch((error: unknown) => logServerError(error, "background:campaign scheduled"));
        await prisma.scheduledAction.update({ where: { id: item.id }, data: { state: "done" } });
        continue;
      }
      if (item.type === "esf_status_poll") {
        const { processEsfStatusPollAction } = await import("./esfStatusSyncService.ts");
        await processEsfStatusPollAction(prisma, item).catch(async (error: unknown) => {
          logServerError(error, "background:esf status poll");
          await prisma.scheduledAction.update({
            where: { id: item.id },
            data: { state: "failed", cancelReason: error instanceof Error ? error.message : "error" },
          });
        });
        continue;
      }
      if (item.type.startsWith("agreement_reminder")) {
        await processAgreementReminder(prisma, item).catch(async (error) => {
          logServerError(error, "background:agreement reminder");
          await prisma.scheduledAction.update({
            where: { id: item.id },
            data: { state: "failed", cancelReason: error instanceof Error ? error.message : "error" },
          });
        });
        continue;
      }
      await prisma.scheduledAction.update({
        where: { id: item.id },
        data: { state: "failed", cancelReason: "Неизвестный тип фонового действия" },
      });
    } catch (error) {
      logServerError(error, "background:scheduled action");
      await prisma.scheduledAction.updateMany({
        where: { id: item.id, state: "running", version: item.version + 1 },
        data: { state: "failed", cancelReason: error instanceof Error ? error.message : "error" },
      });
    } finally { await lease.stop(); }
  }
}

export async function resumeRunningCampaigns(prisma: PrismaClient) {
  const { processCampaignQueue } = await import("./campaignService.ts");
  const running = await prisma.campaign.findMany({ where: { status: "running" }, take: 5 });
  await Promise.all(running.map(campaign => processCampaignQueue(prisma, campaign.id)
    .catch((error: unknown) => logServerError(error, "background:campaign resume"))));
}

export function startBackgroundJobs(prisma: PrismaClient, options: { keepAlive?: boolean } = {}) {
  if (started || process.env.NODE_ENV === "test") return async () => undefined;
  started = true;
  const jobs = createBackgroundTaskGroup((error, name) => logServerError(error, `background:${name}`));
  let lastBillingRun = 0, lastSalesSweep = 0;
  const tick = () => {
    jobs.run("autopilot discovery", () => import("./autopilotService.ts").then(m => m.sweepAutopilot(prisma)));
    jobs.run("business memory retention", () => import("./businessMemoryService.ts").then(m => m.sweepBusinessMemory(prisma)));
    jobs.run("business goals", () => import("./businessGoalService.ts").then(m => m.sweepBusinessGoals(prisma)));
    jobs.run("business insights", () => import("./businessInsightService.ts").then(m => m.sweepBusinessInsights(prisma)));
    jobs.run("situations", () => import("./situationSweepService.ts").then(m => m.sweepSituations(prisma)));
    jobs.run("control notifications", () => processControlNotifications(prisma));
    jobs.run("control chat", () => processControlChat(prisma));
    jobs.run("employee telegram", () => processEmployeeTelegramQueue(prisma));
    jobs.run("billing usage", () => import("./billingResourceService.ts").then(m => m.reconcileBillingUsage(prisma)));
    jobs.run("instagram", () => import("./instagramOAuthService.ts").then(m => m.refreshInstagramConnections(prisma)));
    if (Date.now() - lastSalesSweep >= 60_000 && jobs.run("sales", () => import("./salesControlService.ts").then(m => m.sweepSalesProcesses(prisma)))) lastSalesSweep = Date.now();
    jobs.run("outbox", () => processOutbox(prisma, { lane: "background" }));
    jobs.run("esf polls", () => import("./esfStatusSyncService.ts").then(m => m.ensureEsfStatusPolls(prisma)));
    jobs.run("google", () => import("./googleSyncService.ts").then(m => m.pollGoogleConnections(prisma)));
    jobs.run("scheduled", () => processDueScheduledActions(prisma));
    jobs.run("campaign resume", () => resumeRunningCampaigns(prisma));
    if (Date.now() - lastBillingRun >= 60_000 && jobs.run("billing expire", () => import("./subscriptionActivationService.ts").then(m => m.expireDueSubscriptions(prisma)))) lastBillingRun = Date.now();
  };
  const fastTick = () => {
    for (const lane of ["reply", "delivery"] as const) {
      // Allow a second poll to fill spare lane capacity while one reply is slow.
      jobs.run(`outbox ${lane}`, () => processOutbox(prisma, { lane }), 2);
    }
  };
  fastTick();
  tick();
  const timer = setInterval(tick, TICK_MS);
  const fastTimer = setInterval(fastTick, OUTBOX_FAST_POLL_MS);
  if (!options.keepAlive) timer.unref?.();
  if (!options.keepAlive) fastTimer.unref?.();
  return async () => {
    clearInterval(timer); clearInterval(fastTimer);
    await jobs.drain();
    started = false;
  };
}
