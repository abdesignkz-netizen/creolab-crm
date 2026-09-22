import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { PrismaClient } from "@creolab/db";
import type { Response } from "express";
import {
  companyContractFromTemplateSchema,
  patchContractTemplateSchema,
  saveContractTemplateSchema,
  uploadContractTemplateSchema,
} from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { can, type AuthContext } from "../lib/types.ts";
import { requireDocumentsAccess, requireTenant } from "../lib/access.ts";
import { beginDocumentExtraction } from "./documentExtractionGate.ts";
import { requireDocumentsEnabled } from "./legalProfileService.ts";
import { ensureDefaultTemplate } from "./contractTemplate.ts";
import { rewriteScannedFragment, scanContractTemplateText, describeTemplateFields, type TemplateSellerProfile } from "./contractTemplateScan.ts";
import { sniffWordKind, convertDocToDocx, wordFileToText } from "./wordDocumentText.ts";
import { rewriteDocxText, ensureDocxItemsPlaceholder } from "./docxTemplateFill.ts";
import { createContractDraft, serializeContract } from "./documentDraftService.ts";
import { generateContractPdfFile, renderContractFromTemplate } from "./contractGenerationService.ts";
import { addDealItem } from "./dealItemService.ts";
import { resolveUploadPath } from "../lib/storage.ts";
import { DOCX_MIME } from "./contractDocx.ts";
import { lineAmounts, sumLines } from "./documentMoney.ts";
import { assessContractReadiness, missingFieldsError } from "./contractReadiness.ts";
import {
  PDF_MIME,
  isPdfAttachment,
  pdfDownloadHeaders,
  sendStoredFile,
  wordFileToContractPdf,
  storeContractBytes,
} from "./contractPdfCopy.ts";

function requireManageDocuments(auth: AuthContext) {
  if (!can(auth, "manage_documents")) {
    throw new ApiError(403, "forbidden", "Недостаточно прав для документов");
  }
}

function serializeTemplate(row: {
  id: string;
  name: string;
  body: string;
  isDefault: boolean;
  sourceFileName?: string | null;
  sourceStorageKey?: string | null;
  createdAt: Date;
  updatedAt: Date;
}, withBody = false) {
  const placeholders = [...new Set([...row.body.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)].map((match) => match[1]))];
  return {
    id: row.id,
    name: row.name,
    isDefault: row.isDefault,
    fromWord: Boolean(row.sourceStorageKey),
    placeholders,
    fields: describeTemplateFields(placeholders),
    preview: row.body.slice(0, 280),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(withBody ? { body: row.body } : {}),
  };
}

async function storeTemplateWord(
  tenantId: string,
  templateId: string,
  fileName: string,
  bytes: Buffer,
  scanned: ReturnType<typeof scanContractTemplateText>,
) {
  let stored = bytes;
  let kind = sniffWordKind(bytes, fileName);
  if (kind === "doc") {
    const asDocx = await convertDocToDocx(bytes);
    if (asDocx) {
      stored = asDocx;
      kind = "docx";
      fileName = fileName.replace(/\.doc$/i, ".docx");
    }
  }
  if (kind === "docx") {
    stored = await rewriteDocxText(stored, (text) => rewriteScannedFragment(text, scanned));
    stored = await ensureDocxItemsPlaceholder(stored);
  }
  const safe = fileName.replace(/[^\w.\-а-яёА-ЯЁ]+/gi, "_").slice(0, 180) || "template.docx";
  const storageKey = path.posix.join(tenantId, "contract-templates", templateId, safe);
  const abs = resolveUploadPath(storageKey);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, stored);
  return { sourceFileName: fileName, sourceStorageKey: storageKey };
}

async function sellerProfile(prisma: PrismaClient, tenantId: string): Promise<TemplateSellerProfile> {
  const profile = await prisma.tenantLegalProfile.findUnique({ where: { tenantId } });
  return {
    legalName: profile?.legalName,
    shortName: profile?.shortName,
    bin: profile?.bin,
    iin: profile?.iin,
    legalAddress: profile?.legalAddress,
    directorName: profile?.directorName,
    directorPosition: profile?.directorPosition,
    iban: profile?.iban,
    bankName: profile?.bankName,
    bik: profile?.bik,
    phone: profile?.phone,
    email: profile?.email,
  };
}

