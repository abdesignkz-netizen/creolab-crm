import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { requirePlatformAdmin, requireTenant } from "../lib/access.ts";
import { resolveUploadPath } from "../lib/storage.ts";
import { createStaffNotification } from "./notificationService.ts";
import { supportModuleFromRoute, SUPPORT_CATEGORY_TITLES } from "./supportKnowledgeService.ts";

const TICKET_STATUSES = ["OPEN", "IN_PROGRESS", "WAITING_FOR_CUSTOMER", "RESOLVED", "CLOSED"] as const;
const PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
const MAX_MESSAGE = 8000;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "text/plain",
]);
const EXT_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".txt": "text/plain",
};

const SECRET_KEY = /password|passwd|secret|token|cookie|authorization|bearer|jwt|pin|p12|private.?key|apiToken|instanceid|green.?api|encryption|env|ncalayer/i;

export function sanitizeSupportContext(raw: unknown) {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  const route = String(input.route || input.sourceRoute || "").slice(0, 240);
  if (route.startsWith("/")) out.route = route.split("#")[0];
  if (typeof input.appVersion === "string") out.appVersion = input.appVersion.slice(0, 40);
  if (typeof input.errorId === "string") out.errorId = input.errorId.slice(0, 80);
  if (typeof input.locale === "string") out.locale = input.locale.slice(0, 12);
  if (typeof input.timezone === "string") out.timezone = input.timezone.slice(0, 60);
  if (typeof input.userAgent === "string") {
    out.userAgent = input.userAgent.replace(SECRET_KEY, "[redacted]").slice(0, 180);
  }
  return out;
}

function safeFileName(fileName: string) {
  return String(fileName || "")
    .replace(/[^\w.\-а-яА-ЯёЁ ]+/g, "_")
    .slice(0, 180) || "file.bin";
}

function resolveMime(fileName: string, mimeType: string) {
  const raw = String(mimeType || "").trim().toLowerCase() || "application/octet-stream";
  if (ALLOWED_MIME.has(raw)) return raw;
  const ext = path.extname(fileName || "").toLowerCase();
  return EXT_MIME[ext] || "";
}

function statusLabel(status: string, asAdmin = false) {
  const map: Record<string, string> = {
    OPEN: "Новое",
    IN_PROGRESS: "В работе",
    WAITING_FOR_CUSTOMER: asAdmin ? "Ожидают клиента" : "Ожидаем вас",
    RESOLVED: "Решено",
    CLOSED: "Закрыто",
  };
  return map[status] || status;
}

function moduleLabel(module: string | null | undefined) {
  if (!module) return "";
  return SUPPORT_CATEGORY_TITLES[module] || module;
}

async function attachmentsFor(prisma: PrismaClient, tenantId: string, messageIds: string[]) {
  if (!messageIds.length) return new Map<string, Array<Record<string, unknown>>>();
  const rows = await prisma.attachment.findMany({
    where: { tenantId, parentType: "support_message", parentId: { in: messageIds } },
    orderBy: { createdAt: "asc" },
  });
  const map = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const item = {
      id: row.id,
      fileName: row.originalFileName || row.fileName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      kind: row.mimeType.startsWith("image/") ? "image" : "file",
    };
    const list = map.get(row.parentId) || [];
    list.push(item);
    map.set(row.parentId, list);
  }
  return map;
}

async function ticketUsers(prisma: PrismaClient, tickets: Array<{ createdByUserId: string; assignedToUserId: string | null }>) {
  const ids = [...new Set(tickets.flatMap((item) => [item.createdByUserId, item.assignedToUserId].filter(Boolean)))] as string[];
  if (!ids.length) return new Map<string, { id: string; name: string; email: string }>();
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } });
  return new Map(users.map((user) => [user.id, user]));
}

