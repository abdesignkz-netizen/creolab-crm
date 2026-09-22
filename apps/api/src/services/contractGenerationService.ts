import { documentOrganization } from "./documentOrganization.ts";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PrismaClient } from "@creolab/db";
import type { Response } from "express";
import { ApiError } from "../errors.ts";
import { can, type AuthContext } from "../lib/types.ts";
import { requireDocumentsAccess } from "../lib/access.ts";
import { resolveUploadPath } from "../lib/storage.ts";
import { sumLines } from "./documentMoney.ts";
import { serializeDealItem } from "./dealItemService.ts";
import { requireDocumentsEnabled } from "./legalProfileService.ts";
import { serializeContract } from "./documentDraftService.ts";
import { assessContractReadiness, missingFieldsError } from "./contractReadiness.ts";
import { ensureDefaultTemplate } from "./contractTemplate.ts";
import { type ContractPdfInput } from "./contractPdf.ts";
import { sniffWordKind, convertDocToDocx } from "./wordDocumentText.ts";
import { contractDocxContentHash, DOCX_MIME, renderContractDocx } from "./contractDocx.ts";
import {
  PDF_MIME,
  ensureContractPdfAttachment,
  isPdfAttachment,
  pdfDownloadHeaders,
  sendStoredFile,
  storeContractBytes,
  wordFileToContractPdf,
} from "./contractPdfCopy.ts";

const MUTABLE_STATUSES = new Set(["DRAFT", "READY_TO_SIGN"]);

async function hasReusableContractSource(
  prisma: PrismaClient,
  tenantId: string,
  contractId: string,
  latest: { fileId: string | null; sha256: string | null } | null,
  docx: Buffer,
  renderingInputHash: string,
) {
  if (!latest?.fileId || !latest.sha256) return false;
  const audit = await prisma.auditEvent.findFirst({
    where: { tenantId, entityId: contractId, entityType: "contract", action: "contract.generate" },
    orderBy: { createdAt: "desc" },
  });
  const changes = audit?.changesJson as { sha256?: unknown; sourceFileId?: unknown; renderingInputHash?: unknown } | null;
  if (changes?.sha256 !== latest.sha256 || changes.renderingInputHash !== renderingInputHash || typeof changes.sourceFileId !== "string") return false;
  const [source, pdf] = await Promise.all([
    prisma.attachment.findFirst({ where: { id: changes.sourceFileId, tenantId, parentId: contractId, parentType: "contract", documentType: "contract_source" } }),
    prisma.attachment.findFirst({ where: { id: latest.fileId, tenantId, parentId: contractId, parentType: "contract", mimeType: PDF_MIME } }),
  ]);
  if (!source || !pdf) return false;
  try {
    const [previousDocx, previousPdf] = await Promise.all([
      readFile(resolveUploadPath(source.storageKey)), readFile(resolveUploadPath(pdf.storageKey)),
    ]);
    if (createHash("sha256").update(previousPdf).digest("hex") !== latest.sha256) return false;
    return await contractDocxContentHash(previousDocx) === await contractDocxContentHash(docx);
  } catch {
    // Missing or damaged files must be rebuilt rather than reported as reused.
    return false;
  }
}

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership;
}

function requireManageDocuments(auth: AuthContext) {
  if (!can(auth, "manage_documents")) {
    throw new ApiError(403, "forbidden", "Недостаточно прав для документов");
  }
}

function filled(value: string | null | undefined) {
  return Boolean(value && String(value).trim());
}

export async function renderContractFromTemplate(
  template: { body: string; sourceFileName?: string | null; sourceStorageKey?: string | null },
  input: ContractPdfInput,
) {
  const sourceKey = template.sourceStorageKey;
  if (sourceKey) {
    try {
      let bytes = await readFile(resolveUploadPath(sourceKey));
      let kind = sniffWordKind(bytes, template.sourceFileName || "template.docx");
      if (kind === "doc") {
        const asDocx = await convertDocToDocx(bytes);
        if (asDocx) {
          bytes = asDocx;
          kind = "docx";
        }
      }
      if (kind === "docx") {
        return await renderContractDocx(input, bytes);
      }
    } catch (error) {
      if (error instanceof ApiError && error.code !== "word_file_type" && error.code !== "word_invalid") {
        throw error;
      }
    }
  }
  return renderContractDocx(input, null);
}

