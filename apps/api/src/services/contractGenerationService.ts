import { documentOrganization } from "./documentOrganization.ts";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
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
import { buildContractPlaceholders, renderContractPdf, type ContractPdfInput } from "./contractPdf.ts";
import { fillDocxPlaceholders } from "./docxTemplateFill.ts";
import { sniffWordKind, textutilConvert } from "./wordDocumentText.ts";
import { wordToPdf } from "./wordDocumentConversion.ts";

const MUTABLE_STATUSES = new Set(["DRAFT", "READY_TO_SIGN"]);

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

async function renderContractFromTemplate(
  template: { body: string; sourceFileName?: string | null; sourceStorageKey?: string | null },
  input: ContractPdfInput,
) {
  const sourceKey = template.sourceStorageKey;
  if (sourceKey) {
    try {
      const bytes = await readFile(resolveUploadPath(sourceKey));
      if (sniffWordKind(bytes, template.sourceFileName || "template.docx") === "docx") {
        const filledDocx = await fillDocxPlaceholders(bytes, buildContractPlaceholders(input));
        try {
          return await wordToPdf(filledDocx, "docx");
        } catch (error) {
          if (!(error instanceof ApiError && (error.code === "word_conversion_unavailable" || error.code === "word_conversion_failed"))) {
            throw error;
          }
          const fromTextutil = await textutilConvert(filledDocx, "docx", "pdf");
          if (fromTextutil) return fromTextutil;
        }
      }
    } catch (error) {
      if (error instanceof ApiError && error.code !== "word_file_type" && error.code !== "word_invalid") {
        throw error;
      }
    }
  }
  return renderContractPdf(input);
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
    throw new ApiError(422, "contract_immutable", "Договор уже на подписи или подписан — PDF нельзя пересобрать");
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
  const pdfInput: ContractPdfInput = {
    number: contract.number,
    date: contract.date,
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
  const pdf = await renderContractFromTemplate(template, pdfInput);

  const sha256 = createHash("sha256").update(pdf).digest("hex");
  const latest = contract.versions[contract.versions.length - 1] || null;
  if (latest?.sha256 === sha256 && latest.fileId) {
    const reused = await prisma.contract.update({
      where: { id: contract.id },
      data: {
        subject,
        paymentTerms,
        completionTerms,
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
      contract: serializeContract(reused),
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

  const attachmentId = randomUUID();
  const fileName = `${contract.number}.pdf`;
  const storageKey = path.posix.join(tid, "contracts", contract.id, `${attachmentId}-${fileName}`);
  const abs = resolveUploadPath(storageKey);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, pdf);

  const nextVersion = latest?.fileId ? (latest.version || 0) + 1 : latest?.version || 1;
  const saved = await prisma.$transaction(async (tx) => {
    await tx.attachment.create({
      data: {
        id: attachmentId,
        tenantId: tid,
        parentType: "contract",
        parentId: contract.id,
        storageKey,
        fileName,
        originalFileName: fileName,
        mimeType: "application/pdf",
        sizeBytes: pdf.length,
        checksum: sha256,
        documentType: "contract",
        uploadedById: auth.user.id,
        status: "stored",
      },
    });

    const versionRow = latest && !latest.fileId
      ? await tx.contractVersion.update({
          where: { id: latest.id },
          data: { fileId: attachmentId, sha256 },
        })
      : await tx.contractVersion.create({
          data: {
            tenantId: tid,
            contractId: contract.id,
            version: nextVersion,
            fileId: attachmentId,
            sha256,
          },
        });

    const updated = await tx.contract.update({
      where: { id: contract.id },
      data: {
        subject,
        paymentTerms,
        completionTerms,
        companyId: deal.companyId,
        amountWithoutVat: totals.amountWithoutVat,
        vatRate: totals.vatRate,
        vatAmount: totals.vatAmount,
        totalAmount: totals.totalAmount,
        currency: deal.currency || "KZT",
        status: "READY_TO_SIGN",
        generatedFileId: attachmentId,
        templateId: template.id,
      },
    });

    await tx.auditEvent.create({
      data: {
        tenantId: tid,
        actorUserId: auth.user.id,
        action: "contract.generate_pdf",
        entityType: "contract",
        entityId: contract.id,
        changesJson: { number: contract.number, sha256, version: versionRow.version, reused: false },
      },
    });

    return { updated, versionRow };
  });

  return {
    contract: serializeContract(saved.updated),
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
  const contract = await prisma.contract.findFirst({
    where: { id: contractId, tenantId: tid },
    select: { id: true, number: true, generatedFileId: true },
  });
  if (!contract) throw new ApiError(404, "not_found", "Договор не найден");
  if (!contract.generatedFileId) {
    throw new ApiError(404, "pdf_not_ready", "PDF договора ещё не сформирован");
  }
  const attachment = await prisma.attachment.findFirst({
    where: { id: contract.generatedFileId, tenantId: tid, parentType: "contract", parentId: contract.id },
  });
  if (!attachment) throw new ApiError(404, "not_found", "Файл договора не найден");
  const abs = resolveUploadPath(attachment.storageKey);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(contract.number)}.pdf"`);
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(abs);
    stream.on("error", () => reject(new ApiError(404, "not_found", "Файл договора не найден на диске")));
    stream.on("end", () => resolve());
    stream.pipe(res);
  });
}

export async function sendContractOriginal(prisma: PrismaClient, auth: AuthContext, contractId: string, res: Response) {
  requireDocumentsAccess(auth);
  const tid = requireTenant(auth).tenantId;
  const contract = await prisma.contract.findFirst({where:{id:contractId,tenantId:tid}});
  const file = contract?.originalFileId ? await prisma.attachment.findFirst({where:{id:contract.originalFileId,tenantId:tid,parentId:contractId,parentType:"contract"}}) : null;
  if (!file) throw new ApiError(404,"not_found","Исходный документ не найден");
  res.setHeader("Content-Type",file.mimeType);
  res.setHeader("Content-Disposition",`attachment; filename*=UTF-8''${encodeURIComponent(file.originalFileName || file.fileName)}`);
  res.sendFile(resolveUploadPath(file.storageKey));
}
