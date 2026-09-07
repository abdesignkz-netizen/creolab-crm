import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@creolab/db";
import { crmModeToSeller, sellerModeToCrm, validateClientPhone } from "@creolab/contracts";
import { WhatsAppSellerBridge } from "@creolab/integrations";
import { config } from "../config.ts";
import { ApiError } from "../errors.ts";
import { sha256 } from "../lib/hash.ts";
import { decryptSecret, encryptSecret } from "../lib/secretBox.ts";
import { fileStorageStatus } from "../lib/storage.ts";
import type { AuthContext } from "../lib/types.ts";
import { can } from "../lib/types.ts";
import { analyzeAndApplyConversation } from "./conversationContextApplyService.ts";
import { getSituation, isConversationCommand } from "./situationService.ts";

function historyScopedId(leadId: string, item: { role: string; content: string; at?: string }) {
  const raw = `${leadId}|${item.role}|${item.at || ""}|${item.content}`;
  return `seller:${createHash("sha1").update(raw).digest("hex")}`;
}

function historyScopedIdByPhone(phone: string, item: { role: string; content: string; at?: string }) {
  const raw = `${phone}|${item.role}|${item.at || ""}|${item.content}`;
  return `sellerp:${createHash("sha1").update(raw).digest("hex")}`;
}

function historyFingerprint(role: string, content: string) {
  return `${role}\n${String(content || "").trim()}`;
}

function senderRole(senderKind: string) {
  return senderKind === "ai" ? "assistant" : "user";
}

async function upsertLeadHistory(
  prisma: PrismaClient,
  tid: string,
  conversationId: string,
  leadId: string,
  phone: string,
  history: Array<{ role: string; content: string; at?: string }>,
) {
  const slice = (history || []).slice(-40);
  if (!slice.length) return { added: 0, moved: 0 };
  let added = 0;
  let moved = 0;
  for (const item of slice) {
    const phoneScopedId = historyScopedIdByPhone(phone, item);
    const legacyScopedId = historyScopedId(leadId, item);
    const existing = await prisma.message.findFirst({
      where: { tenantId: tid, connectionScopedId: { in: [phoneScopedId, legacyScopedId] } },
    });
    if (existing) {
      const patch: { conversationId?: string; connectionScopedId?: string } = {};
      if (existing.conversationId !== conversationId) patch.conversationId = conversationId;
      if (existing.connectionScopedId !== phoneScopedId) patch.connectionScopedId = phoneScopedId;
      if (Object.keys(patch).length) {
        await prisma.message.update({ where: { id: existing.id }, data: patch });
        if (patch.conversationId) moved += 1;
      }
      continue;
    }
    await prisma.message.create({
      data: {
        tenantId: tid,
        conversationId,
        senderKind: item.role === "assistant" ? "ai" : "client",
        direction: item.role === "assistant" ? "outbound" : "inbound",
        text: item.content,
        historical: true,
        connectionScopedId: phoneScopedId,
        createdAt: item.at ? new Date(item.at) : new Date(),
      },
    });
    added += 1;
  }
  if (added || moved) {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { messageRevision: { increment: added + moved }, updatedAt: new Date() },
    });
  }
  return { added, moved };
}

async function findOrCreateContactByPhone(
  prisma: PrismaClient,
  tenantId: string,
  phone: { raw: string; normalized: string },
  name?: string | null,
) {
  const method = await prisma.contactMethod.findFirst({
    where: { tenantId, type: "phone", normalizedValue: phone.normalized },
    orderBy: { createdAt: "asc" },
  });
  if (method) {
    if (name) {
      const current = await prisma.contact.findFirst({ where: { id: method.contactId, tenantId } });
      if (current && (!current.name || current.name === "Без имени" || current.name === ".")) {
        await prisma.contact.update({ where: { id: current.id }, data: { name } });
      }
    }
    return method.contactId;
  }
  const contact = await prisma.contact.create({
    data: {
      tenantId,
      name: name || null,
      methods: {
        create: {
          type: "phone",
          rawValue: phone.raw,
          normalizedValue: phone.normalized,
          source: "whatsapp_seller",
          primary: true,
        },
      },
    },
  });
  return contact.id;
}

