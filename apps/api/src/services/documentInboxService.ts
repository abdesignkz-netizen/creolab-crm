import type { Prisma, PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import type { AuthContext } from "../lib/types.ts";
import { asMoney } from "./documentMoney.ts";
import { isDocumentsEnabled } from "./legalProfileService.ts";

export const DOCUMENT_KINDS = ["CONTRACT", "INVOICE", "AVR", "ESF"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_KIND_LABEL: Record<DocumentKind, string> = {
  CONTRACT: "Договор",
  INVOICE: "Счёт",
  AVR: "АВР",
  ESF: "ЭСФ",
};

const CONTRACT_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Черновик",
  READY_TO_SIGN: "Готов к подписи",
  PENDING_SIGNATURE: "На подписи",
  PARTIALLY_SIGNED: "Частично подписан",
  SIGNED: "Подписан",
};

const INVOICE_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Черновик",
  ISSUED: "Выставлен",
  PARTIALLY_PAID: "Частично оплачен",
  PAID: "Оплачен",
  OVERDUE: "Просрочен",
  CANCELLED: "Отменён",
};

const EDOC_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Черновик",
  VALIDATED: "Проверен",
  SIGNED: "Подписан",
  SENT: "Отправлен",
  ACCEPTED: "Подтверждён",
};

const CONTRACT_ATTENTION = new Set(["READY_TO_SIGN", "PENDING_SIGNATURE", "PARTIALLY_SIGNED"]);
const INVOICE_ATTENTION = new Set(["OVERDUE"]);

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership;
}

function parseUuid(value?: string) {
  const raw = String(value || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)
    ? raw
    : "";
}

export function documentStatusLabel(kind: DocumentKind, status: string) {
  if (kind === "CONTRACT") return CONTRACT_STATUS_LABEL[status] || status;
  if (kind === "INVOICE") return INVOICE_STATUS_LABEL[status] || status;
  return EDOC_STATUS_LABEL[status] || status;
}

export function isDocumentAttention(kind: DocumentKind, status: string, errorCode?: string | null) {
  if (kind === "CONTRACT") return CONTRACT_ATTENTION.has(status);
  if (kind === "INVOICE") return INVOICE_ATTENTION.has(status);
  return status === "SENT" || Boolean(errorCode);
}

export async function countDocumentAttention(prisma: PrismaClient, tenantId: string) {
  if (!(await isDocumentsEnabled(prisma, tenantId))) return 0;
  const [contracts, invoices, edocs] = await Promise.all([
    prisma.contract.count({ where: { tenantId, status: { in: [...CONTRACT_ATTENTION] } } }),
    prisma.invoice.count({ where: { tenantId, status: { in: [...INVOICE_ATTENTION] } } }),
    prisma.electronicDocument.count({
      where: {
        tenantId,
        type: { in: ["AVR", "ESF"] },
        OR: [{ status: "SENT" }, { errorCode: { not: null } }],
      },
    }),
  ]);
  return contracts + invoices + edocs;
}

function searchWhere(q: string) {
  return {
    OR: [
      { number: { contains: q, mode: "insensitive" as const } },
      { deal: { title: { contains: q, mode: "insensitive" as const } } },
      { company: { name: { contains: q, mode: "insensitive" as const } } },
    ],
  };
}

