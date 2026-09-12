import type { PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import { can, type AuthContext } from "../lib/types.ts";
import { serializeDealItem } from "./dealItemService.ts";
import { serializeElectronicDocument } from "./documentDraftService.ts";
import { assessEsfInvoiceReadiness, esfInvoiceMissingFieldsError } from "./esfInvoiceReadiness.ts";
import { mapEsfInvoiceSource, resolveCatalogTruId } from "./esfInvoiceMapper.ts";
import { requireDocumentsEnabled } from "./legalProfileService.ts";

const MUTABLE = new Set(["DRAFT", "VALIDATED"]);

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership;
}

function requireManageDocuments(auth: AuthContext) {
  if (!can(auth, "manage_documents")) {
    throw new ApiError(403, "forbidden", "Недостаточно прав для документов");
  }
}

async function nextEsfNumber(prisma: PrismaClient, tenantId: string) {
  const count = await prisma.electronicDocument.count({ where: { tenantId, type: "ESF" } });
  return `ESF-${new Date().getFullYear()}-${String(count + 1).padStart(4, "0")}`;
}

async function loadBundle(prisma: PrismaClient, tenantId: string, dealId: string) {
  const deal = await prisma.deal.findFirst({
    where: { id: dealId, tenantId },
    include: { items: { orderBy: { sortOrder: "asc" } }, company: true },
  });
  if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");
  const [profile, tenant] = await Promise.all([
    prisma.tenantLegalProfile.findUnique({ where: { tenantId } }),
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
  ]);
  return {
    deal,
    items: deal.items.map(serializeDealItem),
    profile,
    tenantName: tenant?.name || null,
  };
}

async function resolveLinks(
  prisma: PrismaClient,
  tenantId: string,
  dealId: string,
  input: { contractId?: string | null; invoiceId?: string | null },
) {
  let contract = null;
  if (input.contractId) {
    contract = await prisma.contract.findFirst({
      where: { id: input.contractId, tenantId, dealId },
    });
    if (!contract) throw new ApiError(404, "not_found", "Договор не найден");
  } else {
    contract = await prisma.contract.findFirst({
      where: { tenantId, dealId, status: "SIGNED" },
      orderBy: { signedAt: "desc" },
    });
  }

  let invoice = null;
  if (input.invoiceId) {
    invoice = await prisma.invoice.findFirst({
      where: { id: input.invoiceId, tenantId, dealId },
    });
    if (!invoice) throw new ApiError(404, "not_found", "Счёт не найден");
  } else {
    invoice = await prisma.invoice.findFirst({
      where: { tenantId, dealId },
      orderBy: { createdAt: "desc" },
    });
  }

  return { contract, invoice };
}

export async function createEsfDraft(
  prisma: PrismaClient,
  auth: AuthContext,
  dealId: string,
  input: { contractId?: string; invoiceId?: string } = {},
) {
  const membership = requireTenant(auth);
  requireManageDocuments(auth);
  const tid = membership.tenantId;
  await requireDocumentsEnabled(prisma, tid);

  const { contract, invoice } = await resolveLinks(prisma, tid, dealId, input);
  const existing = await prisma.electronicDocument.findFirst({
    where: { tenantId: tid, dealId, type: "ESF", status: { in: ["DRAFT", "VALIDATED", "SIGNED", "SENT"] } },
  });
  if (existing && existing.status !== "DRAFT") {
    return { document: serializeElectronicDocument(existing), reused: true };
  }

  const { deal, items, profile, tenantName } = await loadBundle(prisma, tid, dealId);
  if (!items.length) {
    throw new ApiError(422, "deal_items_required", "Сначала добавьте позиции в сделку");
  }
  const number = existing?.number || (await nextEsfNumber(prisma, tid));
  const source = mapEsfInvoiceSource({
    documentDate: existing?.documentDate || new Date(),
    number,
    currency: deal.currency || "KZT",
    deal,
    items,
    defaultCatalogTruId: profile?.defaultCatalogTruId,
    profile,
    tenantName,
    company: deal.company,
    contract,
    invoice,
  });

  if (existing) {
    const updated = await prisma.electronicDocument.update({
      where: { id: existing.id },
      data: {
        contractId: contract?.id || existing.contractId,
        invoiceId: invoice?.id || existing.invoiceId,
        companyId: deal.companyId,
        amountWithoutVat: source.totals.amountWithoutVat,
        vatAmount: source.totals.vatAmount,
        totalAmount: source.totals.totalAmount,
        currency: source.totals.currency,
        sourceDataJson: source,
        errorCode: null,
        errorMessage: null,
      },
    });
    return { document: serializeElectronicDocument(updated), reused: true };
  }

  const created = await prisma.electronicDocument.create({
    data: {
      tenantId: tid,
      type: "ESF",
      dealId,
      contractId: contract?.id || null,
      invoiceId: invoice?.id || null,
      companyId: deal.companyId,
      number,
      amountWithoutVat: source.totals.amountWithoutVat,
      vatAmount: source.totals.vatAmount,
      totalAmount: source.totals.totalAmount,
      currency: source.totals.currency,
      status: "DRAFT",
      sourceDataJson: source,
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
      changesJson: { dealId, type: "ESF", number: created.number },
    },
  });
  return { document: serializeElectronicDocument(created), reused: false };
}