export async function generateContractPdfFile(
  prisma: PrismaClient,
  auth: AuthContext,
  contractId: string,
  input: {
    subject?: string | null;
    paymentTerms?: string | null;
    completionTerms?: string | null;
    templateId?: string | null;
  } = {},
) {
  const membership = requireTenant(auth);
  requireManageDocuments(auth);
  const tid = membership.tenantId;
  await requireDocumentsEnabled(prisma, tid);

  const contract = await prisma.contract.findFirst({
    where: { id: contractId, tenantId: tid },
    include: { versions: { orderBy: { version: "asc" } } },
  });
  if (!contract) throw new ApiError(404, "not_found", "Договор не найден");
  if (contract.originalFileId) throw new ApiError(422, "imported_pdf_immutable", "Загруженный PDF сохраняется в исходном виде. Для другого документа загрузите новый файл.");
  if (!MUTABLE_STATUSES.has(contract.status) || contract.signedAt) {
    throw new ApiError(422, "contract_immutable", "Договор уже на подписи или подписан — файл нельзя пересобрать");
  }

  const deal = await prisma.deal.findFirst({
    where: { id: contract.dealId, tenantId: tid },
    include: {
      items: { orderBy: { sortOrder: "asc" } },
      company: true,
    },
  });
  if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");

  const [profile, tenant] = await Promise.all([
    documentOrganization(prisma, tid, deal.id),
    prisma.tenant.findUnique({ where: { id: tid }, select: { name: true } }),
  ]);

  const items = deal.items.map(serializeDealItem);
  const readiness = assessContractReadiness({
    dealId: deal.id,
    contractId: contract.id,
    itemCount: items.length,
    profile,
    company: deal.company,
  });
  if (!readiness.ready) throw missingFieldsError(readiness);

  const totals = sumLines(items);
  const subject = input.subject !== undefined ? input.subject?.trim() || deal.title : contract.subject || deal.title;
  const paymentTerms =
    input.paymentTerms !== undefined ? input.paymentTerms?.trim() || null : contract.paymentTerms;
  const completionTerms =
    input.completionTerms !== undefined ? input.completionTerms?.trim() || null : contract.completionTerms;

  const requestedTemplateId = input.templateId || contract.templateId;
  const template = requestedTemplateId
    ? (await prisma.contractTemplate.findFirst({ where: { id: requestedTemplateId, tenantId: tid } })) ||
      (await ensureDefaultTemplate(prisma, tid))
    : await ensureDefaultTemplate(prisma, tid);

  const company = deal.company!;
  const contractDate = contract.date;
  const docxInput: ContractPdfInput = {
    number: contract.number,
    date: contractDate,
    subject,
    dealName: deal.title,
    paymentTerms: paymentTerms || "По согласованию сторон.",
    completionTerms: completionTerms || "По согласованию сторон.",
    amountWithoutVat: totals.amountWithoutVat,
    vatRate: totals.vatRate,
    vatAmount: totals.vatAmount,
    totalAmount: totals.totalAmount,
    sellerName: profile!.legalName || profile!.shortName || tenant?.name || "",
    sellerBin: profile!.bin || profile!.iin || "",
    sellerAddress: profile!.legalAddress || "",
    sellerDirector: profile!.directorName || "",
    sellerDirectorPosition: filled(profile!.directorPosition) ? profile!.directorPosition! : "Директор",
    sellerIban: profile!.iban || "",
    sellerBank: profile!.bankName || "",
    sellerBik: profile!.bik || "",
    sellerPhone: profile!.phone || "",
    sellerEmail: profile!.email || "",
    buyerName: company.legalName || company.name,
    buyerBin: company.bin || company.iin || "",
    buyerAddress: company.legalAddress || company.address || "",
    buyerDirector: filled(company.directorName) ? company.directorName! : "________________",
    buyerIban: company.iban || "",
    buyerBank: company.bankName || "",
    buyerBik: company.bik || "",
    items,
    templateBody: template.body,
  };
  const docx = await renderContractFromTemplate(template, docxInput);
  const latest = contract.versions[contract.versions.length - 1] || null;
  const renderingInputHash = createHash("sha256").update(JSON.stringify(docxInput)).digest("hex");
  const reusable = await hasReusableContractSource(prisma, tid, contract.id, latest, docx, renderingInputHash);
  if (reusable && latest?.fileId) {
    const reused = await prisma.contract.update({
      where: { id: contract.id },
      data: {
        subject,
        paymentTerms,
        completionTerms,
        date: contractDate,
        companyId: deal.companyId,
        amountWithoutVat: totals.amountWithoutVat,
        vatRate: totals.vatRate,
        vatAmount: totals.vatAmount,
        totalAmount: totals.totalAmount,
        currency: deal.currency || "KZT",
        status: "READY_TO_SIGN",
        generatedFileId: latest.fileId,
        templateId: template.id,
      },
    });
    return {
      contract: serializeContract({ ...reused, generatedMimeType: PDF_MIME }),
      version: {
        id: latest.id,
        version: latest.version,
        sha256: latest.sha256,
        fileId: latest.fileId,
        createdAt: latest.createdAt.toISOString(),
      },
      reused: true,
      ready: true,
      missingFields: [] as string[],
    };
  }

  const pdf = await wordFileToContractPdf(docx, `${contract.number}.docx`, docxInput);
  const sha256 = createHash("sha256").update(pdf).digest("hex");
  const sourceAttachment = await storeContractBytes(prisma, {
    tenantId: tid,
    parentType: "contract",
    parentId: contract.id,
    fileName: `${contract.number}.docx`,
    mimeType: DOCX_MIME,
    bytes: docx,
    documentType: "contract_source",
    uploadedById: auth.user.id,
  });
  const pdfAttachment = await storeContractBytes(prisma, {
    tenantId: tid,
    parentType: "contract",
    parentId: contract.id,
    fileName: `${contract.number}.pdf`,
    mimeType: PDF_MIME,
    bytes: pdf,
    uploadedById: auth.user.id,
  });

  const nextVersion = latest?.fileId ? (latest.version || 0) + 1 : latest?.version || 1;
  const saved = await prisma.$transaction(async (tx) => {
    const versionRow = latest && !latest.fileId
      ? await tx.contractVersion.update({
          where: { id: latest.id },
          data: { fileId: pdfAttachment.id, sha256 },
        })
      : await tx.contractVersion.create({
          data: {
            tenantId: tid,
            contractId: contract.id,
            version: nextVersion,
            fileId: pdfAttachment.id,
            sha256,
          },
        });

    const updated = await tx.contract.update({
      where: { id: contract.id },
      data: {
        subject,
        paymentTerms,
        completionTerms,
        date: contractDate,
        companyId: deal.companyId,
        amountWithoutVat: totals.amountWithoutVat,
        vatRate: totals.vatRate,
        vatAmount: totals.vatAmount,
        totalAmount: totals.totalAmount,
        currency: deal.currency || "KZT",
        status: "READY_TO_SIGN",
        generatedFileId: pdfAttachment.id,
        templateId: template.id,
      },
    });

    await tx.auditEvent.create({
      data: {
        tenantId: tid,
        actorUserId: auth.user.id,
        action: "contract.generate",
        entityType: "contract",
        entityId: contract.id,
        changesJson: {
          number: contract.number,
          sha256,
          version: versionRow.version,
          reused: false,
          sourceFileId: sourceAttachment.id,
          renderingInputHash,
        },
      },
    });

    return { updated, versionRow };
  });

  return {
    contract: serializeContract({ ...saved.updated, generatedMimeType: PDF_MIME }),
    version: {
      id: saved.versionRow.id,
      version: saved.versionRow.version,
      sha256: saved.versionRow.sha256,
      fileId: saved.versionRow.fileId,
      createdAt: saved.versionRow.createdAt.toISOString(),
    },
    reused: false,
    ready: true,
    missingFields: [] as string[],
  };
}

