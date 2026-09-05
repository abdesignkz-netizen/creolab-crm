import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@creolab/db";
import { integrationEventSchema, validateClientPhone } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { hmacSha256Hex, safeEqual, sha256 } from "../lib/hash.ts";
import type { AuthContext } from "../lib/types.ts";
import { writeActivity } from "./contactService.ts";

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

async function createInquiryTx(
  tx: Prisma.TransactionClient,
  args: {
    tenantId: string;
    integrationId?: string | null;
    source: string;
    inboundEventId?: string | null;
    name?: string;
    phoneRaw: string;
    phoneNormalized: string;
    phoneSource: string;
    subject?: string | null;
    description?: string | null;
    raw?: unknown;
    assigneeMembershipId?: string | null;
    test?: boolean;
  },
) {
  const contactId = await findOrCreateContactWithPhone(
    tx,
    args.tenantId,
    args.name,
    args.phoneRaw,
    args.phoneNormalized,
    args.phoneSource,
  );
  const inquiry = await tx.inquiry.create({
    data: {
      tenantId: args.tenantId,
      integrationId: args.integrationId || null,
      source: args.source,
      sourceType: args.source,
      sourceChannel: args.source === "whatsapp" ? "whatsapp" : args.source === "form" ? "website" : args.source,
      inboundEventId: args.inboundEventId || null,
      contactId,
      phoneRaw: args.phoneRaw,
      phoneNormalized: args.phoneNormalized,
      phoneSource: args.phoneSource,
      subject: args.subject || null,
      description: args.description || null,
      service: args.subject || null,
      rawFieldsJson: (args.raw || {}) as Prisma.InputJsonValue,
      assigneeMembershipId: args.assigneeMembershipId || null,
      test: Boolean(args.test),
      nextStep: "Принять заявку",
    },
  });
  await tx.contact.update({
    where: { id: contactId },
    data: {
      lastSeenAt: new Date(),
      lastContactAt: new Date(),
      ownerMembershipId: args.assigneeMembershipId || undefined,
      lifecycleStatus: "new",
      attributionJson: {
        sourceType: args.source,
        source: args.source,
      },
    },
  });
  await tx.task.create({
    data: {
      tenantId: args.tenantId,
      type: "process_inquiry",
      title: `Обработать заявку: ${inquiry.subject || args.name || "без темы"}`,
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
    title: "Получена новая заявка",
    description: inquiry.subject || inquiry.description || null,
    actorType: "system",
    metadata: { source: args.source },
  });
  await notify(
    tx,
    args.tenantId,
    args.assigneeMembershipId || null,
    "inquiry.created",
    "inquiry",
    inquiry.id,
    "Новая заявка",
    inquiry.subject || "Поступила заявка с обязательным телефоном",
  );
  await writeOutbox(tx, args.tenantId, "inquiry.created", "inquiry", inquiry.id, {
    inquiryId: inquiry.id,
    contactId,
  });
  return inquiry;
}

export async function createManualInquiry(
  prisma: PrismaClient,
  auth: AuthContext,
  input: { name: string; phone: string; subject?: string; message?: string; service?: string },
) {
  const membership = requireTenant(auth);
  const phone = validateClientPhone(input.phone, membership.tenant.defaultRegion);
  if (!phone.ok) {
    throw new ApiError(422, phone.code, phone.message, { phone: phone.message });
  }
  const assignee = await defaultAssignee(prisma, membership.tenantId);
  return prisma.$transaction((tx) =>
    createInquiryTx(tx, {
      tenantId: membership.tenantId,
      source: "manual",
      name: input.name,
      phoneRaw: phone.raw,
      phoneNormalized: phone.normalized,
      phoneSource: "manual",
      subject: input.subject || input.service,
      description: input.message,
      raw: input,
      assigneeMembershipId: assignee,
    }),
  );
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
  if (body.website) {
    return { receipt: "ok", duplicate: false };
  }
  const phone = validateClientPhone(body.phone, "KZ");
  if (!phone.ok) {
    throw new ApiError(422, phone.code, phone.message, { phone: phone.message });
  }
  const name = String(body.name || "").trim();
  if (!name) {
    throw new ApiError(422, "invalid", "Укажите имя", { name: "Укажите имя" });
  }
  const eventKey = meta.submissionId || `form:${hashPayload({ publicKey, name, phone: phone.normalized, message: body.message })}`;
  const payloadHash = hashPayload({ name, phone: phone.normalized, message: body.message, service: body.service });

  return prisma.$transaction(async (tx) => {
    const existing = await tx.inboundEvent.findUnique({
      where: { integrationId_externalEventKey: { integrationId: form.integrationId, externalEventKey: eventKey } },
    });
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new ApiError(409, "conflict", "Тот же ключ с другим содержимым");
      }
      return { receipt: existing.id, duplicate: true };
    }
    const inbound = await tx.inboundEvent.create({
      data: {
        tenantId: form.tenantId,
        integrationId: form.integrationId,
        externalEventKey: eventKey,
        payloadHash,
        rawJson: body as Prisma.InputJsonValue,
        test: form.integration.testMode,
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
      subject: String(body.service || body.subject || "Заявка с сайта"),
      description: String(body.message || ""),
      raw: body,
      assigneeMembershipId: assignee,
      test: form.integration.testMode,
    });
    await tx.inboundEvent.update({
      where: { id: inbound.id },
      data: { processedAt: new Date() },
    });
    return { receipt: inbound.id, inquiryId: inquiry.id, duplicate: false };
  });
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
  const bearerOk = Boolean(
    bearer && integration.secretHash && safeEqual(sha256(bearer), integration.secretHash),
  );
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

  return prisma.$transaction(async (tx) => {
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
      return { disposition: "duplicate", event_id: existing.id };
    }
    const inbound = await tx.inboundEvent.create({
      data: {
        tenantId: integration.tenantId,
        integrationId,
        externalEventKey: parsed.event_id,
        payloadHash,
        rawJson: parsed as Prisma.InputJsonValue,
        test: integration.testMode,
      },
    });

    if (!phone.ok) {
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

    const inquiry = await createInquiryTx(tx, {
      tenantId: integration.tenantId,
      integrationId,
      source: "webhook",
      inboundEventId: inbound.id,
      name: parsed.contact.name,
      phoneRaw: phone.raw,
      phoneNormalized: phone.normalized,
      phoneSource: "webhook",
      subject: parsed.inquiry.subject,
      description: parsed.inquiry.message,
      raw: parsed,
      assigneeMembershipId: assignee,
      test: integration.testMode,
    });
    return { disposition: "inquiry", inquiry_id: inquiry.id, event_id: inbound.id };
  });
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
      return tx.deal.findFirstOrThrow({ where: { id: inquiry.dealId, tenantId: membership.tenantId } });
    }
    const hasPhone = inquiry.contact.methods.some((item) => item.type === "phone" && item.normalizedValue);
    if (!inquiry.phoneNormalized || !hasPhone) {
      throw new ApiError(422, "needs_phone", "Нельзя создать сделку без телефона клиента");
    }
    const stage = await tx.dealStage.findFirst({
      where: { tenantId: membership.tenantId, systemKey: "new" },
    });
    if (!stage) throw new ApiError(500, "misconfigured", "Воронка не настроена");
    const deal = await tx.deal.create({
      data: {
        tenantId: membership.tenantId,
        contactId: inquiry.contactId,
        inquiryId: inquiry.id,
        stageId: stage.id,
        title: title || inquiry.subject || "Сделка",
        description: inquiry.description,
        assigneeMembershipId: inquiry.assigneeMembershipId,
        nextAction: "Связаться с клиентом",
      },
    });
    await tx.inquiry.update({
      where: { id: inquiry.id },
      data: { status: "converted", dealId: deal.id },
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
    return deal;
  });
}

export async function listInquiries(prisma: PrismaClient, auth: AuthContext, query: Record<string, string | undefined>) {
  const membership = requireTenant(auth);
  const take = Math.min(100, Number(query.limit || 30));
  return prisma.inquiry.findMany({
    where: {
      tenantId: membership.tenantId,
      archived: false,
      status: query.status || undefined,
      source: query.source || undefined,
    },
    include: { contact: { include: { methods: true } } },
    orderBy: { receivedAt: "desc" },
    take,
  });
}

export async function listIncomplete(prisma: PrismaClient, auth: AuthContext) {
  const membership = requireTenant(auth);
  return prisma.incompleteIntake.findMany({
    where: { tenantId: membership.tenantId, status: "pending" },
    orderBy: { receivedAt: "desc" },
    take: 50,
  });
}

export { sha256 };
