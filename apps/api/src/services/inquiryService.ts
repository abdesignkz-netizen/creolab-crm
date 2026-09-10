import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@creolab/db";
import { integrationEventSchema, validateClientPhone } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { hmacSha256Hex, safeEqual, sha256 } from "../lib/hash.ts";
import type { AuthContext } from "../lib/types.ts";
import { writeActivity } from "./contactService.ts";
import { inferClientInterest } from "./contactInterestService.ts";
import { periodLabel, resolvePeriodRange, type PeriodPreset } from "./periodRange.ts";
import { pagination } from "./pagination.ts";
import { inquiryNeedsActionWhere, openIntakeWhere } from "./inquiryAttention.ts";
import { markRelatedStaffNotifications } from "./notificationService.ts";

const ACTIVE_WHATSAPP_INQUIRY = ["new", "accepted", "in_progress", "waiting_client", "waiting_manager", "qualification"];

function hashPayload(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) {
    throw new ApiError(403, "no_tenant", "Нет активной компании");
  }
  return auth.activeMembership;
}

async function defaultAssignee(prisma: PrismaClient, tenantId: string, preferred?: string | null) {
  if (preferred) {
    const found = await prisma.membership.findFirst({
      where: { tenantId, id: preferred, active: true },
    });
    if (found) return found.id;
  }
  const owner = await prisma.membership.findFirst({
    where: { tenantId, role: "owner", active: true },
  });
  return owner?.id || null;
}

async function writeOutbox(
  tx: Prisma.TransactionClient,
  tenantId: string,
  type: string,
  entityType: string,
  entityId: string,
  payload: unknown,
) {
  await tx.outboxEvent.create({
    data: { tenantId, type, entityType, entityId, payloadJson: payload as Prisma.InputJsonValue },
  });
}

async function notify(
  tx: Prisma.TransactionClient,
  tenantId: string,
  membershipId: string | null,
  type: string,
  entityType: string,
  entityId: string,
  title: string,
  body: string,
  priority = "normal",
) {
  if (!membershipId) return;
  await tx.notification.upsert({
    where: {
      tenantId_episodeKey_recipientMembershipId: {
        tenantId,
        episodeKey: `${type}:${entityId}`,
        recipientMembershipId: membershipId,
      },
    },
    update: { title, body },
    create: {
      tenantId,
      episodeKey: `${type}:${entityId}`,
      recipientMembershipId: membershipId,
      type,
      priority,
      entityType,
      entityId,
      title,
      body,
    },
  });
}

export async function findOrCreateContactWithPhone(
  tx: Prisma.TransactionClient,
  tenantId: string,
  name: string | undefined,
  phoneRaw: string,
  phoneNormalized: string,
  source: string,
) {
  const existingMethod = await tx.contactMethod.findFirst({
    where: { tenantId, type: "phone", normalizedValue: phoneNormalized },
    orderBy: { createdAt: "asc" },
  });
  if (existingMethod) {
    await tx.contact.update({
      where: { id: existingMethod.contactId },
      data: {
        lastSeenAt: new Date(),
        lastContactAt: new Date(),
        name: name || undefined,
      },
    });
    return existingMethod.contactId;
  }
  const contact = await tx.contact.create({
    data: {
      tenantId,
      name: name || null,
      language: "unknown",
      lifecycleStatus: "new",
      lastContactAt: new Date(),
      methods: {
        create: {
          type: "phone",
          rawValue: phoneRaw,
          normalizedValue: phoneNormalized,
          source,
          primary: true,
        },
      },
    },
  });
  await writeActivity(tx, {
    tenantId,
    contactId: contact.id,
    type: "contact.created",
    title: "Создан клиент",
    description: `Источник: ${source}`,
    actorType: "integration",
    metadata: { source },
  });
  return contact.id;
}

async function findOrCreateContactOptionalPhone(
  tx: Prisma.TransactionClient,
  tenantId: string,
  args: {
    name?: string;
    phoneRaw?: string;
    phoneNormalized?: string;
    source: string;
    contactId?: string;
    companyName?: string;
    forceNewContact?: boolean;
  },
) {
  if (args.contactId && !args.forceNewContact) {
    const existing = await tx.contact.findFirst({
      where: { id: args.contactId, tenantId },
    });
    if (!existing) throw new ApiError(404, "not_found", "Клиент не найден");
    await tx.contact.update({
      where: { id: existing.id },
      data: {
        lastSeenAt: new Date(),
        name: args.name || undefined,
        companyName: args.companyName || undefined,
      },
    });
    return existing.id;
  }
  if (args.phoneNormalized && !args.forceNewContact) {
    return findOrCreateContactWithPhone(
      tx,
      tenantId,
      args.name,
      args.phoneRaw || args.phoneNormalized,
      args.phoneNormalized,
      args.source,
    );
  }
  const contact = await tx.contact.create({
    data: {
      tenantId,
      name: args.name || null,
      companyName: args.companyName || null,
      language: "unknown",
      lifecycleStatus: "new",
      lastContactAt: new Date(),
    },
  });
  await writeActivity(tx, {
    tenantId,
    contactId: contact.id,
    type: "contact.created",
    title: "Создан клиент",
    description: `Источник: ${args.source}`,
    actorType: "system",
    metadata: { source: args.source },
  });
  return contact.id;
}

async function recordStatusChange(
  tx: Prisma.TransactionClient,
  args: {
    tenantId: string;
    inquiryId: string;
    fromStatus?: string | null;
    toStatus: string;
    changedByType?: string;
    changedById?: string | null;
    note?: string | null;
  },
) {
  if (args.fromStatus === args.toStatus) return;
  await tx.inquiryStatusHistory.create({
    data: {
      tenantId: args.tenantId,
      inquiryId: args.inquiryId,
      fromStatus: args.fromStatus || null,
      toStatus: args.toStatus,
      changedByType: args.changedByType || "system",
      changedById: args.changedById || null,
      note: args.note || null,
    },
  });
}