async function decodeUpload(raw: unknown) {
  const input = uploadContractTemplateSchema.parse(raw);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.fileBase64)) {
    throw new ApiError(422, "word_invalid", "Не удалось прочитать файл. Выберите Word ещё раз.");
  }
  const bytes = Buffer.from(input.fileBase64, "base64");
  return { input, bytes };
}

function scanOrThrow(text: string, profile: TemplateSellerProfile, fileName?: string) {
  try {
    return scanContractTemplateText(text, profile, fileName);
  } catch (error) {
    if (error instanceof Error && error.message === "template_text_short") {
      throw new ApiError(422, "template_text_short", "В файле слишком мало текста для шаблона договора");
    }
    throw error;
  }
}

export async function listContractTemplates(prisma: PrismaClient, auth: AuthContext) {
  const membership = requireTenant(auth);
  requireManageDocuments(auth);
  await requireDocumentsEnabled(prisma, membership.tenantId);
  await ensureDefaultTemplate(prisma, membership.tenantId);
  const items = await prisma.contractTemplate.findMany({
    where: { tenantId: membership.tenantId },
    orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
  });
  return { items: items.map((row) => serializeTemplate(row)) };
}

export async function previewContractTemplate(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const membership = requireTenant(auth);
  requireManageDocuments(auth);
  await requireDocumentsEnabled(prisma, membership.tenantId);
  const { input, bytes } = await decodeUpload(raw);
  const release = beginDocumentExtraction();
  try {
    const text = await wordFileToText(bytes, input.fileName);
    const scanned = scanOrThrow(text, await sellerProfile(prisma, membership.tenantId), input.fileName);
    if (input.name?.trim()) scanned.name = input.name.trim();
    return scanned;
  } finally {
    release();
  }
}

export async function createContractTemplate(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  const membership = requireTenant(auth);
  requireManageDocuments(auth);
  await requireDocumentsEnabled(prisma, membership.tenantId);
  const asSave = saveContractTemplateSchema.safeParse(raw);
  let name = "";
  let body = "";
  let makeDefault = false;
  let sourceBytes: Buffer | null = null;
  let sourceName = "";
  let scannedForFile: ReturnType<typeof scanContractTemplateText> | null = null;
  const profile = await sellerProfile(prisma, membership.tenantId);
  if (asSave.success && asSave.data.body) {
    name = asSave.data.name;
    body = asSave.data.body;
    makeDefault = asSave.data.isDefault !== false;
    if (asSave.data.fileBase64 && asSave.data.fileName) {
      sourceName = asSave.data.fileName;
      sourceBytes = Buffer.from(asSave.data.fileBase64, "base64");
      const text = await wordFileToText(sourceBytes, sourceName).catch(() => "");
      if (text) scannedForFile = scanOrThrow(text, profile, sourceName);
    }
  } else {
    const { input, bytes } = await decodeUpload(raw);
    const release = beginDocumentExtraction();
    try {
      const text = await wordFileToText(bytes, input.fileName);
      const scanned = scanOrThrow(text, profile, input.fileName);
      name = input.name?.trim() || scanned.name;
      body = scanned.body;
      makeDefault = true;
      sourceBytes = bytes;
      sourceName = input.fileName;
      scannedForFile = scanned;
    } finally {
      release();
    }
  }
  if (body.length < 40) throw new ApiError(422, "template_text_short", "В шаблоне слишком мало текста");
  const created = await prisma.$transaction(async (tx) => {
    if (makeDefault) {
      await tx.contractTemplate.updateMany({
        where: { tenantId: membership.tenantId, isDefault: true },
        data: { isDefault: false },
      });
    }
    const hasDefault = await tx.contractTemplate.findFirst({
      where: { tenantId: membership.tenantId, isDefault: true },
      select: { id: true },
    });
    return tx.contractTemplate.create({
      data: {
        tenantId: membership.tenantId,
        name: name.slice(0, 200),
        body,
        isDefault: makeDefault || !hasDefault,
      },
    });
  });
  if (sourceBytes && scannedForFile) {
    const stored = await storeTemplateWord(membership.tenantId, created.id, sourceName, sourceBytes, scannedForFile);
    await prisma.contractTemplate.update({
      where: { id: created.id },
      data: stored,
    });
    Object.assign(created, stored);
  }
  await prisma.auditEvent.create({
    data: {
      tenantId: membership.tenantId,
      actorUserId: auth.user.id,
      action: "contract_template.create",
      entityType: "contract_template",
      entityId: created.id,
      changesJson: { name: created.name, isDefault: created.isDefault, fromWord: Boolean(sourceBytes) },
    },
  });
  return { template: serializeTemplate(created, true) };
}