function serializeTicket(
  ticket: {
    id: string;
    number: number;
    tenantId: string;
    createdByUserId: string;
    assignedToUserId: string | null;
    subject: string | null;
    status: string;
    priority: string;
    sourceRoute: string | null;
    sourceModule: string | null;
    lastMessageAt: Date;
    customerUnread: number;
    adminUnread: number;
    createdAt: Date;
    updatedAt: Date;
    resolvedAt: Date | null;
  },
  users: Map<string, { id: string; name: string; email: string }>,
  tenantName?: string,
  asAdmin = false,
) {
  const creator = users.get(ticket.createdByUserId);
  const assignee = ticket.assignedToUserId ? users.get(ticket.assignedToUserId) : null;
  return {
    id: ticket.id,
    number: ticket.number,
    subject: ticket.subject || "Обращение",
    status: ticket.status,
    statusLabel: statusLabel(ticket.status, asAdmin),
    priority: ticket.priority,
    sourceRoute: ticket.sourceRoute,
    sourceModule: ticket.sourceModule,
    sourceLabel: moduleLabel(ticket.sourceModule),
    lastMessageAt: ticket.lastMessageAt,
    customerUnread: ticket.customerUnread,
    adminUnread: ticket.adminUnread,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    resolvedAt: ticket.resolvedAt,
    tenantId: ticket.tenantId,
    tenantName: tenantName || null,
    createdBy: creator ? { id: creator.id, name: creator.name, email: creator.email } : null,
    assignedTo: assignee ? { id: assignee.id, name: assignee.name } : null,
    closed: ticket.status === "CLOSED" || ticket.status === "RESOLVED",
  };
}

async function loadTicketOrThrow(
  prisma: PrismaClient,
  auth: AuthContext,
  ticketId: string,
  asAdmin: boolean,
) {
  if (asAdmin) {
    requirePlatformAdmin(auth);
    const ticket = await prisma.supportTicket.findFirst({ where: { id: ticketId } });
    if (!ticket) throw new ApiError(404, "not_found", "Обращение не найдено");
    return ticket;
  }
  const membership = requireTenant(auth);
  const ticket = await prisma.supportTicket.findFirst({
    where: { id: ticketId, tenantId: membership.tenantId },
  });
  if (!ticket) throw new ApiError(404, "not_found", "Обращение не найдено");
  return ticket;
}

export async function tenantSupportUnread(prisma: PrismaClient, auth: AuthContext) {
  const membership = requireTenant(auth);
  const unread = await prisma.supportTicket.aggregate({
    where: { tenantId: membership.tenantId, createdByUserId: auth.user.id, customerUnread: { gt: 0 } },
    _sum: { customerUnread: true },
  });
  return { unread: unread._sum.customerUnread || 0 };
}

export async function adminSupportUnread(prisma: PrismaClient, auth: AuthContext) {
  requirePlatformAdmin(auth);
  const [open, unread, signupPending, billingPending] = await Promise.all([
    prisma.supportTicket.count({ where: { status: { in: ["OPEN", "IN_PROGRESS"] } } }),
    prisma.supportTicket.aggregate({
      where: { status: { notIn: ["CLOSED", "RESOLVED"] }, adminUnread: { gt: 0 } },
      _sum: { adminUnread: true },
    }),
    prisma.serviceSignupRequest.count({ where: { status: "NEW" } }),
    prisma.subscriptionRequest
      .count({ where: { status: { in: ["PENDING", "AWAITING_PAYMENT", "PAYMENT_REVIEW", "APPROVED"] } } })
      .catch(() => 0),
  ]);
  return { open, unread: unread._sum.adminUnread || 0, signupPending, billingPending };
}

export async function listMySupportTickets(prisma: PrismaClient, auth: AuthContext) {
  const membership = requireTenant(auth);
  const items = await prisma.supportTicket.findMany({
    where: { tenantId: membership.tenantId, createdByUserId: auth.user.id },
    orderBy: { lastMessageAt: "desc" },
    take: 50,
  });
  const users = await ticketUsers(prisma, items);
  return { items: items.map((item) => serializeTicket(item, users)) };
}

export async function createSupportTicket(
  prisma: PrismaClient,
  auth: AuthContext,
  input: { message?: string; route?: string; context?: unknown; subject?: string },
) {
  const membership = requireTenant(auth);
  const text = String(input.message || "").trim().slice(0, MAX_MESSAGE);
  if (text.length < 2) throw new ApiError(422, "invalid", "Опишите вопрос");
  const sourceRoute = String(input.route || "").split("#")[0].slice(0, 240);
  const sourceModule = supportModuleFromRoute(sourceRoute);
  const subject = String(input.subject || text)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  const ticket = await prisma.supportTicket.create({
    data: {
      tenantId: membership.tenantId,
      createdByUserId: auth.user.id,
      subject,
      status: "OPEN",
      priority: "NORMAL",
      sourceRoute: sourceRoute || null,
      sourceModule,
      contextJson: sanitizeSupportContext({ ...(typeof input.context === "object" ? input.context : {}), route: sourceRoute }),
      lastMessageAt: new Date(),
      customerUnread: 0,
      adminUnread: 1,
    },
  });
  await prisma.supportMessage.createMany({
    data: [
      {
        ticketId: ticket.id,
        senderUserId: null,
        senderType: "SYSTEM",
        type: "SYSTEM",
        content: "Здравствуйте! Опишите вопрос, и мы поможем.",
      },
      {
        ticketId: ticket.id,
        senderUserId: auth.user.id,
        senderType: "USER",
        type: "TEXT",
        content: text,
      },
    ],
  });
  await prisma.auditEvent.create({
    data: {
      tenantId: membership.tenantId,
      actorUserId: auth.user.id,
      action: "support.ticket.created",
      entityType: "support_ticket",
      entityId: ticket.id,
      changesJson: { sourceModule, number: ticket.number },
    },
  });
  return getSupportTicket(prisma, auth, ticket.id, false);
}