async function createInquiryTx(
  tx: Prisma.TransactionClient,
  args: {
    tenantId: string;
    integrationId?: string | null;
    source: string;
    inboundEventId?: string | null;
    name?: string;
    phoneRaw?: string;
    phoneNormalized?: string;
    phoneSource?: string;
    subject?: string | null;
    description?: string | null;
    raw?: unknown;
    assigneeMembershipId?: string | null;
    test?: boolean;
    contactId?: string;
    forceNewContact?: boolean;
    companyName?: string | null;
    service?: string | null;
    serviceCategory?: string | null;
    sourceChannel?: string | null;
    sourceType?: string | null;
    city?: string | null;
    desiredDeadline?: string | null;
    landingPage?: string | null;
    referrer?: string | null;
    utmSource?: string | null;
    utmMedium?: string | null;
    utmCampaign?: string | null;
    utmContent?: string | null;
    utmTerm?: string | null;
    fieldMeta?: Record<string, unknown> | null;
    conversationId?: string | null;
    needsReply?: boolean;
  },
) {
  const phoneRaw = args.phoneRaw || "";
  const phoneNormalized = args.phoneNormalized || "";
  const contactId = await findOrCreateContactOptionalPhone(tx, args.tenantId, {
    name: args.name,
    phoneRaw,
    phoneNormalized,
    source: args.phoneSource || args.source,
    contactId: args.contactId,
    companyName: args.companyName || undefined,
    forceNewContact: args.forceNewContact,
  });
  const sourceChannel =
    args.sourceChannel ||
    (args.source === "whatsapp"
      ? "whatsapp"
      : args.source === "form"
        ? "website_form"
        : args.source === "manual"
          ? "manual"
          : args.source);
  const inquiry = await tx.inquiry.create({
    data: {
      tenantId: args.tenantId,
      integrationId: args.integrationId || null,
      source: args.source,
      sourceType: args.sourceType || args.source,
      sourceChannel,
      inboundEventId: args.inboundEventId || null,
      contactId,
      phoneRaw,
      phoneNormalized,
      phoneSource: args.phoneSource || args.source,
      subject: args.subject || null,
      description: args.description || null,
      service: args.service || args.subject || null,
      serviceCategory: args.serviceCategory || null,
      companyName: args.companyName || null,
      city: args.city || null,
      desiredDeadline: args.desiredDeadline || null,
      landingPage: args.landingPage || null,
      referrer: args.referrer || null,
      utmSource: args.utmSource || null,
      utmMedium: args.utmMedium || null,
      utmCampaign: args.utmCampaign || null,
      utmContent: args.utmContent || null,
      utmTerm: args.utmTerm || null,
      rawFieldsJson: (args.raw || {}) as Prisma.InputJsonValue,
      fieldMetaJson: (args.fieldMeta || {}) as Prisma.InputJsonValue,
      assigneeMembershipId: args.assigneeMembershipId || null,
      test: Boolean(args.test),
      conversationId: args.conversationId || null,
      nextStep: "Связаться с клиентом",
      needsReply: args.needsReply !== false,
      firstContactAt: new Date(),
    },
  });
  await recordStatusChange(tx, {
    tenantId: args.tenantId,
    inquiryId: inquiry.id,
    fromStatus: null,
    toStatus: "new",
    changedByType: "system",
    note: "Создана заявка",
  });
  const currentContact = await tx.contact.findUniqueOrThrow({ where: { id: contactId } });
  const now = new Date();
  await tx.contact.update({
    where: { id: contactId },
    data: {
      lastSeenAt: currentContact.lastSeenAt || now,
      lastContactAt: currentContact.lastContactAt || now,
      ownerMembershipId: args.assigneeMembershipId || undefined,
      lifecycleStatus: currentContact.lifecycleStatus === "customer" ? currentContact.lifecycleStatus : "new",
      companyName: args.companyName || undefined,
      attributionJson: {
        ...((currentContact.attributionJson && typeof currentContact.attributionJson === "object"
          ? currentContact.attributionJson
          : {}) as Record<string, unknown>),
        sourceType: args.sourceType || args.source,
        source: args.source,
        sourceChannel,
        utmSource: args.utmSource || null,
        landingPage: args.landingPage || null,
      },
    },
  });
  await tx.task.create({
    data: {
      tenantId: args.tenantId,
      type: "process_inquiry",
      title: `Связаться с клиентом: ${inquiry.subject || args.name || "заявка"}`,
      inquiryId: inquiry.id,
      contactId,
      ownerMembershipId: args.assigneeMembershipId || null,
      source: "rule",
      dedupeKey: `inquiry-process:${inquiry.id}`,
    },
  });
  await writeActivity(tx, {
    tenantId: args.tenantId,
    contactId,
    inquiryId: inquiry.id,
    type: "inquiry.created",
    title: args.test ? "Получена тестовая заявка" : "Получена новая заявка",
    description: inquiry.subject || inquiry.description || null,
    actorType: "system",
    metadata: { source: args.source, test: Boolean(args.test) },
  });
  await notify(
    tx,
    args.tenantId,
    args.assigneeMembershipId || null,
    "inquiry.created",
    "inquiry",
    inquiry.id,
    args.test ? "Тестовая заявка" : "Новая заявка",
    inquiry.subject || "Поступила новая заявка",
  );
  await writeOutbox(tx, args.tenantId, "inquiry.created", "inquiry", inquiry.id, {
    inquiryId: inquiry.id,
    contactId,
  });
  return inquiry;
}

export async function ensureWhatsAppInquiry(
  prisma: PrismaClient,
  args: {
    tenantId: string;
    contactId: string;
    conversationId: string;
    leadId?: string | null;
    name?: string | null;
    phoneRaw?: string | null;
    phoneNormalized?: string | null;
  },
) {
  const existing = await prisma.inquiry.findFirst({
    where: {
      tenantId: args.tenantId,
      archived: false,
      OR: [
        { conversationId: args.conversationId },
        { contactId: args.contactId, source: "whatsapp", status: { in: ACTIVE_WHATSAPP_INQUIRY } },
      ],
    },
    orderBy: { receivedAt: "desc" },
  });
  if (existing) {
    if (!existing.conversationId || existing.conversationId !== args.conversationId) {
      await prisma.inquiry.update({
        where: { id: existing.id },
        data: { conversationId: args.conversationId },
      });
    }
    return { inquiry: existing, created: false as const };
  }

  const messages = await prisma.message.findMany({
    where: { tenantId: args.tenantId, conversationId: args.conversationId, internal: false },
    orderBy: { createdAt: "asc" },
    take: 40,
    select: { id: true, text: true, direction: true, senderKind: true, internal: true, createdAt: true },
  });
  const inbound = messages.filter((item) => item.direction === "inbound" && item.senderKind === "client");
  const last = messages.at(-1);
  const needsReply = last ? last.direction === "inbound" && last.senderKind === "client" : inbound.length > 0;
  const interest = inferClientInterest(messages);
  const assignee = await defaultAssignee(prisma, args.tenantId);
  const integration = await prisma.integration.findFirst({
    where: { tenantId: args.tenantId, type: "whatsapp_seller" },
    select: { id: true },
  });
  const inquiry = await prisma.$transaction((tx) =>
    createInquiryTx(tx, {
      tenantId: args.tenantId,
      integrationId: integration?.id,
      source: "whatsapp",
      sourceChannel: "whatsapp",
      sourceType: "whatsapp",
      name: args.name || undefined,
      phoneRaw: args.phoneRaw || "",
      phoneNormalized: args.phoneNormalized || "",
      phoneSource: "whatsapp",
      contactId: args.contactId,
      conversationId: args.conversationId,
      subject: interest?.text || "Заявка из WhatsApp",
      description: inbound.map((item) => item.text).filter(Boolean).slice(-6).join("\n\n") || null,
      raw: { sellerLeadId: args.leadId || null },
      fieldMeta: { sellerLeadId: args.leadId || null, fromWhatsAppAi: true },
      assigneeMembershipId: assignee,
      needsReply,
    }),
  );
  return { inquiry, created: true as const };
}