export async function updateContractTemplate(prisma: PrismaClient, auth: AuthContext, id: string, raw: unknown) {
  const membership = requireTenant(auth);
  requireManageDocuments(auth);
  const input = patchContractTemplateSchema.parse(raw);
  const existing = await prisma.contractTemplate.findFirst({ where: { id, tenantId: membership.tenantId } });
  if (!existing) throw new ApiError(404, "not_found", "Шаблон не найден");
  const updated = await prisma.$transaction(async (tx) => {
    if (input.isDefault) {
      await tx.contractTemplate.updateMany({
        where: { tenantId: membership.tenantId, isDefault: true },
        data: { isDefault: false },
      });
    }
    return tx.contractTemplate.update({
      where: { id: existing.id },
      data: {
        name: input.name?.trim() || existing.name,
        isDefault: input.isDefault ?? existing.isDefault,
      },
    });
  });
  return { template: serializeTemplate(updated, true) };
}

export async function deleteContractTemplate(prisma: PrismaClient, auth: AuthContext, id: string) {
  const membership = requireTenant(auth);
  requireManageDocuments(auth);
  const existing = await prisma.contractTemplate.findFirst({ where: { id, tenantId: membership.tenantId } });
  if (!existing) throw new ApiError(404, "not_found", "Шаблон не найден");
  await prisma.contractTemplate.delete({ where: { id: existing.id } });
  if (existing.isDefault) await ensureDefaultTemplate(prisma, membership.tenantId);
  return { ok: true };
}

type PreviewItem = {
  name: string;
  description?: string | null;
  quantity: number;
  unit?: string;
  unitPrice: number;
  vatRate: number;
  catalogItemId?: string | null;
  catalogTruId?: string | null;
};

type PreviewMeta = {
  companyId: string;
  templateId: string;
  number: string;
  subject: string;
  items: PreviewItem[];
};

function previewMetaPath(storageKey: string) {
  return resolveUploadPath(`${storageKey}.meta.json`);
}

async function nextContractNumber(prisma: PrismaClient, tenantId: string) {
  const year = new Date().getFullYear();
  const count =
    (await prisma.contract.count({ where: { tenantId } })) +
    (await prisma.auditEvent.count({ where: { tenantId, entityType: "contract", action: "contract.delete" } }));
  return `DOG-${year}-${String(count + 1).padStart(4, "0")}`;
}

async function ensureDealForCompany(
  prisma: PrismaClient,
  auth: AuthContext,
  company: { id: string; name: string; legalName: string | null; directorName: string | null },
  templateName: string,
  itemRows: PreviewItem[],
  dealId?: string,
) {
  const membership = requireTenant(auth);
  if (dealId) {
    const deal = await prisma.deal.findFirst({
      where: { id: dealId, tenantId: membership.tenantId, companyId: company.id },
      include: { items: { select: { id: true } } },
    });
    if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");
    if (!deal.items.length) {
      for (const item of itemRows) {
        await addDealItem(prisma, auth, deal.id, item);
      }
    }
    return { dealId: deal.id, createdDeal: false };
  }
  const linked = await prisma.companyContact.findFirst({
    where: { tenantId: membership.tenantId, companyId: company.id, isActive: true, contact: { archivedAt: null } },
    orderBy: { isPrimary: "desc" },
    select: { contactId: true },
  });
  let contactId = linked?.contactId || "";
  if (!contactId) {
    const contact = await prisma.contact.create({
      data: {
        tenantId: membership.tenantId,
        name: company.directorName || company.legalName || company.name,
        companyName: company.name,
        ownerMembershipId: membership.id,
        attributionJson: { source: "contract_template" },
      },
    });
    contactId = contact.id;
    await prisma.companyContact.create({
      data: { tenantId: membership.tenantId, companyId: company.id, contactId, isPrimary: true },
    });
  }
  const { createDeal } = await import("./dealService.ts");
  const created = await createDeal(prisma, auth, {
    title: templateName.slice(0, 200),
    contactId,
    companyId: company.id,
    description: `Договор по шаблону «${templateName}».`,
    items: itemRows,
  });
  return { dealId: created.deal.id, createdDeal: true };
}

