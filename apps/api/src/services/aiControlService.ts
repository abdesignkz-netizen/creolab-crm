import { chatSettings } from "./controlChatSettings.ts";
import { randomInt } from "node:crypto";
import { requireFeature as requireBillingFeature } from "./entitlementService.ts";
import type { Prisma, PrismaClient } from "@creolab/db";
import {
  CONTROL_ACTION_META,
  CONTROL_ACTIONS,
  controlAccessPatchSchema,
  controlCompanyPatchSchema,
  controlConfirmSchema,
  controlExecuteSchema,
  controlIdentityCreateSchema,
  controlVerifySchema,
  PERMISSIONS,
  validateClientPhone,
  type ControlAction,
  type ControlSource,
} from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { writeAudit } from "../lib/audit.ts";
import { can, requireCompanyAdmin, requireTenant } from "../lib/access.ts";
import { hmacSha256Hex, safeEqual, sha256 } from "../lib/hash.ts";
import { redactSensitive } from "../lib/redact.ts";
import { decryptSecret } from "../lib/secretBox.ts";
import type { AuthContext } from "../lib/types.ts";
import { authForUserInTenant } from "./authService.ts";
import { getAnalyticsDashboard } from "./analyticsService.ts";
import { createCampaign } from "./campaignService.ts";
import {
  createContact,
  deleteContact,
  getContactOverview,
  listContactsBoard,
  updateContact,
  writeActivity,
} from "./contactService.ts";
import {
  changeDealStage,
  createDeal,
  getDeal,
  getDealBoard,
  updateDeal,
} from "./dealService.ts";
import {
  assignTask,
  completeTask,
  createTask,
  getConversation,
  listDeals,
} from "./domainService.ts";
import { withIdempotency } from "./idempotency.ts";
import { createManualInquiry, listInquiries, updateInquiry } from "./inquiryService.ts";
import { mapControlPeriod } from "./controlPeriods.ts";
import { controlTasks, controlRecentLeads, controlRecentDeals } from "./controlReadQueries.ts";
import { controlUnchangedDeals, controlProposalsWithoutFollowup, controlLostReasons, controlExpectedPayments } from "./controlDealQueries.ts";
import { searchContactsForPicker } from "./segmentService.ts";
import { getSituationOverview } from "./situationOverviewService.ts";
import { updateTaskDraft } from "./taskExecutionService.ts";

const CONFIRM_TTL_MS = 10 * 60 * 1000;
const TIMESTAMP_SKEW_MS = 5 * 60 * 1000;
const BULK_MAX = 100;

const CONTROL_ACTION_ALIASES: Record<string, ControlAction> = {
  GET_DEAL_DETAILS: "GET_DEAL",
  GET_PERIOD_SUMMARY: "GENERATE_REPORT",
  GET_SALES_REPORT: "GENERATE_REPORT",
  GET_TEAM_REPORT: "GENERATE_REPORT",
};

type ControlAccessRow = {
  id: string;
  tenantId: string;
  userId: string;
  enabled: boolean;
  allowedSources: unknown;
  allowedActions: unknown;
  canReadFinancialData: boolean;
  canReadTeamData: boolean;
  canModifyDeals: boolean;
  canCreateTasks: boolean;
  canPerformBulkActions: boolean;
  requiresConfirmationForWrites: boolean;
  status: string;
  lastActivityAt: Date | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown) {
  return String(value ?? "").trim();
}

function asStringList(value: unknown) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function controlCompanyEnabled(settingsJson: unknown) {
  return Boolean(asRecord(asRecord(settingsJson).control).enabled);
}

function defaultAccessFlags(role: string) {
  const lead = role === "owner" || role === "director" || role === "sales_lead";
  return {
    canReadFinancialData: lead,
    canReadTeamData: lead,
    canCreateTasks: lead,
    canModifyDeals: lead,
    canPerformBulkActions: false,
    requiresConfirmationForWrites: true,
    allowedSources: ["WHATSAPP", "CRM_CHAT"] as ControlSource[],
    allowedActions: [] as ControlAction[],
  };
}

function parseTimestamp(value: string | undefined) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/^\d{10}$/.test(raw)) return Number(raw) * 1000;
  if (/^\d{13}$/.test(raw)) return Number(raw);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function periodLabelRu(label: string) {
  switch (label) {
    case "today":
      return "Сегодня";
    case "yesterday":
      return "Вчера";
    case "this_week":
      return "Эта неделя";
    case "last_7":
    case "last_7_days":
      return "За неделю";
    case "last_week":
      return "Прошлая неделя";
    case "last_30":
    case "last_30_days":
      return "За 30 дней";
    case "this_month":
      return "Этот месяц";
    case "last_month":
      return "Прошлый месяц";
    default:
      return label || "Сегодня";
  }
}

function presentControlData(action: ControlAction, data: Record<string, unknown>, periodLabel: string) {
  const next = { ...data };
  if (!next.periodLabel) next.periodLabel = periodLabel;
  if (action === "GET_LEADS_STATS") {
    next.stats = {
      totalLeads: next.total,
      leads: next.total,
      total: next.total,
      new: next.new,
      newLeads: next.new,
      inProgress: next.inProgress,
      closed: next.closed,
    };
  }
  if (action === "GET_BUSINESS_SUMMARY") {
    next.stats = {
      newLeads: next.inquiries,
      leads: next.inquiries,
      deals: next.dealsCreated,
      needAttention: asRecord(next.attention).count ?? next.attention ?? null,
      revenue: next.revenueLabel || next.revenue,
      receipts: next.receiptsLabel,
    };
  }
  if (action === "GET_DEALS_STATS") {
    next.stats = {
      deals: next.created,
      closed: Number(next.won || 0) + Number(next.lost || 0),
      revenue: next.revenueLabel || next.revenue,
      receipts: next.receiptsLabel,
    };
  }
  if (action === "GET_REVENUE_STATS") {
    next.stats = { revenue: next.revenueLabel || next.revenue, receipts: next.receiptsLabel };
  }
  if (action === "GET_STUCK_DEALS") {
    next.stats = { stuckDeals: next.total ?? (Array.isArray(next.items) ? next.items.length : 0) };
  }
  if (action === "GET_OVERDUE_TASKS") {
    next.stats = { overdueTasks: next.total ?? (Array.isArray(next.items) ? next.items.length : 0) };
  }
  return next;
}

function normalizeExecuteBody(
  body: unknown,
  headers: { requestIdHeader?: string; senderPhone?: string },
) {
  const raw = asRecord(body);
  const actionRaw = asString(raw.action).toUpperCase();
  return {
    action: CONTROL_ACTION_ALIASES[actionRaw] || actionRaw,
    params: asRecord(raw.params),
    requestId: asString(raw.requestId) || asString(headers.requestIdHeader),
    externalIdentity:
      asString(raw.externalIdentity) || asString(raw.senderPhone) || asString(headers.senderPhone),
    source: asString(raw.source) || "WHATSAPP",
    tenantId: asString(raw.tenantId) || undefined,
    confirm: Boolean(raw.confirm),
    confirmationId: asString(raw.confirmationId),
  };
}

function sellerSecretPlain(schemaJson: unknown) {
  const secretEnc = asString(asRecord(schemaJson).secretEnc);
  if (!secretEnc) return "";
  try {
    return decryptSecret(secretEnc);
  } catch {
    return secretEnc.includes(":") ? "" : secretEnc;
  }
}

async function resolveControlIntegration(
  prisma: PrismaClient,
  input: { secret: string; integrationId?: string | null },
) {
  const secret = String(input.secret || "").trim();
  const rawId = String(input.integrationId || "").trim();
  const hinted = rawId && rawId.toLowerCase() !== "legacy" ? rawId : "";
  if (!secret) {
    throw new ApiError(401, "unauthorized", "Нужны интеграция и секрет");
  }

  const bearerHash = sha256(secret);
  const secretMatches = (integration: {
    secretHash: string | null;
    previousSecretHash: string | null;
    previousSecretExpiresAt: Date | null;
    schemaJson: unknown;
  }) => {
    const hashOk = Boolean(integration.secretHash && safeEqual(bearerHash, integration.secretHash));
    const prevOk = Boolean(
      integration.previousSecretHash &&
        integration.previousSecretExpiresAt &&
        integration.previousSecretExpiresAt.getTime() > Date.now() &&
        safeEqual(bearerHash, integration.previousSecretHash),
    );
    const plain = sellerSecretPlain(integration.schemaJson);
    const plainOk = Boolean(plain && safeEqual(secret, plain));
    return hashOk || prevOk || plainOk;
  };

  const assertUsable = <T extends { status: string; connectionStatus: string; tenant: { status: string } }>(
    integration: T,
  ) => {
    if (integration.status === "disabled" || integration.connectionStatus === "DISCONNECTED") {
      throw new ApiError(403, "disabled", "Интеграция отключена");
    }
    if (integration.tenant.status !== "active") {
      throw new ApiError(403, "tenant_suspended", "Компания приостановлена");
    }
    return integration;
  };

  if (hinted) {
    const integration = await prisma.integration.findFirst({
      where: { id: hinted },
      include: { tenant: true },
    });
    if (integration) {
      if (!secretMatches(integration)) {
        throw new ApiError(401, "unauthorized", "Секрет интеграции не принят");
      }
      return assertUsable(integration);
    }
  }

  const sellers = await prisma.integration.findMany({
    where: { type: "whatsapp_seller" },
    include: { tenant: true },
  });
  const matches = sellers.filter((row) => secretMatches(row));
  if (matches.length === 1) return assertUsable(matches[0]);
  if (matches.length > 1) {
    throw new ApiError(401, "unauthorized", "Секрет интеграции неоднозначен");
  }
  throw new ApiError(401, "unauthorized", hinted ? "Интеграция не найдена" : "Нужны интеграция и секрет");
}

