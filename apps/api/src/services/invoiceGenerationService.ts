import { assertFileCapacity } from "./billingResourceService.ts";
import { documentOrganization } from "./documentOrganization.ts";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@creolab/db";
import type { Response } from "express";
import { inferInvoicePaymentPercent, invoicePayableTotals } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { can, type AuthContext } from "../lib/types.ts";
import { requireDocumentsAccess } from "../lib/access.ts";
import { resolveUploadPath } from "../lib/storage.ts";
import { asMoney, sumLines } from "./documentMoney.ts";
import { serializeDealItem } from "./dealItemService.ts";
import { requireDocumentsEnabled } from "./legalProfileService.ts";
import { listInvoiceMarkFiles } from "./legalProfileService.ts";
import { mapDealItemsToInvoiceItems, serializeInvoice } from "./documentDraftService.ts";
import { assessInvoiceReadiness, invoiceMissingFieldsError } from "./invoiceReadiness.ts";
import { phoneFromContact } from "./contactLabels.ts";
import {
  invoicePdfContentDisposition,
  invoicePdfFileName,
  punchInvoiceStampBackground,
  renderInvoicePdf,
  type InvoicePdfInput,
} from "./invoicePdf.ts";

const MUTABLE_STATUSES = new Set(["DRAFT", "ISSUED"]);

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership;
}

function requireManageDocuments(auth: AuthContext) {
  if (!can(auth, "manage_documents")) {
    throw new ApiError(403, "forbidden", "Недостаточно прав для документов");
  }
}

function defaultDueDate(from: Date) {
  const due = new Date(from);
  due.setUTCDate(due.getUTCDate() + 7);
  return due;
}

function defaultKbe(bin?: string | null, iin?: string | null) {
  return String(bin || "").trim() ? "17" : String(iin || "").trim() ? "19" : "17";
}

type InvoiceRecord = Awaited<ReturnType<PrismaClient["invoice"]["findFirst"]>> & {
  items: Array<{
    name: string;
    quantity: { toString(): string } | number;
    unit: string;
    unitPrice: { toString(): string } | number;
    amountWithoutVat: { toString(): string } | number;
    vatRate: { toString(): string } | number;
    vatAmount: { toString(): string } | number;
    totalAmount: { toString(): string } | number;
    sortOrder: number;
  }>;
};

async function invoicePdfSnapshot(
  prisma: PrismaClient,
  tid: string,
  invoice: NonNullable<InvoiceRecord>,
  options: { requireReady?: boolean } = {},
): Promise<{ input: InvoicePdfInput; signedId: string | null; filename: string; itemCount: number; paymentPercent: number; itemTotals: ReturnType<typeof sumLines>; payable: ReturnType<typeof sumLines> }> {
  const deal = await prisma.deal.findFirst({
    where: { id: invoice.dealId, tenantId: tid },
    include: {
      items: { orderBy: { sortOrder: "asc" } },
      company: true,
      contact: { include: { methods: { select: { type: true, rawValue: true, normalizedValue: true, primary: true } } } },
    },
  });
  if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");

  const signed = invoice.contractId
    ? await prisma.contract.findFirst({
        where: { id: invoice.contractId, tenantId: tid, dealId: deal.id },
      })
    : await prisma.contract.findFirst({
        where: { tenantId: tid, dealId: deal.id, status: "SIGNED" },
        orderBy: { signedAt: "desc" },
      }) || await prisma.contract.findFirst({
        where: { tenantId: tid, dealId: deal.id },
        orderBy: { createdAt: "desc" },
      });

  const [profile, tenant, legal] = await Promise.all([
    documentOrganization(prisma, tid, deal.id, invoice.contractId || signed?.id),
    prisma.tenant.findUnique({ where: { id: tid }, select: { name: true, settingsJson: true } }),
    prisma.tenantLegalProfile.findUnique({ where: { tenantId: tid } }),
  ]);
  const settings = tenant?.settingsJson as { documents?: { kbe?: string; knp?: string }; contactPhone?: string; contactEmail?: string } | null;
  const invoiceItems = invoice.items.map((item) => ({
    name: item.name,
    quantity: asMoney(item.quantity),
    unit: item.unit,
    unitPrice: asMoney(item.unitPrice),
    amountWithoutVat: asMoney(item.amountWithoutVat),
    vatRate: asMoney(item.vatRate),
    vatAmount: asMoney(item.vatAmount),
    totalAmount: asMoney(item.totalAmount),
    sortOrder: item.sortOrder,
  }));
  const dealItems = deal.items.map(serializeDealItem);
  const items = invoiceItems.length ? invoiceItems : dealItems;
  const signedReady = signed?.status === "SIGNED" ? signed : null;
  if (options.requireReady) {
    const readiness = assessInvoiceReadiness({
      dealId: deal.id,
      contractId: signedReady?.id || invoice.contractId,
      invoiceId: invoice.id,
      signedContractId: signedReady?.id || null,
      itemCount: items.length,
      profile,
      company: deal.company,
    });
    if (!readiness.ready) throw invoiceMissingFieldsError(readiness);
  }

  const itemTotals = sumLines(items);
  const paymentPercent = inferInvoicePaymentPercent(asMoney(invoice.totalAmount), itemTotals.totalAmount);
  const computed = invoicePayableTotals(
    items.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      unit: item.unit,
      unitPrice: item.unitPrice,
      vatRate: item.vatRate,
    })),
    paymentPercent,
  );
  const payable = { ...computed.payable, vatRate: itemTotals.vatRate };

  const company = deal.company;
  const contactEmail =
    deal.contact?.methods?.find((item) => item.type === "email" && item.primary)?.rawValue ||
    deal.contact?.methods?.find((item) => item.type === "email")?.rawValue ||
    "";
  const input: InvoicePdfInput = {
    number: invoice.number,
    date: invoice.date,
    dueDate: invoice.dueDate,
    contractNumber: invoice.withoutContract ? "" : invoice.contractNumber || signed?.number || "",
    contractDate: invoice.withoutContract ? null : invoice.contractDate || signed?.date || null,
    withoutContract: Boolean(invoice.withoutContract),
    dealName: deal.title,
    amountWithoutVat: payable.amountWithoutVat,
    vatRate: payable.vatRate,
    vatAmount: payable.vatAmount,
    totalAmount: payable.totalAmount,
    itemsTotalWithoutVat: itemTotals.amountWithoutVat,
    itemsVatAmount: itemTotals.vatAmount,
    itemsTotalAmount: itemTotals.totalAmount,
    paymentPercent,
    sellerName: profile?.legalName || profile?.shortName || tenant?.name || "",
    sellerBin: profile?.bin || profile?.iin || "",
    sellerAddress: profile?.legalAddress || "",
    sellerPhone: legal?.phone || settings?.contactPhone || (profile as { phone?: string | null } | null)?.phone || "",
    sellerEmail: legal?.email || settings?.contactEmail || "",
    sellerIban: profile?.iban || "",
    sellerBankName: profile?.bankName || "",
    sellerBik: profile?.bik || "",
    sellerKbe: settings?.documents?.kbe || defaultKbe(profile?.bin, profile?.iin),
    sellerKnp: settings?.documents?.knp || "859",
    sellerDirector: profile?.directorName || "",
    buyerName: company?.legalName || company?.name || "",
    buyerBin: company?.bin || company?.iin || "",
    buyerAddress: company?.legalAddress || company?.address || "",
    buyerPhone: company?.phone || phoneFromContact(deal.contact) || "",
    buyerEmail: company?.email || contactEmail || "",
    items,
  };
  return {
    input,
    signedId: signedReady?.id || signed?.id || invoice.contractId || null,
    filename: invoicePdfFileName(input),
    itemCount: items.length,
    paymentPercent,
    itemTotals,
    payable,
  };
}