export async function createManualInquiry(
  prisma: PrismaClient,
  auth: AuthContext,
  input: {
    name: string;
    phone?: string;
    company?: string;
    subject?: string;
    message?: string;
    service?: string;
    serviceCategory?: string;
    sourceChannel?: string;
    sourceType?: string;
    contactId?: string;
    forceNewContact?: boolean;
  },
) {
  const membership = requireTenant(auth);
  let phoneRaw = "";
  let phoneNormalized = "";
  if (input.phone && input.phone.trim()) {
    const phone = validateClientPhone(input.phone, membership.tenant.defaultRegion);
    if (!phone.ok) {
      throw new ApiError(422, phone.code, phone.message, { phone: phone.message });
    }
    phoneRaw = phone.raw;
    phoneNormalized = phone.normalized;
  }
  const assignee = membership.id;
  const inquiry = await prisma.$transaction((tx) =>
    createInquiryTx(tx, {
      tenantId: membership.tenantId,
      source: "manual",
      name: input.name,
      phoneRaw,
      phoneNormalized,
      phoneSource: phoneNormalized ? "manual" : "none",
      subject: input.subject || input.service,
      description: input.message,
      service: input.service || input.subject,
      serviceCategory: input.serviceCategory,
      companyName: input.company,
      sourceChannel: input.sourceChannel || "manual",
      sourceType: input.sourceType || "manual",
      contactId: input.contactId,
      forceNewContact: input.forceNewContact,
      raw: input,
      assigneeMembershipId: assignee,
    }),
  );
  const { enqueueInquiryAutomation } = await import("./inquiryAutomationQueue.ts");
  await enqueueInquiryAutomation(prisma, membership.tenantId, inquiry.id);
  return inquiry;
}