function assertFreshTimestamp(timestampHeader: string | undefined) {
  const raw = String(timestampHeader || "").trim();
  if (!raw) return;
  const ts = parseTimestamp(timestampHeader);
  if (ts == null) throw new ApiError(401, "replay_protection", "Нужен x-crm-timestamp");
  if (Math.abs(Date.now() - ts) > TIMESTAMP_SKEW_MS) {
    throw new ApiError(401, "replay_protection", "Метка времени просрочена");
  }
}

function assertOptionalSignature(input: {
  secret: string;
  timestamp?: string;
  requestId: string;
  signature?: string;
}) {
  const signature = String(input.signature || "").trim();
  if (!signature) return;
  const expected = hmacSha256Hex(input.secret, `${input.timestamp || ""}.${input.requestId}`);
  if (!safeEqual(signature.toLowerCase(), expected.toLowerCase())) {
    throw new ApiError(401, "unauthorized", "Подпись запроса неверна");
  }
}

function normalizeIdentity(provider: ControlSource, raw: string, region: string) {
  const value = String(raw || "").trim();
  if (provider === "WHATSAPP") {
    const phone = validateClientPhone(value, region);
    if (!phone.ok) throw new ApiError(422, phone.code, phone.message);
    return { externalUserId: phone.normalized, phoneNormalized: phone.normalized };
  }
  return { externalUserId: value, phoneNormalized: null as string | null };
}

function sixDigitCode() {
  return String(randomInt(100000, 1000000));
}

function serializeAccess(row: ControlAccessRow | null, user: { id: string; name: string; email: string; role: string }) {
  const flags = defaultAccessFlags(user.role);
  return {
    userId: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    enabled: Boolean(row?.enabled && row.status === "active"),
    status: row?.status || "disabled",
    allowedSources: Array.isArray(row?.allowedSources) ? row.allowedSources : flags.allowedSources,
    allowedActions: Array.isArray(row?.allowedActions) ? row.allowedActions : [],
    canReadFinancialData: row?.canReadFinancialData ?? flags.canReadFinancialData,
    canReadTeamData: row?.canReadTeamData ?? flags.canReadTeamData,
    canCreateTasks: row?.canCreateTasks ?? flags.canCreateTasks,
    canModifyDeals: row?.canModifyDeals ?? flags.canModifyDeals,
    canPerformBulkActions: row?.canPerformBulkActions ?? false,
    requiresConfirmationForWrites: row?.requiresConfirmationForWrites ?? true,
    lastActivityAt: row?.lastActivityAt?.toISOString() || null,
  };
}

function assertControlPermission(access: ControlAccessRow, action: ControlAction, source: ControlSource) {
  if (!access.enabled || access.status !== "active") {
    throw new ApiError(403, "control_disabled", "BasQar Control выключен для этого пользователя");
  }
  const sources = asStringList(access.allowedSources);
  if (sources.length && !sources.includes(source)) {
    throw new ApiError(403, "forbidden", "Источник не разрешён");
  }
  const actions = asStringList(access.allowedActions);
  if (actions.length && !actions.includes(action)) {
    throw new ApiError(403, "forbidden", "Действие не разрешено в BasQar Control");
  }
  const meta = CONTROL_ACTION_META[action];
  if (meta.financial && !access.canReadFinancialData) {
    throw new ApiError(403, "forbidden", "Нет права на финансовые данные");
  }
  if (meta.team && !access.canReadTeamData) {
    throw new ApiError(403, "forbidden", "Нет права на данные команды");
  }
  if (meta.bulk && !access.canPerformBulkActions) {
    throw new ApiError(403, "forbidden", "Нет права на массовые действия");
  }
  if (["CREATE_TASK", "CREATE_FOLLOW_UP", "UPDATE_TASK", "COMPLETE_TASK", "ASSIGN_TASK", "BULK_CREATE_TASKS"].includes(action) && !access.canCreateTasks) {
    throw new ApiError(403, "forbidden", "Нет права изменять задачи");
  }
  if (["CREATE_DEAL", "UPDATE_DEAL", "MOVE_DEAL_STAGE", "ASSIGN_DEAL", "ADD_DEAL_NOTE", "BULK_ASSIGN_DEALS", "BULK_MOVE_DEALS"].includes(action) && !access.canModifyDeals) {
    throw new ApiError(403, "forbidden", "Нет права изменять сделки");
  }
  if (action === "EXPORT_REPORT" ) {
    /* CRM export_all is checked in handler */
  }
}

function needsConfirmation(access: ControlAccessRow, action: ControlAction) {
  const risk = CONTROL_ACTION_META[action].riskLevel;
  if (risk === "READ") return false;
  if (risk === "HIGH_RISK") return true;
  return Boolean(access.requiresConfirmationForWrites);
}

function compactTask(item: Record<string, unknown>) {
  return {
    id: item.id,
    title: item.title,
    type: item.type,
    status: item.status,
    dueAt: item.dueAt,
    overdue: item.overdue,
    contactName: item.contactName || item.whoName || null,
    phone: item.phone || item.whoPhone || null,
    ownerName: item.ownerName || item.assigneeName || asRecord(asRecord(item.owner).user).name || null,
  };
}

function compactDeal(item: Record<string, unknown>, financial: boolean) {
  const stage = asRecord(item.stage);
  return {
    id: item.id,
    title: item.title,
    outcome: item.outcome,
    stage: stage.name || item.stageName || stage.systemKey || null,
    contactName: asRecord(item.contact).name || item.contactName || null,
    assigneeName: asRecord(item.owner).name || item.ownerName || item.assigneeName || null,
    ...(financial
      ? {
          amountMinor: item.offerAmountMinor ?? item.amountMinor ?? null,
          paymentStatus: item.paymentStatus,
        }
      : {}),
  };
}

function compactClient(item: Record<string, unknown>) {
  return {
    id: item.id,
    name: item.name,
    phone: item.phone || item.phoneRaw || null,
    companyName: item.companyName || null,
    lifecycleStatus: item.lifecycleStatus || null,
  };
}

function ok(action: ControlAction, data: unknown, meta: Record<string, unknown> = {}) {
  const periodLabel = periodLabelRu(asString(meta.period));
  const presented =
    data && typeof data === "object" && !Array.isArray(data)
      ? presentControlData(action, asRecord(data), periodLabel)
      : data;
  return {
    success: true as const,
    status: "OK" as const,
    action,
    data: presented,
    meta: { ...meta, periodLabel },
  };
}

async function touchAccess(prisma: PrismaClient, accessId: string) {
  await prisma.controlAccess.update({ where: { id: accessId }, data: { lastActivityAt: new Date() } }).catch(() => undefined);
}

async function writeControlAudit(
  prisma: PrismaClient,
  input: {
    tenantId: string;
    userId: string;
    identityId?: string | null;
    source: string;
    action: string;
    params: unknown;
    result: string;
    status: string;
    confirmationId?: string | null;
    requestId: string;
    durationMs: number;
    error?: string | null;
  },
) {
  await writeAudit(prisma, {
    tenantId: input.tenantId,
    actorUserId: input.userId,
    action: `control.${input.action.toLowerCase()}`,
    entityType: "control_command",
    entityId: input.confirmationId || input.requestId,
    correlationId: input.requestId,
    changes: {
      source: input.source,
      identityId: input.identityId || null,
      params: redactSensitive(input.params),
      result: input.result,
      status: input.status,
      confirmationId: input.confirmationId || null,
      requestId: input.requestId,
      durationMs: input.durationMs,
      error: input.error || null,
    },
  });
}