async function previewContractFromTemplate(
  prisma: PrismaClient,
  auth: AuthContext,
  companyId: string,
  input: { templateId: string; items?: PreviewItem[] },
) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const template = await prisma.contractTemplate.findFirst({ where: { id: input.templateId, tenantId: tid } });
  if (!template) throw new ApiError(404, "not_found", "Шаблон не найден");
  const company = await prisma.company.findFirst({
    where: { id: companyId, tenantId: tid, archivedAt: null },
  });
  if (!company) throw new ApiError(404, "not_found", "Компания не найдена");
  const itemRows = (input.items?.length
    ? input.items
    : [{ name: template.name, quantity: 1, unitPrice: 0, vatRate: 0 }]
  ).map((item) => ({ ...item, vatRate: item.vatRate ?? 0 }));
  const pdfItems = itemRows.map((item) => {
    const amounts = lineAmounts(item.quantity, item.unitPrice, item.vatRate);
    return {
      name: item.name,
      quantity: item.quantity,
      unit: item.unit || "шт",
      unitPrice: item.unitPrice,
      vatRate: item.vatRate,
      ...amounts,
    };
  });
  const [profile, tenant] = await Promise.all([
    prisma.tenantLegalProfile.findUnique({ where: { tenantId: tid } }),
    prisma.tenant.findUnique({ where: { id: tid }, select: { name: true } }),
  ]);
  const readiness = assessContractReadiness({
    dealId: "",
    itemCount: pdfItems.length,
    profile,
    company,
  });
  if (!readiness.ready) throw missingFieldsError(readiness);
  const totals = sumLines(pdfItems);
  const number = await nextContractNumber(prisma, tid);
  const contractDate = new Date();
  const filled = (value: string | null | undefined) => Boolean(value && String(value).trim());
  const pdfInput = {
    number,
    date: contractDate,
    subject: template.name,
    dealName: template.name,
    paymentTerms: "По согласованию сторон.",
    completionTerms: "По согласованию сторон.",
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
    items: pdfItems,
    templateBody: template.body,
  };
  const docx = await renderContractFromTemplate(template, pdfInput);
  const pdf = await wordFileToContractPdf(docx, `${number}.docx`, pdfInput);
  const previewId = randomUUID();
  const fileName = `${number}.pdf`;
  const storageKey = path.posix.join(tid, "contract-previews", previewId, fileName);
  const abs = resolveUploadPath(storageKey);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, pdf);
  const meta: PreviewMeta = {
    companyId,
    templateId: template.id,
    number,
    subject: template.name,
    items: itemRows,
  };
  await writeFile(previewMetaPath(storageKey), JSON.stringify(meta));
  await prisma.attachment.create({
    data: {
      id: previewId,
      tenantId: tid,
      parentType: "contract_preview",
      parentId: previewId,
      storageKey,
      fileName,
      originalFileName: fileName,
      mimeType: PDF_MIME,
      sizeBytes: pdf.length,
      checksum: createHash("sha256").update(pdf).digest("hex"),
      documentType: "contract",
      uploadedById: auth.user.id,
      status: "preview",
    },
  });
  await storeContractBytes(prisma, {
    tenantId: tid, parentType: "contract_preview", parentId: previewId,
    fileName: `${number}.docx`, mimeType: DOCX_MIME, bytes: docx,
    documentType: "contract_source", uploadedById: auth.user.id, status: "preview",
  });
  return {
    previewId,
    number,
    generated: true,
    dealId: null,
    createdDeal: false,
    contract: null,
  };
}

