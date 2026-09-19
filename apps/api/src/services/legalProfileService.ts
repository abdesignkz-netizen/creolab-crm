import type { PrismaClient } from "@creolab/db";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeKzTaxId } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { DEFAULT_DOCUMENT_FLAGS } from "../lib/featureFlags.ts";
import type { AuthContext } from "../lib/types.ts";
import { can } from "../lib/types.ts";
import { requireDocumentsAccess } from "../lib/access.ts";
import { resolveUploadPath } from "../lib/storage.ts";
import { asMoney } from "./documentMoney.ts";

function requireTenant(auth: AuthContext) {
  if (!auth.activeMembership) throw new ApiError(403, "no_tenant", "Нет активной компании");
  return auth.activeMembership;
}

export function serializeLegalProfile(
  row: {
    legalName: string | null;
    shortName: string | null;
    bin: string | null;
    iin: string | null;
    legalAddress: string | null;
    actualAddress: string | null;
    iban: string | null;
    bankName: string | null;
    bik: string | null;
    vatPayer: boolean | null;
    vatRegistrationNumber: string | null;
    defaultVatMode: string | null;
    defaultVatRate: { toString(): string } | number | null;
    directorName: string | null;
    directorPosition: string | null;
    email: string | null;
    phone: string | null;
    country: string | null;
    currency: string | null;
    documentsEnabled: boolean;
    contractSigningEnabled: boolean;
    esfIntegrationEnabled: boolean;
    defaultCatalogTruId?: string | null;
  } | null,
) {
  return {
    legalName: row?.legalName ?? null,
    shortName: row?.shortName ?? null,
    bin: row?.bin ?? null,
    iin: row?.iin ?? null,
    legalAddress: row?.legalAddress ?? null,
    actualAddress: row?.actualAddress ?? null,
    iban: row?.iban ?? null,
    bankName: row?.bankName ?? null,
    bik: row?.bik ?? null,
    vatPayer: row?.vatPayer ?? null,
    vatRegistrationNumber: row?.vatRegistrationNumber ?? null,
    defaultVatMode: row?.defaultVatMode ?? null,
    defaultVatRate: row?.defaultVatRate == null ? null : asMoney(row.defaultVatRate),
    directorName: row?.directorName ?? null,
    directorPosition: row?.directorPosition ?? null,
    email: row?.email ?? null,
    phone: row?.phone ?? null,
    country: row?.country ?? "KZ",
    currency: row?.currency ?? "KZT",
    documentsEnabled: row?.documentsEnabled ?? DEFAULT_DOCUMENT_FLAGS.documentsEnabled,
    contractSigningEnabled: row?.contractSigningEnabled ?? DEFAULT_DOCUMENT_FLAGS.contractSigningEnabled,
    esfIntegrationEnabled: row?.esfIntegrationEnabled ?? DEFAULT_DOCUMENT_FLAGS.esfIntegrationEnabled,
    defaultCatalogTruId: row?.defaultCatalogTruId ?? null,
    vatConfigured: Boolean(row?.defaultVatMode),
  };
}

export async function getLegalProfile(prisma: PrismaClient, auth: AuthContext) {
  requireDocumentsAccess(auth);
  const membership = requireTenant(auth);
  const row = await prisma.tenantLegalProfile.findUnique({ where: { tenantId: membership.tenantId } });
  const tenant=await prisma.tenant.findUnique({where:{id:membership.tenantId},select:{settingsJson:true}});
  const settings=tenant?.settingsJson as {documents?:{directorBasis?:string}}|null;
  const marks = row ? await invoiceMarkFlags(prisma, membership.tenantId, row.id) : { hasStamp: false, hasSignature: false };
  return {...serializeLegalProfile(row),directorBasis:settings?.documents?.directorBasis||null, ...marks};
}

export async function getTenantDocumentFlags(prisma: PrismaClient, tenantId: string) {
  const row = await prisma.tenantLegalProfile.findUnique({
    where: { tenantId },
    select: {
      documentsEnabled: true,
      contractSigningEnabled: true,
      esfIntegrationEnabled: true,
      defaultVatMode: true,
      defaultVatRate: true,
    },
  });
  return {
    ...DEFAULT_DOCUMENT_FLAGS,
    documentsEnabled: row?.documentsEnabled ?? DEFAULT_DOCUMENT_FLAGS.documentsEnabled,
    contractSigningEnabled: row?.contractSigningEnabled ?? DEFAULT_DOCUMENT_FLAGS.contractSigningEnabled,
    esfIntegrationEnabled: row?.esfIntegrationEnabled ?? DEFAULT_DOCUMENT_FLAGS.esfIntegrationEnabled,
    defaultVatMode: row?.defaultVatMode ?? null,
    defaultVatRate: row?.defaultVatRate == null ? null : asMoney(row.defaultVatRate),
  };
}

