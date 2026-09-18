import {
  ESF_DEFAULT_MEASURE_UNIT_CODE,
  invoicePayableTotals,
  updateInvoiceDraftSchema,
  type InvoiceEditorInput,
} from "@creolab/contracts";
import type { PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import { can, type AuthContext } from "../lib/types.ts";
import { applyInvoiceEditor, serializeInvoice } from "./documentDraftService.ts";
import { documentOrganization } from "./documentOrganization.ts";
import { assessInvoiceReadiness } from "./invoiceReadiness.ts";
import { getLegalProfile, requireDocumentsEnabled } from "./legalProfileService.ts";
import { serializeDealItem } from "./dealItemService.ts";
import { asMoney } from "./documentMoney.ts";

const MUTABLE = new Set(["DRAFT", "ISSUED"]);

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership;
}

async function workflowAccess(prisma: PrismaClient, auth: AuthContext) {
  const membership = requireTenant(auth);
  if (!can(auth, "manage_documents")) {
    throw new ApiError(403, "forbidden", "Недостаточно прав для документов");
  }
  await requireDocumentsEnabled(prisma, membership.tenantId);
  return membership;
}

function defaultKbe(bin?: string | null, iin?: string | null) {
  return String(bin || "").trim() ? "17" : String(iin || "").trim() ? "19" : "17";
}

function toEditor(invoice: ReturnType<typeof serializeInvoice>): InvoiceEditorInput {
  return {
    documentDate: invoice.date.slice(0, 10),
    paymentPercent: invoice.paymentPercent || 100,
    items: (invoice.items || []).map((item) => ({
      name: item.name || "",
      quantity: item.quantity,
      unit: item.unit,
      unitPrice: item.unitPrice,
      vatRate: item.vatRate ?? 0,
    })),
  };
}

