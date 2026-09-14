import type { Prisma, PrismaClient } from "@creolab/db";

export type IntegrationImplementation = {
  type: string;
  title: string;
  purpose: string;
  functions: string[];
  authMethod: string;
  implementationReady: boolean;
  multiple: boolean;
  fields: string[];
  connectable: boolean;
  connectHint: string;
};

export const INTEGRATION_IMPLEMENTATIONS: IntegrationImplementation[] = [
  {
    type: "form",
    title: "Форма сайта",
    purpose: "Приём заявок с сайта по публичному адресу формы.",
    functions: ["lead_intake", "field_mapping", "assignment"],
    authMethod: "public_key",
    implementationReady: true,
    multiple: true,
    fields: ["name", "fields", "mapping", "assigneeMembershipId", "allowedDomains", "automationMode"],
    connectable: true,
    connectHint: "",
  },
  {
    type: "webhook",
    title: "Webhook / API",
    purpose: "Приём заявок по HMAC-подписи с индивидуального адреса.",
    functions: ["lead_intake", "signature_check", "idempotency"],
    authMethod: "hmac_bearer",
    implementationReady: true,
    multiple: true,
    fields: ["name", "mapping", "assigneeMembershipId", "automationMode", "testMode"],
    connectable: true,
    connectHint: "",
  },
  {
    type: "whatsapp_seller",
    title: "WhatsApp",
    purpose: "Подключение моста WhatsApp AI Manager компании: адрес и секрет.",
    functions: ["receive_messages", "sync_leads"],
    authMethod: "url_and_secret",
    implementationReady: true,
    multiple: false,
    fields: ["name", "sellerUrl", "secret"],
    connectable: true,
    connectHint: "",
  },
  {
    type: "esf",
    title: "ИС ЭСФ",
    purpose: "Сессия компании в ИС ЭСФ. Подписание через NCALayer, без закрытого ключа в панели.",
    functions: ["session_status", "environment"],
    authMethod: "ncalayer",
    implementationReady: true,
    multiple: false,
    fields: ["environment"],
    connectable: false,
    connectHint: "Авторизация только через NCALayer в кабинете компании. Ключ ЭЦП в панель не переносится.",
  },
  {
    type: "telegram_bot",
    title: "Telegram компании",
    purpose: "Отдельный бот компании для клиентских сообщений.",
    functions: [],
    authMethod: "bot_token",
    implementationReady: false,
    multiple: true,
    fields: [],
    connectable: false,
    connectHint: "Программный модуль клиентского бота компании ещё не реализован.",
  },
  {
    type: "telegram_notify",
    title: "Telegram-уведомления сервиса",
    purpose: "Общий бот сервиса для уведомлений сотрудника. Это не подключение компании.",
    functions: ["employee_notify"],
    authMethod: "service_env",
    implementationReady: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_USERNAME),
    multiple: false,
    fields: [],
    connectable: false,
    connectHint: process.env.TELEGRAM_BOT_TOKEN
      ? "Задан серверный бот уведомлений. Сотрудник подключает личный чат в профиле, не через карточку компании."
      : "Нужны TELEGRAM_BOT_TOKEN и TELEGRAM_BOT_USERNAME в инфраструктуре сервиса.",
  },
  {
    type: "calendar",
    title: "Календарь",
    purpose: "OAuth и выбранный календарь. Полная синхронизация не реализована.",
    functions: [],
    authMethod: "oauth",
    implementationReady: false,
    multiple: false,
    fields: [],
    connectable: false,
    connectHint: "Хранилище авторизации календаря есть частично, синхронизация не заявлена как готовая.",
  },
  {
    type: "instagram_direct",
    title: "Instagram Direct",
    purpose: "Сообщения Instagram.",
    functions: [],
    authMethod: "oauth",
    implementationReady: false,
    multiple: false,
    fields: [],
    connectable: false,
    connectHint: "Нет программного модуля подключения.",
  },
  {
    type: "meta_lead_forms",
    title: "Meta Lead Forms",
    purpose: "Лиды из форм Meta.",
    functions: [],
    authMethod: "oauth",
    implementationReady: false,
    multiple: false,
    fields: [],
    connectable: false,
    connectHint: "Нет программного модуля подключения. Для простых источников используйте Webhook.",
  },
  {
    type: "google_forms",
    title: "Google Forms",
    purpose: "Лиды из Google Forms.",
    functions: [],
    authMethod: "oauth",
    implementationReady: false,
    multiple: false,
    fields: [],
    connectable: false,
    connectHint: "Нет программного модуля. Используйте универсальный Webhook.",
  },
  {
    type: "tiktok_leads",
    title: "TikTok Leads",
    purpose: "Лиды TikTok.",
    functions: [],
    authMethod: "oauth",
    implementationReady: false,
    multiple: false,
    fields: [],
    connectable: false,
    connectHint: "Нет программного модуля подключения.",
  },
  {
    type: "email",
    title: "Email",
    purpose: "Входящая почта как источник заявок.",
    functions: [],
    authMethod: "oauth",
    implementationReady: false,
    multiple: false,
    fields: [],
    connectable: false,
    connectHint: "Нет программного модуля подключения.",
  },
];