export function resolveVatRate(
  flags: { defaultVatMode: string | null; defaultVatRate: number | null },
  explicit?: number,
) {
  if (explicit != null) return explicit;
  if (flags.defaultVatMode === "none") return 0;
  if (flags.defaultVatMode === "percent" && flags.defaultVatRate != null) return flags.defaultVatRate;
  throw new ApiError(
    422,
    "vat_default_unset",
    "Укажите НДС у услуги: без НДС или 12%",
  );
}

export async function requireDocumentsEnabled(prisma: PrismaClient, tenantId: string) {
  const flags = await getTenantDocumentFlags(prisma, tenantId);
  if (!flags.documentsEnabled) {
    throw new ApiError(403, "documents_disabled", "Контур документов выключен в настройках");
  }
  return flags;
}

export async function isDocumentsEnabled(prisma: PrismaClient, tenantId: string) {
  const flags = await getTenantDocumentFlags(prisma, tenantId);
  return flags.documentsEnabled;
}

export async function updateLegalProfile(
  prisma: PrismaClient,
  auth: AuthContext,
  input: Record<string, unknown>,
) {
  const membership = requireTenant(auth);
  if (!can(auth, "manage_documents")) {
    throw new ApiError(403, "forbidden", "Недостаточно прав для реквизитов");
  }
  const tid = membership.tenantId;
  const existing = await prisma.tenantLegalProfile.findUnique({ where: { tenantId: tid } });
  const defaultVatMode =
    input.defaultVatMode === undefined ? existing?.defaultVatMode ?? null : (input.defaultVatMode as string | null);
  const defaultVatRate =
    input.defaultVatRate === undefined
      ? existing?.defaultVatRate == null
        ? null
        : asMoney(existing.defaultVatRate)
      : (input.defaultVatRate as number | null);
  if (defaultVatMode === "percent" && (defaultVatRate == null || defaultVatRate < 0)) {
    throw new ApiError(422, "invalid", "Для режима «ставка» укажите процент НДС");
  }

  const data = {
    legalName: input.legalName === undefined ? existing?.legalName ?? null : ((input.legalName as string | null) || null),
    shortName: input.shortName === undefined ? existing?.shortName ?? null : ((input.shortName as string | null) || null),
    bin: input.bin === undefined ? existing?.bin ?? null : normalizeKzTaxId(input.bin as string | null),
    iin: input.iin === undefined ? existing?.iin ?? null : normalizeKzTaxId(input.iin as string | null),
    legalAddress:
      input.legalAddress === undefined ? existing?.legalAddress ?? null : ((input.legalAddress as string | null) || null),
    actualAddress:
      input.actualAddress === undefined ? existing?.actualAddress ?? null : ((input.actualAddress as string | null) || null),
    iban: input.iban === undefined ? existing?.iban ?? null : ((input.iban as string | null) || null),
    bankName: input.bankName === undefined ? existing?.bankName ?? null : ((input.bankName as string | null) || null),
    bik: input.bik === undefined ? existing?.bik ?? null : ((input.bik as string | null) || null),
    vatPayer: input.vatPayer === undefined ? existing?.vatPayer ?? null : (input.vatPayer as boolean | null),
    vatRegistrationNumber:
      input.vatRegistrationNumber === undefined
        ? existing?.vatRegistrationNumber ?? null
        : ((input.vatRegistrationNumber as string | null) || null),
    defaultVatMode,
    defaultVatRate: defaultVatMode === "none" ? 0 : defaultVatRate,
    directorName:
      input.directorName === undefined ? existing?.directorName ?? null : ((input.directorName as string | null) || null),
    directorPosition:
      input.directorPosition === undefined
        ? existing?.directorPosition ?? null
        : ((input.directorPosition as string | null) || null),
    email: input.email === undefined ? existing?.email ?? null : ((input.email as string | null) || null),
    phone: input.phone === undefined ? existing?.phone ?? null : ((input.phone as string | null) || null),
    country: input.country === undefined ? existing?.country ?? "KZ" : ((input.country as string | null) || "KZ"),
    currency: input.currency === undefined ? existing?.currency ?? "KZT" : ((input.currency as string | null) || "KZT"),
    documentsEnabled:
      input.documentsEnabled === undefined
        ? existing?.documentsEnabled ?? true
        : Boolean(input.documentsEnabled),
    contractSigningEnabled:
      input.contractSigningEnabled === undefined
        ? existing?.contractSigningEnabled ?? false
        : Boolean(input.contractSigningEnabled),
    esfIntegrationEnabled:
      input.esfIntegrationEnabled === undefined
        ? existing?.esfIntegrationEnabled ?? false
        : Boolean(input.esfIntegrationEnabled),
    defaultCatalogTruId:
      input.defaultCatalogTruId === undefined
        ? existing?.defaultCatalogTruId ?? null
        : ((input.defaultCatalogTruId as string | null) || null),
  };

  const saved = existing
    ? await prisma.tenantLegalProfile.update({ where: { tenantId: tid }, data })
    : await prisma.tenantLegalProfile.create({ data: { tenantId: tid, ...data } });

  await prisma.auditEvent.create({
    data: {
      tenantId: tid,
      actorUserId: auth.user.id,
      action: "legal_profile.update",
      entityType: "tenant_legal_profile",
      entityId: saved.id,
      changesJson: { defaultVatMode: saved.defaultVatMode, documentsEnabled: saved.documentsEnabled },
    },
  });

  if(input.directorBasis!==undefined)await prisma.$transaction(async tx=>{
    await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tid} FOR UPDATE`;
    const tenant=await tx.tenant.findUniqueOrThrow({where:{id:tid}});
    const settings=tenant.settingsJson as Record<string,any>;
    await tx.tenant.update({where:{id:tid},data:{settingsJson:{...settings,documents:{...settings?.documents,directorBasis:input.directorBasis||null}}}});
  });
  return getLegalProfile(prisma,auth);
}

export const INVOICE_MARK_KINDS = ["stamp", "signature"] as const;
export type InvoiceMarkKind = (typeof INVOICE_MARK_KINDS)[number];

function markDocumentType(kind: InvoiceMarkKind) {
  return kind === "stamp" ? "invoice_stamp" : "invoice_signature";
}

async function invoiceMarkFlags(prisma: PrismaClient, tenantId: string, profileId: string) {
  const rows = await prisma.attachment.findMany({
    where: { tenantId, parentType: "legal_profile", parentId: profileId, documentType: { in: ["invoice_stamp", "invoice_signature"] } },
    select: { documentType: true },
  });
  return {
    hasStamp: rows.some((row) => row.documentType === "invoice_stamp"),
    hasSignature: rows.some((row) => row.documentType === "invoice_signature"),
  };
}

async function ensureLegalProfileRow(prisma: PrismaClient, tenantId: string) {
  return (
    (await prisma.tenantLegalProfile.findUnique({ where: { tenantId } })) ||
    (await prisma.tenantLegalProfile.create({ data: { tenantId } }))
  );
}

export async function listInvoiceMarkFiles(prisma: PrismaClient, tenantId: string) {
  const profile = await prisma.tenantLegalProfile.findUnique({ where: { tenantId } });
  if (!profile) return { stamp: null as Buffer | null, signature: null as Buffer | null, hasStamp: false, hasSignature: false };
  const rows = await prisma.attachment.findMany({
    where: { tenantId, parentType: "legal_profile", parentId: profile.id, documentType: { in: ["invoice_stamp", "invoice_signature"] } },
  });
  async function load(kind: InvoiceMarkKind) {
    const row = rows.find((item) => item.documentType === markDocumentType(kind));
    if (!row) return null;
    try {
      return await readFile(resolveUploadPath(row.storageKey));
    } catch {
      return null;
    }
  }
  const stamp = await load("stamp");
  const signature = await load("signature");
  return { stamp, signature, hasStamp: Boolean(stamp), hasSignature: Boolean(signature) };
}

export async function saveInvoiceMarkImage(
  prisma: PrismaClient,
  auth: AuthContext,
  kindRaw: string,
  input: { contentBase64?: string; mimeType?: string },
) {
  const membership = requireTenant(auth);
  if (!can(auth, "manage_documents")) throw new ApiError(403, "forbidden", "Недостаточно прав для реквизитов");
  if (!INVOICE_MARK_KINDS.includes(kindRaw as InvoiceMarkKind)) {
    throw new ApiError(422, "invalid", "Загрузите печать или подпись");
  }
  const kind = kindRaw as InvoiceMarkKind;
  const mime = String(input.mimeType || "").toLowerCase();
  if (mime !== "image/png" && mime !== "image/jpeg" && mime !== "image/webp") {
    throw new ApiError(422, "invalid", "Печать и подпись — PNG, JPEG или WebP");
  }
  const raw = String(input.contentBase64 || "").replace(/^data:[^;]+;base64,/, "");
  let buffer: Buffer;
  try {
    buffer = Buffer.from(raw, "base64");
  } catch {
    throw new ApiError(422, "invalid", "Некорректный файл");
  }
  if (!buffer.length) throw new ApiError(422, "invalid", "Файл пуст");
  if (buffer.length > 2 * 1024 * 1024) throw new ApiError(422, "invalid", "Файл больше 2 МБ");
  const profile = await ensureLegalProfileRow(prisma, membership.tenantId);
  const previous = await prisma.attachment.findMany({
    where: {
      tenantId: membership.tenantId,
      parentType: "legal_profile",
      parentId: profile.id,
      documentType: markDocumentType(kind),
    },
  });
  const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
  const id = randomUUID();
  const storageKey = path.posix.join(membership.tenantId, "legal-marks", `${kind}-${id}.${ext}`);
  const absolute = resolveUploadPath(storageKey);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, buffer, { flag: "wx" });
  await prisma.attachment.create({
    data: {
      id,
      tenantId: membership.tenantId,
      parentType: "legal_profile",
      parentId: profile.id,
      documentType: markDocumentType(kind),
      storageKey,
      fileName: `${kind}.${ext}`,
      originalFileName: `${kind}.${ext}`,
      mimeType: mime,
      sizeBytes: buffer.length,
      checksum: createHash("sha256").update(buffer).digest("hex"),
      status: "stored",
      uploadedById: auth.user.id,
    },
  });
  for (const old of previous) {
    await prisma.attachment.delete({ where: { id: old.id } }).catch(() => undefined);
    await rm(resolveUploadPath(old.storageKey), { force: true }).catch(() => undefined);
  }
  return getLegalProfile(prisma, auth);
}

export async function invoiceMarkFilePath(prisma: PrismaClient, auth: AuthContext, kindRaw: string) {
  requireDocumentsAccess(auth);
  const membership = requireTenant(auth);
  if (!INVOICE_MARK_KINDS.includes(kindRaw as InvoiceMarkKind)) throw new ApiError(404, "not_found", "Файл не найден");
  const profile = await prisma.tenantLegalProfile.findUnique({ where: { tenantId: membership.tenantId } });
  if (!profile) throw new ApiError(404, "not_found", "Файл не найден");
  const row = await prisma.attachment.findFirst({
    where: {
      tenantId: membership.tenantId,
      parentType: "legal_profile",
      parentId: profile.id,
      documentType: markDocumentType(kindRaw as InvoiceMarkKind),
    },
  });
  if (!row) throw new ApiError(404, "not_found", "Файл не загружен");
  return { path: resolveUploadPath(row.storageKey), mimeType: row.mimeType };
}

export async function deleteInvoiceMarkImage(prisma: PrismaClient, auth: AuthContext, kindRaw: string) {
  const membership = requireTenant(auth);
  if (!can(auth, "manage_documents")) throw new ApiError(403, "forbidden", "Недостаточно прав для реквизитов");
  if (!INVOICE_MARK_KINDS.includes(kindRaw as InvoiceMarkKind)) throw new ApiError(404, "not_found", "Файл не найден");
  const file = await invoiceMarkFilePath(prisma, auth, kindRaw).catch(() => null);
  const profile = await prisma.tenantLegalProfile.findUnique({ where: { tenantId: membership.tenantId } });
  if (profile) {
    await prisma.attachment.deleteMany({
      where: {
        tenantId: membership.tenantId,
        parentType: "legal_profile",
        parentId: profile.id,
        documentType: markDocumentType(kindRaw as InvoiceMarkKind),
      },
    });
  }
  if (file) await rm(file.path, { force: true }).catch(() => undefined);
  return getLegalProfile(prisma, auth);
}