export async function getControlSettings(prisma: PrismaClient, auth: AuthContext) {
  requireCompanyAdmin(auth, "BasQar Control доступен администратору и директору");
  const membership = requireTenant(auth);
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: membership.tenantId } });
  const [members, accesses, identities, senders, deliveries] = await Promise.all([
    prisma.membership.findMany({
      where: { tenantId: membership.tenantId, active: true },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.controlAccess.findMany({ where: { tenantId: membership.tenantId } }),
    prisma.controlIdentity.findMany({ where: { tenantId: membership.tenantId } }),
    prisma.integration.findMany({ where: { tenantId: membership.tenantId, type: { in: ["whatsapp_qr", "whatsapp_cloud"] } }, select: { id: true, name: true, type: true, status: true, connectionStatus: true, schemaJson: true } }),
    prisma.controlChatMessage.findMany({ where: { tenantId: membership.tenantId }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, identityId: true, state: true, kind: true, error: true, createdAt: true } }),
  ]);
  const accessByUser = new Map(accesses.map((row) => [row.userId, row]));
  return {
    enabled: controlCompanyEnabled(tenant.settingsJson),
    timezone: tenant.timezone || "Asia/Almaty",
    senders: senders.map(row => ({ id: row.id, name: row.name, type: row.type, phone: asString(asRecord(row.schemaJson).phone), ready: row.status === "active" && row.connectionStatus === "CONNECTED" })),
    deliveries,
    catalog: CONTROL_ACTIONS.map((action) => ({
      action,
      ...CONTROL_ACTION_META[action],
    })),
    users: members.map((item) => {
      const access = serializeAccess(accessByUser.get(item.userId) || null, {
        id: item.user.id,
        name: item.user.name,
        email: item.user.email,
        role: item.role,
      });
      const links = identities.filter((row) => row.userId === item.userId);
      return {
        ...access,
        membershipId: item.id,
        identities: links.map((row) => ({
          id: row.id,
          provider: row.provider,
          externalUserId: row.externalUserId,
          phoneNormalized: row.phoneNormalized,
          verified: Boolean(row.verifiedAt),
          verifiedAt: row.verifiedAt?.toISOString() || null,
          enabled: row.enabled,
          chat: chatSettings(row.metadata),
        })),
      };
    }),
  };
}

export async function updateControlCompany(prisma: PrismaClient, auth: AuthContext, input: unknown) {
  requireCompanyAdmin(auth);
  const membership = requireTenant(auth);
  const parsed = controlCompanyPatchSchema.parse(input);
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: membership.tenantId } });
  const settings = asRecord(tenant.settingsJson);
  settings.control = { ...asRecord(settings.control), enabled: parsed.enabled };
  await prisma.tenant.update({
    where: { id: membership.tenantId },
    data: { settingsJson: settings as Prisma.InputJsonValue },
  });
  await writeAudit(prisma, {
    tenantId: membership.tenantId,
    actorUserId: auth.user.id,
    action: "control.settings_updated",
    entityType: "tenant",
    entityId: membership.tenantId,
    changes: { enabled: parsed.enabled },
  });
  return getControlSettings(prisma, auth);
}

export async function upsertControlAccess(prisma: PrismaClient, auth: AuthContext, userId: string, input: unknown) {
  requireCompanyAdmin(auth);
  const membership = requireTenant(auth);
  const parsed = controlAccessPatchSchema.parse(input || {});
  const target = await prisma.membership.findFirst({
    where: { tenantId: membership.tenantId, userId, active: true },
    include: { user: true },
  });
  if (!target) throw new ApiError(404, "not_found", "Сотрудник не найден");
  const defaults = defaultAccessFlags(target.role);
  const existing = await prisma.controlAccess.findUnique({
    where: { tenantId_userId: { tenantId: membership.tenantId, userId } },
  });
  const enabled = parsed.enabled ?? existing?.enabled ?? false;
  const row = await prisma.controlAccess.upsert({
    where: { tenantId_userId: { tenantId: membership.tenantId, userId } },
    create: {
      tenantId: membership.tenantId,
      userId,
      enabled,
      status: enabled ? "active" : "disabled",
      allowedSources: parsed.allowedSources ?? defaults.allowedSources,
      allowedActions: parsed.allowedActions ?? [],
      canReadFinancialData: parsed.canReadFinancialData ?? defaults.canReadFinancialData,
      canReadTeamData: parsed.canReadTeamData ?? defaults.canReadTeamData,
      canCreateTasks: parsed.canCreateTasks ?? defaults.canCreateTasks,
      canModifyDeals: parsed.canModifyDeals ?? defaults.canModifyDeals,
      canPerformBulkActions: parsed.canPerformBulkActions ?? false,
      requiresConfirmationForWrites: parsed.requiresConfirmationForWrites ?? true,
    },
    update: {
      ...(parsed.enabled != null ? { enabled, status: enabled ? "active" : "disabled" } : {}),
      ...(parsed.allowedSources ? { allowedSources: parsed.allowedSources } : {}),
      ...(parsed.allowedActions ? { allowedActions: parsed.allowedActions } : {}),
      ...(parsed.canReadFinancialData != null ? { canReadFinancialData: parsed.canReadFinancialData } : {}),
      ...(parsed.canReadTeamData != null ? { canReadTeamData: parsed.canReadTeamData } : {}),
      ...(parsed.canCreateTasks != null ? { canCreateTasks: parsed.canCreateTasks } : {}),
      ...(parsed.canModifyDeals != null ? { canModifyDeals: parsed.canModifyDeals } : {}),
      ...(parsed.canPerformBulkActions != null ? { canPerformBulkActions: parsed.canPerformBulkActions } : {}),
      ...(parsed.requiresConfirmationForWrites != null
        ? { requiresConfirmationForWrites: parsed.requiresConfirmationForWrites }
        : {}),
    },
  });
  await writeAudit(prisma, {
    tenantId: membership.tenantId,
    actorUserId: auth.user.id,
    action: "control.access_updated",
    entityType: "control_access",
    entityId: row.id,
    changes: { userId, enabled: row.enabled },
  });
  return getControlSettings(prisma, auth);
}

export async function createControlIdentity(prisma: PrismaClient, auth: AuthContext, input: unknown) {
  requireCompanyAdmin(auth);
  const membership = requireTenant(auth);
  const parsed = controlIdentityCreateSchema.parse(input);
  const target = await prisma.membership.findFirst({
    where: { tenantId: membership.tenantId, userId: parsed.userId, active: true },
  });
  if (!target) throw new ApiError(404, "not_found", "Сотрудник не найден");
  const raw = parsed.phone || parsed.externalUserId;
  if (!raw) throw new ApiError(422, "invalid", "Укажите номер или внешний идентификатор");
  const ident = normalizeIdentity(parsed.provider, raw, membership.tenant.defaultRegion || "KZ");
  const existingIdentity = await prisma.controlIdentity.findUnique({ where: { tenantId_provider_externalUserId: { tenantId: membership.tenantId, provider: parsed.provider, externalUserId: ident.externalUserId } } });
  if (existingIdentity && existingIdentity.userId !== parsed.userId) throw new ApiError(409, "phone_in_use", "Номер уже привязан к другому сотруднику");
  const code = sixDigitCode();
  const verifyNow = Boolean(parsed.verifyNow);
  const row = await prisma.controlIdentity.upsert({
    where: {
      tenantId_provider_externalUserId: {
        tenantId: membership.tenantId,
        provider: parsed.provider,
        externalUserId: ident.externalUserId,
      },
    },
    create: {
      tenantId: membership.tenantId,
      userId: parsed.userId,
      provider: parsed.provider,
      externalUserId: ident.externalUserId,
      phoneNormalized: ident.phoneNormalized,
      enabled: true,
      verifiedAt: verifyNow ? new Date() : null,
      verificationCodeHash: verifyNow ? null : sha256(code),
      verificationExpiresAt: verifyNow ? null : new Date(Date.now() + 30 * 60 * 1000),
    },
    update: {
      userId: parsed.userId,
      metadata: { ...asRecord(existingIdentity?.metadata), verificationAttempts: 0 },
      phoneNormalized: ident.phoneNormalized,
      enabled: true,
      verifiedAt: verifyNow ? new Date() : null,
      verificationCodeHash: verifyNow ? null : sha256(code),
      verificationExpiresAt: verifyNow ? null : new Date(Date.now() + 30 * 60 * 1000),
    },
  });
  await writeAudit(prisma, {
    tenantId: membership.tenantId,
    actorUserId: auth.user.id,
    action: "control.identity_linked",
    entityType: "control_identity",
    entityId: row.id,
    changes: { userId: parsed.userId, provider: parsed.provider, verifyNow },
  });
  return {
    identity: {
      id: row.id,
      provider: row.provider,
      externalUserId: row.externalUserId,
      verified: Boolean(row.verifiedAt),
    },
    verificationCode: verifyNow ? null : code,
  };
}

export async function disableControlIdentity(prisma: PrismaClient, auth: AuthContext, id: string) {
  requireCompanyAdmin(auth);
  const membership = requireTenant(auth);
  const row = await prisma.controlIdentity.findFirst({ where: { id, tenantId: membership.tenantId } });
  if (!row) throw new ApiError(404, "not_found", "Привязка не найдена");
  await prisma.controlIdentity.update({
    where: { id },
    data: { enabled: false, verifiedAt: null, verificationCodeHash: null },
  });
  await writeAudit(prisma, {
    tenantId: membership.tenantId,
    actorUserId: auth.user.id,
    action: "control.identity_disabled",
    entityType: "control_identity",
    entityId: id,
  });
  return getControlSettings(prisma, auth);
}

