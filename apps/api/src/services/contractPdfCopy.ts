import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@creolab/db";
import type { Response } from "express";
import { ApiError } from "../errors.ts";
import { resolveUploadPath } from "../lib/storage.ts";
import { renderContractPdf, type ContractPdfInput } from "./contractPdf.ts";
import { isWordAttachment } from "./contractDocx.ts";
import { wordToPdf } from "./wordDocumentConversion.ts";
import { ensureDefaultTemplate } from "./contractTemplate.ts";

export const PDF_MIME = "application/pdf";

export function isPdfBytes(bytes: Buffer) {
  return bytes.subarray(0, 5).toString("utf8") === "%PDF-";
}

export function isPdfAttachment(attachment: { mimeType?: string | null; fileName?: string | null; originalFileName?: string | null }) {
  return /pdf/i.test(`${attachment.mimeType || ""} ${attachment.fileName || ""} ${attachment.originalFileName || ""}`);
}

export function pdfDownloadHeaders(number: string) {
  const downloadName = `${String(number || "contract").replace(/\.pdf$/i, "")}.pdf`;
  return {
    contentType: PDF_MIME,
    disposition: `inline; filename="${encodeURIComponent(downloadName)}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
  };
}

export async function sendStoredFile(
  res: Response,
  abs: string,
  headers: { contentType: string; disposition: string },
) {
  res.setHeader("Content-Type", headers.contentType);
  res.setHeader("Content-Disposition", headers.disposition);
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(abs);
    stream.on("error", () => reject(new ApiError(404, "not_found", "Файл договора не найден на диске")));
    stream.on("end", () => resolve());
    stream.pipe(res);
  });
}

export async function wordFileToContractPdf(bytes: Buffer, fileName: string, input?: ContractPdfInput) {
  if (isPdfBytes(bytes)) return bytes;
  const extension = /\.doc$/i.test(fileName) ? "doc" : "docx";
  try {
    return await wordToPdf(bytes, extension);
  } catch (error) {
    if (error instanceof ApiError && error.code === "word_conversion_unavailable" && input) {
      return renderContractPdf(input);
    }
    throw error;
  }
}

export async function storeContractBytes(
  prisma: PrismaClient,
  opts: {
    tenantId: string;
    parentType: string;
    parentId: string;
    fileName: string;
    mimeType: string;
    bytes: Buffer;
    documentType?: string;
    uploadedById?: string | null;
    status?: string;
  },
) {
  const id = randomUUID();
  const folder = opts.parentType === "contract_preview" ? "contract-previews" : "contracts";
  const storageKey = path.posix.join(opts.tenantId, folder, opts.parentId, `${id}-${opts.fileName}`);
  const abs = resolveUploadPath(storageKey);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, opts.bytes);
  return prisma.attachment.create({
    data: {
      id,
      tenantId: opts.tenantId,
      parentType: opts.parentType,
      parentId: opts.parentId,
      storageKey,
      fileName: opts.fileName,
      originalFileName: opts.fileName,
      mimeType: opts.mimeType,
      sizeBytes: opts.bytes.length,
      checksum: createHash("sha256").update(opts.bytes).digest("hex"),
      documentType: opts.documentType || "contract",
      uploadedById: opts.uploadedById || null,
      status: opts.status || "stored",
    },
  });
}

async function pdfInputFromContract(
  prisma: PrismaClient,
  contract: {
    id: string;
    tenantId: string;
    dealId: string;
    number: string;
    date: Date;
    subject: string | null;
    paymentTerms: string | null;
    completionTerms: string | null;
    amountWithoutVat: { toString(): string } | number;
    vatRate: { toString(): string } | number | null;
    vatAmount: { toString(): string } | number;
    totalAmount: { toString(): string } | number;
    templateId: string | null;
  },
): Promise<ContractPdfInput | undefined> {
  const [deal, profile, tenant, storedTemplate] = await Promise.all([
    prisma.deal.findFirst({
      where: { id: contract.dealId, tenantId: contract.tenantId },
      include: { items: { orderBy: { sortOrder: "asc" } }, company: true },
    }),
    prisma.tenantLegalProfile.findUnique({ where: { tenantId: contract.tenantId } }),
    prisma.tenant.findUnique({ where: { id: contract.tenantId }, select: { name: true } }),
    contract.templateId
      ? prisma.contractTemplate.findFirst({ where: { id: contract.templateId, tenantId: contract.tenantId } })
      : Promise.resolve(null),
  ]);
  if (!deal) return undefined;
  const template = storedTemplate || (await ensureDefaultTemplate(prisma, contract.tenantId));
  const filled = (value: string | null | undefined) => Boolean(value && String(value).trim());
  const company = deal.company;
  return {
    number: contract.number,
    date: contract.date || new Date(),
    subject: contract.subject || deal.title,
    dealName: deal.title,
    paymentTerms: contract.paymentTerms || "По согласованию сторон.",
    completionTerms: contract.completionTerms || "По согласованию сторон.",
    amountWithoutVat: Number(contract.amountWithoutVat),
    vatRate: contract.vatRate == null ? null : Number(contract.vatRate),
    vatAmount: Number(contract.vatAmount),
    totalAmount: Number(contract.totalAmount),
    sellerName: profile?.legalName || profile?.shortName || tenant?.name || "",
    sellerBin: profile?.bin || profile?.iin || "",
    sellerAddress: profile?.legalAddress || "",
    sellerDirector: profile?.directorName || "",
    sellerDirectorPosition: filled(profile?.directorPosition) ? profile!.directorPosition! : "Директор",
    sellerIban: profile?.iban || "",
    sellerBank: profile?.bankName || "",
    sellerBik: profile?.bik || "",
    sellerPhone: profile?.phone || "",
    sellerEmail: profile?.email || "",
    buyerName: company?.legalName || company?.name || "",
    buyerBin: company?.bin || company?.iin || "",
    buyerAddress: company?.legalAddress || company?.address || "",
    buyerDirector: filled(company?.directorName) ? company!.directorName! : "________________",
    buyerIban: company?.iban || "",
    buyerBank: company?.bankName || "",
    buyerBik: company?.bik || "",
    items: deal.items.map((item) => ({
      name: item.name,
      quantity: Number(item.quantity),
      unit: item.unit,
      unitPrice: Number(item.unitPrice),
      amountWithoutVat: Number(item.amountWithoutVat),
      totalAmount: Number(item.totalAmount),
    })),
    templateBody: template.body,
  };
}

export async function ensureContractPdfAttachment(
  prisma: PrismaClient,
  args: { tenantId: string; contractId: string },
) {
  const contract = await prisma.contract.findFirst({
    where: { id: args.contractId, tenantId: args.tenantId },
    include: { versions: { orderBy: { version: "asc" } } },
  });
  if (!contract?.generatedFileId) throw new ApiError(404, "pdf_not_ready", "Договор ещё не сформирован");
  const attachment = await prisma.attachment.findFirst({
    where: { id: contract.generatedFileId, tenantId: args.tenantId },
  });
  if (!attachment) throw new ApiError(404, "not_found", "Файл договора не найден");
  const abs = resolveUploadPath(attachment.storageKey);
  const bytes = await readFile(abs).catch(() => {
    throw new ApiError(404, "not_found", "Файл договора не найден на диске");
  });
  if (isPdfBytes(bytes)) {
    if (!isPdfAttachment(attachment)) {
      const updated = await prisma.attachment.update({
        where: { id: attachment.id },
        data: { mimeType: PDF_MIME, fileName: attachment.fileName.replace(/\.docx?$/i, ".pdf") },
      });
      return { contract, attachment: updated };
    }
    return { contract, attachment };
  }
  if (!isWordAttachment(attachment) && !isWordAttachment({ fileName: attachment.storageKey })) {
    throw new ApiError(422, "pdf_not_ready", "Файл договора нельзя открыть как PDF");
  }
  const signatures = await prisma.documentSignature.count({
    where: { tenantId: args.tenantId, contractId: contract.id },
  });
  if (signatures > 0) {
    return { contract, attachment };
  }
  const input = await pdfInputFromContract(prisma, contract);
  const pdf = await wordFileToContractPdf(
    bytes,
    attachment.fileName || attachment.originalFileName || "contract.docx",
    input,
  );
  const pdfAttachment = await storeContractBytes(prisma, {
    tenantId: args.tenantId,
    parentType: "contract",
    parentId: contract.id,
    fileName: `${contract.number}.pdf`,
    mimeType: PDF_MIME,
    bytes: pdf,
    uploadedById: contract.createdByUserId,
  });
  const latest = contract.versions[contract.versions.length - 1] || null;
  await prisma.$transaction(async (tx) => {
    await tx.contract.update({
      where: { id: contract.id },
      data: { generatedFileId: pdfAttachment.id },
    });
    if (latest) {
      await tx.contractVersion.update({
        where: { id: latest.id },
        data: { fileId: pdfAttachment.id, sha256: pdfAttachment.checksum },
      });
    }
    await tx.attachment.update({
      where: { id: attachment.id },
      data: { documentType: "contract_source" },
    });
  });
  return {
    contract: { ...contract, generatedFileId: pdfAttachment.id },
    attachment: pdfAttachment,
  };
}
