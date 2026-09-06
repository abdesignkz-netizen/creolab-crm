import type { Prisma, PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { can } from "../lib/types.ts";
import { MODE_LABEL, type AutomationMode } from "./aiAutomationSettings.ts";
import { config } from "../config.ts";

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership;
}

export const INTEGRATION_TYPE_META: Record<
  string,
  { catalogType: string; title: string; group: "leads" | "messaging" | "notifications" | "other"; stage: number }
> = {
  form: { catalogType: "WEBSITE_FORM", title: "Форма сайта", group: "leads", stage: 1 },
  webhook: { catalogType: "WEBHOOK_API", title: "Webhook / API", group: "leads", stage: 2 },
  whatsapp_seller: { catalogType: "WHATSAPP", title: "WhatsApp AI Manager", group: "messaging", stage: 0 },
  telegram_bot: { catalogType: "TELEGRAM", title: "Telegram", group: "messaging", stage: 3 },
  instagram_direct: { catalogType: "INSTAGRAM_DIRECT", title: "Instagram Direct", group: "messaging", stage: 4 },
  meta_lead_forms: { catalogType: "META_LEAD_FORMS", title: "Meta Lead Forms", group: "leads", stage: 5 },
  google_forms: { catalogType: "GOOGLE_FORMS", title: "Google Forms", group: "leads", stage: 6 },
  tiktok_leads: { catalogType: "TIKTOK_LEADS", title: "TikTok Leads", group: "leads", stage: 7 },
  email: { catalogType: "EMAIL", title: "Email", group: "other", stage: 8 },
};

export function deriveHealthStatus(row: {
  connectionStatus?: string | null;
  status?: string | null;
  lastEventAt?: Date | null;
  lastError?: string | null;
  lastErrorCode?: string | null;
  healthStatus?: string | null;
}): string {
  if (row.lastErrorCode === "TOKEN_EXPIRED") return "TOKEN_EXPIRED";
  if (row.lastError) return "ERROR";
  const connected =
    row.connectionStatus === "CONNECTED" || row.status === "active" || row.connectionStatus === "connected";
  if (!connected && row.status !== "active") return "UNKNOWN";
  if (!row.lastEventAt) return "NO_EVENTS_YET";
  return "HEALTHY";
}

export function healthLabel(status: string) {
  const map: Record<string, string> = {
    HEALTHY: "Работает",
    NO_EVENTS_YET: "Подключено · событий ещё нет",
    TOKEN_EXPIRED: "Требуется повторная авторизация",
    ERROR: "Ошибка",
    DEGRADED: "Есть проблемы",
    UNKNOWN: "Неизвестно",
    UNAVAILABLE: "Функция недоступна для аккаунта",
  };
  return map[status] || status;
}

export async function touchIntegrationSuccess(
  tx: Prisma.TransactionClient | PrismaClient,
  integrationId: string,
  at = new Date(),
) {
  await tx.integration.update({
    where: { id: integrationId },
    data: {
      lastEventAt: at,
      lastSuccessAt: at,
      lastError: null,
      lastErrorAt: null,
      lastErrorCode: null,
      connectionStatus: "CONNECTED",
      healthStatus: "HEALTHY",
      status: "active",
    },
  });
}

export async function touchIntegrationError(
  tx: Prisma.TransactionClient | PrismaClient,
  integrationId: string,
  error: string,
  code?: string,
) {
  await tx.integration.update({
    where: { id: integrationId },
    data: {
      lastError: error.slice(0, 500),
      lastErrorAt: new Date(),
      lastErrorCode: code || null,
      healthStatus: code === "TOKEN_EXPIRED" ? "TOKEN_EXPIRED" : "ERROR",
    },
  });
}