export async function getSupportTicket(prisma: PrismaClient, auth: AuthContext, ticketId: string, asAdmin = false) {
  const ticket = await loadTicketOrThrow(prisma, auth, ticketId, asAdmin);
  const [messages, users, tenant] = await Promise.all([
    prisma.supportMessage.findMany({ where: { ticketId: ticket.id }, orderBy: { createdAt: "asc" } }),
    ticketUsers(prisma, [ticket]),
    prisma.tenant.findFirst({ where: { id: ticket.tenantId }, select: { name: true } }),
  ]);
  const files = await attachmentsFor(prisma, ticket.tenantId, messages.map((item) => item.id));
  if (!asAdmin) {
    await prisma.supportTicket.updateMany({ where: { id: ticket.id, tenantId: ticket.tenantId }, data: { customerUnread: 0 } });
    ticket.customerUnread = 0;
  } else {
    await prisma.supportTicket.updateMany({ where: { id: ticket.id }, data: { adminUnread: 0 } });
    ticket.adminUnread = 0;
  }
  return {
    ticket: {
      ...serializeTicket(ticket, users, tenant?.name, asAdmin),
      context: asAdmin ? sanitizeSupportContext(ticket.contextJson) : undefined,
    },
    messages: messages.map((item) => ({
      id: item.id,
      senderType: item.senderType,
      type: item.type,
      content: item.content,
      createdAt: item.createdAt,
      mine: item.senderUserId === auth.user.id,
      attachments: files.get(item.id) || [],
    })),
  };
}

export async function addSupportMessage(
  prisma: PrismaClient,
  auth: AuthContext,
  ticketId: string,
  input: { content?: string },
  asAdmin = false,
) {
  const ticket = await loadTicketOrThrow(prisma, auth, ticketId, asAdmin);
  if (!asAdmin && (ticket.status === "CLOSED" || ticket.status === "RESOLVED")) {
    throw new ApiError(422, "closed", "Обращение закрыто. Создайте новое.");
  }
  const content = String(input.content || "").trim().slice(0, MAX_MESSAGE);
  if (content.length < 1) throw new ApiError(422, "invalid", "Напишите сообщение");
  const senderType = asAdmin ? "ADMIN" : "USER";
  const message = await prisma.supportMessage.create({
    data: {
      ticketId: ticket.id,
      senderUserId: auth.user.id,
      senderType,
      type: "TEXT",
      content,
    },
  });
  const nextStatus = asAdmin
    ? ticket.status === "CLOSED" || ticket.status === "RESOLVED"
      ? ticket.status
      : "IN_PROGRESS"
    : ticket.status === "WAITING_FOR_CUSTOMER"
      ? "IN_PROGRESS"
      : ticket.status === "CLOSED" || ticket.status === "RESOLVED"
        ? ticket.status
        : ticket.status;
  await prisma.supportTicket.update({
    where: { id: ticket.id },
    data: {
      lastMessageAt: new Date(),
      status: nextStatus,
      assignedToUserId: asAdmin ? ticket.assignedToUserId || auth.user.id : ticket.assignedToUserId,
      customerUnread: asAdmin ? ticket.customerUnread + 1 : 0,
      adminUnread: asAdmin ? 0 : ticket.adminUnread + 1,
    },
  });
  if (asAdmin) {
    const membership = await prisma.membership.findFirst({
      where: { tenantId: ticket.tenantId, userId: ticket.createdByUserId, active: true },
    });
    await createStaffNotification(prisma, {
      tenantId: ticket.tenantId,
      membershipId: membership?.id,
      type: "support.replied",
      entityType: "support_ticket",
      entityId: ticket.id,
      title: "Поддержка ответила",
      body: content.slice(0, 140),
      priority: "normal",
      episodeKey: `support:${ticket.id}:${message.id}`,
      channels: ["in_app", "web_push"],
    });
  }
  return getSupportTicket(prisma, auth, ticket.id, asAdmin);
}

