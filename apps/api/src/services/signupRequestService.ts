import type { PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import { writeAudit } from "../lib/audit.ts";
import { requirePlatformAdmin } from "../lib/access.ts";
import type { AuthContext } from "../lib/types.ts";

const STATUS_LABEL: Record<string, string> = {
  NEW: "Новый",
  DONE: "Обработан",
};

function serialize(row: {
  id: string;
  email: string;
  companyName: string;
  status: string;
  createdAt: Date;
  processedAt: Date | null;
}) {
  return {
    id: row.id,
    email: row.email,
    companyName: row.companyName,
    status: row.status,
    statusLabel: STATUS_LABEL[row.status] || row.status,
    createdAt: row.createdAt.toISOString(),
    processedAt: row.processedAt?.toISOString() || null,
  };
}

export async function createSignupRequest(
  prisma: PrismaClient,
  input: { email: string; companyName: string },
  meta: { ip?: string; userAgent?: string } = {},
) {
  const email = input.email.trim().toLowerCase();
  const companyName = input.companyName.replace(/\s+/g, " ").trim();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const existing = await prisma.serviceSignupRequest.findFirst({
    where: { email, companyName, status: "NEW", createdAt: { gte: since } },
    select: { id: true },
  });
  if (existing) return { ok: true };

  const row = await prisma.serviceSignupRequest.create({
    data: {
      email,
      companyName,
      sourceIp: (meta.ip || "").slice(0, 80) || null,
      userAgent: (meta.userAgent || "").slice(0, 400) || null,
    },
  });
  await writeAudit(prisma, {
    action: "signup_request.created",
    entityType: "ServiceSignupRequest",
    entityId: row.id,
    changes: { email, companyName },
  });
  return { ok: true };
}

export async function countPendingSignupRequests(prisma: PrismaClient) {
  return prisma.serviceSignupRequest.count({ where: { status: "NEW" } });
}

export async function listSignupRequests(
  prisma: PrismaClient,
  auth: AuthContext,
  query: Record<string, string | undefined> = {},
) {
  requirePlatformAdmin(auth);
  const status = String(query.status || "");
  const items = await prisma.serviceSignupRequest.findMany({
    where: status === "NEW" || status === "DONE" ? { status } : undefined,
    orderBy: { createdAt: "desc" },
    take: 80,
  });
  items.sort((a, b) => {
    if (a.status === b.status) return b.createdAt.getTime() - a.createdAt.getTime();
    return a.status === "NEW" ? -1 : 1;
  });
  const pendingCount = await countPendingSignupRequests(prisma);
  return { items: items.map(serialize), pendingCount };
}

export async function updateSignupRequest(
  prisma: PrismaClient,
  auth: AuthContext,
  id: string,
  input: { status: "NEW" | "DONE" },
) {
  requirePlatformAdmin(auth);
  const current = await prisma.serviceSignupRequest.findUnique({ where: { id } });
  if (!current) throw new ApiError(404, "not_found", "Запрос не найден");
  const done = input.status === "DONE";
  const row = await prisma.serviceSignupRequest.update({
    where: { id },
    data: {
      status: input.status,
      processedAt: done ? new Date() : null,
      processedByUserId: done ? auth.user.id : null,
    },
  });
  await writeAudit(prisma, {
    actorUserId: auth.user.id,
    action: done ? "signup_request.done" : "signup_request.reopened",
    entityType: "ServiceSignupRequest",
    entityId: row.id,
    changes: { status: input.status, email: row.email, companyName: row.companyName },
  });
  return serialize(row);
}