export async function adminVerifyControlIdentity(prisma: PrismaClient, auth: AuthContext, id: string) {
  requireCompanyAdmin(auth);
  const membership = requireTenant(auth);
  const row = await prisma.controlIdentity.findFirst({ where: { id, tenantId: membership.tenantId } });
  if (!row) throw new ApiError(404, "not_found", "Привязка не найдена");
  await prisma.controlIdentity.update({
    where: { id },
    data: { verifiedAt: new Date(), enabled: true, verificationCodeHash: null, verificationExpiresAt: null },
  });
  return getControlSettings(prisma, auth);
}

export async function listControlHistory(
  prisma: PrismaClient,
  auth: AuthContext,
  query: Record<string, string | undefined> = {},
) {
  requireCompanyAdmin(auth);
  const membership = requireTenant(auth);
  const page = Math.max(1, Number(query.page || 1));
  const take = Math.min(100, Math.max(10, Number(query.limit || 40)));
  const where: Prisma.AuditEventWhereInput = {
    tenantId: membership.tenantId,
    action: query.action ? `control.${String(query.action).toLowerCase()}` : { startsWith: "control.", not: "control.chat" },
  };
  if (query.userId) where.actorUserId = query.userId;
  if (query.from || query.to) {
    where.createdAt = {
      ...(query.from ? { gte: new Date(query.from) } : {}),
      ...(query.to ? { lte: new Date(query.to) } : {}),
    };
  }
  const [totalAll, raw] = await Promise.all([
    prisma.auditEvent.count({ where }),
    prisma.auditEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 300,
    }),
  ]);
  const filtered = raw.filter((item) => {
    const changes = asRecord(item.changesJson);
    if (query.source && String(changes.source || "") !== query.source) return false;
    if (query.status && String(changes.status || "") !== query.status) return false;
    return true;
  });
  const total = query.source || query.status ? filtered.length : totalAll;
  const items = filtered.slice((page - 1) * take, page * take);
  const actorIds = [...new Set(items.map((item) => item.actorUserId).filter(Boolean))] as string[];
  const actors = actorIds.length
    ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, email: true } })
    : [];
  const actorMap = new Map(actors.map((item) => [item.id, item]));
  return {
    page,
    pageSize: take,
    total,
    items: items.map((item) => {
      const changes = asRecord(item.changesJson);
      return {
        id: item.id,
        action: String(item.action).replace(/^control\./, "").toUpperCase(),
        status: changes.status || null,
        source: changes.source || null,
        title: asString(asRecord(changes.params).title).slice(0, 300) || null,
        requestId: changes.requestId || item.correlationId,
        createdAt: item.createdAt,
        actor: item.actorUserId ? actorMap.get(item.actorUserId) || null : null,
        durationMs: changes.durationMs ?? null,
        error: changes.error || null,
      };
    }),
  };
}

async function resolveLinkedIdentity(
  prisma: PrismaClient,
  tenantId: string,
  source: ControlSource,
  externalIdentity: string,
  region: string,
) {
  const ident = normalizeIdentity(source, externalIdentity, region);
  const row = await prisma.controlIdentity.findFirst({
    where: {
      tenantId,
      provider: source,
      enabled: true,
      OR: [
        { externalUserId: ident.externalUserId },
        ...(ident.phoneNormalized ? [{ phoneNormalized: ident.phoneNormalized }] : []),
      ],
    },
  });
  if (!row || !row.verifiedAt) {
    throw new ApiError(403, "identity_not_linked", "Внешний аккаунт не привязан");
  }
  return row;
}

type DispatchCtx = {
  prisma: PrismaClient;
  auth: AuthContext;
  access: ControlAccessRow;
  params: Record<string, unknown>;
  period: ReturnType<typeof mapControlPeriod>;
};

async function analytics(ctx: DispatchCtx) {
  return getAnalyticsDashboard(ctx.prisma, ctx.auth, {
    period: ctx.period.period,
    dateFrom: ctx.period.dateFrom,
    dateTo: ctx.period.dateTo,
    compare: "none",
  });
}

async function situation(ctx: DispatchCtx) {
  return getSituationOverview(ctx.prisma, ctx.auth, {
    period: ctx.period.period,
    dateFrom: ctx.period.dateFrom,
    dateTo: ctx.period.dateTo,
  });
}

