import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@creolab/db";
import type { Response } from "express";
import { ApiError } from "../errors.ts";
import { can, type AuthContext } from "../lib/types.ts";
import { resolveUploadPath } from "../lib/storage.ts";
import { sumLines } from "./documentMoney.ts";
import { serializeDealItem } from "./dealItemService.ts";
import { requireDocumentsEnabled } from "./legalProfileService.ts";
import { mapDealItemsToInvoiceItems, serializeInvoice } from "./documentDraftService.ts";
import { assessInvoiceReadiness, invoiceMissingFieldsError } from "./invoiceReadiness.ts";
import { renderInvoicePdf } from "./invoicePdf.ts";

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

  const deal = await prisma.deal.findFirst({
    where: { id: invoice.dealId, tenantId: tid },
    include: {
      items: { orderBy: { sortOrder: "asc" } },
      company: true,
    },
  });
  if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");

  const signed = invoice.contractId
    ? await prisma.contract.findFirst({
        where: { id: invoice.contractId, tenantId: tid, dealId: deal.id, status: "SIGNED" },
      })
    : await prisma.contract.findFirst({
        where: { tenantId: tid, dealId: deal.id, status: "SIGNED" },
        orderBy: { signedAt: "desc" },
      });

  const [profile, tenant] = await Promise.all([
    prisma.tenantLegalProfile.findUnique({ where: { tenantId: tid } }),
    prisma.tenant.findUnique({ where: { id: tid }, select: { name: true } }),
  ]);

  const items = deal.items.map(serializeDealItem);
  const readiness = assessInvoiceReadiness({
    dealId: deal.id,
    contractId: signed?.id || invoice.contractId,
    invoiceId: invoice.id,
    signedContractId: signed?.id || null,
    itemCount: items.length,
    profile,
    company: deal.company,
  });
  if (!readiness.ready) throw invoiceMissingFieldsError(readiness);

  const totals = sumLines(items);
  const dueDate =
    input.dueDate !== undefined
      ? input.dueDate
        ? new Date(input.dueDate)
        : null
      : invoice.dueDate || defaultDueDate(invoice.date);
  const company = deal.company!;

  const pdf = await renderInvoicePdf({
    number: invoice.number,
    date: invoice.date,
    dueDate,
    contractNumber: signed!.number,
    contractDate: signed!.date,
    dealName: deal.title,
    amountWithoutVat: totals.amountWithoutVat,
    vatRate: totals.vatRate,
    vatAmount: totals.vatAmount,
    totalAmount: totals.totalAmount,
    sellerName: profile!.legalName || profile!.shortName || tenant?.name || "",
    sellerBin: profile!.bin || profile!.iin || "",
    sellerAddress: profile!.legalAddress || "",
    sellerIban: profile!.iban || "",
    sellerBankName: profile!.bankName || "",
    sellerBik: profile!.bik || "",
    buyerName: company.legalName || company.name,
    buyerBin: company.bin || company.iin || "",
    buyerAddress: company.legalAddress || company.address || "",
    items,
  });

  const sha256 = createHash("sha256").update(pdf).digest("hex");
  if (invoice.pdfFileId) {
    const current = await prisma.attachment.findFirst({
      where: { id: invoice.pdfFileId, tenantId: tid, parentType: "invoice", parentId: invoice.id },
    });
    if (current?.checksum === sha256) {
      const reused = await prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          contractId: signed!.id,
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
  const fileName = `${invoice.number}.pdf`;
  const storageKey = path.posix.join(tid, "invoices", invoice.id, `${attachmentId}-${fileName}`);
  const abs = resolveUploadPath(storageKey);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, pdf);

  const saved = await prisma.$transaction(async (tx) => {
    await tx.invoiceItem.deleteMany({ where: { tenantId: tid, invoiceId: invoice.id } });
    await tx.invoiceItem.createMany({
      data: mapDealItemsToInvoiceItems(items, tid, invoice.id),
    });
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
        contractId: signed!.id,
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
  });

  return {
    invoice: serializeInvoice(saved),
    sha256,
    reused: false,
    ready: true,
    missingFields: [] as string[],
  };
}

export async function sendInvoicePdf(
  prisma: PrismaClient,
  auth: AuthContext,
  invoiceId: string,
  res: Response,
) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, tenantId: tid },
    select: { id: true, number: true, pdfFileId: true },
  });
  if (!invoice) throw new ApiError(404, "not_found", "Счёт не найден");
  if (!invoice.pdfFileId) {
    throw new ApiError(404, "pdf_not_ready", "PDF счёта ещё не сформирован");
  }
  const attachment = await prisma.attachment.findFirst({
    where: { id: invoice.pdfFileId, tenantId: tid, parentType: "invoice", parentId: invoice.id },
  });
  if (!attachment) throw new ApiError(404, "not_found", "Файл счёта не найден");
  const abs = resolveUploadPath(attachment.storageKey);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(invoice.number)}.pdf"`);
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(abs);
    stream.on("error", () => reject(new ApiError(404, "not_found", "Файл счёта не найден на диске")));
    stream.on("end", () => resolve());
    stream.pipe(res);
  });
}
