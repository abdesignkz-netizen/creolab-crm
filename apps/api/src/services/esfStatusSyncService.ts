import type { PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import { readEsfConfig } from "../integrations/esf/EsfConfig.ts";
import { isSessionClosedFault } from "../integrations/esf/EsfSoap.ts";
import { queryAwpStatusById, queryInvoiceById } from "../integrations/esf/sync/EsfDocumentSyncService.ts";
import {
  connectionEnvironment,
  getUsableEsfSession,
  markEsfReauthRequired,
} from "./esfConnectionService.ts";
import { can, type AuthContext } from "../lib/types.ts";
import { serializeElectronicDocument } from "./documentDraftService.ts";
import { requireDocumentsEnabled } from "./legalProfileService.ts";

const POLL_TYPE = "esf_status_poll";
const POLL_DELAYS_MS = [0, 30_000, 60_000, 120_000, 300_000];
const MAX_POLLS = 200;

export const AVR_ACCEPTED_STATUS = "CONFIRMED";
export const INVOICE_ACCEPTED_STATUS = "DELIVERED";

const AVR_TERMINAL = new Set(["CONFIRMED", "FAILED", "DECLINED", "REVOKED", "TERMINATED"]);
const INVOICE_TERMINAL = new Set([
  "DELIVERED",
  "FAILED",
  "DECLINED",
  "CANCELED",
  "CANCELED_BY_OGD",
  "CANCELED_BY_SNT_DECLINE",
  "CANCELED_BY_SNT_REVOKE",
  "REVOKED",
  "DELETED",
  "FAILED_BIOMETRICS_VERIFICATION",
  "DELETED_BIOMETRICS_VERIFICATION",
]);
const FAILED_STATUSES = new Set([
  "FAILED",
  "DECLINED",
  "CANCELED",
  "CANCELED_BY_OGD",
  "CANCELED_BY_SNT_DECLINE",
  "CANCELED_BY_SNT_REVOKE",
  "REVOKED",
  "DELETED",
  "TERMINATED",
  "FAILED_BIOMETRICS_VERIFICATION",
  "DELETED_BIOMETRICS_VERIFICATION",
]);

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership;
}

export function isOfficialAvrAccepted(status: string) {
  return status === AVR_ACCEPTED_STATUS;
}

export function isOfficialInvoiceAccepted(status: string) {
  return status === INVOICE_ACCEPTED_STATUS;
}

export function isOfficialTerminalStatus(type: string, status: string) {
  if (!status) return false;
  return type === "ESF" ? INVOICE_TERMINAL.has(status) : AVR_TERMINAL.has(status);
}

export function pollDelayMs(attempt: number) {
  return POLL_DELAYS_MS[Math.min(Math.max(attempt, 0), POLL_DELAYS_MS.length - 1)]!;
}

async function queryOfficialStatus(
  prisma: PrismaClient,
  tenantId: string,
  type: string,
  externalId: string,
) {
  const config = readEsfConfig();
  if (config.provider === "mock") {
    return type === "ESF" ? queryInvoiceById("", externalId, config) : queryAwpStatusById("", externalId, config);
  }
  const session = await getUsableEsfSession(prisma, tenantId, config);
  if (!session) {
    await markEsfReauthRequired(
      prisma,
      tenantId,
      connectionEnvironment(config),
      "REAUTH_REQUIRED",
      "Для продолжения работы с ИС ЭСФ требуется повторная авторизация через NCALayer",
    );
    return {
      ok: false as const,
      message: "Для продолжения работы с ИС ЭСФ требуется повторная авторизация через NCALayer",
      status: "",
      registrationNumber: "",
    };
  }
  const queried =
    type === "ESF"
      ? await queryInvoiceById(session.sessionId, externalId, config)
      : await queryAwpStatusById(session.sessionId, externalId, config);
  if (!queried.ok && isSessionClosedFault(queried.message)) {
    await markEsfReauthRequired(
      prisma,
      tenantId,
      connectionEnvironment(config),
      "SESSION_EXPIRED",
      "Для продолжения работы с ИС ЭСФ требуется повторная авторизация через NCALayer",
    );
  }
  return queried;
}

