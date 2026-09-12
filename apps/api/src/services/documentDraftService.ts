import type { PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import { can } from "../lib/types.ts";
import type { AuthContext } from "../lib/types.ts";
import { asMoney, sumLines } from "./documentMoney.ts";
import { serializeDealItem } from "./dealItemService.ts";
import { requireDocumentsEnabled } from "./legalProfileService.ts";

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership;
}

function requireManageDocuments(auth: AuthContext) {
  if (!can(auth, "manage_documents")) {
    throw new ApiError(403, "forbidden", "Недостаточно прав для документов");
  }
}

const CONTRACT_OPEN = ["DRAFT", "READY_TO_SIGN", "PENDING_SIGNATURE", "PARTIALLY_SIGNED"];
const INVOICE_OPEN = ["DRAFT", "ISSUED", "PARTIALLY_PAID"];
const EDOC_OPEN = ["DRAFT", "VALIDATED", "SIGNED", "SENT"];

async function nextNumber(prisma: PrismaClient, tenantId: string, prefix: string, count: number) {
  const year = new Date().getFullYear();
  return `${prefix}-${year}-${String(count + 1).padStart(4, "0")}`;
}

function moneyFromItems(items: Array<ReturnType<typeof serializeDealItem>>) {
  if (!items.length) {
    throw new ApiError(422, "deal_items_required", "Сначала добавьте позиции в сделку");
  }
  return sumLines(items);
}

export function mapDealItemsToInvoiceItems(
  items: Array<ReturnType<typeof serializeDealItem>>,
  tenantId: string,
  invoiceId: string,
) {
  return items.map((item) => ({
    tenantId,
    invoiceId,
    dealItemId: item.id,
    name: item.name,
    description: item.description,
    quantity: item.quantity,
    unit: item.unit,
    unitPrice: item.unitPrice,
    amountWithoutVat: item.amountWithoutVat,
    vatRate: item.vatRate,
    vatAmount: item.vatAmount,
    totalAmount: item.totalAmount,
    sortOrder: item.sortOrder,
  }));
}

async function loadDealBundle(prisma: PrismaClient, tenantId: string, dealId: string) {
  const deal = await prisma.deal.findFirst({
    where: { id: dealId, tenantId },
    include: { items: { orderBy: { sortOrder: "asc" } }, company: true },
  });
  if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");
  return { deal, items: deal.items.map(serializeDealItem) };
}