async function saveContractPreview(
  prisma: PrismaClient,
  auth: AuthContext,
  companyId: string,
  previewId: string,
) {
  const membership = requireTenant(auth);
  const tid = membership.tenantId;
  const attachment = await prisma.attachment.findFirst({
    where: { id: previewId, tenantId: tid, parentType: "contract_preview" },
  });
  if (!attachment) throw new ApiError(404, "not_found", "Сформированный договор не найден. Сформируйте его ещё раз.");
  if (attachment.status !== "preview") {
    const existing = await prisma.contract.findFirst({
      where: { tenantId: tid, generatedFileId: attachment.id },
    });
    if (existing) {
      return { contract: serializeContract({ ...existing, generatedMimeType: PDF_MIME }), dealId: existing.dealId, createdDeal: false, generated: true, previewId };
    }
  }
  let meta: PreviewMeta;
  try {
    meta = JSON.parse(await readFile(previewMetaPath(attachment.storageKey), "utf8")) as PreviewMeta;
  } catch {
    throw new ApiError(404, "not_found", "Сформированный договор не найден. Сформируйте его ещё раз.");
  }
  if (meta.companyId !== companyId) throw new ApiError(404, "not_found", "Сформированный договор не найден");
  const template = await prisma.contractTemplate.findFirst({ where: { id: meta.templateId, tenantId: tid } });
  if (!template) throw new ApiError(404, "not_found", "Шаблон не найден");
  const company = await prisma.company.findFirst({
    where: { id: companyId, tenantId: tid, archivedAt: null },
  });
  if (!company) throw new ApiError(404, "not_found", "Компания не найдена");
  let previewFile = attachment;
  if (!isPdfAttachment(previewFile)) {
    const source = await readFile(resolveUploadPath(previewFile.storageKey));
    const pdf = await wordFileToContractPdf(source, previewFile.fileName || "contract.docx");
    await storeContractBytes(prisma, {
      tenantId: tid, parentType: "contract_preview", parentId: previewId,
      fileName: previewFile.fileName, mimeType: previewFile.mimeType, bytes: source,
      documentType: "contract_source", uploadedById: auth.user.id, status: "preview",
    });
    await writeFile(resolveUploadPath(previewFile.storageKey), pdf);
    previewFile = await prisma.attachment.update({
      where: { id: previewFile.id },
      data: {
        fileName: `${meta.number}.pdf`,
        originalFileName: `${meta.number}.pdf`,
        mimeType: PDF_MIME,
        sizeBytes: pdf.length,
        checksum: createHash("sha256").update(pdf).digest("hex"),
      },
    });
  }
  const { dealId, createdDeal } = await ensureDealForCompany(prisma, auth, company, template.name, meta.items);
  const totals = sumLines(
    meta.items.map((item) => {
      const amounts = lineAmounts(item.quantity, item.unitPrice, item.vatRate);
      return { ...amounts, vatRate: item.vatRate };
    }),
  );
  const saved = await prisma.$transaction(async (tx) => {
    const contract = await tx.contract.create({
      data: {
        tenantId: tid,
        dealId,
        companyId,
        number: meta.number,
        subject: meta.subject,
        amountWithoutVat: totals.amountWithoutVat,
        vatRate: totals.vatRate,
        vatAmount: totals.vatAmount,
        totalAmount: totals.totalAmount,
        status: "READY_TO_SIGN",
        templateId: template.id,
        generatedFileId: previewFile.id,
        createdByUserId: auth.user.id,
      },
    });
    await tx.contractVersion.create({
      data: {
        tenantId: tid,
        contractId: contract.id,
        version: 1,
        fileId: previewFile.id,
        sha256: previewFile.checksum,
      },
    });
    await tx.attachment.update({
      where: { id: previewFile.id },
      data: { parentType: "contract", parentId: contract.id, status: "stored" },
    });
    await tx.attachment.updateMany({
      where: { tenantId: tid, parentType: "contract_preview", parentId: previewId, documentType: "contract_source" },
      data: { parentType: "contract", parentId: contract.id, status: "stored" },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: tid,
        actorUserId: auth.user.id,
        action: "contract.from_template",
        entityType: "contract",
        entityId: contract.id,
        changesJson: { dealId, previewId, number: contract.number },
      },
    });
    return contract;
  });
  return {
    contract: serializeContract({ ...saved, generatedMimeType: PDF_MIME }),
    dealId,
    createdDeal,
    generated: true,
    previewId,
  };
}