async function bindSellerIdentity(
  prisma: PrismaClient,
  tenantId: string,
  contactId: string,
  leadId: string,
  connectionId: string | null,
) {
  const byLead = await prisma.externalIdentity.findFirst({
    where: { tenantId, type: "seller_lead", externalId: leadId },
  });
  if (byLead && byLead.contactId !== contactId) {
    await prisma.externalIdentity.update({
      where: { id: byLead.id },
      data: { contactId, connectionId: connectionId || byLead.connectionId },
    });
    return;
  }
  if (byLead) return;

  const byContact = await prisma.externalIdentity.findFirst({
    where: { tenantId, contactId, type: "seller_lead" },
  });
  if (byContact) {
    await prisma.externalIdentity.update({
      where: { id: byContact.id },
      data: { externalId: leadId, connectionId: connectionId || byContact.connectionId },
    });
    return;
  }

  await prisma.externalIdentity.create({
    data: {
      tenantId,
      contactId,
      connectionId,
      type: "seller_lead",
      externalId: leadId,
      confirmed: true,
    },
  });
}

export async function applySellerLeadSync(
  prisma: PrismaClient,
  args: {
    tenantId: string;
    defaultRegion: string;
    lead: {
      leadId: string;
      clientPhone: string | null;
      clientName?: string | null;
      aiMode?: string | null;
      conversationHistory?: Array<{ role: string; content: string; at?: string }>;
    };
    connectionId: string | null;
  },
) {
  const phone = validateClientPhone(args.lead.clientPhone, args.defaultRegion);
  if (!phone.ok) {
    return { skipped: "needs_phone" as const };
  }

  const contactId = await findOrCreateContactByPhone(
    prisma,
    args.tenantId,
    { raw: phone.raw, normalized: phone.normalized },
    args.lead.clientName,
  );
  await bindSellerIdentity(prisma, args.tenantId, contactId, args.lead.leadId, args.connectionId);

  const convByLeadId = await prisma.conversation.findFirst({
    where: { tenantId: args.tenantId, sellerLeadId: args.lead.leadId },
    include: { contact: { include: { methods: true } } },
  });
  const convByContact = await prisma.conversation.findFirst({
    where: {
      tenantId: args.tenantId,
      contactId,
      OR: [{ sellerLeadId: { not: null } }, { id: convByLeadId?.id || "__none__" }],
    },
    orderBy: { updatedAt: "desc" },
  });

  const leadPhoneOnOldConv = convByLeadId?.contact?.methods.find((m) => m.type === "phone")?.normalizedValue;
  const leadIdBoundToWrongContact = Boolean(
    convByLeadId && (convByLeadId.contactId !== contactId || (leadPhoneOnOldConv && leadPhoneOnOldConv !== phone.normalized)),
  );

  let target = leadIdBoundToWrongContact ? convByContact && convByContact.contactId === contactId ? convByContact : null : convByLeadId || convByContact;
  if (target && target.contactId && target.contactId !== contactId) {
    target = null;
  }

  const mode = sellerModeToCrm(args.lead.aiMode);
  if (!target) {
    target = await prisma.conversation.create({
      data: {
        tenantId: args.tenantId,
        connectionId: args.connectionId,
        contactId,
        sellerLeadId: args.lead.leadId,
        externalThreadId: phone.normalized,
        mode,
        status: "open",
        needsAttention: mode !== "ai",
        attentionReason: mode === "human" ? "human" : mode === "paused" ? "paused" : null,
      },
    });
  } else {
    await prisma.conversation.update({
      where: { id: target.id },
      data: {
        mode,
        needsAttention: mode !== "ai",
        attentionReason: mode === "human" ? "human" : mode === "paused" ? "paused" : null,
        contactId,
        connectionId: args.connectionId || target.connectionId,
        sellerLeadId: args.lead.leadId,
        externalThreadId: phone.normalized,
      },
    });
  }

  if (leadIdBoundToWrongContact && convByLeadId && convByLeadId.id !== target.id) {
    await prisma.conversation.update({
      where: { id: convByLeadId.id },
      data: { sellerLeadId: null, attentionReason: "seller_lead_rematched" },
    });
  }

  const { added, moved } = await upsertLeadHistory(
    prisma,
    args.tenantId,
    target.id,
    args.lead.leadId,
    phone.normalized,
    args.lead.conversationHistory || [],
  );

  return {
    skipped: null,
    conversationId: target.id,
    contactId,
    phone: phone.normalized,
    added,
    moved,
    rematched: leadIdBoundToWrongContact,
    created: !convByLeadId && !convByContact,
  };
}

