import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@creolab/db";
import { crmModeToSeller, sellerModeToCrm, validateClientPhone } from "@creolab/contracts";
import { WhatsAppSellerBridge } from "@creolab/integrations";
import { config } from "../config.ts";
import { ApiError } from "../errors.ts";
import { sha256, randomToken, safeEqual } from "../lib/hash.ts";
import { decryptSecret, encryptSecret } from "../lib/secretBox.ts";
import type { AuthContext } from "../lib/types.ts";
import { can } from "../lib/types.ts";
import { requireIntegrationsAccess, requireNotManager, requireTenant } from "../lib/access.ts";
import { enqueueConversationContext } from "./conversationContextQueue.ts";
import { analyzeAndApplyConversation } from "./conversationContextApplyService.ts";
import {
  assertAiManagerReachableUrl,
  extractWhatsAppInstanceId,
  platformBridgeSecret,
  resolveAiManagerUrl,
  sharedAiManagerUrl,
  type WhatsAppSellerSchema,
} from "./aiManagerConfig.ts";
import { syncWhatsAppAiManagerRegistration } from "./aiManagerRegistration.ts";
import { checkGreenApiWhatsAppNumber } from "./greenApiWebhook.ts";
import { classifyWhatsAppDeliveryError, WHATSAPP_NOT_REGISTERED } from "./whatsappChannel.ts";
import { adoptSameContactThreadMessages, listThreadConversationIds } from "./conversationThread.ts";
import { ensureWhatsAppInquiry } from "./inquiryService.ts";
import { getSituation, isConversationCommand } from "./situationService.ts";
import {
  attachHistoryMedia,
  historyMediaFingerprint,
  historyMessageText,
  historyMessageType,
  looksLikeMediaPlaceholder,
  normalizeHistoryMediaItem,
  type HistoryMediaItem,
} from "./conversationMedia.ts";

function historyScopedRaw(item: HistoryMediaItem) {
  const raw = `${item.role}|${item.at || ""}|${item.content}`;
  const media = historyMediaFingerprint(item);
  return media ? `${raw}|${media}` : raw;
}

function historyScopedId(leadId: string, item: HistoryMediaItem) {
  return `seller:${createHash("sha1").update(`${leadId}|${historyScopedRaw(item)}`).digest("hex")}`;
}

function historyScopedIdByPhone(phone: string, item: HistoryMediaItem) {
  return `sellerp:${createHash("sha1").update(`${phone}|${historyScopedRaw(item)}`).digest("hex")}`;
}

function validHistoryDate(value?: string) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

async function upsertLeadHistory(
  prisma: PrismaClient,
  tid: string,
  conversationId: string,
  leadId: string,
  phone: string,
  history: unknown[],
) {
  const slice = (history || []).slice(-40);
  if (!slice.length) return { added: 0, moved: 0 };
  let added = 0;
  let moved = 0;
  let inboundAdded = false;
  for (const raw of slice) {
    const item = normalizeHistoryMediaItem(raw);
    if (!item) continue;
    const oldPhoneScopedId = historyScopedIdByPhone(phone, item);
    const legacyPhoneId = `${tid}:${oldPhoneScopedId}`;
    const phoneScopedId = item.providerMessageId ? `seller-msg:${tid}:${phone}:${item.providerMessageId}` : legacyPhoneId;
    const legacyScopedId = historyScopedId(leadId, item);
    const existing = await prisma.message.findFirst({
      where: { tenantId: tid, connectionScopedId: { in: [phoneScopedId, legacyPhoneId, oldPhoneScopedId, legacyScopedId] } },
    });
    if (existing) {
      const patch: { conversationId?: string; connectionScopedId?: string; type?: string } = {};
      if (existing.conversationId !== conversationId) patch.conversationId = conversationId;
      if (existing.connectionScopedId !== phoneScopedId) patch.connectionScopedId = phoneScopedId;
      const nextType = historyMessageType(item);
      if (nextType !== "text" && existing.type === "text") patch.type = nextType;
      if (Object.keys(patch).length) {
        await prisma.message.update({ where: { id: existing.id }, data: patch });
        if (patch.conversationId) moved += 1;
      }
      const hasFile = await prisma.attachment.findFirst({ where: { tenantId: tid, messageId: existing.id } });
      if (!hasFile) await attachHistoryMedia(prisma, tid, existing.id, item);
      continue;
    }
    const created = await prisma.$transaction(async tx => {
      const message = await tx.message.upsert({
      where: { connectionScopedId: phoneScopedId },
      update: {},
      create: {
        tenantId: tid,
        conversationId,
        senderKind: item.role === "assistant" ? "ai" : "client",
        direction: item.role === "assistant" ? "outbound" : "inbound",
        type: historyMessageType(item),
        text: historyMessageText(item),
        historical: true,
        connectionScopedId: phoneScopedId,
        providerMessageId: item.providerMessageId,
        createdAt: validHistoryDate(item.at) || new Date(),
      },
    });
      await enqueueConversationContext(tx, tid, conversationId, message.id);
      await tx.conversation.update({ where: { id: conversationId }, data: { messageRevision: { increment: 1 } } });
      return message;
    });
    await attachHistoryMedia(prisma, tid, created.id, item);
    added += 1;
    if (item.role !== "assistant") inboundAdded = true;
  }
  if (added || moved) {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        messageRevision: { increment: moved },
        updatedAt: new Date(),
        ...(inboundAdded ? { needsAttention: true, attentionReason: "needs_reply" } : {}),
      },
    });
  }
  return { added, moved };
}