async function dispatchAction(action: ControlAction, ctx: DispatchCtx): Promise<unknown> {
  const { prisma, auth, access, params } = ctx;
  const currency = auth.activeMembership?.tenant.currency || "KZT";
  const financial = access.canReadFinancialData;
  const moneyReport = (dash: Awaited<ReturnType<typeof analytics>>) => ({
    revenue: dash.overview.revenue, revenueLabel: dash.overview.revenueLabel,
    receipts: dash.overview.receipts, receiptsLabel: dash.overview.receiptsLabel,
    salesByCurrency: dash.financial.sales.byCurrency, receiptsByCurrency: dash.financial.receipts.byCurrency,
    currency, salesDateBasis: "closedAt", receiptsDateBasis: "confirmedAt",
  });

  switch (action) {
    case "GET_BUSINESS_SUMMARY": {
      const dash = await analytics(ctx);
      const sit = await situation(ctx);
      return {
        inquiries: dash.overview?.inquiries ?? 0,
        dealsCreated: dash.overview?.dealsCreated ?? 0,
        won: dash.overview?.won ?? 0,
        lost: dash.overview?.lost ?? 0,
        conversion: dash.overview.conversion, closedDeals: dash.overview.closedDeals, conversionBasis: dash.overview.conversionBasis,
        attention: asRecord(sit.attention).summary || null,
        ...(financial
          ? moneyReport(dash)
          : {}),
      };
    }
    case "GET_SITUATION": {
      const sit = await situation(ctx);
      return {
        result: financial ? sit.result : { inquiries: sit.result.inquiries, newClients: sit.result.newClients, dealsCreated: sit.result.dealsCreated, wonDeals: sit.result.wonDeals, lostDeals: sit.result.lostDeals },
        current: financial
          ? sit.current
          : { activeDeals: sit.current.activeDeals, needsReply: sit.current.needsReply, overdueTasks: sit.current.overdueTasks },
        attention: asRecord(sit.attention).summary || null,
        todayTasks: sit.todayTasks,
        ...(financial ? { payments: sit.payments } : {}),
      };
    }
    case "GET_LEADS_STATS": {
      await analytics(ctx);
      const listed = await listInquiries(prisma, auth, {
        period: ctx.period.period,
        dateFrom: ctx.period.dateFrom,
        dateTo: ctx.period.dateTo,
        limit: "1",
      });
      const counts = asRecord(listed.counts);
      return {
        total: counts.all ?? listed.total ?? 0,
        new: counts.new ?? 0,
        inProgress: counts.in_progress ?? 0,
        closed: Number(counts.converted || 0) + Number(counts.lost || 0),
        needsReply: counts.needs_reply ?? 0,
      };
    }
    case "GET_DEALS_STATS": {
      const dash = await analytics(ctx);
      return {
        created: dash.overview?.dealsCreated ?? 0,
        won: dash.overview?.won ?? 0,
        lost: dash.overview?.lost ?? 0,
        conversion: dash.overview.conversion, closedDeals: dash.overview.closedDeals, conversionBasis: dash.overview.conversionBasis,
        ...(financial
          ? { ...moneyReport(dash), pipeline: dash.sales?.pipeline ?? null }
          : {}),
      };
    }
    case "GET_REVENUE_STATS": {
      const dash = await analytics(ctx);
      return {
        ...moneyReport(dash),
        avgCheck: dash.sales?.avgCheck ?? null,
        plan: dash.sales.plan,
        planMinor: dash.sales?.planMinor ?? null,
        planPercent: dash.sales?.planPercent ?? null,
        currency,
      };
    }
    case "GET_SALES_FORECAST": {
      // This estimate covers the current company month only. Never silently
      // discard an owner/client filter or substitute a different horizon.
      if (ctx.period.label !== "this_month" || Object.keys(params).some(key => key !== "period")) {
        throw new ApiError(422, "forecast_period", "Прогноз доступен только на текущий месяц по компании. Напишите «Прогноз продаж на этот месяц». Фильтры можно выбрать в статистике.");
      }
      const { getCompanySalesForecast } = await import("./salesForecastService.ts");
      return { forecast: await getCompanySalesForecast(prisma, auth, ctx.period.now) };
    }
    case "GET_SALES_CONTROL": {
      const { getSalesControl } = await import("./salesControlService.ts");
      const report = await getSalesControl(prisma, auth);
      const filter = ["attention", "ready", "goal"].includes(String(params.filter)) ? String(params.filter) : "all";
      return { ...report, filter, items: report.items.filter(item => filter === "all" || filter === "attention" && item.blockers.length || filter === "ready" && item.closeToSale || filter === "goal" && item.goalReached) };
    }
    case "GET_PIPELINE_SUMMARY": {
      const sit = await situation(ctx);
      const pipeline = asRecord(sit.pipeline);
      return {
        stages: pipeline.stages || [],
        biggestDrop: pipeline.biggestDrop || null,
      };
    }
    case "GET_STUCK_DEALS": {
      const board = await getDealBoard(prisma, auth, { focus: "stalled", period: ctx.period.period });
      const columns = Array.isArray(board.columns) ? board.columns : [];
      const deals = columns.flatMap((col: { deals?: unknown[] }) => col.deals || []).slice(0, 30);
      return { items: deals.map((item) => compactDeal(asRecord(item), financial)), total: deals.length };
    }
    case "GET_UNCHANGED_DEALS": return controlUnchangedDeals(ctx);
    case "GET_PROPOSALS_WITHOUT_FOLLOWUP": return controlProposalsWithoutFollowup(ctx);
    case "GET_LOST_REASONS": return controlLostReasons(ctx);
    case "GET_EXPECTED_PAYMENTS": return controlExpectedPayments(ctx);
    case "GET_OVERDUE_TASKS":
    case "GET_TASKS":
    case "GET_TODAY_TASKS":
      return controlTasks(ctx, action);
    case "GET_CLIENTS": {
      const board = await listContactsBoard(prisma, auth, { limit: "30" });
      const items = Array.isArray(board.items) ? board.items : [];
      return { items: items.slice(0, 30).map((item: Record<string, unknown>) => compactClient(item)) };
    }
    case "FIND_CLIENT": {
      const q = asString(params.q || params.query || params.phone || params.name);
      if (!q) throw new ApiError(422, "invalid", "Укажите запрос для поиска клиента");
      const found = await searchContactsForPicker(prisma, auth, q);
      const items = Array.isArray(found) ? found : asRecord(found).clients;
      return { items: (Array.isArray(items) ? items : []).slice(0, 20) };
    }
    case "GET_CLIENT_DETAILS": {
      const id = asString(params.clientId || params.contactId || params.id);
      if (!id) throw new ApiError(422, "invalid", "Укажите clientId");
      const overview = await getContactOverview(prisma, auth, id);
      if (financial) return overview;
      return { client: { id: overview.client.id, name: overview.client.name, phone: overview.client.phone, companyName: overview.client.companyName, lifecycleLabel: overview.client.lifecycleLabel },
        tasks: overview.tasks.map(item => compactTask(asRecord(item))), deals: overview.deals.map(item => compactDeal(asRecord(item), false)) };
    }
    case "GET_DEAL": {
      const id = asString(params.dealId || params.id);
      if (!id) throw new ApiError(422, "invalid", "Укажите dealId");
      const row = await getDeal(prisma, auth, id);
      if (financial) return row;
      return { deal: compactDeal(asRecord(row.deal), false), stageHistory: row.stageHistory };
    }
    case "FIND_DEAL": {
      const q = asString(params.q || params.query || params.title);
      if (q.length < 2) throw new ApiError(422, "invalid", "Укажите название сделки");
      const deals = await listDeals(prisma, auth);
      const items = (deals as Array<Record<string, unknown>>).filter((item) =>
        String(item.title || "").toLowerCase().includes(q.toLowerCase()),
      );
      return { items: items.slice(0, 20).map((item) => compactDeal(item, financial)) };
    }
    case "GET_MANAGER_PERFORMANCE": {
      const dash = await analytics(ctx);
      return { managers: dash.managers || [] };
    }
    case "GET_TEAM_STATUS": {
      const sit = await situation(ctx);
      return { team: sit.team || [] };
    }
    case "GET_RECENT_LEADS":
      return controlRecentLeads(ctx);
    case "GET_RECENT_DEALS":
      return controlRecentDeals(ctx);
    case "GET_CONVERSATION_SUMMARY": {
      const id = asString(params.conversationId || params.id);
      if (!id) throw new ApiError(422, "invalid", "Укажите conversationId");
      const workspace = asRecord(await getConversation(prisma, auth, id));
      const conversation = asRecord(workspace.conversation || workspace);
      const messages = Array.isArray(workspace.messages) ? workspace.messages : [];
      return {
        id: conversation.id || id,
        mode: conversation.mode,
        contactName: asRecord(conversation.contact).name || workspace.contactName || null,
        waitingReply: workspace.waitingReply ?? null,
        lastMessages: messages.slice(-8).map((item: Record<string, unknown>) => ({
          direction: item.direction,
          senderKind: item.senderKind,
          text: String(item.text || item.body || "").slice(0, 400),
          createdAt: item.createdAt,
        })),
      };
    }
    case "GENERATE_REPORT":
    case "EXPORT_REPORT": {
      if (action === "EXPORT_REPORT" && !can(auth, PERMISSIONS.exportAll)) {
        throw new ApiError(403, "forbidden", "Нет права на экспорт");
      }
      const dash = await analytics(ctx);
      const sit = await situation(ctx);
      return {
        overview: dash.overview,
        sales: financial ? dash.sales : { won: dash.sales?.won },
        attention: asRecord(sit.attention).summary || null,
        currency,
      };
    }
    case "CREATE_TASK":
    case "CREATE_FOLLOW_UP": {
      if (!access.canCreateTasks) throw new ApiError(403, "forbidden", "Нет права создавать задачи");
      const title = asString(params.title) || (action === "CREATE_FOLLOW_UP" ? "Follow-up" : "");
      if (!title) throw new ApiError(422, "invalid", "Укажите название задачи");
      const created = await createTask(prisma, auth, {
        type: action === "CREATE_FOLLOW_UP" ? "follow_up" : asString(params.type) || "other",
        title,
        description: asString(params.description) || undefined,
        contactId: asString(params.contactId || params.clientId) || undefined,
        dealId: asString(params.dealId) || undefined,
        inquiryId: asString(params.inquiryId) || undefined,
        dueAt: asString(params.dueAt) || undefined,
        ownerMembershipId: asString(params.ownerMembershipId || params.assigneeMembershipId) || undefined,
        createdByKind: "user",
        source: "control",
      });
      return { id: created.id, title: created.title, status: created.status };
    }
    case "UPDATE_TASK": {
      const id = asString(params.taskId || params.id);
      if (!id) throw new ApiError(422, "invalid", "Укажите taskId");
      const updated = await updateTaskDraft(prisma, auth, id, {
        title: asString(params.title) || undefined,
        description: asString(params.description) || undefined,
        dueAt: params.dueAt === null ? null : asString(params.dueAt) || undefined,
        contactId: asString(params.contactId) || undefined,
        dealId: asString(params.dealId) || undefined,
      });
      return { id: asRecord(updated).id || id };
    }
    case "COMPLETE_TASK": {
      const id = asString(params.taskId || params.id);
      if (!id) throw new ApiError(422, "invalid", "Укажите taskId");
      const updated = await completeTask(prisma, auth, id);
      return { id: updated.id, status: updated.status };
    }
    case "ASSIGN_TASK": {
      const id = asString(params.taskId || params.id);
      if (!id) throw new ApiError(422, "invalid", "Укажите taskId");
      const updated = await assignTask(prisma, auth, id, {
        membershipId: asString(params.ownerMembershipId || params.membershipId) || undefined,
        executorKind: asString(params.executorKind) === "ai" ? "ai" : undefined,
      });
      return { id: updated.id, ownerMembershipId: updated.ownerMembershipId };
    }
    case "CREATE_LEAD": {
      const name = asString(params.name);
      if (!name) throw new ApiError(422, "invalid", "Укажите имя");
      const created = await createManualInquiry(prisma, auth, {
        name,
        phone: asString(params.phone) || undefined,
        company: asString(params.company) || undefined,
        subject: asString(params.subject || params.service) || undefined,
        message: asString(params.message) || undefined,
      });
      return { id: created.id, status: created.status };
    }
    case "UPDATE_LEAD": {
      const id = asString(params.inquiryId || params.leadId || params.id);
      if (!id) throw new ApiError(422, "invalid", "Укажите inquiryId");
      return updateInquiry(prisma, auth, id, params);
    }
    case "CREATE_DEAL": {
      if (!access.canModifyDeals) throw new ApiError(403, "forbidden", "Нет права менять сделки");
      const title = asString(params.title);
      const contactId = asString(params.contactId || params.clientId);
      if (!title || !contactId) throw new ApiError(422, "invalid", "Укажите title и contactId");
      const created = await createDeal(prisma, auth, {
        title,
        contactId,
        description: asString(params.description) || null,
        offerAmountMinor: params.offerAmountMinor != null ? Number(params.offerAmountMinor) : null,
      });
      return asRecord(created).deal || created;
    }
    case "UPDATE_DEAL": {
      if (!access.canModifyDeals) throw new ApiError(403, "forbidden", "Нет права менять сделки");
      const id = asString(params.dealId || params.id);
      if (!id) throw new ApiError(422, "invalid", "Укажите dealId");
      return updateDeal(prisma, auth, id, params);
    }
    case "MOVE_DEAL_STAGE": {
      if (!access.canModifyDeals) throw new ApiError(403, "forbidden", "Нет права менять сделки");
      const id = asString(params.dealId || params.id);
      if (!id) throw new ApiError(422, "invalid", "Укажите dealId");
      return changeDealStage(prisma, auth, id, {
        stageId: asString(params.stageId) || undefined,
        systemKey: asString(params.systemKey || params.stage) || undefined,
        note: asString(params.note) || undefined,
      });
    }
    case "ASSIGN_DEAL": {
      if (!access.canModifyDeals) throw new ApiError(403, "forbidden", "Нет права менять сделки");
      const id = asString(params.dealId || params.id);
      if (!id) throw new ApiError(422, "invalid", "Укажите dealId");
      return updateDeal(prisma, auth, id, {
        assigneeMembershipId: asString(params.assigneeMembershipId || params.ownerMembershipId) || null,
      });
    }
    case "ADD_DEAL_NOTE": {
      const id = asString(params.dealId || params.id);
      const text = asString(params.text || params.note);
      if (!id || !text) throw new ApiError(422, "invalid", "Укажите dealId и текст");
      const row = await getDeal(prisma, auth, id);
      const deal = asRecord(row.deal);
      const contactId = asString(deal.contactId);
      await prisma.note.create({
        data: {
          tenantId: auth.activeMembership!.tenantId,
          parentType: "deal",
          parentId: id,
          contactId: contactId || null,
          authorUserId: auth.user.id,
          text,
          internal: true,
        },
      });
      if (contactId) {
        await writeActivity(prisma, {
          tenantId: auth.activeMembership!.tenantId,
          contactId,
          dealId: id,
          type: "note.created",
          title: "Заметка по сделке",
          description: text,
          actorType: "user",
          actorId: auth.user.id,
        });
      }
      return { dealId: id, added: true };
    }
    case "CREATE_CLIENT": {
      const name = asString(params.name);
      if (!name) throw new ApiError(422, "invalid", "Укажите имя");
      const created = await createContact(prisma, auth, {
        name,
        phone: asString(params.phone) || undefined,
        comment: asString(params.comment) || undefined,
        companyName: asString(params.companyName) || undefined,
      });
      return { id: asRecord(created).id, name: asRecord(created).name };
    }
    case "UPDATE_CLIENT": {
      const id = asString(params.clientId || params.contactId || params.id);
      if (!id) throw new ApiError(422, "invalid", "Укажите clientId");
      return updateContact(prisma, auth, id, params);
    }
    case "ASSIGN_CLIENT": {
      const id = asString(params.clientId || params.contactId || params.id);
      if (!id) throw new ApiError(422, "invalid", "Укажите clientId");
      return updateContact(prisma, auth, id, {
        ownerMembershipId: asString(params.ownerMembershipId) || null,
      });
    }
    case "ARCHIVE_CLIENT": {
      const id = asString(params.clientId || params.contactId || params.id);
      if (!id) throw new ApiError(422, "invalid", "Укажите clientId");
      return updateContact(prisma, auth, id, { archived: true });
    }
    case "DELETE_CLIENT": {
      const id = asString(params.clientId || params.contactId || params.id);
      if (!id) throw new ApiError(422, "invalid", "Укажите clientId");
      return deleteContact(prisma, auth, id);
    }
    case "BULK_ASSIGN_DEALS": {
      const ids = asStringList(params.dealIds).slice(0, BULK_MAX);
      const assigneeMembershipId = asString(params.assigneeMembershipId);
      if (ids.length < 2 || !assigneeMembershipId) {
        throw new ApiError(422, "invalid", "Нужны dealIds и assigneeMembershipId");
      }
      const results = [];
      for (const id of ids) {
        results.push(await updateDeal(prisma, auth, id, { assigneeMembershipId }));
      }
      return { updated: results.length };
    }
    case "BULK_MOVE_DEALS": {
      const ids = asStringList(params.dealIds).slice(0, BULK_MAX);
      if (ids.length < 2) throw new ApiError(422, "invalid", "Нужны dealIds");
      const results = [];
      for (const id of ids) {
        results.push(
          await changeDealStage(prisma, auth, id, {
            stageId: asString(params.stageId) || undefined,
            systemKey: asString(params.systemKey || params.stage) || undefined,
          }),
        );
      }
      return { updated: results.length };
    }
    case "BULK_UPDATE_LEADS": {
      const ids = asStringList(params.inquiryIds || params.leadIds).slice(0, BULK_MAX);
      if (ids.length < 2) throw new ApiError(422, "invalid", "Нужны inquiryIds");
      const patch = asRecord(params.patch || params.fields);
      const results = [];
      for (const id of ids) results.push(await updateInquiry(prisma, auth, id, patch));
      return { updated: results.length };
    }
    case "BULK_CREATE_TASKS": {
      if (!access.canCreateTasks) throw new ApiError(403, "forbidden", "Нет права создавать задачи");
      const titles = asStringList(params.titles);
      const items = Array.isArray(params.tasks) ? params.tasks : titles.map((title) => ({ title }));
      if (items.length < 2) throw new ApiError(422, "invalid", "Нужно несколько задач");
      const created = [];
      for (const item of items.slice(0, BULK_MAX)) {
        const row = asRecord(item);
        const title = asString(row.title);
        if (!title) continue;
        created.push(
          await createTask(prisma, auth, {
            type: asString(row.type) || "other",
            title,
            description: asString(row.description) || undefined,
            contactId: asString(row.contactId) || undefined,
            dueAt: asString(row.dueAt) || undefined,
            createdByKind: "ai",
          }),
        );
      }
      return { created: created.length, ids: created.map((item) => item.id) };
    }
    case "BULK_SEND_MESSAGE": {
      const campaign = await createCampaign(prisma, auth, {
        title: asString(params.title) || "BasQar Control рассылка",
        channel: "whatsapp",
        source: "ai_command",
        messageDraft: asString(params.message || params.messageDraft),
        contactIds: asStringList(params.contactIds).slice(0, BULK_MAX),
        phones: asStringList(params.phones).slice(0, BULK_MAX),
        phoneListText: asString(params.phoneListText) || undefined,
      });
      return {
        campaignId: asRecord(campaign).id,
        status: asRecord(campaign).status,
        note: "Кампания создана в существующем потоке подтверждения CRM",
      };
    }
    default:
      throw new ApiError(422, "unsupported_action", "Действие не поддерживается");
  }
}

