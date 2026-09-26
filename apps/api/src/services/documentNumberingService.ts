import { z } from "zod";
import type { PrismaClient } from "@creolab/db";
import { ApiError } from "../errors.ts";
import { can, type AuthContext } from "../lib/types.ts";
import { requireDocumentsAccess } from "../lib/access.ts";

export const DOCUMENT_TYPES = ["DOG", "INV", "AVR", "ESF"] as const;
type DocumentType = typeof DOCUMENT_TYPES[number];
type Db = Pick<PrismaClient, "tenant" | "contract" | "invoice" | "electronicDocument" | "auditEvent" | "$queryRaw">;
type Numbering = Partial<Record<DocumentType, { start: number; last?: number }>>;
const startSchema = z.number().int().min(1).max(999999999);
const settingsSchema = z.object({ DOG: startSchema, INV: startSchema, AVR: startSchema, ESF: startSchema }).strict();

async function state(db: Db, tenantId: string) {
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settingsJson: true } });
  const settings = tenant.settingsJson as Record<string, any>;
  return { settings, numbering: (settings.documentNumbering || {}) as Numbering };
}

function canonicalDocumentNumber(number: string, type: "AVR" | "INV") {
  const match = number.trim().match(new RegExp(`^${type}-(\\d{4})-(\\d+)$`, "i"));
  if (match) return `${match[1].slice(-2)}-${match[2].replace(/^0+(?=\d)/, "")}`;
  const local = number.trim().match(/^(\d{2})-(\d+)$/);
  return local ? `${local[1]}-${local[2].replace(/^0+(?=\d)/, "")}` : number.trim();
}

export function canonicalAvrNumber(number: string) {
  return canonicalDocumentNumber(number, "AVR");
}

async function documentNumbers(db: Db, tenantId: string, type: DocumentType) {
  if (type === "DOG") return db.contract.findMany({ where: { tenantId }, select: { id: true, number: true } });
  if (type === "INV") return db.invoice.findMany({ where: { tenantId }, select: { id: true, number: true } });
  return db.electronicDocument.findMany({ where: { tenantId, type }, select: { id: true, number: true } });
}

function sequence(number: string, type: DocumentType, year: number) {
  const match = number.match(new RegExp(`^${type}-${year}-(\\d+)$`, "i"))
    || ((type === "AVR" || type === "INV") ? number.match(new RegExp(`^${String(year).slice(-2)}-(\\d+)$`)) : null);
  const value = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(value) ? value : 0;
}

async function nextValue(db: Db, tenantId: string, type: DocumentType, numbering: Numbering, rows: Array<{number:string}>) {
  const year = new Date().getFullYear();
  const deleted = type === "DOG" && numbering[type]?.last === undefined
    ? await db.auditEvent.count({ where: { tenantId, entityType: "contract", action: "contract.delete" } }) : 0;
  const last = numbering[type]?.last ?? rows.length + deleted;
  return Math.max(numbering[type]?.start || 1, last + 1, rows.reduce((highest, row) => Math.max(highest, sequence(row.number, type, year) + 1), 1));
}

// Call inside the transaction that creates/edits the document. All allocators use the same tenant lock.
export async function allocateDocumentNumber(db: Db, tenantId: string, type: DocumentType, manual?: string, excludeId?: string) {
  await db.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;
  const { settings, numbering } = await state(db, tenantId);
  const rows = await documentNumbers(db, tenantId, type);
  const year = new Date().getFullYear();
  const previous = await nextValue(db, tenantId, type, { ...numbering, [type]: { ...numbering[type], start: 1 } }, rows) - 1;
  const next = Math.max(numbering[type]?.start || 1, previous + 1);
  const number = manual?.trim() || `${type}-${year}-${String(next).padStart(4, "0")}`;
  const key = (value: string) => type === "AVR" || type === "INV" ? canonicalDocumentNumber(value, type) : value;
  if (rows.some(row => row.id !== excludeId && key(row.number) === key(number))) {
    throw new ApiError(409, "document_number_exists", "Документ с таким номером уже существует. Укажите другой номер.");
  }
  const last = Math.max(previous, manual ? sequence(number, type, year) : next);
  await db.tenant.update({ where: { id: tenantId }, data: { settingsJson: {
    ...settings, documentNumbering: { ...numbering, [type]: { start: numbering[type]?.start || 1, last } },
  } } });
  return number;
}

export async function getDocumentNumbering(db: Db, auth: AuthContext) {
  requireDocumentsAccess(auth);
  const tenantId = auth.activeMembership?.tenantId;
  if (!tenantId) throw new ApiError(403, "no_tenant", "Нет активной компании");
  const { numbering } = await state(db, tenantId);
  const result: Record<string, { start: number; next: number; example: string }> = {};
  for (const type of DOCUMENT_TYPES) {
    const next = await nextValue(db, tenantId, type, numbering, await documentNumbers(db, tenantId, type));
    result[type] = { start: numbering[type]?.start || 1, next, example: `${type}-${new Date().getFullYear()}-${String(next).padStart(4, "0")}` };
  }
  return result;
}

export async function updateDocumentNumbering(prisma: PrismaClient, auth: AuthContext, raw: unknown) {
  if (!auth.activeMembership || !can(auth, "manage_documents")) throw new ApiError(403, "forbidden", "Недостаточно прав для настройки документов");
  const input = settingsSchema.parse(raw);
  const tenantId = auth.activeMembership.tenantId;
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;
    const { settings, numbering } = await state(tx, tenantId);
    const updated: Numbering = { ...numbering };
    for (const type of DOCUMENT_TYPES) updated[type] = { ...numbering[type], start: input[type] };
    await tx.tenant.update({ where: { id: tenantId }, data: { settingsJson: { ...settings, documentNumbering: updated } } });
    await tx.auditEvent.create({ data: { tenantId, actorUserId: auth.user.id, action: "document_numbering.update", entityType: "tenant", entityId: tenantId, changesJson: input } });
    return getDocumentNumbering(tx, auth);
  });
}
