import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@creolab/db";
import {
  assignTaskSchema,
  completeIntakeSchema,
  contactNoteSchema,
  contactTagSchema,
  conversationModeSchema,
  createContactSchema,
  createInquirySchema,
  createTaskSchema,
  createFromCommandSchema,
  completeTaskResultSchema,
  campaignAttachmentSchema,
  confirmCampaignSchema,
  createCampaignSchema,
  loginSchema,
  lookupInquiryContactSchema,
  loseInquirySchema,
  nextActionSchema,
  parseContactImportSchema,
  parsePhoneListSchema,
  personalizeCampaignRecipientsSchema,
  parseTaskCommandSchema,
  paymentSchema,
  changeDealStageSchema,
  updateDealSchema,
  markDealWonSchema,
  markDealLostSchema,
  segmentPreviewSchema,
  sendMessageSchema,
  snoozeSituationSchema,
  askSituationSchema,
  taskAttachmentSchema,
  updateCampaignSchema,
  updateContactSchema,
  updateInquirySchema,
  updateTaskSchema,
  createCompanySchema,
  updateCompanySchema,
  companyContactSchema,
  updateCompanyContactSchema,
  dealContactSchema,
} from "@creolab/contracts";
import { config } from "./config.ts";
import { ApiError, errorBody } from "./errors.ts";
import { fileStorageStatus } from "./lib/storage.ts";
import {
  authFromAccessToken,
  authFromSessionToken,
  login,
  logout,
  publicAuth,
  refreshMobile,
} from "./services/authService.ts";
import {
  completeIntake,
  convertInquiryToDeal,
  createManualInquiry,
  getInquiry,
  ingestIntegrationEvent,
  listIncomplete,
  listInquiries,
  lookupContactByPhone,
  loseInquiry,
  submitPublicForm,
  takeInquiry,
  updateInquiry,
} from "./services/inquiryService.ts";
import {
  addConversationMessage,
  addPayment,
  aiSandbox,
  assignTask,
  cancelTask,
  completeTask,
  createTask,
  getTask,
  knowledgeCurrent,
  listDeals,
  listIntegrations,
  listNotifications,
  listTasks,
  markNotificationRead,
  platformTenants,
  reopenTask,
  setConversationMode,
  statsSummary,
  todayQueue,
  waitTask,
} from "./services/domainService.ts";
import { getAnalyticsDashboard, getAnalyticsDrilldown, getAnalyticsTrend } from "./services/analyticsService.ts";
import {
  addDealContact,
  createCompany,
  deleteCompany,
  findCompanyDuplicates,
  getCompanyContacts,
  getCompanyOverview,
  getContactCompanies,
  linkContactToCompany,
  listCompanies,
  suggestCompaniesFromCompanyName,
  unlinkCompanyContact,
  updateCompany,
  updateCompanyContact,
} from "./services/companyService.ts";
import {
  addContactNote,
  addContactTag,
  createContact,
  getContactOverview,
  listContactActivities,
  listContactsBoard,
  removeContactTag,
  updateContact,
} from "./services/contactService.ts";
import { listWorkspaceMembers, previewContactSegment, searchContactsForPicker } from "./services/segmentService.ts";
import { getConversationWorkspace, listConversationsBoard, markConversationRead, getConversationMessages } from "./services/conversationService.ts";
import {
  addTaskAttachment,
  completeTaskWithResult,
  confirmTaskExecution,
  createNextActionFromSuggestion,
  executeTask,
  prepareTaskExecution,
  removeTaskAttachment,
  updateTaskDraft,
} from "./services/taskExecutionService.ts";
import { parseTaskCommand } from "./services/aiCommandParserService.ts";
import { createTaskFromCommand, executeTaskBatch } from "./services/aiCommandExecutionService.ts";
import {
  addCampaignAttachment,
  cancelCampaignRemainder,
  confirmCampaign,
  createCampaign,
  draftCampaignMessage,
  getCampaign,
  pauseCampaign,
  personalizeCampaignRecipients,
  prepareCampaign,
  previewPhoneList,
  removeCampaignAttachment,
  retryFailedCampaign,
  startCampaign,
  updateCampaign,
} from "./services/campaignService.ts";
import { parseContactImportFile } from "./services/contactImportParse.ts";
import { getSituationOverview } from "./services/situationOverviewService.ts";
import { askSituation } from "./services/situationAskService.ts";
import {
  changeDealStage,
  getDeal,
  getDealBoard,
  markDealLost,
  markDealWon,
  setDealOnHold,
  updateDeal,
} from "./services/dealService.ts";
import { analyzeAndApplyConversation } from "./services/conversationContextApplyService.ts";
import { analyzeConversationContext, listAgreementsForConversation } from "./services/conversationContextService.ts";
import { getSituation, snoozeSituation } from "./services/situationService.ts";
import { getNavBadges } from "./services/navBadgesService.ts";
import {
  claimAllAiConversations,
  getManagementOverview,
  setAiManagerRuntimePause,
} from "./services/managementOverviewService.ts";
import {
  addSellerInstruction,
  beginTelegramLink,
  connectWhatsAppSeller,
  controlBoard,
  ingestSellerBridgeEvent,
  integrationSetup,
  rotateWebhookSecret,
  sellerHealthFor,
  syncSellerLeads,
} from "./services/sellerLink.ts";
import type { AuthContext } from "./lib/types.ts";