export function serializeContract(row: {
  id: string;
  dealId: string;
  companyId: string | null;
  number: string;
  date: Date;
  subject: string | null;
  amountWithoutVat: { toString(): string } | number;
  vatRate: { toString(): string } | number | null;
  vatAmount: { toString(): string } | number;
  totalAmount: { toString(): string } | number;
  currency: string;
  paymentTerms: string | null;
  completionTerms: string | null;
  status: string;
  generatedFileId?: string | null;
  originalFileId?: string | null;
  templateId?: string | null;
  verificationPublicId?: string | null;
  signedAt?: Date | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    dealId: row.dealId,
    companyId: row.companyId,
    number: row.number,
    date: row.date.toISOString(),
    subject: row.subject,
    amountWithoutVat: asMoney(row.amountWithoutVat),
    vatRate: row.vatRate == null ? null : asMoney(row.vatRate),
    vatAmount: asMoney(row.vatAmount),
    totalAmount: asMoney(row.totalAmount),
    currency: row.currency,
    paymentTerms: row.paymentTerms,
    completionTerms: row.completionTerms,
    status: row.status,
    generatedFileId: row.generatedFileId ?? null,
    importedPdf: Boolean(row.originalFileId),
    templateId: row.templateId ?? null,
    verificationPublicId: row.verificationPublicId ?? null,
    signedAt: row.signedAt?.toISOString() || null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function serializeInvoice(row: {
  id: string;
  dealId: string;
  contractId: string | null;
  companyId: string | null;
  number: string;
  date: Date;
  dueDate: Date | null;
  currency: string;
  amountWithoutVat: { toString(): string } | number;
  vatRate: { toString(): string } | number | null;
  vatAmount: { toString(): string } | number;
  totalAmount: { toString(): string } | number;
  status: string;
  pdfFileId?: string | null;
  items?: Array<{
    id: string;
    dealItemId: string | null;
    name: string;
    description: string | null;
    quantity: { toString(): string } | number;
    unit: string;
    unitPrice: { toString(): string } | number;
    amountWithoutVat: { toString(): string } | number;
    vatRate: { toString(): string } | number;
    vatAmount: { toString(): string } | number;
    totalAmount: { toString(): string } | number;
    sortOrder: number;
  }>;
}) {
  return {
    id: row.id,
    dealId: row.dealId,
    contractId: row.contractId,
    companyId: row.companyId,
    number: row.number,
    date: row.date.toISOString(),
    dueDate: row.dueDate?.toISOString() || null,
    currency: row.currency,
    amountWithoutVat: asMoney(row.amountWithoutVat),
    vatRate: row.vatRate == null ? null : asMoney(row.vatRate),
    vatAmount: asMoney(row.vatAmount),
    totalAmount: asMoney(row.totalAmount),
    status: row.status,
    pdfFileId: row.pdfFileId ?? null,
    items: (row.items || []).map((item) => ({
      id: item.id,
      dealItemId: item.dealItemId,
      name: item.name,
      description: item.description,
      quantity: asMoney(item.quantity),
      unit: item.unit,
      unitPrice: asMoney(item.unitPrice),
      amountWithoutVat: asMoney(item.amountWithoutVat),
      vatRate: asMoney(item.vatRate),
      vatAmount: asMoney(item.vatAmount),
      totalAmount: asMoney(item.totalAmount),
      sortOrder: item.sortOrder,
    })),
  };
}

export function serializeElectronicDocument(row: {
  id: string;
  type: string;
  dealId: string;
  contractId: string | null;
  invoiceId: string | null;
  companyId: string | null;
  number: string;
  documentDate: Date;
  amountWithoutVat: { toString(): string } | number;
  vatAmount: { toString(): string } | number;
  totalAmount: { toString(): string } | number;
  currency: string;
  status: string;
  sourceDataJson?: unknown;
  validatedAt?: Date | null;
  xmlStorageKey?: string | null;
  signedXmlStorageKey?: string | null;
  signedAt?: Date | null;
  sentAt?: Date | null;
  acceptedAt?: Date | null;
  externalSystem?: string | null;
  externalId?: string | null;
  externalNumber?: string | null;
  externalStatus?: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}) {
  return {
    id: row.id,
    type: row.type,
    dealId: row.dealId,
    contractId: row.contractId,
    invoiceId: row.invoiceId,
    companyId: row.companyId,
    number: row.number,
    documentDate: row.documentDate.toISOString(),
    amountWithoutVat: asMoney(row.amountWithoutVat),
    vatAmount: asMoney(row.vatAmount),
    totalAmount: asMoney(row.totalAmount),
    currency: row.currency,
    status: row.status,
    source: row.sourceDataJson ?? {},
    validatedAt: row.validatedAt?.toISOString() || null,
    xmlPrepared: Boolean(row.xmlStorageKey),
    signedXmlPrepared: Boolean(row.signedXmlStorageKey),
    signedAt: row.signedAt?.toISOString() || null,
    sentAt: row.sentAt?.toISOString() || null,
    acceptedAt: row.acceptedAt?.toISOString() || null,
    externalSystem: row.externalSystem ?? null,
    externalId: row.externalId ?? null,
    externalNumber: row.externalNumber ?? null,
    externalStatus: row.externalStatus ?? null,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
  };
}

export async function listDealDocuments(prisma: PrismaClient, auth: AuthContext, dealId: string) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const deal = await prisma.deal.findFirst({ where: { id: dealId, tenantId: tid } });
  if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");
  const [contracts, invoices, electronicDocuments] = await Promise.all([
    prisma.contract.findMany({ where: { tenantId: tid, dealId }, orderBy: { createdAt: "desc" } }),
    prisma.invoice.findMany({
      where: { tenantId: tid, dealId },
      include: { items: { orderBy: { sortOrder: "asc" } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.electronicDocument.findMany({ where: { tenantId: tid, dealId }, orderBy: { createdAt: "desc" } }),
  ]);
  const importedInvoiceFiles = await prisma.attachment.findMany({ where: { tenantId: tid, parentType: "invoice", status: "imported", id: { in: invoices.flatMap(i => i.pdfFileId ? [i.pdfFileId] : []) } }, select: { id: true } });
  const importedIds = new Set(importedInvoiceFiles.map(f => f.id));
  return {
    contracts: contracts.map(serializeContract),
    invoices: invoices.map(row => ({ ...serializeInvoice(row), importedPdf: Boolean(row.pdfFileId && importedIds.has(row.pdfFileId)) })),
    electronicDocuments: electronicDocuments.map(serializeElectronicDocument),
  };
}

export async function createContractDraft(
  prisma: PrismaClient,
  auth: AuthContext,
  dealId: string,
  input: { subject?: string | null; paymentTerms?: string | null; completionTerms?: string | null },
) {
  const membership = requireTenant(auth);
  requireManageDocuments(auth);
  const tid = membership.tenantId;
  await requireDocumentsEnabled(prisma, tid);
  const existing = await prisma.contract.findFirst({
    where: { tenantId: tid, dealId, status: { in: CONTRACT_OPEN } },
  });
  if (existing) {
    if (existing.status !== "DRAFT") {
      return { contract: serializeContract(existing), reused: true };
    }
    const { deal, items } = await loadDealBundle(prisma, tid, dealId);
    const totals = moneyFromItems(items);
    const updated = await prisma.contract.update({
      where: { id: existing.id },
      data: {
        companyId: deal.companyId,
        subject: input.subject !== undefined ? input.subject?.trim() || deal.title : existing.subject,
        paymentTerms:
          input.paymentTerms !== undefined ? input.paymentTerms?.trim() || null : existing.paymentTerms,
        completionTerms:
          input.completionTerms !== undefined ? input.completionTerms?.trim() || null : existing.completionTerms,
        amountWithoutVat: totals.amountWithoutVat,
        vatRate: totals.vatRate,
        vatAmount: totals.vatAmount,
        totalAmount: totals.totalAmount,
        currency: deal.currency || existing.currency,
      },
    });
    return { contract: serializeContract(updated), reused: true };
  }

  const { deal, items } = await loadDealBundle(prisma, tid, dealId);
  const totals = moneyFromItems(items);
  const count = await prisma.contract.count({ where: { tenantId: tid } });
  const created = await prisma.$transaction(async (tx) => {
    const contract = await tx.contract.create({
      data: {
        tenantId: tid,
        dealId,
        companyId: deal.companyId,
        number: await nextNumber(prisma, tid, "DOG", count),
        subject: input.subject?.trim() || deal.title,
        amountWithoutVat: totals.amountWithoutVat,
        vatRate: totals.vatRate,
        vatAmount: totals.vatAmount,
        totalAmount: totals.totalAmount,
        currency: deal.currency || "KZT",
        paymentTerms: input.paymentTerms?.trim() || null,
        completionTerms: input.completionTerms?.trim() || null,
        status: "DRAFT",
        createdByUserId: auth.user.id,
      },
    });
    await tx.contractVersion.create({
      data: { tenantId: tid, contractId: contract.id, version: 1 },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: tid,
        actorUserId: auth.user.id,
        action: "contract.create_draft",
        entityType: "contract",
        entityId: contract.id,
        changesJson: { dealId, number: contract.number },
      },
    });
    return contract;
  });
  return { contract: serializeContract(created), reused: false };
}

export async function getContract(prisma: PrismaClient, auth: AuthContext, contractId: string) {
  const membership = requireTenant(auth);
  const row = await prisma.contract.findFirst({
    where: { id: contractId, tenantId: membership.tenantId },
    include: { versions: { orderBy: { version: "asc" } } },
  });
  if (!row) throw new ApiError(404, "not_found", "Договор не найден");
  return {
    contract: serializeContract(row),
    versions: row.versions.map((v) => ({
      id: v.id,
      version: v.version,
      sha256: v.sha256,
      fileId: v.fileId,
      createdAt: v.createdAt.toISOString(),
    })),
  };
}

export async function createOrReuseInvoiceDraft(
  prisma: PrismaClient,
  input: {
    tenantId: string;
    dealId: string;
    contractId?: string | null;
    dueDate?: string | null;
    actorUserId?: string | null;
  },
) {
  const tid = input.tenantId;
  const existing = await prisma.invoice.findFirst({
    where: { tenantId: tid, dealId: input.dealId, status: { in: INVOICE_OPEN } },
    include: { items: { orderBy: { sortOrder: "asc" } } },
  });
  if (existing) {
    if (existing.status !== "DRAFT") {
      return { invoice: serializeInvoice(existing), reused: true };
    }
    const { deal, items } = await loadDealBundle(prisma, tid, input.dealId);
    const totals = moneyFromItems(items);
    const updated = await prisma.$transaction(async (tx) => {
      await tx.invoiceItem.deleteMany({ where: { tenantId: tid, invoiceId: existing.id } });
      await tx.invoiceItem.createMany({
        data: mapDealItemsToInvoiceItems(items, tid, existing.id),
      });
      return tx.invoice.update({
        where: { id: existing.id },
        data: {
          contractId: input.contractId || existing.contractId,
          companyId: deal.companyId,
          dueDate:
            input.dueDate !== undefined
              ? input.dueDate
                ? new Date(input.dueDate)
                : null
              : existing.dueDate,
          currency: deal.currency || existing.currency,
          amountWithoutVat: totals.amountWithoutVat,
          vatRate: totals.vatRate,
          vatAmount: totals.vatAmount,
          totalAmount: totals.totalAmount,
        },
        include: { items: { orderBy: { sortOrder: "asc" } } },
      });
    });
    return { invoice: serializeInvoice(updated), reused: true };
  }

  const { deal, items } = await loadDealBundle(prisma, tid, input.dealId);
  const totals = moneyFromItems(items);
  const count = await prisma.invoice.count({ where: { tenantId: tid } });
  const created = await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.create({
      data: {
        tenantId: tid,
        dealId: input.dealId,
        contractId: input.contractId || null,
        companyId: deal.companyId,
        number: await nextNumber(prisma, tid, "INV", count),
        dueDate: input.dueDate ? new Date(input.dueDate) : null,
        currency: deal.currency || "KZT",
        amountWithoutVat: totals.amountWithoutVat,
        vatRate: totals.vatRate,
        vatAmount: totals.vatAmount,
        totalAmount: totals.totalAmount,
        status: "DRAFT",
        createdByUserId: input.actorUserId || null,
      },
    });
    await tx.invoiceItem.createMany({
      data: mapDealItemsToInvoiceItems(items, tid, invoice.id),
    });
    await tx.auditEvent.create({
      data: {
        tenantId: tid,
        actorUserId: input.actorUserId || null,
        action: "invoice.create_draft",
        entityType: "invoice",
        entityId: invoice.id,
        changesJson: { dealId: input.dealId, number: invoice.number },
      },
    });
    return tx.invoice.findFirstOrThrow({
      where: { id: invoice.id, tenantId: tid },
      include: { items: { orderBy: { sortOrder: "asc" } } },
    });
  });
  return { invoice: serializeInvoice(created), reused: false };
}

export async function createInvoiceDraft(
  prisma: PrismaClient,
  auth: AuthContext,
  dealId: string,
  input: { contractId?: string; dueDate?: string | null },
) {
  const membership = requireTenant(auth);
  requireManageDocuments(auth);
  const tid = membership.tenantId;
  await requireDocumentsEnabled(prisma, tid);

  let contractId = input.contractId || null;
  if (contractId) {
    const contract = await prisma.contract.findFirst({
      where: { id: contractId, tenantId: tid, dealId },
    });
    if (!contract) throw new ApiError(404, "not_found", "Договор не найден");
  } else {
    const signed = await prisma.contract.findFirst({
      where: { tenantId: tid, dealId, status: "SIGNED" },
      orderBy: { signedAt: "desc" },
      select: { id: true },
    });
    contractId = signed?.id || null;
  }

  return createOrReuseInvoiceDraft(prisma, {
    tenantId: tid,
    dealId,
    contractId,
    dueDate: input.dueDate,
    actorUserId: auth.user.id,
  });
}

export async function getInvoice(prisma: PrismaClient, auth: AuthContext, invoiceId: string) {
  const membership = requireTenant(auth);
  const row = await prisma.invoice.findFirst({
    where: { id: invoiceId, tenantId: membership.tenantId },
    include: { items: { orderBy: { sortOrder: "asc" } } },
  });
  if (!row) throw new ApiError(404, "not_found", "Счёт не найден");
  return { invoice: serializeInvoice(row) };
}

export async function createElectronicDocumentDraft(
  prisma: PrismaClient,
  auth: AuthContext,
  dealId: string,
  input: { type: "AVR" | "ESF"; contractId?: string; invoiceId?: string },
) {
  if (input.type === "AVR") {
    const { createAvrDraft } = await import("./avrService.ts");
    return createAvrDraft(prisma, auth, dealId, input);
  }
  if (input.type === "ESF") {
    const { createEsfDraft } = await import("./esfInvoiceService.ts");
    return createEsfDraft(prisma, auth, dealId, input);
  }
  const membership = requireTenant(auth);
  requireManageDocuments(auth);
  const tid = membership.tenantId;
  await requireDocumentsEnabled(prisma, tid);

  const existing = await prisma.electronicDocument.findFirst({
    where: { tenantId: tid, dealId, type: input.type, status: { in: EDOC_OPEN } },
  });
  if (existing) return { document: serializeElectronicDocument(existing), reused: true };

  const { deal, items } = await loadDealBundle(prisma, tid, dealId);
  const totals = moneyFromItems(items);
  if (input.contractId) {
    const contract = await prisma.contract.findFirst({
      where: { id: input.contractId, tenantId: tid, dealId },
    });
    if (!contract) throw new ApiError(404, "not_found", "Договор не найден");
  }
  if (input.invoiceId) {
    const invoice = await prisma.invoice.findFirst({
      where: { id: input.invoiceId, tenantId: tid, dealId },
    });
    if (!invoice) throw new ApiError(404, "not_found", "Счёт не найден");
  }
  const count = await prisma.electronicDocument.count({ where: { tenantId: tid, type: input.type } });
  const prefix = input.type === "AVR" ? "AVR" : "ESF";
  const created = await prisma.electronicDocument.create({
    data: {
      tenantId: tid,
      type: input.type,
      dealId,
      contractId: input.contractId || null,
      invoiceId: input.invoiceId || null,
      companyId: deal.companyId,
      number: await nextNumber(prisma, tid, prefix, count),
      amountWithoutVat: totals.amountWithoutVat,
      vatAmount: totals.vatAmount,
      totalAmount: totals.totalAmount,
      currency: deal.currency || "KZT",
      status: "DRAFT",
      sourceDataJson: { itemIds: items.map((item) => item.id) },
      createdByUserId: auth.user.id,
    },
  });
  await prisma.auditEvent.create({
    data: {
      tenantId: tid,
      actorUserId: auth.user.id,
      action: "electronic_document.create_draft",
      entityType: "electronic_document",
      entityId: created.id,
      changesJson: { dealId, type: input.type, number: created.number },
    },
  });
  return { document: serializeElectronicDocument(created), reused: false };
}

export async function getElectronicDocument(prisma: PrismaClient, auth: AuthContext, id: string) {
  const membership = requireTenant(auth);
  const row = await prisma.electronicDocument.findFirst({
    where: { id, tenantId: membership.tenantId },
  });
  if (!row) throw new ApiError(404, "not_found", "Документ не найден");
  return { document: serializeElectronicDocument(row) };
}