export async function addSupportAttachment(
  prisma: PrismaClient,
  auth: AuthContext,
  ticketId: string,
  input: { fileName: string; mimeType: string; contentBase64: string },
  asAdmin = false,
) {
  const ticket = await loadTicketOrThrow(prisma, auth, ticketId, asAdmin);
  if (!asAdmin && (ticket.status === "CLOSED" || ticket.status === "RESOLVED")) {
    throw new ApiError(422, "closed", "Обращение закрыто. Создайте новое.");
  }
  const mimeType = resolveMime(input.fileName, input.mimeType);
  if (!mimeType || !ALLOWED_MIME.has(mimeType)) {
    throw new ApiError(422, "unsupported_type", "Этот тип файла не принимается");
  }
  const buf = Buffer.from(String(input.contentBase64 || ""), "base64");
  if (!buf.length) throw new ApiError(422, "invalid", "Файл пустой");
  if (buf.length > MAX_FILE_BYTES) throw new ApiError(422, "too_large", "Файл больше 15 МБ");
  const safeName = safeFileName(input.fileName);
  const attachmentId = randomUUID();
  const message = await prisma.supportMessage.create({
    data: {
      ticketId: ticket.id,
      senderUserId: auth.user.id,
      senderType: asAdmin ? "ADMIN" : "USER",
      type: mimeType.startsWith("image/") ? "IMAGE" : "FILE",
      content: safeName,
    },
  });
  const storageKey = path.posix.join(ticket.tenantId, "support", ticket.id, `${attachmentId}-${safeName}`);
  const abs = resolveUploadPath(storageKey);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, buf);
  await prisma.attachment.create({
    data: {
      id: attachmentId,
      tenantId: ticket.tenantId,
      parentType: "support_message",
      parentId: message.id,
      storageKey,
      fileName: safeName,
      originalFileName: input.fileName,
      mimeType,
      sizeBytes: buf.length,
      checksum: createHash("sha256").update(buf).digest("hex"),
      documentType: mimeType.startsWith("image/") ? "image" : "document",
      uploadedById: auth.user.id,
      status: "stored",
    },
  });
  await prisma.supportTicket.update({
    where: { id: ticket.id },
    data: {
      lastMessageAt: new Date(),
      status: asAdmin ? "IN_PROGRESS" : ticket.status === "WAITING_FOR_CUSTOMER" ? "IN_PROGRESS" : ticket.status,
      assignedToUserId: asAdmin ? ticket.assignedToUserId || auth.user.id : ticket.assignedToUserId,
      customerUnread: asAdmin ? ticket.customerUnread + 1 : 0,
      adminUnread: asAdmin ? 0 : ticket.adminUnread + 1,
    },
  });
  return getSupportTicket(prisma, auth, ticket.id, asAdmin);
}

export async function getSupportAttachment(
  prisma: PrismaClient,
  auth: AuthContext,
  ticketId: string,
  attachmentId: string,
  asAdmin = false,
) {
  const ticket = await loadTicketOrThrow(prisma, auth, ticketId, asAdmin);
  const att = await prisma.attachment.findFirst({
    where: { id: attachmentId, tenantId: ticket.tenantId, parentType: "support_message" },
  });
  if (!att) throw new ApiError(404, "not_found", "Файл не найден");
  const message = await prisma.supportMessage.findFirst({ where: { id: att.parentId, ticketId: ticket.id } });
  if (!message) throw new ApiError(404, "not_found", "Файл не найден");
  return {
    path: resolveUploadPath(att.storageKey),
    mimeType: att.mimeType,
    fileName: att.originalFileName || att.fileName,
    kind: att.mimeType.startsWith("image/") ? "image" : "file",
  };
}