export async function applyOfficialEsfStatus(
  prisma: PrismaClient,
  document: {
    id: string;
    tenantId: string;
    dealId: string;
    type: string;
    status: string;
    externalId: string | null;
    externalNumber: string | null;
    externalStatus: string | null;
    acceptedAt: Date | null;
  },
  queried: { status: string; registrationNumber?: string },
) {
  const accepted =
    document.type === "ESF" ? isOfficialInvoiceAccepted(queried.status) : isOfficialAvrAccepted(queried.status);
  const failed = FAILED_STATUSES.has(queried.status);
  const nextStatus = accepted ? "ACCEPTED" : failed ? "SENT" : document.status;
  const changed = document.status !== nextStatus || document.externalStatus !== queried.status;
  const updated = await prisma.electronicDocument.update({
    where: { id: document.id },
    data: {
      externalStatus: queried.status,
      externalNumber: queried.registrationNumber || document.externalNumber,
      status: nextStatus,
      acceptedAt: accepted ? document.acceptedAt || new Date() : document.acceptedAt,
      errorCode: failed ? "esf_failed" : null,
      errorMessage: failed ? `ИС ЭСФ вернула ${queried.status}` : null,
    },
  });
  if (accepted && document.status !== "ACCEPTED") {
    await prisma.outboxEvent.create({
      data: {
        tenantId: document.tenantId,
        type: document.type === "ESF" ? "esf.accepted" : "avr.accepted",
        entityType: "electronic_document",
        entityId: updated.id,
        payloadJson: {
          documentId: updated.id,
          dealId: updated.dealId,
          externalId: updated.externalId,
          externalStatus: updated.externalStatus,
        },
      },
    });
  }
  return {
    document: serializeElectronicDocument(updated),
    changed,
    accepted,
    terminal: isOfficialTerminalStatus(document.type, queried.status),
    operation: document.type === "ESF" ? "queryInvoiceById" : "queryAwpStatusById",
    externalId: updated.externalId,
    externalStatus: updated.externalStatus,
  };
}

export async function syncElectronicDocumentById(prisma: PrismaClient, tenantId: string, documentId: string) {
  const document = await prisma.electronicDocument.findFirst({
    where: { id: documentId, tenantId },
  });
  if (!document) throw new ApiError(404, "not_found", "Документ не найден");
  if (document.type !== "AVR" && document.type !== "ESF") {
    throw new ApiError(422, "unsupported_document", "ИС ЭСФ принимает только АВР и ЭСФ");
  }
  if (!document.externalId) {
    throw new ApiError(422, "esf_not_sent", "Сначала отправьте документ в ИС ЭСФ");
  }
  const queried = await queryOfficialStatus(prisma, tenantId, document.type, document.externalId);
  if (!queried.ok || !queried.status) {
    throw new ApiError(422, "esf_status_unavailable", queried.message || "ИС ЭСФ не вернула статус");
  }
  return applyOfficialEsfStatus(prisma, document, queried);
}

export async function scheduleEsfStatusPoll(
  prisma: PrismaClient,
  input: { tenantId: string; documentId: string; attempt?: number; delayMs?: number },
) {
  const attempt = input.attempt ?? 0;
  if (attempt >= MAX_POLLS) return null;
  const existing = await prisma.scheduledAction.findFirst({
    where: { tenantId: input.tenantId, type: POLL_TYPE, parentId: input.documentId, state: "scheduled" },
  });
  if (existing) return existing;
  return prisma.scheduledAction.create({
    data: {
      tenantId: input.tenantId,
      type: POLL_TYPE,
      parentType: "electronic_document",
      parentId: input.documentId,
      dueAt: new Date(Date.now() + (input.delayMs ?? pollDelayMs(attempt))),
      state: "scheduled",
      payloadJson: { documentId: input.documentId, attempt },
    },
  });
}

