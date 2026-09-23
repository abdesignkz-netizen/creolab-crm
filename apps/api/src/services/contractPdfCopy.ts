import { assertFileCapacity } from "./billingResourceService.ts";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { unlink, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@creolab/db";
import type { Response } from "express";
import { ApiError } from "../errors.ts";
import { resolveUploadPath } from "../lib/storage.ts";
import { type ContractPdfInput } from "./contractPdf.ts";
import { isWordAttachment } from "./contractDocx.ts";
import { wordToPdf } from "./wordDocumentConversion.ts";
import { renderSimpleWordPdf } from "./contractWordPdfFallback.ts";

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

export async function wordFileToContractPdf(bytes: Buffer, fileName: string, _input?: ContractPdfInput) {
  if (isPdfBytes(bytes)) return bytes;
  const extension = /\.doc$/i.test(fileName) ? "doc" : "docx";
  try {
    return await wordToPdf(bytes, extension);
  } catch (error) {
    if (error instanceof ApiError && ["word_conversion_unavailable", "word_conversion_failed"].includes(error.code) && extension === "docx") {
      const pdf = await renderSimpleWordPdf(bytes);
      if (pdf) return pdf;
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
  await assertFileCapacity(prisma, opts.tenantId, opts.bytes.length);
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
  }).catch(async error => { await unlink(abs).catch(() => {}); throw error; });
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
  const pdf = await wordFileToContractPdf(
    bytes,
    attachment.fileName || attachment.originalFileName || "contract.docx",
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
