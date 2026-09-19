import type { PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import { can } from "../lib/types.ts";
import type { AuthContext } from "../lib/types.ts";
import { asMoney, sumLines } from "./documentMoney.ts";
import { serializeDealItem } from "./dealItemService.ts";
import { requireDocumentsEnabled } from "./legalProfileService.ts";
import { inferInvoicePaymentPercent, invoicePayableTotals, type InvoiceEditorInput } from "@creolab/contracts";

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

function invoiceContractBasis(editor?: InvoiceEditorInput) {
  if (editor?.withoutContract) {
    return { withoutContract: true, contractNumber: null, contractDate: null };
  }
  const contractNumber = String(editor?.contractNumber || "").trim() || null;
  const contractDate = editor?.contractDate ? new Date(`${editor.contractDate}T00:00:00.000Z`) : null;
  return { withoutContract: false, contractNumber, contractDate };
}

async function syncUnsignedContractBasis(
  tx: { contract: PrismaClient["contract"] },
  input: { tenantId: string; dealId: string; contractId?: string | null; number: string | null; date: Date | null },
) {
  if (!input.number && !input.date) return input.contractId || null;
  const contract = input.contractId
    ? await tx.contract.findFirst({ where: { id: input.contractId, tenantId: input.tenantId, dealId: input.dealId } })
    : await tx.contract.findFirst({ where: { tenantId: input.tenantId, dealId: input.dealId }, orderBy: { createdAt: "desc" } });
  if (!contract || contract.status === "SIGNED") return contract?.id || input.contractId || null;
  const nextNumber = input.number || contract.number;
  if (nextNumber !== contract.number) {
    const clash = await tx.contract.findFirst({ where: { tenantId: input.tenantId, number: nextNumber, id: { not: contract.id } }, select: { id: true } });
    if (clash) return contract.id;
  }
  await tx.contract.update({
    where: { id: contract.id },
    data: {
      number: nextNumber,
      ...(input.date ? { date: input.date } : {}),
    },
  });
  return contract.id;
}

function moneyFromItems(items: Array<ReturnType<typeof serializeDealItem>>) {
  if (!items.length) {
    throw new ApiError(422, "deal_items_required", "Сначала добавьте позиции в сделку");
  }
  return sumLines(items);
}

export function mapEditorToInvoiceItems(editor: InvoiceEditorInput, tenantId: string, invoiceId: string) {
  const amounts = invoicePayableTotals(editor.items, editor.paymentPercent).items;
  return editor.items.map((item, sortOrder) => ({
    tenantId,
    invoiceId,
    dealItemId: null as string | null,
    name: item.name,
    description: null as string | null,
    quantity: item.quantity,
    unit: item.unit,
    unitPrice: item.unitPrice,
    amountWithoutVat: amounts.rows[sortOrder].amountWithoutVat,
    vatRate: item.vatRate,
    vatAmount: amounts.rows[sortOrder].vatAmount,
    totalAmount: amounts.rows[sortOrder].totalAmount,
    sortOrder,
  }));
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
  generatedMimeType?: string | null;
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
    generatedMimeType: row.generatedMimeType ?? null,
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
  contractNumber?: string | null;
  contractDate?: Date | null;
  withoutContract?: boolean | null;
  updatedAt?: Date;
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
    paymentPercent: inferInvoicePaymentPercent(
      asMoney(row.totalAmount),
      (row.items || []).reduce((sum, item) => sum + asMoney(item.totalAmount), 0),
    ),
    status: row.status,
    pdfFileId: row.pdfFileId ?? null,
    contractNumber: row.contractNumber || "",
    contractDate: row.contractDate ? row.contractDate.toISOString().slice(0, 10) : "",
    withoutContract: Boolean(row.withoutContract),
    updatedAt: row.updatedAt?.toISOString() || null,
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
  updatedAt?: Date;
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
    updatedAt: row.updatedAt?.toISOString() || null,
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
  requireManageDocuments(auth);
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
  const { importedInvoiceDetails } = await import("./importedInvoiceDetails.ts");
  const importDetails = await importedInvoiceDetails(prisma, tid, invoices.map(i=>i.id));
  const originals = await prisma.attachment.findMany({
    where: {
      tenantId: tid,
      id: { in: contracts.flatMap((c) => [c.originalFileId, c.generatedFileId].filter(Boolean) as string[]) },
    },
    select: { id: true, originalFileName: true, mimeType: true },
  });
  return {
    contracts: contracts.map((row) => ({
      ...serializeContract({
        ...row,
        generatedMimeType: originals.find((f) => f.id === row.generatedFileId)?.mimeType || null,
      }),
      originalFileName: originals.find((f) => f.id === row.originalFileId)?.originalFileName || null,
    })),
    invoices: invoices.map(row => ({ ...serializeInvoice(row), importDetails: importDetails.get(row.id) || null, importedPdf: Boolean(row.pdfFileId && importedIds.has(row.pdfFileId)) })),
    electronicDocuments: electronicDocuments.map(serializeElectronicDocument),
    documentState: (await import("./documentWorkflow.ts")).documentWorkflowState(electronicDocuments),
  };
}

async function resolveTemplateId(prisma: PrismaClient, tenantId: string, templateId?: string | null) {
  if (!templateId) return undefined;
  const template = await prisma.contractTemplate.findFirst({ where: { id: templateId, tenantId } });
  if (!template) throw new ApiError(404, "not_found", "Шаблон не найден");
  return template.id;
}

export async function createContractDraft(
  prisma: PrismaClient,
  auth: AuthContext,
  dealId: string,
  input: {
    subject?: string | null;
    paymentTerms?: string | null;
    completionTerms?: string | null;
    templateId?: string | null;
  },
) {
  const membership = requireTenant(auth);
  requireManageDocuments(auth);
  const tid = membership.tenantId;
  await requireDocumentsEnabled(prisma, tid);
  const templateId = await resolveTemplateId(prisma, tid, input.templateId);
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
        ...(templateId ? { templateId } : {}),
      },
    });
    return { contract: serializeContract(updated), reused: true };
  }

  const { deal, items } = await loadDealBundle(prisma, tid, dealId);
  const totals = moneyFromItems(items);
  const created = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tid} FOR UPDATE`;
    const count = await tx.contract.count({ where: { tenantId: tid } })
      + await tx.auditEvent.count({where:{tenantId:tid,entityType:"contract",action:"contract.delete"}});
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
        ...(templateId ? { templateId } : {}),
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
  requireManageDocuments(auth);
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
    editor?: InvoiceEditorInput;
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
    if (input.editor) {
      return applyInvoiceEditor(prisma, tid, existing.id, input.editor, {
        contractId: input.contractId || existing.contractId,
        dueDate: input.dueDate,
        actorUserId: input.actorUserId,
      });
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

  const { deal, items: dealItems } = await loadDealBundle(prisma, tid, input.dealId);
  const editor = input.editor;
  const sourceItems = editor?.items.length ? editor.items : dealItems;
  if (!sourceItems.length && !editor) {
    throw new ApiError(422, "deal_items_required", "Сначала добавьте позиции в сделку");
  }
  const payable = editor
    ? invoicePayableTotals(editor.items, editor.paymentPercent).payable
    : moneyFromItems(dealItems);
  const vatRate = editor
    ? invoicePayableTotals(editor.items, editor.paymentPercent).items.rows.length
      ? editor.items.every((item) => item.vatRate === editor.items[0].vatRate)
        ? editor.items[0].vatRate
        : null
      : null
    : moneyFromItems(dealItems).vatRate;
  const totals = editor ? { ...payable, vatRate } : moneyFromItems(dealItems);
  const count = await prisma.invoice.count({ where: { tenantId: tid } });
  const created = await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.create({
      data: {
        tenantId: tid,
        dealId: input.dealId,
        contractId: input.contractId || null,
        companyId: deal.companyId,
        number: await nextNumber(prisma, tid, "INV", count),
        date: editor ? new Date(`${editor.documentDate}T00:00:00.000Z`) : undefined,
        dueDate: input.dueDate ? new Date(input.dueDate) : null,
        currency: deal.currency || "KZT",
        amountWithoutVat: totals.amountWithoutVat,
        vatRate: totals.vatRate,
        vatAmount: totals.vatAmount,
        totalAmount: totals.totalAmount,
        status: "DRAFT",
        createdByUserId: input.actorUserId || null,
        ...invoiceContractBasis(editor),
      },
    });
    await tx.invoiceItem.createMany({
      data: editor
        ? mapEditorToInvoiceItems(editor, tid, invoice.id)
        : mapDealItemsToInvoiceItems(dealItems, tid, invoice.id),
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

export async function applyInvoiceEditor(
  prisma: PrismaClient,
  tenantId: string,
  invoiceId: string,
  editor: InvoiceEditorInput,
  extra: { contractId?: string | null; dueDate?: string | null; actorUserId?: string | null } = {},
) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, tenantId },
    include: { items: { orderBy: { sortOrder: "asc" } } },
  });
  if (!invoice) throw new ApiError(404, "not_found", "Счёт не найден");
  const computed = invoicePayableTotals(editor.items, editor.paymentPercent);
  const vatRate = editor.items.length && editor.items.every((item) => item.vatRate === editor.items[0].vatRate)
    ? editor.items[0].vatRate
    : null;
  const basis = invoiceContractBasis(editor);
  const updated = await prisma.$transaction(async (tx) => {
    await tx.invoiceItem.deleteMany({ where: { tenantId, invoiceId } });
    if (editor.items.length) {
      await tx.invoiceItem.createMany({ data: mapEditorToInvoiceItems(editor, tenantId, invoiceId) });
    }
    const contractId = await syncUnsignedContractBasis(tx, {
      tenantId,
      dealId: invoice.dealId,
      contractId: extra.contractId !== undefined ? extra.contractId : invoice.contractId,
      number: basis.contractNumber,
      date: basis.contractDate,
    });
    return tx.invoice.update({
      where: { id: invoiceId },
      data: {
        contractId: extra.contractId !== undefined ? extra.contractId : contractId || invoice.contractId,
        date: new Date(`${editor.documentDate}T00:00:00.000Z`),
        dueDate:
          extra.dueDate !== undefined
            ? extra.dueDate
              ? new Date(extra.dueDate)
              : null
            : invoice.dueDate,
        amountWithoutVat: computed.payable.amountWithoutVat,
        vatRate,
        vatAmount: computed.payable.vatAmount,
        totalAmount: computed.payable.totalAmount,
        status: invoice.status === "ISSUED" ? "DRAFT" : invoice.status,
        pdfFileId: invoice.status === "ISSUED" ? null : invoice.pdfFileId,
        contractNumber: basis.contractNumber,
        contractDate: basis.contractDate,
        withoutContract: basis.withoutContract,
      },
      include: { items: { orderBy: { sortOrder: "asc" } } },
    });
  });
  return { invoice: serializeInvoice(updated), reused: true };
}

export async function createInvoiceDraft(
  prisma: PrismaClient,
  auth: AuthContext,
  dealId: string,
  input: { contractId?: string; dueDate?: string | null; editor?: InvoiceEditorInput },
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
    const linked = await prisma.contract.findFirst({
      where: { tenantId: tid, dealId, status: "SIGNED" },
      orderBy: { signedAt: "desc" },
      select: { id: true },
    }) || await prisma.contract.findFirst({
      where: { tenantId: tid, dealId },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    contractId = linked?.id || null;
  }

  return createOrReuseInvoiceDraft(prisma, {
    tenantId: tid,
    dealId,
    contractId,
    dueDate: input.dueDate,
    actorUserId: auth.user.id,
    editor: input.editor,
  });
}

export async function getInvoice(prisma: PrismaClient, auth: AuthContext, invoiceId: string) {
  const membership = requireTenant(auth);
  requireManageDocuments(auth);
  const row = await prisma.invoice.findFirst({
    where: { id: invoiceId, tenantId: membership.tenantId },
    include: { items: { orderBy: { sortOrder: "asc" } } },
  });
  if (!row) throw new ApiError(404, "not_found", "Счёт не найден");
  const { importedInvoiceDetails } = await import("./importedInvoiceDetails.ts");
  const details = await importedInvoiceDetails(prisma, membership.tenantId, [row.id]);
  return { invoice: { ...serializeInvoice(row), importDetails: details.get(row.id) || null } };
}

export async function createElectronicDocumentDraft(
  prisma: PrismaClient,
  auth: AuthContext,
  dealId: string,
  input: { type: "AVR" | "ESF"; contractId?: string; invoiceId?: string; editor?: import("@creolab/contracts").AvrEditorInput },
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
  requireManageDocuments(auth);
  const row = await prisma.electronicDocument.findFirst({
    where: { id, tenantId: membership.tenantId },
  });
  if (!row) throw new ApiError(404, "not_found", "Документ не найден");
  return { document: serializeElectronicDocument(row) };
}