export async function validateEsfInvoice(prisma: PrismaClient, auth: AuthContext, documentId: string) {
  const membership = requireTenant(auth);
  requireManageDocuments(auth);
  const tid = membership.tenantId;
  await requireDocumentsEnabled(prisma, tid);

  const document = await prisma.electronicDocument.findFirst({
    where: { id: documentId, tenantId: tid },
  });
  if (!document) throw new ApiError(404, "not_found", "Документ не найден");
  if (document.type !== "ESF") {
    throw new ApiError(422, "not_esf", "Эта проверка только для ЭСФ");
  }
  if (!MUTABLE.has(document.status)) {
    throw new ApiError(422, "esf_immutable", "ЭСФ уже отправлен — проверку менять нельзя");
  }

  const { deal, items, profile, tenantName } = await loadBundle(prisma, tid, document.dealId);
  const { contract, invoice } = await resolveLinks(prisma, tid, document.dealId, {
    contractId: document.contractId,
    invoiceId: document.invoiceId,
  });
  const signed =
    contract?.status === "SIGNED"
      ? contract
      : await prisma.contract.findFirst({
          where: { tenantId: tid, dealId: document.dealId, status: "SIGNED" },
          orderBy: { signedAt: "desc" },
        });
  const catalogTruId =
    items.map((item) => resolveCatalogTruId(item, profile?.defaultCatalogTruId)).find(Boolean) ||
    profile?.defaultCatalogTruId ||
    "";
  const readiness = assessEsfInvoiceReadiness({
    dealId: deal.id,
    contractId: document.contractId,
    documentId: document.id,
    signedContractId: signed?.id || null,
    invoiceId: invoice?.id || document.invoiceId,
    contractNumber: signed?.number || null,
    contractDate: signed?.date || null,
    itemCount: items.length,
    profile,
    company: deal.company,
    catalogTruId,
    outgoingNum: document.number,
    avrExternalId: "skip",
  });
  if (!readiness.ready) throw esfInvoiceMissingFieldsError(readiness);

  const source = mapEsfInvoiceSource({
    documentDate: document.documentDate,
    number: document.number,
    currency: deal.currency || "KZT",
    deal,
    items,
    defaultCatalogTruId: profile?.defaultCatalogTruId,
    profile,
    tenantName,
    company: deal.company,
    contract: signed,
    invoice,
  });

  const updated = await prisma.electronicDocument.update({
    where: { id: document.id },
    data: {
      contractId: signed!.id,
      invoiceId: invoice?.id || document.invoiceId,
      companyId: deal.companyId,
      amountWithoutVat: source.totals.amountWithoutVat,
      vatAmount: source.totals.vatAmount,
      totalAmount: source.totals.totalAmount,
      currency: source.totals.currency,
      status: "VALIDATED",
      sourceDataJson: source,
      validatedAt: new Date(),
      errorCode: null,
      errorMessage: null,
    },
  });
  await prisma.auditEvent.create({
    data: {
      tenantId: tid,
      actorUserId: auth.user.id,
      action: "electronic_document.validate",
      entityType: "electronic_document",
      entityId: updated.id,
      changesJson: { type: "ESF", number: updated.number },
    },
  });
  return {
    document: serializeElectronicDocument(updated),
    ready: true,
    missingFields: [] as string[],
  };
}