function confirmationSummary(action: ControlAction, params: Record<string, unknown>) {
  const label = CONTROL_ACTION_META[action].label;
  const title = asString(params.title);
  const count =
    asStringList(params.dealIds).length ||
    asStringList(params.inquiryIds).length ||
    asStringList(params.contactIds).length ||
    asStringList(params.titles).length;
  if (typeof params._controlPreview === "string") return `${label}\n${params._controlPreview.slice(0, 1500)}`;
  if (count) return `${label}: ${count} объектов`;
  if (title) return `${label}: «${title.slice(0, 80)}»`;
  return label;
}

async function executeResolved(input: {
  prisma: PrismaClient;
  auth: AuthContext;
  access: ControlAccessRow;
  identityId: string;
  source: ControlSource;
  action: ControlAction;
  params: Record<string, unknown>;
  requestId: string;
  confirm: boolean;
}) {
  const started = Date.now();
  const membership = requireTenant(input.auth);
  if (input.action.startsWith("BULK_")) await requireBillingFeature(input.prisma, input.auth, "CONTROL_BULK");
  const period = mapControlPeriod(input.params, membership.tenant.timezone || "Asia/Almaty", new Date(),
    input.action === "GET_SALES_FORECAST" ? "this_month" : input.action === "GET_EXPECTED_PAYMENTS" ? "this_week" :
      ["GET_TASKS", "GET_OVERDUE_TASKS", "GET_UNCHANGED_DEALS", "GET_PROPOSALS_WITHOUT_FOLLOWUP", "GET_LOST_REASONS"].includes(input.action) ? "all" : "today");
  if (input.action === "GET_TODAY_TASKS" && period.label !== "today") throw new ApiError(422, "invalid_period", "Для другого периода запросите задачи с нужными датами.");
  try {
    if (input.confirm) {
      const existing = await input.prisma.controlConfirmation.findUnique({
        where: { tenantId_requestId: { tenantId: membership.tenantId, requestId: input.requestId } },
      });
      if (existing) {
        if (existing.status === "executed" && existing.resultJson) return existing.resultJson;
        if (existing.status === "pending" && existing.expiresAt.getTime() > Date.now()) {
          return {
            success: false,
            status: "CONFIRMATION_REQUIRED",
            action: input.action,
            confirmationId: existing.id,
            summary: existing.summary,
            expiresAt: existing.expiresAt.toISOString(),
            data: null,
          };
        }
      }
      const confirmation = await input.prisma.controlConfirmation.create({
        data: {
          tenantId: membership.tenantId,
          userId: input.auth.user.id,
          identityId: input.identityId,
          source: input.source,
          action: input.action,
          paramsJson: input.params as Prisma.InputJsonValue,
          summary: confirmationSummary(input.action, input.params),
          status: "pending",
          requestId: input.requestId,
          expiresAt: new Date(Date.now() + CONFIRM_TTL_MS),
        },
      });
      const payload = {
        success: false as const,
        status: "CONFIRMATION_REQUIRED" as const,
        action: input.action,
        confirmationId: confirmation.id,
        summary: confirmation.summary,
        expiresAt: confirmation.expiresAt.toISOString(),
        data: null,
      };
      await writeControlAudit(input.prisma, {
        tenantId: membership.tenantId,
        userId: input.auth.user.id,
        identityId: input.identityId,
        source: input.source,
        action: input.action,
        params: input.params,
        result: "confirmation_required",
        status: "CONFIRMATION_REQUIRED",
        confirmationId: confirmation.id,
        requestId: input.requestId,
        durationMs: Date.now() - started,
      });
      return payload;
    }

    const data = await dispatchAction(input.action, {
      prisma: input.prisma,
      auth: input.auth,
      access: input.access,
      params: input.params,
      period,
    });
    const payload = ok(input.action, data, {
      period: period.label,
      dateFrom: period.dateFrom ?? null, dateTo: period.dateTo ?? null, timeZone: period.timeZone,
      currency: membership.tenant.currency || "KZT",
      requestId: input.requestId,
    });
    await writeControlAudit(input.prisma, {
      tenantId: membership.tenantId,
      userId: input.auth.user.id,
      identityId: input.identityId,
      source: input.source,
      action: input.action,
      params: input.params,
      result: "ok",
      status: "OK",
      requestId: input.requestId,
      durationMs: Date.now() - started,
    });
    await touchAccess(input.prisma, input.access.id);
    return payload;
  } catch (error) {
    const message = error instanceof Error ? error.message : "error";
    const code = error instanceof ApiError ? error.code : "internal_error";
    await writeControlAudit(input.prisma, {
      tenantId: membership.tenantId,
      userId: input.auth.user.id,
      identityId: input.identityId,
      source: input.source,
      action: input.action,
      params: input.params,
      result: "error",
      status: code,
      requestId: input.requestId,
      durationMs: Date.now() - started,
      error: message,
    }).catch(() => undefined);
    throw error;
  }
}

