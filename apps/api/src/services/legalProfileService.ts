import type { PrismaClient } from "@creolab/db";
import { normalizeKzTaxId } from "@creolab/contracts";
import { ApiError } from "../errors.ts";
import { DEFAULT_DOCUMENT_FLAGS } from "../lib/featureFlags.ts";
import type { AuthContext } from "../lib/types.ts";
import { can } from "../lib/types.ts";
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
  const membership = requireTenant(auth);
  const row = await prisma.tenantLegalProfile.findUnique({ where: { tenantId: membership.tenantId } });
  return serializeLegalProfile(row);
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
    "Выберите НДС по умолчанию в настройках или укажите ставку в строке",
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

  return serializeLegalProfile(saved);
}