const rateBuckets = new Map<string, { count: number; reset: number }>();

function rateLimit(key: string, limit: number) {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.reset < now) {
    rateBuckets.set(key, { count: 1, reset: now + 60_000 });
    return;
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    throw new ApiError(429, "rate_limited", "Слишком много запросов");
  }
}

export function createApp(prisma: PrismaClient) {
  const app = express();
  app.disable("x-powered-by");
  app.use(
    cors({
      origin: config.allowedOrigins,
      credentials: true,
    }),
  );
  app.use(cookieParser());
  app.use((req, res, next) => {
    const requestId = randomUUID();
    res.locals.requestId = requestId;
    res.setHeader("x-request-id", requestId);
    next();
  });

  app.get("/health", (_req, res) => {
    const storage = fileStorageStatus();
    res.json({
      status: "ok",
      service: "creolab-ai-crm",
      whatsappRequired: false,
      storage: {
        storePathKind: storage.storePathKind,
        storageDirSet: Boolean(storage.storageDir),
        warning: storage.warning,
      },
    });
  });
  app.get("/ready", async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ready" });
  });

  const json = express.json({ limit: "200kb" });
  const jsonLarge = express.json({ limit: "30mb" });
  const urlencoded = express.urlencoded({ extended: true, limit: "200kb" });
  const rawJson = express.raw({ type: "application/json", limit: "200kb" });

  // Public form: JSON + urlencoded (HTML forms). Multipart later for files.
  app.post("/public/forms/:publicKey/submissions", json, urlencoded, async (req, res) => {
    rateLimit(`form:${req.params.publicKey}:${req.ip}`, 20);
    res.setHeader("Access-Control-Allow-Origin", req.get("origin") || "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Submission-Id");
    const result = await submitPublicForm(prisma, req.params.publicKey, req.body || {}, {
      origin: req.get("origin") || undefined,
      submissionId: String(req.header("x-submission-id") || req.body?.submission_id || ""),
    });
    res.status(result.duplicate ? 200 : 202).json({
      ok: true,
      receipt: result.receipt,
      duplicate: result.duplicate,
    });
  });

  app.options("/public/forms/:publicKey/submissions", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", _req.get("origin") || "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Submission-Id");
    res.status(204).end();
  });

  async function requireAuth(req: express.Request): Promise<AuthContext> {
    const tenantHeader = String(req.header("x-tenant-id") || req.query.tenantId || "");
    const cookie = req.cookies?.crm_session as string | undefined;
    const bearer = String(req.header("authorization") || "").replace(/^Bearer\s+/i, "");
    if (cookie) return authFromSessionToken(prisma, cookie, tenantHeader || null);
    if (bearer) return authFromAccessToken(prisma, bearer, tenantHeader || null);
    throw new ApiError(401, "unauthorized", "Нужно войти");
  }

  app.post("/api/v1/auth/login", json, async (req, res) => {
    const result = await login(prisma, req.body);
    if (result.auth.client === "web") {
      res.cookie("crm_session", result.sessionToken, {
        httpOnly: true,
        sameSite: "lax",
        secure: config.cookieSecure,
        path: "/",
        maxAge: 12 * 60 * 60 * 1000,
      });
    }
    res.json({
      user: publicAuth(result.auth),
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
  });

  app.post("/api/v1/auth/logout", json, async (req, res) => {
    const auth = await requireAuth(req);
    await logout(prisma, auth.sessionId, Boolean(req.body?.all), auth.user.id);
    res.clearCookie("crm_session", { path: "/" });
    res.json({ ok: true });
  });

  app.post("/api/v1/auth/refresh", json, async (req, res) => {
    const parsed = await refreshMobile(prisma, String(req.body?.refreshToken || ""));
    res.json(parsed);
  });

  app.get("/api/v1/me", async (req, res) => {
    res.json(publicAuth(await requireAuth(req)));
  });

  app.post("/api/v1/tenants/switch", json, async (req, res) => {
    const auth = await requireAuth(req);
    const tenantId = String(req.body?.tenantId || "");
    const membership = auth.memberships.find((item) => item.tenantId === tenantId && item.active);
    if (!membership) throw new ApiError(403, "forbidden", "Нет доступа к компании");
    res.json({ activeTenant: { membershipId: membership.id, role: membership.role, tenant: membership.tenant } });
  });

  app.get("/api/v1/today", async (req, res) => {
    res.json(await todayQueue(prisma, await requireAuth(req), req.query as Record<string, string>));
  });

  app.get("/api/v1/situation", async (req, res) => {
    res.json(await getSituation(prisma, await requireAuth(req), req.query as Record<string, string>));
  });

  app.get("/api/v1/situation/overview", async (req, res) => {
    res.json(await getSituationOverview(prisma, await requireAuth(req), req.query as Record<string, string>));
  });

  app.get("/api/v1/nav-badges", async (req, res) => {
    res.json(await getNavBadges(prisma, await requireAuth(req)));
  });

  app.post("/api/v1/situation/snooze", json, async (req, res) => {
    const input = snoozeSituationSchema.parse(req.body);
    res.json(await snoozeSituation(prisma, await requireAuth(req), input));
  });

  app.post("/api/v1/situation/ask", json, async (req, res) => {
    const input = askSituationSchema.parse(req.body);
    res.json(await askSituation(prisma, await requireAuth(req), input));
  });

  app.get("/api/v1/inquiries", async (req, res) => {
    res.json(await listInquiries(prisma, await requireAuth(req), req.query as Record<string, string>));
  });

  app.post("/api/v1/inquiries/lookup-contact", json, async (req, res) => {
    const input = lookupInquiryContactSchema.parse(req.body);
    res.json(await lookupContactByPhone(prisma, await requireAuth(req), input.phone));
  });

  app.post("/api/v1/inquiries", json, async (req, res) => {
    const auth = await requireAuth(req);
    const input = createInquirySchema.parse(req.body);
    const inquiry = await createManualInquiry(prisma, auth, input);
    res.status(201).json(inquiry);
  });

  app.get("/api/v1/inquiries/:id", async (req, res) => {
    res.json(await getInquiry(prisma, await requireAuth(req), req.params.id));
  });

  app.patch("/api/v1/inquiries/:id", json, async (req, res) => {
    const input = updateInquirySchema.parse(req.body || {});
    res.json(await updateInquiry(prisma, await requireAuth(req), req.params.id, input));
  });

  app.post("/api/v1/inquiries/:id/take", async (req, res) => {
    res.json(await takeInquiry(prisma, await requireAuth(req), req.params.id));
  });

  app.post("/api/v1/inquiries/:id/lose", json, async (req, res) => {
    const input = loseInquirySchema.parse(req.body || {});
    res.json(await loseInquiry(prisma, await requireAuth(req), req.params.id, input));
  });

  app.post("/api/v1/inquiries/:id/accept", async (req, res) => {
    res.json(await takeInquiry(prisma, await requireAuth(req), req.params.id));
  });

  app.post("/api/v1/inquiries/:id/convert-to-deal", json, async (req, res) => {
    const auth = await requireAuth(req);
    const deal = await convertInquiryToDeal(prisma, auth, req.params.id, req.body?.title);
    res.json(deal);
  });

  app.get("/api/v1/settings/ai-automation", async (req, res) => {
    const { getAIAutomationSettings } = await import("./services/aiAutomationSettingsService.ts");
    res.json(await getAIAutomationSettings(prisma, await requireAuth(req)));
  });

  app.patch("/api/v1/settings/ai-automation", json, async (req, res) => {
    const { updateAIAutomationSettings } = await import("./services/aiAutomationSettingsService.ts");
    res.json(await updateAIAutomationSettings(prisma, await requireAuth(req), req.body || {}));
  });

  app.get("/api/v1/inquiries/:id/ai-preview", async (req, res) => {
    const auth = await requireAuth(req);
    const membership = auth.activeMembership;
    if (!membership) {
      const { ApiError } = await import("./errors.ts");
      throw new ApiError(403, "no_tenant", "Нет активной компании");
    }
    const { getInquiryAutomationPreview } = await import("./services/requestAutomationService.ts");
    const preview = await getInquiryAutomationPreview(prisma, membership.tenantId, req.params.id);
    if (!preview) {
      const { ApiError } = await import("./errors.ts");
      throw new ApiError(404, "not_found", "Заявка не найдена");
    }
    res.json(preview);
  });

  app.post("/api/v1/inquiries/:id/ai/start", async (req, res) => {
    const auth = await requireAuth(req);
    const membership = auth.activeMembership;
    if (!membership) {
      const { ApiError } = await import("./errors.ts");
      throw new ApiError(403, "no_tenant", "Нет активной компании");
    }
    const { processNewRequestAutomation, startAiManagerForInquiry } = await import(
      "./services/requestAutomationService.ts"
    );
    const inquiry = await prisma.inquiry.findFirst({
      where: { id: req.params.id, tenantId: membership.tenantId },
    });
    if (!inquiry) {
      const { ApiError } = await import("./errors.ts");
      throw new ApiError(404, "not_found", "Заявка не найдена");
    }
    const meta =
      inquiry.fieldMetaJson && typeof inquiry.fieldMetaJson === "object"
        ? (inquiry.fieldMetaJson as { automation?: { status?: string } }).automation
        : null;
    if (!meta?.status || meta.status === "none" || meta.status === "analyzed" || meta.status === "failed") {
      await processNewRequestAutomation(prisma, membership.tenantId, inquiry.id, {
        forceMode: "CONFIRM",
        forceStart: true,
      });
    } else {
      await startAiManagerForInquiry(prisma, membership.tenantId, inquiry.id);
    }
    res.json(await getInquiry(prisma, auth, inquiry.id));
  });

  app.post("/api/v1/inquiries/:id/ai/takeover", json, async (req, res) => {
    const auth = await requireAuth(req);
    const membership = auth.activeMembership;
    if (!membership) {
      const { ApiError } = await import("./errors.ts");
      throw new ApiError(403, "no_tenant", "Нет активной компании");
    }
    const { handoffInquiryToHuman } = await import("./services/requestAutomationService.ts");
    await handoffInquiryToHuman(prisma, membership.tenantId, req.params.id, {
      userId: auth.user.id,
      membershipId: membership.id,
      reason: typeof req.body?.reason === "string" ? req.body.reason : "HUMAN_TAKEOVER",
    });
    res.json(await getInquiry(prisma, auth, req.params.id));
  });

  app.post("/api/v1/inquiries/:id/ai/return", async (req, res) => {
    const auth = await requireAuth(req);
    const membership = auth.activeMembership;
    if (!membership) {
      const { ApiError } = await import("./errors.ts");
      throw new ApiError(403, "no_tenant", "Нет активной компании");
    }
    const { returnInquiryToAi } = await import("./services/requestAutomationService.ts");
    await returnInquiryToAi(prisma, membership.tenantId, req.params.id);
    res.json(await getInquiry(prisma, auth, req.params.id));
  });

  app.post("/api/v1/inquiries/:id/ai/retry-analysis", async (req, res) => {
    const auth = await requireAuth(req);
    const membership = auth.activeMembership;
    if (!membership) {
      const { ApiError } = await import("./errors.ts");
      throw new ApiError(403, "no_tenant", "Нет активной компании");
    }
    const { processNewRequestAutomation } = await import("./services/requestAutomationService.ts");
    await processNewRequestAutomation(prisma, membership.tenantId, req.params.id, { forceMode: "ASSIST" });
    res.json(await getInquiry(prisma, auth, req.params.id));
  });

  app.get("/api/v1/incomplete-intakes", async (req, res) => {
    res.json({ items: await listIncomplete(prisma, await requireAuth(req)) });
  });

  app.post("/api/v1/incomplete-intakes/:id/complete", json, async (req, res) => {
    const input = completeIntakeSchema.parse(req.body);
    const inquiry = await completeIntake(prisma, await requireAuth(req), req.params.id, input);
    res.json(inquiry);
  });

  app.get("/api/v1/contacts", async (req, res) => {
    res.json(await listContactsBoard(prisma, await requireAuth(req), req.query as Record<string, string>));
  });

  app.get("/api/v1/contacts/search", async (req, res) => {
    res.json(await searchContactsForPicker(prisma, await requireAuth(req), String(req.query.q || "")));
  });

  app.post("/api/v1/contacts/segment-preview", json, async (req, res) => {
    const input = segmentPreviewSchema.parse(req.body || {});
    res.json(await previewContactSegment(prisma, await requireAuth(req), input));
  });

  app.get("/api/v1/workspace/members", async (req, res) => {
    res.json(await listWorkspaceMembers(prisma, await requireAuth(req)));
  });

  app.post("/api/v1/contacts", json, async (req, res) => {
    const input = createContactSchema.parse(req.body);
    res.status(201).json(await createContact(prisma, await requireAuth(req), input));
  });

  app.get("/api/v1/contacts/:id/overview", async (req, res) => {
    res.json(await getContactOverview(prisma, await requireAuth(req), req.params.id));
  });

  app.get("/api/v1/contacts/:id", async (req, res) => {
    res.json(await getContactOverview(prisma, await requireAuth(req), req.params.id));
  });

  app.patch("/api/v1/contacts/:id", json, async (req, res) => {
    const input = updateContactSchema.parse(req.body || {});
    res.json(await updateContact(prisma, await requireAuth(req), req.params.id, input));
  });

  app.get("/api/v1/contacts/:id/activities", async (req, res) => {
    res.json(await listContactActivities(prisma, await requireAuth(req), req.params.id, req.query as Record<string, string>));
  });

  app.post("/api/v1/contacts/:id/notes", json, async (req, res) => {
    const input = contactNoteSchema.parse(req.body);
    res.status(201).json(await addContactNote(prisma, await requireAuth(req), req.params.id, input));
  });

  app.post("/api/v1/contacts/:id/tags", json, async (req, res) => {
    const input = contactTagSchema.parse(req.body);
    res.status(201).json(await addContactTag(prisma, await requireAuth(req), req.params.id, input.name));
  });

  app.delete("/api/v1/contacts/:id/tags/:tagId", async (req, res) => {
    res.json(await removeContactTag(prisma, await requireAuth(req), req.params.id, req.params.tagId));
  });

  app.get("/api/v1/deals", async (req, res) => {
    const q = req.query as Record<string, string>;
    if (q.view === "list") {
      res.json({ items: await listDeals(prisma, await requireAuth(req)) });
      return;
    }
    res.json(await getDealBoard(prisma, await requireAuth(req), q));
  });

  app.get("/api/v1/deals/:id", async (req, res) => {
    res.json(await getDeal(prisma, await requireAuth(req), req.params.id));
  });

  app.patch("/api/v1/deals/:id", json, async (req, res) => {
    const input = updateDealSchema.parse(req.body || {});
    res.json(await updateDeal(prisma, await requireAuth(req), req.params.id, input));
  });

  app.post("/api/v1/deals/:id/stage", json, async (req, res) => {
    const input = changeDealStageSchema.parse(req.body || {});
    res.json(await changeDealStage(prisma, await requireAuth(req), req.params.id, input));
  });

  app.post("/api/v1/deals/:id/won", json, async (req, res) => {
    const input = markDealWonSchema.parse(req.body || {});
    res.json(await markDealWon(prisma, await requireAuth(req), req.params.id, input));
  });

  app.post("/api/v1/deals/:id/lost", json, async (req, res) => {
    const input = markDealLostSchema.parse(req.body || {});
    res.json(await markDealLost(prisma, await requireAuth(req), req.params.id, input));
  });

  app.post("/api/v1/deals/:id/hold", json, async (req, res) => {
    const hold = Boolean(req.body?.hold ?? true);
    res.json(await setDealOnHold(prisma, await requireAuth(req), req.params.id, hold));
  });

  app.post("/api/v1/deals/:id/payments", json, async (req, res) => {
    const input = paymentSchema.parse(req.body);
    res.status(201).json(await addPayment(prisma, await requireAuth(req), req.params.id, input));
  });

  app.get("/api/v1/tasks", async (req, res) => {
    res.json({ items: await listTasks(prisma, await requireAuth(req)) });
  });

  app.post("/api/v1/tasks/parse-command", json, async (req, res) => {
    const input = parseTaskCommandSchema.parse(req.body);
    res.json(
      await parseTaskCommand(prisma, await requireAuth(req), input.text, {
        contactId: input.contactId,
        contactIds: input.contactIds,
        phone: input.phone,
        phones: input.phones,
        phoneListText: input.phoneListText,
      }),
    );
  });

  app.post("/api/v1/tasks/from-command", json, async (req, res) => {
    const input = createFromCommandSchema.parse(req.body);
    res.status(201).json(await createTaskFromCommand(prisma, await requireAuth(req), input));
  });

  app.get("/api/v1/tasks/:id", async (req, res) => {
    res.json(await getTask(prisma, await requireAuth(req), req.params.id));
  });

  app.post("/api/v1/tasks", json, async (req, res) => {
    const input = createTaskSchema.parse(req.body);
    res.status(201).json(await createTask(prisma, await requireAuth(req), input));
  });

  app.patch("/api/v1/tasks/:id", json, async (req, res) => {
    const input = updateTaskSchema.parse(req.body || {});
    res.json(await updateTaskDraft(prisma, await requireAuth(req), req.params.id, input));
  });

  app.post("/api/v1/tasks/:id/attachments", jsonLarge, async (req, res) => {
    const input = taskAttachmentSchema.parse(req.body);
    res.status(201).json(await addTaskAttachment(prisma, await requireAuth(req), req.params.id, input));
  });

  app.delete("/api/v1/tasks/:id/attachments/:attachmentId", async (req, res) => {
    res.json(await removeTaskAttachment(prisma, await requireAuth(req), req.params.id, req.params.attachmentId));
  });

  app.post("/api/v1/tasks/:id/prepare-execution", async (req, res) => {
    res.json(await prepareTaskExecution(prisma, await requireAuth(req), req.params.id));
  });

  app.post("/api/v1/tasks/:id/confirm-execution", async (req, res) => {
    res.json(await confirmTaskExecution(prisma, await requireAuth(req), req.params.id));
  });

  app.post("/api/v1/tasks/:id/execute", json, async (req, res) => {
    const retryFailedFilesOnly = Boolean(req.body?.retryFailedFilesOnly);
    res.json(await executeTask(prisma, await requireAuth(req), req.params.id, { retryFailedFilesOnly }));
  });

  app.post("/api/v1/tasks/:id/execute-batch", async (req, res) => {
    res.json(await executeTaskBatch(prisma, await requireAuth(req), req.params.id));
  });

  app.post("/api/v1/campaigns/parse-phones", json, async (req, res) => {
    const input = parsePhoneListSchema.parse(req.body);
    res.json(await previewPhoneList(prisma, await requireAuth(req), input.text));
  });

  app.post("/api/v1/campaigns/parse-import", json, async (req, res) => {
    const input = parseContactImportSchema.parse(req.body);
    await requireAuth(req);
    res.json(parseContactImportFile(input.fileName, input.contentBase64, input.mapping));
  });

  app.post("/api/v1/campaigns", json, async (req, res) => {
    const input = createCampaignSchema.parse(req.body);
    res.status(201).json(await createCampaign(prisma, await requireAuth(req), input));
  });

  app.get("/api/v1/campaigns/:id", async (req, res) => {
    res.json(await getCampaign(prisma, await requireAuth(req), req.params.id));
  });

  app.patch("/api/v1/campaigns/:id", json, async (req, res) => {
    const input = updateCampaignSchema.parse(req.body || {});
    res.json(await updateCampaign(prisma, await requireAuth(req), req.params.id, input));
  });

  app.post("/api/v1/campaigns/:id/attachments", jsonLarge, async (req, res) => {
    const input = campaignAttachmentSchema.parse(req.body);
    res.status(201).json(await addCampaignAttachment(prisma, await requireAuth(req), req.params.id, input));
  });

  app.delete("/api/v1/campaigns/:id/attachments/:attachmentId", async (req, res) => {
    res.json(await removeCampaignAttachment(prisma, await requireAuth(req), req.params.id, req.params.attachmentId));
  });

  app.post("/api/v1/campaigns/:id/personalize-recipients", json, async (req, res) => {
    const input = personalizeCampaignRecipientsSchema.parse(req.body || {});
    res.json(await personalizeCampaignRecipients(prisma, await requireAuth(req), req.params.id, input));
  });

  app.post("/api/v1/campaigns/:id/prepare", async (req, res) => {
    res.json(await prepareCampaign(prisma, await requireAuth(req), req.params.id));
  });

  app.post("/api/v1/campaigns/:id/confirm", json, async (req, res) => {
    const input = confirmCampaignSchema.parse(req.body || {});
    res.json(await confirmCampaign(prisma, await requireAuth(req), req.params.id, input));
  });

  app.post("/api/v1/campaigns/:id/start", async (req, res) => {
    res.json(await startCampaign(prisma, await requireAuth(req), req.params.id));
  });

  app.post("/api/v1/campaigns/:id/pause", async (req, res) => {
    res.json(await pauseCampaign(prisma, await requireAuth(req), req.params.id));
  });

  app.post("/api/v1/campaigns/:id/cancel-remainder", async (req, res) => {
    res.json(await cancelCampaignRemainder(prisma, await requireAuth(req), req.params.id));
  });

  app.post("/api/v1/campaigns/:id/retry-failed", async (req, res) => {
    res.json(await retryFailedCampaign(prisma, await requireAuth(req), req.params.id));
  });

  app.post("/api/v1/campaigns/draft-message", json, async (req, res) => {
    res.json(await draftCampaignMessage(String(req.body?.goal || ""), Boolean(req.body?.hasFile)));
  });

  app.post("/api/v1/tasks/:id/complete-result", json, async (req, res) => {
    const input = completeTaskResultSchema.parse(req.body || {});
    res.json(await completeTaskWithResult(prisma, await requireAuth(req), req.params.id, input));
  });

  app.post("/api/v1/tasks/:id/next-action", json, async (req, res) => {
    const input = nextActionSchema.parse(req.body || {});
    res.status(201).json(await createNextActionFromSuggestion(prisma, await requireAuth(req), req.params.id, input));
  });

  app.post("/api/v1/tasks/:id/complete", async (req, res) => {
    res.json(await completeTask(prisma, await requireAuth(req), req.params.id));
  });

  app.post("/api/v1/tasks/:id/wait", async (req, res) => {
    res.json(await waitTask(prisma, await requireAuth(req), req.params.id));
  });

  app.post("/api/v1/tasks/:id/reopen", async (req, res) => {
    res.json(await reopenTask(prisma, await requireAuth(req), req.params.id));
  });

  app.post("/api/v1/tasks/:id/cancel", async (req, res) => {
    res.json(await cancelTask(prisma, await requireAuth(req), req.params.id));
  });

  app.post("/api/v1/tasks/:id/assign", json, async (req, res) => {
    const input = assignTaskSchema.parse(req.body || {});
    res.json(await assignTask(prisma, await requireAuth(req), req.params.id, input.membershipId));
  });

  app.get("/api/v1/conversations", async (req, res) => {
    res.json(await listConversationsBoard(prisma, await requireAuth(req), req.query as Record<string, string>));
  });

  app.get("/api/v1/conversations/:id", async (req, res) => {
    res.json(await getConversationWorkspace(prisma, await requireAuth(req), req.params.id));
  });

  app.get("/api/v1/conversations/:id/messages", async (req, res) => {
    res.json(await getConversationMessages(prisma, await requireAuth(req), req.params.id, String(req.query.before || "")));
  });

  app.post("/api/v1/conversations/:id/read", json, async (req, res) => {
    res.json(await markConversationRead(prisma, await requireAuth(req), req.params.id, String(req.body?.messageId || "")));
  });

  app.post("/api/v1/conversations/:id/analyze-context", json, async (req, res) => {
    const dryRun = Boolean((req.body as { dryRun?: boolean } | undefined)?.dryRun);
    const useLlm = (req.body as { useLlm?: boolean } | undefined)?.useLlm;
    res.json(
      await analyzeAndApplyConversation(prisma, await requireAuth(req), req.params.id, {
        dryRun,
        useLlm: useLlm !== false,
      }),
    );
  });

  app.get("/api/v1/conversations/:id/context-preview", async (req, res) => {
    res.json(await analyzeConversationContext(prisma, await requireAuth(req), req.params.id, { useLlm: true }));
  });

  app.get("/api/v1/conversations/:id/agreements", async (req, res) => {
    res.json({ items: await listAgreementsForConversation(prisma, await requireAuth(req), req.params.id) });
  });

  app.post("/api/v1/conversations/:id/take", async (req, res) => {
    res.json(await setConversationMode(prisma, await requireAuth(req), req.params.id, "human"));
  });

  app.post("/api/v1/conversations/:id/return-to-ai", async (req, res) => {
    res.json(await setConversationMode(prisma, await requireAuth(req), req.params.id, "ai"));
  });

  app.post("/api/v1/conversations/:id/pause", json, async (req, res) => {
    conversationModeSchema.parse({ mode: "paused" });
    res.json(await setConversationMode(prisma, await requireAuth(req), req.params.id, "paused"));
  });

  app.post("/api/v1/conversations/:id/messages", json, async (req, res) => {
    const input = sendMessageSchema.parse(req.body);
    const message = await addConversationMessage(prisma, await requireAuth(req), req.params.id, {
      ...input,
      idempotencyKey: String(req.header("idempotency-key") || ""),
    });
    res.status(201).json(message);
  });

  app.get("/api/v1/notifications", async (req, res) => {
    res.json({ items: await listNotifications(prisma, await requireAuth(req)) });
  });

  app.post("/api/v1/notifications/:id/read", async (req, res) => {
    res.json(await markNotificationRead(prisma, await requireAuth(req), req.params.id));
  });

  app.get("/api/v1/stats/summary", async (req, res) => {
    res.json(await statsSummary(prisma, await requireAuth(req)));
  });

  app.get("/api/v1/analytics/dashboard", async (req, res) => {
    res.json(await getAnalyticsDashboard(prisma, await requireAuth(req), req.query as Record<string, string>));
  });

  app.get("/api/v1/analytics/trend", async (req, res) => {
    res.json(await getAnalyticsTrend(prisma, await requireAuth(req), req.query as Record<string, string>));
  });

  app.get("/api/v1/analytics/drilldown", async (req, res) => {
    res.json(await getAnalyticsDrilldown(prisma, await requireAuth(req), req.query as Record<string, string>));
  });

  app.get("/api/v1/companies", async (req, res) => {
    res.json(await listCompanies(prisma, await requireAuth(req), req.query as Record<string, string>));
  });

  app.post("/api/v1/companies", json, async (req, res) => {
    const input = createCompanySchema.parse(req.body || {});
    res.status(201).json(await createCompany(prisma, await requireAuth(req), input));
  });

  app.get("/api/v1/companies/duplicates", async (req, res) => {
    res.json(
      await findCompanyDuplicates(prisma, await requireAuth(req), {
        name: String(req.query.name || ""),
        bin: req.query.bin ? String(req.query.bin) : undefined,
        website: req.query.website ? String(req.query.website) : undefined,
        email: req.query.email ? String(req.query.email) : undefined,
        phone: req.query.phone ? String(req.query.phone) : undefined,
      }),
    );
  });

  app.post("/api/v1/companies/migrate-preview", async (req, res) => {
    res.json(await suggestCompaniesFromCompanyName(prisma, await requireAuth(req)));
  });

  app.get("/api/v1/companies/:id/overview", async (req, res) => {
    res.json(await getCompanyOverview(prisma, await requireAuth(req), req.params.id));
  });

  app.get("/api/v1/companies/:id", async (req, res) => {
    const overview = await getCompanyOverview(prisma, await requireAuth(req), req.params.id);
    res.json(overview.company);
  });

  app.patch("/api/v1/companies/:id", json, async (req, res) => {
    const input = updateCompanySchema.parse(req.body || {});
    res.json(await updateCompany(prisma, await requireAuth(req), req.params.id, input));
  });

  app.delete("/api/v1/companies/:id", async (req, res) => {
    res.json(await deleteCompany(prisma, await requireAuth(req), req.params.id));
  });

  app.get("/api/v1/companies/:id/contacts", async (req, res) => {
    res.json(await getCompanyContacts(prisma, await requireAuth(req), req.params.id));
  });

  app.post("/api/v1/companies/:id/contacts", json, async (req, res) => {
    const input = companyContactSchema.parse(req.body || {});
    res.status(201).json(await linkContactToCompany(prisma, await requireAuth(req), req.params.id, input));
  });

  app.patch("/api/v1/companies/:id/contacts/:linkId", json, async (req, res) => {
    const input = updateCompanyContactSchema.parse(req.body || {});
    res.json(await updateCompanyContact(prisma, await requireAuth(req), req.params.id, req.params.linkId, input));
  });

  app.delete("/api/v1/companies/:id/contacts/:linkId", async (req, res) => {
    res.json(await unlinkCompanyContact(prisma, await requireAuth(req), req.params.id, req.params.linkId));
  });

  app.get("/api/v1/contacts/:id/companies", async (req, res) => {
    res.json(await getContactCompanies(prisma, await requireAuth(req), req.params.id));
  });

  app.post("/api/v1/deals/:id/contacts", json, async (req, res) => {
    const input = dealContactSchema.parse(req.body || {});
    res.status(201).json(await addDealContact(prisma, await requireAuth(req), req.params.id, input));
  });

  app.get("/api/v1/integrations", async (req, res) => {
    res.json({ items: await listIntegrations(prisma, await requireAuth(req)) });
  });

  app.get("/api/v1/workspace/control", async (req, res) => {
    res.json(await controlBoard(prisma, await requireAuth(req)));
  });

  app.get("/api/v1/management/overview", async (req, res) => {
    res.json(await getManagementOverview(prisma, await requireAuth(req)));
  });

  app.post("/api/v1/management/ai-pause", json, async (req, res) => {
    res.json(await setAiManagerRuntimePause(prisma, await requireAuth(req), Boolean(req.body?.paused)));
  });

  app.post("/api/v1/management/claim-all-ai", json, async (req, res) => {
    res.json(await claimAllAiConversations(prisma, await requireAuth(req)));
  });

  app.get("/api/v1/integrations/setup", async (req, res) => {
    res.json(await integrationSetup(prisma, await requireAuth(req)));
  });

  app.get("/api/v1/integrations/catalog", async (req, res) => {
    const { listIntegrationCatalog } = await import("./services/integrationCatalogService.ts");
    res.json(await listIntegrationCatalog(prisma, await requireAuth(req)));
  });

  app.get("/api/v1/integrations/events", async (req, res) => {
    const { listInboundEventLog } = await import("./services/integrationCatalogService.ts");
    res.json(await listInboundEventLog(prisma, await requireAuth(req), { limit: Number(req.query.limit) || 50 }));
  });

  app.post("/api/v1/integrations/:id/health-check", async (req, res) => {
    const { runIntegrationHealthCheck } = await import("./services/integrationCatalogService.ts");
    res.json(await runIntegrationHealthCheck(prisma, await requireAuth(req), req.params.id));
  });

  app.post("/api/v1/integrations/:id/test-mode", json, async (req, res) => {
    const { setIntegrationTestMode } = await import("./services/integrationCatalogService.ts");
    res.json(
      await setIntegrationTestMode(prisma, await requireAuth(req), req.params.id, Boolean(req.body?.testMode)),
    );
  });

  app.get("/api/v1/integrations/whatsapp-seller/health", async (req, res) => {
    res.json(await sellerHealthFor(prisma, await requireAuth(req)));
  });

  app.post("/api/v1/integrations/whatsapp-seller/connect", json, async (req, res) => {
    res.json(await connectWhatsAppSeller(prisma, await requireAuth(req), req.body || {}));
  });

  app.post("/api/v1/integrations/whatsapp-seller/sync", async (req, res) => {
    res.json(await syncSellerLeads(prisma, await requireAuth(req)));
  });

  app.post("/api/v1/conversations/:id/instruction", json, async (req, res) => {
    res.json(await addSellerInstruction(prisma, await requireAuth(req), req.params.id, String(req.body?.text || "")));
  });

  app.post("/api/v1/integrations/:id/rotate-secret", async (req, res) => {
    res.json(await rotateWebhookSecret(prisma, await requireAuth(req), req.params.id));
  });

  app.post("/api/v1/telegram/begin-link", async (req, res) => {
    res.json(await beginTelegramLink(prisma, await requireAuth(req)));
  });

  app.get("/api/v1/knowledge/current", async (req, res) => {
    res.json(await knowledgeCurrent(prisma, await requireAuth(req)));
  });

  app.post("/api/v1/ai/sandbox", json, async (req, res) => {
    res.json(await aiSandbox(prisma, await requireAuth(req), String(req.body?.message || "")));
  });

  app.get("/api/v1/admin/tenants", async (req, res) => {
    res.json({ items: await platformTenants(prisma, await requireAuth(req)) });
  });

  app.post("/api/v1/integrations/:integrationId/events", rawJson, async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
    if (raw.length > 200 * 1024) {
      throw new ApiError(413, "payload_too_large", "Слишком большое тело");
    }
    const result = await ingestIntegrationEvent(prisma, req.params.integrationId, raw, {
      signature: req.header("x-crm-signature") || undefined,
      timestamp: req.header("x-crm-timestamp") || undefined,
      authorization: req.header("authorization") || undefined,
    });
    res.status(202).json(result);
  });

  app.post("/api/v1/integrations/seller-events", json, async (req, res) => {
    const secret = String(req.header("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!config.crmBridgeSecret || secret !== config.crmBridgeSecret) {
      throw new ApiError(401, "unauthorized", "Мост не принят");
    }
    const result = await ingestSellerBridgeEvent(prisma, req.body);
    res.status(202).json(result);
  });

  // Кабинет (Vite build) с того же origin — для Render / одного домена crm.creolab.kz
  const webDistCandidates = [
    path.resolve(process.cwd(), "apps/web/dist"),
    path.resolve(process.cwd(), "../web/dist"),
    path.resolve(process.cwd(), "../../apps/web/dist"),
  ];
  const webDist = webDistCandidates.find((dir) => existsSync(path.join(dir, "index.html")));
  if (webDist) {
    app.use(express.static(webDist, { index: false, maxAge: "1h" }));
    app.get(/^(?!\/api\/|\/public\/|\/health$|\/ready$).*/, (_req, res) => {
      res.sendFile(path.join(webDist, "index.html"));
    });
  } else {
    app.get("/", (_req, res) => {
      res
        .status(200)
        .type("html")
        .send(
          "<!doctype html><html><body style='font-family:sans-serif;padding:2rem'><h1>CREOLAB CRM API</h1><p>Кабинет ещё не собран. В Render Build Command должен быть: <code>npm install &amp;&amp; npm run build --workspace=@creolab/web</code></p><p><a href='/health'>/health</a></p></body></html>",
        );
    });
  }

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error && typeof error === "object" && "name" in error && error.name === "ZodError") {
      res.status(422).json({
        code: "invalid",
        message: "Проверьте поля",
        field_errors: Object.fromEntries(
          (error as { issues?: Array<{ path: (string | number)[]; message: string }> }).issues?.map((issue) => [
            String(issue.path[0] || "body"),
            issue.message,
          ]) || [],
        ),
        request_id: res.locals.requestId,
      });
      return;
    }
    const mapped = errorBody(error, res.locals.requestId);
    if (mapped.status >= 500) {
      console.error(error);
    }
    res.status(mapped.status).json(mapped.body);
  });

  void loginSchema;
  return app;
}