export async function sendContractPdf(
  prisma: PrismaClient,
  auth: AuthContext,
  contractId: string,
  res: Response,
) {
  requireDocumentsAccess(auth);
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const exists = await prisma.contract.findFirst({
    where: { id: contractId, tenantId: tid },
    select: { id: true },
  });
  if (!exists) throw new ApiError(404, "not_found", "Договор не найден");
  const { contract, attachment } = await ensureContractPdfAttachment(prisma, { tenantId: tid, contractId });
  const headers = isPdfAttachment(attachment)
    ? pdfDownloadHeaders(contract.number)
    : {
        contentType: attachment.mimeType || "application/octet-stream",
        disposition: `inline; filename="${encodeURIComponent(attachment.fileName)}"`,
      };
  await sendStoredFile(res, resolveUploadPath(attachment.storageKey), headers);
}

export async function sendContractOriginal(prisma: PrismaClient, auth: AuthContext, contractId: string, res: Response) {
  requireDocumentsAccess(auth);
  const tid = requireTenant(auth).tenantId;
  const contract = await prisma.contract.findFirst({where:{id:contractId,tenantId:tid}});
  const file = contract?.originalFileId
    ? await prisma.attachment.findFirst({where:{id:contract.originalFileId,tenantId:tid,parentId:contractId,parentType:"contract"}})
    : await prisma.attachment.findFirst({
        where: { tenantId: tid, parentId: contractId, parentType: "contract", documentType: "contract_source" },
        orderBy: { createdAt: "desc" },
      });
  if (!file) throw new ApiError(404,"not_found","Исходный документ не найден");
  res.setHeader("Content-Type",file.mimeType);
  res.setHeader("Content-Disposition",`attachment; filename*=UTF-8''${encodeURIComponent(file.originalFileName || file.fileName)}`);
  res.sendFile(resolveUploadPath(file.storageKey));
}