export async function lookupContactByPhone(prisma: PrismaClient, auth: AuthContext, phoneInput: string) {
  const membership = requireTenant(auth);
  const phone = validateClientPhone(phoneInput, membership.tenant.defaultRegion);
  if (!phone.ok) {
    throw new ApiError(422, phone.code, phone.message, { phone: phone.message });
  }
  const method = await prisma.contactMethod.findFirst({
    where: { tenantId: membership.tenantId, type: "phone", normalizedValue: phone.normalized },
    include: {
      contact: {
        include: {
          _count: { select: { inquiries: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  if (!method) return { found: false as const, phone: phone.raw };
  const lastInquiry = await prisma.inquiry.findFirst({
    where: { tenantId: membership.tenantId, contactId: method.contactId },
    orderBy: { receivedAt: "desc" },
  });
  return {
    found: true as const,
    phone: phone.raw,
    contact: {
      id: method.contact.id,
      name: method.contact.name || [method.contact.firstName, method.contact.lastName].filter(Boolean).join(" ") || "Без имени",
      companyName: method.contact.companyName,
      inquiryCount: method.contact._count.inquiries,
      lastContactAt: method.contact.lastContactAt,
      lastInquiryAt: lastInquiry?.receivedAt || null,
      lastInquirySubject: lastInquiry?.subject || null,
    },
  };
}

export async function submitPublicForm(
  prisma: PrismaClient,
  publicKey: string,
  body: Record<string, unknown>,
  meta: { origin?: string; submissionId?: string },
) {
  const form = await prisma.formDefinition.findUnique({
    where: { publicKey },
    include: { integration: true },
  });
  if (!form || !form.active || form.integration.status !== "active") {
    throw new ApiError(404, "not_found", "Форма недоступна");
  }
  // honeypot — silent success, no lead
  if (body.website) {
    return { receipt: "ok", duplicate: false };
  }

  const { normalizeLeadFromFormPayload } = await import("./leadNormalizationService.ts");
  const { touchIntegrationSuccess } = await import("./integrationCatalogService.ts");
  const lead = normalizeLeadFromFormPayload({
    body,
    mappingJson: form.integration.mappingJson,
    integrationId: form.integrationId,
    entryChannel: "website_form",
    isTest: form.integration.testMode,
  });

  const phone = validateClientPhone(lead.phone, "KZ");
  if (!phone.ok) {
    throw new ApiError(422, phone.code, phone.message, { phone: phone.message });
  }
  const name = String(lead.name || "").trim();
  if (!name) {
    throw new ApiError(422, "invalid", "Укажите имя", { name: "Укажите имя" });
  }

  const eventKey =
    meta.submissionId ||
    lead.externalLeadId ||
    `form:${hashPayload({ publicKey, name, phone: phone.normalized, message: lead.message })}`;
  const payloadHash = hashPayload({
    name,
    phone: phone.normalized,
    message: lead.message,
    service: lead.service,
    mappingVersion: lead.mappingVersion,
  });

  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.inboundEvent.findUnique({
      where: { integrationId_externalEventKey: { integrationId: form.integrationId, externalEventKey: eventKey } },
    });
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new ApiError(409, "conflict", "Тот же ключ с другим содержимым");
      }
      return { receipt: existing.id, inquiryId: null as string | null, duplicate: true };
    }
    const inbound = await tx.inboundEvent.create({
      data: {
        tenantId: form.tenantId,
        integrationId: form.integrationId,
        externalEventKey: eventKey,
        payloadHash,
        rawJson: body as Prisma.InputJsonValue,
        normalizedJson: lead as unknown as Prisma.InputJsonValue,
        provider: "website_form",
        eventType: "LEAD_SUBMISSION",
        status: "PROCESSING",
        test: Boolean(lead.isTest || form.integration.testMode),
        occurredAt: new Date(),
      },
    });
    const assignee = await defaultAssignee(tx as unknown as PrismaClient, form.tenantId);
    const inquiry = await createInquiryTx(tx, {
      tenantId: form.tenantId,
      integrationId: form.integrationId,
      source: "form",
      inboundEventId: inbound.id,
      name,
      phoneRaw: phone.raw,
      phoneNormalized: phone.normalized,
      phoneSource: "form",
      subject: lead.service || lead.pageTitle || "Заявка с сайта",
      description: lead.message || "",
      companyName: lead.company || null,
      city: lead.city || null,
      desiredDeadline: lead.deadline || null,
      landingPage: lead.landingPage || lead.pageUrl || null,
      referrer: lead.referrer || null,
      utmSource: lead.utm?.source || null,
      utmMedium: lead.utm?.medium || null,
      utmCampaign: lead.utm?.campaign || null,
      utmContent: lead.utm?.content || null,
      utmTerm: lead.utm?.term || null,
      raw: body,
      fieldMeta: {
        mappingVersion: lead.mappingVersion,
        customFields: lead.customFields || {},
        normalizedLead: true,
      },
      assigneeMembershipId: assignee,
      test: Boolean(lead.isTest || form.integration.testMode),
      sourceChannel: "website_form",
      sourceType: lead.acquisitionSource || "website_form",
    });
    await tx.inboundEvent.update({
      where: { id: inbound.id },
      data: { processedAt: new Date(), status: "PROCESSED" },
    });
    await touchIntegrationSuccess(tx, form.integrationId);
    return { receipt: inbound.id, inquiryId: inquiry.id, duplicate: false };
  });

  if (result.inquiryId && !result.duplicate) {
    const { enqueueInquiryAutomation } = await import("./inquiryAutomationQueue.ts");
    void enqueueInquiryAutomation(prisma, form.tenantId, result.inquiryId);
  }
  return result;
}

export async function ingestIntegrationEvent(
  prisma: PrismaClient,
  integrationId: string,
  rawBody: Buffer,
  headers: { signature?: string; timestamp?: string; authorization?: string },
) {
  const integration = await prisma.integration.findUnique({ where: { id: integrationId } });
  if (!integration || integration.type !== "webhook" || integration.status !== "active") {
    throw new ApiError(404, "not_found", "Интеграция не найдена");
  }
  const timestamp = Number(headers.timestamp || 0);
  if (!timestamp || Math.abs(Date.now() / 1000 - timestamp) > 300) {
    throw new ApiError(401, "invalid_signature", "Подпись или время отклонены");
  }
  const bearer = String(headers.authorization || "").replace(/^Bearer\s+/i, "");
  const bearerHash = bearer ? sha256(bearer) : "";
  const primaryOk = Boolean(bearer && integration.secretHash && safeEqual(bearerHash, integration.secretHash));
  const previousOk = Boolean(
    bearer &&
      integration.previousSecretHash &&
      integration.previousSecretExpiresAt &&
      integration.previousSecretExpiresAt.getTime() > Date.now() &&
      safeEqual(bearerHash, integration.previousSecretHash),
  );
  const bearerOk = primaryOk || previousOk;
  if (headers.signature) {
    if (!bearerOk) {
      throw new ApiError(401, "invalid_signature", "Подпись или время отклонены");
    }
    const expected = hmacSha256Hex(bearer, `${timestamp}.${rawBody.toString("utf8")}`);
    if (!safeEqual(expected, headers.signature.replace(/^sha256=/, ""))) {
      throw new ApiError(401, "invalid_signature", "Подпись или время отклонены");
    }
  } else if (!bearerOk) {
    throw new ApiError(401, "invalid_signature", "Подпись или время отклонены");
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new ApiError(422, "invalid_body", "Некорректное тело");
  }
  const parsed = integrationEventSchema.parse(json);
  const payloadHash = hashPayload(parsed);
  const phoneMethod = parsed.contact.methods.find((item) => item.type === "phone");
  const phone = validateClientPhone(phoneMethod?.value, "KZ");
  const assignee = await defaultAssignee(prisma, integration.tenantId);

  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.inboundEvent.findUnique({
      where: {
        integrationId_externalEventKey: {
          integrationId,
          externalEventKey: parsed.event_id,
        },
      },
    });
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new ApiError(409, "conflict", "Тот же event_id с другим содержимым");
      }
      return { disposition: "duplicate" as const, event_id: existing.id };
    }
    const inbound = await tx.inboundEvent.create({
      data: {
        tenantId: integration.tenantId,
        integrationId,
        externalEventKey: parsed.event_id,
        payloadHash,
        rawJson: parsed as Prisma.InputJsonValue,
        provider: "webhook_api",
        eventType: "LEAD_SUBMISSION",
        status: "PROCESSING",
        test: integration.testMode,
        occurredAt: parsed.occurred_at ? new Date(parsed.occurred_at) : new Date(),
      },
    });

    if (!phone.ok) {
      await tx.inboundEvent.update({
        where: { id: inbound.id },
        data: { status: "PROCESSED", processedAt: new Date() },
      });
      const intake = await tx.incompleteIntake.create({
        data: {
          tenantId: integration.tenantId,
          inboundEventId: inbound.id,
          integrationId,
          reason: phone.code,
          rawFieldsJson: parsed as Prisma.InputJsonValue,
          assigneeMembershipId: assignee,
        },
      });
      await tx.task.create({
        data: {
          tenantId: integration.tenantId,
          type: "process_inquiry",
          title: "Уточнить телефон входящего обращения",
          source: "rule",
          ownerMembershipId: assignee,
          dedupeKey: `intake-phone:${intake.id}`,
          incompleteIntakeId: intake.id,
        },
      });
      await notify(
        tx,
        integration.tenantId,
        assignee,
        "needs_phone",
        "incomplete_intake",
        intake.id,
        "Требует уточнения телефона",
        parsed.inquiry.message || "Обращение сохранено без корректного номера",
      );
      await writeOutbox(tx, integration.tenantId, "intake.needs_phone", "incomplete_intake", intake.id, {
        intakeId: intake.id,
      });
      return {
        disposition: "needs_phone",
        incomplete_intake_id: intake.id,
        event_id: inbound.id,
      };
    }

    const { normalizeLeadFromWebhookPayload } = await import("./leadNormalizationService.ts");
    const { touchIntegrationSuccess } = await import("./integrationCatalogService.ts");
    const lead = normalizeLeadFromWebhookPayload({
      parsed,
      mappingJson: integration.mappingJson,
      integrationId,
      isTest: integration.testMode,
    });

    const inquiry = await createInquiryTx(tx, {
      tenantId: integration.tenantId,
      integrationId,
      source: "webhook",
      inboundEventId: inbound.id,
      name: lead.name || parsed.contact.name,
      phoneRaw: phone.raw,
      phoneNormalized: phone.normalized,
      phoneSource: "webhook",
      subject: lead.service || parsed.inquiry.subject,
      description: lead.message || parsed.inquiry.message,
      companyName: lead.company,
      landingPage: lead.landingPage,
      referrer: lead.referrer,
      utmSource: lead.utm?.source || null,
      utmMedium: lead.utm?.medium || null,
      utmCampaign: lead.utm?.campaign || null,
      utmContent: lead.utm?.content || null,
      utmTerm: lead.utm?.term || null,
      raw: parsed,
      fieldMeta: { mappingVersion: lead.mappingVersion, normalizedLead: true },
      assigneeMembershipId: assignee,
      test: integration.testMode,
      sourceChannel: "webhook",
      sourceType: lead.acquisitionSource || "webhook",
    });
    await tx.inboundEvent.update({
      where: { id: inbound.id },
      data: {
        processedAt: new Date(),
        status: "PROCESSED",
        normalizedJson: lead as unknown as Prisma.InputJsonValue,
      },
    });
    await touchIntegrationSuccess(tx, integrationId);
    return { disposition: "inquiry", inquiry_id: inquiry.id, event_id: inbound.id, tenantId: integration.tenantId };
  });

  if (result.disposition === "inquiry" && "inquiry_id" in result && result.inquiry_id) {
    const { enqueueInquiryAutomation } = await import("./inquiryAutomationQueue.ts");
    void enqueueInquiryAutomation(prisma, result.tenantId, result.inquiry_id);
  }
  return result;
}