export async function generateInvoicePdfFile(
  prisma: PrismaClient,
  auth: AuthContext,
  invoiceId: string,
  input: { dueDate?: string | null } = {},
) {
  const membership = requireTenant(auth);
  requireManageDocuments(auth);
  const tid = membership.tenantId;
  await requireDocumentsEnabled(prisma, tid);

  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, tenantId: tid },
    include: { items: { orderBy: { sortOrder: "asc" } } },
  });
  if (!invoice) throw new ApiError(404, "not_found", "Счёт не найден");
  if (invoice.pdfFileId && await prisma.attachment.findFirst({ where: { id: invoice.pdfFileId, tenantId: tid, parentType: "invoice", parentId: invoice.id, status: "imported" } })) {
    throw new ApiError(422, "imported_pdf_immutable", "Загруженный PDF счёта сохраняется в исходном виде. Для другого документа загрузите новый файл.");
  }
  if (!MUTABLE_STATUSES.has(invoice.status)) {
    throw new ApiError(422, "invoice_immutable", "Счёт уже оплачен, просрочен или отменён — PDF нельзя пересобрать");
  }

  const snapshot = await invoicePdfSnapshot(prisma, tid, invoice, { requireReady: true });
  const deal = await prisma.deal.findFirst({
    where: { id: invoice.dealId, tenantId: tid },
    select: { id: true, companyId: true, currency: true, paymentStatus: true },
  });
  if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");
  const dueDate =
    input.dueDate !== undefined
      ? input.dueDate
        ? new Date(input.dueDate)
        : null
      : invoice.dueDate || defaultDueDate(invoice.date);
  const pdf = await renderInvoicePdf(await withInvoiceMarks(prisma, tid, { ...snapshot.input, dueDate }, false));
  const sha256 = createHash("sha256").update(pdf).digest("hex");
  const totals = snapshot.payable;
  if (invoice.pdfFileId) {
    const current = await prisma.attachment.findFirst({
      where: { id: invoice.pdfFileId, tenantId: tid, parentType: "invoice", parentId: invoice.id },
    });
    if (current?.checksum === sha256) {
      const reused = await prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          contractId: snapshot.signedId || invoice.contractId,
          companyId: deal.companyId,
          dueDate,
          currency: deal.currency || "KZT",
          amountWithoutVat: totals.amountWithoutVat,
          vatRate: totals.vatRate,
          vatAmount: totals.vatAmount,
          totalAmount: totals.totalAmount,
          status: "ISSUED",
        },
        include: { items: { orderBy: { sortOrder: "asc" } } },
      });
      if (deal.paymentStatus === "NOT_INVOICED") {
        await prisma.deal.update({
          where: { id: deal.id },
          data: { paymentStatus: "INVOICED" },
        });
      }
      return {
        invoice: serializeInvoice(reused),
        sha256,
        reused: true,
        ready: true,
        missingFields: [] as string[],
      };
    }
  }

  const attachmentId = randomUUID();
  const fileName = snapshot.filename;
  const storageKey = path.posix.join(tid, "invoices", invoice.id, `${attachmentId}-${fileName}`);
  const abs = resolveUploadPath(storageKey);
  await mkdir(path.dirname(abs), { recursive: true });
  await assertFileCapacity(prisma, tid, pdf.length);
  await writeFile(abs, pdf);

  const saved = await prisma.$transaction(async (tx) => {
    if (!invoice.items.length) {
      const dealItems = await tx.dealItem.findMany({
        where: { tenantId: tid, dealId: deal.id },
        orderBy: { sortOrder: "asc" },
      });
      await tx.invoiceItem.createMany({
        data: mapDealItemsToInvoiceItems(dealItems.map(serializeDealItem), tid, invoice.id),
      });
    }
    await tx.attachment.create({
      data: {
        id: attachmentId,
        tenantId: tid,
        parentType: "invoice",
        parentId: invoice.id,
        storageKey,
        fileName,
        originalFileName: fileName,
        mimeType: "application/pdf",
        sizeBytes: pdf.length,
        checksum: sha256,
        documentType: "invoice",
        uploadedById: auth.user.id,
        status: "stored",
      },
    });
    const updated = await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        contractId: snapshot.signedId || invoice.contractId,
        companyId: deal.companyId,
        dueDate,
        currency: deal.currency || "KZT",
        amountWithoutVat: totals.amountWithoutVat,
        vatRate: totals.vatRate,
        vatAmount: totals.vatAmount,
        totalAmount: totals.totalAmount,
        status: "ISSUED",
        pdfFileId: attachmentId,
      },
      include: { items: { orderBy: { sortOrder: "asc" } } },
    });
    if (deal.paymentStatus === "NOT_INVOICED") {
      await tx.deal.update({
        where: { id: deal.id },
        data: { paymentStatus: "INVOICED" },
      });
    }
    await tx.auditEvent.create({
      data: {
        tenantId: tid,
        actorUserId: auth.user.id,
        action: "invoice.generate_pdf",
        entityType: "invoice",
        entityId: invoice.id,
        changesJson: { number: invoice.number, sha256, reused: false },
      },
    });
    return updated;
  }).catch(async error => { await unlink(abs).catch(() => {}); throw error; });

  return {
    invoice: serializeInvoice(saved),
    sha256,
    reused: false,
    ready: true,
    missingFields: [] as string[],
  };
}