export async function listIntegrationCatalog(prisma: PrismaClient, auth: AuthContext) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const apiBase = config.apiBaseUrl;

  const [rows, eventCounts, recentEvents, form, telegram] = await Promise.all([
    prisma.integration.findMany({
      where: { tenantId: tid },
      include: {
        forms: { where: { active: true }, take: 1 },
        _count: { select: { inquiries: true, inboundEvents: true } },
      },
      orderBy: { name: "asc" },
    }),
    prisma.inboundEvent.groupBy({
      by: ["integrationId", "status"],
      where: { tenantId: tid },
      _count: true,
    }),
    prisma.inboundEvent.findMany({
      where: { tenantId: tid },
      orderBy: { receivedAt: "desc" },
      take: 30,
      include: { integration: { select: { id: true, name: true, type: true } } },
    }),
    prisma.formDefinition.findFirst({ where: { tenantId: tid, active: true } }),
    prisma.telegramBinding.findFirst({ where: { userId: auth.user.id, revokedAt: null } }),
  ]);

  const countsByIntegration = new Map<string, Record<string, number>>();
  for (const row of eventCounts) {
    const cur = countsByIntegration.get(row.integrationId) || {};
    cur[row.status] = row._count;
    countsByIntegration.set(row.integrationId, cur);
  }

  const leadCards = [];
  for (const meta of Object.values(INTEGRATION_TYPE_META).filter((m) => m.group === "leads")) {
    const typeKey = Object.entries(INTEGRATION_TYPE_META).find(([, v]) => v.catalogType === meta.catalogType)?.[0];
    const row = rows.find((r) => r.type === typeKey);
    if (meta.catalogType === "WEBSITE_FORM") {
      const health = row ? deriveHealthStatus(row) : "UNKNOWN";
      leadCards.push({
        catalogType: meta.catalogType,
        title: meta.title,
        stage: meta.stage,
        connected: Boolean(row && (row.status === "active" || row.connectionStatus === "CONNECTED")),
        connectionStatus: row?.connectionStatus || (row ? "CONNECTED" : "DISCONNECTED"),
        healthStatus: health,
        healthLabel: row ? healthLabel(health) : "Не подключено",
        inquiryCount: row?._count.inquiries || 0,
        eventCount: row?._count.inboundEvents || 0,
        automationMode: row?.automationMode || "inherit",
        automationLabel:
          row?.automationMode && row.automationMode !== "inherit"
            ? MODE_LABEL[row.automationMode as AutomationMode] || row.automationMode
            : "Наследует глобальные настройки",
        integrationId: row?.id || null,
        submitUrl: form ? `${apiBase}/public/forms/${form.publicKey}/submissions` : null,
        publicKey: form?.publicKey || null,
        available: true,
      });
      continue;
    }
    if (meta.catalogType === "WEBHOOK_API") {
      const health = row ? deriveHealthStatus(row) : "UNKNOWN";
      leadCards.push({
        catalogType: meta.catalogType,
        title: meta.title,
        stage: meta.stage,
        connected: Boolean(row && row.status === "active"),
        connectionStatus: row?.connectionStatus || (row?.status === "active" ? "CONNECTED" : "DISCONNECTED"),
        healthStatus: health,
        healthLabel: row ? healthLabel(health) : "Не подключено",
        inquiryCount: row?._count.inquiries || 0,
        eventCount: row?._count.inboundEvents || 0,
        automationMode: row?.automationMode || "inherit",
        automationLabel:
          row?.automationMode && row.automationMode !== "inherit"
            ? MODE_LABEL[row.automationMode as AutomationMode] || row.automationMode
            : "Наследует глобальные настройки",
        integrationId: row?.id || null,
        eventsUrl: row ? `${apiBase}/api/v1/integrations/${row.id}/events` : null,
        available: true,
      });
      continue;
    }
    leadCards.push({
      catalogType: meta.catalogType,
      title: meta.title,
      stage: meta.stage,
      connected: false,
      connectionStatus: "DISCONNECTED",
      healthStatus: "UNKNOWN",
      healthLabel: "Не подключено",
      inquiryCount: 0,
      eventCount: 0,
      automationMode: null,
      automationLabel: null,
      integrationId: null,
      available: false,
      comingSoon: true,
      note:
        meta.catalogType === "TIKTOK_LEADS"
          ? "Подключение после проверки capability аккаунта"
          : "Следующий этап развития интеграций",
    });
  }

  const messagingCards = [
    {
      catalogType: "TELEGRAM",
      title: "Telegram",
      connected: false,
      healthLabel: "Не подключено",
      comingSoon: true,
      note: "Этап 3: BotFather → token → webhook. Сообщения ≠ заявки.",
    },
    {
      catalogType: "INSTAGRAM_DIRECT",
      title: "Instagram Direct",
      connected: false,
      healthLabel: "Не подключено",
      comingSoon: true,
      note: "Этап 4: OAuth Professional Account. Отдельно от Meta Lead Forms.",
    },
  ];

  const eventLog = recentEvents.map((e) => ({
    id: e.id,
    at: e.receivedAt,
    integrationName: e.integration.name,
    integrationType: e.integration.type,
    eventType: e.eventType,
    status: e.status,
    statusLabel: eventStatusLabel(e.status),
    provider: e.provider,
    duplicateIgnored: e.status === "PROCESSED" && e.attempts === 0 && Boolean(e.processedAt),
    error: e.lastError,
    test: e.test,
  }));

  return {
    leads: leadCards,
    messaging: messagingCards,
    notifications: {
      employeeTelegram: {
        connected: Boolean(telegram),
        healthLabel: telegram ? "Подключено" : "Не подключено",
        note: "Уведомления сотрудника — не источник заявок.",
      },
    },
    eventLog,
    checksHint: [
      "Credentials",
      "Provider доступен",
      "Webhook / endpoint",
      "Mapping заполнен",
      "Очередь работает",
      "Последнее событие обработано",
    ],
  };
}