export async function processEsfSentOutbox(
  prisma: PrismaClient,
  event: { tenantId: string; type: string; payloadJson: unknown },
) {
  const payload = (event.payloadJson || {}) as { documentId?: string };
  if (!payload.documentId) return null;
  return scheduleEsfStatusPoll(prisma, { tenantId: event.tenantId, documentId: payload.documentId, attempt: 0, delayMs: 0 });
}

export async function processEsfStatusPollAction(
  prisma: PrismaClient,
  item: { id: string; tenantId: string; parentId: string; payloadJson: unknown },
) {
  const payload = (item.payloadJson || {}) as { documentId?: string; attempt?: number };
  const documentId = payload.documentId || item.parentId;
  const attempt = Number(payload.attempt || 0);
  const document = await prisma.electronicDocument.findFirst({
    where: { id: documentId, tenantId: item.tenantId },
  });
  if (!document?.externalId) {
    await prisma.scheduledAction.update({
      where: { id: item.id },
      data: { state: "canceled", cancelReason: "esf_not_sent" },
    });
    return { skipped: true };
  }
  if (document.status === "ACCEPTED" || isOfficialTerminalStatus(document.type, document.externalStatus || "")) {
    await prisma.scheduledAction.update({ where: { id: item.id }, data: { state: "done" } });
    return { skipped: true, terminal: true };
  }
  try {
    const synced = await syncElectronicDocumentById(prisma, item.tenantId, document.id);
    await prisma.scheduledAction.update({ where: { id: item.id }, data: { state: "done" } });
    if (!synced.terminal) {
      await scheduleEsfStatusPoll(prisma, {
        tenantId: item.tenantId,
        documentId: document.id,
        attempt: attempt + 1,
      });
    }
    return synced;
  } catch (error) {
    await prisma.scheduledAction.update({
      where: { id: item.id },
      data: { state: "failed", cancelReason: error instanceof Error ? error.message : "esf_status_unavailable" },
    });
    await scheduleEsfStatusPoll(prisma, {
      tenantId: item.tenantId,
      documentId: document.id,
      attempt: attempt + 1,
    });
    return { skipped: false, error: error instanceof Error ? error.message : "esf_status_unavailable" };
  }
}

export async function ensureEsfStatusPolls(prisma: PrismaClient) {
  const pending = await prisma.electronicDocument.findMany({
    where: {
      externalId: { not: null },
      type: { in: ["AVR", "ESF"] },
      status: "SENT",
    },
    take: 20,
    orderBy: { updatedAt: "asc" },
  });
  let scheduled = 0;
  for (const document of pending) {
    if (isOfficialTerminalStatus(document.type, document.externalStatus || "")) continue;
    const created = await scheduleEsfStatusPoll(prisma, {
      tenantId: document.tenantId,
      documentId: document.id,
      attempt: 0,
      delayMs: 0,
    });
    if (created) scheduled += 1;
  }
  return scheduled;
}

export async function syncDealEsfDocuments(prisma: PrismaClient, auth: AuthContext, dealId: string) {
  const membership = requireTenant(auth);
  if (!can(auth, "manage_documents")) {
    throw new ApiError(403, "forbidden", "Недостаточно прав для документов");
  }
  const tid = membership.tenantId;
  await requireDocumentsEnabled(prisma, tid);
  const deal = await prisma.deal.findFirst({ where: { id: dealId, tenantId: tid }, select: { id: true } });
  if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");
  const documents = await prisma.electronicDocument.findMany({
    where: { tenantId: tid, dealId, type: { in: ["AVR", "ESF"] }, externalId: { not: null } },
    orderBy: { createdAt: "asc" },
  });
  const results = [];
  for (const document of documents) {
    results.push(await syncElectronicDocumentById(prisma, tid, document.id));
  }
  return { documents: results.map((row) => row.document), results };
}