export async function listTenantDocuments(
  prisma: PrismaClient,
  auth: AuthContext,
  query: Record<string, string | undefined> = {},
) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  if (!(await isDocumentsEnabled(prisma, tid))) {
    throw new ApiError(403, "documents_disabled", "Контур документов выключен в настройках");
  }

  const kindRaw = String(query.kind || "").trim().toUpperCase();
  const kind = DOCUMENT_KINDS.includes(kindRaw as DocumentKind) ? (kindRaw as DocumentKind) : "";
  const status = String(query.status || "").trim();
  const q = String(query.q || "").trim();
  const attentionOnly = query.attention === "1" || query.attention === "true";
  const dealId = parseUuid(query.dealId);
  const companyId = parseUuid(query.companyId);
  const offset = Math.max(0, Number(query.offset || 0) || 0);
  const limit = Math.min(100, Math.max(1, Number(query.limit || 50) || 50));

  const base = {
    tenantId: tid,
    ...(dealId ? { dealId } : {}),
    ...(companyId ? { companyId } : {}),
    ...(q ? searchWhere(q) : {}),
  };
  const contractWhere: Prisma.ContractWhereInput = {
    ...base,
    ...(status ? { status } : {}),
    ...(attentionOnly ? { status: { in: [...CONTRACT_ATTENTION] } } : {}),
  };
  const invoiceWhere: Prisma.InvoiceWhereInput = {
    ...base,
    ...(status ? { status } : {}),
    ...(attentionOnly ? { status: { in: [...INVOICE_ATTENTION] } } : {}),
  };
  const edocWhere = (type: "AVR" | "ESF"): Prisma.ElectronicDocumentWhereInput => ({
    ...base,
    type,
    ...(status ? { status } : {}),
    ...(attentionOnly
      ? {
          OR: [{ status: "SENT" }, { errorCode: { not: null } }],
        }
      : {}),
  });

  const include = {
    deal: { select: { id: true, title: true } },
    company: { select: { id: true, name: true } },
  } as const;

  const [contracts, invoices, avrs, esfs, contractCount, invoiceCount, avrCount, esfCount, attention] =
    await Promise.all([
      !kind || kind === "CONTRACT"
        ? prisma.contract.findMany({ where: contractWhere, include, orderBy: { updatedAt: "desc" }, take: 300 })
        : [],
      !kind || kind === "INVOICE"
        ? prisma.invoice.findMany({ where: invoiceWhere, include, orderBy: { updatedAt: "desc" }, take: 300 })
        : [],
      !kind || kind === "AVR"
        ? prisma.electronicDocument.findMany({
            where: edocWhere("AVR"),
            include,
            orderBy: { updatedAt: "desc" },
            take: 300,
          })
        : [],
      !kind || kind === "ESF"
        ? prisma.electronicDocument.findMany({
            where: edocWhere("ESF"),
            include,
            orderBy: { updatedAt: "desc" },
            take: 300,
          })
        : [],
      !kind || kind === "CONTRACT" ? prisma.contract.count({ where: contractWhere }) : 0,
      !kind || kind === "INVOICE" ? prisma.invoice.count({ where: invoiceWhere }) : 0,
      !kind || kind === "AVR" ? prisma.electronicDocument.count({ where: edocWhere("AVR") }) : 0,
      !kind || kind === "ESF" ? prisma.electronicDocument.count({ where: edocWhere("ESF") }) : 0,
      countDocumentAttention(prisma, tid),
    ]);

  const items = [
    ...contracts.map((row) =>
      serializeInboxItem({
        id: row.id,
        kind: "CONTRACT",
        number: row.number,
        status: row.status,
        totalAmount: row.totalAmount,
        currency: row.currency,
        updatedAt: row.updatedAt,
        dealId: row.deal.id,
        dealTitle: row.deal.title,
        companyId: row.company?.id || null,
        companyName: row.company?.name || null,
        errorCode: null,
        externalStatus: null,
      }),
    ),
    ...invoices.map((row) =>
      serializeInboxItem({
        id: row.id,
        kind: "INVOICE",
        number: row.number,
        status: row.status,
        totalAmount: row.totalAmount,
        currency: row.currency,
        updatedAt: row.updatedAt,
        dealId: row.deal.id,
        dealTitle: row.deal.title,
        companyId: row.company?.id || null,
        companyName: row.company?.name || null,
        errorCode: null,
        externalStatus: null,
      }),
    ),
    ...avrs.map((row) =>
      serializeInboxItem({
        id: row.id,
        kind: "AVR",
        number: row.number,
        status: row.status,
        totalAmount: row.totalAmount,
        currency: row.currency,
        updatedAt: row.updatedAt,
        dealId: row.deal.id,
        dealTitle: row.deal.title,
        companyId: row.company?.id || null,
        companyName: row.company?.name || null,
        errorCode: row.errorCode,
        externalStatus: row.externalStatus,
      }),
    ),
    ...esfs.map((row) =>
      serializeInboxItem({
        id: row.id,
        kind: "ESF",
        number: row.number,
        status: row.status,
        totalAmount: row.totalAmount,
        currency: row.currency,
        updatedAt: row.updatedAt,
        dealId: row.deal.id,
        dealTitle: row.deal.title,
        companyId: row.company?.id || null,
        companyName: row.company?.name || null,
        errorCode: row.errorCode,
        externalStatus: row.externalStatus,
      }),
    ),
  ].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));

  return {
    items: items.slice(offset, offset + limit),
    total: contractCount + invoiceCount + avrCount + esfCount,
    offset,
    limit,
    counts: {
      all: contractCount + invoiceCount + avrCount + esfCount,
      attention,
      contract: contractCount,
      invoice: invoiceCount,
      avr: avrCount,
      esf: esfCount,
    },
  };
}

function serializeInboxItem(row: {
  id: string;
  kind: DocumentKind;
  number: string;
  status: string;
  totalAmount: { toString(): string } | number;
  currency: string;
  updatedAt: Date;
  dealId: string;
  dealTitle: string;
  companyId: string | null;
  companyName: string | null;
  errorCode: string | null;
  externalStatus: string | null;
}) {
  return {
    id: row.id,
    kind: row.kind,
    kindLabel: DOCUMENT_KIND_LABEL[row.kind],
    number: row.number,
    status: row.status,
    statusLabel: documentStatusLabel(row.kind, row.status),
    attention: isDocumentAttention(row.kind, row.status, row.errorCode),
    totalAmount: asMoney(row.totalAmount),
    currency: row.currency,
    updatedAt: row.updatedAt.toISOString(),
    dealId: row.dealId,
    dealTitle: row.dealTitle,
    companyId: row.companyId,
    companyName: row.companyName,
    errorCode: row.errorCode,
    externalStatus: row.externalStatus,
    href: `/deals/${row.dealId}`,
  };
}