export async function sendContractPreviewFile(
  prisma: PrismaClient,
  auth: AuthContext,
  previewId: string,
  res: Response,
) {
  requireDocumentsAccess(auth);
  const tid = requireTenant(auth).tenantId;
  const attachment = await prisma.attachment.findFirst({
    where: { id: previewId, tenantId: tid, parentType: { in: ["contract_preview", "contract"] } },
  });
  if (!attachment) throw new ApiError(404, "not_found", "Сформированный договор не найден");
  if (!isPdfAttachment(attachment)) {
    const source = await readFile(resolveUploadPath(attachment.storageKey));
    const pdf = await wordFileToContractPdf(source, attachment.fileName || "contract.docx");
    await storeContractBytes(prisma, {
      tenantId: tid, parentType: attachment.parentType, parentId: attachment.parentId,
      fileName: attachment.fileName, mimeType: attachment.mimeType, bytes: source,
      documentType: "contract_source", uploadedById: auth.user.id, status: attachment.status,
    });
    const pdfName = (attachment.fileName || "contract").replace(/\.docx?$/i, "") + ".pdf";
    await writeFile(resolveUploadPath(attachment.storageKey), pdf);
    await prisma.attachment.update({
      where: { id: attachment.id },
      data: {
        fileName: pdfName,
        originalFileName: pdfName,
        mimeType: PDF_MIME,
        sizeBytes: pdf.length,
        checksum: createHash("sha256").update(pdf).digest("hex"),
      },
    });
    await sendStoredFile(res, resolveUploadPath(attachment.storageKey), pdfDownloadHeaders(pdfName.replace(/\.pdf$/i, "")));
    return;
  }
  await sendStoredFile(
    res,
    resolveUploadPath(attachment.storageKey),
    pdfDownloadHeaders(attachment.fileName.replace(/\.pdf$/i, "")),
  );
}

export async function createContractFromTemplateForCompany(
  prisma: PrismaClient,
  auth: AuthContext,
  companyId: string,
  raw: unknown,
) {
  const membership = requireTenant(auth);
  requireManageDocuments(auth);
  await requireDocumentsEnabled(prisma, membership.tenantId);
  const input = companyContractFromTemplateSchema.parse(raw || {});
  if (input.save) {
    return saveContractPreview(prisma, auth, companyId, input.previewId!);
  }
  if (input.dealId) {
    const template = await prisma.contractTemplate.findFirst({
      where: { id: input.templateId, tenantId: membership.tenantId },
    });
    if (!template) throw new ApiError(404, "not_found", "Шаблон не найден");
    const company = await prisma.company.findFirst({
      where: { id: companyId, tenantId: membership.tenantId, archivedAt: null },
    });
    if (!company) throw new ApiError(404, "not_found", "Компания не найдена");
    const itemRows = (input.items?.length
      ? input.items
      : [{ name: template.name, quantity: 1, unitPrice: 0, vatRate: 0 }]
    ).map((item) => ({ ...item, vatRate: item.vatRate ?? 0 }));
    const { dealId, createdDeal } = await ensureDealForCompany(prisma, auth, company, template.name, itemRows, input.dealId);
    const draft = await createContractDraft(prisma, auth, dealId, {
      subject: template.name,
      templateId: template.id,
    });
    if (input.generate === false) {
      return { ...draft, dealId, createdDeal, generated: false };
    }
    const generated = await generateContractPdfFile(prisma, auth, draft.contract.id, { templateId: template.id });
    return { ...generated, dealId, createdDeal, generated: true };
  }
  return previewContractFromTemplate(prisma, auth, companyId, {
    templateId: input.templateId!,
    items: input.items?.map((item) => ({ ...item, vatRate: item.vatRate ?? 0 })),
  });
}