function eventStatusLabel(status: string) {
  const map: Record<string, string> = {
    RECEIVED: "Получено",
    QUEUED: "В очереди",
    PROCESSING: "Обработка",
    PROCESSED: "Обработано",
    RETRY: "Повтор",
    FAILED: "Ошибка",
    DEAD_LETTER: "Dead letter",
  };
  return map[status] || status;
}

export async function listInboundEventLog(
  prisma: PrismaClient,
  auth: AuthContext,
  query: { limit?: number } = {},
) {
  if (!can(auth, "manage_integrations") && auth.activeMembership?.role !== "owner") {
    throw new ApiError(403, "forbidden", "Нет права");
  }
  const membership = requireTenant(auth);
  const items = await prisma.inboundEvent.findMany({
    where: { tenantId: membership.tenantId },
    orderBy: { receivedAt: "desc" },
    take: Math.min(query.limit || 50, 100),
    include: { integration: { select: { id: true, name: true, type: true } } },
  });
  return {
    items: items.map((e) => ({
      id: e.id,
      at: e.receivedAt,
      integrationId: e.integrationId,
      integrationName: e.integration.name,
      type: e.integration.type,
      eventType: e.eventType,
      status: e.status,
      statusLabel: eventStatusLabel(e.status),
      provider: e.provider,
      error: e.lastError,
      test: e.test,
      attempts: e.attempts,
    })),
  };
}

export async function runIntegrationHealthCheck(prisma: PrismaClient, auth: AuthContext, integrationId: string) {
  const membership = requireTenant(auth);
  const integration = await prisma.integration.findFirst({
    where: { id: integrationId, tenantId: membership.tenantId },
    include: { forms: true },
  });
  if (!integration) throw new ApiError(404, "not_found", "Интеграция не найдена");

  const checks: Array<{ key: string; ok: boolean; label: string; detail?: string }> = [];
  const connected = integration.status === "active" || integration.connectionStatus === "CONNECTED";
  checks.push({
    key: "credentials",
    ok: Boolean(integration.secretHash || integration.publicKey || integration.type === "form"),
    label: "Credentials",
  });
  checks.push({
    key: "connected",
    ok: connected,
    label: "Подключение",
    detail: integration.connectionStatus || integration.status,
  });
  checks.push({
    key: "mapping",
    ok: Boolean(integration.mappingJson && Object.keys(integration.mappingJson as object).length),
    label: "Mapping заполнен",
  });
  const last = await prisma.inboundEvent.findFirst({
    where: { integrationId: integration.id },
    orderBy: { receivedAt: "desc" },
  });
  checks.push({
    key: "events",
    ok: Boolean(last),
    label: "Есть события",
    detail: last ? `Последнее: ${last.status}` : "NO_EVENTS_YET",
  });
  checks.push({
    key: "last_processed",
    ok: !last || last.status === "PROCESSED" || last.status === "QUEUED",
    label: "Последнее событие обработано / в очереди",
    detail: last?.status,
  });
  if (integration.type === "form") {
    checks.push({
      key: "form",
      ok: integration.forms.some((f) => f.active),
      label: "Активная форма",
    });
    checks.push({
      key: "endpoint",
      ok: Boolean(integration.forms[0]?.publicKey),
      label: "Публичный endpoint",
      detail: integration.forms[0]
        ? `${config.apiBaseUrl}/public/forms/${integration.forms[0].publicKey}/submissions`
        : undefined,
    });
  }
  if (integration.type === "webhook") {
    checks.push({
      key: "secret",
      ok: Boolean(integration.secretHash),
      label: "Webhook secret",
    });
    checks.push({
      key: "endpoint",
      ok: true,
      label: "Events endpoint",
      detail: `${config.apiBaseUrl}/api/v1/integrations/${integration.id}/events`,
    });
  }

  const health = deriveHealthStatus(integration);
  await prisma.integration.update({
    where: { id: integration.id },
    data: {
      healthStatus: health,
      connectionStatus: connected ? "CONNECTED" : integration.connectionStatus || "PENDING",
    },
  });

  return {
    integrationId: integration.id,
    connectionStatus: connected ? "CONNECTED" : "DISCONNECTED",
    healthStatus: health,
    healthLabel: healthLabel(health),
    checks,
    allOk: checks.every((c) => c.ok),
  };
}