export async function executeAiControlCommand(
  prisma: PrismaClient,
  headers: {
    secret: string;
    integrationId?: string | null;
    timestamp?: string;
    signature?: string;
    requestIdHeader?: string;
    senderPhone?: string;
  },
  body: unknown,
) {
  const integration = await resolveControlIntegration(prisma, headers);
  const incoming = normalizeExecuteBody(body, headers);
  if (incoming.confirm && incoming.confirmationId) {
    return confirmAiControlCommand(prisma, headers, {
      confirmationId: incoming.confirmationId,
      externalIdentity: incoming.externalIdentity,
      source: incoming.source,
      requestId: incoming.requestId,
    });
  }
  const parsed = controlExecuteSchema.parse({
    action: incoming.action,
    params: incoming.params,
    requestId: incoming.requestId,
    externalIdentity: incoming.externalIdentity,
    source: incoming.source,
    tenantId: incoming.tenantId,
  });
  const requestId = parsed.requestId || String(headers.requestIdHeader || "").trim();
  if (!requestId) throw new ApiError(422, "invalid", "Нужен requestId");
  assertFreshTimestamp(headers.timestamp);
  assertOptionalSignature({
    secret: headers.secret,
    timestamp: headers.timestamp,
    requestId,
    signature: headers.signature,
  });
  void parsed.tenantId;
  if (!controlCompanyEnabled(integration.tenant.settingsJson)) {
    throw new ApiError(403, "control_disabled", "BasQar Control выключен для компании");
  }
  {
    const { canUseFeature } = await import("./entitlementService.ts");
    const { FEATURES } = await import("@creolab/contracts");
    if (!(await canUseFeature(prisma, integration.tenantId, FEATURES.AI_CONTROL))) {
      throw new ApiError(403, "feature_required", "BasQar Control не подключён.", undefined, {
        feature: FEATURES.AI_CONTROL,
        billingPath: "/billing",
      });
    }
  }
  const identity = await resolveLinkedIdentity(
    prisma,
    integration.tenantId,
    parsed.source,
    parsed.externalIdentity,
    integration.tenant.defaultRegion || "KZ",
  );
  const access = await prisma.controlAccess.findUnique({
    where: { tenantId_userId: { tenantId: integration.tenantId, userId: identity.userId } },
  });
  if (!access) throw new ApiError(403, "control_disabled", "Нет доступа BasQar Control");
  assertControlPermission(access, parsed.action, parsed.source);
  const auth = await authForUserInTenant(prisma, identity.userId, integration.tenantId, `control:${requestId}`);
  const confirm = needsConfirmation(access, parsed.action);
  const risk = CONTROL_ACTION_META[parsed.action].riskLevel;
  const run = () =>
    executeResolved({
      prisma,
      auth,
      access,
      identityId: identity.id,
      source: parsed.source,
      action: parsed.action,
      params: parsed.params || {},
      requestId,
      confirm,
    });
  if (risk === "READ") return run();
  return withIdempotency(prisma, {
    scope: "ai-control",
    actorKey: `${integration.tenantId}:${identity.userId}`,
    key: requestId,
    payload: { action: parsed.action, params: parsed.params || {} },
    run,
  });
}

export async function confirmAiControlCommand(
  prisma: PrismaClient,
  headers: {
    secret: string;
    integrationId?: string | null;
    timestamp?: string;
    signature?: string;
    senderPhone?: string;
  },
  body: unknown,
) {
  const integration = await resolveControlIntegration(prisma, headers);
  const incoming = asRecord(body);
  const parsed = controlConfirmSchema.parse({
    confirmationId: incoming.confirmationId,
    externalIdentity:
      asString(incoming.externalIdentity) || asString(incoming.senderPhone) || asString(headers.senderPhone),
    source: asString(incoming.source) || "WHATSAPP",
    requestId: asString(incoming.requestId) || undefined,
    tenantId: asString(incoming.tenantId) || undefined,
  });
  const requestId = parsed.requestId || parsed.confirmationId;
  assertFreshTimestamp(headers.timestamp);
  assertOptionalSignature({
    secret: headers.secret,
    timestamp: headers.timestamp,
    requestId,
    signature: headers.signature,
  });
  return confirmControlForIntegration(prisma, integration, parsed);
}

async function confirmControlForIntegration(prisma: PrismaClient,
  integration: Pick<Awaited<ReturnType<typeof resolveControlIntegration>>, "tenantId" | "tenant">,
  parsed: { confirmationId: string; source: ControlSource; externalIdentity: string; tenantId?: string },
) {
  void parsed.tenantId;
  if (!controlCompanyEnabled(integration.tenant.settingsJson)) {
    throw new ApiError(403, "control_disabled", "BasQar Control выключен для компании");
  }
  {
    const { canUseFeature } = await import("./entitlementService.ts");
    const { FEATURES } = await import("@creolab/contracts");
    if (!(await canUseFeature(prisma, integration.tenantId, FEATURES.AI_CONTROL))) {
      throw new ApiError(403, "feature_required", "BasQar Control не подключён.", undefined, {
        feature: FEATURES.AI_CONTROL,
        billingPath: "/billing",
      });
    }
  }
  const confirmation = await prisma.controlConfirmation.findFirst({
    where: { id: parsed.confirmationId, tenantId: integration.tenantId },
  });
  if (!confirmation) throw new ApiError(404, "not_found", "Подтверждение не найдено");
  const identity = await resolveLinkedIdentity(
    prisma,
    integration.tenantId,
    parsed.source,
    parsed.externalIdentity,
    integration.tenant.defaultRegion || "KZ",
  );
  if (identity.userId !== confirmation.userId || confirmation.source !== parsed.source || confirmation.identityId && confirmation.identityId !== identity.id) {
    throw new ApiError(403, "forbidden", "Подтверждение принадлежит другому пользователю");
  }
  const access = await prisma.controlAccess.findUnique({
    where: { tenantId_userId: { tenantId: integration.tenantId, userId: identity.userId } },
  });
  if (!access) throw new ApiError(403, "control_disabled", "Нет доступа BasQar Control");
  const action = confirmation.action as ControlAction;
  assertControlPermission(access, action, parsed.source);
  const auth = await authForUserInTenant(prisma, identity.userId, integration.tenantId, `control:${confirmation.requestId}`);
  if (action.startsWith("BULK_")) await requireBillingFeature(prisma, auth, "CONTROL_BULK");
  if (confirmation.status === "executed" && confirmation.resultJson) return confirmation.resultJson;
  if (confirmation.expiresAt.getTime() < Date.now() || confirmation.status === "expired") {
    await prisma.controlConfirmation.updateMany({
      where: { id: confirmation.id, status: "pending" },
      data: { status: "expired" },
    });
    throw new ApiError(410, "confirmation_expired", "Подтверждение просрочено");
  }
  if (confirmation.status !== "pending") {
    throw new ApiError(409, "invalid_state", "Подтверждение уже использовано");
  }
  const claimed = await prisma.controlConfirmation.updateMany({
    where: { id: confirmation.id, status: "pending" },
    data: { status: "confirmed", confirmedAt: new Date() },
  });
  if (!claimed.count) throw new ApiError(409, "invalid_state", "Подтверждение уже использовано");

  const started = Date.now();
  const period = mapControlPeriod(asRecord(confirmation.paramsJson), auth.activeMembership?.tenant.timezone || "Asia/Almaty");
  try {
    const data = await dispatchAction(action, {
      prisma,
      auth,
      access,
      params: asRecord(confirmation.paramsJson),
      period,
    });
    const payload = ok(action, data, {
      period: period.label,
      dateFrom: period.dateFrom ?? null, dateTo: period.dateTo ?? null, timeZone: period.timeZone,
      currency: auth.activeMembership?.tenant.currency || "KZT",
      requestId: confirmation.requestId,
      confirmationId: confirmation.id,
    });
    await prisma.controlConfirmation.update({
      where: { id: confirmation.id },
      data: { status: "executed", executedAt: new Date(), resultJson: payload as Prisma.InputJsonValue },
    });
    await writeControlAudit(prisma, {
      tenantId: integration.tenantId,
      userId: identity.userId,
      identityId: identity.id,
      source: parsed.source,
      action,
      params: confirmation.paramsJson,
      result: "ok",
      status: "OK",
      confirmationId: confirmation.id,
      requestId: confirmation.requestId,
      durationMs: Date.now() - started,
    });
    await touchAccess(prisma, access.id);
    return payload;
  } catch (error) {
    await prisma.controlConfirmation.update({
      where: { id: confirmation.id },
      data: { status: "uncertain" },
    }).catch(() => undefined);
    throw error;
  }
}