export async function reconcileImportedSellerMessages(
  prisma: PrismaClient,
  tenantId: string,
  defaultRegion: string,
  leads: Array<{
    leadId: string;
    clientPhone: string | null;
    conversationHistory?: Array<{ role: string; content: string; at?: string }>;
  }>,
  conversationByPhone: Map<string, string>,
) {
  const fingerprintsByPhone = new Map<string, Set<string>>();
  const ownersByFingerprint = new Map<string, Set<string>>();
  for (const lead of leads) {
    const phone = validateClientPhone(lead.clientPhone, defaultRegion);
    if (!phone.ok) continue;
    const fps = new Set<string>();
    for (const item of lead.conversationHistory || []) {
      const fp = historyFingerprint(item.role === "assistant" ? "assistant" : "user", item.content);
      fps.add(fp);
      const owners = ownersByFingerprint.get(fp) || new Set<string>();
      owners.add(phone.normalized);
      ownersByFingerprint.set(fp, owners);
    }
    fingerprintsByPhone.set(phone.normalized, fps);
  }

  const conversations = await prisma.conversation.findMany({
    where: {
      tenantId,
      OR: [{ sellerLeadId: { not: null } }, { messages: { some: { historical: true } } }],
    },
    include: {
      contact: { include: { methods: { where: { type: "phone" } } } },
      messages: {
        where: { historical: true, senderKind: { in: ["client", "ai"] } },
      },
    },
  });

  let removed = 0;
  let moved = 0;
  for (const conversation of conversations) {
    const convPhone =
      conversation.externalThreadId ||
      conversation.contact?.methods.find((item) => item.primary)?.normalizedValue ||
      conversation.contact?.methods[0]?.normalizedValue ||
      null;
    const own = convPhone ? fingerprintsByPhone.get(convPhone) : undefined;

    for (const message of conversation.messages) {
      const fp = historyFingerprint(senderRole(message.senderKind), message.text || "");
      const owners = [...(ownersByFingerprint.get(fp) || [])];
      const belongsHere = Boolean(convPhone && own?.has(fp));
      if (belongsHere) continue;

      const uniqueOther = owners.filter((phone) => phone !== convPhone);
      if (uniqueOther.length === 1) {
        const targetId = conversationByPhone.get(uniqueOther[0]);
        if (targetId && targetId !== conversation.id) {
          const duplicate = await prisma.message.findFirst({
            where: {
              tenantId,
              conversationId: targetId,
              senderKind: message.senderKind,
              text: message.text,
              id: { not: message.id },
            },
          });
          if (duplicate) {
            await prisma.message.delete({ where: { id: message.id } });
          } else {
            await prisma.message.update({
              where: { id: message.id },
              data: { conversationId: targetId },
            });
          }
          moved += 1;
          continue;
        }
      }

      if (!belongsHere) {
        await prisma.message.delete({ where: { id: message.id } });
        removed += 1;
      }
    }
  }

  return { removed, moved };
}

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership;
}

function describeBridgeError(error: unknown, sellerUrl: string) {
  const message = error instanceof Error ? error.message : String(error || "");
  const cause = error instanceof Error && "cause" in error ? (error.cause as { code?: string } | undefined) : undefined;
  const code = cause?.code || "";
  if (code === "ECONNREFUSED" || message === "fetch failed" || message.includes("ECONNREFUSED")) {
    return `Бот не запущен на ${sellerUrl || "http://127.0.0.1:3000"}. В папке whatsap ai выполните npm start, затем снова «Сохранить и проверить».`;
  }
  if (message.includes("unauthorized") || message.includes("HTTP 401")) {
    return "Секрет не совпал с CRM_BRIDGE_SECRET бота. На Render должен быть тот же секрет, что в кабинете.";
  }
  if (message.includes("HTTP 404") || message.includes("Cannot GET /internal/crm")) {
    return "Это боевой бот, но на нём ещё нет моста CRM (/internal/crm). Нужен деплой crmInternalApi.js на Render.";
  }
  if (code === "ETIMEDOUT" || message.includes("Timeout") || message.includes("aborted")) {
    return `Бот на ${sellerUrl} не ответил за 15 секунд.`;
  }
  return message || "Мост недоступен";
}