export async function listAdminSupportTickets(
  prisma: PrismaClient,
  auth: AuthContext,
  query: { status?: string; q?: string },
) {
  requirePlatformAdmin(auth);
  const status = String(query.status || "").toUpperCase();
  const where: Record<string, unknown> = {};
  if (status === "OPEN" || status === "NEW") where.status = "OPEN";
  else if (status === "IN_PROGRESS") where.status = "IN_PROGRESS";
  else if (status === "WAITING_FOR_CUSTOMER") where.status = "WAITING_FOR_CUSTOMER";
  else if (status === "CLOSED") where.status = { in: ["CLOSED", "RESOLVED"] };
  const q = String(query.q || "").trim();
  const items = await prisma.supportTicket.findMany({
    where: q
      ? {
          AND: [
            where,
            {
              OR: [
                { subject: { contains: q } },
                { sourceRoute: { contains: q } },
                ...(Number(q) ? [{ number: Number(q) }] : []),
              ],
            },
          ],
        }
      : where,
    orderBy: { lastMessageAt: "desc" },
    take: 100,
  });
  const tenantIds = [...new Set(items.map((item) => item.tenantId))];
  const [users, tenants] = await Promise.all([
    ticketUsers(prisma, items),
    prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } }),
  ]);
  const tenantNames = new Map(tenants.map((item) => [item.id, item.name]));
  return {
    items: items.map((item) => serializeTicket(item, users, tenantNames.get(item.tenantId), true)),
  };
}

export async function updateAdminSupportTicket(
  prisma: PrismaClient,
  auth: AuthContext,
  ticketId: string,
  input: { status?: string; assignedToUserId?: string | null; priority?: string },
) {
  requirePlatformAdmin(auth);
  const ticket = await loadTicketOrThrow(prisma, auth, ticketId, true);
  const data: Record<string, unknown> = {};
  if (input.status) {
    const status = String(input.status).toUpperCase();
    if (!TICKET_STATUSES.includes(status as (typeof TICKET_STATUSES)[number])) {
      throw new ApiError(422, "invalid", "Неизвестный статус");
    }
    data.status = status;
    if (status === "CLOSED" || status === "RESOLVED") data.resolvedAt = new Date();
    if (status === "WAITING_FOR_CUSTOMER" && ticket.status !== "WAITING_FOR_CUSTOMER") {
      await prisma.supportMessage.create({
        data: {
          ticketId: ticket.id,
          senderUserId: auth.user.id,
          senderType: "SYSTEM",
          type: "SYSTEM",
          content: "Ожидаем ваш ответ.",
        },
      });
    }
  }
  if (input.priority) {
    const priority = String(input.priority).toUpperCase();
    if (!PRIORITIES.includes(priority as (typeof PRIORITIES)[number])) {
      throw new ApiError(422, "invalid", "Неизвестный приоритет");
    }
    data.priority = priority;
  }
  if (input.assignedToUserId !== undefined) {
    data.assignedToUserId = input.assignedToUserId;
  } else if (!ticket.assignedToUserId) {
    data.assignedToUserId = auth.user.id;
  }
  await prisma.supportTicket.update({ where: { id: ticket.id }, data });
  return getSupportTicket(prisma, auth, ticket.id, true);
}

export async function listSupportQuickReplies(prisma: PrismaClient, auth: AuthContext) {
  requirePlatformAdmin(auth);
  const items = await prisma.supportQuickReply.findMany({
    orderBy: { sortOrder: "asc" },
  });
  return { items };
}

export async function upsertSupportQuickReply(
  prisma: PrismaClient,
  auth: AuthContext,
  input: { id?: string; shortcut: string; title: string; content: string; isActive?: boolean; sortOrder?: number },
) {
  requirePlatformAdmin(auth);
  const shortcut = String(input.shortcut || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
  if (!shortcut.startsWith("/") || shortcut.length < 2) {
    throw new ApiError(422, "invalid", "Команда должна начинаться с /");
  }
  const data = {
    shortcut,
    title: String(input.title || "").trim().slice(0, 80),
    content: String(input.content || "").trim().slice(0, MAX_MESSAGE),
    isActive: input.isActive !== false,
    sortOrder: Number(input.sortOrder) || 100,
  };
  if (!data.title || !data.content) throw new ApiError(422, "invalid", "Нужны название и текст");
  const row = input.id
    ? await prisma.supportQuickReply.update({ where: { id: input.id }, data })
    : await prisma.supportQuickReply.create({ data });
  return row;
}

export async function deleteSupportQuickReply(prisma: PrismaClient, auth: AuthContext, id: string) {
  requirePlatformAdmin(auth);
  await prisma.supportQuickReply.delete({ where: { id } }).catch(() => {
    throw new ApiError(404, "not_found", "Шаблон не найден");
  });
  return { ok: true };
}
