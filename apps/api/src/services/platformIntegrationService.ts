import { randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "@creolab/db";
import { config } from "../config.ts";
import { ApiError } from "../errors.ts";
import { writeAudit } from "../lib/audit.ts";
import { randomToken, sha256 } from "../lib/hash.ts";
import { encryptSecret } from "../lib/secretBox.ts";
import { getEffectiveTenantSettings, invalidateRuntimeConfig } from "./runtimeSettings.ts";
import {
  CONNECTION_STATUS_LABEL,
  implementationOf,
  listPlatformCatalog,
  publicConnectionStatus,
} from "./platformCatalog.ts";
import { resolveSellerBridge, upsertWhatsAppSellerForTenant } from "./sellerLink.ts";
import { runIntegrationHealthCheck } from "./integrationCatalogService.ts";
import type { AuthContext } from "../lib/types.ts";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function publicSchema(type: string, schema: unknown) {
  const row = asRecord(schema);
  if (type === "whatsapp_seller") {
    return {
      sellerUrl: String(row.sellerUrl || ""),
      secretSet: Boolean(row.secretEnc),
      sendOwner: row.sendOwner || "external_bot",
    };
  }
  return row;
}

export function publicIntegration(row: {
  id: string;
  tenantId: string;
  type: string;
  name: string;
  status: string;
  connectionStatus: string | null;
  healthStatus: string | null;
  schemaJson: unknown;
  mappingJson: unknown;
  assignmentJson: unknown;
  lastEventAt: Date | null;
  lastSuccessAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
  lastErrorCode: string | null;
  automationMode: string | null;
  testMode: boolean;
  publicKey: string | null;
  secretHash: string | null;
  forms?: Array<{ id: string; publicKey: string; name: string; fieldsJson: unknown; allowedDomains: unknown; active: boolean }>;
}) {
  const lifecycle = publicConnectionStatus(row);
  return {
    id: row.id,
    tenantId: row.tenantId,
    type: row.type,
    name: row.name,
    status: row.status,
    lifecycle,
    lifecycleLabel: CONNECTION_STATUS_LABEL[lifecycle] || lifecycle,
    connectionStatus: row.connectionStatus,
    healthStatus: row.healthStatus,
    schema: publicSchema(row.type, row.schemaJson),
    mapping: row.mappingJson,
    assignment: row.assignmentJson,
    lastEventAt: row.lastEventAt,
    lastSuccessAt: row.lastSuccessAt,
    lastErrorAt: row.lastErrorAt,
    lastError: row.lastError,
    lastErrorCode: row.lastErrorCode,
    automationMode: row.automationMode,
    testMode: row.testMode,
    publicKey: row.publicKey,
    secretSet: Boolean(row.secretHash),
    forms: (row.forms || []).map((form) => ({
      id: form.id,
      publicKey: form.publicKey,
      name: form.name,
      fields: form.fieldsJson,
      allowedDomains: form.allowedDomains,
      active: form.active,
      submitUrl: `${config.apiBaseUrl}/public/forms/${form.publicKey}/submissions`,
    })),
    eventsUrl: row.type === "webhook" ? `${config.apiBaseUrl}/api/v1/integrations/${row.id}/events` : null,
  };
}

export async function listTenantConnections(prisma: PrismaClient, tenantId: string) {
  const [rows, esf, catalog] = await Promise.all([
    prisma.integration.findMany({
      where: { tenantId },
      include: { forms: true },
      orderBy: { name: "asc" },
    }),
    prisma.esfConnection.findMany({ where: { tenantId } }),
    listPlatformCatalog(prisma),
  ]);
  const integrations = rows.map(publicIntegration);
  const esfItems = esf.map((row) => ({
    id: row.id,
    type: "esf",
    name: `ИС ЭСФ (${row.environment})`,
    environment: row.environment,
    status: row.status,
    lifecycle:
      row.status === "CONNECTED"
        ? "connected"
        : row.status === "REAUTH_REQUIRED" || row.status === "SESSION_EXPIRED"
          ? "reauth"
          : row.status === "NOT_CONNECTED"
            ? "not_configured"
            : row.status === "ERROR"
              ? "error"
              : "pending_auth",
    organizationBin: row.organizationBin,
    lastConnectedAt: row.lastConnectedAt,
    lastErrorCode: row.lastErrorCode,
    lastErrorMessage: row.lastErrorMessage,
    connectHint: "Авторизация через NCALayer. Закрытый ключ в панель не переносится.",
  }));
  const needsAssignment = integrations.filter((item) => item.lifecycle === "needs_assignment");
  return {
    items: integrations,
    esf: esfItems,
    catalog,
    needsAssignment,
  };
}

async function assertTypeConnectable(prisma: PrismaClient, type: string) {
  const catalog = await listPlatformCatalog(prisma);
  const row = catalog.find((item) => item.type === type);
  if (!row?.connectable) {
    throw new ApiError(422, "not_connectable", row?.connectHint || "Этот тип нельзя подключить через панель");
  }
  return row;
}

export async function createTenantConnection(
  prisma: PrismaClient,
  actorUserId: string,
  tenantId: string,
  input: Record<string, unknown>,
) {
  const type = String(input.type || "");
  const impl = implementationOf(type);
  await assertTypeConnectable(prisma, type);
  if (!impl?.multiple) {
    const existing = await prisma.integration.findFirst({ where: { tenantId, type } });
    if (existing) {
      throw new ApiError(409, "already_connected", "Для этого типа допускается только одно подключение");
    }
  }
  const settings = await getEffectiveTenantSettings(prisma, tenantId);
  if (type === "form" && !settings.features.forms.value) {
    throw new ApiError(422, "feature_disabled", "Формы отключены для этой компании");
  }
  if (type === "webhook" && !settings.features.webhook.value) {
    throw new ApiError(422, "feature_disabled", "Webhook отключён для этой компании");
  }
  if (type === "whatsapp_seller" && !settings.features.whatsapp.value) {
    throw new ApiError(422, "feature_disabled", "WhatsApp отключён для этой компании");
  }

  if (type === "whatsapp_seller") {
    const result = await upsertWhatsAppSellerForTenant(prisma, tenantId, {
      sellerUrl: String(input.sellerUrl || ""),
      secret: String(input.secret || ""),
      name: input.name ? String(input.name) : undefined,
      actorUserId,
    });
    const row = await prisma.integration.findFirstOrThrow({
      where: { id: result.integrationId },
      include: { forms: true },
    });
    return { ...publicIntegration(row), reachable: result.reachable, note: result.note, savedConnected: result.reachable };
  }

  if (type === "form") {
    const publicKey = `frm_${randomToken(12)}`;
    const name = String(input.name || "Форма сайта").trim();
    const fields = Array.isArray(input.fields)
      ? input.fields
      : [
          { key: "name", label: "Имя", required: true },
          { key: "phone", label: "Телефон", required: true, immutableRequired: true },
          { key: "message", label: "Задача", required: false },
        ];
    const mapping =
      input.mapping && typeof input.mapping === "object"
        ? input.mapping
        : { version: 1, fields: { name: "name", phone: "phone", message: "message", service: "service", company: "company" } };
    const assignment =
      input.assigneeMembershipId
        ? { kind: "member", membershipId: String(input.assigneeMembershipId) }
        : { kind: "owner" };
    const created = await prisma.integration.create({
      data: {
        tenantId,
        type: "form",
        name,
        status: "active",
        testMode: Boolean(input.testMode),
        publicKey,
        mappingJson: mapping as Prisma.InputJsonValue,
        assignmentJson: assignment as Prisma.InputJsonValue,
        automationMode: input.automationMode ? String(input.automationMode) : null,
        connectionStatus: "CONNECTED",
        healthStatus: "NO_EVENTS_YET",
      },
    });
    await prisma.formDefinition.create({
      data: {
        tenantId,
        integrationId: created.id,
        publicKey,
        name,
        fieldsJson: { fields } as Prisma.InputJsonValue,
        allowedDomains: Array.isArray(input.allowedDomains) ? (input.allowedDomains as Prisma.InputJsonValue) : [],
        antispamJson: { honeypot: "website" },
      },
    });
    const row = await prisma.integration.findFirstOrThrow({ where: { id: created.id }, include: { forms: true } });
    await writeAudit(prisma, {
      tenantId,
      actorUserId,
      action: "integration.connected",
      entityType: "integration",
      entityId: created.id,
      changes: { type, name },
    });
    return {
      ...publicIntegration(row),
      note: "Форма создана. Статус «подключено» означает, что адрес приёма готов, а не что уже были заявки.",
    };
  }

  if (type === "webhook") {
    const secret = `whsec_${randomBytes(16).toString("hex")}`;
    const name = String(input.name || "Webhook").trim();
    const assignment =
      input.assigneeMembershipId
        ? { kind: "member", membershipId: String(input.assigneeMembershipId) }
        : { kind: "owner" };
    const created = await prisma.integration.create({
      data: {
        tenantId,
        type: "webhook",
        name,
        status: "active",
        testMode: Boolean(input.testMode),
        secretHash: sha256(secret),
        mappingJson: (input.mapping && typeof input.mapping === "object" ? input.mapping : {}) as Prisma.InputJsonValue,
        assignmentJson: assignment as Prisma.InputJsonValue,
        automationMode: input.automationMode ? String(input.automationMode) : null,
        connectionStatus: "CONNECTED",
        healthStatus: "NO_EVENTS_YET",
      },
      include: { forms: true },
    });
    await writeAudit(prisma, {
      tenantId,
      actorUserId,
      action: "integration.connected",
      entityType: "integration",
      entityId: created.id,
      changes: { type, name },
    });
    return {
      ...publicIntegration(created),
      secret,
      eventsUrl: `${config.apiBaseUrl}/api/v1/integrations/${created.id}/events`,
      note: "Секрет показывается один раз. Сохранение формы не проверяет внешнего отправителя.",
    };
  }

  throw new ApiError(422, "unsupported", "Этот тип нельзя создать через панель");
}

export async function updateTenantConnection(
  prisma: PrismaClient,
  actorUserId: string,
  tenantId: string,
  integrationId: string,
  input: Record<string, unknown>,
) {
  const row = await prisma.integration.findFirst({
    where: { id: integrationId, tenantId },
    include: { forms: true },
  });
  if (!row) throw new ApiError(404, "not_found", "Подключение не найдено");

  if (row.type === "whatsapp_seller" && (input.sellerUrl || input.secret)) {
    const result = await upsertWhatsAppSellerForTenant(prisma, tenantId, {
      sellerUrl: String(input.sellerUrl || asRecord(row.schemaJson).sellerUrl || ""),
      secret: input.secret ? String(input.secret) : undefined,
      name: input.name ? String(input.name) : undefined,
      actorUserId,
    });
    const updated = await prisma.integration.findFirstOrThrow({
      where: { id: result.integrationId },
      include: { forms: true },
    });
    return { ...publicIntegration(updated), reachable: result.reachable, note: result.note };
  }

  const data: Prisma.IntegrationUpdateInput = {};
  if ("name" in input) data.name = String(input.name || row.name);
  if ("automationMode" in input) data.automationMode = input.automationMode ? String(input.automationMode) : null;
  if ("testMode" in input) data.testMode = Boolean(input.testMode);
  if ("mapping" in input && input.mapping && typeof input.mapping === "object") {
    data.mappingJson = input.mapping as Prisma.InputJsonValue;
  }
  if ("assigneeMembershipId" in input) {
    data.assignmentJson = input.assigneeMembershipId
      ? ({ kind: "member", membershipId: String(input.assigneeMembershipId) } as Prisma.InputJsonValue)
      : ({ kind: "owner" } as Prisma.InputJsonValue);
  }
  const updated = await prisma.integration.update({
    where: { id: row.id },
    data,
    include: { forms: true },
  });
  if (row.type === "form" && row.forms[0] && (input.fields || input.allowedDomains || input.name)) {
    await prisma.formDefinition.update({
      where: { id: row.forms[0].id },
      data: {
        name: input.name ? String(input.name) : undefined,
        fieldsJson: Array.isArray(input.fields) ? ({ fields: input.fields } as Prisma.InputJsonValue) : undefined,
        allowedDomains: Array.isArray(input.allowedDomains) ? (input.allowedDomains as Prisma.InputJsonValue) : undefined,
      },
    });
  }
  await writeAudit(prisma, {
    tenantId,
    actorUserId,
    action: "integration.updated",
    entityType: "integration",
    entityId: row.id,
    changes: { fields: Object.keys(input).filter((key) => key !== "secret") },
  });
  const fresh = await prisma.integration.findFirstOrThrow({ where: { id: row.id }, include: { forms: true } });
  return publicIntegration(fresh);
}

export async function disableTenantConnection(
  prisma: PrismaClient,
  actorUserId: string,
  tenantId: string,
  integrationId: string,
  disabled: boolean,
) {
  const row = await prisma.integration.findFirst({ where: { id: integrationId, tenantId } });
  if (!row) throw new ApiError(404, "not_found", "Подключение не найдено");
  const updated = await prisma.integration.update({
    where: { id: row.id },
    data: {
      status: disabled ? "disabled" : "pending",
      connectionStatus: disabled ? "DISCONNECTED" : "PENDING",
    },
    include: { forms: true },
  });
  await writeAudit(prisma, {
    tenantId,
    actorUserId,
    action: disabled ? "integration.disabled" : "integration.enabled",
    entityType: "integration",
    entityId: row.id,
    changes: { type: row.type },
  });
  invalidateRuntimeConfig(tenantId);
  return publicIntegration(updated);
}

export async function rotateTenantWebhookSecret(
  prisma: PrismaClient,
  actorUserId: string,
  tenantId: string,
  integrationId: string,
) {
  const row = await prisma.integration.findFirst({ where: { id: integrationId, tenantId, type: "webhook" } });
  if (!row) throw new ApiError(404, "not_found", "Webhook не найден");
  const secret = `whsec_${randomBytes(16).toString("hex")}`;
  await prisma.integration.update({
    where: { id: row.id },
    data: {
      secretHash: sha256(secret),
      previousSecretHash: row.secretHash || null,
      previousSecretExpiresAt: row.secretHash ? new Date(Date.now() + 24 * 60 * 60 * 1000) : null,
    },
  });
  await writeAudit(prisma, {
    tenantId,
    actorUserId,
    action: "integration.secret_rotated",
    entityType: "integration",
    entityId: row.id,
    changes: { rotated: true },
  });
  return {
    secret,
    eventsUrl: `${config.apiBaseUrl}/api/v1/integrations/${row.id}/events`,
    note: "Новый секрет показывается один раз. Значение в журнал не записывается.",
  };
}

function classifyConnectionError(message: string, code?: string | null) {
  const text = `${code || ""} ${message}`.toLowerCase();
  if (text.includes("401") || text.includes("unauthorized") || text.includes("секрет")) return "auth";
  if (text.includes("403") || text.includes("forbidden") || text.includes("прав")) return "permission";
  if (text.includes("econnrefused") || text.includes("timeout") || text.includes("недоступ")) return "unavailable";
  if (text.includes("invalid") || text.includes("url") || text.includes("параметр")) return "params";
  return "processing";
}

export async function testTenantConnection(
  prisma: PrismaClient,
  tenantId: string,
  integrationId: string,
  auth?: AuthContext | null,
) {
  const row = await prisma.integration.findFirst({
    where: { id: integrationId, tenantId },
    include: { forms: true },
  });
  if (!row) throw new ApiError(404, "not_found", "Подключение не найдено");
  const checkedAt = new Date();
  await prisma.integration.update({
    where: { id: row.id },
    data: { connectionStatus: "CHECKING" },
  });

  if (row.type === "whatsapp_seller") {
    const resolved = await resolveSellerBridge(prisma, tenantId);
    if (!resolved.configured) {
      await prisma.integration.update({
        where: { id: row.id },
        data: {
          connectionStatus: "ERROR",
          healthStatus: "ERROR",
          lastError: "Подключение не настроено: нет адреса или секрета компании",
          lastErrorCode: "not_configured",
          lastErrorAt: checkedAt,
        },
      });
      return {
        ok: false,
        category: "params",
        checkedAt,
        message: "Ненастроенная компания не использует общее подключение сервера.",
        liveSend: false,
      };
    }
    try {
      const health = await resolved.bridge!.health();
      await prisma.integration.update({
        where: { id: row.id },
        data: {
          status: "active",
          connectionStatus: "CONNECTED",
          healthStatus: "HEALTHY",
          lastError: null,
          lastErrorCode: null,
          lastSuccessAt: checkedAt,
        },
      });
      return {
        ok: true,
        category: "ok",
        checkedAt,
        message: `Мост отвечает. Sender: ${health.sender}. Сообщения клиентам не отправлялись.`,
        liveSend: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Мост недоступен";
      const category = classifyConnectionError(message);
      await prisma.integration.update({
        where: { id: row.id },
        data: {
          connectionStatus: "ERROR",
          healthStatus: "ERROR",
          lastError: message.slice(0, 500),
          lastErrorCode: category,
          lastErrorAt: checkedAt,
        },
      });
      return { ok: false, category, checkedAt, message, liveSend: false };
    }
  }

  if (auth) {
    try {
      const structural = await runIntegrationHealthCheck(prisma, auth, row.id);
      const ok = Array.isArray(structural)
        ? structural.every((item: { ok?: boolean }) => item.ok)
        : Boolean((structural as { ok?: boolean })?.ok ?? true);
      await prisma.integration.update({
        where: { id: row.id },
        data: {
          connectionStatus: row.status === "active" ? "CONNECTED" : row.connectionStatus,
          lastSuccessAt: ok ? checkedAt : row.lastSuccessAt,
        },
      });
      return {
        ok,
        category: ok ? "ok" : "params",
        checkedAt,
        message: "Проверены настройки и секрет. Внешняя отправка не выполнялась.",
        checks: structural,
        liveSend: false,
      };
    } catch {
      // platform admin may not have company membership; fall through
    }
  }

  const hasSecret = Boolean(row.secretHash || row.publicKey || row.type === "form");
  await prisma.integration.update({
    where: { id: row.id },
    data: {
      connectionStatus: hasSecret && row.status === "active" ? "CONNECTED" : "PENDING",
      lastError: hasSecret ? null : "Не задан секрет или публичный ключ",
    },
  });
  return {
    ok: hasSecret && row.status === "active",
    category: hasSecret ? "ok" : "params",
    checkedAt,
    message: hasSecret
      ? "Настройки сохранены. Это не проверка внешнего провайдера."
      : "Не задан секрет или ключ приёма.",
    liveSend: false,
  };
}

export async function listIntegrationEvents(prisma: PrismaClient, tenantId: string, integrationId: string) {
  const row = await prisma.integration.findFirst({ where: { id: integrationId, tenantId } });
  if (!row) throw new ApiError(404, "not_found", "Подключение не найдено");
  const items = await prisma.inboundEvent.findMany({
    where: { tenantId, integrationId },
    orderBy: { receivedAt: "desc" },
    take: 50,
    select: {
      id: true,
      status: true,
      eventType: true,
      lastError: true,
      receivedAt: true,
      processedAt: true,
      test: true,
    },
  });
  return { items };
}

export async function saveTenantAiSettings(
  prisma: PrismaClient,
  actorUserId: string,
  tenantId: string,
  input: Record<string, unknown>,
) {
  const existing = await prisma.aIConfiguration.findFirst({ where: { tenantId } });
  let credentialId = existing?.credentialId || null;
  if (typeof input.apiKey === "string" && input.apiKey.trim()) {
    const encrypted = encryptSecret(input.apiKey.trim());
    if (credentialId) {
      await prisma.credential.update({
        where: { id: credentialId },
        data: { encryptedValue: encrypted, rotatedAt: new Date() },
      });
    } else {
      const cred = await prisma.credential.create({
        data: {
          tenantId,
          scope: "tenant",
          kind: "llm_api_key",
          encryptedValue: encrypted,
          keyVersion: "v1",
        },
      });
      credentialId = cred.id;
    }
  }
  const data = {
    provider: input.provider ? String(input.provider) : existing?.provider || null,
    model: input.model ? String(input.model) : existing?.model || null,
    enabled: "enabled" in input ? Boolean(input.enabled) : existing?.enabled ?? true,
    credentialId,
    limitsJson: (input.limits && typeof input.limits === "object" ? input.limits : existing?.limitsJson || {}) as Prisma.InputJsonValue,
  };
  if (existing) {
    await prisma.aIConfiguration.update({ where: { id: existing.id }, data });
  } else {
    await prisma.aIConfiguration.create({ data: { tenantId, ...data } });
  }
  invalidateRuntimeConfig(tenantId);
  await writeAudit(prisma, {
    tenantId,
    actorUserId,
    action: "settings.ai_updated",
    entityType: "ai_configuration",
    entityId: tenantId,
    changes: { provider: data.provider, model: data.model, enabled: data.enabled, keyReplaced: Boolean(input.apiKey) },
  });
  const settings = await getEffectiveTenantSettings(prisma, tenantId);
  return { ai: settings.ai, keyStored: Boolean(credentialId) };
}