export async function getSellerIntegration(prisma: PrismaClient, tenantId: string) {
  return prisma.integration.findFirst({
    where: { tenantId, type: "whatsapp_seller" },
    include: { channelConnections: true, forms: true },
  });
}

export async function resolveSellerBridge(prisma: PrismaClient, tenantId: string) {
  const integration = await getSellerIntegration(prisma, tenantId);
  const schema = (integration?.schemaJson || {}) as { sellerUrl?: string; secretEnc?: string };
  const url = String(schema.sellerUrl || config.whatsappSellerUrl || "").trim();
  const secret = schema.secretEnc ? decryptSecret(schema.secretEnc) : config.whatsappSellerSecret;
  return {
    integration,
    url,
    configured: Boolean(url && secret),
    secretSet: Boolean(secret),
    bridge: url && secret ? new WhatsAppSellerBridge(url, secret) : null,
  };
}

export async function sellerHealthFor(prisma: PrismaClient, auth: AuthContext) {
  const membership = requireTenant(auth);
  const resolved = await resolveSellerBridge(prisma, membership.tenantId);
  const conversationCount = await prisma.conversation.count({
    where: { tenantId: membership.tenantId, sellerLeadId: { not: null } },
  });
  const lastSyncAt = resolved.integration?.lastEventAt || null;
  if (!resolved.configured || !resolved.bridge) {
    return {
      configured: false,
      reachable: false,
      sender: null,
      sellerUrl: resolved.url || "",
      secretSet: resolved.secretSet,
      leadCountOnBot: null as number | null,
      conversationCount,
      lastSyncAt,
      storePathKind: null as string | null,
      note: "WhatsApp ещё не подключён. CRM уже принимает формы и задачи.",
    };
  }
  try {
    const health = await resolved.bridge.health();
    const leadCountOnBot = typeof health.leadCount === "number" ? health.leadCount : null;
    return {
      configured: true,
      reachable: true,
      sender: health.sender,
      sellerUrl: resolved.url,
      secretSet: true,
      leadCountOnBot,
      conversationCount,
      lastSyncAt,
      storePathKind: health.storePathKind || null,
      note:
        leadCountOnBot === null
          ? "Мост отвечает. Отправка и команды менеджера остаются в боте."
          : `На боте ${leadCountOnBot} лидов · в CRM ${conversationCount} диалогов.`,
    };
  } catch (error) {
    return {
      configured: true,
      reachable: false,
      sender: "whatsappService.js",
      sellerUrl: resolved.url,
      secretSet: true,
      leadCountOnBot: null,
      conversationCount,
      lastSyncAt,
      storePathKind: null,
      note: describeBridgeError(error, resolved.url),
    };
  }
}