export { adoptSameContactThreadMessages, listThreadConversationIds };

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
  const convByContact =
    (await prisma.conversation.findFirst({
      where: { tenantId: args.tenantId, contactId, sellerLeadId: { not: null } },
      orderBy: { updatedAt: "desc" },
    })) ||
    (await prisma.conversation.findFirst({
      where: {
        tenantId: args.tenantId,
        contactId,
        OR: [{ externalThreadId: phone.normalized }, { id: convByLeadId?.id || "__none__" }],
      },
      orderBy: { updatedAt: "desc" },
    }));

  const leadPhoneOnOldConv = convByLeadId?.contact?.methods.find((m) => m.type === "phone")?.normalizedValue;
  const leadIdBoundToWrongContact = Boolean(
    convByLeadId && (convByLeadId.contactId !== contactId || (leadPhoneOnOldConv && leadPhoneOnOldConv !== phone.normalized)),
  );

  let target = leadIdBoundToWrongContact ? convByContact && convByContact.contactId === contactId ? convByContact : null : convByLeadId || convByContact;
  if (target && target.contactId && target.contactId !== contactId) {
    target = null;
  }

  const mode = args.lead.aiMode ? sellerModeToCrm(args.lead.aiMode) : target?.mode || "ai";
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
        needsAttention: false,
        attentionReason: mode === "human" ? "human" : mode === "paused" ? "paused" : null,
      },
    });
  } else {
    const becameHumanFromAi = target.mode === "ai" && mode !== "ai";
    await prisma.conversation.update({
      where: { id: target.id },
      data: {
        mode,
        needsAttention: mode === "ai" ? false : becameHumanFromAi ? true : target.needsAttention,
        attentionReason:
          mode === "ai"
            ? null
            : becameHumanFromAi
              ? mode === "paused"
                ? "paused"
                : "human"
              : target.attentionReason,
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

  const adopted = await adoptSameContactThreadMessages(
    prisma,
    args.tenantId,
    { ...target, sellerLeadId: args.lead.leadId, contactId },
    phone.normalized,
  );

  const { added, moved } = await upsertLeadHistory(
    prisma,
    args.tenantId,
    target.id,
    args.lead.leadId,
    phone.normalized,
    args.lead.conversationHistory || [],
  );

  const dates = await prisma.message.findMany({
    where: { tenantId: args.tenantId, conversation: { contactId }, internal: false },
    select: { createdAt: true, direction: true }, orderBy: { createdAt: "asc" },
  });
  const contact = await prisma.contact.findUniqueOrThrow({ where: { id: contactId } });
  const earliest = dates[0]?.createdAt;
  const latest = dates.at(-1)?.createdAt;
  const latestInbound = dates.filter((m) => m.direction === "inbound").at(-1)?.createdAt;
  const latestOutbound = dates.filter((m) => m.direction === "outbound").at(-1)?.createdAt;
  const later = (a: Date | null, b?: Date) => !a || (b && b > a) ? b || a : a;
  const attribution = (contact.attributionJson || {}) as Record<string, unknown>;
  await prisma.contact.update({
    where: { id: contactId },
    data: {
      firstSeenAt: earliest && earliest < contact.firstSeenAt ? earliest : contact.firstSeenAt,
      lastSeenAt: later(contact.lastSeenAt, latest) || contact.lastSeenAt,
      lastContactAt: later(contact.lastContactAt, latest),
      lastInboundMessageAt: later(contact.lastInboundMessageAt, latestInbound),
      lastOutboundMessageAt: later(contact.lastOutboundMessageAt, latestOutbound),
      attributionJson: { source: "whatsapp", sourceType: "whatsapp", ...attribution },
    },
  });

  const inquiry = await ensureWhatsAppInquiry(prisma, {
    tenantId: args.tenantId,
    contactId,
    conversationId: target.id,
    leadId: args.lead.leadId,
    name: args.lead.clientName || contact.name,
    phoneRaw: phone.raw,
    phoneNormalized: phone.normalized,
  });

  return {
    skipped: null,
    conversationId: target.id,
    contactId,
    inquiryId: inquiry.inquiry.id,
    inquiryCreated: inquiry.created,
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
  // A bounded snapshot is not evidence of deletion or ownership. Identical
  // greetings can belong to different clients. Only exact legacy IDs are moved
  // by upsertLeadHistory; all other stored history must be retained.
  return { removed: 0, moved: 0 };
}

function requireIntegrationAdmin(auth: AuthContext) {
  requireIntegrationsAccess(auth);
}

function mergeLeadHistory(history: unknown[], extras: unknown[]) {
  const next = [...history];
  for (const extra of extras) {
    const item = normalizeHistoryMediaItem(extra);
    if (!item) continue;
    const idx = next.findIndex((raw) => {
      const current = normalizeHistoryMediaItem(raw);
      return Boolean(
        current &&
          current.role === item.role &&
          (current.at || "") === (item.at || "") &&
          (current.content === item.content || !current.content || looksLikeMediaPlaceholder(current.content)),
      );
    });
    if (idx >= 0) next[idx] = { ...(typeof next[idx] === "object" && next[idx] ? next[idx] : {}), ...item };
    else next.push(item);
  }
  return next;
}

function describeBridgeError(error: unknown, _sellerUrl: string) {
  const message = error instanceof Error ? error.message : String(error || "");
  const cause = error instanceof Error && "cause" in error ? (error.cause as { code?: string } | undefined) : undefined;
  const code = cause?.code || "";
  if (code === "ECONNREFUSED" || message === "fetch failed" || message.includes("ECONNREFUSED")) {
    return "WhatsApp сейчас недоступен. Проверьте подключение позже или обратитесь в поддержку.";
  }
  if (message.includes("unauthorized") || message.includes("HTTP 401")) {
    return "Не удалось подтвердить подключение. Нажмите «Переподключить» или обратитесь в поддержку.";
  }
  if (message.includes("HTTP 404") || message.includes("Cannot GET /internal/crm")) {
    return "WhatsApp ещё не готов для этой компании. Обратитесь в поддержку.";
  }
  if (code === "ETIMEDOUT" || message.includes("Timeout") || message.includes("aborted")) {
    return "WhatsApp не ответил. Попробуйте позже.";
  }
  return "WhatsApp сейчас недоступен.";
}

export async function getSellerIntegration(prisma: PrismaClient, tenantId: string) {
  return prisma.integration.findFirst({
    where: { tenantId, type: "whatsapp_seller" },
    include: { channelConnections: true, forms: true },
  });
}

export async function resolveSellerBridge(prisma: PrismaClient, tenantId: string) {
  const integration = await getSellerIntegration(prisma, tenantId);
  const schema = (integration?.schemaJson || {}) as WhatsAppSellerSchema;
  const disabled = integration?.status === "disabled" || integration?.connectionStatus === "DISCONNECTED";
  const url = resolveAiManagerUrl(schema.sellerUrl);
  const integrationSecret = schema.secretEnc ? decryptSecret(schema.secretEnc) : "";
  const configured = Boolean(!disabled && url && integrationSecret);
  return {
    integration,
    url,
    configured,
    secretSet: Boolean(integrationSecret),
    instanceId: String(schema.instanceId || "").trim() || null,
    needsAssignment: Boolean(integration && !integrationSecret),
    bridge:
      configured && url && integrationSecret && integration?.id
        ? new WhatsAppSellerBridge(url, integrationSecret, { tenantId, integrationId: integration.id })
        : null,
  };
}

function phoneLookupValues(normalized: Array<string | null | undefined>) {
  const values = new Set<string>();
  for (const raw of normalized) {
    const digits = String(raw || "").replace(/\D/g, "");
    if (!digits) continue;
    values.add(digits);
    if (digits.startsWith("8") && digits.length === 11) values.add(`7${digits.slice(1)}`);
    if (digits.startsWith("7") && digits.length === 11) values.add(`8${digits.slice(1)}`);
  }
  return [...values];
}

export async function findExistingWhatsAppConversation(
  prisma: PrismaClient,
  tenantId: string,
  contactId: string,
  preferredConversationId?: string | null,
) {
  if (preferredConversationId) {
    const preferred = await prisma.conversation.findFirst({
      where: { id: preferredConversationId, tenantId, sellerLeadId: { not: null } },
    });
    if (preferred?.sellerLeadId && (!preferred.contactId || preferred.contactId === contactId)) {
      return preferred;
    }
  }

  const own = await prisma.conversation.findFirst({
    where: { tenantId, contactId, sellerLeadId: { not: null } },
    orderBy: { updatedAt: "desc" },
  });
  if (own) return own;

  const phones = await prisma.contactMethod.findMany({
    where: { tenantId, contactId, type: "phone" },
    select: { normalizedValue: true },
  });
  const values = phoneLookupValues(phones.map((item) => item.normalizedValue));

  if (values.length) {
    const byThread = await prisma.conversation.findFirst({
      where: { tenantId, sellerLeadId: { not: null }, externalThreadId: { in: values } },
      orderBy: { updatedAt: "desc" },
    });
    if (byThread) return byThread;

    const sibling = await prisma.contactMethod.findFirst({
      where: {
        tenantId,
        type: "phone",
        normalizedValue: { in: values },
        contactId: { not: contactId },
      },
      orderBy: { createdAt: "asc" },
    });
    if (sibling) {
      const conv = await prisma.conversation.findFirst({
        where: { tenantId, contactId: sibling.contactId, sellerLeadId: { not: null } },
        orderBy: { updatedAt: "desc" },
      });
      if (conv) return conv;
    }
  }

  const identity = await prisma.externalIdentity.findFirst({
    where: { tenantId, contactId, type: "seller_lead" },
  });
  if (identity?.externalId) {
    const byLead = await prisma.conversation.findFirst({
      where: { tenantId, sellerLeadId: identity.externalId },
    });
    if (byLead?.sellerLeadId && (!byLead.contactId || byLead.contactId === contactId)) {
      return byLead;
    }
    if (byLead?.sellerLeadId && byLead.contactId && values.length) {
      const otherPhones = await prisma.contactMethod.findMany({
        where: { tenantId, contactId: byLead.contactId, type: "phone" },
        select: { normalizedValue: true },
      });
      const otherValues = phoneLookupValues(otherPhones.map((item) => item.normalizedValue));
      if (otherValues.some((item) => values.includes(item))) return byLead;
    }
  }

  return null;
}

async function healWhatsAppFromBot(
  prisma: PrismaClient,
  args: {
    tenantId: string;
    contactId: string;
    defaultRegion?: string;
    contactName?: string | null;
    extraPhones?: Array<string | null | undefined>;
  },
): Promise<{ conversation: Awaited<ReturnType<typeof findExistingWhatsAppConversation>>; error: string | null }> {
  const phones = await prisma.contactMethod.findMany({
    where: { tenantId: args.tenantId, contactId: args.contactId, type: "phone" },
    select: { rawValue: true, normalizedValue: true },
  });
  const values = phoneLookupValues([
    ...phones.map((item) => item.normalizedValue || item.rawValue),
    ...(args.extraPhones || []),
  ]);
  if (!values.length) return { conversation: null, error: "no_phone" };

  const resolved = await resolveSellerBridge(prisma, args.tenantId);
  if (!resolved.bridge) return { conversation: null, error: "not_configured" };
  const region = args.defaultRegion || "KZ";
  const connection = resolved.integration
    ? await prisma.channelConnection.findFirst({
        where: { tenantId: args.tenantId, integrationId: resolved.integration.id },
      })
    : null;

  const matchesPhone = (clientPhone: string | null | undefined) => {
    const stripped = String(clientPhone || "").replace(/@(c\.us|s\.whatsapp\.net|g\.us|lid)$/i, "");
    const parsed = validateClientPhone(stripped, region);
    if (parsed.ok && values.includes(parsed.normalized)) return true;
    const digits = phoneLookupValues([stripped, clientPhone]);
    return digits.some((item) => values.includes(item));
  };

  try {
    const listed = await resolved.bridge.listLeads();
    const leads = await filterLeadsForTenant(prisma, args.tenantId, listed.leads);
    const lead = leads.find((item) => matchesPhone(item.clientPhone));
    if (lead) {
      await applySellerLeadSync(prisma, {
        tenantId: args.tenantId,
        defaultRegion: region,
        lead,
        connectionId: connection?.id || null,
      });
      const synced = await findExistingWhatsAppConversation(prisma, args.tenantId, args.contactId);
      if (synced?.sellerLeadId) return { conversation: synced, error: null };
    }
  } catch (error) {
    console.warn("[whatsapp-heal] listLeads failed", error instanceof Error ? error.message : error);
  }

  const phone = values.find((item) => item.startsWith("7") && item.length === 11) || values[0];
  try {
    const ensured = await resolved.bridge.ensureLead(phone, args.contactName);
    if (ensured?.lead) {
      await applySellerLeadSync(prisma, {
        tenantId: args.tenantId,
        defaultRegion: region,
        lead: ensured.lead,
        connectionId: connection?.id || null,
      });
      return {
        conversation: await findExistingWhatsAppConversation(prisma, args.tenantId, args.contactId),
        error: null,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "ensureLead failed";
    console.warn("[whatsapp-heal] ensureLead failed", message);
    return { conversation: null, error: message };
  }

  return { conversation: null, error: "NO_AUTOMATED_CHANNEL" };
}

export async function resolveWhatsAppConversation(
  prisma: PrismaClient,
  args: {
    tenantId: string;
    contactId: string;
    preferredConversationId?: string | null;
    defaultRegion?: string;
    contactName?: string | null;
    healFromBot?: boolean;
  },
) {
  const existing = await findExistingWhatsAppConversation(
    prisma,
    args.tenantId,
    args.contactId,
    args.preferredConversationId,
  );
  if (existing?.sellerLeadId) return existing;
  if (!args.healFromBot) return existing;
  const healed = await healWhatsAppFromBot(prisma, args);
  return healed.conversation;
}

export async function openWhatsAppChannelForContact(
  prisma: PrismaClient,
  args: {
    tenantId: string;
    contactId: string;
    contactName?: string | null;
    defaultRegion?: string;
    extraPhones?: Array<string | null | undefined>;
  },
) {
  const existing = await findExistingWhatsAppConversation(prisma, args.tenantId, args.contactId);
  if (existing?.sellerLeadId) return { conversation: existing, error: null as string | null };
  return healWhatsAppFromBot(prisma, args);
}

function greenApiTokenPlain(schema: WhatsAppSellerSchema) {
  if (!schema.apiTokenEnc) return "";
  try {
    return decryptSecret(schema.apiTokenEnc);
  } catch {
    return "";
  }
}

export async function startContactWhatsAppChat(prisma: PrismaClient, auth: AuthContext, contactId: string) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, tenantId: tid },
    include: { methods: true },
  });
  if (!contact) throw new ApiError(404, "not_found", "Клиент не найден");

  const existing = await findExistingWhatsAppConversation(prisma, tid, contactId);
  if (existing?.sellerLeadId) {
    return { conversationId: existing.id, created: false };
  }

  const region = membership.tenant.defaultRegion || "KZ";
  const phoneRow = contact.methods.find((item) => item.type === "phone" && item.primary) || contact.methods.find((item) => item.type === "phone");
  const parsed = phoneRow ? validateClientPhone(phoneRow.rawValue || phoneRow.normalizedValue, region) : { ok: false as const };
  if (!parsed.ok) {
    throw new ApiError(422, "no_phone", "Укажите телефон клиента, чтобы написать в WhatsApp");
  }

  const resolved = await resolveSellerBridge(prisma, tid);
  const schema = (resolved.integration?.schemaJson || {}) as WhatsAppSellerSchema;
  const instanceId = String(schema.instanceId || "").trim();
  const apiToken = greenApiTokenPlain(schema);
  if (instanceId && apiToken) {
    const check = await checkGreenApiWhatsAppNumber({
      instanceId,
      apiToken,
      phone: parsed.normalized,
      apiHost: schema.greenApiHost,
    });
    if (check.exists === false) {
      throw new ApiError(409, WHATSAPP_NOT_REGISTERED, "Этот номер не зарегистрирован в WhatsApp");
    }
  }

  const opened = await openWhatsAppChannelForContact(prisma, {
    tenantId: tid,
    contactId,
    contactName: [contact.firstName, contact.lastName, contact.name].filter(Boolean).join(" ").trim() || contact.name,
    defaultRegion: region,
    extraPhones: [parsed.normalized, parsed.raw],
  });
  if (!opened.conversation?.sellerLeadId) {
    const classified = classifyWhatsAppDeliveryError(opened.error);
    if (classified.code === WHATSAPP_NOT_REGISTERED) {
      throw new ApiError(409, WHATSAPP_NOT_REGISTERED, "Этот номер не зарегистрирован в WhatsApp");
    }
    throw new ApiError(422, classified.code, classified.message);
  }

  try {
    const { setConversationMode } = await import("./domainService.ts");
    await setConversationMode(prisma, auth, opened.conversation.id, "human");
  } catch {
    // The thread exists; the composer still opens even if takeover is already done.
  }

  return { conversationId: opened.conversation.id, created: true };
}

function sellerSyncWarning(args: {
  configured: boolean;
  reachable: boolean;
  lastSyncAt: Date | null;
  leadCountOnBot: number | null;
  conversationCount: number;
}) {
  if (!args.configured) return null;
  if (!args.reachable) return "Картина неполная: WhatsApp не отвечает";
  if (!args.lastSyncAt) return "Ждём первую загрузку диалогов";
  if (args.leadCountOnBot != null && args.leadCountOnBot > 0 && args.conversationCount === 0) {
    return "На WhatsApp есть переписки, которых ещё нет в CRM. Нажмите «Забрать диалоги из бота».";
  }
  if (Date.now() - args.lastSyncAt.getTime() > 15 * 60 * 1000 && args.conversationCount > 0) {
    return "Список диалогов устарел — обновится сам";
  }
  return null;
}

export async function sellerHealthFor(prisma: PrismaClient, auth: AuthContext) {
  const membership = requireTenant(auth);
  const resolved = await resolveSellerBridge(prisma, membership.tenantId);
  const conversationCount = await prisma.conversation.count({
    where: { tenantId: membership.tenantId, sellerLeadId: { not: null } },
  });
  const lastSyncAt = resolved.integration?.lastEventAt || null;
  const schema = (resolved.integration?.schemaJson || {}) as WhatsAppSellerSchema;
  const publicView = {
    instanceId: String(schema.instanceId || "").trim() || null,
    secretSet: resolved.secretSet,
    conversationCount,
    lastSyncAt,
  };
  if (!resolved.configured || !resolved.bridge) {
    return {
      configured: false,
      reachable: false,
      sender: null,
      ...publicView,
      leadCountOnBot: null as number | null,
      storePathKind: null as string | null,
      warning: sellerSyncWarning({
        configured: false,
        reachable: false,
        lastSyncAt,
        leadCountOnBot: null,
        conversationCount,
      }),
      note: sharedAiManagerUrl()
        ? "Укажите Instance ID и API Token из личного кабинета Green API."
        : "WhatsApp ещё не подключён.",
    };
  }
  try {
    const health = await resolved.bridge.health();
    const leadCountOnBot = typeof health.leadCount === "number" ? health.leadCount : null;
    return {
      configured: true,
      reachable: true,
      sender: health.sender,
      ...publicView,
      leadCountOnBot,
      storePathKind: health.storePathKind || null,
      warning: sellerSyncWarning({
        configured: true,
        reachable: true,
        lastSyncAt,
        leadCountOnBot,
        conversationCount,
      }),
      note:
        leadCountOnBot === null
          ? "WhatsApp подключён."
          : `На WhatsApp ${leadCountOnBot} переписок · в CRM ${conversationCount} диалогов.`,
    };
  } catch (error) {
    return {
      configured: true,
      reachable: false,
      sender: null,
      ...publicView,
      leadCountOnBot: null,
      storePathKind: null,
      warning: sellerSyncWarning({
        configured: true,
        reachable: false,
        lastSyncAt,
        leadCountOnBot: null,
        conversationCount,
      }),
      note: describeBridgeError(error, resolved.url),
    };
  }
}

export async function upsertWhatsAppSellerForTenant(
  prisma: PrismaClient,
  tenantId: string,
  input: {
    sellerUrl?: string;
    secret?: string;
    instanceId?: string;
    apiToken?: string;
    name?: string;
    actorUserId?: string | null;
    rotateSecret?: boolean;
  },
) {
  const existing = await getSellerIntegration(prisma, tenantId);
  const previousSchema = (existing?.schemaJson || {}) as WhatsAppSellerSchema;
  const requestedUrl = String(input.sellerUrl || "").trim().replace(/\/$/, "");
  const sellerUrl = resolveAiManagerUrl(requestedUrl || previousSchema.sellerUrl);
  assertAiManagerReachableUrl(sellerUrl);
  const instanceId = String(input.instanceId || previousSchema.instanceId || "").trim();
  const apiToken = String(input.apiToken || "").trim();
  const apiTokenEnc = apiToken ? encryptSecret(apiToken) : previousSchema.apiTokenEnc;
  let secret = String(input.secret || "").trim();
  let issuedSecret: string | null = null;
  if (!secret && (input.rotateSecret || !previousSchema.secretEnc)) {
    secret = randomToken(32);
    issuedSecret = secret;
  }
  const secretEnc = secret ? encryptSecret(secret) : previousSchema.secretEnc;
  if (!secretEnc) {
    throw new ApiError(422, "invalid", "Не удалось создать секрет подключения");
  }
  const integrationSecret = secret || decryptSecret(secretEnc);
  const schemaJson: WhatsAppSellerSchema = {
    sellerUrl,
    secretEnc,
    instanceId: instanceId || previousSchema.instanceId,
    apiTokenEnc,
    sendOwner: "external_bot",
    webhookToken: previousSchema.webhookToken,
    webhookUrl: previousSchema.webhookUrl,
    greenApiHost: previousSchema.greenApiHost,
  };
  let integration = existing;
  if (!integration) {
    integration = await prisma.integration.create({
      data: {
        tenantId,
        type: "whatsapp_seller",
        name: String(input.name || "WhatsApp ИИ-менеджер"),
        status: "error",
        testMode: false,
        lastError: "Проверка подключения ещё не выполнена",
        lastErrorCode: "provider_unreachable",
        connectionStatus: "ERROR",
        healthStatus: "ERROR",
        schemaJson,
        channelConnections: {
          create: {
            channelType: "whatsapp",
            status: "error",
            autoReply: false,
            capabilitiesJson: ["receive_messages", "send_text", "send_media", "delivery_receipts"],
            externalRef: instanceId || null,
          },
        },
      },
      include: { channelConnections: true, forms: true },
    });
  } else {
    integration = await prisma.integration.update({
      where: { id: integration.id },
      data: {
        name: input.name ? String(input.name) : undefined,
        schemaJson,
      },
      include: { channelConnections: true, forms: true },
    });
    if (instanceId) {
      await prisma.channelConnection.updateMany({
        where: { tenantId, integrationId: integration.id },
        data: { externalRef: instanceId },
      });
    }
  }

  let note = "Сохранено. Подключение пока не подтверждено.";
  let reachable = false;
  const savedInstanceId = String(schemaJson.instanceId || "").trim();
  const savedToken = Boolean(apiTokenEnc);
  if (savedInstanceId && savedToken) {
    try {
      const registered = await syncWhatsAppAiManagerRegistration(prisma, tenantId, integration.id);
      note = registered.note;
      if (registered.ok || registered.registered) {
        const healthBridge = new WhatsAppSellerBridge(sellerUrl, integrationSecret, {
          tenantId,
          integrationId: integration.id,
        });
        try {
          const health = await healthBridge.health();
          reachable = true;
          note = registered.webhookUrl
            ? `${registered.note} Sender: ${health.sender}.`
            : `Мост отвечает. Sender: ${health.sender}. ${registered.note}`;
        } catch (error) {
          reachable = false;
          note = `${registered.note} ${describeBridgeError(error, sellerUrl)}`;
        }
      }
    } catch (error) {
      note = describeBridgeError(error, sellerUrl);
    }
  } else {
    try {
      const healthBridge = new WhatsAppSellerBridge(sellerUrl, integrationSecret, {
        tenantId,
        integrationId: integration.id,
      });
      const health = await healthBridge.health();
      reachable = true;
      note = `Мост отвечает. Sender: ${health.sender}.`;
    } catch (error) {
      note = describeBridgeError(error, sellerUrl);
    }
  }

  const status = reachable ? "active" : "error";
  const connectionStatus = reachable ? "CONNECTED" : "ERROR";
  const healthStatus = reachable ? "NO_EVENTS_YET" : "ERROR";
  integration = await prisma.integration.update({
    where: { id: integration.id },
    data: {
      status,
      lastError: reachable ? null : note,
      lastErrorCode: reachable ? null : "provider_unreachable",
      connectionStatus,
      healthStatus,
    },
    include: { channelConnections: true, forms: true },
  });
  await prisma.channelConnection.updateMany({
    where: { tenantId, integrationId: integration.id },
    data: { status: reachable ? "active" : "error" },
  });
  await prisma.auditEvent.create({
    data: {
      tenantId,
      actorUserId: input.actorUserId || null,
      action: issuedSecret || secret ? "integration.whatsapp.secret_replaced" : "integration.whatsapp.connect",
      entityType: "integration",
      entityId: integration.id,
      changesJson: { reachable, secretReplaced: Boolean(issuedSecret || input.secret), instanceId: instanceId || null },
    },
  });
  return {
    ok: true,
    reachable,
    note,
    integrationId: integration.id,
    connectionStatus,
    bridgeSecret: issuedSecret,
    secretIssued: Boolean(issuedSecret),
  };
}

export async function connectWhatsAppSeller(
  prisma: PrismaClient,
  auth: AuthContext,
  input: { sellerUrl?: string; secret?: string; instanceId?: string; apiToken?: string },
) {
  const membership = requireTenant(auth);
  if (!can(auth, "manage_integrations")) {
    throw new ApiError(403, "forbidden", "Нет права управлять интеграциями");
  }
  const existing = await getSellerIntegration(prisma, membership.tenantId);
  if (!existing) {
    const { requireLimitAvailable } = await import("./entitlementService.ts");
    const { LIMITS } = await import("@creolab/contracts");
    const used = await prisma.integration.count({
      where: {
        tenantId: membership.tenantId,
        type: "whatsapp_seller",
        NOT: { OR: [{ status: "disabled" }, { connectionStatus: "DISCONNECTED" }] },
      },
    });
    await requireLimitAvailable(
      prisma,
      membership.tenantId,
      LIMITS.WHATSAPP_CONNECTIONS,
      used,
      "Лимит WhatsApp исчерпан. Подключите дополнительный номер.",
    );
  }
  const instanceId = String(input.instanceId || "").trim();
  const apiToken = String(input.apiToken || "").trim();
  const legacySecret = String(input.secret || "").trim();
  const previous = (existing?.schemaJson || {}) as WhatsAppSellerSchema;
  if (!existing && !instanceId && !legacySecret) {
    throw new ApiError(422, "invalid", "Укажите Instance ID Green API", { instanceId: "Обязательно" });
  }
  if (instanceId && !apiToken && !previous.apiTokenEnc) {
    throw new ApiError(422, "invalid", "Укажите API Token Green API", { apiToken: "Обязательно" });
  }
  return upsertWhatsAppSellerForTenant(prisma, membership.tenantId, {
    instanceId,
    apiToken,
    sellerUrl: input.sellerUrl,
    secret: input.secret,
    actorUserId: auth.user.id,
  });
}

export async function rotateWhatsAppSellerSecret(prisma: PrismaClient, auth: AuthContext) {
  const membership = requireTenant(auth);
  if (!can(auth, "manage_integrations")) throw new ApiError(403, "forbidden", "Нет права");
  const existing = await getSellerIntegration(prisma, membership.tenantId);
  if (!existing) throw new ApiError(404, "not_found", "WhatsApp не подключён");
  return upsertWhatsAppSellerForTenant(prisma, membership.tenantId, {
    rotateSecret: true,
    actorUserId: auth.user.id,
  });
}

export async function disconnectWhatsAppSeller(prisma: PrismaClient, auth: AuthContext) {
  const membership = requireTenant(auth);
  if (!can(auth, "manage_integrations")) throw new ApiError(403, "forbidden", "Нет права");
  const existing = await getSellerIntegration(prisma, membership.tenantId);
  if (!existing) throw new ApiError(404, "not_found", "WhatsApp не подключён");
  await prisma.integration.update({
    where: { id: existing.id },
    data: { status: "disabled", connectionStatus: "DISCONNECTED", healthStatus: "UNKNOWN" },
  });
  await prisma.auditEvent.create({
    data: {
      tenantId: membership.tenantId,
      actorUserId: auth.user.id,
      action: "integration.whatsapp.disconnect",
      entityType: "integration",
      entityId: existing.id,
      changesJson: {},
    },
  });
  return { ok: true, note: "WhatsApp отключён. Диалоги в CRM сохранены." };
}

const runningSyncs = new WeakMap<PrismaClient, Map<string, Promise<unknown>>>();

async function foreignSellerLeadIds(prisma: PrismaClient, tenantId: string) {
  const rows = await prisma.conversation.findMany({
    where: { sellerLeadId: { not: null }, tenantId: { not: tenantId } },
    select: { sellerLeadId: true },
  });
  return new Set(rows.map((row) => row.sellerLeadId).filter((id): id is string => Boolean(id)));
}

async function filterLeadsForTenant<T extends { leadId: string }>(prisma: PrismaClient, tenantId: string, leads: T[]) {
  const taken = await foreignSellerLeadIds(prisma, tenantId);
  return leads.filter((lead) => !taken.has(lead.leadId));
}

function integrationSecretPlain(schema: WhatsAppSellerSchema) {
  if (!schema.secretEnc) return "";
  try {
    return decryptSecret(schema.secretEnc);
  } catch {
    return "";
  }
}

export async function resolveSellerIntegrationForEvent(
  prisma: PrismaClient,
  input: { secret: string; integrationId?: string | null; payload?: unknown },
) {
  const secret = String(input.secret || "").trim();
  if (!secret) throw new ApiError(401, "unauthorized", "Мост не принят");
  const rows = await prisma.integration.findMany({
    where: { type: "whatsapp_seller" },
    include: { tenant: { select: { id: true, defaultRegion: true, status: true } } },
  });
  const secretMatches = rows.filter((row) => {
    const plain = integrationSecretPlain((row.schemaJson || {}) as WhatsAppSellerSchema);
    return Boolean(plain) && safeEqual(secret, plain);
  });
  const platformOk = Boolean(platformBridgeSecret() && safeEqual(secret, platformBridgeSecret()));
  const hintedId = String(input.integrationId || "").trim();
  if (hintedId) {
    const hinted = rows.find((row) => row.id === hintedId);
    if (!hinted) throw new ApiError(401, "unauthorized", "Мост не принят");
    const ownSecret = integrationSecretPlain((hinted.schemaJson || {}) as WhatsAppSellerSchema);
    if (ownSecret && safeEqual(secret, ownSecret)) return hinted;
    throw new ApiError(401, "unauthorized", "Мост не принят");
  }
  if (secretMatches.length === 1) return secretMatches[0];
  if (secretMatches.length > 1) {
    throw new ApiError(401, "unauthorized", "Секрет моста неоднозначен");
  }
  if (!platformOk) throw new ApiError(401, "unauthorized", "Мост не принят");
  const active = rows.filter((row) => row.status !== "disabled");
  const instanceId = extractWhatsAppInstanceId(input.payload);
  if (instanceId) {
    const byInstance = active.filter((row) => {
      const schema = (row.schemaJson || {}) as WhatsAppSellerSchema;
      return String(schema.instanceId || "").trim() === instanceId;
    });
    if (byInstance.length === 1) return byInstance[0];
  }
  const leadId = String((input.payload as { leadId?: unknown } | undefined)?.leadId || "").trim();
  if (leadId) {
    const owned = await prisma.conversation.findMany({
      where: { sellerLeadId: leadId },
      select: { tenantId: true },
    });
    const tenantIds = [...new Set(owned.map((row) => row.tenantId))];
    if (tenantIds.length === 1) {
      const row = active.find((item) => item.tenantId === tenantIds[0]);
      if (row) return row;
    }
  }
  if (active.length === 1) return active[0];
  throw new ApiError(401, "unknown_connection", "Событие не привязано к конкретной интеграции WhatsApp");
}

export async function ingestSellerBridgeEvent(
  prisma: PrismaClient,
  payload: unknown,
  auth?: { secret?: string; integrationId?: string | null },
) {
  const body = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const type = String(body.type || "");
  const integration = auth?.secret
    ? await resolveSellerIntegrationForEvent(prisma, {
        secret: auth.secret,
        integrationId: auth.integrationId,
        payload,
      })
    : null;
  if (!integration) throw new ApiError(401, "unauthorized", "Мост не принят");
  if (integration.status === "disabled" || integration.connectionStatus === "DISCONNECTED") {
    throw new ApiError(403, "disabled", "Интеграция WhatsApp отключена");
  }
  if (integration.tenant.status !== "active") {
    throw new ApiError(403, "tenant_suspended", "Компания приостановлена, событие не обработано");
  }

  if (type === "ai.usage" || body.usage) {
    const usage = (body.usage && typeof body.usage === "object" ? body.usage : body) as Record<string, unknown>;
    const { recordAiUsage } = await import("./aiUsageService.ts");
    await recordAiUsage(prisma, {
      tenantId: integration.tenantId,
      integrationId: integration.id,
      conversationId: String(usage.conversationId || body.conversationId || "") || null,
      provider: String(usage.provider || "openai"),
      model: String(usage.model || "unknown"),
      feature: String(usage.feature || "AI_MANAGER_REPLY"),
      providerRequestId: String(usage.providerRequestId || usage.id || "") || null,
      inputTokens: usage.inputTokens != null ? Number(usage.inputTokens) : null,
      outputTokens: usage.outputTokens != null ? Number(usage.outputTokens) : null,
      cachedInputTokens: usage.cachedInputTokens != null ? Number(usage.cachedInputTokens) : null,
      reasoningTokens: usage.reasoningTokens != null ? Number(usage.reasoningTokens) : null,
      totalTokens: usage.totalTokens != null ? Number(usage.totalTokens) : null,
      latencyMs: usage.latencyMs != null ? Number(usage.latencyMs) : null,
      status: String(usage.status || "ok") === "failed" ? "failed" : "ok",
      errorCode: usage.errorCode ? String(usage.errorCode).slice(0, 80) : null,
    });
    if (type === "ai.usage") return { accepted: true, handled: true, usage: true, tenantId: integration.tenantId };
  }

  const leadId = String(body.leadId || "").trim();
  if (!leadId) {
    throw new ApiError(422, "invalid", "Событие отклонено: нет leadId");
  }
  const allowedTypes = new Set(["", "lead.created", "lead.updated", "message.received", "incomingMessageReceived", "ai.usage"]);
  if (type && !allowedTypes.has(type)) {
    throw new ApiError(422, "ignored_type", `Событие отклонено: тип ${type} не обрабатывается`);
  }
  const foreign = await prisma.conversation.findFirst({
    where: { sellerLeadId: leadId, tenantId: { not: integration.tenantId } },
    select: { id: true },
  });
  if (foreign) {
    throw new ApiError(403, "cross_tenant", "Диалог принадлежит другой компании");
  }

  const resolved = await resolveSellerBridge(prisma, integration.tenantId);
  let lead:
    | {
        leadId: string;
        clientPhone: string | null;
        clientName?: string | null;
        aiMode?: string | null;
        conversationHistory?: Array<{ role: string; content: string; at?: string }>;
      }
    | undefined;
  if (resolved.bridge) {
    try {
      const listed = await resolved.bridge.listLeads();
      lead = listed.leads.find((item) => item.leadId === leadId);
    } catch (error) {
      console.warn("[seller-events] listLeads failed", error instanceof Error ? error.message : error);
    }
  }
  if (!lead) {
    lead = {
      leadId,
      clientPhone: String(body.clientPhone || body.phone || "") || null,
      clientName: String(body.clientName || body.name || "") || null,
      aiMode: body.aiMode ? String(body.aiMode) : null,
      conversationHistory: Array.isArray(body.conversationHistory)
        ? (body.conversationHistory as Array<{ role: string; content: string; at?: string }>)
        : [],
    };
  }
  const extras = [body.message, body.messageData ? body : null].filter(Boolean);
  if (extras.length) {
    lead = {
      ...lead,
      conversationHistory: mergeLeadHistory(lead.conversationHistory || [], extras) as Array<{
        role: string;
        content: string;
        at?: string;
      }>,
    };
  }
  const connection = resolved.integration
    ? await prisma.channelConnection.findFirst({
        where: { tenantId: integration.tenantId, integrationId: resolved.integration.id },
      })
    : null;
  const synced = await applySellerLeadSync(prisma, {
    tenantId: integration.tenantId,
    defaultRegion: integration.tenant.defaultRegion || "KZ",
    lead,
    connectionId: connection?.id || null,
  });
  if (!synced.skipped && synced.conversationId) {
    const { afterConversationActivity } = await import("./aiConversationPolicyService.ts");
    await afterConversationActivity(prisma, integration.tenantId, synced.conversationId).catch((error) => {
      console.warn("[ai-policy] after ingest", error instanceof Error ? error.message : error);
    });
  }
  await prisma.integration.update({
    where: { id: integration.id },
    data: { lastEventAt: new Date(), lastError: null, status: "active" },
  });
  return { accepted: true, handled: true, tenantId: integration.tenantId, integrationId: integration.id, results: [{ tenantId: integration.tenantId, ...synced }] };
}

export async function syncSellerLeads(prisma: PrismaClient, auth: AuthContext) {
  const tid = requireTenant(auth).tenantId;
  let jobs = runningSyncs.get(prisma);
  if (!jobs) { jobs = new Map(); runningSyncs.set(prisma, jobs); }
  const running = jobs.get(tid);
  if (running) return running;
  const job = syncSellerLeadsOnce(prisma, auth);
  jobs.set(tid, job);
  try { return await job; } finally { jobs.delete(tid); }
}

async function syncSellerLeadsOnce(prisma: PrismaClient, auth: AuthContext) {
  const membership = requireTenant(auth);
  const resolved = await resolveSellerBridge(prisma, membership.tenantId);
  if (!resolved.bridge) {
    throw new ApiError(422, "not_configured", "Сначала подключите WhatsApp ИИ-менеджер");
  }
  const listed = await resolved.bridge.listLeads();
  const leads = await filterLeadsForTenant(prisma, membership.tenantId, listed.leads);
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
      await analyzeAndApplyConversation(prisma, auth, conversationId, { useLlm: true, automatic: true });
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
        ? "Новых диалогов в WhatsApp пока нет. История чатов из Green API этой кнопкой не выгружается."
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
    sellerError = `На WhatsApp не применилось: ${error instanceof Error ? error.message : "сейчас недоступен"}`;
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
  requireIntegrationAdmin(auth);
  const membership = requireTenant(auth);
  const [form, seller, telegram] = await Promise.all([
    prisma.formDefinition.findFirst({
      where: { tenantId: membership.tenantId, active: true },
      include: { integration: true },
    }),
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
                ? "Подключено"
                : "Ошибка",
          testMode: Boolean(form.integration.testMode),
          integrationId: form.integrationId,
        }
      : { connected: false },
    telegram: {
      employee: {
        connected: Boolean(telegram),
        botConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_USERNAME),
        note: process.env.TELEGRAM_BOT_TOKEN
          ? "Нажмите «Подключить Telegram», затем откройте бота и отправьте /start."
          : "Уведомления в Telegram пока недоступны.",
      },
    },
  };
}

export async function rotateWebhookSecret(prisma: PrismaClient, auth: AuthContext, integrationId: string) {
  const membership = requireTenant(auth);
  if (!can(auth, "manage_integrations")) {
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
      ? "Откройте бота и нажмите Start."
      : "Уведомления в Telegram пока недоступны.",
  };
}

export async function controlBoard(prisma: PrismaClient, auth: AuthContext) {
  requireNotManager(auth, "Управление доступно администратору и директору");
  const [situation, seller] = await Promise.all([getSituation(prisma, auth, { scope: "all" }), sellerHealthFor(prisma, auth)]);
  return {
    seller,
    items: situation.items.filter(isConversationCommand),
    freshness: situation.freshness,
    metrics: situation.metrics,
  };
}

export { crmModeToSeller };