export async function verifyAiControlIdentity(
  prisma: PrismaClient,
  headers: { secret: string; integrationId?: string | null; timestamp?: string; senderPhone?: string },
  body: unknown,
) {
  const integration = await resolveControlIntegration(prisma, headers);
  assertFreshTimestamp(headers.timestamp);
  const incoming = asRecord(body);
  const parsed = controlVerifySchema.parse({
    externalIdentity:
      asString(incoming.externalIdentity) || asString(incoming.senderPhone) || asString(headers.senderPhone),
    code: incoming.code,
    source: asString(incoming.source) || "WHATSAPP",
    tenantId: asString(incoming.tenantId) || undefined,
  });
  void parsed.tenantId;
  const ident = normalizeIdentity(parsed.source, parsed.externalIdentity, integration.tenant.defaultRegion || "KZ");
  const row = await prisma.controlIdentity.findFirst({
    where: {
      tenantId: integration.tenantId,
      provider: parsed.source,
      enabled: true,
      OR: [{ externalUserId: ident.externalUserId }, { phoneNormalized: ident.phoneNormalized || ident.externalUserId }],
    },
  });
  if (!row || !row.verificationCodeHash || !row.verificationExpiresAt) {
    throw new ApiError(403, "identity_not_linked", "Код подтверждения не найден");
  }
  if (row.verificationExpiresAt.getTime() < Date.now()) {
    throw new ApiError(410, "confirmation_expired", "Код подтверждения просрочен");
  }
  if (!safeEqual(sha256(parsed.code), row.verificationCodeHash)) {
    throw new ApiError(403, "invalid_code", "Неверный код подтверждения");
  }
  await prisma.controlIdentity.update({
    where: { id: row.id },
    data: { verifiedAt: new Date(), verificationCodeHash: null, verificationExpiresAt: null },
  });
  await writeAudit(prisma, {
    tenantId: integration.tenantId,
    actorUserId: row.userId,
    action: "control.identity_verified",
    entityType: "control_identity",
    entityId: row.id,
    changes: { provider: parsed.source },
  });
  return { success: true, verified: true, userId: row.userId };
}


/** Internal adapter for provider-authenticated WhatsApp events. Not exposed as an HTTP route. */
export async function authorizeNativeControl(prisma: PrismaClient, integrationId: string, identityId: string, action?: ControlAction) {
  const integration = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId }, include: { tenant: true } });
  const identity = await prisma.controlIdentity.findFirst({ where: { id: identityId, tenantId: integration.tenantId, provider: "WHATSAPP", enabled: true, verifiedAt: { not: null } } });
  const chat = asRecord(asRecord(identity?.metadata).chat);
  if (!["whatsapp_qr", "whatsapp_cloud"].includes(integration.type) || integration.status !== "active" || integration.tenant.status !== "active" || !identity || !chat.enabled || chat.integrationId !== integration.id || !controlCompanyEnabled(integration.tenant.settingsJson)) {
    throw new ApiError(403, "control_disabled", "Доступ к BasQar Control отключён. Проверьте настройки в кабинете.");
  }
  const { canUseFeature } = await import("./entitlementService.ts");
  if (!await canUseFeature(prisma, integration.tenantId, "AI_CONTROL")) throw new ApiError(403, "feature_required", "BasQar Control не подключён к тарифу.");
  const access = await prisma.controlAccess.findUnique({ where: { tenantId_userId: { tenantId: integration.tenantId, userId: identity.userId } } });
  if (!access || !access.enabled || access.status !== "active" || asStringList(access.allowedSources).length && !asStringList(access.allowedSources).includes("WHATSAPP")) throw new ApiError(403, "control_disabled", "Доступ сотрудника к WhatsApp Control отключён.");
  if (action) assertControlPermission(access, action, "WHATSAPP");
  const auth = await authForUserInTenant(prisma, identity.userId, integration.tenantId, `control-whatsapp:${identity.id}`);
  return { integration, identity, access, auth, tenant: integration.tenant };
}

export async function executeNativeControl(prisma: PrismaClient, integrationId: string, identityId: string,
  action: ControlAction, params: Record<string, unknown>, requestId: string) {
  const ctx = await authorizeNativeControl(prisma, integrationId, identityId, action);
  // Every change requested from chat gets a concrete preview, regardless of API preferences.
  return executeResolved({ prisma, auth: ctx.auth, access: ctx.access, identityId, source: "WHATSAPP", action, params, requestId,
    confirm: CONTROL_ACTION_META[action].riskLevel !== "READ" });
}

export async function confirmNativeControl(prisma: PrismaClient, integrationId: string, identityId: string, confirmationId: string) {
  const ctx = await authorizeNativeControl(prisma, integrationId, identityId);
  const own = await prisma.controlConfirmation.findFirst({ where: { id: confirmationId, tenantId: ctx.integration.tenantId, identityId, source: "WHATSAPP" } });
  if (!own) throw new ApiError(404, "not_found", "Подтверждение не найдено");
  return confirmControlForIntegration(prisma, ctx.integration, { confirmationId, externalIdentity: ctx.identity.externalUserId, source: "WHATSAPP" });
}


export function controlAuthorizationVersion(ctx: Pick<Awaited<ReturnType<typeof authorizeNativeControl>>, "auth" | "access"> & { identity: { userId: string } }) {
  const { lastActivityAt: _last, updatedAt: _updated, createdAt: _created, ...permissions } = ctx.access;
  return sha256(JSON.stringify({ permissions, membership: ctx.auth.activeMembership, userId: ctx.identity.userId }));
}

/** Browser requests use the logged-in member, never a submitted phone or user ID. */
export async function authorizeWebControl(prisma: PrismaClient, auth: AuthContext, action?: ControlAction) {
  const member = requireTenant(auth);
  const current = await authForUserInTenant(prisma, auth.user.id, member.tenantId, "control-web");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: member.tenantId } });
  if (!controlCompanyEnabled(tenant.settingsJson) || tenant.status !== "active") throw new ApiError(403, "control_disabled", "BasQar Control выключен для компании. Включите его в настройках Control.");
  await requireBillingFeature(prisma, current, "AI_CONTROL");
  const access = await prisma.controlAccess.findUnique({ where: { tenantId_userId: { tenantId: member.tenantId, userId: auth.user.id } } });
  if (!access?.enabled || access.status !== "active" || asStringList(access.allowedSources).length && !asStringList(access.allowedSources).includes("CRM_CHAT")) throw new ApiError(403, "control_disabled", "Разрешите доступ «Control в платформе» в настройках сотрудника.");
  if (action) assertControlPermission(access, action, "CRM_CHAT");
  return { access, auth: current, tenant };
}
export async function executeWebControl(prisma: PrismaClient, auth: AuthContext, identityId: string, action: ControlAction, params: Record<string, unknown>, requestId: string) {
  const ctx = await authorizeWebControl(prisma, auth, action);
  const identity = await prisma.controlIdentity.findFirst({ where: { id: identityId, tenantId: ctx.tenant.id, userId: auth.user.id, provider: "CRM_CHAT", enabled: true, verifiedAt: { not: null } } });
  if (!identity) throw new ApiError(403, "forbidden", "Нет доступа к истории Control");
  return executeResolved({ prisma, auth: ctx.auth, access: ctx.access, identityId, source: "CRM_CHAT", action, params, requestId, confirm: CONTROL_ACTION_META[action].riskLevel !== "READ" });
}
export async function confirmWebControl(prisma: PrismaClient, auth: AuthContext, confirmationId: string) {
  const ctx = await authorizeWebControl(prisma, auth);
  return confirmControlForIntegration(prisma, { tenantId: ctx.tenant.id, tenant: ctx.tenant }, { confirmationId, source: "CRM_CHAT", externalIdentity: auth.user.id });
}