export async function connectWhatsAppSeller(
  prisma: PrismaClient,
  auth: AuthContext,
  input: { sellerUrl: string; secret: string },
) {
  const membership = requireTenant(auth);
  if (!can(auth, "manage_integrations") && membership.role !== "owner") {
    throw new ApiError(403, "forbidden", "Нет права управлять интеграциями");
  }
  const sellerUrl = String(input.sellerUrl || "").trim().replace(/\/$/, "");
  const secret = String(input.secret || "").trim();
  if (!sellerUrl || !secret) {
    throw new ApiError(422, "invalid", "Укажите адрес бота и секрет моста", {
      sellerUrl: sellerUrl ? "" : "Обязательно",
      secret: secret ? "" : "Обязательно",
    });
  }
  const bridge = new WhatsAppSellerBridge(sellerUrl, secret);
  let reachable = false;
  let note = "Сохранено. Бот сейчас не отвечает — проверьте, что whatsap ai запущен и CRM_BRIDGE_SECRET совпадает.";
  try {
    const health = await bridge.health();
    reachable = true;
    note = `Мост отвечает. Sender: ${health.sender}. Управление менеджера из WhatsApp не отключено.`;
  } catch (error) {
    note = describeBridgeError(error, sellerUrl);
  }

  let integration = await getSellerIntegration(prisma, membership.tenantId);
  const schemaJson = { sellerUrl, secretEnc: encryptSecret(secret), sendOwner: "external_bot" };
  if (!integration) {
    integration = await prisma.integration.create({
      data: {
        tenantId: membership.tenantId,
        type: "whatsapp_seller",
        name: "WhatsApp ИИ-менеджер",
        status: reachable ? "active" : "error",
        testMode: false,
        lastError: reachable ? null : note,
        schemaJson,
        channelConnections: {
          create: {
            tenantId: membership.tenantId,
            channelType: "whatsapp",
            status: reachable ? "active" : "error",
            autoReply: false,
            capabilitiesJson: ["receive_messages", "send_text", "send_media", "delivery_receipts"],
          },
        },
      },
      include: { channelConnections: true, forms: true },
    });
  } else {
    integration = await prisma.integration.update({
      where: { id: integration.id },
      data: {
        status: reachable ? "active" : "error",
        lastError: reachable ? null : note,
        schemaJson,
      },
      include: { channelConnections: true, forms: true },
    });
  }
  await prisma.auditEvent.create({
    data: {
      tenantId: membership.tenantId,
      actorUserId: auth.user.id,
      action: "integration.whatsapp.connect",
      entityType: "integration",
      entityId: integration.id,
      changesJson: { sellerUrl, reachable },
    },
  });
  return { ok: true, reachable, note, integrationId: integration.id };
}

export async function syncSellerLeads(prisma: PrismaClient, auth: AuthContext) {
  const membership = requireTenant(auth);
  const resolved = await resolveSellerBridge(prisma, membership.tenantId);
  if (!resolved.bridge) {
    throw new ApiError(422, "not_configured", "Сначала подключите WhatsApp ИИ-менеджер");
  }
  const { leads } = await resolved.bridge.listLeads();
  const connection = resolved.integration
    ? await prisma.channelConnection.findFirst({
        where: { tenantId: membership.tenantId, integrationId: resolved.integration.id },
      })
    : null;
  let imported = 0;
  let updated = 0;
  let needsPhone = 0;
  let messagesAdded = 0;
  let rematched = 0;
  const analyzeIds: string[] = [];
  const conversationByPhone = new Map<string, string>();
  for (const lead of leads) {
    const result = await applySellerLeadSync(prisma, {
      tenantId: membership.tenantId,
      defaultRegion: membership.tenant.defaultRegion,
      lead,
      connectionId: connection?.id || null,
    });
    if (result.skipped === "needs_phone") {
      needsPhone += 1;
      continue;
    }
    messagesAdded += result.added + result.moved;
    if (result.rematched) rematched += 1;
    if (result.created) imported += 1;
    else updated += 1;
    if (result.phone) conversationByPhone.set(result.phone, result.conversationId);
    if (result.added > 0 || result.moved > 0 || result.rematched) {
      analyzeIds.push(result.conversationId);
    }
  }
  const cleaned = await reconcileImportedSellerMessages(
    prisma,
    membership.tenantId,
    membership.tenant.defaultRegion,
    leads,
    conversationByPhone,
  );
  if (cleaned.removed + cleaned.moved > 0) {
    messagesAdded += cleaned.moved;
  }
  if (resolved.integration) {
    await prisma.integration.update({
      where: { id: resolved.integration.id },
      data: { lastEventAt: new Date(), lastError: null, status: "active" },
    });
  }

  let contextApplied = 0;
  for (const conversationId of [...new Set(analyzeIds)].slice(0, 25)) {
    try {
      await analyzeAndApplyConversation(prisma, auth, conversationId, { useLlm: true });
      contextApplied += 1;
    } catch {
      /* analysis is best-effort during sync */
    }
  }

  return {
    imported,
    updated,
    rematched,
    cleaned: cleaned.removed + cleaned.moved,
    needsPhone,
    messagesAdded,
    contextApplied,
    total: leads.length,
    note:
      leads.length === 0
        ? "Бот ответил, но в его базе нет лидов. Кнопка забирает только то, что уже лежит в leads.json после входящих сообщений. Историю WhatsApp из Green API она не выгружает."
        : undefined,
  };
}