export async function completeIntake(
  prisma: PrismaClient,
  auth: AuthContext,
  intakeId: string,
  input: { phone: string; name?: string },
) {
  const membership = requireTenant(auth);
  const phone = validateClientPhone(input.phone, membership.tenant.defaultRegion);
  if (!phone.ok) {
    throw new ApiError(422, phone.code, phone.message, { phone: phone.message });
  }
  return prisma.$transaction(async (tx) => {
    const intake = await tx.incompleteIntake.findFirst({
      where: { id: intakeId, tenantId: membership.tenantId },
    });
    if (!intake) {
      throw new ApiError(404, "not_found", "Обращение не найдено");
    }
    if (intake.status === "completed" && intake.inquiryId) {
      return tx.inquiry.findFirstOrThrow({ where: { id: intake.inquiryId, tenantId: membership.tenantId } });
    }
    const raw = (intake.rawFieldsJson || {}) as { contact?: { name?: string }; inquiry?: { subject?: string; message?: string } };
    const inquiry = await createInquiryTx(tx, {
      tenantId: membership.tenantId,
      integrationId: intake.integrationId,
      source: "webhook",
      inboundEventId: intake.inboundEventId,
      name: input.name || raw.contact?.name,
      phoneRaw: phone.raw,
      phoneNormalized: phone.normalized,
      phoneSource: "intake_complete",
      subject: raw.inquiry?.subject,
      description: raw.inquiry?.message,
      raw: intake.rawFieldsJson,
      assigneeMembershipId: intake.assigneeMembershipId,
    });
    await tx.incompleteIntake.update({
      where: { id: intake.id },
      data: { status: "completed", inquiryId: inquiry.id, completedAt: new Date() },
    });
    await tx.task.updateMany({
      where: { tenantId: membership.tenantId, dedupeKey: `intake-phone:${intake.id}`, status: "open" },
      data: { status: "done", completedAt: new Date() },
    });
    return inquiry;
  }).then(async (inquiry) => {
    const { enqueueInquiryAutomation } = await import("./inquiryAutomationQueue.ts");
    await enqueueInquiryAutomation(prisma, membership.tenantId, inquiry.id);
    return inquiry;
  });
}

export async function convertInquiryToDeal(prisma: PrismaClient, auth: AuthContext, inquiryId: string, title?: string) {
  const membership = requireTenant(auth);
  return prisma.$transaction(async (tx) => {
    const inquiry = await tx.inquiry.findFirst({
      where: { id: inquiryId, tenantId: membership.tenantId },
      include: { contact: { include: { methods: true } } },
    });
    if (!inquiry) throw new ApiError(404, "not_found", "Заявка не найдена");
    if (inquiry.dealId) {
      return tx.deal.findFirstOrThrow({
        where: { id: inquiry.dealId, tenantId: membership.tenantId },
        include: { stage: true },
      });
    }
    const hasPhone =
      Boolean(inquiry.phoneNormalized) ||
      inquiry.contact.methods.some((item) => item.type === "phone" && item.normalizedValue);
    if (!hasPhone) {
      throw new ApiError(422, "needs_phone", "Нельзя создать сделку без телефона клиента");
    }
    const stage = await tx.dealStage.findFirst({
      where: { tenantId: membership.tenantId, systemKey: "new" },
    });
    if (!stage) throw new ApiError(500, "misconfigured", "Воронка не настроена");
    const now = new Date();
    const deal = await tx.deal.create({
      data: {
        tenantId: membership.tenantId,
        contactId: inquiry.contactId,
        inquiryId: inquiry.id,
        stageId: stage.id,
        title: title || inquiry.subject || "Сделка",
        description: inquiry.description,
        assigneeMembershipId: inquiry.assigneeMembershipId || membership.id,
        nextAction: "Связаться с клиентом",
        probability: stage.defaultProbability ?? 10,
        paymentStatus: "NOT_INVOICED",
        stageEnteredAt: now,
      },
    });
    await tx.dealStageHistory.create({
      data: {
        tenantId: membership.tenantId,
        dealId: deal.id,
        fromStageId: null,
        fromSystemKey: null,
        toStageId: stage.id,
        toSystemKey: stage.systemKey,
        enteredAt: now,
        changedByType: "user",
        changedById: auth.user.id,
        note: "Создана из заявки",
      },
    });
    const fromStatus = inquiry.status;
    await tx.inquiry.update({
      where: { id: inquiry.id },
      data: {
        status: "converted",
        dealId: deal.id,
        convertedAt: now,
        nextStep: "Вести сделку",
        needsReply: false,
      },
    });
    await recordStatusChange(tx, {
      tenantId: membership.tenantId,
      inquiryId: inquiry.id,
      fromStatus,
      toStatus: "converted",
      changedByType: "user",
      changedById: auth.user.id,
      note: `Создана сделка «${deal.title}»`,
    });
    await writeActivity(tx, {
      tenantId: membership.tenantId,
      contactId: inquiry.contactId,
      inquiryId: inquiry.id,
      dealId: deal.id,
      type: "deal.created",
      title: "Создана сделка",
      description: deal.title,
      actorType: "user",
      actorId: auth.user.id,
      metadata: { dealId: deal.id, fromInquiryId: inquiry.id },
    });
    await writeActivity(tx, {
      tenantId: membership.tenantId,
      contactId: inquiry.contactId,
      inquiryId: inquiry.id,
      dealId: deal.id,
      type: "inquiry.converted",
      title: "Заявка конвертирована в сделку",
      description: deal.title,
      actorType: "user",
      actorId: auth.user.id,
      metadata: { dealId: deal.id },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: membership.tenantId,
        actorUserId: auth.user.id,
        action: "inquiry.convert",
        entityType: "deal",
        entityId: deal.id,
        changesJson: { inquiryId },
      },
    });
    return tx.deal.findFirstOrThrow({
      where: { id: deal.id, tenantId: membership.tenantId },
      include: { stage: true },
    });
  });
}

const inquiryListInclude = {
  contact: {
    include: {
      methods: true,
      _count: { select: { inquiries: true } },
    },
  },
  assignee: { include: { user: true } },
  deal: { include: { stage: true } },
  tasks: {
    where: { status: { in: ["open", "planned"] } },
    orderBy: { dueAt: "asc" as const },
    take: 3,
  },
  conversation: {
    include: {
      connection: true,
      _count: { select: { messages: true } },
    },
  },
} satisfies Prisma.InquiryInclude;

const CHANNEL_ALIASES: Record<string, string[]> = {
  manual: ["manual"],
  website_form: ["website_form", "website", "form"],
  website_ai: ["website_ai"],
  whatsapp: ["whatsapp"],
  telegram: ["telegram"],
  instagram: ["instagram"],
  phone: ["phone", "phone_call"],
  api: ["api", "webhook"],
  other: ["other"],
};