export async function listInvoiceEligibleDeals(
  prisma: PrismaClient,
  auth: AuthContext,
  query: Record<string, unknown> = {},
) {
  const membership = await workflowAccess(prisma, auth);
  const tid = membership.tenantId;
  const deals = await prisma.deal.findMany({
    where: {
      tenantId: tid,
      outcome: { not: "lost" },
      ...(query.scope === "mine"
        ? { assigneeMembershipId: membership.id }
        : query.scope === "unassigned"
          ? { assigneeMembershipId: null }
          : {}),
    },
    include: {
      company: true,
      contact: true,
      stage: true,
      assignee: { include: { user: { select: { name: true } } } },
      items: true,
      contracts: { where: { status: "SIGNED" }, orderBy: { signedAt: "desc" }, take: 1, select: { id: true } },
      invoices: {
        where: { status: { in: ["DRAFT", "ISSUED", "PARTIALLY_PAID"] } },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true, status: true, totalAmount: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });
  const profile = await prisma.tenantLegalProfile.findUnique({ where: { tenantId: tid } });
  const items = deals
    .map((deal) => {
      const invoice = deal.invoices[0] || null;
      const itemCount = deal.items.length || (deal.title && Number(deal.offerAmountMinor) > 0 ? 1 : 0);
      const readiness = assessInvoiceReadiness({
        dealId: deal.id,
        contractId: deal.contracts[0]?.id || null,
        invoiceId: invoice?.id || null,
        signedContractId: deal.contracts[0]?.id || null,
        itemCount,
        profile,
        company: deal.company,
      });
      const amount = deal.items.length
        ? invoicePayableTotals(
            deal.items.map((item) => ({
              name: item.name,
              quantity: asMoney(item.quantity),
              unit: item.unit,
              unitPrice: asMoney(item.unitPrice),
              vatRate: asMoney(item.vatRate),
            })),
            100,
          ).items.totals.totalAmount
        : Number(deal.offerAmountMinor || 0);
      const reasons = [...readiness.missingFields.map((field) => readiness.missingFieldLabels[field])];
      if (amount <= 0) reasons.push("Не указана сумма сделки");
      return {
        id: deal.id,
        number: deal.id.slice(0, 8).toUpperCase(),
        title: deal.title,
        companyId: deal.companyId,
        companyName: deal.company?.name || null,
        contactName: deal.contact.name,
        amount,
        currency: deal.currency,
        stage: deal.stage.name,
        paymentStatus: deal.paymentStatus,
        responsible: deal.assignee?.user.name || null,
        ready: reasons.length === 0,
        reasons,
        invoiceId: invoice?.id || null,
        invoiceStatus: invoice?.status || null,
      };
    })
    .filter(
      (deal) =>
        !query.q ||
        `${deal.title} ${deal.companyName} ${deal.number}`.toLowerCase().includes(String(query.q).toLowerCase()),
    )
    .sort((a, b) => Number(b.ready) - Number(a.ready));
  return { items: query.filter === "ready" ? items.filter((deal) => deal.ready) : items, total: items.length };
}

export async function getInvoiceEditorContext(prisma: PrismaClient, auth: AuthContext, dealId: string) {
  const membership = await workflowAccess(prisma, auth);
  const deal = await prisma.deal.findFirst({
    where: { id: dealId, tenantId: membership.tenantId },
    include: {
      company: true,
      contact: true,
      assignee: { include: { user: { select: { name: true } } } },
      items: { orderBy: { sortOrder: "asc" } },
      contracts: { orderBy: { createdAt: "desc" }, take: 1 },
      invoices: {
        where: { status: { in: ["DRAFT", "ISSUED", "PARTIALLY_PAID"] } },
        orderBy: { createdAt: "desc" },
        take: 1,
        include: { items: { orderBy: { sortOrder: "asc" } } },
      },
    },
  });
  if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");
  const profile = await documentOrganization(prisma, membership.tenantId, deal.id, deal.contracts[0]?.id);
  const legal = await getLegalProfile(prisma, auth);
  const items = deal.items.map(serializeDealItem);
  const fallback =
    !items.length && Number(deal.offerAmountMinor) > 0
      ? [
          {
            name: deal.title,
            quantity: 1,
            unit: ESF_DEFAULT_MEASURE_UNIT_CODE,
            unitPrice: Number(deal.offerAmountMinor),
            vatRate: 0,
          },
        ]
      : [];
  const invoice = deal.invoices[0] ? serializeInvoice(deal.invoices[0]) : null;
  const settings = (await prisma.tenant.findUnique({
    where: { id: membership.tenantId },
    select: { settingsJson: true },
  }))?.settingsJson as { documents?: { kbe?: string; knp?: string } } | null;
  return {
    deal: {
      id: deal.id,
      title: deal.title,
      number: deal.id.slice(0, 8).toUpperCase(),
      contactId: deal.contactId,
      contactName: deal.contact.name,
      companyId: deal.companyId,
      responsible: deal.assignee?.user.name || null,
    },
    company: deal.company,
    organization: {
      ...profile,
      phone: legal.phone,
      email: legal.email,
      hasStamp: legal.hasStamp,
      hasSignature: legal.hasSignature,
      directorBasis: legal.directorBasis,
      kbe: settings?.documents?.kbe || defaultKbe(profile?.bin, profile?.iin),
      knp: settings?.documents?.knp || "859",
    },
    contract: deal.contracts[0] || null,
    items: items.length ? items : fallback,
    invoice,
    existingInvoiceId: invoice?.id || null,
    editor: invoice ? toEditor(invoice) : null,
  };
}

export async function updateInvoiceDraft(
  prisma: PrismaClient,
  auth: AuthContext,
  invoiceId: string,
  body: unknown,
) {
  const membership = await workflowAccess(prisma, auth);
  const parsed = updateInvoiceDraftSchema.parse(body);
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, tenantId: membership.tenantId },
    include: { items: { orderBy: { sortOrder: "asc" } } },
  });
  if (!invoice) throw new ApiError(404, "not_found", "Счёт не найден");
  if (!MUTABLE.has(invoice.status)) {
    throw new ApiError(422, "invoice_immutable", "Счёт уже оплачен, просрочен или отменён");
  }
  const imported = invoice.pdfFileId
    ? await prisma.attachment.findFirst({
        where: {
          id: invoice.pdfFileId,
          tenantId: membership.tenantId,
          parentType: "invoice",
          parentId: invoice.id,
          status: "imported",
        },
        select: { id: true },
      })
    : null;
  if (imported) {
    throw new ApiError(422, "imported_pdf_immutable", "Загруженный PDF счёта сохраняется в исходном виде.");
  }
  if (parsed.updatedAt && invoice.updatedAt.toISOString() !== parsed.updatedAt) {
    throw new ApiError(409, "version_conflict", "Счёт изменился, обновите страницу");
  }
  const result = await applyInvoiceEditor(prisma, membership.tenantId, invoice.id, parsed, {
    actorUserId: auth.user.id,
  });
  await prisma.auditEvent.create({
    data: {
      tenantId: membership.tenantId,
      actorUserId: auth.user.id,
      action: "invoice.update_draft",
      entityType: "invoice",
      entityId: invoice.id,
      changesJson: { paymentPercent: parsed.paymentPercent, itemCount: parsed.items.length },
    },
  });
  return result;
}