export function implementationOf(type: string) {
  return INTEGRATION_IMPLEMENTATIONS.find((item) => item.type === type) || null;
}

export async function ensurePlatformIntegrationTypes(prisma: PrismaClient | Prisma.TransactionClient) {
  for (const item of INTEGRATION_IMPLEMENTATIONS) {
    const existing = await prisma.platformIntegrationType.findUnique({ where: { type: item.type } });
    if (!existing) {
      await prisma.platformIntegrationType.create({
        data: {
          type: item.type,
          title: item.title,
          description: item.purpose,
          purpose: item.purpose,
          available: item.implementationReady && item.type !== "telegram_notify",
        },
      });
    }
  }
}

export async function listPlatformCatalog(prisma: PrismaClient) {
  await ensurePlatformIntegrationTypes(prisma);
  const rows = await prisma.platformIntegrationType.findMany({ orderBy: { title: "asc" } });
  return rows.map((row) => {
    const impl = implementationOf(row.type);
    const implementationReady = Boolean(impl?.implementationReady);
    const connectable = Boolean(impl?.connectable && implementationReady && row.available);
    return {
      type: row.type,
      title: row.title,
      description: row.description || impl?.purpose || "",
      purpose: row.purpose || impl?.purpose || "",
      functions: impl?.functions || [],
      authMethod: impl?.authMethod || "none",
      implementationReady,
      available: row.available,
      connectable,
      connectHint: connectable ? "" : impl?.connectHint || "Нельзя подключить: нет готового модуля или тип выключен.",
      multiple: Boolean(impl?.multiple),
      fields: impl?.fields || [],
      defaultSettings: row.defaultSettingsJson,
      allowedParams: row.allowedParamsJson,
    };
  });
}

export async function updatePlatformIntegrationType(
  prisma: PrismaClient,
  type: string,
  input: Record<string, unknown>,
) {
  await ensurePlatformIntegrationTypes(prisma);
  const row = await prisma.platformIntegrationType.findUnique({ where: { type } });
  if (!row) return null;
  const data: Prisma.PlatformIntegrationTypeUpdateInput = {};
  if ("title" in input) data.title = String(input.title || row.title);
  if ("description" in input) data.description = String(input.description || "");
  if ("purpose" in input) data.purpose = String(input.purpose || "");
  if ("available" in input) data.available = Boolean(input.available);
  if ("defaultSettings" in input && input.defaultSettings && typeof input.defaultSettings === "object") {
    data.defaultSettingsJson = input.defaultSettings as Prisma.InputJsonValue;
  }
  if ("allowedParams" in input && input.allowedParams && typeof input.allowedParams === "object") {
    data.allowedParamsJson = input.allowedParams as Prisma.InputJsonValue;
  }
  return prisma.platformIntegrationType.update({ where: { type }, data });
}

export function publicConnectionStatus(row: {
  type: string;
  status: string;
  connectionStatus: string | null;
  healthStatus: string | null;
  lastError: string | null;
  lastErrorCode: string | null;
  schemaJson?: unknown;
} | null) {
  if (!row) return "not_configured";
  const schema = row.schemaJson && typeof row.schemaJson === "object" ? (row.schemaJson as Record<string, unknown>) : {};
  if (row.type === "whatsapp_seller" && !String(schema.sellerUrl || "").trim()) return "needs_assignment";
  if (row.status === "disabled" || row.connectionStatus === "DISCONNECTED") return "disabled";
  if (row.connectionStatus === "CHECKING") return "checking";
  if (row.lastErrorCode === "TOKEN_EXPIRED" || row.healthStatus === "TOKEN_EXPIRED") return "reauth";
  if (row.status === "error" || row.healthStatus === "ERROR" || row.lastError) return "error";
  if (row.connectionStatus === "PENDING" || row.status === "pending") return "pending_auth";
  if (row.connectionStatus === "CONNECTED" || row.status === "active") return "connected";
  return "not_configured";
}

export const CONNECTION_STATUS_LABEL: Record<string, string> = {
  not_configured: "Не настроено",
  needs_assignment: "Требуется назначение",
  pending_auth: "Ожидает авторизации",
  checking: "Проверяется",
  connected: "Подключено",
  reauth: "Нужна повторная авторизация",
  error: "Ошибка",
  disabled: "Отключено",
};