async function withInvoiceMarks(
  prisma: PrismaClient,
  tenantId: string,
  input: InvoicePdfInput,
  stamped: boolean,
): Promise<InvoicePdfInput> {
  if (!stamped) return { ...input, withStamp: false, stampPng: null, signaturePng: null };
  const marks = await listInvoiceMarkFiles(prisma, tenantId);
  const stampPng = marks.stamp ? await punchInvoiceStampBackground(marks.stamp).catch(() => marks.stamp) : null;
  const signaturePng = marks.signature ? await punchInvoiceStampBackground(marks.signature).catch(() => marks.signature) : null;
  return { ...input, withStamp: true, stampPng, signaturePng };
}

export async function sendInvoicePdf(
  prisma: PrismaClient,
  auth: AuthContext,
  invoiceId: string,
  res: Response,
  query: Record<string, unknown> = {},
) {
  requireDocumentsAccess(auth);
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const stamped = query.stamped === "1" || query.stamped === "true" || query.stamped === true;
  const download = query.download === "1" || query.download === "true" || query.download === true;
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, tenantId: tid },
    include: { items: { orderBy: { sortOrder: "asc" } } },
  });
  if (!invoice) throw new ApiError(404, "not_found", "Счёт не найден");
  if (invoice.pdfFileId) {
    const attachment = await prisma.attachment.findFirst({
      where: { id: invoice.pdfFileId, tenantId: tid, parentType: "invoice", parentId: invoice.id },
    });
    if (attachment?.status === "imported") {
      const abs = resolveUploadPath(attachment.storageKey);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(attachment.originalFileName || invoice.number)}.pdf"`);
      await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(abs);
        stream.on("error", () => reject(new ApiError(404, "not_found", "Файл счёта не найден на диске")));
        stream.on("end", () => resolve());
        stream.pipe(res);
      });
      return;
    }
  }
  const snapshot = await invoicePdfSnapshot(prisma, tid, invoice);
  const pdf = await renderInvoicePdf(await withInvoiceMarks(prisma, tid, snapshot.input, stamped));
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", invoicePdfContentDisposition(snapshot.filename, !download));
  res.setHeader("Cache-Control", "no-store");
  res.send(pdf);
}