export async function addSellerInstruction(
  prisma: PrismaClient,
  auth: AuthContext,
  conversationId: string,
  text: string,
) {
  const membership = requireTenant(auth);
  const instruction = String(text || "").trim();
  if (!instruction) {
    throw new ApiError(422, "invalid", "Напишите поручение для ИИ");
  }
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId: membership.tenantId },
  });
  if (!conversation?.sellerLeadId) {
    throw new ApiError(422, "no_seller", "Диалог ещё не связан с WhatsApp-лидом. Сначала синхронизируйте.");
  }
  const resolved = await resolveSellerBridge(prisma, membership.tenantId);
  if (!resolved.bridge) throw new ApiError(422, "not_configured", "WhatsApp не подключён");
  let appliedOnSeller = false;
  let sellerError: string | null = null;
  try {
    await resolved.bridge.addInstruction(conversation.sellerLeadId, instruction);
    appliedOnSeller = true;
  } catch (error) {
    sellerError = `На боте не применилось: ${error instanceof Error ? error.message : "мост недоступен"}`;
  }
  await prisma.note.create({
    data: {
      tenantId: membership.tenantId,
      parentType: "conversation",
      parentId: conversation.id,
      authorUserId: auth.user.id,
      text: instruction,
      internal: true,
      contactId: conversation.contactId,
    },
  });
  await prisma.auditEvent.create({
    data: {
      tenantId: membership.tenantId,
      actorUserId: auth.user.id,
      action: "conversation.instruction",
      entityType: "conversation",
      entityId: conversation.id,
      changesJson: { sellerLeadId: conversation.sellerLeadId, appliedOnSeller },
    },
  });
  return { ok: true, appliedOnSeller, sellerError };
}

export async function integrationSetup(prisma: PrismaClient, auth: AuthContext) {
  const membership = requireTenant(auth);
  const [form, webhook, seller, telegram] = await Promise.all([
    prisma.formDefinition.findFirst({
      where: { tenantId: membership.tenantId, active: true },
      include: { integration: true },
    }),
    prisma.integration.findFirst({ where: { tenantId: membership.tenantId, type: "webhook" } }),
    sellerHealthFor(prisma, auth),
    prisma.telegramBinding.findFirst({ where: { userId: auth.user.id, revokedAt: null } }),
  ]);
  const apiBase = config.apiBaseUrl;
  const formHealth = form
    ? form.integration.lastError
      ? "ERROR"
      : form.integration.lastEventAt
        ? "HEALTHY"
        : "NO_EVENTS_YET"
    : "UNKNOWN";
  return {
    whatsapp: seller,
    fileStorage: fileStorageStatus(),
    form: form
      ? {
          connected: true,
          name: form.name,
          publicKey: form.publicKey,
          submitUrl: `${apiBase}/public/forms/${form.publicKey}/submissions`,
          connectionStatus: "CONNECTED",
          healthStatus: formHealth,
          healthLabel:
            formHealth === "HEALTHY"
              ? "Работает"
              : formHealth === "NO_EVENTS_YET"
                ? "Подключено · событий ещё нет"
                : "Ошибка",
          mapping: form.integration.mappingJson,
          testMode: Boolean(form.integration.testMode),
          integrationId: form.integrationId,
        }
      : { connected: false },
    webhook: webhook
      ? {
          connected: webhook.status === "active",
          id: webhook.id,
          eventsUrl: `${apiBase}/api/v1/integrations/${webhook.id}/events`,
          connectionStatus: webhook.status === "active" ? "CONNECTED" : "PENDING",
          healthStatus: webhook.lastError
            ? "ERROR"
            : webhook.lastEventAt
              ? "HEALTHY"
              : "NO_EVENTS_YET",
          healthLabel: webhook.lastError
            ? "Ошибка"
            : webhook.lastEventAt
              ? "Работает"
              : "Подключено · событий ещё нет",
        }
      : { connected: false },
    telegram: {
      siteLeads: {
        connected: false,
        note: "Клиентский Telegram-бот — отдельный этап (сообщения ≠ заявки).",
      },
      employee: {
        connected: Boolean(telegram),
        botConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_USERNAME),
        note: process.env.TELEGRAM_BOT_TOKEN
          ? "Бот задан. Нажмите «Подключить Telegram», затем /start в боте."
          : "Для уведомлений сотрудника задайте TELEGRAM_BOT_TOKEN и TELEGRAM_BOT_USERNAME в .env CRM.",
      },
    },
    placeholders: {
      instagramDirect: { connected: false, note: "Этап 4 · OAuth Professional Account" },
      metaLeadForms: { connected: false, note: "Этап 5 · отдельно от Instagram Direct" },
      googleForms: { connected: false, note: "Этап 6 · Pub/Sub + watch renewal" },
      tiktokLeads: { connected: false, note: "Только после capability check аккаунта" },
    },
  };
}