function buildInquiryWhere(
  tenantId: string,
  query: Record<string, string | undefined>,
  timeZone = "Asia/Almaty",
): Prisma.InquiryWhereInput {
  const where: Prisma.InquiryWhereInput = {
    tenantId,
    archived: false,
  };
  const filter = query.filter || "all";
  const q = (query.q || "").trim();
  const andParts: Prisma.InquiryWhereInput[] = [];

  if (query.assignee) where.assigneeMembershipId = query.assignee === "unassigned" ? null : query.assignee;
  if (query.test === "false") where.test = false;
  if (query.status) where.status = query.status;
  if (query.source) where.source = query.source;

  switch (filter) {
    case "new":
      where.status = "new";
      break;
    case "needs_reply":
      where.needsReply = true;
      where.status = { in: ["new", "qualification", "qualified", "in_progress", "waiting_client", "waiting_manager", "proposal", "accepted"] };
      break;
    case "attention": {
      const attention = inquiryNeedsActionWhere(tenantId);
      where.status = attention.status;
      andParts.push({ OR: attention.OR });
      break;
    }
    case "in_progress":
      where.status = { in: ["in_progress", "accepted", "qualification", "qualified"] };
      break;
    case "waiting_client":
      where.status = "waiting_client";
      break;
    case "unassigned":
      where.assigneeMembershipId = null;
      where.status = { notIn: ["converted", "lost", "cancelled", "closed", "invalid", "spam", "duplicate"] };
      break;
    case "no_phone":
      where.phoneNormalized = "";
      break;
    case "qualified":
      where.status = { in: ["qualified", "proposal"] };
      break;
    case "in_deal":
    case "converted":
      where.status = "converted";
      break;
    case "lost":
      where.status = { in: ["lost", "invalid", "spam"] };
      break;
    case "today": {
      const today = resolvePeriodRange(timeZone, "today");
      where.receivedAt = { gte: today.from!, lt: today.to! };
      break;
    }
    case "ai_processing":
      where.tasks = { some: { type: "process_inquiry", status: "open", source: "ai_automation", executionStatus: { in: ["in_progress", "queued"] } } };
      break;
    case "ai_needs_human":
      where.tasks = { some: { type: "process_inquiry", status: "open", executionStatus: { in: ["needs_human", "failed"] } } };
      break;
    case "ai_failed":
      where.attentionReason = "AI_ANALYSIS_FAILED";
      where.status = { notIn: ["lost", "converted", "cancelled"] };
      break;
    case "needs_clarification":
      andParts.push({
        OR: [
          { phoneNormalized: "" },
          { AND: [{ subject: null }, { service: null }, { serviceCategory: null }] },
        ],
      });
      where.status = { notIn: ["converted", "lost", "cancelled", "closed", "invalid", "spam", "duplicate"] };
      break;
    default:
      break;
  }

  const periodRaw = String(query.period || "all");
  const period = (
    [
      "today",
      "yesterday",
      "last_7",
      "last_30",
      "this_month",
      "last_month",
      "this_year",
      "all",
      "custom",
    ] as PeriodPreset[]
  ).includes(periodRaw as PeriodPreset)
    ? (periodRaw as PeriodPreset)
    : "all";

  if (period !== "all" && filter !== "attention") {
    const range = resolvePeriodRange(timeZone, period, query.dateFrom, query.dateTo);
    const receivedAt: { gte?: Date; lt?: Date } = {};
    if (range.from) receivedAt.gte = range.from;
    if (range.to) receivedAt.lt = range.to;
    if (receivedAt.gte || receivedAt.lt) {
      // Period selector wins over the legacy «Сегодня» attention filter date bound.
      where.receivedAt = receivedAt;
    }
  }

  if (query.sourceChannel) {
    const channels = CHANNEL_ALIASES[query.sourceChannel] || [query.sourceChannel];
    andParts.push({
      OR: [{ sourceChannel: { in: channels } }, { source: { in: channels } }],
    });
  }

  if (query.serviceCategory) {
    andParts.push({
      OR: [
        { serviceCategory: query.serviceCategory },
        { service: { contains: query.serviceCategory, mode: "insensitive" } },
      ],
    });
  }

  if (q) {
    andParts.push({
      OR: [
        { subject: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
        { service: { contains: q, mode: "insensitive" } },
        { serviceCategory: { contains: q, mode: "insensitive" } },
        { companyName: { contains: q, mode: "insensitive" } },
        { phoneRaw: { contains: q, mode: "insensitive" } },
        ...(q.replace(/\D+/g, "") ? [{ phoneNormalized: { contains: q.replace(/\D+/g, "") } }] : []),
        { id: { equals: q } },
        { contact: { name: { contains: q, mode: "insensitive" } } },
        { contact: { companyName: { contains: q, mode: "insensitive" } } },
      ],
    });
  }

  if (andParts.length) where.AND = andParts;
  return where;
}

export async function listInquiries(prisma: PrismaClient, auth: AuthContext, query: Record<string, string | undefined>) {
  const membership = requireTenant(auth);
  const timeZone = membership.tenant.timezone || "Asia/Almaty";
  const { take, skip } = pagination(query);
  query = { ...query, ...(query.scope === "mine" ? { assignee: membership.id } : query.scope === "unassigned" ? { assignee: "unassigned" } : {}) };
  const where = buildInquiryWhere(membership.tenantId, query, timeZone);
  const sort = query.sort || "attention";

  const periodRaw = String(query.period || "all");
  const period = (
    [
      "today",
      "yesterday",
      "last_7",
      "last_30",
      "this_month",
      "last_month",
      "this_year",
      "all",
      "custom",
    ] as PeriodPreset[]
  ).includes(periodRaw as PeriodPreset)
    ? (periodRaw as PeriodPreset)
    : "all";
  const range =
    period === "all"
      ? { from: null as Date | null, to: null as Date | null }
      : resolvePeriodRange(timeZone, period, query.dateFrom, query.dateTo);

  let orderBy: Prisma.InquiryOrderByWithRelationInput[] = [{ needsReply: "desc" }, { receivedAt: "desc" }];
  if (sort === "newest") orderBy = [{ receivedAt: "desc" }];
  if (sort === "oldest") orderBy = [{ receivedAt: "asc" }];
  if (sort === "needs_reply") orderBy = [{ needsReply: "desc" }, { receivedAt: "desc" }];
  if (sort === "activity") orderBy = [{ receivedAt: "desc" }];
  orderBy.push({ id: "asc" });

  // Normalize legacy accepted → treated as in_progress in DTO only; migrate lazily on list
  await prisma.inquiry.updateMany({
    where: { tenantId: membership.tenantId, status: "accepted" },
    data: { status: "in_progress" },
  });
  await prisma.inquiry.updateMany({
    where: { tenantId: membership.tenantId, status: "closed" },
    data: { status: "cancelled" },
  });

  // Facet counts keep the search, owner, period and other selected constraints.
  const periodBase = { ...query, filter: "all", status: undefined };

  const [items, countsRaw, channelRaw, categoryRaw, intakes, total] = await Promise.all([
    prisma.inquiry.findMany({
      where,
      include: inquiryListInclude,
      orderBy,
      take,
      skip,
    }),
    prisma.inquiry.groupBy({
      by: ["status"],
      where: buildInquiryWhere(membership.tenantId, { ...periodBase, filter: "all" }, timeZone),
      _count: { _all: true },
    }),
    prisma.inquiry.groupBy({
      by: ["sourceChannel"],
      where: buildInquiryWhere(membership.tenantId, { ...periodBase, sourceChannel: undefined, source: undefined }, timeZone),
      _count: { _all: true },
    }),
    prisma.inquiry.groupBy({
      by: ["serviceCategory"],
      where: buildInquiryWhere(membership.tenantId, { ...periodBase, serviceCategory: undefined }, timeZone),
      _count: { _all: true },
    }),
    prisma.incompleteIntake.findMany({
      where: {
        ...openIntakeWhere(membership.tenantId),
        ...(query.filter !== "attention" && (range.from || range.to)
          ? {
              receivedAt: {
                ...(range.from ? { gte: range.from } : {}),
                ...(range.to ? { lt: range.to } : {}),
              },
            }
          : {}),
      },
      orderBy: { receivedAt: "desc" },
      take: 50,
    }),
    prisma.inquiry.count({ where }),
  ]);

  const statusCounts = Object.fromEntries(countsRaw.map((row) => [row.status, row._count._all]));
  const allCount = countsRaw.reduce((sum, row) => sum + row._count._all, 0);

  const sourceCounts: Record<string, number> = {};
  for (const row of channelRaw) {
    const raw = row.sourceChannel || "other";
    const key =
      Object.entries(CHANNEL_ALIASES).find(([, aliases]) => aliases.includes(raw))?.[0] ||
      (raw === "website" || raw === "form" ? "website_form" : raw === "webhook" ? "api" : raw);
    sourceCounts[key] = (sourceCounts[key] || 0) + row._count._all;
  }

  const categoryCounts: Record<string, number> = {};
  for (const row of categoryRaw) {
    const key = row.serviceCategory || "other";
    categoryCounts[key] = (categoryCounts[key] || 0) + row._count._all;
  }

  const [
    needsReplyCount,
    unassignedCount,
    noPhoneCount,
    todayCount,
    clarificationCount,
    attentionInquiryCount,
    attentionIntakeCount,
  ] = await Promise.all([
    prisma.inquiry.count({
      where: buildInquiryWhere(membership.tenantId, { ...periodBase, filter: "needs_reply" }, timeZone),
    }),
    prisma.inquiry.count({
      where: buildInquiryWhere(membership.tenantId, { ...periodBase, filter: "unassigned" }, timeZone),
    }),
    prisma.inquiry.count({
      where: buildInquiryWhere(membership.tenantId, { ...periodBase, filter: "no_phone" }, timeZone),
    }),
    prisma.inquiry.count({
      where: buildInquiryWhere(membership.tenantId, { ...periodBase, filter: "today" }, timeZone),
    }),
    prisma.inquiry.count({
      where: buildInquiryWhere(membership.tenantId, { ...periodBase, filter: "needs_clarification" }, timeZone),
    }),
    prisma.inquiry.count({ where: inquiryNeedsActionWhere(membership.tenantId) }),
    prisma.incompleteIntake.count({ where: openIntakeWhere(membership.tenantId) }),
  ]);

  const { mapInquiryListItem, intakeReasonLabel, relativeDayLabel } = await import("./inquiryPresentation.ts");

  return {
    items: items.map((item) => mapInquiryListItem(item, membership.tenant.timezone)),
    total,
    offset: skip,
    limit: take,
    hasMore: skip + items.length < total,
    period: {
      preset: period,
      label: periodLabel(period, range.from, range.to, timeZone),
      from: range.from?.toISOString() || null,
      to: range.to?.toISOString() || null,
    },
    counts: {
      all: allCount,
      new: (statusCounts.new || 0),
      needs_reply: needsReplyCount,
      in_progress: (statusCounts.in_progress || 0) + (statusCounts.accepted || 0) + (statusCounts.qualification || 0) + (statusCounts.qualified || 0),
      waiting_client: statusCounts.waiting_client || 0,
      unassigned: unassignedCount,
      no_phone: noPhoneCount,
      qualified: (statusCounts.qualified || 0) + (statusCounts.proposal || 0),
      converted: statusCounts.converted || 0,
      lost: (statusCounts.lost || 0) + (statusCounts.invalid || 0) + (statusCounts.spam || 0),
      today: todayCount,
      needs_clarification: clarificationCount,
      attention: attentionInquiryCount + attentionIntakeCount,
      attention_inquiries: attentionInquiryCount,
      attention_intakes: attentionIntakeCount,
    },
    sourceCounts,
    categoryCounts,
    clarification: [
      ...intakes.map((item) => ({
        kind: "intake" as const,
        id: item.id,
        title: intakeReasonLabel(item.reason),
        detail:
          item.reason === "missing_phone" || item.reason === "invalid_phone"
            ? "Клиент оставил обращение, но контактный номер не указан или некорректен."
            : "Нужна ручная проверка входящего обращения.",
        receivedAt: item.receivedAt,
        receivedLabel: relativeDayLabel(item.receivedAt, membership.tenant.timezone),
        reason: item.reason,
        canCompletePhone: true,
      })),
      ...items
        .map((item) => mapInquiryListItem(item, membership.tenant.timezone))
        .filter((item) => item.needsClarification)
        .map((item) => ({
          kind: "inquiry" as const,
          id: item.id,
          title: item.issues[0]?.label || "Требует уточнения",
          detail: item.issues[0]?.detail || "",
          receivedAt: item.receivedAt,
          receivedLabel: item.receivedLabel,
          reason: item.issues[0]?.code || "other",
          canCompletePhone: !item.hasPhone,
          inquiryId: item.id,
        })),
    ],
  };
}

export async function getInquiry(prisma: PrismaClient, auth: AuthContext, inquiryId: string) {
  const membership = requireTenant(auth);
  const inquiry = await prisma.inquiry.findFirst({
    where: { id: inquiryId, tenantId: membership.tenantId },
    include: {
      ...inquiryListInclude,
      statusHistory: { orderBy: { changedAt: "desc" }, take: 40 },
      tasks: { orderBy: { createdAt: "desc" }, take: 20 },
    },
  });
  if (!inquiry) throw new ApiError(404, "not_found", "Заявка не найдена");
  await markRelatedStaffNotifications(prisma, {
    tenantId: membership.tenantId,
    membershipId: membership.id,
    conversationIds: inquiry.conversationId ? [inquiry.conversationId] : [],
    inquiryIds: [inquiry.id],
  });
  const activities = await prisma.activity.findMany({
    where: { tenantId: membership.tenantId, inquiryId: inquiry.id },
    orderBy: { createdAt: "desc" },
    take: 40,
  });
  const { mapInquiryDetail } = await import("./inquiryPresentation.ts");
  return mapInquiryDetail({ ...inquiry, activities }, membership.tenant.timezone);
}

export async function takeInquiry(prisma: PrismaClient, auth: AuthContext, inquiryId: string) {
  const membership = requireTenant(auth);
  return prisma.$transaction(async (tx) => {
    const inquiry = await tx.inquiry.findFirst({
      where: { id: inquiryId, tenantId: membership.tenantId },
    });
    if (!inquiry) throw new ApiError(404, "not_found", "Заявка не найдена");
    const fromStatus = inquiry.status;
    const updated = await tx.inquiry.update({
      where: { id: inquiry.id },
      data: {
        status: "in_progress",
        assigneeMembershipId: membership.id,
        nextStep: inquiry.nextStep || "Связаться с клиентом",
      },
    });
    await recordStatusChange(tx, {
      tenantId: membership.tenantId,
      inquiryId: inquiry.id,
      fromStatus,
      toStatus: "in_progress",
      changedByType: "user",
      changedById: auth.user.id,
      note: "Взята в работу",
    });
    await writeActivity(tx, {
      tenantId: membership.tenantId,
      contactId: inquiry.contactId,
      inquiryId: inquiry.id,
      type: "inquiry.taken",
      title: "Заявка взята в работу",
      description: auth.user.name,
      actorType: "user",
      actorId: auth.user.id,
    });
    return updated;
  }).then(() => getInquiry(prisma, auth, inquiryId));
}

export async function updateInquiry(
  prisma: PrismaClient,
  auth: AuthContext,
  inquiryId: string,
  input: Record<string, unknown>,
) {
  const membership = requireTenant(auth);
  await prisma.$transaction(async (tx) => {
    const inquiry = await tx.inquiry.findFirst({
      where: { id: inquiryId, tenantId: membership.tenantId },
    });
    if (!inquiry) throw new ApiError(404, "not_found", "Заявка не найдена");

    const data: Prisma.InquiryUncheckedUpdateInput = {};
    if ("subject" in input) data.subject = input.subject as string | null;
    if ("description" in input) data.description = input.description as string | null;
    if ("service" in input) data.service = input.service as string | null;
    if ("serviceCategory" in input) data.serviceCategory = input.serviceCategory as string | null;
    if ("serviceSubcategory" in input) data.serviceSubcategory = input.serviceSubcategory as string | null;
    if ("companyName" in input) data.companyName = input.companyName as string | null;
    if ("city" in input) data.city = input.city as string | null;
    if ("desiredDeadline" in input) data.desiredDeadline = input.desiredDeadline as string | null;
    if ("budgetMin" in input) data.budgetMin = input.budgetMin as number | null;
    if ("budgetMax" in input) data.budgetMax = input.budgetMax as number | null;
    if ("nextStep" in input) data.nextStep = input.nextStep as string | null;
    if ("needsReply" in input) data.needsReply = Boolean(input.needsReply);
    if ("aiSummary" in input) data.aiSummary = input.aiSummary as string | null;
    if ("assigneeMembershipId" in input) {
      data.assigneeMembershipId = (input.assigneeMembershipId as string | null) || null;
    }
    if (typeof input.phone === "string" && input.phone.trim()) {
      const phone = validateClientPhone(input.phone, membership.tenant.defaultRegion);
      if (!phone.ok) throw new ApiError(422, phone.code, phone.message, { phone: phone.message });
      data.phoneRaw = phone.raw;
      data.phoneNormalized = phone.normalized;
      data.phoneSource = "manual";
      data.phoneConfirmed = true;
      const existingMethod = await tx.contactMethod.findFirst({
        where: { tenantId: membership.tenantId, contactId: inquiry.contactId, type: "phone" },
      });
      if (existingMethod) {
        await tx.contactMethod.update({
          where: { id: existingMethod.id },
          data: { rawValue: phone.raw, normalizedValue: phone.normalized, source: "manual", confirmed: true },
        });
      } else {
        await tx.contactMethod.create({
          data: {
            tenantId: membership.tenantId,
            contactId: inquiry.contactId,
            type: "phone",
            rawValue: phone.raw,
            normalizedValue: phone.normalized,
            source: "manual",
            primary: true,
            confirmed: true,
          },
        });
      }
    }
    if (typeof input.status === "string" && input.status !== inquiry.status) {
      data.status = input.status;
      if (input.status === "qualified") data.qualifiedAt = new Date();
      if (input.status === "converted") data.convertedAt = new Date();
      if (input.status === "lost") data.lostAt = new Date();
      if (input.status === "cancelled" || input.status === "invalid" || input.status === "spam") {
        data.closedAt = new Date();
      }
      await recordStatusChange(tx, {
        tenantId: membership.tenantId,
        inquiryId: inquiry.id,
        fromStatus: inquiry.status,
        toStatus: input.status,
        changedByType: "user",
        changedById: auth.user.id,
      });
    }
    await tx.inquiry.update({ where: { id: inquiry.id }, data });
    await writeActivity(tx, {
      tenantId: membership.tenantId,
      contactId: inquiry.contactId,
      inquiryId: inquiry.id,
      type: "inquiry.updated",
      title: "Заявка обновлена",
      actorType: "user",
      actorId: auth.user.id,
      metadata: input,
    });
  });
  return getInquiry(prisma, auth, inquiryId);
}

export async function loseInquiry(
  prisma: PrismaClient,
  auth: AuthContext,
  inquiryId: string,
  input: { reason: string; comment?: string; classification?: string },
) {
  const membership = requireTenant(auth);
  const classification = input.classification || "lost";
  const toStatus = classification === "lost" ? "lost" : classification;
  await prisma.$transaction(async (tx) => {
    const inquiry = await tx.inquiry.findFirst({
      where: { id: inquiryId, tenantId: membership.tenantId },
    });
    if (!inquiry) throw new ApiError(404, "not_found", "Заявка не найдена");
    await tx.inquiry.update({
      where: { id: inquiry.id },
      data: {
        status: toStatus,
        lostReason: input.reason,
        lostComment: input.comment || null,
        classification: toStatus,
        lostAt: toStatus === "lost" ? new Date() : inquiry.lostAt,
        closedAt: new Date(),
        needsReply: false,
        nextStep: null,
      },
    });
    await recordStatusChange(tx, {
      tenantId: membership.tenantId,
      inquiryId: inquiry.id,
      fromStatus: inquiry.status,
      toStatus,
      changedByType: "user",
      changedById: auth.user.id,
      note: input.reason,
    });
    await writeActivity(tx, {
      tenantId: membership.tenantId,
      contactId: inquiry.contactId,
      inquiryId: inquiry.id,
      type: "inquiry.lost",
      title: toStatus === "lost" ? "Заявка потеряна" : `Заявка закрыта: ${toStatus}`,
      description: input.comment || input.reason,
      actorType: "user",
      actorId: auth.user.id,
    });
  });
  return getInquiry(prisma, auth, inquiryId);
}

export async function listIncomplete(prisma: PrismaClient, auth: AuthContext) {
  const membership = requireTenant(auth);
  const { intakeReasonLabel, relativeDayLabel } = await import("./inquiryPresentation.ts");
  const items = await prisma.incompleteIntake.findMany({
    where: { tenantId: membership.tenantId, status: "pending" },
    orderBy: { receivedAt: "desc" },
    take: 50,
  });
  return items.map((item) => ({
    ...item,
    reasonLabel: intakeReasonLabel(item.reason),
    receivedLabel: relativeDayLabel(item.receivedAt, membership.tenant.timezone),
    detail:
      item.reason === "missing_phone" || item.reason === "invalid_phone"
        ? "Клиент оставил обращение, но контактный номер не указан или некорректен."
        : "Нужна ручная проверка входящего обращения.",
  }));
}

export { sha256 };
