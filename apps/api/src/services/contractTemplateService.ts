import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@creolab/db";
import {
  companyContractFromTemplateSchema,
  patchContractTemplateSchema,
  saveContractTemplateSchema,
  uploadContractTemplateSchema,
} from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { can, type AuthContext } from "../lib/types.ts";
import { requireTenant } from "../lib/access.ts";
import { beginDocumentExtraction } from "./documentExtractionGate.ts";
import { requireDocumentsEnabled } from "./legalProfileService.ts";
import { ensureDefaultTemplate } from "./contractTemplate.ts";
import { rewriteScannedFragment, scanContractTemplateText, type TemplateSellerProfile } from "./contractTemplateScan.ts";
import { sniffWordKind, textutilConvert, wordFileToText } from "./wordDocumentText.ts";
import { rewriteDocxText } from "./docxTemplateFill.ts";
import { createContractDraft } from "./documentDraftService.ts";
import { generateContractPdfFile } from "./contractGenerationService.ts";
import { addDealItem } from "./dealItemService.ts";
import { resolveUploadPath } from "../lib/storage.ts";

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
    const asDocx = await textutilConvert(bytes, "doc", "docx");
    if (asDocx) {
      stored = asDocx;
      kind = "docx";
      fileName = fileName.replace(/\.doc$/i, ".docx");
    }
  }
  if (kind === "docx") {
    stored = await rewriteDocxText(stored, (text) => rewriteScannedFragment(text, scanned));
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

  let dealId = input.dealId || "";
  let createdDeal = false;
  if (dealId) {
    const deal = await prisma.deal.findFirst({
      where: { id: dealId, tenantId: membership.tenantId, companyId },
      include: { items: { select: { id: true } } },
    });
    if (!deal) throw new ApiError(404, "not_found", "Сделка не найдена");
    if (!deal.items.length) {
      for (const item of itemRows) {
        await addDealItem(prisma, auth, deal.id, item);
      }
    }
  } else {
    const linked = await prisma.companyContact.findFirst({
      where: { tenantId: membership.tenantId, companyId, isActive: true, contact: { archivedAt: null } },
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
        data: { tenantId: membership.tenantId, companyId, contactId, isPrimary: true },
      });
    }
    const { createDeal } = await import("./dealService.ts");
    const created = await createDeal(prisma, auth, {
      title: template.name.slice(0, 200),
      contactId,
      companyId,
      description: `Договор по шаблону «${template.name}».`,
      items: itemRows,
    });
    dealId = created.deal.id;
    createdDeal = true;
  }

  const draft = await createContractDraft(prisma, auth, dealId, {
    subject: template.name,
    templateId: template.id,
  });
  if (input.generate === false) {
    return { ...draft, dealId, createdDeal, generated: false };
  }
  try {
    const generated = await generateContractPdfFile(prisma, auth, draft.contract.id, { templateId: template.id });
    return { ...generated, dealId, createdDeal, generated: true };
  } catch (error) {
    if (error instanceof ApiError && error.code === "missing_fields") {
      return {
        ...draft,
        dealId,
        createdDeal,
        generated: false,
        missingFields: error.details && typeof error.details === "object" ? error.details : { message: error.message },
      };
    }
    throw error;
  }
}