export async function rotateWebhookSecret(prisma: PrismaClient, auth: AuthContext, integrationId: string) {
  const membership = requireTenant(auth);
  if (!can(auth, "manage_integrations") && membership.role !== "owner") {
    throw new ApiError(403, "forbidden", "Нет права");
  }
  const integration = await prisma.integration.findFirst({
    where: { id: integrationId, tenantId: membership.tenantId, type: "webhook" },
  });
  if (!integration) throw new ApiError(404, "not_found", "Webhook не найден");
  const secret = `whsec_${randomBytes(16).toString("hex")}`;
  const previousHash = integration.secretHash;
  await prisma.integration.update({
    where: { id: integration.id },
    data: {
      secretHash: sha256(secret),
      previousSecretHash: previousHash || null,
      previousSecretExpiresAt: previousHash ? new Date(Date.now() + 24 * 60 * 60 * 1000) : null,
      connectionStatus: "CONNECTED",
      healthStatus: deriveHealthOrKeep(integration),
    },
  });
  return {
    secret,
    eventsUrl: `${config.apiBaseUrl}/api/v1/integrations/${integration.id}/events`,
    previousSecretValidHours: previousHash ? 24 : 0,
    note: previousHash
      ? "Новый секрет активен. Старый ещё действует 24 часа — успейте обновить отправителя."
      : "Секрет показывается один раз. Сохраните его на стороне отправителя.",
  };
}

function deriveHealthOrKeep(integration: { lastEventAt: Date | null; lastError: string | null }) {
  if (integration.lastError) return "ERROR";
  if (!integration.lastEventAt) return "NO_EVENTS_YET";
  return "HEALTHY";
}

export async function beginTelegramLink(prisma: PrismaClient, auth: AuthContext) {
  const token = randomBytes(16).toString("hex");
  const username = process.env.TELEGRAM_BOT_USERNAME || "";
  await prisma.telegramBinding.create({
    data: {
      userId: auth.user.id,
      chatRef: "",
      pendingTokenHash: sha256(token),
      pendingExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
  });
  return {
    expiresInMinutes: 10,
    deepLink: username ? `https://t.me/${username}?start=${token}` : null,
    token: username ? undefined : token,
    note: username
      ? "Откройте ссылку и нажмите Start. Не отправляйте токен в клиентский чат."
      : "TELEGRAM_BOT_USERNAME не задан. Привязка не завершится, пока бот сотрудника не настроен.",
  };
}

export async function controlBoard(prisma: PrismaClient, auth: AuthContext) {
  const [situation, seller] = await Promise.all([getSituation(prisma, auth, { scope: "all" }), sellerHealthFor(prisma, auth)]);
  return {
    seller,
    items: situation.items.filter(isConversationCommand),
    freshness: situation.freshness,
    metrics: situation.metrics,
  };
}

export { crmModeToSeller };
